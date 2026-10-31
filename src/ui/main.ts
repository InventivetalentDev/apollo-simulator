import './styles.css';
import { INTERRUPT_NAMES, overflowCorrected, REG, type AGC } from '../agc/cpu.ts';
import { readDsky, type DskyKey } from '../agc/dsky.ts';
import { PROGRAMS, sourceLink, type ProgramInfo } from '../programs.ts';
import type { LunarModule } from '../sim/lm.ts';
import { ropeHash } from '../yul/rope-hash.ts';
import { assembleSources, type AssembleResponse } from './assemble-sources.ts';
import { COMMANDS, displayKeys, parseKeys } from './commands.ts';
import { DskyView, KEYBOARD_MAP } from './dsky-view.ts';
import { LmPanel } from './lm-panel.ts';
import type { LmView } from './lm-view.ts';
import { Machine } from './machine.ts';
import { formatAddress, ropeIndexOf, SourceView, type SourceLinker } from './source-view.ts';

interface LoadedProgram {
  info: ProgramInfo;
  response: AssembleResponse;
  expectedRopeHash: string | null;
  /** Links a file or line to the same text on GitHub, at the submodule commit. */
  link: SourceLinker;
  /** Labels on code, sorted by rope index, for naming the routine at any address. */
  labelIndex: Int32Array;
  labelNames: string[];
  jobTracker: AGC['jobTracker'];
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const els = {
  runToggle: $<HTMLButtonElement>('#run-toggle'),
  step: $<HTMLButtonElement>('#step'),
  speed: $<HTMLSelectElement>('#speed'),
  power: $<HTMLButtonElement>('#power'),
  follow: $<HTMLSelectElement>('#follow'),
  loading: $('#loading'),
  loadingText: $('#loading-text'),
  status: $('#assembly-status'),
  routine: $('#cpu-routine'),
  location: $('#cpu-location'),
  time: $('#cpu-time'),
  regs: {
    z: $('#reg-z'),
    a: $('#reg-a'),
    l: $('#reg-l'),
    q: $('#reg-q'),
    bb: $('#reg-bb'),
  },
  chips: $('#cpu-chips'),
  rupts: $('#cpu-rupts'),
  commands: $('#command-list'),
};

let machine: Machine | null = null;
let program: LoadedProgram | null = null;
const cache = new Map<string, LoadedProgram>();
let loadToken = 0;

const dsky = new DskyView($('#dsky-host'), {
  onKey: (key) => typeKeys([key]),
  onPro: (down) => {
    machine?.holdPro(down);
    if (down) dsky.flashKey('PRO');
  },
});

const craft = new LmPanel($('#craft'));
let view: LmView | null = null;

const source = new SourceView($('.source'), {
  onUserNavigate: () => {
    if (els.follow.value !== 'off') els.follow.value = 'off';
  },
});

function typeKeys(keys: DskyKey[]): void {
  if (!machine) return;
  machine.type(keys);
  keys.forEach((k, i) => setTimeout(() => dsky.flashKey(k), (i * 140) / Math.max(1, machine?.speed ?? 1)));
  if (els.follow.value === 'off') els.follow.value = 'jobs';
}

// ---- Commands

function renderCommands(vehicle: 'LM' | 'CM'): void {
  els.commands.innerHTML = COMMANDS.map((c, i) =>
    c.vehicle && c.vehicle !== vehicle
      ? ''
      : `<li><button type="button" class="cmd${c.keys.length > 24 ? ' long' : ''}" data-cmd="${i}"><span class="title">${c.title}</span>` +
        `<span class="keys">${displayKeys(c.keys)}</span><span class="detail">${c.detail}</span></button></li>`,
  ).join('');
}
els.commands.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-cmd]');
  if (!btn) return;
  typeKeys(parseKeys(COMMANDS[Number(btn.dataset.cmd)].keys));
  // On a narrow screen the DSKY is above the list: bring it back into view.
  if (window.matchMedia('(max-width: 900px)').matches) {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    dsky.el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  }
});

// ---- Keyboard

document.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  if (target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (target.closest('button') && (e.key === 'Enter' || e.key === ' ')) return;
  const key = KEYBOARD_MAP[e.key] ?? KEYBOARD_MAP[e.key.toLowerCase()];
  if (!key) return;
  e.preventDefault();
  typeKeys([key]);
});

// ---- Run controls

