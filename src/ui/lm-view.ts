// The 3D view: the Lunar Module at its simulated attitude against the stars,
// with a plume on each RCS jet while it fires. The scene axes are the
// inertial axes, mapped as in scene-axes.ts, so the camera, the Sun, the Moon
// and the stars stay still while the LM turns.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { LunarModule } from '../sim/lm.ts';
import { buildLunarModule } from './lm-model.ts';
import { quatToScene } from './scene-axes.ts';

/** Direction of the Sun: high, on the camera's side, so the default view is lit. */
const SUN = new THREE.Vector3(10, 6, 4).normalize();
/**
 * The Moon's radius and the LM's height above it. Both are scaled down from
 * the real ones but keep the horizon about 25° below level, and they are large
 * enough that turning the camera around the LM shows no parallax.
 */
const MOON_RADIUS = 40000;
const ALTITUDE = 4000;
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
  // About 2.5 km per tile on the scaled Moon.
  texture.repeat.set(100, 50);
  return texture;
}

function moon(random: () => number, anisotropy: number): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(MOON_RADIUS, 256, 128);
  // Broad light and dark regions that span many tiles, so the tiling does not show.
  const position = geometry.getAttribute('position');
  const colors: number[] = [];
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i) / MOON_RADIUS;
    const y = position.getY(i) / MOON_RADIUS;
    const z = position.getZ(i) / MOON_RADIUS;
    const shade = 0.84 + 0.12 * Math.sin(9 * x + 2.1) * Math.sin(7 * z + 0.4) + 0.08 * Math.sin(31 * y + 17 * z) * Math.sin(23 * x + 1.3);
    colors.push(shade, shade, shade);
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const map = moonTexture(random);
  map.anisotropy = anisotropy;
  // The Moon is lit by the Sun only, not by the moonshine meant for the LM.
  const material = new THREE.MeshStandardMaterial({ map, vertexColors: true, roughness: 1, metalness: 0, envMapIntensity: 0 });
  // Sample the tile a second time, about seven times larger and turned, and
  // let it lighten and darken the first, so the repeat does not line up.
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      '#include <map_fragment>\n\tdiffuseColor.rgb *= 0.5 + 1.8 * texture2D( map, mat2( 0.12, 0.08, -0.08, 0.12 ) * vMapUv + vec2( 0.37, 0.71 ) ).g;',
    );
  };
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(0, -(MOON_RADIUS + ALTITUDE), 0);
  // Put the texture's equator, not its pole, under the LM.
  mesh.rotation.z = Math.PI / 2;
  return mesh;
}

export class LmView {
  private lm: LunarModule | null = null;
  private readonly renderer: THREE.WebGLRenderer | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(40, 1, 0.1, 2 * STAR_DISTANCE);
  private readonly controls!: OrbitControls;
  private readonly model!: THREE.Group;
  private readonly plumes: THREE.Object3D[] = [];
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
    this.scene.add(stars(random), moon(random, renderer.capabilities.getMaxAnisotropy()));

    const lm = buildLunarModule();
    this.model = lm.group;
    this.plumes = lm.plumes;
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
  }

  /** Draw one frame: the LM at its current attitude, with the jets in `litJets` (bit n-1 for jet n) firing. */
  update(litJets: number): void {
    if (!this.ready || !this.lm || !this.renderer || this.host.hidden || document.visibilityState !== 'visible') return;
    const [w, x, y, z] = quatToScene(this.lm.attitude);
    this.model.quaternion.set(x, y, z, w);
    const steady = this.reducedMotion.matches;
    for (let j = 0; j < 16; j++) {
      const plume = this.plumes[j];
      plume.visible = Boolean(litJets & (1 << j));
      // A firing jet's plume flickers in length.
      if (plume.visible) plume.scale.set(1, steady ? 1 : 0.85 + 0.3 * Math.random(), 1);
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
