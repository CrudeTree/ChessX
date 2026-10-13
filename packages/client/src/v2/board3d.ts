// Pieces as figures standing on the board. The DOM board stays the board: this leans it back with a CSS
// perspective, and it keeps every square, highlight, effect and click. Over it, a WebGL canvas draws each piece as a
// figure (its 3D model, or until it has one, its creature cut out of the card) through a camera that sees the
// board exactly as the CSS perspective does, so each figure stands on its square to the pixel.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { v2 } from '@chessx/engine';

type Square = v2.Square;

/** A piece as it stands on the board. */
export interface Figure {
  id: string;
  /** Its figure in /figures: the model <name>.glb, or the creature cut out of its card, <name>.webp. */
  name: string;
  square: Square;
  owner: v2.Color;
  /** How tall it stands, in squares. */
  height: number;
  /** The ring round its base: its type's colour, or its King's. */
  ring: string;
  /** What it moves like and its level ("♜II"), on a tag by its base; empty for none. */
  badge: string;
  /** Picked up: it floats a little. */
  picked: boolean;
  sick: boolean;
  shielded: boolean;
  frozen: boolean;
  /** Lava Breath: an ember by its head, bright while it can spit. */
  ember: 'none' | 'idle' | 'ready';
  /** performance.now() when it rises out of its square, if it has just arrived; it is not there before. */
  riseAt?: number;
}

/** How a figure leaves the board: knocked over, or drawn into a seal or the piece it evolves into. */
export type FigureExit = 'capture' | 'consume';

/** figures/index.json: the figures there are, as cut-outs and as models. */
interface FigureIndex {
  standees: string[];
  models: string[];
}

const DEG = Math.PI / 180;
/** How far the board leans back; less on a small board, whose far squares would get too small to tap. */
const TILT = 36 * DEG;
const TILT_SMALL = 30 * DEG;
const SMALL_BOARD = 520;
/** The eye's distance from the board (the CSS perspective), in board widths. */
const DEPTH = 1.9;
/** Models lean back toward the eye a little, to be seen more from the front than from above. */
const LEAN = 20 * DEG;
/** Seen from above a model looks shorter than a cut-out of the same height, so it stands this much taller. */
const MODEL_TALL = 1.3;
/** Models may spread wider than cut-outs (wings over the next squares). */
const MODEL_MAX_WIDTH = 1.7;
/** The canvas reaches past the board (in board widths), for heads and wings over its edges. */
const PAD_X = 0.08;
const PAD_TOP = 0.08;
const PAD_BOTTOM = 0.03;
/** A figure's base: radius and thickness, in squares. */
const BASE_R = 0.38;
const BASE_H = 0.07;
/** No figure is wider than this many squares; a wider one stands lower. */
const MAX_WIDTH = 1.15;
/** How high a figure floats, in squares: held in a drag, or picked up. */
const HELD_LIFT = 0.4;
const PICKED_LIFT = 0.1;
/** A drag under a finger holds the figure this far above it (in squares), as the flat board does. */
const TOUCH_RAISE = 0.72;
const RISE_MS = 650;
const EXIT_MS = { capture: 560, consume: 620, fade: 200 } as const;
/** A slide takes this long a square, within these bounds. */
const SLIDE_MS_PER_SQUARE = 110;
const SLIDE_MS_MIN = 140;
const SLIDE_MS_MAX = 420;
const BASE_COLOR = { white: 0xeee4cc, black: 0x2b2339 } as const;
const SICK_TINT = new THREE.Color(0.6, 0.6, 0.64);
const FROST_TINT = new THREE.Color(0.62, 0.84, 1.15);
const FROST_RING = '#9fe0ff';
/** Models that do not face front as generated: how far to turn them, in degrees. */
const YAW: Record<string, number> = {};
/** Figures that should stand smaller (a baby dragon, all head) or larger than their height and width allow. */
const SIZE: Record<string, number> = { wyrmling: 0.7, ancient_mystic_dragon: 1.5 };
/** Picking a cut-out: its opaque parts, on a grid this many cells a side. */
const MASK = 32;
/** How solid a figure is while it stands in front of a square the player can choose; the picked one, a little more. */
const SEE_THROUGH = 0.3;
const SEE_THROUGH_PICKED = 0.55;
/** Where on a square the eye looks to see whether a figure is in front of it: its middle and its four sides. */
const SPOTS = [[0, 0], [0, -0.3], [0, 0.3], [-0.3, 0], [0.3, 0]] as const;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const easeOut = (t: number): number => 1 - (1 - t) ** 3;
const easeOutBack = (t: number): number => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;

/** A loaded model, scaled to stand 1 tall on the origin. */
interface Model {
  node: THREE.Object3D;
  /** Its bounds in that unit space, a little narrower than the model: a cheap test of what stands before a square. */
  bounds: THREE.Box3;
  /** A box round all of it in that space: no part of it is nearer the eye than that box. */
  whole: THREE.Box3;
  /** Width over height. */
  width: number;
}

/** A creature cut out of its card. */
interface Standee {
  texture: THREE.Texture;
  /** Width over height. */
  aspect: number;
  /** Which cells of a MASK x MASK grid over it are not see-through, top row first. */
  mask: Uint8Array;
}

