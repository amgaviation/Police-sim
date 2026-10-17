/**
 * CAD documents (design §6.4): incident reports, citations, bookings, evidence log entries and
 * supplementals. Drafts are editable; finalized documents are immutable except for evidence custody,
 * which is append-only. Every change emits `cad:documentSaved`.
 */
import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import { PERSON_POPULATION } from '../records/ids';
import { findStatute } from './data';
import { isArrayOf, isCadTime, isInt, isNullOr, isNum, isObj, isOneOf, isStr, isStrArray, type Obj } from './guards';
import type { CadDocumentSavedEvent } from './events';
import type { CadTime } from './types';

export const DOC_KINDS = ['report', 'citation', 'booking', 'evidence', 'supplement'] as const;
export type DocKind = (typeof DOC_KINDS)[number];

/** Id prefix and zero-padded digits per kind: R-0001, CT-000001, B-0001, E-0001, S-0001. */
export const DOC_ID_FORMAT: Readonly<Record<DocKind, { readonly prefix: string; readonly digits: number }>> = {
  report: { prefix: 'R', digits: 4 },
  citation: { prefix: 'CT', digits: 6 },
  booking: { prefix: 'B', digits: 4 },
  evidence: { prefix: 'E', digits: 4 },
  supplement: { prefix: 'S', digits: 4 },
};

export const PERSON_ROLES = ['victim', 'suspect', 'witness', 'reportingParty', 'involved'] as const;
export type PersonRole = (typeof PERSON_ROLES)[number];
export const EVIDENCE_CATEGORIES = ['property', 'drugs', 'weapon', 'document', 'digital', 'other'] as const;
export type EvidenceCategory = (typeof EVIDENCE_CATEGORIES)[number];
export const CUSTODY_ACTIONS = ['collected', 'transferred', 'booked', 'released'] as const;
export type CustodyAction = (typeof CUSTODY_ACTIONS)[number];

export interface DocBase {
  readonly id: string;
  readonly kind: DocKind;
  readonly created: CadTime;
  updated: CadTime;
  /** "Officer Doe #4071". */
  readonly author: string;
  callId: number | null;
  status: 'draft' | 'final';
}

export interface IncidentReport extends DocBase {
  kind: 'report';
  title: string;
  offenseIds: string[];
  location: string;
  occurredGame: number;
  persons: { personId: number; role: PersonRole }[];
  vehicles: { vehicleId: number; plate: string; role: string }[];
  narrative: string;
  evidenceIds: string[];
}

export interface CitationViolation {
  statuteId: string;
  fine: number;
  detail: string;
}

export interface Citation extends DocBase {
  kind: 'citation';
  personId: number;
  vehicleId: number;
  plate: string;
  location: string;
  violations: CitationViolation[];
  /** Always `citationTotal(violations)`. */
  totalFine: number;
  recordedSpeedMph: number | null;
  limitMph: number | null;
  notes: string;
}

export interface Booking extends DocBase {
  kind: 'booking';
  personId: number;
  /** Statute ids. */
  charges: string[];
  arrestedGame: number;
  arrestLocation: string;
  property: string;
  notes: string;
}

export interface CustodyEntry {
  game: number;
  action: CustodyAction;
  by: string;
  note: string;
}

export interface EvidenceItem extends DocBase {
  kind: 'evidence';
  description: string;
  category: EvidenceCategory;
  foundAt: string;
  custody: CustodyEntry[];
}

export interface Supplement extends DocBase {
  kind: 'supplement';
  /** Id of the (usually final) incident report it supplements. */
  parentId: string;
  narrative: string;
}

export type CadDocument = IncidentReport | Citation | Booking | EvidenceItem | Supplement;
export type DocOfKind<K extends DocKind> = Extract<CadDocument, { kind: K }>;

/** Kind-specific fields of a document; missing ones take defaults on `create`. */
export type DraftFields<K extends DocKind> = K extends DocKind
  ? Partial<Omit<DocOfKind<K>, keyof DocBase | 'totalFine'>> & { readonly callId?: number | null }
  : never;

export type DocCounters = Record<DocKind, number>;

export interface DocumentsSave {
  counters: DocCounters;
  items: CadDocument[];
}

/** Thrown by `finalize` when the document is incomplete; `messages` lists every problem. */
export class DocumentValidationError extends Error {
  readonly messages: string[];

