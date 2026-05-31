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

// -----------------------------------------------------------------------------
// PcmStreamSink — the de-chunking + WAV-skip fix for the "sssk" noise bug.
//
// THE BUG: the dashboard streams the reply as an HTTP chunked response
// (Transfer-Encoding: chunked, a ReadableStream with no Content-Length) and
// prepends a 44-byte WAV header. The OLD code read http.getStreamPtr()->
// readBytes() and pushed every byte to I2S as PCM. But Arduino's HTTPClient
// only DE-CHUNKS inside writeToStream() — never on the raw stream pointer. So
// the firmware was playing the HTTP chunk-size markers ("<hexlen>\r\n" between
// every ~4 KB) AND the WAV header as if they were audio samples → the periodic
// "noise / normal / noise / normal" hiss. The browser/simulator de-chunks
// transparently, which is why it was always clean there.
//
// THE FIX: feed HTTPClient::writeToStream() a custom Stream whose write() gets
// the already-DE-CHUNKED body (exactly what the browser sees). We skip the
// leading 44-byte WAV header, then forward pure PCM16 to the speaker. The same
// sink also handles touch-to-interrupt and the talk-duration cap by returning
// a short write to abort the transfer cleanly.
// -----------------------------------------------------------------------------
class PcmStreamSink : public Stream {
 public:
  explicit PcmStreamSink(bool (*keepTalking)())
      : keepTalking_(keepTalking) {}

  // Write-only sink: reads are never used by writeToStream().
  int available() override { return 0; }
  int read() override { return -1; }
  int peek() override { return -1; }
  size_t write(uint8_t b) override { return write(&b, 1); }

  size_t write(const uint8_t* buffer, size_t size) override {
    if (size == 0) return 0;
    // Once aborted, keep returning a short write so HTTPClient stops the
    // transfer (it retries once, then returns HTTPC_ERROR_STREAM_WRITE, which
    // we recognise as our own clean stop via interrupted_/capped_).
    if (aborted_) return 0;

    if (firstBlock_) {
      firstBlock_ = false;
      talkStart_ = millis();
    }

    // Touch-to-interrupt: tap BMO mid-reply and it stops like a person who's
    // been interrupted. Checked per ~4 KB block (HTTP_TCP_RX_BUFFER_SIZE).
    if (keepTalking_ && !keepTalking_()) {
      interrupted_ = true;
      aborted_ = true;
      return 0;
    }
    // Talk-duration safety cap (don't let BMO monologue forever).
    if ((millis() - talkStart_) >= kMaxTalkMs) {
      capped_ = true;
      aborted_ = true;
      return 0;
    }

    size_t off = 0;
    // Skip the 44-byte WAV header that the dashboard prepends (only the
    // browser needs it; the device wants raw PCM16). Spread across blocks in
    // case the body is split, though it always arrives in the first block.
    if (headerSkip_ > 0) {
      const size_t s = headerSkip_ < size ? headerSkip_ : size;
      headerSkip_ -= s;
      off += s;
    }
    if (off < size) {
      writePcm16ChunkToAudio(buffer + off, size - off);
      totalBytes_ += (size - off);
    }
    return size;  // tell HTTPClient we consumed the whole block
  }

  bool interrupted() const { return interrupted_; }
  bool capped() const { return capped_; }
  bool sawData() const { return !firstBlock_; }
  size_t totalBytes() const { return totalBytes_; }

