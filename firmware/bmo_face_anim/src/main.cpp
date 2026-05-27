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
// All moods share the same BMO-blue background for visual consistency.
// `bgOverride` field is kept in FaceState for ad-hoc tints, but the built-in
// moods don't use it — moods that want to communicate temperature/sickness
// do it through icons (snowflakes, steam, sweat) layered on top of the
// standard BMO blue.
// -----------------------------------------------------------------------------
static constexpr uint16_t C_BG       = 0x1AD3;  // dark BMO teal-blue (~#163B7A blend)
static constexpr uint16_t C_BG_COLD  = C_BG;
static constexpr uint16_t C_BG_HOT   = C_BG;
static constexpr uint16_t C_BG_SICK  = C_BG;
static constexpr uint16_t C_INK      = 0x0000;
static constexpr uint16_t C_SHINE    = 0xFFFF;
static constexpr uint16_t C_BLUSH    = 0xFCD3;
static constexpr uint16_t C_HEART    = 0xF81F;
static constexpr uint16_t C_STAR     = 0xFFE0;
static constexpr uint16_t C_TEAR     = 0x6E5F;
static constexpr uint16_t C_SWEAT    = 0xC65F;
static constexpr uint16_t C_TONGUE   = 0xF992;
static constexpr uint16_t C_BROW     = 0x0000;

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
  int left = cx - w / 2;
  int r    = (w < h ? w : h) / 2;
  if (r > 6) r = 6;

  if (lid >= 0.95f) {
    fbDrawFlatMouth(cx, cy, w + 2, 2, C_INK);
    return;
  }

  fbFillRoundRect(left, top, w, h, r, C_INK);

  if (lid > 0) {
    int lidH = (int)((h - 2) * lid);
    fbRect(left - 1, top - 1, w + 2, lidH + 2, C_BG);
  }

  int shineY = cy + dy - 5;
  int shineX = cx + dx + 3;
  if (shineY > top + (int)((h) * lid) + 1) {
    fbRect(shineX,     shineY,     3, 3, C_SHINE);
    fbRect(shineX - 1, shineY + 1, 1, 1, C_SHINE);
    fbRect(shineX + 3, shineY + 1, 1, 1, C_SHINE);
  }
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

// Tongue / drool: a soft pink tear-shape sticking out of the mouth.
static void fbDrawDrool(int cx, int cy, int len) {
  fbFillEllipse(cx, cy + len / 2, 3, len / 2 + 2, C_TONGUE);
}

