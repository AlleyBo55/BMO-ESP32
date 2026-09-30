/**
 * The BMO world runtime: one fixed, transparent WebGL canvas behind the page.
 *
 * Loaded with a dynamic import after first paint, so neither this nor three.js
 * is on the landing's critical path. Native scrolling is never hijacked: the
 * page scrolls normally and the world reads `scrollY`, blends between chapter
 * poses (see chapters.ts) and damps toward them every frame.
 */
import {
  Color,
  DirectionalLight,
  HemisphereLight,
  NeutralToneMapping,
  PMREMGenerator,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { ShaderMaterial } from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import {
  CHAPTERS,
  CHAPTER_MOOD,
  MOOD_TINT,
  NARROW_MAX_WIDTH,
  NARROW_POSES,
  POSES,
} from './chapters';
import type { ChapterId, OrganId, Pose } from './chapters';
import { FaceRenderer, talkEnvelope } from './faceRenderer';
import type { FaceMood } from './faceRenderer';
import {
  FLOOR_Y,
  HEART_BRAIN_POS,
  SCREEN_SLIDE,
  buildBmo,
  setShaderColor,
  updateWire,
} from './model';
import type { OrganRig } from './model';
import type { Cue } from './sound';

export interface BmoWorldOptions {
  canvas: HTMLCanvasElement;
  /** Fixed backdrop; receives --bg-top, --bg-bottom, --glow, --glow-x/y, --grid. */
  backdrop: HTMLElement;
  /** Landing sections in page order, each with `data-chapter`. */
  sections: HTMLElement[];
  /** Organ labels, pinned over their 3D anchors during the Inside chapter. */
  labels: Partial<Record<OrganId, HTMLElement>>;
  /** Speech bubble, pinned above BMO's head while it talks. */
  bubble: HTMLElement | null;
  /** Lines BMO "replies" with after a hold-to-talk. */
  replies: readonly string[];
  onReady(): void;
  onError(): void;
  onMood(mood: FaceMood): void;
  onSpeech(text: string | null): void;
  onCue(cue: Cue, text?: string): void;
}

export interface BmoWorld {
  /** Base face (mood chips, Signals rows). Transient reactions still win. */
  setMood(mood: FaceMood): void;
  /** Start a touch; held past ~0.4 s it becomes listening (push-to-talk). */
  press(): void;
  /** End a touch: tap → surprise (3 fast taps → laugh); hold → think → talk. */
  release(): void;
  highlightOrgan(id: OrganId | null): void;
  highlightNode(index: number | null): void;
  celebrate(): void;
  setPaused(paused: boolean): void;
  dispose(): void;
}

const NUM_KEYS = [
  'theta',
  'phi',
  'dist',
  'tx',
  'ty',
  'tz',
  'shiftX',
  'shiftY',
  'yaw',
  'explode',
  'flat',
  'bed',
  'brain',
  'organs',
  'spin',
  'wave',
  'shadow',
  'grid',
] as const;
const COLOR_KEYS = ['bgTop', 'bgBottom', 'glow', 'dust'] as const;
type LivePose = Record<(typeof NUM_KEYS)[number], number> &
  Record<(typeof COLOR_KEYS)[number], Color>;

interface Step {
  mood: FaceMood;
  ms: number;
  speech?: string;
  /** Survives setMood() (the quest celebration). */
  sticky?: boolean;
}

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const HOLD_MS = 380;
const BOOT_MS = 1500;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const smooth = (x: number): number => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};
const easeOutCubic = (x: number): number => 1 - Math.pow(1 - clamp(x, 0, 1), 3);

function toLive(p: Pose): LivePose {
  const live = {} as LivePose;
  for (const k of NUM_KEYS) live[k] = p[k];
  for (const k of COLOR_KEYS) {
    const c = new Color();
    setShaderColor(c, p[k]);
    live[k] = c;
  }
  return live;
}

function copyLive(out: LivePose, src: LivePose): void {
  for (const k of NUM_KEYS) out[k] = src[k];
  for (const k of COLOR_KEYS) out[k].copy(src[k]);
}

