// An emulator for the Block II Apollo Guidance Computer.
//
// The model follows the hardware closely enough to run the unmodified flight
// software: 15-bit ones'-complement words, 16-bit A/L/Q registers that carry
// an overflow bit, banked erasable and fixed memory, the extracode
// instructions, interrupts, the timer counters TIME1-TIME6, I/O channels, and
// the hardware alarms (night watchman, rupt lock, TC trap) that force a
// restart when the software stops behaving.
//
// Timing is counted in memory cycles (MCT, 11.72 microseconds); `step()`
// advances the machine by one MCT, much like the real timing pulse generator.
// The behaviour of the less-documented corners (MP/DV sign rules, editing
// registers, interrupt entry and RESUME) matches the Virtual AGC project's
// yaAGC, which has been validated against the original hardware tests.

export const MCT_PER_SECOND = 1024000 / 12; // 85333.3

// Central and special registers (erasable bank 0).
export const REG = {
  A: 0o0,
  L: 0o1,
  Q: 0o2,
  EB: 0o3,
  FB: 0o4,
  Z: 0o5,
  BB: 0o6,
  ZERO: 0o7,
  ARUPT: 0o10,
  LRUPT: 0o11,
  QRUPT: 0o12,
  ZRUPT: 0o15,
  BBRUPT: 0o16,
  BRUPT: 0o17,
  CYR: 0o20,
  SR: 0o21,
  CYL: 0o22,
  EDOP: 0o23,
  TIME2: 0o24,
  TIME1: 0o25,
  TIME3: 0o26,
  TIME4: 0o27,
  TIME5: 0o30,
  TIME6: 0o31,
  CDUX: 0o32,
  CDUY: 0o33,
  CDUZ: 0o34,
  OPTY: 0o35,
  OPTX: 0o36,
  PIPAX: 0o37,
  PIPAY: 0o40,
  PIPAZ: 0o41,
  INLINK: 0o45,
  NEWJOB: 0o67,
} as const;

export const INTERRUPT_NAMES = ['', 'T6RUPT', 'T5RUPT', 'T3RUPT', 'T4RUPT', 'KEYRUPT1', 'KEYRUPT2', 'UPRUPT', 'DOWNRUPT', 'RADARUPT', 'HANDRUPT'];

// Channel 77 alarm bits, as the software reads them after a restart.
export const ALARM = { PARITY: 0o1, TC_TRAP: 0o4, RUPT_LOCK: 0o10, NIGHT_WATCHMAN: 0o20 } as const;

const ERASABLE_WORDS = 0o4000;
const FIXED_BASE = ERASABLE_WORDS;
export const FIXED_WORDS = 0o44 * 0o2000;

