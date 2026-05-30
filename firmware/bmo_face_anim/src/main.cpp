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
#include "audio_clips.h"
#include "bmo_brain_client.h"
#include "bmo_mic.h"
#include "bmo_provisioning.h"
#include "bmo_wav.h"

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

// Sunglasses bar across both eyes.
static void fbDrawShades(int leftCx, int rightCx, int cy) {
  int half = (rightCx - leftCx) / 2;
  int left = leftCx - 12;
  int right = rightCx + 12;
  // bridge
  fbHLine(leftCx + 8, cy, rightCx - leftCx - 16, C_INK);
  // lenses
  fbFillRoundRect(left,  cy - 6, 24, 12, 5, C_INK);
  fbFillRoundRect(rightCx - 12, cy - 6, 24, 12, 5, C_INK);
  // shine on lens
  fbFillRoundRect(left + 4, cy - 4, 5, 2, 1, C_SHINE);
  fbFillRoundRect(rightCx - 8, cy - 4, 5, 2, 1, C_SHINE);
  (void)half; (void)right;
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
static volatile float g_volume = 0.234f;  // bumped +30% from 0.18

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

extern "C" void bmo_audio_push_pcm16(const uint8_t* data, size_t len) {
  if (data == nullptr || len < 2) return;
  // 24 → 16 kHz downsample by dropping 1 of every 3 input samples.
  static uint8_t leftoverByte = 0;
  static bool hasLeftover = false;
  static uint8_t skipPhase = 0;  // 0,1,2 — skip when phase == 2.

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
      size_t written = 0;
      i2s_write(AUDIO_I2S_PORT, batch, batchN * sizeof(int16_t), &written,
                portMAX_DELAY);
      batchN = 0;
    }
  }

  if (batchN > 0) {
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
    size_t written;
    i2s_write(AUDIO_I2S_PORT, chunk, n * sizeof(int16_t), &written,
              portMAX_DELAY);
  }
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
static void pollTouch() {
  static bool wasDown = false;
  static uint32_t pressStart = 0;
  bool isDown = digitalRead(PIN_TOUCH) == HIGH;

  if (isDown && !wasDown) {
    // press began
    pressStart = millis();
    s_recentPressMs[s_pressIdx % 8] = pressStart;
    s_pressIdx++;
  } else if (!isDown && wasDown) {
    // release: classify by hold duration + recent press count
    uint32_t held = millis() - pressStart;
    int taps = recentPressesWithin(900);
    TouchKind kind;
    if (taps >= 3 && held < 250) {
      kind = TOUCH_TICKLE;
    } else if (held < 250) {
      kind = TOUCH_QUICK_POKE;
    } else if (held < 1500) {
      kind = TOUCH_HOLD;
    } else {
      kind = TOUCH_LONG_HOLD;
    }
    g_pendingKind = kind;
    g_touchPending = true;
  }
  wasDown = isDown;
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
// Brain glue — long-hold gesture captures audio and asks the dashboard.
//
// Flow:
//   1. We've already played `playReactionGlance(TOUCH_LONG_HOLD)` and are now
//      animating a "listening" face while we capture from the mic. The user
//      just *stopped* holding (that's how the gesture is detected), so we
//      give them ~3 s of speech room; capture continues until either the
//      buffer fills or the timeout hits.
//   2. Wrap the captured PCM16 in a RIFF/WAVE header in-place, then call
//      BrainClient::ask(). The client streams the dashboard's PCM16 reply
//      through `bmo_audio_push_pcm16()` (defined above), which downsamples
//      to 16 kHz and writes to the speaker.
//   3. Status callbacks pulse the face mood while listening / thinking /
//      talking, then we return to the main mood loop.
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
}

// Drives the listening / thinking / talking face moods until the brain task
// finishes. We render frames here from the foreground so the LCD never goes
// blank; status comes from the brain client's callback.
static void renderBrainStatusFrame(uint32_t now) {
  FaceState s;
  switch (g_brainStatus) {
    case bmo::BrainStatus::Listening: {
      s.eyeShape  = FaceState::EYE_NORMAL;
      s.mouth     = FaceState::M_FLAT;
      s.lidL      = s.lidR = 0.05f + 0.05f * sinf(now * 0.01f);
      // gentle eye sway
      s.pupilDx   = (int)(1.5f * sinf(now * 0.004f));
      // ear-cupped pose: tiny tilt
      s.shakeX    = (int)(1 * sinf(now * 0.003f));
      fbDrawListeningMarks(now);
      break;
    }
    case bmo::BrainStatus::Thinking: {
      s.eyeShape = FaceState::EYE_NORMAL;
      s.mouth    = FaceState::M_FLAT;
      s.pupilDx  = (int)(2 * sinf(now * 0.002f));
      s.pupilDy  = -1;
      s.shakeY   = (int)(0.5f * sinf(now * 0.003f));
      fbDrawThinkingDots(now);
      break;
    }
    case bmo::BrainStatus::Talking: {
      // Mouth chatters with a faux-speech envelope; eyes warm.
      const float wave = 0.5f + 0.5f * sinf(now * 0.018f);
      s.mouth     = FaceState::M_OPEN;
      s.mouthOpen = 0.25f + 0.55f * wave;
      s.eyeShape  = FaceState::EYE_CRESCENT;
      s.lidL      = s.lidR = 0.25f;
      break;
    }
    default:
      s.mouth = FaceState::M_SMILE;
      break;
  }
  renderFrameWithParticles(s, now);
}

