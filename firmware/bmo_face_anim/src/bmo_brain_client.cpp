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

// Only the fingerprint is compiled in; WiFi creds + dashboard URL come from
// the provisioning singleton at runtime.
#include "../include/secrets.h"

namespace bmo {

namespace {

// Multipart boundary. Fixed and unguessable-enough for a single-host firmware.
constexpr const char* kMultipartBoundary =
    "----BMOFirmwareBoundaryE4F2A1B0C3D9";

// Streaming response buffer. ESP32-C3 has ~320 KiB of SRAM; 4 KiB is the
// design.md spec ("4 KiB audio chunks straight into the I2S buffer").
constexpr size_t kAudioChunkBytes = 4096;

constexpr uint32_t kConnectTimeoutMs       = 5000;
constexpr uint32_t kFirstByteTimeoutMs     = 10000;
constexpr uint32_t kTotalResponseTimeoutMs = 30000;

// Forward-declared in the header so main.cpp / audio task can supply this.
// This module does not own the I2S setup; it only feeds bytes in.
extern "C" void bmo_audio_push_pcm16(const uint8_t* data, size_t len)
    __attribute__((weak));

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

String buildMultipartPrefix() {
  String s;
  s.reserve(192);
  s += "--";
  s += kMultipartBoundary;
  s += "\r\n";
  s += "Content-Disposition: form-data; name=\"audio\"; filename=\"capture.wav\"\r\n";
  s += "Content-Type: audio/wav\r\n";
  s += "\r\n";
  return s;
}

String buildMultipartSuffix() {
  String s;
  s.reserve(64);
  s += "\r\n--";
  s += kMultipartBoundary;
  s += "--\r\n";
  return s;
}

}  // namespace

BrainClient::BrainClient()
    : statusCb_(nullptr), status_(BrainStatus::Idle), wifiBegun_(false) {}

void BrainClient::onStatus(void (*cb)(BrainStatus)) {
  statusCb_ = cb;
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

bool BrainClient::ask(const uint8_t* wavData, size_t wavLen) {
  emit_(BrainStatus::Listening);

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[brain] wifi not connected");
    emit_(BrainStatus::Error);
    return false;
  }
  if (wavData == nullptr || wavLen == 0) {
    Serial.println("[brain] empty wav buffer");
    emit_(BrainStatus::Error);
    return false;
  }

  // Build multipart body. The body is sent in three writes via HTTPClient's
  // sendRequest(method, payload, len) — for that we need the prefix, raw wav,
  // and suffix concatenated into one buffer. The wav payload is the bulk and
  // is bounded by mic capture size; on this firmware ~64 KiB max.
  const String prefix = buildMultipartPrefix();
  const String suffix = buildMultipartSuffix();
  const size_t totalLen = prefix.length() + wavLen + suffix.length();

  // Large allocation lives in the heap; a typical 3-second 16 kHz PCM16 capture
  // is ~96 KiB, comfortably within the ESP32-C3's SRAM after framework usage.
  uint8_t* body = static_cast<uint8_t*>(malloc(totalLen));
  if (body == nullptr) {
    Serial.printf("[brain] oom allocating %u bytes for request body\n",
                  static_cast<unsigned>(totalLen));
    emit_(BrainStatus::Error);
    return false;
  }
  memcpy(body, prefix.c_str(), prefix.length());
  memcpy(body + prefix.length(), wavData, wavLen);
  memcpy(body + prefix.length() + wavLen, suffix.c_str(), suffix.length());

  WiFiClientSecure tls;
  tls.setInsecure();  // see file header comment — fingerprint is the real auth.
  tls.setTimeout(kConnectTimeoutMs / 1000);

  HTTPClient http;
  http.setTimeout(kFirstByteTimeoutMs);
  http.setReuse(false);

  String url = dashboardUrl_ + "/api/brain";
  if (dashboardUrl_.length() == 0) {
    Serial.println("[brain] no dashboard url configured");
    free(body);
    emit_(BrainStatus::Error);
    return false;
  }
  if (!http.begin(tls, url)) {
    Serial.println("[brain] http.begin failed");
    free(body);
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
  free(body);

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

  uint8_t buf[kAudioChunkBytes];
  size_t totalBytes = 0;
  bool firstChunk = true;
  const uint32_t totalDeadline = requestStart + kTotalResponseTimeoutMs;

  while (http.connected() && millis() < totalDeadline) {
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
      emit_(BrainStatus::Talking);
    }

    writePcm16ChunkToAudio(buf, static_cast<size_t>(read));
    totalBytes += static_cast<size_t>(read);
  }

  http.end();

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

}  // namespace bmo
