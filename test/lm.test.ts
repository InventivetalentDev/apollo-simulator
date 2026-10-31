import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGC, MCT_PER_SECOND } from '../src/agc/cpu.ts';
import { pressKey, readDsky, releaseKey, type DskyKey } from '../src/agc/dsky.ts';
import { cross, DEG, gimbalAngles, gimbalMatrix, type Vec3 } from '../src/sim/attitude.ts';
import { inertiaForMass, JETS, jetsFromChannels, LunarModule } from '../src/sim/lm.ts';
import { assembleProgram } from './helpers.ts';

test('gimbal angles survive a round trip through the stable-member-to-navigation-base matrix', () => {
  for (const [o, i, m] of [
    [10, 20, 5],
    [-170, 135, -60],
    [359, -45, 80],
  ]) {
    const g = gimbalAngles(gimbalMatrix({ outer: o * DEG, inner: i * DEG, middle: m * DEG }));
    const wrap = (a: number) => ((((a / DEG) % 360) + 540) % 360) - 180;
    assert.ok(Math.abs(wrap(g.outer) - wrap(o * DEG)) < 1e-9, `outer ${o}`);
    assert.ok(Math.abs(wrap(g.inner) - wrap(i * DEG)) < 1e-9, `inner ${i}`);
    assert.ok(Math.abs(wrap(g.middle) - wrap(m * DEG)) < 1e-9, `middle ${m}`);
  }
});

test('the jets wired to channels 5 and 6 do what the autopilot\'s jet tables say', () => {
  const effect = (ch5: number, ch6: number) => {
    const mask = jetsFromChannels(ch5, ch6);
    const torque: Vec3 = [0, 0, 0];
    const force: Vec3 = [0, 0, 0];
    for (const jet of JETS) {
      if (!(mask & (1 << (jet.number - 1)))) continue;
      const t = cross(jet.position, jet.force);
      for (let k = 0; k < 3; k++) {
        torque[k] += t[k];
        force[k] += jet.force[k];
      }
    }
    return { torque: torque.map(Math.sign), force: force.map(Math.sign) };
  };
  // Channel 6 policies from P-AXIS_RCS_AUTOPILOT.agc (TYPEP table).
  assert.deepEqual(effect(0, 0o125), { torque: [1, 0, 0], force: [0, 0, 0] }, '+P');
  assert.deepEqual(effect(0, 0o252), { torque: [-1, 0, 0], force: [0, 0, 0] }, '-P');
  assert.deepEqual(effect(0, 0o220), { torque: [0, 0, 0], force: [0, 1, 0] }, '+Y');
  assert.deepEqual(effect(0, 0o140), { torque: [0, 0, 0], force: [0, -1, 0] }, '-Y');
  assert.deepEqual(effect(0, 0o011), { torque: [0, 0, 0], force: [0, 0, 1] }, '+Z');
  assert.deepEqual(effect(0, 0o006), { torque: [0, 0, 0], force: [0, 0, -1] }, '-Z');
  // Channel 5 policies from Q_R-AXIS_RCS_AUTOPILOT.agc (ALLJETS/TYPEPOLY).  U turns +Q +R, V turns -Q +R.
  assert.deepEqual(effect(0o204, 0), { torque: [0, 1, 1], force: [0, 0, 0] }, '+U');
  assert.deepEqual(effect(0o110, 0), { torque: [0, -1, -1], force: [0, 0, 0] }, '-U');
  assert.deepEqual(effect(0o041, 0), { torque: [0, -1, 1], force: [0, 0, 0] }, '+V');
  assert.deepEqual(effect(0o022, 0), { torque: [0, 1, -1], force: [0, 0, 0] }, '-V');
  assert.deepEqual(effect(0o252, 0), { torque: [0, 0, 0], force: [1, 0, 0] }, '+X');
  assert.deepEqual(effect(0o125, 0), { torque: [0, 0, 0], force: [-1, 0, 0] }, '-X');
});

test('moments of inertia from the 1/ACCS fits are in the range of a fuelled LM', () => {
  for (const i of inertiaForMass(15100)) assert.ok(i > 30000 && i < 40000, `${i} kg m^2`);
});

function bootLm() {
  const { result } = assembleProgram('Luminary099');
  const agc = new AGC(result.rope);
  const lm = new LunarModule(agc);
  agc.peripheral = lm;
  const run = (seconds: number) => agc.run(Math.round(seconds * MCT_PER_SECOND));
  const keys = (seq: string) => {
    for (const tok of seq.split(' ')) {
      const key = ({ V: 'VERB', N: 'NOUN', E: 'ENTR' } as Record<string, DskyKey>)[tok] ?? (tok as DskyKey);
      pressKey(agc, key);
      if (key === 'PRO') {
        run(0.3);
        releaseKey(agc, key);
      }
      run(0.15);
    }
  };
  const erasable = (name: string) => agc.mem[result.symbols.find((s) => s.name === name)!.value];
  return { agc, lm, run, keys, erasable };
}

test('Luminary099 flies the LM: IMU start-up, attitude hold and an automatic maneuver', () => {
  const { agc, lm, run, keys, erasable } = bootLm();
  lm.setGimbals({ outer: 10 * DEG, inner: 20 * DEG, middle: 5 * DEG });

  // With the IMU already operating at a fresh start, the software zeroes the
  // CDUs, lets them count up to the gimbal angles, then enables the DAP.
  run(16);
  assert.equal(erasable('IMODES33') & 0o40, 0, 'IMODES33 bit 6 clear: IMU usable, DAP enabled');
  keys('V 1 6 N 2 0 E');
  run(1.5);
  assert.deepEqual(readDsky(agc).r, ['+01000', '+02000', '+00500'], 'N20 shows the gimbal angles');

  // DAP data: descent stage attached, 0.3 degree deadband, 2 deg/s maneuvers; LM weight in pounds.
  keys('V 4 8 E V 2 1 E 2 1 1 0 2 E PRO V 2 1 E + 3 3 2 9 0 E PRO PRO');
  run(2);

  // Attitude hold stops a 2 deg/s pitch rate.
  lm.rate = [0, 2 * DEG, 0];
  run(15);
  assert.ok(Math.hypot(...lm.rate) / DEG < 0.1, `rate damped (${lm.rate.map((r) => (r / DEG).toFixed(3))} deg/s)`);
  assert.ok(lm.jetSeconds.some((s) => s > 0), 'jets fired');

  // V49: the computer turns the LM to the keyed gimbal angles.
  lm.controls.mode = 'auto';
  keys('V 3 7 E 0 0 E');
  run(2);
  keys('V 4 9 E V 2 5 E + 0 4 5 0 0 E + 0 1 0 0 0 E + 0 0 0 0 0 E PRO');
  run(1);
  keys('PRO');
  run(40);
  const g = lm.gimbals;
  const miss = Math.max(Math.abs(g.outer / DEG - 45), Math.abs(g.inner / DEG - 10), Math.abs(g.middle / DEG));
  assert.ok(miss < 1, `maneuver ends within 1 degree (${[g.outer, g.inner, g.middle].map((a) => (a / DEG).toFixed(2))})`);
  assert.equal(agc.restarts, 0);
});
