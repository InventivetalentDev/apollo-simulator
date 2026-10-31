// Opcode tables for the Block II AGC assembly language, as accepted by the
// MIT Instrumentation Lab's YUL assembler (and its modern re-creation, yaYUL).
// Values are octal, exactly as they appear in the original documentation.

export type ParserKind =
  | 'general'
  | 'equals'
  | 'eqMinus'
  | 'eqECADR'
  | 'checkEquals'
  | 'bank'
  | 'block'
  | 'setloc'
  | 'erase'
  | 'oct'
  | '2oct'
  | 'dec'
  | '2dec'
  | 'vn'
  | 'genadr'
  | 'cadr'
  | 'ecadr'
  | '2cadr'
  | '2fcadr'
  | 'bbcon'
  | 'bbconStar'
  | 'ebankEquals'
  | 'sbankEquals'
  | 'index'
  | 'stcall'
  | 'stodl'
  | 'store'
  | 'stovl'
  | 'edrupt'
  | 'secsiz';

// Flags for 'general' (machine instruction) parsing.
export const KPLUS1 = 0x1; // instruction operand is K+1 rather than K
export const EXTENDED = 0x2; // must be preceded by EXTEND
export const PC0 = 0x4;
export const QC0 = 0x8;
export const PC1 = 0x10;
export const PC2 = 0x20;
export const QC1 = 0x40;
export const PC3 = 0x80;
export const PC4 = 0x100;
export const QC2 = 0x200;
export const PC5 = 0x400;
export const PC6 = 0x800;
export const QC3 = 0x1000;
export const PC7 = 0x2000;
export const QCNOT0 = 0x4000;
export const FIXED = 0x8000;
export const ERASABLE = 0x10000;
export const ENUMBER = 0x20000;

export interface OpDef {
  kind?: ParserKind;
  opcode?: number; // for 'general'
  flags?: number; // for 'general'
  alias?: [string, string]; // [operator, operand]
  discard?: boolean; // silently ignored pseudo-op
  adder?: number;
  xmask?: number;
  adder2?: number;
  xmask2?: number;
  pinchHit?: boolean; // may stand in for an interpretive operand
  interpretive?: boolean; // STORE-family pseudo-ops
}

const g = (opcode: number, flags: number): OpDef => ({ kind: 'general', opcode, flags });

