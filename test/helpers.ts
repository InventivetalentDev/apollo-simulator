import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { assemble, type AssemblyResult } from '../src/yul/assembler.ts';
import { applyCorrections, type CorrectionStatus } from '../src/yul/sources.ts';
import { PROGRAMS } from '../src/programs.ts';

const cache = new Map<string, { result: AssemblyResult; corrections: CorrectionStatus[] }>();

export function assembleProgram(id: string): { result: AssemblyResult; corrections: CorrectionStatus[] } {
  const hit = cache.get(id);
  if (hit) return hit;
  const program = PROGRAMS.find((p) => p.id === id)!;
  const dir = join('vendor/Apollo-11', program.directory);
  const corrections: CorrectionStatus[] = [];
  const result = assemble(
    'MAIN.agc',
    (f) => (existsSync(join(dir, f)) ? applyCorrections(program, f, readFileSync(join(dir, f), 'utf8'), corrections) : undefined),
    { includeAliases: program.includeAliases },
  );
  const entry = { result, corrections };
  cache.set(id, entry);
  return entry;
}
