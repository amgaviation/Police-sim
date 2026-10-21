import './dispatch.css';
import type { RoadGraph } from '../../world/roadGraph';
import { clampView, panView, zoomView, MAP_ZOOM_STEP, type MapView } from '../mdt/map';
import { setText } from '../panels/dom';
import { clearChildren, el, type Menu, type UIRoot } from '../ui';
import { drawConsoleMap, frameView, pickMarker, worldAt, type MapHit } from './map';
import {
  callsSignature,
  consoleModel,
  detailSignature,
  formatAge,
  formatEta,
  orderLabel,
  reduceConsoleKey,
  statusLabel,
  unitsSignature,
  type ConsoleAction,
  type ConsoleModel,
  type ConsolePriority,
  type ConsoleUiState,
  type DispatchConsolePort,
} from './model';
import { RoadCache } from './roads';

export { consoleModel, suggestUnits } from './model';
export type { ConsoleCall, ConsoleUnit, DispatchConsolePort } from './model';

/** Rebuild period (ms): at most 4 Hz. */
export const CONSOLE_TICK_MS = 250;
const CANVAS_W = 720;
const CANVAS_H = 440;
const HEADLESS_ELEMENT = {} as HTMLElement;

function isTypingTarget(target: EventTarget | null | undefined): boolean {
  const tag = (target as { tagName?: unknown } | null | undefined)?.tagName;
  const name = typeof tag === 'string' ? tag.toLowerCase() : '';
  return name === 'input' || name === 'textarea' || name === 'select';
}

interface Dom {
  root: HTMLElement;
  title: HTMLElement;
  score: HTMLElement;
  status: HTMLElement;
  queue: HTMLElement;
  units: HTMLElement;
  canvas: HTMLCanvasElement;
  info: HTMLElement;
  premise: HTMLElement;
  notes: HTMLElement;
  noteInput: HTMLInputElement;
  suggest: HTMLElement;
  priority: HTMLButtonElement[];
  dispo: HTMLSelectElement;
  closeBtn: HTMLButtonElement;
  orders: HTMLElement;
  createRow: HTMLElement;
  createType: HTMLSelectElement;
  createPriority: HTMLSelectElement;
}

/**
 * Dispatch console (design 12.1). A non-pausing `Menu`: queue left, map centre, units right, detail bottom. It reads and
 * writes only through a `DispatchConsolePort` (local dispatcher or co-op room). Keys: Up / Down call, Left / Right unit,
 * A assign, U unassign, 1-4 priority, N note, C create then click the map, Escape -> `onEscape`. `update(nowMs)` is
 * called every frame by the app and does real work at most every 250 ms. Headless (no `document` or no `UIRoot`) it keeps
 * the model and the key handling but builds no DOM.
 */
export class DispatchConsole implements Menu {
  readonly id = 'dispatch-console';
  readonly element: HTMLElement;
  readonly pausesGame = false as const;

  private readonly ui: UIRoot | null;
  private readonly port: DispatchConsolePort;
  private readonly onEscape: () => void;
  private readonly dom: Dom | null;
  private readonly roads: RoadCache;
  private readonly view: MapView = { cx: 0, cz: 0, scale: 0.1, width: CANVAS_W, height: CANVAS_H };
  private state: ConsoleUiState = { sel: { callId: null, unit: null }, creating: false };
  private current: ConsoleModel;
  private openFlag = false;
  private framed = false;
  private lastRev = -1;
  private lastTick = Number.NEGATIVE_INFINITY;
  private queueSig = '';
  private unitSig = '';
  private detailSig = '';
  private ageCells: { el: HTMLElement; id: number }[] = [];
  private statusText = '';
  private drag: { x: number; y: number; moved: boolean } | null = null;

  constructor(ui: UIRoot | null, port: DispatchConsolePort, graph: RoadGraph, onEscape: () => void) {
    this.ui = ui;
    this.port = port;
    this.onEscape = onEscape;
    this.roads = new RoadCache(graph);
    this.current = consoleModel(port, this.state.sel);
    this.dom = ui !== null && typeof document !== 'undefined' ? this.build() : null;
    this.element = this.dom?.root ?? HEADLESS_ELEMENT;
  }

