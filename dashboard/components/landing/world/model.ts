/**
 * Procedural BMO: every mesh is built from primitives at runtime, so the hero
 * costs zero model downloads (the real CAD GLBs are ~5.7 MB and stay behind
 * the opt-in CAD viewer). Proportions follow the compact CAD shell: ~80 × 100
 * × 52 mm with the control layout from `cad-preview.html`, in units of 1 cm.
 *
 * Every part carries three transforms the scene blends between:
 *   home     assembled BMO
 *   explode  home + offset, for the Inside chapter's exploded view
 *   flat     laid out on a Bambu Lab A1 plate, for the Build chapter
 */
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CapsuleGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  DataTexture,
  DoubleSide,
  Euler,
  ExtrudeGeometry,
  Group,
  Line,
  LineBasicMaterial,
  LineSegments,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NearestFilter,
  Object3D,
  PlaneGeometry,
  Points,
  Quaternion,
  RGBAFormat,
  SRGBColorSpace,
  ShaderMaterial,
  Shape,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  TubeGeometry,
  Vector3,
} from 'three';
import type { Material } from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

import type { OrganId } from './chapters';
import { FACE_H, FACE_W } from './faceRenderer';

type V3 = readonly [number, number, number];

/** Feet rest here; the print plate's top surface sits at the same height. */
export const FLOOR_Y = -7;
/** Face screen offset from the TFT board: flush behind the bezel → on the glass. */
export const SCREEN_SLIDE = { home: 1.06, open: 0.24 } as const;
/**
 * Where the Wonder Heart floats during the Brain chapter. On the yaw axis, so
 * body space and the (unrotated) constellation agree on it.
 */
export const HEART_BRAIN_POS = new Vector3(0, 8.4, 0);
const HUB = HEART_BRAIN_POS;

const PALETTE = {
  shell: 0x63cdb5,
  lid: 0x4db8a2,
  bezel: 0x3fa894,
  limb: 0x55c4ad,
  window: 0x0f2c2a,
  dpad: 0xffd23f,
  triangle: 0x3f8cff,
  green: 0x52d17c,
  red: 0xff5a5f,
  navy: 0x1f4f96,
  pcb: 0x1e3a5f,
  pcbDark: 0x172333,
  chip: 0x202329,
  metal: 0xc9ced6,
  gold: 0xd8b24a,
  cone: 0x2b3036,
  flex: 0xd9973a,
  heart: 0xff6fa3,
} as const;

const ORGAN_ACCENT: Record<OrganId, string> = {
  tft: '#8de3ff',
  esp32: '#ffe36d',
  mic: '#adffe5',
  speaker: '#ffae9a',
  touch: '#c5b5ff',
  heart: '#ff7aa8',
};

export interface PartRig {
  obj: Object3D;
  homePos: Vector3;
  homeQuat: Quaternion;
  explode: Vector3;
  flatPos: Vector3;
  flatQuat: Quaternion;
  /** 0..0.4 stagger when the parts fly onto the print plate. */
  delay: number;
  /** Electronics shrink away on the print plate (they are bought, not printed). */
  organ: boolean;
}

export interface OrganRig {
  id: OrganId;
  part: PartRig;
  /** The organ's meshes; hidden while BMO is assembled (they are inside). */
  hardware: Group;
  anchor: Object3D;
  materials: MeshStandardMaterial[];
  accent: Color;
  level: number;
}

export interface WireRig {
  line: Line;
  positions: Float32Array;
  attr: BufferAttribute;
  material: LineBasicMaterial;
  from: { obj: Object3D; offset: Vector3 };
  to: { obj: Object3D; offset: Vector3 };
}

export interface ConstellationRig {
  group: Group;
  material: ShaderMaterial;
  edgeMaterial: LineBasicMaterial;
  nodeCount: number;
  highlight: Float32Array;
  highlightAttr: BufferAttribute;
  edges: ReadonlyArray<readonly [number, number]>;
  edgeColors: Float32Array;
  edgeColorAttr: BufferAttribute;
}

export interface BmoRig {
  /** Pose transform (yaw, turntable). */
  root: Group;
  /** Squash-and-stretch pivot at floor level. */
  squash: Group;
  /** All parts live here, in "body space" (origin = body centre). */
  body: Group;
  parts: PartRig[];
  organs: Record<OrganId, OrganRig>;
  screen: {
    mesh: Mesh;
    material: ShaderMaterial;
    slide: Object3D;
    texture: DataTexture;
  };
  /** Wave pivots at the shoulders. */
  armL: Object3D;
  armR: Object3D;
  hitTargets: Object3D[];
  heartGlow: Sprite;
  wires: WireRig[];
  bed: { group: Group; material: MeshStandardMaterial };
  shadow: { mesh: Mesh; material: MeshBasicMaterial };
  constellation: ConstellationRig;
  dust: { points: Points; material: ShaderMaterial };
  /** Speech bubble anchor, above the head. */
  headAnchor: Object3D;
  dispose(): void;
}

