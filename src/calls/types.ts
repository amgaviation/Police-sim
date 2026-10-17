/**
 * Call catalog contracts (Phase 3 design §4.0, §6.2): the fixed id lists other modules validate
 * against, and the typed shapes of `src/data/calls/*.json`. Pure types and constants; no imports.
 */

// --- Fixed id lists (design §4.0) ---------------------------------------------------------------

/** Item ids; defined by `src/data/people/items.json`, listed here so calls can validate without importing people. */
export const ITEM_IDS = [
  'driversLicense', 'fakeId', 'wallet', 'phone', 'keys', 'cashRoll', 'openContainer', 'liquorBottle', 'cannabis',
  'narcotics', 'pills', 'syringe', 'pipe', 'knife', 'handgun', 'brassKnuckles', 'burglaryTools', 'stolenGoods',
  'sprayPaint', 'creditCards', 'backpack', 'suspiciousPackage', 'shellCasing', 'bloodEvidence', 'brokenGlass', 'threatNote',
] as const;
export type ItemId = (typeof ITEM_IDS)[number];

/** Items that are weapons (`weapon: true` in the people item table). */
export const WEAPON_ITEM_IDS: readonly string[] = ['knife', 'handgun', 'brassKnuckles'];

/** Items whose possession is a finding (a subset of the contraband / evidence items). */
export const CONTRABAND_ITEM_IDS: readonly string[] = [
  'cannabis', 'narcotics', 'pills', 'syringe', 'pipe', 'burglaryTools', 'stolenGoods', 'fakeId', 'creditCards',
];

/** Behaviour profile ids; defined by `src/data/npc/behaviors.json`. */
export const PROFILE_IDS = [
  'bystander', 'callerHelpful', 'callerUpset', 'victimDistraught', 'victimInjured', 'witnessReluctant', 'suspectCalm',
  'suspectNervous', 'suspectEvasive', 'suspectAgitated', 'suspectHostile', 'suspectArmedHostile', 'suspectFleeRisk',
  'subjectCrisis', 'subjectSuicidal', 'subjectIntoxicated', 'subjectConfused', 'subjectUnconscious', 'subjectDeceased',
  'juvenileScared', 'guardianWorried', 'protester', 'crowdMember', 'ambusher', 'barricaded', 'driverCooperative',
  'driverNervous', 'passenger', 'residentInnocent', 'securityGuard', 'animalDog', 'animalAggressiveDog',
] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];

/** Service stub kinds; defined by `src/data/calls/services.json`. */
export const SERVICE_KINDS = [
  'ems', 'fire', 'hazmat', 'swat', 'k9', 'coroner', 'interpreter', 'animalControl', 'bombSquad', 'tow', 'supervisor',
] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

export const VARIANT_KINDS = ['escalation', 'deescalation', 'false', 'duplicate', 'swatting', 'ambush'] as const;
export type VariantKind = (typeof VARIANT_KINDS)[number];

/** Where a participant stands relative to the scene anchor (placement is the scene module's `spots.ts`). */
export const SPOTS = ['door', 'curb', 'yard', 'street', 'roadside', 'vehicle', 'inside', 'hidden', 'crowd', 'distance'] as const;
export type Spot = (typeof SPOTS)[number];

export const ANCHORS = ['door', 'curb', 'street', 'intersection', 'lot', 'roadside', 'vehicle'] as const;
export type AnchorKind = (typeof ANCHORS)[number];

/** NPC command ids (defined by the npc module; `release` and `returnToVehicle` are internal and not listed). */
export const NPC_COMMAND_IDS = [
  'stop', 'handsUp', 'getDown', 'turnAround', 'comeHere', 'stayBack', 'followMe', 'sitDown', 'stepOut', 'dropWeapon',
  'showHands', 'leaveArea', 'disperse', 'calmDown', 'turnOffEngine', 'tossKeys', 'walkBackward',
] as const;
export type NpcCommandId = (typeof NPC_COMMAND_IDS)[number];

/** Drug kinds of an intoxication entry (defined by people). */
export const DRUG_KINDS = ['none', 'cannabis', 'stimulant', 'opioid', 'depressant'] as const;

/** Prop kinds (`PROP` names of the people renderer, design §12.1) an action may lay out. */
export const PROP_KINDS = ['cone', 'flare', 'tape', 'marker', 'bottle', 'bag', 'knife', 'handgun', 'package', 'casing', 'glass', 'note'] as const;

export const SERVICE_EFFECTS = [
  'none', 'transportInjured', 'resolveBarricade', 'revealHidden', 'removeDeceased', 'interpreter', 'secureAnimal', 'towVehicles',
] as const;
export type ServiceEffect = (typeof SERVICE_EFFECTS)[number];

export type Grade = 'good' | 'ok' | 'bad';
export const GRADES: readonly Grade[] = ['good', 'ok', 'bad'];

// --- Conditions -----------------------------------------------------------------------------------

/**
 * Condition over scene flags (design §4.2): a flag atom, `"true"`, a leading `"!"` negates an atom
 * (`"!custody:suspect"`), or `all` / `any` / `not`.
 */
export type Cond = string | { readonly all: readonly Cond[] } | { readonly any: readonly Cond[] } | { readonly not: Cond };

// --- Family / type definitions ----------------------------------------------------------------------

export interface PersonConstraint {
  readonly minAge?: number;
  readonly maxAge?: number;
  readonly warrant?: boolean;
  readonly mentalHealth?: boolean;
  readonly risk?: boolean;
  readonly sex?: 'M' | 'F';
}

export interface RoleIntoxication {
  readonly chance: number;
  readonly bac: readonly [number, number];
  readonly drug: string;
}

