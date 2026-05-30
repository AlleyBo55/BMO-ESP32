// =============================================================================
// bmo_wav.cpp
// =============================================================================

#include "bmo_wav.h"

#include <string.h>

namespace bmo {

namespace {

inline void writeU32LE(uint8_t* p, uint32_t v) {
  p[0] = static_cast<uint8_t>(v & 0xFF);
  p[1] = static_cast<uint8_t>((v >> 8) & 0xFF);
  p[2] = static_cast<uint8_t>((v >> 16) & 0xFF);
  p[3] = static_cast<uint8_t>((v >> 24) & 0xFF);
}

inline void writeU16LE(uint8_t* p, uint16_t v) {
  p[0] = static_cast<uint8_t>(v & 0xFF);
  p[1] = static_cast<uint8_t>((v >> 8) & 0xFF);
}

}  // namespace

void wavWriteHeader(uint8_t* out,
                    uint32_t dataSize,
                    uint32_t sampleRate,
                    uint16_t channels,
                    uint16_t bitsPerSample) {
  const uint16_t blockAlign = static_cast<uint16_t>(channels * bitsPerSample / 8);
  const uint32_t byteRate = sampleRate * blockAlign;
  const uint32_t riffSize =
      (dataSize == 0xFFFFFFFFu) ? 0xFFFFFFFFu : 36u + dataSize;

  memcpy(out + 0,  "RIFF", 4);
  writeU32LE(out + 4, riffSize);
  memcpy(out + 8,  "WAVE", 4);
  memcpy(out + 12, "fmt ", 4);
  writeU32LE(out + 16, 16);
  writeU16LE(out + 20, 1);              // PCM
  writeU16LE(out + 22, channels);
  writeU32LE(out + 24, sampleRate);
  writeU32LE(out + 28, byteRate);
  writeU16LE(out + 32, blockAlign);
  writeU16LE(out + 34, bitsPerSample);
  memcpy(out + 36, "data", 4);
  writeU32LE(out + 40, dataSize);
}

}  // namespace bmo
