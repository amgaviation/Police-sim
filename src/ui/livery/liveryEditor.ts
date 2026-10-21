/**
 * The livery editor (Phase 7 §12.1): a 380 px panel on the right with tabs Paint, Decals, Lights, Equipment, Loadout and
 * Library; the world (the real vehicle in the station lot) stays visible on the left and orbits with the mouse. All
 * behaviour sits in `editorReducer` and the pure models; this class forwards user input to them and mirrors the state
 * into the DOM. Headless (no `document` or no `UIRoot`) it keeps the state and every method but builds no DOM.
 */
import { LIGHTBAR_PATTERNS } from '../../police/lightbar';
import { SIREN_TONE_NAMES } from '../../police/data';
import {
  FINISHES,
  LIVERY_FACES,
  LIVERY_FONTS,
  LIVERY_WEIGHTS,
  SHAPE_KINDS,
  LIGHTBAR_STYLES,
  WRAP_KINDS,
  exportLivery,
  newLiveryId,
  type LiveryDoc,
  type LiveryLayer,
} from '../../livery';
import type { LoadoutValidation, VehicleCapacity, VehicleLoadout } from '../../gear';
import type { VehicleModel } from '../../vehicles/model';
import { clearChildren, el, type Menu, type UIRoot } from '../ui';
import {
  EDITOR_TABS,
  EDITOR_TAB_LABELS,
  LAYER_NUMBER_FIELDS,
  STAR_POINTS_FIELD,
  createEditorState,
  documentToSave,
  duplicateDocument,
  editorCanSave,
  editorReducer,
  equipmentAvailability,
  layerLabel,
  type EditorAction,
  type EditorState,
} from './editorState';
import {
  actionButton,
  barField,
  checkField,
  colorField,
  selectField,
  sliderField,
  textField,
  type Option,
} from './fields';
import { effectiveLoadout, loadoutView, withRacked, withTrunkCount, type LoadoutView } from './loadoutModel';
import { PolygonPad } from './polygonPad';
import { ORBIT_RAD_PER_PX, ORBIT_ZOOM_PER_WHEEL, Throttle } from './preview';

/** What the editor needs from the app (design §12.1). */
export interface LiveryEditorHost {
  readonly unitId: string;
  readonly unitNumber: string;
  readonly dept: string;
  readonly model: VehicleModel;
  readonly fleetClass: string;
  readonly capacity: VehicleCapacity;
  library(): readonly LiveryDoc[];
  validateLoadout(l: VehicleLoadout): LoadoutValidation;
  /** Live 3D preview: the integrator applies the draft to the vehicle (the editor throttles this to 10 Hz). */
  preview(doc: LiveryDoc): void;
  /** Store in the library and apply to the unit. */
  save(doc: LiveryDoc): void;
  /** Restore the unit's livery. */
  cancel(): void;
  /** Plays 1.5 s of the tone. */
  sirenPreview?(tone: string): void;
  /** Preview camera: yaw / pitch in radians, zoom as a change of the distance multiplier. */
  orbit(dYaw: number, dPitch: number, dZoom: number): void;
}

const HEADLESS_ELEMENT = {} as HTMLElement;

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const options = <T extends string>(values: readonly T[], label: (v: T) => string = cap): Option<T>[] => values.map((v) => ({ value: v, label: label(v) }));

const FACE_LABELS: Readonly<Record<string, string>> = { sides: 'Both sides', left: 'Left side', right: 'Right side', hood: 'Hood', roof: 'Roof', front: 'Front', rear: 'Rear' };
const FONT_LABELS: Readonly<Record<string, string>> = { sans: 'Sans', serif: 'Serif', mono: 'Mono', stencil: 'Stencil' };
const WRAP_LABELS: Readonly<Record<string, string>> = { solid: 'Solid', twoTone: 'Two tone', fade: 'Fade', pinstripe: 'Pinstripe' };
const STYLE_LABELS: Readonly<Record<string, string>> = { roof: 'Roof light bar', hidden: 'Hidden lights', none: 'No lights' };

interface EditorDom {
  readonly root: HTMLDivElement;
  readonly orbit: HTMLDivElement;
  readonly subtitle: HTMLElement;
  readonly tabs: HTMLButtonElement[];
  readonly errors: HTMLElement;
  readonly body: HTMLElement;
  readonly save: HTMLButtonElement;
  readonly file: HTMLInputElement;
}

