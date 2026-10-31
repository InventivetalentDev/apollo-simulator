// The crew's side of the powered descent, one step at a time: what the DSKY
// is asking now, what it means, and which key answers it.  The step comes
// from the DSKY's own state (program, verb, noun, flashing) and the LM's, so
// it follows the real software.

import type { AGC } from '../agc/cpu.ts';
import { REG } from '../agc/cpu.ts';
import { readDsky, type DskyState } from '../agc/dsky.ts';
import type { LunarModule } from '../sim/lm.ts';
import { inertialToMoonFixed } from '../sim/moon.ts';

export interface DescentStep {
  /** Position in the procedure, 1 to DESCENT_STEPS. */
  number: number;
  /** What the DSKY shows, or what is happening. */
  title: string;
  detail: string;
  /** The DSKY key that answers this step, if one does. */
  key: 'PRO' | 'ENTR' | null;
  /** Keys that do this step's work, when it takes more than one key (V, N, E as in commands.ts). */
  keys?: string;
  /** The step's button stops the descent engine, as the crew's ENGINE STOP button did. */
  stopEngine?: boolean;
  /** Label of the button for `keys` or `stopEngine`. */
  button?: string;
  /** Nothing to answer: the crew waits, and fast-forward helps. */
  wait?: boolean;
  /** A clock for this step, such as the time to ignition. */
  timer?: string;
}

export const DESCENT_STEPS = 15;

/** The probes under the footpads touch the surface this far before the footpads do, m (67 in). */
const PROBE_LENGTH = 1.7;
/** LRINH, flagword 11 bit 8: the crew has permitted landing radar updates (VERB 57). */
const LRINH_BIT = 0o200;
/**
 * While P63 waits for PRO on V99, CLOCPLAY (BURN_BABY_BURN) rewrites the
 * display once a second: for about 0.1 s the DSKY shows V06 with the same
 * noun, and the flashing stops for a moment.  A rewrite counts as V99 still
 * asking if V99 flashed within this many seconds of computer time, which is
 * more than one browser frame at the highest speed.
 */
const V99_REWRITE = 4;

const clock = (s: number) => {
  const whole = Math.max(0, Math.floor(s));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};
const distance = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

const START: DescentStep = {
  number: 1,
  title: 'Start P63',
  detail: 'P63 lights the descent engine and flies the braking phase. P64 and P65 take the LM on down to the surface.',
  key: null,
  keys: 'V 3 7 E 6 3 E',
  button: 'Start P63',
};

/** True while the DSKY flashes this verb and noun (or just this verb), waiting for the crew. */
const asking = (d: DskyState, verbNoun: string) => d.vnFlashing && (d.verb + d.noun === verbNoun || d.verb === verbNoun);

const RELOAD: DescentStep = {
  number: 1,
  title: 'Set up powered descent',
  detail: 'The computer restarted and lost its descent data. Click “Land on the Moon” at the top of the page to load it again.',
  key: null,
};

export class DescentChecklist {
  private startedP63 = false;
  private turned = false;
  /** Computer time when V06 N18 came up steady after step 4, or -1. */
  private turningSince = -1;
  private accepted = false;
  private enabled = false;
  private ignitionAt = 0;
  /** Computer time V99 last flashed, and its noun. */
  private v99At = -Infinity;
  private v99Noun = '';
  /** The landing radar has had data since ignition. */
  private radarSeen = false;
  private last: DescentStep;
  private readonly tigAddress: number;
  private readonly flagsAddress: number;
  private readonly loaded: boolean;

  /**
   * `addressOf` finds erasable symbols (-1 when missing): TIG, the ignition
   * time, for the countdown, and flagword 11 for the landing radar.
   * `loaded` is false when the computer's memory no longer holds the descent setup.
   */
  constructor(addressOf: (name: string) => number = () => -1, loaded = true) {
    this.tigAddress = addressOf('TIG');
    this.flagsAddress = addressOf('FLGWRD11');
    this.loaded = loaded;
    this.last = loaded ? START : RELOAD;
  }

  /** The step the crew is on, or null when the LM is not in orbit. */
  current(agc: AGC, lm: LunarModule): DescentStep | null {
    if (!lm.orbiting) return null;
    const now = (agc.mem[REG.TIME2] * 2 ** 14 + agc.mem[REG.TIME1]) / 100;
    const d = this.throughRewrites(readDsky(agc), now);
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
    if (this.ignitionAt && lm.radarRange !== null) this.radarSeen = true;
    const radarUsed = this.flagsAddress >= 0 && (agc.mem[this.flagsAddress] & LRINH_BIT) !== 0;

    const step = this.match(d, lm, now, tig, radarUsed);
    // Between displays the DSKY is briefly blank: keep showing the step just answered.
    if (step) this.last = step;
    return this.last;
  }