// Tongue out (hungry): flat pink bar dangling from a small open mouth.
static void fbDrawTongueOut(int cx, int cy) {
  // small mouth above
  fbFillEllipse(cx, cy - 4, 9, 4, C_INK);
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
  fbFillCircle(cx, cy - 4, 2, C_BG);
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
  fbFillRoundRect(cx - 18, cy - 5, 36, 10, 3, C_INK);
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
  fbFillEllipse(cx, cy, rx, ry, C_INK);
  // Tongue stripe inside
  fbFillRoundRect(cx - 6, cy + ry / 2, 12, 3, 1, C_TONGUE);
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
static constexpr int EYE_W = 18;
static constexpr int EYE_H = 30;
static constexpr int EYE_Y = 50;
static constexpr int EYE_DX = 30;
static constexpr int MOUTH_Y  = 92;
static constexpr int MOUTH_CX = TFT_W / 2;

static void renderFrame(const FaceState &s, uint32_t now) {
  // Background — moods can override (cold/hot/sick)
  uint16_t bg = s.bgOverride ? s.bgOverride : C_BG;
  fbFill(bg);

  int leftCx  = MOUTH_CX - EYE_DX + s.shakeX;
  int rightCx = MOUTH_CX + EYE_DX + s.shakeX;
  int eyeY    = EYE_Y + s.shakeY;

  // Cheeks
  if (s.blush > 0) {
    int r = 5 + (int)(2 * s.blush);
    fbFillEllipse(20,         eyeY + 20, r + 1, r, C_BLUSH);
    fbFillEllipse(TFT_W - 20, eyeY + 20, r + 1, r, C_BLUSH);
  }

  // Eyes
  switch (s.eyeShape) {
    case FaceState::EYE_NORMAL:
      fbDrawEye(leftCx,  eyeY, EYE_W, EYE_H, s.lidL, s.pupilDx, s.pupilDy);
      fbDrawEye(rightCx, eyeY, EYE_W, EYE_H, s.lidR, s.pupilDx, s.pupilDy);
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
  }

  // Eyebrows
  if (s.browVisible) {
    fbDrawBrow(leftCx,  eyeY - EYE_H / 2 - 6, 18, s.browSlope, 4, C_BROW);
    fbDrawBrow(rightCx, eyeY - EYE_H / 2 - 6, 18, -s.browSlope, 4, C_BROW);
  }

  // Mouth
  switch (s.mouth) {
    case FaceState::M_SMILE:
      fbDrawSmile(MOUTH_CX + s.shakeX, MOUTH_Y - 4 + s.shakeY, 56, 10, 4, 6, C_INK);
      break;
    case FaceState::M_OPEN: {
      int rx = 10 + (int)(14 * s.mouthOpen);
      int ry = 4  + (int)(10 * s.mouthOpen);
      fbFillEllipse(MOUTH_CX + s.shakeX, MOUTH_Y + s.shakeY, rx, ry, C_INK);
      break;
    }
    case FaceState::M_FLAT:
      fbDrawFlatMouth(MOUTH_CX + s.shakeX, MOUTH_Y + s.shakeY, 38, 4, C_INK);
      break;
    case FaceState::M_TALK: {
      int rx = 14;
      int ry = 3 + (int)(7 * s.mouthOpen);
      fbFillEllipse(MOUTH_CX + s.shakeX, MOUTH_Y + s.shakeY, rx, ry, C_INK);
      break;
    }
    case FaceState::M_FROWN:
      fbDrawFrown(MOUTH_CX + s.shakeX, MOUTH_Y + 4 + s.shakeY, 44, 8, 4, C_INK);
      break;
    case FaceState::M_GRIN:
      fbDrawSmile(MOUTH_CX + s.shakeX, MOUTH_Y - 4 + s.shakeY, 64, 14, 4, 10, C_INK);
      break;
    case FaceState::M_OH:
      fbFillEllipse(MOUTH_CX + s.shakeX, MOUTH_Y + s.shakeY, 6, 8, C_INK);
      break;
    case FaceState::M_TONGUE_OUT:
      fbDrawTongueOut(MOUTH_CX + s.shakeX, MOUTH_Y + 2 + s.shakeY);
      break;
    case FaceState::M_DROOL: {
      // open mouth above + drool dripping below
      int ry = 4 + (int)(6 * s.mouthOpen);
      fbFillEllipse(MOUTH_CX + s.shakeX, MOUTH_Y + s.shakeY, 12, ry, C_INK);
      int droolLen = 6 + (int)(6 * s.mouthOpen);
      fbDrawDrool(MOUTH_CX + s.shakeX - 2, MOUTH_Y + ry + 2, droolLen);
      break;
    }
    case FaceState::M_ZIGZAG:
      fbDrawZigzag(MOUTH_CX + s.shakeX, MOUTH_Y + s.shakeY, 40, 4, 3, C_INK);
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

  flushFrame();
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
// Pre-baked PCM clip playback.
//
// Clips live in src/audio_clips.h, generated by tools/bake_audio.py from
// real WAV/MP3 files. Format: 8-bit unsigned PCM, mono, 16 kHz.
//
// We convert 8-bit unsigned (0..255, midpoint 128) to signed 16-bit
// (-32768..32767) on the fly while applying volume, then stream to I2S.
// -----------------------------------------------------------------------------
static void playClip(const BmoClip *clip) {
  if (!clip || clip->length == 0) return;

  static int16_t chunk[256];
  uint32_t sent = 0;
  while (sent < clip->length) {
    uint32_t n = clip->length - sent;
    if (n > 256) n = 256;
    for (uint32_t i = 0; i < n; ++i) {
      // 0..255 -> -1.0..+1.0
      int s = (int)clip->samples[sent + i] - 128;        // -128..+127
      float f = (float)s / 128.0f;
      f *= g_volume;
      if (f > 1.0f) f = 1.0f;
      else if (f < -1.0f) f = -1.0f;
      chunk[i] = (int16_t)(f * 32767.0f);
    }
    size_t written;
    i2s_write(AUDIO_I2S_PORT, chunk, n * sizeof(int16_t), &written,
              portMAX_DELAY);
    sent += n;
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
// BMO voice synth — procedural sounds that capture BMO's beep-and-chirp
// vocal character without needing pre-recorded audio. For phrases that need
// real words ("Hi friend!", "Who wants to play video games?"), see
// tools/generate_voice.py for the TTS-based pipeline.
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
// Real TTS recommended; this is a stand-in until tools/generate_voice.py is run.
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
static const Note kJingleWink[]     = { {1000, 60} };
static const Note kJingleGlitch[]   = { {200, 30}, {1500, 30}, {200, 30}, {1500, 30} };
static const Note kJingleIdle[]     = { {0, 0} };  // silent

enum Mood : uint8_t {
  MOOD_IDLE,
  MOOD_BLINK,
  MOOD_HAPPY,
  MOOD_TALK,
  MOOD_LISTEN,
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
        s.mouth = FaceState::M_SMILE;
        s.pupilDx = (int)(2 * sinf(now * 0.0015f));
        uint32_t bp = now % 3000;
        if (bp < 150) {
          float p = bp / 150.0f;
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
        s.mouth = FaceState::M_OPEN;
        s.mouthOpen = 0.6f + 0.4f * sinf(now * 0.012f);
        s.lidL = s.lidR = 0.45f;
        s.blush = 1.0f;
        break;
      }
      case MOOD_TALK: {
        s.mouth = FaceState::M_TALK;
        s.mouthOpen = 0.5f + 0.5f * sinf(now * 0.025f);
        s.pupilDy = (int)(1 * sinf(now * 0.01f));
        break;
      }
      case MOOD_LISTEN: {
        s.mouth = FaceState::M_FLAT;
        s.pupilDx = (int)(1 * sinf(now * 0.005f));
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
        s.mouth = FaceState::M_GRIN;
        s.lidL = s.lidR = 0.3f;
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
        // Crescent eyes (heavy lids), big laugh mouth, blush
        s.lidL = s.lidR = 0.5f;
        s.mouth = FaceState::M_LAUGH;
        s.mouthOpen = 0.7f + 0.3f * sinf(now * 0.025f);
        s.shakeY = (int)(2 * fabsf(sinf(now * 0.025f)));
        s.blush = 1.0f;
        break;
      }

      default: break;
    }

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
  // Reuse the same path as renderFrame but draw particles on top before flush.
  // We can't easily inject between draw and flush without splitting renderFrame,
  // so we replicate the body here. Cheap and keeps the API simple.
  uint16_t bg = s.bgOverride ? s.bgOverride : C_BG;
  fbFill(bg);

  int leftCx  = MOUTH_CX - EYE_DX + s.shakeX;
  int rightCx = MOUTH_CX + EYE_DX + s.shakeX;
  int eyeY    = EYE_Y + s.shakeY;

  if (s.blush > 0) {
    int r = 5 + (int)(2 * s.blush);
    fbFillEllipse(20,         eyeY + 20, r + 1, r, C_BLUSH);
    fbFillEllipse(TFT_W - 20, eyeY + 20, r + 1, r, C_BLUSH);
  }

  // (Same eye dispatch as renderFrame.)
  switch (s.eyeShape) {
    case FaceState::EYE_NORMAL:
      fbDrawEye(leftCx,  eyeY, EYE_W, EYE_H, s.lidL, s.pupilDx, s.pupilDy);
      fbDrawEye(rightCx, eyeY, EYE_W, EYE_H, s.lidR, s.pupilDx, s.pupilDy);
      break;
    case FaceState::EYE_HEART:
      fbDrawHeartEye(leftCx,  eyeY, 7, C_HEART);
      fbDrawHeartEye(rightCx, eyeY, 7, C_HEART);
      break;
    case FaceState::EYE_X:
      fbDrawXEye(leftCx,  eyeY, 7, C_INK);
      fbDrawXEye(rightCx, eyeY, 7, C_INK);
      break;
    case FaceState::EYE_DOT:
      fbFillCircle(leftCx,  eyeY, 3, C_INK);
      fbFillCircle(rightCx, eyeY, 3, C_INK);
      break;
    default:
      fbDrawEye(leftCx,  eyeY, EYE_W, EYE_H, s.lidL, s.pupilDx, s.pupilDy);
      fbDrawEye(rightCx, eyeY, EYE_W, EYE_H, s.lidR, s.pupilDx, s.pupilDy);
      break;
  }

  if (s.browVisible) {
    fbDrawBrow(leftCx,  eyeY - EYE_H / 2 - 6, 18, s.browSlope, 4, C_BROW);
    fbDrawBrow(rightCx, eyeY - EYE_H / 2 - 6, 18, -s.browSlope, 4, C_BROW);
  }

  switch (s.mouth) {
    case FaceState::M_SMILE:
      fbDrawSmile(MOUTH_CX + s.shakeX, MOUTH_Y - 4 + s.shakeY, 56, 10, 4, 6, C_INK);
      break;
    case FaceState::M_OPEN: {
      int rx = 10 + (int)(14 * s.mouthOpen);
      int ry = 4  + (int)(10 * s.mouthOpen);
      fbFillEllipse(MOUTH_CX + s.shakeX, MOUTH_Y + s.shakeY, rx, ry, C_INK);
      break;
    }
    case FaceState::M_LAUGH:
      fbDrawLaugh(MOUTH_CX + s.shakeX, MOUTH_Y + s.shakeY, s.mouthOpen, now);
      break;
    case FaceState::M_OH:
      fbFillEllipse(MOUTH_CX + s.shakeX, MOUTH_Y + s.shakeY, 6, 8, C_INK);
      break;
    case FaceState::M_FLAT:
      fbDrawFlatMouth(MOUTH_CX + s.shakeX, MOUTH_Y + s.shakeY, 38, 4, C_INK);
      break;
    default:
      fbDrawSmile(MOUTH_CX + s.shakeX, MOUTH_Y - 4 + s.shakeY, 56, 10, 4, 6, C_INK);
      break;
  }

  particlesDraw();   // ⭐ overlay particles
  flushFrame();
}

static void playReaction(TouchKind k) {
  Serial.printf("touch: %s\n", touchKindName(k));
  particlesClear();

  switch (k) {

    // ─────────────────────────────────────────────────────────────────────
    // QUICK POKE
    // anticipation (compress) → recoil up + gasp + exclamation burst →
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
      // Phase B — recoil 200ms (gasp + exclamation particles)
      particlesEmit(6, MOUTH_CX, MOUTH_Y - 30, 2, C_INK);    // exclamation burst
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
    // glance → relax → contented purr with breathing eyes + sway + ambient
    // pink dot particles trickling up. Eyes track toward touch on entry.
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
        s.mouth = FaceState::M_OPEN;
        s.mouthOpen = 0.25f + 0.3f * t;
        s.lidL = s.lidR = 0.20f + 0.30f * t;
        s.blush = 0.3f + 0.7f * t;
        s.pupilDx = 3 - (int)(3 * t);
        s.shakeX = (int)(1 * sinf(now * 0.005f));
        renderFrameWithParticles(s, now);
        delay(22);
      }
      // Phase C — purr 1500ms: looped breathing animation, ambient pink dot
      // particles drift upward off the cheeks every ~250ms
      uint32_t pC = millis();
      uint32_t lastPuff = 0;
      while (millis() - pC < 1500) {
        uint32_t now = millis();
        if (now - lastPuff > 250) {
          particlesEmit(2, 30,         70, 3, C_BLUSH);
          particlesEmit(2, TFT_W - 30, 70, 3, C_BLUSH);
          lastPuff = now;
        }
        FaceState s;
        s.mouth = FaceState::M_OPEN;
        s.mouthOpen = 0.55f + 0.18f * sinf(now * 0.008f);
        s.lidL = s.lidR = 0.50f + 0.10f * sinf(now * 0.005f);
        s.blush = 1.0f;
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
    // pet phase → swelling anticipation → musical sting → heart-eye
    // transformation with floating hearts that burst in a circle
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
        s.mouth = FaceState::M_OPEN;
        s.mouthOpen = 0.3f + 0.3f * t;
        s.lidL = s.lidR = 0.20f + 0.30f * t;
        s.blush = 0.4f + 0.6f * t;
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
        s.mouth = FaceState::M_OPEN;
        s.mouthOpen = 0.6f + 0.3f * sinf(now * 0.015f);
        s.lidL = s.lidR = 0.45f - 0.45f * ease;
        s.blush = 1.0f;
        s.shakeY = -(int)(3 * ease);
        renderFrameWithParticles(s, now);
        delay(28);
      }
      // Phase C — sting + heart burst (250ms): a big musical chord, a circle
      // of hearts erupts outward from BMO's chest area
      playClipOrSynth("bmo_games", playBmoGames);
      particlesEmit(MAX_PARTICLES, MOUTH_CX, MOUTH_Y - 5, 1, C_HEART);
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
      // Phase D — heart eyes (1700ms): full love mode, eyes are hearts,
      // ambient hearts gently float around face, body bobs softly
      uint32_t pD = millis();
      uint32_t lastHeart = 0;
      while (millis() - pD < 1700) {
        uint32_t now = millis();
        if (now - lastHeart > 350) {
          particlesEmit(2, 25 + ((int)(now / 100) % 8), 90, 1, C_HEART);
          particlesEmit(2, TFT_W - 25 - ((int)(now / 100) % 8), 90, 1, C_HEART);
          lastHeart = now;
        }
        FaceState s;
        s.eyeShape = FaceState::EYE_HEART;
        s.mouth = FaceState::M_OPEN;
        s.mouthOpen = 0.5f + 0.4f * sinf(now * 0.012f);
        s.blush = 1.0f;
        s.shakeY = -(int)(2 + 1.5f * sinf(now * 0.008f));
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
      particlesEmit(6, MOUTH_CX, MOUTH_Y - 20, 0, C_STAR);
      uint32_t pA = millis();
      while (millis() - pA < 350) {
        uint32_t now = millis();
        FaceState s;
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
          particlesEmit(3, 20 + (rand() % 120), 30 + (rand() % 30), 0, C_STAR);
          lastStar = now;
        }
        FaceState s;
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