/** Download `text` as `filename` through a temporary link and Blob URL. */
function downloadText(filename: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export class LiveryEditor implements Menu {
  readonly id = 'livery-editor' as const;
  readonly element: HTMLElement;
  readonly pausesGame = true as const;

  private readonly ui: UIRoot | null;
  private readonly host: LiveryEditorHost;
  private readonly dom: EditorDom | null;
  private readonly throttle: Throttle<LiveryDoc>;
  private st: EditorState;
  private openFlag = false;
  private layerRows: HTMLElement[] = [];
  private dragging = false;
  private lastX = 0;
  private lastY = 0;

  constructor(ui: UIRoot | null, host: LiveryEditorHost, start: LiveryDoc) {
    this.ui = ui;
    this.host = host;
    this.st = createEditorState(start);
    this.throttle = new Throttle<LiveryDoc>((doc) => this.host.preview(doc));
    this.dom = ui !== null && typeof document !== 'undefined' ? this.build() : null;
    this.element = this.dom?.root ?? HEADLESS_ELEMENT;
    this.render();
  }

  /** The editor state (a new object after every accepted change). */
  get state(): Readonly<EditorState> {
    return this.st;
  }

  get isOpen(): boolean {
    return this.openFlag;
  }

  /** The Loadout tab's view of the current draft. */
  get loadout(): LoadoutView {
    const doc = this.st.doc;
    const l = effectiveLoadout(doc, this.host.model);
    return loadoutView(l, this.host.validateLoadout(l), this.host.capacity, doc.loadout === null);
  }

  /** Whether Save is available: the last change was accepted and an own loadout validates. */
  get canSave(): boolean {
    if (!editorCanSave(this.st)) return false;
    const own = this.st.doc.loadout;
    return own === null || this.host.validateLoadout(own).ok;
  }

  /** Runs `action` through the reducer; the preview follows the document. Returns the new state. */
  dispatch(action: EditorAction): EditorState {
    this.apply(action);
    return this.st;
  }

  /** Opens the editor on the menu stack and previews the draft. */
  open(): void {
    this.openFlag = true;
    this.host.preview(this.st.doc);
    this.ui?.push(this);
  }

  /** Stores the draft in the library (a default livery is saved under a new id) and closes; false when Save is disabled. */
  save(): boolean {
    if (!this.canSave) return false;
    const doc = documentToSave(this.st.doc, this.host.library().map((l) => l.id));
    this.throttle.cancel();
    this.host.save(doc);
    this.finish();
    return true;
  }

  /** Restores the unit's livery and closes. */
  cancel(): void {
    this.throttle.cancel();
    this.host.cancel();
    this.finish();
  }

  /** The draft as `.json` text (`exportLivery`). */
  exportText(): string {
    return exportLivery(this.st.doc);
  }

  /** Download the draft as `<id>.json`. */
  exportFile(): void {
    if (typeof document === 'undefined') return;
    downloadText(`${this.st.doc.id}.json`, this.exportText(), 'application/json');
  }

  /** Loads an imported document into the draft (an id already in the library gets a free one); errors stay in the state. */
  importText(text: string): EditorState {
    this.apply({ kind: 'import', text });
    return this.st;
  }

  onKeyDown(event: KeyboardEvent): boolean {
    if (!this.openFlag || event.key !== 'Escape') return false;
    this.cancel();
    return true;
  }

  onHide(): void {
    // Popped by someone else (the menu stack was cleared): behave like Cancel.
    if (this.openFlag && this.ui && !this.ui.isOpen(this)) {
      this.throttle.cancel();
      this.host.cancel();
      this.openFlag = false;
    }
  }

  dispose(): void {
    this.throttle.cancel();
  }

  // --- state plumbing -----------------------------------------------------------------------

  private finish(): void {
    this.openFlag = false;
    if (this.ui?.isOpen(this)) this.ui.pop(this);
  }

  private apply(action: EditorAction, light = false): void {
    const prev = this.st;
    this.st = editorReducer(prev, action);
    if (action.kind === 'import' && this.st.errors.length === 0 && this.st.doc !== prev.doc) this.freeImportedId();
    if (this.st === prev) return;
    if (this.st.doc !== prev.doc) this.throttle.push(this.st.doc);
    if (light && this.st.tab === prev.tab && this.st.selected === prev.selected) this.refreshChrome();
    else this.render();
  }

  /** An imported livery whose id is already in the library (or is a default's) is renamed so Save cannot overwrite it. */
  private freeImportedId(): void {
    const taken = this.host.library().map((l) => l.id);
    const id = this.st.doc.id;
    if (!taken.includes(id)) return;
    this.st = editorReducer(this.st, { kind: 'load', doc: { ...this.st.doc, id: newLiveryId(id, taken) } });
  }

  private patchSelected(patch: Record<string, unknown>, light = false): void {
    this.apply({ kind: 'updateLayer', index: this.st.selected, patch }, light);
  }

  // --- DOM ----------------------------------------------------------------------------------

  private build(): EditorDom {
    const orbit = el('div', { class: 'livery-orbit', title: 'Drag to orbit, wheel to zoom' });
    orbit.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      orbit.setPointerCapture?.(e.pointerId);
    });
    orbit.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.host.orbit((e.clientX - this.lastX) * ORBIT_RAD_PER_PX, (e.clientY - this.lastY) * ORBIT_RAD_PER_PX, 0);
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    const stop = (): void => {
      this.dragging = false;
    };
    orbit.addEventListener('pointerup', stop);
    orbit.addEventListener('pointercancel', stop);
    orbit.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.host.orbit(0, 0, e.deltaY * ORBIT_ZOOM_PER_WHEEL);
      },
      { passive: false },
    );

    const tabs = EDITOR_TABS.map((tab) =>
      el('button', { type: 'button', role: 'tab', 'aria-selected': 'false', onclick: () => this.apply({ kind: 'tab', tab }) }, EDITOR_TAB_LABELS[tab]),
    );
    const subtitle = el('div', { class: 'livery-sub' });
    const errors = el('div', { class: 'livery-errors', role: 'alert' });
    const body = el('div', { class: 'livery-body' });
    const save = el('button', { type: 'button', class: 'primary', onclick: () => this.save() }, 'Save');
    const file = el('input', {
      type: 'file',
      accept: '.json,application/json',
      hidden: true,
      onchange: (e: Event) => {
        const input = e.target as HTMLInputElement;
        const picked = input.files?.[0];
        if (!picked) return;
        const reader = new FileReader();
        reader.onload = () => {
          input.value = '';
          this.apply({ kind: 'import', text: typeof reader.result === 'string' ? reader.result : '' });
        };
        reader.readAsText(picked);
      },
    });
    const panel = el(
      'div',
      { class: 'livery-panel', role: 'dialog', 'aria-label': 'Livery editor' },
      el('div', { class: 'livery-head' }, el('h2', null, `Livery · ${this.host.unitId}`), subtitle),
      el('div', { class: 'livery-tabs', role: 'tablist' }, ...tabs),
      errors,
      body,
      el('div', { class: 'livery-foot' }, save, actionButton('Cancel', () => this.cancel())),
      file,
    );
    const root = el('div', { class: 'livery-root' }, orbit, panel);
    return { root, orbit, subtitle, tabs, errors, body, save, file };
  }

  /** Full refresh: tab strip, chrome and the active tab's body. */
  private render(): void {
    const dom = this.dom;
    if (!dom) return;
    EDITOR_TABS.forEach((tab, i) => dom.tabs[i]?.setAttribute('aria-selected', tab === this.st.tab ? 'true' : 'false'));
    this.layerRows = [];
    clearChildren(dom.body);
    switch (this.st.tab) {
      case 'paint':
        dom.body.append(this.paintTab());
        break;
      case 'decals':
        dom.body.append(this.decalsTab());
        break;
      case 'lights':
        dom.body.append(this.lightsTab());
        break;
      case 'equipment':
        dom.body.append(this.equipmentTab());
        break;
      case 'loadout':
        dom.body.append(this.loadoutTab());
        break;
      case 'library':
        dom.body.append(this.libraryTab());
        break;
    }
    this.refreshChrome();
  }

  /** Cheap refresh while a slider or text box is being edited: errors, the Save button and the layer list. */
  private refreshChrome(): void {
    const dom = this.dom;
    if (!dom) return;
    const doc = this.st.doc;
    dom.subtitle.textContent = `${this.host.dept} · unit ${this.host.unitNumber} · ${this.host.model.name}${this.st.dirty ? ' · edited' : ''}`;
    clearChildren(dom.errors);
    dom.errors.hidden = this.st.errors.length === 0;
    for (const e of this.st.errors) dom.errors.append(el('div', null, e));
    dom.save.disabled = !this.canSave;
    this.layerRows.forEach((row, i) => {
      const layer = doc.layers[i];
      if (layer) row.textContent = layerLabel(layer);
    });
  }

  private section(title: string, ...children: (HTMLElement | null)[]): HTMLElement {
    return el('section', { class: 'livery-section' }, el('h3', null, title), ...children);
  }

  // --- Paint --------------------------------------------------------------------------------

  private paintTab(): HTMLElement {
    const doc = this.st.doc;
    const wrap = doc.wrap;
    const wrapKinds: Option<string>[] = [{ value: 'none', label: 'No wrap' }, ...options(WRAP_KINDS, (k) => WRAP_LABELS[k] ?? k)];
    const wrapColors = wrap === null ? 0 : wrap.kind === 'solid' ? 1 : Math.min(3, Math.max(2, wrap.colors.length));
    const wrapFields: HTMLElement[] = [];
    if (wrap !== null) {
      for (let i = 0; i < wrapColors; i++) {
        wrapFields.push(
          colorField(`Wrap colour ${String(i + 1)}`, wrap.colors[i] ?? wrap.colors[0] ?? '#808080', (hex) => {
            const colors = [...wrap.colors];
            while (colors.length < wrapColors) colors.push(colors[0] ?? '#808080');
            colors[i] = hex;
            this.apply({ kind: 'setWrap', wrap: { ...wrap, colors } }, true);
          }),
        );
      }
      wrapFields.push(
        sliderField({ key: 'split', label: 'Split', min: 0, max: 1, step: 0.01 }, wrap.split, (v) => this.apply({ kind: 'setWrap', wrap: { ...wrap, split: v } }, true)),
      );
    }
    return el(
      'div',
      null,
      this.section(
        'Name',
        textField('Name', doc.name, (v) => this.apply({ kind: 'rename', name: v }, true), { maxLength: 40 }),
      ),
      this.section(
        'Base paint',
        colorField('Colour', doc.base.color, (hex) => this.apply({ kind: 'setBase', color: hex }, true)),
        selectField('Finish', options(FINISHES), doc.base.finish, (v) => this.apply({ kind: 'setBase', finish: v })),
      ),
      this.section(
        'Wrap',
        selectField('Kind', wrapKinds, wrap === null ? 'none' : wrap.kind, (v) => {
          if (v === 'none') this.apply({ kind: 'setWrap', wrap: null });
          else this.apply({ kind: 'setWrap', wrap: { kind: v as NonNullable<LiveryDoc['wrap']>['kind'], colors: wrap?.colors ?? [doc.base.color], split: wrap?.split ?? 0.5 } });
        }),
        ...wrapFields,
      ),
    );
  }

  // --- Decals -------------------------------------------------------------------------------

  private decalsTab(): HTMLElement {
    const doc = this.st.doc;
    const list = el('div', { class: 'livery-layers', role: 'listbox', 'aria-label': 'Layers' });
    doc.layers.forEach((layer, i) => {
      const label = el('button', {
        type: 'button',
        class: `livery-layer${i === this.st.selected ? ' livery-selected' : ''}`,
        role: 'option',
        'aria-selected': i === this.st.selected ? 'true' : 'false',
        onclick: () => this.apply({ kind: 'select', index: i }),
      });
      label.textContent = layerLabel(layer);
      this.layerRows.push(label);
      list.append(
        el(
          'div',
          { class: 'livery-layer-row' },
          label,
          actionButton('↑', () => this.apply({ kind: 'moveLayer', index: i, dir: -1 }), 'small', i === 0),
          actionButton('↓', () => this.apply({ kind: 'moveLayer', index: i, dir: 1 }), 'small', i === doc.layers.length - 1),
          actionButton('Delete', () => this.apply({ kind: 'removeLayer', index: i }), 'small danger'),
        ),
      );
    });
    if (doc.layers.length === 0) list.append(el('div', { class: 'livery-hint' }, 'No decals yet. Add one below.'));
    const adders = el(
      'div',
      { class: 'livery-adders' },
      actionButton('+ Stripe', () => this.apply({ kind: 'addLayer', layer: 'stripe' }), 'small'),
      actionButton('+ Shape', () => this.apply({ kind: 'addLayer', layer: 'shape' }), 'small'),
      actionButton('+ Text', () => this.apply({ kind: 'addLayer', layer: 'text' }), 'small'),
      actionButton('+ Checker', () => this.apply({ kind: 'addLayer', layer: 'checker' }), 'small'),
    );
    const layer = doc.layers[this.st.selected];
    return el('div', null, this.section(`Layers (${String(doc.layers.length)}/32)`, list, adders), layer ? this.layerFields(layer) : null);
  }

  private layerFields(layer: LiveryLayer): HTMLElement {
    const fields: HTMLElement[] = [
      selectField('Face', options(LIVERY_FACES, (f) => FACE_LABELS[f] ?? f), layer.face, (v) => this.patchSelected({ face: v })),
    ];
    if (layer.type === 'shape') {
      fields.push(selectField('Shape', options(SHAPE_KINDS), layer.shape, (v) => this.patchSelected({ shape: v })));
    }
    if (layer.type === 'text') {
      fields.push(textField('Text', layer.text, (v) => this.patchSelected({ text: v }, true), { maxLength: 24 }));
      fields.push(el('div', { class: 'livery-hint' }, 'Tokens: {unit} is the unit number, {dept} the department.'));
    }
    const record = layer as unknown as Record<string, unknown>;
    for (const spec of LAYER_NUMBER_FIELDS[layer.type]) {
      const value = record[spec.key];
      if (typeof value !== 'number') continue;
      fields.push(sliderField(spec, value, (v) => this.patchSelected({ [spec.key]: v }, true)));
    }
    if (layer.type === 'shape' && layer.shape === 'star') {
      fields.push(sliderField(STAR_POINTS_FIELD, layer.starPoints ?? 5, (v) => this.patchSelected({ starPoints: v }, true)));
    }
    if (layer.type === 'shape' && layer.shape === 'polygon') {
      const pad = new PolygonPad({ points: layer.points ?? [], minPoints: 3, onChange: (points) => this.patchSelected({ points }) });
      fields.push(el('div', { class: 'livery-field' }, el('span', { class: 'livery-label' }, 'Outline'), pad.element));
    }
    if (layer.type === 'checker') {
      fields.push(colorField('Colour 1', layer.colors[0], (hex) => this.patchSelected({ colors: [hex, layer.colors[1]] }, true)));
      fields.push(colorField('Colour 2', layer.colors[1], (hex) => this.patchSelected({ colors: [layer.colors[0], hex] }, true)));
    } else {
      fields.push(colorField('Colour', layer.color, (hex) => this.patchSelected({ color: hex }, true)));
    }
    if (layer.type === 'shape' || layer.type === 'text') {
      fields.push(
        checkField('Outline', layer.outline !== null, (on) => this.patchSelected({ outline: on ? '#000000' : null })),
      );
      if (layer.outline !== null) fields.push(colorField('Outline colour', layer.outline, (hex) => this.patchSelected({ outline: hex }, true)));
    }
    if (layer.type === 'text') {
      fields.push(selectField('Font', options(LIVERY_FONTS, (f) => FONT_LABELS[f] ?? f), layer.font, (v) => this.patchSelected({ font: v })));
      fields.push(selectField('Weight', options(LIVERY_WEIGHTS), layer.weight, (v) => this.patchSelected({ weight: v })));
      fields.push(checkField('Italic', layer.italic, (on) => this.patchSelected({ italic: on })));
    }
    fields.push(checkField('Reflective (glows at night)', layer.reflective, (on) => this.patchSelected({ reflective: on })));
    return this.section('Selected layer', ...fields);
  }

  // --- Lights -------------------------------------------------------------------------------

  private lightsTab(): HTMLElement {
    const lights = this.st.doc.lights;
    const patterns: Option<string>[] = LIGHTBAR_PATTERNS.map((p) => ({ value: p.id, label: p.label }));
    const preview = actionButton('Preview', () => this.host.sirenPreview?.(lights.siren), 'small', this.host.sirenPreview === undefined);
    return this.section(
      'Lights and siren',
      selectField('Style', options(LIGHTBAR_STYLES, (s) => STYLE_LABELS[s] ?? s), lights.style, (v) => this.apply({ kind: 'setLights', patch: { style: v } })),
      selectField('Pattern', patterns, lights.pattern, (v) => this.apply({ kind: 'setLights', patch: { pattern: v } })),
      selectField('Siren tone', options(SIREN_TONE_NAMES), lights.siren, (v) => this.apply({ kind: 'setLights', patch: { siren: v } })),
      el('div', { class: 'livery-field' }, preview),
    );
  }

  // --- Equipment ----------------------------------------------------------------------------

  private equipmentTab(): HTMLElement {
    const eq = this.st.doc.equipment;
    const avail = equipmentAvailability(this.host.model);
    const box = (label: string, key: 'pushBar' | 'spotlight' | 'partition'): HTMLElement =>
      checkField(label, avail[key].enabled && eq[key], (on) => this.apply({ kind: 'setEquipment', patch: { [key]: on } }), {
        disabled: !avail[key].enabled,
        hint: avail[key].hint,
      });
    return this.section('Equipment', box('Push bar', 'pushBar'), box('Spotlight', 'spotlight'), box('Prisoner partition', 'partition'));
  }

  // --- Loadout ------------------------------------------------------------------------------

  private loadoutTab(): HTMLElement {
    const view = this.loadout;
    const l = view.loadout;
    const rackSlots = this.host.capacity.rackSlots;
    const rows = view.rows.map((r) =>
      el(
        'div',
        { class: 'livery-loadout-row', role: 'group', 'aria-label': `${r.label}: ${String(r.count)}` },
        el('span', { class: 'livery-loadout-name' }, r.label),
        actionButton('−', () => this.apply({ kind: 'setLoadout', loadout: withTrunkCount(l, r.id, r.count - 1) }), 'small', r.count === 0, `Remove one ${r.label} (${String(r.count)} now)`),
        el('span', { class: 'livery-value' }, String(r.count)),
        actionButton('+', () => this.apply({ kind: 'setLoadout', loadout: withTrunkCount(l, r.id, r.count + 1) }), 'small', false, `Add one ${r.label} (${String(r.count)} now)`),
      ),
    );
    const rack = view.rack.map((b) =>
      checkField(b.label, b.checked, (on) => this.apply({ kind: 'setLoadout', loadout: withRacked(l, b.id, on, rackSlots) }), { disabled: !b.enabled }),
    );
    const messages = [...view.errors.map((m) => el('div', { class: 'livery-msg livery-msg-error' }, m)), ...view.warnings.map((m) => el('div', { class: 'livery-msg' }, m))];
    return el(
      'div',
      null,
      this.section(
        'Vehicle loadout',
        el('div', { class: 'livery-hint' }, view.isDefault ? 'Using the unit’s default loadout.' : 'Custom loadout for this livery.'),
        actionButton('Use default', () => this.apply({ kind: 'setLoadout', loadout: null }), 'small', view.isDefault),
        barField('Weight', view.weight.used, view.weight.cap, ' kg'),
        barField('Trunk slots', view.slots.used, view.slots.cap, ''),
        barField('Rack', view.rackSlots.used, view.rackSlots.cap, ''),
        ...messages,
      ),
      this.section('Trunk', ...rows),
      this.section('Rack', ...(rackSlots > 0 ? rack : [el('div', { class: 'livery-hint' }, 'This vehicle has no long-gun rack.')])),
    );
  }

  // --- Library ------------------------------------------------------------------------------

  private libraryTab(): HTMLElement {
    const dom = this.dom;
    const library = this.host.library();
    const taken = library.map((l) => l.id);
    const rows = library.map((doc) =>
      el(
        'div',
        { class: 'livery-lib-row' },
        el('span', { class: 'livery-loadout-name' }, `${doc.name}`, el('span', { class: 'livery-hint' }, ` ${doc.id}${doc.author !== '' ? ` · ${doc.author}` : ''}`)),
        actionButton('Apply', () => this.apply({ kind: 'load', doc }), 'small'),
        actionButton('Duplicate', () => this.apply({ kind: 'load', doc: duplicateDocument(doc, taken) }), 'small'),
      ),
    );
    return el(
      'div',
      null,
      this.section('Library', ...(rows.length > 0 ? rows : [el('div', { class: 'livery-hint' }, 'The library is empty.')])),
      this.section(
        'Share',
        el(
          'div',
          { class: 'livery-adders' },
          actionButton('Export', () => this.exportFile(), 'small'),
          actionButton('Import…', () => dom?.file.click(), 'small'),
        ),
        el('div', { class: 'livery-hint' }, 'Files are .json; an imported livery replaces the draft and is checked before it loads.'),
      ),
    );
  }
}