/** A material of a figure's own, with its colour before any tint. */
interface Paint {
  material: THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
  color: THREE.Color;
  /** Its alpha test and alpha to coverage as made: where a cut-out's edge is, and how it is smoothed. */
  edge: number;
  coverage: boolean;
}

function webgl(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}

/** Stand a model up 1 tall, its feet on the origin. */
function unitModel(scene: THREE.Object3D): Model {
  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  scene.position.sub(new THREE.Vector3(centre.x, box.min.y, centre.z));
  const node = new THREE.Group();
  node.add(scene);
  node.scale.setScalar(1 / size.y);
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    for (const m of [mesh.material].flat()) {
      // Generated models often say nothing about metal, which glTF reads as all metal: dark without a room to reflect.
      const std = m as THREE.MeshStandardMaterial;
      if (std.isMeshStandardMaterial && !std.metalnessMap) std.metalness = Math.min(std.metalness, 0.15);
    }
  });
  const w = size.x / size.y / 2;
  const d = size.z / size.y / 2;
  return {
    node,
    bounds: new THREE.Box3(new THREE.Vector3(-w * 0.8, 0, -d * 0.8), new THREE.Vector3(w * 0.8, 1, d * 0.8)),
    whole: new THREE.Box3(new THREE.Vector3(-w, 0, -d), new THREE.Vector3(w, 1, d)).expandByScalar(0.01),
    width: size.x / size.y,
  };
}

function alphaMask(image: CanvasImageSource): Uint8Array {
  const canvas = document.createElement('canvas');
  canvas.width = MASK;
  canvas.height = MASK;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const mask = new Uint8Array(MASK * MASK);
  if (!g) return mask.fill(1);
  g.drawImage(image, 0, 0, MASK, MASK);
  const data = g.getImageData(0, 0, MASK, MASK).data;
  for (let i = 0; i < mask.length; i++) mask[i] = (data[i * 4 + 3] ?? 0) > 60 ? 1 : 0;
  return mask;
}

function emberTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const g = canvas.getContext('2d');
  if (g) {
    const glow = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    glow.addColorStop(0, 'rgba(255, 246, 200, 1)');
    glow.addColorStop(0.25, 'rgba(255, 170, 60, 0.95)');
    glow.addColorStop(0.6, 'rgba(230, 70, 20, 0.45)');
    glow.addColorStop(1, 'rgba(200, 40, 0, 0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, 64, 64);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** A piece's tag: its glyph and level on a dark pill edged in its colour. */
function badgeTexture(text: string, color: string): { texture: THREE.Texture; aspect: number } {
  const font = '700 44px "Segoe UI Symbol", "DejaVu Sans", sans-serif';
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d');
  const h = 64;
  let w = 96;
  if (g) {
    g.font = font;
    w = Math.max(h, Math.ceil(g.measureText(text).width) + 34);
  }
  canvas.width = w;
  canvas.height = h;
  if (g) {
    g.beginPath();
    g.roundRect(3, 3, w - 6, h - 6, (h - 6) / 2);
    g.fillStyle = 'rgba(22, 18, 32, 0.9)';
    g.fill();
    g.lineWidth = 5;
    g.strokeStyle = color;
    g.stroke();
    g.font = font;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#fbf6ea';
    g.fillText(text, w / 2, h / 2 + 2);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, aspect: w / h };
}

/** What the figures share: the board's measurements, the eye, and the meshes, textures and files they use. */
class Kit {
  cell = 1;
  tilt = TILT;
  /** The side at the near edge, before the eye: its models face away, toward the other side's, which face the eye. */
  near: v2.Color = 'white';
  readonly eye = new THREE.Vector3();
  readonly centres: THREE.Vector3[] = [];
  readonly baseGeo = new THREE.CylinderGeometry(1, 1.06, 1, 48).translate(0, 0.5, 0);
  readonly ringGeo = new THREE.TorusGeometry(1, 0.075, 10, 56).rotateX(Math.PI / 2);
  readonly planeGeo = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
  readonly domeGeo = new THREE.SphereGeometry(1, 40, 16, 0, Math.PI * 2, 0, Math.PI / 2);
  /** A shield: a bubble of light, clear in the middle and bright toward its rim. */
  readonly domeMat = new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(0xffd27a) } },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vec4 at = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = normalize(-at.xyz);
        gl_Position = projectionMatrix * at;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 color;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        float rim = 1.0 - abs(dot(normalize(vNormal), normalize(vView)));
        gl_FragColor = vec4(color, 0.05 + 0.9 * pow(rim, 2.5));
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  readonly ember = emberTexture();
  private readonly badges = new Map<string, { texture: THREE.Texture; aspect: number }>();
  private readonly loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  private readonly models = new Map<string, Promise<Model | null>>();
  private readonly standees = new Map<string, Promise<Standee | null>>();

  constructor(
    readonly modelNames: ReadonlySet<string>,
    readonly standeeNames: ReadonlySet<string>,
  ) {}

  centre(square: Square): THREE.Vector3 {
    return this.centres[square] ?? new THREE.Vector3();
  }

  model(name: string): Promise<Model | null> {
    let model = this.models.get(name);
    if (!model) {
      model = this.loader.loadAsync(`/figures/${name}.glb`).then(
        (gltf) => unitModel(gltf.scene),
        () => null,
      );
      this.models.set(name, model);
    }
    return model;
  }

  standee(name: string): Promise<Standee | null> {
    let standee = this.standees.get(name);
    if (!standee) {
      standee = new THREE.TextureLoader().loadAsync(`/figures/${name}.webp`).then(
        (texture) => {
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.anisotropy = 4;
          const image = texture.image as HTMLImageElement;
          return { texture, aspect: image.width / image.height, mask: alphaMask(image) };
        },
        () => null,
      );
      this.standees.set(name, standee);
    }
    return standee;
  }

  badge(text: string, color: string): { texture: THREE.Texture; aspect: number } {
    const key = `${text}|${color}`;
    let badge = this.badges.get(key);
    if (!badge) {
      badge = badgeTexture(text, color);
      this.badges.set(key, badge);
    }
    return badge;
  }

  dispose(): void {
    for (const geo of [this.baseGeo, this.ringGeo, this.planeGeo, this.domeGeo]) geo.dispose();
    this.domeMat.dispose();
    this.ember.dispose();
    for (const badge of this.badges.values()) badge.texture.dispose();
    for (const standee of this.standees.values()) void standee.then((s) => s?.texture.dispose());
    for (const model of this.models.values()) {
      void model.then((m) =>
        m?.node.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.geometry.dispose();
          for (const mat of [mesh.material].flat()) {
            for (const value of Object.values(mat)) if (value instanceof THREE.Texture) value.dispose();
            mat.dispose();
          }
        }),
      );
    }
  }
}

