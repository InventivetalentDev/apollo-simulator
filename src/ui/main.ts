import './styles.css';
import { INTERRUPT_NAMES, overflowCorrected, REG, type AGC } from '../agc/cpu.ts';
import { readDsky, type DskyKey } from '../agc/dsky.ts';
import { PROGRAMS, sourceLink, type ProgramInfo } from '../programs.ts';
import type { LunarModule } from '../sim/lm.ts';
import { ropeHash } from '../yul/rope-hash.ts';
import { assembleSources, type AssembleResponse } from './assemble-sources.ts';
import { COMMANDS, displayKeys, parseKeys, type Command } from './commands.ts';
import { DskyView, KEYBOARD_MAP } from './dsky-view.ts';
import { LmPanel } from './lm-panel.ts';
import type { LmView } from './lm-view.ts';
import { Machine } from './machine.ts';
import { abbr, alarmLine, alarmList, escapeHtml, explain, explainIn, programName, setProgramLists } from './glossary.ts';
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
  land: $<HTMLButtonElement>('#land'),
  follow: $<HTMLSelectElement>('#follow'),
  loading: $('#loading'),
  loadingText: $('#loading-text'),
  retry: $<HTMLButtonElement>('#loading-retry'),
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
  rate: $('#cpu-rate'),
  lamps: {
    inhint: $('#lamp-inhint'),
    restarts: $('#lamp-restarts'),
    paused: $('#lamp-paused'),
    speed: $('#lamp-speed'),
  },
  restarts: $('#cpu-restarts'),
  speedShown: $('#cpu-speed'),
  rupts: $('#cpu-rupts'),
  commands: $('#command-list'),
  quickCmds: $('#quick-cmds'),
  cmdNote: $('#cmd-note'),
  guide: $<HTMLDialogElement>('#guide'),
  guideOpen: $<HTMLButtonElement>('#guide-open'),
  guideClose: $<HTMLButtonElement>('#guide-close'),
  alarms: $('#alarm-list'),
  alarmSearch: $<HTMLInputElement>('#alarm-search'),
  alarmCount: $('#alarm-count'),
  alarmEmpty: $('#alarm-empty'),
  leftScroll: $('.left-scroll'),
  right: $('.right'),
  deckTabs: $('.deck-tabs'),
  run: {
    routine: $('#run-routine'),
    location: $('#run-location'),
    time: $('#run-time'),
  },
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

const craft = new LmPanel($('#craft'), {
  type: (keys) => typeKeys(parseKeys(keys)),
  cue: (key) => dsky.cue(key),
  speed: () => machine?.speed ?? 1,
  setSpeed: (speed) => {
    els.speed.value = String(speed);
    if (machine) machine.speed = speed;
  },
}, { fdai: $('#fdai'), descent: $('#descent'), checklist: $('#checklist') });
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

// ---- Tab lists: a click or the arrow keys select a tab

function tabList(list: HTMLElement, select: (tab: HTMLButtonElement) => void): void {
  const tabs = () => [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  list.addEventListener('click', (e) => {
    const tab = (e.target as HTMLElement).closest<HTMLButtonElement>('[role="tab"]');
    if (tab) select(tab);
  });
  list.addEventListener('keydown', (e) => {
    const all = tabs();
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: all.length - 1 }[e.key];
    if (i < 0 || next === undefined) return;
    e.preventDefault();
    const tab = all[(next + all.length) % all.length];
    select(tab);
    tab.focus();
  });
}
/** Mark `tab` selected in its list and show its panel, hiding the others'. */
function showTab(tab: HTMLButtonElement): void {
  for (const t of tab.parentElement!.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    const panel = document.getElementById(t.getAttribute('aria-controls')!)!;
    if (panel.classList.contains('guide-panel')) panel.hidden = !on;
  }
}

// ---- Right side: the Moon (3D view and attitude ball) or the computer (registers and listing)

