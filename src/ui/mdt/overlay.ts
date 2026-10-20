/**
 * The MDT / CAD terminal (design §13.2): a full-screen, keyboard-first, non-pausing `Menu` with eleven
 * tabs (Phase 5 appends Career and Community). CAD changes go through `deps.request` (applied by the dispatcher in its next fixed step);
 * records queries call `deps.records` directly; documents are written to `deps.cad.docs`.
 *
 * Cost: nothing while closed. While open, `update` refreshes the visible tab at most 4 Hz and only
 * when the CAD revision (or AVL revision on Units/Map), the query log (BOLO) or the tab changed; the
 * header clock and the age columns tick once per second. Lists reuse their row elements and forms are
 * never rebuilt while open. Headless (no `document` or no `UIRoot`) it builds no DOM and its model
 * methods still work.
 */
import './mdt.css';
import { addressAt } from '../../cad/address';
import { canAssign, canTransition } from '../../cad/cadState';
import { plateRunNarrative } from '../../cad/codes';
import { statusLabel } from '../../cad/codes';
import { DISPOSITIONS, findCallType } from '../../cad/data';
import {
  CUSTODY_ACTIONS,
  DOC_KINDS,
  DocumentValidationError,
  type CadDocument,
  type CustodyAction,
  type DocKind,
  type DraftFields,
} from '../../cad/documents';
import type { CadCall, TrafficStopInfo, UnitStatus } from '../../cad/types';
import type { Bolo } from '../../records/bolo';
import { epochDayFromYmd, formatClockTime, formatStamp, ymdOfEpochDay } from '../../records/calendar';
import { normalizePlate, plateSummary, type PersonQuery, type PersonSummary, type PlateQueryResult, type QueryLogEntry, type VinQueryResult } from '../../records/db';
import { PERSON_POPULATION } from '../../records/ids';
import { mountedPlate } from '../../records/vehicle';
import { REGISTRY_POPULATION } from '../../traffic/registry';
import { clearChildren, el, type Menu, type UIRoot } from '../ui';
import { ListView, button, renderSections, selectField, setText, textField, type Field } from './dom';
import { buildDocForm, showErrors, type DocFormView, type FormOptions } from './forms';
import { MAP_ZOOM_STEP, MdtMap, type MapDrawState } from './map';
import { careerModel, communityModel, renderCareer, renderCommunity, type CareerModel, type CommunityRow } from './career';
import { gradeSections, normalizeAssertions, type ChoiceInfo } from './statements';
import {
  type CallDetailLine,
  callDetailLines,
  canCompleteBooking,
  citationDraftFromStop,
  docRows,
  docSections,
  personSections,
  queueRows,
  stopSections,
  suggestedCharges,
  tabFromKey,
  unitRows,
  vehicleSections,
  type DocRow,
  type QueueRow,
  type UnitRow,
} from './model';
import { MDT_TABS, MDT_TAB_LABELS, tabKeyLabel, type MdtDeps, type MdtTab } from './types';

/** Minimum time between refreshes of the visible tab (4 Hz). */
export const MDT_REFRESH_MS = 250;
/** Clock and age columns tick at this period. */
const TICK_MS = 1000;

const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file', 'image']);

/** True when keys typed at `target` belong to a text field (inputs, textareas, selects, editable content). */
export function isTextField(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const o = target as { tagName?: unknown; type?: unknown; isContentEditable?: unknown };
  if (o.isContentEditable === true) return true;
  const tag = typeof o.tagName === 'string' ? o.tagName.toUpperCase() : '';
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = typeof o.type === 'string' ? o.type.toLowerCase() : 'text';
  return !NON_TEXT_INPUTS.has(type);
}

const DOC_KIND_LABELS: Readonly<Record<DocKind, string>> = {
  report: 'Reports',
  citation: 'Citations',
  booking: 'Bookings',
  evidence: 'Evidence',
  supplement: 'Supplements',
};
const DOC_KIND_SINGULAR: Readonly<Record<DocKind, string>> = {
  report: 'incident report',
  citation: 'citation',
  booking: 'booking',
  evidence: 'evidence item',
  supplement: 'supplement',
};

const STATUS_BUTTONS: readonly { readonly status: UnitStatus; readonly label: string }[] = [
  { status: 'available', label: '10-8 Available' },
  { status: 'enRoute', label: 'En route' },
  { status: 'onScene', label: 'On scene' },
  { status: 'busy', label: 'Busy' },
  { status: 'transporting', label: 'Transporting' },
  { status: 'outOfService', label: '10-7 Out of service' },
];

const STOP_CONTACT_HINTS = [
  'Request license, check VIN, warn and arrest are done at the driver window (driver contact panel).',
];

/** Result of saving a document form. */
export interface SaveResult {
  readonly doc: CadDocument | null;
  readonly errors: readonly string[];
}

interface FormState {
  readonly kind: DocKind;
  docId: string | null;
  readonly init: DraftFields<DocKind>;
  readonly opts: FormOptions;
  view: DocFormView | null;
  /** Report form: the statements ticked without a DOM (`setAssertions`) or restored from a saved draft. */
  assertions: string[];
}

interface FormDom {
  readonly root: HTMLElement;
  readonly errors: HTMLElement;
  readonly complete: HTMLButtonElement | null;
}

interface Dom {
  readonly root: HTMLElement;
  readonly unitInfo: HTMLElement;
  readonly clock: HTMLElement;
  readonly message: HTMLElement;
  readonly tabs: Record<MdtTab, HTMLButtonElement>;
  readonly panels: Record<MdtTab, HTMLElement>;
  // queue
  readonly queue: ListView<QueueRow>;
  readonly queueActions: Record<'accept' | 'decline' | 'self' | 'enRoute' | 'onScene' | 'clear', HTMLButtonElement>;
  readonly disposition: HTMLSelectElement;
  // call
  readonly callDetail: HTMLElement;
  readonly narrative: Field<HTMLInputElement>;
  readonly callButtons: { readonly add: HTMLButtonElement; readonly report: HTMLButtonElement };
  // units
  readonly units: ListView<UnitRow>;
  readonly statusButtons: Map<UnitStatus, HTMLButtonElement>;
  // map
  readonly map: MdtMap;
  readonly mapSelected: HTMLElement;
  // person
  readonly personQuery: { last: HTMLInputElement; first: HTMLInputElement; dob: HTMLInputElement; dl: HTMLInputElement };
  readonly personResults: ListView<PersonSummary>;
  readonly personRecord: HTMLElement;
  readonly wantsButton: HTMLButtonElement;
  // vehicle
  readonly vehicleQuery: HTMLInputElement;
  readonly vehicleResult: HTMLElement;
  readonly runTarget: HTMLButtonElement;
  readonly runStop: HTMLButtonElement;
  // bolo
  readonly bolos: ListView<Bolo>;
  readonly history: ListView<QueryLogEntry>;
  // reports
  readonly kindButtons: Record<DocKind, HTMLButtonElement>;
  readonly newDoc: HTMLButtonElement;
  readonly docs: ListView<DocRow>;
  readonly docPane: HTMLElement;
  // career / community
  readonly careerBody: HTMLElement;
  readonly communityBody: HTMLElement;
  // stop
  readonly stopBody: HTMLElement;
  readonly stopButtons: { readonly run: HTMLButtonElement; readonly wants: HTMLButtonElement; readonly cite: HTMLButtonElement; readonly release: HTMLButtonElement };
}

/** Fields of a document that `DocumentStore.create/update` accept (everything but the base and totals). */
function draftFieldsOf(doc: CadDocument): DraftFields<DocKind> {
  const copy: Record<string, unknown> = { ...structuredClone(doc) };
  for (const key of ['id', 'kind', 'created', 'updated', 'author', 'status', 'totalFine']) delete copy[key];
  return copy;
}

/** "MM/DD/YYYY" -> epoch day; undefined when malformed or not a calendar date (13/45/1990). */
export function parseDob(text: string): number | undefined {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text.trim());
  if (!m) return undefined;
  const y = Number(m[3]), mo = Number(m[1]), d = Number(m[2]);
  const day = epochDayFromYmd(y, mo, d);
  const back = ymdOfEpochDay(day);
  return back.y === y && back.m === mo && back.d === d ? day : undefined;
}

/** Person query fields as typed (the DOB still text). */
export interface PersonQueryText {
  readonly last: string;
  readonly first: string;
  readonly dob: string;
  readonly dl: string;
}

function isRegistryId(id: number): boolean {
  return Number.isInteger(id) && id >= 0 && id < REGISTRY_POPULATION;
}

function callLineKey(l: CallDetailLine): string {
  return `${l.kind}\t${l.label}\t${l.text}`;
}

const HEADLESS_ELEMENT = {} as HTMLElement;

export class MdtOverlay implements Menu {
  readonly id = 'mdt' as const;
  readonly element: HTMLElement;
  readonly pausesGame = false as const;

