// Assembles a program from its source files, applying the documented
// corrections.  Runs in a Web Worker, or on the main thread as a fallback.

import { assemble, type AssemblyResult } from '../yul/assembler.ts';
import { applyCorrections, type CorrectionStatus } from '../yul/sources.ts';
import { PROGRAMS } from '../programs.ts';

export interface AssembleRequest {
  programId: string;
  files: Record<string, string>;
}

export interface AssembleResponse {
  result: AssemblyResult;
  corrections: CorrectionStatus[];
  /** The text of each assembled file, after corrections, in include order. */
  texts: string[];
  ms: number;
}

export function assembleSources({ programId, files }: AssembleRequest): AssembleResponse {
  const program = PROGRAMS.find((p) => p.id === programId);
  if (!program) throw new Error(`Unknown program ${programId}`);
  const corrections: CorrectionStatus[] = [];
  const corrected = new Map<string, string>();
  const t0 = performance.now();
  const result = assemble(
    'MAIN.agc',
    (name) => {
      const text = files[name];
      if (text === undefined) return undefined;
      const fixed = applyCorrections(program, name, text, corrections);
      corrected.set(name, fixed);
      return fixed;
    },
    { includeAliases: program.includeAliases },
  );
  const ms = performance.now() - t0;
  return { result, corrections, texts: result.files.map((f) => corrected.get(f.name) ?? ''), ms };
}

export function transferables(r: AssemblyResult): Transferable[] {
  return [r.rope, r.used, r.ropeLine, r.lineAddress, r.lineWordStart, r.lineWordCount, r.lineWords].map((a) => a.buffer);
}
