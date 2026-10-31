// The DSKY (display and keyboard) as the AGC sees it: relay words written to
// channel 10, status bits in channel 11, and five-bit key codes in channel 15.

import { AGC } from './cpu.ts';

export const KEY_CODES = {
  '0': 0o20,
  '1': 0o1,
  '2': 0o2,
  '3': 0o3,
  '4': 0o4,
  '5': 0o5,
  '6': 0o6,
  '7': 0o7,
  '8': 0o10,
  '9': 0o11,
  VERB: 0o21,
  NOUN: 0o37,
  '+': 0o32,
  '-': 0o33,
  ENTR: 0o34,
  CLR: 0o36,
  RSET: 0o22,
  'KEY REL': 0o31,
} as const;

export type DskyKey = keyof typeof KEY_CODES | 'PRO';

// Five-bit relay codes for the electroluminescent seven-segment digits.
const DIGITS: Record<number, string> = {
  0o0: ' ',
  0o25: '0',
  0o3: '1',
  0o31: '2',
  0o33: '3',
  0o17: '4',
  0o36: '5',
  0o34: '6',
  0o23: '7',
  0o35: '8',
  0o37: '9',
};
const digit = (code: number): string => DIGITS[code & 0o37] ?? ' ';

export interface DskyLamps {
  uplinkActy: boolean;
  noAtt: boolean;
  stby: boolean;
  keyRel: boolean;
  oprErr: boolean;
  prioDisp: boolean;
  noDap: boolean;
  temp: boolean;
  gimbalLock: boolean;
  prog: boolean;
  restart: boolean;
  tracker: boolean;
  alt: boolean;
  vel: boolean;
  compActy: boolean;
}

export interface DskyState {
  prog: string; // two characters
  verb: string;
  noun: string;
  /** Registers R1-R3: sign ('+', '-' or ' ') followed by five digits. */
  r: [string, string, string];
  lamps: DskyLamps;
  /** True while the verb/noun digits are in the "off" phase of flashing. */
  vnBlank: boolean;
  /** True while verb and noun flash: the computer is waiting for the crew. */
  vnFlashing: boolean;
}

function sign(plus: number, minus: number): string {
  if (plus & 0o2000) return '+';
  if (minus & 0o2000) return '-';
  return ' ';
}

export function readDsky(agc: AGC): DskyState {
  const rw = agc.relays;
  const left = (row: number) => digit(rw[row] >> 5);
  const right = (row: number) => digit(rw[row]);
  const ch11 = agc.channels[0o11];
  const ch13 = agc.channels[0o13];
  const lampRow = rw[0o14];
  const lampTest = (ch13 & 0o1000) !== 0;
  // The DSKY flashes VERB/NOUN (and KEY REL / OPR ERR) at about 1.5 Hz: three phases on, one off.
  const flashPhase = Math.floor(agc.cycleCounter / ((81920 / 3) | 0)) % 4;
  const flashOff = flashPhase === 0;
  const keyRel = (ch11 & 0o20) !== 0 && !flashOff;
  const oprErr = (ch11 & 0o100) !== 0 && !flashOff;
  return {
    prog: left(0o13) + right(0o13),
    verb: left(0o12) + right(0o12),
    noun: left(0o11) + right(0o11),
    r: [
      sign(rw[7], rw[6]) + right(0o10) + left(7) + right(7) + left(6) + right(6),
      sign(rw[5], rw[4]) + left(5) + right(5) + left(4) + right(4) + left(3),
      sign(rw[2], rw[1]) + right(3) + left(2) + right(2) + left(1) + right(1),
    ],
    vnBlank: (ch11 & 0o40) !== 0 && flashOff,
    vnFlashing: (ch11 & 0o40) !== 0,
    lamps: {
      uplinkActy: (ch11 & 0o4) !== 0,
      noAtt: (lampRow & 0o10) !== 0,
      stby: lampTest || agc.standby,
      keyRel,
      oprErr,
      prioDisp: (lampRow & 0o1) !== 0,
      noDap: (lampRow & 0o2) !== 0,
      temp: (ch11 & 0o10) !== 0 || (agc.channels[0o30] & 0o40000) !== 0,
      gimbalLock: (lampRow & 0o40) !== 0,
      prog: (lampRow & 0o400) !== 0,
      restart: lampTest || agc.restartLight,
      tracker: (lampRow & 0o200) !== 0,
      alt: (lampRow & 0o20) !== 0,
      vel: (lampRow & 0o4) !== 0,
      compActy: (ch11 & 0o2) !== 0,
    },
  };
}

/** Press a DSKY key.  PRO is not a keystroke: it holds a discrete in channel 32 low. */
export function pressKey(agc: AGC, key: DskyKey): void {
  if (key === 'PRO') {
    agc.setInputChannel(0o32, agc.channels[0o32] & ~0o20000);
  } else {
    agc.keypress(KEY_CODES[key]);
  }
}

export function releaseKey(agc: AGC, key: DskyKey): void {
  if (key === 'PRO') agc.setInputChannel(0o32, agc.channels[0o32] | 0o20000);
}