type Deck = 'moon' | 'computer';
let deck: Deck = 'moon';
try {
  if (localStorage.getItem('agc-deck') === 'computer') deck = 'computer';
} catch {
  // storage unavailable
}
/** Show one side; the choice is kept for the next visit. */
function setDeck(next: Deck): void {
  deck = next;
  els.right.dataset.deck = next;
  showTab($<HTMLButtonElement>(`#tab-${next}`));
  if (next === 'computer') refreshPanels(true);
  try {
    localStorage.setItem('agc-deck', next);
  } catch {
    // storage unavailable
  }
}
tabList(els.deckTabs, (tab) => setDeck(tab.id === 'tab-moon' ? 'moon' : 'computer'));

// ---- Commands

function renderCommands(vehicle: 'LM' | 'CM'): void {
  const shown = COMMANDS.map((c, i) => [c, i] as const).filter(([c]) => !c.vehicle || c.vehicle === vehicle);
  els.commands.innerHTML = shown
    .map(
      ([c, i]) =>
        `<li><button type="button" class="cmd${c.keys.length > 24 ? ' long' : ''}" data-cmd="${i}"><span class="title">${explain(c.title)}</span>` +
        `<span class="keys">${explain(displayKeys(c.keys))}</span><span class="detail">${explain(c.detail)}</span></button></li>`,
    )
    .join('');
  els.quickCmds.innerHTML = shown
    .filter(([c]) => c.chip)
    .map(([c, i]) => `<button type="button" class="ctl quick-cmd" data-cmd="${i}" title="${escapeHtml(displayKeys(c.keys))}">${escapeHtml(c.chip!)}</button>`)
    .join('');
}
/** The loaded program's alarm list, each code with what it means, what sets it, and what the computer does. */
function renderAlarms(): void {
  const alarms = alarmList();
  els.alarmCount.textContent = `${programName()} has ${alarms.length}; this list comes from its own listing.`;
  els.alarms.innerHTML = alarms
    .map((a) => {
      const words = [a.code, ...a.variants.map((v) => `${v.text} ${v.setBy}`), a.note].join(' ').toLowerCase();
      const lines = a.variants.map((v) => `<p>${escapeHtml(alarmLine(v))}</p>`).join('');
      return `<li data-words="${escapeHtml(words)}"><code>${a.code}</code><div>${lines}${a.note ? `<p class="note">${escapeHtml(a.note)}</p>` : ''}</div></li>`;
    })
    .join('');
  filterAlarms();
}
function filterAlarms(): void {
  const query = els.alarmSearch.value.trim().toLowerCase();
  let shown = 0;
  for (const li of els.alarms.children as HTMLCollectionOf<HTMLElement>) {
    li.hidden = !!query && !li.dataset.words!.includes(query);
    if (!li.hidden) shown++;
  }
  els.alarmEmpty.hidden = shown > 0;
}
els.alarmSearch.addEventListener('input', filterAlarms);

for (const list of [els.commands, els.quickCmds]) {
  list.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-cmd]');
    if (!btn) return;
    // The sheet on a phone covers the DSKY: put it away so the keys can be seen going in.
    if (list === els.commands && els.guide.matches(':modal')) closeGuide(false);
    runCommand(COMMANDS[Number(btn.dataset.cmd)]);
  });
}

/** Key in a ready-made command; a setup command first puts the simulation in its state. */
function runCommand(command: Command): void {
  if (command.setup === 'descent' && machine && program) {
    const symbols = program.response.result.symbols;
    machine.setUpDescent((name) => {
      const symbol = symbols.find((s) => s.name === name);
      if (!symbol) throw new Error(`no symbol ${name}`);
      return symbol.value;
    });
    craft.attach(machine.lm, machine.agc, (name) => symbols.find((s) => s.name === name)?.value ?? -1);
  }
  typeKeys(parseKeys(command.keys));
  // What the command does stays under the chips until the next one; a setup's checklist explains itself.
  els.cmdNote.hidden = !!command.setup;
  if (!command.setup) els.cmdNote.innerHTML = `<b>${explain(command.title)}.</b> ${explain(command.detail)}`;
  const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  // When the list has scrolled the DSKY out of sight (narrow or short screens), bring it back.
  const shown = dsky.el.getBoundingClientRect();
  if (shown.top < 0 || shown.bottom > window.innerHeight) dsky.el.scrollIntoView({ behavior, block: 'start' });
  // After a setup, show the LM panel's checklist at the top of the panels under the DSKY.
  if (command.setup) els.leftScroll.scrollTo({ top: 0, behavior });
}

