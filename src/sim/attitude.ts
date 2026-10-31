// Small 3-D rotation toolkit for the spacecraft model.
//
// A rotation is a unit quaternion [w, x, y, z] that turns vectors expressed in
// a body frame into the reference frame: v_ref = q * v_body * q^-1.  Matrices
// are row-major arrays of 9 numbers.

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export type Mat3 = number[];

export const TWO_PI = 2 * Math.PI;
export const DEG = Math.PI / 180;

export const IDENTITY: Quat = [1, 0, 0, 0];

export function quatMultiply(a: Quat, b: Quat): Quat {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

export function quatNormalize(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** Rotation by `angle` radians about a unit axis. */
export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const s = Math.sin(angle / 2);
  return [Math.cos(angle / 2), axis[0] * s, axis[1] * s, axis[2] * s];
}

/** Advance an attitude by a body-frame angular rate (rad/s) over dt seconds. */
export function quatIntegrate(q: Quat, rate: Vec3, dt: number): Quat {
  const w = Math.hypot(rate[0], rate[1], rate[2]);
  if (w === 0) return q;
  const axis: Vec3 = [rate[0] / w, rate[1] / w, rate[2] / w];
  return quatNormalize(quatMultiply(q, quatFromAxisAngle(axis, w * dt)));
}

/** The matrix with the same effect as q: columns are the body axes in the reference frame. */
export function quatToMatrix(q: Quat): Mat3 {
  const [w, x, y, z] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

export function matrixToQuat(m: Mat3): Quat {
  const trace = m[0] + m[4] + m[8];
  let q: Quat;
  if (trace > 0) {
    const s = 2 * Math.sqrt(trace + 1);
    q = [s / 4, (m[7] - m[5]) / s, (m[2] - m[6]) / s, (m[3] - m[1]) / s];
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = 2 * Math.sqrt(1 + m[0] - m[4] - m[8]);
    q = [(m[7] - m[5]) / s, s / 4, (m[1] + m[3]) / s, (m[2] + m[6]) / s];
  } else if (m[4] > m[8]) {
    const s = 2 * Math.sqrt(1 + m[4] - m[0] - m[8]);
    q = [(m[2] - m[6]) / s, (m[1] + m[3]) / s, s / 4, (m[5] + m[7]) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m[8] - m[0] - m[4]);
    q = [(m[3] - m[1]) / s, (m[2] + m[6]) / s, (m[5] + m[7]) / s, s / 4];
  }
  return quatNormalize(q);
}

export function matMultiply(a: Mat3, b: Mat3): Mat3 {
  const r = new Array<number>(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  }
  return r;
}

export function matTranspose(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export function matVec(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * IMU gimbal angles.  The Apollo IMU's gimbals sit in the order stable member,
 * inner (about Y), middle (about Z), outer (about X), navigation base.  The
 * flight software's *SMNB* routine converts stable-member coordinates to
 * navigation-base coordinates with rotations about Y, then Z, then X:
 *   v_NB = Rx(outer) Rz(middle) Ry(inner) v_SM
 * where R is the coordinate-transformation (passive) rotation.
 */
export interface GimbalAngles {
  outer: number;
  inner: number;
  middle: number;
}

/** The matrix that turns stable-member coordinates into navigation-base coordinates. */
export function gimbalMatrix(g: GimbalAngles): Mat3 {
  const co = Math.cos(g.outer), so = Math.sin(g.outer);
  const ci = Math.cos(g.inner), si = Math.sin(g.inner);
  const cm = Math.cos(g.middle), sm = Math.sin(g.middle);
  return [
    cm * ci, sm, -cm * si,
    -co * sm * ci + so * si, co * cm, co * sm * si + so * ci,
    so * sm * ci + co * si, -so * cm, -so * sm * si + co * ci,
  ];
}

/** Inverse of gimbalMatrix (middle gimbal within +-90 degrees). */
export function gimbalAngles(m: Mat3): GimbalAngles {
  return {
    middle: Math.asin(Math.max(-1, Math.min(1, m[1]))),
    inner: Math.atan2(-m[2], m[0]),
    outer: Math.atan2(-m[7], m[4]),
  };
}

/** Wrap an angle into [-pi, pi). */
export function wrapAngle(a: number): number {
  return a - TWO_PI * Math.floor((a + Math.PI) / TWO_PI);
}
