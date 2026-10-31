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
  type Quat,
  type Vec3,
} from './attitude.ts';

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
  /** Inertial velocity change from the jets, m/s (no gravity in this model). */
  velocity: Vec3 = [0, 0, 0];
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
    this.attitude = quatIntegrate(this.attitude, this.rate, TICK);
    // An IMU that is not running holds no inertial reference: it turns with the body.
    if (gimbalsBefore) this.setGimbals(gimbalsBefore);

    // Translation and the accelerometers (in stable-member axes).
    if (this.jets) {
      const body = quatToMatrix(this.attitude);
      const dv = matVec(body, force).map((v) => (v / this.mass) * TICK) as Vec3;
      for (let k = 0; k < 3; k++) this.velocity[k] += dv[k];
      if (this.controls.imuOperate) {
        const sm = matVec(matTranspose(quatToMatrix(this.stableMember)), dv);
        for (let k = 0; k < 3; k++) this.pipaResidual[k] += sm[k];
      }
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
    } else if (register === REG.GYROCMD) {
      if (!this.controls.imuOperate || this.controls.imuCage) return;
      // Channel 14 bits 7-8 select the gyro: X = 01, Y = 10, Z = 11.
      const select = (this.agc.channels[0o14] >> 6) & 3;
      if (!select) return;
      const axis: Vec3 = [select === 1 ? 1 : 0, select === 2 ? 1 : 0, select === 3 ? 1 : 0];
      this.stableMember = quatNormalize(quatMultiply(this.stableMember, quatFromAxisAngle(axis, direction * GYRO_PULSE)));
    }
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
