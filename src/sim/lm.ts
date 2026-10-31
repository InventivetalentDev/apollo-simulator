// The Lunar Module around the guidance computer: a rigid body with 16 RCS
// jets, the inertial measurement unit (IMU) and its angle counters (CDUs),
// the accelerometers (PIPAs), and the panel switches and hand controller the
// software reads.  Everything here talks to the computer the way the real
// hardware did: through input/output channels and counter pulses.
//
// Physical constants come from the flight software where it states them, so
// the vehicle behaves the way the autopilot expects:
//   - jet thrust 100 lbf at a 5.5 ft lever arm (TORKJET1, CONTROLLED_CONSTANTS.agc)
//   - moments of inertia from the 1/ACCS curve fits of jet acceleration
//     against mass (INERCONA/B/C, AOSTASK_AND_AOSJOB.agc)
//   - 1 cm/s per accelerometer pulse (KPIP, CONTROLLED_CONSTANTS.agc)
//   - jet-to-channel wiring from the jet-selection tables of the autopilot
//     (P-AXIS_RCS_AUTOPILOT.agc, Q_R-AXIS_RCS_AUTOPILOT.agc)
//
// In orbit mode the LM also moves: it falls around the Moon, fires its descent
// engine (descent-engine.ts), and measures its altitude and velocity with the
// landing radar.  Positions are in the computer's own inertial frame (moon.ts).

import { AGC, REG, type Peripheral } from '../agc/cpu.ts';
import {
  cross,
  gimbalAngles,
  gimbalMatrix,
  IDENTITY,
  matMultiply,
  matrixToQuat,
  matTranspose,
  matVec,
  quatIntegrate,
  quatToMatrix,
  quatMultiply,
  quatNormalize,
  quatFromAxisAngle,
  TWO_PI,
  type GimbalAngles,
  type Mat3,
  type Quat,
  type Vec3,
} from './attitude.ts';
import { DescentEngine, pivotToCg } from './descent-engine.ts';
import { moonGravity, moonSpin } from './moon.ts';

const TICK = 1 / 3200; // the computer's scaler calls the hardware 3200 times a second
const LBF = 4.4482216;
const FOOT = 0.3048;
const JET_THRUST = 100 * LBF;
const JET_ARM = 5.5 * FOOT;

/** CDU angle counters: 2^15 counts per revolution. */
const CDU_COUNTS = 32768;
/** One gyro torquing pulse turns the stable member 2^-21 revolution. */
const GYRO_PULSE = TWO_PI / 2 ** 21;
/** One coarse-align drive pulse moves a gimbal 4 CDU counts (COARS divides the angle error by 4). */
const COARSE_PULSE = (4 * TWO_PI) / CDU_COUNTS;
/** Accelerometer pulse: 1 cm/s. */
const PIPA_PULSE = 0.01;
/** Full hand-controller deflection gives 42 counts (20 deg/s in normal scaling, STIKLOAD). */
const RHC_FULL_COUNTS = 42;
/** Stick deflection (as a fraction of full travel) that takes the controller out of detent. */
const RHC_DETENT = 0.05;
/** A landing radar read takes this long before the radar interrupts (ticks). */
const RADAR_READ_TICKS = Math.round(0.09 * 3200);
/** The landing radar antenna takes this long to swing to position 2 (ticks). */
const RADAR_SWING_TICKS = 10 * 3200;
/** An angle given in CDU counts, as the pad load gives the radar antenna's angles. */
const cduAngle = (counts: number) => (counts * TWO_PI) / CDU_COUNTS;
/**
 * The landing radar antenna's axes in navigation-base axes, in position 1
 * (descent) and position 2 (hover): rotations about X and Y by the pad-loaded
 * LRALPHA and LRBETA1, and LRALPHA2 and LRBETA2.  The computer gets the same
 * angles in its erasable load (descent.ts).
 */
