import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGC, REG } from '../src/agc/cpu.ts';
import { DEG, gimbalMatrix, matMultiply, quatFromAxisAngle, type Mat3, type Vec3 } from '../src/sim/attitude.ts';
import { LunarModule } from '../src/sim/lm.ts';
import { ballPoint, fdaiAngles, onFace } from '../src/ui/fdai.ts';

const near = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual}, expected ${expected}`);

/** The FDAI ball's matrix for an LM turned by `angle` about body axis `axis` from the stable member. */
function turned(axis: Vec3, angle: number): Mat3 {
  const lm = new LunarModule(new AGC(new Uint16Array(36 * 1024)));
  lm.attitude = quatFromAxisAngle(axis, angle);
  return gimbalMatrix(lm.gimbals);
}

test('at zero attitude the ball shows pitch 0 in the centre, the pitch 0 line level, and higher pitch above', () => {
  const m = gimbalMatrix({ outer: 0, inner: 0, middle: 0 });
  const centre = onFace(m, ballPoint(0, 0));
  near(centre[0], 0, 'right');
  near(centre[1], 0, 'up');
  near(centre[2], 1, 'depth');
  for (const yaw of [-60, -20, 20, 60]) near(onFace(m, ballPoint(0, yaw * DEG))[1], 0, `pitch 0 line at yaw ${yaw}`);
  near(onFace(m, ballPoint(10 * DEG, 0))[1], Math.sin(10 * DEG), 'pitch 10 sits above the centre');
});

test('nose up 10 degrees brings pitch 10 to the centre and moves the pitch 0 line down', () => {
  const m = turned([0, 1, 0], 10 * DEG);
  const centre = onFace(m, ballPoint(10 * DEG, 0));
  near(centre[0], 0, 'right');
  near(centre[1], 0, 'up');
  assert.ok(onFace(m, ballPoint(0, 0))[1] < -0.17, 'pitch 0 moved down');
  near(fdaiAngles(m).pitch, 10 * DEG, 'pitch reads 10');
});

test('rolling right turns the ball counterclockwise, and yawing left moves it to the right', () => {
  const rolled = turned([0, 0, 1], 20 * DEG);
  const top = onFace(rolled, ballPoint(90 * DEG, 0));
  assert.ok(top[0] < 0, 'the point above the centre moves left');
  near(fdaiAngles(rolled).roll, 20 * DEG, 'roll reads 20');
  const yawed = turned([1, 0, 0], 20 * DEG);
  assert.ok(onFace(yawed, ballPoint(0, 0))[0] > 0.3, 'the old centre moves right');
  near(fdaiAngles(yawed).yaw, 20 * DEG, 'yaw reads 20');
});

test('the FDAI angles come back from the matrix they build: roll, then yaw, then pitch', () => {
  const pitch = 123 * DEG, yaw = -35 * DEG, roll = 71 * DEG;
  const rx = gimbalMatrix({ outer: yaw, inner: 0, middle: 0 });
  const ry = gimbalMatrix({ outer: 0, inner: pitch, middle: 0 });
  const rz = gimbalMatrix({ outer: 0, inner: 0, middle: roll });
  const m = matMultiply(rz, matMultiply(rx, ry));
  const a = fdaiAngles(m);
  near(a.pitch, pitch, 'pitch');
  near(a.yaw, yaw, 'yaw');
  near(a.roll, roll, 'roll');
  const centre = onFace(m, ballPoint(pitch, yaw));
  near(centre[0], 0, 'the nose point is in the centre (right)');
  near(centre[1], 0, 'the nose point is in the centre (up)');
});

test('the error needles count the CDU error counter pulses and centre when the computer disables the counters', () => {
  const agc = new AGC(new Uint16Array(36 * 1024));
  const lm = new LunarModule(agc);
  agc.channels[0o12] = 0o40; // bit 6: IMU error counters enabled
  for (let i = 0; i < 5; i++) lm.pulse(REG.CDUYCMD, -1);
  lm.pulse(REG.CDUZCMD, 1);
  lm.tick();
  assert.deepEqual(lm.errorNeedles, [0, -5, 1]);
  agc.channels[0o12] = 0;
  lm.tick();
  assert.deepEqual(lm.errorNeedles, [0, 0, 0]);
});
