import type { PersonRecord } from '../records/person';

/** People module types (design §5.4 / §5.5). Pure data: no THREE, no DOM. */

export type Temperament = 'calm' | 'timid' | 'irritable' | 'volatile';
export type DrugKind = 'none' | 'cannabis' | 'stimulant' | 'opioid' | 'depressant';
export type MentalCondition = 'none' | 'anxiety' | 'depression' | 'bipolar' | 'schizophrenia' | 'ptsd';
export type HealthCondition = 'diabetic' | 'epilepsy' | 'heart' | 'asthma';
export type Relation = 'parent' | 'child' | 'partner' | 'sibling' | 'relative';
export type Custody = 'none' | 'detained' | 'arrested' | 'jailed' | 'hospital' | 'released';

export const DRUG_KINDS: readonly DrugKind[] = ['none', 'cannabis', 'stimulant', 'opioid', 'depressant'];
export const CUSTODIES: readonly Custody[] = ['none', 'detained', 'arrested', 'jailed', 'hospital', 'released'];
export const ITEM_WHERE = ['pocket', 'waistband', 'bag', 'hand', 'cabin', 'underSeat', 'glovebox', 'trunk', 'ground'] as const;
export const FACT_SOURCES = ['claim', 'document', 'record', 'evidence', 'observation', 'booking'] as const;
export const ITEM_CATEGORIES = ['document', 'personal', 'alcohol', 'drugs', 'paraphernalia', 'weapon', 'tools', 'property', 'evidence'] as const;

/** A relative of a person; `relation` is the relative's role seen from the person (B is A's `parent`). */
export interface FamilyLink {
  readonly personId: number;
  readonly relation: Relation;
}

/** Colours are 0xRRGGBB (feed the humanoid renderer directly). */
export interface Appearance {
  readonly skin: number;
  /** Null when bald. */
  readonly hair: number | null;
  readonly top: number;
  readonly topName: string;
  readonly bottom: number;
  readonly bottomName: string;
  readonly heightM: number;
  readonly build: number;
}

export interface Intoxication {
  readonly bac: number;
  readonly drug: DrugKind;
  /** 0..1. */
  readonly level: number;
}

export interface CarriedItem {
  /** `"<p|v><ownerId>:<item>:<n>"`. */
  readonly instance: string;
  readonly item: string;
  readonly where: (typeof ITEM_WHERE)[number];
  readonly visible: boolean;
}

export interface NpcIdentity {
  readonly id: number;
  /** The Phase 2 CAD record (overlay applied) this identity was generated from. */
  readonly record: PersonRecord;
  readonly age: number;
  readonly juvenile: boolean;
  readonly elderly: boolean;
  readonly employer: string;
  readonly vehicleId: number;
  readonly family: readonly FamilyLink[];
  readonly guardianId: number;
  readonly temperament: Temperament;
  readonly honesty: number;
  readonly attitude: number;
  readonly risk: number;
  readonly language: { readonly id: string; readonly label: string; readonly english: 'fluent' | 'limited' | 'none' };
  readonly hearing: 'normal' | 'hardOfHearing' | 'deaf';
  readonly dementia: boolean;
  readonly mental: MentalCondition;
  readonly health: readonly HealthCondition[];
  readonly drinker: number;
  readonly drugUse: DrugKind;
  readonly wanted: boolean;
  readonly appearance: Appearance;
  readonly baseItems: readonly CarriedItem[];
}

/** One answer the person gave (statement log, per person per incident). `truthful` is hidden truth: never shown to the player. */
export interface Statement {
  readonly incident: string;
  readonly fact: string;
  readonly value: string;
  readonly text: string;
  readonly game: number;
  readonly truthful: boolean;
  readonly confused: boolean;
}

export type FactSource = (typeof FACT_SOURCES)[number];

/** Something the player has discovered about the person (inconsistency-engine input). */
export interface PersonFact {
  /** Unique per person, never reused. */
  readonly id: number;
  readonly incident: string;
  readonly topic: string;
  readonly value: string;
  readonly source: FactSource;
  readonly display: string;
  readonly detail: string;
  readonly game: number;
}

export interface OfficerHistory {
  readonly count: number;
  readonly lastGame: number;
  readonly lastOutcome: string;
  /** -1..1. */
  readonly rapport: number;
}

export interface NpcState {
  readonly intoxication: Intoxication;
  readonly mood: number;
  readonly custody: Custody;
  readonly injured: number;
  readonly deceased: boolean;
  readonly missing: boolean;
}

export type ItemOwner = { readonly kind: 'person'; readonly id: number } | { readonly kind: 'vehicle'; readonly id: number };

export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

export interface ItemDef {
  readonly id: string;
  readonly label: string;
  readonly category: ItemCategory;
  readonly contraband: boolean;
  readonly weapon: boolean;
  /** 0 obvious .. 1 well hidden. */
  readonly concealment: number;
  readonly odor: 'alcohol' | 'cannabis' | null;
  readonly statute: string | null;
  readonly prop: string | null;
  readonly inVehicle: boolean;
}

/** Persisted shape (frozen after Phase 3). Only touched persons are stored, as deltas over the deterministic base. */
export interface PersonDeltaSave {
  id: number;
  /** Game seconds of the last change. */
  touched: number;
  /** Explicit intoxication (decays from `setAt`). */
  intox?: { bac: number; drug: DrugKind; level: number; setAt: number };
  mood?: number;
  custody?: Custody;
  custodySince?: number;
  injured?: number;
  deceased?: boolean;
  missing?: boolean;
  /** Seized instance ids (person and vehicle-owned ids alike). */
  seized?: string[];
  added?: { instance: string; item: string; owner: 'person' | 'vehicle'; ownerId: number; where: string; visible: boolean }[];
  /** Contacts with the player officer. */
  officer?: OfficerHistory;
  /** Newest last, at most 100 per person. */
  statements?: Statement[];
  /** At most 100 per person. */
  facts?: PersonFact[];
  nextFactId?: number;
  lies?: { incident: string; fact: string; value: string }[];
  flags?: string[];
}

export interface PeopleSave {
  version: 1;
  identityVersion: 1;
  persons: PersonDeltaSave[];
}