static void askBrain() {
  // Stage 0: face says "listening" while we capture from mic.
  g_brainStatus = bmo::BrainStatus::Listening;

  // 3 s capture cap (mic buffer is sized for it). The user already released
  // the touch, so we don't have a "stop on release" lambda — capture until
  // either the buffer fills or capture stalls.
  int16_t* pcm = bmo::micStaticBuffer();
  const uint32_t captureStart = millis();
  size_t samples = 0;
  // Animate the listening face for up to ~3s while we collect.
  while (samples < bmo::kMicCaptureSamples && (millis() - captureStart) < 3500) {
    const size_t batchTarget = (size_t)((millis() - captureStart) * 16); // ~16 sps/ms
    const size_t want =
        (batchTarget > samples && batchTarget - samples < 2048)
            ? (batchTarget - samples)
            : 1024;
    const size_t cap = bmo::kMicCaptureSamples - samples;
    const size_t batch = (want > cap) ? cap : want;
    const size_t got = bmo::micCapture(pcm + samples, batch, nullptr);
    samples += got;
    renderBrainStatusFrame(millis());
    if (got == 0) break;
  }
  Serial.printf("[brain] captured %u samples (%lums)\n",
                static_cast<unsigned>(samples),
                static_cast<unsigned long>(millis() - captureStart));

  if (samples < 4000) {
    // <250ms of audio; treat as cancellation, no point sending.
    Serial.println("[brain] capture too short, skipping");
    g_brainStatus = bmo::BrainStatus::Idle;
    return;
  }

  // Build a RIFF/WAVE header and concatenate with the PCM bytes. We allocate
  // a contiguous buffer on the heap so the brain client can hand it to
  // HTTPClient::POST() in one shot.
  const size_t pcmBytes = samples * sizeof(int16_t);
  const size_t totalBytes = 44 + pcmBytes;
  uint8_t* wav = static_cast<uint8_t*>(malloc(totalBytes));
  if (wav == nullptr) {
    Serial.printf("[brain] oom for wav (%u bytes)\n",
                  static_cast<unsigned>(totalBytes));
    g_brainStatus = bmo::BrainStatus::Error;
    return;
  }
  bmo::wavWriteHeader(wav, pcmBytes, 16000, 1, 16);
  memcpy(wav + 44, pcm, pcmBytes);

  // Stage 1+: brain client takes over. It emits Thinking → Talking → Idle.
  const bool ok = g_brain.ask(wav, totalBytes);
  free(wav);

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

static void playReaction(TouchKind k) {
  Serial.printf("touch: %s\n", touchKindName(k));
  particlesClear();
  playReactionGlance(k);

  // -------- LONG_HOLD: route to dashboard brain instead of canned reaction --
  if (k == TOUCH_LONG_HOLD) {
    askBrain();
    particlesClear();
    return;
  }

  switch (k) {

    // ─────────────────────────────────────────────────────────────────────
    // QUICK POKE
    // anticipation (compress) → recoil up + gasp →
    // dart eyes seeking culprit → relief blink → nervous smile + faint blush
    // ─────────────────────────────────────────────────────────────────────
    case TOUCH_QUICK_POKE: {
      // Voice: clip "bmo_what" if available, otherwise synth startled
      playClipOrSynth("bmo_what", playBmoStartled);
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
      // Voice: clip "bmo_hi_friend" if available, otherwise synth
      playClipOrSynth("bmo_hi_friend", playBmoHi);
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

  pinMode(PIN_TOUCH, INPUT);   // TTP223 actively drives HIGH/LOW

  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println("BMO extended-expressions boot");

  tftSPI.begin(PIN_SCK, -1, PIN_SDA, -1);
  tftSPI.setHwCs(false);
  tftInit();

  fbFill(C_BG);
  flushFrame();

  audioInit();
  Serial.println("audio ready");

  // Mic init shares the I2S unit with the speaker but on the second port.
  if (bmo::micBegin()) {
    Serial.println("mic ready");
  } else {
    Serial.println("mic init failed; long-hold-to-ask will not work");
  }

  // ── Provisioning ───────────────────────────────────────────────────────
  // If the user is holding the touch button while we boot, treat that as a
  // factory-reset gesture: wipe NVS so the captive portal opens fresh.
  if (digitalRead(PIN_TOUCH) == HIGH) {
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
      playReaction(g_pendingKind);
      // Run a couple more reactions if user keeps touching (chain)
      while (g_touchPending) {
        g_touchPending = false;
        playReaction(g_pendingKind);
      }
    }
    playMood(sc.m, sc.ms);
  }
}