const RADAR_ANTENNA = [
  gimbalMatrix({ outer: cduAngle(0o1027), inner: cduAngle(0o4204), middle: 0 }),
  gimbalMatrix({ outer: cduAngle(0o1022), inner: cduAngle(0o4), middle: 0 }),
];
/** The altitude beam in antenna axes (HBEAMANT, CONTROLLED_CONSTANTS.agc, which holds it at half scale). */
const ALTITUDE_BEAM: Vec3 = [-0.9374036082, 0, -0.3482448542];
/** Slant range per count on the low scale (HSCAL); the high scale counts five times as much (HISCALIM). */
const RANGE_LOW_SCALE = 1.079 * FOOT;
const RANGE_HIGH_SCALE = 5 * RANGE_LOW_SCALE;
/** Below this slant range the radar measures on its low scale. */
const RANGE_SCALE_CHANGE = 2500 * FOOT;
/** Velocity counts are biased by 12,288 (LVELBIAS, the 153.6 kHz carrier). */
const VELOCITY_BIAS = 12288;
/** Velocity per count along the antenna's X, Y and Z axes, m/s (VXSCAL, VYSCAL, VZSCAL). */
const VELOCITY_SCALE: Vec3 = [-0.644 * FOOT, 1.212 * FOOT, 0.8668 * FOOT];
/** The radar's counter holds 15 bits. */
const RADAR_COUNT_MAX = 0o77777;

// ---- RCS jets.  Jets 1-4, 5-8, 9-12 and 13-16 share a quad; the quads sit on
// the diagonals between the Y and Z axes.  Each quad has an up-firing and a
// down-firing jet and two horizontal jets pointing away from the vehicle.

interface Jet {
  /** Jet number, 1-16. */
  number: number;
  position: Vec3;
  /** Direction of the force on the vehicle (opposite to the exhaust). */
  force: Vec3;
}

const QUAD_POSITION: Record<number, Vec3> = {
  1: [0, JET_ARM, JET_ARM],
  2: [0, JET_ARM, -JET_ARM],
  3: [0, -JET_ARM, -JET_ARM],
  4: [0, -JET_ARM, JET_ARM],
};

const JET_FORCE: Vec3[] = [
  [-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, -1, 0],
  [-1, 0, 0], [1, 0, 0], [0, 0, 1], [0, -1, 0],
  [-1, 0, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0],
  [-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 1, 0],
];

export const JETS: Jet[] = JET_FORCE.map((force, i) => ({
  number: i + 1,
  position: QUAD_POSITION[(i >> 2) + 1],
  force,
}));

/** Jets driven by channel 5 (bits 1-8, up and down jets) and channel 6 (bits 1-8, horizontal jets). */
export const CHANNEL5_JETS = [1, 2, 5, 6, 9, 10, 13, 14];
export const CHANNEL6_JETS = [7, 3, 15, 11, 12, 8, 4, 16];

/** The jets (as a bit mask, bit n-1 for jet n) commanded by channel 5 and 6 words. */
export function jetsFromChannels(ch5: number, ch6: number): number {
  let mask = 0;
  for (let b = 0; b < 8; b++) {
    if (ch5 & (1 << b)) mask |= 1 << (CHANNEL5_JETS[b] - 1);
    if (ch6 & (1 << b)) mask |= 1 << (CHANNEL6_JETS[b] - 1);
  }
  return mask;
}

/**
 * Moments of inertia (kg m^2) about X, Y, Z for the LM with its descent stage,
 * from the flight software's fit: one-jet angular acceleration
 * 1JACC = A / (mass + C) + B, with mass scaled at 2^16 kg and 1JACC at pi/4 rad/s^2.
 */
export function inertiaForMass(mass: number): Vec3 {
  const m = mass / 65536;
  const fit = (a: number, b: number, c: number) => JET_THRUST * JET_ARM / ((a / (m + c) + b) * (Math.PI / 4));
  return [
    fit(0.0059347674, 0.002989, 0.008721),
    fit(0.0014979264, 0.018791, -0.068163),
    fit(0.0010451889, 0.021345, -0.066027),
  ];
}

export type ModeControl = 'off' | 'attHold' | 'auto';

/** Panel switches and controllers the crew sets. */
export interface LmControls {
  /** PGNS mode control switch. */
  mode: ModeControl;
  /** Guidance control switch: the primary system (PGNS) or the abort guidance system. */
  pgnsInControl: boolean;
  /** IMU powered and operating. */
  imuOperate: boolean;
  /** IMU cage switch. */
  imuCage: boolean;
  /** Attitude controller (hand controller) deflection, -1..1, about X (yaw), Y (pitch), Z (roll). */
  stick: Vec3;
  /** Translation controller: -1, 0 or 1 along X, Y, Z. */
  translation: Vec3;
}

