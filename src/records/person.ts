import { createRng, type Rng } from '../core/rng';
import { CALENDAR, epochDayFromYmd } from './calendar';
import { CALENDAR_DATA, NAMES, PERSON_DATA, VIN_ALPHABET, type PriorKind } from './data';
import { hash3 } from './hash';
import { PERSON_POPULATION, dlNumberOf } from './ids';

/**
 * Person records (design §5.2). Identity (name, sex, DOB) is pure integer hashing so the name
 * index stays cheap; everything else is drawn from `createRng(seed).stream('records:person:<id>')`
 * in a fixed, append-only order (see `generatePerson`).
 */

export interface PersonIdentity {
  readonly id: number;
  readonly first: string;
  readonly middle: string;
  readonly last: string;
  readonly sex: 'M' | 'F';
  /** Epoch day. */
  readonly dob: number;
}

export type LicenseStatus = 'valid' | 'suspended' | 'revoked' | 'expired' | 'none';

export interface Warrant {
  readonly id: string;
  readonly kind: string;
  readonly offense: string;
  readonly bail: number;
  readonly court: string;
  /** Epoch day. */
  readonly issued: number;
}

export interface PriorContact {
  /** Epoch day. */
  readonly day: number;
  readonly kind: string;
  readonly location: string;
  readonly summary: string;
  /** Document id for contacts from this game ('' for generated history). */
  readonly ref: string;
}

export interface PersonRecord extends PersonIdentity {
  readonly heightCm: number;
  readonly weightKg: number;
  readonly eyes: string;
  readonly hair: string;
  readonly address: string;
  readonly phone: string;
  /** `number` and `cls` are '' and `expires` 0 when `status` is 'none'. */
  readonly license: { readonly number: string; readonly cls: string; readonly status: LicenseStatus; readonly expires: number };
  readonly warrants: readonly Warrant[];
  /** `agent` '' and `until` 0 when `kind` is 'none'. */
  readonly supervision: {
    readonly kind: 'none' | 'probation' | 'parole';
    readonly agent: string;
    readonly until: number;
    readonly conditions: readonly string[];
  };
  readonly gang: { readonly name: string; readonly role: 'member' | 'associate' } | null;
  readonly mentalHealth: string | null;
  readonly officerSafety: readonly string[];
  readonly firearms: readonly { readonly type: string; readonly serial: string; readonly registered: number }[];
  /** As the restrained party. */
  readonly protectiveOrders: readonly { readonly protectedId: number; readonly conditions: readonly string[]; readonly expires: number }[];
  /** Newest first. */
  readonly priors: readonly PriorContact[];
}

/** Generation never depends on `today` (records must not change from day to day); only ages, summaries and BOLO day use it. */
export interface RecordsContext {
  readonly homeEdges: readonly number[];
  formatAddress(edge: number, t: number): string;
  /** Epoch day. */
  today(): number;
}

/** A context without a city: no home addresses or prior locations (the other draws are unaffected). */
export const DETACHED_CONTEXT: RecordsContext = {
  homeEdges: [],
  formatAddress: () => '',
  today: () => CALENDAR.startEpochDay,
};

export const NO_FIXED_ADDRESS = 'NO FIXED ADDRESS';

const SALT = { sex: 0x5045_0001, first: 0x5045_0002, middle: 0x5045_0003, last: 0x5045_0004, band: 0x5045_0005, age: 0x5045_0006, dayOffset: 0x5045_0007 } as const;
const TWO_POW_32 = 4294967296;
/** Most people are 20..60 (this share), the rest spread over the whole age range. */
const CORE_AGE_SHARE = 0.75;
const CORE_AGE: readonly [number, number] = [20, 60];
const DAYS_16_YEARS = 5844;

function checkId(id: number, what: string): void {
  if (!Number.isInteger(id) || id < 0 || id >= PERSON_POPULATION) {
    throw new RangeError(`${what}: id ${id} outside [0, ${PERSON_POPULATION})`);
  }
}

/** Index into `NAMES.last` of person `id` (the name index buckets by it). */
export function lastNameIndex(seed: number, id: number): number {
  return hash3(seed, SALT.last, id) % NAMES.last.length;
}

