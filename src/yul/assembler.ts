// A TypeScript re-implementation of the parts of the YUL assembler needed to
// turn the original Apollo Guidance Computer (Block II) source code into a
// core-rope image.  It follows the behaviour of Ron Burkey's yaYUL (the
// assembler used by the Virtual AGC project) closely enough that the output
// matches the octal listings printed in 1969, word for word.
//
// Addresses are handled as YUL "pseudo-addresses":
//   0000-3777      erasable memory (E0-E7; E0-E2 are unswitched)
//   4000-7777      fixed-fixed memory (banks 2 and 3)
//   10000-117777   banked fixed memory, 10000 + bank*2000 + offset (banks 0-43)

import {
  ENUMBER,
  ERASABLE,
  EXTENDED,
  FIXED,
  INTERPRETIVE,
  KPLUS1,
  PARSERS,
  PC0,
  PC1,
  PC2,
  PC3,
  PC4,
  PC5,
  PC6,
  PC7,
  QC0,
  QC1,
  QC2,
  QC3,
  QCNOT0,
  type InterpDef,
  type OpDef,
} from './tables.ts';

export const NUM_BANKS = 0o44;
export const BANK_SIZE = 0o2000;

export interface SourceFile {
  name: string;
  text: string;
}

export interface AssemblyMessage {
  file: string;
  line: number; // 1-based
  message: string;
  fatal: boolean;
}

export interface SymbolInfo {
  name: string;
  value: number; // pseudo-address or constant
  constant: boolean;
  line: number; // global line id of the definition, or -1
}

export interface AssemblyResult {
  /** 36 banks x 1024 words, bank-major, 15-bit values. */
  rope: Uint16Array;
  /** Whether each rope word was produced by the source (vs. unused). */
  used: Uint8Array;
  /** Global line id that produced each rope word, or -1. */
  ropeLine: Int32Array;
  /** Per global line: the pseudo-address it assembled at, or -1. */
  lineAddress: Int32Array;
  /** Per global line: index into `lineWords` of its first word, and the word count. */
  lineWordStart: Int32Array;
  lineWordCount: Uint8Array;
  lineWords: Uint16Array;
  /** Files in include order, with the global line id of their first line. */
  files: { name: string; firstLine: number; lineCount: number }[];
  symbols: SymbolInfo[];
  messages: AssemblyMessage[];
  bankUsage: number[];
  passes: number;
}

// ---------------------------------------------------------------------------
// Addresses

interface Addr {
  v: number; // pseudo-address, or the value of a constant
  c: boolean; // true if this is a constant rather than an address
  ovf?: boolean; // incrementing ran off the end of a memory bank
}

type MaybeAddr = Addr | null; // null = invalid / not yet resolved

const addr = (v: number): Addr => ({ v, c: false });

function pseudoToStruct(v: number): MaybeAddr {
  if (v < 0 || v > 0o117777) return null;
  return addr(v);
}

function inRange(a: Addr): boolean {
  return a.v >= 0 && a.v <= 0o117777;
}
function isErasable(a: Addr): boolean {
  return inRange(a) && a.v <= 0o3777;
}
function isFixed(a: Addr): boolean {
  return inRange(a) && a.v >= 0o4000;
}
/** True for switched (banked) memory: erasable E3-E7 or fixed banks via 10000+. */
function isBanked(a: Addr): boolean {
  return (a.v >= 0o1400 && a.v <= 0o3777) || a.v >= 0o10000;
}
/** The 12-bit S-register (CPU-visible) form of an address. */
function sreg(a: Addr): number {
  const v = a.v;
  if (v < 0 || v > 0o117777) return 0;
  if (v <= 0o1377) return v;
  if (v <= 0o3777) return 0o1400 + (v & 0o377);
  if (v <= 0o7777) return v;
  return 0o2000 + (v & 0o1777);
}
/** The erasable bank number of an erasable address (0-7). */
function ebOf(a: Addr): number {
  return (a.v >> 8) & 7;
}
/** The fixed bank number (0-43) of a fixed address. */
function bankOf(a: Addr): number {
  if (a.v >= 0o10000) return (a.v - 0o10000) >> 10;
  return a.v >> 10; // 2 or 3 for fixed-fixed
}
/** The value YUL keeps in its "FB" field: 0 for unbanked, bank-010 for superbanks. */
function fbOf(a: Addr): number {
  if (a.v < 0o10000) return 0;
  const b = bankOf(a);
  return b >= 0o40 ? b - 0o10 : b;
}
function isSuper(a: Addr): boolean {
  return a.v >= 0o110000;
}

function incPc(a: MaybeAddr, n: number): MaybeAddr {
  if (!a) return null;
  if (a.c) {
    if (a.v < 0) return a;
    if (a.v < 0o1400) a = addr(a.v);
    else return a;
  }
  if (a.ovf) return a;
  const v = a.v;
  let min: number, max: number;
  if (v <= 0o1377) {
    min = 0;
    max = 0o1377;
  } else if (v <= 0o3777) {
    min = v & ~0o377;
    max = min + 0o377;
  } else if (v <= 0o7777) {
    min = 0o4000;
    max = 0o7777;
  } else {
    min = v & ~0o1777;
    max = min + 0o1777;
  }
  const nv = v + n;
  if (nv < min) return { v: min, c: false, ovf: true };
  if (nv > max) return { v: max, c: false, ovf: true };
  return addr(nv);
}

function sameAddr(a: MaybeAddr, b: MaybeAddr): boolean {
  if (!a || !b) return a === b;
  return a.v === b.v && a.c === b.c && !!a.ovf === !!b.ovf;
}

// ---------------------------------------------------------------------------
// Numbers

/** YUL number syntax: octal by default, decimal with a D suffix or digits 8/9. */
export function getOctOrDec(s: string): number | null {
  let p = 0;
  if (s[p] === '+' || s[p] === '-') p++;
  if (p >= s.length || s[p] === 'D') return null;
  if (/^[+-]?[0-7]+$/.test(s)) return parseInt(s, 8);
  const m = /^([+-]?)([0-9]+)(D?)$/.exec(s);
  if (m && (m[3] === 'D' || /[89]/.test(m[2]))) return parseInt(m[1] + m[2], 10);
  return null;
}

/** 15-bit ones'-complement addition with end-around carry, as YUL computes checksums. */
function agcToNative(n: number): number {
  return n & 0o40000 ? -(~n & 0o37777) : n;
}
function onesAdd(n1: number, n2: number): number {
  let sum = agcToNative(n1) + agcToNative(n2);
  if (sum > 16383) sum = sum - 16384 + 1;
  else if (sum < -16383) sum = sum + 16384 - 1;
  return sum >= 0 ? sum : 0o77777 & ~-sum;
}

function scaleFactor(s: string): number {
  if (!s) return 1;
  const n = parseInt(s.slice(1), 10) || 0;
  if (s[0] === 'E') return n >= 0 ? 10 ** n : 1 / 10 ** -n;
  if (s[0] === 'B') return 2 ** n;
  return 1;
}

