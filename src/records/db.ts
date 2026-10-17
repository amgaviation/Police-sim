import { REGISTRY_POPULATION, vehicleIdFromPlate } from '../traffic/registry';
import type { City } from '../world/city';
import { DISTRICT, ROAD_CLASS } from '../world/ids';
import { dailyBolos, type Bolo } from './bolo';
import { epochDayOfGameSeconds, formatDate } from './calendar';
import { descriptionMismatch, personHits, registrationHits, severityOf, type RecordHit } from './hits';
import { PERSON_POPULATION, personIdFromDl, vehicleIdFromVin } from './ids';
import {
  displayName,
  generatePerson,
  personIdentity,
  type PersonIdentity,
  type PersonRecord,
  type PriorContact,
  type RecordsContext,
} from './person';
import { NameIndex } from './search';
import { PLATE_FLAG, generateRegistration, vehicleDescription, type ObservedVehicle, type RegistrationRecord } from './vehicle';

export type { Bolo } from './bolo';
export type { HitSeverity, RecordHit } from './hits';
export { createRecordsCommands } from './commands';

/**
 * The records database (design §5): lazily generated, cached person and registration records,
 * snapshots of everything the player has seen (saved, so a loaded game shows the same records),
 * and the player's overlay (contacts, served warrants, added BOLOs) plus a query log.
 */

export interface PlateQueryResult {
  readonly plate: string;
  readonly found: boolean;
  readonly registration: RegistrationRecord | null;
  readonly owner: PersonRecord | null;
  readonly hits: readonly RecordHit[];
  /** Detected `PLATE_FLAG` bits. */
  readonly flags: number;
  readonly observed: ObservedVehicle | null;
}

export interface VinQueryResult {
  readonly vin: string;
  readonly found: boolean;
  readonly registration: RegistrationRecord | null;
  readonly hits: readonly RecordHit[];
}

export interface PersonQuery {
  readonly last?: string;
  readonly first?: string;
  /** Epoch day. */
  readonly dob?: number;
  readonly dl?: string;
}

export interface PersonSummary {
  readonly personId: number;
  readonly name: string;
  readonly dob: string;
  readonly dl: string;
  readonly dlStatus: string;
  readonly hits: readonly string[];
  readonly severity: 'clear' | 'caution' | 'alert';
}

export interface PlateSummary {
  readonly plate: string;
  readonly found: boolean;
  readonly description: string;
  readonly owner: string;
  readonly ownerPersonId: number;
  readonly hits: readonly string[];
  readonly severity: 'clear' | 'caution' | 'alert';
}

export interface ContactEntry {
  readonly gameSeconds: number;
  readonly kind: 'citation' | 'arrest' | 'warning' | 'trafficStop' | 'fieldInterview';
  readonly ref: string;
  readonly summary: string;
}

export interface QueryLogEntry {
  readonly gameSeconds: number;
  readonly kind: 'plate' | 'vin' | 'person' | 'dl';
  readonly text: string;
  readonly summary: string;
  readonly severity: 'clear' | 'caution' | 'alert';
}

export interface RecordsSave {
  version: 1;
  /** Touched person snapshots (least recently touched first). */
  persons: PersonRecord[];
  vehicles: RegistrationRecord[];
  contacts: [number, ContactEntry[]][];
  served: [number, string[]][];
  /** Added BOLOs only (the daily bulletin is regenerated). */
  bolos: Bolo[];
  queries: QueryLogEntry[];
}

const CONTACT_KINDS: readonly ContactEntry['kind'][] = ['citation', 'arrest', 'warning', 'trafficStop', 'fieldInterview'];
const QUERY_KINDS: readonly QueryLogEntry['kind'][] = ['plate', 'vin', 'person', 'dl'];
const SEVERITIES: readonly QueryLogEntry['severity'][] = ['clear', 'caution', 'alert'];