const ray = new THREE.Ray();
const caster = new THREE.Raycaster();
const hits: THREE.Intersection[] = [];
const inverse = new THREE.Matrix4();
const point = new THREE.Vector3();
const facing = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

/** One figure: its base, the model or cut-out on it, its tag, and its shield, frost and ember. */
class Piece {
  readonly root = new THREE.Group();
  /** On the base; leans back, rises out of the floor and floats. */
  private readonly body = new THREE.Group();
  /** Turns to face the eye, and scales the model or cut-out to the figure's height. */
  private readonly holder = new THREE.Group();
  private readonly base: THREE.Mesh;
  private readonly ring: THREE.Mesh;
  private readonly baseMat: THREE.MeshStandardMaterial;
  private readonly ringMat: THREE.MeshStandardMaterial;
  private model: Model | null = null;
  private standee: Standee | null = null;
  private shape: THREE.Object3D | null = null;
  private paints: Paint[] = [];
  /** How tall the model or cut-out stands, in pixels. */
  private tall = 0;
  private badge: THREE.Sprite | null = null;
  private badgeKey = '';
  private dome: THREE.Mesh | null = null;
  private ember: THREE.Sprite | null = null;
  square: Square;
  private move: { from: THREE.Vector3; to: THREE.Vector3; start: number; ms: number; hop: number } | null = null;
  /** Held in a drag: where on the floor it is being held over. */
  heldAt: THREE.Vector3 | null = null;
  private lift = 0;
  private riseAt = 0;
  exit: { how: FigureExit | 'fade'; at: number } | null = null;
  done = false;
  /** It stands in front of a square the player can choose, and fades to let it be seen. */
  hiding = false;
  private solid = 1;
  private opacity = 1;
  private disposed = false;
  /** Settles once it wears its model, or what it has instead. */
  readonly ready: Promise<void>;

