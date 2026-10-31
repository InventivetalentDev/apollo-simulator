import assert from 'node:assert/strict';
import test from 'node:test';
import { AGC, REG } from '../src/agc/cpu.ts';
import { DescentEngine, DPS_FULL_THROTTLE, DPS_MINIMUM, pivotToCg } from '../src/sim/descent-engine.ts';
import { LunarModule } from '../src/sim/lm.ts';
import { MOON_MU, moonAxes, moonFixedToInertial, inertialToMoonFixed } from '../src/sim/moon.ts';

const DEG = Math.PI / 180;
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

test('the Moon turns once a sidereal month about an axis tilted from the inertial Z axis', () => {
  const day = 86400;
  const [x0, y0, z0] = moonAxes(19 * day);
  // Orthonormal to the 8 digits of the software's COSI and SINI constants.
  for (const [a, b] of [[x0, y0], [y0, z0], [z0, x0]]) assert.ok(Math.abs(dot(a, b)) < 1e-7);
  for (const a of [x0, y0, z0]) assert.ok(Math.abs(dot(a, a) - 1) < 1e-7);
  // The spin axis sits about 23.5 degrees (the obliquity, give or take 1.5) from inertial Z.
  const tilt = Math.acos(z0[2]) / DEG;
  assert.ok(tilt > 21 && tilt < 26, `pole ${tilt.toFixed(2)} deg from Z`);
  // In one day the prime meridian turns 360/27.32 degrees.
  const [x1] = moonAxes(20 * day);
  const turn = Math.acos(dot(x0, x1)) / DEG;
  assert.ok(Math.abs(turn - 360 / 27.32) < 0.2, `turns ${turn.toFixed(3)} deg a day`);
  // Moon-fixed and inertial conversions undo each other.
  const v: [number, number, number] = [1.5e6, -7e5, 2e4];
  const back = inertialToMoonFixed(moonFixedToInertial(v, 19 * day), 19 * day);
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(back[k] - v[k]) < 0.2, `round trip within 0.2 m (${back[k] - v[k]})`);
});

test('descent engine: the throttle adds the computer\'s pulses to the minimum, up to full throttle', () => {
  const engine = new DescentEngine();
  engine.armed = true;
  engine.propellant = 8000;
  const run = (seconds: number, ch11: number, ch12 = 0) => {
    for (let i = 0; i < seconds * 3200; i++) engine.step(1 / 3200, ch11, ch12);
  };
  run(1, 0o20000);
  assert.equal(engine.thrust, 0, 'engine off');
  run(1, 0o10000);
  assert.ok(Math.abs(engine.thrust - DPS_MINIMUM) < 1, `ignition at the minimum (${engine.thrust.toFixed(0)} N)`);
  for (let i = 0; i < 4096; i++) engine.pulse(1); // FLATOUT
  run(1, 0o10000);
  assert.ok(Math.abs(engine.thrust - DPS_FULL_THROTTLE) < 1, 'full throttle');
  const before = engine.propellant;
  run(10, 0o10000);
  assert.ok(Math.abs(before - engine.propellant - 147) < 1, `burns about 14.7 kg/s (${(before - engine.propellant).toFixed(1)} kg in 10 s)`);
  for (let i = 0; i < 4096; i++) engine.pulse(-1);
  run(1, 0o10000);
  assert.ok(Math.abs(engine.thrust - DPS_MINIMUM) < 1, 'back to the minimum');
  run(1, 0o20000);
  assert.equal(engine.thrust, 0, 'cut off');

  // Trim gimbal: 0.2 deg/s, stops at 6 degrees.
  run(10, 0o20000, 0o1000);
  assert.ok(Math.abs(engine.gimbal[0] / DEG - 2) < 1e-6, 'pitch +2 deg after 10 s');
  run(40, 0o20000, 0o2000);
  assert.ok(Math.abs(engine.gimbal[1] / DEG + 6) < 1e-9, 'roll stops at -6 deg');
  assert.ok(Math.abs(pivotToCg(15100) - 0.866) < 0.005, 'pivot 0.87 m below the centre of mass at 15.1 t');
});

test('in orbit mode the LM falls around the Moon, and the accelerometers feel only the engine', () => {
  const agc = new AGC(new Uint16Array(36 * 1024));
  const lm = new LunarModule(agc);
  lm.orbiting = true;
  lm.surfaceRadius = 1_735_000;
  const r = 1_750_000;
  lm.position = [r, 0, 0];
  lm.velocity = [0, Math.sqrt(MOON_MU / r), 0];
  const tick = () => lm.tick();
  for (let i = 0; i < 60 * 3200; i++) tick();
  const radius = Math.hypot(...lm.position);
  assert.ok(Math.abs(radius - r) < 5, `circular orbit holds its radius (${(radius - r).toFixed(2)} m)`);
  assert.equal(agc.mem[REG.PIPAX] | agc.mem[REG.PIPAY] | agc.mem[REG.PIPAZ], 0, 'free fall: no accelerometer counts');

  // Engine on at the minimum for 10 s: about 0.3 m/s^2 along body +X.
  lm.engine.armed = true;
  lm.engine.propellant = 8000;
  agc.channels[0o11] = 0o10000;
  for (let i = 0; i < 10 * 3200; i++) tick();
  const counts = agc.mem[REG.PIPAX];
  const expected = (DPS_MINIMUM / lm.mass) * 10 * 100;
  assert.ok(Math.abs(counts - expected) < 5, `PIPAX counts ${counts}, expected about ${expected.toFixed(0)}`);

  // The radar answers a read with a RADARUPT and swings its antenna on command.
  agc.channels[0o13] |= 0o10;
  for (let i = 0; i < 0.1 * 3200; i++) tick();
  assert.equal(agc.channels[0o13] & 0o10, 0, 'read complete');
  assert.ok(agc.interruptRequests[9], 'RADARUPT requested');
  assert.equal(agc.channels[0o33] & 0o360, 0o320, 'antenna in position 1, no data');
  agc.channels[0o12] |= 0o10000;
  for (let i = 0; i < 11 * 3200; i++) tick();
  assert.equal(agc.channels[0o33] & 0o360, 0o260, 'antenna in position 2, no data');
});
