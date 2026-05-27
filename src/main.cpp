#include <Arduino.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7735.h>
#include <SPI.h>

// Wiring for your 1.8" ST7735S TFT.
//
// TFT label -> ESP32-S3 WROOM N16R8 CAM board
// LED/BL    -> 3V3
// SCK/SCL   -> GPIO47
// SDA/MOSI  -> GPIO21
// A0/DC     -> GPIO41
// RESET/RST -> GPIO40
// CS        -> GPIO42
// GND       -> any GND
// VCC       -> 3V3
static constexpr int TFT_CS = 42;
static constexpr int TFT_DC = 41;
static constexpr int TFT_RST = 40;
static constexpr int TFT_SCLK = 47;
static constexpr int TFT_MOSI = 21;

Adafruit_ST7735 tft(TFT_CS, TFT_DC, TFT_MOSI, TFT_SCLK, TFT_RST);

static constexpr int SCREEN_W = 160;
static constexpr int SCREEN_H = 128;

static constexpr uint16_t C_PANEL = 0xCFF7;   // soft mint
static constexpr uint16_t C_PANEL_DARK = 0x8D76;
static constexpr uint16_t C_PANEL_LITE = 0xE7FE;
static constexpr uint16_t C_INK = ST77XX_BLACK;
static constexpr uint16_t C_CHEEK = 0xFCD3;
static constexpr uint16_t C_MOUTH = 0x2C44;
static constexpr uint16_t C_BLUE = 0x04BF;
static constexpr uint16_t C_YELLOW = 0xFFE0;
static constexpr uint16_t C_PINK = 0xF81F;
static constexpr uint16_t C_GREEN = 0x07E0;

enum Mood {
  MOOD_IDLE,
  MOOD_BLINK,
  MOOD_HAPPY,
  MOOD_SLEEPY,
  MOOD_SURPRISED,
  MOOD_LISTENING,
  MOOD_TALK_1,
  MOOD_TALK_2,
  MOOD_THINKING
};

void roundScreen() {
  tft.fillScreen(ST77XX_BLACK);
  tft.fillRoundRect(4, 4, 152, 120, 13, C_PANEL_DARK);
  tft.fillRoundRect(8, 8, 144, 112, 11, C_PANEL);
  tft.drawRoundRect(10, 10, 140, 108, 10, C_PANEL_LITE);
}

void eyeOval(int x, int y, int w, int h) {
  tft.fillRoundRect(x, y, w, h, h / 2, C_INK);
  tft.fillCircle(x + w - 4, y + 4, 2, ST77XX_WHITE);
}

void eyeSmile(int cx, int cy) {
  tft.drawFastHLine(cx - 8, cy, 16, C_INK);
  tft.drawFastHLine(cx - 7, cy + 1, 14, C_INK);
  tft.drawPixel(cx - 9, cy + 1, C_INK);
  tft.drawPixel(cx + 8, cy + 1, C_INK);
}

void eyeSleep(int cx, int cy) {
  tft.drawFastHLine(cx - 9, cy, 18, C_INK);
  tft.drawFastHLine(cx - 8, cy + 1, 16, C_INK);
  tft.drawPixel(cx - 10, cy - 1, C_INK);
  tft.drawPixel(cx + 9, cy - 1, C_INK);
}

void mouthSmile(int cx, int cy) {
  tft.drawRoundRect(cx - 25, cy - 6, 50, 21, 10, C_INK);
  tft.drawRoundRect(cx - 24, cy - 5, 48, 19, 9, C_INK);
  tft.fillRect(cx - 24, cy - 12, 48, 13, C_PANEL);
  tft.drawFastHLine(cx - 20, cy + 6, 40, C_INK);
}

void mouthOpen(int cx, int cy, int w, int h, uint16_t color = C_INK) {
  tft.fillRoundRect(cx - w / 2, cy - h / 2, w, h, h / 2, color);
}

void mouthFlat(int cx, int cy) {
  tft.fillRoundRect(cx - 18, cy - 2, 36, 4, 2, C_INK);
}

void blush() {
  tft.fillCircle(34, 80, 5, C_CHEEK);
  tft.fillCircle(126, 80, 5, C_CHEEK);
}

void drawStatusDots(uint16_t color) {
  tft.fillCircle(20, 108, 3, color);
  tft.fillCircle(31, 108, 3, color);
  tft.fillCircle(42, 108, 3, color);
}

void drawTinyControls() {
  tft.fillRoundRect(110, 103, 18, 7, 3, C_BLUE);
  tft.fillCircle(137, 106, 6, C_GREEN);
  tft.fillTriangle(74, 108, 84, 92, 94, 108, C_BLUE);
  tft.fillRect(28, 92, 7, 21, C_YELLOW);
  tft.fillRect(21, 99, 21, 7, C_YELLOW);
}

