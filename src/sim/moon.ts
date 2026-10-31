// The Moon as the LM's guidance computer sees it: its gravity and its
// orientation in the computer's inertial frame (the "basic reference
// coordinates", centred on the Moon).  The simulation uses that frame as its
// own, so positions and directions pass between the two unchanged.

import type { Vec3 } from './attitude.ts';

/** Lunar gravitational parameter, m^3/s^2: the value the average-G routine uses (MUNRVG, SERVICER.agc). */
export const MOON_MU = 4.902778e12;

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
