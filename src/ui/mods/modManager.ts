import './mods.css';
import { formatModErrors, modRef, resolveActiveMods, validateCombination, validateModBundle, type ModValidationContext } from '../../mods/schema';
import { readModFiles, type FileLike } from '../../mods/loader';
import { leaveSafeMode } from '../../mods/boot';
import type { StoredMod, ModStore } from '../../mods/store';
import { MOD_CONTENT_KINDS, type ModBundle, type ModRef } from '../../mods/types';
import { setText } from '../panels/dom';
import { clearChildren, el, type Menu, type UIRoot } from '../ui';

/** The part of `ModStore` the manager uses (a fake in tests). */
export type ModStoreLike = Pick<ModStore, 'list' | 'put' | 'remove' | 'enabled' | 'setEnabled'>;

export interface ModManagerHost {
  store: ModStoreLike;
  /** What a mod is validated against (`defaultModContext()`). */
  context(): ModValidationContext;
  /** The mods applied at this page load (`activeModRefs()` or `BootResult.active`). */
  active(): readonly ModRef[];
  bootErrors(): readonly string[];
  /** True when the last start failed with mods and they were switched off. */
  safeMode(): boolean;
  /** Reloads the page (mods apply at load). */
  reload(): void;
  close(): void;
}

export interface ModRow {
  id: string;
  name: string;
  version: string;
  author: string;
  kinds: string;
  size: string;
  enabled: boolean;
  active: boolean;
  /** 1-based position in the load order; 0 when not enabled. */
  order: number;
}

/** '640 B', '12 KiB', '1.5 MiB'. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${String(Math.round(n))} B`;
  if (n < 1024 * 1024) return `${String(Math.round(n / 1024))} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

/** The content kinds a bundle actually carries, e.g. 'callTypes, vehicles'. */
export function contentKinds(bundle: Readonly<ModBundle>): string {
  const content = bundle.content as Record<string, unknown>;
  const out: string[] = [];
  for (const kind of MOD_CONTENT_KINDS) {
    const v = content[kind];
    if (Array.isArray(v) ? v.length > 0 : typeof v === 'object' && v !== null && Object.keys(v).length > 0) out.push(kind);
  }
  return out.length > 0 ? out.join(', ') : 'no content';
}

/**
 * Rows for the list: enabled mods first in load order (`enabled` ids that are installed), then the others by id.
 * `active` = the same mod (id and hash) is applied in this page load.
 */
export function modRows(stored: readonly StoredMod[], enabled: readonly string[], active: readonly ModRef[]): ModRow[] {
  const byId = new Map(stored.map((s) => [s.id, s]));
  const order: string[] = [];
  for (const id of enabled) if (byId.has(id) && !order.includes(id)) order.push(id);
  const rest = stored.map((s) => s.id).filter((id) => !order.includes(id)).sort();
  return [...order, ...rest].map((id) => {
    const s = byId.get(id) as StoredMod;
    const position = order.indexOf(id);
    return {
      id,
      name: s.bundle.name,
      version: s.bundle.modVersion,
      author: s.bundle.author,
      kinds: contentKinds(s.bundle),
      size: formatBytes(s.size),
      enabled: position >= 0,
      active: active.some((r) => r.id === id && r.hash === s.ref.hash),
      order: position + 1,
    };
  });
}

export type SavePlan = { ok: true; order: string[] } | { ok: false; errors: string[] };

/**
 * Checks the enabled set before it is saved: load-order duplicates (`resolveActiveMods`) and the merged content
 * (`validateCombination`). Errors block saving; the result lists them as '<mod>: <path>: <message>'.
 */
export function planSave(stored: readonly StoredMod[], order: readonly string[], ctx: ModValidationContext): SavePlan {
  const { active, errors } = resolveActiveMods(stored.map((s) => s.bundle), order);
  const all = [...errors, ...validateCombination(active, ctx)];
  if (all.length > 0) return { ok: false, errors: formatModErrors(all) };
  return { ok: true, order: active.map((m) => m.id) };
}

export interface InstallResult {
  /** File name, or the folder's name for a folder install. */
  source: string;
  ok: boolean;
  id: string | null;
  lines: string[];
}

function sourceName(files: readonly FileLike[]): string {
  const first = files[0];
  if (!first) return 'mod';
  if (files.length === 1) return first.name;
  const rel = first.webkitRelativePath;
  return rel !== undefined && rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : 'folder';
}

