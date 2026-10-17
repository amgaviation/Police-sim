import { epochDayOfGameSeconds } from '../records/calendar';
import { PERSON_POPULATION, ownerOfVehicle } from '../records/ids';
import type { RecordsDb } from '../records/db';
import type { PersonRecord } from '../records/person';
import type { NameIndex } from '../records/search';
import { driverOf } from '../records/vehicle';
import { REGISTRY_POPULATION } from '../traffic/registry';
import { PEOPLE_DATA } from './data';
import { nameIndexFor } from './family';
import { generateIdentity } from './identity';
import { baseIntoxication, intoxicationLevel } from './intoxication';
import { hasCarryNote, hasRegisteredHandgun, isItemId, itemDef, vehicleItems as baseVehicleItems } from './items';
import { occupantsOf as occupantsOfVehicle } from './occupants';
import {
  CUSTODIES,
  DRUG_KINDS,
  FACT_SOURCES,
  ITEM_WHERE,
  type Appearance,
  type CarriedItem,
  type Custody,
  type DrugKind,
  type Intoxication,
  type ItemOwner,
  type NpcIdentity,
  type NpcState,
  type OfficerHistory,
  type PeopleSave,
  type PersonDeltaSave,
  type PersonFact,
  type Statement,
} from './types';

/**
 * Identity and state layer (design §5.4 / §5.5): lazily generated identities (LRU) plus deltas for the persons
 * the player touched. A person who was never touched has no delta and is saved as nothing.
 */

/** Identity cache capacity (keyed by person id and epoch day). */
export const IDENTITY_CACHE = 2048;
/** Persons kept in the save / in memory. */
export const PEOPLE_CAP = 3000;
/** Statements, facts and lies per person. */
export const PER_PERSON_CAP = 100;
/** When over the cap, the least recently touched droppable persons are evicted down to `PEOPLE_CAP - TRIM`. */
const TRIM = 150;
const ADDED_CAP = 64;
const SEIZED_CAP = 200;
const FLAGS_CAP = 64;
/** An explicit intoxication overrides the base session curve for at least this long (sim game seconds). */
const OVERRIDE_MIN_S = 12 * 3600;
/** Explicitly set drug influence lasts this long at `DRUG_SET_LEVEL`. */
const DRUG_SET_H = 4;
const DRUG_SET_LEVEL = 0.6;
/** BAC at which a driver counts as intoxicated for vehicle contents. */
const INTOXICATED_BAC = 0.04;
const ID_SPACE = 131072;
/** Instance numbers of scenario-added items start here (base items use 0..9). */
const ADDED_INSTANCE_BASE = 100;
const INSTANCE_RE = /^([pv])(\d+):([A-Za-z]+):(\d+)$/;

const NO_ITEMS: readonly CarriedItem[] = [];
const NO_STATEMENTS: readonly Statement[] = [];
const NO_FACTS: readonly PersonFact[] = [];
const NO_HISTORY: OfficerHistory = { count: 0, lastGame: 0, lastOutcome: '', rapport: 0 };

export interface PopulationDeps {
  readonly seed: number;
  readonly records: RecordsDb;
  /** Game seconds. */
  now(): number;
}