export const PARSERS: Record<string, OpDef> = {
  '-1DNADR': { kind: 'ecadr', adder: 0, xmask: 0o77777 },
  '-2CADR': { kind: '2cadr', adder: 0, xmask: 0o77777, adder2: 0, xmask2: 0o77777 },
  '-2DNADR': { kind: 'ecadr', adder: 0o4000, xmask: 0o77777 },
  '-3DNADR': { kind: 'ecadr', adder: 0o10000, xmask: 0o77777 },
  '-4DNADR': { kind: 'ecadr', adder: 0o14000, xmask: 0o77777 },
  '-5DNADR': { kind: 'ecadr', adder: 0o20000, xmask: 0o77777 },
  '-6DNADR': { kind: 'ecadr', adder: 0o24000, xmask: 0o77777 },
  '-CCS': { ...g(0o10000, QC0 | ENUMBER), xmask: 0o77777 },
  '-DNCHAN': { ...g(0o34000, PC0 | ENUMBER), xmask: 0o77777 },
  '-DNPTR': { kind: 'genadr', adder: 0o30000, xmask: 0o77777 },
  '-GENADR': { kind: 'genadr', xmask: 0o77777 },
  '=': { kind: 'equals' },
  '=ECADR': { kind: 'eqECADR' },
  '=MINUS': { kind: 'eqMinus' },
  '1DNADR': { kind: 'ecadr' },
  '2BCADR': { kind: '2cadr' },
  '2CADR': { kind: '2cadr' },
  '2DEC': { kind: '2dec' },
  '2DEC*': { kind: '2dec' },
  '2DNADR': { kind: 'ecadr', adder: 0o4000 },
  '2FCADR': { kind: '2fcadr' },
  '2OCT': { kind: '2oct' },
  '3DNADR': { kind: 'ecadr', adder: 0o10000 },
  '4DNADR': { kind: 'ecadr', adder: 0o14000 },
  '5DNADR': { kind: 'ecadr', adder: 0o20000 },
  '6DNADR': { kind: 'ecadr', adder: 0o24000 },
  AD: g(0o60000, ENUMBER),
  ADRES: { kind: 'genadr' },
  ADS: g(0o20000, QC3),
  AUG: g(0o20000, EXTENDED | QC2),
  BANK: { kind: 'bank' },
  BLOCK: { kind: 'block' },
  BBCON: { kind: 'bbcon' },
  'BBCON*': { kind: 'bbconStar' },
  BNKSUM: { discard: true },
  BZF: g(0o10000, EXTENDED | QCNOT0),
  BZMF: g(0o60000, EXTENDED | QCNOT0),
  CA: g(0o30000, ENUMBER),
  CAE: g(0o30000, ERASABLE | ENUMBER),
  CAF: g(0o30000, FIXED | ENUMBER),
  CADR: { kind: 'cadr', pinchHit: true },
  CCS: g(0o10000, QC0 | ENUMBER),
  'CHECK=': { kind: 'checkEquals' },
  COM: { alias: ['CS', 'A'] },
  COUNT: { discard: true },
  'COUNT*': { discard: true },
  CS: g(0o40000, ENUMBER),
  DAS: g(0o20000, QC0 | KPLUS1),
  DCA: g(0o30000, EXTENDED | KPLUS1 | ENUMBER),
  DCOM: { alias: ['DCS', 'A'] },
  DCS: g(0o40000, EXTENDED | KPLUS1 | ENUMBER),
  DDOUBL: { alias: ['DAS', 'A'] },
  DEC: { kind: 'dec', pinchHit: true },
  'DEC*': { kind: 'dec' },
  DIM: g(0o20000, EXTENDED | QC3),
  DNCHAN: g(0o34000, PC0 | ENUMBER),
  DNPTR: { kind: 'genadr', adder: 0o30000 },
  DOUBLE: { alias: ['AD', 'A'] },
  DTCB: { alias: ['DXCH', 'Z'] },
  DTCF: { alias: ['DXCH', '$4'] },
  DV: g(0o10000, EXTENDED | QC0),
  DXCH: g(0o50000, QC1 | KPLUS1 | ENUMBER),
  'EBANK=': { kind: 'ebankEquals' },
  ECADR: { kind: 'ecadr', pinchHit: true },
  EDRUPT: { kind: 'edrupt' },
  EQUALS: { kind: 'equals' },
  ERASE: { kind: 'erase' },
  EXTEND: { alias: ['TC', '$6'] },
  FCADR: { kind: 'cadr', pinchHit: true },
  GENADR: { kind: 'genadr' },
  INCR: g(0o20000, QC2),
  INDEX: { kind: 'index' },
  INHINT: { alias: ['TC', '$4'] },
  LXCH: g(0o20000, QC1 | ENUMBER),
  MASK: g(0o70000, 0),
  MSK: g(0o70000, 0),
  MEMORY: { discard: true },
  MM: { kind: 'dec' },
  MP: g(0o70000, EXTENDED),
  MSU: g(0o20000, EXTENDED | QC0 | ENUMBER),
  NDX: { kind: 'index' },
  NV: { kind: 'vn', pinchHit: true },
  OCT: { kind: 'oct', pinchHit: true },
  OCTAL: { kind: 'oct', pinchHit: true },
  OVSK: { alias: ['TS', 'A'] },
  QXCH: g(0o20000, EXTENDED | QC1 | ENUMBER),
  RAND: g(0, EXTENDED | PC2 | ENUMBER),
  READ: g(0, EXTENDED | PC0 | ENUMBER),
  RELINT: { alias: ['TC', '$3'] },
  REMADR: { kind: 'genadr' },
  RESUME: { alias: ['INDEX', '$17'] },
  RETURN: { alias: ['TC', 'Q'] },
  ROR: g(0, EXTENDED | PC4 | ENUMBER),
  RXOR: g(0, EXTENDED | PC6 | ENUMBER),
  'SBANK=': { kind: 'sbankEquals' },
  SECSIZ: { kind: 'secsiz' },
  SETLOC: { kind: 'setloc' },
  SQUARE: { alias: ['MP', 'A'] },
  STCALL: { kind: 'stcall', interpretive: true },
  STODL: { kind: 'stodl', interpretive: true },
  'STODL*': { kind: 'stodl', interpretive: true, adder: 0o4000 },
  STORE: { kind: 'store', interpretive: true },
  STOVL: { kind: 'stovl', interpretive: true },
  'STOVL*': { kind: 'stovl', interpretive: true, adder: 0o4000 },
  SU: g(0o60000, EXTENDED | QC0 | ENUMBER),
  SUBRO: { discard: true },
  TC: g(0, ENUMBER),
  TCR: g(0, ENUMBER),
  TCAA: { alias: ['TS', 'Z'] },
  TCF: g(0o10000, QCNOT0 | ENUMBER),
  TS: g(0o50000, QC2 | ENUMBER),
  VN: { kind: 'vn', pinchHit: true },
  WAND: g(0, EXTENDED | PC3 | ENUMBER),
  WOR: g(0, EXTENDED | PC5 | ENUMBER),
  WRITE: g(0, EXTENDED | PC1 | ENUMBER),
  XCH: g(0o50000, QC3 | ENUMBER),
  XLQ: { alias: ['TC', 'L'] },
  XXALQ: { alias: ['TC', 'A'] },
  ZL: { alias: ['LXCH', '$7'] },
  ZQ: { alias: ['QXCH', '$7'] },
};