// ---- Guide: every command, the alarm codes and the introduction

/** A phone gets the guide as a sheet over the page; a wider window keeps the DSKY beside it. */
const sheetMedia = window.matchMedia('(max-width: 900px)');
const guideTabs = [...els.guide.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
tabList(els.guide.querySelector('[role="tablist"]')!, showTab);

function openGuide(tab?: string): void {
  if (tab) showTab($<HTMLButtonElement>(`#${tab}`));
  if (!els.guide.open) {
    if (sheetMedia.matches) els.guide.showModal();
    else els.guide.show();
  }
  els.guideOpen.setAttribute('aria-expanded', 'true');
  guideTabs.find((t) => t.getAttribute('aria-selected') === 'true')?.focus();
}
/** Close the guide; `refocus` puts focus back on the button that opened it. */
function closeGuide(refocus = true): void {
  if (!els.guide.open) return;
  els.guide.close();
  els.guideOpen.setAttribute('aria-expanded', 'false');
  if (refocus) els.guideOpen.focus();
}
els.guideOpen.addEventListener('click', () => (els.guide.open ? closeGuide() : openGuide()));
els.guideClose.addEventListener('click', () => closeGuide());
// Esc closes the sheet by itself (cancel); the panel beside the DSKY is not modal, so it is handled here.
els.guide.addEventListener('cancel', (e) => {
  e.preventDefault();
  closeGuide();
});
els.guide.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeGuide();
  }
});
// A tap on the dimmed page around the sheet closes it.
els.guide.addEventListener('click', (e) => {
  if (e.target === els.guide && els.guide.matches(':modal')) closeGuide();
});
// Turning a phone or resizing the window past the breakpoint changes which kind of guide it is.
sheetMedia.addEventListener('change', () => closeGuide(false));

// ---- Keyboard

document.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  if (target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  // Enter and Space work the focused control: a button or a link.
  if (target.closest('button, a[href]') && (e.key === 'Enter' || e.key === ' ')) return;
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
  // One instruction at a time is for reading along in the listing.
  if (deck !== 'computer') setDeck('computer');
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
  craft.restartChecklist(false);
  refreshPanels(true);
});
const DESCENT_SETUP = COMMANDS.find((c) => c.setup === 'descent')!;
els.land.addEventListener('click', async () => {
  if (program?.info.id !== 'Luminary099') await loadProgram('Luminary099');
  if (program?.info.id !== 'Luminary099' || !machine) return;
  setDeck('moon');
  setRunning(true);
  runCommand(DESCENT_SETUP);
});

els.retry.addEventListener('click', () => void loadProgram(els.retry.dataset.program!));

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
  // The CM has no 3D view: its right side is the computer only.
  els.right.dataset.vehicle = info.vehicle;
  renderCommands(info.vehicle);
  let loaded = cache.get(id);
  if (!loaded) {
    els.loading.hidden = false;
    els.loading.classList.remove('failed');
    els.retry.hidden = true;
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
      if (token !== loadToken) return;
      // Stop the spinner and offer another try: nothing was cached, so a retry starts clean.
      els.loading.classList.add('failed');
      els.loadingText.textContent = String(err instanceof Error ? err.message : err);
      els.retry.dataset.program = id;
      els.retry.hidden = false;
      return;
    }
  }
  program = loaded;
  heatBase = new Map();
  lastLocation = ''; // both programs share file names, so the link must be rebuilt
  const { response } = loaded;
  // Hover text for verb and noun numbers and alarm codes comes from this program's own lists.
  const lists = response.result.files.findIndex((f) => f.name === 'ASSEMBLY_AND_OPERATION_INFORMATION.agc');
  setProgramLists(response.texts[lists], info.id.replace(/(\D)(\d)/, '$1 $2'));
  renderCommands(info.vehicle);
  renderAlarms();
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
  const symbols = response.result.symbols;
  craft.attach(machine.lm, machine.agc, (name) => symbols.find((s) => s.name === name)?.value ?? -1);
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
/** Interrupts whose rates the computer panel shows: T3, T4, KEYRUPT1, T6, T5 and DOWNRUPT. */
const SHOWN_RUPTS = [3, 4, 5, 1, 2, 8];
/**
 * The INHINT lamp stays lit this long after the computer was last seen with
 * interrupts inhibited, ms: the software inhibits them for microseconds at a
 * time, too briefly to see.
 */
