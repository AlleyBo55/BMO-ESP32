// =============================================================================
// bmo_brain_client.cpp
//
// HTTPS POST to /api/brain with multipart/form-data audio body and an
// X-BMO-Fingerprint header. Streams the PCM16 reply back in 4 KiB chunks.
//
// Cert handling: WiFiClientSecure::setInsecure() for now. Vercel uses Let's
// Encrypt rotated certificates and the ESP32-C3 has limited flash for a CA
// bundle; cert pinning lives in a future task. The fingerprint header is the
// real authentication boundary, not TLS hostname verification.
//
// Timeouts:
//   - WiFi/TCP connect:   5 seconds
//   - HTTP send + first byte: 10 seconds
//   - Total response:     30 seconds
// =============================================================================

#include "bmo_brain_client.h"

#include <Arduino.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <string.h>

// Only the fingerprint is compiled in; WiFi creds + dashboard URL come from
// the provisioning singleton at runtime.
#include "../include/secrets.h"
#include "bmo_mic.h"   // kMicCaptureSamples
#include "bmo_wav.h"   // wavWriteHeader

namespace bmo {

namespace {

// Multipart boundary. Fixed and unguessable-enough for a single-host firmware.
constexpr const char* kMultipartBoundary =
    "----BMOFirmwareBoundaryE4F2A1B0C3D9";

// Fixed multipart prefix/suffix as compile-time constants so their lengths are
// known and we can lay out the request body in a single static buffer (no
// runtime allocation — see s_body below). These MUST stay in sync with
// kMultipartBoundary above: the prefix line is "--" + boundary, the suffix is
// "\r\n--" + boundary + "--".
constexpr char kBodyPrefix[] =
    "------BMOFirmwareBoundaryE4F2A1B0C3D9\r\n"
    "Content-Disposition: form-data; name=\"audio\"; filename=\"capture.wav\"\r\n"
    "Content-Type: audio/wav\r\n"
    "\r\n";
constexpr char kBodySuffix[] =
    "\r\n------BMOFirmwareBoundaryE4F2A1B0C3D9--\r\n";

constexpr size_t kBodyPrefixLen = sizeof(kBodyPrefix) - 1;  // drop NUL
constexpr size_t kBodySuffixLen = sizeof(kBodySuffix) - 1;
constexpr size_t kWavHeaderLen  = 44;

// Bytes reserved BEFORE the PCM region for [prefix][wav header]. Must be a
// multiple of 4 so the PCM region that follows is 4-byte aligned for the I2S
// DMA, and large enough to hold prefix + wav header.
constexpr size_t kHeaderReserve = 256;
static_assert(kBodyPrefixLen + kWavHeaderLen <= kHeaderReserve,
              "header reserve too small for multipart prefix + wav header");

// Single static request-body buffer. Layout:
//   [ ... pad ... ][ prefix ][ wav hdr ][ PCM samples ........ ][ suffix ]
//                  ^p (POST start)       ^kHeaderReserve (PCM, 4-aligned)
// This replaces the previous design that held the mic capture, a WAV copy,
// and the multipart body as THREE separate ~96 KB allocations — which OOM'd
// on the C3 (only ~96 KB free heap after WiFi/TLS). Now: zero heap, one BSS
// buffer, the mic captures straight into the PCM region.
__attribute__((aligned(4)))
uint8_t s_body[kHeaderReserve + (kMicCaptureSamples * sizeof(int16_t)) +
               kBodySuffixLen];

// Streaming response buffer. ESP32-C3 has ~320 KiB of SRAM; 4 KiB is the
// design.md spec ("4 KiB audio chunks straight into the I2S buffer").
constexpr size_t kAudioChunkBytes = 4096;

constexpr uint32_t kConnectTimeoutMs       = 10000;
// First-byte timeout must cover the WHOLE pre-audio pipeline on the dashboard:
// STT → full LLM completion → TTS open, plus a possible Vercel cold start.
// That regularly exceeds 10s, so the old 10s value killed every real request
// with -11 (READ_TIMEOUT) before the reply could start. The dashboard's own
// budget is 60s (TOTAL_BUDGET_MS / Vercel maxDuration), so give the firmware
// headroom up to that.
constexpr uint32_t kFirstByteTimeoutMs     = 45000;
constexpr uint32_t kTotalResponseTimeoutMs = 60000;

// Maximum time we'll keep playing a single reply, measured from the first
// audio chunk. This is a UX/safety cap (don't let BMO monologue forever, and
// recover if the dashboard streams a pathologically long clip), NOT a memory
// limit — reply audio streams chunk-by-chunk straight to I2S and never
// accumulates in RAM. A clean stop here ends with a soft cue + neutral face,
// not the harsh error face.
constexpr uint32_t kMaxTalkMs = 20000;

// Forward-declared in the header so main.cpp / audio task can supply this.
// This module does not own the I2S setup; it only feeds bytes in.
extern "C" void bmo_audio_push_pcm16(const uint8_t* data, size_t len)
    __attribute__((weak));

// Resets the downsampler's cross-chunk state (leftover byte + skip phase) so a
// new reply starts byte-aligned. Without this, an odd-length previous reply
// leaves a stale half-sample that misaligns the entire next stream into noise.
// Weak so the firmware provides it; in tests/no-audio builds it's a no-op.
extern "C" void bmo_audio_reset_stream() __attribute__((weak));

// Forward declared here so main.cpp can read the latest volume the dashboard
// asked us to use, and apply it to g_volume. Declared via a weak C symbol so
// the brain client doesn't have to know about main.cpp's audio internals.
extern "C" void bmo_set_volume_from_dashboard(int volume0to100)
    __attribute__((weak));

void writePcm16ChunkToAudio(const uint8_t* data, size_t len) {
  if (bmo_audio_push_pcm16) {
    bmo_audio_push_pcm16(data, len);
  }
  // If the audio sink isn't wired yet, drop chunks silently — the test in
  // docs/HARDWARE-SMOKE-TEST.md catches this as "audio plays but it's noise".
}

}  // namespace

BrainClient::BrainClient()
    : statusCb_(nullptr),
      shouldKeepTalkingCb_(nullptr),
      status_(BrainStatus::Idle),
      wifiBegun_(false) {}

void BrainClient::onStatus(void (*cb)(BrainStatus)) {
  statusCb_ = cb;
}

void BrainClient::onShouldKeepTalking(bool (*cb)()) {
  shouldKeepTalkingCb_ = cb;
}

void BrainClient::emit_(BrainStatus s) {
  status_ = s;
  if (statusCb_) statusCb_(s);
}

void BrainClient::begin() {
  if (wifiBegun_ && WiFi.status() == WL_CONNECTED) return;

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[brain] wifi up, ip=%s, rssi=%d\n",
                  WiFi.localIP().toString().c_str(),
                  static_cast<int>(WiFi.RSSI()));
    Serial.printf("[brain] dashboard=%s, fingerprint=********\n",
                  dashboardUrl_.length() > 0 ? dashboardUrl_.c_str() : "(unset)");
    wifiBegun_ = true;
    return;
  }

  Serial.println("[brain] wifi not connected; provisioning module owns the radio");
  emit_(BrainStatus::Error);
}