export interface InterpDef {
  code: number;
  numOperands: number;
  switchType: number; // 0 normal, 1 switch (flag) instruction, 2 shift instruction
  nnnn: number;
  argTypes: [number, number];
}

const I = (code: number, numOperands: number, switchType = 0, nnnn = 0, argTypes: [number, number] = [0, 0]): InterpDef => ({
  code,
  numOperands,
  switchType,
  nnnn,
  argTypes,
});
const IX: [number, number] = [1, 0];

export const INTERPRETIVE: Record<string, InterpDef> = {
  ABS: I(0o130, 0),
  ABVAL: I(0o130, 0),
  ARCCOS: I(0o50, 0),
  ACOS: I(0o50, 0),
  ARCSIN: I(0o40, 0),
  ASIN: I(0o40, 0),
  'AXC,1': I(0o16, 1),
  'AXC,2': I(0o12, 1),
  'AXT,1': I(0o6, 1),
  'AXT,2': I(0o2, 1),
  BDDV: I(0o111, 1, 0, 0, IX),
  'BDDV*': I(0o113, 1, 0, 0, IX),
  BDSU: I(0o155, 1, 0, 0, IX),
  'BDSU*': I(0o157, 1, 0, 0, IX),
  BHIZ: I(0o146, 1),
  BMN: I(0o136, 1),
  BOFCLR: I(0o162, 2, 1, 0o241),
  BOF: I(0o162, 2, 1, 0o341),
  BOFF: I(0o162, 2, 1, 0o341),
  BOFINV: I(0o162, 2, 1, 0o141),
  BOFSET: I(0o162, 2, 1, 0o41),
  BON: I(0o162, 2, 1, 0o301),
  BONCLR: I(0o162, 2, 1, 0o201),
  BONINV: I(0o162, 2, 1, 0o101),
  BONSET: I(0o162, 2, 1, 0o1),
  BOV: I(0o176, 1),
  BOVB: I(0o172, 1),
  BPL: I(0o132, 1),
  BVSU: I(0o131, 1, 0, 0, IX),
  'BVSU*': I(0o133, 1, 0, 0, IX),
  BZE: I(0o122, 1),
  CALL: I(0o152, 1),
  CALRB: I(0o152, 1),
  CCALL: I(0o65, 2, 0, 0, IX),
  'CCALL*': I(0o67, 2, 0, 0, IX),
  CGOTO: I(0o21, 2, 0, 0, IX),
  'CGOTO*': I(0o23, 2, 0, 0, IX),
  CLEAR: I(0o162, 1, 1, 0o261),
  CLR: I(0o162, 1, 1, 0o261),
  CLRGO: I(0o162, 2, 1, 0o221),
  COS: I(0o30, 0),
  COSINE: I(0o30, 0),
  DAD: I(0o161, 1, 0, 0, IX),
  'DAD*': I(0o163, 1, 0, 0, IX),
  DCOMP: I(0o100, 0),
  DDV: I(0o105, 1, 0, 0, IX),
  'DDV*': I(0o107, 1, 0, 0, IX),
  DLOAD: I(0o31, 1, 0, 0, IX),
  'DLOAD*': I(0o33, 1, 0, 0, IX),
  DMP: I(0o171, 1, 0, 0, IX),
  'DMP*': I(0o173, 1, 0, 0, IX),
  DMPR: I(0o101, 1, 0, 0, IX),
  'DMPR*': I(0o103, 1, 0, 0, IX),
  DOT: I(0o135, 1, 0, 0, IX),
  'DOT*': I(0o137, 1, 0, 0, IX),
  DSQ: I(0o60, 0),
  DSU: I(0o151, 1, 0, 0, IX),
  'DSU*': I(0o153, 1, 0, 0, IX),
  EXIT: I(0o0, 0),
  GOTO: I(0o126, 1),
  'INCR,1': I(0o66, 1),
  'INCR,2': I(0o62, 1),
  INVERT: I(0o162, 1, 1, 0o161),
  INVGO: I(0o162, 2, 1, 0o121),
  ITA: I(0o156, 1),
  ITCQ: I(0o160, 0),
  'LXA,1': I(0o26, 1),
  'LXA,2': I(0o22, 1),
  'LXC,1': I(0o36, 1),
  'LXC,2': I(0o32, 1),
  MXV: I(0o55, 1, 0, 0, IX),
  'MXV*': I(0o57, 1, 0, 0, IX),
  NORM: I(0o75, 1, 0, 0, IX),
  'NORM*': I(0o77, 1, 0, 0, IX),
  PDDL: I(0o51, 1, 0, 0, IX),
  'PDDL*': I(0o53, 1, 0, 0, IX),
  PDVL: I(0o61, 1, 0, 0, IX),
  'PDVL*': I(0o63, 1, 0, 0, IX),
  PUSH: I(0o170, 0),
  ROUND: I(0o70, 0),
  RTB: I(0o142, 1),
  RVQ: I(0o160, 0),
  SET: I(0o162, 1, 1, 0o61),
  SETGO: I(0o162, 2, 1, 0o21),
  SETPD: I(0o175, 1, 0, 0, IX),
  SIGN: I(0o11, 1, 0, 0, IX),
  'SIGN*': I(0o13, 1, 0, 0, IX),
  SIN: I(0o20, 0),
  SINE: I(0o20, 0),
  SL: I(0o115, 1, 2, 0o20202, IX),
  'SL*': I(0o117, 1, 2, 0o20202, IX),
  SLOAD: I(0o41, 1, 0, 0, IX),
  'SLOAD*': I(0o43, 1, 0, 0, IX),
  SL1: I(0o24, 0, 0, 0, IX),
  SL1R: I(0o4, 0, 0, 0, IX),
  SL2: I(0o64, 0, 0, 0, IX),
  SL2R: I(0o44, 0, 0, 0, IX),
  SL3: I(0o124, 0, 0, 0, IX),
  SL3R: I(0o104, 0, 0, 0, IX),
  SL4: I(0o164, 0, 0, 0, IX),
  SL4R: I(0o144, 0, 0, 0, IX),
  SLR: I(0o115, 1, 2, 0o21202, IX),
  'SLR*': I(0o117, 1, 2, 0o21202, IX),
  SQRT: I(0o10, 0),
  SR: I(0o115, 1, 2, 0o20602, IX),
  'SR*': I(0o117, 1, 2, 0o20602, IX),
  SR1: I(0o34, 0, 0, 0, IX),
  SR1R: I(0o14, 0, 0, 0, IX),
  SR2: I(0o74, 0, 0, 0, IX),
  SR2R: I(0o54, 0, 0, 0, IX),
  SR3: I(0o134, 0, 0, 0, IX),
  SR3R: I(0o114, 0, 0, 0, IX),
  SR4: I(0o174, 0, 0, 0, IX),
  SR4R: I(0o154, 0, 0, 0, IX),
  SRR: I(0o115, 1, 2, 0o21602, IX),
  'SRR*': I(0o117, 1, 2, 0o21602, IX),
  SSP: I(0o45, 2, 0, 0, IX),
  'SSP*': I(0o47, 1, 0, 0, IX),
  STADR: I(0o150, 0),
  STQ: I(0o156, 1),
  'SXA,1': I(0o46, 1),
  'SXA,2': I(0o42, 1),
  TAD: I(0o5, 1, 0, 0, IX),
  'TAD*': I(0o7, 1, 0, 0, IX),
  'TIX,1': I(0o76, 1),
  'TIX,2': I(0o72, 1),
  TLOAD: I(0o25, 1, 0, 0, IX),
  'TLOAD*': I(0o27, 1, 0, 0, IX),
  UNIT: I(0o120, 0),
  'V/SC': I(0o35, 1, 0, 0, IX),
  'V/SC*': I(0o37, 1, 0, 0, IX),
  VAD: I(0o121, 1, 0, 0, IX),
  'VAD*': I(0o123, 1, 0, 0, IX),
  VCOMP: I(0o100, 0),
  VDEF: I(0o110, 0),
  VLOAD: I(0o1, 1, 0, 0, IX),
  'VLOAD*': I(0o3, 1, 0, 0, IX),
  VPROJ: I(0o145, 1, 0, 0, IX),
  'VPROJ*': I(0o147, 1, 0, 0, IX),
  VSL: I(0o115, 1, 2, 0o20202, IX),
  'VSL*': I(0o117, 1, 2, 0o20202, IX),
  VSL1: I(0o4, 0, 0, 0, IX),
  VSL2: I(0o24, 0, 0, 0, IX),
  VSL3: I(0o44, 0, 0, 0, IX),
  VSL4: I(0o64, 0, 0, 0, IX),
  VSL5: I(0o104, 0, 0, 0, IX),
  VSL6: I(0o124, 0, 0, 0, IX),
  VSL7: I(0o144, 0, 0, 0, IX),
  VSL8: I(0o164, 0, 0, 0, IX),
  VSQ: I(0o140, 0),
  VSR: I(0o115, 1, 2, 0o20602, IX),
  'VSR*': I(0o117, 1, 2, 0o20602, IX),
  VSR1: I(0o14, 0, 0, 0, IX),
  VSR2: I(0o34, 0, 0, 0, IX),
  VSR3: I(0o54, 0, 0, 0, IX),
  VSR4: I(0o74, 0, 0, 0, IX),
  VSR5: I(0o114, 0, 0, 0, IX),
  VSR6: I(0o134, 0, 0, 0, IX),
  VSR7: I(0o154, 0, 0, 0, IX),
  VSR8: I(0o174, 0, 0, 0, IX),
  VSU: I(0o125, 1, 0, 0, IX),
  'VSU*': I(0o127, 1, 0, 0, IX),
  VXM: I(0o71, 1, 0, 0, IX),
  'VXM*': I(0o73, 1, 0, 0, IX),
  VXSC: I(0o15, 1, 0, 0, IX),
  'VXSC*': I(0o17, 1, 0, 0, IX),
  VXV: I(0o141, 1, 0, 0, IX),
  'VXV*': I(0o143, 1, 0, 0, IX),
  'XAD,1': I(0o106, 1),
  'XAD,2': I(0o102, 1),
  'XCHX,1': I(0o56, 1),
  'XCHX,2': I(0o52, 1),
  'XSU,1': I(0o116, 1),
  'XSU,2': I(0o112, 1),
};