  private readonly ui: UIRoot | null;
  private readonly deps: MdtDeps;
  private readonly dom: Dom | null;
  private openFlag = false;
  private current: MdtTab = 'queue';
  private selectedCall: number | null = null;
  private form: FormState | null = null;
  private formDom: FormDom | null = null;
  private docKind: DocKind = 'report';
  private viewDocId: string | null = null;
  private personShown = -1;
  private vehicleResultValue: PlateQueryResult | VinQueryResult | null = null;
  private stopRun: PlateQueryResult | null = null;
  /** The stop call `stopRun` belongs to. */
  private stopRunCallId = -1;
  /** The call (and its default) the Queue's disposition select was last set for. */
  private dispositionCallId: number | null = null;
  private dispositionDefault = '';
  private messageText = '';
  private dirty = true;
  private lastUpdateMs = -Infinity;
  /** Reused map draw state (no per-frame allocation). */
  private readonly mapState: { -readonly [K in keyof MapDrawState]: MapDrawState[K] } = { selectedCallId: null, playerCallsign: '', nowMs: 0, reducedFlash: false };
  private lastTickMs = -Infinity;
  private lastRev = -1;
  private lastAvl = -1;
  private lastLogKey = '';
  /** `docPaneKey` of the viewer last rendered ('' = a form or nothing). */
  private renderedDocKey = '';
  /** What the Call / Stop tabs last rendered: rebuilt only when it changes (keeps focus, no churn). */
  private renderedCallKey = '';
  private renderedStopKey = '';
  /** Non-CAD inputs of button states (reticle target, station, prisoner, active stop) last refreshed. */
  private lastExtKey = -1;
  private messageError = false;
  private refreshCount = 0;
  /** Statements ticked in a report draft, by document id (session-only convenience; the document has no field for them). */
  private readonly draftAssertions = new Map<string, string[]>();
  private careerShown: CareerModel | null = null;
  private communityShown: CommunityRow[] = [];

  constructor(ui: UIRoot | null, deps: MdtDeps) {
    this.ui = ui;
    this.deps = deps;
    this.dom = ui !== null && typeof document !== 'undefined' ? this.build() : null;
    this.element = this.dom?.root ?? HEADLESS_ELEMENT;
  }

  // --- State --------------------------------------------------------------------------------

  get isOpen(): boolean {
    return this.ui ? this.ui.isOpen(this) : this.openFlag;
  }

  get tab(): MdtTab {
    return this.current;
  }

  get selectedCallId(): number | null {
    return this.selectedCall;
  }

  /** A document form is open (Escape cancels it before closing the MDT). */
  get editing(): boolean {
    return this.form !== null;
  }

  get formKind(): DocKind | null {
    return this.form?.kind ?? null;
  }

  /** Refreshes of the visible tab so far (tests and diagnostics). */
  get refreshes(): number {
    return this.refreshCount;
  }

  /** Last status line ("Citation CT-000001 issued", "Request sent"...). */
  get message(): string {
    return this.messageText;
  }

  get vehicleResult(): PlateQueryResult | VinQueryResult | null {
    return this.vehicleResultValue;
  }

  get personId(): number {
    return this.personShown;
  }

  open(tab?: MdtTab): void {
    if (tab !== undefined) this.setTab(tab);
    this.openFlag = true;
    if (this.ui && !this.ui.isOpen(this)) this.ui.push(this);
    this.dirty = true;
    this.lastUpdateMs = -Infinity;
  }

  close(): void {
    this.openFlag = false;
    if (this.ui?.isOpen(this)) this.ui.pop(this);
  }

  onShow(): void {
    this.dirty = true;
    this.lastUpdateMs = -Infinity;
    this.dom?.tabs[this.current].focus();
  }

  setTab(tab: MdtTab, focus = false): void {
    if (tab !== this.current) {
      this.current = tab;
      this.dirty = true;
      this.lastUpdateMs = -Infinity;
      const dom = this.dom;
      if (dom) {
        for (const t of MDT_TABS) {
          const on = t === tab;
          dom.tabs[t].setAttribute('aria-selected', on ? 'true' : 'false');
          dom.tabs[t].tabIndex = on ? 0 : -1;
          dom.panels[t].hidden = !on;
        }
      }
    }
    if (focus) this.dom?.tabs[tab].focus();
  }

  selectCall(callId: number | null): void {
    if (this.selectedCall === callId) return;
    this.selectedCall = callId;
    this.dirty = true;
    this.lastUpdateMs = -Infinity;
    if (callId !== null) this.dom?.queue.select(callId);
  }

  // --- Frame update -----------------------------------------------------------------------------

  update(nowMs: number): void {
    if (!this.isOpen) return;
    // User-driven view changes repaint at once; the CAD layer follows the refresh gate below.
    if (this.current === 'map' && this.dom?.map.viewDirty) this.drawMap(nowMs);
    if (nowMs - this.lastUpdateMs < MDT_REFRESH_MS) return;
    this.lastUpdateMs = nowMs;
    const { cad, records } = this.deps;
    const avlTab = this.current === 'units' || this.current === 'map';
    const log = records.queryLog;
    const logKey = this.current === 'bolo' ? `${log.length}:${log[log.length - 1]?.gameSeconds ?? -1}:${records.today()}` : this.lastLogKey;
    const extTab = this.current === 'vehicle' || this.current === 'reports' || this.current === 'stop' || this.current === 'career' || this.current === 'community';
    const extKey = extTab ? this.externalKey() : this.lastExtKey;
    const changed =
      this.dirty ||
      cad.revision !== this.lastRev ||
      (avlTab && cad.avlRevision !== this.lastAvl) ||
      logKey !== this.lastLogKey ||
      extKey !== this.lastExtKey;
    const tick = nowMs - this.lastTickMs >= TICK_MS;
    if (changed) {
      this.dirty = false;
      this.lastRev = cad.revision;
      this.lastAvl = cad.avlRevision;
      this.lastLogKey = logKey;
      this.lastExtKey = extKey;
      this.refreshCount++;
      this.refreshTab();
    } else if (tick && (this.current === 'queue' || this.current === 'units')) {
      this.refreshTab(); // ages only: the lists write just the cells that changed
    }
    if (tick || changed) {
      this.lastTickMs = nowMs;
      this.refreshHeader();
    }
    if (this.current === 'map') this.drawMap(nowMs);
  }

  /**
   * Packs the non-CAD inputs of the Vehicle / Reports / Stop button states (and the Career / Community revisions) into
   * one number (no allocation).
   */
  private externalKey(): number {
    const d = this.deps;
    if (this.current === 'career') return d.career ? d.career.revision() * 100000 + (Math.floor(d.career.now().game / 60) % 100000) : 0;
    if (this.current === 'community') return d.community ? d.community.revision() : 0;
    const bits = (d.target() !== null ? 1 : 0) | (d.atStation() ? 2 : 0) | (this.activeStop() !== null ? 4 : 0);
    const key = (d.prisoner() + 1) * 8 + bits;
    // A report's grade arrives from the conduct system a step after the report is filed.
    return this.current === 'reports' ? key * 128 + this.viewedGradeScore() + 1 : key;
  }

  /** Score of the viewed report's grade, -1 when ungraded or no report is shown. */
  private viewedGradeScore(): number {
    const grade = this.viewDocId !== null ? this.deps.reportGrade?.(this.viewDocId) : null;
    return grade ? Math.min(100, Math.max(0, Math.round(grade.score))) : -1;
  }

  private drawMap(nowMs: number): void {
    const dom = this.dom;
    if (!dom) return;
    const st = this.mapState;
    st.selectedCallId = this.selectedCall;
    st.playerCallsign = this.deps.callsign;
    st.nowMs = nowMs;
    st.reducedFlash = document.documentElement.dataset['reducedFlash'] === 'true';
    dom.map.draw(this.deps.cad, st);
  }

  // --- Keyboard -----------------------------------------------------------------------------

