// =============================================================================
// bmo_brain_client.h
//
// HTTPS client that ships recorded audio to <BMO_DASHBOARD_URL>/api/brain and
// streams the PCM16 reply back. Authenticates with the X-BMO-Fingerprint
// header read from include/secrets.h.
//
// Target: ESP32-C3 + Arduino + PlatformIO. Uses Arduino String for ergonomics
// (the strings here are small — single-digit KiB at most).
//
// Threading: ask() blocks the caller for the duration of the request. Status
// callbacks fire from the same thread that called ask().
// =============================================================================

#pragma once

#include <Arduino.h>
#include <stddef.h>
#include <stdint.h>

namespace bmo {

// Coarse phase the dashboard call is in. The face renderer subscribes to this
// to drive listening / thinking / talking moods on screen.
enum class BrainStatus {
  Idle,        // no request in flight
  Listening,   // capturing audio (caller-driven; emitted on ask() entry)
  Thinking,    // request sent, waiting for first response byte
  Talking,     // streaming PCM16 audio back to the I2S buffer
  Error,       // last request failed (timeout, non-200, network)
};

class BrainClient {
 public:
  BrainClient();

  // Sets the dashboard origin used for `/api/brain` calls. Safe to call any
  // number of times; later calls replace the previous URL.
  void setDashboardUrl(const String& url) { dashboardUrl_ = url; }

  // Marks the WiFi connection as already established by the caller (e.g.
  // the provisioning module brought it up before we got here). Subsequent
  // `ask()` calls skip the WiFi-connect step and go straight to HTTPS.
  void markWifiReady() { wifiBegun_ = true; }

  // Initializes WiFi if it's not already up. Safe to call multiple times.
  // `setDashboardUrl()` must have been called first.
  void begin();

  // Sends a recorded WAV blob (16 kHz mono PCM16 wrapped in a RIFF/WAVE
  // header by the caller) to the dashboard /api/brain endpoint. Streams the
  // response audio in 4 KiB chunks; the implementation forwards each chunk
  // straight into the I2S output ring buffer used by the face/audio task.
  //
  // Returns true on success (HTTP 200 + a complete stream), false on any
  // failure (no network, non-200, mid-stream abort, total-time budget hit).
  // Status transitions: Listening (entry) → Thinking (post-headers) →
  // Talking (first audio chunk) → Idle (success) or Error (failure).
  bool ask(const uint8_t* wavData, size_t wavLen);

  // Subscribe to status transitions for the face renderer. Only one subscriber
  // is supported; passing nullptr unsubscribes.
  void onStatus(void (*cb)(BrainStatus));

 private:
  void emit_(BrainStatus s);

  void (*statusCb_)(BrainStatus);
  BrainStatus status_;
  bool wifiBegun_;
  String dashboardUrl_;
};

}  // namespace bmo