  constructor(messages: string[]) {
    super(messages.join('; '));
    this.name = 'DocumentValidationError';
    this.messages = messages;
  }
}

export function citationTotal(violations: readonly { fine: number }[]): number {
  let total = 0;
  for (const v of violations) if (Number.isFinite(v.fine)) total += v.fine;
  return Math.round(total * 100) / 100;
}

export function emptyCounters(): DocCounters {
  return { report: 0, citation: 0, booking: 0, evidence: 0, supplement: 0 };
}

export function formatDocId(kind: DocKind, n: number): string {
  const f = DOC_ID_FORMAT[kind];
  return `${f.prefix}-${String(n).padStart(f.digits, '0')}`;
}

/** Sequence number of a document id of `kind` ("CT-000012" -> 12), -1 when it does not match. */
export function docIdNumber(kind: DocKind, id: string): number {
  const prefix = `${DOC_ID_FORMAT[kind].prefix}-`;
  if (!id.startsWith(prefix)) return -1;
  const rest = id.slice(prefix.length);
  return /^\d+$/.test(rest) ? Number(rest) : -1;
}

function defaultsFor(kind: DocKind, t: CadTime): Record<string, unknown> {
  switch (kind) {
    case 'report':
      return { title: '', offenseIds: [], location: '', occurredGame: t.game, persons: [], vehicles: [], narrative: '', evidenceIds: [] };
    case 'citation':
      return { personId: -1, vehicleId: -1, plate: '', location: '', violations: [], recordedSpeedMph: null, limitMph: null, notes: '' };
    case 'booking':
      return { personId: -1, charges: [], arrestedGame: t.game, arrestLocation: '', property: '', notes: '' };
    case 'evidence':
      return { description: '', category: 'other', foundAt: '', custody: [] };
    case 'supplement':
      return { parentId: '', narrative: '' };
  }
}

const FIELD_KEYS: Readonly<Record<DocKind, readonly string[]>> = {
  report: Object.keys(defaultsFor('report', { sim: 0, game: 0 })),
  citation: Object.keys(defaultsFor('citation', { sim: 0, game: 0 })),
  booking: Object.keys(defaultsFor('booking', { sim: 0, game: 0 })),
  evidence: Object.keys(defaultsFor('evidence', { sim: 0, game: 0 })),
  supplement: Object.keys(defaultsFor('supplement', { sim: 0, game: 0 })),
};

/** A person id of the records population. */
export function knownPerson(id: number): boolean {
  return Number.isInteger(id) && id >= 0 && id < PERSON_POPULATION;
}

function blank(text: string): boolean {
  return text.trim().length === 0;
}

/**
 * Problems that keep `doc` from being finalized ([] when valid). `find` resolves other documents
 * (a supplement's parent); without it only the parent id's format is checked.
 */
export function validateDocument(doc: CadDocument, find?: (id: string) => CadDocument | null): string[] {
  const out: string[] = [];
  switch (doc.kind) {
    case 'report':
      if (blank(doc.title)) out.push('Report needs a title');
      if (blank(doc.location)) out.push('Report needs a location');
      if (doc.narrative.trim().length < 20) out.push('Report narrative must be at least 20 characters');
      for (const p of doc.persons) if (!knownPerson(p.personId)) out.push(`Unknown person #${p.personId}`);
      break;
    case 'citation': {
      if (!(doc.personId >= 0)) out.push('Citation needs a person');
      else if (!knownPerson(doc.personId)) out.push(`Unknown person #${doc.personId}`);
      if (blank(doc.plate) && !(doc.vehicleId >= 0)) out.push('Citation needs a plate or vehicle');
      if (doc.violations.length === 0) out.push('Citation needs at least one violation');
      doc.violations.forEach((v, i) => {
        const s = findStatute(v.statuteId);
        if (!s) out.push(`Citation violation ${i + 1} has unknown statute ${v.statuteId}`);
        else if (!s.citeable) out.push(`Citation violation ${i + 1}: ${s.id} is not citeable`);
      });
      if (blank(doc.location)) out.push('Citation needs a location');
      break;
    }
    case 'booking': {
      if (!(doc.personId >= 0)) out.push('Booking needs a person');
      else if (!knownPerson(doc.personId)) out.push(`Unknown person #${doc.personId}`);
      let bookable = 0;
      for (const id of doc.charges) {
        const s = findStatute(id);
        if (!s) out.push(`Booking charge ${id} is unknown`);
        else if (!s.bookable) out.push(`Booking charge ${id} is not bookable`);
        else bookable++;
      }
      if (bookable === 0) out.push('Booking needs at least one bookable charge');
      break;
    }
    case 'evidence':
      if (blank(doc.description)) out.push('Evidence needs a description');
      if (!(EVIDENCE_CATEGORIES as readonly string[]).includes(doc.category)) out.push('Evidence needs a category');
      if (!doc.custody.some((c) => c.action === 'collected')) out.push("Evidence needs a 'collected' custody entry");
      break;
    case 'supplement': {
      const parentOk = find
        ? find(doc.parentId)?.kind === 'report'
        : docIdNumber('report', doc.parentId) >= 0;
      if (!parentOk) out.push('Supplement needs an existing report');
      if (doc.narrative.trim().length < 10) out.push('Supplement narrative must be at least 10 characters');
      break;
    }
  }
  return out;
}

