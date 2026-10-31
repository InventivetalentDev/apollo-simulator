// The Moon as the LM's guidance computer sees it: its gravity and its
// orientation in the computer's inertial frame (the "basic reference
// coordinates", centred on the Moon).  The simulation uses that frame as its
// own, so positions and directions pass between the two unchanged.

import type { Vec3 } from './attitude.ts';

/** Lunar gravitational parameter, m^3/s^2: the value the average-G routine uses (MUNRVG, SERVICER.agc). */
export const MOON_MU = 4.902778e12;

/**
 * The Moon's departures from a sphere, as the software's coasting integration
 * models them (OBLATE and QUALITY1-3, ORBITAL_INTEGRATION.agc), converted
 * from centiseconds to seconds.  The zonal terms are fixed in the software
 * (J2REQSQ and 2J3RE/J2, Moon entries, CONTROLLED_CONSTANTS.agc); the
 * Earth-facing bulge terms are Apollo 11's pad load (E3J22R2M, E32C31RM).
 */
const MU_J2_R2 = 0.3067493316e18 * 1e4; // mu J2 R^2, m^5/s^2 (J2 = 2.07e-4)
const J3R_OVER_J2 = -176236.02; // J3 R / J2, m (J3 = -2.1e-5)
const THREE_C22_MU_R2 = 9.20479047931e16 * 1e4; // 3 C22 mu R^2, m^5/s^2
const THREE_HALVES_C31_MU_R3 = 1.31289255968e23 * 1e4; // (3/2) C31 mu R^3, m^6/s^2

/**
 * Constants of the Moon's orientation from the flight software's fixed memory
 * (CONTROLLED_CONSTANTS.agc), in radians and radians per second.
 */
const BSUBO = 0.40916190299;
const BDOT = -7.19757301e-14;
const FSUBO = 5.20932947829;
const FDOT = 2.6724041e-6;
const NODIO = 6.19653663041;
const NODDOT = -1.07047011e-8;
const COSI = 0.99964173;
const SINI = 0.02676579;

/**
 * Rows of the matrix that turns inertial vectors into Moon-fixed ones, at
 * `seconds` after the ephemeris epoch (the computer's clock plus TEPHEM).
 * This follows MOONMX (PLANETARY_INERTIAL_ORIENTATION.agc) step for step.
 * The rows are the Moon-fixed X, Y and Z axes in inertial coordinates; Z is
 * the Moon's spin axis.  Physical libration (504LM) is taken as zero.
 */
export function moonAxes(seconds: number): [Vec3, Vec3, Vec3] {
  const b = BSUBO + BDOT * seconds;
  const f = FSUBO + FDOT * seconds;
  const node = NODIO + NODDOT * seconds;
  const cob = Math.cos(b);
  const sob = Math.sin(b);
  const a: Vec3 = [Math.cos(node), cob * Math.sin(node), sob * Math.sin(node)];
  const bv: Vec3 = [-Math.sin(node), cob * Math.cos(node), sob * Math.cos(node)];
  const c: Vec3 = [0, -sob, cob];
  const m2 = bv.map((x, i) => x * SINI + c[i] * COSI) as Vec3;
  const d = bv.map((x, i) => x * COSI - c[i] * SINI) as Vec3;
  const m1 = a.map((x, i) => x * Math.sin(f) - d[i] * Math.cos(f)) as Vec3;
  const m0 = a.map((x, i) => -(x * Math.cos(f) + d[i] * Math.sin(f))) as Vec3;
  return [m0, m1, m2];
}

/** A Moon-fixed vector in inertial coordinates at `seconds` after the ephemeris epoch. */
export function moonFixedToInertial(v: Vec3, seconds: number): Vec3 {
  const [m0, m1, m2] = moonAxes(seconds);
  return [0, 1, 2].map((i) => m0[i] * v[0] + m1[i] * v[1] + m2[i] * v[2]) as Vec3;
}

/** An inertial vector in Moon-fixed coordinates at `seconds` after the ephemeris epoch. */
export function inertialToMoonFixed(v: Vec3, seconds: number): Vec3 {
  return moonAxes(seconds).map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]) as Vec3;
}

/**
 * Gravitational acceleration, m/s^2, at an inertial position, `seconds` after
 * the ephemeris epoch: the point mass plus the terms above.  The zonal terms
 * follow the Legendre-derivative form the software uses; the bulge terms are
 * worked in Moon-fixed axes and turned back.
 */
export function moonGravity(position: Vec3, seconds: number): Vec3 {
  const [m0, m1, m2] = moonAxes(seconds);
  const r = Math.hypot(...position);
  const u = position.map((c) => c / r) as Vec3;
  const x = m0[0] * u[0] + m0[1] * u[1] + m0[2] * u[2];
  const y = m1[0] * u[0] + m1[1] * u[1] + m1[2] * u[2];
  const z = m2[0] * u[0] + m2[1] * u[1] + m2[2] * u[2]; // sine of the latitude
  const r4 = r ** 4;

  // Point mass, J2 and J3: along the radius and along the spin axis.
  const p2 = 3 * z;
  const p3 = (15 * z * z - 3) / 2;
  const p4 = (35 * z ** 3 - 15 * z) / 2;
  const k3 = J3R_OVER_J2 / r;
  const zonal = MU_J2_R2 / r4;
  const radial = -MOON_MU / (r * r) + zonal * (p3 + k3 * p4);
  const axial = -zonal * (p2 + k3 * p3);

  // C22 and C31, in Moon-fixed axes.
  const c22 = THREE_C22_MU_R2 / r4;
  const d22 = -5 * (x * x - y * y);
  const c31 = THREE_HALVES_C31_MU_R3 / (r4 * r);
  const d31 = 5 * x * (1 - 7 * z * z);
  const fx = c22 * (2 * x + d22 * x) + c31 * (5 * z * z - 1 + d31 * x);
  const fy = c22 * (-2 * y + d22 * y) + c31 * d31 * y;
  const fz = c22 * d22 * z + c31 * (10 * x * z + d31 * z);

  return [0, 1, 2].map((i) => radial * u[i] + (axial + fz) * m2[i] + fx * m0[i] + fy * m1[i]) as Vec3;
}