/** Sex, names and DOB of person `id` by integer hashing only (cheap; no RNG stream). */
export function personIdentity(seed: number, id: number): PersonIdentity {
  checkId(id, 'personIdentity');
  const sex = (hash3(seed, SALT.sex, id) & 1) === 1 ? 'F' : 'M';
  const firstList = sex === 'M' ? NAMES.male : NAMES.female;
  const first = firstList[hash3(seed, SALT.first, id) % firstList.length] ?? '';
  const middle = NAMES.middleInitials.charAt(hash3(seed, SALT.middle, id) % NAMES.middleInitials.length);
  const last = NAMES.last[lastNameIndex(seed, id)] ?? '';
  const [lo, hi] = PERSON_DATA.ageRange;
  const core = hash3(seed, SALT.band, id) / TWO_POW_32 < CORE_AGE_SHARE;
  const a = core ? Math.max(lo, CORE_AGE[0]) : lo;
  const b = core ? Math.min(hi, CORE_AGE[1]) : hi;
  const age = a + Math.floor((hash3(seed, SALT.age, id) / TWO_POW_32) * (b - a + 1));
  // Born `age` years before the start date minus 0..364 days: exactly `age` on game day 0.
  const dob = epochDayFromYmd(CALENDAR_DATA.y - age, CALENDAR_DATA.m, CALENDAR_DATA.d) - (hash3(seed, SALT.dayOffset, id) % 365);
  return { id, first, middle, last, sex, dob };
}

function pickWeighted<T extends { readonly weight: number }>(items: readonly T[], u: number): T {
  let total = 0;
  for (const it of items) total += it.weight;
  let x = u * total;
  for (const it of items) {
    x -= it.weight;
    if (x < 0) return it;
  }
  const last = items[items.length - 1];
  if (!last) throw new RangeError('pickWeighted: empty list');
  return last;
}

/** The class with the highest weight (first on ties). */
function mostCommonClass(classes: readonly { readonly cls: string; readonly weight: number }[]): string {
  let best = classes[0];
  for (const c of classes) if (best === undefined || c.weight > best.weight) best = c;
  return best?.cls ?? '';
}

function at<T>(list: readonly T[], u: number): T {
  const v = list[Math.min(list.length - 1, Math.floor(u * list.length))];
  if (v === undefined) throw new RangeError('at: empty list');
  return v;
}

/** One draw: a non-empty subset of `list` (in list order) from a bitmask. */
function subset(rng: Rng, list: readonly string[]): string[] {
  const mask = rng.nextInt(1, 2 ** list.length - 1);
  return list.filter((_, i) => (mask & (1 << i)) !== 0);
}

function vinChars(n: number, count: number): string {
  let s = '';
  for (let i = 0; i < count; i++) {
    s = VIN_ALPHABET.charAt(n % VIN_ALPHABET.length) + s;
    n = Math.floor(n / VIN_ALPHABET.length);
  }
  return s;
}

/** Address text for draws (uEdge, uT); '' without home edges. */
function addressFrom(ctx: RecordsContext, uEdge: number, uT: number): string {
  if (ctx.homeEdges.length === 0) return '';
  return ctx.formatAddress(at(ctx.homeEdges, uEdge), 0.1 + 0.8 * uT);
}

/**
 * Full person record. Draws from `'records:person:<id>'`, in this FIXED, APPEND-ONLY order (every
 * group always consumes the same number of draws, whatever the outcome or context, so adding a
 * field later must append draws at the end):
 *  1 physical: height, weight, eyes, hair (4)
 *  2 address: edge, t (2)
 *  3 phone (1)
 *  4 risk u -> r = u^exponent, rate factor 0.25 + 3r (1)
 *  5 license: status, class, expiry (3)
 *  6 warrants: has, count, then `max` x (kind, bail, court, issued) (2 + 4 max)
 *  7 supervision: kind, agent initial, agent last name, until, conditions mask (5)
 *  8 gang: has, name, role (3)
 *  9 mental health: has, note (2)
 * 10 officer safety: has, notes mask (2)
 * 11 firearms: has, count, then `max` x (type, serial hi, serial lo, registered) (2 + 4 max)
 * 12 protective order: has, protected person, conditions mask, expiry (4)
 * 13 priors: count, then `max` x (day, kind, location edge, location t, summary) (1 + 5 max)
 * Outcomes are then made consistent without extra draws: warrant kinds that `require` a
 * supervision kind are only resolved for such a person; a supervised person has at least one
 * prior of `supervision.priorKind`; no firearms below `firearms.minAge`; licence classes below
 * their `classMinAge` fall back to the most common class; an expired licence expired after 16.
 */