function setRunning(running: boolean): void {
  if (!machine) return;
  machine.running = running;
  els.runToggle.textContent = running ? 'Pause' : 'Run';
  els.runToggle.classList.toggle('paused', !running);
  els.step.disabled = running;
  refreshPanels(true);
}
els.runToggle.addEventListener('click', () => setRunning(!machine?.running));
els.step.addEventListener('click', () => {
  if (!machine) return;
  machine.stepInstruction();
  if (els.follow.value === 'off') els.follow.value = 'all';
  refreshPanels(true);
});
els.speed.addEventListener('change', () => {
  if (machine) machine.speed = Number(els.speed.value);
});
els.power.addEventListener('click', () => {
  if (!machine) return;
  machine.reset();
  refreshPanels(true);
});

for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-program]')) {
  btn.addEventListener('click', () => {
    const id = btn.dataset.program!;
    if (program?.info.id === id) return;
    void loadProgram(id);
  });
}

// ---- Loading and assembling

interface SourceBundle {
  files: Record<string, string>;
  expectedRopeHash: string | null;
  sourceCommit: string;
}

// The sources come gzipped (see vite.config.ts). If a host labels the file
// with Content-Encoding: gzip, the browser unzips it before we see it, so check
// for the gzip header bytes instead of assuming.
async function fetchSources(info: ProgramInfo): Promise<SourceBundle> {
  const url = `agc/${info.id}.json.gz`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const text = gzipped
    ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
    : new TextDecoder().decode(bytes);
  return JSON.parse(text);
}

function assembleInWorker(programId: string, files: Record<string, string>): Promise<AssembleResponse> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./assemble.worker.ts', import.meta.url), { type: 'module' });
    } catch (err) {
      reject(err);
      return;
    }
    worker.onmessage = (e) => {
      worker.terminate();
      if (e.data.ok) resolve(e.data.response);
      else reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'Worker failed'));
    };
    worker.postMessage({ programId, files });
  });
}

function buildLabelIndex(response: AssembleResponse): { labelIndex: Int32Array; labelNames: string[] } {
  const r = response.result;
  const entries: [number, string][] = [];
  for (const s of r.symbols) {
    if (s.constant || s.line < 0 || r.lineWordStart[s.line] < 0) continue;
    const idx = ropeIndexOf(s.value);
    if (idx >= 0) entries.push([idx, s.name]);
  }
  entries.sort((a, b) => a[0] - b[0]);
  return { labelIndex: Int32Array.from(entries.map((e) => e[0])), labelNames: entries.map((e) => e[1]) };
}

/** Which rope words belong to the Executive's dispatching code and to the interpreter. */
function buildJobTracker(response: AssembleResponse): AGC['jobTracker'] {
  const r = response.result;
  const fileOf = (name: string) => r.files.findIndex((f) => f.name === name);
  const exclude = new Uint8Array(r.rope.length);
  const interpreter = new Uint8Array(r.rope.length);
  const executive = [fileOf('EXECUTIVE.agc'), fileOf('INTER-BANK_COMMUNICATION.agc')];
  const interp = fileOf('INTERPRETER.agc');
  for (let i = 0; i < r.rope.length; i++) {
    const line = r.ropeLine[i];
    if (line < 0) continue;
    const f = r.files.findIndex((ff) => line >= ff.firstLine && line < ff.firstLine + ff.lineCount);
    if (executive.includes(f)) exclude[i] = 1;
    if (f === interp) interpreter[i] = 1;
  }
  const addressOf = (name: string) => r.symbols.find((s) => s.name === name)?.value ?? -1;
  const locAddress = addressOf('LOC');
  const banksetAddress = addressOf('BANKSET');
  if (locAddress < 0 || banksetAddress < 0 || locAddress > 0o1377 || banksetAddress > 0o1377) return null;
  return { exclude, interpreter, locAddress, banksetAddress };
}

/** Loads the 3D view the first time an LM is shown, then attaches the LM. */
async function attachView(lm: LunarModule, token: number): Promise<void> {
  if (!view) {
    try {
      const { LmView } = await import('./lm-view.ts');
      view ??= new LmView($('#view3d'));
    } catch (err) {
      console.error('Could not load the 3D view', err);
      return;
    }
  }
  if (token === loadToken) view.attach(lm);
}

