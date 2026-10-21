import './sandbox.css';
import type { RoadGraph } from '../../world/roadGraph';
import { SCENARIO_LIMITS, parseSandboxScenario, type SandboxScenario, type ScenarioContext } from '../../training/scenario';
import { RoadCache } from '../dispatch/roads';
import { mapToWorld } from '../mdt/map';
import { setText } from '../panels/dom';
import { clearChildren, el, type Menu, type UIRoot } from '../ui';
import { PICK_PX, drawScenario, editorView } from './draw';
import { downloadText, pickTextFile } from './download';
import { LIBRARY_LIMIT, browserLibraryStorage, libraryList, libraryLoad, libraryRemove, librarySave, type LibraryStorage } from './library';
import { EditorState, blankScenario, cloneScenario, type EditorTool, type PlaceOptions } from './state';

export { EditorState, blankScenario, type EditorTool } from './state';
export { libraryList, libraryLoad, librarySave, libraryRemove } from './library';

/** What the editor needs from the game. `anchor()` is where a new scenario is centred (the officer / station). */
export interface EditorHost {
  graph: RoadGraph;
  context: ScenarioContext;
  anchor(): { x: number; z: number };
  run(doc: SandboxScenario): void;
  close(): void;
}

/** Rotation step of Q / E (radians). */
export const ROTATE_STEP = Math.PI / 12;
/** Largest scenario file the importer reads (bytes). */
export const IMPORT_MAX_BYTES = 256 * 1024;

export const EDITOR_TOOLS: readonly { tool: EditorTool; label: string }[] = [
  { tool: 'select', label: 'Select' },
  { tool: 'npc', label: 'Person' },
  { tool: 'vehicle', label: 'Vehicle' },
  { tool: 'evidence', label: 'Evidence' },
  { tool: 'call', label: 'Call' },
];

const HEADLESS_ELEMENT = {} as HTMLElement;

function sorted(set: ReadonlySet<string>): string[] {
  return [...set].sort();
}

function isTypingTarget(target: EventTarget | null | undefined): boolean {
  const tag = (target as { tagName?: unknown } | null | undefined)?.tagName;
  const name = typeof tag === 'string' ? tag.toLowerCase() : '';
  return name === 'input' || name === 'textarea' || name === 'select';
}

/** Reads and validates a scenario file's text. Never throws; the errors are ready to show. */
export function importScenarioText(text: string, size: number, ctx: ScenarioContext): { ok: true; value: SandboxScenario } | { ok: false; errors: string[] } {
  if (size > IMPORT_MAX_BYTES) return { ok: false, errors: [`File is ${String(Math.ceil(size / 1024))} KiB; the limit is ${String(IMPORT_MAX_BYTES / 1024)} KiB`] };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`Not valid JSON (${e instanceof Error ? e.message : 'parse error'})`] };
  }
  return parseSandboxScenario(json, ctx);
}

/**
 * Scenario editor (design 12.2): a pausing `Menu` with a top-down canvas (±150 m around the anchor), tools, an
 * inspector for the selected object, scenario details, a browser-storage library, export / import of validated JSON
 * and Run. Keys: Q / E rotate, Delete removes, 1-5 pick a tool, Escape closes. Headless (no `document` or no `UIRoot`) it
 * keeps the state and the file / library operations but builds no DOM.
 */
export class ScenarioEditor implements Menu {
  readonly id = 'scenario-editor';
  readonly element: HTMLElement;

  private readonly ui: UIRoot | null;
  private readonly host: EditorHost;
  private readonly storage: LibraryStorage | null;
  private readonly roads: RoadCache;
  private readonly canvas: HTMLCanvasElement | null;
  private readonly side: HTMLElement | null;
  private readonly optionsBox: HTMLElement | null;
  private readonly detailsBox: HTMLElement | null;
  private readonly libraryBox: HTMLElement | null;
  private readonly problemsBox: HTMLElement | null;
  private readonly statusLine: HTMLElement | null;
  private readonly toolButtons: HTMLButtonElement[] = [];
  private editor: EditorState;
  private activeTool: EditorTool = 'select';
  private readonly placeOpts: PlaceOptions = { role: 'bystander', priority: '3' };
  private openFlag = false;
  private drag = false;
  private savedRev = 0;
  private paintedRev = -1;
  private message = '';
  private problems: string[] = [];

