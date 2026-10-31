// The LM panel: the RCS jets seen from above, the IMU gimbal angles and body
// rates, the PGNS mode switch, the IMU switch, and a hand controller
// (on-screen buttons or the keyboard).  In orbit it also shows the LM's true
// altitude, speeds, thrust and propellant, and the powered-descent checklist.
// The attitude ball (FDAI) it drives sits in its own panel, beside the 3D view.

import type { AGC } from '../agc/cpu.ts';
import type { DskyKey } from '../agc/dsky.ts';
import { DEG, gimbalMatrix, type Vec3 } from '../sim/attitude.ts';
import { JETS, type LunarModule, type ModeControl } from '../sim/lm.ts';
import { displayKeys } from './commands.ts';
import { DESCENT_STEPS, DescentChecklist, type DescentStep } from './descent-checklist.ts';
import { Fdai } from './fdai.ts';

/** Stick deflection for a held key or button; Shift gives full deflection. */
const STICK_NORMAL = 0.5;
/** Keep a jet lit for at least this long so 14 ms firings are visible. */
const JET_GLOW_MS = 140;
/** The descent engine's rated thrust, 10,500 lbf: 100% on the LM's thrust meter. */
const DPS_RATED = 10500 * 4.4482216;

/** Simulation speed while the checklist fast-forwards through a wait. */
const FAST_FORWARD = 20;

/** What the checklist's buttons need from the page. */
export interface ChecklistHost {
  /** Type DSKY keys at human speed (space separated; V, N, E stand for VERB, NOUN, ENTR). */
  type(keys: string): void;
  /** Light up the DSKY key the crew should press, or none. */
  cue(key: DskyKey | null): void;
  speed(): number;
  setSpeed(speed: number): void;
}

type StickInput = 'pitchUp' | 'pitchDown' | 'rollLeft' | 'rollRight' | 'yawLeft' | 'yawRight';

/** Stick axis (0 = X/yaw, 1 = Y/pitch, 2 = Z/roll) and sign for each input. */
const STICK_AXES: Record<StickInput, [number, 1 | -1]> = {
  pitchUp: [1, 1],
  pitchDown: [1, -1],
  rollLeft: [2, -1],
  rollRight: [2, 1],
  yawLeft: [0, 1],
  yawRight: [0, -1],
};

const STICK_KEYS: Record<string, StickInput> = {
  ArrowDown: 'pitchUp', // pull back: nose up
  ArrowUp: 'pitchDown',
  ArrowLeft: 'rollLeft',
  ArrowRight: 'rollRight',
  a: 'yawLeft',
  d: 'yawRight',
};

const STICK_BUTTONS: { input: StickInput; label: string; title: string }[] = [
  { input: 'pitchUp', label: 'Pitch ▲', title: 'Nose up (↓ key)' },
  { input: 'pitchDown', label: 'Pitch ▼', title: 'Nose down (↑ key)' },
  { input: 'rollLeft', label: 'Roll ◀', title: 'Roll left (← key)' },
  { input: 'rollRight', label: 'Roll ▶', title: 'Roll right (→ key)' },
  { input: 'yawLeft', label: 'Yaw ↺', title: 'Yaw left (A key)' },
  { input: 'yawRight', label: 'Yaw ↻', title: 'Yaw right (D key)' },
];

const MODES: { mode: ModeControl; label: string }[] = [
  { mode: 'off', label: 'Off' },
  { mode: 'attHold', label: 'Att hold' },
  { mode: 'auto', label: 'Auto' },
];

// ---- The jet diagram: the LM from above, forward (+Z) up the page, +Y to the right.

const QUAD = 52; // quad distance from the centre along Y and Z, in diagram units
const PLUME = 26;

