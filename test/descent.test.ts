import assert from 'node:assert/strict';
import test from 'node:test';
import { AGC, REG } from '../src/agc/cpu.ts';
import { readDsky } from '../src/agc/dsky.ts';
import { descentState, loadDescent, prepareLunarModule } from '../src/sim/descent.ts';
import { DescentEngine, DPS_FULL_THROTTLE, DPS_MINIMUM, pivotToCg } from '../src/sim/descent-engine.ts';
import { LunarModule } from '../src/sim/lm.ts';
import { cross } from '../src/sim/attitude.ts';
import { MOON_MU, moonAxes, moonFixedToInertial, inertialToMoonFixed, moonSpin } from '../src/sim/moon.ts';
import { DESCENT_STEPS, DescentChecklist } from '../src/ui/descent-checklist.ts';
import { bootLm } from './helpers.ts';

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
  // moonSpin is how fast a point on the surface moves: about 4.6 m/s at the equator.
  const site: [number, number, number] = [1.73e6, 2e5, -1e5];
  const moved = moonFixedToInertial(inertialToMoonFixed(site, 19 * day), 19 * day + 1).map((x, k) => x - site[k]);
  const predicted = cross(moonSpin(19 * day), site);
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(moved[k] - predicted[k]) < 0.05, `surface moves ${moved[k].toFixed(3)} m/s, spin says ${predicted[k].toFixed(3)}`);
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

test('in orbit mode the LM coasts around the Moon, the accelerometers feel only the engine, and the landing radar measures', () => {
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
  assert.ok(Math.abs(radius - r) < 5, `a circular orbit keeps its radius for a minute (${(radius - r).toFixed(2)} m)`);
  assert.equal(agc.mem[REG.PIPAX] | agc.mem[REG.PIPAY] | agc.mem[REG.PIPAZ], 0, 'free fall: no accelerometer counts');

  // Engine on at the minimum for 10 s: about 0.3 m/s^2 along body +X.
  lm.engine.armed = true;
  lm.engine.propellant = 8000;
  agc.channels[0o11] = 0o10000;
  for (let i = 0; i < 10 * 3200; i++) tick();
  const counts = agc.mem[REG.PIPAX];
  const expected = (DPS_MINIMUM / lm.mass) * 10 * 100;
  assert.ok(Math.abs(counts - expected) < 5, `PIPAX counts ${counts}, expected about ${expected.toFixed(0)}`);

  // The landing radar.  Its altitude beam points down and to the side of body -X, so here it
  // reaches the surface 15 km below: data good (bits 5 and 8 low), the high range scale (bit 9 high).
  assert.equal(agc.channels[0o33] & 0o760, 0o500, 'antenna in position 1, data good, high range scale');
  const read = (select: number) => {
    agc.channels[0o13] = (agc.channels[0o13] & ~0o17) | 0o10 | select;
    agc.interruptRequests[9] = false;
    for (let i = 0; i < 0.1 * 3200; i++) tick();
    assert.equal(agc.channels[0o13] & 0o10, 0, 'read complete');
    assert.ok(agc.interruptRequests[9], 'RADARUPT requested');
    return agc.mem[REG.RNRAD];
  };
  const FOOT = 0.3048;
  const slant = lm.radarRange!;
  assert.ok(slant > 15_000 && slant < 25_000, `slant range ${slant.toFixed(0)} m`);
  const high = read(7);
  assert.ok(Math.abs(high - lm.radarRange! / (5.395 * FOOT)) < 5, `range count ${high} at 5.395 ft`);
  // Velocity counts carry a 12,288 bias.  The three antenna axes are square to each other, so the
  // velocities they measure add up to the speed against the ground: 50 m/s straight down here.
  const up = lm.position.map((x) => x / Math.hypot(...lm.position));
  const ground = cross(moonSpin(lm.ephemerisTime), lm.position);
  lm.velocity = ground.map((v, k) => v - 50 * up[k]) as typeof lm.velocity;
  const speeds = [4, 5, 6].map((select, k) => (read(select) - 12288) * [-0.644, 1.212, 0.8668][k] * FOOT);
  const speed = Math.hypot(...speeds);
  assert.ok(Math.abs(speed - 50) < 1, `velocity counts add up to ${speed.toFixed(2)} m/s`);
  // Below 2,500 ft the radar measures range on its low scale, 1.079 ft a count.
  lm.position = [lm.surfaceRadius + 500, 0, 0];
  const low = read(7);
  assert.equal(agc.channels[0o33] & 0o400, 0, 'low range scale');
  assert.ok(Math.abs(low - lm.radarRange! / (1.079 * FOOT)) < 3, `range count ${low} at 1.079 ft`);
  // Turned over, the beam points away from the Moon: no data.
  lm.attitude = [0, 0, 0, 1];
  tick();
  assert.equal(lm.radarRange, null, 'beam misses the Moon');
  assert.equal(agc.channels[0o33] & 0o220, 0o220, 'no data');
  assert.equal(read(7), 0, 'empty count');
  // The antenna swings to position 2 on command.
  agc.channels[0o12] |= 0o10000;
  for (let i = 0; i < 11 * 3200; i++) tick();
  assert.equal(agc.channels[0o33] & 0o140, 0o040, 'antenna in position 2');
});