async function loadProgram(id: string): Promise<void> {
  const info = PROGRAMS.find((p) => p.id === id)!;
  const token = ++loadToken;
  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-program]')) {
    btn.setAttribute('aria-checked', String(btn.dataset.program === id));
  }
  machine = null;
  craft.attach(null, null);
  view?.attach(null);
  dsky.setVehicle(info.vehicle);
  renderCommands(info.vehicle);
  let loaded = cache.get(id);
  if (!loaded) {
    els.loading.hidden = false;
    els.loadingText.textContent = `Loading the original ${info.id} source…`;
    try {
      const { files, expectedRopeHash, sourceCommit } = await fetchSources(info);
      if (token !== loadToken) return;
      const lines = Object.values(files).reduce((n, t) => n + t.split('\n').length, 0);
      els.loadingText.textContent = `Assembling ${lines.toLocaleString()} lines of AGC source…`;
      let response: AssembleResponse;
      try {
        response = await assembleInWorker(id, files);
      } catch {
        await new Promise((r) => setTimeout(r, 30)); // let the message paint
        response = assembleSources({ programId: id, files });
      }
      if (token !== loadToken) return;
      const link: SourceLinker = (file, line) => sourceLink(sourceCommit, info.directory, file, line);
      loaded = { info, response, expectedRopeHash, link, ...buildLabelIndex(response), jobTracker: buildJobTracker(response) };
      cache.set(id, loaded);
    } catch (err) {
      els.loadingText.textContent = String(err instanceof Error ? err.message : err);
      return;
    }
  }
  program = loaded;
  heatBase = new Map();
  lastLocation = ''; // both programs share file names, so the link must be rebuilt
  const { response } = loaded;
  source.load(
    response.result,
    response.texts,
    (info.corrections ?? []).map((c) => ({ file: c.file, line: c.line, reason: c.reason })),
    loaded.link,
  );
  els.loading.hidden = true;
  showAssemblyStatus(loaded);
  machine = new Machine(response.result.rope, info.vehicle);
  machine.agc.jobTracker = loaded.jobTracker;
  craft.attach(machine.lm, machine.agc, response.result.symbols.find((s) => s.name === 'IMODES33')?.value ?? -1);
  if (machine.lm) void attachView(machine.lm, token);
  machine.speed = Number(els.speed.value);
  setRunning(true);
  try {
    localStorage.setItem('agc-program', id);
  } catch {
    // storage unavailable: nothing to remember
  }
}

function showAssemblyStatus(p: LoadedProgram): void {
  const r = p.response.result;
  const lines = r.files.reduce((n, f) => n + f.lineCount, 0);
  const fatals = r.messages.filter((m) => m.fatal).length;
  const hash = ropeHash(r.rope, r.used);
  const parts = [
    `Assembled in your browser: ${r.files.length} files, ${lines.toLocaleString()} lines → 36 banks of core rope in ${Math.round(p.response.ms)} ms.`,
  ];
  if (fatals) parts.push(`<span class="warn">${fatals} assembly errors.</span>`);
  if (p.expectedRopeHash) {
    parts.push(
      hash === p.expectedRopeHash
        ? '<span class="ok">Every word matches the 1969 listing.</span>'
        : '<span class="warn">Differs from the 1969 listing.</span>',
    );
  }
  const fixes = p.response.corrections.filter((c) => c.applied).length;
  if (fixes) parts.push(`${fixes} transcription errors in the upstream copy corrected (lines marked in amber).`);
  if (p.info.includeAliases) parts.push(`${Object.keys(p.info.includeAliases).length} renamed include files mapped.`);
  els.status.innerHTML = parts.join(' ');
}

// ---- Panels

function routineAt(ropeIndex: number): string {
  if (!program || ropeIndex < 0) return '—';
  const idx = program.labelIndex;
  let lo = 0;
  let hi = idx.length - 1;
  if (hi < 0 || idx[0] > ropeIndex) return '—';
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (idx[mid] <= ropeIndex) lo = mid;
    else hi = mid - 1;
  }
  if (idx[lo] >> 10 !== ropeIndex >> 10) return '—';
  const off = ropeIndex - idx[lo];
  return off ? `${program.labelNames[lo]} +${off}` : program.labelNames[lo];
}

function ropeLocation(ropeIndex: number): string {
  if (ropeIndex < 0) return '';
  const bank = ropeIndex >> 10;
  const off = ropeIndex & 0o1777;
  if (bank === 2 || bank === 3) return formatAddress(bank * 0o2000 + off);
  return formatAddress(0o10000 + ropeIndex);
}

const oct = (v: number, w = 5) => v.toString(8).padStart(w, '0');
let lastPanelUpdate = 0;
let lastLocation = '';
let heatBase = new Map<number, number>();