/** All documents of a session, in creation order. */
export class DocumentStore {
  private readonly bus: EventBus<EventMap> | null;
  private readonly onChange: ((doc: CadDocument) => void) | null;
  private items: CadDocument[] = [];
  private readonly byId = new Map<string, CadDocument>();
  private counters: DocCounters = emptyCounters();

  constructor(bus?: EventBus<EventMap>, onChange?: (doc: CadDocument) => void) {
    this.bus = bus ?? null;
    this.onChange = onChange ?? null;
  }

  /** New draft with the next id of its kind; missing fields take defaults. */
  create<K extends DocKind>(kind: K, fields: DraftFields<K>, t: CadTime, author: string): DocOfKind<K> {
    this.counters[kind] += 1;
    const doc: Record<string, unknown> = {
      id: formatDocId(kind, this.counters[kind]),
      kind,
      created: { sim: t.sim, game: t.game },
      updated: { sim: t.sim, game: t.game },
      author,
      callId: null,
      status: 'draft',
      ...defaultsFor(kind, t),
    };
    this.apply(doc, kind, fields, true);
    const created = doc as unknown as CadDocument;
    this.items.push(created);
    this.byId.set(created.id, created);
    this.saved(created);
    return created as DocOfKind<K>;
  }

  /** Edits a draft (custody excepted: use `addCustody`); throws on an unknown id or a final document. */
  update(id: string, patch: Partial<DraftFields<DocKind>>, t: CadTime): CadDocument {
    const doc = this.require(id);
    if (doc.status === 'final') throw new Error(`Document ${id} is final and cannot be edited`);
    this.apply(doc as unknown as Record<string, unknown>, doc.kind, patch, false);
    doc.updated = { sim: t.sim, game: t.game };
    this.saved(doc);
    return doc;
  }

  /** Validates and locks a draft; throws `DocumentValidationError` when invalid. Final documents are returned as is. */
  finalize(id: string, t: CadTime): CadDocument {
    const doc = this.require(id);
    if (doc.status === 'final') return doc;
    const problems = validateDocument(doc, (other) => this.get(other));
    if (problems.length > 0) throw new DocumentValidationError(problems);
    doc.status = 'final';
    doc.updated = { sim: t.sim, game: t.game };
    this.saved(doc);
    return doc;
  }

  /** Appends a chain-of-custody entry (also after the item was finalized). */
  addCustody(evidenceId: string, entry: CustodyEntry, t: CadTime): void {
    const doc = this.require(evidenceId);
    if (doc.kind !== 'evidence') throw new Error(`Document ${evidenceId} is not an evidence item`);
    if (!(CUSTODY_ACTIONS as readonly string[]).includes(entry.action)) {
      throw new Error(`Unknown custody action "${String(entry.action)}"`);
    }
    doc.custody.push({ game: entry.game, action: entry.action, by: entry.by, note: entry.note });
    doc.updated = { sim: t.sim, game: t.game };
    this.saved(doc);
  }

  get(id: string): CadDocument | null {
    return this.byId.get(id) ?? null;
  }

  list(kind?: DocKind): readonly CadDocument[] {
    return kind === undefined ? this.items : this.items.filter((d) => d.kind === kind);
  }

  byCall(callId: number): CadDocument[] {
    return this.items.filter((d) => d.callId === callId);
  }

  get count(): number {
    return this.items.length;
  }

  serialize(): DocumentsSave {
    return { counters: { ...this.counters }, items: structuredClone(this.items) };
  }