  constructor(
    private readonly kit: Kit,
    private f: Figure,
    private readonly changed: () => void,
  ) {
    this.square = f.square;
    this.baseMat = new THREE.MeshStandardMaterial({ color: BASE_COLOR[f.owner], roughness: 0.5, metalness: 0.15 });
    this.ringMat = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.3, emissiveIntensity: 0.4 });
    this.base = new THREE.Mesh(kit.baseGeo, this.baseMat);
    this.base.castShadow = true;
    this.ring = new THREE.Mesh(kit.ringGeo, this.ringMat);
    this.body.add(this.holder);
    this.root.add(this.base, this.ring, this.body);
    if (f.riseAt && f.riseAt > performance.now() - RISE_MS && !reducedMotion.matches) this.riseAt = f.riseAt;
    this.root.position.copy(kit.centre(f.square));
    this.update(f);
    this.ready = this.load();
  }

  get name(): string {
    return this.f.name;
  }

  private async load(): Promise<void> {
    const { kit, f } = this;
    const model = kit.modelNames.has(f.name) ? kit.model(f.name) : null;
    if (kit.standeeNames.has(f.name)) {
      const standee = await kit.standee(f.name);
      // A model that is already there wins; otherwise the cut-out stands in for it until it is.
      if (standee && !this.disposed && !this.model) this.wear(null, standee);
    }
    const loaded = await model;
    if (loaded && !this.disposed) this.wear(loaded, null);
  }

  private wear(model: Model | null, standee: Standee | null): void {
    if (this.shape) {
      this.holder.remove(this.shape);
      for (const p of this.paints) p.material.dispose();
    }
    this.model = model;
    this.standee = standee;
    this.paints = [];
    if (model) {
      const shape = model.node.clone(true);
      shape.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const own = [mesh.material].flat().map((m) => {
          const copy = m.clone() as THREE.MeshStandardMaterial;
          this.paints.push({ material: copy, color: copy.color.clone(), edge: copy.alphaTest, coverage: copy.alphaToCoverage });
          return copy;
        });
        mesh.material = Array.isArray(mesh.material) ? own : own[0]!;
      });
      shape.rotation.y = (YAW[this.f.name] ?? 0) * DEG;
      this.shape = shape;
    } else if (standee) {
      const material = new THREE.MeshBasicMaterial({
        map: standee.texture,
        alphaTest: 0.5,
        alphaToCoverage: true,
        side: THREE.DoubleSide,
      });
      this.paints.push({ material, color: material.color.clone(), edge: material.alphaTest, coverage: true });
      this.shape = new THREE.Mesh(this.kit.planeGeo, material);
    }
    if (this.shape) this.holder.add(this.shape);
    this.setOpacity(this.opacity, true);
    this.fit();
    this.paint();
    this.changed();
  }

  /** The piece changed: it moved, or was shielded, frozen, picked up... `snap`: it is there now, without sliding. */
  update(f: Figure, snap = false): void {
    this.f = f;
    if (snap) {
      this.heldAt = null;
      this.move = null;
      this.square = f.square;
    } else if (f.square !== this.square) {
      this.square = f.square;
      if (!this.heldAt) this.slideTo(f.square);
    }
    this.ringMat.color.set(f.frozen ? FROST_RING : f.ring);
    this.ringMat.emissive.set(f.frozen ? FROST_RING : f.ring);
    if (f.badge && `${f.badge}|${f.ring}` !== this.badgeKey) {
      this.badgeKey = `${f.badge}|${f.ring}`;
      const { texture, aspect } = this.kit.badge(f.badge, f.ring);
      if (!this.badge) {
        this.badge = new THREE.Sprite(new THREE.SpriteMaterial({ depthWrite: false }));
        this.root.add(this.badge);
      }
      this.badge.material.map = texture;
      this.badge.material.opacity = this.opacity;
      this.badge.material.needsUpdate = true;
      this.badge.userData.aspect = aspect;
    } else if (!f.badge && this.badge) {
      this.root.remove(this.badge);
      this.badge.material.dispose();
      this.badge = null;
      this.badgeKey = '';
    }
    if (f.shielded && !this.dome) {
      this.dome = new THREE.Mesh(this.kit.domeGeo, this.kit.domeMat);
      this.root.add(this.dome);
    } else if (!f.shielded && this.dome) {
      this.root.remove(this.dome);
      this.dome = null;
    }
    if (f.ember !== 'none' && !this.ember) {
      const material = new THREE.SpriteMaterial({ map: this.kit.ember, blending: THREE.AdditiveBlending, depthWrite: false });
      this.ember = new THREE.Sprite(material);
      this.root.add(this.ember);
    } else if (f.ember === 'none' && this.ember) {
      this.root.remove(this.ember);
      this.ember.material.dispose();
      this.ember = null;
    }
    this.paint();
    this.fit();
  }

  /** Tints: grey while it cannot act yet, icy while frozen. */
  private paint(): void {
    for (const p of this.paints) {
      p.material.color.copy(p.color);
      if (this.f.sick) p.material.color.multiply(SICK_TINT);
      if (this.f.frozen) p.material.color.multiply(FROST_TINT);
    }
  }

  /** Size everything to the squares as they are now. */
  fit(): void {
    const cell = this.kit.cell;
    this.base.scale.set(BASE_R * cell, BASE_H * cell, BASE_R * cell);
    this.ring.scale.setScalar(BASE_R * cell);
    this.ring.position.y = BASE_H * cell;
    const size = SIZE[this.f.name.replace(/_(white|dark)$/, '')] ?? 1;
    let tall = this.f.height * cell;
    if (this.model) {
      tall = Math.min(tall * MODEL_TALL, (MODEL_MAX_WIDTH * cell) / this.model.width) * size;
      this.holder.scale.setScalar(tall);
      this.body.rotation.x = -LEAN;
      this.tall = tall;
    } else if (this.standee) {
      // A cut-out stands straight up, so the eye above sees it shortened by sin(tilt); it is that much taller.
      const aspect = this.standee.aspect;
      tall = Math.min(tall, (MAX_WIDTH * cell) / aspect) * size;
      this.holder.scale.set(tall * aspect, tall / Math.sin(this.kit.tilt), 1);
      this.body.rotation.x = 0;
      this.tall = tall / Math.sin(this.kit.tilt);
    }
    if (this.badge) {
      const h = 0.3 * cell;
      this.badge.scale.set(h * (this.badge.userData.aspect as number), h, 1);
      this.badge.position.set(0.36 * cell, 0.18 * cell, 0.32 * cell);
    }
    if (this.dome) {
      this.dome.scale.set(0.56 * cell, this.tall * 1.06 + BASE_H * cell, 0.56 * cell);
    }
    if (this.ember) {
      const size = (this.f.ember === 'ready' ? 0.55 : 0.32) * cell;
      this.ember.scale.set(size, size, 1);
      this.ember.position.set(0.18 * cell, BASE_H * cell + this.tall * 0.82, 0.22 * cell);
      this.ember.material.opacity = this.f.ember === 'ready' ? 1 : 0.6;
    }
    if (!this.move && !this.heldAt) this.root.position.copy(this.kit.centre(this.square));
    this.face();
  }

  /** Turn to the eye, or a near-side model away from it, to face the other side; a cut-out has no back to turn. */
  private face(): void {
    const p = this.root.position;
    const away = this.model && this.f.owner === this.kit.near ? Math.PI : 0;
    this.holder.rotation.y = Math.atan2(this.kit.eye.x - p.x, this.kit.eye.z - p.z) + away;
  }

  private slideTo(square: Square): void {
    const to = this.kit.centre(square).clone();
    const from = this.root.position.clone();
    const cell = this.kit.cell;
    const squares = from.distanceTo(to) / cell;
    if (reducedMotion.matches || squares < 0.01) {
      this.move = null;
      this.root.position.copy(to);
      return;
    }
    const ms = Math.min(SLIDE_MS_MAX, Math.max(SLIDE_MS_MIN, squares * SLIDE_MS_PER_SQUARE));
    // Neither straight nor diagonal: a knight's leap, over whatever is in the way.
    const across = Math.abs(to.x - from.x) / cell;
    const along = Math.abs(to.z - from.z) / cell;
    const leap = across > 0.5 && along > 0.5 && Math.abs(across - along) > 0.5;
    const hop = (leap ? 0.6 : Math.min(0.25, 0.06 * squares)) * cell;
    this.move = { from, to, start: performance.now(), ms, hop };
    this.changed();
  }

  hold(): void {
    this.heldAt = this.root.position.clone();
    this.move = null;
  }

  follow(at: THREE.Vector3): void {
    this.heldAt?.copy(at);
    this.changed();
  }

  /** Let go: back to its square, or onto the one it was dropped on (see `update`). */
  release(): void {
    if (!this.heldAt) return;
    this.heldAt = null;
    this.slideTo(this.square);
  }

  leave(how: FigureExit | 'fade', delay: number): void {
    if (this.exit) return;
    this.heldAt = null;
    this.exit = { how, at: performance.now() + delay };
    this.changed();
  }

  /** One frame: true while it is still moving. */
  step(now: number): boolean {
    const cell = this.kit.cell;
    const p = this.root.position;
    let busy = false;
    let hop = 0;
    if (this.heldAt) {
      p.x += (this.heldAt.x - p.x) * 0.5;
      p.z += (this.heldAt.z - p.z) * 0.5;
      busy = Math.abs(this.heldAt.x - p.x) + Math.abs(this.heldAt.z - p.z) > 0.2;
    } else if (this.move) {
      const t = (now - this.move.start) / this.move.ms;
      if (t >= 1) {
        p.copy(this.move.to);
        this.move = null;
      } else {
        p.lerpVectors(this.move.from, this.move.to, easeInOut(Math.max(0, t)));
        hop = this.move.hop * 4 * t * (1 - t);
        busy = true;
      }
    }
    const lift = (this.heldAt ? HELD_LIFT : this.f.picked ? PICKED_LIFT : 0) * cell;
    this.lift += (lift - this.lift) * 0.3;
    if (Math.abs(lift - this.lift) > 0.3) busy = true;
    else this.lift = lift;

    let grow = 1;
    let sink = 0;
    this.root.visible = true;
    if (this.riseAt) {
      const t = (now - this.riseAt) / RISE_MS;
      if (t < 0) {
        this.root.visible = false;
        busy = true;
      } else if (t < 1) {
        grow = 0.3 + 0.7 * easeOutBack(t);
        sink = (1 - easeOut(t)) * 0.7 * this.tall;
        busy = true;
      } else {
        this.riseAt = 0;
      }
    }
    this.root.rotation.x = 0;
    let fade = 1;
    if (this.exit) {
      const t = (now - this.exit.at) / EXIT_MS[this.exit.how];
      busy = true;
      if (t >= 1 || reducedMotion.matches) {
        this.done = true;
        return false;
      }
      if (t > 0) {
        const e = easeOut(t);
        fade = 1 - t * t;
        if (this.exit.how === 'capture') {
          // Knocked over backwards, sinking as it goes.
          this.root.rotation.x = -e * 80 * DEG;
          sink += e * 0.2 * cell;
        } else if (this.exit.how === 'consume') {
          grow *= 1 - 0.7 * e;
          hop += e * 0.5 * cell;
        }
      }
    }
    this.root.scale.setScalar(grow);
    this.body.position.y = BASE_H * cell + hop + this.lift - sink;
    this.face();
    const solid = this.hiding ? (this.f.picked ? SEE_THROUGH_PICKED : SEE_THROUGH) : 1;
    this.solid += (solid - this.solid) * 0.25;
    if (Math.abs(solid - this.solid) > 0.01 && !reducedMotion.matches) busy = true;
    else this.solid = solid;
    this.setOpacity(fade * this.solid);
    return busy;
  }

  /** Draw it this solid: 1, or less as it fades (leaving, or out of the way). */
  private setOpacity(opacity: number, again = false): void {
    if (opacity === this.opacity && !again) return;
    this.opacity = opacity;
    const fading = opacity < 1;
    // Opaque until they fade; the tag is see-through anyway.
    for (const m of [this.baseMat, this.ringMat, ...this.paints.map((p) => p.material)]) {
      if (m.transparent !== fading) {
        m.transparent = fading;
        m.needsUpdate = true;
      }
      m.opacity = opacity;
    }
    for (const p of this.paints) {
      // Fading, a cut-out blends instead of covering part of each pixel, and its edge stays where it was.
      const coverage = p.coverage && !fading;
      if (p.material.alphaToCoverage !== coverage) {
        p.material.alphaToCoverage = coverage;
        p.material.needsUpdate = true;
      }
      if (p.edge) p.material.alphaTest = Math.max(0.01, p.edge * opacity);
    }
    if (this.badge) this.badge.material.opacity = opacity;
  }

  /**
   * How far along `r` it is hit, or null if it is not. A model is hit by a box a little narrower than it (`core`), by
   * a box round all of it (`whole`), or by the model itself (`shape`): dearer, but a pointer between a dragon's wings
   * is not on the dragon. A cut-out is hit where it is not see-through.
   */
  hit(r: THREE.Ray, by: 'core' | 'whole' | 'shape' = 'core'): number | null {
    if (!this.shape || !this.root.visible || this.exit || this.heldAt) return null;
    if (by === 'shape' && this.model) {
      this.shape.updateWorldMatrix(true, true);
      caster.ray.copy(r);
      hits.length = 0;
      caster.intersectObject(this.shape, true, hits);
      return hits[0]?.distance ?? null;
    }
    this.holder.updateWorldMatrix(true, false);
    inverse.copy(this.holder.matrixWorld).invert();
    ray.copy(r).applyMatrix4(inverse);
    if (this.model) {
      if (!ray.intersectBox(by === 'whole' ? this.model.whole : this.model.bounds, point)) return null;
    } else if (this.standee) {
      if (!ray.intersectPlane(facing, point)) return null;
      const u = point.x + 0.5;
      const v = 1 - point.y;
      if (u < 0 || u >= 1 || v < 0 || v >= 1) return null;
      if (!this.standee.mask[Math.floor(v * MASK) * MASK + Math.floor(u * MASK)]) return null;
    }
    return point.applyMatrix4(this.holder.matrixWorld).distanceTo(r.origin);
  }

  dispose(): void {
    this.disposed = true;
    this.root.removeFromParent();
    this.baseMat.dispose();
    this.ringMat.dispose();
    for (const p of this.paints) p.material.dispose();
    this.badge?.material.dispose();
    this.ember?.material.dispose();
  }
}