  get isOpen(): boolean {
    return this.openFlag;
  }

  /** The model of the last update (tests, diagnostics). */
  get model(): ConsoleModel {
    return this.current;
  }

  /** Selection and "creating" flag. */
  get uiState(): Readonly<ConsoleUiState> {
    return this.state;
  }

  /** Last status line ("Assigned N1 to 25-0004"). */
  get statusLine(): string {
    return this.statusText;
  }

  open(): void {
    this.openFlag = true;
    this.lastRev = -1;
    this.lastTick = Number.NEGATIVE_INFINITY;
    this.refresh();
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

  /** Called every frame: rebuilds the lists on a revision change and repaints the map, both at most 4 Hz. */
  update(nowMs: number): void {
    if (!this.openFlag || nowMs - this.lastTick < CONSOLE_TICK_MS) return;
    this.lastTick = nowMs;
    const rev = this.port.revision();
    this.current = consoleModel(this.port, this.state.sel);
    this.state.sel = { ...this.current.sel };
    if (rev !== this.lastRev) {
      this.lastRev = rev;
      this.renderLists();
    } else {
      this.renderAges();
    }
    this.drawMap();
  }

  /** Recomputes the model and repaints everything now (selection changes, open). */
  refresh(): void {
    this.current = consoleModel(this.port, this.state.sel);
    this.state.sel = { ...this.current.sel };
    this.lastRev = this.port.revision();
    this.renderLists();
    this.drawMap();
  }

  /** Runs one key through the reducer and performs its action; true when the key was consumed. */
  handleKey(key: string): boolean {
    this.current = consoleModel(this.port, this.state.sel);
    const r = reduceConsoleKey(this.current, this.state, key);
    if (!r.consumed) return false;
    const selectionChanged = r.ui.sel.callId !== this.state.sel.callId || r.ui.sel.unit !== this.state.sel.unit;
    const creatingChanged = r.ui.creating !== this.state.creating;
    this.state = r.ui;
    if (r.action) this.perform(r.action);
    else if (selectionChanged || creatingChanged) this.refresh();
    return true;
  }

  onKeyDown(event: KeyboardEvent): boolean {
    if (!this.openFlag) return false;
    if (event.ctrlKey || event.altKey || event.metaKey) return false;
    if (isTypingTarget(event.target)) {
      if (event.key === 'Escape') {
        (event.target as { blur?: () => void } | null)?.blur?.();
        return true;
      }
      return false;
    }
    if (event.key === '+' || event.key === '=') return this.zoom(MAP_ZOOM_STEP);
    if (event.key === '-' || event.key === '_') return this.zoom(1 / MAP_ZOOM_STEP);
    if (event.key === 'f' || event.key === 'F') {
      this.frame();
      this.drawMap();
      return true;
    }
    return this.handleKey(event.key);
  }

  // --- Actions ----------------------------------------------------------------------------------------------

  private perform(a: ConsoleAction): void {
    switch (a.kind) {
      case 'assign':
        this.port.assign(a.callId, a.callsign);
        this.say(`Assigned ${a.callsign} to ${this.callNumber(a.callId)}`);
        break;
      case 'unassign':
        this.port.unassign(a.callId, a.callsign);
        this.say(`Unassigned ${a.callsign} from ${this.callNumber(a.callId)}`);
        break;
      case 'priority':
        this.port.setPriority(a.callId, a.priority);
        this.say(`${this.callNumber(a.callId)} priority ${String(a.priority)}`);
        break;
      case 'focusNote':
        this.dom?.noteInput.focus();
        break;
      case 'escape':
        this.onEscape();
        break;
    }
    if (a.kind !== 'escape' && a.kind !== 'focusNote') this.refresh();
  }

  private callNumber(id: number): string {
    return this.current.calls.find((c) => c.id === id)?.number ?? `#${String(id)}`;
  }

  private say(text: string): void {
    this.statusText = text;
    if (this.dom) setText(this.dom.status, text);
  }

  private select(callId: number | null, unit: string | null): void {
    this.state = { ...this.state, sel: { callId, unit } };
    this.refresh();
  }

  private addNote(): void {
    const dom = this.dom;
    const call = this.current.call;
    if (!dom || !call) return;
    const text = dom.noteInput.value.trim();
    if (text === '') return;
    this.port.note(call.id, text);
    dom.noteInput.value = '';
    this.say(`Note added to ${call.number}`);
    this.refresh();
  }

  private closeCall(): void {
    const dom = this.dom;
    const call = this.current.call;
    if (!dom || !call) return;
    const disposition = dom.dispo.value || (this.port.dispositions[0]?.id ?? '');
    if (disposition === '') return;
    this.port.close(call.id, disposition);
    this.say(`Closed ${call.number}`);
    this.refresh();
  }

  private sendOrder(order: string): void {
    const unit = this.current.unit;
    if (!unit) return;
    this.port.order(unit.callsign, order, unit.callId ?? this.current.call?.id ?? null);
    this.say(`${orderLabel(order)}: ${unit.callsign}`);
  }

  private createAt(x: number, z: number): void {
    const dom = this.dom;
    if (!dom || !this.state.creating) return;
    const typeId = dom.createType.value || (this.port.callTypes()[0]?.id ?? '');
    if (typeId === '') {
      this.say('Pick a call type first');
      return;
    }
    const priority = Number(dom.createPriority.value) as ConsolePriority;
    this.port.create(typeId, priority >= 1 && priority <= 4 ? priority : 3, x, z);
    this.state = { ...this.state, creating: false };
    this.say('Call created');
    this.refresh();
  }

  // --- Map --------------------------------------------------------------------------------------------------

  private zoom(factor: number): boolean {
    zoomView(this.view, factor, this.view.width / 2, this.view.height / 2);
    this.drawMap();
    return true;
  }

  private frame(): void {
    const f = frameView(this.view.width, this.view.height, this.current.calls, this.current.units);
    this.view.cx = f.cx;
    this.view.cz = f.cz;
    this.view.scale = f.scale;
    clampView(this.view);
    this.framed = true;
  }

  private drawMap(): void {
    const dom = this.dom;
    if (!dom) return;
    if (!this.framed) this.frame();
    const ctx = dom.canvas.getContext('2d');
    if (!ctx) return;
    drawConsoleMap(ctx, this.roads, this.view, this.current.calls, this.current.units, {
      selectedCall: this.current.sel.callId,
      selectedUnit: this.current.sel.unit,
      creating: this.state.creating,
    });
  }

  private canvasPoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const canvas = this.dom?.canvas;
    const rect = canvas?.getBoundingClientRect();
    if (!canvas || !rect || rect.width <= 0 || rect.height <= 0) return { x: e.clientX, y: e.clientY };
    return { x: ((e.clientX - rect.left) * canvas.width) / rect.width, y: ((e.clientY - rect.top) * canvas.height) / rect.height };
  }