export class LunarModule implements Peripheral {
  mass = 15100;
  inertia: Vec3 = inertiaForMass(15100);
  /** Body attitude: turns body (navigation base) vectors into the inertial frame. */
  attitude: Quat = IDENTITY;
  /** Body angular rate, rad/s, about X, Y, Z. */
  rate: Vec3 = [0, 0, 0];
  /**
   * Orbit mode: the LM moves under the Moon's gravity, with its descent engine
   * and landing radar.  Without it the LM only turns, and `velocity` is just
   * the change the jets have made.
   */
  orbiting = false;
  /** Position in the computer's inertial frame (centred on the Moon), m. */
  position: Vec3 = [0, 0, 0];
  /** Inertial velocity, m/s. */
  velocity: Vec3 = [0, 0, 0];
  /** The planned landing site, Moon-fixed, m. */
  site: Vec3 = [0, 0, 0];
  /** Radius of the lunar surface under the LM, m: in orbit mode the LM stops there. */
  surfaceRadius = 0;
  /** Seconds since the ephemeris epoch: where the Moon has turned to, for its gravity. */
  ephemerisTime = 0;
  /** The LM reached the surface. */
  landed = false;
  /** Speeds against the ground at touchdown, m/s (vertical is negative going down), or null before it. */
  touchdown: { vertical: number; horizontal: number } | null = null;
  /**
   * Slant range from the landing radar to the surface along its altitude beam,
   * m, or null while the beam misses the Moon or the counter cannot hold it:
   * then the radar has no data.
   */
  radarRange: number | null = null;
  readonly engine = new DescentEngine();
  /** Stable member orientation: turns stable-member vectors into the inertial frame. */
  stableMember: Quat = IDENTITY;
  /** Jets firing now (bit n-1 for jet n). */
  jets = 0;
  /** Seconds each jet has fired in total. */
  readonly jetSeconds = new Float64Array(16);
  /** Simulated seconds since the model started. */
  time = 0;
  /** FDAI attitude-error needle counts driven through the CDU error counters (X, Y, Z). */
  readonly errorNeedles: Vec3 = [0, 0, 0];

  readonly controls: LmControls = {
    mode: 'attHold',
    pgnsInControl: true,
    imuOperate: true,
    imuCage: false,
    stick: [0, 0, 0],
    translation: [0, 0, 0],
  };

  /** Counts each CDU has sent to the computer since it was last zeroed (X, Y, Z). */
  private readonly cduSent = new Int32Array(3);
  /** Accelerometer velocity not yet sent as whole pulses, in the stable-member frame. */
  private readonly pipaResidual: Vec3 = [0, 0, 0];
  /** ISS turn-on request: raised when the IMU is switched on, ended by the computer's "delay complete". */
  private turnOnRequest = false;
  private imuWasOn = true;
  /** Hand-controller counts still to deliver into the RHC counters (X, Y, Z). */
  private readonly rhcPending = new Int32Array(3);
  private rhcReading = false;
  private readonly jetTorque: Vec3[];
  /** Ticks until the landing radar read in progress interrupts, or -1 when idle. */
  private radarRead = -1;
  /** Ticks the landing radar antenna has been driven towards position 2. */
  private radarSwing = 0;

  constructor(readonly agc: AGC) {
    this.jetTorque = JETS.map((j) => cross(j.position, j.force).map((v) => v * JET_THRUST) as Vec3);
    this.writeInputs();
  }

  setMass(kg: number): void {
    this.mass = kg;
    this.inertia = inertiaForMass(kg);
  }

  /** The computer was powered up again: its counters start from zero, so the CDUs and hand controller do too. */
  computerReset(): void {
    this.cduSent.fill(0);
    this.rhcPending.fill(0);
    this.rhcReading = false;
  }

  /** Current gimbal angles (radians). */
  get gimbals(): GimbalAngles {
    const body = quatToMatrix(this.attitude);
    return gimbalAngles(matMultiply(matTranspose(body), quatToMatrix(this.stableMember)));
  }

