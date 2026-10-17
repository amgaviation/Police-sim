import itemsJson from '../data/people/items.json';
import peopleJson from '../data/people/people.json';
import {
  fail,
  readArray,
  readBoolean,
  readColor,
  readNumber,
  readObject,
  readOneOf,
  readString,
  readVersion,
  type JsonObject,
} from '../vehicles/json';
import { ITEM_CATEGORIES, type DrugKind, type ItemDef, type MentalCondition, type Temperament } from './types';

/**
 * Validated people tables (design §4.1). Every parser throws an Error naming the file and the
 * dotted field path, e.g. `people.json: honesty.min must be in [0, 1], got 2`.
 */

export interface Weighted<K extends string> {
  readonly key: K;
  readonly weight: number;
}

export interface PaletteEntry {
  readonly name: string;
  readonly color: number;
}

export interface PeopleData {
  readonly temperament: readonly Weighted<Temperament>[];
  readonly honesty: { readonly min: number; readonly max: number; readonly riskPenalty: number };
  readonly attitude: {
    readonly min: number;
    readonly max: number;
    readonly perPrior: number;
    readonly perArrestPrior: number;
    readonly gang: number;
    readonly minClamp: number;
    readonly maxClamp: number;
  };
  readonly language: {
    readonly englishShare: number;
    readonly others: readonly { readonly id: string; readonly label: string; readonly weight: number }[];
    readonly noEnglishShare: number;
  };
  readonly hearing: { readonly deaf: number; readonly hardOfHearing: number; readonly elderlyHardOfHearing: number; readonly elderlyAge: number };
  readonly dementia: { readonly minAge: number; readonly rate: number };
  readonly mental: {
    readonly withRecordNote: readonly Weighted<MentalCondition>[];
    readonly baseRate: number;
    readonly base: readonly Weighted<MentalCondition>[];
  };
  readonly health: {
    readonly diabetic: number;
    readonly epilepsy: number;
    readonly heart: { readonly rate: number; readonly minAge: number };
    readonly asthma: number;
  };
  readonly drinking: {
    readonly propensityExponent: number;
    /** Monday first. */
    readonly weekday: readonly number[];
    readonly sessionRate: number;
    readonly startHour: readonly [number, number];
    readonly durationH: readonly [number, number];
    readonly peakBac: readonly [number, number];
    readonly riseH: number;
    readonly eliminationPerHour: number;
  };
  readonly drugs: { readonly rate: number; readonly riskFactor: number; readonly kinds: readonly Weighted<DrugKind>[]; readonly dailyUseRate: number };
  readonly employment: {
    readonly employers: readonly string[];
    readonly unemployed: number;
    readonly retiredAge: number;
    readonly studentMaxAge: number;
    readonly studentShare: number;
  };
  readonly appearance: {
    readonly skinTones: readonly number[];
    /** Colour per `record.hair` name; null = bald. */
    readonly hair: ReadonlyMap<string, number | null>;
    readonly tops: readonly PaletteEntry[];
    readonly bottoms: readonly PaletteEntry[];
  };
  readonly items: {
    readonly daily: { readonly phone: number; readonly wallet: number; readonly keys: number; readonly cashRoll: number; readonly backpack: number };
    readonly driversLicenseCarry: number;
    readonly fakeIdIfRisk: number;
    readonly knife: number;
    readonly knifeIfSafetyNote: number;
    readonly handgunIfSafetyNote: number;
    readonly handgunIfRegistered: number;
    readonly brassKnucklesIfGang: number;
    readonly drugsIfUser: number;
    readonly paraphernaliaIfUser: number;
    readonly stolenGoodsIfRisk: number;
    readonly creditCardsIfRisk: number;
  };
  readonly vehicleItems: {
    readonly openContainerIfDrinking: number;
    readonly liquorBottleIfDrinker: number;
    readonly drugsIfUser: number;
    readonly weaponIfCarrier: number;
    readonly stolenGoods: number;
    readonly burglaryToolsIfRisk: number;
  };
  /** P(0..n passengers), cumulative-ready (sums to 1). */
  readonly occupants: { readonly passengers: readonly number[] };
  readonly family: { readonly clusterSize: number };
}

const FILE = 'people.json';
const ITEMS_FILE = 'items.json';

function prob(value: unknown, file: string, path: string): number {
  return readNumber(value, file, path, 0, 1);
}

function posInt(value: unknown, file: string, path: string, min: number, max: number): number {
  const n = readNumber(value, file, path, min, max);
  if (!Number.isInteger(n)) fail(file, path, `must be an integer, got ${n}`);
  return n;
}