int16_t* BrainClient::requestPcmBuffer() {
  return reinterpret_cast<int16_t*>(s_body + kHeaderReserve);
}

size_t BrainClient::requestPcmCapacitySamples() {
  return kMicCaptureSamples;
}

bool BrainClient::ask(size_t pcmSampleCount) {
  emit_(BrainStatus::Listening);

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[brain] wifi not connected");
    emit_(BrainStatus::Error);
    return false;
  }
  if (pcmSampleCount == 0 || pcmSampleCount > kMicCaptureSamples) {
    Serial.printf("[brain] bad pcm sample count: %u\n",
                  static_cast<unsigned>(pcmSampleCount));
    emit_(BrainStatus::Error);
    return false;
  }

  // Assemble the multipart body IN PLACE inside s_body, with no heap
  // allocation. The mic has already captured PCM into requestPcmBuffer()
  // (== s_body + kHeaderReserve). We lay the prefix + WAV header immediately
  // before it and the suffix immediately after it:
  //
  //   s_body: [pad][ prefix ][ wav hdr ][ PCM .......... ][ suffix ]
  //                 ^bodyStart          ^kHeaderReserve
  //
  // POST starts at bodyStart and runs for totalLen bytes. This replaces the
  // old two-malloc design (a 96 KB WAV copy + a 96 KB body copy) that OOM'd
  // on the C3's tiny post-WiFi heap.
  const size_t pcmBytes = pcmSampleCount * sizeof(int16_t);
  const size_t bodyStart = kHeaderReserve - kBodyPrefixLen - kWavHeaderLen;
  uint8_t* body = s_body + bodyStart;
  memcpy(body, kBodyPrefix, kBodyPrefixLen);
  // The mic may decimate (e.g. 8 kHz) to fit a longer capture in the fixed
  // buffer, so the WAV header MUST advertise the mic's EFFECTIVE rate — not a
  // hardcoded 16000 — or STT decodes the PCM at the wrong speed and garbles it.
  wavWriteHeader(body + kBodyPrefixLen, pcmBytes, micEffectiveRate(), 1, 16);
  // PCM already lives at s_body + kHeaderReserve, which is exactly
  // body + kBodyPrefixLen + kWavHeaderLen — no copy needed.
  memcpy(s_body + kHeaderReserve + pcmBytes, kBodySuffix, kBodySuffixLen);
  const size_t totalLen = kBodyPrefixLen + kWavHeaderLen + pcmBytes + kBodySuffixLen;

  WiFiClientSecure tls;
  tls.setInsecure();  // see file header comment — fingerprint is the real auth.
  tls.setTimeout(kConnectTimeoutMs / 1000);

  Serial.printf("[brain] pre-TLS heap: free=%u maxAlloc=%u\n",
                static_cast<unsigned>(ESP.getFreeHeap()),
                static_cast<unsigned>(ESP.getMaxAllocHeap()));

  HTTPClient http;
  http.setTimeout(kFirstByteTimeoutMs);
  http.setReuse(false);

  String url = dashboardUrl_ + "/api/brain";
  if (dashboardUrl_.length() == 0) {
    Serial.println("[brain] no dashboard url configured");
    emit_(BrainStatus::Error);
    return false;
  }
  if (!http.begin(tls, url)) {
    Serial.println("[brain] http.begin failed");
    emit_(BrainStatus::Error);
    return false;
  }

  http.addHeader("Content-Type",
                 String("multipart/form-data; boundary=") + kMultipartBoundary);
  http.addHeader("X-BMO-Fingerprint", BMO_FINGERPRINT);
  http.addHeader("Accept", "audio/L16;rate=24000;channels=1");

  // We want to read X-BMO-Volume off the response. HTTPClient only tracks
  // headers we explicitly request via collectHeaders().
  static const char* kCollectedHeaders[] = { "X-BMO-Volume" };
  http.collectHeaders(kCollectedHeaders, 1);

  // Block on response headers. HTTPClient::POST returns the HTTP status code
  // (or a negative HTTPClient error code).
  emit_(BrainStatus::Thinking);
  const uint32_t requestStart = millis();
  const int status = http.POST(body, totalLen);

  if (status != 200) {
    Serial.printf("[brain] POST /api/brain status=%d in %lums\n",
                  status,
                  static_cast<unsigned long>(millis() - requestStart));
    http.end();
    emit_(BrainStatus::Error);
    return false;
  }

  Serial.printf("[brain] POST /api/brain status=200 in %lums\n",
                static_cast<unsigned long>(millis() - requestStart));

  // Pick up the dashboard-controlled volume and propagate it before we
  // start filling the speaker buffer, so the very first chunk plays at the
  // correct level.
  if (bmo_set_volume_from_dashboard) {
    String vh = http.header("X-BMO-Volume");
    if (vh.length() > 0) {
      const long parsed = vh.toInt();
      if (parsed >= 0 && parsed <= 100) {
        bmo_set_volume_from_dashboard(static_cast<int>(parsed));
      }
    }
  }

  // Stream body in 4 KiB chunks straight to the I2S buffer.
  WiFiClient* stream = http.getStreamPtr();
  if (stream == nullptr) {
    Serial.println("[brain] no response stream");
    http.end();
    emit_(BrainStatus::Error);
    return false;
  }

  // Reset the downsampler's cross-chunk byte/phase state so this reply starts
  // byte-aligned regardless of how the previous one ended (see the weak-symbol
  // comment above). Skipping this is what turned the 2nd+ reply into noise.
  if (bmo_audio_reset_stream) bmo_audio_reset_stream();

  uint8_t buf[kAudioChunkBytes];
  size_t totalBytes = 0;
  bool firstChunk = true;
  uint32_t talkStart = 0;          // set on first audio chunk
  bool interrupted = false;        // user tapped to stop
  bool talkCapped = false;         // hit kMaxTalkMs
  const uint32_t totalDeadline = requestStart + kTotalResponseTimeoutMs;

  while (http.connected() && millis() < totalDeadline) {
    // User-initiated interrupt (e.g. touch during playback). Clean stop, not
    // an error — BMO behaves like a person who's been interrupted mid-word.
    if (!firstChunk && shouldKeepTalkingCb_ && !shouldKeepTalkingCb_()) {
      interrupted = true;
      break;
    }
    // Talk-duration cap. Measured from the first chunk so connect/think time
    // doesn't count against it.
    if (!firstChunk && (millis() - talkStart) >= kMaxTalkMs) {
      talkCapped = true;
      break;
    }

    const size_t available = stream->available();
    if (available == 0) {
      delay(2);
      continue;
    }
    const size_t toRead = available > sizeof(buf) ? sizeof(buf) : available;
    const int read = stream->readBytes(buf, toRead);
    if (read <= 0) {
      // No more data and no longer connected — normal stream end.
      break;
    }

    if (firstChunk) {
      Serial.printf("[brain] streaming audio, first chunk %lums after request\n",
                    static_cast<unsigned long>(millis() - requestStart));
      firstChunk = false;
      talkStart = millis();
      emit_(BrainStatus::Talking);
    }

    writePcm16ChunkToAudio(buf, static_cast<size_t>(read));
    totalBytes += static_cast<size_t>(read);
  }

  http.end();

  // Clean, user-initiated stop: caller plays a soft "okay!" cue + neutral
  // mood. We return true (success) so the caller doesn't show the error face.
  if (interrupted) {
    Serial.printf("[brain] talk interrupted by user after %lums, %u bytes\n",
                  static_cast<unsigned long>(millis() - requestStart),
                  static_cast<unsigned>(totalBytes));
    emit_(BrainStatus::Idle);
    return true;
  }

  // Hit the talk cap: also a graceful stop (BMO trails off), not an error.
  if (talkCapped) {
    Serial.printf("[brain] talk cap (%lums) reached, %u bytes — trailing off\n",
                  static_cast<unsigned long>(kMaxTalkMs),
                  static_cast<unsigned>(totalBytes));
    emit_(BrainStatus::Idle);
    return true;
  }

  if (millis() >= totalDeadline) {
    Serial.printf("[brain] total-response timeout after %lums, %u bytes\n",
                  static_cast<unsigned long>(millis() - requestStart),
                  static_cast<unsigned>(totalBytes));
    emit_(BrainStatus::Error);
    return false;
  }

  Serial.printf("[brain] stream ended after %lums, %u bytes\n",
                static_cast<unsigned long>(millis() - requestStart),
                static_cast<unsigned>(totalBytes));
  emit_(BrainStatus::Idle);
  return true;
}

