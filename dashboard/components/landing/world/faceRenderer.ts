/**
 * BMO's face, ported from the firmware.
 *
 * A TypeScript port of the framebuffer primitives and face routines in
 * `firmware/bmo_face_anim/src/main.cpp` (`drawFaceToBuffer` and friends). It
 * paints into a 160×128 RGBA buffer — the ST7735's native resolution — so the
 * face on the website is the same pixels the device shows.
 *
 * No DOM or WebGL dependency: the 3D scene uploads `pixels` as a texture and
 * the no-WebGL poster blits it into a 2D canvas.
 *
 * Deviations from the firmware are deliberate and marked `web:` inline.
 */

export const FACE_W = 160;
export const FACE_H = 128;

/** Faces the web renderer knows. The first five match the landing MOMENTS. */
export type FaceMood =
  | 'boot'
  | 'idle'
  | 'touch'
  | 'listen'
  | 'think'
  | 'talk'
  | 'bashful'
  | 'laugh';

export interface FaceFrame {
  mood: FaceMood;
  /** Millisecond clock, like the firmware's millis(). */
  now: number;
  /** -1..1 horizontal gaze (pointer direction). Only moves normal eyes. */
  lookX: number;
  /** -1..1 vertical gaze. */
  lookY: number;
  /** 0..1 loudness envelope for the talking mouth. */
  talkLevel: number;
  /** 0..1 progress of the power-on sequence (mood 'boot' only). */
  boot: number;
  /** Draw the firmware's "excited" stars around the face. */
  sparkle: boolean;
}

const LITTLE_ENDIAN =
  new Uint8Array(new Uint32Array([0x0a0b0c0d]).buffer)[0] === 0x0d;

/** Pack 0xRRGGBB into one opaque RGBA pixel for the Uint32 view. */
function rgb(hex: number): number {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  return LITTLE_ENDIAN
    ? ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0
    : ((r << 24) | (g << 16) | (b << 8) | 0xff) >>> 0;
}

// Firmware palette: the RGB565 constants expanded to 8-bit per channel.
const C_BG = rgb(0xcee7d6); // 0xCF3A, sampled BMO screen mint
const C_INK = rgb(0x000000);
const C_MOUTH = rgb(0x395539); // 0x3AA7
const C_SHINE = rgb(0xffffff);
const C_BLUSH = rgb(0xff9aad); // 0xFCD5
const C_HEART = rgb(0xff69a5); // 0xFB54
const C_TONGUE = rgb(0xb5b29c); // 0xB593
const C_STAR = rgb(0xffef63); // 0xFF6C

/** Face background as CSS hex, for surfaces that should match the screen. */
export const FACE_BG_HEX = '#cee7d6';

// Eye + mouth coordinates (identical to the firmware constants).
const EYE_W = 8;
const EYE_H = 8;
const EYE_Y = 48;
const EYE_DX = 46;
const MOUTH_Y = 80;
const MOUTH_CX = FACE_W / 2;

type EyeShape = 'normal' | 'x' | 'spinner' | 'crescent';
type MouthShape = 'smile' | 'open' | 'flat' | 'oh' | 'laugh' | 'pulse';

interface FaceState {
  eye: EyeShape;
  lidL: number;
  lidR: number;
  pupilDx: number;
  pupilDy: number;
  mouth: MouthShape;
  mouthOpen: number;
  smileWidth: number;
  smileDip: number;
  flatWidth: number;
  blush: number;
  listeningMarks: boolean;
  stars: boolean;
  shakeX: number;
  shakeY: number;
}

