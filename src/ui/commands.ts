// Ready-made DSKY key sequences.  Each was checked against the programs it is shown for.

import type { DskyKey } from '../agc/dsky.ts';

export interface Command {
  title: string;
  keys: string; // space separated: V, N, E stand for VERB, NOUN, ENTR
  detail: string;
  /** Show only for this spacecraft (default: both). */
  vehicle?: 'LM' | 'CM';
  /** Before typing the keys, put the simulation in this state. */
  setup?: 'descent';
}

export const COMMANDS: Command[] = [
  {
    title: 'Load the autopilot data',
    keys: 'V 4 8 E V 2 1 E 2 1 1 0 2 E PRO V 2 1 E + 3 3 2 9 0 E PRO PRO',
    detail:
      'Verb 48 asks for the DAP settings. Noun 46: descent stage attached, 0.3° deadband, 2°/s maneuvers. Noun 47: LM weight 33,290 lb. Without the weight the autopilot misjudges its jets and leaves the LM turning slowly.',
    vehicle: 'LM',
  },
  {
    title: 'Monitor the IMU gimbal angles',
    keys: 'V 1 6 N 2 0 E',
    detail: 'Noun 20 shows the outer, inner and middle gimbal angles as the IMU’s angle counters (CDUs) count them. Turn the LM and watch them change.',
    vehicle: 'LM',
  },
  {
    title: 'Turn to an attitude (V49)',
    keys: 'V 3 7 E 0 0 E V 4 9 E V 2 5 E + 0 4 5 0 0 E + 0 1 0 0 0 E + 0 0 0 0 0 E PRO',
    detail:
      'Set the mode switch to Auto first. In P00, verb 49 takes target gimbal angles (here 45°, 10°, 0°). When V50 N18 flashes, press PRO and the attitude maneuver routine (KALCMANU) turns the LM at 2°/s.',
    vehicle: 'LM',
  },
  {
    title: 'Set up powered descent',
    keys: 'RSET V 4 8 E V 2 1 E 2 1 1 0 2 E PRO V 2 1 E + 3 3 2 9 0 E PRO PRO',
    detail:
      'Restarts the computer at 102:27:00 into Apollo 11: the LM in its descent orbit 18 km above the Moon, the IMU aligned to the landing site, and the 1969 pre-launch erasable load. Then it clears the restart alarm and loads the autopilot data. The landing radar answers, but has no data.',
    vehicle: 'LM',
    setup: 'descent',
  },
  {
    title: 'Start powered descent (P63)',
    keys: 'V 3 7 E 6 3 E',
    detail:
      'After the setup. P63 works out when to light the engine (about 102:32:50). Answer it on the DSKY: V06 N61 PRO; V50 N25 00014 ENTER (no fine alignment); V50 N18 PRO, and ENTER when it flashes again; at 35 s to go, V99 PRO to enable the engine. The engine lights at minimum thrust, goes to full throttle 26 s later, and P64 starts at high gate, about 8 minutes into the burn. Use the speed menu to shorten the wait.',
    vehicle: 'LM',
  },
  {
    title: 'Lamp test',
    keys: 'V 3 5 E',
    detail: 'Verb 35 lights every lamp and display segment for about five seconds.',
  },
  {
    title: 'Show the alarm codes',
    keys: 'V 0 5 N 0 9 E',
    detail: 'At power-up the PROG lamp is lit with alarm 01107: erasable memory was blank, so the software did a fresh start.',
  },
  {
    title: 'Clear the alarm lamps',
    keys: 'RSET',
    detail: 'Error reset turns off PROG, OPR ERR and the RESTART lamp.',
  },
  {
    title: 'Watch the clock',
    keys: 'V 1 6 N 6 5 E',
    detail: 'Verb 16 monitors noun 65, the time since power-up: hours, minutes and hundredths of a second.',
  },
  {
    title: 'Start program 00',
    keys: 'V 3 7 E 0 0 E',
    detail: 'Verb 37 changes the major mode. P00 is the idle program the crew selected between activities.',
  },
  {
    title: 'Monitor a memory word',
    keys: 'V 1 1 N 0 1 E 2 5 E',
    detail: 'Verb 11 noun 01 shows any address in octal and keeps it updated. Address 25 is TIME1, which counts hundredths of a second.',
  },
  {
    title: 'Run the self-check',
    keys: 'V 2 1 N 2 7 E 1 0 E',
    detail: 'Loads 10 into SMODE so the idle loop runs the built-in tests of the instructions, erasable memory and rope checksums.',
  },
];

const NAMES: Record<string, DskyKey> = { V: 'VERB', N: 'NOUN', E: 'ENTR' };

export function parseKeys(keys: string): DskyKey[] {
  return keys.split(' ').map((k) => NAMES[k] ?? (k as DskyKey));
}

export function displayKeys(keys: string): string {
  return keys.replace(/\bV\b/g, 'VERB').replace(/\bN\b/g, 'NOUN').replace(/\bE\b/g, 'ENTR');
}
