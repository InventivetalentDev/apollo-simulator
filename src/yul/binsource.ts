// Reader for Virtual AGC ".binsource" files: octal transcriptions of the
// assembly listings printed in 1969, used to check the assembler's output.

import { BANK_SIZE, NUM_BANKS } from './assembler.ts';

/** Returns one entry per rope word: the 15-bit value, -2 for "@" (unused), or -1 if absent. */
export function parseBinsource(text: string): Int32Array {
  const expected = new Int32Array(NUM_BANKS * BANK_SIZE).fill(-1);
  let bank = -1;
  let offset = 0;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/;.*/, '').trim();
    if (!line) continue;
    const m = /^BANK=([0-7]+)/.exec(line);
    if (m) {
      bank = parseInt(m[1], 8);
      offset = 0;
      continue;
    }
    if (bank < 0) continue;
    for (const tok of line.split(/\s+/)) {
      expected[bank * BANK_SIZE + offset] = tok === '@' ? -2 : parseInt(tok, 8);
      offset++;
    }
  }
  return expected;
}

export interface RopeMismatch {
  bank: number;
  offset: number;
  expected: number;
  actual: number;
}

export function compareRope(rope: Uint16Array, used: Uint8Array, expected: Int32Array): { compared: number; mismatches: RopeMismatch[] } {
  const mismatches: RopeMismatch[] = [];
  let compared = 0;
  for (let i = 0; i < expected.length; i++) {
    const e = expected[i];
    if (e === -1) continue;
    compared++;
    const actual = used[i] ? rope[i] : -2;
    const ok = e === -2 ? actual === -2 || actual === 0 : actual === e;
    if (!ok) mismatches.push({ bank: Math.floor(i / BANK_SIZE), offset: i % BANK_SIZE, expected: e, actual });
  }
  return { compared, mismatches };
}