test('Luminary099 flies the powered descent from the setup to the surface, with the landing radar', () => {
  const { agc, lm, run, keys, address } = bootLm();
  const state = descentState();
  prepareLunarModule(lm, state);
  run(16);
  loadDescent(agc, lm, address, state);
  // RSET clears the fresh start's alarm; V48 loads the autopilot data (15,100 kg).
  keys('RSET V 4 8 E V 2 1 E 2 1 1 0 2 E PRO V 2 1 E + 3 3 2 9 0 E PRO PRO');
  run(2);
  keys('V 3 7 E 6 3 E');

  const word = (a: number) => (agc.mem[a] & 0o40000 ? -(~agc.mem[a] & 0o37777) : agc.mem[a]);
  const double = (name: string, scaleExponent: number, offset = 0) => {
    const a = address(name) + offset;
    return ((word(a) * 2 ** 14 + word(a + 1)) / 2 ** 28) * 2 ** scaleExponent;
  };
  const clock = () => (agc.mem[REG.TIME2] * 2 ** 14 + agc.mem[REG.TIME1]) / 100;
  // How far the computer's position (RN, at PIPTIME) is above or below the LM's.
  const radialError = () => {
    const rn = [0, 2, 4].map((k) => double('RN', 29, k));
    const lag = clock() - double('PIPTIME', 28) / 100;
    const truth = lm.position.map((x, k) => x - lm.velocity[k] * lag);
    const up = truth.map((x) => x / Math.hypot(...truth));
    return rn.reduce((sum, x, k) => sum + (x - truth[k]) * up[k], 0);
  };

  // The crew's part: do what each step of the panel's checklist asks: press its key, key in
  // its verb (step 1 was keyed above), or stop the engine at the contact light.
  const checklist = new DescentChecklist(address);
  const steps: number[] = [];
  let ignition = 0;
  let errorAtIgnition = NaN;
  let fullThrottle = 0;
  let radarAltitude = NaN;
  let highGate: { time: number; altitude: number; error: number } | undefined;
  let p65: { altitude: number; error: number } | undefined;
  let radarFailed = false;
  // Check as often as a 10 Hz screen would, so brief displays between questions show up.
  for (let t = 0; t < 1200 && steps.at(-1) !== DESCENT_STEPS; t += 0.1) {
    run(0.1);
    const d = readDsky(agc);
    const step = checklist.current(agc, lm)!;
    if (step.number !== steps.at(-1)) {
      steps.push(step.number);
      // Leave V99 waiting a few seconds, through P63's once-a-second rewrites of the
      // display: the step must not waver, even at every 10 ms.
      if (step.key === 'PRO' && step.title.startsWith('V99')) {
        const seen = new Set<string>();
        for (let i = 0; i < 400; i++) {
          run(0.01);
          seen.add(checklist.current(agc, lm)!.title);
        }
        assert.deepEqual([...seen], [step.title], 'the V99 step holds while it waits');
      }
      if (step.key) keys(step.key);
      else if (step.keys && step.number > 1) keys(step.keys);
      else if (step.stopEngine) lm.engine.armed = false;
    }
    const altitude = Math.hypot(...lm.position) - lm.surfaceRadius;
    if (!ignition && DescentEngine.commandedOn(agc.channels[0o11])) {
      ignition = clock();
      errorAtIgnition = radialError();
    }
    if (ignition && clock() - ignition > 40 && !fullThrottle) fullThrottle = lm.engine.thrust;
    if (lm.radarRange !== null && Number.isNaN(radarAltitude)) radarAltitude = altitude;
    // HFLSHFLG and VFLSHFLG (flagword 11 bits 1 and 2): a measurement failed the computer's reasonableness test.
    if (agc.mem[address('FLGWRD11')] & 0o3) radarFailed = true;
    if (d.prog === '64' && !highGate) highGate = { time: clock(), altitude, error: radialError() };
    if (d.prog === '65' && !p65) p65 = { altitude, error: radialError() };
  }

  const fmt = (s: number) => `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${(s % 60).toFixed(0).padStart(2, '0')}`;
  // Apollo 11 lit the engine at 102:33:05.
  const apollo11 = 102 * 3600 + 33 * 60 + 5;
  assert.ok(ignition && Math.abs(ignition - apollo11) < 60, `ignition at ${fmt(ignition)}`);
  // The computer coasted its state to the burn with the same lunar gravity as the simulation.
  assert.ok(Math.abs(errorAtIgnition) < 20, `computer within 20 m of the LM at ignition (${errorAtIgnition.toFixed(1)} m)`);
  assert.ok(Math.abs(fullThrottle - DPS_FULL_THROTTLE) < 100, `full throttle after the zoom time (${fullThrottle.toFixed(0)} N)`);
  // The radar sees the ground once the computer has turned the LM windows up, below 30,000 ft.
  assert.ok(radarAltitude > 7000 && radarAltitude < 9144, `radar data from ${radarAltitude.toFixed(0)} m`);
  assert.ok(highGate, 'P64 reached');
  assert.ok(highGate.altitude > 1500 && highGate.altitude < 3000, `high gate at ${highGate.altitude.toFixed(0)} m, ${fmt(highGate.time)}`);
  // With the radar's data the computer knows its altitude to a few metres.
  assert.ok(Math.abs(highGate.error) < 5, `computer within 5 m of the LM at high gate (${highGate.error.toFixed(1)} m)`);
  assert.ok(p65, 'P65 reached');
  assert.ok(p65.altitude > 10 && p65.altitude < 100, `P65 from ${p65.altitude.toFixed(0)} m`);
  assert.ok(Math.abs(p65.error) < 3, `computer within 3 m of the LM in P65 (${p65.error.toFixed(1)} m)`);
  assert.ok(agc.mem[address('LRLCTR')] > 50 && agc.mem[address('LRMCTR')] > 50, 'the computer used altitude and velocity measurements');
  assert.equal(radarFailed, false, 'no measurement failed the reasonableness tests');
  // The checklist walked the crew through every step, in order.
  assert.deepEqual(steps, Array.from({ length: DESCENT_STEPS }, (_, k) => k + 1), `checklist steps ${steps.join(' ')}`);
  // Touchdown: the engine stopped at the contact light, 1.7 m up, so the LM dropped the last of it.
  const touchdown = lm.touchdown!;
  assert.ok(touchdown.vertical > -3 && touchdown.vertical < 0, `touchdown at ${touchdown.vertical.toFixed(2)} m/s vertical`);
  assert.ok(touchdown.horizontal < 0.5, `and ${touchdown.horizontal.toFixed(2)} m/s horizontal`);
  const site = inertialToMoonFixed(lm.position, lm.ephemerisTime);
  const fromSite = Math.hypot(...site.map((x, k) => x - lm.site[k]));
  assert.ok(fromSite < 500, `${fromSite.toFixed(0)} m from the planned landing site`);
  assert.equal(agc.restarts, 0, 'no restarts');
  assert.deepEqual([0, 1, 2].map((k) => agc.mem[address('FAILREG') + k]), [0, 0, 0], 'no alarms');
});
