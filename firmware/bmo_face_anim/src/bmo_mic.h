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

// Number of mic samples we are willing to allocate. 3 seconds at 16 kHz =
// 48000 samples = 96 KB of int16_t. ESP32-C3 has ~330 KB SRAM total; with
// the framebuffer + WiFi heap that's right at the edge but works.
constexpr size_t kMicCaptureSamples = 48000;

// Initialise the INMP441 RX path on the shared I2S port. Must be called
// AFTER `audioInit()` because both directions use the same I2S controller.
// Returns true on success, false if the driver init returned an error.
bool micBegin();

// Captures up to `kMicCaptureSamples` samples from the mic, blocking the
// caller. Returns the number of samples actually captured. The capture stops
// early when:
//   - `keepGoing()` returns false (e.g. the user released the touch button), or
//   - the buffer is full.
// Pass nullptr for `keepGoing` to capture the full buffer unconditionally.
size_t micCapture(int16_t* dest, size_t maxSamples, bool (*keepGoing)());

// Returns a pointer to a static 96 KB capture buffer, available across the
// app. Lives in BSS so it does not contribute to runtime allocation costs.
int16_t* micStaticBuffer();

}  // namespace bmo
