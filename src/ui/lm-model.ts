// The Lunar Module for the 3D view, built from three.js primitives in scene
// axes (y up, +z forward, -x is the LM's right; see scene-axes.ts), in metres.
// Proportions follow the LM's published dimensions. The RCS thrusters and
// their plumes are placed and aimed from the simulation's jet table, so each
// plume comes out of the nozzle of the jet the autopilot fired.

import * as THREE from 'three';
import { JETS } from '../sim/lm.ts';
import { toScene } from './scene-axes.ts';

export interface LmModel {
  group: THREE.Group;
  /** One plume per jet, in jet order: plumes[j] belongs to jet j + 1. */
  plumes: THREE.Object3D[];
}

const Y = new THREE.Vector3(0, 1, 0);
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** A small seeded generator, so the procedural textures are the same on every load. */
function seeded(seed: number): () => number {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
}

/** Crinkled thermal-blanket foil: random grey facets, tiled seamlessly, for a bump map. */
function foilTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#808080';
  g.fillRect(0, 0, size, size);
  const random = seeded(1969);
  for (let i = 0; i < 600; i++) {
    const x = random() * size;
    const y = random() * size;
    const r = 5 + random() * 20;
    const points = [0, 1, 2].map(() => [x + (random() - 0.5) * 2 * r, y + (random() - 0.5) * 2 * r]);
    const grey = Math.round(80 + random() * 96);
    g.fillStyle = `rgb(${grey},${grey},${grey})`;
    // Draw each facet in the neighbouring tiles too, so the texture repeats without seams.
    for (const dx of [-size, 0, size]) {
      for (const dy of [-size, 0, size]) {
        g.beginPath();
        g.moveTo(points[0][0] + dx, points[0][1] + dy);
        g.lineTo(points[1][0] + dx, points[1][1] + dy);
        g.lineTo(points[2][0] + dx, points[2][1] + dy);
        g.fill();
      }
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(0.8, 0.8);
  return texture;
}

/** Bright at the nozzle (top of the texture), fading to nothing at the end of the plume. */
function plumeTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 128;
  const g = canvas.getContext('2d')!;
  const fade = g.createLinearGradient(0, 0, 0, 128);
  fade.addColorStop(0, '#ffffff');
  fade.addColorStop(0.15, '#ffd9a8');
  fade.addColorStop(0.5, '#6b4a2a');
  fade.addColorStop(1, '#000000');
  g.fillStyle = fade;
  g.fillRect(0, 0, 4, 128);
  return new THREE.CanvasTexture(canvas);
}

function materials() {
  const foil = foilTexture();
  return {
    goldFoil: new THREE.MeshStandardMaterial({ color: 0xd8a03a, metalness: 0.8, roughness: 0.45, bumpMap: foil, bumpScale: 2 }),
    blackFoil: new THREE.MeshStandardMaterial({ color: 0x2a2a2d, metalness: 0.5, roughness: 0.55, bumpMap: foil, bumpScale: 2 }),
    gold: new THREE.MeshStandardMaterial({ color: 0xc89434, metalness: 0.75, roughness: 0.5, side: THREE.DoubleSide }),
    panel: new THREE.MeshStandardMaterial({ color: 0xb4b8bd, metalness: 0.3, roughness: 0.6 }),
    face: new THREE.MeshStandardMaterial({ color: 0x8d9197, metalness: 0.3, roughness: 0.6 }),
    antiGlare: new THREE.MeshStandardMaterial({ color: 0x1d1f22, metalness: 0.1, roughness: 0.75 }),
    aft: new THREE.MeshStandardMaterial({ color: 0x7a8088, metalness: 0.3, roughness: 0.6 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x1b2430, metalness: 1, roughness: 0.08 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x9da1a6, metalness: 0.7, roughness: 0.45 }),
    nozzle: new THREE.MeshStandardMaterial({ color: 0x3a3a3c, metalness: 0.7, roughness: 0.5, side: THREE.DoubleSide }),
    dish: new THREE.MeshStandardMaterial({ color: 0xdedbd2, metalness: 0.1, roughness: 0.65, side: THREE.DoubleSide }),
  };
}