  /** Point the stable member so the gimbals read the given angles at the current attitude. */
  setGimbals(g: GimbalAngles): void {
    this.stableMember = matrixToQuat(matMultiply(quatToMatrix(this.attitude), gimbalMatrix(g)));
  }

  // ---- Peripheral interface.

  tick(): void {
    const agc = this.agc;
    this.time += TICK;
    this.writeInputs();

    // Jets.  The DAP turns jets on and off by writing channels 5 and 6.
    this.jets = jetsFromChannels(agc.channels[0o5], agc.channels[0o6]);
    const torque: Vec3 = [0, 0, 0];
    const force: Vec3 = [0, 0, 0];
    if (this.jets) {
      for (let j = 0; j < 16; j++) {
        if (!(this.jets & (1 << j))) continue;
        this.jetSeconds[j] += TICK;
        const t = this.jetTorque[j];
        const f = JETS[j].force;
        for (let k = 0; k < 3; k++) {
          torque[k] += t[k];
          force[k] += f[k] * JET_THRUST;
        }
      }
    }

    if (this.orbiting) this.descentEngine(force, torque);

    // Rigid-body rotation: I dw/dt = torque - w x (I w).
    const [ix, iy, iz] = this.inertia;
    const [p, q, r] = this.rate;
    const imuFollowsBody = !this.controls.imuOperate;
    const gimbalsBefore = imuFollowsBody ? this.gimbals : null;
    this.rate = [
      p + ((torque[0] - (iz - iy) * q * r) / ix) * TICK,
      q + ((torque[1] - (ix - iz) * r * p) / iy) * TICK,
      r + ((torque[2] - (iy - ix) * p * q) / iz) * TICK,
    ];
    if (this.landed) this.rate = [0, 0, 0]; // the legs hold the LM still
    this.attitude = quatIntegrate(this.attitude, this.rate, TICK);
    // An IMU that is not running holds no inertial reference: it turns with the body.
    if (gimbalsBefore) this.setGimbals(gimbalsBefore);

    // Translation and the accelerometers (in stable-member axes).  The
    // accelerometers feel the jets and the engine, never gravity.  On the
    // surface they feel only the ground holding the LM up.
    let felt: Vec3 | null = null;
    if (this.landed) {
      felt = moonGravity(this.position, this.ephemerisTime).map((a) => -a * TICK) as Vec3;
    } else if (force[0] || force[1] || force[2]) {
      felt = matVec(quatToMatrix(this.attitude), force).map((v) => (v / this.mass) * TICK) as Vec3;
      for (let k = 0; k < 3; k++) this.velocity[k] += felt[k];
    }
    if (felt && this.controls.imuOperate) {
      const sm = matVec(matTranspose(quatToMatrix(this.stableMember)), felt);
      for (let k = 0; k < 3; k++) this.pipaResidual[k] += sm[k];
    }
    if (this.orbiting) {
      this.fall();
      this.landingRadar();
    }
    this.sendPipaPulses();

    this.imuHardware();
    this.trackCdus();
    this.readHandController();
  }

  pulse(register: number, direction: 1 | -1): void {
    const ch12 = this.agc.channels[0o12];
    if (register >= REG.CDUXCMD && register <= REG.CDUZCMD) {
      const axis = register - REG.CDUXCMD;
      if (ch12 & 0o10 && ch12 & 0o40) {
        // Coarse align: the pulses drive the gimbal servos.
        if (this.controls.imuOperate && !(ch12 & 0o20)) this.moveGimbal(axis, direction * COARSE_PULSE);
      } else if (ch12 & 0o40) {
        this.errorNeedles[axis] += direction; // attitude-error display
      }
    } else if (register === REG.THRUST) {
      this.engine.pulse(direction);
    } else if (register === REG.GYROCMD) {
      if (!this.controls.imuOperate || this.controls.imuCage) return;
      // Channel 14 bits 7-8 select the gyro: X = 01, Y = 10, Z = 11.
      const select = (this.agc.channels[0o14] >> 6) & 3;
      if (!select) return;
      const axis: Vec3 = [select === 1 ? 1 : 0, select === 2 ? 1 : 0, select === 3 ? 1 : 0];
      this.stableMember = quatNormalize(quatMultiply(this.stableMember, quatFromAxisAngle(axis, direction * GYRO_PULSE)));
    }
  }

