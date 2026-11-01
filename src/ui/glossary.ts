// Short forms on the page, spelled out with what they mean.  `abbr()` wraps a
// label in an <abbr> whose title shows on hover.  `explain()` does the same
// for the first use of each short form in a sentence, for verb, noun and
// program numbers (V06, N62, VERB 57, P63), and for alarm codes (alarm 1703).
// The verb and noun names and the alarm codes come from the loaded program's
// own lists in ASSEMBLY_AND_OPERATION_INFORMATION.agc.

/** Short forms that `explain()` finds in text. */
const TERMS: Record<string, string> = {
  AGC: 'Apollo Guidance Computer: the computer in both the Command Module and the Lunar Module.',
  DSKY: 'Display and keyboard: the crew’s keyboard and display for the computer.',
  LM: 'Lunar Module: the spacecraft that landed on the Moon.',
  CM: 'Command Module: the spacecraft that took the crew to the Moon and back.',
  IMU: 'Inertial measurement unit: a platform that gyros hold still in space. Its gimbal angles give the spacecraft’s attitude, and its accelerometers measure changes in speed.',
  CDU: 'Coupling data unit: turns the IMU’s gimbal angles into counts for the computer, and the computer’s counts into gimbal motion.',
  CDUs: 'Coupling data units: they turn the IMU’s gimbal angles into counts for the computer, and the computer’s counts into gimbal motion.',
  RCS: 'Reaction control system: the 16 small jets that turn and move the LM.',
  DAP: 'Digital autopilot: the flight software that fires the RCS jets and trims the descent engine.',
  PGNS: 'Primary guidance and navigation system: the IMU, the computer and the DSKY.',
  FDAI: 'Flight director attitude indicator: the attitude ball.',
  'I/O': 'Input/output: the computer’s channels to the DSKY, the switches and the rest of the spacecraft’s hardware.',
  'Block II': 'The second and final design of the AGC, flown on every crewed Apollo mission.',
  KALCMANU: 'The name of the attitude maneuver routine in the flight software.',
  SMODE: 'Self-check mode: the erasable word that picks the self-test the idle loop runs.',
  TIME1: 'The low half of the computer’s clock, which counts hundredths of a second.',
  INHINT: 'Inhibit interrupts: the software has blocked interrupts while it changes data an interrupt also uses.',
  PRO: 'Proceed: carry on with the program, or answer yes to a flashing display.',
  ENTR: 'Enter: send the verb, noun or number just keyed, or answer a flashing display.',
  RSET: 'Reset: turn off the alarm lamps.',
  CLR: 'Clear: clear the number being keyed.',
  'KEY REL': 'Key release: give the display back to the program that is waiting for it.',
  'OPR ERR': 'Operator error: the computer did not accept a key. Press RSET.',
  PROG: 'Program alarm lamp: the software found a problem. VERB 05 NOUN 09 shows the alarm codes.',
  RESTART: 'The computer restarted. RSET turns the lamp off.',
  ALT: 'Altitude lamp: the landing radar is not giving good altitude data.',
  VEL: 'Velocity lamp: the landing radar is not giving good velocity data.',
};

/** Labels that are short forms only on their own (single letters and the like); `abbr()` knows them, `explain()` does not. */
const LABELS: Record<string, string> = {
  Z: 'Z register: the program counter, the address of the next instruction. A fixed-memory address shows as bank,address in octal.',
  A: 'A register: the accumulator, where the computer does its arithmetic.',
  L: 'L register: the lower half of a double-length number, and a second working register.',
  Q: 'Q register: the return address after a subroutine call.',
  BB: 'Both banks: the erasable bank and the fixed bank selected now, in one register.',
  'instr/s': 'Instructions per second: how many instructions the computer runs each second of real time.',
  EXTEND: 'The next instruction is one of the extended set.',
  T3RUPT: 'Timer 3 interrupt: runs the tasks the software put on its waitlist.',
  T4RUPT: 'Timer 4 interrupt: updates the DSKY and watches the IMU and the switches, every 120 ms.',
  T5RUPT: 'Timer 5 interrupt: runs the digital autopilot (DAP).',
  T6RUPT: 'Timer 6 interrupt: turns RCS jets off when the autopilot’s firing time is up.',
  KEYRUPT1: 'Keyboard interrupt: a key was pressed on the DSKY.',
  DOWNRUPT: 'Downlink interrupt: the telemetry system takes the next two words to send to the ground.',
  OG: 'Outer gimbal angle of the IMU.',
  IG: 'Inner gimbal angle of the IMU.',
  MG: 'Middle gimbal angle of the IMU. Near 90° the IMU loses its reference (gimbal lock).',
  Vert: 'Vertical speed: positive is up.',
  Horiz: 'Horizontal speed, across the ground.',
  'Att hold': 'Attitude hold: the autopilot holds the attitude, and the hand controller turns the LM.',
  FWD: 'Forward: the +Z axis, out of the front hatch.',
};