  private mapClick(px: number, py: number): void {
    if (this.state.creating) {
      const w = worldAt(this.view, px, py);
      this.createAt(w.x, w.z);
      return;
    }
    const hit: MapHit | null = pickMarker(this.view, this.current.calls, this.current.units, px, py);
    if (!hit) return;
    if (hit.kind === 'call') this.select(hit.id, this.state.sel.unit);
    else this.select(this.state.sel.callId, hit.callsign);
  }

  // --- DOM --------------------------------------------------------------------------------------------------

  private renderLists(): void {
    const dom = this.dom;
    if (!dom) return;
    const m = this.current;
    setText(dom.title, m.title);
    setText(dom.score, m.score ?? '');
    dom.score.hidden = m.score === null;
    const qSig = callsSignature(m.calls, m.sel.callId);
    if (qSig !== this.queueSig) {
      this.queueSig = qSig;
      this.renderQueue(dom, m);
    }
    const uSig = unitsSignature(m.units, m.sel.unit);
    if (uSig !== this.unitSig) {
      this.unitSig = uSig;
      this.renderUnits(dom, m);
    }
    const dSig = `${detailSignature(m)}|${String(this.state.creating)}`;
    if (dSig !== this.detailSig) {
      this.detailSig = dSig;
      this.renderDetail(dom, m);
    }
    this.renderAges();
  }