  /** The DSKY as the crew reads it: V99 goes on asking through P63's once-a-second rewrites of it. */
  private throughRewrites(d: DskyState, now: number): DskyState {
    if (d.vnFlashing && d.verb === '99') {
      this.v99At = now;
      this.v99Noun = d.noun;
      return d;
    }
    const rewrite = (d.verb === '06' || d.verb === '99') && d.noun === this.v99Noun && now - this.v99At < V99_REWRITE;
    if (rewrite && !this.ignitionAt) return { ...d, verb: '99', vnFlashing: true };
    this.v99At = -Infinity;
    return d;
  }

  private match(d: DskyState, lm: LunarModule, now: number, tig: number, radarUsed: boolean): DescentStep | null {
    const prog = d.prog;
    const sinceIgnition = this.ignitionAt ? `T+${clock(now - this.ignitionAt)}` : undefined;
    const altitude = Math.hypot(...lm.position) - lm.surfaceRadius;
    if (lm.landed && lm.engine.thrust === 0) return this.onTheSurface(lm, radarUsed);
    if (altitude < PROBE_LENGTH) {
      const armed = lm.engine.armed;
      return {
        number: 14,
        title: 'Contact light',
        detail: armed
          ? 'The probes under the footpads touched the surface, 1.7 m below the LM. Stop the descent engine, and the LM drops the rest of the way.'
          : 'The engine is off, and the LM settles onto its legs.',
        key: null,
        stopEngine: armed,
        button: armed ? 'Stop the engine' : undefined,
      };
    }
    if (prog === '65' || prog === '66') {
      return {
        number: 13,
        title: `Landing phase: P${prog}`,
        detail:
          prog === '65'
            ? 'Near the ground, P65 stops the LM moving across the surface and lets it down straight, at 1 m/s (3 ft/s).'
            : 'The mode switch went to Attitude Hold, so P66 holds the rate of descent while the crew steers the LM.',
        key: null,
        wait: true,
        timer: sinceIgnition,
      };
    }
    if (prog === '64') {
      return {
        number: 12,
        title: 'Approach phase: P64',
        detail:
          'At high gate, about 2 km up, P64 pitches the LM up so the crew can see the landing site, and swings the radar antenna to its second position. ' +
          (radarUsed
            ? 'Near the ground, P65 takes over.'
            : 'The computer is not using the landing radar (nobody keyed VERB 57), so its altitude is off: the LM will reach the ground before the computer expects it.'),
        key: null,
        wait: true,
        timer: sinceIgnition,
      };
    }
    if (!this.startedP63) return this.loaded ? START : RELOAD;
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
    if (this.ignitionAt && radarUsed) {
      return {
        number: 11,
        title: 'Braking with radar data',
        detail: 'Every 2 s the computer corrects its altitude with the radar’s, and from about 600 m/s its velocity too. P64 starts at high gate, about 2 km up.',
        key: null,
        wait: true,
        timer: sinceIgnition,
      };
    }
    if (this.ignitionAt && this.radarSeen) {
      return {
        number: 10,
        title: 'The landing radar sees the ground',
        detail: 'The radar measures the altitude and the velocity against the ground, and the ALT and VEL lamps go out. The computer uses the measurements only once the crew allows it with VERB 57.',
        key: null,
        keys: 'V 5 7 E',
        button: 'Key it in for me',
        timer: sinceIgnition,
      };
    }
    if (this.ignitionAt) {
      return {
        number: 9,
        title: 'Braking phase',
        detail: 'The engine lit at 10% thrust and went to full throttle 26 s later. The landing radar has no data yet, so the DSKY lights its ALT lamp, and later VEL: the radar’s beam points away from the ground until the computer turns the LM windows up, about 6 minutes in.',
        key: null,
        wait: true,
        timer: sinceIgnition,
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

  private onTheSurface(lm: LunarModule, radarUsed: boolean): DescentStep {
    const touchdown = lm.touchdown;
    const here = inertialToMoonFixed(lm.position, lm.ephemerisTime);
    const fromSite = Math.hypot(...here.map((x, k) => x - lm.site[k]));
    const speeds = touchdown
      ? `Touchdown at ${Math.abs(touchdown.vertical).toFixed(1)} m/s down and ${touchdown.horizontal.toFixed(1)} m/s across, `
      : 'The LM is down, ';
    return {
      number: DESCENT_STEPS,
      title: 'On the surface',
      detail:
        `${speeds}${distance(fromSite)} from the planned landing site.` +
        (radarUsed ? '' : ' The computer never used the landing radar, so it thought the LM was higher than it was.'),
      key: null,
    };
  }
}