export function buildLunarModule(): LmModel {
  const m = materials();
  const group = new THREE.Group();
  const add = <T extends THREE.Object3D>(object: T): T => {
    group.add(object);
    return object;
  };
  const mesh = (geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], x = 0, y = 0, z = 0) => {
    const object = add(new THREE.Mesh(geometry, material));
    object.position.set(x, y, z);
    return object;
  };
  /** A round rod from one point to another. */
  const strut = (from: THREE.Vector3, to: THREE.Vector3, radius: number, material: THREE.Material) => {
    const along = new THREE.Vector3().subVectors(to, from);
    const rod = mesh(new THREE.CylinderGeometry(radius, radius, along.length(), 10), material);
    rod.position.copy(from).add(to).multiplyScalar(0.5);
    rod.quaternion.setFromUnitVectors(Y, along.normalize());
    return rod;
  };
  /** A shallow dish facing `facing`, its rim centred at `at`. */
  const dish = (at: THREE.Vector3, facing: THREE.Vector3, radius: number) => {
    const cap = mesh(new THREE.SphereGeometry(radius * 1.6, 24, 6, 0, Math.PI * 2, 0, 0.68), m.dish);
    const direction = facing.clone().normalize();
    // The cap sits around the sphere's +y pole with its hollow towards -y; turn the hollow to face forward.
    cap.quaternion.setFromUnitVectors(Y.clone().negate(), direction);
    cap.position.copy(at).addScaledVector(direction, radius * 1.6 * Math.cos(0.68));
    strut(at, at.clone().addScaledVector(direction, radius * 0.7), 0.015, m.metal);
  };

  // ---- Descent stage: an octagon whose long faces carry the legs, gold foil
  // on the sides, black foil on the deck and the base.
  const octagon = (half: number, chamfer: number) => {
    const a = half;
    const b = half - chamfer;
    return new THREE.Shape([[b, a], [a, b], [a, -b], [b, -a], [-b, -a], [-a, -b], [-a, b], [-b, a]].map(([x, y]) => new THREE.Vector2(x, y)));
  };
  const prism = (shape: THREE.Shape, bottom: number, height: number, caps: THREE.Material, sides: THREE.Material) => {
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
    geometry.rotateX(-Math.PI / 2); // extrude upwards
    return mesh(geometry, [caps, sides], 0, bottom, 0);
  };
  prism(octagon(2.1, 0.75), -2.55, 1.65, m.blackFoil, m.goldFoil);
  prism(octagon(2.115, 0.755), -1.15, 0.25, m.blackFoil, m.blackFoil);

  // Descent engine bell, flaring from the throat inside the stage.
  const bell: THREE.Vector2[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    bell.push(new THREE.Vector2(0.3 + 0.45 * (1 - (1 - t) ** 2.4), -2.35 - 1.05 * t));
  }
  mesh(new THREE.LatheGeometry(bell, 40), m.nozzle);

  // Porch under the hatch, with its handrails.
  mesh(new THREE.BoxGeometry(0.95, 0.05, 1.1), m.gold, 0, -0.87, 1.95);
  for (const x of [-0.46, 0.46]) {
    strut(v(x, -0.85, 1.45), v(x, -0.55, 1.6), 0.015, m.metal);
    strut(v(x, -0.55, 1.6), v(x, -0.55, 2.45), 0.015, m.metal);
  }

  // ---- Landing gear: one leg on each long face. A primary strut, two
  // secondary struts from the lower corners, a dish footpad, and a contact
  // probe below every footpad except the forward one, which carries the ladder.
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const out = v(dx, 0, dz);
    const side = v(dz, 0, -dx);
    const top = out.clone().multiplyScalar(2.15).setY(-1.05);
    const foot = out.clone().multiplyScalar(4.25).setY(-3.95);
    strut(top, foot, 0.075, m.gold);
    const knee = top.clone().lerp(foot, 0.82);
    for (const s of [-1, 1]) strut(out.clone().multiplyScalar(2.1).addScaledVector(side, 0.8 * s).setY(-2.5), knee, 0.045, m.metal);
    strut(out.clone().multiplyScalar(2.1).setY(-1.95), top.clone().lerp(foot, 0.45), 0.035, m.metal);
    const pad = mesh(
      new THREE.LatheGeometry([[0, -0.1], [0.3, -0.1], [0.44, -0.03], [0.47, 0.05], [0.43, 0.06], [0, 0]].map(([x, y]) => new THREE.Vector2(x, y)), 28),
      m.gold,
    );
    pad.position.copy(foot).setY(-4.0);
    if (dz === 1) {
      // Ladder rails and rungs, just in front of the strut.
      const along = new THREE.Vector3().subVectors(foot, top);
      const normal = v(0, along.z, -along.y).normalize(); // the strut's upper, outer side
      const start = top.clone().addScaledVector(normal, 0.12);
      const end = top.clone().lerp(foot, 0.9).addScaledVector(normal, 0.12);
      for (const x of [-0.22, 0.22]) strut(start.clone().setX(x), end.clone().setX(x), 0.014, m.metal);
      for (let i = 1; i < 12; i++) {
        const at = start.clone().lerp(end, i / 12);
        strut(at.clone().setX(-0.22), at.clone().setX(0.22), 0.01, m.metal);
      }
    } else {
      strut(foot.clone().setY(-4.1), foot.clone().addScaledVector(out, 0.15).setY(-5.75), 0.016, m.metal);
    }
  }

  // ---- Ascent stage: the flat front face with the hatch and the two
  // triangular windows, the crew compartment behind it, the aft equipment
  // bay, the propellant tank bulges, the docking tunnel and the antennas.
  const face = new THREE.Shape([[-1.2, -0.85], [1.2, -0.85], [1.2, 0.7], [0.7, 1.35], [-0.7, 1.35], [-1.2, 0.7]].map(([x, y]) => new THREE.Vector2(x, y)));
  mesh(new THREE.ExtrudeGeometry(face, { depth: 1.25, bevelEnabled: false }), [m.face, m.panel], 0, 0, 0.1);
  // The black anti-glare surround of the windows, then each pane in a metal frame.
  const surround = new THREE.Shape([[-1.05, 0.45], [1.05, 0.45], [1.05, 0.75], [0.62, 1.28], [-0.62, 1.28], [-1.05, 0.75]].map(([x, y]) => new THREE.Vector2(x, y)));
  mesh(new THREE.ShapeGeometry(surround), m.antiGlare, 0, 0, 1.352);
  for (const s of [-1, 1]) {
    const triangle = (grow: number) =>
      new THREE.Shape([[0.2 - grow, 1.2 + grow * 1.5], [0.95 + grow * 2, 0.72], [0.2 - grow, 0.55 - grow]].map(([x, y]) => new THREE.Vector2(x * s, y)));
    mesh(new THREE.ShapeGeometry(triangle(0.04)), m.metal, 0, 0, 1.355);
    mesh(new THREE.ShapeGeometry(triangle(0)), m.glass, 0, 0, 1.358);
  }
  mesh(new THREE.BoxGeometry(0.92, 0.92, 0.02), m.glass, 0, -0.35, 1.355);
  mesh(new THREE.BoxGeometry(0.8, 0.8, 0.04), m.panel, 0, -0.35, 1.37);
  mesh(new THREE.BoxGeometry(0.34, 0.02, 0.3), m.glass, 0.4, 1.355, 0.75);

  const cabin = mesh(new THREE.CylinderGeometry(1.15, 1.15, 1.1, 40), m.panel, 0, 0.2, -0.45);
  cabin.rotation.x = Math.PI / 2;
  mesh(new THREE.BoxGeometry(2.1, 1.15, 1.05), m.aft, 0, 0.45, -1.5);
  for (const s of [-1, 1]) {
    const tank = mesh(new THREE.SphereGeometry(0.6, 32, 16), m.aft, 1.1 * s, -0.25, -0.55);
    tank.scale.set(0.75, 0.9, 1.2);
  }
  mesh(new THREE.CylinderGeometry(0.42, 0.46, 0.38, 32), m.panel, 0, 1.5, -0.35);
  const drogue = mesh(new THREE.TorusGeometry(0.43, 0.035, 10, 40), m.metal, 0, 1.69, -0.35);
  drogue.rotation.x = Math.PI / 2;

  strut(v(-0.45, 1.35, 0.95), v(-0.45, 1.7, 0.95), 0.05, m.metal);
  dish(v(-0.45, 1.72, 0.95), v(0, 0.5, 1), 0.3); // rendezvous radar
  strut(v(-1.1, 1.0, -0.6), v(-1.55, 1.5, -0.6), 0.035, m.metal);
  dish(v(-1.55, 1.52, -0.6), v(-0.3, 1, 0.2), 0.33); // steerable S-band antenna
  for (const s of [-1, 1]) strut(v(0.95 * s, 1.0, -1.95), v(1.15 * s, 1.85, -2.15), 0.012, m.metal); // VHF antennas

  // ---- RCS quads: a housing on struts from the cabin, and a nozzle for
  // every jet, pointing the way that jet's exhaust goes.
  const plumes: THREE.Object3D[] = [];
  const plumeMap = plumeTexture();
  const glow = (color: number, opacity: number) =>
    new THREE.MeshBasicMaterial({ color, map: plumeMap, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  /** A cone with its apex at the origin, opening along +y over `length`. */
  const plumeCone = (radius: number, length: number) => new THREE.ConeGeometry(radius, length, 24, 1, true).rotateX(Math.PI).translate(0, length / 2, 0);
  // Nested cones, wide and faint outside, narrow and bright inside, so the plume has no hard edge.
  const layers = [
    { geometry: plumeCone(0.45, 1.5), material: glow(0xffc98a, 0.16) },
    { geometry: plumeCone(0.3, 1.25), material: glow(0xffc98a, 0.24) },
    { geometry: plumeCone(0.16, 0.9), material: glow(0xffe2bd, 0.4) },
    { geometry: plumeCone(0.07, 0.5), material: glow(0xffffff, 0.85) },
  ];
  const nozzle = new THREE.CylinderGeometry(0.035, 0.07, 0.2, 14, 1, true);
  const quads = new Set<string>();
  for (const jet of JETS) {
    const p = v(...toScene(jet.position));
    const key = p.toArray().join(',');
    if (!quads.has(key)) {
      quads.add(key);
      mesh(new THREE.BoxGeometry(0.3, 0.42, 0.3), m.metal, p.x, p.y, p.z);
      const sx = Math.sign(p.x);
      const front = p.z > 0;
      strut(v(1.2 * sx, 0, front ? 1.0 : -0.9), p, 0.035, m.metal);
      strut(v(1.2 * sx, -0.4, front ? 0.6 : -0.5), p, 0.035, m.metal);
    }
    const exhaust = v(...toScene(jet.force)).negate();
    const offset = exhaust.y !== 0 ? 0.21 : 0.15;
    const n = mesh(nozzle, m.nozzle);
    n.quaternion.setFromUnitVectors(Y.clone().negate(), exhaust);
    n.position.copy(p).addScaledVector(exhaust, offset + 0.1);
    const plume = new THREE.Group();
    plume.add(...layers.map(({ geometry, material }) => new THREE.Mesh(geometry, material)));
    plume.quaternion.setFromUnitVectors(Y, exhaust);
    plume.position.copy(p).addScaledVector(exhaust, offset + 0.2);
    plume.visible = false;
    plumes.push(plume);
  }

  group.traverse((object) => {
    object.castShadow = true;
    object.receiveShadow = true;
  });
  // Plumes are light, not matter: added after the shadow pass above.
  group.add(...plumes);
  return { group, plumes };
}
