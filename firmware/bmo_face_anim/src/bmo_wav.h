// =============================================================================
// bmo_wav.h
//
// Minimal RIFF/WAVE header builder. Used to wrap mic PCM16 captures before
// shipping to the dashboard /api/brain endpoint, which expects audio/wav.
// =============================================================================

#pragma once

#include <stddef.h>
#include <stdint.h>

namespace bmo {

// Writes a 44-byte RIFF/WAVE PCM16 header into `out`. The buffer must be at
// least 44 bytes. `dataSize` is the byte length of the raw PCM that will
// follow — for streaming-WAV ("size unknown") use 0xFFFFFFFF.
void wavWriteHeader(uint8_t* out,
                    uint32_t dataSize,
                    uint32_t sampleRate,
                    uint16_t channels,
                    uint16_t bitsPerSample);

}  // namespace bmo
