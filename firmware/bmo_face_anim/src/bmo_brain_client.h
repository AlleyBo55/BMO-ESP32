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

  // Sends the recorded mic audio (16 kHz mono PCM16) to the dashboard
  // /api/brain endpoint and streams the response audio back in 4 KiB chunks.
  //
  // IMPORTANT: the caller must capture the mic PCM directly into
  // requestPcmBuffer() (up to requestPcmCapacitySamples() samples), then call
  // ask(sampleCount). The request body — multipart prefix, WAV header, PCM,
  // and suffix — is assembled in place inside one static buffer with zero heap
  // allocation. This is what fixes the OOM that previously killed
  // touch-to-speak right after recording (the old design held three separate
  // ~96 KB copies of the audio, which doesn't fit in the C3's post-WiFi heap).
  //
  // Returns true on success (HTTP 200 + a complete stream), false on any
  // failure (no network, non-200, mid-stream abort, total-time budget hit).
  // Status transitions: Listening (entry) → Thinking (post-headers) →
  // Talking (first audio chunk) → Idle (success) or Error (failure).
  bool ask(size_t pcmSampleCount);

  // Requests a spontaneous "random thought" from the dashboard and streams
  // the spoken reply back, exactly like ask() but with no mic audio: the
  // dashboard generates a short musing (recall + LLM), remembers it, and
  // synthesizes it to speech. This is the device half of the gbrain/OpenClaw
  // "keep thinking on your own" loop; the firmware fires it after a few
  // touches so it costs nothing while BMO sits untouched (and stays silent in
  // quiet hours when no one is around to touch it).
  //
  // GET <dashboard>/api/brain/idle-thought with the X-BMO-Fingerprint header.
  //
  // Returns true when BMO spoke a thought (HTTP 200 + a complete stream) OR
  // when the dashboard declined to think this round (HTTP 204 — skill off or
  // generation skipped; a clean non-event). Returns false only on a real
  // failure (no network, non-200/204, mid-stream abort, timeout). Status
  // transitions mirror ask(): Thinking → Talking → Idle, or Error.
  //
  // Honors the same onShouldKeepTalking() interrupt predicate as ask(), so a
  // touch during the musing stops it mid-sentence.
  bool requestThought();

  // Returns the static buffer the caller must capture mic PCM into before
  // calling ask(). Valid for the life of the program. Do not free.
  static int16_t* requestPcmBuffer();

  // Maximum number of int16 samples requestPcmBuffer() can hold.
  static size_t requestPcmCapacitySamples();

  // Optional "should I keep streaming the reply?" predicate. When set, the
  // response-streaming loop calls it between chunks; returning false stops
  // playback early and ask() returns true (a clean, user-initiated stop, not
  // an error). Used for touch-to-interrupt: tap BMO while it's talking and it
  // stops mid-sentence like a person who's been interrupted. Pass nullptr to
  // disable.
  void onShouldKeepTalking(bool (*cb)());

  // Subscribe to status transitions for the face renderer. Only one subscriber
  // is supported; passing nullptr unsubscribes.
  void onStatus(void (*cb)(BrainStatus));

 private:
  void emit_(BrainStatus s);

  void (*statusCb_)(BrainStatus);
  bool (*shouldKeepTalkingCb_)();
  BrainStatus status_;
  bool wifiBegun_;
  String dashboardUrl_;
};

}  // namespace bmo