const HEADLESS_ELEMENT = {} as HTMLElement;

interface Dom {
  root: HTMLElement;
  notice: HTMLElement;
  info: HTMLElement;
  list: HTMLElement;
  messages: HTMLElement;
  status: HTMLElement;
}

/**
 * Mod manager (design 12.3): a pausing `Menu`. "Add mod..." takes `.json` bundles, "Add mod folder..." a folder with
 * `mod.json`; each is read (`readModFiles`), validated (`validateModBundle`) and stored, or its errors are listed and
 * nothing is stored. Mods are enabled, ordered and removed here; "Save & reload" checks the whole enabled set and
 * reloads (mods apply at page load). Headless it keeps the operations but builds no DOM.
 */
export class ModManager implements Menu {
  readonly id = 'mod-manager';
  readonly element: HTMLElement;

  private readonly ui: UIRoot | null;
  private readonly host: ModManagerHost;
  private readonly dom: Dom | null;
  private stored: StoredMod[] = [];
  private order: string[] = [];
  private lines: string[] = [];
  private statusText = '';
  private openFlag = false;
  private busy = false;
  private changed = false;

  constructor(ui: UIRoot | null, host: ModManagerHost) {
    this.ui = ui;
    this.host = host;
    this.dom = ui !== null && typeof document !== 'undefined' ? this.build() : null;
    this.element = this.dom?.root ?? HEADLESS_ELEMENT;
  }

  get isOpen(): boolean {
    return this.openFlag;
  }

  /** Rows as shown. */
  get rows(): ModRow[] {
    return modRows(this.stored, this.order, this.host.active());
  }

  /** Error / info lines under the list. */
  get messages(): readonly string[] {
    return this.lines;
  }

  get status(): string {
    return this.statusText;
  }

  /** The enabled ids in the working order (not yet saved). */
  get enabledOrder(): readonly string[] {
    return this.order;
  }

  /** True when the enabled set or the installed mods differ from what this page load applied. */
  get needsReload(): boolean {
    const active = this.host.active();
    if (active.length !== this.order.length) return true;
    return this.order.some((id, i) => active[i]?.id !== id || active[i]?.hash !== this.stored.find((s) => s.id === id)?.ref.hash);
  }

  async open(): Promise<void> {
    this.openFlag = true;
    this.render();
    if (this.ui && !this.ui.isOpen(this)) this.ui.push(this);
    await this.load();
  }

  close(): void {
    if (!this.openFlag) return;
    this.openFlag = false;
    if (this.ui?.isOpen(this)) this.ui.pop(this);
  }

  onHide(): void {
    if (this.openFlag && this.ui && !this.ui.isOpen(this)) this.openFlag = false;
  }

  onKeyDown(event: KeyboardEvent): boolean {
    if (!this.openFlag || event.key !== 'Escape') return false;
    this.leave();
    return true;
  }

  /** Reads the installed mods and the saved order from the store. */
  async load(): Promise<void> {
    try {
      this.stored = await this.host.store.list();
      const ids = new Set(this.stored.map((s) => s.id));
      this.order = this.host.store.enabled().filter((id) => ids.has(id));
      this.setStatus('');
    } catch (e) {
      this.stored = [];
      this.order = [];
      this.setStatus(`Could not read the installed mods: ${errorText(e)}`);
    }
    this.render();
  }

  /** Reads, validates and stores picked files. `kind` 'files': each `.json` is its own mod; 'folder': all files are one mod. */
  async install(files: readonly FileLike[], kind: 'files' | 'folder'): Promise<InstallResult[]> {
    if (files.length === 0) return [];
    const groups: (readonly FileLike[])[] = kind === 'files' ? files.map((f) => [f]) : [files];
    const results: InstallResult[] = [];
    this.busy = true;
    for (const group of groups) results.push(await this.installOne(group));
    this.busy = false;
    this.lines = results.flatMap((r) => (r.ok ? [] : [`${r.source} was not installed:`, ...r.lines.map((l) => `  ${l}`)]));
    const installed = results.filter((r) => r.ok);
    this.setStatus(
      installed.length > 0
        ? `Installed ${installed.map((r) => r.id ?? r.source).join(', ')}. Tick it, then press Save & reload.`
        : results.length > 0
          ? 'Nothing was installed.'
          : '',
    );
    this.render();
    return results;
  }