  private renderAges(): void {
    const byId = new Map(this.current.calls.map((c) => [c.id, c.ageS]));
    for (const cell of this.ageCells) setText(cell.el, formatAge(byId.get(cell.id) ?? 0));
  }

  private renderQueue(dom: Dom, m: ConsoleModel): void {
    clearChildren(dom.queue);
    this.ageCells = [];
    if (m.calls.length === 0) {
      dom.queue.appendChild(el('div', { class: 'dc-empty' }, 'No open calls.'));
      return;
    }
    for (const c of m.calls) {
      const age = el('span', { class: 'dc-age' }, formatAge(c.ageS));
      this.ageCells.push({ el: age, id: c.id });
      dom.queue.appendChild(
        el(
          'button',
          {
            class: `dc-row${c.id === m.sel.callId ? ' dc-selected' : ''}`,
            type: 'button',
            'aria-pressed': c.id === m.sel.callId ? 'true' : 'false',
            title: `${c.address} (${c.district})`,
            onclick: () => this.select(c.id, this.state.sel.unit),
          },
          el('span', { class: `dc-chip dc-p${String(c.priority)}` }, `P${String(c.priority)}`),
          el('span', { class: 'dc-nature' }, c.nature),
          age,
          el('span', { class: 'dc-state' }, c.status === 'pending' ? 'pending' : c.units.join(' ')),
        ),
      );
    }
  }

  private renderUnits(dom: Dom, m: ConsoleModel): void {
    clearChildren(dom.units);
    if (m.units.length === 0) {
      dom.units.appendChild(el('div', { class: 'dc-empty' }, 'No units.'));
      return;
    }
    for (const u of m.units) {
      const call = u.callId === null ? undefined : m.calls.find((c) => c.id === u.callId);
      dom.units.appendChild(
        el(
          'button',
          {
            class: `dc-row dc-unit dc-s-${u.status}${u.callsign === m.sel.unit ? ' dc-selected' : ''}`,
            type: 'button',
            'aria-pressed': u.callsign === m.sel.unit ? 'true' : 'false',
            title: u.label,
            onclick: () => this.select(this.state.sel.callId, u.callsign),
          },
          el('span', { class: 'dc-callsign' }, u.callsign),
          el('span', { class: 'dc-state' }, statusLabel(u.status)),
          el('span', { class: 'dc-state' }, call ? call.number : ''),
          el('span', { class: 'dc-age' }, formatEta(u.etaS)),
        ),
      );
    }
  }