export function generatePerson(seed: number, id: number, ctx: RecordsContext): PersonRecord {
  const identity = personIdentity(seed, id);
  const rng = createRng(seed).stream(`records:person:${id}`);
  const d = PERSON_DATA;
  const start = CALENDAR.startEpochDay;
  const adultFrom = Math.min(start - 1, identity.dob + DAYS_16_YEARS);
  // Age in whole years on game day 0 (the DOB is `age` years and 0..364 days before it).
  const ageYears = Math.floor((start - identity.dob) / 365.25);
  const pastDay = (daysAgo: number): number => Math.max(start - daysAgo, adultFrom);

  // 1 physical
  const sexKey = identity.sex;
  const heightCm = rng.nextInt(d.physical.heightCm[sexKey][0], d.physical.heightCm[sexKey][1]);
  const weightKg = rng.nextInt(d.physical.weightKg[sexKey][0], d.physical.weightKg[sexKey][1]);
  const eyes = rng.pick(d.physical.eyes);
  const hair = rng.pick(d.physical.hair);

  // 2 address
  const homeEdge = rng.next();
  const homeT = rng.next();
  const address = ctx.homeEdges.length === 0 ? NO_FIXED_ADDRESS : addressFrom(ctx, homeEdge, homeT);

  // 3 phone
  const phone = `${d.phonePrefix}-${String(rng.nextInt(0, 9999)).padStart(4, '0')}`;

  // 4 risk
  const risk = rng.next() ** d.risk.exponent;
  const rf = 0.25 + 3 * risk;

  // 5 license
  const uStatus = rng.next();
  const uClass = rng.next();
  const uExpiry = rng.next();
  const lic = d.license;
  const cuts = [lic.none, lic.suspended * rf, lic.revoked * rf, lic.expired];
  const statuses: readonly LicenseStatus[] = ['none', 'suspended', 'revoked', 'expired'];
  let status: LicenseStatus = 'valid';
  let acc = 0;
  for (let i = 0; i < cuts.length; i++) {
    acc += cuts[i] ?? 0;
    if (uStatus < acc) {
      status = statuses[i] ?? 'valid';
      break;
    }
  }
  // An expired licence expired after the holder could first be licensed (16); someone too young for that holds a valid one.
  const licensedFrom = identity.dob + DAYS_16_YEARS + 1;
  if (status === 'expired' && licensedFrom > start - 1) status = 'valid';
  let cls = pickWeighted(lic.classes, uClass).cls;
  if (ageYears < (lic.classMinAge[cls] ?? 0)) cls = mostCommonClass(lic.classes);
  const license =
    status === 'none'
      ? { number: '', cls: '', status, expires: 0 }
      : {
          number: dlNumberOf(seed, id),
          cls,
          status,
          expires: status === 'expired' ? Math.max(licensedFrom, start - 1 - Math.floor(uExpiry * 900)) : start + 30 + Math.floor(uExpiry * 1471),
        };

  // 6 warrants (drawn now, resolved after supervision: some kinds require a supervision kind)
  const w = d.warrants;
  const hasWarrant = rng.next() < w.rate * rf;
  const warrantCount = 1 + Math.floor(rng.next() ** 2 * w.max);
  const warrantDraws: { uKind: number; uBail: number; court: string; issuedAgo: number }[] = [];
  for (let k = 0; k < w.max; k++) {
    const uKind = rng.next();
    const uBail = rng.next();
    const court = at(w.courts, rng.next());
    const issuedAgo = rng.nextInt(1, 1500);
    if (hasWarrant && k < warrantCount) warrantDraws.push({ uKind, uBail, court, issuedAgo });
  }

  // 7 supervision
  const s = d.supervision;
  const uSup = rng.next();
  const agentInitial = NAMES.middleInitials.charAt(Math.floor(rng.next() * NAMES.middleInitials.length));
  const agentLast = at(NAMES.last, rng.next());
  const supUntil = start + rng.nextInt(30, 900);
  const supConditions = subset(rng, s.conditions);
  const supKind = uSup < s.probation * rf ? 'probation' : uSup < (s.probation + s.parole) * rf ? 'parole' : 'none';
  const eligibleKinds = w.kinds.filter((k) => k.requires === null || k.requires === supKind);
  const warrants: Warrant[] = warrantDraws.map((wd, k) => {
    const kind = pickWeighted(eligibleKinds, wd.uKind);
    return {
      id: `W${id}-${k + 1}`,
      kind: kind.kind,
      offense: kind.label,
      bail: Math.round((kind.bail[0] + wd.uBail * (kind.bail[1] - kind.bail[0])) / 50) * 50,
      court: wd.court,
      issued: pastDay(wd.issuedAgo),
    };
  });
  const supervision: PersonRecord['supervision'] =
    supKind === 'none'
      ? { kind: supKind, agent: '', until: 0, conditions: [] }
      : { kind: supKind, agent: `Agent ${agentInitial}. ${agentLast}`, until: supUntil, conditions: supConditions };

  // 8 gang
  const hasGang = rng.next() < d.gang.rate * rf;
  const gangName = at(d.gang.names, rng.next());
  const gangRole = rng.next() < d.gang.associateShare ? 'associate' : 'member';
  const gang = hasGang ? { name: gangName, role: gangRole } as const : null;

  // 9 mental health
  const hasMh = rng.next() < d.mentalHealth.rate;
  const mhNote = at(d.mentalHealth.notes, rng.next());

  // 10 officer safety
  const hasOs = rng.next() < d.officerSafety.rate * rf;
  const osNotes = subset(rng, d.officerSafety.notes);

  // 11 firearms
  const f = d.firearms;
  const hasFirearms = rng.next() < f.rate;
  const firearmCount = 1 + Math.floor(rng.next() ** 2 * f.max);
  const firearms: { type: string; serial: string; registered: number }[] = [];
  for (let k = 0; k < f.max; k++) {
    const type = at(f.types, rng.next());
    const hi = rng.nextInt(0, VIN_ALPHABET.length ** 4 - 1);
    const lo = rng.nextInt(0, VIN_ALPHABET.length ** 3 - 1);
    const regAgo = rng.nextInt(1, 5000);
    if (hasFirearms && k < firearmCount && ageYears >= f.minAge) {
      firearms.push({ type, serial: `F${vinChars(hi, 4)}${vinChars(lo, 3)}`, registered: pastDay(regAgo) });
    }
  }

  // 12 protective order
  const hasOrder = rng.next() < d.protectiveOrders.rate * rf;
  const protectedRaw = rng.nextInt(0, PERSON_POPULATION - 2);
  const orderConditions = subset(rng, d.protectiveOrders.conditions);
  const orderExpires = start + rng.nextInt(30, 700);
  const protectiveOrders = hasOrder
    ? [{ protectedId: protectedRaw >= id ? protectedRaw + 1 : protectedRaw, conditions: orderConditions, expires: orderExpires }]
    : [];

  // 13 priors
  const p = d.priors;
  let priorCount = Math.min(p.max, Math.floor(rng.next() * (2 * p.mean * rf + 1)));
  const priorDraws: { ago: number; kind: PriorKind; uEdge: number; uT: number; uSummary: number }[] = [];
  for (let k = 0; k < p.max; k++) {
    const ago = rng.nextInt(1, 3000);
    const kind = pickWeighted(p.kinds, rng.next());
    const uEdge = rng.next();
    const uT = rng.next();
    const uSummary = rng.next();
    priorDraws.push({ ago, kind, uEdge, uT, uSummary });
  }
  // Probation or parole implies a conviction: a supervised person has at least one prior of `s.priorKind`.
  if (supKind !== 'none' && p.max > 0 && !priorDraws.slice(0, priorCount).some((x) => x.kind.kind === s.priorKind)) {
    priorCount = Math.max(1, priorCount);
    const first = priorDraws[0];
    const conviction = p.kinds.find((k) => k.kind === s.priorKind);
    if (first && conviction) first.kind = conviction;
  }
  const priors: PriorContact[] = [];
  for (let k = 0; k < priorCount; k++) {
    const x = priorDraws[k];
    if (!x) break;
    priors.push({ day: pastDay(x.ago), kind: x.kind.kind, location: addressFrom(ctx, x.uEdge, x.uT), summary: at(x.kind.summaries, x.uSummary), ref: '' });
  }
  priors.sort((a, b) => b.day - a.day);

  return {
    ...identity,
    heightCm,
    weightKg,
    eyes,
    hair,
    address,
    phone,
    license,
    warrants,
    supervision,
    gang,
    mentalHealth: hasMh ? mhNote : null,
    officerSafety: hasOs ? osNotes : [],
    firearms,
    protectiveOrders,
    priors,
  };
}

/** True when the generated record of person `id` has at least one warrant (ignores served warrants). */
export function hasGeneratedWarrant(seed: number, id: number): boolean {
  return generatePerson(seed, id, DETACHED_CONTEXT).warrants.length > 0;
}

/** "SMITH, JOHN A". */
export function displayName(p: { readonly first: string; readonly middle: string; readonly last: string }): string {
  return `${p.last}, ${p.first}${p.middle === '' ? '' : ` ${p.middle}`}`.toUpperCase();
}
