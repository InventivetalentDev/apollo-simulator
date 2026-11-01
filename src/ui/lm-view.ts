// The 3D view: the Lunar Module at its simulated attitude against the stars,
// with a plume on each RCS jet while it fires. The scene axes are the
// inertial axes, mapped as in scene-axes.ts, so the camera, the Sun, the Moon
// and the stars stay still while the LM turns.
//
// In orbit the scene follows the LM instead: up is away from the Moon and
// forward is along the ground track, the stars turn as the LM goes round,
// the ground moves past below at the true rate, and the descent engine's
// plume grows with its thrust.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { cross, matrixToQuat, quatMultiply, type Quat, type Vec3 } from '../sim/attitude.ts';
import { DPS_FULL_THROTTLE } from '../sim/descent-engine.ts';
import type { LunarModule } from '../sim/lm.ts';
import { inertialToMoonFixed, moonFixedToInertial } from '../sim/moon.ts';
import { buildLunarModule, FOOTPAD_DEPTH } from './lm-model.ts';
import { quatToScene, toScene } from './scene-axes.ts';

/** Direction of the Sun: high, on the camera's side, so the default view is lit. */
const SUN = new THREE.Vector3(10, 6, 4).normalize();
/**
 * The Moon's radius and the LM's height above it. Both are scaled down from
 * the real ones but keep the horizon about 25° below level, and they are large
 * enough that turning the camera around the LM shows no parallax.  In orbit
 * the height follows the true altitude at the Moon's scale (1:43), so the
 * horizon sits as far below level as it really would.
 */
const MOON_RADIUS = 40000;
const ALTITUDE = 4000;
/** One tile of the surface texture, m. */
const TILE = 2500;
/** Sine of the angle below level at which the Moon's horizon sits. */
const HORIZON = -Math.sqrt(1 - (MOON_RADIUS / (MOON_RADIUS + ALTITUDE)) ** 2);
const STAR_DISTANCE = 90000;

/** A small seeded generator, so the stars and the Moon are the same on every load. */
function seeded(seed: number): () => number {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
}

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/**
 * Light reflected onto the LM: dark sky above the horizon, lit lunar surface
 * below it. Metal and foil need something to reflect, or gold reads as brown
 * plastic. The sky is lifted a little above black so that the faces turned
 * away from the Sun still show their shape.
 */
function moonshine(renderer: THREE.WebGLRenderer): THREE.Texture {
  const geometry = new THREE.SphereGeometry(1, 48, 24);
  const position = geometry.getAttribute('position');
  const sky = new THREE.Color(0x15181d);
  const ground = new THREE.Color(0xa29f97);
  const colors: number[] = [];
  for (let i = 0; i < position.count; i++) {
    const c = sky.clone().lerp(ground, smoothstep(HORIZON + 0.05, HORIZON - 0.08, position.getY(i)));
    colors.push(c.r, c.g, c.b);
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide });
  const environment = new THREE.Scene().add(new THREE.Mesh(geometry, material));
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(environment).texture;
  pmrem.dispose();
  geometry.dispose();
  material.dispose();
  return texture;
}

