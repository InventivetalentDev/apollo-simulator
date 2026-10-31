// Simulation axes -> scene axes:
// +X (up)      -> +y
// +Y (right)   -> -x
// +Z (forward) -> +z

import type { Quat, Vec3 } from '../sim/attitude.ts';

/** A simulation vector (body or inertial axes) in scene axes. */
export function toScene(v: Vec3): Vec3 {
  return [-v[1], v[0], v[2]];
}

/** A simulation attitude quaternion [w, x, y, z] in scene axes, same layout. */
export function quatToScene(q: Quat): Quat {
  return [q[0], -q[2], q[1], q[3]];
}