  private async installOne(group: readonly FileLike[]): Promise<InstallResult> {
    const source = sourceName(group);
    try {
      const read = await readModFiles(group);
      if (!read.ok) return { source, ok: false, id: null, lines: read.errors };
      const checked = validateModBundle(read.json, this.host.context());
      if (!checked.ok) return { source, ok: false, id: null, lines: formatModErrors(checked.errors) };
      const mod = checked.mod;
      const entry: StoredMod = { id: mod.id, bundle: mod, ref: modRef(mod), size: read.size, installedAt: Date.now() };
      await this.host.store.put(entry);
      const at = this.stored.findIndex((s) => s.id === mod.id);
      if (at >= 0) this.stored[at] = entry;
      else this.stored.push(entry);
      this.changed = true;
      return { source, ok: true, id: mod.id, lines: [`Installed ${mod.name} ${mod.modVersion}`] };
    } catch (e) {
      return { source, ok: false, id: null, lines: [`Could not install: ${errorText(e)}`] };
    }
  }

  /** Ticks or unticks a mod; new mods go to the end of the load order. */
  setEnabled(id: string, on: boolean): void {
    if (!this.stored.some((s) => s.id === id)) return;
    const has = this.order.includes(id);
    if (on && !has) this.order.push(id);
    else if (!on && has) this.order = this.order.filter((x) => x !== id);
    this.changed = true;
    this.render();
  }