  // ---- Orbit mode.

  /** Landing radar back to its starting state: antenna in position 1, no read in progress. */
  resetLandingRadar(): void {
    this.radarRead = -1;
    this.radarSwing = 0;
    this.radarRange = null;
  }

  /** Velocity against the ground, which turns with the Moon, m/s. */
  groundVelocity(): Vec3 {
    const ground = cross(moonSpin(this.ephemerisTime), this.position);
    return this.velocity.map((v, k) => v - ground[k]) as Vec3;
  }

  /** Descent engine thrust and the trim gimbal's torque, added to the body-axis force and torque. */
  private descentEngine(force: Vec3, torque: Vec3): void {
    const agc = this.agc;
    const engine = this.engine;
    const burned = engine.step(TICK, agc.channels[0o11], agc.channels[0o12]);
    if (!engine.thrust) return;
    // The thrust leans with the gimbal: pitch tilts it about Y, roll about Z.
    const [pitch, roll] = engine.gimbal;
    const t = engine.thrust;
    force[0] += t * Math.cos(pitch) * Math.cos(roll);
    force[1] += t * Math.sin(roll);
    force[2] -= t * Math.sin(pitch) * Math.cos(roll);
    // The pivot sits below the centre of mass (along -X), so a lean turns the LM.
    const arm = pivotToCg(this.mass);
    torque[1] -= arm * t * Math.sin(pitch) * Math.cos(roll);
    torque[2] -= arm * t * Math.sin(roll);
    if (burned) this.setMass(this.mass - burned);
  }

  /** Gravity moves the LM along its orbit until it reaches the surface; after that it turns with the Moon. */
  private fall(): void {
    const g = moonGravity(this.position, this.ephemerisTime);
    this.ephemerisTime += TICK;
    if (this.landed) this.velocity = cross(moonSpin(this.ephemerisTime), this.position);
    else for (let k = 0; k < 3; k++) this.velocity[k] += g[k] * TICK;
    for (let k = 0; k < 3; k++) this.position[k] += this.velocity[k] * TICK;
    if (!this.landed && Math.hypot(...this.position) <= this.surfaceRadius) {
      const v = this.groundVelocity();
      const r = Math.hypot(...this.position);
      const vertical = (v[0] * this.position[0] + v[1] * this.position[1] + v[2] * this.position[2]) / r;
      this.touchdown = { vertical, horizontal: Math.sqrt(Math.max(0, v[0] ** 2 + v[1] ** 2 + v[2] ** 2 - vertical ** 2)) };
      this.landed = true;
    }
  }

  /**
   * The landing radar.  Each read the computer starts (channel 13 bit 4)
   * takes a sample of what channel 13 bits 1-3 select: the slant range (7) or
   * the velocity along the antenna's Z, Y or X axis (6, 5, 4).  The count goes
   * into RNRAD and a RADARUPT ends the read.  While the altitude beam reaches
   * the surface, channel 33 says the data are good (bits 5 and 8, active low)
   * and which range scale is in use (bit 9, set for the high scale).  The
   * antenna swings from position 1 to position 2 while channel 12 bit 13 asks.
   */
  private landingRadar(): void {
    const agc = this.agc;
    // The antenna moves only while commanded, and stays in position 2 once
    // there: the software removes the command after it arrives.
    if (agc.channels[0o12] & 0o10000) this.radarSwing = Math.min(RADAR_SWING_TICKS, this.radarSwing + 1);
    const antenna = RADAR_ANTENNA[this.radarSwing === RADAR_SWING_TICKS ? 1 : 0];
    const body = quatToMatrix(this.attitude);
    this.radarRange = this.slantRange(matVec(body, matVec(antenna, ALTITUDE_BEAM)));
    const lowScale = this.radarRange !== null && this.radarRange < RANGE_SCALE_CHANGE;

    const ch13 = agc.channels[0o13];
    if (ch13 & 0o10) {
      if (this.radarRead < 0) this.radarRead = RADAR_READ_TICKS;
      else if (--this.radarRead === 0) {
        this.radarRead = -1;
        agc.mem[REG.RNRAD] = this.radarCount(ch13 & 7, body, antenna, lowScale);
        agc.setInputChannel(0o13, ch13 & ~0o10);
        agc.interruptRequests[9] = true; // RADARUPT
      }
    } else {
      this.radarRead = -1;
    }

    // Active low: bit 6 = antenna in position 1, bit 7 = in position 2.
    const position = this.radarSwing === 0 ? 0o40 : this.radarSwing === RADAR_SWING_TICKS ? 0o100 : 0;
    let ch33 = (agc.channels[0o33] | 0o760) & ~position;
    if (this.radarRange !== null) ch33 &= ~0o220;
    if (lowScale) ch33 &= ~0o400;
    if (agc.channels[0o33] !== ch33) agc.setInputChannel(0o33, ch33);
  }