  constructor(ui: UIRoot | null, host: EditorHost, storage: LibraryStorage | null = browserLibraryStorage()) {
    this.ui = ui;
    this.host = host;
    this.storage = storage;
    this.roads = new RoadCache(host.graph);
    this.editor = new EditorState(blankScenario(newId(), host.anchor()));
    this.savedRev = this.editor.revision;
    if (ui === null || typeof document === 'undefined') {
      this.canvas = null;
      this.side = null;
      this.optionsBox = null;
      this.detailsBox = null;
      this.libraryBox = null;
      this.problemsBox = null;
      this.statusLine = null;
      this.element = HEADLESS_ELEMENT;
      return;
    }
    this.canvas = el('canvas', { class: 'sb-canvas', width: 600, height: 600, role: 'img', 'aria-label': 'Scenario map, top-down, 150 metres around the anchor' });
    this.optionsBox = el('div', { class: 'sb-options' });
    this.detailsBox = el('div', { class: 'sb-details' });
    this.libraryBox = el('div', { class: 'sb-library' });
    this.problemsBox = el('div', { class: 'sb-problems', role: 'status' });
    this.statusLine = el('p', { class: 'hint sb-status', role: 'status', 'aria-live': 'polite' });
    this.side = el('div', { class: 'sb-side' });
    this.bindCanvas(this.canvas);
    const toolbar = el('div', { class: 'row sb-tools', role: 'toolbar', 'aria-label': 'Tools' });
    for (const t of EDITOR_TOOLS) {
      const b = el('button', { type: 'button', class: 'small', 'aria-pressed': t.tool === this.activeTool ? 'true' : 'false', onclick: () => this.setTool(t.tool) }, t.label);
      this.toolButtons.push(b);
      toolbar.appendChild(b);
    }
    this.side.append(
      el('h2', null, 'Details'),
      this.detailsBox,
      el('h2', null, 'Library'),
      this.libraryBox,
      el(
        'div',
        { class: 'row' },
        el('button', { type: 'button', class: 'small', onclick: () => this.exportFile() }, 'Export…'),
        el('button', { type: 'button', class: 'small', onclick: () => void this.importFile() }, 'Import…'),
      ),
      el('h2', null, 'Problems'),
      this.problemsBox,
    );
    const root = el(
      'div',
      { class: 'panel scenario-editor', role: 'dialog', 'aria-label': 'Scenario editor' },
      el('div', { class: 'row sb-head' }, el('h1', null, 'Scenario editor'), el('button', { type: 'button', class: 'small', onclick: () => this.leave() }, 'Close (Esc)')),
      el(
        'div',
        { class: 'sb-grid' },
        el('div', { class: 'sb-left' }, toolbar, this.optionsBox, this.canvas, el('p', { class: 'hint' }, 'Click to place or select · drag to move · Q / E rotate · Delete removes · 1-5 tools')),
        this.side,
      ),
      el(
        'div',
        { class: 'row end' },
        el('button', { type: 'button', onclick: () => { if (this.confirmDiscard()) this.newScenario(); } }, 'New'),
        el('button', { type: 'button', class: 'primary', onclick: () => this.run() }, 'Run scenario'),
      ),
      this.statusLine,
    );
    this.element = root;
    this.renderAll();
  }

  get isOpen(): boolean {
    return this.openFlag;
  }

  get state(): EditorState {
    return this.editor;
  }

  get tool(): EditorTool {
    return this.activeTool;
  }

  /** True when the document changed since it was opened, loaded or saved. */
  get dirty(): boolean {
    return this.editor.revision !== this.savedRev;
  }

  /** The last status or error text. */
  get statusText(): string {
    return this.message;
  }

  /** Opens the editor on `doc` (copied), or on a new scenario anchored at `host.anchor()`. */
  open(doc?: SandboxScenario): void {
    this.editor = new EditorState(doc ?? blankScenario(newId(), this.host.anchor()));
    this.savedRev = this.editor.revision;
    this.paintedRev = -1;
    this.message = '';
    this.openFlag = true;
    this.renderAll();
    if (this.ui && !this.ui.isOpen(this)) this.ui.push(this);
  }

  close(): void {
    if (!this.openFlag) return;
    this.openFlag = false;
    if (this.ui?.isOpen(this)) this.ui.pop(this);
  }

  onHide(): void {
    if (this.openFlag && this.ui && !this.ui.isOpen(this)) this.openFlag = false;
  }

