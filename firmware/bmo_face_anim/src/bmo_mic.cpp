// =============================================================================
// bmo_mic.cpp
//
// ESP32-C3 has only one I²S peripheral, so the mic must share BCLK/LRC with
// the speaker. micBegin() therefore re-installs the driver in TX|RX mode and
// adds the mic data pin (DIN). This is destructive — call AFTER `audioInit()`
// has succeeded and BEFORE any speaker writes you care about, but in
// practice setup() does it in that order and that's enough.
//
// INMP441 and MAX98357A both run happily at 16 kHz / 16-bit (the mic emits
// 24-bit data padded to 32-bit; we shift it down before storing).
// =============================================================================

#include "bmo_mic.h"

#include <driver/i2s.h>

namespace bmo {

namespace {

// We use the *speaker's* I²S unit. The chip only has one. BCLK/LRC come
// straight from main.cpp's pin map (GP0/GP1). DIN is the only mic-specific
// pin we add here.
constexpr i2s_port_t MIC_I2S_PORT = I2S_NUM_0;
constexpr int        PIN_MIC_DIN  = 8;

constexpr int PIN_I2S_BCLK_SHARED = 0;
constexpr int PIN_I2S_LRC_SHARED  = 1;
constexpr int PIN_I2S_DOUT_SHARED = 2;

constexpr uint32_t MIC_SAMPLE_RATE_HZ = 16000;

// 96 KB scratch buffer for the captured WAV body. Lives in BSS.
__attribute__((aligned(4)))
int16_t s_capture[kMicCaptureSamples];

}  // namespace

int16_t* micStaticBuffer() { return s_capture; }

bool micBegin() {
  // Tear down the speaker-only driver from audioInit() so we can install a
  // duplex one. main.cpp must be sequenced so audioInit() runs before this.
  i2s_driver_uninstall(MIC_I2S_PORT);

  i2s_config_t cfg = {};
  cfg.mode                = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX | I2S_MODE_RX);
  cfg.sample_rate         = MIC_SAMPLE_RATE_HZ;
  cfg.bits_per_sample     = I2S_BITS_PER_SAMPLE_16BIT;
  cfg.channel_format      = I2S_CHANNEL_FMT_ONLY_LEFT;
  cfg.communication_format= I2S_COMM_FORMAT_STAND_I2S;
  cfg.intr_alloc_flags    = ESP_INTR_FLAG_LEVEL1;
  cfg.dma_buf_count       = 4;
  cfg.dma_buf_len         = 256;
  cfg.use_apll            = false;
  cfg.tx_desc_auto_clear  = true;
  cfg.fixed_mclk          = 0;

  i2s_pin_config_t pins = {};
  pins.bck_io_num   = PIN_I2S_BCLK_SHARED;
  pins.ws_io_num    = PIN_I2S_LRC_SHARED;
  pins.data_out_num = PIN_I2S_DOUT_SHARED;
  pins.data_in_num  = PIN_MIC_DIN;
  pins.mck_io_num   = I2S_PIN_NO_CHANGE;

  esp_err_t err = i2s_driver_install(MIC_I2S_PORT, &cfg, 0, NULL);
  if (err != ESP_OK) {
    Serial.printf("[mic] driver_install (duplex) failed: %d\n",
                  static_cast<int>(err));
    return false;
  }
  err = i2s_set_pin(MIC_I2S_PORT, &pins);
  if (err != ESP_OK) {
    Serial.printf("[mic] set_pin (duplex) failed: %d\n",
                  static_cast<int>(err));
    return false;
  }
  i2s_zero_dma_buffer(MIC_I2S_PORT);
  return true;
}

// INMP441 emits 16-bit samples when configured at I2S_BITS_PER_SAMPLE_16BIT
// in the controller. We can read directly into int16_t and store as-is.
// `keepGoing` lets the caller stop early (e.g. on touch release).
size_t micCapture(int16_t* dest, size_t maxSamples, bool (*keepGoing)()) {
  if (dest == nullptr || maxSamples == 0) return 0;

  size_t totalSamples = 0;

  while (totalSamples < maxSamples) {
    if (keepGoing != nullptr && !keepGoing()) break;

    const size_t want =
        (maxSamples - totalSamples) * sizeof(int16_t);

    size_t read = 0;
    esp_err_t err = i2s_read(MIC_I2S_PORT,
                             dest + totalSamples,
                             want,
                             &read,
                             50 / portTICK_PERIOD_MS);
    if (err != ESP_OK) {
      Serial.printf("[mic] i2s_read failed: %d\n", static_cast<int>(err));
      break;
    }
    if (read == 0) continue;
    totalSamples += read / sizeof(int16_t);
  }
  return totalSamples;
}

}  // namespace bmo
