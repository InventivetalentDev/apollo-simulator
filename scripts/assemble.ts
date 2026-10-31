// Assemble one of the original AGC programs from vendor/Apollo-11 and report on
// the result.  Usage: npm run assemble -- Luminary099 [--compare]
// --compare checks the rope against the 1969 octal listing in test/fixtures.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { assemble } from '../src/yul/assembler.ts';
import { compareRope, parseBinsource } from '../src/yul/binsource.ts';
import { applyCorrections, type CorrectionStatus } from '../src/yul/sources.ts';
import { PROGRAMS } from '../src/programs.ts';

const name = process.argv[2] ?? 'Luminary099';
const program = PROGRAMS.find((p) => p.id === name);
if (!program) throw new Error(`Unknown program ${name}`);
const dir = join('vendor/Apollo-11', program.directory);
const corrections: CorrectionStatus[] = [];
const t0 = performance.now();
const result = assemble(
  'MAIN.agc',
  (f) => (existsSync(join(dir, f)) ? applyCorrections(program, f, readFileSync(join(dir, f), 'utf8'), corrections) : undefined),
  { includeAliases: program.includeAliases },
);
const t1 = performance.now();
const fatals = result.messages.filter((m) => m.fatal);
console.log(
  `${name}: ${result.files.length} files, ${result.passes} passes, ${(t1 - t0).toFixed(0)} ms, ${fatals.length} fatal, ${result.messages.length - fatals.length} warnings`,
);
for (const c of corrections) console.log(`  correction ${c.applied ? 'applied' : 'NOT APPLIED'}: ${c.file}:${c.line}`);
for (const m of result.messages.slice(0, 40)) console.log(`  ${m.fatal ? 'E' : 'W'} ${m.file}:${m.line} ${m.message}`);

if (process.argv.includes('--compare')) {
  const expected = parseBinsource(readFileSync(join('test/fixtures', `${name}.binsource`), 'utf8'));
  const { compared, mismatches } = compareRope(result.rope, result.used, expected);
  for (const m of mismatches.slice(0, 40)) {
    const idx = m.bank * 1024 + m.offset;
    const lineId = result.ropeLine[idx];
    const f = result.files.find((ff) => lineId >= ff.firstLine && lineId < ff.firstLine + ff.lineCount);
    const base = m.bank === 2 ? 0o4000 : m.bank === 3 ? 0o6000 : 0o2000;
    const fmt = (v: number) => (v < 0 ? '@' : v.toString(8).padStart(5, '0'));
    console.log(
      `  ${m.bank.toString(8).padStart(2, '0')},${(base + m.offset).toString(8)}: expected ${fmt(m.expected)} got ${fmt(m.actual)}  ${f ? `${f.name}:${lineId - f.firstLine + 1}` : ''}`,
    );
  }
  console.log(`Compared ${compared} words with the 1969 listing: ${mismatches.length} mismatches.`);
  process.exitCode = mismatches.length ? 1 : 0;
}