/**
 * The figures over the board. It starts hidden: `prepare` loads and draws the figures unseen, then `show` puts them
 * over the board in one frame. `hide` takes them off again but keeps what was loaded, so showing them again is
 * instant.
 */
export class Board3D {
  /** Null without WebGL, or without the list of figures. */
  static async create(box: HTMLElement, board: HTMLElement, cell: (square: Square) => HTMLElement | undefined): Promise<Board3D | null> {
    if (!webgl()) return null;
    try {
      const res = await fetch('/figures/index.json');
      if (!res.ok) return null;
      return new Board3D(box, board, cell, (await res.json()) as FigureIndex);
    } catch {
      return null;
    }
  }

  readonly canvas = document.createElement('canvas');
  /** The canvas lost its WebGL context; the board should go back to flat tokens. */
  onLost: (() => void) | null = null;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera();
  private readonly sun = new THREE.DirectionalLight(0xfff0d8, 1.9);
  private readonly floor: THREE.Mesh;
  private readonly shade: THREE.Mesh;
  private readonly kit: Kit;
  private readonly pieces = new Map<string, Piece>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly resize: ResizeObserver;
  private held: Piece | null = null;
  /** The squares the player can choose between now (see `reveal`), and whether the figures before them are known. */
  private revealed: Square[] = [];
  private unveiled = true;
  private frame = 0;
  private size = 0;
  private shown = false;