function jetDiagram(): string {
  const base = [
    '<polygon class="hull" points="-30,-40 30,-40 44,-22 44,28 30,40 -30,40 -44,28 -44,-22" />',
    '<rect class="hatch" x="-10" y="-46" width="20" height="8" rx="2" />',
    '<text class="axis" x="0" y="-86" text-anchor="middle">FWD +Z</text>',
    '<text class="axis" x="96" y="4" text-anchor="end">+Y</text>',
  ];
  const quads: string[] = [];
  for (const [y, z, n] of [
    [1, 1, '1–4'],
    [1, -1, '5–8'],
    [-1, -1, '9–12'],
    [-1, 1, '13–16'],
  ] as const) {
    quads.push(`<rect class="quad" x="${y * QUAD - 13}" y="${-z * QUAD - 13}" width="26" height="26" rx="4" />`);
    quads.push(`<text class="quad-label" x="${y * (QUAD + 24)}" y="${-z * (QUAD + 28) + 4}" text-anchor="middle">${n}</text>`);
  }
  const jets: string[] = [];
  for (const jet of JETS) {
    const qy = Math.sign(jet.position[1]) * QUAD;
    const qz = -Math.sign(jet.position[2]) * QUAD; // screen y grows downwards
    const [fx, fy, fz] = jet.force;
    const kind = fx ? (fx > 0 ? 'down-firing' : 'up-firing') : 'horizontal';
    const title = `<title>Jet ${jet.number}, ${kind}</title>`;
    if (fx) {
      // Up- and down-firing jets: two dots on the quad's diagonal.
      const out = fx < 0 ? 7 : -7;
      const cx = qy + Math.sign(qy) * out;
      const cy = qz + Math.sign(qz) * out;
      jets.push(`<g class="jet vjet" data-jet="${jet.number - 1}">${title}<circle cx="${cx}" cy="${cy}" r="5.5" /></g>`);
    } else {
      // Horizontal jets: a nozzle and a plume along the exhaust, opposite to the force.
      const ex = -fy;
      const ey = fz; // exhaust along -Z is down the page
      const nx = qy + ex * 16;
      const ny = qz + ey * 16;
      const px = nx + ex * PLUME;
      const py = ny + ey * PLUME;
      const w = 7;
      const plume = ex ? `${nx},${ny - w} ${px},${py} ${nx},${ny + w}` : `${nx - w},${ny} ${px},${py} ${nx + w},${ny}`;
      jets.push(
        `<g class="jet hjet" data-jet="${jet.number - 1}">${title}<polygon class="plume" points="${plume}" />` +
          `<line x1="${qy}" y1="${qz}" x2="${nx}" y2="${ny}" /></g>`,
      );
    }
  }
  return `<svg class="jets" viewBox="-100 -100 200 200" role="img" aria-label="RCS jets seen from above; lit jets are firing">${[...base, ...quads, ...jets].join('')}</svg>`;
}

/** Gimbal angle as the DSKY shows it in noun 20: 000.00 to 359.99 degrees. */
const fmtAngle = (rad: number) => {
  const hundredths = ((Math.round((rad / DEG) * 100) % 36000) + 36000) % 36000;
  return (hundredths / 100).toFixed(2).padStart(6, '0');
};
const fmtRate = (rad: number) => {
  const hundredths = Math.round((rad / DEG) * 100);
  return `${hundredths < 0 ? '−' : '+'}${(Math.abs(hundredths) / 100).toFixed(2)}`;
};

export class LmPanel {
  /** Jets lit in the diagram on the last update (bit n-1 for jet n), including the glow time. */
  litJets = 0;
  private lm: LunarModule | null = null;
  private agc: AGC | null = null;
  private imodes33 = -1;
  private addressOf: (name: string) => number = () => -1;
  private checklist = new DescentChecklist();
  private step: DescentStep | null = null;
  private cued: DskyKey | null = null;
  /** The speed to go back to after fast-forward, or 0 when not fast-forwarding. */
  private resumeSpeed = 0;
  private readonly held = new Set<StickInput>();
  private full = false;
  private readonly jetEls: SVGGElement[] = [];
  private readonly glowUntil = new Float64Array(16);
  private readonly lastJetSeconds = new Float64Array(16);
  private readonly fdai: Fdai;
  private readonly els: {
    status: HTMLElement;
    gimbals: HTMLElement[];
    rates: HTMLElement[];
    descent: HTMLElement;
    descentValues: HTMLElement[];
    checklist: HTMLElement;
    step: Record<'count' | 'title' | 'detail' | 'act' | 'action' | 'timer', HTMLElement>;
    do: HTMLButtonElement;
    modes: HTMLButtonElement[];
    imu: HTMLInputElement;
  };

