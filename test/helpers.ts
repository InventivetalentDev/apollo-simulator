import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AGC, MCT_PER_SECOND } from '../src/agc/cpu.ts';
import { pressKey, releaseKey, type DskyKey } from '../src/agc/dsky.ts';
import { LunarModule } from '../src/sim/lm.ts';
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

/**
 * Luminary099 wired to a simulated LM, with helpers to run it for a number of
 * seconds, key DSKY sequences ("V 3 7 E 6 3 E"), and look up erasable symbols.
 */
export function bootLm() {
  const { result } = assembleProgram('Luminary099');
  const agc = new AGC(result.rope);
  const lm = new LunarModule(agc);
  agc.peripheral = lm;
  const run = (seconds: number) => agc.run(Math.round(seconds * MCT_PER_SECOND));
  const keys = (seq: string) => {
    for (const tok of seq.split(' ')) {
      const key = ({ V: 'VERB', N: 'NOUN', E: 'ENTR' } as Record<string, DskyKey>)[tok] ?? (tok as DskyKey);
      pressKey(agc, key);
      if (key === 'PRO') {
        run(0.3);
        releaseKey(agc, key);
      }
      run(0.15);
    }
  };
  const address = (name: string) => {
    const symbol = result.symbols.find((s) => s.name === name);
    if (!symbol) throw new Error(`no symbol ${name}`);
    return symbol.value;
  };
  const erasable = (name: string) => agc.mem[address(name)];
  return { agc, lm, run, keys, address, erasable };
}