  private constructor(
    private readonly box: HTMLElement,
    private readonly board: HTMLElement,
    private readonly cell: (square: Square) => HTMLElement | undefined,
    index: FigureIndex,
  ) {
    this.kit = new Kit(new Set(index.models), new Set(index.standees));
    this.canvas.className = 'g2-figures';
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.onLost?.();
    });

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();
    this.scene.add(new THREE.HemisphereLight(0xfff4e2, 0x3a2c44, 0.9));
    this.sun.castShadow = true;
    this.scene.add(this.sun, this.sun.target);

    const flat = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    // The board, unseen: what sinks below it (a figure rising, one knocked over) is hidden.
    this.floor = new THREE.Mesh(flat, new THREE.MeshBasicMaterial({ colorWrite: false }));
    this.floor.renderOrder = -1;
    // Catches the figures' shadows on the board.
    this.shade = new THREE.Mesh(flat, new THREE.ShadowMaterial({ color: 0x160b04, opacity: 0.34, depthWrite: false }));
    this.shade.receiveShadow = true;
    this.scene.add(this.floor, this.shade);

    this.resize = new ResizeObserver(() => this.layout());
    this.resize.observe(board);
    this.layout();
  }

  /** Load these figures and draw them once, unseen: their models, textures and shaders are all ready to show. */
  async prepare(figures: Figure[]): Promise<void> {
    this.sync(figures, true);
    await Promise.all([...this.pieces.values()].map((piece) => piece.ready));
    await this.renderer.compileAsync(this.scene, this.camera);
    this.renderer.render(this.scene, this.camera);
  }

  /** Lean the board back and stand these figures on it, where they are now. */
  show(figures: Figure[]): void {
    if (this.shown) return;
    this.shown = true;
    this.board.classList.add('three');
    this.board.after(this.canvas);
    this.layout();
    this.sync(figures, true);
  }

  /** The flat board again. What was loaded stays, for `show`. */
  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.held = null;
    this.canvas.remove();
    this.board.classList.remove('three');
    const board = this.board.style;
    board.transform = '';
    board.transformOrigin = '';
    board.removeProperty('--tilt');
  }

  /** Whether there is a figure by this name; a piece without one keeps its flat token. */
  shows(name: string): boolean {
    return this.kit.standeeNames.has(name) || this.kit.modelNames.has(name);
  }

  /** Fit the lean, the canvas and the eye to the board as it is laid out now: after a resize, or a flip. */
  layout(): void {
    const S = this.board.offsetWidth;
    const first = this.cell(0);
    if (!S || !first) return;
    const tilt = S < SMALL_BOARD ? TILT_SMALL : TILT;
    const eye = DEPTH * S;
    this.size = S;
    this.kit.tilt = tilt;
    this.kit.cell = first.offsetWidth;
    this.kit.near = first.offsetTop > S / 2 ? 'white' : 'black';
    if (this.shown) {
      const board = this.board.style;
      board.transformOrigin = '50% 100%';
      board.transform = `perspective(${eye}px) rotateX(${tilt / DEG}deg)`;
      board.setProperty('--tilt', `${tilt / DEG}deg`);
    }

    const padX = PAD_X * S;
    const padTop = PAD_TOP * S;
    const padBottom = PAD_BOTTOM * S;
    const w = S + 2 * padX;
    const h = S + padTop + padBottom;
    const canvas = this.canvas.style;
    canvas.left = `${this.board.offsetLeft - padX}px`;
    canvas.top = `${this.board.offsetTop - padTop}px`;
    canvas.width = `${w}px`;
    canvas.height = `${h}px`;
    this.renderer.setSize(w, h, false);

    // World: x to the right and z toward the eye, along the board; y up off it; in CSS pixels. The origin is the
    // middle of the board's near edge, which it leans back about (its transform-origin). The frustum is cut so
    // that the canvas shows exactly what the CSS perspective would draw over it.
    const near = eye * 0.05;
    const k = near / eye;
    this.kit.eye.set(0, eye * Math.cos(tilt), eye * Math.sin(tilt));
    this.camera.position.copy(this.kit.eye);
    this.camera.up.set(0, Math.sin(tilt), -Math.cos(tilt));
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();
    this.camera.projectionMatrix.makePerspective((-S / 2 - padX) * k, (S / 2 + padX) * k, (S + padTop) * k, -padBottom * k, near, eye * 4);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();

    for (let square = 0; square < 64; square++) {
      const c = this.cell(square);
      if (c) this.kit.centres[square] = new THREE.Vector3(c.offsetLeft + c.offsetWidth / 2 - S / 2, 0, c.offsetTop + c.offsetHeight / 2 - S);
    }
    for (const plane of [this.floor, this.shade]) {
      plane.scale.set(S, 1, S);
      plane.position.set(0, 0, -S / 2);
    }
    this.sun.position.set(-0.5 * S, 1.3 * S, 0.3 * S);
    this.sun.target.position.set(0, 0, -S / 2);
    const shadow = this.sun.shadow;
    const cam = shadow.camera;
    cam.left = cam.bottom = -0.85 * S;
    cam.right = cam.top = 0.85 * S;
    cam.near = 0.1 * S;
    cam.far = 3.5 * S;
    cam.updateProjectionMatrix();
    const map = S < SMALL_BOARD ? 1024 : 2048;
    if (shadow.mapSize.x !== map) {
      shadow.mapSize.set(map, map);
      shadow.map?.dispose();
      shadow.map = null;
    }
    shadow.bias = -0.0005;
    shadow.normalBias = 0.01 * this.kit.cell;
    for (const piece of this.pieces.values()) piece.fit();
    this.changed();
  }

  /**
   * The pieces on the board now. New ones appear (rising, if they just arrived); gone ones fade. `snap`: they are
   * just as given, at once, with nothing sliding, fading or still leaving (as after the board was hidden).
   */
  sync(figures: Figure[], snap = false): void {
    const seen = new Set<string>();
    for (const f of figures) {
      seen.add(f.id);
      let piece = this.pieces.get(f.id);
      // Another figure now (or after a hidden while, another game's piece by the same id): it stands anew.
      if (piece && (piece.name !== f.name || (snap && piece.exit))) {
        this.remove(f.id, piece);
        piece = undefined;
      }
      if (piece?.exit) continue;
      if (piece) piece.update(f, snap);
      else {
        const made = new Piece(this.kit, f, this.changed);
        this.pieces.set(f.id, made);
        this.scene.add(made.root);
      }
    }
    for (const [id, piece] of this.pieces) {
      if (seen.has(id)) continue;
      if (snap) this.remove(id, piece);
      else piece.leave('fade', 0);
    }
    this.changed();
  }

  private remove(id: string, piece: Piece): void {
    piece.dispose();
    this.pieces.delete(id);
    if (this.held === piece) this.held = null;
  }

  /** The squares the player can choose between now: a figure that stands in front of one fades, so it can be seen. */
  reveal(squares: Iterable<Square>): void {
    const list = [...new Set(squares)].sort((a, b) => a - b);
    if (list.length === this.revealed.length && list.every((s, i) => s === this.revealed[i])) return;
    this.revealed = list;
    this.unveiled = false;
    this.wake();
  }

  /** A piece is leaving the board, after `delay`: knocked over (captured, smitten) or drawn in (sealed, evolved). */
  leave(id: string, how: FigureExit, delay: number): void {
    this.pieces.get(id)?.leave(how, delay);
  }

  /** A drag picked this piece up: its figure follows `follow` until `release`. */
  hold(id: string): void {
    this.release();
    this.held = this.pieces.get(id) ?? null;
    this.held?.hold();
    this.changed();
  }

  follow(x: number, y: number, touch: boolean): void {
    if (!this.held) return;
    const at = this.floorAt(x, y - (touch ? TOUCH_RAISE * this.kit.cell : 0));
    if (at) this.held.follow(at);
  }

  release(): void {
    this.held?.release();
    this.held = null;
    this.changed();
  }

  /** The square of the figure under (x, y) on the page, if a figure is there. */
  pick(x: number, y: number): Square | null {
    if (!this.aim(x, y)) return null;
    const r = this.raycaster.ray;
    const near: { piece: Piece; at: number }[] = [];
    for (const piece of this.pieces.values()) {
      const at = piece.hit(r, 'whole');
      if (at !== null) near.push({ piece, at });
    }
    near.sort((a, b) => a.at - b.at);
    let best: Piece | null = null;
    let bestAt = Infinity;
    // Nearest first, until no part of the rest can be nearer than what is hit.
    for (const { piece, at: reach } of near) {
      if (reach >= bestAt) break;
      const at = piece.hit(r, 'shape');
      if (at !== null && at < bestAt) {
        best = piece;
        bestAt = at;
      }
    }
    return best ? best.square : null;
  }

  /** Every figure off the board at once (a new game). */
  clear(): void {
    this.held = null;
    for (const piece of this.pieces.values()) piece.dispose();
    this.pieces.clear();
    this.wake();
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.clear();
    this.kit.dispose();
    this.scene.environment?.dispose();
    this.floor.geometry.dispose();
    (this.floor.material as THREE.Material).dispose();
    (this.shade.material as THREE.Material).dispose();
    this.renderer.dispose();
    this.canvas.remove();
    this.board.classList.remove('three');
    const board = this.board.style;
    board.transform = '';
    board.transformOrigin = '';
    board.removeProperty('--tilt');
  }

  /** Point the raycaster from the eye through (x, y) on the page. */
  private aim(x: number, y: number): boolean {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height || !this.size) return false;
    this.raycaster.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, 1 - ((y - r.top) / r.height) * 2), this.camera);
    return true;
  }

  /** The point on the board under (x, y) on the page. */
  private floorAt(x: number, y: number): THREE.Vector3 | null {
    if (!this.aim(x, y)) return null;
    return this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
  }

  /** Something moved or changed shape: draw it, and look again at what stands before the revealed squares. */
  private readonly changed = (): void => {
    if (this.revealed.length) this.unveiled = false;
    this.wake();
  };

  /** Mark the figures that stand between the eye and some part of a revealed square, other than the one on it. */
  private unveil(): void {
    const cell = this.kit.cell;
    const eye = this.kit.eye;
    const look = new THREE.Ray();
    const spot = new THREE.Vector3();
    const hiding = new Set<Piece>();
    for (const square of this.revealed) {
      const centre = this.kit.centres[square];
      if (!centre) continue;
      for (const [dx, dz] of SPOTS) {
        spot.set(centre.x + dx * cell, 0, centre.z + dz * cell);
        look.origin.copy(eye);
        look.direction.subVectors(spot, eye).normalize();
        const far = eye.distanceTo(spot);
        for (const piece of this.pieces.values()) {
          // Only what stands nearer the eye than the spot can be in front of it.
          if (hiding.has(piece) || piece.square === square || piece.root.position.z < spot.z) continue;
          const at = piece.hit(look);
          if (at !== null && at < far) hiding.add(piece);
        }
      }
    }
    for (const piece of this.pieces.values()) piece.hiding = hiding.has(piece);
  }

  private wake(): void {
    if (!this.frame && this.shown) this.frame = requestAnimationFrame(this.draw);
  }

  private readonly draw = (now: number): void => {
    this.frame = 0;
    if (!this.unveiled) {
      this.unveiled = true;
      this.unveil();
    }
    let busy = false;
    for (const [id, piece] of this.pieces) {
      if (piece.step(now)) busy = true;
      if (piece.done) this.remove(id, piece);
    }
    this.renderer.render(this.scene, this.camera);
    if (busy) this.wake();
  };
}
