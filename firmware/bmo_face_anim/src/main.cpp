// =============================================================================
// BMO face — extended expression set.
//
// Now supports 15 moods. Renders to a 160x128 RGB565 back-buffer, flushed in
// one hardware-SPI burst per frame at 40 MHz. ~30 fps animation.
//
// Target: ESP32-C3 Super Mini.
// Wiring:
//   VCC -> 3V3, GND -> GND, LED -> 3V3
//   CS  -> GP7, RESET -> GP10, A0 -> GP3, SD -> GP6, SCK -> GP4
// =============================================================================

#include <Arduino.h>
#include <SPI.h>
#include <math.h>
#include <driver/i2s.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>
#include "audio_clips.h"
#include "bmo_brain_client.h"
#include "bmo_mic.h"
#include "bmo_provisioning.h"

// -----------------------------------------------------------------------------
// Pin map
// -----------------------------------------------------------------------------
static constexpr int PIN_CS  = 7;
static constexpr int PIN_RST = 10;
static constexpr int PIN_DC  = 3;
static constexpr int PIN_SDA = 6;
static constexpr int PIN_SCK = 4;

// I2S audio output (MAX98357A)
static constexpr int PIN_I2S_BCLK = 0;
static constexpr int PIN_I2S_LRC  = 1;
static constexpr int PIN_I2S_DOUT = 2;

// Touch sensor (TTP223)
static constexpr int PIN_TOUCH = 20;

// Forward declarations for touch state used by playMood (defined later)
enum TouchKind : int;
extern volatile bool      g_touchPending;
extern volatile TouchKind g_pendingKind;
static void pollTouch();
static void askBrain();
static void renderBrainStatusFrame(uint32_t now);
static const char *touchKindName(TouchKind k);

// -----------------------------------------------------------------------------
// Panel geometry
// -----------------------------------------------------------------------------
static constexpr int TFT_W = 160;
static constexpr int TFT_H = 128;
static constexpr int X_OFFSET = 0;
static constexpr int Y_OFFSET = 0;

// -----------------------------------------------------------------------------
// BMO palette (RGB565)
//
// All moods share the same pale BMO screen background for visual consistency.
// `bgOverride` field is kept in FaceState for ad-hoc tints, but the built-in
// moods don't use it — moods that want to communicate temperature/sickness
// do it through icons (snowflakes, steam, sweat) layered on top of the
// standard BMO face color.
// -----------------------------------------------------------------------------
static constexpr uint16_t C_BG       = 0xCF3A;  // sampled BMO screen mint (~#CCE4D7)
static constexpr uint16_t C_BG_COLD  = C_BG;
static constexpr uint16_t C_BG_HOT   = C_BG;
static constexpr uint16_t C_BG_SICK  = C_BG;
static constexpr uint16_t C_INK      = 0x0000;
static constexpr uint16_t C_MOUTH    = 0x3AA7;  // sampled dark green mouth fill (~#3B5638)
static constexpr uint16_t C_SHINE    = 0xFFFF;
static constexpr uint16_t C_BLUSH    = 0xFCD5;
static constexpr uint16_t C_HEART    = 0xFB54;
static constexpr uint16_t C_STAR     = 0xFF6C;
static constexpr uint16_t C_TEAR     = 0x76FF;
static constexpr uint16_t C_SWEAT    = 0x7EFF;
static constexpr uint16_t C_TONGUE   = 0xB593;  // sampled muted lower mouth/tongue (~#B0B19D)
static constexpr uint16_t C_BROW     = 0x0000;
static uint16_t g_frameBg = C_BG;

// -----------------------------------------------------------------------------
// Hardware SPI
// -----------------------------------------------------------------------------
SPIClass tftSPI(FSPI);
static constexpr uint32_t SPI_HZ = 40 * 1000 * 1000;

static inline void csLo() { digitalWrite(PIN_CS, LOW); }
static inline void csHi() { digitalWrite(PIN_CS, HIGH); }
static inline void dcCmd()  { digitalWrite(PIN_DC, LOW); }
static inline void dcData() { digitalWrite(PIN_DC, HIGH); }

static inline void writeCmd(uint8_t cmd) {
  dcCmd(); csLo();
  tftSPI.transfer(cmd);
  csHi();
}
static inline void writeData(uint8_t b) {
  dcData(); csLo();
  tftSPI.transfer(b);
  csHi();
}

static void hwReset() {
  digitalWrite(PIN_RST, HIGH); delay(20);
  digitalWrite(PIN_RST, LOW);  delay(50);
  digitalWrite(PIN_RST, HIGH); delay(150);
}

static void tftInit() {
  hwReset();
  tftSPI.beginTransaction(SPISettings(SPI_HZ, MSBFIRST, SPI_MODE0));
  writeCmd(0x11); delay(150);
  writeCmd(0x3A); writeData(0x05);
  writeCmd(0x36); writeData(0x60);
  writeCmd(0x20);
  writeCmd(0x13);
  writeCmd(0x29); delay(50);
  tftSPI.endTransaction();
}

// -----------------------------------------------------------------------------
// Back-buffer
// -----------------------------------------------------------------------------
static uint16_t fb[TFT_W * TFT_H];

// -----------------------------------------------------------------------------
// Background face animation
//
// The brain flow blocks the main thread for several seconds inside
// HTTPClient::POST() with no foreground hook to redraw — which is why the
// Thinking face used to freeze on a single frame. This dedicated render task
// keeps the listening / thinking / talking face animating while the main
// thread is parked on the network. It only draws while g_brainFaceActive is
// true (the request window); the rest of the time the main loop owns the
// screen. g_faceMutex serializes all framebuffer + SPI access between the two.
// -----------------------------------------------------------------------------
static SemaphoreHandle_t g_faceMutex       = nullptr;  // guards fb + SPI
static volatile bool     g_brainFaceActive = false;    // task renders while true
static TaskHandle_t      g_faceTaskHandle  = nullptr;

static inline void putPx(int x, int y, uint16_t c) {
  if ((unsigned)x >= (unsigned)TFT_W || (unsigned)y >= (unsigned)TFT_H) return;
  fb[y * TFT_W + x] = c;
}
static void fbFill(uint16_t c) {
  for (int i = 0; i < TFT_W * TFT_H; ++i) fb[i] = c;
}
static void fbHLine(int x, int y, int w, uint16_t c) {
  if ((unsigned)y >= (unsigned)TFT_H) return;
  if (x < 0) { w += x; x = 0; }
  if (x + w > TFT_W) w = TFT_W - x;
  if (w <= 0) return;
  uint16_t *row = fb + y * TFT_W + x;
  for (int i = 0; i < w; ++i) row[i] = c;
}
static void fbVLine(int x, int y, int h, uint16_t c) {
  if ((unsigned)x >= (unsigned)TFT_W) return;
  if (y < 0) { h += y; y = 0; }
  if (y + h > TFT_H) h = TFT_H - y;
  if (h <= 0) return;
  for (int i = 0; i < h; ++i) fb[(y + i) * TFT_W + x] = c;
}
static void fbRect(int x, int y, int w, int h, uint16_t c) {
  if (w <= 0 || h <= 0) return;
  if (x < 0) { w += x; x = 0; }
  if (y < 0) { h += y; y = 0; }
  if (x + w > TFT_W) w = TFT_W - x;
  if (y + h > TFT_H) h = TFT_H - y;
  if (w <= 0 || h <= 0) return;
  for (int j = 0; j < h; ++j) {
    uint16_t *row = fb + (y + j) * TFT_W + x;
    for (int i = 0; i < w; ++i) row[i] = c;
  }
}
static void fbFillCircle(int cx, int cy, int r, uint16_t c) {
  if (r < 0) return;
  for (int y = -r; y <= r; ++y) {
    int dx = (int)floorf(sqrtf((float)(r * r - y * y)));
    fbHLine(cx - dx, cy + y, 2 * dx + 1, c);
  }
}
static void fbFillEllipse(int cx, int cy, int rx, int ry, uint16_t c) {
  if (rx <= 0 || ry <= 0) return;
  for (int y = -ry; y <= ry; ++y) {
    float t = (float)y / (float)ry;
    int dx = (int)floorf(rx * sqrtf(1.0f - t * t));
    fbHLine(cx - dx, cy + y, 2 * dx + 1, c);
  }
}
static void fbFillRoundRect(int x, int y, int w, int h, int r, uint16_t c) {
  if (r * 2 > w) r = w / 2;
  if (r * 2 > h) r = h / 2;
  if (r < 0) r = 0;
  fbRect(x + r, y, w - 2 * r, h, c);
  fbRect(x,         y + r, r, h - 2 * r, c);
  fbRect(x + w - r, y + r, r, h - 2 * r, c);
  fbFillCircle(x + r,         y + r,         r, c);
  fbFillCircle(x + w - r - 1, y + r,         r, c);
  fbFillCircle(x + r,         y + h - r - 1, r, c);
  fbFillCircle(x + w - r - 1, y + h - r - 1, r, c);
}