  /** Repaints when the document changed (call once per frame; cheap when nothing changed). */
  update(): void {
    if (this.openFlag && this.paintedRev !== this.editor.revision) this.renderAll();
  }

  setTool(tool: EditorTool): void {
    this.activeTool = tool;
    this.toolButtons.forEach((b, i) => b.setAttribute('aria-pressed', EDITOR_TOOLS[i]?.tool === tool ? 'true' : 'false'));
    this.renderOptions();
  }

  onKeyDown(event: KeyboardEvent): boolean {
    if (!this.openFlag || event.ctrlKey || event.altKey || event.metaKey) return false;
    if (isTypingTarget(event.target)) {
      if (event.key === 'Escape') {
        (event.target as { blur?: () => void } | null)?.blur?.();
        return true;
      }
      return false;
    }
    switch (event.key) {
      case 'Escape':
        this.leave();
        return true;
      case 'q':
      case 'Q':
        this.editor.rotate(-ROTATE_STEP);
        this.renderAll();
        return true;
      case 'e':
      case 'E':
        this.editor.rotate(ROTATE_STEP);
        this.renderAll();
        return true;
      case 'Delete':
      case 'Backspace':
        this.editor.remove();
        this.renderAll();
        return true;
      default: {
        const n = Number(event.key);
        const t = Number.isInteger(n) ? EDITOR_TOOLS[n - 1] : undefined;
        if (t) {
          this.setTool(t.tool);
          return true;
        }
        return false;
      }
    }
  }

  // --- Operations (also used by tests) ----------------------------------------------------------------------

  /** Starts a new empty scenario. */
  newScenario(): void {
    this.editor = new EditorState(blankScenario(newId(), this.host.anchor()));
    this.savedRev = this.editor.revision;
    this.say('New scenario');
    this.renderAll();
  }

  /** Validates, then runs the scenario in the world; the problems are shown instead when it is invalid. */
  run(): boolean {
    const errors = this.editor.validate(this.host.context);
    if (errors.length > 0) {
      this.say(`Cannot run: ${String(errors.length)} problem${errors.length === 1 ? '' : 's'}`);
      this.renderAll();
      return false;
    }
    this.host.run(cloneScenario(this.editor.doc));
    return true;
  }

  /** Saves to the library (valid scenarios only). Returns the error text or null. */
  saveToLibrary(): string | null {
    const errors = this.editor.validate(this.host.context);
    if (errors.length > 0) return this.fail(`Cannot save: ${errors[0] ?? 'invalid scenario'}`);
    const err = librarySave(this.storage, this.editor.doc);
    if (err !== null) return this.fail(err);
    this.savedRev = this.editor.revision;
    this.say(`Saved "${this.editor.doc.name}" to the library`);
    this.renderAll();
    return null;
  }

  /** Loads library entry `id`. */
  loadFromLibrary(id: string): boolean {
    const doc = libraryLoad(this.storage, id, this.host.context);
    if (!doc) {
      this.fail(`Could not load "${id}"`);
      return false;
    }
    this.editor = new EditorState(doc);
    this.savedRev = this.editor.revision;
    this.say(`Loaded "${doc.name}"`);
    this.renderAll();
    return true;
  }

  removeFromLibrary(id: string): boolean {
    const ok = libraryRemove(this.storage, id);
    this.say(ok ? 'Deleted from the library' : 'Could not delete');
    this.renderAll();
    return ok;
  }

  /** Replaces the document with an imported file's text; the errors are shown and the current document kept when invalid. */
  importText(text: string, size = text.length): boolean {
    const r = importScenarioText(text, size, this.host.context);
    if (!r.ok) {
      this.problems = r.errors;
      this.fail(`Import failed: ${String(r.errors.length)} problem${r.errors.length === 1 ? '' : 's'}`);
      this.renderProblems(r.errors);
      return false;
    }
    this.editor = new EditorState(r.value);
    this.savedRev = this.editor.revision;
    this.say(`Imported "${r.value.name}"`);
    this.renderAll();
    return true;
  }

  /** Downloads the scenario as `<id>.json` (valid scenarios only). */
  exportFile(): boolean {
    const errors = this.editor.validate(this.host.context);
    if (errors.length > 0) {
      this.fail(`Cannot export: ${errors[0] ?? 'invalid scenario'}`);
      return false;
    }
    const ok = downloadText(`${this.editor.doc.id}.json`, this.editor.exportJson());
    this.say(ok ? `Exported ${this.editor.doc.id}.json` : 'Download is not available here');
    return ok;
  }