void drawMood(Mood mood) {
  roundScreen();

  switch (mood) {
    case MOOD_IDLE:
      eyeOval(45, 40, 13, 20);
      eyeOval(103, 40, 13, 20);
      mouthSmile(80, 76);
      drawStatusDots(C_BLUE);
      break;

    case MOOD_BLINK:
      eyeSleep(52, 51);
      eyeSleep(110, 51);
      mouthSmile(80, 76);
      drawStatusDots(C_BLUE);
      break;

    case MOOD_HAPPY:
      eyeSmile(52, 48);
      eyeSmile(110, 48);
      mouthOpen(80, 76, 42, 24);
      tft.fillRoundRect(66, 66, 28, 12, 6, C_PANEL);
      blush();
      drawStatusDots(C_GREEN);
      break;

    case MOOD_SLEEPY:
      eyeSleep(52, 48);
      eyeSleep(110, 48);
      mouthFlat(80, 78);
      tft.setTextColor(C_INK);
      tft.setTextSize(1);
      tft.setCursor(120, 25);
      tft.print("z");
      tft.setCursor(132, 18);
      tft.print("z");
      drawStatusDots(C_BLUE);
      break;

    case MOOD_SURPRISED:
      tft.drawCircle(52, 50, 8, C_INK);
      tft.drawCircle(110, 50, 8, C_INK);
      tft.fillCircle(52, 50, 4, C_INK);
      tft.fillCircle(110, 50, 4, C_INK);
      mouthOpen(80, 80, 25, 30);
      drawStatusDots(C_PINK);
      break;

    case MOOD_LISTENING:
      eyeOval(43, 42, 12, 18);
      eyeOval(104, 42, 12, 18);
      mouthFlat(80, 78);
      tft.drawCircle(80, 88, 5, C_INK);
      tft.drawCircle(80, 88, 12, C_INK);
      tft.drawCircle(80, 88, 19, C_INK);
      drawStatusDots(C_YELLOW);
      break;

    case MOOD_TALK_1:
      eyeOval(45, 40, 13, 20);
      eyeOval(103, 40, 13, 20);
      mouthOpen(80, 78, 35, 15);
      tft.fillRoundRect(68, 76, 24, 4, 2, C_MOUTH);
      drawStatusDots(C_GREEN);
      break;

    case MOOD_TALK_2:
      eyeSmile(52, 48);
      eyeSmile(110, 48);
      mouthOpen(80, 78, 47, 27);
      tft.fillRoundRect(64, 66, 32, 10, 5, C_PANEL);
      tft.fillRoundRect(63, 88, 34, 5, 2, C_MOUTH);
      drawStatusDots(C_GREEN);
      break;

    case MOOD_THINKING:
      eyeOval(46, 43, 11, 18);
      eyeSleep(110, 52);
      tft.drawCircle(80, 78, 4, C_INK);
      tft.drawCircle(92, 82, 3, C_INK);
      tft.drawCircle(104, 85, 2, C_INK);
      drawStatusDots(C_YELLOW);
      break;
  }

  drawTinyControls();
}

void splash() {
  roundScreen();
  tft.setTextColor(C_INK);
  tft.setTextSize(2);
  tft.setCursor(46, 44);
  tft.print("BEEP");
  tft.setTextSize(1);
  tft.setCursor(32, 76);
  tft.print("tiny console pal");
  drawTinyControls();
}

void bootColorTest() {
  Serial.println("TFT color test: red");
  tft.fillScreen(ST77XX_RED);
  delay(250);
  Serial.println("TFT color test: green");
  tft.fillScreen(ST77XX_GREEN);
  delay(250);
  Serial.println("TFT color test: blue");
  tft.fillScreen(ST77XX_BLUE);
  delay(250);
  Serial.println("TFT color test: white");
  tft.fillScreen(ST77XX_WHITE);
  delay(250);
  Serial.println("TFT color test done");
}

void setup() {
  Serial.begin(115200);
  delay(1500);
  Serial.println();
  Serial.println("Tiny console pal face animation boot");
  Serial.println("Init ST7735...");

  tft.initR(INITR_BLACKTAB);
  tft.setRotation(1);
  tft.fillScreen(ST77XX_BLACK);

  Serial.println("TFT init done");
  bootColorTest();
  splash();
  delay(1200);
}

void loop() {
  static const Mood sequence[] = {
    MOOD_IDLE,
    MOOD_BLINK,
    MOOD_IDLE,
    MOOD_HAPPY,
    MOOD_TALK_1,
    MOOD_TALK_2,
    MOOD_TALK_1,
    MOOD_LISTENING,
    MOOD_THINKING,
    MOOD_SURPRISED,
    MOOD_SLEEPY
  };

  static const uint16_t delayMs[] = {
    1400, 160, 900, 1000, 180, 180, 180, 1000, 1000, 900, 1400
  };

  for (size_t i = 0; i < sizeof(sequence) / sizeof(sequence[0]); ++i) {
    drawMood(sequence[i]);
    Serial.print("Face frame ");
    Serial.println(i);
    delay(delayMs[i]);
  }
}
