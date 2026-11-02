// The DSKY drawn in the browser: indicator lamps, the electroluminescent
// display, and the 19-key keyboard.

import type { DskyKey, DskyLamps, DskyState } from '../agc/dsky.ts';
import { describe, describeAlarm, DSKY_TITLES, escapeHtml, programName } from './glossary.ts';

const SEGMENTS: Record<string, string> = {
  a: '6.5,4 9,1.5 23,1.5 25.5,4 23,6.5 9,6.5',
  b: '28,5 30.5,7.5 30.5,22.5 28,25 25.5,22.5 25.5,7.5',
  c: '28,27 30.5,29.5 30.5,44.5 28,47 25.5,44.5 25.5,29.5',
  d: '6.5,48 9,45.5 23,45.5 25.5,48 23,50.5 9,50.5',
  e: '4,27 6.5,29.5 6.5,44.5 4,47 1.5,44.5 1.5,29.5',
  f: '4,5 6.5,7.5 6.5,22.5 4,25 1.5,22.5 1.5,7.5',
  g: '6.5,26 9,23.5 23,23.5 25.5,26 23,28.5 9,28.5',
};
const DIGIT_SEGMENTS: Record<string, string> = {
  '0': 'abcdef',
  '1': 'bc',
  '2': 'abdeg',
  '3': 'abcdg',
  '4': 'bcfg',
  '5': 'acdfg',
  '6': 'acdefg',
  '7': 'abc',
  '8': 'abcdefg',
  '9': 'abcdfg',
  ' ': '',
};

function digitSvg(): string {
  const polys = Object.entries(SEGMENTS)
    .map(([name, pts]) => `<polygon class="seg" data-seg="${name}" points="${pts}"/>`)
    .join('');
  return `<svg class="digit" viewBox="0 0 32 52" aria-hidden="true">${polys}</svg>`;
}
function signSvg(): string {
  return (
    '<svg class="digit sign" viewBox="0 0 24 52" aria-hidden="true">' +
    '<polygon class="seg" data-seg="h" points="2,26 4.5,23.5 19.5,23.5 22,26 19.5,28.5 4.5,28.5"/>' +
    '<polygon class="seg" data-seg="v" points="12,15 14.5,17.5 14.5,23 12,24.5 9.5,23 9.5,17.5"/>' +
    '<polygon class="seg" data-seg="v" points="12,27.5 14.5,29 14.5,34.5 12,37 9.5,34.5 9.5,29"/>' +
    '</svg>'
  );
}

interface LampDef {
  id: keyof DskyLamps;
  label: string;
  color: 'white' | 'amber';
  lmOnly?: boolean;
}
// The two columns of the caution and status panel, top to bottom.
/** A key's hover text: what it does, and its key on the computer keyboard. */
const keyTitle = (k: { key: string; hint: string }) => {
  const what = describe(k.key) ?? DSKY_TITLES[k.key];
  return what ? ` title="${escapeHtml(`${what} Keyboard: ${k.hint}.`)}"` : '';
};

const LAMP_COLUMNS: (LampDef | null)[][] = [
  [
    { id: 'uplinkActy', label: 'UPLINK ACTY', color: 'white' },
    { id: 'noAtt', label: 'NO ATT', color: 'white' },
    { id: 'stby', label: 'STBY', color: 'white' },
    { id: 'keyRel', label: 'KEY REL', color: 'white' },
    { id: 'oprErr', label: 'OPR ERR', color: 'white' },
    { id: 'prioDisp', label: 'PRIO DISP', color: 'white', lmOnly: true },
    { id: 'noDap', label: 'NO DAP', color: 'white', lmOnly: true },
  ],
  [
    { id: 'temp', label: 'TEMP', color: 'amber' },
    { id: 'gimbalLock', label: 'GIMBAL LOCK', color: 'amber' },
    { id: 'prog', label: 'PROG', color: 'amber' },
    { id: 'restart', label: 'RESTART', color: 'amber' },
    { id: 'tracker', label: 'TRACKER', color: 'amber' },
    { id: 'alt', label: 'ALT', color: 'amber', lmOnly: true },
    { id: 'vel', label: 'VEL', color: 'amber', lmOnly: true },
  ],
];

