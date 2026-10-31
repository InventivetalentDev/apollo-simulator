// The crew's side of P63, one step at a time: what the DSKY is asking now,
// what it means, and which key answers it.  The step comes from the DSKY's
// own state (program, verb, noun, flashing), so it follows the real software.

import type { AGC } from '../agc/cpu.ts';
import { REG } from '../agc/cpu.ts';
import { readDsky, type DskyState } from '../agc/dsky.ts';
import type { LunarModule } from '../sim/lm.ts';

export interface DescentStep {
  /** Position in the procedure, 1 to DESCENT_STEPS. */
  number: number;
  /** What the DSKY shows, or what is happening. */
  title: string;
  detail: string;
  /** The DSKY key that answers this step, if one does. */
  key: 'PRO' | 'ENTR' | null;
  /** Keys that start this step's work, when it takes more than one key (V, N, E as in commands.ts). */
  keys?: string;
  /** Nothing to answer: the crew waits, and fast-forward helps. */
  wait?: boolean;
  /** A clock for this step, such as the time to ignition. */
  timer?: string;
}

export const DESCENT_STEPS = 10;

const clock = (s: number) => {
  const whole = Math.max(0, Math.floor(s));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};

const START: DescentStep = {
  number: 1,
  title: 'Start P63',
  detail: 'P63 flies the braking phase, from ignition to high gate. Start it below, or key VERB 37 ENTR 63 ENTR on the DSKY.',
  key: null,
  keys: 'V 3 7 E 6 3 E',
};

/** True while the DSKY flashes this verb and noun (or just this verb), waiting for the crew. */
const asking = (d: DskyState, verbNoun: string) => d.vnFlashing && (d.verb + d.noun === verbNoun || d.verb === verbNoun);

export class DescentChecklist {
  private startedP63 = false;
  private turned = false;
  /** Computer time when V06 N18 came up steady after step 4, or -1. */
  private turningSince = -1;
  private accepted = false;
  private enabled = false;
  private ignitionAt = 0;
  private last: DescentStep = START;

  private readonly tigAddress: number;

  /** `tigAddress` is the erasable address of TIG, the ignition time, for the countdown (-1 for none). */
  constructor(tigAddress = -1) {
    this.tigAddress = tigAddress;
  }

  /** The step the crew is on, or null when the LM is not in orbit. */
  current(agc: AGC, lm: LunarModule): DescentStep | null {
    if (!lm.orbiting) return null;
    const d = readDsky(agc);
    const now = (agc.mem[REG.TIME2] * 2 ** 14 + agc.mem[REG.TIME1]) / 100;
    const tig = this.tigAddress >= 0 ? (agc.mem[this.tigAddress] * 2 ** 14 + agc.mem[this.tigAddress + 1]) / 100 : 0;
    // Each answer moves the display on; the step after it starts once the question is gone.
    if (d.prog === '63') this.startedP63 = true;
    // While R60 sets up its question, N18 shows for a moment before V50 flashes; only a
    // steady V06 N18 after step 4 means the LM is turning.
    const steady0618 = d.verb + d.noun === '0618' && !d.vnFlashing && this.last.number >= 4;
    if (!steady0618) this.turningSince = -1;
    else if (this.turningSince < 0) this.turningSince = now;
    if (steady0618 && now - this.turningSince >= 0.5) this.turned = true;
    if (this.last.number === 6 && !asking(d, '5018')) this.accepted = true;
    if (this.last.number === 8 && !asking(d, '99')) this.enabled = true;
    if (lm.engine.thrust > 0 && !this.ignitionAt) this.ignitionAt = now;

    const step = this.match(d, lm, now, tig);
    // Between displays the DSKY is briefly blank: keep showing the step just answered.
    if (step) this.last = step;
    return this.last;
  }

  private match(d: DskyState, lm: LunarModule, now: number, tig: number): DescentStep | null {
    const prog = d.prog;
    if (lm.landed) {
      return {
        number: DESCENT_STEPS,
        title: 'On the surface',
        detail: 'Without landing-radar data the computer navigated on the IMU alone. Its altitude was high, so the LM reached the ground before the computer expected it.',
        key: null,
      };
    }
    if (prog === '64' || prog === '65' || prog === '66') {
      return {
        number: DESCENT_STEPS,
        title: `High gate: P${prog}`,
        detail: 'The braking phase is over, and P64 pitches the LM up so the crew can see the landing site. The landing radar has no data in this simulation, so the computer’s altitude is about 50 m high.',
        key: null,
      };
    }
    if (!this.startedP63) return START;
    if (asking(d, '0661')) {
      return {
        number: 2,
        title: 'V06 N61 flashing',
        detail: 'P63 has worked out when to light the engine. R1 shows the time to go in the braking phase, R2 the time from ignition, and R3 the cross range.',
        key: 'PRO',
      };
    }
    if (asking(d, '5025') && d.r[0].trim() === '00014') {
      return {
        number: 3,
        title: 'V50 N25 00014 flashing',
        detail: 'P63 offers a fine alignment of the IMU against the stars. The IMU is already aligned to the landing site: skip it.',
        key: 'ENTR',
      };
    }
    if (asking(d, '5018') && !this.turned) {
      return {
        number: 4,
        title: 'V50 N18 flashing',
        detail:
          lm.controls.mode === 'auto'
            ? 'P63 asks to turn the LM to the ignition attitude. R1 to R3 show the target roll, pitch and yaw.'
            : 'P63 asks to turn the LM to the ignition attitude. Set the mode switch to Auto first: outside Auto, the computer only asks again.',
        key: 'PRO',
      };
    }
    if (this.turned && d.verb + d.noun === '0618') {
      return {
        number: 5,
        title: 'V06 N18: turning',
        detail: 'The autopilot turns the LM to the ignition attitude. When the turn is done, V50 N18 flashes again.',
        key: null,
        wait: true,
      };
    }
    if (asking(d, '5018')) {
      return {
        number: 6,
        title: 'V50 N18 flashing again',
        detail: 'The turn is done. ENTR accepts the attitude; PRO would turn again.',
        key: 'ENTR',
      };
    }
    if (asking(d, '99')) {
      return {
        number: 8,
        title: 'V99 flashing',
        detail: 'Ignition is 35 s away, and the computer asks for permission to light the engine.',
        key: 'PRO',
      };
    }
    if (this.ignitionAt) {
      return {
        number: 9,
        title: 'Braking phase',
        detail: 'The engine lit at 10% thrust and went to full throttle 26 s later. About 6½ minutes in, the computer throttles down. P64 starts at high gate, about 2 km up.',
        key: null,
        wait: true,
        timer: `T+${clock(now - this.ignitionAt)}`,
      };
    }
    if (this.accepted) {
      return {
        number: this.enabled ? 8 : 7,
        title: this.enabled ? 'Engine enabled' : 'Waiting for ignition',
        detail: this.enabled
          ? 'The RCS jets fire to settle the propellant, and then the engine lights.'
          : 'P63 counts down to ignition, and the DSKY stays blank until 35 s before it.',
        key: null,
        wait: true,
        timer: tig > now ? `Ignition in ${clock(tig - now)}` : undefined,
      };
    }
    return null;
  }
}