/** The DSKY's lamps and labels. */
export const DSKY_TITLES: Record<string, string> = {
  'UPLINK ACTY': 'Uplink activity: data is coming in from the ground.',
  'NO ATT': 'No attitude: the IMU is giving no attitude reference, for example while it is caged or turning on.',
  STBY: 'Standby: the computer is in standby.',
  'KEY REL': 'Key release: a program is waiting to show a display while you use the keyboard. Press KEY REL to let it.',
  'OPR ERR': TERMS['OPR ERR'],
  'PRIO DISP': 'Priority display.',
  'NO DAP': 'No digital autopilot.',
  TEMP: 'Temperature: the IMU is outside its temperature range.',
  'GIMBAL LOCK': 'The IMU’s middle gimbal angle is above 70°. At 90° the IMU would lose its reference.',
  PROG: TERMS.PROG,
  RESTART: TERMS.RESTART,
  TRACKER: 'Tracker fail: the rendezvous radar or the landing radar did not deliver good data.',
  ALT: TERMS.ALT,
  VEL: TERMS.VEL,
  'COMP ACTY': 'Computer activity: lit while the computer runs a job, dark while it idles.',
  'PROG display': 'Program: the number of the program (major mode) running now.',
  'VERB display': 'Verb: what the computer is doing, such as displaying or loading.',
  'NOUN display': 'Noun: what the verb acts on, such as the IMU gimbal angles.',
  VERB: 'Verb: key a two-digit verb number next.',
  NOUN: 'Noun: key a two-digit noun number next.',
  PRO: TERMS.PRO,
  ENTR: TERMS.ENTR,
  RSET: TERMS.RSET,
  CLR: TERMS.CLR,
};

/** Programs (major modes) the page mentions. */
const PROGRAMS: Record<string, string> = {
  '00': 'idling: the computer keeps its state up to date and waits for the crew.',
  '63': 'braking phase of the powered descent, from ignition to high gate.',
  '64': 'approach phase, from high gate, with the landing site in view.',
  '65': 'automatic landing phase.',
  '66': 'landing phase with the crew steering: the computer holds the rate of descent.',
  '68': 'landing confirmation.',
};

/** What the computer does when the alarm comes up. */
export type AlarmKind = 'alarm' | 'restart' | 'abort' | 'priority';

/** One line of a program's alarm list.  A code can have more than one, set by different routines. */
export interface AlarmVariant {
  text: string;
  setBy: string;
  kind: AlarmKind;
}

export interface Alarm {
  /** Five octal digits, as VERB 05 NOUN 09 shows it. */
  code: string;
  variants: AlarmVariant[];
  /** A note the list adds under the code, or ''. */
  note: string;
}

const KIND_TEXT: Record<AlarmKind, string> = {
  alarm: 'The program carries on.',
  restart: 'The computer does a software restart.',
  abort: 'The program is abandoned.',
  priority: 'A priority alarm.',
};

let verbs = new Map<string, string>();
let nouns = new Map<string, string>();
let alarms = new Map<string, Alarm>();
let listName = '';