  /** Distance along `beam` (an inertial unit vector) to the surface, or null when the radar cannot measure it. */
  private slantRange(beam: Vec3): number | null {
    const p = this.position;
    const along = p[0] * beam[0] + p[1] * beam[1] + p[2] * beam[2];
    const above = p[0] * p[0] + p[1] * p[1] + p[2] * p[2] - this.surfaceRadius ** 2;
    if (above <= 0) return 0;
    const disc = along * along - above;
    if (disc < 0 || along > 0) return null; // the beam passes the Moon, or points away from it
    const range = -along - Math.sqrt(disc);
    return range <= RADAR_COUNT_MAX * RANGE_HIGH_SCALE ? range : null;
  }

  /** The count a radar read returns for channel 13 select code `select` (0 without data or for the rendezvous radar). */
  private radarCount(select: number, body: Mat3, antenna: Mat3, lowScale: boolean): number {
    if (this.radarRange === null || select < 4) return 0;
    let count: number;
    if (select === 7) {
      count = this.radarRange / (lowScale ? RANGE_LOW_SCALE : RANGE_HIGH_SCALE);
    } else {
      const axis = select - 4;
      const relative = this.groundVelocity();
      const unit: Vec3 = [0, 0, 0];
      unit[axis] = 1;
      const along = matVec(body, matVec(antenna, unit));
      const speed = relative[0] * along[0] + relative[1] * along[1] + relative[2] * along[2];
      count = VELOCITY_BIAS + speed / VELOCITY_SCALE[axis];
    }
    return Math.max(0, Math.min(RADAR_COUNT_MAX, Math.round(count)));
  }

  // ---- Inputs.

  /** Present the switch and controller states on input channels 30 and 31 (signals are active low). */
  private writeInputs(): void {
    const c = this.controls;
    const agc = this.agc;
    let ch30 = 0o77777;
    ch30 &= ~0o20; // bit 5: auto throttle (computer controls the descent engine)
    ch30 &= ~0o40000; // bit 15: stable member temperature within limits
    if (c.imuOperate) ch30 &= ~0o400; // bit 9: IMU operate
    if (c.pgnsInControl) ch30 &= ~0o1000; // bit 10: LGC has control of the LM
    if (c.imuCage) ch30 &= ~0o2000; // bit 11: IMU cage
    if (c.imuOperate && !this.imuWasOn) this.turnOnRequest = true;
    if (!c.imuOperate) this.turnOnRequest = false;
    this.imuWasOn = c.imuOperate;
    if (this.turnOnRequest && agc.channels[0o12] & 0o40000) this.turnOnRequest = false; // ISS delay complete
    if (this.turnOnRequest) ch30 &= ~0o20000; // bit 14: ISS turn-on requested
    if (agc.channels[0o30] !== ch30) agc.setInputChannel(0o30, ch30);

    let ch31 = 0o77777;
    if (c.mode === 'attHold') ch31 &= ~0o10000; // bit 13
    else if (c.mode === 'auto') ch31 &= ~0o20000; // bit 14
    const t = c.translation;
    // Bits 7-12: +X, -X, +Y, -Y, +Z, -Z translation.
    for (let k = 0; k < 3; k++) {
      if (t[k] > 0) ch31 &= ~(0o100 << (2 * k));
      else if (t[k] < 0) ch31 &= ~(0o200 << (2 * k));
    }
    if (c.stick.some((d) => Math.abs(d) > RHC_DETENT)) ch31 &= ~0o40000; // bit 15: out of detent
    if (agc.channels[0o31] !== ch31) agc.setInputChannel(0o31, ch31);
  }