function fuzzedIsInt(x: number): boolean {
  const f = Math.abs(x % 1);
  return f < 1e-10 || f > 1 - 1e-10;
}

// ---------------------------------------------------------------------------
// Source preparation

interface Line {
  id: number; // global line id
  file: number;
  lineNo: number; // 1-based
  include?: string;
  s: string; // tab-expanded text with the comment removed
  fields: string[];
  col0: number;
}

function expandTabs(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\t') out += ' '.repeat(((out.length + 8) & ~7) - out.length);
    else out += ch;
  }
  return out;
}

function prepareLine(raw: string, id: number, file: number, lineNo: number): Line {
  if (raw.endsWith('\r')) raw = raw.slice(0, -1);
  if (raw[0] === '$') {
    const name = raw.slice(1).trim().split(/\s+/)[0];
    return { id, file, lineNo, include: name, s: '', fields: [], col0: 0 };
  }
  let s = expandTabs(raw);
  const hash = s.indexOf('#');
  if (hash >= 0) s = s.slice(0, hash);
  const fields = s.split(/\s+/).filter((f) => f.length > 0).slice(0, 6);
  const col0 = fields.length ? s.indexOf(fields[0]) : 0;
  return { id, file, lineNo, s, fields, col0 };
}

// ---------------------------------------------------------------------------
// The assembler

interface EBankState {
  current: MaybeAddr;
  last: MaybeAddr;
  oneshot: boolean;
}
interface SBankState {
  current: number;
  last: number;
  oneshot: boolean;
}

interface Input {
  pc: MaybeAddr;
  label: string;
  falseLabel: string;
  operator: string;
  operand: string;
  mod1: string;
  mod2: string;
  extra: string;
  alias: string;
  extend: number;
  indexValid: boolean;
  ebank: EBankState;
  sbank: SBankState;
}

interface Output {
  pc: MaybeAddr;
  words: number[];
  fatal: string | null;
  warning: string | null;
  equals: boolean;
  extend: number;
  indexValid: boolean;
  ebank: EBankState;
  sbank: SBankState;
}

export interface AssembleOptions {
  /** Map of include names (as written after `$`) to actual file names. */
  includeAliases?: Record<string, string>;
  maxPasses?: number;
}

const PARSER_MAP = new Map<string, OpDef>(Object.entries(PARSERS));
const INTERP_MAP = new Map<string, InterpDef>(Object.entries(INTERPRETIVE));