  private async importFile(): Promise<void> {
    const file = await pickTextFile('.json,application/json');
    if (!file) return;
    this.importText(file.text, file.size);
  }

  /** Asks before throwing away unsaved edits (no prompt in a browser without `confirm`, or when nothing changed). */
  private confirmDiscard(): boolean {
    if (!this.dirty || typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
    return window.confirm('Discard the unsaved changes to this scenario?');
  }

  private leave(): void {
    this.close();
    this.host.close();
  }

  // --- Canvas -----------------------------------------------------------------------------------------------

  private bindCanvas(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('pointerdown', (e) => {
      const view = editorView(this.editor.doc.anchor);
      const p = this.canvasPoint(e);
      const w = mapToWorld(view, p.x, p.y, { x: 0, z: 0 });
      const radius = PICK_PX / view.scale;
      if (this.activeTool === 'select') {
        this.editor.select(w.x, w.z, radius);
        this.drag = this.editor.selected !== null && this.editor.selected.kind !== 'call';
        if (this.drag) canvas.setPointerCapture?.(e.pointerId);
      } else {
        const err = this.editor.place(this.activeTool, w.x, w.z, this.placeOpts);
        if (err !== null) this.fail(err);
        else this.say('');
      }
      this.renderAll();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const view = editorView(this.editor.doc.anchor);
      const p = this.canvasPoint(e);
      const w = mapToWorld(view, p.x, p.y, { x: 0, z: 0 });
      this.editor.move(w.x, w.z);
      this.paintedRev = this.editor.revision;
      this.renderCanvas();
    });
    const end = (): void => {
      if (this.drag) {
        this.drag = false;
        this.renderAll();
      }
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  private canvasPoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const canvas = this.canvas;
    const rect = canvas?.getBoundingClientRect();
    if (!canvas || !rect || rect.width <= 0 || rect.height <= 0) return { x: e.clientX, y: e.clientY };
    return { x: ((e.clientX - rect.left) * canvas.width) / rect.width, y: ((e.clientY - rect.top) * canvas.height) / rect.height };
  }

  // --- Messages and rendering -------------------------------------------------------------------------------

  private say(text: string): void {
    this.message = text;
    if (this.statusLine) setText(this.statusLine, text);
  }

  private fail(text: string): string {
    this.say(text);
    return text;
  }

  private renderAll(): void {
    this.paintedRev = this.editor.revision;
    this.renderCanvas();
    this.renderOptions();
    this.renderDetails();
    this.renderLibrary();
    this.problems = this.editor.validate(this.host.context);
    this.renderProblems(this.problems);
  }

  private renderCanvas(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    drawScenario(ctx, this.roads, editorView(this.editor.doc.anchor), this.editor.doc, this.editor.selected);
  }

  private renderProblems(lines: readonly string[]): void {
    const box = this.problemsBox;
    if (!box) return;
    clearChildren(box);
    if (lines.length === 0) {
      box.appendChild(el('div', { class: 'sb-ok' }, 'Valid: ready to run, save or export.'));
      return;
    }
    for (const line of lines.slice(0, 12)) box.appendChild(el('div', { class: 'sb-problem' }, line));
    if (lines.length > 12) box.appendChild(el('div', { class: 'sb-problem' }, `… and ${String(lines.length - 12)} more`));
  }

  private select(options: readonly string[], value: string, onChange: (v: string) => void, label: string, blank?: string): HTMLSelectElement {
    const s = el(
      'select',
      { 'aria-label': label, onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value) },
      blank !== undefined ? el('option', { value: '' }, blank) : null,
      ...options.map((o) => el('option', { value: o }, o)),
    );
    s.value = value;
    return s;
  }

  private labelled(text: string, control: HTMLElement): HTMLElement {
    return el('label', { class: 'sb-field' }, el('span', null, text), control);
  }

  /** The property form for the active tool, or for the selected object when the Select tool is active. */
  private renderOptions(): void {
    const box = this.optionsBox;
    if (!box) return;
    clearChildren(box);
    const ctx = this.host.context;
    const selected = this.editor.selected;
    const editing = this.activeTool === 'select';
    const kind = editing ? selected?.kind : this.activeTool;
    const doc = this.editor.doc;
    const values: PlaceOptions = { ...this.placeOpts };
    if (editing && selected) {
      if (selected.kind === 'npc') {
        const n = doc.npcs[selected.index];
        if (n) Object.assign(values, { profile: n.profile, role: n.role, weapon: n.weapon ?? '', hidden: n.hidden });
      } else if (selected.kind === 'vehicle') {
        const v = doc.vehicles[selected.index];
        if (v) values['modelId'] = v.modelId;
      } else if (selected.kind === 'evidence') {
        const e = doc.evidence[selected.index];
        if (e) Object.assign(values, { item: e.item, concealed: e.concealed });
      }
    }
    const set = (key: string, v: string | boolean): void => {
      if (editing) {
        const err = this.editor.setProps({ [key]: v });
        if (err !== null) this.fail(err);
        this.formChanged();
      } else {
        this.placeOpts[key] = v;
      }
    };
    const profiles = sorted(ctx.profiles);
    if (kind === 'npc') {
      const profile = typeof values['profile'] === 'string' && values['profile'] !== '' ? values['profile'] : (profiles[0] ?? '');
      if (!editing) this.placeOpts['profile'] = profile;
      box.append(
        this.labelled('Behaviour', this.select(profiles, profile, (v) => set('profile', v), 'Behaviour profile')),
        this.labelled(
          'Role',
          el('input', { type: 'text', value: String(values['role'] ?? 'bystander'), maxlength: 24, 'aria-label': 'Role', onchange: (e: Event) => set('role', (e.target as HTMLInputElement).value) }),
        ),
        this.labelled('Weapon', this.select(sorted(ctx.weapons), String(values['weapon'] ?? ''), (v) => set('weapon', v), 'Weapon', 'Unarmed')),
        this.labelled('Hidden', this.checkbox(values['hidden'] === true, (v) => set('hidden', v), 'Hidden at the start')),
      );
    } else if (kind === 'vehicle') {
      const models = sorted(ctx.vehicleModels);
      const modelId = typeof values['modelId'] === 'string' && values['modelId'] !== '' ? values['modelId'] : (models[0] ?? '');
      if (!editing) this.placeOpts['modelId'] = modelId;
      box.appendChild(this.labelled('Model', this.select(models, modelId, (v) => set('modelId', v), 'Vehicle model')));
    } else if (kind === 'evidence') {
      const items = sorted(ctx.items);
      const item = typeof values['item'] === 'string' && values['item'] !== '' ? values['item'] : (items[0] ?? '');
      if (!editing) this.placeOpts['item'] = item;
      box.append(
        this.labelled('Item', this.select(items, item, (v) => set('item', v), 'Evidence item')),
        this.labelled('Concealed', this.checkbox(values['concealed'] === true, (v) => set('concealed', v), 'Concealed')),
      );
    } else if (kind === 'call') {
      const types = sorted(ctx.callTypeIds);
      const current = doc.call;
      const typeId = current?.typeId ?? (typeof this.placeOpts['typeId'] === 'string' && this.placeOpts['typeId'] !== '' ? this.placeOpts['typeId'] : (types[0] ?? ''));
      const p = current?.priority ?? Number(this.placeOpts['priority']);
      const priority = p === 1 || p === 2 || p === 3 || p === 4 ? p : 3;
      this.placeOpts['typeId'] = typeId;
      this.placeOpts['priority'] = String(priority);
      const apply = (t: string, pr: 1 | 2 | 3 | 4): void => {
        this.placeOpts['typeId'] = t;
        this.placeOpts['priority'] = String(pr);
        if (this.editor.doc.call) {
          this.editor.setCall(t, pr);
          this.formChanged();
        }
      };
      box.append(
        this.labelled('Call type', this.select(types, typeId, (v) => apply(v, priority), 'Call type')),
        this.labelled('Priority', this.select(['1', '2', '3', '4'], String(priority), (v) => apply(typeId, Number(v) as 1 | 2 | 3 | 4), 'Call priority')),
        el('p', { class: 'hint' }, current ? 'The call starts at the anchor (the cross in the middle).' : 'Click the map to add a call at the anchor.'),
      );
    } else {
      box.appendChild(el('p', { class: 'hint' }, editing ? 'Click an object to select it.' : ''));
    }
    if (editing && selected) {
      box.appendChild(
        el(
          'div',
          { class: 'row' },
          el('button', { type: 'button', class: 'small', onclick: () => { this.editor.rotate(-ROTATE_STEP); this.renderAll(); } }, 'Rotate left (Q)'),
          el('button', { type: 'button', class: 'small', onclick: () => { this.editor.rotate(ROTATE_STEP); this.renderAll(); } }, 'Rotate right (E)'),
          el('button', { type: 'button', class: 'small danger', onclick: () => { this.editor.remove(); this.renderAll(); } }, 'Remove (Del)'),
        ),
      );
    }
  }

  /** A form field changed the document: repaint the canvas and the problems without rebuilding the form (keeps focus). */
  private formChanged(): void {
    this.paintedRev = this.editor.revision;
    this.renderCanvas();
    this.problems = this.editor.validate(this.host.context);
    this.renderProblems(this.problems);
  }

  private checkbox(checked: boolean, onChange: (v: boolean) => void, label: string): HTMLInputElement {
    return el('input', { type: 'checkbox', checked, 'aria-label': label, onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked) });
  }