  /** Replaces every document; counters never fall below the highest id in use. */
  restore(save: DocumentsSave): void {
    this.items = structuredClone(save.items);
    this.byId.clear();
    for (const d of this.items) this.byId.set(d.id, d);
    const counters = { ...save.counters };
    for (const d of this.items) counters[d.kind] = Math.max(counters[d.kind], docIdNumber(d.kind, d.id));
    this.counters = counters;
  }

  private require(id: string): CadDocument {
    const doc = this.byId.get(id);
    if (!doc) throw new Error(`Unknown document ${id}`);
    return doc;
  }

  private apply(doc: Record<string, unknown>, kind: DocKind, fields: Record<string, unknown>, creating: boolean): void {
    const keys = FIELD_KEYS[kind];
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      if (key === 'callId') {
        doc.callId = typeof value === 'number' && Number.isInteger(value) ? value : null;
      } else if (keys.includes(key) && (creating || key !== 'custody')) {
        doc[key] = typeof value === 'object' && value !== null ? structuredClone(value) : value;
      }
    }
    if (kind === 'citation') doc.totalFine = citationTotal(doc.violations as { fine: number }[]);
  }

  private saved(doc: CadDocument): void {
    this.onChange?.(doc);
    const payload: CadDocumentSavedEvent = { id: doc.id, kind: doc.kind, final: doc.status === 'final' };
    this.bus?.emit('cad:documentSaved', payload);
  }
}

// --- Save validation --------------------------------------------------------------------------

function isPersonRef(x: unknown): x is IncidentReport['persons'][number] {
  return isObj(x) && isInt(x.personId) && isOneOf(x.role, PERSON_ROLES);
}

function isVehicleRef(x: unknown): x is IncidentReport['vehicles'][number] {
  return isObj(x) && isInt(x.vehicleId) && isStr(x.plate) && isStr(x.role);
}

function isViolation(x: unknown): x is CitationViolation {
  return isObj(x) && isStr(x.statuteId) && isNum(x.fine) && isStr(x.detail);
}

function isCustody(x: unknown): x is CustodyEntry {
  return isObj(x) && isNum(x.game) && isOneOf(x.action, CUSTODY_ACTIONS) && isStr(x.by) && isStr(x.note);
}

function isKindFields(d: Obj): boolean {
  switch (d.kind) {
    case 'report':
      return isStr(d.title) && isStrArray(d.offenseIds) && isStr(d.location) && isNum(d.occurredGame) &&
        isArrayOf(d.persons, isPersonRef) && isArrayOf(d.vehicles, isVehicleRef) && isStr(d.narrative) &&
        isStrArray(d.evidenceIds);
    case 'citation':
      return isInt(d.personId) && isInt(d.vehicleId) && isStr(d.plate) && isStr(d.location) &&
        isArrayOf(d.violations, isViolation) && isNum(d.totalFine) && isNullOr(d.recordedSpeedMph, isNum) &&
        isNullOr(d.limitMph, isNum) && isStr(d.notes);
    case 'booking':
      return isInt(d.personId) && isStrArray(d.charges) && isNum(d.arrestedGame) && isStr(d.arrestLocation) &&
        isStr(d.property) && isStr(d.notes);
    case 'evidence':
      return isStr(d.description) && isOneOf(d.category, EVIDENCE_CATEGORIES) && isStr(d.foundAt) &&
        isArrayOf(d.custody, isCustody);
    case 'supplement':
      return isStr(d.parentId) && isStr(d.narrative);
    default:
      return false;
  }
}

export function isCadDocument(x: unknown): x is CadDocument {
  return isObj(x) && isStr(x.id) && isOneOf(x.kind, DOC_KINDS) && isCadTime(x.created) && isCadTime(x.updated) &&
    isStr(x.author) && isNullOr(x.callId, (v): v is number => isInt(v)) && isOneOf(x.status, ['draft', 'final'] as const) &&
    isKindFields(x);
}

export function isDocumentsSave(x: unknown): x is DocumentsSave {
  if (!isObj(x) || !isObj(x.counters) || !isArrayOf(x.items, isCadDocument)) return false;
  const counters = x.counters;
  if (!DOC_KINDS.every((k) => isInt(counters[k], 0))) return false;
  const ids = new Set<string>();
  for (const d of x.items) {
    if (ids.has(d.id)) return false;
    ids.add(d.id);
  }
  return true;
}