// Bresenham line for slanted eyebrows / tilted strokes.
static void fbLine(int x0, int y0, int x1, int y1, int thickness, uint16_t c) {
  int dx = abs(x1 - x0);
  int dy = -abs(y1 - y0);
  int sx = x0 < x1 ? 1 : -1;
  int sy = y0 < y1 ? 1 : -1;
  int err = dx + dy;
  while (true) {
    if (thickness <= 1) {
      putPx(x0, y0, c);
    } else {
      // simulate thickness with a small disc
      fbFillCircle(x0, y0, thickness / 2, c);
    }
    if (x0 == x1 && y0 == y1) break;
    int e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

// Heart: two top circles + a triangle pointing down. Symmetrical.
// `size` controls overall scale (tested for 4..10).
static void fbDrawHeart(int cx, int cy, int size, uint16_t c) {
  int r = size;
  fbFillCircle(cx - r,     cy - r / 2, r, c);
  fbFillCircle(cx + r,     cy - r / 2, r, c);
  // Filled triangle for the bottom point
  for (int dy = -r / 2; dy <= 2 * r; ++dy) {
    float t = (float)(dy + r / 2) / (float)(2 * r + r / 2);  // 0..1
    int half = (int)((1.0f - t) * (2 * r));
    if (half < 0) half = 0;
    fbHLine(cx - half, cy + dy, 2 * half + 1, c);
  }
}

// 4-point sparkle/star: vertical and horizontal needle.
static void fbDrawStar(int cx, int cy, int size, uint16_t c) {
  if (size < 1) return;
  // vertical needle
  fbFillRoundRect(cx - 1, cy - size, 3, 2 * size + 1, 1, c);
  // horizontal needle
  fbFillRoundRect(cx - size, cy - 1, 2 * size + 1, 3, 1, c);
  // center dot
  fbFillCircle(cx, cy, 1, C_SHINE);
}

// Smile arc (BMO-style with curled ends).
static void fbDrawSmile(int cx, int cy, int width, int dipDepth, int thickness,
                        int cornerCurl, uint16_t c) {
  int half = width / 2;
  for (int x = -half; x <= half; ++x) {
    float t = (float)x / half;
    float dip = dipDepth * (1.0f - t * t);
    float curl = cornerCurl * (t * t * t * t);
    int y = cy + (int)dip - (int)curl;
    fbVLine(cx + x, y - thickness / 2, thickness, c);
  }
}

// Inverted smile: same as fbDrawSmile but bowing upward (sad mouth).
static void fbDrawFrown(int cx, int cy, int width, int dipDepth, int thickness,
                        uint16_t c) {
  int half = width / 2;
  for (int x = -half; x <= half; ++x) {
    float t = (float)x / half;
    float bump = dipDepth * (1.0f - t * t);
    int y = cy - (int)bump;
    fbVLine(cx + x, y - thickness / 2, thickness, c);
  }
}

static void fbDrawFlatMouth(int cx, int cy, int width, int thickness, uint16_t c) {
  fbFillRoundRect(cx - width / 2, cy - thickness / 2, width, thickness,
                  thickness / 2, c);
}

// Thick slanted eyebrow.
static void fbDrawBrow(int cx, int cy, int width, int slope, int thickness,
                       uint16_t c) {
  // slope: positive = inner end down (angry); negative = inner end up (sad).
  int x0 = cx - width / 2;
  int x1 = cx + width / 2;
  int y0 = cy + slope / 2;
  int y1 = cy - slope / 2;
  fbLine(x0, y0, x1, y1, thickness, c);
}

static void fbDrawEye(int cx, int cy, int w, int h, float lid, int dx, int dy) {
  int top  = cy - h / 2;
  int rx   = w / 2;
  int ry   = h / 2;

  if (lid >= 0.95f) {
    fbDrawFlatMouth(cx, cy, w + 2, 2, C_INK);
    return;
  }

  fbFillEllipse(cx, cy, rx, ry, C_INK);

  if (lid > 0) {
    int lidH = (int)((h - 2) * lid);
    fbRect(cx - rx - 1, top - 1, w + 2, lidH + 2, g_frameBg);
  }

  (void)dx;
  (void)dy;
}

static void fbDrawCrescentEye(int cx, int cy, int width, uint16_t c) {
  fbDrawSmile(cx, cy - 4, width, 4, 2, 1, c);
}

// Heart-shaped eye for LOVE mood.
static void fbDrawHeartEye(int cx, int cy, int size, uint16_t c) {
  fbDrawHeart(cx, cy, size, c);
}

// Spiral / dizzy eye.
static void fbDrawSpiralEye(int cx, int cy, int radius, float phase, uint16_t c) {
  // Approximate Archimedean spiral with stepping segments.
  int prevX = cx, prevY = cy;
  for (int i = 0; i < 24; ++i) {
    float t = i / 24.0f;
    float r = radius * t;
    float a = phase + t * 6.28318f * 2.0f;
    int x = cx + (int)(cosf(a) * r);
    int y = cy + (int)(sinf(a) * r);
    if (i > 0) fbLine(prevX, prevY, x, y, 2, c);
    prevX = x; prevY = y;
  }
}

// X-shaped "knocked out" eye.
static void fbDrawXEye(int cx, int cy, int size, uint16_t c) {
  fbLine(cx - size, cy - size, cx + size, cy + size, 3, c);
  fbLine(cx - size, cy + size, cx + size, cy - size, 3, c);
}

// Tear drop with falling animation (yPx is current y offset).
static void fbDrawTear(int cx, int cy, int yPx, uint16_t c) {
  int y = cy + yPx;
  fbFillEllipse(cx, y + 2, 2, 4, c);
  fbFillCircle(cx, y, 1, C_SHINE);
}

// Sweat drop: like a tear but on the side of the face / forehead.
static void fbDrawSweat(int cx, int cy, int yPx) {
  int y = cy + yPx;
  fbFillEllipse(cx, y + 2, 2, 3, C_SWEAT);
  fbFillCircle(cx + 1, y - 1, 1, C_SHINE);
}

// Soft cheek bloom with a few BMO-like blush hatches.
static void fbDrawBlush(int cx, int cy, float amount) {
  int r = 3 + (int)(2 * amount);
  fbFillEllipse(cx, cy, r + 1, r, C_BLUSH);
  if (amount < 0.65f) return;
  fbLine(cx - 4, cy + 2, cx - 2, cy - 2, 1, C_HEART);
  fbLine(cx,     cy + 2, cx + 2, cy - 2, 1, C_HEART);
  fbLine(cx + 4, cy + 1, cx + 5, cy - 1, 1, C_HEART);
}

static void fbDrawBmoMouth(int cx, int cy, int w, int h, bool tooth, bool tongue) {
  if (w < 10) w = 10;
  if (h < 8) h = 8;
  int rx = w / 2;
  int ry = h / 2;

  fbFillEllipse(cx, cy, rx + 2, ry + 2, C_INK);
  fbFillEllipse(cx, cy, rx, ry, C_MOUTH);

  if (tongue && h >= 12) {
    int tongueRx = rx - 5;
    int tongueRy = ry / 3;
    if (tongueRx < 3) tongueRx = 3;
    if (tongueRy < 2) tongueRy = 2;
    fbFillEllipse(cx + 1, cy + ry - 3, tongueRx, tongueRy, C_TONGUE);
    fbHLine(cx - tongueRx + 1, cy + ry - 4, tongueRx * 2 - 2, C_INK);
  }

  if (tooth && w >= 18) {
    int toothRx = rx - 5;
    if (toothRx < 4) toothRx = 4;
    fbFillEllipse(cx, cy - ry + 5, toothRx, 3, C_SHINE);
  }
}

static void fbDrawOpenMouth(int cx, int cy, int rx, int ry, bool tongue) {
  fbDrawBmoMouth(cx, cy, rx * 2, ry * 2, rx > 10 && ry > 6, tongue);
}

// Tongue / drool: a muted lower-mouth color, matching the BMO reference.
static void fbDrawDrool(int cx, int cy, int len) {
  fbFillEllipse(cx, cy + len / 2, 3, len / 2 + 2, C_TONGUE);
}

// Tongue out (hungry): flat pink bar dangling from a small open mouth.
static void fbDrawTongueOut(int cx, int cy) {
  // small mouth above
  fbDrawBmoMouth(cx, cy - 4, 18, 10, true, false);
  // tongue protruding down
  fbFillRoundRect(cx - 5, cy - 2, 10, 10, 4, C_TONGUE);
  // shine on tongue
  fbFillCircle(cx + 2, cy + 1, 1, C_SHINE);
}

// Snowflake: 6-spoke needle.
static void fbDrawSnow(int cx, int cy, int size) {
  fbVLine(cx, cy - size, 2 * size, C_SHINE);
  fbHLine(cx - size, cy, 2 * size, C_SHINE);
  // diagonals
  for (int i = -size; i <= size; ++i) {
    putPx(cx + i, cy + i, C_SHINE);
    putPx(cx + i, cy - i, C_SHINE);
  }
}

// Steam line: short curving stroke implied with two stacked horizontal arcs.
static void fbDrawSteam(int cx, int cy, int phase, uint16_t c) {
  // Two ovals offset by phase to feel like rising steam
  int dy = phase % 8;
  fbFillEllipse(cx - 2, cy - dy,     3, 1, c);
  fbFillEllipse(cx + 2, cy - dy - 6, 3, 1, c);
}

// Question mark: built from a small filled curve and a dot.
static void fbDrawQuestion(int cx, int cy, uint16_t c) {
  // top hook (top part of '?')
  fbFillCircle(cx, cy - 4, 4, c);
  fbFillCircle(cx, cy - 4, 2, g_frameBg);
  // tail
  fbFillRoundRect(cx, cy - 2, 2, 4, 1, c);
  // dot
  fbFillCircle(cx + 1, cy + 4, 1, c);
}

// "z" letter, small: drawn as 3 line segments.
static void fbDrawZ(int cx, int cy, int size, uint16_t c) {
  fbHLine(cx - size, cy - size, 2 * size + 1, c);
  fbHLine(cx - size, cy + size, 2 * size + 1, c);
  fbLine(cx + size, cy - size, cx - size, cy + size, 2, c);
}

// Pit Viper-style shield visor: one oversized wraparound mirror lens across
// both eyes (no bridge gap), a chunky top rim, swept-back temple arms, stacked
// blue/cyan/teal bands, and the tiny center nose notch visible in the reference.
static void fbDrawShades(int leftCx, int rightCx, int cy) {
  // Mirror-lens palette (RGB565), tuned for a tiny ST7735 screen.
  const uint16_t C_FRAME     = 0x0000;  // black frame / brow
  const uint16_t C_RIM       = 0xF345;  // warm coral top rim like sport frames
  const uint16_t C_LENS_SKY  = 0x9FFF;  // pale sky-blue highlight
  const uint16_t C_LENS_AQUA = 0x07FF;  // bright aqua mirror
  const uint16_t C_LENS_TEAL = 0x0596;  // saturated teal
  const uint16_t C_LENS_NAVY = 0x01AA;  // deep blue lower reflection
  const uint16_t C_STREAK    = 0xFFFF;  // white mirror glare

  // Wide shield lens spanning almost the whole face, like the photo reference.
  const int x0  = leftCx  - 26;
  const int x1  = rightCx + 26;
  const int w   = x1 - x0;
  const int top = cy - 14;
  const int h   = 28;
  const int noseX = (leftCx + rightCx) / 2;

  // Thick swept-back side arms, visible outside the lens like real Vipers.
  // upper swept-back arms
  fbLine(x0 + 5, top + 5, x0 - 10, top + 9, 4, C_FRAME);
  fbLine(x1 - 5, top + 5, x1 + 10, top + 9, 4, C_FRAME);
  // lower swept-back arms
  fbLine(x0 + 3, top + h - 8, x0 - 8, top + h - 2, 3, C_FRAME);
  fbLine(x1 - 3, top + h - 8, x1 + 8, top + h - 2, 3, C_FRAME);

  // Black outline with tapered top/bottom corners, drawn as scanlines so the
  // visor reads less like a simple rounded rectangle on the low-res panel.
  for (int y = -2; y < h + 2; ++y) {
    int sideInset = 0;
    if (y < 4) sideInset = 4 - y;
    if (y > h - 6) sideInset = y - (h - 6);
    if (sideInset < 0) sideInset = 0;
    fbHLine(x0 - 2 + sideInset, top + y, w + 4 - sideInset * 2, C_FRAME);
  }

  // Mirrored shield body: broad stacked bands mimic the blue/cyan visor in the
  // attached Viper photo while keeping the whole lens continuous across BMO's eyes.
  for (int y = 0; y < h; ++y) {
    int sideInset = 0;
    if (y < 4) sideInset = 4 - y;
    if (y > h - 6) sideInset = y - (h - 6);

    uint16_t c = C_LENS_NAVY;
    if (y < 5) {
      c = C_LENS_SKY;
    } else if (y < 12) {
      c = C_LENS_AQUA;
    } else if (y < 21) {
      c = C_LENS_TEAL;
    }
    fbHLine(x0 + sideInset, top + y, w - sideInset * 2, c);
  }

  // Chunky brow/rim along the top edge, with a warm frame glint like the photo.
  fbFillRoundRect(x0 + 4, top - 2, w - 8, 5, 2, C_FRAME);
  fbHLine(x0 + 8, top - 1, w - 16, C_RIM);

  // center nose notch: a small dark dip at the lower middle of the visor.
  fbFillRoundRect(noseX - 5, top + h - 3, 10, 6, 2, C_FRAME);

  // Diagonal mirror glare streaks, lower-left to upper-right.
  fbLine(x0 + 15, top + h - 4, x0 + 34, top + 3, 2, C_STREAK);
  fbLine(x0 + 29, top + h - 5, x0 + 46, top + 4, 1, C_STREAK);
  fbLine(x1 - 35, top + 4, x1 - 18, top + h - 7, 1, C_STREAK);
}

// Zigzag mouth (wavy unhappy / sick line).
static void fbDrawZigzag(int cx, int cy, int width, int amp, int thickness,
                         uint16_t c) {
  int half = width / 2;
  int seg = 5;
  int prevY = cy;
  int prevX = cx - half;
  for (int x = -half; x <= half; ++x) {
    int phase = ((x + half) / seg) % 2;
    int y = cy + (phase ? -amp : amp);
    if (x > -half) fbLine(prevX, prevY, cx + x, y, thickness, c);
    prevX = cx + x; prevY = y;
  }
}

// Pulsing "processing" orb where the mouth is — concentric rings that breathe
// in/out. Used for the Thinking face so it reads as "computing" rather than a
// frozen flat line. `phase` is a free-running 0..1 ramp.
static void fbDrawPulseMouth(int cx, int cy, float phase, uint32_t now) {
  // Breathing radius via a sine on the phase.
  float b = 0.5f + 0.5f * sinf(phase * 6.28318f);
  int rOuter = 6 + (int)(7 * b);
  // Outer soft ring.
  fbFillCircle(cx, cy, rOuter, C_MOUTH);
  // Punch out the centre to leave a ring, leaving a small solid core.
  uint16_t bg = g_frameBg;
  int rInner = rOuter - 3;
  if (rInner > 2) fbFillCircle(cx, cy, rInner, bg);
  // Pulsing core dot.
  int rCore = 2 + (int)(2 * (1.0f - b));
  fbFillCircle(cx, cy, rCore, C_MOUTH);
  // A couple of orbiting specks for a techy feel.
  for (int i = 0; i < 2; ++i) {
    float a = phase * 6.28318f * (i ? -1.0f : 1.0f) + i * 3.14159f;
    int ox = cx + (int)(cosf(a) * (rOuter + 4));
    int oy = cy + (int)(sinf(a) * (rOuter + 4));
    fbFillCircle(ox, oy, 1, C_MOUTH);
  }
  (void)now;
}

// Teeth chatter: alternating short vertical stripes inside a flat mouth box.
static void fbDrawChatter(int cx, int cy, uint32_t now) {
  fbFillRoundRect(cx - 20, cy - 7, 40, 14, 5, C_INK);
  fbFillRoundRect(cx - 18, cy - 5, 36, 10, 3, C_MOUTH);
  // alternating white teeth bars
  bool odd = ((now / 80) & 1) == 0;
  for (int i = -3; i <= 3; ++i) {
    int x = cx + i * 5;
    if ((i & 1) ^ (odd ? 0 : 1)) {
      fbRect(x - 1, cy - 3, 2, 6, C_SHINE);
    }
  }
}

// Laugh mouth: wide-open ellipse with two small ripple lines beside it.
static void fbDrawLaugh(int cx, int cy, float openness, uint32_t now) {
  int rx = 14;
  int ry = 5 + (int)(8 * openness);
  fbDrawBmoMouth(cx, cy, rx * 2, ry * 2, true, true);
  // Ripple side-marks for "haha" emphasis
  int t = (int)(now / 80) % 6;
  fbDrawZ(cx - 28, cy - 6 - t, 2, C_INK);
  fbDrawZ(cx + 28, cy - 6 - t, 2, C_INK);
}

// -----------------------------------------------------------------------------
// Frame flush
// -----------------------------------------------------------------------------

// Datamosh-style glitch post-process. Runs over the finished framebuffer just
// before flush: picks a few horizontal bands and shoves each sideways by a
// pseudo-random amount, with an occasional cyan/magenta RGB-split tint so it
// reads like a corrupted video signal. `intensity` scales band count + shift.
// Cheap: only touches a handful of rows per frame.
static void fbApplyGlitch(uint8_t intensity, uint32_t now) {
  if (intensity == 0) return;
  static uint16_t lineBuf[TFT_W];
  const int bands = 2 + intensity;            // a few bands
  for (int b = 0; b < bands; ++b) {
    // Pseudo-random band position/height/shift seeded off time + index.
    uint32_t r = now * 2654435761u + (uint32_t)(b * 40503);
    int y0 = (int)(r % TFT_H);
    int h  = 2 + (int)((r >> 8) % 6);
    int shift = (int)((r >> 16) % (uint32_t)(3 + intensity * 3)) - (1 + intensity);
    if (shift == 0) shift = (b & 1) ? 2 : -2;
    bool tint = ((r >> 24) & 3) == 0;          // ~25% of bands get RGB split
    uint16_t tintMask = (b & 1) ? 0x07FF : 0xF81F;  // cyan / magenta
    for (int dy = 0; dy < h; ++dy) {
      int y = y0 + dy;
      if (y < 0 || y >= TFT_H) continue;
      uint16_t* row = fb + y * TFT_W;
      // Copy row, then write back shifted (wrap-around).
      for (int x = 0; x < TFT_W; ++x) lineBuf[x] = row[x];
      for (int x = 0; x < TFT_W; ++x) {
        int src = x - shift;
        if (src < 0) src += TFT_W;
        else if (src >= TFT_W) src -= TFT_W;
        uint16_t px = lineBuf[src];
        if (tint) px |= tintMask;              // additive-ish channel smear
        row[x] = px;
      }
    }
  }
}

static void flushFrame() {
  tftSPI.beginTransaction(SPISettings(SPI_HZ, MSBFIRST, SPI_MODE0));

  writeCmd(0x2A);
  dcData(); csLo();
  tftSPI.transfer(0); tftSPI.transfer(X_OFFSET);
  tftSPI.transfer(0); tftSPI.transfer(X_OFFSET + TFT_W - 1);
  csHi();

  writeCmd(0x2B);
  dcData(); csLo();
  tftSPI.transfer(0); tftSPI.transfer(Y_OFFSET);
  tftSPI.transfer(0); tftSPI.transfer(Y_OFFSET + TFT_H - 1);
  csHi();

  writeCmd(0x2C);

  static uint8_t tx[TFT_W * 2];
  dcData(); csLo();
  for (int y = 0; y < TFT_H; ++y) {
    const uint16_t *row = fb + y * TFT_W;
    for (int x = 0; x < TFT_W; ++x) {
      uint16_t v = row[x];
      tx[x * 2]     = v >> 8;
      tx[x * 2 + 1] = v & 0xFF;
    }
    tftSPI.writeBytes(tx, TFT_W * 2);
  }
  csHi();

  tftSPI.endTransaction();
}

// -----------------------------------------------------------------------------
// Face state
// -----------------------------------------------------------------------------
struct FaceState {
  // Eye base
  float lidL = 0;
  float lidR = 0;
  int pupilDx = 0;
  int pupilDy = 0;

  // Eye shape variant
  enum EyeShape {
    EYE_NORMAL,
    EYE_HEART,
    EYE_X,
    EYE_SPIRAL,
    EYE_HALF_WINK_L,
    EYE_HALF_WINK_R,
    EYE_DOLLAR,        // $$ pupils for greed/excited variants (unused for now)
    EYE_DOT,           // tiny dot eyes for confused/bored
    EYE_SHADES,        // sunglasses bar over the eyes
    EYE_SQUINT,        // narrow horizontal slit (focused)
    EYE_CRESCENT,      // BMO's closed happy/laugh eye arcs
  } eyeShape = EYE_NORMAL;

  // Eyebrows
  bool browVisible = false;
  int browSlope = 0;

  // Mouth
  enum MouthShape {
    M_SMILE, M_OPEN, M_FLAT, M_TALK, M_FROWN, M_GRIN, M_OH,
    M_TONGUE_OUT,        // hungry
    M_DROOL,             // hungry-2: open mouth + drool drip
    M_ZIGZAG,            // sick / confused
    M_CHATTER,           // teeth chatter (cold) — stripes
    M_LAUGH,             // wide open + laugh ripples
  } mouth = M_SMILE;
  float mouthOpen = 0;
  int smileWidth = 46;
  int smileDip = 8;
  int flatWidth = 38;

  // Cheeks
  float blush = 0;

  // Decorative overlays
  bool tearVisible = false;
  int  tearY = 0;
  bool sweatVisible = false;       // shared by hot / scared / focused
  int  sweatY = 0;
  bool starsVisible = false;
  bool heartsAround = false;
  bool questionMarks = false;      // confused
  bool listeningMarks = false;     // listening / voice input
  bool thinkingDots = false;       // thinking / processing
  bool snowFlakes = false;         // cold
  bool steamLines = false;         // hot
  bool zzzLetters = false;         // bored / sleepy

  // Thinking "processing orb": a pulsing ring/dot where the mouth is, sized by
  // pulsePhase (0 = use time-based default). Set pulseMouth to enable.
  bool  pulseMouth = false;

  // Datamosh-style glitch: horizontal bands of the rendered face get shoved
  // sideways + RGB-split. 0 = off; higher = more/stronger bands. Applied as a
  // post-process over the whole framebuffer (see fbApplyGlitch).
  uint8_t glitchShift = 0;

  // Whole-face shake
  int shakeX = 0;
  int shakeY = 0;

  // Glitch bars
  uint8_t glitchBars = 0;

  // Background tint override (0 = use default C_BG)
  uint16_t bgOverride = 0;
};

// Eye + mouth coords
static constexpr int EYE_W = 8;
static constexpr int EYE_H = 8;
static constexpr int EYE_Y = 48;
static constexpr int EYE_DX = 46;
static constexpr int MOUTH_Y  = 80;
static constexpr int MOUTH_CX = TFT_W / 2;

static void fbDrawListeningMarks(uint32_t now) {
  int phase = (int)((now / 120) % 3);
  for (int i = 0; i < 3; ++i) {
    int h = 3 + ((phase + i) % 3) * 2;
    int y = MOUTH_Y - h / 2 + (int)(1 * sinf(now * 0.005f + i));
    int leftX = 20 + i * 5;
    int rightX = TFT_W - 23 - i * 5;
    fbFillRoundRect(leftX, y, 3, h, 1, C_MOUTH);
    fbFillRoundRect(rightX, y, 3, h, 1, C_MOUTH);
  }
}

static void fbDrawThinkingDots(uint32_t now) {
  int phase = (int)((now / 240) % 3);
  static const int xs[3] = { MOUTH_CX + 20, MOUTH_CX + 30, MOUTH_CX + 42 };
  static const int ys[3] = { EYE_Y - 14,   EYE_Y - 20,   EYE_Y - 17 };
  for (int i = 0; i < 3; ++i) {
    int r = 2 + (((phase + i) % 3) == 0 ? 1 : 0);
    fbFillCircle(xs[i], ys[i], r, C_MOUTH);
  }
}

static void drawFaceToBuffer(const FaceState &s, uint32_t now) {
  // Background — moods can override (cold/hot/sick)
  uint16_t bg = s.bgOverride ? s.bgOverride : C_BG;
  g_frameBg = bg;
  fbFill(bg);

  int leftCx  = MOUTH_CX - EYE_DX + s.shakeX;
  int rightCx = MOUTH_CX + EYE_DX + s.shakeX;
  int eyeY    = EYE_Y + s.shakeY;

  // Cheeks
  if (s.blush > 0) {
    fbDrawBlush(leftCx - 18,  eyeY + 18, s.blush);
    fbDrawBlush(rightCx + 18, eyeY + 18, s.blush);
  }

  // Eyes
  switch (s.eyeShape) {
    case FaceState::EYE_NORMAL:
      fbDrawEye(leftCx + s.pupilDx,  eyeY + s.pupilDy, EYE_W, EYE_H, s.lidL, 0, 0);
      fbDrawEye(rightCx + s.pupilDx, eyeY + s.pupilDy, EYE_W, EYE_H, s.lidR, 0, 0);
      break;
    case FaceState::EYE_HEART:
      fbDrawHeartEye(leftCx,  eyeY, 7, C_HEART);
      fbDrawHeartEye(rightCx, eyeY, 7, C_HEART);
      break;
    case FaceState::EYE_X:
      fbDrawXEye(leftCx,  eyeY, 7, C_INK);
      fbDrawXEye(rightCx, eyeY, 7, C_INK);
      break;
    case FaceState::EYE_SPIRAL: {
      float phase = (now % 1500) / 1500.0f * 6.28f;
      fbDrawSpiralEye(leftCx,  eyeY, 9, phase,            C_INK);
      fbDrawSpiralEye(rightCx, eyeY, 9, phase + 1.57f,    C_INK);
      break;
    }
    case FaceState::EYE_HALF_WINK_L:
      fbDrawEye(leftCx,  eyeY, EYE_W, EYE_H, 1.0f, s.pupilDx, s.pupilDy);
      fbDrawEye(rightCx, eyeY, EYE_W, EYE_H, s.lidR, s.pupilDx, s.pupilDy);
      break;
    case FaceState::EYE_HALF_WINK_R:
      fbDrawEye(leftCx,  eyeY, EYE_W, EYE_H, s.lidL, s.pupilDx, s.pupilDy);
      fbDrawEye(rightCx, eyeY, EYE_W, EYE_H, 1.0f, s.pupilDx, s.pupilDy);
      break;
    case FaceState::EYE_DOLLAR:
      // Same outline as normal eye, plus tiny "$" inside
      fbDrawEye(leftCx,  eyeY, EYE_W, EYE_H, 0, 0, 0);
      fbDrawEye(rightCx, eyeY, EYE_W, EYE_H, 0, 0, 0);
      // dollar sign approximation: vertical line + S
      fbVLine(leftCx,  eyeY - 5, 11, C_STAR);
      fbVLine(rightCx, eyeY - 5, 11, C_STAR);
      break;
    case FaceState::EYE_DOT: {
      // Tiny dot eyes
      fbFillCircle(leftCx,  eyeY, 3, C_INK);
      fbFillCircle(rightCx, eyeY, 3, C_INK);
      break;
    }
    case FaceState::EYE_SHADES:
      fbDrawShades(leftCx, rightCx, eyeY);
      break;
    case FaceState::EYE_SQUINT: {
      // Narrow horizontal slits for "focused" mood
      fbFillRoundRect(leftCx  - EYE_W / 2, eyeY - 2, EYE_W, 4, 2, C_INK);
      fbFillRoundRect(rightCx - EYE_W / 2, eyeY - 2, EYE_W, 4, 2, C_INK);
      // tiny pupil dot
      fbFillCircle(leftCx  + s.pupilDx, eyeY + s.pupilDy, 1, C_SHINE);
      fbFillCircle(rightCx + s.pupilDx, eyeY + s.pupilDy, 1, C_SHINE);
      break;
    }
    case FaceState::EYE_CRESCENT:
      fbDrawCrescentEye(leftCx,  eyeY + 4, 16, C_INK);
      fbDrawCrescentEye(rightCx, eyeY + 4, 16, C_INK);
      break;
  }

  // Eyebrows
  if (s.browVisible) {
    fbDrawBrow(leftCx,  eyeY - EYE_H / 2 - 6, 18, s.browSlope, 4, C_BROW);
    fbDrawBrow(rightCx, eyeY - EYE_H / 2 - 6, 18, -s.browSlope, 4, C_BROW);
  }

  // Mouth
  if (s.pulseMouth) {
    // Thinking "processing orb" replaces the normal mouth entirely.
    float phase = (now % 1200) / 1200.0f;
    fbDrawPulseMouth(MOUTH_CX + s.shakeX, MOUTH_Y + s.shakeY, phase, now);
  } else {
  switch (s.mouth) {
    case FaceState::M_SMILE:
      fbDrawSmile(MOUTH_CX + s.shakeX, MOUTH_Y - 4 + s.shakeY, s.smileWidth, s.smileDip, 3, 2, C_MOUTH);
      break;
    case FaceState::M_OPEN: {
      int rx = 10 + (int)(14 * s.mouthOpen);
      int ry = 4  + (int)(10 * s.mouthOpen);
      fbDrawOpenMouth(MOUTH_CX + s.shakeX, MOUTH_Y + s.shakeY, rx, ry, true);
      break;
    }
    case FaceState::M_FLAT:
      fbDrawFlatMouth(MOUTH_CX + s.shakeX, MOUTH_Y + s.shakeY, s.flatWidth, 4, C_MOUTH);
      break;
    case FaceState::M_TALK: {
      uint8_t talkPhase = (uint8_t)((now / 120) % 3);
      switch (talkPhase) {
        case 0:
          fbDrawFlatMouth(MOUTH_CX + s.shakeX, MOUTH_Y + s.shakeY, 22, 3, C_MOUTH);
          break;
        case 1:
          fbDrawOpenMouth(MOUTH_CX + s.shakeX, MOUTH_Y + s.shakeY, 8, 7, false);
          break;
        default:
          fbDrawOpenMouth(MOUTH_CX + s.shakeX, MOUTH_Y + s.shakeY, 15, 7 + (int)(3 * s.mouthOpen), true);
          break;
      }
      break;
    }
    case FaceState::M_FROWN:
      fbDrawFrown(MOUTH_CX + s.shakeX, MOUTH_Y + 4 + s.shakeY, 44, 8, 4, C_MOUTH);
      break;
    case FaceState::M_GRIN:
      fbDrawSmile(MOUTH_CX + s.shakeX, MOUTH_Y - 4 + s.shakeY, 56, 12, 4, 4, C_MOUTH);
      break;
    case FaceState::M_OH:
      fbDrawOpenMouth(MOUTH_CX + s.shakeX, MOUTH_Y + s.shakeY, 6, 8, false);
      break;
    case FaceState::M_TONGUE_OUT:
      fbDrawTongueOut(MOUTH_CX + s.shakeX, MOUTH_Y + 2 + s.shakeY);
      break;
    case FaceState::M_DROOL: {
      // open mouth above + drool dripping below
      int ry = 4 + (int)(6 * s.mouthOpen);
      fbDrawBmoMouth(MOUTH_CX + s.shakeX, MOUTH_Y + s.shakeY, 24, ry * 2, true, false);
      int droolLen = 6 + (int)(6 * s.mouthOpen);
      fbDrawDrool(MOUTH_CX + s.shakeX - 2, MOUTH_Y + ry + 2, droolLen);
      break;
    }
    case FaceState::M_ZIGZAG:
      fbDrawZigzag(MOUTH_CX + s.shakeX, MOUTH_Y + s.shakeY, 40, 4, 3, C_MOUTH);
      break;
    case FaceState::M_CHATTER:
      fbDrawChatter(MOUTH_CX + s.shakeX, MOUTH_Y + s.shakeY, now);
      break;
    case FaceState::M_LAUGH:
      fbDrawLaugh(MOUTH_CX + s.shakeX, MOUTH_Y + s.shakeY, s.mouthOpen, now);
      break;
  }
  }

  // Tear (sad)
  if (s.tearVisible) {
    fbDrawTear(leftCx + 8, eyeY + EYE_H / 2 + 2, s.tearY, C_TEAR);
  }

  // Sweat (hot/scared/focused)
  if (s.sweatVisible) {
    fbDrawSweat(rightCx + 12, eyeY - EYE_H / 2 - 4, s.sweatY);
  }

  // Stars (excited)
  if (s.starsVisible) {
    int t = (int)(now / 80) % 4;
    fbDrawStar(20  + t * 2,   20, 4, C_STAR);
    fbDrawStar(140 - t * 2,   16, 5, C_STAR);
    fbDrawStar(30,             100 - t, 3, C_STAR);
    fbDrawStar(135,            108 + t, 4, C_STAR);
  }

  // Hearts (love)
  if (s.heartsAround) {
    int t = (int)(now / 100) % 6;
    fbDrawHeart(20 + t,  18, 4, C_HEART);
    fbDrawHeart(140 - t, 24, 5, C_HEART);
    fbDrawHeart(30,      108 - t, 3, C_HEART);
  }

  // Question marks (confused)
  if (s.questionMarks) {
    int phase = (int)(now / 200) % 3;
    fbDrawQuestion(28  + phase * 2,  18, C_INK);
    fbDrawQuestion(132 - phase,      14, C_INK);
  }

  if (s.listeningMarks) {
    fbDrawListeningMarks(now);
  }

  if (s.thinkingDots) {
    fbDrawThinkingDots(now);
  }

  // Snowflakes (cold)
  if (s.snowFlakes) {
    int t = (int)(now / 100);
    fbDrawSnow(20  + (t % 8),  16 + ((t * 3) % 6), 3);
    fbDrawSnow(140 - (t % 6),  20 + ((t * 5) % 8), 3);
    fbDrawSnow(80,             14 + ((t * 7) % 6), 3);
  }

  // Steam lines (hot)
  if (s.steamLines) {
    int phase = (int)(now / 80);
    fbDrawSteam(28,  20, phase,     C_INK);
    fbDrawSteam(80,  18, phase + 3, C_INK);
    fbDrawSteam(132, 22, phase + 6, C_INK);
  }

  // ZZZ letters (sleepy / bored)
  if (s.zzzLetters) {
    int t = (int)(now / 200) % 3;
    fbDrawZ(120 + t * 2, 20 - t, 2, C_INK);
    fbDrawZ(132,         12,    3, C_INK);
  }

  // Glitch bars
  if (s.glitchBars > 0) {
    for (uint8_t i = 0; i < s.glitchBars; ++i) {
      int y = (int)((now * 13 + i * 41) % TFT_H);
      int h = 2 + (int)((now / 13) % 4);
      fbRect(0, y, TFT_W, h, (i & 1) ? 0x07FF : 0x0000);
    }
  }

  // Datamosh row-shift glitch — applied LAST so it displaces the finished
  // face (eyes, mouth, overlays) rather than getting drawn over.
  if (s.glitchShift > 0) {
    fbApplyGlitch(s.glitchShift, now);
  }

}

static void renderFrame(const FaceState &s, uint32_t now) {
  drawFaceToBuffer(s, now);
  flushFrame();
}

static void applyMoodTransition(FaceState &s, float t) {
  float edge = 1.0f;
  if (t < 0.12f) {
    edge = t / 0.12f;
  } else if (t > 0.88f) {
    edge = (1.0f - t) / 0.12f;
  }
  if (edge >= 1.0f) return;
  if (edge < 0.0f) edge = 0.0f;

  float lid = (1.0f - edge) * 0.18f;
  if (s.eyeShape == FaceState::EYE_NORMAL) {
    if (s.lidL < lid) s.lidL = lid;
    if (s.lidR < lid) s.lidR = lid;
  }
  s.shakeY += (int)((1.0f - edge) * 2.0f);
}

// -----------------------------------------------------------------------------
// I2S audio output (MAX98357A)
//
// We synthesize short musical jingles with a software sine generator and
// stream them to the amp via the C3's I2S peripheral. No SD card or WAV
// files needed — perfect for tiny mood-transition sounds.
//
// Uses the legacy `driver/i2s.h` API which works on Arduino-ESP32 2.x.
// -----------------------------------------------------------------------------
static constexpr uint32_t AUDIO_RATE = 16000;
static constexpr i2s_port_t AUDIO_I2S_PORT = I2S_NUM_0;

// Global volume, 0.0 (mute) .. 1.0 (max). Live-tunable via setVolume().
// A future web UI can call setVolume() over WiFi / serial to adjust live.
// Keep the default modest because the MAX98357A's GAIN pin is at 9 dB.
static volatile float g_volume = 0.328f;  // bumped +40% from 0.234

static inline void setVolume(float v) {
  if (v < 0.0f) v = 0.0f;
  if (v > 1.0f) v = 1.0f;
  g_volume = v;
}
static inline float getVolume() { return g_volume; }

static void audioInit() {
  i2s_config_t cfg = {};
  cfg.mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX);
  cfg.sample_rate = AUDIO_RATE;
  cfg.bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT;
  cfg.channel_format = I2S_CHANNEL_FMT_ONLY_LEFT;
  cfg.communication_format = I2S_COMM_FORMAT_STAND_I2S;
  cfg.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1;
  cfg.dma_buf_count = 4;
  cfg.dma_buf_len = 256;
  cfg.use_apll = false;
  cfg.tx_desc_auto_clear = true;
  cfg.fixed_mclk = 0;

  i2s_pin_config_t pins = {};
  pins.bck_io_num   = PIN_I2S_BCLK;
  pins.ws_io_num    = PIN_I2S_LRC;
  pins.data_out_num = PIN_I2S_DOUT;
  pins.data_in_num  = I2S_PIN_NO_CHANGE;
  pins.mck_io_num   = I2S_PIN_NO_CHANGE;

  i2s_driver_install(AUDIO_I2S_PORT, &cfg, 0, NULL);
  i2s_set_pin(AUDIO_I2S_PORT, &pins);
  i2s_zero_dma_buffer(AUDIO_I2S_PORT);
}

// -----------------------------------------------------------------------------
// Brain-stream sink (weak C symbols consumed by bmo_brain_client.cpp).
//
// The dashboard streams audio at 24 kHz mono PCM16; the speaker I²S TX is
// configured at 16 kHz. We downsample 3:2 by skipping every 3rd input sample
// and pass the result through `g_volume`. Quality is fine for speech and for
// short songs; if you want full-fidelity playback later, switch I²S TX to
// 24 kHz and update playTone/playClip's sample rate accordingly.
//
// `bmo_set_volume_from_dashboard()` is invoked by the brain client right
// after parsing the response headers, propagating the dashboard slider.
// -----------------------------------------------------------------------------

extern "C" void bmo_set_volume_from_dashboard(int volume0to100) {
  if (volume0to100 < 0)   volume0to100 = 0;
  if (volume0to100 > 100) volume0to100 = 100;
  // Save the dashboard's last-known volume so non-brain audio paths
  // (jingles, synthesized voice) honour it too.
  g_volume = static_cast<float>(volume0to100) / 100.0f;
  Serial.printf("[audio] volume set to %d%%\n", volume0to100);
}

// Persistent stream state for bmo_audio_push_pcm16. These carry partial
// state ACROSS chunks within a single reply: `leftoverByte`/`hasLeftover`
// stitch a 16-bit sample split across a chunk boundary, and `skipPhase`
// tracks the 3:2 downsample position.
//
// CRITICAL: they must be reset between replies. If a reply's total byte count
// is odd, hasLeftover stays true with one orphan byte; the NEXT reply would
// then stitch that stale byte onto its first byte, shifting every subsequent
// 16-bit sample's high/low byte boundary for the entire stream → pure noise.
// That's the "works once, then noise on the next try" bug. bmo_audio_reset_
// stream() clears them and is called at the start of every reply.
static uint8_t s_pcmLeftoverByte = 0;
static bool    s_pcmHasLeftover  = false;
static uint8_t s_pcmSkipPhase    = 0;  // 0,1,2 — skip when phase == 2.

// Live talking-loudness envelope, 0.0..1.0, updated as reply/clip audio is
// pushed to I2S. The talking face reads this so the mouth moves with the
// ACTUAL voice (real lip-sync) instead of a canned sine wiggle. Written from
// the audio path, read from the render task — a float read/write is atomic
// enough on the C3 for a smoothed visual envelope, so no lock needed.
static volatile float g_talkLevel = 0.0f;

// Feed a block of post-volume PCM16 samples into the envelope follower. Uses a
// fast-attack / slow-release peak tracker so the mouth snaps open on syllables
// and eases shut between them — reads as speech, not a buzz.
static inline void talkEnvelopeFeed(const int16_t* samples, size_t n) {
  if (samples == nullptr || n == 0) return;
  // Cheap peak over the block.
  int32_t peak = 0;
  for (size_t k = 0; k < n; ++k) {
    int32_t a = samples[k];
    if (a < 0) a = -a;
    if (a > peak) peak = a;
  }
  float target = (float)peak / 32767.0f;
  // Normalize: speech rarely hits full-scale post-volume, so lift it a bit and
  // clamp. This keeps the mouth lively at normal listening levels.
  target *= 2.2f;
  if (target > 1.0f) target = 1.0f;
  float cur = g_talkLevel;
  // Fast attack, slow release.
  if (target > cur) cur += (target - cur) * 0.6f;
  else              cur += (target - cur) * 0.15f;
  g_talkLevel = cur;
}

extern "C" void bmo_audio_reset_stream() {
  s_pcmLeftoverByte = 0;
  s_pcmHasLeftover  = false;
  s_pcmSkipPhase    = 0;
  g_talkLevel       = 0.0f;
}

extern "C" void bmo_audio_push_pcm16(const uint8_t* data, size_t len) {
  if (data == nullptr || len < 2) return;
  // 24 → 16 kHz downsample by dropping 1 of every 3 input samples.
  uint8_t& leftoverByte = s_pcmLeftoverByte;
  bool&    hasLeftover  = s_pcmHasLeftover;
  uint8_t& skipPhase    = s_pcmSkipPhase;

  // Stitch a leading half-sample from the previous chunk if present.
  size_t i = 0;
  if (hasLeftover && len >= 1) {
    int16_t sample = static_cast<int16_t>(
        static_cast<uint16_t>(leftoverByte) |
        (static_cast<uint16_t>(data[0]) << 8));
    hasLeftover = false;
    if (skipPhase != 2) {
      float f = (static_cast<float>(sample) / 32768.0f) * g_volume;
      if (f >  1.0f) f =  1.0f;
      else if (f < -1.0f) f = -1.0f;
      int16_t out = static_cast<int16_t>(f * 32767.0f);
      talkEnvelopeFeed(&out, 1);
      size_t written = 0;
      i2s_write(AUDIO_I2S_PORT, &out, sizeof(out), &written, portMAX_DELAY);
    }
    skipPhase = (skipPhase + 1) % 3;
    i = 1;
  }

  static int16_t batch[256];
  size_t batchN = 0;

  while (i + 1 < len) {
    int16_t sample = static_cast<int16_t>(
        static_cast<uint16_t>(data[i]) |
        (static_cast<uint16_t>(data[i + 1]) << 8));
    i += 2;

    if (skipPhase == 2) {
      skipPhase = 0;
      continue;
    }
    skipPhase++;

    float f = (static_cast<float>(sample) / 32768.0f) * g_volume;
    if (f >  1.0f) f =  1.0f;
    else if (f < -1.0f) f = -1.0f;
    batch[batchN++] = static_cast<int16_t>(f * 32767.0f);

    if (batchN == sizeof(batch) / sizeof(batch[0])) {
      talkEnvelopeFeed(batch, batchN);
      size_t written = 0;
      i2s_write(AUDIO_I2S_PORT, batch, batchN * sizeof(int16_t), &written,
                portMAX_DELAY);
      batchN = 0;
    }
  }

  if (batchN > 0) {
    talkEnvelopeFeed(batch, batchN);
    size_t written = 0;
    i2s_write(AUDIO_I2S_PORT, batch, batchN * sizeof(int16_t), &written,
              portMAX_DELAY);
  }

  // Save any trailing odd byte for the next chunk.
  if (i < len) {
    leftoverByte = data[i];
    hasLeftover = true;
  }
}

// Play a sine tone of given frequency for given duration.
// `boost` is an optional per-tone multiplier (1.0 = use g_volume as-is,
// 0.5 = half of g_volume for quieter notes, etc).
static void playTone(float hz, uint32_t durationMs, float boost = 1.0f) {
  const float volume = g_volume * boost;
  const uint32_t samples = (AUDIO_RATE * durationMs) / 1000;
  const float twoPi = 6.28318530718f;
  const float step = twoPi * hz / AUDIO_RATE;
  float phase = 0;
  const uint32_t edge = AUDIO_RATE / 50;

  static int16_t chunk[256];
  uint32_t sent = 0;
  while (sent < samples) {
    uint32_t n = samples - sent;
    if (n > 256) n = 256;
    for (uint32_t i = 0; i < n; ++i) {
      uint32_t idx = sent + i;
      float env = 1.0f;
      if (idx < edge) env = (float)idx / edge;
      else if (idx > samples - edge) env = (float)(samples - idx) / edge;
      float v = sinf(phase) * volume * env;
      chunk[i] = (int16_t)(v * 32767.0f);
      phase += step;
      if (phase > twoPi) phase -= twoPi;
    }
    size_t written;
    i2s_write(AUDIO_I2S_PORT, chunk, n * sizeof(int16_t), &written,
              portMAX_DELAY);
    sent += n;
  }
}

static void playSilence(uint32_t durationMs) {
  static int16_t zeros[128] = { 0 };
  uint32_t samples = (AUDIO_RATE * durationMs) / 1000;
  while (samples > 0) {
    uint32_t n = samples > 128 ? 128 : samples;
    size_t written;
    i2s_write(AUDIO_I2S_PORT, zeros, n * sizeof(int16_t), &written, 1);
    samples -= n;
  }
}

// -----------------------------------------------------------------------------
// Pre-baked tiny clip playback.
//
// Clips live in src/audio_clips.h, generated by tools/bake_audio.py from
// WAV/MP3 files. Format: 4-bit IMA ADPCM, mono, 16 kHz.
//
// We decode nibbles to signed 16-bit PCM on the fly while applying volume,
// then stream to I2S. This halves flash use versus the previous 8-bit PCM.
// -----------------------------------------------------------------------------
static const int8_t kImaIndexTable[16] = {
  -1, -1, -1, -1, 2, 4, 6, 8,
  -1, -1, -1, -1, 2, 4, 6, 8,
};

static const int16_t kImaStepTable[89] = {
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17,
  19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
  130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
  337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
  876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
  2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358,
  5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
  15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
};

static int16_t decodeImaNibble(uint8_t code, int16_t &predictor, uint8_t &stepIndex) {
  if (stepIndex > 88) stepIndex = 88;
  int step = kImaStepTable[stepIndex];
  int diff = step >> 3;
  if (code & 1) diff += step >> 2;
  if (code & 2) diff += step >> 1;
  if (code & 4) diff += step;
  if (code & 8) predictor -= diff;
  else          predictor += diff;

  if (predictor > 32767) predictor = 32767;
  else if (predictor < -32768) predictor = -32768;

  int nextIndex = (int)stepIndex + kImaIndexTable[code & 0x0F];
  if (nextIndex < 0) nextIndex = 0;
  else if (nextIndex > 88) nextIndex = 88;
  stepIndex = (uint8_t)nextIndex;
  return predictor;
}

static void playClip(const BmoClip *clip) {
  if (!clip || clip->sample_count == 0) return;
  if (clip->rate != AUDIO_RATE) return;

  static int16_t chunk[256];
  int16_t predictor = clip->predictor;
  uint8_t stepIndex = clip->step_index;
  uint32_t produced = 0;
  uint32_t encodedIndex = 0;
  bool highNibble = false;

  while (produced < clip->sample_count) {
    uint32_t n = 0;
    while (n < 256 && produced < clip->sample_count) {
      int16_t sample;
      if (produced == 0) {
        sample = predictor;
      } else {
        if (encodedIndex >= clip->length) break;
        uint8_t packed = clip->samples[encodedIndex];
        uint8_t code = highNibble ? (packed >> 4) : (packed & 0x0F);
        if (highNibble) encodedIndex++;
        highNibble = !highNibble;
        sample = decodeImaNibble(code, predictor, stepIndex);
      }

      float f = ((float)sample / 32768.0f) * g_volume;
      if (f > 1.0f) f = 1.0f;
      else if (f < -1.0f) f = -1.0f;
      chunk[n++] = (int16_t)(f * 32767.0f);
      produced++;
    }
    if (n == 0) break;
    talkEnvelopeFeed(chunk, n);   // keep the lip-sync envelope live for clips too
    size_t written;
    i2s_write(AUDIO_I2S_PORT, chunk, n * sizeof(int16_t), &written,
              portMAX_DELAY);
  }
  g_talkLevel = 0.0f;   // mouth closes when the clip ends
}

// Lip-synced clip playback: like playClip, but renders a BMO "talking" face
// between audio chunks so the mouth moves with the clip's actual loudness.
// Used for the touch greetings so BMO visibly *says* "hai!" rather than
// playing a voice over a static face. Blocks until the clip finishes.
static void playClipLipSync(const BmoClip *clip) {
  if (!clip || clip->sample_count == 0 || clip->rate != AUDIO_RATE) return;

  static int16_t chunk[256];
  int16_t predictor = clip->predictor;
  uint8_t stepIndex = clip->step_index;
  uint32_t produced = 0;
  uint32_t encodedIndex = 0;
  bool highNibble = false;
  uint8_t frameSkip = 0;

  while (produced < clip->sample_count) {
    uint32_t n = 0;
    while (n < 256 && produced < clip->sample_count) {
      int16_t sample;
      if (produced == 0) {
        sample = predictor;
      } else {
        if (encodedIndex >= clip->length) break;
        uint8_t packed = clip->samples[encodedIndex];
        uint8_t code = highNibble ? (packed >> 4) : (packed & 0x0F);
        if (highNibble) encodedIndex++;
        highNibble = !highNibble;
        sample = decodeImaNibble(code, predictor, stepIndex);
      }
      float f = ((float)sample / 32768.0f) * g_volume;
      if (f > 1.0f) f = 1.0f;
      else if (f < -1.0f) f = -1.0f;
      chunk[n++] = (int16_t)(f * 32767.0f);
      produced++;
    }
    if (n == 0) break;
    talkEnvelopeFeed(chunk, n);

    // Render a talking frame roughly every other chunk (~32ms) so we keep the
    // I2S buffer fed without starving it on slow draws.
    if ((frameSkip++ & 1) == 0) {
      const uint32_t now = millis();
      float lvl = g_talkLevel;
      FaceState s;
      s.eyeShape  = FaceState::EYE_NORMAL;
      s.mouth     = FaceState::M_OPEN;
      s.mouthOpen = 0.08f + 0.9f * lvl;
      if (s.mouthOpen > 1.0f) s.mouthOpen = 1.0f;
      const uint32_t blinkPhase = now % 2600;
      s.lidL = s.lidR = (blinkPhase < 130) ? 0.8f : 0.1f;
      s.pupilDy = -(int)(2.0f * lvl);
      s.blush = 0.25f;   // warm, friendly greeting
      drawFaceToBuffer(s, now);
      flushFrame();
    }

    size_t written;
    i2s_write(AUDIO_I2S_PORT, chunk, n * sizeof(int16_t), &written,
              portMAX_DELAY);
  }
  g_talkLevel = 0.0f;
}

// Lookup by clip name (e.g. "bmo_hi_friend"). Returns NULL if not found.
// Use when you want optional clips: if it's not baked, you can fall back
// to the synth voices below.
static const BmoClip *findClip(const char *name) {
  for (int i = 0; i < BMO_CLIP_COUNT; ++i) {
    if (strcmp(BMO_CLIP_TABLE[i]->name, name) == 0) return BMO_CLIP_TABLE[i];
  }
  return NULL;
}

// Try to play a clip by name; if missing, run the synth fallback function.
static void playClipOrSynth(const char *name, void (*synthFallback)()) {
  const BmoClip *c = findClip(name);
  if (c) playClip(c);
  else if (synthFallback) synthFallback();
}

// Generic greeting voices played on a normal (non-talk) touch. We rotate
// through whichever of these clips are actually baked into the voice pack so
// BMO doesn't say the exact same thing every single time you poke it — it
// feels alive rather than canned. Names that aren't present are skipped, and
// if NONE of them are baked we fall back to the caller-supplied synth voice.
//
// These live in flash as baked ADPCM clips (src/audio_clips.h), same as the
// existing voices — see the note at the bottom of this function for the
// storage rationale. Add WAVs named like these to audio/ and re-bake.
static void playGreeting(void (*synthFallback)()) {
  static const char *const kGreetingClips[] = {
    "bmo_hi_friend",
    "bmo_hello",
    "bmo_hey",
    "bmo_oh_hi",
    "bmo_hi_there",
  };
  constexpr int kCount = sizeof(kGreetingClips) / sizeof(kGreetingClips[0]);

  // Collect the ones that are actually baked in this build.
  const BmoClip *present[kCount];
  int n = 0;
  for (int i = 0; i < kCount; ++i) {
    const BmoClip *c = findClip(kGreetingClips[i]);
    if (c) present[n++] = c;
  }

  if (n == 0) {
    // No greeting clips baked → behave exactly like before.
    if (synthFallback) synthFallback();
    return;
  }

  // Rotate so consecutive touches don't repeat the same greeting. Seeded off
  // millis() the first time for a little variety across power cycles.
  static int idx = -1;
  if (idx < 0) idx = (int)(millis() % n);
  else idx = (idx + 1) % n;
  // Lip-sync the greeting so BMO visibly says it (mouth moves with the voice)
  // rather than playing audio over a frozen face.
  playClipLipSync(present[idx]);
}


// -----------------------------------------------------------------------------
// Toy voice synth — procedural sounds that give BMO a bright beep-and-chirp
// character without needing pre-recorded audio. For tiny generated phrases,
// see tools/generate_tiny_voice.py and tools/bake_audio.py.
// -----------------------------------------------------------------------------

// Slide from one frequency to another over a duration. Adds a slight vibrato
// for vocal feel.
static void playSlide(float startHz, float endHz, uint32_t durationMs,
                      float boost = 1.0f) {
  const float volume = g_volume * boost;
  const uint32_t samples = (AUDIO_RATE * durationMs) / 1000;
  const float twoPi = 6.28318530718f;
  const uint32_t edge = AUDIO_RATE / 80;          // 12 ms attack/release
  static int16_t chunk[256];
  float phase = 0;
  uint32_t sent = 0;
  while (sent < samples) {
    uint32_t n = samples - sent;
    if (n > 256) n = 256;
    for (uint32_t i = 0; i < n; ++i) {
      uint32_t idx = sent + i;
      float t = (float)idx / (float)samples;
      // Smooth ease curve so the slide doesn't sound robotic
      float ease = t * t * (3.0f - 2.0f * t);
      float hz = startHz + (endHz - startHz) * ease;
      // Light vibrato (~6 Hz, ±2%)
      hz *= 1.0f + 0.02f * sinf(twoPi * 6.0f * idx / AUDIO_RATE);
      float env = 1.0f;
      if (idx < edge) env = (float)idx / edge;
      else if (idx > samples - edge) env = (float)(samples - idx) / edge;
      phase += twoPi * hz / AUDIO_RATE;
      if (phase > twoPi) phase -= twoPi;
      chunk[i] = (int16_t)(sinf(phase) * volume * env * 32767.0f);
    }
    size_t written;
    i2s_write(AUDIO_I2S_PORT, chunk, n * sizeof(int16_t), &written, portMAX_DELAY);
    sent += n;
  }
}

// Quick chirp: rises then falls in one fluid motion. Great for laughter.
static void playChirp(float baseHz, float peakHz, uint32_t durationMs,
                      float boost = 1.0f) {
  uint32_t half = durationMs / 2;
  playSlide(baseHz, peakHz, half, boost);
  playSlide(peakHz, baseHz, durationMs - half, boost);
}

// "BMO laugh!" — 5 alternating chirps that descend in pitch over time.
static void playBmoLaugh() {
  static const float pattern[] = { 980, 880, 1100, 880, 780 };
  for (int i = 0; i < 5; ++i) {
    playChirp(pattern[i] * 0.9f, pattern[i], 90, 1.1f);
    playSilence(40);
  }
}

// Two-tone classic: high then low, like saying "beep BOOP".
static void playBmoBeepBoop() {
  playSlide(900, 1100, 90, 1.0f);
  playSilence(30);
  playSlide(700, 500, 120, 1.0f);
}

// "Hooray!" — rising 4-note triumph with a sparkle on top.
static void playBmoHooray() {
  playSlide(523, 659, 80, 1.0f);     // C → E
  playSlide(659, 784, 80, 1.0f);     // E → G
  playSlide(784, 988, 100, 1.1f);    // G → B
  playSilence(40);
  playSlide(988, 1318, 200, 1.2f);   // B → high E (sparkle finish)
}

// "What?" — single rising chirp with question intonation.
static void playBmoWhat() {
  playSlide(700, 900, 70, 1.0f);
  playSilence(20);
  playSlide(900, 1300, 130, 1.1f);
}

// "Hi friend!" placeholder — until real TTS clips are added, this is a
// 3-syllable rising phrase with BMO's characteristic warble.
static void playBmoHi() {
  playSlide(700, 900, 100, 1.0f);    // "hi" rising
  playSilence(40);
  playSlide(800, 700, 70, 1.0f);     // "fre"
  playSlide(700, 900, 90, 1.0f);     // "end" rising again
}

// "BMO BMO BMO BMO" — 4 quick same-pitch beeps with a tiny bounce.
static void playBmoChant() {
  for (int i = 0; i < 4; ++i) {
    float base = 800 + (i & 1) * 60;
    playSlide(base, base + 180, 60, 1.0f);
    playSilence(50);
  }
}

// "Who wants to play video games?" placeholder — long playful melody.
// The tiny voice pack can override this with a generated toy-voice clip.
static void playBmoGames() {
  static const float notes[] = { 700, 700, 800, 700, 600, 700, 800, 900, 1100 };
  static const uint16_t durs[] = {  80,  60,  80,  60,  80,  80,  80, 100, 200 };
  for (size_t i = 0; i < 9; ++i) {
    playSlide(notes[i] * 0.95f, notes[i], durs[i], 1.0f);
    playSilence(15);
  }
}

// Cute "huh!" startled chirp — used for QUICK_POKE.
static void playBmoStartled() {
  playSlide(1500, 1700, 50, 1.3f);
  playSilence(20);
  playSlide(1100, 800, 80, 1.0f);
}

// Sweet sigh — used at end of HOLD purr.
static void playBmoSigh() {
  playSlide(900, 600, 250, 0.9f);
}


// Mood-specific jingles. Tone frequencies in Hz, durations in ms.
struct Note { float hz; uint16_t ms; };

static void playJingle(const Note *notes, size_t count) {
  for (size_t i = 0; i < count; ++i) {
    if (notes[i].hz <= 0) playSilence(notes[i].ms);
    else                  playTone(notes[i].hz, notes[i].ms);
  }
}

static const Note kJingleHappy[]    = { {523, 80}, {659, 80}, {784, 120} };
static const Note kJingleSad[]      = { {440, 200}, {392, 200}, {330, 300} };
static const Note kJingleSurprise[] = { {1200, 50}, {0, 30}, {1500, 80} };
static const Note kJingleLove[]     = { {659, 100}, {784, 100}, {988, 150} };
static const Note kJingleAngry[]    = { {200, 80}, {200, 80}, {200, 80} };
static const Note kJingleTalk[]     = { {500, 60}, {600, 60}, {500, 60} };
static const Note kJingleLaugh[]    = { {660, 60}, {880, 60}, {660, 60}, {880, 80} };
static const Note kJingleSleepy[]   = { {350, 200}, {280, 250} };
static const Note kJingleWake[]     = { {440, 80}, {550, 80}, {660, 80}, {880, 150} };
static const Note kJingleConfused[] = { {500, 80}, {350, 80}, {500, 80}, {350, 80} };
static const Note kJingleBlink[]    = { {800, 30} };
static const Note kJingleHungry[]   = { {350, 100}, {0, 50}, {350, 100}, {0, 50}, {350, 200} };
static const Note kJingleHot[]      = { {1000, 60}, {800, 60}, {1000, 60} };
static const Note kJingleCold[]     = { {1100, 50}, {1100, 50}, {1100, 50} };
static const Note kJingleSick[]     = { {500, 200}, {300, 300} };
static const Note kJingleCool[]     = { {523, 100}, {659, 100}, {784, 200} };
static const Note kJingleScared[]   = { {1500, 80}, {1500, 80}, {1500, 200} };
static const Note kJingleFocused[]  = { {880, 50}, {0, 30}, {880, 50} };
static const Note kJingleExcited[]  = { {659, 60}, {784, 60}, {988, 60}, {1175, 100} };
static const Note kJingleDizzy[]    = { {880, 80}, {659, 80}, {440, 80}, {659, 80} };
static const Note kJingleListen[]   = { {880, 50} };
static const Note kJingleThinking[] = { {650, 60}, {0, 40}, {740, 60}, {0, 40}, {880, 80} };
static const Note kJingleWink[]     = { {1000, 60} };
static const Note kJingleGlitch[]   = { {200, 30}, {1500, 30}, {200, 30}, {1500, 30} };
static const Note kJingleIdle[]     = { {0, 0} };  // silent

// ============================================================================
// Songs / TTS audio are now produced host-side by Doraemon (BMO soul) and
// streamed back as PCM. The ESP32 stays minimal: animate face, capture mic,
// play whatever audio the bridge sends. Removed dead in-firmware song bank.
// ============================================================================

enum Mood : uint8_t {
  MOOD_IDLE,
  MOOD_BLINK,
  MOOD_HAPPY,
  MOOD_TALK,
  MOOD_LISTEN,
  MOOD_THINKING,
  MOOD_SURPRISE,
  MOOD_SLEEPY,
  MOOD_WINK,
  MOOD_LOVE,
  MOOD_SAD,
  MOOD_ANGRY,
  MOOD_EXCITED,
  MOOD_DIZZY,
  MOOD_WAKE,
  MOOD_GLITCH,
  // new in this round
  MOOD_HUNGRY,
  MOOD_COLD,
  MOOD_HOT,
  MOOD_SICK,
  MOOD_COOL,
  MOOD_CONFUSED,
  MOOD_BORED,
  MOOD_SCARED,
  MOOD_FOCUSED,
  MOOD_LAUGH,
  MOOD_COUNT,
};

static const char *moodName(Mood m) {
  switch (m) {
    case MOOD_IDLE:     return "idle";
    case MOOD_BLINK:    return "blink";
    case MOOD_HAPPY:    return "happy";
    case MOOD_TALK:     return "talk";
    case MOOD_LISTEN:   return "listen";
    case MOOD_THINKING: return "thinking";
    case MOOD_SURPRISE: return "surprise";
    case MOOD_SLEEPY:   return "sleepy";
    case MOOD_WINK:     return "wink";
    case MOOD_LOVE:     return "love";
    case MOOD_SAD:      return "sad";
    case MOOD_ANGRY:    return "angry";
    case MOOD_EXCITED:  return "excited";
    case MOOD_DIZZY:    return "dizzy";
    case MOOD_WAKE:     return "wake";
    case MOOD_GLITCH:   return "glitch";
    case MOOD_HUNGRY:   return "hungry";
    case MOOD_COLD:     return "cold";
    case MOOD_HOT:      return "hot";
    case MOOD_SICK:     return "sick";
    case MOOD_COOL:     return "cool";
    case MOOD_CONFUSED: return "confused";
    case MOOD_BORED:    return "bored";
    case MOOD_SCARED:   return "scared";
    case MOOD_FOCUSED:  return "focused";
    case MOOD_LAUGH:    return "laugh";
    default: return "?";
  }
}

// Pick the right jingle for a mood (returns pointer + count).
static void jingleFor(Mood m, const Note *&n, size_t &count) {
  #define J(arr) do { n = arr; count = sizeof(arr)/sizeof(arr[0]); } while (0)
  switch (m) {
    case MOOD_IDLE:     J(kJingleIdle); break;
    case MOOD_BLINK:    J(kJingleBlink); break;
    case MOOD_HAPPY:    J(kJingleHappy); break;
    case MOOD_TALK:     J(kJingleTalk); break;
    case MOOD_LISTEN:   J(kJingleListen); break;
    case MOOD_THINKING: J(kJingleThinking); break;
    case MOOD_SURPRISE: J(kJingleSurprise); break;
    case MOOD_SLEEPY:   J(kJingleSleepy); break;
    case MOOD_WINK:     J(kJingleWink); break;
    case MOOD_LOVE:     J(kJingleLove); break;
    case MOOD_SAD:      J(kJingleSad); break;
    case MOOD_ANGRY:    J(kJingleAngry); break;
    case MOOD_EXCITED:  J(kJingleExcited); break;
    case MOOD_DIZZY:    J(kJingleDizzy); break;
    case MOOD_WAKE:     J(kJingleWake); break;
    case MOOD_GLITCH:   J(kJingleGlitch); break;
    case MOOD_HUNGRY:   J(kJingleHungry); break;
    case MOOD_COLD:     J(kJingleCold); break;
    case MOOD_HOT:      J(kJingleHot); break;
    case MOOD_SICK:     J(kJingleSick); break;
    case MOOD_COOL:     J(kJingleCool); break;
    case MOOD_CONFUSED: J(kJingleConfused); break;
    case MOOD_BORED:    J(kJingleIdle); break;
    case MOOD_SCARED:   J(kJingleScared); break;
    case MOOD_FOCUSED:  J(kJingleFocused); break;
    case MOOD_LAUGH:    J(kJingleLaugh); break;
    default:            J(kJingleIdle); break;
  }
  #undef J
}

// Per-mood jingle on transition. DISABLED for now — re-enable by setting
// `g_jingleEnabled = true` if you want them back, or wire it to a serial
// command later.
static bool g_jingleEnabled = false;

static void playMood(Mood m, uint32_t durationMs) {
  uint32_t start = millis();
  Serial.printf("mood: %s (%u ms)\n", moodName(m), (unsigned)durationMs);

  if (g_jingleEnabled) {
    const Note *jn; size_t jc;
    jingleFor(m, jn, jc);
    if (jc > 0) playJingle(jn, jc);
  }

  while (millis() - start < durationMs) {
    uint32_t now = millis();
    float t = (now - start) / (float)durationMs;
    FaceState s;

    switch (m) {
      case MOOD_IDLE: {
        s.mouth = FaceState::M_OPEN;
        s.mouthOpen = 0.55f + 0.05f * sinf(now * 0.0013f);
        s.pupilDx = (int)(2 * sinf(now * 0.0011f));
        s.pupilDy = (int)(1 * sinf(now * 0.0007f));
        uint32_t bp = now % 5200;
        if (bp < 130) {
          float p = bp / 130.0f;
          float lid = (p < 0.5f) ? p * 2 : (1 - p) * 2;
          s.lidL = s.lidR = lid;
        }
        break;
      }
      case MOOD_BLINK: {
        s.mouth = FaceState::M_SMILE;
        float p = t;
        s.lidL = s.lidR = (p < 0.5f) ? p * 2 : (1 - p) * 2;
        break;
      }
      case MOOD_HAPPY: {
        s.eyeShape = FaceState::EYE_CRESCENT;
        s.mouth = FaceState::M_OPEN;
        s.mouthOpen = 0.6f + 0.4f * sinf(now * 0.012f);
        s.blush = 1.0f;
        break;
      }
      case MOOD_TALK: {
        s.mouth = FaceState::M_TALK;
        s.mouthOpen = 0.5f + 0.5f * sinf(now * 0.018f);
        uint8_t talkPhase = (uint8_t)((now / 120) % 3);
        if (talkPhase == 0) s.pupilDx = -1;
        else if (talkPhase == 1) s.pupilDx = 1;
        s.pupilDy = (int)(1 * sinf(now * 0.01f));
        break;
      }
      case MOOD_LISTEN: {
        s.mouth = FaceState::M_OPEN;
        s.mouthOpen = 0.18f + 0.06f * fabsf(sinf(now * 0.010f));
        s.pupilDx = (int)(1 * sinf(now * 0.005f));
        s.pupilDy = (int)(1 * sinf(now * 0.003f));
        s.listeningMarks = true;
        s.shakeY = (int)(1 * sinf(now * 0.006f));
        break;
      }
      case MOOD_THINKING: {
        s.mouth = FaceState::M_FLAT;
        s.flatWidth = 18 + (int)(3 * sinf(now * 0.004f));
        s.pupilDx = 2 + (int)(1 * sinf(now * 0.003f));
        s.pupilDy = -2;
        s.lidL = s.lidR = 0.15f + 0.08f * fabsf(sinf(now * 0.004f));
        s.thinkingDots = true;
        s.shakeY = (int)(1 * sinf(now * 0.002f));
        break;
      }
      case MOOD_SURPRISE: {
        s.mouth = FaceState::M_OH;
        s.lidL = s.lidR = 0;
        s.pupilDx = (int)(1 * sinf(now * 0.05f));
        s.pupilDy = (int)(1 * cosf(now * 0.05f));
        break;
      }
      case MOOD_SLEEPY: {
        s.mouth = FaceState::M_FLAT;
        float breathe = (sinf(now * 0.002f) + 1) * 0.5f;
        s.lidL = s.lidR = 0.75f + 0.2f * breathe;
        break;
      }

      case MOOD_WINK: {
        // Hold a wink for first 60% of the scene, then both eyes return
        s.mouth = FaceState::M_GRIN;
        if (t < 0.7f) {
          s.eyeShape = FaceState::EYE_HALF_WINK_R;
        }
        s.blush = 0.5f;
        break;
      }
      case MOOD_LOVE: {
        s.eyeShape = FaceState::EYE_HEART;
        // Pulsing happy mouth
        s.mouth = FaceState::M_OPEN;
        s.mouthOpen = 0.5f + 0.4f * sinf(now * 0.012f);
        s.blush = 1.0f;
        s.heartsAround = true;
        break;
      }
      case MOOD_SAD: {
        s.mouth = FaceState::M_FROWN;
        s.browVisible = true;
        s.browSlope = -8;          // inner ends raised (sad)
        s.lidL = s.lidR = 0.5f;    // half closed eyes
        // Tear cycles: appears, drips down, fades
        float tearCycle = fmodf(t * 1.5f, 1.0f);
        s.tearVisible = (tearCycle < 0.6f);
        s.tearY = (int)(tearCycle * 18);
        s.pupilDy = 2;             // looking down
        break;
      }
      case MOOD_ANGRY: {
        s.mouth = FaceState::M_FLAT;
        s.browVisible = true;
        s.browSlope = 10;          // inner ends down (angry)
        // Slight shake
        s.shakeX = (int)(2 * sinf(now * 0.05f));
        s.shakeY = (int)(1 * cosf(now * 0.04f));
        s.pupilDx = -2;
        break;
      }
      case MOOD_EXCITED: {
        s.eyeShape = FaceState::EYE_CRESCENT;
        s.mouth = FaceState::M_GRIN;
        s.starsVisible = true;
        // bouncing
        s.shakeY = -(int)(2 * fabsf(sinf(now * 0.012f)));
        s.blush = 0.8f;
        break;
      }
      case MOOD_DIZZY: {
        s.eyeShape = FaceState::EYE_SPIRAL;
        s.mouth = FaceState::M_OPEN;
        // Wobbly mouth
        s.mouthOpen = 0.4f + 0.3f * sinf(now * 0.02f);
        s.shakeX = (int)(3 * sinf(now * 0.008f));
        break;
      }
      case MOOD_WAKE: {
        // Big yawn — eyes widen, mouth opens enormously, then settle
        s.mouth = FaceState::M_OPEN;
        if (t < 0.4f) {
          s.mouthOpen = t / 0.4f;          // ramp up
          s.lidL = s.lidR = 1.0f - t / 0.4f;
        } else if (t < 0.7f) {
          s.mouthOpen = 1.0f;
          s.lidL = s.lidR = 0;
        } else {
          float p = (t - 0.7f) / 0.3f;
          s.mouthOpen = 1.0f - p;
          s.lidL = s.lidR = 0;
        }
        break;
      }
      case MOOD_GLITCH: {
        s.mouth = FaceState::M_FLAT;
        s.lidL = s.lidR = 0;
        // Heavy glitch bars + occasional X eyes
        s.glitchBars = 4;
        if (((int)(now / 200) & 1) == 0) {
          s.eyeShape = FaceState::EYE_X;
        }
        s.shakeX = (int)((now * 7) % 5) - 2;
        break;
      }

      case MOOD_HUNGRY: {
        // Eyes look down, tongue out, drool dripping
        s.mouth = FaceState::M_DROOL;
        s.mouthOpen = 0.6f + 0.4f * sinf(now * 0.008f);
        s.pupilDy = 3;
        s.lidL = s.lidR = 0.2f;
        s.blush = 0.4f;
        break;
      }
      case MOOD_COLD: {
        s.mouth = FaceState::M_CHATTER;
        s.lidL = s.lidR = 0.6f;
        s.shakeX = (int)((now / 60) % 3) - 1;
        s.shakeY = (int)((now / 40) % 3) - 1;
        s.snowFlakes = true;
        break;
      }
      case MOOD_HOT: {
        s.mouth = FaceState::M_OPEN;
        s.mouthOpen = 0.6f + 0.3f * sinf(now * 0.005f);
        s.lidL = s.lidR = 0.4f;
        s.steamLines = true;
        s.sweatVisible = true;
        s.sweatY = (int)((now / 60) % 18);
        s.blush = 0.7f;
        break;
      }
      case MOOD_SICK: {
        s.mouth = FaceState::M_ZIGZAG;
        s.lidL = s.lidR = 0.55f;
        s.pupilDx = (int)(2 * sinf(now * 0.003f));
        s.pupilDy = 1;
        s.browVisible = true;
        s.browSlope = -4;
        s.shakeY = (int)(1 * sinf(now * 0.006f));
        break;
      }
      case MOOD_COOL: {
        // Sunglasses + smug grin, slight head bob
        s.eyeShape = FaceState::EYE_SHADES;
        s.mouth = FaceState::M_SMILE;
        s.shakeY = (int)(1 * sinf(now * 0.004f));
        break;
      }
      case MOOD_CONFUSED: {
        // Tiny dot eyes scanning side to side, zigzag mouth, ?? in air
        s.eyeShape = FaceState::EYE_DOT;
        s.mouth = FaceState::M_ZIGZAG;
        s.questionMarks = true;
        // Head tilt and pupil drift simulated by shake
        s.shakeX = (int)(2 * sinf(now * 0.002f));
        s.browVisible = true;
        s.browSlope = -3;
        break;
      }
      case MOOD_BORED: {
        // Half-lidded eyes looking sideways, flat mouth, occasional zzz
        s.lidL = s.lidR = 0.7f;
        s.pupilDx = -3;
        s.mouth = FaceState::M_FLAT;
        s.zzzLetters = ((now / 800) % 3 == 0);
        break;
      }
      case MOOD_SCARED: {
        // Wide eyes, frown, sweat, shake
        s.lidL = s.lidR = 0;
        s.pupilDx = (int)(2 * sinf(now * 0.04f));
        s.pupilDy = (int)(1 * cosf(now * 0.04f));
        s.mouth = FaceState::M_FROWN;
        s.sweatVisible = true;
        s.sweatY = (int)((now / 80) % 16);
        s.shakeX = (int)((now / 50) % 3) - 1;
        s.shakeY = (int)((now / 70) % 3) - 1;
        s.browVisible = true;
        s.browSlope = -5;
        break;
      }
      case MOOD_FOCUSED: {
        // Squint eyes, tight mouth, slight sweat indicating effort
        s.eyeShape = FaceState::EYE_SQUINT;
        s.mouth = FaceState::M_FLAT;
        s.browVisible = true;
        s.browSlope = 6;
        s.sweatVisible = true;
        s.sweatY = (int)((now / 100) % 12);
        s.pupilDx = (int)(1 * sinf(now * 0.002f));
        break;
      }
      case MOOD_LAUGH: {
        s.eyeShape = FaceState::EYE_CRESCENT;
        // Crescent eyes (heavy lids), big laugh mouth, blush
        s.mouth = FaceState::M_LAUGH;
        s.mouthOpen = 0.7f + 0.3f * sinf(now * 0.025f);
        s.shakeY = (int)(2 * fabsf(sinf(now * 0.025f)));
        s.blush = 1.0f;
        break;
      }

      default: break;
    }

    applyMoodTransition(s, t);
    renderFrame(s, now);
    delay(30);

    // Touch interrupt: if user touches BMO during any mood, abort and react.
    pollTouch();
    if (g_touchPending) break;
  }
}

// -----------------------------------------------------------------------------
// Touch sensor (TTP223): debounced reader + classifier.
//
// We classify touches into 4 reaction types so BMO feels alive:
//   - QUICK_POKE   : <250 ms tap        → surprised + giggle
//   - HOLD         : 250-1500 ms hold   → happy/blush + warm coo
//   - LONG_HOLD    : >1500 ms hold      → love (heart eyes) + heart melody
//   - TICKLE       : 3+ rapid taps in 1s → laughing + bouncing
// Anything else falls back to a single happy giggle.
// -----------------------------------------------------------------------------
enum TouchKind : int {
  TOUCH_NONE,
  TOUCH_QUICK_POKE,
  TOUCH_HOLD,
  TOUCH_LONG_HOLD,
  TOUCH_TICKLE,
};

volatile bool      g_touchPending = false;
volatile TouchKind g_pendingKind  = TOUCH_NONE;

// History of recent press-down timestamps for tickle detection
static uint32_t s_recentPressMs[8] = {0};
static uint8_t  s_pressIdx = 0;

static int recentPressesWithin(uint32_t windowMs) {
  uint32_t now = millis();
  int count = 0;
  for (size_t i = 0; i < sizeof(s_recentPressMs) / sizeof(s_recentPressMs[0]); ++i) {
    if (s_recentPressMs[i] != 0 && (now - s_recentPressMs[i]) <= windowMs) count++;
  }
  return count;
}

// Poll the touch sensor and classify. Call frequently (every ~10ms is fine).
//
// Gesture model (walkie-talkie / push-to-talk):
//   - tap  (<250ms)                : poke  (3+ rapid taps = tickle)
//   - brief hold (250ms..kTalkHoldMs): canned "pet" HOLD reaction
//   - hold >= kTalkHoldMs          : PUSH-TO-TALK. Fires *while still held*
//       so askBrain() records for as long as the user keeps holding and
//       sends the moment they release. The listening face shows the entire
//       time, so the user always knows BMO is hearing them.
static constexpr uint32_t kTalkHoldMs = 500;

// True while the capacitive button is being touched. Used as the
// "keep recording" predicate for push-to-talk.
//
// DEBOUNCED. The raw line can glitch — electrical noise on the wire, or the
// pin briefly flickering — and pollTouch() has no other filtering, so a single
// glitch becomes a phantom press→release pair = a phantom poke/reaction. Left
// unfiltered this shows up as BMO reacting "non-stop like it's being touched."
// We only accept a new level once the raw reading has held steady for
// kDebounceMs, which kills the fast glitches while staying responsive.
static constexpr uint32_t kDebounceMs = 40;

static bool touchRaw() { return digitalRead(PIN_TOUCH) == HIGH; }

static bool touchIsDown() {
  static bool stable = false;      // last accepted (debounced) level
  static bool lastRaw = false;     // previous raw sample
  static uint32_t lastChange = 0;  // when the raw sample last changed
  bool raw = touchRaw();
  if (raw != lastRaw) {
    lastRaw = raw;
    lastChange = millis();
  } else if (raw != stable && (millis() - lastChange) >= kDebounceMs) {
    stable = raw;
  }
  return stable;
}

static void pollTouch() {
  static bool wasDown = false;
  static uint32_t pressStart = 0;
  static bool consumed = false;  // this press already fired the talk gesture
  bool isDown = touchIsDown();

  if (isDown && !wasDown) {
    // press began
    pressStart = millis();
    consumed = false;
    s_recentPressMs[s_pressIdx % 8] = pressStart;
    s_pressIdx++;
  } else if (isDown && wasDown) {
    // still holding — once we cross the talk threshold, fire LONG_HOLD
    // IMMEDIATELY (while the finger is still down) so the recording in
    // askBrain() runs for the duration of the hold, walkie-talkie style.
    if (!consumed && (millis() - pressStart) >= kTalkHoldMs) {
      consumed = true;
      g_pendingKind = TOUCH_LONG_HOLD;
      g_touchPending = true;
    }
  } else if (!isDown && wasDown) {
    // release. If the talk gesture already fired mid-hold, do nothing here
    // (the press is consumed). Otherwise classify the short gestures — AND,
    // crucially, treat a sustained hold as PUSH-TO-TALK here too. The mid-hold
    // branch above is the *fast* path (fires while the finger is still down),
    // but it depends on pollTouch() being sampled steadily across the
    // kTalkHoldMs mark with a perfectly stable line. The TTP223 line can
    // flicker enough to miss that, so without this release fallback a long
    // physical hold collapses to a "pet" and the brain/STT path never runs.
    if (!consumed) {
      uint32_t held = millis() - pressStart;
      int taps = recentPressesWithin(900);
      TouchKind kind;
      if (held >= kTalkHoldMs) {
        kind = TOUCH_LONG_HOLD;   // sustained hold → push-to-talk (brain)
      } else if (taps >= 3 && held < 250) {
        kind = TOUCH_TICKLE;
      } else if (held < 250) {
        kind = TOUCH_QUICK_POKE;
      } else {
        kind = TOUCH_HOLD;  // 250ms .. kTalkHoldMs: brief "pet"
      }
      Serial.printf("[touch] release held=%lums -> %s\n",
                    static_cast<unsigned long>(held), touchKindName(kind));
      g_pendingKind = kind;
      g_touchPending = true;
    }
  }
  wasDown = isDown;
}

// Set true when a touch interrupts BMO mid-reply, so askBrain() can play a
// graceful "okay!" acknowledgement instead of letting the reply run out.
static volatile bool g_talkInterrupted = false;

// ---- Idle "random thought" gating ------------------------------------------
// Instead of a wall-clock timer (which would burn OpenRouter credit all day
// and risk BMO talking to an empty room at 2am), BMO only muses a spontaneous
// thought after the child has played with it a few times. We count playful
// touches here; when the count hits kTouchesPerThought, BMO thinks aloud once
// and the counter resets. No touches (BMO sitting in a drawer, or night-time)
// => no thoughts => zero cost and silence in quiet hours. The count lives in
// RAM only; a reboot harmlessly restarts the accumulation.
static constexpr uint32_t kTouchesPerThought = 5;
static uint32_t g_playfulTouchCount = 0;
// Set by countTouchForThought() when the threshold is reached; consumed by the
// loop once the current touch reaction has fully finished, so the musing plays
// cleanly after BMO reacts rather than interrupting the reaction.
static bool g_thoughtDue = false;

// Counts a finished touch toward the idle-thought threshold. LONG_HOLD is
// push-to-talk — that already starts a full conversation, so it doesn't count
// as an idle "play" touch. Every other touch (poke, tickle, pet) does. When
// the count reaches kTouchesPerThought we arm g_thoughtDue and reset, so the
// next quiet moment gets one spontaneous thought.
static void countTouchForThought(TouchKind k) {
  if (k == TOUCH_LONG_HOLD || k == TOUCH_NONE) return;
  g_playfulTouchCount++;
  Serial.printf("[brain] playful touch %lu/%lu toward idle thought\n",
                static_cast<unsigned long>(g_playfulTouchCount),
                static_cast<unsigned long>(kTouchesPerThought));
  if (g_playfulTouchCount >= kTouchesPerThought) {
    g_playfulTouchCount = 0;
    g_thoughtDue = true;
  }
}

// Predicate handed to the brain client: returns false (stop talking) the
// instant a fresh touch is detected during playback. We consume that touch
// here (clear the pending flags) so it interrupts cleanly without ALSO
// triggering a poke/hold reaction right afterwards — BMO just stops, like a
// person who hears "okay, stop" and pauses.
static bool brainShouldKeepTalking() {
  pollTouch();
  if (g_touchPending) {
    g_touchPending = false;
    g_pendingKind  = TOUCH_NONE;
    g_talkInterrupted = true;
    return false;
  }
  // The brain client calls this between every audio chunk while streaming the
  // reply. We render the talking face HERE (cooperatively, on the main thread)
  // rather than from faceRenderTask — on the single-core C3 a background SPI
  // flush during streaming starves the TLS read loop and truncates the reply.
  // Rendering between chunks keeps the stream fed. Mutex-guarded so we never
  // draw at the same time as the background task during the phase handoff.
  if (g_faceMutex && xSemaphoreTake(g_faceMutex, 0) == pdTRUE) {
    renderBrainStatusFrame(millis());
    xSemaphoreGive(g_faceMutex);
  }
  return true;
}

static const char *touchKindName(TouchKind k) {
  switch (k) {
    case TOUCH_QUICK_POKE: return "poke";
    case TOUCH_HOLD:       return "hold";
    case TOUCH_LONG_HOLD:  return "long-hold";
    case TOUCH_TICKLE:     return "tickle";
    default:               return "none";
  }
}

// Map a touch event to a reaction mood + duration. The reaction always
// plays a sound (overriding g_jingleEnabled) because that IS the reaction.
struct Reaction {
  Mood mood;
  uint32_t durationMs;
  const Note *jingle;
  size_t jingleCount;
};

#define J(x) (x), (sizeof(x) / sizeof(Note))

// Use existing arrays where possible; one new "tickle giggle" array below
static const Note kTickleJingle[]   = { {659, 60}, {880, 60}, {1175, 60}, {880, 60}, {659, 60} };
static const Note kPokeJingle[]     = { {1200, 50}, {0, 30}, {1500, 80} };
static const Note kHoldJingle[]     = { {523, 100}, {659, 100}, {784, 150} };
static const Note kLongHoldJingle[] = { {659, 100}, {784, 100}, {988, 100}, {1175, 250} };

static Reaction reactionFor(TouchKind k) {
  switch (k) {
    case TOUCH_QUICK_POKE: return { MOOD_SURPRISE, 1100, J(kPokeJingle) };
    case TOUCH_HOLD:       return { MOOD_HAPPY,    2200, J(kHoldJingle) };
    case TOUCH_LONG_HOLD:  return { MOOD_LOVE,     3000, J(kLongHoldJingle) };
    case TOUCH_TICKLE:     return { MOOD_LAUGH,    2400, J(kTickleJingle) };
    default:               return { MOOD_HAPPY,    1200, J(kHoldJingle) };
  }
}
#undef J

// Particle burst: a few small shapes that fly outward and fade.
// Used for confetti effects in reactions (sparkles, hearts, exclamations).
struct Particle {
  float x, y;
  float vx, vy;
  float life;     // 1.0 -> 0.0 over lifetime
  uint16_t color;
  uint8_t kind;   // 0 = sparkle, 1 = heart, 2 = exclaim, 3 = dot
};
static constexpr int MAX_PARTICLES = 12;
static Particle g_particles[MAX_PARTICLES];

static void particlesClear() {
  for (int i = 0; i < MAX_PARTICLES; ++i) g_particles[i].life = 0;
}

static void particlesEmit(int count, int cx, int cy, uint8_t kind, uint16_t color) {
  for (int i = 0; i < count && i < MAX_PARTICLES; ++i) {
    int slot = -1;
    for (int s = 0; s < MAX_PARTICLES; ++s) {
      if (g_particles[s].life <= 0) { slot = s; break; }
    }
    if (slot < 0) return;
    float ang = (float)i / (float)count * 6.28318f + (millis() & 31) * 0.05f;
    float speed = 0.8f + (i & 3) * 0.25f;
    g_particles[slot] = {
      (float)cx, (float)cy,
      cosf(ang) * speed, sinf(ang) * speed - 0.3f,
      1.0f, color, kind
    };
  }
}

static void particlesStep() {
  for (int i = 0; i < MAX_PARTICLES; ++i) {
    Particle &p = g_particles[i];
    if (p.life <= 0) continue;
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.05f;     // gentle gravity
    p.life -= 0.03f;
  }
}

static void particlesDraw() {
  for (int i = 0; i < MAX_PARTICLES; ++i) {
    Particle &p = g_particles[i];
    if (p.life <= 0) continue;
    if (p.x < 0 || p.x >= TFT_W || p.y < 0 || p.y >= TFT_H) continue;
    int sz = 1 + (int)(3 * p.life);
    switch (p.kind) {
      case 0: fbDrawStar((int)p.x, (int)p.y, sz, p.color); break;
      case 1: fbDrawHeart((int)p.x, (int)p.y, sz, p.color); break;
      case 2: {
        // exclamation: vertical bar + dot
        fbVLine((int)p.x, (int)p.y - sz, sz * 2, p.color);
        fbFillCircle((int)p.x, (int)p.y + sz + 1, 1, p.color);
        break;
      }
      case 3: fbFillCircle((int)p.x, (int)p.y, sz, p.color); break;
    }
  }
}

// Render a frame and overlay particles. Use instead of renderFrame() during
// reactions that emit particles.
static void renderFrameWithParticles(const FaceState &s, uint32_t now) {
  drawFaceToBuffer(s, now);
  particlesDraw();
  flushFrame();
}

static void playReactionGlance(TouchKind k) {
  int dir = 0;
  int up = 0;
  switch (k) {
    case TOUCH_QUICK_POKE: dir = -2; up = -1; break;
    case TOUCH_HOLD:       dir =  2; up =  0; break;
    case TOUCH_LONG_HOLD:  dir =  1; up = -1; break;
    case TOUCH_TICKLE:     dir = -1; up =  1; break;
    default: break;
  }

  uint32_t start = millis();
  while (millis() - start < 110) {
    uint32_t now = millis();
    float t = (now - start) / 110.0f;
    FaceState s;
    s.mouth = FaceState::M_SMILE;
    s.smileWidth = 42;
    s.smileDip = 6;
    s.pupilDx = (int)(dir * t);
    s.pupilDy = (int)(up * t);
    renderFrameWithParticles(s, now);
    delay(18);
  }
}

// -----------------------------------------------------------------------------
// Brain glue — push-to-talk: hold to record, release to send.
//
// Flow:
//   1. pollTouch() fires TOUCH_LONG_HOLD the instant a hold crosses
//      kTalkHoldMs (~500ms) — while the finger is STILL down. askBrain()
//      then records from the mic for as long as the user keeps holding
//      (walkie-talkie style), showing the "listening" face the whole time,
//      and stops the moment they release (bounded by a ~3s max).
//   2. The captured PCM16 sits in the brain client's static request buffer;
//      BrainClient::ask() wraps it in a multipart/WAV body in place (no
//      heap) and streams the dashboard's PCM16 reply through
//      `bmo_audio_push_pcm16()`, which downsamples to 16 kHz and plays it.
//   3. Status callbacks pulse the face mood while listening / thinking /
//      talking; a tap during the reply interrupts it gracefully.
//
// If WiFi or HTTP fails we play a soft "what?" cue and animate the
// confused / sad mood briefly. Standalone behavior is still available via
// the other touch gestures.
// -----------------------------------------------------------------------------

static bmo::BrainClient g_brain;
static volatile bmo::BrainStatus g_brainStatus = bmo::BrainStatus::Idle;

static const char* brainStatusName(bmo::BrainStatus s) {
  switch (s) {
    case bmo::BrainStatus::Idle:      return "idle";
    case bmo::BrainStatus::Listening: return "listening";
    case bmo::BrainStatus::Thinking:  return "thinking";
    case bmo::BrainStatus::Talking:   return "talking";
    case bmo::BrainStatus::Error:     return "error";
  }
  return "?";
}

static void onBrainStatus(bmo::BrainStatus s) {
  g_brainStatus = s;
  Serial.printf("[brain] status: %s\n", brainStatusName(s));
  // Draw one frame immediately on every transition so the face reflects the
  // new phase right away — but ONLY when the background render task isn't
  // already driving the screen. During a brain request (g_brainFaceActive),
  // faceRenderTask owns the framebuffer and SPI; rendering here too would race
  // it and tear frames. The task picks up the new g_brainStatus on its next
  // ~30 fps tick, so the transition still shows immediately.
  if (!g_brainFaceActive) {
    renderBrainStatusFrame(millis());
  }
}

// Drives the listening / thinking / talking face moods until the brain task
// finishes. We render frames here from the foreground so the LCD never goes
// blank; status comes from the brain client's callback.
static void renderBrainStatusFrame(uint32_t now) {
  FaceState s;
  switch (g_brainStatus) {
    case bmo::BrainStatus::Listening: {
      // "Tuned-in receiver" look: X eyes + an open, alert mouth, with a light
      // datamosh glitch over the whole face so it reads like BMO is jacked
      // into a live signal. Listening marks still pulse beside the mouth.
      s.eyeShape  = FaceState::EYE_X;
      s.mouth     = FaceState::M_OPEN;
      // Mouth gently breathes open/closed while waiting for your voice.
      s.mouthOpen = 0.3f + 0.25f * (0.5f + 0.5f * sinf(now * 0.012f));
      s.shakeX    = (int)(1 * sinf(now * 0.02f));   // tiny jitter
      s.listeningMarks = true;
      s.glitchShift = 1;                            // subtle signal glitch
      break;
    }
    case bmo::BrainStatus::Thinking: {
      // "Processing" look: the mouth becomes a pulsing orb/ring that breathes,
      // eyes drift in focused thought, and a faint glitch flickers now and
      // then like cycles being burned.
      s.eyeShape   = FaceState::EYE_SQUINT;
      s.pupilDx    = (int)(2 * sinf(now * 0.002f));
      s.pupilDy    = -1;
      s.shakeY     = (int)(0.5f * sinf(now * 0.004f));
      s.pulseMouth = true;            // pulsing processing orb (replaces mouth)
      s.thinkingDots = true;          // orbiting "..." beside it
      // Occasional brief glitch burst (~every ~1.5s) for a techy stutter.
      s.glitchShift = ((now % 1500) < 160) ? 2 : 0;
      break;
    }
    case bmo::BrainStatus::Talking: {
      // REAL lip-sync: the mouth opening tracks the live audio loudness
      // envelope (g_talkLevel), updated as reply PCM is pushed to the speaker.
      // A small floor keeps the mouth alive on quiet phonemes; a touch of
      // sine adds natural micro-movement between syllables.
      float lvl = g_talkLevel;
      float micro = 0.06f * (0.5f + 0.5f * sinf(now * 0.05f));
      s.mouth     = FaceState::M_OPEN;
      s.mouthOpen = 0.08f + 0.9f * lvl + micro;
      if (s.mouthOpen > 1.0f) s.mouthOpen = 1.0f;
      s.eyeShape  = FaceState::EYE_NORMAL;
      // Mostly-open eyes with a soft, slow blink — BMO talks with its eyes open.
      const uint32_t blinkPhase = now % 2600;
      s.lidL = s.lidR = (blinkPhase < 130) ? 0.8f : 0.08f;
      // Brows/pupils lift a hair on loud syllables so the whole face emotes.
      s.pupilDy = -(int)(2.0f * lvl);
      s.pupilDx = (int)(1.0f * sinf(now * 0.006f));
      break;
    }
    default:
      s.mouth = FaceState::M_SMILE;
      break;
  }
  renderFrameWithParticles(s, now);
}

// Background render task. While g_brainFaceActive is set, this owns the screen
// during the phases where the MAIN THREAD IS BLOCKED with no cooperative hook:
// Listening (mic capture loop also renders, but this covers gaps) and Thinking
// (the multi-second blocking HTTPClient::POST(), which is exactly when the face
// used to freeze).
//
// It deliberately does NOT render during Talking. On the single-core C3, a
// full SPI framebuffer flush from this task competes with the TLS stream read
// loop for CPU and was starving the network — the reply audio cut off mid-
// sentence with an mbedTLS read error. During Talking the brain client calls
// brainShouldKeepTalking() between every audio chunk, so we render the talking
// face cooperatively from THERE instead, which never blocks the stream.
static void faceRenderTask(void* /*arg*/) {
  for (;;) {
    if (g_brainFaceActive && g_brainStatus != bmo::BrainStatus::Talking) {
      if (xSemaphoreTake(g_faceMutex, portMAX_DELAY) == pdTRUE) {
        if (g_brainFaceActive && g_brainStatus != bmo::BrainStatus::Talking) {
          renderBrainStatusFrame(millis());
        }
        xSemaphoreGive(g_faceMutex);
      }
      vTaskDelay(pdMS_TO_TICKS(40));
    } else {
      vTaskDelay(pdMS_TO_TICKS(20));
    }
  }
}

// Hand the screen to the background render task for the duration of a brain
// request, so the face stays alive while the main thread blocks on the network.
static void brainFaceStart() {
  g_brainFaceActive = true;
}

// Reclaim the screen for the main thread. Draining the mutex guarantees the
// task has finished any in-flight frame before foreground code (interrupt /
// error faces) draws again, so there's no torn frame at the handoff.
static void brainFaceStop() {
  g_brainFaceActive = false;
  if (g_faceMutex) {
    xSemaphoreTake(g_faceMutex, portMAX_DELAY);
    xSemaphoreGive(g_faceMutex);
  }
}

// -----------------------------------------------------------------------------
// Mic self-test (record → playback). Triggered by the TICKLE gesture (3 rapid
// taps). Records ~1.5s on the LEFT slot, then ~1.5s on the RIGHT slot, prints
// the peak amplitude of each so we can SEE which channel the INMP441 lands on,
// then plays the louder capture back through the speaker so you can HEAR it.
//
// This is the isolation test for the "empty transcript / all -1 samples"
// problem: if BOTH channels read silent, it's wiring/power; if one channel has
// real signal, we lock the capture to that channel.
// -----------------------------------------------------------------------------
static int32_t micTestPeak(const int16_t* pcm, size_t n) {
  int32_t peak = 0;
  for (size_t k = 0; k < n; ++k) {
    int32_t a = pcm[k];
    if (a < 0) a = -a;
    if (a > peak) peak = a;
  }
  return peak;
}

static void micRecordPlaybackTest() {
  int16_t* pcm = bmo::BrainClient::requestPcmBuffer();
  const size_t cap = bmo::BrainClient::requestPcmCapacitySamples();
  const size_t want = cap < 24000 ? cap : 24000;   // ~1.5s @ 16kHz

  Serial.println("[mictest] === record/playback self-test ===");
  Serial.println("[mictest] SPEAK NOW (left-channel capture)...");

  // ---- LEFT channel ----
  bmo::micSetChannel(false);
  delay(40);
  size_t gotL = 0;
  uint32_t t0 = millis();
  while (gotL < want && (millis() - t0) < 1600) {
    size_t batch = want - gotL; if (batch > 1024) batch = 1024;
    gotL += bmo::micCapture(pcm + gotL, batch, nullptr);
  }
  int32_t peakL = micTestPeak(pcm, gotL);
  Serial.printf("[mictest] LEFT: %u samples, peak=%ld\n",
                (unsigned)gotL, (long)peakL);

  // Stash left capture's peak, then record RIGHT into the same buffer. We only
  // need the peaks to decide; we replay whichever channel we end on if louder.
  // ---- RIGHT channel ----
  Serial.println("[mictest] SPEAK AGAIN (right-channel capture)...");
  bmo::micSetChannel(true);
  delay(40);
  size_t gotR = 0;
  t0 = millis();
  while (gotR < want && (millis() - t0) < 1600) {
    size_t batch = want - gotR; if (batch > 1024) batch = 1024;
    gotR += bmo::micCapture(pcm + gotR, batch, nullptr);
  }
  int32_t peakR = micTestPeak(pcm, gotR);
  Serial.printf("[mictest] RIGHT: %u samples, peak=%ld\n",
                (unsigned)gotR, (long)peakR);

  // The RIGHT capture currently lives in the buffer. Play it back so you can
  // hear it. (If LEFT was the louder one we still demo RIGHT here, but the
  // serial peaks tell the real story; we lock the winning channel below.)
  Serial.println("[mictest] playing back RIGHT capture...");
  size_t i = 0;
  while (i < gotR) {
    size_t n = gotR - i; if (n > 256) n = 256;
    static int16_t out[256];
    for (size_t k = 0; k < n; ++k) {
      float f = (pcm[i + k] / 32768.0f) * g_volume * 3.0f;  // boost for audibility
      if (f > 1.0f) f = 1.0f; else if (f < -1.0f) f = -1.0f;
      out[k] = (int16_t)(f * 32767.0f);
    }
    size_t written = 0;
    i2s_write(AUDIO_I2S_PORT, out, n * sizeof(int16_t), &written, portMAX_DELAY);
    i += n;
  }

  // Lock capture to whichever channel had the stronger signal for normal use.
  const bool useRight = peakR >= peakL;
  bmo::micSetChannel(useRight);
  Serial.printf("[mictest] === done. peakL=%ld peakR=%ld -> locking %s ===\n",
                (long)peakL, (long)peakR, useRight ? "RIGHT" : "LEFT");
}

static void askBrain() {
  // Stage 0: PUSH-TO-TALK capture. We record for as long as the user keeps
  // holding the button (walkie-talkie style), showing the listening face the
  // whole time, and send the moment they release. This is invoked from
  // pollTouch() the instant the hold crosses kTalkHoldMs — i.e. while the
  // finger is STILL down — so the capture window matches the physical hold.
  g_brainStatus = bmo::BrainStatus::Listening;

  // Capture mic PCM DIRECTLY into the brain client's static request buffer.
  // No separate mic buffer, no WAV copy, no body malloc — the brain client
  // assembles the multipart body in place around this PCM region.
  int16_t* pcm = bmo::BrainClient::requestPcmBuffer();
  const size_t pcmCapacity = bmo::BrainClient::requestPcmCapacitySamples();
  const uint32_t captureStart = millis();
  size_t samples = 0;

  // Record while the button is held, bounded by the buffer (~3s) and a hard
  // max so a stuck button can't hang. Stop early when the user releases —
  // but require a short minimum so the initial press debounce doesn't end the
  // capture before it starts.
  constexpr uint32_t kMinCaptureMs = 300;
  constexpr uint32_t kMaxCaptureMs = 2000;  // matches kMicCaptureSamples (2s @ 16kHz)
  while (samples < pcmCapacity) {
    const uint32_t elapsed = millis() - captureStart;
    if (elapsed >= kMaxCaptureMs) break;
    // Released after the minimum hold → user is done talking, send it.
    if (elapsed >= kMinCaptureMs && !touchIsDown()) break;

    const size_t cap = pcmCapacity - samples;
    const size_t batch = cap < 1024 ? cap : 1024;
    const size_t got = bmo::micCapture(pcm + samples, batch, nullptr);
    samples += got;
    renderBrainStatusFrame(millis());
    if (got == 0) break;
  }
  Serial.printf("[brain] captured %u samples (%lums held)\n",
                static_cast<unsigned>(samples),
                static_cast<unsigned long>(millis() - captureStart));

  // Mic amplitude diagnostic + AUTO-GAIN. The INMP441 captures quite quietly
  // (peak ~800/32767 ≈ 2.5% at normal speaking distance), and STT drops the
  // quieter trailing words ("...melon apa") while catching the louder leading
  // ones ("saya tanya warna..."). So after measuring the peak we normalize the
  // whole capture up so the loudest sample hits ~70% full scale. This makes
  // every word clearly audible to STT without the clipping that a fixed large
  // gain would cause on loud input.
  if (samples > 0) {
    int32_t peak = 0;
    int64_t sumSq = 0;
    for (size_t k = 0; k < samples; ++k) {
      int32_t a = pcm[k];
      if (a < 0) a = -a;
      if (a > peak) peak = a;
      sumSq += (int64_t)pcm[k] * pcm[k];
    }
    const int rms = (int)sqrtf((float)(sumSq / (int64_t)samples));
    Serial.printf("[mic] peak=%ld rms=%d first=[%d %d %d %d %d %d %d %d]\n",
                  (long)peak, rms,
                  pcm[0], pcm[1], pcm[2], pcm[3],
                  pcm[4], pcm[5], pcm[6], pcm[7]);

    // Auto-gain toward a target peak of ~22000 (≈67% FS). The INMP441 on this
    // board captures very quietly (peak often 400–800 ≈ 1–2% FS), so the gain
    // needed is large — allow up to 48x. This is what lets STT hear the quiet
    // trailing words. We only ever boost; we never attenuate a loud capture.
    if (peak > 4) {
      constexpr int32_t kTargetPeak = 22000;
      float gain = (float)kTargetPeak / (float)peak;
      if (gain > 48.0f) gain = 48.0f;   // generous ceiling for a quiet mic
      if (gain > 1.0f) {
        for (size_t k = 0; k < samples; ++k) {
          int32_t v = (int32_t)(pcm[k] * gain);
          if (v > 32767) v = 32767;
          else if (v < -32768) v = -32768;
          pcm[k] = (int16_t)v;
        }
        Serial.printf("[mic] applied gain x%.1f (peak %ld -> ~%ld)\n",
                      gain, (long)peak, (long)(peak * gain));
      }
    }
  }

  if (samples < 4000) {
    // <250ms of audio; treat as cancellation (a too-brief hold), don't send.
    Serial.println("[brain] capture too short, skipping");
    g_brainStatus = bmo::BrainStatus::Idle;
    return;
  }

  // Stage 1+: brain client assembles the body in place and takes over,
  // emitting Thinking → Talking → Idle. No malloc/free here anymore.
  //
  // ask() blocks the main thread for several seconds (DNS/TLS, the POST,
  // streaming). Hand the screen to the background render task for that whole
  // window so the listening / thinking / talking face keeps animating instead
  // of freezing on a single frame during the blocking POST.
  g_talkInterrupted = false;
  brainFaceStart();
  const bool ok = g_brain.ask(samples);
  brainFaceStop();

  // Graceful user interrupt: BMO was talking and got tapped. Acknowledge with
  // a short happy cue + warm face so it feels like "oh! okay!" rather than a
  // glitch. ask() returned true (clean stop), so we land here, not the error
  // branch below.
  if (g_talkInterrupted) {
    Serial.println("[brain] reply interrupted — playing acknowledgement");
    g_talkInterrupted = false;
    playClipOrSynth("bmo_ok", playBmoStartled);
    const uint32_t ackStart = millis();
    while (millis() - ackStart < 600) {
      FaceState s;
      s.eyeShape = FaceState::EYE_CRESCENT;
      s.mouth = FaceState::M_SMILE;
      s.lidL = s.lidR = 0.2f;
      renderFrameWithParticles(s, millis());
      delay(28);
    }
    g_brainStatus = bmo::BrainStatus::Idle;
    return;
  }

  if (!ok) {
    Serial.println("[brain] ask() failed; playing fallback");
    g_brainStatus = bmo::BrainStatus::Error;
    playClipOrSynth("bmo_what", playBmoStartled);
    // Brief sad/confused face so the user knows it didn't work.
    const uint32_t errStart = millis();
    while (millis() - errStart < 700) {
      FaceState s;
      s.mouth = FaceState::M_FROWN;
      s.smileWidth = 36;
      s.smileDip = 4;
      s.lidL = s.lidR = 0.6f;
      renderFrameWithParticles(s, millis());
      delay(28);
    }
  }
  g_brainStatus = bmo::BrainStatus::Idle;
}

// Fires a spontaneous "random thought": asks the dashboard to generate, store,
// and speak one short musing, then plays it through the speaker. Reuses the
// brain client's status callbacks + interrupt predicate, and the same
// background face-render handoff as askBrain() so the thinking/talking face
// animates while the main thread blocks on the network. Returns quietly on a
// 204 (BMO chose not to think) or any failure — an idle thought is never an
// error the child should see.
static void maybeThinkAloud() {
  Serial.println("[brain] idle thought trigger (touch threshold reached)");
  g_brainStatus = bmo::BrainStatus::Thinking;
  g_talkInterrupted = false;
  brainFaceStart();
  const bool ok = g_brain.requestThought();
  brainFaceStop();

  // If the child interrupted the musing, give the same soft "okay!" cue +
  // happy face that an interrupted reply gets, so it feels intentional.
  if (g_talkInterrupted) {
    playClipOrSynth("bmo_ok", playBmoStartled);
    const uint32_t ackStart = millis();
    while (millis() - ackStart < 500) {
      uint32_t now = millis();
      FaceState s;
      s.eyeShape = FaceState::EYE_CRESCENT;
      s.mouth = FaceState::M_SMILE;
      renderFrameWithParticles(s, now);
      delay(28);
    }
  }
  g_brainStatus = bmo::BrainStatus::Idle;
  (void)ok;  // failures stay silent; nothing to surface to the child
}

static void playReaction(TouchKind k) {
  Serial.printf("touch: %s\n", touchKindName(k));
  particlesClear();

  // -------- LONG_HOLD: push-to-talk → dashboard brain ----------------------
  // Skip the glance animation here: this fires the instant the hold crosses
  // the talk threshold (finger still down), so we want to start capturing
  // immediately and not clip the first word behind a 110ms glance.
  if (k == TOUCH_LONG_HOLD) {
    askBrain();
    particlesClear();
    return;
  }

  // Non-talk reactions get the quick glance toward the touch point.
  playReactionGlance(k);

  switch (k) {

    // ─────────────────────────────────────────────────────────────────────
    // QUICK POKE
    // anticipation (compress) → recoil up + gasp →
    // dart eyes seeking culprit → relief blink → nervous smile + faint blush
    // ─────────────────────────────────────────────────────────────────────
    case TOUCH_QUICK_POKE: {
      // Voice: rotating generic BMO greeting (e.g. "oh, hi you!") if any
      // greeting clips are baked, otherwise the startled synth chirp.
      playGreeting(playBmoStartled);
      // Phase A — squash 80ms (anticipation)
      uint32_t pA = millis();
      while (millis() - pA < 80) {
        uint32_t now = millis();
        float t = (now - pA) / 80.0f;
        FaceState s;
        s.mouth = FaceState::M_FLAT;
        s.lidL = s.lidR = 0.2f - 0.2f * t;
        s.shakeY = (int)(2 * t);            // compress down
        renderFrameWithParticles(s, now);
        delay(15);
      }
      // Phase B — recoil 200ms (gasp, no center marker)
      uint32_t pB = millis();
      while (millis() - pB < 220) {
        uint32_t now = millis();
        float t = (now - pB) / 220.0f;
        float ease = 1.0f - (1.0f - t) * (1.0f - t);
        FaceState s;
        s.mouth = FaceState::M_OH;
        s.lidL = s.lidR = 0;
        s.shakeY = -(int)(8 * (1 - ease));   // launch up
        s.shakeX = (int)(2 * sinf(now * 0.05f));
        s.pupilDy = -2;
        particlesStep();
        renderFrameWithParticles(s, now);
        delay(18);
      }
      // Phase C — dart 600ms with secondary bobbing + tracking eyes
      uint32_t pC = millis();
      while (millis() - pC < 600) {
        uint32_t now = millis();
        FaceState s;
        s.mouth = FaceState::M_OH;
        s.lidL = s.lidR = 0;
        // pupils chase a target that snaps left, then right, then center
        float ph = (now - pC) / 200.0f;
        if (ph < 1)      { s.pupilDx = -3; }
        else if (ph < 2) { s.pupilDx =  3; }
        else             { s.pupilDx =  0; }
        s.pupilDy = (int)(sinf(now * 0.02f));
        // body wobbles down/up after recoil (settle)
        s.shakeY = (int)(2 * cosf(now * 0.02f));
        particlesStep();
        renderFrameWithParticles(s, now);
        delay(20);
      }
      // Phase D — relief blink + nervous smile 700ms
      playTone(1000, 60, 0.6f);
      uint32_t pD = millis();
      while (millis() - pD < 700) {
        uint32_t now = millis();
        float t = (now - pD) / 700.0f;
        FaceState s;
        s.mouth = FaceState::M_SMILE;
        // double-blink in first half
        if (t < 0.15f)      s.lidL = s.lidR = 1.0f;
        else if (t < 0.30f) s.lidL = s.lidR = 0.2f;
        else if (t < 0.42f) s.lidL = s.lidR = 1.0f;
        else                s.lidL = s.lidR = 0.2f;
        s.blush = 0.5f * t;
        s.shakeY = (int)(1 * sinf(now * 0.008f));   // soft breathing
        renderFrameWithParticles(s, now);
        delay(25);
      }
      break;
    }

    // ─────────────────────────────────────────────────────────────────────
    // HOLD ("pet")
    // glance → bashful BMO smile → contented purr with small sway + occasional
    // pink cheek puffs. Eyes track toward touch on entry.
    // ─────────────────────────────────────────────────────────────────────
    case TOUCH_HOLD: {
      // Voice: rotating generic BMO greeting if any greeting clips are baked,
      // otherwise the synth "hi" warble.
      playGreeting(playBmoHi);
      // Phase A — glance 220ms: pupils swing toward touch (right), eyes squint happy
      uint32_t pA = millis();
      while (millis() - pA < 220) {
        uint32_t now = millis();
        float t = (now - pA) / 220.0f;
        FaceState s;
        s.mouth = FaceState::M_SMILE;
        s.lidL = s.lidR = 0.2f * t;
        s.pupilDx = (int)(3 * t);
        s.blush = 0.3f * t;
        renderFrameWithParticles(s, now);
        delay(20);
      }
      playClipOrSynth("bmo_sigh", playBmoSigh);
      // Phase B — relax 800ms: eyes close to crescents, mouth opens slightly,
      // blush blooms, body sways
      uint32_t pB = millis();
      while (millis() - pB < 800) {
        uint32_t now = millis();
        float t = (now - pB) / 800.0f;
        FaceState s;
        s.eyeShape = FaceState::EYE_CRESCENT;
        s.mouth = FaceState::M_SMILE;
        s.smileWidth = 38 + (int)(4 * t);
        s.smileDip = 6 + (int)(2 * t);
        s.blush = 0.25f + 0.4f * t;
        s.pupilDx = 3 - (int)(3 * t);
        s.shakeX = (int)(1 * sinf(now * 0.005f));
        renderFrameWithParticles(s, now);
        delay(22);
      }
      // Phase C — purr 1500ms: looped breathing animation, ambient pink dot
      // particles drift upward off the cheeks every ~420ms
      uint32_t pC = millis();
      uint32_t lastPuff = 0;
      while (millis() - pC < 1500) {
        uint32_t now = millis();
        if (now - lastPuff > 420) {
          particlesEmit(1, 34,         66, 3, C_BLUSH);
          particlesEmit(1, TFT_W - 34, 66, 3, C_BLUSH);
          lastPuff = now;
        }
        FaceState s;
        s.eyeShape = FaceState::EYE_CRESCENT;
        s.mouth = FaceState::M_SMILE;
        s.smileWidth = 40 + (int)(2 * sinf(now * 0.006f));
        s.smileDip = 7;
        s.blush = 0.65f;
        s.shakeX = (int)(1 * sinf(now * 0.004f));
        s.shakeY = (int)(1 * sinf(now * 0.006f));
        particlesStep();
        renderFrameWithParticles(s, now);
        delay(28);
        pollTouch();
        if (g_touchPending) goto reactionDone;
      }
      break;
    }

    // ─────────────────────────────────────────────────────────────────────
    // LONG HOLD ("deep affection")
    // bashful BMO pet phase → tiny heart pop → shy smile. Keep it sweet,
    // not a full anime affection storm.
    // ─────────────────────────────────────────────────────────────────────
    case TOUCH_LONG_HOLD: {
      // Voice: clip "bmo_chant" if available, otherwise synth
      playClipOrSynth("bmo_chant", playBmoChant);
      // Phase A — pet (1000ms): same shape as HOLD's start
      uint32_t pA = millis();
      while (millis() - pA < 1000) {
        uint32_t now = millis();
        float t = (now - pA) / 1000.0f;
        FaceState s;
        s.eyeShape = FaceState::EYE_CRESCENT;
        s.mouth = FaceState::M_SMILE;
        s.smileWidth = 38 + (int)(5 * t);
        s.smileDip = 6 + (int)(2 * t);
        s.blush = 0.35f + 0.35f * t;
        s.shakeX = (int)(1 * sinf(now * 0.005f));
        renderFrameWithParticles(s, now);
        delay(25);
      }
      // Phase B — swell (700ms): mouth widens, eyes start opening, body slowly
      // rises — anticipation before the heart transformation
      playClipOrSynth("bmo_hooray", playBmoHooray);
      uint32_t pB = millis();
      while (millis() - pB < 700) {
        uint32_t now = millis();
        float t = (now - pB) / 700.0f;
        float ease = t * t;
        FaceState s;
        s.eyeShape = FaceState::EYE_CRESCENT;
        s.mouth = FaceState::M_SMILE;
        s.smileWidth = 42 + (int)(4 * sinf(now * 0.012f));
        s.smileDip = 7;
        s.blush = 0.7f;
        s.shakeY = -(int)(2 * ease);
        renderFrameWithParticles(s, now);
        delay(28);
      }
      // Phase C — sting + heart burst (250ms): a big musical chord, a circle
      // of hearts erupts outward from BMO's chest area
      playClipOrSynth("bmo_games", playBmoGames);
      particlesEmit(4, MOUTH_CX, MOUTH_Y - 5, 1, C_HEART);
      uint32_t pC = millis();
      while (millis() - pC < 250) {
        uint32_t now = millis();
        FaceState s;
        s.mouth = FaceState::M_OH;
        s.lidL = s.lidR = 0;
        s.shakeY = -3;
        particlesStep();
        renderFrameWithParticles(s, now);
        delay(20);
      }
      // Phase D — bashful hold (1700ms): brief heart eyes, then shy crescent
      // eyes with sparse hearts and a tiny body bob.
      uint32_t pD = millis();
      uint32_t lastHeart = 0;
      while (millis() - pD < 1700) {
        uint32_t now = millis();
        float t = (now - pD) / 1700.0f;
        if (now - lastHeart > 650) {
          particlesEmit(1, 30 + ((int)(now / 100) % 6), 88, 1, C_HEART);
          particlesEmit(1, TFT_W - 30 - ((int)(now / 100) % 6), 88, 1, C_HEART);
          lastHeart = now;
        }
        FaceState s;
        s.eyeShape = (t < 0.35f) ? FaceState::EYE_HEART : FaceState::EYE_CRESCENT;
        s.mouth = FaceState::M_SMILE;
        s.smileWidth = 40 + (int)(3 * sinf(now * 0.008f));
        s.smileDip = 7;
        s.blush = 0.75f;
        s.shakeY = -(int)(1 + 1.0f * sinf(now * 0.008f));
        particlesStep();
        renderFrameWithParticles(s, now);
        delay(28);
        pollTouch();
        if (g_touchPending) goto reactionDone;
      }
      break;
    }

    // ─────────────────────────────────────────────────────────────────────
    // TICKLE
    // shake into helpless laughter, scattering star confetti, mouth
    // rapidly opens/closes, eyes squeeze tighter at intensity peaks,
    // pupils spin up briefly then settle into closed crescents
    // ─────────────────────────────────────────────────────────────────────
    case TOUCH_TICKLE: {
      // DIAGNOSTIC: 3 rapid taps run the mic record/playback self-test. This
      // records both I2S channels, prints their peak levels, and plays the
      // capture back so we can tell whether the mic is wired/working and which
      // channel slot carries its data. Remove once the mic is confirmed good.
      micRecordPlaybackTest();
      // Voice: clip "bmo_laugh" if available, otherwise synth
      playClipOrSynth("bmo_laugh", playBmoLaugh);
      // Phase A — burst of giggles (350ms): sharp high "ha!"
      particlesEmit(4, MOUTH_CX, MOUTH_Y - 20, 0, C_STAR);
      uint32_t pA = millis();
      while (millis() - pA < 350) {
        uint32_t now = millis();
        FaceState s;
        s.eyeShape = FaceState::EYE_CRESCENT;
        s.lidL = s.lidR = 0.4f + 0.2f * sinf(now * 0.04f);
        s.mouth = FaceState::M_LAUGH;
        s.mouthOpen = 0.9f;
        s.blush = 1.0f;
        s.shakeX = (int)(4 * sinf(now * 0.04f));
        s.shakeY = (int)(3 * fabsf(sinf(now * 0.04f)));
        particlesStep();
        renderFrameWithParticles(s, now);
        delay(20);
      }
      // Phase B — sustained laughter (1900ms): bouncing, stars sprinkle on
      // each peak, "haha" beeps scheduled when mouth is most open
      static const float beeps[] = {880, 1175, 988, 1318, 988, 1175};
      uint8_t bi = 0;
      uint32_t lastBeep = 0;
      uint32_t lastStar = 0;
      uint32_t pB = millis();
      while (millis() - pB < 1900) {
        uint32_t now = millis();
        // Trigger beeps at the moments when sin(now*0.03) crosses peak
        float wave = sinf(now * 0.025f);
        if (wave > 0.85f && now - lastBeep > 160) {
          playTone(beeps[bi % 6], 60, 1.1f);
          bi++;
          lastBeep = now;
        }
        if (wave > 0.75f && now - lastStar > 220) {
          particlesEmit(1, 20 + (rand() % 120), 30 + (rand() % 30), 0, C_STAR);
          lastStar = now;
        }
        FaceState s;
        s.eyeShape = FaceState::EYE_CRESCENT;
        // squeezed shut crescents that vary with intensity
        s.lidL = s.lidR = 0.55f + 0.15f * fabsf(wave);
        s.mouth = FaceState::M_LAUGH;
        s.mouthOpen = 0.6f + 0.4f * fabsf(wave);
        s.blush = 1.0f;
        // big bouncy shake with secondary motion
        s.shakeX = (int)(4 * sinf(now * 0.03f));
        s.shakeY = (int)(3 * fabsf(sinf(now * 0.03f)));
        particlesStep();
        renderFrameWithParticles(s, now);
        delay(22);
        pollTouch();
        if (g_touchPending) goto reactionDone;
      }
      // Phase C — exhausted slump (300ms): body sags, mouth stays open in a tired smile
      uint32_t pC = millis();
      while (millis() - pC < 300) {
        uint32_t now = millis();
        float t = (now - pC) / 300.0f;
        FaceState s;
        s.eyeShape = FaceState::EYE_CRESCENT;
        s.lidL = s.lidR = 0.55f + 0.15f * (1 - t);
        s.mouth = FaceState::M_OPEN;
        s.mouthOpen = 0.4f - 0.3f * t;
        s.blush = 1.0f;
        s.shakeY = (int)(1 * t);            // settles down
        particlesStep();
        renderFrameWithParticles(s, now);
        delay(25);
      }
      break;
    }

    default: break;
  }

reactionDone:
  // Settle 250ms with content smile + slow blink + dwindling particles
  uint32_t settleStart = millis();
  while (millis() - settleStart < 250) {
    uint32_t now = millis();
    float t = (now - settleStart) / 250.0f;
    FaceState s;
    s.eyeShape = FaceState::EYE_CRESCENT;
    s.mouth = FaceState::M_SMILE;
    s.lidL = s.lidR = 0.2f + 0.05f * sinf(now * 0.01f);
    s.blush = 0.3f + 0.2f * (1 - t);
    particlesStep();
    renderFrameWithParticles(s, now);
    delay(28);
  }
  particlesClear();
}
void setup() {
  pinMode(PIN_CS,  OUTPUT);
  pinMode(PIN_DC,  OUTPUT);
  pinMode(PIN_RST, OUTPUT);
  digitalWrite(PIN_CS, HIGH);
  digitalWrite(PIN_DC, HIGH);
  digitalWrite(PIN_RST, HIGH);

  // INPUT_PULLDOWN, not bare INPUT. With a bare INPUT the line floats whenever
  // the TTP223 isn't actively driving it, and a floating C3 input drifts/
  // oscillates LOW↔HIGH on its own — which pollTouch() reads as an endless
  // stream of phantom press/release events (the "keeps looping like it's
  // touched" bug). The internal pulldown parks the line at a solid LOW when
  // idle; the TTP223 still drives a strong HIGH on real contact and overrides
  // it easily, so genuine touches register while phantoms can't. Same pin
  // (GP20) — this only turns on the chip's internal resistor.
  pinMode(PIN_TOUCH, INPUT_PULLDOWN);

  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println("BMO extended-expressions boot");

  tftSPI.begin(PIN_SCK, -1, PIN_SDA, -1);
  tftSPI.setHwCs(false);
  tftInit();

  fbFill(C_BG);
  flushFrame();

  // Background face render task: keeps the brain-status face animating while
  // the main thread is blocked on the network during a request (see
  // faceRenderTask / brainFaceStart / brainFaceStop). The C3 is single-core,
  // but the main thread yields to the scheduler whenever it blocks on I/O, so
  // this task naturally fills those gaps. g_faceMutex serializes fb + SPI
  // access between the two so they never draw at the same time.
  g_faceMutex = xSemaphoreCreateMutex();
  xTaskCreate(faceRenderTask, "faceRender", 4096, nullptr, 1, &g_faceTaskHandle);

  audioInit();
  Serial.println("audio ready");

  // Mic init shares the I2S unit with the speaker but on the second port.
  if (bmo::micBegin()) {
    Serial.println("mic ready");
  } else {
    Serial.println("mic init failed; long-hold-to-ask will not work");
  }

  // ── MIC SELF-TEST ────────────────────────────────────────────────────────
  // On-demand via the TICKLE gesture (3 rapid taps), not at boot — boot timing
  // made it hard to catch on the serial monitor. See micRecordPlaybackTest()
  // wired into the TOUCH_TICKLE case.

  // ── Provisioning ───────────────────────────────────────────────────────
  // If the user is holding the touch button while we boot, treat that as a
  // factory-reset gesture: wipe NVS so the captive portal opens fresh.
  //
  // Require the line to read HIGH continuously for ~1.5s before honouring it.
  // A single instantaneous read on this line can glitch HIGH from electrical
  // noise, and a phantom hit here would wipe the user's saved WiFi/dashboard
  // creds — destructive. A sustained hold can't be faked by a brief glitch.
  bool resetGesture = false;
  if (digitalRead(PIN_TOUCH) == HIGH) {
    const uint32_t holdStart = millis();
    resetGesture = true;
    while (millis() - holdStart < 1500) {
      if (digitalRead(PIN_TOUCH) != HIGH) { resetGesture = false; break; }
      delay(10);
    }
  }
  if (resetGesture) {
    Serial.println("[boot] factory reset gesture detected — clearing creds");
    bmo::g_provisioning.clear();
    // Show a brief "RESET" face so the user knows the gesture was honoured.
    fbFill(C_BG);
    flushFrame();
    delay(600);
  }

  // While the portal blocks for credentials, drive a "setup mode" face so
  // the screen isn't dead. The lambda is called ~50 Hz from inside the
  // portal loop. Curious / questioning eyes plus a faintly glowing antenna
  // line communicate "I'm waiting on the network."
  auto renderSetupFace = []() {
    const uint32_t now = millis();
    FaceState s;
    s.eyeShape = FaceState::EYE_NORMAL;
    s.mouth    = FaceState::M_OH;
    // Slow blink every ~3s.
    const uint32_t blinkPhase = now % 3000;
    s.lidL = s.lidR = (blinkPhase < 180) ? 0.85f : 0.05f;
    // Eyes drift left/right like searching.
    s.pupilDx = (int)(2 * sinf(now * 0.0018f));
    s.pupilDy = (int)(1 * cosf(now * 0.0014f));
    s.shakeX  = (int)(1 * sinf(now * 0.0009f));
    drawFaceToBuffer(s, now);
    fbDrawListeningMarks(now);
    flushFrame();
  };

  // Try saved creds, then fall back to the captive portal. This *blocks* on
  // first run until the user submits the form on their phone — the lambda
  // above keeps the face alive during the wait.
  Serial.println("[boot] starting provisioning...");
  const bool wifiUp = bmo::g_provisioning.ensureProvisionedAndConnected(
      /*portalTimeoutSeconds=*/600,
      renderSetupFace);
  if (!wifiUp) {
    Serial.println("[boot] portal timed out; brain features disabled");
  } else {
    Serial.printf("[boot] dashboard=%s\n",
                  bmo::g_provisioning.dashboardUrl().c_str());
  }

  // Brain client uses the URL we just got; status callback drives the
  // listening / thinking / talking face moods.
  g_brain.onStatus(onBrainStatus);
  g_brain.onShouldKeepTalking(brainShouldKeepTalking);
  g_brain.setDashboardUrl(bmo::g_provisioning.dashboardUrl());
  if (wifiUp) {
    g_brain.markWifiReady();
    g_brain.begin();
  }
}

void loop() {
  struct Scene { Mood m; uint32_t ms; };
  static const Scene script[] = {
    { MOOD_IDLE,     2000 },
    { MOOD_BLINK,     200 },
    { MOOD_HAPPY,    1800 },
    { MOOD_LAUGH,    1800 },
    { MOOD_WINK,     1400 },
    { MOOD_LOVE,     2000 },
    { MOOD_TALK,     1800 },
    { MOOD_LISTEN,   1600 },
    { MOOD_THINKING, 1800 },
    { MOOD_FOCUSED,  1800 },
    { MOOD_SURPRISE, 1100 },
    { MOOD_EXCITED,  1800 },
    { MOOD_SCARED,   1800 },
    { MOOD_HUNGRY,   1800 },
    { MOOD_HOT,      2000 },
    { MOOD_COLD,     2000 },
    { MOOD_SICK,     2000 },
    { MOOD_DIZZY,    1800 },
    { MOOD_GLITCH,    900 },
    { MOOD_CONFUSED, 2000 },
    { MOOD_BORED,    2000 },
    { MOOD_SAD,      2000 },
    { MOOD_ANGRY,    1600 },
    { MOOD_COOL,     2000 },
    { MOOD_WAKE,     1800 },
    { MOOD_SLEEPY,   2200 },
  };

  for (const auto &sc : script) {
    // Top-of-scene check: if a touch is pending, react immediately.
    if (g_touchPending) {
      g_touchPending = false;
      const TouchKind kind = g_pendingKind;
      playReaction(kind);
      countTouchForThought(kind);
      // Run a couple more reactions if user keeps touching (chain)
      while (g_touchPending) {
        g_touchPending = false;
        const TouchKind chained = g_pendingKind;
        playReaction(chained);
        countTouchForThought(chained);
      }
      // After the interaction settles, BMO may muse aloud if it's been played
      // with enough times (see countTouchForThought / kTouchesPerThought).
      if (g_thoughtDue) {
        g_thoughtDue = false;
        maybeThinkAloud();
      }
    }
    playMood(sc.m, sc.ms);
  }
}