function blendInto(out: LivePose, a: LivePose, b: LivePose, t: number): void {
  for (const k of NUM_KEYS) out[k] = a[k] + (b[k] - a[k]) * t;
  for (const k of COLOR_KEYS) out[k].copy(a[k]).lerp(b[k], t);
}

function dampInto(cur: LivePose, target: LivePose, k: number): void {
  for (const key of NUM_KEYS) cur[key] += (target[key] - cur[key]) * k;
  for (const key of COLOR_KEYS) cur[key].lerp(target[key], k);
}

function uniform<T>(material: ShaderMaterial, name: string): { value: T } {
  const u = material.uniforms[name];
  if (!u) throw new Error(`BMO world: missing uniform ${name}`);
  return u as { value: T };
}

const cssColor = (c: Color): string =>
  `rgb(${Math.round(c.r * 255)} ${Math.round(c.g * 255)} ${Math.round(c.b * 255)})`;

export function createBmoWorld(opts: BmoWorldOptions): BmoWorld {
  const { canvas, backdrop, sections, labels, bubble } = opts;

  // --- Renderer, lights, environment ------------------------------------------
  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  });
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = NeutralToneMapping;
  renderer.toneMappingExposure = 1.05;
  let dpr = Math.min(window.devicePixelRatio || 1, 1.75);
  renderer.setPixelRatio(dpr);

  const scene = new Scene();
  const room = new RoomEnvironment();
  const pmrem = new PMREMGenerator(renderer);
  const envTarget = pmrem.fromScene(room, 0.04);
  scene.environment = envTarget.texture;
  scene.environmentIntensity = 0.9;
  pmrem.dispose();
  room.dispose();

  scene.add(new HemisphereLight(0xffffff, 0x9cc9b8, 0.55));
  const key = new DirectionalLight(0xffffff, 1.5);
  key.position.set(9, 16, 14);
  const rim = new DirectionalLight(0xd4fff0, 0.8);
  rim.position.set(-14, 7, -10);
  scene.add(key, rim);

  const camera = new PerspectiveCamera(30, 1, 1, 400);

  // --- BMO ---------------------------------------------------------------------
  const face = new FaceRenderer();
  const rig = buildBmo(face.pixels);
  scene.add(rig.root, rig.constellation.group, rig.dust.points);

  const organList: OrganRig[] = Object.values(rig.organs);
  const heartPart = rig.organs.heart.part;
  const heartHardware = rig.organs.heart.hardware;
  const uScreenTime = uniform<number>(rig.screen.material, 'uTime');
  const uGlitch = uniform<number>(rig.screen.material, 'uGlitch');
  const uPower = uniform<number>(rig.screen.material, 'uPower');
  const uDustTime = uniform<number>(rig.dust.material, 'uTime');
  const uDustRatio = uniform<number>(rig.dust.material, 'uPixelRatio');
  const uDustColor = uniform<Color>(rig.dust.material, 'uColor');
  const uDustOpacity = uniform<number>(rig.dust.material, 'uOpacity');
  const uStarTime = uniform<number>(rig.constellation.material, 'uTime');
  const uStarRatio = uniform<number>(rig.constellation.material, 'uPixelRatio');
  const uStarOpacity = uniform<number>(rig.constellation.material, 'uOpacity');

  // --- Poses ---------------------------------------------------------------------
  const wideLive = CHAPTERS.map((id) => toLive(POSES[id]));
  const narrowLive = CHAPTERS.map((id) => toLive({ ...POSES[id], ...NARROW_POSES[id] }));
  const worldIndex = CHAPTERS.indexOf('world');
  const sectionChapter = sections.map((el) =>
    Math.max(0, CHAPTERS.indexOf((el.dataset.chapter ?? 'hero') as ChapterId)),
  );
  const target = toLive(POSES.hero);
  const cur = toLive(POSES.hero);
  const tops: number[] = sections.map(() => 0);

  // --- Mutable state ---------------------------------------------------------------
  let vw = 0;
  let vh = 0;
  let narrow = window.innerWidth <= NARROW_MAX_WIDTH;
  let sizeDirty = true;
  let measureDirty = true;
  let first = true;
  let readyFired = false;
  let paused = false;
  let disposed = false;
  let lastMs = performance.now();
  let t = 0;
  let perfFrames = 0;
  let perfAcc = 0;

  const pointer = new Vector2(0, 0);
  let lastPointerMove = -1e9;
  let overCanvas = false;
  let hoverDirty = false;
  let hovering = false;
  let pressPointer: number | null = null;

  let baseMood: FaceMood = 'idle';
  let queue: Step[] = [{ mood: 'boot', ms: BOOT_MS }];
  let stepStart = performance.now();
  let speaking = false;
  let talkStart = 0;
  let pressedAt = -1;
  let holding = false;
  let taps: number[] = [];
  let lastMood: FaceMood | null = null;
  let lastChapter = -1;
  let glitchUntil = 0;
  let sparkleUntil = 0;
  let waveBoostUntil = 0;
  let replyIndex = Math.floor(Math.random() * Math.max(1, opts.replies.length));
  let lastFace = -1e9;
  let faceGlitch = 0;
  const bootStart = performance.now();

  let hiOrgan: OrganId | null = null;
  let hiNode: number | null = null;
  let lookYaw = 0;
  let lookPitch = 0;
  let spinAngle = 0;
  let waveLevel = 0;
  let squashX = 0;
  let squashV = 0;
  let squashTarget = 0;
  let hopY = 0;
  let hopV = 0;
  let labelsShown = false;
  let lastBackdrop = '';
  let lastGlow = '';

  const raycaster = new Raycaster();
  const ndc = new Vector2();
  const v = new Vector3();
  const scratch = { a: new Vector3(), b: new Vector3(), m: new Vector3() };
  const lookTarget = new Vector3();
  const baseEdge = new Color('#6fe0c6').multiplyScalar(0.55);
  const hiEdge = new Color('#ffe36d');
  const edgeTmp = new Color();

  // --- Measurement -------------------------------------------------------------
  function resize(): void {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    sizeDirty = false;
    if (w === vw && h === vh) return;
    vw = w;
    vh = h;
    narrow = window.innerWidth <= NARROW_MAX_WIDTH;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    measureDirty = true;
  }

  function measure(): void {
    measureDirty = false;
    const sy = window.scrollY;
    sections.forEach((el, i) => {
      tops[i] = el.getBoundingClientRect().top + sy;
    });
  }

  /** Blend the two chapter poses around the viewport's centre line. */
  function computeTarget(): number {
    const set = narrow ? narrowLive : wideLive;
    const n = sections.length;
    if (n === 0) {
      copyLive(target, set[0]!);
      return 0;
    }
    const viewH = window.innerHeight;
    const center = window.scrollY + viewH * 0.5;
    const w = viewH * 0.36;
    let i = 0;
    while (i + 1 < n && tops[i + 1]! <= center) i++;
    let a = i;
    let b = i;
    let x = 0;
    if (i + 1 < n && center > tops[i + 1]! - w) {
      b = i + 1;
      x = smooth((center - (tops[i + 1]! - w)) / (2 * w));
    } else if (i > 0 && center < tops[i]! + w) {
      a = i - 1;
      x = smooth((center - (tops[i]! - w)) / (2 * w));
    }
    blendInto(target, set[sectionChapter[a]!]!, set[sectionChapter[b]!]!, x);
    return sectionChapter[x < 0.5 ? a : b]!;
  }

  // --- Face sequencing ----------------------------------------------------------
  function currentMood(): FaceMood {
    if (holding) return 'listen';
    return queue[0]?.mood ?? baseMood;
  }

  function enterStep(now: number): void {
    const step = queue[0];
    if (speaking && !step?.speech) {
      speaking = false;
      opts.onSpeech(null);
    }
    if (step?.speech) {
      speaking = true;
      talkStart = now;
      opts.onSpeech(step.speech);
      opts.onCue('talk', step.speech);
    } else if (step?.mood === 'talk') {
      talkStart = now;
    }
  }

  function play(steps: Step[], now: number): void {
    queue = steps;
    stepStart = now;
    enterStep(now);
  }

  function advance(now: number): void {
    let step = queue[0];
    while (step && now - stepStart >= step.ms) {
      stepStart += step.ms;
      queue.shift();
      enterStep(now);
      step = queue[0];
    }
  }

  function nextReply(): string {
    const { replies } = opts;
    if (replies.length === 0) return 'Hello, friend!';
    replyIndex = (replyIndex + 1) % replies.length;
    return replies[replyIndex] ?? 'Hello, friend!';
  }

  function press(): void {
    if (pressedAt >= 0 || disposed) return;
    pressedAt = performance.now();
    squashTarget = 1;
  }

  function release(): void {
    if (pressedAt < 0) return;
    const now = performance.now();
    pressedAt = -1;
    squashTarget = 0;
    if (holding) {
      holding = false;
      const reply = nextReply();
      const talkMs = clamp(900 + reply.length * 55, 1800, 5200);
      play(
        [
          { mood: 'think', ms: 1100 },
          { mood: 'talk', ms: talkMs, speech: reply },
        ],
        now,
      );
      opts.onCue('think');
      return;
    }
    taps = taps.filter((at) => now - at < 900);
    taps.push(now);
    if (taps.length >= 3) {
      taps = [];
      play([{ mood: 'laugh', ms: 1800 }], now);
      opts.onCue('laugh');
    } else {
      play([{ mood: 'touch', ms: 1200 }], now);
      opts.onCue('tap');
    }
    hopV = 7.5;
  }

  function cancelPress(): void {
    pressedAt = -1;
    squashTarget = 0;
    holding = false;
  }

  // --- Input -------------------------------------------------------------------
  function hitsBmo(clientX: number, clientY: number): boolean {
    const rect = canvas.getBoundingClientRect();
    ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    return raycaster.intersectObjects(rig.hitTargets, false).length > 0;
  }

  const onPointerMove = (e: PointerEvent): void => {
    pointer.set(
      (e.clientX / Math.max(1, window.innerWidth)) * 2 - 1,
      -(e.clientY / Math.max(1, window.innerHeight)) * 2 + 1,
    );
    lastPointerMove = performance.now();
    hoverDirty = true;
  };
  const onCanvasEnter = (): void => {
    overCanvas = true;
    hoverDirty = true;
  };
  const onCanvasLeave = (): void => {
    overCanvas = false;
    hoverDirty = true;
  };
  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || pressPointer !== null) return;
    if (!hitsBmo(e.clientX, e.clientY)) return;
    pressPointer = e.pointerId;
    press();
  };
  const onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== pressPointer) return;
    pressPointer = null;
    release();
  };
  const onPointerCancel = (e: PointerEvent): void => {
    if (e.pointerId !== pressPointer) return;
    pressPointer = null;
    cancelPress();
  };
  const onContextMenu = (e: Event): void => {
    if (pressPointer !== null) e.preventDefault();
  };
  const onResize = (): void => {
    sizeDirty = true;
    measureDirty = true;
  };
  const onVisibility = (): void => updateLoop();
  const onContextLost = (e: Event): void => {
    e.preventDefault();
    renderer.setAnimationLoop(null);
    opts.onError();
  };

  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVisibility);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerenter', onCanvasEnter);
  canvas.addEventListener('pointerleave', onCanvasLeave);
  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('webglcontextlost', onContextLost);

  const resizeObserver = new ResizeObserver(() => {
    sizeDirty = true;
    measureDirty = true;
  });
  resizeObserver.observe(canvas);
  for (const el of sections) resizeObserver.observe(el);

  // --- Per-frame helpers ----------------------------------------------------------
  function paintEdges(): void {
    const c = rig.constellation;
    c.edges.forEach(([a, b], k) => {
      const h = Math.max(c.highlight[a] ?? 0, b >= 0 ? (c.highlight[b] ?? 0) : 0);
      edgeTmp.copy(baseEdge).lerp(hiEdge, h);
      c.edgeColors.set(
        [edgeTmp.r, edgeTmp.g, edgeTmp.b, edgeTmp.r, edgeTmp.g, edgeTmp.b],
        k * 6,
      );
    });
    c.edgeColorAttr.needsUpdate = true;
  }
  paintEdges();

  function project(obj: { getWorldPosition(target: Vector3): Vector3 }): Vector3 {
    obj.getWorldPosition(v);
    return v.project(camera);
  }

  function placeOverlay(el: HTMLElement, p: Vector3): void {
    const x = (p.x * 0.5 + 0.5) * vw;
    const y = (-p.y * 0.5 + 0.5) * vh;
    el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    const side = x > vw * 0.66 ? 'left' : 'right';
    if (el.dataset.side !== side) el.dataset.side = side;
  }

  // --- Frame -------------------------------------------------------------------
  function frame(): void {
    const now = performance.now();
    const rawDt = Math.max(0, (now - lastMs) / 1000);
    const dt = Math.min(rawDt, 0.05);
    lastMs = now;
    t += dt;

    if (sizeDirty) resize();
    if (vw === 0) return;
    if (measureDirty) measure();

    // Adaptive resolution: step the pixel ratio down on slow devices.
    perfAcc += rawDt;
    perfFrames += 1;
    if (perfFrames >= 90) {
      if (perfAcc / perfFrames > 0.026 && dpr > 1) {
        dpr = Math.max(1, dpr - 0.25);
        renderer.setPixelRatio(dpr);
      }
      perfFrames = 0;
      perfAcc = 0;
    }

    // Chapter + pose.
    const chapter = computeTarget();
    if (chapter !== lastChapter) {
      const chapterMood = CHAPTER_MOOD[CHAPTERS[chapter] ?? 'hero'];
      if (chapterMood) {
        baseMood = chapterMood;
        // On the very first frame the boot sequence keeps playing.
        if (lastChapter !== -1 && !queue[0]?.sticky && !holding) {
          queue = [];
          enterStep(now);
        }
      }
      lastChapter = chapter;
    }
    if (first) {
      copyLive(cur, target);
      cur.yaw = 0; // turn in from the flat-on poster while the screen boots
      first = false;
    } else {
      dampInto(cur, target, 1 - Math.exp(-dt * 4.2));
    }

    // Touch → hold → listen.
    if (pressedAt >= 0 && !holding && now - pressedAt >= HOLD_MS) {
      holding = true;
      queue = [];
      enterStep(now);
      opts.onCue('listen');
    }
    advance(now);
    const mood = currentMood();
    if (mood !== lastMood) {
      lastMood = mood;
      glitchUntil = now + 170;
      if (mood === 'talk' && !speaking) talkStart = now;
      setShaderColor(wideLive[worldIndex]!.bgTop, MOOD_TINT[mood]);
      setShaderColor(narrowLive[worldIndex]!.bgTop, MOOD_TINT[mood]);
      opts.onMood(mood);
    }

    // Camera first: everything below projects through it. (Projecting through
    // an unplaced camera divides by zero, and a NaN yaw hides BMO for good.)
    const distFit = narrow ? clamp(0.56 / Math.max(camera.aspect, 0.3), 1, 1.5) : 1;
    const dist = cur.dist * distFit;
    const th = cur.theta * DEG;
    const ph = cur.phi * DEG;
    lookTarget.set(cur.tx, cur.ty, cur.tz);
    camera.position.set(
      lookTarget.x + dist * Math.sin(th) * Math.cos(ph) + pointer.x * 0.9,
      lookTarget.y + dist * Math.sin(ph) + pointer.y * 0.5,
      lookTarget.z + dist * Math.cos(th) * Math.cos(ph),
    );
    camera.lookAt(lookTarget);
    camera.setViewOffset(vw, vh, -cur.shiftX * vw, cur.shiftY * vh, vw, vh);
    camera.updateMatrixWorld();

    const explodeE = smooth(cur.explode);
    const flatE = clamp(cur.flat, 0, 1);
    const brainE = smooth(cur.brain);
    const bedE = easeOutCubic(cur.bed);
    const k6 = 1 - Math.exp(-dt * 6);

    // Parts: home → exploded → flat on the plate (staggered, with a lift arc).
    for (const p of rig.parts) {
      const fi = smooth((flatE - p.delay) / 0.66);
      p.obj.position.copy(p.homePos).addScaledVector(p.explode, explodeE);
      if (fi > 0) {
        p.obj.position.lerp(p.flatPos, fi);
        p.obj.position.y += Math.sin(Math.PI * fi) * (3 + p.delay * 8);
        p.obj.quaternion.slerpQuaternions(p.homeQuat, p.flatQuat, fi);
      } else {
        p.obj.quaternion.copy(p.homeQuat);
      }
      if (p.organ) {
        const s = 1 - fi;
        p.obj.scale.setScalar(Math.max(s, 0.0001));
        p.obj.visible = s > 0.002;
      }
    }

    // The Wonder Heart floats up above BMO's head for the Brain chapter.
    const beat =
      Math.pow(Math.max(0, Math.sin(t * 5.2)), 12) +
      0.6 * Math.pow(Math.max(0, Math.sin(t * 5.2 - 0.7)), 12);
    heartPart.obj.position.lerp(HEART_BRAIN_POS, brainE);
    heartPart.obj.position.y += Math.sin(t * 1.6) * 0.18 * brainE;
    heartHardware.scale.setScalar(1 + 0.12 * beat);
    heartHardware.rotation.y = brainE * Math.sin(t * 0.8) * 0.5;
    rig.heartGlow.material.opacity = 0.45 + 0.45 * beat;

    for (const o of organList) {
      const show = explodeE > 0.004 || (o.id === 'heart' && brainE > 0.01);
      if (o.hardware.visible !== show) o.hardware.visible = show;
      const goal = o.id === hiOrgan ? 1 : 0;
      o.level += (goal - o.level) * k6;
      const pulse = o.level * (0.55 + 0.25 * Math.sin(t * 5));
      for (const m of o.materials) {
        if (o.id === 'heart') {
          m.emissiveIntensity = 0.5 + 0.4 * beat + pulse;
        } else {
          m.emissive.copy(o.accent);
          m.emissiveIntensity = pulse;
        }
      }
    }

    rig.screen.slide.position.z =
      SCREEN_SLIDE.home + (SCREEN_SLIDE.open - SCREEN_SLIDE.home) * explodeE;

    const wiresOn = explodeE > 0.02 && flatE < 0.5;
    for (const w of rig.wires) {
      w.line.visible = wiresOn;
      if (wiresOn) {
        updateWire(w, scratch);
        w.material.opacity = explodeE * 0.85;
      }
    }

    // Squash-and-stretch spring + hop.
    squashV += (220 * (squashTarget - squashX) - 16 * squashV) * dt;
    squashX += squashV * dt;
    if (hopY > 0 || hopV > 0) {
      hopV -= 38 * dt;
      hopY = Math.max(0, hopY + hopV * dt);
      if (hopY === 0 && hopV < 0) {
        squashV += 5;
        hopV = 0;
      }
    }
    const breathe = Math.sin(t * 2.1) * 0.008 * (1 - flatE);
    rig.squash.scale.set(1 + squashX * 0.06, 1 - squashX * 0.09 + breathe, 1 + squashX * 0.06);
    rig.squash.position.y = FLOOR_Y + hopY;
    rig.squash.rotation.z = mood === 'laugh' ? Math.sin(t * 28) * 0.025 : 0;

    // Pointer: BMO leans toward it and the face glances at it.
    const lookAmount = (1 - flatE) * (1 - explodeE * 0.8) * (1 - brainE * 0.5);
    const bmoNdc = project(rig.root);
    const bx = Number.isFinite(bmoNdc.x) ? bmoNdc.x : 0;
    const by = Number.isFinite(bmoNdc.y) ? bmoNdc.y : 0;
    const active = now - lastPointerMove < 6000;
    const px = active ? pointer.x : Math.sin(t * 0.45) * 0.35 + bx;
    const py = active ? pointer.y : by + 0.1;
    lookYaw += (clamp(px - bx, -1, 1) * 16 * lookAmount - lookYaw) * k6;
    lookPitch += (clamp(-(py - by), -1, 1) * 5 * lookAmount - lookPitch) * k6;
    if (!Number.isFinite(lookYaw)) lookYaw = 0;
    if (!Number.isFinite(lookPitch)) lookPitch = 0;
    if (cur.spin > 0.02) spinAngle += cur.spin * dt;
    else spinAngle += (Math.round(spinAngle / TAU) * TAU - spinAngle) * k6;
    rig.root.rotation.y = (cur.yaw + lookYaw) * DEG + spinAngle;
    rig.squash.rotation.x = lookPitch * DEG;

    const waveGoal = Math.max(cur.wave, now < waveBoostUntil ? 1 : 0) * (1 - flatE);
    waveLevel += (waveGoal - waveLevel) * (1 - Math.exp(-dt * 4));
    rig.armR.rotation.z =
      waveLevel * (2 + 0.35 * Math.sin(t * 9)) + Math.sin(t * 1.4) * 0.05 * (1 - waveLevel);
    rig.armL.rotation.z = -Math.sin(t * 1.4 + 1) * 0.05 * (1 - flatE);

    // Shadow, plate, constellation, dust.
    rig.shadow.material.opacity =
      cur.shadow * (1 - flatE) * (1 - Math.min(hopY * 0.5, 0.6));
    rig.shadow.mesh.scale.setScalar(1 - Math.min(hopY * 0.12, 0.3));

    rig.bed.group.visible = cur.bed > 0.01;
    rig.bed.material.opacity = Math.min(1, cur.bed * 1.4);
    rig.bed.group.position.y = FLOOR_Y - 0.26 - (1 - bedE) * 3;

    const c = rig.constellation;
    c.group.visible = brainE > 0.01;
    if (c.group.visible) {
      c.group.rotation.y += dt * 0.06;
      uStarOpacity.value = brainE;
      c.edgeMaterial.opacity = brainE * 0.6;
      let changed = false;
      for (let i = 0; i < c.nodeCount; i++) {
        const goal = i === hiNode ? 1 : 0;
        const val = c.highlight[i] ?? 0;
        const next = val + (goal - val) * k6;
        if (Math.abs(next - val) > 1e-4) {
          c.highlight[i] = next;
          changed = true;
        }
      }
      if (changed) {
        c.highlightAttr.needsUpdate = true;
        paintEdges();
      }
    }
    uStarTime.value = t;
    uStarRatio.value = renderer.getPixelRatio();

    uDustTime.value = t;
    uDustRatio.value = renderer.getPixelRatio();
    uDustColor.value.copy(cur.dust);
    const lum = 0.2126 * cur.bgTop.r + 0.7152 * cur.bgTop.g + 0.0722 * cur.bgTop.b;
    uDustOpacity.value = 0.35 + 0.45 * (1 - smooth((lum - 0.25) / 0.35));
    rig.dust.points.position.x = -pointer.x * 1.2;

    // Face at ~30 fps, like the device.
    if (now - lastFace >= 33) {
      lastFace = now;
      const head = project(rig.headAnchor);
      const gx = active ? pointer.x - head.x : Math.sin(t * 0.5) * 0.4;
      const gy = active ? -(pointer.y - head.y) : 0;
      const step = queue[0];
      faceGlitch = face.render({
        mood,
        now,
        lookX: clamp(gx * 1.8, -1, 1),
        lookY: clamp(gy * 1.8, -1, 1),
        talkLevel: mood === 'talk' ? talkEnvelope(now - talkStart) : 0,
        boot: step?.mood === 'boot' ? (now - stepStart) / step.ms : 1,
        sparkle: now < sparkleUntil,
      });
      rig.screen.texture.needsUpdate = true;
    }
    uScreenTime.value = t;
    uGlitch.value = Math.max(faceGlitch, now < glitchUntil ? 0.6 : 0);
    uPower.value = clamp((now - bootStart) / 700, 0, 1);

    // Hover cursor.
    if (hoverDirty) {
      hoverDirty = false;
      const next = overCanvas && hitsBmo(
        ((pointer.x + 1) / 2) * window.innerWidth,
        ((1 - pointer.y) / 2) * window.innerHeight,
      );
      if (next !== hovering) {
        hovering = next;
        canvas.style.cursor = next ? 'pointer' : '';
      }
    }

    // DOM overlays: backdrop colours, organ labels, speech bubble.
    const bg = `${cssColor(cur.bgTop)}|${cssColor(cur.bgBottom)}|${cssColor(cur.glow)}|${cur.grid.toFixed(3)}`;
    if (bg !== lastBackdrop) {
      lastBackdrop = bg;
      backdrop.style.setProperty('--bg-top', cssColor(cur.bgTop));
      backdrop.style.setProperty('--bg-bottom', cssColor(cur.bgBottom));
      backdrop.style.setProperty('--glow', cssColor(cur.glow));
      backdrop.style.setProperty('--grid', cur.grid.toFixed(3));
    }
    const gxPct = ((bx * 0.5 + 0.5) * 100).toFixed(1);
    const gyPct = ((-by * 0.5 + 0.5) * 100 - 6).toFixed(1);
    const glowPos = `${gxPct}|${gyPct}`;
    if (glowPos !== lastGlow) {
      lastGlow = glowPos;
      backdrop.style.setProperty('--glow-x', `${gxPct}%`);
      backdrop.style.setProperty('--glow-y', `${gyPct}%`);
    }

    const organsVis = cur.organs * (1 - flatE);
    if (organsVis > 0.02 || labelsShown) {
      labelsShown = organsVis > 0.02;
      for (const o of organList) {
        const el = labels[o.id];
        if (!el) continue;
        if (!labelsShown) {
          el.style.opacity = '0';
          continue;
        }
        const p = project(o.anchor);
        placeOverlay(el, p);
        el.style.opacity = p.z < 1 ? organsVis.toFixed(3) : '0';
      }
    }
    if (bubble && speaking) placeOverlay(bubble, project(rig.headAnchor));

    renderer.render(scene, camera);
    if (!readyFired) {
      readyFired = true;
      opts.onReady();
      opts.onCue('boot');
    }
  }

  function updateLoop(): void {
    const run = !paused && !disposed && !document.hidden;
    if (run) lastMs = performance.now();
    renderer.setAnimationLoop(run ? frame : null);
  }
  updateLoop();

  return {
    setMood(mood: FaceMood): void {
      baseMood = mood;
      if (!queue[0]?.sticky && !holding) {
        queue = [];
        enterStep(performance.now());
      }
    },
    press,
    release,
    highlightOrgan(id: OrganId | null): void {
      hiOrgan = id;
    },
    highlightNode(index: number | null): void {
      hiNode = index;
    },
    celebrate(): void {
      const now = performance.now();
      play([{ mood: 'laugh', ms: 2600, sticky: true }], now);
      sparkleUntil = now + 2600;
      waveBoostUntil = now + 2600;
      hopV = 8;
    },
    setPaused(next: boolean): void {
      paused = next;
      updateLoop();
    },
    dispose(): void {
      disposed = true;
      renderer.setAnimationLoop(null);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerenter', onCanvasEnter);
      canvas.removeEventListener('pointerleave', onCanvasLeave);
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      resizeObserver.disconnect();
      canvas.style.cursor = '';
      for (const el of Object.values(labels)) if (el) el.style.opacity = '0';
      rig.dispose();
      envTarget.dispose();
      renderer.dispose();
    },
  };
}