function range(value: unknown, file: string, path: string, min: number, max: number): readonly [number, number] {
  const a = readArray(value, file, path);
  if (a.length !== 2) fail(file, path, `must be [min, max], got ${a.length} items`);
  const lo = readNumber(a[0], file, `${path}[0]`, min, max);
  const hi = readNumber(a[1], file, `${path}[1]`, min, max);
  if (lo > hi) fail(file, path, `must have min <= max, got [${lo}, ${hi}]`);
  return [lo, hi];
}

/** `{ key: weight }` in file order; keys restricted to `allowed`; at least one positive weight. */
function weights<K extends string>(value: unknown, allowed: readonly K[], file: string, path: string): Weighted<K>[] {
  const o = readObject(value, file, path);
  const out: Weighted<K>[] = [];
  let total = 0;
  for (const k of Object.keys(o)) {
    const key = readOneOf(k, allowed, file, `${path}.${k}`);
    const weight = readNumber(o[k], file, `${path}.${k}`, 0);
    total += weight;
    out.push({ key, weight });
  }
  if (out.length === 0 || total <= 0) fail(file, path, 'must have at least one positive weight');
  return out;
}

function palette(value: unknown, file: string, path: string): PaletteEntry[] {
  return readArray(value, file, path, 1).map((e, i) => {
    const o = readObject(e, file, `${path}[${i}]`);
    return { name: readString(o.name, file, `${path}[${i}].name`), color: readColor(o.hex, file, `${path}[${i}].hex`) };
  });
}

const TEMPERAMENTS: readonly Temperament[] = ['calm', 'timid', 'irritable', 'volatile'];
const MENTAL_RECORD: readonly MentalCondition[] = ['depression', 'bipolar', 'schizophrenia', 'ptsd'];
const MENTAL_BASE: readonly MentalCondition[] = ['anxiety', 'depression', 'bipolar', 'schizophrenia', 'ptsd'];
const DRUG_KINDS_USED: readonly DrugKind[] = ['cannabis', 'stimulant', 'opioid', 'depressant'];