  constructor(
    readonly host: HTMLElement,
    private readonly checklistHost: ChecklistHost,
    /** Where the attitude ball goes: its own panel, beside the 3D view. */
    private readonly fdaiHost: HTMLElement,
  ) {
    host.innerHTML = `
      <div class="craft-head">
        <h2 id="craft-title">Lunar Module</h2>
        <span class="craft-status" id="craft-status" role="status">—</span>
      </div>
      <section class="checklist" aria-labelledby="checklist-label" hidden>
        <div class="checklist-head">
          <span class="k" id="checklist-label">Powered descent</span>
          <span class="mono" data-step="count"></span>
        </div>
        <div aria-live="polite">
          <p class="checklist-title" data-step="title"></p>
          <p class="checklist-detail" data-step="detail"></p>
        </div>
        <div class="checklist-act" data-step="act">
          <span class="checklist-action" data-step="action"></span>
          <button type="button" class="ctl checklist-do" data-do></button>
        </div>
        <p class="checklist-timer mono" data-step="timer"></p>
      </section>
      <div class="craft-body">
        ${jetDiagram()}
        <div class="craft-read">
          <div class="readout">
            <span class="k">IMU gimbals <small>deg</small></span>
            <div class="trio">
              <span><b>OG</b><i class="mono" data-g="0">—</i></span>
              <span><b>IG</b><i class="mono" data-g="1">—</i></span>
              <span><b>MG</b><i class="mono" data-g="2">—</i></span>
            </div>
          </div>
          <div class="readout">
            <span class="k">Body rates <small>deg/s</small></span>
            <div class="trio">
              <span><b>Yaw</b><i class="mono" data-r="0">—</i></span>
              <span><b>Pitch</b><i class="mono" data-r="1">—</i></span>
              <span><b>Roll</b><i class="mono" data-r="2">—</i></span>
            </div>
          </div>
          <div class="switches">
            <div class="seg" role="radiogroup" aria-label="PGNS mode control">
              ${MODES.map((m) => `<button type="button" role="radio" data-mode="${m.mode}" aria-checked="false">${m.label}</button>`).join('')}
            </div>
            <label class="toggle"><input type="checkbox" id="craft-imu" checked /> IMU operate</label>
          </div>
        </div>
      </div>
      <div class="readout descent" hidden>
        <span class="k">Descent <small>true values; the DSKY shows the computer's</small></span>
        <div class="trio five">
          <span><b>Altitude m</b><i class="mono" data-d="0">—</i></span>
          <span><b>Vert m/s</b><i class="mono" data-d="1">—</i></span>
          <span><b>Horiz m/s</b><i class="mono" data-d="2">—</i></span>
          <span><b>Thrust %</b><i class="mono" data-d="3">—</i></span>
          <span><b>Fuel kg</b><i class="mono" data-d="4">—</i></span>
        </div>
      </div>
      <div class="stick" aria-label="Hand controller: hold a button to turn">
        ${STICK_BUTTONS.map((b) => `<button type="button" class="ctl" data-stick="${b.input}" title="${b.title}">${b.label}</button>`).join('')}
        <button type="button" class="ctl kick" data-kick title="Give the LM a random turn and watch the autopilot stop it">Disturb</button>
      </div>
      <p class="hint">Keys: <kbd>↑</kbd><kbd>↓</kbd> pitch, <kbd>←</kbd><kbd>→</kbd> roll, <kbd>A</kbd><kbd>D</kbd> yaw, <kbd>Shift</kbd> full stick.</p>`;
    this.els = {
      status: host.querySelector('#craft-status')!,
      gimbals: [...host.querySelectorAll<HTMLElement>('[data-g]')],
      rates: [...host.querySelectorAll<HTMLElement>('[data-r]')],
      descent: host.querySelector('.descent')!,
      descentValues: [...host.querySelectorAll<HTMLElement>('[data-d]')],
      checklist: host.querySelector('.checklist')!,
      step: Object.fromEntries(
        [...host.querySelectorAll<HTMLElement>('[data-step]')].map((el) => [el.dataset.step, el]),
      ) as LmPanel['els']['step'],
      do: host.querySelector('[data-do]')!,
      modes: [...host.querySelectorAll<HTMLButtonElement>('[data-mode]')],
      imu: host.querySelector('#craft-imu')!,
    };
    for (const g of host.querySelectorAll<SVGGElement>('.jet')) this.jetEls[Number(g.dataset.jet)] = g;
    fdaiHost.innerHTML = `
      <h2 id="fdai-title">Attitude ball</h2>
      <canvas class="fdai-ball" role="img"
        aria-label="Attitude ball (FDAI), with the computer's attitude-error needles and the rate needles"
        title="The ball holds still in space while the LM turns around it: its centre shows where the front of the LM points. The needles across the ball come from the original software and point the way to turn to reach the attitude it wants. The pointers outside show how fast the LM turns."></canvas>
      <p class="fdai-key">Centre: where the LM points. Needles: the way to turn.</p>`;
    this.fdai = new Fdai(fdaiHost.querySelector('.fdai-ball')!);

    host.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const mode = target.closest<HTMLElement>('[data-mode]')?.dataset.mode as ModeControl | undefined;
      if (mode && this.lm) {
        this.lm.controls.mode = mode;
        this.syncSwitches();
      }
      if (target.closest('[data-kick]')) this.kick();
      if (target.closest('[data-do]')) this.doStep();
    });
    this.els.imu.addEventListener('change', () => {
      if (this.lm) this.lm.controls.imuOperate = this.els.imu.checked;
    });
    host.addEventListener('pointerdown', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-stick]');
      if (!btn) return;
      btn.setPointerCapture(e.pointerId);
      this.full = e.shiftKey;
      this.hold(btn.dataset.stick as StickInput, true);
    });
    const release = (e: PointerEvent) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-stick]');
      if (btn) this.hold(btn.dataset.stick as StickInput, false);
    };
    host.addEventListener('pointerup', release);
    host.addEventListener('pointercancel', release);

    document.addEventListener('keydown', (e) => this.onKey(e, true));
    document.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => {
      this.held.clear();
      this.applyStick();
    });
  }

  /** Show the panel for an LM, or hide it.  `addressOf` finds erasable symbols (-1 when missing). */
  attach(lm: LunarModule | null, agc: AGC | null, addressOf: (name: string) => number = () => -1): void {
    this.lm = lm;
    this.agc = agc;
    this.imodes33 = addressOf('IMODES33');
    this.addressOf = addressOf;
    this.restartChecklist();
    this.host.hidden = !lm;
    this.fdaiHost.hidden = !lm;
    this.held.clear();
    this.lastJetSeconds.fill(0);
    this.glowUntil.fill(0);
    this.litJets = 0;
    if (lm) {
      this.applyStick();
      this.syncSwitches();
    }
  }

  update(now: number): void {
    const lm = this.lm;
    if (!lm || !this.agc) return;
    const g = lm.gimbals;
    [g.outer, g.inner, g.middle].forEach((a, i) => (this.els.gimbals[i].textContent = fmtAngle(a)));
    lm.rate.forEach((r, i) => (this.els.rates[i].textContent = fmtRate(r)));
    this.fdai.draw(gimbalMatrix(g), lm.errorNeedles, lm.rate);
    this.litJets = 0;
    for (let j = 0; j < 16; j++) {
      if (lm.jetSeconds[j] > this.lastJetSeconds[j] || lm.jets & (1 << j)) this.glowUntil[j] = now + JET_GLOW_MS;
      this.lastJetSeconds[j] = lm.jetSeconds[j];
      this.jetEls[j]?.classList.toggle('on', this.glowUntil[j] > now);
      if (this.glowUntil[j] > now) this.litJets |= 1 << j;
    }
    this.els.status.textContent = this.status();
    this.els.descent.hidden = !lm.orbiting;
    if (lm.orbiting) this.updateDescent(lm);
    this.updateChecklist(lm, this.agc);
  }

  /** Start the descent checklist over: after a setup, or after a restart that cleared memory (`loaded` false). */
  restartChecklist(loaded = true): void {
    this.checklist = new DescentChecklist(this.addressOf, loaded);
    this.step = null;
    this.fastForward(false);
    this.cue(null);
  }

  /** The checklist's button: answer the DSKY, key in a verb, stop the engine, or fast-forward through a wait. */
  private doStep(): void {
    const step = this.step;
    if (!step) return;
    if (step.key) this.checklistHost.type(step.key);
    else if (step.keys) this.checklistHost.type(step.keys);
    else if (step.stopEngine && this.lm) this.lm.engine.armed = false;
    else if (step.wait) this.fastForward(!this.resumeSpeed);
  }

  private fastForward(on: boolean): void {
    const host = this.checklistHost;
    if (on && !this.resumeSpeed) {
      this.resumeSpeed = host.speed();
      host.setSpeed(FAST_FORWARD);
    } else if (!on && this.resumeSpeed) {
      // Leave the speed alone if it was changed by hand meanwhile.
      if (host.speed() === FAST_FORWARD) host.setSpeed(this.resumeSpeed);
      this.resumeSpeed = 0;
    }
  }

  private cue(key: DskyKey | null): void {
    if (key === this.cued) return;
    this.cued = key;
    this.checklistHost.cue(key);
  }

  private updateChecklist(lm: LunarModule, agc: AGC): void {
    const step = this.checklist.current(agc, lm);
    // A new step ends fast-forward, so every question and event comes at the chosen speed.
    if (step?.number !== this.step?.number || step?.key !== this.step?.key) this.fastForward(false);
    this.step = step;
    this.cue(step?.key ?? null);
    this.els.checklist.hidden = !step;
    if (!step) return;
    const set = (el: HTMLElement, html: string) => {
      if (el.innerHTML !== html) el.innerHTML = html;
    };
    const s = this.els.step;
    set(s.count, `Step ${step.number} of ${DESCENT_STEPS}`);
    set(s.title, step.title);
    set(s.detail, step.detail);
    set(s.timer, step.timer ?? '');
    s.timer.hidden = !step.timer;
    const canSpeedUp = step.wait && (this.resumeSpeed > 0 || this.checklistHost.speed() < FAST_FORWARD);
    const kbd = (keys: string) => displayKeys(keys).split(' ').map((k) => `<kbd>${k}</kbd>`).join(' ');
    set(
      s.action,
      step.key ? `Press the lit <kbd>${step.key}</kbd> key on the DSKY, or` : step.keys ? `Key ${kbd(step.keys)} on the DSKY, or` : '',
    );
    set(this.els.do, step.key ? 'Press it for me' : (step.button ?? `Fast-forward ${FAST_FORWARD}×`));
    this.els.do.setAttribute('aria-pressed', String(this.resumeSpeed > 0));
    if (!step.wait) this.els.do.removeAttribute('aria-pressed');
    s.act.hidden = !(step.key || step.keys || step.stopEngine || canSpeedUp);
  }

  private updateDescent(lm: LunarModule): void {
    const r = Math.hypot(...lm.position);
    const up = lm.position.map((x) => x / r);
    const ground = lm.groundVelocity();
    const vertical = ground.reduce((sum, v, k) => sum + v * up[k], 0);
    const horizontal = Math.sqrt(Math.max(0, ground.reduce((sum, v) => sum + v * v, 0) - vertical * vertical));
    const signed = (x: number, digits: number) => `${x < 0 ? '−' : '+'}${Math.abs(x).toFixed(digits)}`;
    [
      Math.max(0, Math.round(r - lm.surfaceRadius)).toLocaleString('en-US'),
      signed(vertical, 1),
      horizontal.toFixed(1),
      ((100 * lm.engine.thrust) / DPS_RATED).toFixed(0),
      Math.round(lm.engine.propellant).toLocaleString('en-US'),
    ].forEach((text, i) => (this.els.descentValues[i].textContent = text));
  }

  private status(): string {
    const lm = this.lm!;
    const agc = this.agc!;
    const c = lm.controls;
    if (lm.landed) return 'On the surface';
    if (!c.imuOperate) return 'IMU off: no attitude reference';
    if (!(agc.channels[0o30] & 0o20000)) return 'IMU turning on (90 s)';
    if (this.imodes33 >= 0 && agc.mem[this.imodes33] & 0o40) return 'Waiting for the IMU';
    if (c.mode === 'off') return 'Autopilot off';
    return c.mode === 'auto' ? 'Autopilot: auto' : 'Autopilot: attitude hold';
  }

  private syncSwitches(): void {
    const lm = this.lm;
    if (!lm) return;
    for (const b of this.els.modes) b.setAttribute('aria-checked', String(b.dataset.mode === lm.controls.mode));
    this.els.imu.checked = lm.controls.imuOperate;
  }

  private kick(): void {
    if (!this.lm) return;
    const axis = Math.floor(Math.random() * 3);
    const rate: Vec3 = [...this.lm.rate];
    rate[axis] += (Math.random() < 0.5 ? -1 : 1) * (1 + Math.random()) * DEG;
    this.lm.rate = rate;
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (!this.lm || this.host.hidden) return;
    const input = STICK_KEYS[e.key] ?? STICK_KEYS[e.key.toLowerCase()];
    if (!input) {
      if (e.key === 'Shift') {
        this.full = down;
        this.applyStick();
      }
      return;
    }
    // A press in a text field or the listing is not for the stick; a release always is.
    const target = e.target as HTMLElement;
    if (down && (target.closest('input, select, textarea, .source') || e.metaKey || e.ctrlKey || e.altKey)) return;
    e.preventDefault();
    this.full = e.shiftKey;
    this.hold(input, down);
  }

  private hold(input: StickInput, down: boolean): void {
    if (down) this.held.add(input);
    else this.held.delete(input);
    for (const b of this.host.querySelectorAll<HTMLElement>('[data-stick]')) {
      b.classList.toggle('held', this.held.has(b.dataset.stick as StickInput));
    }
    this.applyStick();
  }

  private applyStick(): void {
    if (!this.lm) return;
    const stick: Vec3 = [0, 0, 0];
    const amount = this.full ? 1 : STICK_NORMAL;
    for (const input of this.held) {
      const [axis, sign] = STICK_AXES[input];
      stick[axis] += sign * amount;
    }
    this.lm.controls.stick = stick;
  }
}