export interface RoleDef {
  readonly role: string;
  readonly count: readonly [number, number];
  readonly person: 'caller' | 'driver' | 'given' | PersonConstraint;
  readonly spot: Spot;
  readonly profile: string;
  readonly items: readonly { readonly item: string; readonly chance: number }[];
  readonly weapon: string | null;
  readonly intoxication: RoleIntoxication | null;
  /** Chance 0..1 that the participant is injured. */
  readonly injured: number;
  readonly deceased: boolean;
  readonly body: 'human' | 'dog';
  /** Vehicle role the person is associated with, null for none. */
  readonly vehicle: string | null;
}

export interface VehicleRoleDef {
  readonly role: string;
  readonly count: readonly [number, number];
  readonly mode: 'driving' | 'parked' | 'crashed';
  readonly behavior: 'normal' | 'dui';
  readonly reported: boolean;
  readonly flee: number;
}

export type RoleOverrides = Readonly<Record<string, Partial<RoleDef>>>;
export type VehicleOverrides = Readonly<Record<string, Partial<VehicleRoleDef>>>;

export interface BranchDef {
  readonly id: string;
  readonly weight: number;
  readonly flags: readonly string[];
  readonly remove: readonly string[];
  readonly roleOverrides: RoleOverrides;
  readonly vehicleOverrides: VehicleOverrides;
}

export interface ObjectiveDef {
  readonly text: string;
  readonly done: Cond;
  readonly show: Cond | null;
}

export interface OutcomeDef {
  readonly id: string;
  readonly when: Cond;
  readonly disposition: string;
  readonly grade: Grade;
}

export interface VariantChange {
  readonly narratives: readonly string[];
  readonly roleOverrides: RoleOverrides;
  readonly remove: readonly string[];
}

export interface GroundEvidenceDef {
  readonly item: string;
  readonly spot: Spot;
  readonly chance: number;
}

export interface FamilyDef {
  readonly id: string;
  readonly label: string;
  readonly anchor: string;
  readonly derived: boolean;
  readonly roles: readonly RoleDef[];
  readonly vehicles: readonly VehicleRoleDef[];
  readonly evidence: readonly GroundEvidenceDef[];
  readonly describe: string | null;
  readonly branches: readonly BranchDef[];
  readonly variants: Readonly<Record<VariantKind, number>>;
  readonly escalation: VariantChange | null;
  readonly deescalation: VariantChange | null;
  readonly actions: readonly string[];
  readonly objectives: readonly ObjectiveDef[];
  readonly outcomes: readonly OutcomeDef[];
}

export interface CallTypeDef {
  readonly id: string;
  readonly family: string;
  readonly label: string;
  readonly generated: boolean;
  readonly weight: number;
  readonly category: string;
  /** Per-branch weight overrides (missing = the family's weight; 0 disables). */
  readonly branchWeights: Readonly<Record<string, number>>;
  /** Variant multipliers replacing the family's (every kind filled in), null = the family's. */
  readonly variants: Readonly<Record<VariantKind, number>> | null;
}

// --- Actions, services, variants ---------------------------------------------------------------------

export interface ActionProps {
  readonly kind: string;
  readonly count: number;
  readonly pattern: 'line' | 'ring' | 'point';
  readonly spacing: number;
  readonly radius: number;
}

export interface ActionDef {
  readonly id: string;
  readonly label: string;
  readonly requires: Cond | null;
  readonly sets: readonly string[];
  readonly service: ServiceKind | null;
  readonly reveals: 'inside' | 'hidden' | null;
  /** Seconds the officer must stay near before the flags are set; 0 = immediate. */
  readonly durationS: number;
  readonly once: boolean;
  readonly consumes: Readonly<Record<string, number>>;
  readonly props: ActionProps | null;
  readonly narrative: string | null;
  readonly radio: string | null;
  readonly command: { readonly command: string; readonly roles: readonly string[] } | null;
  readonly opens: 'citation' | 'report' | null;
}

export interface ServiceDef {
  readonly id: ServiceKind;
  readonly label: string;
  readonly arriveS: readonly [number, number];
  readonly effect: ServiceEffect;
  readonly sets: readonly string[];
  readonly radio: string;
  readonly ack: string;
  readonly arrivedText: string;
}

/** `variants.json` as typed fields (design §4.2). */
export interface VariantConfig {
  readonly rates: Readonly<Record<VariantKind, number>>;
  readonly escalation: { readonly delayS: readonly [number, number]; readonly priorityDelta: number };
  readonly deescalation: { readonly delayS: readonly [number, number]; readonly priorityDelta: number };
  readonly duplicate: {
    readonly callers: readonly [number, number];
    readonly delayS: readonly [number, number];
    readonly linkedCallChance: number;
  };
  readonly ambush: { readonly triggerDistanceM: number; readonly delayS: readonly [number, number] };
  readonly dispatchErrors: {
    readonly wrongAddress: number;
    readonly wrongDescription: number;
    readonly missingWeapon: number;
    readonly addressShiftM: readonly [number, number];
    readonly correctionDelayS: readonly [number, number];
  };
}

export interface CallCatalog {
  readonly families: readonly FamilyDef[];
  readonly types: readonly CallTypeDef[];
  readonly actions: readonly ActionDef[];
  readonly services: readonly ServiceDef[];
  readonly variants: VariantConfig;
  /** Phase 2 call type id -> family id. */
  readonly legacy: Readonly<Record<string, string>>;
}

export interface CatalogInput {
  readonly families: unknown;
  readonly types: readonly { readonly file: string; readonly json: unknown }[];
  readonly actions: unknown;
  readonly services: unknown;
  readonly variants: unknown;
  readonly legacy: unknown;
}

export interface CatalogContext {
  readonly dispositions: readonly string[];
  readonly crimeCategories: readonly string[];
  readonly trunkItems: readonly string[];
}