/** Generated-record LRU caches. */
const CACHE_SIZE = 4096;
/** Snapshot caps (records referenced by the overlay are kept beyond them). */
export const SNAPSHOT_CAP = 500;
export const QUERY_LOG_CAP = 50;
const DEFAULT_SEARCH_LIMIT = 20;
/** Daily bulletins kept in memory. */
const BOLO_DAY_CACHE = 8;
const PLATE_RE = /^([A-Z]{3})\s*(\d{4})$/;

/** "abc1234" / " ABC 1234 " -> "ABC 1234"; null when malformed. */
export function normalizePlate(text: string): string | null {
  const m = PLATE_RE.exec(text.trim().toUpperCase());
  return m ? `${m[1] ?? ''} ${m[2] ?? ''}` : null;
}

/** Map-backed LRU cache. */
class Lru<V> {
  private readonly map = new Map<number, V>();
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  get(key: number): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: number, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
  }

  clear(): void {
    this.map.clear();
  }
}

function inRange(id: number, size: number): boolean {
  return Number.isInteger(id) && id >= 0 && id < size;
}

function isIdIn(id: unknown, size: number): id is number {
  return typeof id === 'number' && inRange(id, size);
}

export class RecordsDb {
  readonly seed: number;
  private readonly ctx: RecordsContext;
  private readonly personCache = new Lru<PersonRecord>(CACHE_SIZE);
  private readonly regCache = new Lru<RegistrationRecord>(CACHE_SIZE);
  /** Restored snapshots: take precedence over regeneration. */
  private readonly personSnapshots = new Map<number, PersonRecord>();
  private readonly regSnapshots = new Map<number, RegistrationRecord>();
  /** Touched ids in recency order (oldest first). */
  private readonly touchedPersons = new Map<number, true>();
  private readonly touchedVehicles = new Map<number, true>();
  private readonly contacts = new Map<number, ContactEntry[]>();
  private readonly served = new Map<number, string[]>();
  private addedBolos: Bolo[] = [];
  private nextBoloNumber = 1;
  private readonly boloDays = new Map<number, readonly Bolo[]>();
  private log: QueryLogEntry[] = [];
  private nameIndex: NameIndex | null = null;

  constructor(seed: number, ctx: RecordsContext) {
    this.seed = seed;
    this.ctx = ctx;
  }

  /** Newest last, at most `QUERY_LOG_CAP`. */
  get queryLog(): readonly QueryLogEntry[] {
    return this.log;
  }

  /** Current epoch day (from the context). */
  today(): number {
    return this.ctx.today();
  }

  // --- Records -------------------------------------------------------------------

  /** Person record with the overlay applied; RangeError outside the population. */
  person(id: number): PersonRecord {
    this.checkPerson(id, 'person');
    this.touchPerson(id);
    return this.viewPerson(id);
  }

  /** Registration record; RangeError outside the registry. */
  registration(vehicleId: number): RegistrationRecord {
    if (!inRange(vehicleId, REGISTRY_POPULATION)) {
      throw new RangeError(`registration: id ${vehicleId} outside [0, ${REGISTRY_POPULATION})`);
    }
    this.touchVehicle(vehicleId);
    return this.baseRegistration(vehicleId);
  }

  /** Hits of a person (overlay and today's BOLOs applied); does not mark the record touched. */
  personHits(id: number): RecordHit[] {
    this.checkPerson(id, 'personHits');
    return personHits(this.viewPerson(id), this.bolos(this.ctx.today()));
  }

  personSummary(id: number): PersonSummary {
    this.checkPerson(id, 'personSummary');
    this.touchPerson(id);
    return this.summaryOf(id);
  }

  // --- Queries -------------------------------------------------------------------

