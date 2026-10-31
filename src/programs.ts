// The two Apollo 11 flight programs in the original source repository.

/**
 * A correction to one line of the upstream transcription, applied when the
 * source is loaded.  The upstream files themselves are never modified.
 */
export interface SourceCorrection {
  file: string;
  line: number; // 1-based
  original: string; // the exact upstream line
  corrected: string;
  reason: string;
}

export interface ProgramInfo {
  id: string;
  directory: string;
  vehicle: 'LM' | 'CM';
  title: string;
  description: string;
  /**
   * Include names in MAIN.agc that do not match a file in the repository.
   * Upstream renamed two Luminary099 files without updating MAIN.agc; the
   * files' own headers still give the original names used here.
   */
  includeAliases?: Record<string, string>;
  /** Transcription errors in the upstream copy, checked against the 1969 octal listing. */
  corrections?: SourceCorrection[];
}

export const PROGRAMS: ProgramInfo[] = [
  {
    id: 'Luminary099',
    directory: 'Luminary099',
    vehicle: 'LM',
    title: 'Luminary 099 — Lunar Module "Eagle"',
    description: 'LMY99 revision 001, the software flown in the Apollo 11 Lunar Module.',
    includeAliases: {
      'LAMBERT_AIMPOINT_GUIDANCE.agc': 'GENERAL_LAMBERT_AIMPOINT_GUIDANCE.agc',
      'TRIM_GIMBAL_CNTROL_SYSTEM.agc': 'TRIM_GIMBAL_CONTROL_SYSTEM.agc',
    },
  },
  {
    id: 'Comanche055',
    directory: 'Comanche055',
    vehicle: 'CM',
    title: 'Comanche 055 — Command Module "Columbia"',
    description: 'Colossus 2A, the software flown in the Apollo 11 Command Module.',
    corrections: [
      {
        file: 'ERASABLE_ASSIGNMENTS.agc',
        line: 2094,
        original: '\t\t\t\t\t\t\t\t\t  -16',
        corrected: '#\t\t\t\t\t\t\t\t\t  -16',
        reason: 'Continuation of the comment above lost its "#", which shifted ALTVAR by one word.',
      },
      {
        file: 'KALCMANU_STEERING.agc',
        line: 248,
        original: 'ZEROERROR\tCA\tCDUX\t\t# PICK UP CDU ANGLES AND STORE IN',
        corrected: 'ZEROEROR\tCA\tCDUX\t\t# PICK UP CDU ANGLES AND STORE IN',
        reason: 'Label is ZEROEROR in the original listing (YUL labels are at most 8 characters); ANGLFIND refers to it by that name.',
      },
      {
        file: 'REENTRY_CONTROL.agc',
        line: 737,
        original: 'GETDLEWD\tDLOAD\tDMP',
        corrected: 'GETLEWD\tDLOAD\tDMP',
        reason: 'Label is GETLEWD in the original listing; it is referenced by that name a few lines earlier.',
      },
      {
        file: 'P32-P33_P72-P73.agc',
        line: 648,
        original: '1DPB2\t\t2DEC\t1.08-2',
        corrected: '1DPB2\t\t2DEC\t1.0 B-2',
        reason: 'Constant is 1.0 B-2 in the original listing.',
      },
    ],
  },
];
