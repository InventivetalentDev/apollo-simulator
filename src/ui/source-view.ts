// A listing of the original source, in the style of a YUL assembly listing:
// location, assembled octal words, then the source line.  Only the visible
// rows are rendered, so files of several thousand lines scroll smoothly.

import type { AssemblyResult, SymbolInfo } from '../yul/assembler.ts';
import { INTERPRETIVE, PARSERS } from '../yul/tables.ts';

const LINE_HEIGHT = 20;
const OVERSCAN = 12;

const INTERPRETIVE_OPS = new Set(Object.keys(INTERPRETIVE).concat(['STORE', 'STODL', 'STOVL', 'STCALL', 'STODL*', 'STOVL*']));
const PSEUDO_OPS = new Set(Object.entries(PARSERS).filter(([, d]) => d.kind !== 'general' && d.kind !== 'index' && !d.alias).map(([n]) => n));
const MACHINE_OPS = new Set(Object.keys(PARSERS).filter((n) => !PSEUDO_OPS.has(n) && !INTERPRETIVE_OPS.has(n)).concat(['NOOP']));

const pad = (n: number, w: number) => n.toString(8).padStart(w, '0');

/** Location in the notation of the 1969 listings: 4000, 21,2345 or E3,1400. */
export function formatAddress(p: number): string {
  if (p < 0) return '';
  if (p <= 0o1377) return pad(p, 4);
  if (p <= 0o3777) return `E${p >> 8},${pad(0o1400 + (p & 0o377), 4)}`;
  if (p <= 0o7777) return pad(p, 4);
  const bank = (p - 0o10000) >> 10;
  return `${pad(bank, 2)},${pad(0o2000 + (p & 0o1777), 4)}`;
}

/** Rope index (bank*1024+offset) of a fixed-memory pseudo-address, or -1. */
export function ropeIndexOf(p: number): number {
  if (p >= 0o10000) return p - 0o10000;
  if (p >= 0o4000) return p;
  return -1;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function highlight(line: string): string {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('##')) return `<span class="cm note">${escapeHtml(line)}</span>`;
  if (trimmed.startsWith('#')) return `<span class="cm">${escapeHtml(line)}</span>`;
  if (trimmed.startsWith('$')) return `<span class="inc">${escapeHtml(line)}</span>`;
  const hash = line.indexOf('#');
  const code = hash >= 0 ? line.slice(0, hash) : line;
  let out = '';
  let last = 0;
  let index = 0;
  for (const m of code.matchAll(/\S+/g)) {
    out += escapeHtml(code.slice(last, m.index));
    const tok = m[0];
    let cls = '';
    if (index === 0 && m.index === 0) cls = 'lb';
    else if (MACHINE_OPS.has(tok)) cls = 'op';
    else if (INTERPRETIVE_OPS.has(tok)) cls = 'ip';
    else if (PSEUDO_OPS.has(tok)) cls = 'ps';
    out += cls ? `<span class="${cls}">${escapeHtml(tok)}</span>` : escapeHtml(tok);
    last = m.index + tok.length;
    index++;
  }
  out += escapeHtml(code.slice(last));
  if (hash >= 0) out += `<span class="cm">${escapeHtml(line.slice(hash))}</span>`;
  return out;
}

export interface SourceViewOptions {
  /** Called when the user scrolls or picks a file, so follow mode can be paused. */
  onUserNavigate: () => void;
}

/** Builds a link to a file, or one line of it, in the source repository. */
export type SourceLinker = (file: string, line?: number) => string;

export class SourceView {
  readonly el: HTMLElement;
  private scroller: HTMLElement;
  private fileLink: HTMLAnchorElement;
  private link: SourceLinker = () => '';
  /** True while a line-number link is pressed: re-rendering then would swallow the click. */
  private holdRender = false;
  private spacer: HTMLElement;
  private rows: HTMLElement;
  private fileSelect: HTMLSelectElement;
  private searchInput: HTMLInputElement;
  private searchStatus: HTMLElement;
  private result: AssemblyResult | null = null;
  private texts: string[] = [];
  private lines: string[] = [];
  private fileIndex = 0;
  private current = -1; // global line id of the executing instruction
  private flash = -1;
  private hot = new Set<number>();
  private corrected = new Map<number, string>();
  private symbols = new Map<string, SymbolInfo>();
  private renderQueued = false;
  private programmaticScroll = false;