const LAMP_HOLD_MS = 500;
let inhintSeen = -Infinity;
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
    els.run.location.replaceChildren(...[...els.location.childNodes].map((n) => n.cloneNode(true)));
  }
  els.run.routine.textContent = els.routine.textContent;

  const cs = agc.mem[REG.TIME2] * 16384 + agc.mem[REG.TIME1];
  const s = Math.floor(cs / 100);
  els.time.textContent = `${String(Math.floor(s / 3600)).padStart(3, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  els.run.time.textContent = els.time.textContent;
  const z = agc.mem[REG.Z] & 0o7777;
  const fb = (agc.mem[REG.FB] >> 10) & 0o37;
  els.regs.z.textContent = z >= 0o2000 && z < 0o4000 ? `${oct(fb + ((fb & 0o30) === 0o30 && agc.outputChannel7 & 0o100 ? 0o10 : 0), 2)},${oct(z, 4)}` : oct(z, 4);
  const a = agc.mem[REG.A];
  els.regs.a.textContent = oct(overflowCorrected(a)) + ((a & 0o140000) === 0o40000 || (a & 0o140000) === 0o100000 ? ' OV' : '');
  els.regs.l.textContent = oct(overflowCorrected(agc.mem[REG.L]));
  els.regs.q.textContent = oct(overflowCorrected(agc.mem[REG.Q]));
  els.regs.bb.textContent = oct(agc.mem[REG.BB]);

  // Fixed lamps that light up, so nothing appears, vanishes or shifts the row.
  els.rate.textContent = `${(machine.instructionRate / 1000).toFixed(1)}k`;
  els.lamps.inhint.classList.toggle('on', now - inhintSeen < LAMP_HOLD_MS);
  els.restarts.textContent = String(agc.restarts);
  els.lamps.restarts.classList.toggle('on', agc.restarts > 0);
  els.lamps.paused.classList.toggle('on', !machine.running);
  els.speedShown.textContent = `${machine.speed}×`;
  els.lamps.speed.classList.toggle('on', machine.speed !== 1);
  // Built once and then only updated, so their hover text stays put.
  if (!els.rupts.childElementCount) {
    els.rupts.innerHTML = SHOWN_RUPTS.map((i) => `<span class="rupt"><b>0.0</b>${abbr(INTERRUPT_NAMES[i])}</span>`).join('');
  }
  SHOWN_RUPTS.forEach((i, k) => {
    const rate = machine!.interruptRates[i];
    const el = els.rupts.children[k] as HTMLElement;
    el.classList.toggle('active', rate > 0);
    // Three characters at most ("9.9", "10", "100"), so the row never shifts.
    el.firstElementChild!.textContent = rate < 9.95 ? rate.toFixed(1) : String(Math.round(rate));
  });

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
    if (!machine.agc.allowInterrupt) inhintSeen = now;
    dsky.update(readDsky(machine.agc));
    craft.update(now);
    // The 3D view draws only while it can be seen: on a phone it always can, on a wider window on the Moon side.
    if (sheetMedia.matches || deck === 'moon') view?.update(craft.litJets);
    refreshPanels();
  }
  requestAnimationFrame(frame);
}

// Short forms in the page's fixed text: their meaning shows on hover.
for (const el of document.querySelectorAll<HTMLElement>('[data-abbr]')) el.innerHTML = abbr(el.textContent!.trim());
explainIn($('#gpanel-about'));
explainIn($('#gpanel-try .hint'));
$('#intro').append($('#gpanel-about ul').cloneNode(true));

let initial = 'Luminary099';
try {
  initial = localStorage.getItem('agc-program') ?? initial;
} catch {
  // storage unavailable
}
if (!PROGRAMS.some((p) => p.id === initial)) initial = 'Luminary099';
setDeck(deck);
void loadProgram(initial);
requestAnimationFrame(frame);