  /** Moves an enabled mod one place up (-1) or down (+1) in the load order. */
  move(id: string, dir: -1 | 1): void {
    const i = this.order.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= this.order.length) return;
    const a = this.order[i] as string;
    this.order[i] = this.order[j] as string;
    this.order[j] = a;
    this.changed = true;
    this.render();
  }

  /** Deletes an installed mod from the store (the caller confirms). */
  async remove(id: string): Promise<boolean> {
    try {
      await this.host.store.remove(id);
    } catch (e) {
      this.setStatus(`Could not remove ${id}: ${errorText(e)}`);
      this.render();
      return false;
    }
    this.stored = this.stored.filter((s) => s.id !== id);
    this.order = this.order.filter((x) => x !== id);
    this.changed = true;
    this.setStatus(`Removed ${id}.`);
    this.render();
    return true;
  }

  /** Checks the enabled set; on success saves the order, leaves safe mode and reloads. Errors are listed and block saving. */
  saveAndReload(): boolean {
    const plan = planSave(this.stored, this.order, this.host.context());
    if (!plan.ok) {
      this.lines = ['Cannot save this set of mods:', ...plan.errors.map((l) => `  ${l}`)];
      this.setStatus('Fix the problems below, or untick the mod.');
      this.render();
      return false;
    }
    this.host.store.setEnabled(plan.order);
    leaveSafeMode();
    this.lines = [];
    this.setStatus('Reloading…');
    this.changed = false;
    this.render();
    this.host.reload();
    return true;
  }

  private leave(): void {
    this.close();
    this.host.close();
  }

  private setStatus(text: string): void {
    this.statusText = text;
    if (this.dom) setText(this.dom.status, text);
  }

  // --- DOM --------------------------------------------------------------------------------------------------

  private build(): Dom {
    const notice = el('p', { class: 'mm-notice', role: 'alert' });
    const info = el('div', { class: 'mm-info' });
    const list = el('div', { class: 'mm-list' });
    const messages = el('div', { class: 'mm-messages', role: 'status' });
    const status = el('p', { class: 'hint', role: 'status', 'aria-live': 'polite' });
    const root = el(
      'div',
      { class: 'panel mod-manager', role: 'dialog', 'aria-label': 'Mod manager' },
      el('div', { class: 'row mm-head' }, el('h1', null, 'Mods'), el('button', { type: 'button', class: 'small', onclick: () => this.leave() }, 'Close (Esc)')),
      notice,
      info,
      el('h2', null, 'Installed'),
      list,
      el(
        'div',
        { class: 'row' },
        el('button', { type: 'button', onclick: () => void this.pick(false) }, 'Add mod…'),
        el('button', { type: 'button', onclick: () => void this.pick(true) }, 'Add mod folder…'),
        el('button', { type: 'button', class: 'primary', onclick: () => void this.saveAndReload() }, 'Save & reload'),
      ),
      status,
      messages,
      el('p', { class: 'hint' }, 'Mods are JSON files (see docs/MODDING.md). They are checked when you add them and applied when the page reloads. Use ?nomods in the address to start without mods.'),
    );
    return { root, notice, info, list, messages, status };
  }

  private async pick(folder: boolean): Promise<void> {
    if (this.busy) return;
    const files = await pickFiles(folder);
    if (files.length > 0) await this.install(files, folder ? 'folder' : 'files');
  }

  private render(): void {
    const dom = this.dom;
    if (!dom) return;
    const host = this.host;
    dom.notice.hidden = !host.safeMode();
    setText(dom.notice, host.safeMode() ? 'Mods were disabled after a failed start. Review them below; Save & reload switches them back on.' : '');
    clearChildren(dom.info);
    const active = host.active();
    dom.info.appendChild(
      el('p', { class: 'hint' }, active.length === 0 ? 'No mods are active in this session.' : `Active now: ${active.map((r) => `${r.id} ${r.modVersion} (${r.hash})`).join(', ')}`),
    );
    const boot = host.bootErrors();
    if (boot.length > 0) {
      dom.info.appendChild(el('p', { class: 'mm-error' }, 'Problems when the mods were loaded:'));
      for (const line of boot) dom.info.appendChild(el('div', { class: 'mm-error mm-line' }, line));
    }
    if (this.needsReload && this.changed) dom.info.appendChild(el('p', { class: 'hint' }, 'Changes apply after Save & reload.'));
    clearChildren(dom.list);
    const rows = this.rows;
    if (rows.length === 0) dom.list.appendChild(el('div', { class: 'mm-empty' }, 'No mods installed.'));
    rows.forEach((r) => {
      const lastEnabled = r.order === this.order.length;
      dom.list.appendChild(
        el(
          'div',
          { class: `mm-row${r.enabled ? ' mm-enabled' : ''}` },
          el(
            'label',
            { class: 'mm-check' },
            el('input', { type: 'checkbox', checked: r.enabled, 'aria-label': `Enable ${r.name}`, onchange: (e: Event) => this.setEnabled(r.id, (e.target as HTMLInputElement).checked) }),
            el('span', { class: 'mm-name' }, r.name),
          ),
          el('span', { class: 'mm-meta' }, `${r.version} · ${r.author === '' ? 'unknown author' : r.author} · ${r.size}`),
          el('span', { class: 'mm-meta' }, r.kinds),
          el('span', { class: 'mm-badge' }, r.enabled ? (r.active ? `#${String(r.order)} active` : `#${String(r.order)} on reload`) : r.active ? 'off on reload' : 'off'),
          el(
            'span',
            { class: 'mm-actions' },
            el('button', { type: 'button', class: 'small', disabled: !r.enabled || r.order <= 1, 'aria-label': `Move ${r.name} up`, onclick: () => this.move(r.id, -1) }, '↑'),
            el('button', { type: 'button', class: 'small', disabled: !r.enabled || lastEnabled, 'aria-label': `Move ${r.name} down`, onclick: () => this.move(r.id, 1) }, '↓'),
            el(
              'button',
              {
                type: 'button',
                class: 'small danger',
                'aria-label': `Remove ${r.name}`,
                onclick: () => {
                  if (typeof window === 'undefined' || typeof window.confirm !== 'function' || window.confirm(`Remove the mod "${r.name}"?`)) void this.remove(r.id);
                },
              },
              'Remove',
            ),
          ),
        ),
      );
    });
    clearChildren(dom.messages);
    for (const line of this.lines) dom.messages.appendChild(el('div', { class: `mm-line${line.startsWith('  ') ? ' mm-error' : ''}` }, line));
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Opens a file picker: `.json` files (several), or a folder (`webkitdirectory`). Resolves with the chosen files, [] when cancelled. */
export function pickFiles(folder: boolean): Promise<File[]> {
  if (typeof document === 'undefined') return Promise.resolve([]);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (folder) input.setAttribute('webkitdirectory', '');
    else input.accept = '.json,application/json';
    input.style.display = 'none';
    let settled = false;
    const done = (files: File[]): void => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done(input.files ? Array.from(input.files) : []));
    input.addEventListener('cancel', () => done([]));
    document.body.appendChild(input);
    input.click();
  });
}
