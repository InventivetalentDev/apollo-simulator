// The 3D view: the Lunar Module at its simulated attitude against the stars,
// with a plume on each RCS jet while it fires. The scene axes are the
// inertial axes, mapped as in scene-axes.ts, so the camera stays still while
// the LM turns.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { JETS, type LunarModule } from '../sim/lm.ts';
import { quatToScene, toScene } from './scene-axes.ts';

export class LmView {
  private lm: LunarModule | null = null;
  private readonly renderer: THREE.WebGLRenderer | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(40, 1, 0.1, 8000);
  private readonly controls!: OrbitControls;
  private readonly model = new THREE.Group();
  private readonly plumes: THREE.Mesh[] = [];

  constructor(readonly host: HTMLElement) {
    host.innerHTML = `<h2 class="view3d-title" id="view3d-title">3D view</h2>
      <p class="view3d-hint">Drag to look around, scroll to zoom</p>`;
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

    this.camera.position.set(9, 4, 13);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.target.set(0, -0.5, 0);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 40;

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.25));
    const sun = new THREE.DirectionalLight(0xffffff, 3);
    sun.position.set(10, 6, 4);
    this.scene.add(sun);

    let seed = 0x19690720;
    const random = () => {
      let t = (seed += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const stars = new Float32Array(1500 * 3);
    for (let i = 0; i < 1500; i++) {
      const y = 2 * random() - 1;
      const angle = 2 * Math.PI * random();
      const r = Math.sqrt(1 - y * y);
      stars.set([3000 * r * Math.cos(angle), 3000 * y, 3000 * r * Math.sin(angle)], i * 3);
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute('position', new THREE.BufferAttribute(stars, 3));
    this.scene.add(new THREE.Points(
      starGeometry,
      new THREE.PointsMaterial({ color: 0xcfd8e0, size: 1.6, sizeAttenuation: false }),
    ));

    const moon = new THREE.Mesh(
      new THREE.SphereGeometry(4000, 128, 64),
      new THREE.MeshStandardMaterial({ color: 0x8a8a86, roughness: 1 }),
    );
    moon.position.set(0, -4400, 0);
    this.scene.add(moon);

    const gold = new THREE.MeshStandardMaterial({ color: 0xc9a227, metalness: 0.7, roughness: 0.45 });
    const grey = new THREE.MeshStandardMaterial({ color: 0xb8bcc0, metalness: 0.3, roughness: 0.6 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1b1f24 });
    const descent = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.1, 1.6, 8), gold);
    descent.rotation.y = Math.PI / 8;
    descent.position.y = -1.75;
    this.model.add(descent);

    const ascent = new THREE.Mesh(new THREE.BoxGeometry(3.0, 2.2, 2.6), grey);
    ascent.position.set(0, 0.2, 0.2);
    this.model.add(ascent);
    for (const x of [-0.6, 0.6]) {
      const pane = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.4, 0.05), dark);
      pane.position.set(x, 0.7, 1.52);
      this.model.add(pane);
    }
    const hatch = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.05), dark);
    hatch.position.set(0, -0.3, 1.52);
    this.model.add(hatch);

    const tunnel = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.4, 24), grey);
    tunnel.position.y = 1.5;
    this.model.add(tunnel);
    const bell = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.8, 1.0, 24, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x444444, side: THREE.DoubleSide }),
    );
    bell.position.y = -3.0;
    this.model.add(bell);

    const up = new THREE.Vector3(0, 1, 0);
    const strut = (from: THREE.Vector3, to: THREE.Vector3, material: THREE.Material) => {
      const direction = new THREE.Vector3().subVectors(to, from);
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, direction.length()), material);
      mesh.position.copy(from).add(to).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(up, direction.normalize());
      this.model.add(mesh);
    };
    for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      strut(new THREE.Vector3(1.9 * x, -1.2, 1.9 * z), new THREE.Vector3(4.2 * x, -3.4, 4.2 * z), gold);
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.08, 24), gold);
      foot.position.set(4.2 * x, -3.45, 4.2 * z);
      this.model.add(foot);
    }

    const quadPositions = new Set<string>();
    const plumeGeometry = new THREE.ConeGeometry(0.18, 1.0, 16);
    const plumeMaterial = new THREE.MeshBasicMaterial({
      color: 0xffd9a0,
      transparent: true,
      opacity: 0.75,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    for (const jet of JETS) {
      const position = new THREE.Vector3(...toScene(jet.position));
      const key = position.toArray().join(',');
      if (!quadPositions.has(key)) {
        quadPositions.add(key);
        const quad = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 0.35), grey);
        quad.position.copy(position);
        this.model.add(quad);
        strut(new THREE.Vector3(Math.sign(position.x) * 1.5, position.y, 0.2 + Math.sign(position.z) * 1.3), position, grey);
      }
      const exhaust = new THREE.Vector3(...toScene(jet.force)).negate();
      const plume = new THREE.Mesh(plumeGeometry, plumeMaterial);
      // The cone's apex is at +y; its base must point along the exhaust.
      plume.quaternion.setFromUnitVectors(up, exhaust.clone().negate());
      plume.position.copy(position).addScaledVector(exhaust, 0.2 + 0.5);
      plume.visible = false;
      this.model.add(plume);
      this.plumes.push(plume);
    }
    this.scene.add(this.model);
  }

  /** Show the view for an LM, or hide it with null. */
  attach(lm: LunarModule | null): void {
    this.lm = lm;
    this.host.hidden = !lm;
  }

  /** Draw one frame: the LM at its current attitude, with the jets in `litJets` (bit n-1 for jet n) firing. */
  update(litJets: number): void {
    if (!this.lm || !this.renderer || this.host.hidden || document.visibilityState !== 'visible') return;
    const [w, x, y, z] = quatToScene(this.lm.attitude);
    this.model.quaternion.set(x, y, z, w);
    for (let j = 0; j < 16; j++) this.plumes[j].visible = Boolean(litJets & (1 << j));
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