  /** Runs a plate (normalised, e.g. "abc1234" -> "ABC 1234") and logs the query. */
  runPlate(plate: string, observed?: ObservedVehicle, gameSeconds = 0): PlateQueryResult {
    const norm = normalizePlate(plate);
    const text = norm ?? plate.trim().toUpperCase();
    const id = norm === null ? null : vehicleIdFromPlate(this.seed, norm);
    let result: PlateQueryResult;
    if (id === null) {
      result = { plate: text, found: false, registration: null, owner: null, hits: [], flags: 0, observed: observed ?? null };
    } else {
      const reg = this.registration(id);
      const owner = this.person(reg.ownerId);
      const bolos = this.bolos(this.ctx.today());
      const hits = registrationHits(reg, owner, observed ?? null, bolos);
      let flags = 0;
      if (reg.stolen || reg.plateReportedStolen) flags |= PLATE_FLAG.stolen;
      if (reg.cloneAlert) flags |= PLATE_FLAG.cloned;
      if (observed && descriptionMismatch(reg, observed)) flags |= PLATE_FLAG.mismatched;
      if (reg.expired) flags |= PLATE_FLAG.expired;
      const bolo = bolos.some((b) => b.kind === 'vehicle' && b.vehicleId === id);
      if (reg.flag !== null || bolo || owner.warrants.length > 0) flags |= PLATE_FLAG.flagged;
      result = { plate: text, found: true, registration: reg, owner, hits, flags, observed: observed ?? null };
    }
    const s = plateSummary(result);
    const summary = s.found ? `${s.description.toUpperCase()} - RO ${s.owner}${hitCount(s.hits.length)}` : 'NO RECORD';
    this.logQuery({ gameSeconds, kind: 'plate', text, summary, severity: s.severity });
    return result;
  }

  /** Runs a VIN and logs the query. */
  runVin(vin: string, gameSeconds = 0): VinQueryResult {
    const text = vin.trim().toUpperCase();
    const id = vehicleIdFromVin(this.seed, text);
    let result: VinQueryResult;
    if (id === null) {
      result = { vin: text, found: false, registration: null, hits: [] };
    } else {
      const reg = this.registration(id);
      result = { vin: text, found: true, registration: reg, hits: registrationHits(reg, null, null, this.bolos(this.ctx.today())) };
    }
    const reg = result.registration;
    const summary = reg ? `${vehicleDescription(reg).toUpperCase()} - PLATE ${reg.plate}${hitCount(result.hits.length)}` : 'NO RECORD';
    this.logQuery({ gameSeconds, kind: 'vin', text, summary, severity: severityOf(result.hits) });
    return result;
  }

  /**
   * Name / DOB / DL search. Needs a DL number or a last name of 2+ characters (exact or prefix,
   * case-insensitive); `first` is a prefix, `dob` exact. Sorted by (last, first, dob, id), at most
   * `limit` results; logged like the other queries. Results are not marked touched.
   */
  findPersons(q: PersonQuery, limit = DEFAULT_SEARCH_LIMIT, gameSeconds = 0): PersonSummary[] {
    const last = (q.last ?? '').trim().toUpperCase();
    const first = (q.first ?? '').trim().toUpperCase();
    const dl = (q.dl ?? '').trim().toUpperCase();
    let ids: number[] = [];
    if (dl !== '') {
      const id = personIdFromDl(this.seed, dl);
      if (id !== null) ids.push(id);
    } else if (last.length >= 2) {
      this.nameIndex ??= new NameIndex(this.seed);
      ids = this.nameIndex.candidates(last, ids);
    }
    const matches: PersonIdentity[] = [];
    for (const id of ids) {
      // Identity from a restored snapshot when there is one, else the cheap hash identity.
      const p = this.personSnapshots.get(id) ?? personIdentity(this.seed, id);
      if (last !== '' && !p.last.toUpperCase().startsWith(last)) continue;
      if (first !== '' && !p.first.toUpperCase().startsWith(first)) continue;
      if (q.dob !== undefined && p.dob !== q.dob) continue;
      if (dl !== '' && this.basePerson(id).license.number !== dl) continue;
      matches.push(p);
    }
    matches.sort((a, b) => cmp(a.last.toUpperCase(), b.last.toUpperCase()) || cmp(a.first.toUpperCase(), b.first.toUpperCase()) || a.dob - b.dob || a.id - b.id);
    const out = matches.slice(0, Math.max(0, limit)).map((p) => this.summaryOf(p.id));
    const parts = [dl, last === '' ? '' : `${last}${first === '' ? '' : `, ${first}`}`, q.dob === undefined ? '' : `DOB ${formatDate(q.dob)}`];
    this.logQuery({
      gameSeconds,
      kind: dl !== '' ? 'dl' : 'person',
      text: parts.filter((s) => s !== '').join(' '),
      summary: `${matches.length} MATCH${matches.length === 1 ? '' : 'ES'}`,
      severity: rollup(out.map((s) => s.severity)),
    });
    return out;
  }