 private:
  bool (*keepTalking_)();
  size_t   headerSkip_ = kWavHeaderLen;  // 44-byte WAV header to discard
  size_t   totalBytes_ = 0;
  uint32_t talkStart_  = 0;
  bool     firstBlock_  = true;
  bool     interrupted_ = false;
  bool     capped_      = false;
  bool     aborted_     = false;
};

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

  // Stream the reply body through HTTPClient::writeToStream() into our custom
  // PcmStreamSink. This is THE fix for the "sssk" noise: writeToStream()
  // de-chunks the HTTP chunked transfer-encoding (the dashboard streams with
  // Transfer-Encoding: chunked), so the sink receives the SAME clean body the
  // browser sees — no chunk-size markers played as audio. The sink then skips
  // the 44-byte WAV header and forwards pure PCM16 to the speaker.
  if (bmo_audio_reset_stream) bmo_audio_reset_stream();

  emit_(BrainStatus::Talking);
  PcmStreamSink sink(shouldKeepTalkingCb_);
  const int written = http.writeToStream(&sink);
  http.end();

  const size_t totalBytes = sink.totalBytes();

  // Clean, user-initiated stop: caller plays a soft "okay!" cue + neutral
  // mood. We return true (success) so the caller doesn't show the error face.
  if (sink.interrupted()) {
    Serial.printf("[brain] talk interrupted by user after %lums, %u bytes\n",
                  static_cast<unsigned long>(millis() - requestStart),
                  static_cast<unsigned>(totalBytes));
    emit_(BrainStatus::Idle);
    return true;
  }

  // Hit the talk cap: also a graceful stop (BMO trails off), not an error.
  if (sink.capped()) {
    Serial.printf("[brain] talk cap (%lums) reached, %u bytes — trailing off\n",
                  static_cast<unsigned long>(kMaxTalkMs),
                  static_cast<unsigned>(totalBytes));
    emit_(BrainStatus::Idle);
    return true;
  }

  // writeToStream() returns the number of body bytes written, or a negative
  // HTTPClient error. A negative return AFTER we received audio is treated as
  // a normal end-of-stream (the server closed the connection); only treat it
  // as an error if we never got any audio at all.
  if (written < 0 && !sink.sawData()) {
    Serial.printf("[brain] writeToStream error %d, no audio received after %lums\n",
                  written,
                  static_cast<unsigned long>(millis() - requestStart));
    emit_(BrainStatus::Error);
    return false;
  }

  Serial.printf("[brain] stream ended after %lums, %u bytes (writeToStream=%d)\n",
                static_cast<unsigned long>(millis() - requestStart),
                static_cast<unsigned>(totalBytes),
                written);
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

  if (http.getStreamPtr() == nullptr) {
    Serial.println("[brain] (thought) no response stream");
    http.end();
    emit_(BrainStatus::Error);
    return false;
  }

  // Same de-chunking fix as ask(): route the chunked reply through
  // writeToStream() into the PCM sink so the device gets clean, de-chunked,
  // header-stripped PCM16 (see PcmStreamSink for the full rationale).
  if (bmo_audio_reset_stream) bmo_audio_reset_stream();

  emit_(BrainStatus::Talking);
  PcmStreamSink sink(shouldKeepTalkingCb_);
  const int written = http.writeToStream(&sink);
  http.end();

  const size_t totalBytes = sink.totalBytes();

  if (sink.interrupted()) {
    Serial.printf("[brain] (thought) interrupted by user after %lums, %u bytes\n",
                  static_cast<unsigned long>(millis() - requestStart),
                  static_cast<unsigned>(totalBytes));
    emit_(BrainStatus::Idle);
    return true;
  }
  if (sink.capped()) {
    Serial.printf("[brain] (thought) talk cap reached, %u bytes — trailing off\n",
                  static_cast<unsigned>(totalBytes));
    emit_(BrainStatus::Idle);
    return true;
  }
  if (written < 0 && !sink.sawData()) {
    Serial.printf("[brain] (thought) writeToStream error %d, no audio after %lums\n",
                  written,
                  static_cast<unsigned long>(millis() - requestStart));
    emit_(BrainStatus::Error);
    return false;
  }

  Serial.printf("[brain] (thought) stream ended after %lums, %u bytes (writeToStream=%d)\n",
                static_cast<unsigned long>(millis() - requestStart),
                static_cast<unsigned>(totalBytes),
                written);
  emit_(BrainStatus::Idle);
  return true;
}

}  // namespace bmo