  private renderDetail(dom: Dom, m: ConsoleModel): void {
    const c = m.call;
    clearChildren(dom.info);
    clearChildren(dom.premise);
    clearChildren(dom.notes);
    clearChildren(dom.suggest);
    clearChildren(dom.orders);
    dom.noteInput.disabled = c === null;
    dom.closeBtn.disabled = c === null;
    dom.dispo.disabled = c === null;
    for (const b of dom.priority) {
      b.disabled = c === null;
      b.setAttribute('aria-pressed', c !== null && Number(b.textContent) === c.priority ? 'true' : 'false');
    }
    dom.createRow.hidden = !m.canCreate;
    if (!c) {
      dom.info.appendChild(el('div', { class: 'dc-empty' }, 'Select a call.'));
      return;
    }
    dom.info.append(
      el('div', { class: 'dc-title' }, `${c.number} · ${c.nature}`),
      el('div', { class: 'dc-meta' }, `${c.address} · ${c.district} · priority ${String(c.priority)} · ${c.status}`),
      el('div', { class: 'dc-meta' }, c.units.length > 0 ? `Units: ${c.units.join(', ')}` : 'No units assigned'),
    );
    dom.premise.appendChild(el('h3', null, 'Premise history'));
    if (c.premise.length === 0) dom.premise.appendChild(el('div', { class: 'dc-empty' }, 'No prior calls at this address.'));
    else for (const line of c.premise.slice(0, 6)) dom.premise.appendChild(el('div', { class: 'dc-line' }, line));
    dom.notes.appendChild(el('h3', null, 'Notes'));
    if (c.notes.length === 0) dom.notes.appendChild(el('div', { class: 'dc-empty' }, 'No notes.'));
    else for (const line of c.notes.slice(-6)) dom.notes.appendChild(el('div', { class: 'dc-line' }, line));
    if (m.suggestions.length > 0) {
      dom.suggest.appendChild(el('span', { class: 'dc-label' }, 'Suggested:'));
      for (const callsign of m.suggestions) {
        const u = m.units.find((x) => x.callsign === callsign);
        const eta = u ? formatEta(u.etaS) : '';
        dom.suggest.appendChild(
          el(
            'button',
            { type: 'button', class: 'small', onclick: () => this.perform({ kind: 'assign', callId: c.id, callsign }) },
            eta === '' ? `Assign ${callsign}` : `Assign ${callsign} (${eta})`,
          ),
        );
      }
    }
    const unit = m.unit;
    if (unit && c.units.includes(unit.callsign)) {
      dom.suggest.appendChild(
        el(
          'button',
          { type: 'button', class: 'small', onclick: () => this.perform({ kind: 'unassign', callId: c.id, callsign: unit.callsign }) },
          `Unassign ${unit.callsign}`,
        ),
      );
    }
    if (this.port.orders.length > 0 && unit) {
      dom.orders.appendChild(el('span', { class: 'dc-label' }, `Order to ${unit.callsign}:`));
      for (const order of this.port.orders) {
        dom.orders.appendChild(el('button', { type: 'button', class: 'small', onclick: () => this.sendOrder(order) }, orderLabel(order)));
      }
    }
  }

