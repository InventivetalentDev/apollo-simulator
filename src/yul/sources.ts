// Applies the documented corrections from programs.ts to upstream source text.

import type { ProgramInfo } from '../programs.ts';

export interface CorrectionStatus {
  file: string;
  line: number;
  applied: boolean;
  reason: string;
}

export function applyCorrections(program: ProgramInfo, file: string, text: string, status: CorrectionStatus[]): string {
  const fixes = (program.corrections ?? []).filter((c) => c.file === file);
  if (!fixes.length) return text;
  const lines = text.split('\n');
  for (const fix of fixes) {
    const current = lines[fix.line - 1]?.replace(/\r$/, '');
    const applied = current === fix.original;
    if (applied) lines[fix.line - 1] = fix.corrected;
    status.push({ file: fix.file, line: fix.line, applied, reason: fix.reason });
  }
  return lines.join('\n');
}