bool BrainClient::requestThought() {
  // No mic capture and no request body — this is a GET. The dashboard does the
  // recall + LLM + capture and streams back the spoken musing (or 204 to say
  // "not this round"). Status starts at Thinking since there's nothing to
  // listen to.
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[brain] (thought) wifi not connected");
    emit_(BrainStatus::Error);
    return false;
  }
  if (dashboardUrl_.length() == 0) {
    Serial.println("[brain] (thought) no dashboard url configured");
    emit_(BrainStatus::Error);
    return false;
  }

  WiFiClientSecure tls;
  tls.setInsecure();  // see file header — fingerprint is the real auth.
  tls.setTimeout(kConnectTimeoutMs / 1000);

  HTTPClient http;
  http.setTimeout(kFirstByteTimeoutMs);
  http.setReuse(false);

  const String url = dashboardUrl_ + "/api/brain/idle-thought";
  if (!http.begin(tls, url)) {
    Serial.println("[brain] (thought) http.begin failed");
    emit_(BrainStatus::Error);
    return false;
  }

  http.addHeader("X-BMO-Fingerprint", BMO_FINGERPRINT);
  http.addHeader("Accept", "audio/L16;rate=24000;channels=1");
  static const char* kCollectedHeaders[] = { "X-BMO-Volume" };
  http.collectHeaders(kCollectedHeaders, 1);

  emit_(BrainStatus::Thinking);
  const uint32_t requestStart = millis();
  const int status = http.GET();

  // 204 No Content: BMO chose not to think this round (skill off, or the
  // dashboard skipped generation). A clean non-event — go back to Idle and
  // report success so the caller doesn't flash an error face.
  if (status == 204) {
    Serial.printf("[brain] (thought) 204 no-content in %lums — staying quiet\n",
                  static_cast<unsigned long>(millis() - requestStart));
    http.end();
    emit_(BrainStatus::Idle);
    return true;
  }

  if (status != 200) {
    Serial.printf("[brain] (thought) GET status=%d in %lums\n",
                  status,
                  static_cast<unsigned long>(millis() - requestStart));
    http.end();
    emit_(BrainStatus::Error);
    return false;
  }

  // Propagate dashboard-controlled volume before the first chunk plays.
  if (bmo_set_volume_from_dashboard) {
    String vh = http.header("X-BMO-Volume");
    if (vh.length() > 0) {
      const long parsed = vh.toInt();
      if (parsed >= 0 && parsed <= 100) {
        bmo_set_volume_from_dashboard(static_cast<int>(parsed));
      }
    }
  }

  WiFiClient* stream = http.getStreamPtr();
  if (stream == nullptr) {
    Serial.println("[brain] (thought) no response stream");
    http.end();
    emit_(BrainStatus::Error);
    return false;
  }

  // Same streaming loop as ask(): byte-align the downsampler, then pump 4 KiB
  // chunks straight to I2S, honoring the interrupt predicate and talk cap.
  if (bmo_audio_reset_stream) bmo_audio_reset_stream();

  uint8_t buf[kAudioChunkBytes];
  size_t totalBytes = 0;
  bool firstChunk = true;
  uint32_t talkStart = 0;
  bool interrupted = false;
  bool talkCapped = false;
  const uint32_t totalDeadline = requestStart + kTotalResponseTimeoutMs;

  while (http.connected() && millis() < totalDeadline) {
    if (!firstChunk && shouldKeepTalkingCb_ && !shouldKeepTalkingCb_()) {
      interrupted = true;
      break;
    }
    if (!firstChunk && (millis() - talkStart) >= kMaxTalkMs) {
      talkCapped = true;
      break;
    }

    const size_t available = stream->available();
    if (available == 0) {
      delay(2);
      continue;
    }
    const size_t toRead = available > sizeof(buf) ? sizeof(buf) : available;
    const int read = stream->readBytes(buf, toRead);
    if (read <= 0) break;

    if (firstChunk) {
      Serial.printf("[brain] (thought) streaming audio, first chunk %lums after request\n",
                    static_cast<unsigned long>(millis() - requestStart));
      firstChunk = false;
      talkStart = millis();
      emit_(BrainStatus::Talking);
    }

    writePcm16ChunkToAudio(buf, static_cast<size_t>(read));
    totalBytes += static_cast<size_t>(read);
  }

  http.end();

  if (interrupted) {
    Serial.printf("[brain] (thought) interrupted by user after %lums, %u bytes\n",
                  static_cast<unsigned long>(millis() - requestStart),
                  static_cast<unsigned>(totalBytes));
    emit_(BrainStatus::Idle);
    return true;
  }
  if (talkCapped) {
    Serial.printf("[brain] (thought) talk cap reached, %u bytes — trailing off\n",
                  static_cast<unsigned>(totalBytes));
    emit_(BrainStatus::Idle);
    return true;
  }
  if (millis() >= totalDeadline) {
    Serial.printf("[brain] (thought) total-response timeout after %lums, %u bytes\n",
                  static_cast<unsigned long>(millis() - requestStart),
                  static_cast<unsigned>(totalBytes));
    emit_(BrainStatus::Error);
    return false;
  }

  Serial.printf("[brain] (thought) stream ended after %lums, %u bytes\n",
                static_cast<unsigned long>(millis() - requestStart),
                static_cast<unsigned>(totalBytes));
  emit_(BrainStatus::Idle);
  return true;
}

}  // namespace bmo