  private build(): Dom {
    const port = this.port;
    const title = el('h1', { class: 'dc-heading' }, port.title);
    const score = el('span', { class: 'dc-score', role: 'status' });
    const status = el('p', { class: 'hint dc-status', role: 'status', 'aria-live': 'polite' });
    const queue = el('div', { class: 'dc-list', role: 'group', 'aria-label': 'Call queue' });
    const units = el('div', { class: 'dc-list', role: 'group', 'aria-label': 'Units' });
    const canvas = el('canvas', { class: 'dc-map', width: CANVAS_W, height: CANVAS_H, role: 'img', 'aria-label': 'Dispatch map. Click a marker to select it. Plus and minus zoom, F fits all markers.' });
    canvas.addEventListener('pointerdown', (e) => {
      const p = this.canvasPoint(e);
      this.drag = { x: p.x, y: p.y, moved: false };
      canvas.setPointerCapture?.(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d) return;
      const p = this.canvasPoint(e);
      if (!d.moved && Math.hypot(p.x - d.x, p.y - d.y) < 4) return;
      d.moved = true;
      panView(this.view, p.x - d.x, p.y - d.y);
      d.x = p.x;
      d.y = p.y;
      this.drawMap();
    });
    const release = (e: PointerEvent, click: boolean): void => {
      const d = this.drag;
      this.drag = null;
      if (click && d && !d.moved) {
        const p = this.canvasPoint(e);
        this.mapClick(p.x, p.y);
      }
    };
    canvas.addEventListener('pointerup', (e) => release(e, true));
    canvas.addEventListener('pointercancel', (e) => release(e, false));
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const p = this.canvasPoint(e);
        zoomView(this.view, e.deltaY < 0 ? MAP_ZOOM_STEP : 1 / MAP_ZOOM_STEP, p.x, p.y);
        this.drawMap();
      },
      { passive: false },
    );

    const info = el('div', { class: 'dc-info' });
    const premise = el('div', { class: 'dc-premise' });
    const notes = el('div', { class: 'dc-notes' });
    const noteInput = el('input', {
      type: 'text',
      class: 'dc-note-input',
      placeholder: 'Note for the selected call (N)',
      maxlength: 200,
      autocomplete: 'off',
      'aria-label': 'Call note',
      onkeydown: (e: Event) => {
        if ((e as KeyboardEvent).key === 'Enter') this.addNote();
      },
    });
    const suggest = el('div', { class: 'row dc-suggest' });
    const priority = ([1, 2, 3, 4] as const).map((p) =>
      el('button', { type: 'button', class: `small dc-p${String(p)}`, title: `Priority ${String(p)}`, onclick: () => this.handleKey(String(p)) }, String(p)),
    );
    const dispo = el(
      'select',
      { 'aria-label': 'Disposition' },
      ...port.dispositions.map((d) => el('option', { value: d.id }, d.label)),
    );
    const closeBtn = el('button', { type: 'button', class: 'small', onclick: () => this.closeCall() }, 'Close call');
    const orders = el('div', { class: 'row dc-orders' });
    const createType = el('select', { 'aria-label': 'Call type to create' }, ...port.callTypes().map((t) => el('option', { value: t.id }, t.label)));
    const createPriority = el(
      'select',
      { 'aria-label': 'Priority of the new call' },
      ...(['1', '2', '3', '4'] as const).map((v) => el('option', { value: v }, `Priority ${v}`)),
    );
    createPriority.value = '3';
    const createRow = el(
      'div',
      { class: 'row dc-create' },
      el('span', { class: 'dc-label' }, 'New call:'),
      createType,
      createPriority,
      el('button', { type: 'button', class: 'small', onclick: () => this.handleKey('c') }, 'Place on map (C)'),
    );
    createRow.hidden = !port.canCreate;

    const root = el(
      'div',
      { class: 'panel dispatch-console', role: 'dialog', 'aria-label': 'Dispatch console' },
      el('div', { class: 'row dc-head' }, title, score, el('button', { type: 'button', class: 'small', onclick: () => this.onEscape() }, 'Close (Esc)')),
      el(
        'div',
        { class: 'dc-grid' },
        el('section', { class: 'dc-col', 'aria-label': 'Queue' }, el('h2', null, 'Queue'), queue),
        el(
          'section',
          { class: 'dc-col dc-center', 'aria-label': 'Map' },
          canvas,
          el(
            'div',
            { class: 'row dc-maptools' },
            el('button', { type: 'button', class: 'small', onclick: () => void this.zoom(MAP_ZOOM_STEP) }, '+'),
            el('button', { type: 'button', class: 'small', onclick: () => void this.zoom(1 / MAP_ZOOM_STEP) }, '−'),
            el('button', { type: 'button', class: 'small', onclick: () => { this.frame(); this.drawMap(); } }, 'Fit'),
          ),
        ),
        el('section', { class: 'dc-col', 'aria-label': 'Units' }, el('h2', null, 'Units'), units),
      ),
      el(
        'section',
        { class: 'dc-detail', 'aria-label': 'Call detail' },
        info,
        el('div', { class: 'dc-cols' }, premise, notes),
        el('div', { class: 'row' }, noteInput, el('button', { type: 'button', class: 'small', onclick: () => this.addNote() }, 'Add note')),
        suggest,
        el('div', { class: 'row' }, el('span', { class: 'dc-label' }, 'Priority:'), ...priority, el('span', { class: 'dc-label' }, 'Close:'), dispo, closeBtn),
        orders,
        createRow,
      ),
      status,
      el('p', { class: 'hint' }, '↑↓ call · ←→ unit · A assign · U unassign · 1-4 priority · N note · C create · +/− zoom · F fit · Esc leave'),
    );
    return { root, title, score, status, queue, units, canvas, info, premise, notes, noteInput, suggest, priority, dispo, closeBtn, orders, createRow, createType, createPriority };
  }
}