  /** The daily bulletin of `epochDay` (pure from the seed) plus added BOLOs dated on or before it. */
  bolos(epochDay: number): readonly Bolo[] {
    let daily = this.boloDays.get(epochDay);
    if (!daily) {
      if (this.boloDays.size >= BOLO_DAY_CACHE) this.boloDays.clear();
      daily = dailyBolos(this.seed, epochDay);
      this.boloDays.set(epochDay, daily);
    }
    const added = this.addedBolos.filter((b) => b.day <= epochDay);
    return added.length === 0 ? daily : [...daily, ...added];
  }

  // --- Overlay -------------------------------------------------------------------

  addBolo(b: Omit<Bolo, 'id'>): Bolo {
    const bolo: Bolo = { ...b, id: `BOLO-A${String(this.nextBoloNumber++).padStart(4, '0')}` };
    this.addedBolos.push(bolo);
    if (inRange(bolo.personId, PERSON_POPULATION)) this.touchPerson(bolo.personId);
    if (inRange(bolo.vehicleId, REGISTRY_POPULATION)) this.touchVehicle(bolo.vehicleId);
    return bolo;
  }

  /** Records a contact from this game; it shows first in the person's priors. */
  addContact(personId: number, c: ContactEntry): void {
    this.checkPerson(personId, 'addContact');
    const list = this.contacts.get(personId) ?? [];
    list.push(c);
    this.contacts.set(personId, list);
    this.touchPerson(personId);
  }

  /** Removes a warrant from the person's active warrants (and hits). */
  serveWarrant(personId: number, warrantId: string): void {
    this.checkPerson(personId, 'serveWarrant');
    const list = this.served.get(personId) ?? [];
    if (!list.includes(warrantId)) list.push(warrantId);
    this.served.set(personId, list);
    this.touchPerson(personId);
  }

  // --- Persistence -----------------------------------------------------------------

  serialize(): RecordsSave {
    return {
      version: 1,
      persons: [...this.touchedPersons.keys()].map((id) => this.basePerson(id)),
      vehicles: [...this.touchedVehicles.keys()].map((id) => this.baseRegistration(id)),
      contacts: [...this.contacts].map(([id, list]) => [id, list.slice()]),
      served: [...this.served].map(([id, list]) => [id, list.slice()]),
      bolos: this.addedBolos.slice(),
      queries: this.log.slice(),
    };
  }