function stars(random: () => number): THREE.Points {
  const count = 3000;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const y = 2 * random() - 1;
    const angle = 2 * Math.PI * random();
    const r = Math.sqrt(1 - y * y);
    positions.set([r * Math.cos(angle), y, r * Math.sin(angle)].map((c) => c * STAR_DISTANCE), i * 3);
    // Most stars are faint and a few are bright; some are a little blue or yellow.
    const brightness = 0.12 + 0.88 * random() ** 6;
    const hue = random();
    const tint = hue < 0.2 ? [0.8, 0.88, 1] : hue > 0.85 ? [1, 0.9, 0.74] : [1, 1, 1];
    colors.set(tint.map((c) => c * brightness), i * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const dot = document.createElement('canvas');
  dot.width = dot.height = 32;
  const g = dot.getContext('2d')!;
  const fade = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  fade.addColorStop(0, 'rgba(255,255,255,1)');
  fade.addColorStop(0.35, 'rgba(255,255,255,0.8)');
  fade.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = fade;
  g.fillRect(0, 0, 32, 32);
  const material = new THREE.PointsMaterial({
    size: 2.6,
    sizeAttenuation: false,
    vertexColors: true,
    map: new THREE.CanvasTexture(dot),
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  return new THREE.Points(geometry, material);
}

/** One tile of lunar surface, albedo patches and craters, repeating without seams. */
function moonTexture(random: () => number): THREE.CanvasTexture {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#8f8e89';
  g.fillRect(0, 0, size, size);
  /** Draw at (x, y), and again past each edge the shape crosses, so the tile repeats without seams. */
  const wrapped = (x: number, y: number, r: number, draw: (x: number, y: number) => void) => {
    for (const dx of [-size, 0, size]) {
      for (const dy of [-size, 0, size]) {
        if (x + dx + r > 0 && x + dx - r < size && y + dy + r > 0 && y + dy - r < size) draw(x + dx, y + dy);
      }
    }
  };
  for (let i = 0; i < 70; i++) {
    const r = 60 + random() * 200;
    const dark = random() < 0.6;
    wrapped(random() * size, random() * size, r, (x, y) => {
      const patch = g.createRadialGradient(x, y, 0, x, y, r);
      patch.addColorStop(0, dark ? 'rgba(55,55,52,0.18)' : 'rgba(215,213,206,0.14)');
      patch.addColorStop(1, 'rgba(128,128,128,0)');
      g.fillStyle = patch;
      g.fillRect(x - r, y - r, 2 * r, 2 * r);
    });
  }
  // Craters: a dark floor and a soft raised rim, many small and a few large.
  for (let i = 0; i < 700; i++) {
    const r = 2 + 60 * random() ** 3;
    const outer = r * 1.3;
    const rim = Math.min(0.26, 0.05 + r / 150);
    wrapped(random() * size, random() * size, outer, (x, y) => {
      const crater = g.createRadialGradient(x, y, 0, x, y, outer);
      crater.addColorStop(0, 'rgba(58,58,55,0.3)');
      crater.addColorStop(0.62, 'rgba(58,58,55,0.16)');
      crater.addColorStop(0.77, `rgba(226,224,217,${rim})`);
      crater.addColorStop(1, 'rgba(226,224,217,0)');
      g.fillStyle = crater;
      g.fillRect(x - outer, y - outer, 2 * outer, 2 * outer);
    });
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/**
 * The part of the Moon the LM can see, as a cap around the point straight
 * below it: rings packed close under the LM and spreading out towards the
 * horizon, so the ground near the LM is smooth at any height.  The texture is
 * laid flat from above; moving its offset moves the ground.
 */
function moonCap(): THREE.BufferGeometry {
  const rings = 160;
  const segments = 256;
  const reach = 1.2; // radians from the point below, well past the horizon
  const positions = [0, MOON_RADIUS, 0];
  for (let i = 1; i <= rings; i++) {
    const angle = reach * (i / rings) ** 2;
    for (let j = 0; j < segments; j++) {
      const around = (2 * Math.PI * j) / segments;
      positions.push(MOON_RADIUS * Math.sin(angle) * Math.cos(around), MOON_RADIUS * Math.cos(angle), MOON_RADIUS * Math.sin(angle) * Math.sin(around));
    }
  }
  const uvs: number[] = [];
  const normals: number[] = [];
  for (let k = 0; k < positions.length; k += 3) {
    uvs.push(positions[k] / TILE, positions[k + 2] / TILE);
    normals.push(positions[k] / MOON_RADIUS, positions[k + 1] / MOON_RADIUS, positions[k + 2] / MOON_RADIUS);
  }
  const index: number[] = [];
  const at = (ring: number, j: number) => 1 + (ring - 1) * segments + (j % segments);
  for (let j = 0; j < segments; j++) index.push(0, at(1, j + 1), at(1, j));
  for (let i = 1; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      index.push(at(i, j), at(i, j + 1), at(i + 1, j), at(i, j + 1), at(i + 1, j + 1), at(i + 1, j));
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  return geometry;
}

function moon(random: () => number, anisotropy: number): THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> {
  const map = moonTexture(random);
  map.anisotropy = anisotropy;
  // The Moon is lit by the Sun only, not by the moonshine meant for the LM.
  const material = new THREE.MeshStandardMaterial({ map, roughness: 1, metalness: 0, envMapIntensity: 0 });
  // Sample the tile twice more, about seven and forty times larger and
  // turned, and let them lighten and darken the first, so the repeat does not
  // line up and broad light and dark regions span many tiles.
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      '#include <map_fragment>\n\tdiffuseColor.rgb *= 0.5 + 1.8 * texture2D( map, mat2( 0.12, 0.08, -0.08, 0.12 ) * vMapUv + vec2( 0.37, 0.71 ) ).g;' +
        '\n\tdiffuseColor.rgb *= 0.46 + 1.4 * texture2D( map, mat2( 0.02, -0.014, 0.014, 0.02 ) * vMapUv + vec2( 0.53, 0.19 ) ).g;',
    );
  };
  const mesh = new THREE.Mesh(moonCap(), material);
  mesh.position.set(0, -(MOON_RADIUS + ALTITUDE), 0);
  mesh.receiveShadow = true;
  return mesh;
}

const conjugate = (q: Quat): Quat => [q[0], -q[1], -q[2], -q[3]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Vec3): Vec3 => {
  const n = Math.hypot(...a);
  return [a[0] / n, a[1] / n, a[2] / n];
};

export class LmView {
  private lm: LunarModule | null = null;
  private readonly renderer: THREE.WebGLRenderer | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(40, 1, 0.1, 2 * STAR_DISTANCE);
  private readonly controls!: OrbitControls;
  private readonly model!: THREE.Group;
  private readonly plumes: THREE.Object3D[] = [];
  private readonly descentPlume!: THREE.Object3D;
  private readonly moon!: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  private readonly stars!: THREE.Points;
  /** In orbit: the Moon-fixed direction of the point below the LM on the last frame. */
  private below: Vec3 | null = null;
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  /** False while the shaders compile in the background; nothing is drawn until then. */
  private ready = true;

  constructor(readonly host: HTMLElement) {
    host.innerHTML = `<h2 class="view3d-title" id="view3d-title">3D view</h2>
      <p class="view3d-hint">Drag to look around, scroll or pinch to zoom</p>`;
    const hint = host.querySelector('.view3d-hint')!;
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      hint.textContent = 'The 3D view needs WebGL, which this browser does not offer.';
      return;
    }
    const renderer = this.renderer;
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setClearColor('#05070a');
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.domElement.setAttribute('role', 'img');
    renderer.domElement.setAttribute('aria-label', 'The Lunar Module at its current attitude, with its RCS jets');
    host.insertBefore(renderer.domElement, hint);
    new ResizeObserver(([entry]) => {
      const { width: w, height: h } = entry.contentRect;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }).observe(host);

    this.camera.position.set(9.5, 2.5, 13.5);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.target.set(0, -1.4, 0);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 40;
    // On a touch screen the view is at the top of the page: a swipe up or down scrolls the
    // page, a swipe sideways turns the view, and a pinch zooms it.
    if (window.matchMedia('(pointer: coarse)').matches) {
      renderer.domElement.style.touchAction = 'pan-y';
      hint.textContent = 'Swipe sideways to look around, pinch to zoom';
    }

    this.scene.environment = moonshine(renderer);
    this.scene.environmentIntensity = 1.3;
    // The sunlit Moon below lights the LM from underneath; the sky above gives almost nothing.
    this.scene.add(new THREE.HemisphereLight(0x2a2c30, 0x9a968c, 0.9));
    const sun = new THREE.DirectionalLight(0xfff4e6, 3.2);
    sun.position.copy(SUN).multiplyScalar(25);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -6.5, right: 6.5, top: 6.5, bottom: -6.5, near: 5, far: 45 });
    sun.shadow.bias = -0.0003;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun);

    const random = seeded(0x19690720);
    this.stars = stars(random);
    this.moon = moon(random, renderer.capabilities.getMaxAnisotropy());
    this.scene.add(this.stars, this.moon);

    const lm = buildLunarModule();
    this.model = lm.group;
    this.plumes = lm.plumes;
    this.descentPlume = lm.descentPlume;
    this.scene.add(this.model);

    // Where the browser can compile shaders in the background, compile them
    // all now, the hidden plumes' too, so neither the first frame nor the
    // first firing stalls the simulation. Elsewhere they compile on first use.
    if (renderer.extensions.has('KHR_parallel_shader_compile')) {
      this.ready = false;
      void renderer.compileAsync(this.scene, this.camera).then(() => {
        this.ready = true;
      });
    }
  }

  /** Show the view for an LM, or hide it with null. */
  attach(lm: LunarModule | null): void {
    this.lm = lm;
    this.host.hidden = !lm;
    this.below = null;
  }

  /** Draw one frame: the LM at its current attitude, with the jets in `litJets` (bit n-1 for jet n) firing. */
  update(litJets: number): void {
    const lm = this.lm;
    if (!this.ready || !lm || !this.renderer || this.host.hidden || document.visibilityState !== 'visible') return;
    const setQuat = (object: THREE.Object3D, q: Quat) => {
      const [w, x, y, z] = quatToScene(q);
      object.quaternion.set(x, y, z, w);
    };
    if (lm.orbiting) {
      const frame = this.followOrbit(lm);
      setQuat(this.model, quatMultiply(conjugate(frame), lm.attitude));
      setQuat(this.stars, conjugate(frame));
    } else {
      setQuat(this.model, lm.attitude);
      this.stars.quaternion.identity();
      this.moon.position.y = -(MOON_RADIUS + ALTITUDE);
      this.below = null;
    }
    const steady = this.reducedMotion.matches;
    for (let j = 0; j < 16; j++) {
      const plume = this.plumes[j];
      plume.visible = Boolean(litJets & (1 << j));
      // A firing jet's plume flickers in length.
      if (plume.visible) plume.scale.set(1, steady ? 1 : 0.85 + 0.3 * Math.random(), 1);
    }
    this.updateDescentPlume(lm, steady);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * In orbit: the local frame (simulation axes X up, Y right, Z forward along
   * the ground track) as an attitude in the inertial frame.  Also sets the
   * Moon's height below the LM and moves the ground by the distance flown.
   */
  private followOrbit(lm: LunarModule): Quat {
    const up = unit(lm.position);
    const forward = unit(lm.velocity.map((v, k) => v - dot(lm.velocity, up) * up[k]) as Vec3);
    const right = cross(forward, up);
    const frame = matrixToQuat([up[0], right[0], forward[0], up[1], right[1], forward[1], up[2], right[2], forward[2]]);

    // The Moon at its scale, with the footpads just touching it at zero altitude.
    const scale = MOON_RADIUS / lm.surfaceRadius;
    const altitude = Math.max(0, Math.hypot(...lm.position) - lm.surfaceRadius);
    this.moon.position.y = -(MOON_RADIUS + FOOTPAD_DEPTH + altitude * scale);

    // The ground under the LM moves by the change in the Moon-fixed point below it.
    const below = inertialToMoonFixed(up, lm.ephemerisTime);
    if (this.below) {
      const step = moonFixedToInertial(below.map((c, k) => c - this.below![k]) as Vec3, lm.ephemerisTime);
      // A jump (a new setup) starts the ground afresh.
      if (Math.hypot(...step) < 0.01) {
        const offset = this.moon.material.map!.offset;
        offset.x -= (dot(step, right) * MOON_RADIUS) / TILE;
        offset.y += (dot(step, forward) * MOON_RADIUS) / TILE;
      }
    }
    this.below = below;
    return frame;
  }

  /** The descent engine's plume: shown while it fires, longer with more thrust, along the gimballed thrust line. */
  private updateDescentPlume(lm: LunarModule, steady: boolean): void {
    const plume = this.descentPlume;
    const thrust = lm.engine.thrust / DPS_FULL_THROTTLE;
    plume.visible = thrust > 0;
    if (!plume.visible) return;
    const [pitch, roll] = lm.engine.gimbal;
    const exhaust: Vec3 = [-Math.cos(pitch) * Math.cos(roll), -Math.sin(roll), Math.sin(pitch) * Math.cos(roll)];
    plume.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...toScene(exhaust)));
    const width = 0.55 + 0.45 * thrust;
    plume.scale.set(width, (0.3 + 0.7 * thrust) * (steady ? 1 : 0.93 + 0.14 * Math.random()), width);
  }
}