function refreshPanels(force = false): void {
  if (!machine || !program) return;
  const now = performance.now();
  if (!force && now - lastPanelUpdate < 160) return;
  lastPanelUpdate = now;
  const agc = machine.agc;
  const r = program.response.result;

  const ropeIndex = agc.lastRopeIndex;
  const lineId = ropeIndex >= 0 ? r.ropeLine[ropeIndex] : -1;
  const loc = source.locate(lineId);
  els.routine.textContent = routineAt(ropeIndex);
  const context = agc.isr ? `interrupt ${INTERRUPT_NAMES[agc.isr]}` : agc.channels[0o11] & 2 ? 'job' : 'idle loop';
  const where = loc ? `${r.files[loc.file].name}:${loc.line}` : '';
  const location = where ? `${where} · ${ropeLocation(ropeIndex)} · ${context}` : context;
  // Rewrite only on change, so the link stays clickable while the computer runs.
  if (location !== lastLocation) {
    lastLocation = location;
    if (loc) {
      const a = document.createElement('a');
      a.href = program.link(r.files[loc.file].name, loc.line);
      a.target = '_blank';
      a.rel = 'noopener';
      a.title = 'Open this line on GitHub';
      a.textContent = where;
      els.location.replaceChildren(a, ` · ${ropeLocation(ropeIndex)} · ${context}`);
    } else {
      els.location.textContent = context;
    }
  }

  const cs = agc.mem[REG.TIME2] * 16384 + agc.mem[REG.TIME1];
  const s = Math.floor(cs / 100);
  els.time.textContent = `${String(Math.floor(s / 3600)).padStart(3, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  const z = agc.mem[REG.Z] & 0o7777;
  const fb = (agc.mem[REG.FB] >> 10) & 0o37;
  els.regs.z.textContent = z >= 0o2000 && z < 0o4000 ? `${oct(fb + ((fb & 0o30) === 0o30 && agc.outputChannel7 & 0o100 ? 0o10 : 0), 2)},${oct(z, 4)}` : oct(z, 4);
  const a = agc.mem[REG.A];
  els.regs.a.textContent = oct(overflowCorrected(a)) + ((a & 0o140000) === 0o40000 || (a & 0o140000) === 0o100000 ? ' OV' : '');
  els.regs.l.textContent = oct(overflowCorrected(agc.mem[REG.L]));
  els.regs.q.textContent = oct(overflowCorrected(agc.mem[REG.Q]));
  els.regs.bb.textContent = oct(agc.mem[REG.BB]);

  const chips: string[] = [];
  chips.push(`<span class="chip ok">${(machine.instructionRate / 1000).toFixed(1)}k instr/s</span>`);
  chips.push(agc.allowInterrupt ? '<span class="chip">interrupts on</span>' : '<span class="chip warn">INHINT</span>');
  if (agc.extraCode) chips.push('<span class="chip">EXTEND</span>');
  chips.push(agc.restarts ? `<span class="chip warn">${agc.restarts} restart${agc.restarts > 1 ? 's' : ''}</span>` : '<span class="chip">no restarts</span>');
  if (!machine.running) chips.push('<span class="chip warn">paused</span>');
  if (machine.speed !== 1) chips.push(`<span class="chip warn">${machine.speed}× speed</span>`);
  els.chips.innerHTML = chips.join('');
  const shown = [3, 4, 5, 1, 2, 8];
  els.rupts.innerHTML = shown
    .map((i) => {
      const rate = machine!.interruptRates[i];
      return `<span class="rupt${rate > 0 ? ' active' : ''}" title="${INTERRUPT_NAMES[i]} per second"><b>${rate >= 10 ? Math.round(rate) : rate.toFixed(1)}</b>${INTERRUPT_NAMES[i]}</span>`;
    })
    .join('');

  // Source listing: the executing line and lines that ran since the last refresh.
  const mode = els.follow.value;
  const followIndex = mode === 'jobs' ? agc.lastJobRopeIndex : ropeIndex;
  const followLine = followIndex >= 0 ? r.ropeLine[followIndex] : -1;
  source.setCurrent(mode === 'jobs' ? followLine : lineId, mode !== 'off' && followLine >= 0);
  const hot = new Set<number>();
  const nextBase = new Map<number, number>();
  for (const id of source.visibleLineIds()) {
    const ri = ropeIndexOf(r.lineAddress[id]);
    if (ri < 0 || r.lineWordStart[id] < 0) continue;
    let count = 0;
    for (let k = 0; k < r.lineWordCount[id]; k++) count += agc.execCounts[ri + k];
    const prev = heatBase.get(id);
    if (prev !== undefined && count > prev) hot.add(id);
    nextBase.set(id, count);
  }
  heatBase = nextBase;
  source.setHot(hot);
}

function frame(now: number): void {
  if (machine) {
    machine.frame(now);
    dsky.update(readDsky(machine.agc));
    craft.update(now);
    view?.update(craft.litJets);
    refreshPanels();
  }
  requestAnimationFrame(frame);
}

let initial = 'Luminary099';
try {
  initial = localStorage.getItem('agc-program') ?? initial;
} catch {
  // storage unavailable
}
if (!PROGRAMS.some((p) => p.id === initial)) initial = 'Luminary099';
void loadProgram(initial);
requestAnimationFrame(frame);