  /** Replaces all state with `save`; malformed entries are dropped silently (regenerated). */
  restore(save: RecordsSave): void {
    this.personCache.clear();
    this.regCache.clear();
    this.personSnapshots.clear();
    this.regSnapshots.clear();
    this.touchedPersons.clear();
    this.touchedVehicles.clear();
    this.contacts.clear();
    this.served.clear();
    this.addedBolos = [];
    this.nextBoloNumber = 1;
    this.log = [];
    const s = (typeof save === 'object' && save !== null ? save : {}) as Partial<Record<keyof RecordsSave, unknown>>;
    for (const [id, list] of pairsOf(s.contacts)) {
      if (!isIdIn(id, PERSON_POPULATION) || !Array.isArray(list)) continue;
      const valid = (list as unknown[]).filter(isContactEntry);
      if (valid.length > 0) this.contacts.set(id, [...(this.contacts.get(id) ?? []), ...valid]);
    }
    for (const [id, list] of pairsOf(s.served)) {
      if (!isIdIn(id, PERSON_POPULATION) || !Array.isArray(list)) continue;
      const valid = (list as unknown[]).filter((w): w is string => typeof w === 'string');
      if (valid.length > 0) this.served.set(id, valid);
    }
    for (const b of arrayOf(s.bolos)) {
      if (!isBolo(b)) continue;
      this.addedBolos.push(b);
      const n = /^BOLO-A(\d+)$/.exec(b.id);
      if (n) this.nextBoloNumber = Math.max(this.nextBoloNumber, Number(n[1]) + 1);
    }
    this.log = arrayOf(s.queries).filter(isQueryLogEntry).slice(-QUERY_LOG_CAP);
    for (const p of arrayOf(s.persons)) {
      if (!isPersonRecord(p) || !isIdIn(p.id, PERSON_POPULATION)) continue;
      this.personSnapshots.set(p.id, p);
      this.touchPerson(p.id);
    }
    for (const r of arrayOf(s.vehicles)) {
      if (!isRegistrationRecord(r) || !isIdIn(r.vehicleId, REGISTRY_POPULATION)) continue;
      this.regSnapshots.set(r.vehicleId, r);
      this.touchVehicle(r.vehicleId);
    }
    // Overlay references are always kept (normally they are among the snapshots already).
    const keepPerson = (id: number): void => {
      if (inRange(id, PERSON_POPULATION) && !this.touchedPersons.has(id)) this.touchPerson(id);
    };
    for (const id of this.contacts.keys()) keepPerson(id);
    for (const id of this.served.keys()) keepPerson(id);
    for (const b of this.addedBolos) {
      keepPerson(b.personId);
      if (inRange(b.vehicleId, REGISTRY_POPULATION) && !this.touchedVehicles.has(b.vehicleId)) this.touchVehicle(b.vehicleId);
    }
  }

  // --- Internals -----------------------------------------------------------------

  private checkPerson(id: number, what: string): void {
    if (!inRange(id, PERSON_POPULATION)) throw new RangeError(`${what}: id ${id} outside [0, ${PERSON_POPULATION})`);
  }

  private basePerson(id: number): PersonRecord {
    const snap = this.personSnapshots.get(id);
    if (snap) return snap;
    let p = this.personCache.get(id);
    if (!p) {
      p = generatePerson(this.seed, id, this.ctx);
      this.personCache.set(id, p);
    }
    return p;
  }

  private baseRegistration(vehicleId: number): RegistrationRecord {
    const snap = this.regSnapshots.get(vehicleId);
    if (snap) return snap;
    let r = this.regCache.get(vehicleId);
    if (!r) {
      r = generateRegistration(this.seed, vehicleId);
      this.regCache.set(vehicleId, r);
    }
    return r;
  }

  /** Base record with the overlay: contacts (newest first) ahead of the priors, served warrants removed. */
  private viewPerson(id: number): PersonRecord {
    const base = this.basePerson(id);
    const contacts = this.contacts.get(id);
    const served = this.served.get(id);
    if (!contacts && !served) return base;
    const added: PriorContact[] = (contacts ?? [])
      .map((c) => ({ day: epochDayOfGameSeconds(c.gameSeconds), kind: c.kind, location: '', summary: c.summary, ref: c.ref }))
      .reverse();
    return {
      ...base,
      warrants: served ? base.warrants.filter((w) => !served.includes(w.id)) : base.warrants,
      priors: [...added, ...base.priors],
    };
  }

  private summaryOf(id: number): PersonSummary {
    const p = this.viewPerson(id);
    const hits = personHits(p, this.bolos(this.ctx.today()));
    return {
      personId: id,
      name: displayName(p),
      dob: formatDate(p.dob),
      dl: p.license.number === '' ? 'NONE' : p.license.number,
      dlStatus: p.license.status.toUpperCase(),
      hits: hits.map((h) => h.text),
      severity: severityOf(hits),
    };
  }

  private isPersonReferenced(id: number): boolean {
    return this.contacts.has(id) || this.served.has(id) || this.addedBolos.some((b) => b.personId === id);
  }

  private isVehicleReferenced(id: number): boolean {
    return this.addedBolos.some((b) => b.vehicleId === id);
  }

  private touchPerson(id: number): void {
    touch(this.touchedPersons, id, (k) => this.isPersonReferenced(k));
  }