  /**
   * Hand-controller angles: when the program sets channel 13 bits 8 and 9, the
   * controller sends its deflection as pulses into the RHC counters.
   */
  private readHandController(): void {
    const agc = this.agc;
    const ch13 = agc.channels[0o13];
    if (!this.rhcReading && (ch13 & 0o600) === 0o600) {
      this.rhcReading = true;
      this.controls.stick.forEach((d, k) => {
        const travel = Math.max(0, Math.abs(d) - RHC_DETENT) / (1 - RHC_DETENT);
        this.rhcPending[k] = Math.sign(d) * Math.round(Math.min(1, travel) * RHC_FULL_COUNTS);
      });
    }
    if (!this.rhcReading) return;
    const counters = [REG.RHCP, REG.RHCQ, REG.RHCR];
    let busy = false;
    for (let k = 0; k < 3; k++) {
      const n = this.rhcPending[k];
      if (n > 0) {
        agc.pinc(counters[k]);
        this.rhcPending[k]--;
      } else if (n < 0) {
        agc.minc(counters[k]);
        this.rhcPending[k]++;
      }
      busy ||= this.rhcPending[k] !== 0;
    }
    if (!busy) {
      this.rhcReading = false;
      agc.setInputChannel(0o13, agc.channels[0o13] & ~0o400); // the read is done: drop "start RHC read"
    }
  }

  // ---- IMU.

  private moveGimbal(axis: number, delta: number): void {
    const g = this.gimbals;
    if (axis === 0) g.outer += delta;
    else if (axis === 1) g.inner += delta;
    else g.middle += delta;
    this.setGimbals(g);
  }

  /** Caging and the computer's zero-and-coarse command drive the gimbals to zero. */
  private imuHardware(): void {
    const ch12 = this.agc.channels[0o12];
    const caging = this.controls.imuCage || (this.controls.imuOperate && (ch12 & 0o30) === 0o30);
    if (!caging) return;
    const g = this.gimbals;
    const step = COARSE_PULSE; // one coarse-align step per tick: about 140 degrees a second
    const toward = (a: number) => (Math.abs(a) <= step ? 0 : a - Math.sign(a) * step);
    if (g.outer || g.inner || g.middle) {
      this.setGimbals({ outer: toward(g.outer), inner: toward(g.inner), middle: toward(g.middle) });
    }
  }

  /**
   * The CDUs count gimbal angle changes into CDUX (outer), CDUY (inner) and
   * CDUZ (middle), one pulse per tick per axis at most.  While the computer
   * holds the "zero ICDUs" bit (channel 12 bit 5) they read zero.
   */
  private trackCdus(): void {
    const agc = this.agc;
    if (agc.channels[0o12] & 0o20) {
      this.cduSent.fill(0);
      return;
    }
    const g = this.gimbals;
    const angles = [g.outer, g.inner, g.middle];
    const registers = [REG.CDUX, REG.CDUY, REG.CDUZ];
    for (let k = 0; k < 3; k++) {
      const target = Math.round((angles[k] / TWO_PI) * CDU_COUNTS);
      const diff = ((((target - this.cduSent[k]) % CDU_COUNTS) + CDU_COUNTS + CDU_COUNTS / 2) % CDU_COUNTS) - CDU_COUNTS / 2;
      if (diff > 0) {
        agc.pcdu(registers[k]);
        this.cduSent[k]++;
      } else if (diff < 0) {
        agc.mcdu(registers[k]);
        this.cduSent[k]--;
      }
    }
  }

  private sendPipaPulses(): void {
    const registers = [REG.PIPAX, REG.PIPAY, REG.PIPAZ];
    for (let k = 0; k < 3; k++) {
      while (this.pipaResidual[k] >= PIPA_PULSE) {
        this.agc.pinc(registers[k]);
        this.pipaResidual[k] -= PIPA_PULSE;
      }
      while (this.pipaResidual[k] <= -PIPA_PULSE) {
        this.agc.minc(registers[k]);
        this.pipaResidual[k] += PIPA_PULSE;
      }
    }
  }
}
