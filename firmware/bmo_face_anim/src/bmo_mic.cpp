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
//
// PIN_MIC_DIN was GPIO8 — which is a BOOT STRAPPING pin on the ESP32-C3 (and
// on the SuperMini it's tied to the onboard LED with a pull-up). With nothing
// strongly driving it, the I2S input read it as a stuck-HIGH line: every
// sample came back 0xFFFF (= -1), peak≈1, on BOTH channels regardless of
// bit-width — i.e. "the mic captures pure silence" and STT got an empty
// transcript. Moving the mic SD/DOUT wire to GPIO5 (a free, non-strapping pin)
// fixes it. GPIO9 is also a strapping pin — do not use it for this.
constexpr i2s_port_t MIC_I2S_PORT = I2S_NUM_0;
constexpr int        PIN_MIC_DIN  = 5;

constexpr int PIN_I2S_BCLK_SHARED = 0;
constexpr int PIN_I2S_LRC_SHARED  = 1;
constexpr int PIN_I2S_DOUT_SHARED = 2;

constexpr uint32_t MIC_SAMPLE_RATE_HZ = 16000;

// Which I2S slot the INMP441 data is read from. Default ONLY_LEFT, but the
// ESP32 controller commonly reads the opposite slot from the mic's L/R strap,
// so micSetChannel() can flip this at runtime to find the one with signal.
i2s_channel_fmt_t s_micChannel = I2S_CHANNEL_FMT_ONLY_LEFT;

}  // namespace

// Installs the shared duplex I2S driver with the current s_micChannel.
static bool installMicDriver() {
  i2s_driver_uninstall(MIC_I2S_PORT);

  i2s_config_t cfg = {};
  cfg.mode                = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX | I2S_MODE_RX);
  cfg.sample_rate         = MIC_SAMPLE_RATE_HZ;
  cfg.bits_per_sample     = I2S_BITS_PER_SAMPLE_16BIT;
  cfg.channel_format      = s_micChannel;
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

bool micBegin() {
  // Tear down the speaker-only driver from audioInit() so we can install a
  // duplex one. main.cpp must be sequenced so audioInit() runs before this.
  return installMicDriver();
}

bool micSetChannel(bool right) {
  s_micChannel = right ? I2S_CHANNEL_FMT_ONLY_RIGHT : I2S_CHANNEL_FMT_ONLY_LEFT;
  Serial.printf("[mic] channel -> %s\n", right ? "RIGHT" : "LEFT");
  return installMicDriver();
}

// INMP441 capture. The mic shares the single I2S peripheral with the speaker,
// installed at 16-bit by micBegin(). We read 16-bit frames directly.
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
