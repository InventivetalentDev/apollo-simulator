// Runs the AGC in real time (or faster), feeds it DSKY keystrokes at a
// human pace, and keeps simple statistics for the UI.

import { AGC, MCT_PER_SECOND } from '../agc/cpu.ts';
import { pressKey, releaseKey, type DskyKey } from '../agc/dsky.ts';

/** Simulated time between queued keystrokes, so each KEYRUPT is fully handled. */
const KEY_GAP_MCT = Math.round(0.14 * MCT_PER_SECOND);
// The software samples PRO every 120 ms (in T4RUPT), so hold it longer than that.
const PRO_HOLD_MCT = Math.round(0.3 * MCT_PER_SECOND);
/** Never try to catch up more than this much real time in one frame (e.g. after a background tab). */
const MAX_FRAME_SECONDS = 0.1;

export class Machine {
  readonly agc: AGC;
  running = true;
  speed = 1;
  private lastNow = 0;
  private queue: DskyKey[] = [];
  private nextKeyAt = 0;
  private proReleaseAt = 0;
  private proHeldByPointer = false;
  /** Interrupt counts per second, refreshed about once a second. */
  interruptRates = new Array<number>(11).fill(0);
  private rateWindowStart = 0;
  private rateBase = new Uint32Array(11);
  /** Instructions per second over the last second of simulated time. */
  instructionRate = 0;
  private instrBase = 0;

  constructor(rope: Uint16Array) {
    this.agc = new AGC(rope);
  }

  /** Queue a keystroke (or a sequence) to be typed at human speed. */
  type(keys: DskyKey[]): void {
    this.queue.push(...keys);
  }

  get pendingKeys(): number {
    return this.queue.length;
  }

  /** PRO is held for as long as the pointer is down (with a minimum hold time). */
  holdPro(down: boolean): void {
    if (down) {
      this.proHeldByPointer = true;
      pressKey(this.agc, 'PRO');
      this.proReleaseAt = this.agc.cycleCounter + PRO_HOLD_MCT;
    } else {
      this.proHeldByPointer = false;
    }
  }

  reset(): void {
    this.agc.reset();
    this.queue = [];
    this.nextKeyAt = 0;
    this.proReleaseAt = 0;
    this.rateWindowStart = 0;
    this.rateBase.fill(0);
    this.instrBase = 0;
    this.interruptRates.fill(0);
    this.instructionRate = 0;
  }

  /** Advance by the real time elapsed since the last frame. */
  frame(now: number): void {
    const dt = this.lastNow ? Math.min((now - this.lastNow) / 1000, MAX_FRAME_SECONDS) : 0;
    this.lastNow = now;
    if (!this.running) return;
    this.advance(Math.round(dt * MCT_PER_SECOND * this.speed));
  }

  /** Execute exactly one instruction (or interrupt entry). */
  stepInstruction(): void {
    const start = this.agc.instructions;
    const startRupts = this.agc.interruptCounts.reduce((a, b) => a + b, 0);
    for (let i = 0; i < 200; i++) {
      this.agc.step();
      if (this.agc.instructions !== start) break;
      if (this.agc.interruptCounts.reduce((a, b) => a + b, 0) !== startRupts) break;
    }
    this.serviceKeys();
  }

  advance(mcts: number): void {
    const agc = this.agc;
    const end = agc.cycleCounter + mcts;
    while (agc.cycleCounter < end) {
      const chunk = Math.min(end - agc.cycleCounter, 2000);
      agc.run(chunk);
      this.serviceKeys();
      this.updateRates();
    }
  }

  private serviceKeys(): void {
    const agc = this.agc;
    if (this.proReleaseAt && agc.cycleCounter >= this.proReleaseAt && !this.proHeldByPointer) {
      releaseKey(agc, 'PRO');
      this.proReleaseAt = 0;
      this.nextKeyAt = agc.cycleCounter + KEY_GAP_MCT;
    }
    if (!this.queue.length || agc.cycleCounter < this.nextKeyAt || this.proReleaseAt) return;
    const key = this.queue.shift()!;
    pressKey(agc, key);
    if (key === 'PRO') this.proReleaseAt = agc.cycleCounter + PRO_HOLD_MCT;
    this.nextKeyAt = agc.cycleCounter + KEY_GAP_MCT;
  }

  private updateRates(): void {
    const agc = this.agc;
    const window = agc.cycleCounter - this.rateWindowStart;
    if (window < MCT_PER_SECOND) return;
    const seconds = window / MCT_PER_SECOND;
    for (let i = 0; i < 11; i++) {
      this.interruptRates[i] = (agc.interruptCounts[i] - this.rateBase[i]) / seconds;
      this.rateBase[i] = agc.interruptCounts[i];
    }
    this.instructionRate = (agc.instructions - this.instrBase) / seconds;
    this.instrBase = agc.instructions;
    this.rateWindowStart = agc.cycleCounter;
  }
}