const DEG = Math.PI / 180;
const v3 = (a: V3): Vector3 => new Vector3(a[0], a[1], a[2]);
const quatDeg = (a: V3): Quaternion =>
  new Quaternion().setFromEuler(new Euler(a[0] * DEG, a[1] * DEG, a[2] * DEG));

/** Deterministic PRNG so the dust and stars look the same on every visit. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas2d(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D | null] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

/** Raw sRGB triplet for custom shaders (they skip colour management). */
export function setShaderColor(target: Color, hex: string): void {
  const n = Number.parseInt(hex.slice(1), 16);
  target.setRGB(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

// -----------------------------------------------------------------------------
// Shaders
// -----------------------------------------------------------------------------

const SCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/**
 * The ST7735, on the GPU: nearest-sampled 160×128 face, the firmware's
 * datamosh glitch bands, an LCD pixel grid that only appears once pixels are
 * big enough to resolve, and a CRT-style power-on.
 */
const SCREEN_FRAG = /* glsl */ `
uniform sampler2D uFace;
uniform float uTime;
uniform float uGlitch;
uniform float uPower;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec2 uv = vUv;
  vec2 p = (uv - 0.5) * vec2(1.25, 1.0);
  vec2 q = abs(p) - (vec2(0.625, 0.5) - 0.07);
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.07;
  float mask = 1.0 - smoothstep(-0.003, 0.003, d);

  float t = floor(uTime * 16.0);
  float band = floor(uv.y * 32.0);
  float on = step(1.0 - 0.22 * uGlitch, hash(vec2(band, t)));
  float shift = on * (hash(vec2(t, band)) - 0.5) * 0.12 * uGlitch;
  vec2 fuv = vec2(fract(uv.x + shift), 1.0 - uv.y);
  vec3 col = texture2D(uFace, fuv).rgb;
  col.r = mix(col.r, texture2D(uFace, fuv + vec2(0.012, 0.0)).r, on);
  col.b = mix(col.b, texture2D(uFace, fuv - vec2(0.012, 0.0)).b, on);

  vec2 cells = uv * vec2(${FACE_W.toFixed(1)}, ${FACE_H.toFixed(1)});
  vec2 cell = fract(cells);
  float pxSize = 1.0 / max(fwidth(cells.x), 1e-4);
  float grid = smoothstep(3.0, 8.0, pxSize) * 0.16;
  col *= 1.0 - grid * max(step(0.86, cell.x), step(0.86, cell.y));

  col *= 0.93 + 0.07 * (1.0 - dot(p, p) * 1.6);
  col *= 0.985 + 0.015 * sin(uv.y * 900.0 + uTime * 12.0);

  float w = smoothstep(0.0, 0.35, uPower);
  float h = mix(0.006, 0.52, smoothstep(0.3, 1.0, uPower));
  float vis = step(abs(uv.x - 0.5), w * 0.5) * step(abs(uv.y - 0.5), h);
  vec3 off = vec3(0.055, 0.13, 0.12);
  col = mix(off, col + (1.0 - smoothstep(0.2, 0.9, uPower)) * 0.9, vis);

  gl_FragColor = vec4(col, mask);
}`;

const DUST_VERT = /* glsl */ `
attribute float aSeed;
uniform float uTime;
uniform float uPixelRatio;
varying float vFade;
void main() {
  vec3 p = position;
  p.y = mod(p.y + uTime * (0.25 + aSeed * 0.45) + 14.0, 36.0) - 14.0;
  p.x += sin(uTime * 0.35 + aSeed * 6.2831) * 0.8;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = (2.0 + aSeed * 3.5) * uPixelRatio * (40.0 / -mv.z);
  vFade = smoothstep(-14.0, -9.0, p.y) * (1.0 - smoothstep(17.0, 22.0, p.y));
}`;

/** Square "pixel" motes, a nod to the 160×128 face. */
const DUST_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vFade;
void main() {
  vec2 c = abs(gl_PointCoord - 0.5);
  if (max(c.x, c.y) > 0.36) discard;
  gl_FragColor = vec4(uColor, uOpacity * vFade);
}`;

const STAR_VERT = /* glsl */ `
attribute float aSize;
attribute float aPhase;
attribute float aNode;
attribute float aHi;
uniform float uTime;
uniform float uPixelRatio;
uniform float uOpacity;
varying float vAlpha;
varying float vHi;
varying float vNode;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float twinkle = 0.55 + 0.45 * sin(uTime * 1.6 + aPhase);
  gl_PointSize = aSize * (1.0 + aHi * 1.2) * uPixelRatio * (70.0 / -mv.z);
  vAlpha = uOpacity * mix(twinkle, 1.0, aNode);
  vHi = aHi;
  vNode = aNode;
}`;

const STAR_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uHiColor;
varying float vAlpha;
varying float vHi;
varying float vNode;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float core = smoothstep(0.5, 0.0, d);
  float glow = pow(core, 3.0) + vNode * 0.35 * pow(core, 1.4);
  if (glow < 0.01) discard;
  gl_FragColor = vec4(mix(uColor, uHiColor, vHi), glow * vAlpha);
}`;

// -----------------------------------------------------------------------------
// Textures
// -----------------------------------------------------------------------------

function sideTextTexture(): CanvasTexture {
  const [c, g] = canvas2d(256, 96);
  if (g) {
    g.fillStyle = '#2a7f70';
    g.font = '900 76px ui-rounded, "Arial Rounded MT Bold", system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('BMO', 128, 52);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/** Textured PEI plate: dark speckle, 1 cm grid, the A1's 256 mm label. */
function bedTexture(): CanvasTexture {
  const size = 512; // 25.6 cm × 20 px/cm
  const [c, g] = canvas2d(size, size);
  if (g) {
    const rand = mulberry32(42);
    g.fillStyle = '#2a2d33';
    g.fillRect(0, 0, size, size);
    for (let i = 0; i < 2600; i++) {
      g.fillStyle = `rgba(255,255,255,${(0.02 + rand() * 0.05).toFixed(3)})`;
      g.fillRect(rand() * size, rand() * size, 1, 1);
    }
    for (let i = 0; i <= 25; i++) {
      const p = i * 20 + 6;
      g.fillStyle = i % 5 === 0 ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.05)';
      g.fillRect(p, 0, 1, size);
      g.fillRect(0, p, size, 1);
    }
    g.fillStyle = 'rgba(255,255,255,0.42)';
    g.font = '700 13px system-ui, sans-serif';
    g.fillText('BAMBU LAB A1 · 256 × 256 mm · PLA', 16, size - 16);
    g.fillStyle = '#ff8e5e';
    g.fillText('BMO COMPACT · OUTSIDE KIT', 16, 26);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function radialTexture(inner: string, outer: string): CanvasTexture {
  const [c, g] = canvas2d(128, 128);
  if (g) {
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, inner);
    grad.addColorStop(1, outer);
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

// -----------------------------------------------------------------------------
// Shapes
// -----------------------------------------------------------------------------

function heartShape(): Shape {
  const s = new Shape();
  s.moveTo(0, -0.9);
  s.bezierCurveTo(-0.2, -0.7, -1, -0.25, -1, 0.25);
  s.bezierCurveTo(-1, 0.75, -0.45, 0.95, 0, 0.55);
  s.bezierCurveTo(0.45, 0.95, 1, 0.75, 1, 0.25);
  s.bezierCurveTo(1, -0.25, 0.2, -0.7, 0, -0.9);
  return s;
}

function triangleShape(r: number): Shape {
  const s = new Shape();
  s.moveTo(0, r);
  s.lineTo(-r * 0.92, -r * 0.55);
  s.lineTo(r * 0.92, -r * 0.55);
  s.closePath();
  return s;
}

// -----------------------------------------------------------------------------
// Builder
// -----------------------------------------------------------------------------

export function buildBmo(facePixels: Uint8Array): BmoRig {
  const trash: Array<{ dispose(): void }> = [];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    trash.push(x);
    return x;
  };
  const std = (color: number, roughness = 0.46, metalness = 0): MeshStandardMaterial =>
    keep(new MeshStandardMaterial({ color, roughness, metalness }));
  const add = (
    parent: Object3D,
    geo: BufferGeometry,
    mat: Material,
    x = 0,
    y = 0,
    z = 0,
  ): Mesh => {
    const m = new Mesh(keep(geo), mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };

  const root = new Group();
  root.name = 'bmo';
  const squash = new Group();
  squash.position.y = FLOOR_Y;
  root.add(squash);
  const body = new Group();
  body.position.y = -FLOOR_Y;
  squash.add(body);

  const parts: PartRig[] = [];
  const rig = (
    obj: Object3D,
    explode: V3,
    flatPos: V3,
    flatRot: V3,
    delay: number,
    organ = false,
  ): PartRig => {
    body.add(obj);
    const part: PartRig = {
      obj,
      homePos: obj.position.clone(),
      homeQuat: obj.quaternion.clone(),
      explode: v3(explode),
      flatPos: v3(flatPos),
      flatQuat: quatDeg(flatRot),
      delay,
      organ,
    };
    parts.push(part);
    return part;
  };
  const y0 = FLOOR_Y;

  // --- Shell -----------------------------------------------------------------
  const shellMat = std(PALETTE.shell, 0.42);
  const lidMat = std(PALETTE.lid, 0.48);
  const bezelMat = std(PALETTE.bezel, 0.4);
  const windowMat = std(PALETTE.window, 0.22);

  const shell = new Group();
  shell.position.set(0, 0, 0.85);
  const shellMesh = add(shell, new RoundedBoxGeometry(8, 10, 3.5, 4, 0.8), shellMat);
  const bezel = add(shell, new RoundedBoxGeometry(6.3, 5.2, 0.24, 2, 0.1), bezelMat, 0, 2.1, 1.77);
  const windowMesh = add(shell, new PlaneGeometry(5.6, 4.5), windowMat, 0, 2.1, 1.9);
  const sideText = add(
    shell,
    new PlaneGeometry(1.7, 0.64),
    keep(
      new MeshStandardMaterial({
        map: keep(sideTextTexture()),
        transparent: true,
        roughness: 0.5,
      }),
    ),
    4.012,
    -0.8,
    0,
  );
  sideText.rotation.y = Math.PI / 2;
  rig(shell, [0, 0, 7], [-6.2, y0 + 1.75, -4.4], [-90, 0, 0], 0);

  const lid = new Group();
  lid.position.set(0, 0, -1.75);
  const lidMesh = add(lid, new RoundedBoxGeometry(8, 10, 1.7, 4, 0.7), lidMat);
  rig(lid, [0, 0, -4.6], [3.4, y0 + 0.85, -4.4], [-90, 0, 0], 0.08);

  // --- Controls (front face at z = 2.6) --------------------------------------
  const dpadMat = std(PALETTE.dpad, 0.3);
  const dpad = new Group();
  dpad.position.set(-2, -2.35, 2.65);
  add(dpad, new RoundedBoxGeometry(2.2, 0.72, 0.5, 2, 0.16), dpadMat);
  add(dpad, new RoundedBoxGeometry(0.72, 2.2, 0.5, 2, 0.16), dpadMat);
  rig(dpad, [0, 0, 9.8], [9.9, y0 + 0.25, -8.2], [-90, 0, 0], 0.14);

  const triGeo = new ExtrudeGeometry(triangleShape(0.62), {
    depth: 0.22,
    bevelEnabled: true,
    bevelThickness: 0.1,
    bevelSize: 0.1,
    bevelSegments: 3,
    curveSegments: 1,
  });
  triGeo.center();
  const triangle = add(body, triGeo, std(PALETTE.triangle, 0.3), 0.55, -2.2, 2.68);
  rig(triangle, [0, 0, 9.8], [9.9, y0 + 0.21, -5.9], [-90, 0, 0], 0.18);

  const roundButton = (r: number, h: number, color: number, x: number, y: number): Mesh => {
    const m = add(body, new CylinderGeometry(r, r, h, 32), std(color, 0.3), x, y, 2.62);
    m.rotation.x = Math.PI / 2;
    return m;
  };
  rig(roundButton(0.42, 0.45, PALETTE.green, 2.35, -1.95), [0, 0, 9.8], [9.9, y0 + 0.225, -4.1], [0, 0, 0], 0.22);
  rig(roundButton(0.72, 0.45, PALETTE.red, 1.55, -3.55), [0, 0, 9.8], [9.9, y0 + 0.225, -2.1], [0, 0, 0], 0.26);
  rig(roundButton(0.22, 0.3, PALETTE.navy, 2.35, -1), [0, 0, 9.8], [9.9, y0 + 0.15, -0.5], [0, 0, 0], 0.3);

  const navyMat = std(PALETTE.navy, 0.35);
  for (const [x, fx] of [
    [-2.55, 9.3],
    [-1.45, 10.6],
  ] as const) {
    const pill = add(body, new CapsuleGeometry(0.16, 0.5, 4, 12), navyMat, x, -4.2, 2.62);
    pill.rotation.z = Math.PI / 2;
    rig(pill, [0, 0, 9.8], [fx, y0 + 0.16, 0.9], [0, 0, 90], 0.32);
  }

  // --- Limbs -------------------------------------------------------------------
  const limbMat = std(PALETTE.limb, 0.44);
  const makeArm = (side: 1 | -1): { part: Group; pivot: Group } => {
    const part = new Group();
    part.position.set(4 * side, 0.6, 0.2);
    const pivot = new Group();
    part.add(pivot);
    const curve = new CatmullRomCurve3([
      new Vector3(0, 0, 0),
      new Vector3(0.8 * side, -0.25, 0),
      new Vector3(1.35 * side, -1.2, 0.05),
      new Vector3(1.5 * side, -2.4, 0.1),
    ]);
    add(pivot, new TubeGeometry(curve, 20, 0.21, 8), limbMat);
    add(pivot, new SphereGeometry(0.36, 16, 12), limbMat, 1.5 * side, -2.45, 0.1);
    return { part, pivot };
  };
  const armL = makeArm(-1);
  const armR = makeArm(1);
  rig(armL.part, [-3, 0.4, 0], [-6, y0 + 0.36, 2.4], [-90, 0, 0], 0.2);
  rig(armR.part, [3, 0.4, 0], [-10.8, y0 + 0.36, 2.4], [-90, 0, 0], 0.24);

  const makeLeg = (side: 1 | -1): Group => {
    const leg = new Group();
    leg.position.set(1.6 * side, -5, 0.1);
    const curve = new CatmullRomCurve3([
      new Vector3(0, 0, 0),
      new Vector3(0, -0.9, 0),
      new Vector3(0, -1.6, 0.05),
    ]);
    add(leg, new TubeGeometry(curve, 10, 0.23, 8), limbMat);
    const foot = add(leg, new SphereGeometry(0.45, 18, 12), limbMat, 0, -1.72, 0.3);
    foot.scale.set(1.1, 0.55, 1.45);
    return leg;
  };
  rig(makeLeg(-1), [-0.6, -2.4, 0], [-1, y0 + 0.37, 3], [-90, 0, 0], 0.28);
  rig(makeLeg(1), [0.6, -2.4, 0], [1.6, y0 + 0.37, 3], [-90, 0, 0], 0.3);

  // --- Organs ------------------------------------------------------------------
  const organs = {} as Record<OrganId, OrganRig>;
  const organ = (
    id: OrganId,
    pos: V3,
    explode: V3,
    anchorAt: V3,
    build: (g: Group, mat: (color: number, rough?: number, metal?: number) => MeshStandardMaterial) => void,
  ): Group => {
    const group = new Group();
    group.position.set(pos[0], pos[1], pos[2]);
    const hardware = new Group();
    hardware.visible = false;
    group.add(hardware);
    const materials: MeshStandardMaterial[] = [];
    build(hardware, (color, rough = 0.5, metal = 0) => {
      const m = std(color, rough, metal);
      materials.push(m);
      return m;
    });
    const anchor = new Object3D();
    anchor.position.set(anchorAt[0], anchorAt[1], anchorAt[2]);
    group.add(anchor);
    const part = rig(group, explode, pos, [0, 0, 0], 0, true);
    organs[id] = {
      id,
      part,
      hardware,
      anchor,
      materials,
      accent: new Color(ORGAN_ACCENT[id]),
      level: 0,
    };
    return group;
  };

  const tft = organ('tft', [0, 2.1, 1.75], [0, 0, 3.4], [2.9, 2.3, 0.2], (g, mat) => {
    add(g, new BoxGeometry(6.1, 5, 0.12), mat(PALETTE.pcb));
    add(g, new BoxGeometry(5.6, 4.5, 0.16), mat(PALETTE.window, 0.2), 0, 0, 0.14);
    add(g, new BoxGeometry(1.4, 0.9, 0.04), mat(PALETTE.flex, 0.6), 0, -2.85, -0.02);
  });

  organ('esp32', [-1.7, -2.3, 0.1], [-1.4, -0.6, 1.2], [0.95, 1.1, 0.2], (g, mat) => {
    add(g, new BoxGeometry(1.8, 2.25, 0.12), mat(PALETTE.pcbDark));
    add(g, new BoxGeometry(0.7, 0.7, 0.12), mat(PALETTE.chip, 0.35), 0, 0.15, 0.12);
    add(g, new BoxGeometry(0.9, 0.3, 0.1), mat(PALETTE.metal, 0.3, 0.6), 0, 0.85, 0.11);
    add(g, new RoundedBoxGeometry(0.9, 0.34, 0.32, 1, 0.1), mat(PALETTE.metal, 0.3, 0.9), 0, -1.05, 0.16);
  });

  organ('mic', [2.1, -2.2, 0.35], [1.5, 0.2, 1.6], [0.55, 0.55, 0.2], (g, mat) => {
    const board = add(g, new CylinderGeometry(0.55, 0.55, 0.1, 28), mat(PALETTE.pcb));
    board.rotation.x = Math.PI / 2;
    const can = add(g, new CylinderGeometry(0.24, 0.24, 0.26, 20), mat(PALETTE.metal, 0.3, 0.9), 0, 0, 0.16);
    can.rotation.x = Math.PI / 2;
    add(g, new BoxGeometry(0.5, 0.18, 0.1), mat(PALETTE.gold, 0.4, 0.8), 0, -0.52, 0);
  });

  organ('speaker', [0.4, -3.4, -0.45], [0.9, -1.8, -1.6], [1.2, 0.9, 0.2], (g, mat) => {
    const frame = add(g, new CylinderGeometry(1.05, 1.05, 0.36, 36), mat(PALETTE.cone, 0.6));
    frame.rotation.x = Math.PI / 2;
    const coneMat = mat(0x3a3f46, 0.7);
    coneMat.side = DoubleSide; // open-ended: we look into the inside of the cone
    const cone = add(g, new CylinderGeometry(0.85, 0.3, 0.3, 36, 1, true), coneMat, 0, 0, 0.2);
    cone.rotation.x = Math.PI / 2;
    const cap = add(g, new SphereGeometry(0.28, 16, 10), mat(0x50565d, 0.5), 0, 0, 0.26);
    cap.scale.z = 0.5;
    const magnet = add(g, new CylinderGeometry(0.5, 0.5, 0.3, 24), mat(PALETTE.metal, 0.3, 0.9), 0, 0, -0.32);
    magnet.rotation.x = Math.PI / 2;
    add(g, new BoxGeometry(1, 0.8, 0.1), mat(PALETTE.pcb), 1.65, 0.6, 0.1);
    add(g, new BoxGeometry(0.34, 0.34, 0.08), mat(PALETTE.chip, 0.35), 1.65, 0.6, 0.18);
  });

  organ('touch', [0, 4.62, 0.7], [0, 2.8, 0.4], [0.7, 0.25, 0], (g, mat) => {
    add(g, new BoxGeometry(1.2, 0.1, 1.2), mat(PALETTE.pcb));
    add(g, new CylinderGeometry(0.4, 0.4, 0.05, 24), mat(PALETTE.gold, 0.35, 0.85), 0, 0.07, 0);
    add(g, new BoxGeometry(0.26, 0.08, 0.26), mat(PALETTE.chip), 0.36, 0.08, 0.36);
  });

  const heartGlowMat = keep(
    new SpriteMaterial({
      map: keep(radialTexture('rgba(255,122,168,0.85)', 'rgba(255,122,168,0)')),
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
    }),
  );
  const heartGlow = new Sprite(heartGlowMat);
  heartGlow.scale.setScalar(4.2);
  organ('heart', [0, -0.6, -0.9], [0, 0.8, -1.7], [0.9, 0.9, 0], (g, mat) => {
    const heartGeo = new ExtrudeGeometry(heartShape(), {
      depth: 0.45,
      bevelEnabled: true,
      bevelThickness: 0.18,
      bevelSize: 0.14,
      bevelSegments: 4,
      curveSegments: 18,
    });
    heartGeo.center();
    const m = mat(PALETTE.heart, 0.3);
    m.emissive.set(PALETTE.heart);
    m.emissiveIntensity = 0.5;
    add(g, heartGeo, m);
    g.add(heartGlow);
  });

  // --- Face screen (lives on the TFT so it stays lit in the exploded view) -----
  const texture = keep(new DataTexture(facePixels, FACE_W, FACE_H, RGBAFormat));
  texture.magFilter = NearestFilter;
  texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  const screenMaterial = keep(
    new ShaderMaterial({
      uniforms: {
        uFace: { value: texture },
        uTime: { value: 0 },
        uGlitch: { value: 0 },
        uPower: { value: 0 },
      },
      vertexShader: SCREEN_VERT,
      fragmentShader: SCREEN_FRAG,
      transparent: true,
    }),
  );
  // A sibling of the TFT's hidden `hardware` group, so it stays visible.
  const slide = new Object3D();
  slide.position.z = SCREEN_SLIDE.home;
  tft.add(slide);
  const screenMesh = new Mesh(keep(new PlaneGeometry(5.5, 4.4)), screenMaterial);
  slide.add(screenMesh);

  // --- Wires (1px signal lines, redrawn only while exploded) -------------------
  const wires: WireRig[] = [];
  const esp = organs.esp32.part.obj;
  const wire = (
    color: string,
    fromOffset: V3,
    to: Object3D,
    toOffset: V3,
  ): void => {
    const positions = new Float32Array(20 * 3);
    const geo = keep(new BufferGeometry());
    const attr = new BufferAttribute(positions, 3);
    geo.setAttribute('position', attr);
    const material = keep(
      new LineBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false }),
    );
    const line = new Line(geo, material);
    line.frustumCulled = false;
    line.visible = false;
    body.add(line);
    wires.push({
      line,
      positions,
      attr,
      material,
      from: { obj: esp, offset: v3(fromOffset) },
      to: { obj: to, offset: v3(toOffset) },
    });
  };
  wire('#ff7b7b', [0.2, 1.1, 0.1], organs.tft.part.obj, [-2.2, -2.4, -0.1]);
  wire('#ffd23f', [0.9, 0.3, 0.1], organs.mic.part.obj, [-0.55, 0, 0]);
  wire('#7fe8d0', [0.3, -1.1, 0], organs.speaker.part.obj, [1.2, 0.6, 0]);
  wire('#c5b5ff', [-0.6, 1.1, 0], organs.touch.part.obj, [-0.4, -0.05, 0]);

  // --- Print plate + contact shadow (outside the squash pivot) -----------------
  const bedGroup = new Group();
  bedGroup.position.set(0, FLOOR_Y - 0.26, 0);
  bedGroup.visible = false;
  const bedMaterial = keep(
    new MeshStandardMaterial({
      map: keep(bedTexture()),
      roughness: 0.78,
      metalness: 0.15,
      transparent: true,
      opacity: 0,
    }),
  );
  add(bedGroup, new RoundedBoxGeometry(25.6, 0.5, 25.6, 2, 0.2), bedMaterial);
  root.add(bedGroup);

  const shadowMaterial = keep(
    new MeshBasicMaterial({
      map: keep(radialTexture('rgba(10,38,32,0.5)', 'rgba(10,38,32,0)')),
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  const shadowMesh = add(root, new PlaneGeometry(12, 12), shadowMaterial, 0, FLOOR_Y + 0.02, 0.3);
  shadowMesh.rotation.x = -Math.PI / 2;

  const headAnchor = new Object3D();
  headAnchor.position.set(2.2, 6.4, 1.2);
  body.add(headAnchor);

  const constellation = buildConstellation(keep);
  const dust = buildDust(keep);

  return {
    root,
    squash,
    body,
    parts,
    organs,
    screen: { mesh: screenMesh, material: screenMaterial, slide, texture },
    armL: armL.pivot,
    armR: armR.pivot,
    hitTargets: [shellMesh, lidMesh, bezel, windowMesh, screenMesh],
    heartGlow,
    wires,
    bed: { group: bedGroup, material: bedMaterial },
    shadow: { mesh: shadowMesh, material: shadowMaterial },
    constellation,
    dust,
    headAnchor,
    dispose(): void {
      for (const item of trash) item.dispose();
      trash.length = 0;
    },
  };
}

/** Redraw a wire as a sagging quadratic curve between two organs (body space). */
export function updateWire(w: WireRig, scratch: { a: Vector3; b: Vector3; m: Vector3 }): void {
  const { a, b, m } = scratch;
  a.copy(w.from.obj.position).add(w.from.offset);
  b.copy(w.to.obj.position).add(w.to.offset);
  m.addVectors(a, b).multiplyScalar(0.5);
  m.y -= 0.6;
  m.z += 0.8;
  const n = w.positions.length / 3;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const u = 1 - t;
    w.positions[i * 3] = u * u * a.x + 2 * u * t * m.x + t * t * b.x;
    w.positions[i * 3 + 1] = u * u * a.y + 2 * u * t * m.y + t * t * b.y;
    w.positions[i * 3 + 2] = u * u * a.z + 2 * u * t * m.z + t * t * b.z;
  }
  w.attr.needsUpdate = true;
}

// -----------------------------------------------------------------------------
// Memory constellation (Brain chapter)
// -----------------------------------------------------------------------------

/** One node per BRAIN_CAPABILITIES entry, plus a field of faint stars. */
export const CONSTELLATION_NODES = 10;

function buildConstellation(
  keep: <T extends { dispose(): void }>(x: T) => T,
): ConstellationRig {
  const rand = mulberry32(7);
  const nodeCount = CONSTELLATION_NODES;
  const starCount = 260;
  const total = nodeCount + starCount;
  const positions = new Float32Array(total * 3);
  const size = new Float32Array(total);
  const phase = new Float32Array(total);
  const node = new Float32Array(total);
  const highlight = new Float32Array(total);

  const nodePos: Vector3[] = [];
  for (let i = 0; i < nodeCount; i++) {
    const a = (i / nodeCount) * Math.PI * 2 + 0.35;
    const r = 8.2 + (i % 3) * 1.15;
    const p = new Vector3(Math.cos(a) * r, 2 + Math.sin(i * 2.1) * 3.4, Math.sin(a) * r * 0.72);
    nodePos.push(p);
    positions.set([p.x, p.y, p.z], i * 3);
    size[i] = 9;
    phase[i] = rand() * 6.28;
    node[i] = 1;
  }
  for (let i = nodeCount; i < total; i++) {
    const u = rand() * 2 - 1;
    const th = rand() * Math.PI * 2;
    const r = 7 + rand() * 13;
    const s = Math.sqrt(1 - u * u);
    positions.set([Math.cos(th) * s * r, 2 + u * r * 0.7, Math.sin(th) * s * r], i * 3);
    size[i] = 1.6 + rand() * 2.6;
    phase[i] = rand() * 6.28;
  }

  const geo = keep(new BufferGeometry());
  geo.setAttribute('position', new BufferAttribute(positions, 3));
  geo.setAttribute('aSize', new BufferAttribute(size, 1));
  geo.setAttribute('aPhase', new BufferAttribute(phase, 1));
  geo.setAttribute('aNode', new BufferAttribute(node, 1));
  const highlightAttr = new BufferAttribute(highlight, 1);
  geo.setAttribute('aHi', highlightAttr);

  const starColor = new Color();
  const starHiColor = new Color();
  setShaderColor(starColor, '#bff5e6');
  setShaderColor(starHiColor, '#ffe36d');
  const material = keep(
    new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: 1 },
        uOpacity: { value: 0 },
        uColor: { value: starColor },
        uHiColor: { value: starHiColor },
      },
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    }),
  );
  const points = new Points(geo, material);
  points.frustumCulled = false;

  // Edges: a ring, a few chords, and a spoke from every node to the heart.
  const HEART = -1;
  const edges: Array<readonly [number, number]> = [];
  for (let i = 0; i < nodeCount; i++) edges.push([i, (i + 1) % nodeCount]);
  for (let i = 0; i < nodeCount; i += 2) edges.push([i, (i + 3) % nodeCount]);
  for (let i = 0; i < nodeCount; i++) edges.push([i, HEART]);
  const edgePos = new Float32Array(edges.length * 6);
  edges.forEach(([a, b], k) => {
    const pa = nodePos[a]!;
    const pb = b === HEART ? HUB : nodePos[b]!;
    edgePos.set([pa.x, pa.y, pa.z, pb.x, pb.y, pb.z], k * 6);
  });
  const edgeColors = new Float32Array(edges.length * 6);
  const edgeGeo = keep(new BufferGeometry());
  edgeGeo.setAttribute('position', new BufferAttribute(edgePos, 3));
  const edgeColorAttr = new BufferAttribute(edgeColors, 3);
  edgeGeo.setAttribute('color', edgeColorAttr);
  const edgeMaterial = keep(
    new LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: AdditiveBlending,
    }),
  );
  const lines = new LineSegments(edgeGeo, edgeMaterial);
  lines.frustumCulled = false;

  const group = new Group();
  group.add(points, lines);
  group.visible = false;

  return {
    group,
    material,
    edgeMaterial,
    nodeCount,
    highlight,
    highlightAttr,
    edges,
    edgeColors,
    edgeColorAttr,
  };
}

// -----------------------------------------------------------------------------
// Ambient dust
// -----------------------------------------------------------------------------

function buildDust(
  keep: <T extends { dispose(): void }>(x: T) => T,
): { points: Points; material: ShaderMaterial } {
  const rand = mulberry32(3);
  const count = 150;
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    positions.set([(rand() * 2 - 1) * 34, -14 + rand() * 36, -26 + rand() * 34], i * 3);
    seeds[i] = rand();
  }
  const geo = keep(new BufferGeometry());
  geo.setAttribute('position', new BufferAttribute(positions, 3));
  geo.setAttribute('aSeed', new BufferAttribute(seeds, 1));
  const material = keep(
    new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: 1 },
        uColor: { value: new Color(1, 1, 1) },
        uOpacity: { value: 0.55 },
      },
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      transparent: true,
      depthWrite: false,
    }),
  );
  const points = new Points(geo, material);
  points.frustumCulled = false;
  return { points, material };
}