  constructor(parent: HTMLElement, private readonly options: SourceViewOptions) {
    this.el = parent;
    this.fileSelect = parent.querySelector('#source-file')!;
    this.searchInput = parent.querySelector('#source-search')!;
    this.searchStatus = parent.querySelector('#source-search-status')!;
    this.fileLink = parent.querySelector('#source-github')!;
    this.scroller = parent.querySelector('.code-scroll')!;
    this.spacer = parent.querySelector('.code-spacer')!;
    this.rows = parent.querySelector('.code-rows')!;
    this.scroller.addEventListener('scroll', () => {
      if (!this.programmaticScroll) this.options.onUserNavigate();
      this.programmaticScroll = false;
      this.queueRender();
    });
    new ResizeObserver(() => this.queueRender()).observe(this.scroller);
    this.rows.addEventListener('pointerdown', (e) => {
      if ((e.target as Element).closest('a.ln')) this.holdRender = true;
    });
    const release = () => {
      if (!this.holdRender) return;
      // Let the click land on the link before the rows are rebuilt.
      setTimeout(() => {
        this.holdRender = false;
        this.queueRender();
      });
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    this.fileSelect.addEventListener('change', () => {
      this.options.onUserNavigate();
      this.openFile(Number(this.fileSelect.value), 0);
    });
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.search(this.searchInput.value);
    });
  }

  load(
    result: AssemblyResult,
    texts: string[],
    corrections: { file: string; line: number; reason: string }[],
    link: SourceLinker,
  ): void {
    this.result = result;
    this.texts = texts;
    this.link = link;
    this.corrected.clear();
    for (const c of corrections) {
      const f = result.files.find((ff) => ff.name === c.file);
      if (f) this.corrected.set(f.firstLine + c.line - 1, c.reason);
    }
    this.symbols = new Map(result.symbols.map((s) => [s.name.toUpperCase(), s]));
    this.fileSelect.innerHTML = result.files
      .map((f, i) => `<option value="${i}">${escapeHtml(f.name)} (${f.lineCount.toLocaleString()} lines)</option>`)
      .join('');
    const datalist = this.el.querySelector('#source-symbols')!;
    datalist.innerHTML = result.symbols
      .filter((s) => !s.constant && s.value >= 0o4000)
      .map((s) => `<option value="${escapeHtml(s.name)}"></option>`)
      .join('');
    this.current = -1;
    this.openFile(0, 0);
  }

  get currentFile(): string {
    return this.result?.files[this.fileIndex]?.name ?? '';
  }

  /** File name and 1-based line number of a global line id. */
  locate(lineId: number): { file: number; line: number } | null {
    const files = this.result?.files;
    if (!files || lineId < 0) return null;
    let lo = 0;
    let hi = files.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (files[mid].firstLine <= lineId) lo = mid;
      else hi = mid - 1;
    }
    return { file: lo, line: lineId - files[lo].firstLine + 1 };
  }

  /** Mark the line being executed; with `follow`, bring it into view. */
  setCurrent(lineId: number, follow: boolean): void {
    if (lineId === this.current && !follow) return;
    this.current = lineId;
    if (this.holdRender) return; // keep the view still until the pressed link is released
    if (follow && lineId >= 0) this.reveal(lineId, false);
    else this.queueRender();
  }

  /** Lines whose code ran since the last refresh get a marker in the gutter. */
  setHot(lines: Set<number>): void {
    this.hot = lines;
    this.queueRender();
  }

  /** The global line ids currently on screen (used to compute heat cheaply). */
  visibleLineIds(): number[] {
    if (!this.result) return [];
    const { first, last } = this.visibleRange();
    const base = this.result.files[this.fileIndex].firstLine;
    const ids: number[] = [];
    for (let i = first; i < last; i++) ids.push(base + i);
    return ids;
  }

  reveal(lineId: number, flash: boolean): void {
    const loc = this.locate(lineId);
    if (!loc) return;
    if (flash) this.flash = lineId;
    if (loc.file !== this.fileIndex) this.openFile(loc.file, loc.line - 1, true);
    else this.scrollToLine(loc.line - 1, true);
    this.queueRender();
  }

  search(query: string): void {
    const q = query.trim().toUpperCase();
    if (!q) return;
    let sym = this.symbols.get(q);
    if (!sym) sym = [...this.symbols.values()].find((s) => s.name.toUpperCase().startsWith(q) && s.line >= 0);
    if (!sym || sym.line < 0) {
      this.searchStatus.textContent = `No label “${query.trim()}”`;
      return;
    }
    this.searchStatus.textContent = '';
    this.options.onUserNavigate();
    this.reveal(sym.line, true);
  }

  private openFile(index: number, line: number, keepIfVisible = false): void {
    if (!this.result) return;
    this.fileIndex = index;
    this.fileSelect.value = String(index);
    const name = this.result.files[index].name;
    this.fileLink.href = this.link(name);
    this.fileLink.title = `Open ${name} on GitHub`;
    this.lines = this.texts[index].split('\n');
    if (this.lines.length && this.lines[this.lines.length - 1] === '') this.lines.pop();
    this.spacer.style.height = `${this.lines.length * LINE_HEIGHT}px`;
    this.scrollToLine(line, keepIfVisible, true);
    this.render();
  }

  private scrollToLine(line: number, onlyIfHidden: boolean, force = false): void {
    const top = line * LINE_HEIGHT;
    const view = this.scroller.clientHeight;
    const cur = this.scroller.scrollTop;
    if (!force && onlyIfHidden && top >= cur + LINE_HEIGHT * 2 && top <= cur + view - LINE_HEIGHT * 3) return;
    const target = Math.max(0, top - view / 3);
    if (Math.abs(target - cur) < 1) return;
    this.programmaticScroll = true;
    this.scroller.scrollTop = target;
  }

  private visibleRange(): { first: number; last: number } {
    const first = Math.max(0, Math.floor(this.scroller.scrollTop / LINE_HEIGHT) - OVERSCAN);
    const count = Math.ceil(this.scroller.clientHeight / LINE_HEIGHT) + OVERSCAN * 2;
    return { first, last: Math.min(this.lines.length, first + count) };
  }

  private queueRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  private render(): void {
    const r = this.result;
    if (!r || this.holdRender) return;
    const { first, last } = this.visibleRange();
    const base = r.files[this.fileIndex].firstLine;
    const file = r.files[this.fileIndex].name;
    let html = '';
    for (let i = first; i < last; i++) {
      const id = base + i;
      const addr = r.lineAddress[id];
      const ws = r.lineWordStart[id];
      let words = '';
      if (ws >= 0) for (let k = 0; k < r.lineWordCount[id]; k++) words += (k ? ' ' : '') + pad(r.lineWords[ws + k], 5);
      const cls = ['row'];
      if (id === this.current) cls.push('current');
      if (id === this.flash) cls.push('flash');
      if (this.hot.has(id)) cls.push('hot');
      const fix = this.corrected.get(id);
      if (fix) cls.push('corrected');
      html +=
        `<div class="${cls.join(' ')}" style="top:${i * LINE_HEIGHT}px"${fix ? ` title="Corrected: ${escapeHtml(fix)}"` : ''}>` +
        `<a class="ln" href="${escapeHtml(this.link(file, i + 1))}" target="_blank" rel="noopener" tabindex="-1" title="Line ${i + 1} on GitHub${fix ? ' (shows the uncorrected upstream text)' : ''}">${i + 1}</a><span class="addr">${formatAddress(words ? addr : -1)}</span>` +
        `<span class="words">${words}</span><span class="src">${highlight(this.lines[i])}</span></div>`;
    }
    this.rows.innerHTML = html;
  }
}