/** Read the verb and noun names from a program's ASSEMBLY_AND_OPERATION_INFORMATION.agc. */
export function parseVerbsAndNouns(text: string): { verbs: Map<string, string>; nouns: Map<string, string> } {
  const found = { verbs: new Map<string, string>(), nouns: new Map<string, string>() };
  let into: Map<string, string> | null = null;
  for (const line of text.split('\n')) {
    if (/VERB LIST/.test(line)) into = found.verbs;
    else if (/IN THE FOLLOWING NOUN LIST|REGISTERS AND SCALING/.test(line)) into = null;
    else if (/^#\s*NORMAL NOUNS/.test(line)) into = found.nouns;
    const m = into && /^#\s+(\d\d)\s+(.+)$/.exec(line);
    if (!m) continue;
    const name = m[2].split('\t')[0].trim().replace(/,$/, '');
    if (name && !/^(SPARE|NOT IN USE)/.test(name) && !into!.has(m[1])) into!.set(m[1], name);
  }
  return found;
}

const expandTabs = (line: string) => {
  let out = '';
  for (const c of line) out += c === '\t' ? ' '.repeat(8 - (out.length % 8)) : c;
  return out;
};

/** Luminary marks the type before the text; Comanche names the alarm routine in a last column. */
function alarmKind(mark: string, routine: string): AlarmKind {
  if (routine) return /BAILOUT/.test(routine) ? 'restart' : /POODOO|CURTAINS/.test(routine) ? 'abort' : /PRIOLARM/.test(routine) ? 'priority' : 'alarm';
  return mark === '*' ? 'restart' : mark === '**' ? 'abort' : mark === 'P' ? 'priority' : 'alarm';
}

/**
 * Read the alarm codes from a program's ASSEMBLY_AND_OPERATION_INFORMATION.agc.
 * The list is laid out in columns, with tabs to every 8th: the code, a type
 * mark, the text from column 16, the routine that sets it from column 56, and
 * in Comanche the alarm routine from about column 96.  Lines without a code
 * continue the one above; a line starting before column 16 is a note.
 */
export function parseAlarms(text: string): Map<string, Alarm> {
  const found = new Map<string, Alarm>();
  const add = (to: string, more: string, gap: string) => (!more ? to : to ? `${to}${gap}${more}` : more);
  let inList = false;
  let last: Alarm | undefined;
  for (const raw of text.split('\n')) {
    if (/ALARM CODES FOR/.test(raw)) inList = true;
    if (!inList || !raw.startsWith('#') || /^# Page \d/.test(raw)) continue;
    if (/INDICATES|CHECKLIST CODES/.test(raw)) break;
    const line = expandTabs(` ${raw.slice(1)}`);
    const code = /^ {2}(\d{5})(?!\S)/.exec(line)?.[1];
    if (!code && !last) continue; // the list's headings
    // On a code line, columns 7 to 15 hold the type mark, if any.
    const mark = code ? line.slice(7, 16).trim() : '';
    const fields = [...(code ? ' '.repeat(16) + line.slice(16) : line).matchAll(/\S+(?: \S+)*/g)].map((m) => ({ at: m.index, text: m[0] }));
    if (!code && fields[0] && fields[0].at < 16) {
      last!.note = add(last!.note, fields.map((f) => f.text).join(' '), ' ');
      continue;
    }
    const words = fields.filter((f) => f.at < 56);
    const setBy = fields.filter((f) => f.at >= 56 && f.at < 90).map((f) => f.text).join(' ');
    const routine = fields.filter((f) => f.at >= 90).map((f) => f.text).join(' ');
    const said = words.map((f) => f.text).join(' ');
    if (code && code !== last?.code) {
      last = { code, variants: [{ text: said, setBy, kind: alarmKind(mark, routine) }], note: '' };
      found.set(code, last);
    } else if (code && words[0]?.at === 16) {
      last!.variants.push({ text: said, setBy, kind: alarmKind(mark, routine) });
    } else {
      // Text indented past column 16, or a line with no code: more of the line above.
      const variant = last!.variants.at(-1)!;
      variant.text = add(variant.text, said, ' ');
      // The same routine can be named again on the next line.
      if (!variant.setBy.split(/,\s*/).includes(setBy)) variant.setBy = add(variant.setBy, setBy, variant.setBy.endsWith(',') ? ' ' : ', ');
    }
  }
  return found;
}

/** Use this program's verb and noun names and alarm codes from now on. */
export function setProgramLists(listing: string | undefined, computer: string): void {
  ({ verbs, nouns } = listing ? parseVerbsAndNouns(listing) : { verbs: new Map(), nouns: new Map() });
  alarms = listing ? parseAlarms(listing) : new Map();
  listName = computer;
}

/** The loaded program's alarm codes, in order. */
export const alarmList = (): Alarm[] => [...alarms.values()];

/** The name of the loaded program, as the lists say whose they are. */
export const programName = () => listName;

const sentence = (s: string) => (/\.\)?$/.test(s) ? s : `${s}.`);

/** One line of an alarm, in words: what it means, what sets it, and what the computer does. */
export const alarmLine = (v: AlarmVariant) => `${sentence(v.text)}${v.setBy ? ` Set by ${sentence(v.setBy)}` : ''} ${KIND_TEXT[v.kind]}`;

/**
 * What an alarm code means, or undefined when the list does not have it.
 * A leading 4 to 7 is FAILREG's bit 15: more alarms came than its three words hold.
 */
export function describeAlarm(digits: string): string | undefined {
  let code = digits.padStart(5, '0');
  const overflow = code.length === 5 && code[0] >= '4' && code[0] <= '7';
  if (overflow) code = `${Number(code[0]) - 4}${code.slice(1)}`;
  const alarm = alarms.get(code);
  if (!alarm) return undefined;
  return [
    `Alarm ${code}, from ${listName}’s alarm list:`,
    ...alarm.variants.map(alarmLine),
    alarm.note && sentence(alarm.note),
    overflow ? `The leading ${digits[0]} means more alarms came than the computer has room for; this is the latest.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** What a short form or a verb, noun or program number means, or undefined. */
export function describe(term: string): string | undefined {
  const alarm = /^alarms? (\d{4,5})$/i.exec(term);
  if (alarm) return describeAlarm(alarm[1]);
  const code = /^(V|VERB |N|NOUN |P)(\d\d)$/.exec(term);
  if (code) {
    const [, kind, n] = code;
    if (kind === 'P') return `Program ${n}: ${PROGRAMS[n] ?? 'a major mode, chosen with VERB 37.'}`;
    const isVerb = kind.startsWith('V');
    const name = (isVerb ? verbs : nouns).get(n);
    const what = isVerb ? 'Verb' : 'Noun';
    return name ? `${what} ${n}, from ${listName}’s ${what.toLowerCase()} list: ${name}` : `${what} ${n}`;
  }
  return TERMS[term] ?? LABELS[term];
}

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** An <abbr> for a label, with its meaning on hover; plain text when the glossary does not know it. */
export function abbr(term: string, label = term): string {
  const title = describe(term);
  return title ? `<abbr title="${escapeHtml(title)}">${escapeHtml(label)}</abbr>` : escapeHtml(label);
}

const termPattern = Object.keys(TERMS)
  .sort((a, b) => b.length - a.length)
  .map((t) => t.replace(/[/]/g, '\\$&'))
  .join('|');
const PATTERN = new RegExp(`(?<![\\w-])(${termPattern}|[Aa]larms? \\d{4,5}|VERB \\d\\d|NOUN \\d\\d|[VNP]\\d\\d)(?![\\w-])`, 'g');

/** Plain text as HTML, with the first use of each known short form wrapped in an <abbr>. */
export function explain(text: string): string {
  const seen = new Set<string>();
  let out = '';
  let at = 0;
  for (const m of text.matchAll(PATTERN)) {
    const term = m[1];
    const key = term.replace(/^VERB /, 'V').replace(/^NOUN /, 'N').replace(/^alarms? 0*/i, 'alarm ');
    out += escapeHtml(text.slice(at, m.index));
    out += seen.has(key) ? escapeHtml(term) : abbr(term);
    seen.add(key);
    at = m.index + term.length;
  }
  return out + escapeHtml(text.slice(at));
}

/** Wrap known short forms in the text of an element, outside links, <kbd> and existing <abbr>s. */
export function explainIn(el: Element): void {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('a, abbr, kbd') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const html = explain(node.data);
    if (html === escapeHtml(node.data)) continue;
    const span = document.createElement('span');
    span.innerHTML = html;
    node.replaceWith(...span.childNodes);
  }
}