interface KeyDef {
  key: DskyKey;
  label: string;
  area: string;
  hint: string;
}
const KEYS: KeyDef[] = [
  { key: 'VERB', label: 'VERB', area: 'verb', hint: 'V' },
  { key: 'NOUN', label: 'NOUN', area: 'noun', hint: 'N' },
  { key: '+', label: '+', area: 'plus', hint: '+' },
  { key: '-', label: '−', area: 'minus', hint: '−' },
  { key: '0', label: '0', area: 'k0', hint: '0' },
  { key: '7', label: '7', area: 'k7', hint: '7' },
  { key: '4', label: '4', area: 'k4', hint: '4' },
  { key: '1', label: '1', area: 'k1', hint: '1' },
  { key: '8', label: '8', area: 'k8', hint: '8' },
  { key: '5', label: '5', area: 'k5', hint: '5' },
  { key: '2', label: '2', area: 'k2', hint: '2' },
  { key: '9', label: '9', area: 'k9', hint: '9' },
  { key: '6', label: '6', area: 'k6', hint: '6' },
  { key: '3', label: '3', area: 'k3', hint: '3' },
  { key: 'CLR', label: 'CLR', area: 'clr', hint: 'C' },
  { key: 'PRO', label: 'PRO', area: 'pro', hint: 'P' },
  { key: 'KEY REL', label: 'KEY<br>REL', area: 'keyrel', hint: 'K' },
  { key: 'ENTR', label: 'ENTR', area: 'entr', hint: 'Enter' },
  { key: 'RSET', label: 'RSET', area: 'rset', hint: 'R' },
];

/** Physical keyboard shortcuts. */
export const KEYBOARD_MAP: Record<string, DskyKey> = {
  v: 'VERB',
  n: 'NOUN',
  '+': '+',
  '=': '+',
  '-': '-',
  c: 'CLR',
  p: 'PRO',
  k: 'KEY REL',
  Enter: 'ENTR',
  e: 'ENTR',
  r: 'RSET',
  ...Object.fromEntries('0123456789'.split('').map((d) => [d, d as DskyKey])),
};

export interface DskyHandlers {
  onKey: (key: DskyKey) => void;
  onPro: (down: boolean) => void;
}

export class DskyView {
  readonly el: HTMLElement;
  private digits = new Map<string, SVGElement[]>();
  private lampEls = new Map<string, HTMLElement>();
  private compActy!: HTMLElement;
  private vnBlock!: HTMLElement;
  private registers: HTMLElement[] = [];
  private last = '';

