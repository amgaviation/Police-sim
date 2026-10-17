import { ageOn } from '../records/calendar';
import { unitHash } from '../records/hash';
import { vehicleOfOwner } from '../records/ids';
import type { PersonRecord } from '../records/person';
import type { NameIndex } from '../records/search';
import { PEOPLE_DATA, type Weighted } from './data';
import { familyOf, nameIndexFor, oldestParent } from './family';
import { baseItems } from './items';
import { SALT } from './salt';
import type { Appearance, DrugKind, HealthCondition, MentalCondition, NpcIdentity, Temperament } from './types';

export { SALT } from './salt';

/** Pure identity generation (design §5.1): the Phase 2 record plus hashed traits. */

export const EMPLOYER_RETIRED = 'Retired';
export const EMPLOYER_STUDENT = 'Student';
export const EMPLOYER_UNEMPLOYED = 'Unemployed';
const JUVENILE_AGE = 18;
const FALLBACK_HAIR = 0x4b3621;

function lerp(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function pickWeighted<K extends string>(list: readonly Weighted<K>[], u: number): K {
  let total = 0;
  for (const it of list) total += it.weight;
  let x = u * total;
  for (const it of list) {
    x -= it.weight;
    if (x < 0) return it.key;
  }
  const last = list[list.length - 1];
  if (!last) throw new RangeError('pickWeighted: empty list');
  return last.key;
}

function indexOf(u: number, n: number): number {
  return Math.min(n - 1, Math.floor(u * n));
}

/** Risk 0..1 from the record: warrants, arrest priors, gang membership and officer-safety notes. */
export function riskOf(record: PersonRecord): number {
  let arrests = 0;
  for (const p of record.priors) if (p.kind === 'arrest') arrests++;
  return Math.min(1, (record.warrants.length + arrests + (record.gang ? 2 : 0) + record.officerSafety.length) / 6);
}

/**
 * The in-world identity of person `id` on `epochDay`: a pure function of (seed, id, record, epochDay)
 * (`index` is the seed's name index, memoised when omitted). Every trait uses `unitHash` with its own salt;
 * daily traits (clothes, daily items) use `salt ^ epochDay`.
 */
export function generateIdentity(seed: number, id: number, record: PersonRecord, epochDay: number, index?: NameIndex): NpcIdentity {
  const d = PEOPLE_DATA;
  const u = (salt: number): number => unitHash(seed, salt, id);
  const age = ageOn(record.dob, epochDay);
  const juvenile = age < JUVENILE_AGE;
  const elderly = age >= d.hearing.elderlyAge;
  const risk = riskOf(record);
  const arrestPriors = record.priors.filter((p) => p.kind === 'arrest').length;

  // Employment.
  let employer: string;
  if (age >= d.employment.retiredAge) employer = EMPLOYER_RETIRED;
  else if (age <= d.employment.studentMaxAge && u(SALT.employer) < d.employment.studentShare) employer = EMPLOYER_STUDENT;
  else if (u(SALT.unemployed) < d.employment.unemployed) employer = EMPLOYER_UNEMPLOYED;
  else employer = d.employment.employers[indexOf(u(SALT.employerPick), d.employment.employers.length)] ?? EMPLOYER_UNEMPLOYED;

  const temperament: Temperament = pickWeighted(d.temperament, u(SALT.temperament));
  const honesty = clamp(lerp(d.honesty.min, d.honesty.max, u(SALT.honesty)) - risk * d.honesty.riskPenalty, 0, 1);
  const attitude = clamp(
    lerp(d.attitude.min, d.attitude.max, u(SALT.attitude)) +
      d.attitude.perPrior * record.priors.length +
      d.attitude.perArrestPrior * arrestPriors +
      (record.gang ? d.attitude.gang : 0),
    d.attitude.minClamp,
    d.attitude.maxClamp,
  );

  // Language.
  let language: NpcIdentity['language'];
  if (u(SALT.language) < d.language.englishShare) {
    language = { id: 'english', label: 'English', english: 'fluent' };
  } else {
    const others = d.language.others;
    let total = 0;
    for (const o of others) total += o.weight;
    let x = u(SALT.languagePick) * total;
    let pick = others[others.length - 1];
    for (const o of others) {
      x -= o.weight;
      if (x < 0) {
        pick = o;
        break;
      }
    }
    language = {
      id: pick?.id ?? 'spanish',
      label: pick?.label ?? 'Spanish',
      english: u(SALT.languageLevel) < d.language.noEnglishShare ? 'none' : 'limited',
    };
  }

  // Hearing, dementia, mental and physical health.
  const uh = u(SALT.hearing);
  const hearing: NpcIdentity['hearing'] =
    uh < d.hearing.deaf ? 'deaf' : uh < d.hearing.deaf + (elderly ? d.hearing.elderlyHardOfHearing : d.hearing.hardOfHearing) ? 'hardOfHearing' : 'normal';
  const dementia = age >= d.dementia.minAge && u(SALT.dementia) < d.dementia.rate;
  let mental: MentalCondition = 'none';
  if (record.mentalHealth !== null) mental = pickWeighted(d.mental.withRecordNote, u(SALT.mentalKind));
  else if (u(SALT.mentalHas) < d.mental.baseRate) mental = pickWeighted(d.mental.base, u(SALT.mentalKind));
  const health: HealthCondition[] = [];
  if (u(SALT.healthDiabetic) < d.health.diabetic) health.push('diabetic');
  if (u(SALT.healthEpilepsy) < d.health.epilepsy) health.push('epilepsy');
  if (age >= d.health.heart.minAge && u(SALT.healthHeart) < d.health.heart.rate) health.push('heart');
  if (u(SALT.healthAsthma) < d.health.asthma) health.push('asthma');

  // Substances.
  const drinker = u(SALT.drinker) ** d.drinking.propensityExponent;
  const drugUse: DrugKind = u(SALT.drugUse) < d.drugs.rate * (1 + risk * d.drugs.riskFactor) ? pickWeighted(d.drugs.kinds, u(SALT.drugKind)) : 'none';

  // Appearance.
  const a = d.appearance;
  const top = a.tops[indexOf(unitHash(seed, SALT.top ^ epochDay, id), a.tops.length)];
  const bottom = a.bottoms[indexOf(unitHash(seed, SALT.bottom ^ epochDay, id), a.bottoms.length)];
  const hairColor = a.hair.get(record.hair);
  const heightM = record.heightCm / 100;
  const bmi = record.weightKg / (heightM * heightM);
  const appearance: Appearance = {
    skin: a.skinTones[indexOf(u(SALT.skin), a.skinTones.length)] ?? 0xc68642,
    hair: hairColor === undefined ? FALLBACK_HAIR : hairColor,
    top: top?.color ?? 0x7a7a7a,
    topName: top?.name ?? 'gray',
    bottom: bottom?.color ?? 0x5f6266,
    bottomName: bottom?.name ?? 'gray pants',
    heightM,
    build: clamp(0.85 + (bmi - 18) * 0.03, 0.85, 1.25),
  };

  const family = familyOf(seed, id, index ?? nameIndexFor(seed));
  return {
    id,
    record,
    age,
    juvenile,
    elderly,
    employer,
    vehicleId: vehicleOfOwner(seed, id),
    family,
    guardianId: juvenile ? oldestParent(seed, family) : -1,
    temperament,
    honesty,
    attitude,
    risk,
    language,
    hearing,
    dementia,
    mental,
    health,
    drinker,
    drugUse,
    wanted: record.warrants.length > 0,
    appearance,
    baseItems: baseItems(seed, id, record, { risk, drugUse }, epochDay),
  };
}

export interface PersonDescription {
  readonly sex: 'M' | 'F';
  /** "in their 30s". */
  readonly ageBand: string;
  /** "black shirt". */
  readonly top: string;
  /** "blue jeans". */
  readonly bottom: string;
  /** "brown hair" or "bald". */
  readonly hair: string;
  /** "5 foot 10". */
  readonly heightText: string;
}

/** Radio-style description of a person (sex, age band, clothes, hair, height). */
export function describePerson(identity: NpcIdentity): PersonDescription {
  const decade = Math.floor(identity.age / 10) * 10;
  const inches = Math.round(identity.record.heightCm / 2.54);
  return {
    sex: identity.record.sex,
    ageBand: decade < 20 ? 'in their teens' : `in their ${decade}s`,
    top: `${identity.appearance.topName} shirt`,
    bottom: identity.appearance.bottomName,
    hair: identity.record.hair === 'bald' ? 'bald' : `${identity.record.hair} hair`,
    heightText: `${Math.floor(inches / 12)} foot ${inches % 12}`,
  };
}