  private renderDetails(): void {
    const box = this.detailsBox;
    if (!box) return;
    clearChildren(box);
    const ctx = this.host.context;
    const doc = this.editor.doc;
    const hours = Array.from({ length: 24 }, (_, h) => String(h));
    const hour = this.select(hours, doc.timeOfDay === null ? '' : String(doc.timeOfDay), (v) => {
      this.editor.setEnvironment(v === '' ? null : Number(v), this.editor.doc.weather);
      this.formChanged();
    }, 'Hour of day', 'Leave time alone');
    const weather = this.select([...ctx.weatherKinds], doc.weather ?? '', (v) => {
      this.editor.setEnvironment(this.editor.doc.timeOfDay, v === '' ? null : v);
      this.formChanged();
    }, 'Weather', 'Leave weather alone');
    const idInput = el('input', {
      type: 'text',
      value: doc.id,
      maxlength: 40,
      'aria-label': 'Scenario id',
      onchange: (e: Event) => {
        const err = this.editor.setId((e.target as HTMLInputElement).value.trim());
        if (err !== null) this.fail(err);
        this.formChanged();
      },
    });
    box.append(
      this.labelled('Name', el('input', { type: 'text', value: doc.name, maxlength: 60, 'aria-label': 'Scenario name', onchange: (e: Event) => { this.editor.setMeta((e.target as HTMLInputElement).value, this.editor.doc.description); this.formChanged(); } })),
      this.labelled('Id', idInput),
      this.labelled('About', el('input', { type: 'text', value: doc.description, maxlength: 400, 'aria-label': 'Description', onchange: (e: Event) => { this.editor.setMeta(this.editor.doc.name, (e.target as HTMLInputElement).value); this.formChanged(); } })),
      this.labelled('Time', hour),
      this.labelled('Weather', weather),
      el('p', { class: 'hint' }, `${String(doc.npcs.length)}/${String(SCENARIO_LIMITS.npcs)} people · ${String(doc.vehicles.length)}/${String(SCENARIO_LIMITS.vehicles)} vehicles · ${String(doc.evidence.length)}/${String(SCENARIO_LIMITS.evidence)} items`),
    );
  }