function checkPerson(id: number, what: string): void {
  if (!Number.isInteger(id) || id < 0 || id >= PERSON_POPULATION) throw new RangeError(`${what}: id ${id} outside [0, ${PERSON_POPULATION})`);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** The parts of a record the overlay can change: a cached identity is stale when any differs. */
function sameView(a: PersonRecord, b: PersonRecord): boolean {
  return (
    a === b ||
    (a.warrants.length === b.warrants.length &&
      a.priors.length === b.priors.length &&
      a.license.status === b.license.status &&
      a.supervision.kind === b.supervision.kind)
  );
}

function isEmptyDelta(d: PersonDeltaSave): boolean {
  return (
    d.intox === undefined && d.mood === undefined && d.custody === undefined && d.injured === undefined && d.deceased === undefined &&
    d.missing === undefined && d.seized === undefined && d.added === undefined && d.officer === undefined && d.statements === undefined &&
    d.facts === undefined && d.lies === undefined && d.flags === undefined
  );
}

/** Deltas the retention rule never drops (design §5.5, plus deceased/missing/lies/flags which cannot be regenerated). */
function isProtected(d: PersonDeltaSave): boolean {
  return (
    (d.statements?.length ?? 0) > 0 || (d.facts?.length ?? 0) > 0 || (d.custody !== undefined && d.custody !== 'none' && d.custody !== 'released') ||
    d.officer !== undefined || (d.added?.length ?? 0) > 0 || (d.seized?.length ?? 0) > 0 || d.deceased === true || d.missing === true ||
    (d.lies?.length ?? 0) > 0 || (d.flags?.length ?? 0) > 0
  );
}

function cloneDelta(d: PersonDeltaSave): PersonDeltaSave {
  const o: PersonDeltaSave = { id: d.id, touched: d.touched };
  if (d.intox) o.intox = { ...d.intox };
  if (d.mood !== undefined) o.mood = d.mood;
  if (d.custody !== undefined) o.custody = d.custody;
  if (d.custodySince !== undefined) o.custodySince = d.custodySince;
  if (d.injured !== undefined) o.injured = d.injured;
  if (d.deceased !== undefined) o.deceased = d.deceased;
  if (d.missing !== undefined) o.missing = d.missing;
  if (d.seized) o.seized = d.seized.slice();
  if (d.added) o.added = d.added.map((a) => ({ ...a }));
  if (d.officer) o.officer = { ...d.officer };
  if (d.statements) o.statements = d.statements.map((s) => ({ ...s }));
  if (d.facts) o.facts = d.facts.map((f) => ({ ...f }));
  if (d.nextFactId !== undefined) o.nextFactId = d.nextFactId;
  if (d.lies) o.lies = d.lies.map((l) => ({ ...l }));
  if (d.flags) o.flags = d.flags.slice();
  return o;
}

export class Population {
  readonly seed: number;
  private readonly records: RecordsDb;
  private readonly nowFn: () => number;
  private readonly deltas = new Map<number, PersonDeltaSave>();
  private readonly cache = new Map<number, NpcIdentity>();
  private index: NameIndex | null = null;
  private rev = 0;

  constructor(deps: PopulationDeps) {
    this.seed = deps.seed;
    this.records = deps.records;
    this.nowFn = () => deps.now();
  }

  /** Bumps on every delta change. */
  get revision(): number {
    return this.rev;
  }

  // --- Identity ------------------------------------------------------------------

  /** Identity of person `id` today (LRU 2048 keyed by id and epoch day); the record is read without touching it. */
  identity(id: number): NpcIdentity {
    checkPerson(id, 'identity');
    const day = epochDayOfGameSeconds(this.nowFn());
    const key = day * ID_SPACE + id;
    const record = this.records.peekPerson(id);
    const hit = this.cache.get(key);
    if (hit && sameView(hit.record, record)) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    this.index ??= nameIndexFor(this.seed);
    const made = generateIdentity(this.seed, id, record, day, this.index);
    this.cache.delete(key);
    this.cache.set(key, made);
    if (this.cache.size > IDENTITY_CACHE) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    return made;
  }

  appearance(id: number): Appearance {
    return this.identity(id).appearance;
  }

  // --- State ---------------------------------------------------------------------

  state(id: number): NpcState {
    checkPerson(id, 'state');
    const d = this.deltas.get(id);
    return {
      intoxication: this.intoxication(id),
      mood: d?.mood ?? 0,
      custody: d?.custody ?? 'none',
      injured: d?.injured ?? 0,
      deceased: d?.deceased === true,
      missing: d?.missing === true,
    };
  }

  /** The explicit intoxication (decayed by the elimination rate since it was set) or the base session curve. */
  intoxication(id: number): Intoxication {
    checkPerson(id, 'intoxication');
    const now = this.nowFn();
    const set = this.deltas.get(id)?.intox;
    if (set) {
      const dt = Math.max(0, now - set.setAt);
      const bac = Math.max(0, set.bac - (PEOPLE_DATA.drinking.eliminationPerHour * dt) / 3600);
      const drugOn = set.drug !== 'none' && dt < DRUG_SET_H * 3600;
      if (bac > 0 || drugOn || dt < OVERRIDE_MIN_S) {
        return { bac, drug: drugOn ? set.drug : 'none', level: intoxicationLevel(bac, drugOn ? DRUG_SET_LEVEL : 0) };
      }
    }
    const ident = this.identity(id);
    return baseIntoxication(this.seed, id, now, ident.drinker, ident.drugUse);
  }

  setIntoxication(id: number, bac: number, drug: DrugKind): void {
    checkPerson(id, 'setIntoxication');
    const b = clamp(Number.isFinite(bac) ? bac : 0, 0, 0.6);
    const kind: DrugKind = DRUG_KINDS.includes(drug) ? drug : 'none';
    this.edit(id).intox = { bac: b, drug: kind, level: intoxicationLevel(b, kind === 'none' ? 0 : DRUG_SET_LEVEL), setAt: this.nowFn() };
  }

  /** Raises BAC to `minBac` (DUI-behaviour drivers) when it is lower now. */
  ensureIntoxicated(id: number, minBac: number): void {
    const cur = this.intoxication(id);
    if (cur.bac < minBac) this.setIntoxication(id, minBac, cur.drug);
  }

  /** Mood -1..1; 0 (the base) clears it. */
  setMood(id: number, mood: number): void {
    checkPerson(id, 'setMood');
    const v = clamp(Number.isFinite(mood) ? mood : 0, -1, 1);
    if (v === 0) this.clearField(id, (d) => d.mood !== undefined, (d) => void delete d.mood);
    else this.edit(id).mood = v;
  }

  /** `'none'` clears the custody. */
  setCustody(id: number, c: Custody): void {
    checkPerson(id, 'setCustody');
    if (!CUSTODIES.includes(c)) throw new RangeError(`setCustody: unknown custody "${String(c)}"`);
    if (c === 'none') {
      this.clearField(id, (d) => d.custody !== undefined, (d) => {
        delete d.custody;
        delete d.custodySince;
      });
      return;
    }
    const d = this.edit(id);
    d.custody = c;
    d.custodySince = this.nowFn();
  }

  /** Injury 0..1; 0 clears it. */
  setInjured(id: number, v: number): void {
    checkPerson(id, 'setInjured');
    const n = clamp(Number.isFinite(v) ? v : 0, 0, 1);
    if (n === 0) this.clearField(id, (d) => d.injured !== undefined, (d) => void delete d.injured);
    else this.edit(id).injured = n;
  }

  setDeceased(id: number): void {
    checkPerson(id, 'setDeceased');
    this.edit(id).deceased = true;
  }

  /** `false` clears the flag. */
  setMissing(id: number, missing: boolean): void {
    checkPerson(id, 'setMissing');
    if (missing) this.edit(id).missing = true;
    else this.clearField(id, (d) => d.missing !== undefined, (d) => void delete d.missing);
  }

  // --- Items ---------------------------------------------------------------------

  /** Base items minus the seized ones plus the added ones. */
  itemsOn(id: number): readonly CarriedItem[] {
    const base = this.identity(id).baseItems;
    const d = this.deltas.get(id);
    if (!d || (!d.seized && !d.added)) return base;
    return this.merge(base, d, 'person', id);
  }

  /**
   * Contents of registry vehicle `vehicleId` driven by `driverId` today: generated items minus the seized
   * ones plus the ones placed by scenarios. Fleet and unregistered vehicles are empty.
   */
  vehicleItems(vehicleId: number, driverId: number): readonly CarriedItem[] {
    if (!this.isRegistered(vehicleId)) return NO_ITEMS;
    const ident = this.identity(driverId);
    const base = baseVehicleItems(this.seed, vehicleId, epochDayOfGameSeconds(this.nowFn()), {
      id: driverId,
      drinker: ident.drinker,
      drugUse: ident.drugUse,
      intoxicated: this.intoxication(driverId).bac >= INTOXICATED_BAC,
      weaponCarrier: hasCarryNote(ident.record) || hasRegisteredHandgun(ident.record),
      risk: ident.risk,
    });
    const d = this.deltas.get(ownerOfVehicle(this.seed, vehicleId));
    if (!d || (!d.seized && !d.added)) return base;
    return this.merge(base, d, 'vehicle', vehicleId);
  }

  /** Places an item (scenarios): the owner is a person or a registry vehicle. */
  addItem(owner: ItemOwner, item: string, where: CarriedItem['where'], visible: boolean): CarriedItem {
    itemDef(item);
    if (!ITEM_WHERE.includes(where)) throw new RangeError(`addItem: unknown location "${String(where)}"`);
    const holder = this.holderOf(owner, 'addItem');
    const d = this.edit(holder);
    const prefix = `${owner.kind === 'person' ? 'p' : 'v'}${owner.id}:${item}:`;
    let n = ADDED_INSTANCE_BASE;
    for (const a of d.added ?? []) {
      if (a.instance.startsWith(prefix)) n = Math.max(n, Number(a.instance.slice(prefix.length)) + 1);
    }
    const list = (d.added ??= []);
    if (list.length >= ADDED_CAP) this.evictAdded(d);
    const entry = { instance: `${prefix}${n}`, item, owner: owner.kind, ownerId: owner.id, where, visible };
    list.push(entry);
    return { instance: entry.instance, item, where, visible };
  }

  /** Removes an item from its owner (evidence); false when the owner does not have it. */
  seize(owner: ItemOwner, instance: string): boolean {
    const holder = this.holderOf(owner, 'seize');
    const prefix = `${owner.kind === 'person' ? 'p' : 'v'}${owner.id}:`;
    if (!instance.startsWith(prefix)) return false;
    const present = owner.kind === 'person' ? this.itemsOn(owner.id) : this.vehicleItems(owner.id, driverOf(this.seed, owner.id));
    if (!present.some((i) => i.instance === instance)) return false;
    const d = this.edit(holder);
    const seized = (d.seized ??= []);
    if (!seized.includes(instance)) {
      seized.push(instance);
      if (seized.length > SEIZED_CAP) seized.splice(0, seized.length - SEIZED_CAP);
    }
    return true;
  }

  /** Driver first, then passengers of registry vehicle `vehicleId`; fleet ids give []. */
  occupantsOf(vehicleId: number): readonly number[] {
    return occupantsOfVehicle(this.seed, vehicleId);
  }

  // --- Contacts, statements, facts ------------------------------------------------

  officerHistory(id: number): OfficerHistory {
    checkPerson(id, 'officerHistory');
    return this.deltas.get(id)?.officer ?? NO_HISTORY;
  }

  /** A contact with the player officer: count + 1, last outcome and rapport + delta (clamped to -1..1). */
  recordContact(id: number, outcome: string, rapportDelta: number): void {
    checkPerson(id, 'recordContact');
    const d = this.edit(id);
    const h = d.officer ?? NO_HISTORY;
    d.officer = {
      count: h.count + 1,
      lastGame: this.nowFn(),
      lastOutcome: outcome,
      rapport: clamp(h.rapport + (Number.isFinite(rapportDelta) ? rapportDelta : 0), -1, 1),
    };
  }

  addStatement(id: number, s: Statement): void {
    checkPerson(id, 'addStatement');
    const d = this.edit(id);
    const list = (d.statements ??= []);
    list.push({ ...s });
    if (list.length > PER_PERSON_CAP) list.splice(0, list.length - PER_PERSON_CAP);
  }

  statements(id: number, incident?: string): readonly Statement[] {
    checkPerson(id, 'statements');
    const list = this.deltas.get(id)?.statements;
    if (!list) return NO_STATEMENTS;
    return incident === undefined ? list : list.filter((s) => s.incident === incident);
  }

  /** Stores a discovered fact and assigns its per-person id (never reused). */
  addFact(id: number, f: Omit<PersonFact, 'id'>): PersonFact {
    checkPerson(id, 'addFact');
    const d = this.edit(id);
    const fact: PersonFact = { ...f, id: d.nextFactId ?? 1 };
    d.nextFactId = fact.id + 1;
    const list = (d.facts ??= []);
    list.push(fact);
    if (list.length > PER_PERSON_CAP) list.splice(0, list.length - PER_PERSON_CAP);
    return fact;
  }

  facts(id: number, incident?: string): readonly PersonFact[] {
    checkPerson(id, 'facts');
    const list = this.deltas.get(id)?.facts;
    if (!list) return NO_FACTS;
    return incident === undefined ? list : list.filter((f) => f.incident === incident);
  }

  /** Remembers the false value the person gave for `fact` in `incident` (so the lie stays consistent). */
  rememberLie(id: number, incident: string, fact: string, value: string): void {
    checkPerson(id, 'rememberLie');
    const d = this.edit(id);
    const lies = (d.lies ??= []);
    const i = lies.findIndex((l) => l.incident === incident && l.fact === fact);
    if (i >= 0) lies[i] = { incident, fact, value };
    else lies.push({ incident, fact, value });
    if (lies.length > PER_PERSON_CAP) lies.splice(0, lies.length - PER_PERSON_CAP);
  }

  lieFor(id: number, incident: string, fact: string): string | null {
    checkPerson(id, 'lieFor');
    return this.deltas.get(id)?.lies?.find((l) => l.incident === incident && l.fact === fact)?.value ?? null;
  }

  setFlag(id: number, flag: string, on: boolean): void {
    checkPerson(id, 'setFlag');
    if (on) {
      const d = this.edit(id);
      const flags = (d.flags ??= []);
      if (!flags.includes(flag)) {
        flags.push(flag);
        if (flags.length > FLAGS_CAP) flags.splice(0, flags.length - FLAGS_CAP);
      }
    } else {
      this.clearField(id, (d) => d.flags?.includes(flag) === true, (d) => {
        d.flags = (d.flags ?? []).filter((f) => f !== flag);
        if (d.flags.length === 0) delete d.flags;
      });
    }
  }

  hasFlag(id: number, flag: string): boolean {
    checkPerson(id, 'hasFlag');
    return this.deltas.get(id)?.flags?.includes(flag) === true;
  }

  /** How many persons have a stored delta (the save size; capped at `PEOPLE_CAP` unless everyone is protected). */
  get touchedCount(): number {
    return this.deltas.size;
  }

  /** True when the person has a stored delta. */
  isTouched(id: number): boolean {
    return this.deltas.has(id);
  }

  // --- Persistence -----------------------------------------------------------------

  /** Deltas of touched persons, ascending id; expired explicit intoxications are dropped. */
  serialize(): PeopleSave {
    const now = this.nowFn();
    const persons: PersonDeltaSave[] = [];
    for (const d of this.deltas.values()) {
      const c = cloneDelta(d);
      if (c.intox && now - c.intox.setAt >= OVERRIDE_MIN_S && !this.intoxActive(c.intox, now)) delete c.intox;
      if (!isEmptyDelta(c)) persons.push(c);
    }
    persons.sort((a, b) => a.id - b.id);
    return { version: 1, identityVersion: 1, persons };
  }

  /** Replaces all state with `save`; malformed entries are dropped silently. */
  restore(save: PeopleSave): void {
    this.deltas.clear();
    this.cache.clear();
    this.rev++;
    if (!isPeopleSave(save)) return;
    for (const raw of save.persons) {
      const d = sanitizeDelta(raw, this.seed);
      if (d && !isEmptyDelta(d)) this.deltas.set(d.id, d);
    }
    if (this.deltas.size > PEOPLE_CAP) this.trim(-1);
  }

  // --- Internals -------------------------------------------------------------------

  private isRegistered(vehicleId: number): boolean {
    return Number.isInteger(vehicleId) && vehicleId >= 0 && vehicleId < REGISTRY_POPULATION;
  }

  /** The person whose delta stores items of `owner`. */
  private holderOf(owner: ItemOwner, what: string): number {
    if (owner.kind === 'person') {
      checkPerson(owner.id, what);
      return owner.id;
    }
    if (!this.isRegistered(owner.id)) throw new RangeError(`${what}: vehicle ${owner.id} is not a registry vehicle`);
    return ownerOfVehicle(this.seed, owner.id);
  }

  private intoxActive(set: NonNullable<PersonDeltaSave['intox']>, now: number): boolean {
    const dt = Math.max(0, now - set.setAt);
    return set.bac - (PEOPLE_DATA.drinking.eliminationPerHour * dt) / 3600 > 0 || (set.drug !== 'none' && dt < DRUG_SET_H * 3600);
  }

  private merge(base: readonly CarriedItem[], d: PersonDeltaSave, kind: 'person' | 'vehicle', ownerId: number): CarriedItem[] {
    const seized = d.seized;
    const out = seized ? base.filter((i) => !seized.includes(i.instance)) : base.slice();
    for (const a of d.added ?? []) {
      if (a.owner !== kind || a.ownerId !== ownerId || seized?.includes(a.instance)) continue;
      out.push({ instance: a.instance, item: a.item, where: a.where as CarriedItem['where'], visible: a.visible });
    }
    return out;
  }

  /** Drops the oldest seized added entry (else the oldest) to make room. */
  private evictAdded(d: PersonDeltaSave): void {
    const list = d.added;
    if (!list) return;
    let i = list.findIndex((a) => d.seized?.includes(a.instance));
    if (i < 0) i = 0;
    const [gone] = list.splice(i, 1);
    if (gone && d.seized) d.seized = d.seized.filter((s) => s !== gone.instance);
  }

  /** The (new) delta of `id`, stamped as touched now; bumps the revision. */
  private edit(id: number): PersonDeltaSave {
    let d = this.deltas.get(id);
    if (!d) {
      d = { id, touched: this.nowFn() };
      this.deltas.set(id, d);
      if (this.deltas.size > PEOPLE_CAP) this.trim(id);
    } else {
      d.touched = this.nowFn();
    }
    this.rev++;
    return d;
  }

  /** Clears one field when present (a no-op otherwise); removes the delta once it is empty. */
  private clearField(id: number, has: (d: PersonDeltaSave) => boolean, clear: (d: PersonDeltaSave) => void): void {
    const d = this.deltas.get(id);
    if (!d || !has(d)) return;
    clear(d);
    d.touched = this.nowFn();
    this.rev++;
    if (isEmptyDelta(d)) this.deltas.delete(id);
  }

  /** Retention rule: evict the least recently touched droppable persons (never `keep`) down to the cap minus a margin. */
  private trim(keep: number): void {
    const droppable = [...this.deltas.values()].filter((d) => d.id !== keep && !isProtected(d));
    droppable.sort((a, b) => a.touched - b.touched || a.id - b.id);
    const target = PEOPLE_CAP - TRIM;
    for (const d of droppable) {
      if (this.deltas.size <= target) break;
      this.deltas.delete(d.id);
    }
  }
}

// --- Validation ------------------------------------------------------------------

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/** Structural check of the save envelope: the version tags and a `persons` array (entries are validated one by one on restore). */
export function isPeopleSave(x: unknown): x is PeopleSave {
  return isObj(x) && x.version === 1 && x.identityVersion === 1 && Array.isArray(x.persons);
}

/** A save without any touched person (migrated v4 saves, new games). */
export function emptyPeopleSave(): PeopleSave {
  return { version: 1, identityVersion: 1, persons: [] };
}

function isStatement(x: unknown): x is Statement {
  return (
    isObj(x) && typeof x.incident === 'string' && typeof x.fact === 'string' && typeof x.value === 'string' && typeof x.text === 'string' &&
    isNum(x.game) && typeof x.truthful === 'boolean' && typeof x.confused === 'boolean'
  );
}

function isFact(x: unknown): x is PersonFact {
  return (
    isObj(x) && Number.isInteger(x.id) && typeof x.incident === 'string' && typeof x.topic === 'string' && typeof x.value === 'string' &&
    (FACT_SOURCES as readonly unknown[]).includes(x.source) && typeof x.display === 'string' && typeof x.detail === 'string' && isNum(x.game)
  );
}

function list<T>(x: unknown, ok: (v: unknown) => v is T, cap: number): T[] {
  return Array.isArray(x) ? (x as unknown[]).filter(ok).slice(-cap) : [];
}

/** A delta from untrusted data; null when its id is invalid. Malformed fields and entries are dropped. */
function sanitizeDelta(raw: unknown, seed: number): PersonDeltaSave | null {
  if (!isObj(raw) || typeof raw.id !== 'number' || !Number.isInteger(raw.id) || raw.id < 0 || raw.id >= PERSON_POPULATION) return null;
  const d: PersonDeltaSave = { id: raw.id, touched: isNum(raw.touched) ? raw.touched : 0 };
  const ix = raw.intox;
  if (isObj(ix) && isNum(ix.bac) && ix.bac >= 0 && isNum(ix.level) && isNum(ix.setAt) && (DRUG_KINDS as readonly unknown[]).includes(ix.drug)) {
    d.intox = { bac: ix.bac, drug: ix.drug as DrugKind, level: clamp(ix.level, 0, 1), setAt: ix.setAt };
  }
  if (isNum(raw.mood) && raw.mood !== 0) d.mood = clamp(raw.mood, -1, 1);
  if ((CUSTODIES as readonly unknown[]).includes(raw.custody) && raw.custody !== 'none') {
    d.custody = raw.custody as Custody;
    if (isNum(raw.custodySince)) d.custodySince = raw.custodySince;
  }
  if (isNum(raw.injured) && raw.injured > 0) d.injured = clamp(raw.injured, 0, 1);
  if (raw.deceased === true) d.deceased = true;
  if (raw.missing === true) d.missing = true;
  const seized = [...new Set(list(raw.seized, (v): v is string => typeof v === 'string' && INSTANCE_RE.test(v), SEIZED_CAP))];
  if (seized.length > 0) d.seized = seized;
  const added = list(
    raw.added,
    (v): v is NonNullable<PersonDeltaSave['added']>[number] => {
      if (!isObj(v) || typeof v.instance !== 'string' || typeof v.item !== 'string' || !isItemId(v.item)) return false;
      if ((v.owner !== 'person' && v.owner !== 'vehicle') || typeof v.ownerId !== 'number' || !Number.isInteger(v.ownerId)) return false;
      if (!(ITEM_WHERE as readonly unknown[]).includes(v.where) || typeof v.visible !== 'boolean') return false;
      const m = INSTANCE_RE.exec(v.instance);
      if (!m || m[1] !== (v.owner === 'person' ? 'p' : 'v') || Number(m[2]) !== v.ownerId || m[3] !== v.item) return false;
      if (v.owner === 'person') return v.ownerId === raw.id;
      return v.ownerId >= 0 && v.ownerId < REGISTRY_POPULATION && ownerOfVehicle(seed, v.ownerId) === raw.id;
    },
    ADDED_CAP,
  );
  if (added.length > 0) d.added = added;
  const o = raw.officer;
  if (isObj(o) && typeof o.count === 'number' && Number.isInteger(o.count) && o.count >= 0 && isNum(o.lastGame) && typeof o.lastOutcome === 'string' && isNum(o.rapport)) {
    d.officer = { count: o.count, lastGame: o.lastGame, lastOutcome: o.lastOutcome, rapport: clamp(o.rapport, -1, 1) };
  }
  const statements = list(raw.statements, isStatement, PER_PERSON_CAP);
  if (statements.length > 0) d.statements = statements;
  const facts = list(raw.facts, isFact, PER_PERSON_CAP);
  if (facts.length > 0) d.facts = facts;
  let next = isNum(raw.nextFactId) && Number.isInteger(raw.nextFactId) ? raw.nextFactId : 1;
  for (const f of facts) next = Math.max(next, f.id + 1);
  if (facts.length > 0 || next > 1) d.nextFactId = next;
  const lies = list(raw.lies, (v): v is { incident: string; fact: string; value: string } => isObj(v) && typeof v.incident === 'string' && typeof v.fact === 'string' && typeof v.value === 'string', PER_PERSON_CAP);
  if (lies.length > 0) d.lies = lies.map((l) => ({ incident: l.incident, fact: l.fact, value: l.value }));
  const flags = [...new Set(list(raw.flags, (v): v is string => typeof v === 'string', FLAGS_CAP))];
  if (flags.length > 0) d.flags = flags;
  return d;
}