  constructor(parent: HTMLElement, handlers: DskyHandlers) {
    this.el = document.createElement('div');
    this.el.className = 'dsky';
    this.el.innerHTML = this.template();
    parent.appendChild(this.el);

    for (const el of this.el.querySelectorAll<HTMLElement>('[data-field]')) {
      this.digits.set(el.dataset.field!, Array.from(el.querySelectorAll('svg')));
    }
    for (const el of this.el.querySelectorAll<HTMLElement>('[data-lamp]')) this.lampEls.set(el.dataset.lamp!, el);
    this.compActy = this.el.querySelector('.comp-acty')!;
    this.vnBlock = this.el.querySelector('.vn')!;
    this.registers = [...this.el.querySelectorAll<HTMLElement>('.register')];

    for (const btn of this.el.querySelectorAll<HTMLButtonElement>('button[data-key]')) {
      const key = btn.dataset.key as DskyKey;
      if (key === 'PRO') {
        btn.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          btn.setPointerCapture(e.pointerId);
          handlers.onPro(true);
        });
        const up = () => handlers.onPro(false);
        btn.addEventListener('pointerup', up);
        btn.addEventListener('pointercancel', up);
        btn.addEventListener('keydown', (e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            handlers.onKey('PRO');
          }
        });
      } else {
        btn.addEventListener('click', () => handlers.onKey(key));
      }
    }
  }

  setVehicle(vehicle: 'LM' | 'CM'): void {
    for (const col of LAMP_COLUMNS) {
      for (const lamp of col) {
        if (!lamp?.lmOnly) continue;
        const el = this.lampEls.get(lamp.id)!;
        el.classList.toggle('unused', vehicle === 'CM');
      }
    }
  }

  /** Light up the key the crew should press next (none for null). */
  cue(key: DskyKey | null): void {
    for (const btn of this.el.querySelectorAll<HTMLElement>('button[data-key]')) {
      btn.classList.toggle('cue', btn.dataset.key === key);
    }
  }

  /** Briefly show a key as pressed (for keys typed by commands or the keyboard). */
  flashKey(key: DskyKey): void {
    const btn = this.el.querySelector<HTMLElement>(`button[data-key="${CSS.escape(key)}"]`);
    if (!btn) return;
    btn.classList.add('pressed');
    setTimeout(() => btn.classList.remove('pressed'), 140);
  }

  update(state: DskyState): void {
    const key = JSON.stringify(state);
    if (key === this.last) return;
    this.last = key;
    this.setDigits('prog', state.prog);
    this.setDigits('verb', state.verb);
    this.setDigits('noun', state.noun);
    state.r.forEach((r, i) => {
      this.setSign(`r${i + 1}s`, r[0]);
      this.setDigits(`r${i + 1}`, r.slice(1));
    });
    this.vnBlock.classList.toggle('blank', state.vnBlank);
    // VERB 05 NOUN 09 shows the alarm codes in R1 to R3: hover over or tap one for its meaning.
    const alarms = state.verb === '05' && state.noun === '09';
    this.registers.forEach((el, i) => {
      const code = state.r[i].slice(1).trim();
      if (!alarms || !/^\d{5}$/.test(code)) el.removeAttribute('title');
      else el.title = code === '00000' ? 'No alarm.' : (describeAlarm(code) ?? `Alarm ${code} is not in ${programName()}’s alarm list.`);
    });
    this.compActy.classList.toggle('on', state.lamps.compActy);
    for (const [id, el] of this.lampEls) el.classList.toggle('on', !!state.lamps[id as keyof DskyLamps]);
  }

  private setDigits(field: string, text: string): void {
    const svgs = this.digits.get(field)!;
    svgs.forEach((svg, i) => {
      const on = DIGIT_SEGMENTS[text[i] ?? ' '] ?? '';
      for (const seg of svg.querySelectorAll<SVGElement>('.seg')) seg.classList.toggle('on', on.includes(seg.dataset.seg!));
    });
  }

  private setSign(field: string, sign: string): void {
    const svg = this.digits.get(field)![0];
    for (const seg of svg.querySelectorAll<SVGElement>('.seg')) {
      const s = seg.dataset.seg;
      seg.classList.toggle('on', sign === '+' || (sign === '-' && s === 'h'));
    }
  }

  private template(): string {
    const lamps = LAMP_COLUMNS.map(
      (col) =>
        `<div class="lamp-col">${col
          .map((l) =>
            l
              ? `<div class="lamp ${l.color}" data-lamp="${l.id}" title="${escapeHtml(DSKY_TITLES[l.label] ?? '')}"><span>${l.label.replace(' ', '<br>')}</span></div>`
              : '<div class="lamp"></div>',
          )
          .join('')}</div>`,
    ).join('');
    const digits = (field: string, n: number) => `<div class="digits" data-field="${field}">${digitSvg().repeat(n)}</div>`;
    const register = (n: number) =>
      `<div class="register"><div class="digits sign-cell" data-field="r${n}s">${signSvg()}</div>${digits(`r${n}`, 5)}</div>`;
    const keys = KEYS.map(
      (k) =>
        `<button type="button" class="key key-${k.area}" style="grid-area:${k.area}" data-key="${k.key}" aria-label="${k.label.replace('<br>', ' ')} (keyboard: ${k.hint})"${keyTitle(k)}><span>${k.label}</span></button>`,
    ).join('');
    return `
      <div class="dsky-upper">
        <div class="lamp-panel" aria-label="Caution and status lamps">${lamps}</div>
        <div class="el-panel" aria-label="Display">
          <div class="el-grid">
            <div class="el-label comp-acty" title="${escapeHtml(DSKY_TITLES['COMP ACTY'])}">COMP<br>ACTY</div>
            <div class="el-field"><div class="el-label" title="${escapeHtml(DSKY_TITLES['PROG display'])}">PROG</div>${digits('prog', 2)}</div>
            <div class="vn">
              <div class="el-field"><div class="el-label" title="${escapeHtml(DSKY_TITLES['VERB display'])}">VERB</div>${digits('verb', 2)}</div>
              <div class="el-field"><div class="el-label" title="${escapeHtml(DSKY_TITLES['NOUN display'])}">NOUN</div>${digits('noun', 2)}</div>
            </div>
          </div>
          <div class="el-bar"></div>${register(1)}
          <div class="el-bar"></div>${register(2)}
          <div class="el-bar"></div>${register(3)}
        </div>
      </div>
      <div class="keyboard" role="group" aria-label="DSKY keyboard">${keys}</div>`;
  }
}
