// The descent engine (DPS) as the guidance computer drives it: on and off
// through channel 11, thrust through pulses into the THRUST counter, and the
// trim gimbal through channel 12.  Constants come from the flight software
// where it states them (CONTROLLED_CONSTANTS.agc, AOSTASK_AND_AOSJOB.agc).

const LBF = 4.4482216;
const DEG = Math.PI / 180;

/** Thrust at the full-throttle position, N (FMAXPOS: 9,769 lbf). */
export const DPS_FULL_THROTTLE = 43455;
/** Thrust per throttle pulse, N (SCALEFAC). */
export const DPS_PULSE = 12.532;
/** The throttle command saturates at this many pulses (FMAXODD, 48,145 N). */
export const DPS_COUNTER_MAX = 3841;
/**
 * Thrust with the automatic command at zero: the crew's throttle at its
 * minimum gives 10% of the engine's rated 10,500 lbf.  The computer's
 * pulses add to it.
 */
export const DPS_MINIMUM = 1050 * LBF;
/** Exhaust velocity, m/s (DPSVEX). */
export const DPS_EXHAUST_VELOCITY = 2955.89;
/** Time constant of the throttle's response, s (measured 0.05 to 0.08 s to 60% of a step). */
const THROTTLE_LAG = 0.08;
/** Trim gimbal drive rate, the 0.2 deg/s the autopilot assumes (TORKJET1 = 550/.2), and its travel. */
const GIMBAL_RATE = 0.2 * DEG;
const GIMBAL_LIMIT = 6 * DEG;

/** Channel 11 bits 13 and 14: engine on, engine off. */
const ENGINE_BITS = 0o30000;
const ENGINE_ON = 0o10000;

/**
 * Distance from the engine's gimbal pivot to the centre of mass, m, for a
 * given LM mass: the autopilot's own curve fit for L,PVT-CG (descent stage
 * attached), which it scales at 8 ft with mass at 2^16 kg.
 */
export function pivotToCg(mass: number): number {
  return 8 * 0.3048 * (0.0410511917 / (mass / 65536 - 0.025233) + 0.155044);
}

export class DescentEngine {
  /** The crew's engine arm switch: without it the engine cannot fire. */
  armed = false;
  /** The automatic throttle command, in pulses, as the engine's control assembly holds it. */
  counter = 0;
  /** Thrust now, N. */
  thrust = 0;
  /** Usable propellant left, kg. */
  propellant = 0;
  /** Trim gimbal angles, radians: pitch (about Y) and roll (about Z). */
  readonly gimbal: [number, number] = [0, 0];

  /** One pulse from the THRUST counter. */
  pulse(direction: 1 | -1): void {
    this.counter = Math.min(DPS_COUNTER_MAX, Math.max(0, this.counter + direction));
  }

  /** Thrust the throttle asks for, N. */
  get command(): number {
    return Math.min(DPS_FULL_THROTTLE, DPS_MINIMUM + this.counter * DPS_PULSE);
  }

  /** True while the computer holds the engine-on command. */
  static commandedOn(channel11: number): boolean {
    return (channel11 & ENGINE_BITS) === ENGINE_ON;
  }

  /**
   * Advance by `dt` seconds.  Returns the propellant burned, kg.  Channel 12
   * bits 9/10 drive the pitch gimbal -/+, bits 11/12 the roll gimbal -/+.
   */
  step(dt: number, channel11: number, channel12: number): number {
    const firing = this.armed && this.propellant > 0 && DescentEngine.commandedOn(channel11);
    const target = firing ? this.command : 0;
    this.thrust += (target - this.thrust) * (1 - Math.exp(-dt / THROTTLE_LAG));
    if (this.thrust < 1) this.thrust = 0;

    if (this.armed) {
      const move = (k: number, plus: number, minus: number) => {
        const d = channel12 & plus ? GIMBAL_RATE * dt : channel12 & minus ? -GIMBAL_RATE * dt : 0;
        this.gimbal[k] = Math.min(GIMBAL_LIMIT, Math.max(-GIMBAL_LIMIT, this.gimbal[k] + d));
      };
      move(0, 0o1000, 0o400);
      move(1, 0o4000, 0o2000);
    }

    const burned = Math.min(this.propellant, (this.thrust / DPS_EXHAUST_VELOCITY) * dt);
    this.propellant -= burned;
    return burned;
  }
}