  private renderLibrary(): void {
    const box = this.libraryBox;
    if (!box) return;
    clearChildren(box);
    const entries = libraryList(this.storage);
    box.appendChild(el('div', { class: 'row' }, el('button', { type: 'button', class: 'small', onclick: () => void this.saveToLibrary() }, 'Save to library'), el('span', { class: 'hint' }, `${String(entries.length)}/${String(LIBRARY_LIMIT)}`)));
    if (entries.length === 0) {
      box.appendChild(el('div', { class: 'sb-empty' }, 'No saved scenarios.'));
      return;
    }
    for (const e of entries) {
      box.appendChild(
        el(
          'div',
          { class: 'row sb-entry' },
          el('button', { type: 'button', class: 'small wide', onclick: () => void this.loadFromLibrary(e.id), title: e.id }, e.name),
          el('button', { type: 'button', class: 'small danger', 'aria-label': `Delete ${e.name}`, onclick: () => {
            if (typeof window === 'undefined' || typeof window.confirm !== 'function' || window.confirm(`Delete "${e.name}" from the library?`)) this.removeFromLibrary(e.id);
          } }, 'Delete'),
        ),
      );
    }
  }
}

/** A fresh scenario id: `scenario-` and a base-36 timestamp (UI only; never part of the simulation). */
function newId(): string {
  return `scenario-${Date.now().toString(36)}`;
}