export function parsePeopleData(json: unknown, file = FILE): PeopleData {
  const r = readObject(json, file, '');
  readVersion(r, file);
  const sub = (key: string): JsonObject => readObject(r[key], file, key);

  const honesty = sub('honesty');
  const hMin = prob(honesty.min, file, 'honesty.min');
  const hMax = prob(honesty.max, file, 'honesty.max');
  if (hMin > hMax) fail(file, 'honesty', `must have min <= max, got [${hMin}, ${hMax}]`);

  const att = sub('attitude');
  const aMin = readNumber(att.min, file, 'attitude.min', -1, 1);
  const aMax = readNumber(att.max, file, 'attitude.max', -1, 1);
  if (aMin > aMax) fail(file, 'attitude', `must have min <= max, got [${aMin}, ${aMax}]`);

  const lang = sub('language');
  const others = readArray(lang.others, file, 'language.others', 1).map((e, i) => {
    const o = readObject(e, file, `language.others[${i}]`);
    return {
      id: readString(o.id, file, `language.others[${i}].id`),
      label: readString(o.label, file, `language.others[${i}].label`),
      weight: readNumber(o.weight, file, `language.others[${i}].weight`, 0.0001),
    };
  });

  const hearing = sub('hearing');
  const dementia = sub('dementia');
  const mental = sub('mental');
  const health = sub('health');
  const heart = readObject(health.heart, file, 'health.heart');
  const drinking = sub('drinking');
  const weekday = readArray(drinking.weekday, file, 'drinking.weekday').map((v, i) => readNumber(v, file, `drinking.weekday[${i}]`, 0));
  if (weekday.length !== 7) fail(file, 'drinking.weekday', `must have 7 entries (Monday first), got ${weekday.length}`);
  const drugs = sub('drugs');
  const emp = sub('employment');
  const employers = readArray(emp.employers, file, 'employment.employers', 1).map((e, i) => readString(e, file, `employment.employers[${i}]`));
  const app = sub('appearance');
  const hairObj = readObject(app.hair, file, 'appearance.hair');
  const hair = new Map<string, number | null>();
  for (const k of Object.keys(hairObj)) hair.set(k, hairObj[k] === null ? null : readColor(hairObj[k], file, `appearance.hair.${k}`));
  if (hair.size === 0) fail(file, 'appearance.hair', 'must have at least one entry');
  const skinTones = readArray(app.skinTones, file, 'appearance.skinTones', 1).map((c, i) => readColor(c, file, `appearance.skinTones[${i}]`));

  const items = sub('items');
  const daily = readObject(items.daily, file, 'items.daily');
  const veh = sub('vehicleItems');
  const occ = sub('occupants');
  const passengers = readArray(occ.passengers, file, 'occupants.passengers', 1).map((p, i) => prob(p, file, `occupants.passengers[${i}]`));
  const psum = passengers.reduce((a, b) => a + b, 0);
  if (Math.abs(psum - 1) > 1e-6) fail(file, 'occupants.passengers', `must sum to 1, got ${psum}`);
  const family = sub('family');

  return {
    temperament: weights(r.temperament, TEMPERAMENTS, file, 'temperament'),
    honesty: { min: hMin, max: hMax, riskPenalty: readNumber(honesty.riskPenalty, file, 'honesty.riskPenalty', 0, 2) },
    attitude: {
      min: aMin,
      max: aMax,
      perPrior: readNumber(att.perPrior, file, 'attitude.perPrior', -1, 1),
      perArrestPrior: readNumber(att.perArrestPrior, file, 'attitude.perArrestPrior', -1, 1),
      gang: readNumber(att.gang, file, 'attitude.gang', -1, 1),
      minClamp: readNumber(att.minClamp, file, 'attitude.minClamp', -1, 1),
      maxClamp: readNumber(att.maxClamp, file, 'attitude.maxClamp', -1, 1),
    },
    language: {
      englishShare: prob(lang.englishShare, file, 'language.englishShare'),
      others,
      noEnglishShare: prob(lang.noEnglishShare, file, 'language.noEnglishShare'),
    },
    hearing: {
      deaf: prob(hearing.deaf, file, 'hearing.deaf'),
      hardOfHearing: prob(hearing.hardOfHearing, file, 'hearing.hardOfHearing'),
      elderlyHardOfHearing: prob(hearing.elderlyHardOfHearing, file, 'hearing.elderlyHardOfHearing'),
      elderlyAge: posInt(hearing.elderlyAge, file, 'hearing.elderlyAge', 18, 120),
    },
    dementia: { minAge: posInt(dementia.minAge, file, 'dementia.minAge', 18, 120), rate: prob(dementia.rate, file, 'dementia.rate') },
    mental: {
      withRecordNote: weights(mental.withRecordNote, MENTAL_RECORD, file, 'mental.withRecordNote'),
      baseRate: prob(mental.baseRate, file, 'mental.baseRate'),
      base: weights(mental.base, MENTAL_BASE, file, 'mental.base'),
    },
    health: {
      diabetic: prob(health.diabetic, file, 'health.diabetic'),
      epilepsy: prob(health.epilepsy, file, 'health.epilepsy'),
      heart: { rate: prob(heart.rate, file, 'health.heart.rate'), minAge: posInt(heart.minAge, file, 'health.heart.minAge', 0, 120) },
      asthma: prob(health.asthma, file, 'health.asthma'),
    },
    drinking: {
      propensityExponent: readNumber(drinking.propensityExponent, file, 'drinking.propensityExponent', 0.1, 10),
      weekday,
      sessionRate: prob(drinking.sessionRate, file, 'drinking.sessionRate'),
      startHour: range(drinking.startHour, file, 'drinking.startHour', 0, 24),
      durationH: range(drinking.durationH, file, 'drinking.durationH', 0.1, 24),
      peakBac: range(drinking.peakBac, file, 'drinking.peakBac', 0, 0.6),
      riseH: readNumber(drinking.riseH, file, 'drinking.riseH', 0.01, 12),
      eliminationPerHour: readNumber(drinking.eliminationPerHour, file, 'drinking.eliminationPerHour', 0.0001, 0.2),
    },
    drugs: {
      rate: prob(drugs.rate, file, 'drugs.rate'),
      riskFactor: readNumber(drugs.riskFactor, file, 'drugs.riskFactor', 0, 20),
      kinds: weights(drugs.kinds, DRUG_KINDS_USED, file, 'drugs.kinds'),
      dailyUseRate: prob(drugs.dailyUseRate, file, 'drugs.dailyUseRate'),
    },
    employment: {
      employers,
      unemployed: prob(emp.unemployed, file, 'employment.unemployed'),
      retiredAge: posInt(emp.retiredAge, file, 'employment.retiredAge', 40, 120),
      studentMaxAge: posInt(emp.studentMaxAge, file, 'employment.studentMaxAge', 10, 40),
      studentShare: prob(emp.studentShare, file, 'employment.studentShare'),
    },
    appearance: { skinTones, hair, tops: palette(app.tops, file, 'appearance.tops'), bottoms: palette(app.bottoms, file, 'appearance.bottoms') },
    items: {
      daily: {
        phone: prob(daily.phone, file, 'items.daily.phone'),
        wallet: prob(daily.wallet, file, 'items.daily.wallet'),
        keys: prob(daily.keys, file, 'items.daily.keys'),
        cashRoll: prob(daily.cashRoll, file, 'items.daily.cashRoll'),
        backpack: prob(daily.backpack, file, 'items.daily.backpack'),
      },
      driversLicenseCarry: prob(items.driversLicenseCarry, file, 'items.driversLicenseCarry'),
      fakeIdIfRisk: prob(items.fakeIdIfRisk, file, 'items.fakeIdIfRisk'),
      knife: prob(items.knife, file, 'items.knife'),
      knifeIfSafetyNote: prob(items.knifeIfSafetyNote, file, 'items.knifeIfSafetyNote'),
      handgunIfSafetyNote: prob(items.handgunIfSafetyNote, file, 'items.handgunIfSafetyNote'),
      handgunIfRegistered: prob(items.handgunIfRegistered, file, 'items.handgunIfRegistered'),
      brassKnucklesIfGang: prob(items.brassKnucklesIfGang, file, 'items.brassKnucklesIfGang'),
      drugsIfUser: prob(items.drugsIfUser, file, 'items.drugsIfUser'),
      paraphernaliaIfUser: prob(items.paraphernaliaIfUser, file, 'items.paraphernaliaIfUser'),
      stolenGoodsIfRisk: prob(items.stolenGoodsIfRisk, file, 'items.stolenGoodsIfRisk'),
      creditCardsIfRisk: prob(items.creditCardsIfRisk, file, 'items.creditCardsIfRisk'),
    },
    vehicleItems: {
      openContainerIfDrinking: prob(veh.openContainerIfDrinking, file, 'vehicleItems.openContainerIfDrinking'),
      liquorBottleIfDrinker: prob(veh.liquorBottleIfDrinker, file, 'vehicleItems.liquorBottleIfDrinker'),
      drugsIfUser: prob(veh.drugsIfUser, file, 'vehicleItems.drugsIfUser'),
      weaponIfCarrier: prob(veh.weaponIfCarrier, file, 'vehicleItems.weaponIfCarrier'),
      stolenGoods: prob(veh.stolenGoods, file, 'vehicleItems.stolenGoods'),
      burglaryToolsIfRisk: prob(veh.burglaryToolsIfRisk, file, 'vehicleItems.burglaryToolsIfRisk'),
    },
    occupants: { passengers },
    family: { clusterSize: posInt(family.clusterSize, file, 'family.clusterSize', 1, 50) },
  };
}

