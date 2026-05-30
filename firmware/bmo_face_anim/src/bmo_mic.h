// =============================================================================
// bmo_mic.h
//
// INMP441 microphone capture into a heap buffer. Uses the RX side of the
// shared I2S port that the speaker also uses (full-duplex). The TTP223 long
// hold gesture starts the capture; the brain task then ships it to the
// dashboard's /api/brain endpoint.
//
// Capture format: 16 kHz mono PCM16, raw — the brain glue wraps this in a
// RIFF/WAVE header before sending.
// =============================================================================

#pragma once

#include <Arduino.h>
#include <stddef.h>
#include <stdint.h>

namespace bmo {

// Number of mic samples we are willing to allocate. 2 seconds at 16 kHz =
// 32000 samples = 64 KB of int16_t.
//
// DO NOT raise this past 32000 without re-testing TLS. The buffer is a static
// allocation sharing SRAM with the mbedTLS handshake. 40000 (80 KB / 2.5s) was
// tried and FAILED: it left maxAlloc ~41 KB and the HTTPS POST died with
// status=-3 ("failed to send chunk") because the larger body couldn't be
// pushed through the TLS connection. 64 KB (2s) is the proven-safe size.
// Longer speech is handled by gain (clarity), not a bigger buffer.
constexpr size_t kMicCaptureSamples = 32000;

// Initialise the INMP441 RX path on the shared I2S port. Must be called
// AFTER `audioInit()` because both directions use the same I2S controller.
// Returns true on success, false if the driver init returned an error.
bool micBegin();

// Re-installs the shared I2S RX path using the given channel slot. The
// INMP441's data lands in the LEFT or RIGHT I2S slot depending on how its
// L/R pin is strapped AND a known ESP32 quirk where the controller often
// reads the opposite slot. If ONLY_LEFT captures silence, ONLY_RIGHT usually
// fixes it. Returns true on success. `right` selects ONLY_RIGHT when true,
// ONLY_LEFT when false.
bool micSetChannel(bool right);

// Sets software decimation: 1 = full 16 kHz, 2 = 8 kHz (doubles the seconds a
// fixed buffer holds), etc. The WAV header sent to STT MUST use
// micEffectiveRate() to match. 8 kHz is telephone quality — fine for speech.
void micSetDecimation(uint8_t factor);

// The effective capture sample rate after decimation (16000 / factor). Use
// this for the outgoing WAV header so STT decodes the audio at the right speed.
uint32_t micEffectiveRate();

// Captures up to `kMicCaptureSamples` samples from the mic, blocking the
// caller. Returns the number of samples actually captured. The capture stops
// early when:
//   - `keepGoing()` returns false (e.g. the user released the touch button), or
//   - the buffer is full.
// Pass nullptr for `keepGoing` to capture the full buffer unconditionally.
//
// Capture destination: the caller supplies the buffer. For the brain request
// path this is BrainClient::requestPcmBuffer(), so the mic writes straight
// into the HTTP request body with no extra copy or allocation.
size_t micCapture(int16_t* dest, size_t maxSamples, bool (*keepGoing)());

}  // namespace bmo