  private touchVehicle(id: number): void {
    touch(this.touchedVehicles, id, (k) => this.isVehicleReferenced(k));
  }

  private logQuery(e: QueryLogEntry): void {
    this.log.push(e);
    if (this.log.length > QUERY_LOG_CAP) this.log.splice(0, this.log.length - QUERY_LOG_CAP);
  }
}

/** Marks `id` most recently touched; evicts the least recently touched unreferenced ids over the cap. */
function touch(set: Map<number, true>, id: number, referenced: (id: number) => boolean): void {
  set.delete(id);
  set.set(id, true);
  if (set.size <= SNAPSHOT_CAP) return;
  for (const k of set.keys()) {
    if (set.size <= SNAPSHOT_CAP) break;
    if (k !== id && !referenced(k)) set.delete(k);
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function hitCount(n: number): string {
  return n === 0 ? '' : ` - ${n} HIT${n === 1 ? '' : 'S'}`;
}

function rollup(list: readonly ('clear' | 'caution' | 'alert')[]): 'clear' | 'caution' | 'alert' {
  if (list.includes('alert')) return 'alert';
  return list.includes('caution') ? 'caution' : 'clear';
}

function arrayOf(x: unknown): unknown[] {
  return Array.isArray(x) ? (x as unknown[]) : [];
}

function pairsOf(x: unknown): [unknown, unknown][] {
  return arrayOf(x).filter((p): p is [unknown, unknown] => Array.isArray(p) && p.length === 2);
}

/** Plate query -> the radio/CAD readback shape (cad `PlateReadback`). */
export function plateSummary(r: PlateQueryResult): PlateSummary {
  const reg = r.registration;
  return {
    plate: r.plate,
    found: r.found,
    description: reg ? vehicleDescription(reg) : '',
    owner: r.owner ? displayName(r.owner) : '',
    ownerPersonId: r.owner ? r.owner.id : -1,
    hits: r.hits.map((h) => h.text),
    severity: severityOf(r.hits),
  };
}

/** Ids (ascending) of local and collector edges in suburbs, downtown or rural districts: where people live. */
export function homeEdgesOf(city: City): number[] {
  const out: number[] = [];
  for (const e of city.graph.edges) {
    const cls = e.roadClass === ROAD_CLASS.local || e.roadClass === ROAD_CLASS.collector;
    const district = e.district === DISTRICT.suburbs || e.district === DISTRICT.downtown || e.district === DISTRICT.rural;
    if (cls && district) out.push(e.id);
  }
  return out.sort((a, b) => a - b);
}

export function emptyRecordsSave(): RecordsSave {
  return { version: 1, persons: [], vehicles: [], contacts: [], served: [], bolos: [], queries: [] };
}

// --- Structural validators ---------------------------------------------------------------

type Obj = Record<string, unknown>;

function isObj(x: unknown): x is Obj {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isInt(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x);
}

function isNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function isStr(x: unknown): x is string {
  return typeof x === 'string';
}

function isStrArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every(isStr);
}

function isContactEntry(x: unknown): x is ContactEntry {
  return isObj(x) && isNum(x.gameSeconds) && (CONTACT_KINDS as readonly unknown[]).includes(x.kind) && isStr(x.ref) && isStr(x.summary);
}

function isQueryLogEntry(x: unknown): x is QueryLogEntry {
  return (
    isObj(x) &&
    isNum(x.gameSeconds) &&
    (QUERY_KINDS as readonly unknown[]).includes(x.kind) &&
    isStr(x.text) &&
    isStr(x.summary) &&
    (SEVERITIES as readonly unknown[]).includes(x.severity)
  );
}

function isBolo(x: unknown): x is Bolo {
  return (
    isObj(x) && isStr(x.id) && isInt(x.day) && (x.kind === 'vehicle' || x.kind === 'person') && isInt(x.vehicleId) && isInt(x.personId) && isStr(x.text)
  );
}

function isPrior(x: unknown): x is PriorContact {
  return isObj(x) && isInt(x.day) && isStr(x.kind) && isStr(x.location) && isStr(x.summary) && isStr(x.ref);
}

function isWarrantShape(x: unknown): boolean {
  return isObj(x) && isStr(x.id) && isStr(x.kind) && isStr(x.offense) && isNum(x.bail) && isStr(x.court) && isInt(x.issued);
}

/** Full structural check of a person snapshot. */
export function isPersonRecord(x: unknown): x is PersonRecord {
  if (!isObj(x)) return false;
  const lic = x.license;
  const sup = x.supervision;
  const gang = x.gang;
  return (
    isInt(x.id) &&
    isStr(x.first) &&
    isStr(x.middle) &&
    isStr(x.last) &&
    (x.sex === 'M' || x.sex === 'F') &&
    isInt(x.dob) &&
    isNum(x.heightCm) &&
    isNum(x.weightKg) &&
    isStr(x.eyes) &&
    isStr(x.hair) &&
    isStr(x.address) &&
    isStr(x.phone) &&
    isObj(lic) &&
    isStr(lic.number) &&
    isStr(lic.cls) &&
    ['valid', 'suspended', 'revoked', 'expired', 'none'].includes(lic.status as string) &&
    isInt(lic.expires) &&
    Array.isArray(x.warrants) &&
    x.warrants.every(isWarrantShape) &&
    isObj(sup) &&
    ['none', 'probation', 'parole'].includes(sup.kind as string) &&
    isStr(sup.agent) &&
    isInt(sup.until) &&
    isStrArray(sup.conditions) &&
    (gang === null || (isObj(gang) && isStr(gang.name) && (gang.role === 'member' || gang.role === 'associate'))) &&
    (x.mentalHealth === null || isStr(x.mentalHealth)) &&
    isStrArray(x.officerSafety) &&
    Array.isArray(x.firearms) &&
    x.firearms.every((f) => isObj(f) && isStr(f.type) && isStr(f.serial) && isInt(f.registered)) &&
    Array.isArray(x.protectiveOrders) &&
    x.protectiveOrders.every((o) => isObj(o) && isInt(o.protectedId) && isStrArray(o.conditions) && isInt(o.expires)) &&
    Array.isArray(x.priors) &&
    x.priors.every(isPrior)
  );
}

/** Full structural check of a registration snapshot. */
export function isRegistrationRecord(x: unknown): x is RegistrationRecord {
  return (
    isObj(x) &&
    isInt(x.vehicleId) &&
    isStr(x.plate) &&
    isStr(x.vin) &&
    isInt(x.year) &&
    isStr(x.modelId) &&
    isStr(x.modelName) &&
    isInt(x.color) &&
    isStr(x.colorName) &&
    isInt(x.ownerId) &&
    isInt(x.expires) &&
    typeof x.expired === 'boolean' &&
    typeof x.insured === 'boolean' &&
    isStr(x.insurer) &&
    typeof x.stolen === 'boolean' &&
    typeof x.plateReportedStolen === 'boolean' &&
    typeof x.cloneAlert === 'boolean' &&
    (x.flag === null || isStr(x.flag))
  );
}

/**
 * Structural check of a records save block: the overlay and query log entries are checked fully;
 * person/vehicle snapshots only need to be arrays (malformed snapshots are dropped on restore).
 */
export function isRecordsSave(x: unknown): x is RecordsSave {
  if (!isObj(x) || x.version !== 1) return false;
  if (!Array.isArray(x.persons) || !Array.isArray(x.vehicles)) return false;
  const pairs = (v: unknown, ok: (list: unknown) => boolean): boolean =>
    Array.isArray(v) && v.every((p) => Array.isArray(p) && p.length === 2 && isInt(p[0]) && ok(p[1]));
  return (
    pairs(x.contacts, (l) => Array.isArray(l) && l.every(isContactEntry)) &&
    pairs(x.served, isStrArray) &&
    Array.isArray(x.bolos) &&
    x.bolos.every(isBolo) &&
    Array.isArray(x.queries) &&
    x.queries.every(isQueryLogEntry)
  );
}