const STATUTE_RE = /^(TR|PC)-\d{3}$/;
const PROPS = ['cone', 'flare', 'tape', 'marker', 'bottle', 'bag', 'knife', 'handgun', 'package', 'casing', 'glass', 'note'] as const;

/** The 26 item ids other modules reference (design §4.0). */
export const ITEM_IDS = [
  'driversLicense', 'fakeId', 'wallet', 'phone', 'keys', 'cashRoll', 'openContainer', 'liquorBottle', 'cannabis', 'narcotics',
  'pills', 'syringe', 'pipe', 'knife', 'handgun', 'brassKnuckles', 'burglaryTools', 'stolenGoods', 'sprayPaint', 'creditCards',
  'backpack', 'suspiciousPackage', 'shellCasing', 'bloodEvidence', 'brokenGlass', 'threatNote',
] as const;

export function parseItems(json: unknown, file = ITEMS_FILE): ItemDef[] {
  const r = readObject(json, file, '');
  readVersion(r, file);
  const out: ItemDef[] = [];
  const seen = new Set<string>();
  readArray(r.items, file, 'items', 1).forEach((e, i) => {
    const p = `items[${i}]`;
    const o = readObject(e, file, p);
    const id = readString(o.id, file, `${p}.id`);
    if (seen.has(id)) fail(file, `${p}.id`, `duplicate item id ${id}`);
    seen.add(id);
    const odor = o.odor === null ? null : readOneOf(o.odor, ['alcohol', 'cannabis'] as const, file, `${p}.odor`);
    const statute = o.statute === null ? null : readString(o.statute, file, `${p}.statute`);
    if (statute !== null && !STATUTE_RE.test(statute)) fail(file, `${p}.statute`, `must look like TR-361 or PC-262, got "${statute}"`);
    const prop = o.prop === null ? null : readOneOf(o.prop, PROPS, file, `${p}.prop`);
    out.push({
      id,
      label: readString(o.label, file, `${p}.label`),
      category: readOneOf(o.category, ITEM_CATEGORIES, file, `${p}.category`),
      contraband: readBoolean(o.contraband, file, `${p}.contraband`),
      weapon: readBoolean(o.weapon, file, `${p}.weapon`),
      concealment: readNumber(o.concealment, file, `${p}.concealment`, 0, 1),
      odor,
      statute,
      prop,
      inVehicle: readBoolean(o.inVehicle, file, `${p}.inVehicle`),
    });
  });
  for (const id of ITEM_IDS) if (!seen.has(id)) fail(file, 'items', `is missing required item "${id}"`);
  return out;
}

export const PEOPLE_DATA: PeopleData = parsePeopleData(peopleJson);
export const ITEMS: readonly ItemDef[] = parseItems(itemsJson);