  onKeyDown(event: KeyboardEvent): boolean {
    if (!this.isOpen) return false;
    const key = event.key;
    if (key === 'Escape') {
      // Escape cancels a form only where it is shown; elsewhere it closes the MDT and keeps the form (like Close).
      if (this.current === 'reports' && this.cancelForm()) return true;
      this.close();
      return true;
    }
    if (event.ctrlKey || event.altKey || event.metaKey) return false;
    const target = event.target;
    if (isTextField(target)) return false;
    const tab = tabFromKey(key);
    if (tab) {
      this.setTab(tab, true);
      return true;
    }
    const dom = this.dom;
    if (this.current === 'map' && dom && (target === dom.map.canvas || key === '+' || key === '-' || key === '=')) {
      if (this.mapKey(key)) return true;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const i = MDT_TABS.indexOf(this.current);
      const n = MDT_TABS.length;
      this.setTab(MDT_TABS[(i + (key === 'ArrowLeft' ? n - 1 : 1)) % n] as MdtTab, true);
      return true;
    }
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      const list = this.listFor(target);
      return list ? list.move(key === 'ArrowUp' ? -1 : 1) : false;
    }
    if (key === 'Enter' && this.dom && target instanceof Element && target.hasAttribute('data-mdt-row')) {
      return this.listFor(target)?.activate() ?? false;
    }
    return false;
  }

  private mapKey(key: string): boolean {
    const dom = this.dom;
    if (!dom) return false;
    const map = dom.map;
    const step = Math.min(map.view.width, map.view.height) * 0.15;
    switch (key) {
      case 'ArrowLeft':
        map.pan(step, 0);
        return true;
      case 'ArrowRight':
        map.pan(-step, 0);
        return true;
      case 'ArrowUp':
        map.pan(0, step);
        return true;
      case 'ArrowDown':
        map.pan(0, -step);
        return true;
      case '+':
      case '=':
        map.zoom(MAP_ZOOM_STEP);
        return true;
      case '-':
        map.zoom(1 / MAP_ZOOM_STEP);
        return true;
      case 'Home':
        this.centreOnPlayer();
        return true;
      case 'Enter': {
        const id = map.pickCentre(this.deps.cad);
        if (id !== null && id === this.selectedCall) this.setTab('call', true);
        else this.selectCall(id);
        return true;
      }
      default:
        return false;
    }
  }

  /** The list that Up/Down/Enter act on: the one holding focus, else the visible tab's main list. */
  private listFor(target: EventTarget | null): ListView<unknown> | null {
    const dom = this.dom;
    if (!dom) return null;
    // Keys on the controls of a form (checkboxes, Add/Remove buttons) or the document pane stay there.
    if (target instanceof Node && dom.docPane.contains(target)) return null;
    if (target instanceof Element && target.closest('form') !== null) return null;
    const lists: Partial<Record<MdtTab, ListView<unknown>[]>> = {
      queue: [dom.queue],
      units: [dom.units],
      person: [dom.personResults],
      bolo: [dom.bolos, dom.history],
      reports: [dom.docs],
    };
    const candidates = lists[this.current] ?? [];
    return candidates.find((l) => l.contains(target)) ?? candidates[0] ?? null;
  }

  // --- CAD requests (deps.request) --------------------------------------------------------------

  private send(r: Parameters<MdtDeps['request']>[0], text: string): void {
    this.deps.request(r);
    this.setMessage(text);
  }

  /**
   * The dispatcher's answer to a request (`dispatch:ack` for the player): MDT answers are silent on
   * the radio, so a refusal ("No call offered", "Unable: ...") must show here.
   */
  notify(text: string, ok: boolean): void {
    if (ok && text === '') return;
    this.setMessage(ok ? text : `Refused: ${text}`, !ok);
  }

  /** Code 4: no further assistance needed; clears an active emergency. */
  code4(): void {
    this.send({ kind: 'code4' }, 'Code 4 sent');
  }

  acceptCall(callId: number): void {
    this.send({ kind: 'acceptCall', callId }, 'Accept sent');
  }

  declineCall(callId: number): void {
    this.send({ kind: 'declineCall', callId }, 'Decline sent');
  }

  selfAssign(callId: number): void {
    this.send({ kind: 'selfAssign', callId }, 'Self-assign sent');
  }

  setStatus(status: UnitStatus): void {
    this.send({ kind: 'status', status }, `Status ${statusLabel(status)} sent`);
  }

  clearCall(callId: number, disposition: string): void {
    this.send({ kind: 'clearCall', callId, disposition }, 'Clear sent');
  }

  addNarrative(callId: number, text: string): boolean {
    const t = text.trim();
    if (t === '') return false;
    this.send({ kind: 'narrative', callId, text: t }, 'Narrative sent');
    return true;
  }

  wantsCheck(personId: number): void {
    if (personId < 0) return;
    this.send({ kind: 'runPerson', personId }, 'Wants check requested');
  }

  releaseStop(): void {
    this.send({ kind: 'stopContact', action: 'release' }, 'Release sent');
  }

  // --- Records queries (direct) ---------------------------------------------------------------

  /** Runs a plate; `vehicleId` (target or stop car) adds the observed description. */
  runPlate(plate: string, vehicleId = -1): PlateQueryResult {
    const stop = this.activeStop();
    // A typed plate that is the stop car's (or the targeted car's) is run against that car, so a
    // description mismatch still shows.
    const vid = vehicleId >= 0 ? vehicleId : this.observedIdForPlate(plate, stop);
    const observed = vid >= 0 ? this.deps.observed(vid) : null;
    const r = this.deps.records.runPlate(plate, observed ?? undefined, this.deps.now().game);
    this.vehicleResultValue = r;
    // Reported like a dispatcher run: hit tone, HUD target result and in-car alert.
    this.deps.plateRun?.(vid, plateSummary(r));
    if (stop && vid === stop.vehicleId) {
      this.stopRun = r;
      this.stopRunCallId = stop.callId;
      // Recorded in CAD like a radio run, so it survives save/load and shows on every screen.
      const { cad } = this.deps;
      const t = this.deps.now();
      if (!stop.plateRun) cad.updateTrafficStop({ plateRun: true }, t);
      cad.addNarrative(stop.callId, 'CAD', plateRunNarrative(plateSummary(r)), t);
    }
    this.dirty = true;
    this.renderVehicle();
    return r;
  }

  /** The stop car (else the targeted car) when `plate` is the one mounted on it; -1 otherwise. */
  private observedIdForPlate(plate: string, stop: TrafficStopInfo | null): number {
    const p = normalizePlate(plate);
    if (p === null) return -1;
    if (stop && p === stop.plate) return stop.vehicleId;
    const target = this.deps.target();
    return target && p === normalizePlate(target.plate) ? target.vehicleId : -1;
  }

  /** The MDT's own plate run of this stop's car (a run of an earlier stop does not count). */
  private stopRunFor(stop: TrafficStopInfo): PlateQueryResult | null {
    return this.stopRunCallId === stop.callId ? this.stopRun : null;
  }

  runVin(vin: string): VinQueryResult {
    const r = this.deps.records.runVin(vin, this.deps.now().game);
    this.vehicleResultValue = r;
    this.dirty = true;
    this.renderVehicle();
    return r;
  }

  /** Plate (or a 17-character VIN) typed into the Vehicle tab. */
  runVehicleQuery(text: string): PlateQueryResult | VinQueryResult | null {
    const t = text.trim().toUpperCase();
    if (t === '') return null;
    return /^[A-Z0-9]{17}$/.test(t) ? this.runVin(t) : this.runPlate(t);
  }

  runTarget(): PlateQueryResult | null {
    const target = this.deps.target();
    if (!target) {
      this.setMessage('No target vehicle');
      return null;
    }
    return this.runPlate(target.plate, target.vehicleId);
  }

  runStopVehicle(): PlateQueryResult | null {
    const stop = this.activeStop();
    if (!stop) {
      this.setMessage('No active traffic stop');
      return null;
    }
    return this.runPlate(stop.plate, stop.vehicleId);
  }

  /** The Person tab's search: a DOB that is typed but not a valid MM/DD/YYYY date refuses the search; null then. */
  searchPersonFields(q: PersonQueryText): PersonSummary[] | null {
    const dobText = q.dob.trim();
    const dob = dobText === '' ? undefined : parseDob(dobText);
    if (dobText !== '' && dob === undefined) {
      this.setMessage('DOB must be MM/DD/YYYY', true);
      return null;
    }
    return this.searchPersons({ last: q.last, first: q.first, dl: q.dl, ...(dob !== undefined ? { dob } : {}) });
  }

  searchPersons(q: PersonQuery): PersonSummary[] {
    const results = this.deps.records.findPersons(q, 20, this.deps.now().game);
    this.dirty = true;
    if (this.dom) {
      this.dom.personResults.render(results);
      if (results.length === 0) this.setMessage('No matches (a DL number or 2+ letters of a last name are needed)');
    }
    if (results.length === 1 && results[0]) this.showPerson(results[0].personId);
    return results;
  }

  showPerson(personId: number): void {
    const { records } = this.deps;
    if (!Number.isInteger(personId) || personId < 0 || personId >= PERSON_POPULATION) {
      this.setMessage(`Unknown person #${personId}`);
      return;
    }
    this.personShown = personId;
    this.setTab('person');
    const dom = this.dom;
    if (!dom) return;
    const sections = personSections(records.person(personId), records.personHits(personId), records.today());
    renderSections(dom.personRecord, sections, this.links());
    dom.wantsButton.disabled = false;
  }

  // --- Documents ------------------------------------------------------------------------------

  private author(): string {
    const o = this.deps.officer();
    return `${o.name} #${o.badge}`;
  }

  /**
   * Creates (or updates `docId`) and optionally finalizes a document. A booking is finalized only
   * when `canCompleteBooking`, and then handed to `deps.completeBooking`. Validation problems come
   * back in `errors` (the draft is kept).
   */
  saveDocument(kind: DocKind, fields: DraftFields<DocKind>, finalize: boolean, docId: string | null = null): SaveResult {
    const { cad } = this.deps;
    const t = this.deps.now();
    let doc: CadDocument | null = docId !== null ? cad.docs.get(docId) : null;
    try {
      if (doc) {
        doc = cad.docs.update(doc.id, fields, t);
      } else {
        const f = kind === 'evidence'
          ? { ...fields, custody: [{ game: t.game, action: 'collected' as const, by: this.author(), note: '' }] }
          : fields;
        doc = cad.docs.create(kind, f, t, this.author());
      }
      if (finalize) {
        if (doc.kind === 'booking' && !canCompleteBooking(doc, this.deps.prisoner(), this.deps.atStation())) {
          return { doc, errors: ['Booking can only be completed at the station, for the prisoner in the car'] };
        }
        doc = cad.docs.finalize(doc.id, t);
        if (doc.kind === 'booking') this.deps.completeBooking(doc.id);
      }
      return { doc, errors: [] };
    } catch (e) {
      const errors = e instanceof DocumentValidationError ? e.messages : [e instanceof Error ? e.message : String(e)];
      return { doc, errors };
    }
  }

  /**
   * Opens a document form on the Reports tab. An open form is first saved as a draft; when it cannot
   * be saved (validation) it stays open and nothing else opens (false).
   */
  openForm(kind: DocKind, init?: DraftFields<DocKind>, opts: FormOptions = {}, docId: string | null = null): boolean {
    if (!this.stashForm()) return false;
    this.form = { kind, docId, init: init ?? this.prefill(kind), opts, view: null, assertions: [...(docId !== null ? (this.draftAssertions.get(docId) ?? []) : [])] };
    this.docKind = kind;
    this.syncKindButtons();
    this.setTab('reports');
    this.dirty = true;
    this.renderForm();
    return true;
  }

  /** Saves an open form as a draft before something replaces it; false (form kept, Reports tab shown) when it cannot be saved. */
  private stashForm(): boolean {
    if (!this.form) return true;
    const r = this.submitForm(false);
    if (r.errors.length > 0) {
      this.setTab('reports', true);
      this.setMessage(`Save or cancel the open form first: ${r.errors[0] ?? ''}`, true);
      return false;
    }
    this.form = null;
    this.formDom = null;
    return true;
  }

  /**
   * Saves the open form as a draft without touching the UI (before a save or when the MDT goes away),
   * so typed text is kept; false when it cannot be saved (invalid input: the form stays as it is).
   */
  flushDraft(): boolean {
    const form = this.form;
    if (!form) return true;
    if ((form.view?.validate?.() ?? []).length > 0) return false;
    const fields = form.view ? form.view.read() : form.init;
    const r = this.saveDocument(form.kind, fields, false, form.docId);
    if (r.doc) {
      form.docId = r.doc.id;
      if (r.errors.length === 0) this.afterReportSave(r.doc, this.formAssertions());
    }
    return r.errors.length === 0;
  }

  /** Closes the open form without saving; false when none was open. */
  cancelForm(): boolean {
    if (!this.form) return false;
    this.form = null;
    this.formDom = null;
    this.renderDocPane();
    this.setMessage('Form cancelled');
    return true;
  }

  /** Saves the open form (draft, or finalize / issue / complete). */
  submitForm(finalize: boolean): SaveResult {
    const form = this.form;
    if (!form) return { doc: null, errors: ['No form open'] };
    const invalid = form.view?.validate?.() ?? [];
    if (invalid.length > 0) {
      if (this.formDom) showErrors(this.formDom.errors, invalid);
      this.setMessage(invalid[0] ?? 'Not saved', true);
      return { doc: form.docId !== null ? this.deps.cad.docs.get(form.docId) : null, errors: invalid };
    }
    const fields = form.view ? form.view.read() : form.init;
    const result = this.saveDocument(form.kind, fields, finalize, form.docId);
    if (result.doc) form.docId = result.doc.id;
    if (result.errors.length > 0) {
      if (this.formDom) showErrors(this.formDom.errors, result.errors);
      this.setMessage(result.errors[0] ?? 'Not saved');
      return result;
    }
    const doc = result.doc;
    if (doc) {
      this.afterReportSave(doc, this.formAssertions());
      const verb = doc.status === 'final' ? (doc.kind === 'citation' ? 'issued' : doc.kind === 'booking' ? 'completed' : 'finalized') : 'saved as draft';
      this.setMessage(`${doc.id} ${verb}`);
      if (doc.status === 'final' || !this.dom) {
        this.form = null;
        this.formDom = null;
        this.viewDocId = doc.id;
        this.renderDocPane();
      } else if (this.formDom) {
        showErrors(this.formDom.errors, []);
      }
    }
    return result;
  }

  /** Citation form prefilled from the current stop (or empty without one). */
  writeCitation(): boolean {
    return this.openForm('citation');
  }

  /** Shows a document read-only (an open form is saved as a draft first, or kept when it cannot be). */
  viewDocument(id: string): void {
    const doc = this.deps.cad.docs.get(id);
    if (!doc) return;
    if (!this.stashForm()) return;
    this.docKind = doc.kind;
    this.syncKindButtons();
    this.viewDocId = id;
    this.setTab('reports');
    this.dirty = true;
    this.renderDocPane();
  }

  private playerCall(): CadCall | null {
    const u = this.deps.cad.unit(this.deps.callsign);
    return u && u.callId !== null ? this.deps.cad.call(u.callId) : null;
  }

  private playerLocation(): string {
    const u = this.deps.cad.unit(this.deps.callsign);
    if (!u) return '';
    return addressAt(this.deps.graph, u.x, u.z, undefined, 150)?.text ?? '';
  }

  private stopLocation(stop: TrafficStopInfo | null): string {
    if (!stop) return this.playerLocation();
    return this.deps.cad.call(stop.callId)?.location.text ?? addressAt(this.deps.graph, stop.x, stop.z, undefined, 150)?.text ?? '';
  }

  private prefill(kind: DocKind): DraftFields<DocKind> {
    const { cad, records } = this.deps;
    const now = this.deps.now();
    // Citations come from a stop in progress; a booking also from the stop that ended in the arrest.
    const stop = this.activeStop();
    const arrestStop = stop ?? (cad.trafficStop?.outcome === 'arrest' ? cad.trafficStop : null);
    const selected = this.selectedCall !== null ? cad.call(this.selectedCall) : null;
    // The queue's selection is only used from the Call tab: the queue auto-selects its first row.
    const call = this.current === 'call' && selected ? selected : this.playerCall();
    switch (kind) {
      case 'report': {
        if (!call) return { callId: null, location: this.playerLocation(), occurredGame: now.game };
        const persons: { personId: number; role: 'reportingParty' | 'involved' }[] = [];
        if (call.caller.personId >= 0) persons.push({ personId: call.caller.personId, role: 'reportingParty' });
        for (const p of call.persons) if (!persons.some((x) => x.personId === p)) persons.push({ personId: p, role: 'involved' });
        const vehicles = call.vehicles.map((v) => ({
          vehicleId: v,
          plate: isRegistryId(v) ? mountedPlate(records.seed, v).plate : '',
          role: 'involved',
        }));
        return { callId: call.id, title: call.nature, location: call.location.text, occurredGame: call.created.game, persons, vehicles };
      }
      case 'citation': {
        if (!stop) return { callId: call?.id ?? null, location: call?.location.text ?? this.playerLocation() };
        const draft = citationDraftFromStop(
          stop,
          records,
          this.deps.observedViolations(stop.vehicleId),
          this.deps.observedSpeed(stop.vehicleId),
          this.stopLocation(stop),
          this.stopRunFor(stop),
        );
        const { idUnverified: _idUnverified, totalFine: _totalFine, ...fields } = draft;
        return fields;
      }
      case 'booking': {
        const prisoner = this.deps.prisoner();
        return {
          callId: arrestStop?.callId ?? call?.id ?? null,
          personId: prisoner,
          charges: suggestedCharges(records, prisoner, arrestStop),
          arrestLocation: arrestStop ? this.stopLocation(arrestStop) : call?.location.text ?? this.playerLocation(),
          arrestedGame: now.game,
        };
      }
      case 'evidence':
        return { callId: call?.id ?? null, foundAt: call?.location.text ?? this.playerLocation() };
      case 'supplement': {
        const parent = this.viewDocId !== null ? cad.docs.get(this.viewDocId) : null;
        return { callId: parent?.callId ?? null, parentId: parent?.kind === 'report' && parent.status === 'final' ? parent.id : '' };
      }
    }
  }

  private formOptionsFor(kind: DocKind): FormOptions {
    const stop = this.activeStop();
    return kind === 'citation' && stop !== null && !(stop.driverId >= 0) ? { idUnverified: true } : {};
  }

  // --- Lifecycle ------------------------------------------------------------------------------

  dispose(): void {
    this.flushDraft();
    this.close();
    this.dom?.map.dispose();
    this.dom?.root.remove();
    this.form = null;
    this.formDom = null;
  }

  // --- Rendering --------------------------------------------------------------------------------

  private setMessage(text: string, error = false): void {
    this.messageText = text;
    this.messageError = error;
    if (this.dom) {
      setText(this.dom.message, text);
      this.dom.message.classList.toggle('mdt-error', error);
    }
  }

  /** The last message is an error or refusal. */
  get messageIsError(): boolean {
    return this.messageError;
  }

  private links(): { person: (id: number) => void; doc: (id: string) => void } {
    return { person: (id) => this.showPerson(id), doc: (id) => this.viewDocument(id) };
  }

  private refreshHeader(): void {
    const dom = this.dom;
    if (!dom) return;
    const unit = this.deps.cad.unit(this.deps.callsign);
    const o = this.deps.officer();
    setText(dom.unitInfo, `Unit ${this.deps.callsign}  ${o.name} #${o.badge}  ${unit ? statusLabel(unit.status) : ''}${unit?.emergency ? '  EMERGENCY' : ''}`);
    setText(dom.clock, formatStamp(this.deps.now().game));
  }

  /** Builds the view model of the visible tab and, with a DOM, writes it. */
  private refreshTab(): void {
    const { cad, graph } = this.deps;
    const now = this.deps.now();
    const dom = this.dom;
    switch (this.current) {
      case 'queue': {
        const rows = queueRows(cad, now.sim);
        // A closed / removed call drops out of the queue: select the top call instead.
        if (this.selectedCall === null || !rows.some((r) => r.callId === this.selectedCall)) this.selectedCall = rows[0]?.callId ?? null;
        if (dom) {
          dom.queue.render(rows);
          if (this.selectedCall !== null) dom.queue.select(this.selectedCall);
          this.refreshQueueActions();
        }
        break;
      }
      case 'call':
        this.renderCall();
        break;
      case 'units': {
        const rows = unitRows(cad, graph, now.sim);
        if (dom) {
          dom.units.render(rows);
          const player = cad.unit(this.deps.callsign);
          for (const [status, b] of dom.statusButtons) {
            b.disabled = !player || player.status === status || !canTransition(player.status, status);
            b.setAttribute('aria-pressed', player?.status === status ? 'true' : 'false');
          }
        }
        break;
      }
      case 'map':
        this.renderMapSelection();
        break;
      case 'person':
        break;
      case 'vehicle':
        if (dom) {
          dom.runTarget.disabled = this.deps.target() === null;
          dom.runStop.disabled = this.activeStop() === null;
        }
        break;
      case 'bolo': {
        const records = this.deps.records;
        const bolos = records.bolos(records.today());
        const history = [...records.queryLog].reverse();
        if (dom) {
          dom.bolos.render(bolos);
          dom.history.render(history);
        }
        break;
      }
      case 'reports': {
        const rows = docRows(cad.docs, this.docKind);
        if (dom) {
          dom.docs.render(rows);
          // Follow the viewed document, but not while a form is open or the user is moving in the list.
          const listFocused = typeof document !== 'undefined' && dom.docs.contains(document.activeElement);
          if (this.viewDocId !== null && !this.form && !listFocused) dom.docs.select(this.viewDocId);
          // The form is never rebuilt here; only its booking button state and a read-only viewer update.
          if (this.formDom?.complete && this.form) {
            const doc = this.form.docId !== null ? cad.docs.get(this.form.docId) : null;
            const personId = this.form.view ? (this.form.view.read() as { personId?: number }).personId ?? -1 : -1;
            this.formDom.complete.disabled = !canCompleteBooking(
              { personId, status: doc?.status ?? 'draft' },
              this.deps.prisoner(),
              this.deps.atStation(),
            );
          } else if (!this.form && this.docPaneKey() !== this.renderedDocKey) {
            // Only when the shown document changed: a rebuild would wipe a custody note being typed.
            this.renderDocPane();
          }
        }
        break;
      }
      case 'stop':
        this.renderStop();
        break;
      case 'career':
        this.renderCareerTab();
        break;
      case 'community':
        this.renderCommunityTab();
        break;
    }
  }

  // --- Career and Community (design phase 5 §12.1) -------------------------------------------------

  /** The Career tab's sections as last built (null before the tab was shown or without `deps.career`). */
  get careerSections(): CareerModel | null {
    return this.careerShown;
  }

  /** The Community tab's rows as last built. */
  get communityRows(): readonly CommunityRow[] {
    return this.communityShown;
  }

  /** ATTEND on a scheduled hearing: asks the court system when `career.canAttend` allows it. */
  attendCase(caseId: string): boolean {
    const career = this.deps.career;
    if (!career) return false;
    if (!career.canAttend(caseId)) {
      this.setMessage(`${caseId}: the hearing is not open yet`, true);
      return false;
    }
    career.attend(caseId);
    this.setMessage(`Attending ${caseId}`);
    return true;
  }

  /** REVIEW on an open internal affairs case: the app opens the bodycam review. */
  reviewIa(caseId: string): boolean {
    const career = this.deps.career;
    if (!career?.view().ia.some((c) => c.id === caseId && c.status === 'open')) return false;
    career.openIa(caseId);
    return true;
  }

  private renderCareerTab(): void {
    const career = this.deps.career;
    const dom = this.dom;
    if (!career) {
      this.careerShown = null;
      if (dom) {
        clearChildren(dom.careerBody);
        dom.careerBody.appendChild(el('p', { class: 'mdt-hint' }, 'No career data in this session.'));
      }
      return;
    }
    const model = careerModel(career.view(), career.cases(), career.now(), {
      canAttend: (id) => career.canAttend(id),
      jurisdiction: career.jurisdiction(),
    });
    this.careerShown = model;
    if (dom) renderCareer(dom.careerBody, model, { attend: (id) => this.attendCase(id), review: (id) => this.reviewIa(id) });
  }

  private renderCommunityTab(): void {
    const community = this.deps.community;
    const dom = this.dom;
    this.communityShown = community ? communityModel(community.rows()) : [];
    if (!dom) return;
    if (!community) {
      clearChildren(dom.communityBody);
      dom.communityBody.appendChild(el('p', { class: 'mdt-hint' }, 'No community data in this session.'));
      return;
    }
    renderCommunity(dom.communityBody, this.communityShown);
  }

  // --- Statements of fact ------------------------------------------------------------------------

  /** The statements the officer may assert for `callId` (hidden fields already stripped by the feed); [] when none. */
  statementChoices(callId: number | null): readonly ChoiceInfo[] {
    return callId === null ? [] : (this.deps.reportChoices?.(callId) ?? []);
  }

  /** Ticks statements on the open report form when there is no DOM to tick (the headless / model path). */
  setAssertions(ids: readonly string[]): void {
    if (this.form) this.form.assertions = [...ids];
  }

  /** The statements ticked on the open report form (the DOM checklist, else the ids set with `setAssertions`). */
  formAssertions(): string[] {
    const form = this.form;
    if (!form) return [];
    return form.view?.assertions ? form.view.assertions() : [...form.assertions];
  }

  /** Remembers a draft's ticks, or hands a final report's ticks to `deps.submitReport`. */
  private afterReportSave(doc: CadDocument, ticked: readonly string[]): void {
    if (doc.kind !== 'report') return;
    if (doc.status !== 'final') {
      this.draftAssertions.set(doc.id, [...ticked]);
      return;
    }
    this.draftAssertions.delete(doc.id);
    if (doc.callId === null || !this.deps.submitReport) return;
    const choices = this.statementChoices(doc.callId);
    if (choices.length === 0) return;
    this.deps.submitReport(doc.id, doc.callId, normalizeAssertions(choices, ticked));
  }

  private refreshQueueActions(): void {
    const dom = this.dom;
    if (!dom) return;
    const call = this.selectedCall !== null ? this.deps.cad.call(this.selectedCall) : null;
    const open = call !== null && call.status !== 'closed';
    const mine = open && call.units.includes(this.deps.callsign);
    const offered = open && call.offeredTo === this.deps.callsign;
    const assignable = this.canTakeCall();
    const player = this.deps.cad.unit(this.deps.callsign);
    const a = dom.queueActions;
    a.accept.disabled = !offered || !assignable;
    a.decline.disabled = !offered;
    a.self.disabled = !open || mine || !assignable;
    a.enRoute.disabled = !mine || !player || !canTransition(player.status, 'enRoute');
    a.onScene.disabled = !mine || !player || !canTransition(player.status, 'onScene');
    a.clear.disabled = !mine;
    dom.disposition.disabled = !mine;
    // The disposition follows the selected call's default (a stop's citation / warning / arrest)
    // until the player picks another one.
    const def = call ? this.defaultDisposition(call) : 'handled';
    if (call?.id !== this.dispositionCallId || (dom.disposition.value === this.dispositionDefault && def !== this.dispositionDefault)) {
      dom.disposition.value = def;
    }
    this.dispositionCallId = call?.id ?? null;
    this.dispositionDefault = def;
  }

  private defaultDisposition(call: CadCall): string {
    const fromDeps = this.deps.defaultDisposition?.(call.id);
    if (fromDeps !== undefined) return fromDeps;
    const stop = this.deps.cad.trafficStop;
    if (stop && stop.callId === call.id) {
      if (stop.outcome === 'arrest') return 'arrestMade';
      if (stop.citations.length > 0) return 'citationIssued';
    }
    const first = findCallType(call.typeId)?.dispositions[0];
    return first !== undefined && DISPOSITIONS.some((d) => d.id === first) ? first : 'handled';
  }

  /** The player may take a call: their status can go en route and they are not on an active traffic stop. */
  private canTakeCall(): boolean {
    const { cad } = this.deps;
    const player = cad.unit(this.deps.callsign);
    if (!player || !canAssign(player.status)) return false;
    const stop = this.activeStop();
    return !stop || stop.callId !== player.callId;
  }

  /** The traffic stop while it is in progress (`cad.trafficStop` keeps the last one after it ends). */
  private activeStop(): TrafficStopInfo | null {
    const stop = this.deps.cad.trafficStop;
    return stop && stop.outcome === 'active' ? stop : null;
  }

  private renderCall(): void {
    const dom = this.dom;
    if (!dom) return;
    const call = this.selectedCall !== null ? this.deps.cad.call(this.selectedCall) : this.playerCall();
    dom.narrative.control.disabled = !call || call.status === 'closed';
    dom.callButtons.add.disabled = dom.narrative.control.disabled;
    dom.callButtons.report.disabled = !call;
    const lines = call ? callDetailLines(call) : [];
    // Rebuilt only when what it shows changed (any CAD revision bumps the refresh; a rebuild drops focus).
    const key = call ? `${call.id}|${call.priority}|${lines.map(callLineKey).join('\n')}` : 'none';
    if (key === this.renderedCallKey) return;
    this.renderedCallKey = key;
    clearChildren(dom.callDetail);
    if (!call) {
      dom.callDetail.appendChild(el('p', { class: 'mdt-hint' }, 'No call selected. Pick one on the Queue or Map tab.'));
      return;
    }
    const dl = el('dl', { class: 'mdt-lines' });
    const narrative = el('ol', { class: 'mdt-narrative', 'aria-label': 'Narrative' });
    let title: HTMLElement | null = null;
    for (const l of lines) {
      if (l.kind === 'title') {
        title = el('h3', { class: `mdt-call-title mdt-p${call.priority}` }, `${l.label}  ${l.text}`);
      } else if (l.kind === 'narrative') {
        narrative.appendChild(el('li', null, el('time', null, l.label), ' ', l.text));
      } else if (l.kind === 'document') {
        const id = l.text;
        dl.append(el('dt', null, l.label), el('dd', null, button(id, () => this.viewDocument(id), 'mdt-link')));
      } else {
        dl.append(el('dt', null, l.label), el('dd', null, l.text));
      }
    }
    dom.callDetail.append(title ?? '', dl, el('h3', null, 'Narrative'), narrative);
  }

  private renderMapSelection(): void {
    const dom = this.dom;
    if (!dom) return;
    const call = this.selectedCall !== null ? this.deps.cad.call(this.selectedCall) : null;
    setText(dom.mapSelected, call ? `${call.number} P${call.priority} ${call.nature} - ${call.location.text} (${call.status})` : 'No call selected');
  }

  private renderVehicle(): void {
    const dom = this.dom;
    if (!dom) return;
    const r = this.vehicleResultValue;
    if (!r) {
      clearChildren(dom.vehicleResult);
      return;
    }
    renderSections(dom.vehicleResult, vehicleSections(r), this.links());
  }

  private renderStop(): void {
    const dom = this.dom;
    if (!dom) return;
    const stop = this.deps.cad.trafficStop;
    const b = dom.stopButtons;
    const active = stop !== null && stop.outcome === 'active';
    b.run.disabled = !active;
    b.wants.disabled = !stop || !(stop.driverId >= 0);
    b.cite.disabled = !active;
    b.release.disabled = !active;
    if (!stop) {
      if (this.renderedStopKey === 'none') return;
      this.renderedStopKey = 'none';
      clearChildren(dom.stopBody);
      dom.stopBody.appendChild(el('p', { class: 'mdt-hint' }, 'No active traffic stop. Light up a car behind you to pull it over.'));
      return;
    }
    const sections = stopSections(stop, this.deps.records, this.deps.observed(stop.vehicleId), this.stopRunFor(stop));
    // Rebuilt only when the shown stop changed (keeps focus on its links).
    const key = JSON.stringify(sections);
    if (key === this.renderedStopKey) return;
    this.renderedStopKey = key;
    renderSections(dom.stopBody, sections, this.links());
    dom.stopBody.appendChild(el('ul', { class: 'mdt-hint' }, ...STOP_CONTACT_HINTS.map((h) => el('li', null, h))));
  }

  private renderForm(): void {
    const dom = this.dom;
    const form = this.form;
    if (!dom || !form) return;
    clearChildren(dom.docPane);
    const base = form.opts.idUnverified ? form.opts : this.formOptionsFor(form.kind);
    const opts: FormOptions =
      form.kind === 'report' && this.deps.reportChoices
        ? { ...base, choices: (callId) => this.statementChoices(callId), assertions: form.assertions }
        : base;
    const view = buildDocForm(form.kind, form.init, { cad: this.deps.cad, seed: this.deps.records.seed }, opts);
    form.view = view;
    const errors = el('ul', { class: 'mdt-errors', role: 'alert', hidden: true });
    const actions = el('div', { class: 'mdt-actions' });
    let complete: HTMLButtonElement | null = null;
    switch (form.kind) {
      case 'citation':
        actions.append(button('Issue citation', () => this.submitForm(true), 'primary'), button('Save draft', () => this.submitForm(false)));
        break;
      case 'booking':
        complete = button('Complete booking', () => this.submitForm(true), 'primary');
        complete.title = 'Only at the station with the prisoner in the car';
        actions.append(complete, button('Save draft', () => this.submitForm(false)));
        break;
      default:
        actions.append(button('Finalize', () => this.submitForm(true), 'primary'), button('Save draft', () => this.submitForm(false)));
    }
    actions.appendChild(button('Cancel (Esc)', () => this.cancelForm()));
    const title = form.docId !== null ? `Edit ${form.docId}` : `New ${DOC_KIND_SINGULAR[form.kind]}`;
    const formEl = el('form', { class: 'mdt-form', 'aria-label': title }, el('h3', null, title), errors, view.element, actions);
    // Enter in a single-line field must not submit (Finalize is explicit); textareas keep newlines.
    formEl.addEventListener('submit', (e) => e.preventDefault());
    dom.docPane.appendChild(formEl);
    this.formDom = { root: formEl, errors, complete };
    if (complete) {
      const doc = form.docId !== null ? this.deps.cad.docs.get(form.docId) : null;
      const personId = (form.init as { personId?: number }).personId ?? -1;
      complete.disabled = !canCompleteBooking({ personId, status: doc?.status ?? 'draft' }, this.deps.prisoner(), this.deps.atStation());
    }
    view.focus();
  }

  /** What the read-only viewer shows: the document, its revision and the booking button state. */
  private docPaneKey(): string {
    const doc = this.viewDocId !== null ? this.deps.cad.docs.get(this.viewDocId) : null;
    if (!doc) return `none:${this.docKind}`;
    const canComplete = doc.kind === 'booking' && canCompleteBooking(doc, this.deps.prisoner(), this.deps.atStation());
    const custody = doc.kind === 'evidence' ? doc.custody.length : 0;
    const grade = doc.kind === 'report' ? this.viewedGradeScore() : -1;
    return `${doc.id}:${doc.status}:${doc.updated.sim}:${custody}:${canComplete ? 1 : 0}:${grade}`;
  }

  private renderDocPane(): void {
    this.buildDocPane();
    this.keepFocusInMdt();
  }

  private buildDocPane(): void {
    const dom = this.dom;
    if (!dom) return;
    if (this.form) {
      this.renderedDocKey = '';
      this.renderForm();
      return;
    }
    this.renderedDocKey = this.docPaneKey();
    clearChildren(dom.docPane);
    const doc = this.viewDocId !== null ? this.deps.cad.docs.get(this.viewDocId) : null;
    if (!doc) {
      dom.docPane.appendChild(el('p', { class: 'mdt-hint' }, `Select a document or create a new ${DOC_KIND_SINGULAR[this.docKind]}.`));
      return;
    }
    const body = el('div', { class: 'mdt-viewer', 'aria-label': `${doc.id} (read-only)` });
    const grade = doc.kind === 'report' && doc.status === 'final' ? (this.deps.reportGrade?.(doc.id) ?? null) : null;
    renderSections(body, [...docSections(doc), ...gradeSections(grade)], this.links());
    const actions = el('div', { class: 'mdt-actions' });
    if (doc.status === 'draft') {
      actions.appendChild(button('Edit', () => this.openForm(doc.kind, draftFieldsOf(doc), {}, doc.id)));
      if (doc.kind === 'booking') {
        const b = button('Complete booking', () => this.finalizeViewed(doc.id), 'primary');
        b.disabled = !canCompleteBooking(doc, this.deps.prisoner(), this.deps.atStation());
        actions.appendChild(b);
      } else {
        actions.appendChild(button(doc.kind === 'citation' ? 'Issue' : 'Finalize', () => this.finalizeViewed(doc.id), 'primary'));
      }
    }
    if (doc.kind === 'report' && doc.status === 'final') {
      actions.appendChild(button('Add supplement', () => this.openForm('supplement', { callId: doc.callId, parentId: doc.id, narrative: '' })));
    }
    dom.docPane.append(body, actions);
    if (doc.kind === 'evidence') dom.docPane.appendChild(this.custodyForm(doc.id));
  }

  /**
   * The doc pane was rebuilt: when that removed the focused control (focus fell to <body>), focus
   * moves to the pane's first button, else the document list, so Tab keeps working inside the MDT.
   */
  private keepFocusInMdt(): void {
    const dom = this.dom;
    if (!dom || !this.isOpen || typeof document === 'undefined') return;
    if (dom.root.contains(document.activeElement)) return;
    const first = dom.docPane.querySelector('button:not([disabled])');
    if (first instanceof HTMLElement) first.focus();
    else dom.docs.focus();
  }

  private finalizeViewed(id: string): void {
    const doc = this.deps.cad.docs.get(id);
    if (!doc) return;
    // A report with statements of fact is finalized from its form, where the statements are ticked.
    if (doc.kind === 'report' && this.statementChoices(doc.callId).length > 0) {
      if (this.openForm('report', draftFieldsOf(doc), {}, doc.id)) this.setMessage('Tick your statements of fact, then Finalize');
      return;
    }
    const r = this.saveDocument(doc.kind, {}, true, id);
    if (r.errors.length > 0) {
      this.setMessage(r.errors.join('; '));
      const dom = this.dom;
      if (dom) {
        const list = el('ul', { class: 'mdt-errors', role: 'alert' });
        showErrors(list, r.errors);
        dom.docPane.prepend(list);
      }
      return;
    }
    this.setMessage(`${id} finalized`);
    this.renderDocPane();
  }

  private custodyForm(evidenceId: string): HTMLElement {
    const action = selectField('Custody action', CUSTODY_ACTIONS.map((a) => ({ value: a, label: a })), 'transferred');
    const note = textField('Note', '', { maxlength: 120 });
    const add = (): void => {
      try {
        const t = this.deps.now();
        this.deps.cad.docs.addCustody(evidenceId, { game: t.game, action: action.control.value as CustodyAction, by: this.author(), note: note.control.value.trim() }, t);
        this.setMessage(`Custody entry added to ${evidenceId}`);
        this.renderDocPane();
      } catch (e) {
        this.setMessage(e instanceof Error ? e.message : String(e));
      }
    };
    const form = el('form', { class: 'mdt-form mdt-inline', 'aria-label': 'Add custody entry' }, action.element, note.element, el('button', { type: 'submit' }, 'Add custody'));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      add();
    });
    return form;
  }

  private centreOnPlayer(): void {
    const u = this.deps.cad.unit(this.deps.callsign);
    if (u && this.dom) this.dom.map.centreOn(u.x, u.z);
  }

  // --- DOM construction ---------------------------------------------------------------------------

  private build(): Dom {
    const tabs = {} as Record<MdtTab, HTMLButtonElement>;
    const panels = {} as Record<MdtTab, HTMLElement>;
    const tablist = el('div', { class: 'mdt-tabs', role: 'tablist', 'aria-label': 'MDT sections' });
    MDT_TABS.forEach((t) => {
      const on = t === this.current;
      const tabEl = el('button', {
        type: 'button', role: 'tab', id: `mdt-tab-${t}`, class: 'mdt-tab', 'aria-controls': `mdt-panel-${t}`,
        'aria-selected': on ? 'true' : 'false', tabindex: on ? 0 : -1, onclick: () => this.setTab(t, true),
      }, el('span', { class: 'mdt-key', 'aria-hidden': 'true' }, tabKeyLabel(t)), MDT_TAB_LABELS[t]);
      tabs[t] = tabEl;
      tablist.appendChild(tabEl);
      panels[t] = el('section', { class: `mdt-panel mdt-panel-${t}`, id: `mdt-panel-${t}`, role: 'tabpanel', 'aria-labelledby': `mdt-tab-${t}`, hidden: !on });
    });

    // Queue
    const queue = new ListView<QueueRow>('Open calls', [
      { label: 'P', cls: 'mdt-c-p', text: (r) => `P${r.priority}` },
      { label: 'Call', cls: 'mdt-c-num', text: (r) => r.number },
      { label: 'Nature', text: (r) => r.nature },
      { label: 'Address', text: (r) => r.address },
      { label: 'Caller', text: (r) => r.caller },
      { label: 'Status', text: (r) => r.status },
      { label: 'Units', text: (r) => r.units },
      { label: 'Age', cls: 'mdt-c-num', text: (r) => r.age },
    ], {
      key: (r) => r.callId,
      rowClass: (r) => `mdt-p${r.priority}${r.offered ? ' mdt-offered' : ''}${r.mine ? ' mdt-mine' : ''}`,
      onSelect: (r) => {
        this.selectedCall = r.callId;
        this.refreshQueueActions();
      },
      onActivate: (r) => {
        this.selectCall(r.callId);
        this.setTab('call', true);
      },
      empty: 'No open calls',
    });
    const withCall = (fn: (id: number) => void) => (): void => {
      if (this.selectedCall !== null) fn(this.selectedCall);
    };
    const disposition = selectField('Disposition', DISPOSITIONS.map((d) => ({ value: d.id, label: d.label })), 'handled');
    const queueActions = {
      accept: button('Accept', withCall((id) => this.acceptCall(id)), 'primary'),
      decline: button('Decline', withCall((id) => this.declineCall(id))),
      self: button('Self-assign', withCall((id) => this.selfAssign(id))),
      enRoute: button('En route', () => this.setStatus('enRoute')),
      onScene: button('On scene', () => this.setStatus('onScene')),
      clear: button('Clear call', withCall((id) => this.clearCall(id, disposition.control.value)), 'danger'),
    };
    panels.queue.append(
      el('div', { class: 'mdt-scroll' }, queue.element),
      el('div', { class: 'mdt-actions', role: 'group', 'aria-label': 'Selected call actions' },
        queueActions.accept, queueActions.decline, queueActions.self, queueActions.enRoute, queueActions.onScene,
        disposition.element, queueActions.clear),
    );

    // Call
    const callDetail = el('div', { class: 'mdt-scroll mdt-call-detail' });
    const narrative = textField('Add narrative', '', { maxlength: 200 });
    const addNarrative = el('button', { type: 'submit' }, 'Add');
    const narrativeForm = el('form', { class: 'mdt-inline', 'aria-label': 'Add narrative' }, narrative.element, addNarrative);
    narrativeForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const call = this.selectedCall ?? this.playerCall()?.id ?? null;
      if (call !== null && this.addNarrative(call, narrative.control.value)) narrative.control.value = '';
    });
    const writeReport = button('Write report', () => this.openForm('report'));
    panels.call.append(callDetail, el('div', { class: 'mdt-actions' }, narrativeForm, writeReport));

    // Units
    const units = new ListView<UnitRow>('Unit roster', [
      { label: 'Unit', cls: 'mdt-c-num', text: (r) => r.callsign },
      { label: 'Officer', text: (r) => r.officer },
      { label: 'Status', text: (r) => `${r.statusLabel}${r.emergency ? ' EMERGENCY' : ''}` },
      { label: 'Call', text: (r) => r.call },
      { label: 'Location', text: (r) => r.location },
      { label: 'In status', cls: 'mdt-c-num', text: (r) => r.since },
    ], {
      key: (r) => r.callsign,
      rowClass: (r) => `mdt-st-${r.status}${r.player ? ' mdt-mine' : ''}${r.emergency ? ' mdt-emergency' : ''}`,
      onActivate: (r) => {
        const u = this.deps.cad.unit(r.callsign);
        if (u?.callId !== null && u?.callId !== undefined) {
          this.selectCall(u.callId);
          this.setTab('call', true);
        }
      },
    });
    const statusButtons = new Map<UnitStatus, HTMLButtonElement>();
    const statusGroup = el('div', { class: 'mdt-actions', role: 'group', 'aria-label': `Unit ${this.deps.callsign} status` });
    for (const s of STATUS_BUTTONS) {
      const b = button(s.label, () => this.setStatus(s.status));
      statusButtons.set(s.status, b);
      statusGroup.appendChild(b);
    }
    // Code 4 also ends an emergency (a path that does not need the radio).
    statusGroup.appendChild(button('Code 4', () => this.code4()));
    panels.units.append(el('div', { class: 'mdt-scroll' }, units.element), statusGroup);

    // Map
    const map = new MdtMap(this.deps.graph, (id) => this.selectCall(id));
    map.setCallSource(() => this.deps.cad.calls());
    const mapSelected = el('span', { class: 'mdt-map-selected', 'aria-live': 'polite' }, 'No call selected');
    panels.map.append(
      el('div', { class: 'mdt-map-wrap' }, map.canvas),
      el('div', { class: 'mdt-actions' },
        button('Zoom in (+)', () => map.zoom(MAP_ZOOM_STEP)),
        button('Zoom out (-)', () => map.zoom(1 / MAP_ZOOM_STEP)),
        button('My unit (Home)', () => this.centreOnPlayer()),
        mapSelected,
        button('Open call', () => {
          if (this.selectedCall !== null) this.setTab('call', true);
        }),
        el('span', { class: 'mdt-legend' },
          el('i', { class: 'mdt-dot mdt-st-available' }), 'avail ', el('i', { class: 'mdt-dot mdt-st-enRoute' }), 'en route ',
          el('i', { class: 'mdt-dot mdt-st-onScene' }), 'on scene ', el('i', { class: 'mdt-dot mdt-st-busy' }), 'busy ',
          el('i', { class: 'mdt-diamond mdt-p1' }), 'P1 ', el('i', { class: 'mdt-diamond mdt-p2' }), 'P2 ',
          el('i', { class: 'mdt-diamond mdt-p3' }), 'P3 ', el('i', { class: 'mdt-diamond mdt-p4' }), 'P4'),
      ),
    );

    // Person
    const last = textField('Last name', '', { maxlength: 30 });
    const first = textField('First name', '', { maxlength: 30 });
    const dob = textField('DOB (MM/DD/YYYY)', '', { maxlength: 10, inputmode: 'numeric' });
    const dl = textField('DL #', '', { maxlength: 8 });
    const personForm = el('form', { class: 'mdt-inline mdt-query', 'aria-label': 'Person query' },
      last.element, first.element, dob.element, dl.element, el('button', { type: 'submit', class: 'primary' }, 'Search'));
    personForm.addEventListener('submit', (e) => {
      e.preventDefault();
      this.searchPersonFields({ last: last.control.value, first: first.control.value, dob: dob.control.value, dl: dl.control.value });
    });
    const personResults = new ListView<PersonSummary>('Person results', [
      { label: 'Name', text: (r) => r.name },
      { label: 'DOB', text: (r) => r.dob },
      { label: 'DL', text: (r) => `${r.dl} ${r.dlStatus}` },
      { label: 'Flags', text: (r) => (r.hits.length > 0 ? `${r.hits.length} HIT${r.hits.length === 1 ? '' : 'S'}` : 'CLEAR') },
    ], {
      key: (r) => r.personId,
      rowClass: (r) => `mdt-sev-${r.severity === 'clear' ? 'none' : r.severity}`,
      onActivate: (r) => this.showPerson(r.personId),
      empty: 'No results',
    });
    const personRecord = el('div', { class: 'mdt-record', 'aria-live': 'polite' });
    const wantsButton = button('Wants check', () => this.wantsCheck(this.personShown));
    wantsButton.disabled = true;
    panels.person.append(personForm, el('div', { class: 'mdt-split' },
      el('div', { class: 'mdt-scroll mdt-split-list' }, personResults.element),
      el('div', { class: 'mdt-scroll mdt-split-main' }, el('div', { class: 'mdt-actions' }, wantsButton), personRecord)));

    // Vehicle
    const vq = textField('Plate or VIN', '', { maxlength: 17 });
    const vehicleForm = el('form', { class: 'mdt-inline mdt-query', 'aria-label': 'Vehicle query' }, vq.element, el('button', { type: 'submit', class: 'primary' }, 'Run'));
    vehicleForm.addEventListener('submit', (e) => {
      e.preventDefault();
      this.runVehicleQuery(vq.control.value);
    });
    const runTarget = button('Run target', () => this.runTarget());
    const runStop = button('Run stop vehicle', () => this.runStopVehicle());
    const vehicleResult = el('div', { class: 'mdt-scroll mdt-record', 'aria-live': 'polite' });
    panels.vehicle.append(el('div', { class: 'mdt-actions' }, vehicleForm, runTarget, runStop), vehicleResult);

    // BOLO
    const bolos = new ListView<Bolo>("Today's BOLO bulletin", [
      { label: 'BOLO', cls: 'mdt-c-num', text: (b) => b.id },
      { label: 'Kind', text: (b) => b.kind },
      { label: 'Text', text: (b) => b.text },
    ], {
      key: (b) => b.id,
      onActivate: (b) => {
        if (b.kind === 'person' && b.personId >= 0) this.showPerson(b.personId);
        else if (b.vehicleId >= 0 && isRegistryId(b.vehicleId)) {
          this.runPlate(this.deps.records.registration(b.vehicleId).plate);
          this.setTab('vehicle');
        }
      },
      empty: 'No BOLOs today',
    });
    const history = new ListView<QueryLogEntry>('Query history', [
      { label: 'Time', cls: 'mdt-c-num', text: (q) => formatClockTime(q.gameSeconds) },
      { label: 'Kind', text: (q) => q.kind.toUpperCase() },
      { label: 'Query', text: (q) => q.text },
      { label: 'Result', text: (q) => q.summary },
    ], {
      key: (q) => `${q.gameSeconds}:${q.kind}:${q.text}`,
      rowClass: (q) => `mdt-sev-${q.severity === 'clear' ? 'none' : q.severity}`,
      onActivate: (q) => {
        if (q.kind === 'plate') {
          this.runPlate(q.text);
          this.setTab('vehicle');
        } else if (q.kind === 'vin') {
          this.runVin(q.text);
          this.setTab('vehicle');
        }
      },
      empty: 'No queries yet',
    });
    panels.bolo.append(el('h3', null, "Today's bulletin"), el('div', { class: 'mdt-scroll' }, bolos.element),
      el('h3', null, 'Query history'), el('div', { class: 'mdt-scroll' }, history.element));

    // Reports
    const kindButtons = {} as Record<DocKind, HTMLButtonElement>;
    const kindBar = el('div', { class: 'mdt-actions', role: 'group', 'aria-label': 'Document kind' });
    const newDoc = button('New incident report', () => this.openForm(this.docKind, undefined, this.formOptionsFor(this.docKind)), 'primary');
    for (const k of DOC_KINDS) {
      const b = button(DOC_KIND_LABELS[k], () => this.setDocKind(k));
      b.setAttribute('aria-pressed', k === this.docKind ? 'true' : 'false');
      kindButtons[k] = b;
      kindBar.appendChild(b);
    }
    kindBar.appendChild(newDoc);
    const docs = new ListView<DocRow>('Documents', [
      { label: 'ID', cls: 'mdt-c-num', text: (d) => d.id },
      { label: 'Status', text: (d) => d.status },
      { label: 'Created', text: (d) => d.time },
      { label: 'Summary', text: (d) => d.summary },
    ], {
      key: (d) => d.id,
      rowClass: (d) => (d.status === 'DRAFT' ? 'mdt-draft' : ''),
      onSelect: (d) => {
        if (!this.form) this.viewDocument(d.id);
      },
      onActivate: (d) => this.viewDocument(d.id),
      empty: 'No documents of this kind',
    });
    const docPane = el('div', { class: 'mdt-scroll mdt-split-main mdt-docpane' });
    panels.reports.append(kindBar, el('div', { class: 'mdt-split' }, el('div', { class: 'mdt-scroll mdt-split-list' }, docs.element), docPane));

    // Stop
    const stopButtons = {
      run: button('Run plate', () => {
        this.runStopVehicle();
        this.dirty = true;
        this.renderStop();
      }, 'primary'),
      wants: button('Wants check (driver)', () => {
        const s = this.deps.cad.trafficStop;
        if (s) this.wantsCheck(s.driverId);
      }),
      cite: button('Write citation', () => this.writeCitation()),
      release: button('Release', () => this.releaseStop(), 'danger'),
    };
    const stopBody = el('div', { class: 'mdt-scroll mdt-record' });
    panels.stop.append(el('div', { class: 'mdt-actions' }, stopButtons.run, stopButtons.wants, stopButtons.cite, stopButtons.release), stopBody);

    // Career and Community (design phase 5 §12.1)
    const careerBody = el('div', { class: 'mdt-scroll mdt-record mdt-career' });
    panels.career.appendChild(careerBody);
    const communityBody = el('div', { class: 'mdt-scroll mdt-community' });
    panels.community.append(
      el('p', { class: 'mdt-hint' }, 'Community trust by district. The tick marks the district baseline; the arrow is the change since midnight.'),
      communityBody,
    );

    const unitInfo = el('span', { class: 'mdt-unit' });
    const clock = el('span', { class: 'mdt-clock' });
    const message = el('div', { class: 'mdt-message', role: 'status', 'aria-live': 'polite' });
    const root = el('div', { class: 'mdt', role: 'dialog', 'aria-label': 'Mobile data terminal' },
      el('header', { class: 'mdt-header' },
        el('span', { class: 'mdt-title' }, 'MDT'), unitInfo, clock, button('Close (Esc)', () => this.close(), 'small')),
      tablist,
      el('div', { class: 'mdt-body' }, ...MDT_TABS.map((t) => panels[t])),
      el('footer', { class: 'mdt-footer' }, message,
        el('span', { class: 'mdt-keys' }, '1-9 0 tabs  ←/→ tabs  ↑/↓ lists  Enter open  Esc cancel/close')),
    );
    return {
      root, unitInfo, clock, message, tabs, panels,
      queue, queueActions, disposition: disposition.control,
      callDetail, narrative, callButtons: { add: addNarrative, report: writeReport },
      units, statusButtons,
      map, mapSelected,
      personQuery: { last: last.control, first: first.control, dob: dob.control, dl: dl.control },
      personResults, personRecord, wantsButton,
      vehicleQuery: vq.control, vehicleResult, runTarget, runStop,
      bolos, history,
      kindButtons, newDoc, docs, docPane,
      careerBody, communityBody,
      stopBody, stopButtons,
    };
  }

  private setDocKind(kind: DocKind): void {
    this.docKind = kind;
    this.viewDocId = null;
    this.dirty = true;
    this.lastUpdateMs = -Infinity;
    this.syncKindButtons();
    if (!this.form) this.renderDocPane();
  }

  private syncKindButtons(): void {
    const dom = this.dom;
    if (!dom) return;
    for (const k of DOC_KINDS) dom.kindButtons[k].setAttribute('aria-pressed', k === this.docKind ? 'true' : 'false');
    setText(dom.newDoc, `New ${DOC_KIND_SINGULAR[this.docKind]}`);
  }
}
