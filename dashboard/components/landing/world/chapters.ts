import type { FaceMood } from './faceRenderer';

/**
 * Scroll chapters, in page order. Each landing section carries
 * `data-chapter="<id>"`; the 3D world blends between these poses as the
 * section boundaries cross the middle of the viewport.
 *
 * Pure data (no three.js) so it is cheap to import from the page and easy to
 * tune: every number below is a camera or rig target, not an animation.
 */
export const CHAPTERS = [
  'hero',
  'world',
  'demo',
  'features',
  'inside',
  'brain',
  'cad',
  'bye',
] as const;

export type ChapterId = (typeof CHAPTERS)[number];

export const CHAPTER_LABELS: Record<ChapterId, string> = {
  hero: 'Hello',
  world: 'Signals',
  demo: 'Demo',
  features: 'Features',
  inside: 'Inside',
  brain: 'Brain',
  cad: 'Build',
  bye: 'Bye',
};

/** Face BMO switches to when a chapter takes over (null = leave it alone). */
export const CHAPTER_MOOD: Record<ChapterId, FaceMood | null> = {
  hero: 'idle',
  world: null, // the mood rows drive the face here
  demo: 'idle',
  features: 'idle',
  inside: 'bashful', // being looked inside is a little embarrassing
  brain: 'think',
  cad: 'idle',
  bye: 'laugh',
};

export interface Pose {
  /** Camera azimuth around the target, degrees (0 = straight at BMO's face). */
  theta: number;
  /** Camera elevation, degrees. */
  phi: number;
  /** Camera distance from the target, world units (1 unit ≈ 1 cm of BMO). */
  dist: number;
  tx: number;
  ty: number;
  tz: number;
  /** Lens shift: where BMO sits on screen, as a fraction of the viewport. */
  shiftX: number;
  shiftY: number;
  /** BMO body yaw, degrees. */
  yaw: number;
  /** 0..1 rig states. */
  explode: number;
  flat: number;
  bed: number;
  brain: number;
  organs: number;
  /** Turntable speed, radians per second. */
  spin: number;
  /** 0..1 arm wave. */
  wave: number;
  /** 0..1 contact-shadow strength. */
  shadow: number;
  /** Backdrop gradient + glow (CSS hex). */
  bgTop: string;
  bgBottom: string;
  glow: string;
  /** 0..1 blueprint grid over the backdrop. */
  grid: number;
  /** Floating dust colour. */
  dust: string;
}

const BASE: Pose = {
  theta: 0,
  phi: 4,
  dist: 44,
  tx: 0,
  ty: -1,
  tz: 0,
  shiftX: 0,
  shiftY: 0,
  yaw: 0,
  explode: 0,
  flat: 0,
  bed: 0,
  brain: 0,
  organs: 0,
  spin: 0,
  wave: 0,
  shadow: 1,
  bgTop: '#cdeedf',
  bgBottom: '#f7f1dc',
  glow: '#fff6cc',
  grid: 0,
  dust: '#ffffff',
};

/** Wide (desktop / landscape) poses. */
export const POSES: Record<ChapterId, Pose> = {
  hero: { ...BASE, yaw: -16, dist: 43, shiftY: -0.02 },
  world: {
    ...BASE,
    theta: -8,
    phi: 6,
    dist: 42,
    shiftX: -0.22,
    yaw: 24,
    bgTop: '#d6efff',
    bgBottom: '#f4f7e8',
  },
  demo: {
    ...BASE,
    phi: 6,
    dist: 60,
    shiftX: 0.34,
    shiftY: -0.1,
    yaw: -40,
    shadow: 0.35,
    bgTop: '#15251f',
    bgBottom: '#08120f',
    glow: '#1f4a3f',
    dust: '#8de3ff',
  },
  features: {
    ...BASE,
    phi: 9,
    dist: 47,
    shiftX: 0.27,
    spin: 0.32,
    bgTop: '#f8f3e4',
    bgBottom: '#e2f3e7',
    glow: '#ffffff',
  },
  inside: {
    ...BASE,
    theta: -54,
    phi: 16,
    dist: 60,
    tz: 2,
    ty: 0,
    shiftX: 0.17,
    explode: 1,
    organs: 1,
    shadow: 0,
    bgTop: '#0f2a28',
    bgBottom: '#061517',
    glow: '#1b5a52',
    grid: 1,
    dust: '#7fe8d0',
  },
  brain: {
    ...BASE,
    theta: 14,
    phi: -3,
    dist: 54,
    ty: 1.6,
    shiftX: -0.2,
    yaw: 14,
    brain: 1,
    shadow: 0,
    bgTop: '#0d1530',
    bgBottom: '#04060f',
    glow: '#2a3a92',
    dust: '#b9c9ff',
  },
  cad: {
    ...BASE,
    theta: 22,
    phi: 50,
    dist: 64,
    ty: -6,
    shiftX: 0.2,
    flat: 1,
    bed: 1,
    shadow: 0,
    bgTop: '#f5efe1',
    bgBottom: '#e5dcc6',
    glow: '#fffaf0',
  },
  bye: {
    ...BASE,
    dist: 41,
    shiftY: 0.02,
    wave: 1,
    bgTop: '#c4ecdc',
    bgBottom: '#fff0bb',
    glow: '#ffffff',
  },
};

/**
 * Narrow (portrait / phone) overrides. BMO is centred and lifted into the top
 * of the viewport so the text panels can scroll over the lower half.
 */
export const NARROW_POSES: Record<ChapterId, Partial<Pose>> = {
  hero: { shiftX: 0, shiftY: 0.1, dist: 50 },
  world: { shiftX: 0, shiftY: 0.2, dist: 52, yaw: 12, theta: 0 },
  demo: { shiftX: 0, shiftY: 0.24, dist: 60, yaw: -12 },
  features: { shiftX: 0, shiftY: 0.22, dist: 56 },
  inside: { shiftX: 0, shiftY: 0.18, dist: 76 },
  brain: { shiftX: 0, shiftY: 0.2, dist: 64 },
  cad: { shiftX: 0, shiftY: 0.18, dist: 80 },
  bye: { shiftX: 0, shiftY: 0.14, dist: 50 },
};

/** Hardware "organs" the Inside chapter can highlight. */
export type OrganId = 'tft' | 'esp32' | 'mic' | 'speaker' | 'touch' | 'heart';

/** Viewports narrower than this use NARROW_POSES (keep in sync with CSS). */
export const NARROW_MAX_WIDTH = 899;

/** Background tint per face while the Signals chapter is on screen. */
export const MOOD_TINT: Record<FaceMood, string> = {
  boot: '#d6efff',
  idle: '#d6efff',
  touch: '#fff0b8',
  listen: '#cdeeff',
  think: '#d3f7e6',
  talk: '#ffdccf',
  bashful: '#e6ddff',
  laugh: '#fff0b8',
};