// Extra MCTs taken by each instruction beyond the first, indexed by the top
// five bits of the instruction (opcode and quarter code).
const BASIC_TIMING = [0, 0, 0, 0, 1, 0, 0, 0, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
const EXTRACODE_TIMING = [1, 1, 1, 1, 5, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 0, 0, 0, 2, 2, 2, 2];

// ---- Ones'-complement helpers.  "16-bit" values carry an overflow bit in
// bit 15 and the true sign in bit 16; 15-bit values are memory words.

export const signExtend = (w: number): number => (w & 0o77777) | ((w << 1) & 0o100000);
export const overflowCorrected = (v: number): number => (v & 0o37777) | ((v >> 1) & 0o40000);
const addSP16 = (a: number, b: number): number => {
  let sum = a + b;
  if (sum & 0o200000) sum = (sum + 1) & 0o177777;
  return sum;
};
/** +1, -1 (as 15-bit 077776) or +0 depending on the overflow state of a 16-bit value. */
const valueOverflowed = (v: number): number => {
  switch (v & 0o140000) {
    case 0o40000:
      return 1;
    case 0o100000:
      return 0o77776;
    default:
      return 0;
  }
};
const dabs15 = (x: number): number => {
  if (x & 0o40000) x = 0o37777 & ~x;
  return x > 1 ? x - 1 : 0;
};
const dabs16 = (x: number): number => {
  if (x & 0o100000) x = 0o177777 & ~x;
  return x > 1 ? x - 1 : 0;
};
const agcToInt = (w: number): number => (w & 0o40000 ? -(0o37777 & ~w) : w & 0o37777);
const intToAgc = (n: number): number => (n < 0 ? 0o77777 & ~-n : n & 0o77777);
const intToAgc2 = (n: number): number => (n < 0 ? 0o3777777777 & ~(0o1777777777 & -n) : n & 0o1777777777);
const absSP = (w: number): number => (w & 0o40000 ? 0o77777 & ~w : w);

/** A 28-bit double-precision value from two words, as the hardware would interpret it. */
function spToDecent(msb: number, lsb: number): number {
  if (msb === 0 || msb === 0o77777) {
    let v = signExtend(lsb);
    if (v & 0o100000) v |= ~0o177777;
    return v & 0o7777777777;
  }
  if ((0o40000 & lsb) !== (0o40000 & msb)) {
    if (lsb === 0 || lsb === 0o77777) {
      lsb = 0o40000 & msb ? 0o77777 : 0;
    } else {
      const complement = 0o40000 & msb;
      if (complement) {
        msb = 0o77777 & ~msb;
        lsb = 0o77777 & ~lsb;
      }
      msb--;
      lsb = (lsb + 0o40000 + 1) & 0o77777;
      if (complement) {
        msb = 0o77777 & ~msb;
        lsb = 0o77777 & ~lsb;
      }
    }
  }
  let v = (0o3777740000 & (msb << 14)) | (0o37777 & lsb);
  if (0o2000000000 & v) v |= 0o4000000000;
  return v;
}

export interface CpuSnapshot {
  mem: Uint16Array;
  channels: Uint16Array;
  relays: Uint16Array;
}

export class AGC {
  /** Erasable memory (banks E0-E7) followed by the fixed-memory rope (banks 0-43). */
  readonly mem = new Uint16Array(ERASABLE_WORDS + FIXED_WORDS);
  /** I/O channels.  Channels 1 and 2 alias the L and Q registers. */
  readonly channels = new Uint16Array(0o1000);
  /** The latest word written to channel 10 for each DSKY relay row. */
  readonly relays = new Uint16Array(16);
  readonly interruptRequests = new Array<boolean>(11).fill(false);
  /** How many times each interrupt has been taken (index 1-10, 0 = EDRUPT). */
  readonly interruptCounts = new Uint32Array(11);

  cycleCounter = 0;
  /** Number of instructions executed. */
  instructions = 0;
  nextZ = 0;
  extraCode = false;
  allowInterrupt = true;
  inIsr = false;
  substituteInstruction = false;
  indexValue = 0;
  pendFlag = false;
  pendDelay = 0;
  extraDelay = 0;
  outputChannel7 = 0;

  scalerCounter = 0;
  standby = false;
  nightWatchman = false;
  nightWatchmanTripped = false;
  ruptLock = false;
  noRupt = false;
  tcTrap = false;
  noTC = false;
  restartLight = false;
  restarts = 0;
  /** Set to false to stop hardware alarms from restarting the computer. */
  alarmsEnabled = true;

  downruptTime = 0;
  downruptTimeValid = false;
  private downlinkWritten = 0;
  private tookBZF = false;
  private tookBZMF = false;

  /** Rope index (bank*1024+offset) of the last instruction fetched from fixed memory, or -1. */
  lastRopeIndex = -1;
  /** Executions per rope word, for showing which code has run. */
  readonly execCounts = new Uint32Array(FIXED_WORDS);
  /** Called whenever the software writes an output channel. */
  onChannelWrite: ((channel: number, value: number) => void) | null = null;
  /** Called on each hardware restart, with the channel 77 alarm bits. */
  onRestart: ((alarms: number) => void) | null = null;

  constructor(rope?: Uint16Array) {
    if (rope) this.loadRope(rope);
    this.reset();
  }

  loadRope(rope: Uint16Array): void {
    this.mem.set(rope.subarray(0, FIXED_WORDS), FIXED_BASE);
  }

  /** Power-on: clear erasable memory and start at the fresh-start address 4000. */
  reset(): void {
    this.mem.fill(0, 0, ERASABLE_WORDS);
    this.channels.fill(0);
    this.relays.fill(0);
    this.channels[0o30] = 0o37777;
    this.channels[0o31] = 0o77777;
    this.channels[0o32] = 0o77777;
    this.channels[0o33] = 0o77777;
    this.mem[REG.Z] = 0o4000;
    this.nextZ = 0o4000;
    this.cycleCounter = 0;
    this.instructions = 0;
    this.extraCode = false;
    this.allowInterrupt = true;
    this.inIsr = false;
    this.substituteInstruction = false;
    this.indexValue = 0;
    this.pendFlag = false;
    this.pendDelay = 0;
    this.extraDelay = 0;
    this.outputChannel7 = 0;
    this.interruptRequests.fill(false);
    this.scalerCounter = 0;
    this.standby = false;
    this.nightWatchman = this.nightWatchmanTripped = false;
    this.ruptLock = this.noRupt = this.tcTrap = this.noTC = false;
    this.restartLight = false;
    this.restarts = 0;
    this.downruptTimeValid = true;
    this.downruptTime = 0;
    this.downlinkWritten = 0;
    this.tookBZF = this.tookBZMF = false;
    this.lastRopeIndex = -1;
    this.execCounts.fill(0);
    this.interruptCounts.fill(0);
  }

  // ---- Memory.

  /** Index into `mem` for a 12-bit CPU address under the current bank registers. */
  memIndex(address12: number): number {
    address12 &= 0o7777;
    if (address12 === REG.NEWJOB) this.nightWatchman = false;
    if (address12 < 0o1400) return address12;
    if (address12 < 0o2000) return ((this.mem[REG.EB] >> 8) & 7) * 0o400 + (address12 & 0o377);
    let bank: number;
    if (address12 < 0o4000) {
      bank = (this.mem[REG.FB] >> 10) & 0o37;
      if ((bank & 0o30) === 0o30 && this.outputChannel7 & 0o100) bank += 0o10;
    } else {
      bank = address12 < 0o6000 ? 2 : 3;
    }
    return FIXED_BASE + bank * 0o2000 + (address12 & 0o1777);
  }

  /** Read a word without side effects (for debuggers and the UI). */
  peek(address12: number): number {
    const nw = this.nightWatchman;
    const v = this.mem[this.memIndex(address12)];
    this.nightWatchman = nw;
    return v;
  }

  /** Write erasable memory, applying the special behaviour of the low registers. */
  private assign(index: number, value: number): void {
    if (index >= ERASABLE_WORDS) return; // fixed memory is read-only
    if (index < 0o400) {
      switch (index) {
        case REG.Z:
          this.nextZ = value;
          break;
        case REG.CYR:
          value &= 0o77777;
          value = value & 1 ? (value >> 1) | 0o40000 : value >> 1;
          break;
        case REG.SR:
          value &= 0o77777;
          value = value & 0o40000 ? (value >> 1) | 0o40000 : value >> 1;
          break;
        case REG.CYL:
          value &= 0o77777;
          value = value & 0o40000 ? (value << 1) + 1 : value << 1;
          break;
        case REG.EDOP:
          value = ((value & 0o77777) >> 7) & 0o177;
          break;
        case REG.ZERO:
          value = 0;
          break;
      }
      this.mem[index] = index < 3 ? value & 0o177777 : value & 0o77777;
    } else {
      this.mem[index] = value & 0o77777;
    }
  }

  /** A timer write that overflowed (from INCR/AUG) raises the same interrupt as the counter would. */
  private counterOverflowRupt(address10: number, sum: number): void {
    if (valueOverflowed(sum) === 0) return;
    if (address10 === REG.TIME1) this.pinc(REG.TIME2);
    else if (address10 === REG.TIME5) this.interruptRequests[2] = true;
    else if (address10 === REG.TIME3) this.interruptRequests[3] = true;
    else if (address10 === REG.TIME4) this.interruptRequests[4] = true;
  }

  // ---- Counters (unprogrammed sequences).

  /** PINC: add one to a counter; returns true on overflow. */
  pinc(reg: number): boolean {
    let v = this.mem[reg];
    if (v === 0o37777) {
      this.mem[reg] = 0;
      return true;
    }
    v = (v + 1) & 0o77777;
    if (v === 0) v++;
    this.mem[reg] = v;
    return false;
  }

  /** MINC: subtract one from a counter; returns true on overflow. */
  minc(reg: number): boolean {
    let v = this.mem[reg];
    if (v === 0o40000) {
      this.mem[reg] = 0o77777;
      return true;
    }
    v = (v - 1) & 0o77777;
    if (v === 0o77777) v--;
    this.mem[reg] = v;
    return false;
  }

  /** DINC: count a counter towards zero; returns true when it is (or reaches) zero. */
  private dinc(reg: number): boolean {
    const v = this.mem[reg];
    if (v === 0 || v === 0o77777) return true;
    this.mem[reg] = (v & 0o40000 ? addSP16(signExtend(v), 1) : addSP16(signExtend(v), signExtend(0o77776))) & 0o77777;
    return false;
  }

  /** PCDU/MCDU: two's-complement counting used by the CDU angle counters. */
  pcdu(reg: number): void {
    this.mem[reg] = (this.mem[reg] + 1) & 0o77777;
    this.extraDelay++;
  }
  mcdu(reg: number): void {
    this.mem[reg] = (this.mem[reg] - 1) & 0o77777;
    this.extraDelay++;
  }

  // ---- I/O.

  readChannel(channel: number): number {
    if (channel === REG.L || channel === REG.Q) return this.mem[channel];
    return this.channels[channel];
  }

  /** Input from the outside world (DSKY keys, discretes).  Does not raise interrupts. */
  setInputChannel(channel: number, value: number): void {
    this.channels[channel] = value & 0o77777;
  }

  /** A DSKY keystroke: put the 5-bit key code in channel 15 and request KEYRUPT1. */
  keypress(code: number): void {
    this.channels[0o15] = code & 0o37;
    if (code === 0o22) this.restartLight = false; // RSET also clears the RESTART lamp
    this.interruptRequests[5] = true;
  }

  private writeIO(channel: number, value: number): void {
    value &= 0o77777;
    if (channel === REG.L || channel === REG.Q) this.mem[channel] = value;
    if (channel === 0o10) this.relays[(value >> 11) & 0o17] = value;
    else if (channel === 0o33) value = (this.channels[0o33] & 0o76000) | (value & 0o1777);
    this.channels[channel] = value;
  }

  private cpuWriteIO(channel: number, value: number): void {
    if (channel === 0o13) value &= 0o43777; // bits 12-14 only reset the hand-controller traps
    if (channel === 0o33) {
      this.channels[0o33] |= 0o76000;
      value = this.channels[0o33];
    } else if (channel === 0o77) {
      value = this.nightWatchmanTripped ? ALARM.NIGHT_WATCHMAN : 0;
    } else if (channel === 0o11 && value & 0o1000) {
      this.restartLight = false;
    } else if (channel === 0o7) {
      this.outputChannel7 = value & 0o160;
    }
    this.writeIO(channel, value);
    this.onChannelWrite?.(channel, value & 0o77777);
    // Telemetry: once both downlink words are loaded, the hardware shifts them
    // out and requests DOWNRUPT 20 ms later.
    if (channel === 0o34) this.downlinkWritten |= 1;
    else if (channel === 0o35) this.downlinkWritten |= 2;
    if (this.downlinkWritten === 3) {
      this.downruptTimeValid = true;
      this.downruptTime = this.cycleCounter + Math.round(MCT_PER_SECOND / 50);
      this.downlinkWritten = 0;
    }
  }

  // ---- Hardware restart (GOJAM).

  private gojam(alarms: number): void {
    this.extraDelay += 2;
    this.mem[REG.Q] = this.mem[REG.Z];
    this.mem[REG.Z] = 0o4000;
    this.nextZ = 0o4000;
    this.inIsr = false;
    this.allowInterrupt = true;
    this.interruptRequests.fill(false);
    // Output channels are cleared; the DSKY's latching relays keep their state.
    for (const ch of [0o5, 0o6, 0o10, 0o11, 0o12, 0o13, 0o14]) this.cpuWriteIO(ch, 0);
    this.channels[0o33] |= 0o2000;
    this.cpuWriteIO(0o34, 0);
    this.cpuWriteIO(0o35, 0);
    this.downruptTimeValid = false;
    this.indexValue = 0;
    this.extraCode = false;
    this.substituteInstruction = false;
    this.pendFlag = false;
    this.pendDelay = 0;
    this.tookBZF = this.tookBZMF = false;
    this.restartLight = true;
    this.restarts++;
    this.onRestart?.(alarms);
  }

  // ---- The scaler: a 3200 Hz clock that drives the timers and the alarms.

  private scalerTick(): void {
    const ch = this.channels;
    let s = (ch[0o4] + 1) & 0o77777;
    if (s === 0o40000) {
      s = 0;
      ch[0o3] = (ch[0o3] + 1) & 0o37777;
    }
    ch[0o4] = s;
    let alarm = 0;

    if ((s & 0o7777) === 0o4000) {
      this.nightWatchman = true;
    } else if ((s & 0o7777) === 0) {
      if (this.nightWatchman) {
        alarm |= ALARM.NIGHT_WATCHMAN;
        this.nightWatchmanTripped = true;
      } else {
        this.nightWatchmanTripped = false;
      }
    }

    if ((s & 0o777) === 0o400) {
      this.ruptLock = this.noRupt = true;
    } else if ((this.ruptLock || this.noRupt) && (s & 0o777) === 0o300) {
      alarm |= ALARM.RUPT_LOCK;
    }
    if ((s & 0o37) === 0o20) {
      this.tcTrap = this.noTC = true;
    } else if ((this.tcTrap || this.noTC) && (s & 0o37) === 0) {
      alarm |= ALARM.TC_TRAP;
    }

    if ((s & 0o37) === 0o20) {
      this.extraDelay++;
      if (this.pinc(REG.TIME1)) {
        this.extraDelay++;
        this.pinc(REG.TIME2);
      }
      this.extraDelay++;
      if (this.pinc(REG.TIME3)) this.interruptRequests[3] = true;
    }
    if ((s & 0o37) === 0) {
      this.extraDelay++;
      if (this.pinc(REG.TIME5)) this.interruptRequests[2] = true;
    }
    if ((s & 0o37) === 0o10) {
      this.extraDelay++;
      if (this.pinc(REG.TIME4)) this.interruptRequests[4] = true;
    }
    if (ch[0o13] & 0o40000 && s & 1) {
      this.extraDelay++;
      if (this.dinc(REG.TIME6)) {
        this.interruptRequests[1] = true;
        this.cpuWriteIO(0o13, ch[0o13] & 0o37777);
      }
    }

    if (alarm && this.alarmsEnabled) {
      ch[0o77] |= alarm;
      this.gojam(alarm);
    }
  }

  // ---- Execution.

  /** Advance the machine by one memory cycle. */
  step(): void {
    if (this.downruptTimeValid && this.cycleCounter >= this.downruptTime) {
      this.interruptRequests[8] = true;
      this.downruptTimeValid = false;
    }
    if (this.cycleCounter === 0) this.restartLight = true;
    this.cycleCounter++;
    this.scalerCounter += 3; // the scaler runs at 3200 Hz: 3 ticks per 80 MCT

    if (this.extraDelay) {
      this.extraDelay--;
      return;
    }
    if (this.pendFlag && this.pendDelay > 0) {
      this.pendDelay--;
      return;
    }
    while (this.scalerCounter >= 80) {
      this.scalerCounter -= 80;
      this.scalerTick();
      if (this.extraDelay) {
        // Counter updates steal memory cycles from the program.
        this.extraDelay--;
        return;
      }
    }
    if (this.standby) return;
    this.execute();
  }

  /** Run for a number of memory cycles. */
  run(mcts: number): void {
    for (let i = 0; i < mcts; i++) this.step();
  }

  private execute(): void {
    const mem = this.mem;
    const currentEB = mem[REG.EB];
    const currentFB = mem[REG.FB];
    const currentBB = mem[REG.BB];
    let acc = mem[REG.A];
    const overflow = valueOverflowed(acc) !== 0;
    const pc = mem[REG.Z] & 0o7777;
    const where = this.memIndex(pc);
    let instruction: number;
    if (this.substituteInstruction) instruction = mem[REG.BRUPT];
    else instruction = overflowCorrected(addSP16(signExtend(this.indexValue), signExtend(mem[where])));
    instruction &= 0o77777;
    const extOp = (instruction >> 9) | (this.extraCode ? 0o100 : 0);
    const quarter = instruction >> 10;
    const a12 = instruction & 0o7777;
    const a10 = instruction & 0o1777;
    const a9 = instruction & 0o777;
    let keepExtraCode = false;
    let executedTC = false;
    let tcTransient = false;
    let justTookBZF = false;
    let justTookBZMF = false;

    // Interrupts are taken between instructions, unless inhibited, already in
    // an interrupt, just after EXTEND or INDEX, or while A holds an overflow.
    if (
      (!this.inIsr &&
        this.allowInterrupt &&
        !this.extraCode &&
        !this.pendFlag &&
        !overflow &&
        instruction !== 3 &&
        instruction !== 4 &&
        instruction !== 6) ||
      extOp === 0o107
    ) {
      let taken = false;
      for (let i = 1; i <= 10; i++) {
        if (this.interruptRequests[i]) {
          this.interruptRequests[i] = false;
          this.nextZ = 0o4000 + 4 * i;
          this.interruptCounts[i]++;
          taken = true;
          break;
        }
      }
      if (!taken && extOp === 0o107) {
        this.nextZ = 0;
        this.interruptCounts[0]++;
        taken = true;
      }
      if (taken) {
        mem[REG.ZRUPT] = pc + 1;
        mem[REG.BRUPT] = instruction;
        this.extraCode = false;
        this.indexValue = 0;
        this.substituteInstruction = false;
        this.inIsr = true;
        this.extraDelay++;
        this.finish(currentEB, currentFB, currentBB, false, false, false, false, false);
        return;
      }
    }

    if (!this.pendFlag) {
      const t = (this.extraCode ? EXTRACODE_TIMING : BASIC_TIMING)[quarter];
      if (t) {
        this.pendFlag = true;
        this.pendDelay = t - 1;
        return;
      }
    } else {
      this.pendFlag = false;
    }

    this.instructions++;
    if (where >= FIXED_BASE) {
      const r = where - FIXED_BASE;
      this.lastRopeIndex = r;
      this.execCounts[r]++;
    }
    this.indexValue = 0;
    this.substituteInstruction = false;
    this.nextZ = 1 + mem[REG.Z];
    mem[REG.Z] = this.nextZ;
    if (this.tookBZF && !(extOp === 0 && a12 === 6)) tcTransient = true;

    switch (extOp) {
      case 0o0:
      case 0o1:
      case 0o2:
      case 0o3:
      case 0o4:
      case 0o5:
      case 0o6:
      case 0o7: // TC (and RELINT, INHINT, EXTEND)
        if (a12 === 3) {
          this.allowInterrupt = true;
          if (this.tookBZF || this.tookBZMF) tcTransient = true;
        } else if (a12 === 4) {
          this.allowInterrupt = false;
          if (this.tookBZF || this.tookBZMF) tcTransient = true;
        } else if (a12 === 6) {
          this.extraCode = true;
          keepExtraCode = true;
        } else {
          if (a12 !== REG.Q) mem[REG.Q] = 0o177777 & this.nextZ;
          this.nextZ = a12;
          executedTC = true;
        }
        break;

      case 0o10:
      case 0o11: {
        // CCS
        let operand: number;
        let value16 = 0;
        if (a10 < 3) {
          value16 = mem[a10];
          operand = overflowCorrected(value16);
          mem[REG.A] = dabs16(value16);
        } else {
          const w = this.memIndex(a10);
          operand = mem[w] & 0o77777;
          mem[REG.A] = dabs15(operand);
          this.assign(w, operand);
        }
        if (a10 < 3 && valueOverflowed(value16) === 1) this.nextZ += 0;
        else if (a10 < 3 && valueOverflowed(value16) === 0o77776) this.nextZ += 2;
        else if (operand === 0) this.nextZ += 1;
        else if (operand === 0o77777) this.nextZ += 3;
        else if (operand & 0o40000) this.nextZ += 2;
        break;
      }

      case 0o12:
      case 0o13:
      case 0o14:
      case 0o15:
      case 0o16:
      case 0o17: // TCF
        this.nextZ = a12;
        executedTC = true;
        break;

      case 0o20:
      case 0o21: {
        // DAS (DDOUBL when K is A)
        let lsw: number;
        let msw: number;
        if (a10 === REG.L) {
          lsw = addSP16(mem[REG.L], mem[REG.L]);
          msw = addSP16(acc, acc);
          if ((0o140000 & lsw) === 0o40000) msw = addSP16(msw, 1);
          else if ((0o140000 & lsw) === 0o100000) msw = addSP16(msw, signExtend(0o77776));
          lsw = overflowCorrected(lsw);
          mem[REG.A] = msw & 0o177777;
          mem[REG.L] = signExtend(lsw);
          break;
        }
        const w = this.memIndex(a10);
        const wm = this.memIndex(a10 - 1);
        lsw = addSP16(mem[REG.L], a10 < 3 ? mem[a10] : signExtend(mem[w]));
        msw = addSP16(acc, a10 < 4 ? mem[a10 - 1] : signExtend(mem[wm]));
        if ((0o140000 & lsw) === 0o40000) msw = addSP16(msw, 1);
        else if ((0o140000 & lsw) === 0o100000) msw = addSP16(msw, signExtend(0o77776));
        lsw = overflowCorrected(lsw);
        if ((0o140000 & msw) === 0o100000) mem[REG.A] = signExtend(0o77776);
        else if ((0o140000 & msw) === 0o40000) mem[REG.A] = 1;
        else mem[REG.A] = 0;
        mem[REG.L] = 0;
        if (a10 < 3) mem[a10] = signExtend(lsw);
        else this.assign(w, lsw);
        if (a10 < 4) mem[a10 - 1] = msw;
        else this.assign(wm, overflowCorrected(msw));
        break;
      }

      case 0o22:
      case 0o23: {
        // LXCH
        if (a10 === REG.L) break;
        if (a10 === REG.ZERO) {
          mem[REG.L] = 0;
        } else if (a10 < 3) {
          const t = mem[REG.L];
          mem[REG.L] = mem[a10];
          mem[a10] = t;
        } else {
          const w = this.memIndex(a10);
          const t = mem[w];
          this.assign(w, overflowCorrected(mem[REG.L]));
          mem[REG.L] = signExtend(t);
        }
        break;
      }

      case 0o24:
      case 0o25: {
        // INCR
        const w = this.memIndex(a10);
        if (a10 < 3) {
          mem[a10] = addSP16(1, mem[a10]);
        } else {
          const sum = addSP16(1, signExtend(mem[w]));
          this.assign(w, overflowCorrected(sum));
          this.counterOverflowRupt(a10, sum);
        }
        break;
      }

      case 0o26:
      case 0o27: {
        // ADS
        const w = this.memIndex(a10);
        if (a10 === REG.A) acc = addSP16(acc, acc);
        else if (a10 < 3) acc = addSP16(acc, mem[a10]);
        else acc = addSP16(acc, signExtend(mem[w]));
        mem[REG.A] = acc;
        if (a10 === REG.A) {
          // nothing more
        } else if (a10 < 3) {
          mem[a10] = acc;
        } else {
          this.assign(w, overflowCorrected(acc));
        }
        break;
      }

      case 0o30:
      case 0o31:
      case 0o32:
      case 0o33:
      case 0o34:
      case 0o35:
      case 0o36:
      case 0o37: {
        // CA
        if (a12 === REG.A) break;
        if (a12 < 3) {
          mem[REG.A] = mem[a12];
          break;
        }
        const w = this.memIndex(a12);
        mem[REG.A] = signExtend(mem[w]);
        this.assign(w, mem[w]);
        break;
      }

      case 0o40:
      case 0o41:
      case 0o42:
      case 0o43:
      case 0o44:
      case 0o45:
      case 0o46:
      case 0o47: {
        // CS
        tcTransient = true;
        if (a12 === REG.A) {
          mem[REG.A] = ~acc & 0o177777;
          break;
        }
        if (a12 < 3) {
          mem[REG.A] = ~mem[a12] & 0o177777;
          break;
        }
        const w = this.memIndex(a12);
        mem[REG.A] = signExtend(0o77777 & ~mem[w]);
        this.assign(w, mem[w]);
        break;
      }

      case 0o50:
      case 0o51: // INDEX (RESUME when K is BRUPT)
        if (a10 === REG.BRUPT) {
          this.resume();
        } else if (a10 < 3) {
          this.indexValue = overflowCorrected(mem[a10]);
        } else {
          this.indexValue = mem[this.memIndex(a10)];
        }
        break;
      case 0o150:
      case 0o151:
      case 0o152:
      case 0o153:
      case 0o154:
      case 0o155:
      case 0o156:
      case 0o157: // extracode INDEX
        if (a12 === REG.BRUPT << 1) {
          this.resume();
        } else {
          this.indexValue = a12 < 3 ? overflowCorrected(mem[a12]) : mem[this.memIndex(a12)];
          keepExtraCode = true;
        }
        break;

      case 0o52:
      case 0o53: {
        // DXCH
        tcTransient = true;
        if (a10 === REG.L) {
          mem[REG.L] = signExtend(overflowCorrected(mem[REG.L]));
          break;
        }
        const w = this.memIndex(a10);
        if (a10 < 3) {
          const t = mem[a10];
          mem[a10] = mem[REG.L];
          mem[REG.L] = t;
        } else {
          const t = signExtend(mem[w]);
          this.assign(w, overflowCorrected(mem[REG.L]));
          mem[REG.L] = t;
        }
        mem[REG.L] = signExtend(overflowCorrected(mem[REG.L]));
        if (a10 < 4) {
          const t = mem[a10 - 1];
          mem[a10 - 1] = mem[REG.A];
          mem[REG.A] = t;
        } else {
          const wm = this.memIndex(a10 - 1);
          const t = signExtend(mem[wm]);
          this.assign(wm, overflowCorrected(mem[REG.A]));
          mem[REG.A] = t;
        }
        break;
      }

      case 0o54:
      case 0o55: // TS
        tcTransient = true;
        if (a10 === REG.A) {
          if (overflow) this.nextZ += 1;
        } else if (a10 === REG.Z) {
          this.nextZ = 0o77777 & acc;
          if (overflow) mem[REG.A] = signExtend(valueOverflowed(acc));
        } else {
          const w = this.memIndex(a10);
          if (a10 < 3) mem[a10] = acc;
          else this.assign(w, overflowCorrected(acc));
          if (overflow) {
            mem[REG.A] = signExtend(valueOverflowed(acc));
            this.nextZ += 1;
          }
        }
        break;

      case 0o56:
      case 0o57: {
        // XCH
        tcTransient = true;
        if (a10 === REG.A) break;
        if (a10 < 3) {
          mem[REG.A] = mem[a10];
          mem[a10] = acc;
          break;
        }
        const w = this.memIndex(a10);
        mem[REG.A] = signExtend(mem[w]);
        this.assign(w, overflowCorrected(acc));
        break;
      }

      case 0o60:
      case 0o61:
      case 0o62:
      case 0o63:
      case 0o64:
      case 0o65:
      case 0o66:
      case 0o67: {
        // AD
        if (a12 === REG.A) acc = addSP16(acc, acc);
        else if (a12 < 3) acc = addSP16(acc, mem[a12]);
        else {
          const w = this.memIndex(a12);
          acc = addSP16(acc, signExtend(mem[w]));
          this.assign(w, mem[w]);
        }
        mem[REG.A] = acc;
        break;
      }

      case 0o70:
      case 0o71:
      case 0o72:
      case 0o73:
      case 0o74:
      case 0o75:
      case 0o76:
      case 0o77: // MASK
        if (a12 < 3) mem[REG.A] = acc & mem[a12];
        else mem[REG.A] = signExtend(overflowCorrected(acc) & mem[this.memIndex(a12)]);
        break;

      // ---- Extracodes.

      case 0o100: // READ
        mem[REG.A] = a9 === REG.L || a9 === REG.Q ? mem[a9] : signExtend(this.readChannel(a9));
        break;
      case 0o101: // WRITE
        if (a9 === REG.L || a9 === REG.Q) mem[a9] = acc;
        else this.cpuWriteIO(a9, overflowCorrected(acc));
        break;
      case 0o102: // RAND
        if (a9 === REG.L || a9 === REG.Q) mem[REG.A] = acc & mem[a9];
        else mem[REG.A] = signExtend(overflowCorrected(acc) & this.readChannel(a9));
        break;
      case 0o103: // WAND
        if (a9 === REG.L || a9 === REG.Q) mem[REG.A] = mem[a9] = acc & mem[a9];
        else {
          const v = overflowCorrected(acc) & this.readChannel(a9);
          this.cpuWriteIO(a9, v);
          mem[REG.A] = signExtend(v);
        }
        break;
      case 0o104: // ROR
        if (a9 === REG.L || a9 === REG.Q) mem[REG.A] = acc | mem[a9];
        else mem[REG.A] = signExtend(overflowCorrected(acc) | this.readChannel(a9));
        break;
      case 0o105: // WOR
        if (a9 === REG.L || a9 === REG.Q) mem[REG.A] = mem[a9] = acc | mem[a9];
        else {
          const v = overflowCorrected(acc) | this.readChannel(a9);
          this.cpuWriteIO(a9, v);
          mem[REG.A] = signExtend(v);
        }
        break;
      case 0o106: // RXOR
        if (a9 === REG.L || a9 === REG.Q) mem[REG.A] = acc ^ mem[a9];
        else mem[REG.A] = signExtend(overflowCorrected(acc) ^ this.readChannel(a9));
        break;
      case 0o107: // EDRUPT (handled with the interrupt logic above)
        break;

      case 0o110:
      case 0o111:
        this.dv(acc, a10);
        break;

      case 0o112:
      case 0o113:
      case 0o114:
      case 0o115:
      case 0o116:
      case 0o117: // BZF
        if (acc === 0 || acc === 0o177777) {
          this.nextZ = a12;
          justTookBZF = true;
        }
        break;

      case 0o120:
      case 0o121: {
        // MSU: unsigned (two's-complement) subtraction, result in ones' complement
        const w = this.memIndex(a10);
        let ui: number;
        let uj: number;
        if (a10 < 3) {
          ui = 0o177777 & acc;
          uj = 0o177777 & ~mem[a10];
        } else {
          ui = 0o77777 & overflowCorrected(acc);
          uj = 0o77777 & ~mem[w];
        }
        let diff = ui + uj + 1;
        if (diff & 0o40000) {
          diff |= 0o100000;
          diff--;
        }
        mem[REG.A] = a10 === REG.Q ? 0o177777 & diff : signExtend(0o77777 & diff);
        if (a10 >= 0o20 && a10 <= 0o23) this.assign(w, mem[w]);
        break;
      }

      case 0o122:
      case 0o123: {
        // QXCH
        if (a10 === REG.Q) break;
        if (a10 === REG.ZERO) {
          mem[REG.Q] = 0;
        } else if (a10 < 3) {
          const t = mem[REG.Q];
          mem[REG.Q] = mem[a10];
          mem[a10] = t;
        } else {
          const w = this.memIndex(a10);
          const t = overflowCorrected(mem[REG.Q]);
          mem[REG.Q] = signExtend(mem[w]);
          this.assign(w, t);
        }
        break;
      }

      case 0o124:
      case 0o125: {
        // AUG
        const w = this.memIndex(a10);
        const operand = (a10 < 3 ? mem[a10] : signExtend(mem[w])) & 0o177777;
        const inc = operand & 0o100000 ? signExtend(0o77776) : 1;
        const sum = addSP16(inc, operand);
        if (a10 < 3) mem[a10] = sum;
        else {
          this.assign(w, overflowCorrected(sum));
          this.counterOverflowRupt(a10, sum);
        }
        break;
      }

      case 0o126:
      case 0o127: {
        // DIM
        const w = this.memIndex(a10);
        const operand = (a10 < 3 ? mem[a10] : signExtend(mem[w])) & 0o177777;
        if (operand === 0 || operand === 0o177777) break;
        const inc = operand & 0o100000 ? 1 : signExtend(0o77776);
        const sum = addSP16(inc, operand);
        if (a10 < 3) mem[a10] = sum;
        else this.assign(w, overflowCorrected(sum));
        break;
      }

      case 0o130:
      case 0o131:
      case 0o132:
      case 0o133:
      case 0o134:
      case 0o135:
      case 0o136:
      case 0o137: {
        // DCA
        if (a12 === REG.L) {
          mem[REG.L] = signExtend(overflowCorrected(mem[REG.L]));
          break;
        }
        const w = this.memIndex(a12);
        const wm = this.memIndex(a12 - 1);
        mem[REG.L] = signExtend(overflowCorrected(a12 < 3 ? mem[a12] : signExtend(mem[w])));
        mem[REG.A] = a12 < 4 ? mem[a12 - 1] : signExtend(mem[wm]);
        if (a12 >= 0o20 && a12 <= 0o23) this.assign(w, mem[w]);
        if (a12 >= 0o21 && a12 <= 0o24) this.assign(wm, mem[wm]);
        break;
      }

      case 0o140:
      case 0o141:
      case 0o142:
      case 0o143:
      case 0o144:
      case 0o145:
      case 0o146:
      case 0o147: {
        // DCS (DCOM when K is A)
        if (a12 === REG.L) {
          mem[REG.A] = ~acc & 0o177777;
          mem[REG.L] = signExtend(overflowCorrected(~mem[REG.L] & 0o177777));
          break;
        }
        const w = this.memIndex(a12);
        const wm = this.memIndex(a12 - 1);
        mem[REG.L] = signExtend(overflowCorrected(~(a12 < 3 ? mem[a12] : signExtend(mem[w])) & 0o177777));
        mem[REG.A] = ~(a12 < 4 ? mem[a12 - 1] : signExtend(mem[wm])) & 0o177777;
        if (a12 >= 0o20 && a12 <= 0o23) this.assign(w, mem[w]);
        if (a12 >= 0o21 && a12 <= 0o24) this.assign(wm, mem[wm]);
        break;
      }

      case 0o160:
      case 0o161: {
        // SU
        if (a10 === REG.A) acc = signExtend(0o77777);
        else if (a10 < 3) acc = addSP16(acc, 0o177777 & ~mem[a10]);
        else {
          const w = this.memIndex(a10);
          acc = addSP16(acc, signExtend(0o77777 & ~mem[w]));
          this.assign(w, mem[w]);
        }
        mem[REG.A] = acc;
        break;
      }

      case 0o162:
      case 0o163:
      case 0o164:
      case 0o165:
      case 0o166:
      case 0o167: // BZMF
        if (acc === 0 || acc & 0o100000) {
          this.nextZ = a12;
          justTookBZMF = true;
        }
        break;

      case 0o170:
      case 0o171:
      case 0o172:
      case 0o173:
      case 0o174:
      case 0o175:
      case 0o176:
      case 0o177: {
        // MP
        const w = this.memIndex(a12);
        const op1 = overflowCorrected(acc);
        const op2 = a12 < 3 ? overflowCorrected(mem[a12]) : mem[w];
        let ms: number;
        let ls: number;
        if (op2 === 0 || op2 === 0o77777) {
          ms = ls = 0;
        } else if (op1 === 0 || op1 === 0o77777) {
          if ((op1 === 0 && op2 & 0o40000) || (op1 === 0o77777 && !(op2 & 0o40000))) ms = ls = 0o77777;
          else ms = ls = 0;
        } else {
          let product = intToAgc2(agcToInt(op1) * agcToInt(op2));
          if (0o2000000000 & product) product |= 0o4000000000;
          ls = (0o37777 & product) | (product & 0o4000000000 ? 0o40000 : 0);
          ms = overflowCorrected(0o177777 & Math.floor(product / 0o40000));
        }
        mem[REG.A] = signExtend(ms);
        mem[REG.L] = signExtend(ls);
        break;
      }

      default:
        break;
    }

    this.finish(currentEB, currentFB, currentBB, keepExtraCode, executedTC, tcTransient, justTookBZF, justTookBZMF);
  }

  private resume(): void {
    this.nextZ = this.mem[REG.ZRUPT] - 1;
    this.inIsr = false;
    this.substituteInstruction = true;
  }

  private finish(
    currentEB: number,
    currentFB: number,
    currentBB: number,
    keepExtraCode: boolean,
    executedTC: boolean,
    tcTransient: boolean,
    justTookBZF: boolean,
    justTookBZMF: boolean,
  ): void {
    const mem = this.mem;
    mem[REG.ZERO] = 0;
    this.channels[0o7] = this.outputChannel7 &= 0o160;
    mem[REG.Z] = this.substituteInstruction ? this.nextZ & 0o77777 : this.nextZ & 0o7777;
    if (!keepExtraCode) this.extraCode = false;
    // EB, FB and BB are views of the same bank bits.
    if (currentBB !== mem[REG.BB]) {
      mem[REG.FB] = mem[REG.BB] & 0o76000;
      mem[REG.EB] = (mem[REG.BB] & 0o7) << 8;
    } else if (currentEB !== mem[REG.EB] || currentFB !== mem[REG.FB]) {
      mem[REG.BB] = (mem[REG.FB] & 0o76000) | ((mem[REG.EB] & 0o3400) >> 8);
    }
    mem[REG.EB] &= 0o3400;
    mem[REG.FB] &= 0o76000;
    mem[REG.BB] &= 0o76007;
    mem[REG.L] = signExtend(overflowCorrected(mem[REG.L]));
    if (this.inIsr) this.noRupt = false;
    else this.ruptLock = false;
    if (executedTC || tcTransient) this.noTC = false;
    if (!executedTC) this.tcTrap = false;
    this.tookBZF = justTookBZF;
    this.tookBZMF = justTookBZMF;
  }

  /** DV: divide the double word in A,L by K; quotient to A, remainder to L. */
  private dv(acc: number, a10: number): void {
    const mem = this.mem;
    const a0 = overflowCorrected(acc);
    const l0 = mem[REG.L];
    let dividend = spToDecent(a0, l0 & 0o77777);
    // Normalised words of the dividend, as the hardware sees them.
    const nl = (0o37777 & dividend) | (dividend & 0o4000000000 ? 0o40000 : 0);
    const na = overflowCorrected(0o177777 & Math.floor((dividend & 0o7777777777) / 0o40000));
    const absA = absSP(na);
    const absL = absSP(nl);
    let div16: number;
    if (a10 === REG.A) {
      div16 = mem[REG.A];
      if ((mem[REG.A] & 0o100000) === 0) div16 = 0o177777 & ~div16;
    } else if (a10 === REG.L) {
      div16 = mem[REG.L];
      if ((absA === 0 && 0o100000 & mem[REG.L]) || (absA !== 0 && 0o100000 & mem[REG.A])) div16 = 0o177777 & ~div16;
      div16 = signExtend(overflowCorrected(addSP16(div16 & 0o177777, 0o40000)));
    } else if (a10 === REG.Z) {
      div16 = mem[REG.Z];
      if ((absA === 0 && 0o100000 & mem[REG.L]) || (absA !== 0 && 0o100000 & mem[REG.A])) div16 |= 0o100000;
    } else if (a10 < 3) {
      div16 = mem[a10];
    } else {
      div16 = signExtend(mem[this.memIndex(a10)]);
    }
    const absK = absSP(overflowCorrected(div16));
    if (absA > absK || (absA === absK && absL !== 0) || valueOverflowed(div16) !== 0) {
      this.simulateDV(div16);
    } else if (absA === 0 && absL === 0) {
      let q: number;
      if ((0o40000 & mem[REG.L]) === (0o40000 & overflowCorrected(div16))) q = absK === 0 ? 0o37777 : 0;
      else q = absK === 0 ? 0o40000 : 0o77777;
      mem[REG.A] = signExtend(q);
    } else if (absA === absK && absL === 0) {
      const q = na === overflowCorrected(div16) ? 0o37777 : 0o40000;
      mem[REG.L] = signExtend(na);
      mem[REG.A] = signExtend(q);
    } else {
      dividend = dividend & 0o2000000000 ? -(0o1777777777 & ~dividend) : dividend & 0o1777777777;
      const divisor = agcToInt(overflowCorrected(div16));
      const quotient = Math.trunc(dividend / divisor);
      const remainder = dividend % divisor;
      mem[REG.A] = signExtend(intToAgc(quotient));
      if (remainder === 0) mem[REG.L] = dividend >= 0 ? 0 : signExtend(0o77777);
      else mem[REG.L] = signExtend(intToAgc(remainder));
    }
  }

  /** The hardware divide algorithm, for the cases where the result is "undefined". */
  private simulateDV(divisor: number): void {
    const mem = this.mem;
    let a = mem[REG.A];
    let l = mem[REG.L];
    let dividendSign = a & 0o100000;
    if (!dividendSign) a = ~a & 0o177777;
    if (a === 0o177777) dividendSign = l & 0o100000;
    if (dividendSign) l = ~l & 0o177777;
    l = addSP16(l, 0o40000);
    if (valueOverflowed(l) !== 1) a = addSP16(a, 1);
    let remainder = a;
    const divisorSign = divisor & 0o100000;
    if (divisorSign) divisor = ~divisor & 0o177777;
    const quotientSign = l & 0o100000;
    let quotient = quotientSign | ((l & 0o37777) << 1) | (quotientSign >> 15);
    for (let i = 0; i < 14; i++) {
      quotient = (quotient << 1) & 0o177777;
      const remainderSign = remainder & 0o100000;
      remainder = remainderSign | ((remainder & 0o37777) << 1);
      if ((quotient & 0o100000) === 0) remainder |= remainderSign >> 15;
      const sum = addSP16(remainder, divisor);
      if (sum & 0o100000) {
        quotient |= 1;
        remainder = sum;
      }
    }
    a = quotientSign | (quotient & 0o77777);
    mem[REG.A] = (dividendSign !== divisorSign ? ~a : a) & 0o177777;
    mem[REG.L] = (dividendSign ? remainder : ~remainder) & 0o177777;
  }
}