function freshState(): FaceState {
  return {
    eye: 'normal',
    lidL: 0,
    lidR: 0,
    pupilDx: 0,
    pupilDy: 0,
    mouth: 'smile',
    mouthOpen: 0,
    smileWidth: 46,
    smileDip: 8,
    flatWidth: 38,
    blush: 0,
    listeningMarks: false,
    stars: false,
    shakeX: 0,
    shakeY: 0,
  };
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
/** C-style (int) cast: truncate toward zero. */
const int = (v: number): number => Math.trunc(v);

function hash1(n: number): number {
  const s = Math.sin(n * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Stand-in for the device's live audio envelope: syllable-shaped bumps with
 * varied loudness and a short breath every few syllables. `t` is ms since the
 * reply started.
 */
export function talkEnvelope(t: number): number {
  const syllable = t / 140;
  const k = Math.floor(syllable);
  const frac = syllable - k;
  const loud = 0.4 + 0.6 * hash1(k + 7);
  const breath = k % 7 === 6 ? 0.1 : 1;
  return clamp01(loud * breath * Math.pow(Math.sin(Math.PI * frac), 0.7));
}

export class FaceRenderer {
  /** RGBA8, row 0 = top of the screen. */
  readonly pixels = new Uint8Array(FACE_W * FACE_H * 4);
  private readonly fb = new Uint32Array(this.pixels.buffer);
  private frameBg = C_BG;

  /**
   * Draw one frame. Returns how much signal glitch (0..1) the display should
   * add on top — the firmware's `glitchShift`, applied by the screen shader.
   */
  render(frame: FaceFrame): number {
    const { now } = frame;
    if (frame.mood === 'boot') return this.renderBoot(frame.boot);

    const s = freshState();
    let glitch = 0;

    switch (frame.mood) {
      case 'idle': {
        s.mouth = 'open';
        s.mouthOpen = 0.55 + 0.05 * Math.sin(now * 0.0013);
        s.pupilDx = int(2 * Math.sin(now * 0.0011));
        s.pupilDy = int(1 * Math.sin(now * 0.0007));
        const bp = now % 5200;
        if (bp < 130) {
          const p = bp / 130;
          const lid = p < 0.5 ? p * 2 : (1 - p) * 2;
          s.lidL = lid;
          s.lidR = lid;
        }
        break;
      }
      case 'touch': {
        // MOOD_SURPRISE. web: Math.round so the "eye dart" is visible; the
        // firmware's (int) cast of a unit sine is almost always 0.
        s.mouth = 'oh';
        s.pupilDx = Math.round(Math.sin(now * 0.05));
        s.pupilDy = Math.round(Math.cos(now * 0.05));
        break;
      }
      case 'listen': {
        // BrainStatus::Listening — the "tuned-in receiver" look.
        s.eye = 'x';
        s.mouth = 'open';
        s.mouthOpen = 0.3 + 0.25 * (0.5 + 0.5 * Math.sin(now * 0.012));
        s.shakeX = Math.round(Math.sin(now * 0.02));
        s.listeningMarks = true;
        glitch = 0.35;
        break;
      }
      case 'think': {
        // BrainStatus::Thinking spinner eyes. web: the pulsing processing orb
        // (fbDrawPulseMouth) stands in for the flat mouth, matching the copy.
        s.eye = 'spinner';
        s.mouth = 'pulse';
        s.shakeY = Math.round(Math.sin(now * 0.0015));
        glitch = now % 2600 < 110 ? 0.55 : 0;
        break;
      }
      case 'talk': {
        // BrainStatus::Talking — mouth driven by the loudness envelope.
        const lvl = clamp01(frame.talkLevel);
        const micro = 0.06 * (0.5 + 0.5 * Math.sin(now * 0.05));
        s.mouth = 'open';
        s.mouthOpen = Math.min(1, 0.08 + 0.9 * lvl + micro);
        const blink = now % 2600 < 130 ? 0.8 : 0.08;
        s.lidL = blink;
        s.lidR = blink;
        s.pupilDy = -int(2 * lvl);
        s.pupilDx = int(1 * Math.sin(now * 0.006));
        break;
      }
      case 'bashful': {
        // web: the firmware has no shy mood; composed from its primitives —
        // lowered lids, a small sideways smile, cheeks with blush hatches.
        s.lidL = 0.5;
        s.lidR = 0.5;
        s.pupilDx = -2;
        s.pupilDy = 2;
        s.smileWidth = 30;
        s.smileDip = 6;
        s.blush = 0.72 + 0.08 * Math.sin(now * 0.004);
        break;
      }
      case 'laugh': {
        s.eye = 'crescent';
        s.mouth = 'laugh';
        s.mouthOpen = 0.7 + 0.3 * Math.sin(now * 0.025);
        s.shakeY = int(2 * Math.abs(Math.sin(now * 0.025)));
        s.blush = 1;
        break;
      }
    }

    if (s.eye === 'normal') {
      s.pupilDx += Math.round(clamp(frame.lookX, -1, 1) * 3);
      s.pupilDy += Math.round(clamp(frame.lookY, -1, 1) * 2);
    }
    s.stars = frame.sparkle;

    this.draw(s, now);
    return glitch;
  }

  // ---------------------------------------------------------------------------
  // drawFaceToBuffer
  // ---------------------------------------------------------------------------

  private draw(s: FaceState, now: number): void {
    this.frameBg = C_BG;
    this.fb.fill(C_BG);

    const leftCx = MOUTH_CX - EYE_DX + s.shakeX;
    const rightCx = MOUTH_CX + EYE_DX + s.shakeX;
    const eyeY = EYE_Y + s.shakeY;

    if (s.blush > 0) {
      this.blush(leftCx - 18, eyeY + 18, s.blush);
      this.blush(rightCx + 18, eyeY + 18, s.blush);
    }

    switch (s.eye) {
      case 'normal':
        this.eye(leftCx + s.pupilDx, eyeY + s.pupilDy, EYE_W, EYE_H, s.lidL);
        this.eye(rightCx + s.pupilDx, eyeY + s.pupilDy, EYE_W, EYE_H, s.lidR);
        break;
      case 'x':
        this.xEye(leftCx, eyeY, 7);
        this.xEye(rightCx, eyeY, 7);
        break;
      case 'spinner': {
        const phase = ((now % 960) / 960) * 6.28;
        this.spinnerEye(leftCx, eyeY, 8, phase);
        this.spinnerEye(rightCx, eyeY, 8, phase + 0.8);
        break;
      }
      case 'crescent':
        // fbDrawCrescentEye(cx, eyeY + 4, 16) → fbDrawSmile(cx, cy - 4, ...)
        this.smile(leftCx, eyeY, 16, 4, 2, 1, C_INK);
        this.smile(rightCx, eyeY, 16, 4, 2, 1, C_INK);
        break;
    }

    const mx = MOUTH_CX + s.shakeX;
    const my = MOUTH_Y + s.shakeY;
    switch (s.mouth) {
      case 'pulse':
        this.pulseMouth(mx, my, (now % 1200) / 1200);
        break;
      case 'smile':
        this.smile(mx, my - 4, s.smileWidth, s.smileDip, 3, 2, C_MOUTH);
        break;
      case 'open':
        this.openMouth(
          mx,
          my,
          10 + int(14 * s.mouthOpen),
          4 + int(10 * s.mouthOpen),
          true,
        );
        break;
      case 'flat':
        this.flatMouth(mx, my, s.flatWidth, 4, C_MOUTH);
        break;
      case 'oh':
        this.openMouth(mx, my, 6, 8, false);
        break;
      case 'laugh':
        this.laugh(mx, my, s.mouthOpen, now);
        break;
    }

    if (s.stars) {
      const t = int(now / 80) % 4;
      this.star(20 + t * 2, 20, 4, C_STAR);
      this.star(140 - t * 2, 16, 5, C_STAR);
      this.star(30, 100 - t, 3, C_STAR);
      this.star(135, 108 + t, 4, C_STAR);
    }

    if (s.listeningMarks) this.listeningMarks(now);
  }

  /** Power-on: a loading bar, then the eyes wake up and BMO smiles. */
  private renderBoot(progress: number): number {
    const p = clamp01(progress);
    this.frameBg = C_BG;
    this.fb.fill(C_BG);

    if (p < 0.6) {
      const x = 48;
      const y = 59;
      const w = 64;
      const h = 10;
      this.fillRoundRect(x, y, w, h, 4, C_INK);
      this.fillRoundRect(x + 2, y + 2, w - 4, h - 4, 3, C_BG);
      const fill = Math.round((w - 8) * clamp01(p / 0.55));
      if (fill > 0) this.fillRoundRect(x + 4, y + 4, fill, h - 8, 1, C_MOUTH);
      return 0.25 * (1 - p);
    }

    const q = (p - 0.6) / 0.4;
    const lid = q < 0.45 ? 0.96 : Math.max(0, 0.96 - ((q - 0.45) / 0.3) * 0.96);
    this.eye(MOUTH_CX - EYE_DX, EYE_Y, EYE_W, EYE_H, lid);
    this.eye(MOUTH_CX + EYE_DX, EYE_Y, EYE_W, EYE_H, lid);
    if (q > 0.55) this.smile(MOUTH_CX, MOUTH_Y - 4, 46, 8, 3, 2, C_MOUTH);
    return 0;
  }

  // ---------------------------------------------------------------------------
  // Face routines (fbDraw*)
  // ---------------------------------------------------------------------------

  private smile(
    cx: number,
    cy: number,
    width: number,
    dipDepth: number,
    thickness: number,
    cornerCurl: number,
    c: number,
  ): void {
    const half = int(width / 2);
    for (let x = -half; x <= half; x++) {
      const t = x / half;
      const dip = dipDepth * (1 - t * t);
      const curl = cornerCurl * (t * t * t * t);
      const y = cy + int(dip) - int(curl);
      this.vline(cx + x, y - int(thickness / 2), thickness, c);
    }
  }

  private flatMouth(
    cx: number,
    cy: number,
    width: number,
    thickness: number,
    c: number,
  ): void {
    this.fillRoundRect(
      cx - int(width / 2),
      cy - int(thickness / 2),
      width,
      thickness,
      int(thickness / 2),
      c,
    );
  }

  private eye(cx: number, cy: number, w: number, h: number, lid: number): void {
    const top = cy - int(h / 2);
    const rx = int(w / 2);
    const ry = int(h / 2);

    if (lid >= 0.95) {
      this.flatMouth(cx, cy, w + 2, 2, C_INK);
      return;
    }

    this.fillEllipse(cx, cy, rx, ry, C_INK);

    if (lid > 0) {
      const lidH = int((h - 2) * lid);
      this.rect(cx - rx - 1, top - 1, w + 2, lidH + 2, this.frameBg);
    }
  }

  private xEye(cx: number, cy: number, size: number): void {
    this.line(cx - size, cy - size, cx + size, cy + size, 3, C_INK);
    this.line(cx - size, cy + size, cx + size, cy - size, 3, C_INK);
  }

  private spinnerEye(cx: number, cy: number, radius: number, phase: number): void {
    const count = 8;
    for (let i = 0; i < count; i++) {
      if (i > 5) continue; // rotating gap so it reads as motion
      const a = phase - i * (6.28318 / count);
      const x = cx + int(Math.cos(a) * radius);
      const y = cy + int(Math.sin(a) * radius);
      this.fillCircle(x, y, i < 2 ? 2 : 1, C_INK);
    }
  }

  private blush(cx: number, cy: number, amount: number): void {
    const r = 3 + int(2 * amount);
    this.fillEllipse(cx, cy, r + 1, r, C_BLUSH);
    if (amount < 0.65) return;
    this.line(cx - 4, cy + 2, cx - 2, cy - 2, 1, C_HEART);
    this.line(cx, cy + 2, cx + 2, cy - 2, 1, C_HEART);
    this.line(cx + 4, cy + 1, cx + 5, cy - 1, 1, C_HEART);
  }

  private bmoMouth(
    cx: number,
    cy: number,
    width: number,
    height: number,
    tooth: boolean,
    tongue: boolean,
  ): void {
    const w = Math.max(10, width);
    const h = Math.max(8, height);
    const rx = int(w / 2);
    const ry = int(h / 2);

    this.fillEllipse(cx, cy, rx + 2, ry + 2, C_INK);
    this.fillEllipse(cx, cy, rx, ry, C_MOUTH);

    if (tongue && h >= 12) {
      const tongueRx = Math.max(3, rx - 5);
      const tongueRy = Math.max(2, int(ry / 3));
      this.fillEllipse(cx + 1, cy + ry - 3, tongueRx, tongueRy, C_TONGUE);
      this.hline(cx - tongueRx + 1, cy + ry - 4, tongueRx * 2 - 2, C_INK);
    }

    if (tooth && w >= 18) {
      const toothRx = Math.max(4, rx - 5);
      this.fillEllipse(cx, cy - ry + 5, toothRx, 3, C_SHINE);
    }
  }

  private openMouth(
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    tongue: boolean,
  ): void {
    this.bmoMouth(cx, cy, rx * 2, ry * 2, rx > 10 && ry > 6, tongue);
  }

  private pulseMouth(cx: number, cy: number, phase: number): void {
    const b = 0.5 + 0.5 * Math.sin(phase * 6.28318);
    const rOuter = 6 + int(7 * b);
    this.fillCircle(cx, cy, rOuter, C_MOUTH);
    const rInner = rOuter - 3;
    if (rInner > 2) this.fillCircle(cx, cy, rInner, this.frameBg);
    const rCore = 2 + int(2 * (1 - b));
    this.fillCircle(cx, cy, rCore, C_MOUTH);
    for (let i = 0; i < 2; i++) {
      const a = phase * 6.28318 * (i ? -1 : 1) + i * 3.14159;
      const ox = cx + int(Math.cos(a) * (rOuter + 4));
      const oy = cy + int(Math.sin(a) * (rOuter + 4));
      this.fillCircle(ox, oy, 1, C_MOUTH);
    }
  }

  private laugh(cx: number, cy: number, openness: number, now: number): void {
    const rx = 14;
    const ry = 5 + int(8 * openness);
    this.bmoMouth(cx, cy, rx * 2, ry * 2, true, true);
    const t = int(now / 80) % 6;
    this.letterZ(cx - 28, cy - 6 - t, 2);
    this.letterZ(cx + 28, cy - 6 - t, 2);
  }

  private letterZ(cx: number, cy: number, size: number): void {
    this.hline(cx - size, cy - size, 2 * size + 1, C_INK);
    this.hline(cx - size, cy + size, 2 * size + 1, C_INK);
    this.line(cx + size, cy - size, cx - size, cy + size, 2, C_INK);
  }

  private listeningMarks(now: number): void {
    const phase = int(now / 120) % 3;
    for (let i = 0; i < 3; i++) {
      const h = 3 + ((phase + i) % 3) * 2;
      const y = MOUTH_Y - int(h / 2) + int(1 * Math.sin(now * 0.005 + i));
      this.fillRoundRect(20 + i * 5, y, 3, h, 1, C_MOUTH);
      this.fillRoundRect(FACE_W - 23 - i * 5, y, 3, h, 1, C_MOUTH);
    }
  }

  private star(cx: number, cy: number, size: number, c: number): void {
    if (size < 1) return;
    this.fillRoundRect(cx - 1, cy - size, 3, 2 * size + 1, 1, c);
    this.fillRoundRect(cx - size, cy - 1, 2 * size + 1, 3, 1, c);
    this.fillCircle(cx, cy, 1, C_SHINE);
  }

  // ---------------------------------------------------------------------------
  // Framebuffer primitives (putPx, fbHLine, ... fbLine)
  // ---------------------------------------------------------------------------

  private putPx(x: number, y: number, c: number): void {
    if (x < 0 || y < 0 || x >= FACE_W || y >= FACE_H) return;
    this.fb[y * FACE_W + x] = c;
  }

  private hline(x: number, y: number, w: number, c: number): void {
    if (y < 0 || y >= FACE_H) return;
    let x0 = x;
    let width = w;
    if (x0 < 0) {
      width += x0;
      x0 = 0;
    }
    if (x0 + width > FACE_W) width = FACE_W - x0;
    if (width <= 0) return;
    const start = y * FACE_W + x0;
    this.fb.fill(c, start, start + width);
  }

  private vline(x: number, y: number, h: number, c: number): void {
    if (x < 0 || x >= FACE_W) return;
    let y0 = y;
    let height = h;
    if (y0 < 0) {
      height += y0;
      y0 = 0;
    }
    if (y0 + height > FACE_H) height = FACE_H - y0;
    for (let i = 0; i < height; i++) this.fb[(y0 + i) * FACE_W + x] = c;
  }

  private rect(x: number, y: number, w: number, h: number, c: number): void {
    let x0 = x;
    let y0 = y;
    let width = w;
    let height = h;
    if (width <= 0 || height <= 0) return;
    if (x0 < 0) {
      width += x0;
      x0 = 0;
    }
    if (y0 < 0) {
      height += y0;
      y0 = 0;
    }
    if (x0 + width > FACE_W) width = FACE_W - x0;
    if (y0 + height > FACE_H) height = FACE_H - y0;
    if (width <= 0 || height <= 0) return;
    for (let j = 0; j < height; j++) {
      const start = (y0 + j) * FACE_W + x0;
      this.fb.fill(c, start, start + width);
    }
  }

  private fillCircle(cx: number, cy: number, r: number, c: number): void {
    if (r < 0) return;
    for (let y = -r; y <= r; y++) {
      const dx = Math.floor(Math.sqrt(r * r - y * y));
      this.hline(cx - dx, cy + y, 2 * dx + 1, c);
    }
  }

  private fillEllipse(cx: number, cy: number, rx: number, ry: number, c: number): void {
    if (rx <= 0 || ry <= 0) return;
    for (let y = -ry; y <= ry; y++) {
      const t = y / ry;
      const dx = Math.floor(rx * Math.sqrt(Math.max(0, 1 - t * t)));
      this.hline(cx - dx, cy + y, 2 * dx + 1, c);
    }
  }

  private fillRoundRect(
    x: number,
    y: number,
    w: number,
    h: number,
    radius: number,
    c: number,
  ): void {
    let r = radius;
    if (r * 2 > w) r = int(w / 2);
    if (r * 2 > h) r = int(h / 2);
    if (r < 0) r = 0;
    this.rect(x + r, y, w - 2 * r, h, c);
    this.rect(x, y + r, r, h - 2 * r, c);
    this.rect(x + w - r, y + r, r, h - 2 * r, c);
    this.fillCircle(x + r, y + r, r, c);
    this.fillCircle(x + w - r - 1, y + r, r, c);
    this.fillCircle(x + r, y + h - r - 1, r, c);
    this.fillCircle(x + w - r - 1, y + h - r - 1, r, c);
  }

  /** Bresenham line; thickness is simulated with a small disc per step. */
  private line(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    thickness: number,
    c: number,
  ): void {
    // Integer endpoints are required for the loop to terminate.
    let x0 = Math.round(fromX);
    let y0 = Math.round(fromY);
    const x1 = Math.round(toX);
    const y1 = Math.round(toY);
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      if (thickness <= 1) this.putPx(x0, y0, c);
      else this.fillCircle(x0, y0, int(thickness / 2), c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