export function assemble(
  mainName: string,
  readFile: (name: string) => string | undefined,
  options: AssembleOptions = {},
): AssemblyResult {
  // ---- Load all files in include order.
  const files: { name: string; firstLine: number; lineCount: number }[] = [];
  const lines: Line[] = [];
  const loadMessages: AssemblyMessage[] = [];
  const messages: AssemblyMessage[] = [];
  let nextId = 0;
  const loadFile = (name: string, fromFile?: number, fromLine?: number): void => {
    const actual = options.includeAliases?.[name] ?? name;
    const text = readFile(actual);
    if (text === undefined) {
      loadMessages.push({
        file: fromFile !== undefined ? files[fromFile].name : name,
        line: fromLine ?? 0,
        message: `Include file "${name}" not found.`,
        fatal: true,
      });
      return;
    }
    const raw = text.split('\n');
    if (raw.length && raw[raw.length - 1] === '') raw.pop();
    const fileIndex = files.length;
    files.push({ name: actual, firstLine: nextId, lineCount: raw.length });
    const firstId = nextId;
    nextId += raw.length;
    for (let i = 0; i < raw.length; i++) {
      const line = prepareLine(raw[i], firstId + i, fileIndex, i + 1);
      lines.push(line);
      if (line.include) loadFile(line.include, fileIndex, i + 1);
    }
  };
  loadFile(mainName);
  const totalLines = nextId;

  // ---- Symbol table.  All labels are known up front; values get resolved over several passes.
  const symbols = new Map<string, MaybeAddr>();
  const symbolLine = new Map<string, number>();
  for (const line of lines) {
    if (line.include || !line.fields.length) continue;
    if (line.s.length && !/\s/.test(line.s[0])) {
      const op = line.fields[1] ?? '';
      if (op !== 'MEMORY' && op !== 'CHECK=') symbols.set(line.fields[0], null);
    }
  }
  // Pseudo-symbols used by instruction aliases (RELINT = TC $3, and so on).
  for (const r of [3, 4, 5, 6, 7, 0o17]) symbols.set('$' + r.toString(8), addr(r));

  // ---- Output buffers.
  const rope = new Uint16Array(NUM_BANKS * BANK_SIZE);
  const used = new Uint8Array(NUM_BANKS * BANK_SIZE);
  const ropeLine = new Int32Array(NUM_BANKS * BANK_SIZE).fill(-1);
  const lineAddress = new Int32Array(totalLines).fill(-1);
  const lineWordStart = new Int32Array(totalLines).fill(-1);
  const lineWordCount = new Uint8Array(totalLines);
  const lineWordsList: number[] = [];

  let usedInBank = new Array<number>(NUM_BANKS).fill(0);
  let priorUsedInBank = usedInBank;

  // ---- Per-pass state.
  let numInterp = 0;
  let rawNumInterp = 0;
  const nnnnFields = [0, 0, 0, 0];
  const switchIncrement = [0, 0, 0, 0];
  let opcodeOffset = 0;
  let argType = 0;
  let reassigned = 0;
  let lastPass = false;
  let currentLine: Line = lines[0];

  const editSymbol = (name: string, value: MaybeAddr): void => {
    if (!symbols.has(name)) return;
    if (!sameAddr(symbols.get(name) ?? null, value)) reassigned++;
    symbols.set(name, value);
    symbolLine.set(name, currentLine.id);
  };

  const fetchSymbolPlusOffset = (pc: MaybeAddr, operand: string, mod: string): { ok: boolean; a: MaybeAddr } => {
    if (operand === '') return { ok: true, a: pc };
    const n = getOctOrDec(operand);
    if (n !== null) return { ok: true, a: incPc(pc, n) };
    if (!symbols.has(operand)) return { ok: false, a: null };
    const sym = symbols.get(operand) ?? null;
    if (!sym) return { ok: true, a: null };
    const off = getOctOrDec(mod);
    if (off !== null) return { ok: true, a: pseudoToStruct(sym.v + off) };
    return { ok: true, a: sym };
  };

  const updateBankCounts = (pc: MaybeAddr): void => {
    if (!pc || pc.c || pc.ovf || !isFixed(pc)) return;
    let count: number;
    let bank: number;
    if (pc.v >= 0o10000) {
      count = pc.v & 0o1777;
      bank = bankOf(pc);
    } else if (pc.v < 0o6000) {
      count = pc.v - 0o4000;
      bank = 2;
    } else {
      count = pc.v - 0o6000;
      bank = 3;
    }
    if (count > usedInBank[bank]) usedInBank[bank] = count;
  };

  const parseComma = (inp: Input): number => {
    const strip = (s: string): [string, number] => {
      if (s.length < 3) return [s, 0];
      if (s.endsWith(',1')) return [s.slice(0, -2), 1];
      if (s.endsWith(',2')) return [s.slice(0, -2), 2];
      return [s, 0];
    };
    if (inp.mod1) {
      const [s, t] = strip(inp.mod1);
      inp.mod1 = s;
      return t;
    }
    if (inp.operand) {
      const [s, t] = strip(inp.operand);
      inp.operand = s;
      return t;
    }
    return 0;
  };

  // ---- Machine instructions (yaYUL's ParseGeneral).
  const parseGeneral = (inp: Input, out: Output, opcode: number, flags: number): void => {
    const args = inp.mod1 + inp.mod2;
    out.words = [0];
    if (flags & PC1) opcode |= 0o1000;
    else if (flags & PC2) opcode |= 0o2000;
    else if (flags & PC3) opcode |= 0o3000;
    else if (flags & PC4) opcode |= 0o4000;
    else if (flags & PC5) opcode |= 0o5000;
    else if (flags & PC6) opcode |= 0o6000;
    else if (flags & PC7) opcode |= 0o7000;
    else if (flags & QC1) opcode |= 0o2000;
    else if (flags & QC2) opcode |= 0o4000;
    else if (flags & QC3) opcode |= 0o6000;
    out.words[0] = opcode;
    if (flags & QCNOT0) out.words[0] |= 0o6000;
    if (inp.extend && !(flags & EXTENDED) && !inp.indexValid) {
      if (inp.extend !== 2) out.fatal = 'Illegally preceded by EXTEND.';
    } else if (!inp.extend && flags & EXTENDED) {
      out.fatal = 'Required EXTEND is missing.';
    }

    let k: MaybeAddr = null;
    let found = true;
    const value = getOctOrDec(inp.operand);
    if (value !== null && flags & ENUMBER && inp.operand[0] !== '+' && inp.operand[0] !== '-') {
      k = pseudoToStruct(value);
      const off = getOctOrDec(args);
      if (off !== null) opcodeOffset = off;
    } else if (value !== null) {
      if (inp.operand[0] === '+' || inp.operand[0] === '-') k = incPc(inp.pc, value);
      else k = pseudoToStruct(value);
      if (args) {
        const off = getOctOrDec(args);
        if (off !== null) opcodeOffset = off;
      }
    } else {
      const r = fetchSymbolPlusOffset(inp.pc, inp.operand, args);
      found = r.ok;
      k = r.a;
    }

    if (!found) {
      out.fatal = `Symbol "${inp.operand}" undefined or offset bad`;
    } else if (!k) {
      out.fatal = 'Destination address not resolved.';
    } else if (k.ovf) {
      out.fatal = 'Destination address out of range.';
    } else {
      if (k.c) k = pseudoToStruct(k.v);
      if (k && flags & KPLUS1) k = incPc(k, 1);
      let i = k ? sreg(k) : 0;
      if (k && !inp.indexValid) {
        if (flags & FIXED && !isFixed(k)) {
          i &= ~0o7000;
          out.fatal = 'The address is not in fixed memory.';
        } else if (flags & ERASABLE && !isErasable(k)) {
          i &= ~0o7600;
          out.fatal = 'The address is not in erasable memory.';
        }
        if (flags & (PC0 | PC1 | PC2 | PC3 | PC4 | PC5 | PC6 | PC7)) {
          if ((i & 0o7000) !== 0 && (i & 0o7000) !== (opcode & 0o7000)) {
            i &= ~0o7000;
            out.fatal = 'Operand out of range.';
          }
        } else if (flags & (QC0 | QC1 | QC2 | QC3)) {
          if ((i & 0o6000) !== 0 && (i & 0o6000) !== (opcode & 0o6000)) {
            i &= ~0o6000;
            out.fatal = `Operand (0${i.toString(8)}) out of range.`;
          }
        } else if (flags & QCNOT0) {
          if ((sreg(k) & 0o6000) === 0) {
            i |= 0o6000;
            out.fatal = 'Operand out of range.';
          }
        }
      }
      out.words[0] = opcode | i;
    }

    // Track EXTEND: a `TC 6` (EXTEND) makes the next instruction an extracode.
    if (opcode === 0 && !(flags & EXTENDED) && k && (k.c || (isErasable(k) && !isBanked(k))) && sreg(k) === 6) {
      out.extend = inp.alias === '' ? 2 : 1;
    } else {
      out.extend = 0;
    }
    out.indexValid = false;
  };

  const parseIndex = (inp: Input, out: Output): void => {
    out.extend = inp.extend;
    out.indexValid = true;
    let k: MaybeAddr;
    let found = true;
    const value = getOctOrDec(inp.operand);
    if (value !== null) {
      k = inp.operand[0] === '+' || inp.operand[0] === '-' ? incPc(inp.pc, value) : pseudoToStruct(value);
      if (inp.mod1) {
        const off = getOctOrDec(inp.mod1);
        if (off !== null) opcodeOffset = off;
      }
    } else {
      const r = fetchSymbolPlusOffset(inp.pc, inp.operand, inp.mod1);
      found = r.ok;
      k = r.a;
    }
    if (!found) {
      out.fatal = `Symbol "${inp.operand}" undefined or offset bad`;
      out.words = [0o50000];
    } else if (!k) {
      out.fatal = 'Index is not an address.';
      out.words = [0o50000];
    } else if (k.c) {
      out.words = [0o50000 + k.v];
    } else {
      let s = sreg(k);
      if ((inp.extend && s > 0o7777) || (!inp.extend && s > 0o1777)) {
        out.fatal = 'Index is out of range.';
        s = 0;
      }
      out.words = [0o50000 + s];
    }
    if (out.words[0] === 0o50017) out.indexValid = false;
  };

  // ---- Interpretive operands (yaYUL's ParseInterpretiveOperand).
  const parseInterpretiveOperand = (inp: Input, out: Output): void => {
    argType = parseComma(inp);
    out.words = [0];
    let k: MaybeAddr;
    let found = true;
    const value = getOctOrDec(inp.operand);
    if (value !== null) {
      if (inp.operand[0] === '+' || inp.operand[0] === '-') k = incPc(inp.pc, value);
      else k = { v: value, c: true };
    } else {
      const r = fetchSymbolPlusOffset(inp.pc, inp.operand, '');
      found = r.ok;
      k = r.a;
    }
    if (!found || !k) {
      out.fatal = `Interpretive operand "${inp.operand}" not resolved.`;
      return;
    }
    let kmod = 0;
    if (inp.mod1) {
      const m = getOctOrDec(inp.mod1 + inp.mod2);
      if (m === null) {
        out.fatal = `Bad interpretive operand modifier "${inp.mod1}".`;
        return;
      }
      kmod = m;
    }
    opcodeOffset = kmod;
    const idx = rawNumInterp - numInterp;
    let word = 0;
    for (;;) {
      if (k.c) {
        const n = nnnnFields[idx];
        if ((n & 3) === 1) {
          word = ((Math.trunc(k.v / 15) & 0o77) << 8) | k.v % 15 | (0o360 & n);
        } else if ((n & 3) === 2) {
          word = k.v | (n & ~3);
        } else {
          let i = k.v + opcodeOffset;
          if (i < 0) i--;
          i &= 0o77777;
          opcodeOffset = 0;
          if (i & 0o40000) {
            word = i;
          } else {
            const kk = pseudoToStruct(i);
            if (!kk) {
              out.fatal = 'Incorrect operand type.';
              break;
            }
            k = kk;
            continue;
          }
        }
      } else if (isErasable(k)) {
        word = k.v;
      } else if (isFixed(k)) {
        word = k.v < 0o10000 ? k.v : 0o2000 * fbOf(k) + (k.v & 0o1777);
      } else {
        out.fatal = 'Incorrect operand type.';
      }
      break;
    }
    word += opcodeOffset;
    if (switchIncrement[idx]) {
      word = (word + 1) & 0o37777;
      if (argType === 2) word = 0o77777 & ~word;
    }
    out.words = [word];
  };

  // ---- STORE, STODL, STOVL, STCALL.
  const parseST = (inp: Input, out: Output, opcode: number): void => {
    opcode += 0o4000 * argType;
    out.words = [opcode];
    let k: MaybeAddr;
    let found = true;
    const value = getOctOrDec(inp.operand);
    if (value !== null && inp.operand[0] !== '+' && inp.operand[0] !== '-') {
      k = pseudoToStruct(value);
      const off = getOctOrDec(inp.mod1);
      if (off !== null) opcodeOffset = off;
    } else if (value !== null && !inp.mod1) {
      k = incPc(inp.pc, value);
    } else {
      const r = fetchSymbolPlusOffset(inp.pc, inp.operand, inp.mod1);
      found = r.ok;
      k = r.a;
      if (k && k.c) k = pseudoToStruct(k.v);
    }
    if (!found) {
      out.fatal = `Symbol "${inp.operand}" undefined or offset bad`;
    } else if (!k) {
      out.fatal = 'Destination address not resolved.';
    } else if (k.ovf) {
      out.fatal = 'Destination address out of range.';
    } else {
      if (k.c) k = pseudoToStruct(k.v);
      if (k) k = incPc(k, 1);
      if (!k || !isErasable(k)) {
        out.fatal = 'The Address is not in erasable memory.';
        out.words = [opcode];
      } else {
        out.words = [opcode | k.v];
      }
    }
    out.extend = 0;
    out.indexValid = false;
  };

  const parseDec = (inp: Input, out: Output, double: boolean): void => {
    out.words = double ? [0, 0] : [0];
    const operand = inp.operand;
    if (!operand) {
      out.fatal = 'Operand is missing.';
      return;
    }
    let tmpval: number;
    let m1: string;
    let m2: string;
    if (operand[0] === 'E' || operand[0] === 'B') {
      tmpval = 1.0;
      m1 = operand;
      m2 = inp.mod1;
    } else if (!double) {
      tmpval = parseFloat(operand);
      m1 = inp.mod1;
      m2 = inp.mod2;
    } else {
      const e = operand.indexOf('E');
      const b = operand.indexOf('B');
      if (e >= 0 || b >= 0) {
        const cut = Math.min(e >= 0 ? e : Infinity, b >= 0 ? b : Infinity);
        if (e >= 0 && b >= 0) {
          m1 = operand.slice(e, e < b ? b : undefined);
          m2 = operand.slice(b, b < e ? e : undefined);
        } else {
          m1 = operand.slice(cut);
          m2 = '';
        }
        tmpval = parseFloat(operand.slice(0, cut));
      } else {
        if (inp.extra) {
          if (inp.mod1 === 'E' || inp.mod1 === 'B') {
            m1 = inp.mod1 + inp.mod2;
            m2 = inp.extra;
          } else {
            m1 = inp.mod1;
            m2 = inp.mod2 + inp.extra;
          }
        } else if (inp.mod1 === 'E' || inp.mod1 === 'B') {
          m1 = inp.mod1 + inp.mod2;
          m2 = '';
        } else {
          m1 = inp.mod1;
          m2 = inp.mod2;
        }
        tmpval = parseFloat(operand);
      }
    }
    if (Number.isNaN(tmpval)) tmpval = 0;
    let x = tmpval * scaleFactor(m1) * scaleFactor(m2);
    const sign = operand[0] === '-';
    if (sign) x = -x;
    const bits = double ? 28 : 14;
    let value: number;
    if (fuzzedIsInt(x)) {
      value = Math.trunc(x);
    } else {
      if (x >= 1.0) {
        out.fatal = 'Value out of range.';
        return;
      }
      value = 0;
      for (let i = 0; i < bits; i++) {
        value = value * 2;
        if (x >= 0.5) {
          value++;
          x -= 0.5;
        }
        x *= 2;
      }
      if (x >= 0.5 && value < (double ? 0x0fffffff : 0x3fff)) value++;
    }
    if (double) {
      let lo = value & 0x3fff;
      let hi = Math.floor(value / 0x4000) & 0x3fff;
      if (sign) {
        hi = ~hi & 0x7fff;
        lo = ~lo & 0x7fff;
      }
      out.words = [hi, lo];
    } else {
      out.words = [sign ? 0x7fff & ~value : value & 0x7fff];
    }
  };

  const parseOct = (inp: Input, out: Output, double: boolean): void => {
    out.words = double ? [0, 0] : [0];
    const operand = inp.operand;
    if (!/^[+-]?[0-7]+$/.test(operand)) {
      out.fatal = 'Not an octal number.';
      return;
    }
    const minus = operand[0] === '-';
    const digits = operand.replace(/^[+-]/, '');
    if (!double) {
      let v = parseInt(digits, 8);
      if (v & ~0o77777) {
        v &= 0o77777;
        out.warning = 'Value out of range.';
      }
      out.words = [minus ? ~v & 0o77777 : v];
    } else {
      const v1 = parseInt(digits, 8);
      let value: number;
      if (/^[0-7]+$/.test(inp.mod1)) value = (v1 & 0o77777) * 0o100000 + (parseInt(inp.mod1, 8) & 0o77777);
      else value = v1 % 0o10000000000;
      let hi = Math.floor(value / 0o100000) & 0o77777;
      let lo = value & 0o77777;
      if (minus) {
        hi = ~hi & 0o77777;
        lo = ~lo & 0o77777;
      }
      out.words = [hi, lo];
    }
  };

  const ebankEB = (inp: Input): number => {
    const cur = inp.ebank.current;
    if (!cur) return 0;
    return ebOf(cur);
  };

  // Common bank/superbank bits for BBCON and 2CADR.
  const sbankBits = (inp: Input, a: Addr): number => {
    const fb = fbOf(a);
    if (fb >= 0o30 && fb <= 0o37) return (isSuper(a) ? 4 : 3) << 4;
    return inp.sbank.current << 4;
  };

  const runParser = (def: OpDef, inp: Input, out: Output): void => {
    switch (def.kind) {
      case 'general':
        out.pc = incPc(inp.pc, 1);
        if (inp.operator === 'TCF' && !inp.operand) inp.operand = '+0';
        parseGeneral(inp, out, def.opcode!, def.flags!);
        return;
      case 'index':
        out.pc = incPc(inp.pc, 1);
        parseIndex(inp, out);
        return;
      case 'edrupt':
        out.pc = incPc(inp.pc, 1);
        parseGeneral(inp, out, 0, EXTENDED | PC7);
        return;
      case 'equals':
        parseEquals(inp, out);
        return;
      case 'eqMinus': {
        out.pc = inp.pc;
        out.equals = true;
        if (!inp.label) return;
        if (!inp.operand) {
          out.fatal = 'Missing operand.';
          return;
        }
        const r = fetchSymbolPlusOffset(inp.pc, inp.operand, inp.mod1);
        if (!r.ok || !r.a || !inp.pc) {
          out.fatal = `Symbol "${inp.operand}" undefined or offset bad`;
          editSymbol(inp.label, null);
          return;
        }
        editSymbol(inp.label, { v: sreg(r.a) - sreg(inp.pc), c: true });
        return;
      }
      case 'eqECADR':
        out.pc = inp.pc;
        return;
      case 'checkEquals':
        out.pc = inp.pc;
        return;
      case 'bank':
        parseBank(inp, out);
        return;
      case 'block': {
        const value = getOctOrDec(inp.operand);
        if (value === 0 || value === 2 || value === 3) {
          const usedCount = usedInBank[value] + value * 0o2000;
          out.pc = addr(usedCount);
          if (value === 0) out.ebank.current = out.pc;
        } else {
          out.fatal = 'BLOCK operand must be 0, 2, or 3.';
          out.pc = null;
        }
        inp.pc = out.pc;
        return;
      }
      case 'setloc': {
        out.pc = inp.pc;
        out.extend = inp.extend;
        const value = getOctOrDec(inp.operand);
        if (value !== null) {
          out.pc = inp.operand[0] === '+' || inp.operand[0] === '-' ? incPc(out.pc, value) : pseudoToStruct(value);
        } else if (symbols.has(inp.operand)) {
          out.pc = symbols.get(inp.operand) ?? null;
        } else {
          out.fatal = `Symbol "${inp.operand}" undefined or offset bad`;
          out.pc = null;
        }
        const off = getOctOrDec(inp.mod1);
        if (off !== null) out.pc = incPc(out.pc, off);
        inp.pc = out.pc;
        if (out.pc && isErasable(out.pc)) {
          out.ebank.current = out.pc;
          out.ebank.last = out.pc;
          out.ebank.oneshot = false;
        }
        return;
      }
      case 'erase': {
        out.pc = incPc(inp.pc, 1);
        const value = getOctOrDec(inp.operand);
        if (value !== null) {
          if (value < 0) {
            out.warning = 'Address increment is negative.';
          } else if (inp.mod1 === '-') {
            parseEquals(inp, out);
          } else {
            out.pc = incPc(inp.pc, 1 + value);
          }
        } else if (inp.operand) {
          out.fatal = 'Illegal number.';
        }
        return;
      }
      case 'oct':
        out.pc = incPc(inp.pc, 1);
        parseOct(inp, out, false);
        return;
      case '2oct':
        out.pc = incPc(inp.pc, 2);
        parseOct(inp, out, true);
        return;
      case 'dec':
        out.pc = incPc(inp.pc, 1);
        parseDec(inp, out, false);
        return;
      case '2dec':
        out.pc = incPc(inp.pc, 2);
        parseDec(inp, out, true);
        return;
      case 'vn': {
        out.pc = incPc(inp.pc, 1);
        if (!/^[0-9]+$/.test(inp.operand)) {
          out.fatal = 'Operand is not a decimal number.';
          out.words = [0];
          return;
        }
        const v = parseInt(inp.operand, 10);
        out.words = [(v % 100) | (Math.floor(v / 100) << 7)];
        return;
      }
      case 'genadr': {
        out.pc = incPc(inp.pc, 1);
        out.words = [0];
        let a: MaybeAddr;
        const value = getOctOrDec(inp.operand);
        if (value !== null && !inp.mod1) {
          a = incPc(inp.pc, value);
        } else {
          const r = fetchSymbolPlusOffset(inp.pc, inp.operand, inp.mod1);
          if (!r.ok) {
            out.fatal = `Symbol "${inp.operand}" undefined or offset bad`;
            return;
          }
          a = r.a;
        }
        if (!a) {
          out.fatal = 'Destination address not resolved.';
          return;
        }
        if (a.c) a = pseudoToStruct(a.v);
        if (!a) {
          out.fatal = 'Destination is not a memory address.';
          return;
        }
        out.words = [sreg(a)];
        return;
      }
      case 'cadr': {
        out.pc = incPc(inp.pc, 1);
        out.words = [0];
        let a: MaybeAddr;
        const value = getOctOrDec(inp.operand);
        if (value !== null && !inp.mod1) {
          a = pseudoToStruct(value);
        } else {
          const r = fetchSymbolPlusOffset(inp.pc, inp.operand, inp.mod1 + inp.mod2);
          if (!r.ok) {
            out.fatal = `Symbol "${inp.operand}" undefined or offset bad`;
            return;
          }
          a = r.a;
        }
        if (!a || !inRange(a)) {
          out.fatal = 'Destination address not resolved.';
          return;
        }
        if (!isFixed(a) || a.v < 0o10000) {
          out.fatal = 'Destination not in an F-bank.';
          return;
        }
        let v = a.v;
        if (isSuper(a)) v -= 0o10 * 0o2000;
        out.words = [v - 0o10000];
        return;
      }
      case 'ecadr': {
        out.pc = incPc(inp.pc, 1);
        out.words = [0];
        let a: MaybeAddr;
        const value = getOctOrDec(inp.operand);
        if (value !== null && !inp.mod1) {
          a = incPc(inp.pc, value);
        } else {
          const r = fetchSymbolPlusOffset(inp.pc, inp.operand, inp.mod1);
          if (!r.ok) {
            out.fatal = `Symbol "${inp.operand}" undefined or offset bad`;
            return;
          }
          a = r.a;
        }
        if (!a) {
          out.fatal = 'Destination address not resolved.';
          return;
        }
        if (!inRange(a) || !isErasable(a)) {
          out.fatal = 'Destination not in erasable memory.';
          return;
        }
        out.words = [a.v];
        return;
      }
      case '2cadr': {
        out.pc = incPc(inp.pc, 2);
        out.words = [0, 0];
        const r = fetchSymbolPlusOffset(inp.pc, inp.operand, inp.mod1);
        if (!r.ok) {
          out.fatal = `Symbol "${inp.operand}" undefined or offset bad`;
          return;
        }
        let a = r.a;
        if (!a) {
          out.fatal = 'Destination address not resolved.';
          return;
        }
        if (a.c) a = pseudoToStruct(a.v);
        if (!a) {
          out.fatal = 'Destination is not a memory address.';
          return;
        }
        const s = sreg(a);
        let w1 = ebankEB(inp);
        if (s >= 0o2000) w1 |= (s < 0o4000 ? fbOf(a) : s >> 10) << 10;
        w1 |= sbankBits(inp, a);
        out.words = [s, w1];
        return;
      }
      case '2fcadr': {
        out.pc = incPc(inp.pc, 2);
        out.words = [0, 0];
        const r = fetchSymbolPlusOffset(inp.pc, inp.operand, inp.mod1);
        let a = r.a;
        if (!r.ok || !a) {
          out.fatal = 'Destination address not resolved.';
          return;
        }
        if (a.c) a = pseudoToStruct(a.v);
        if (!a || !isFixed(a)) {
          out.fatal = 'Destination not in fixed memory.';
          return;
        }
        const s = sreg(a);
        out.words = s < 0o4000 ? [(fbOf(a) << 10) | (s - 0o2000), s] : [s, s];
        return;
      }
      case 'bbcon':
      case 'bbconStar': {
        out.pc = incPc(inp.pc, 1);
        out.words = [0];
        let a: MaybeAddr;
        const value = getOctOrDec(inp.operand);
        if (def.kind === 'bbconStar') {
          // BBCON* refers to the last fixed bank that contains anything.
          let bank = NUM_BANKS - 1;
          while (bank > 0 && priorUsedInBank[bank] === 0) bank--;
          a = addr(0o10000 + bank * 0o2000 + priorUsedInBank[bank]);
        } else if (value !== null && !inp.mod1) {
          a = incPc(inp.pc, value);
        } else {
          const r = fetchSymbolPlusOffset(inp.pc, inp.operand, inp.mod1);
          if (!r.ok) {
            out.fatal = `Symbol "${inp.operand}" undefined or offset bad`;
            return;
          }
          a = r.a;
        }
        if (!a) {
          out.fatal = 'Destination address not resolved.';
          return;
        }
        if (a.c) a = pseudoToStruct(a.v);
        if (!a || !isFixed(a)) {
          out.fatal = 'Destination is not in fixed memory.';
          return;
        }
        const bank = a.v >= 0o10000 ? fbOf(a) : sreg(a) >> 10;
        out.words = [(bank << 10) | ebankEB(inp) | sbankBits(inp, a)];
        return;
      }
      case 'ebankEquals': {
        out.pc = inp.pc;
        out.extend = inp.extend;
        out.indexValid = inp.indexValid;
        let a: MaybeAddr;
        const value = getOctOrDec(inp.operand);
        if (value !== null) {
          if (value < 0o10 || value > 0o3777) {
            out.fatal = 'EBank address value out of range.';
            return;
          }
          a = pseudoToStruct(value);
        } else {
          const r = fetchSymbolPlusOffset(inp.pc, inp.operand, '');
          if (!r.ok) {
            out.fatal = `Symbol "${inp.operand}" undefined or offset bad`;
            return;
          }
          a = incPc(r.a, opcodeOffset);
        }
        if (!a) {
          out.fatal = 'Destination address not resolved.';
          return;
        }
        if (!isErasable(a)) {
          out.fatal = 'Destination not erasable.';
          return;
        }
        out.ebank.last = out.ebank.current;
        out.ebank.current = a;
        out.ebank.oneshot = true;
        return;
      }
      case 'sbankEquals': {
        out.pc = inp.pc;
        if (!inp.operand) return;
        let a: MaybeAddr;
        const value = getOctOrDec(inp.operand);
        if (value !== null) {
          a = pseudoToStruct(value);
        } else {
          const r = fetchSymbolPlusOffset(inp.pc, inp.operand, '');
          if (!r.ok) {
            out.fatal = 'Symbol undefined or offset bad';
            return;
          }
          a = incPc(r.a, opcodeOffset);
        }
        if (!a) {
          out.fatal = 'Destination address not resolved.';
          return;
        }
        if (!isFixed(a) || a.v < 0o10000) {
          out.fatal = 'Destination address out of range.';
          return;
        }
        const fb = fbOf(a);
        if (fb >= 0o30 && fb <= 0o37) {
          out.sbank.last = out.sbank.current;
          out.sbank.current = isSuper(a) ? 4 : 3;
        } else {
          out.sbank.current = 0;
          out.fatal = 'Destination address not in superbank.';
          return;
        }
        out.sbank.oneshot = true;
        return;
      }
      case 'stcall':
      case 'stodl':
      case 'stovl':
      case 'store': {
        argType = parseComma(inp);
        out.pc = incPc(inp.pc, 1);
        if (def.kind === 'store') {
          numInterp = 0;
          parseST(inp, out, 0);
          return;
        }
        switchIncrement[0] = def.kind === 'stcall' ? 0 : 1;
        nnnnFields[0] = 0;
        rawNumInterp = numInterp = 1;
        parseST(inp, out, def.kind === 'stcall' ? 0o34000 : def.kind === 'stodl' ? 0o14000 : 0o24000);
        return;
      }
      case 'secsiz':
        out.pc = inp.pc;
        return;
      default:
        out.pc = inp.pc;
    }
  };

  const parseEquals = (inp: Input, out: Output): void => {
    out.pc = inp.pc;
    out.equals = true;
    out.words = [];
    if (!inp.label) return;
    if (!inp.operand && !inp.mod1) {
      editSymbol(inp.label, inp.pc);
      return;
    }
    const value = getOctOrDec(inp.operand);
    if (value === null) {
      let r: { ok: boolean; a: MaybeAddr };
      if (inp.mod1 === '+' || inp.mod1 === '-') {
        if (!inp.mod2) {
          out.fatal = 'Syntax error, invalid offset specified';
          return;
        }
        r = fetchSymbolPlusOffset(inp.pc, inp.operand, inp.mod1 + inp.mod2);
      } else {
        r = fetchSymbolPlusOffset(inp.pc, inp.operand, inp.mod1);
      }
      if (!r.ok) {
        out.fatal = `Symbol "${inp.operand}" undefined or offset bad`;
        return;
      }
      editSymbol(inp.label, r.a);
    } else if (inp.operand[0] === '+' || inp.operand[0] === '-') {
      editSymbol(inp.label, incPc(inp.pc, value));
    } else {
      let v = value;
      if (v < -16383 || v > 32767) {
        out.warning = 'Value out of range---truncating';
        v = Math.max(-16383, Math.min(32767, v));
      }
      let label: Addr = { v, c: true };
      if (pseudoToStruct(v)) {
        const constant = !(inp.operator === 'ERASE' || (v >= 0o2000 && inp.operator === 'EQUALS'));
        label = { v, c: constant };
      }
      editSymbol(inp.label, label);
    }
  };

  const parseBank = (inp: Input, out: Output): void => {
    out.extend = inp.extend;
    if (!inp.operand) {
      out.pc = inp.pc;
      const pc = out.pc;
      if (!pc) return;
      if (!isFixed(pc)) {
        out.fatal = 'Works only for fixed-memory.';
        return;
      }
      if (pc.v >= 0o10000) {
        const b = bankOf(pc);
        out.pc = addr(0o10000 + b * 0o2000 + usedInBank[b]);
      } else if (pc.v <= 0o5777) {
        out.pc = addr(0o4000 + usedInBank[2]);
      } else {
        out.pc = addr(0o6000 + usedInBank[3]);
      }
      return;
    }
    const value = getOctOrDec(inp.operand);
    if (value !== null && value >= 0 && value <= 0o43) {
      out.pc = addr((value === 2 || value === 3 ? value * 0o2000 : 0o10000 + value * 0o2000) + usedInBank[value]);
    } else {
      out.fatal = 'BANK operand range is 00 to 43.';
      out.pc = null;
    }
    inp.pc = out.pc;
  };

  // ---- One pass over the whole program.
  let state = {
    pc: null as MaybeAddr,
    ebank: { current: null, last: null, oneshot: false } as EBankState,
    sbank: { current: 0, last: 0, oneshot: false } as SBankState,
    extend: 0,
    indexValid: false,
  };

  const runPass = (): void => {
    reassigned = 0;
    numInterp = 0;
    rawNumInterp = 0;
    priorUsedInBank = usedInBank;
    usedInBank = new Array<number>(NUM_BANKS).fill(0);
    let stadrInvert = 0;
    state = {
      pc: null,
      ebank: { current: null, last: null, oneshot: false },
      sbank: { current: 0, last: 0, oneshot: false },
      extend: 0,
      indexValid: false,
    };
    if (lastPass) {
      rope.fill(0);
      used.fill(0);
      ropeLine.fill(-1);
      lineAddress.fill(-1);
      lineWordStart.fill(-1);
      lineWordCount.fill(0);
      lineWordsList.length = 0;
      messages.length = 0;
      messages.push(...loadMessages);
    }

    for (const line of lines) {
      currentLine = line;
      if (line.include) continue;
      opcodeOffset = 0;
      argType = 0;
      let pinchHitting = false;
      const inp: Input = {
        pc: state.pc,
        label: '',
        falseLabel: '',
        operator: '',
        operand: '',
        mod1: '',
        mod2: '',
        extra: '',
        alias: '',
        extend: state.extend,
        indexValid: state.indexValid,
        ebank: { ...state.ebank },
        sbank: { ...state.sbank },
      };
      const out: Output = {
        pc: null,
        words: [],
        fatal: null,
        warning: null,
        equals: false,
        extend: 0,
        indexValid: false,
        ebank: { ...state.ebank },
        sbank: { ...state.sbank },
      };

      // Split the line into fields.
      const f = line.fields;
      const nf = f.length;
      if (nf >= 1) {
        let i = 0;
        let notOffset = false;
        if (line.col0 === 0) {
          inp.label = f[i++];
        } else if (isFalseLabel(f[0]) && line.col0 < 16) {
          // A "+n"/"-n" location note in the label area.  YUL put these in
          // columns 1-8; some lines of the upstream transcription have drifted
          // one tab stop to the right, so accept them anywhere before the
          // opcode column.
          if (nf === 1) notOffset = true;
          else inp.falseLabel = f[i++];
        } else if (line.col0 < 8) {
          i++;
        }
        if (!notOffset) {
          const fi = f[i] ?? '';
          const noOperator = !(line.s.length >= 16 && line.s.startsWith(fi, 16));
          const iMatch = noOperator ? undefined : INTERP_MAP.get(fi);
          let match: OpDef | undefined = PARSER_MAP.get(fi);
          if (numInterp && !iMatch && !match) {
            inp.operator = '';
          } else if (match && numInterp && i + 1 >= nf) {
            match = undefined;
            inp.operator = '';
          } else if (match && match.pinchHit && numInterp) {
            numInterp--;
            pinchHitting = true;
            if (i < nf) inp.operator = f[i++];
          } else {
            numInterp = 0;
            if (i < nf) inp.operator = f[i++];
          }
        }
        if (i < nf) inp.operand = f[i++];
        if (i < nf) inp.mod1 = f[i++];
        if (i < nf) inp.mod2 = f[i++];
        if (i < nf) inp.extra = f[i];
      }
      if (!inp.operand && inp.operator === 'TC') inp.operand = '-0';

      if (!inp.operator && !numInterp) {
        out.pc = inp.pc;
        out.extend = inp.extend;
        out.indexValid = inp.indexValid;
      } else {
        if (inp.operator === 'NOOP' && !numInterp) {
          if (inp.pc && isErasable(inp.pc)) {
            inp.operator = 'CA';
            inp.operand = 'A';
          } else {
            inp.operator = 'TCF';
            inp.operand = '+1';
          }
          inp.alias = 'NOOP';
        }
        aliasRetry: for (;;) {
          const iMatch: InterpDef | undefined = INTERP_MAP.get(inp.operator);
          if (iMatch) {
            if (inp.operator === 'STADR' || inp.operand === 'STADR') stadrInvert = 2;
            let iMatch2: InterpDef | undefined;
            if (inp.operand) {
              iMatch2 = INTERP_MAP.get(inp.operand);
              if (!iMatch2) out.fatal = `Unrecognized interpretive opcode "${inp.operand}".`;
            }
            numInterp = 0;
            for (const m of iMatch2 ? [iMatch, iMatch2] : [iMatch]) {
              if (m.numOperands) {
                switchIncrement[numInterp] = m.argTypes[0];
                nnnnFields[numInterp++] = m.nnnn;
                if (m.numOperands > 1) {
                  switchIncrement[numInterp] = m.argTypes[1];
                  nnnnFields[numInterp++] = 0;
                }
              }
            }
            rawNumInterp = numInterp;
            let w = 0o177 & (iMatch.code + 1);
            if (iMatch2) w |= 0o37600 & ((iMatch2.code + 1) << 7);
            out.words = [0o77777 & ~w];
            out.pc = incPc(inp.pc, 1);
            break;
          } else if (numInterp && !pinchHitting) {
            if (!inp.operator && !inp.operand) {
              out.pc = inp.pc;
            } else if (!inp.operator) {
              out.pc = incPc(inp.pc, 1);
              parseInterpretiveOperand(inp, out);
              numInterp--;
            } else {
              out.fatal = 'Missing interpretive operands.';
              out.words = [0];
              numInterp = 0;
              out.pc = incPc(inp.pc, 1);
            }
            break;
          }

          const match = PARSER_MAP.get(inp.operator);
          if (!match) {
            const numOperator = getOctOrDec(inp.operator);
            if (numOperator !== null) {
              // A raw number in the operator field, e.g. "2 0002".
              let value = getOctOrDec(inp.operand);
              if (value === null) {
                const r = fetchSymbolPlusOffset(inp.pc, inp.operand, inp.mod1);
                value = r.a ? sreg(r.a) : 0;
              }
              let flags = 0;
              if (
                (!inp.extend && numOperator === 2 && (value & 0o6000) === 0) ||
                (!inp.extend && numOperator === 5 && (value & 0o6000) === 0o2000) ||
                (inp.extend && numOperator === 4) ||
                (inp.extend && numOperator === 5)
              ) {
                flags |= KPLUS1;
              }
              out.pc = incPc(inp.pc, 1);
              parseGeneral(inp, out, numOperator << 12, flags);
              out.words[0] = 0o77777 & (out.words[0] + opcodeOffset);
              out.ebank.oneshot = false;
              out.sbank.oneshot = false;
              break;
            }
            out.pc = incPc(inp.pc, 1);
            out.fatal = `Unrecognized opcode/pseudo-op "${inp.operator}".`;
            break;
          }
          if (match.discard) {
            out.pc = inp.pc;
          } else if (match.alias) {
            inp.alias = inp.operator;
            [inp.operator, inp.operand] = match.alias;
            inp.mod1 = inp.mod2 = '';
            continue aliasRetry;
          } else {
            runParser(match, inp, out);
            if (out.words.length) {
              const before = out.words[0];
              let w = 0o77777 & (out.words[0] + opcodeOffset);
              if (w & 0o40000 && !(before & 0o40000)) w--;
              out.words[0] = ((w + (match.adder ?? 0)) ^ (match.xmask ?? 0)) & 0o77777;
              if (out.words.length > 1) out.words[1] = ((out.words[1] + (match.adder2 ?? 0)) ^ (match.xmask2 ?? 0)) & 0o77777;
            }
            if (inp.ebank.oneshot && (match.kind === 'bbcon' || match.kind === 'bbconStar' || match.kind === '2cadr')) out.ebank.current = inp.ebank.last;
            if (inp.sbank.oneshot && (match.kind === 'bbcon' || match.kind === 'bbconStar' || match.kind === '2cadr')) out.sbank.current = inp.sbank.last;
            if (match.kind !== 'ebankEquals') out.ebank.oneshot = false;
            if (match.kind !== 'sbankEquals') out.sbank.oneshot = false;
          }
          break;
        }
      }

      // STADR: the store word that follows is complemented.
      if (stadrInvert && out.words.length) {
        if (stadrInvert === 1) out.words[0] = 0o77777 & ~out.words[0];
        stadrInvert--;
      }

      updateBankCounts(out.pc);
      if (out.words.length && out.pc && out.pc.v >= 0o10000) {
        const fb = fbOf(out.pc);
        if (fb >= 0o30 && fb <= 0o37) out.sbank.current = isSuper(out.pc) ? 4 : 3;
      }

      // Labels take the value of the location counter.
      if (inp.label && !out.equals && inp.operator !== 'MEMORY' && inp.operator !== 'CHECK=') {
        editSymbol(inp.label, inp.pc);
      }

      if (lastPass) {
        if (out.fatal) {
          messages.push({ file: files[line.file].name, line: line.lineNo, message: out.fatal, fatal: true });
        } else if (out.warning) {
          messages.push({ file: files[line.file].name, line: line.lineNo, message: out.warning, fatal: false });
        }
        const pc = inp.pc;
        if (pc && (inp.label || inp.operator || inp.operand)) lineAddress[line.id] = pc.v;
        if (out.words.length) {
          lineWordStart[line.id] = lineWordsList.length;
          lineWordCount[line.id] = out.words.length;
          for (const w of out.words) lineWordsList.push(w & 0o77777);
          if (pc && !pc.c && isFixed(pc)) {
            const bank = pc.v >= 0o10000 ? bankOf(pc) : pc.v >> 10;
            const base = pc.v & 0o1777;
            for (let i = 0; i < out.words.length; i++) {
              const off = (base + i) & 0o1777;
              const idx = bank * BANK_SIZE + off;
              rope[idx] = out.words[i] & 0o77777;
              used[idx] = 1;
              ropeLine[idx] = line.id;
            }
          }
        }
      }

      state = {
        pc: out.pc,
        ebank: out.ebank,
        sbank: out.sbank,
        extend: out.extend,
        indexValid: out.indexValid,
      };
    }
  };

  // ---- Run passes until all symbols settle, then a final pass to emit code.
  const unresolved = (): number => {
    let n = 0;
    for (const v of symbols.values()) if (!v) n++;
    return n;
  };
  const maxPasses = options.maxPasses ?? 10;
  let lastUnresolved = unresolved();
  let passes = 0;
  for (let i = 1; i <= maxPasses; i++) {
    runPass();
    passes++;
    const k = unresolved();
    if ((k === 0 || k >= lastUnresolved) && reassigned === 0) break;
    lastUnresolved = k;
  }
  lastPass = true;
  runPass();
  passes++;

  // ---- Bank checksums ("bugger words"), as YUL appended them to every used bank.
  for (let bank = 0; bank < NUM_BANKS; bank++) {
    const offset = bank === 2 ? 0o4000 : bank === 3 ? 0o6000 : 0o2000;
    let value = usedInBank[bank];
    if (value <= 0) continue;
    const base = bank * BANK_SIZE;
    if (value < 0o1776) {
      rope[base + value] = value + offset;
      used[base + value] = 1;
      value++;
    }
    if (value < 0o1777) {
      rope[base + value] = value + offset;
      used[base + value] = 1;
      value++;
    }
    if (value < 0o2000) {
      let bugger = 0;
      for (let o = 0; o < value; o++) bugger = onesAdd(bugger, rope[base + o]);
      const guess = bugger & 0o40000 ? onesAdd(0o77777 & ~bank, 0o77777 & ~bugger) : onesAdd(bank, 0o77777 & ~bugger);
      rope[base + value] = guess;
      used[base + value] = 1;
    }
  }

  const symbolList: SymbolInfo[] = [];
  for (const [name, v] of symbols) {
    if (name.startsWith('$') || !v) continue;
    symbolList.push({ name, value: v.v, constant: v.c, line: symbolLine.get(name) ?? -1 });
  }
  for (const [name, v] of symbols) {
    if (!v && !name.startsWith('$')) {
      messages.push({ file: '', line: 0, message: `Unresolved symbol "${name}".`, fatal: true });
    }
  }

  return {
    rope,
    used,
    ropeLine,
    lineAddress,
    lineWordStart,
    lineWordCount,
    lineWords: Uint16Array.from(lineWordsList),
    files,
    symbols: symbolList,
    messages,
    bankUsage: usedInBank.slice(),
    passes,
  };
}

function isFalseLabel(s: string): boolean {
  return /^[+-][0-9]+D?$/.test(s);
}
