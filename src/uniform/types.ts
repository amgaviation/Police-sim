/**
 * Uniform, outfit and character types (design Phase 7 §4.1, §7). Pure data: no DOM, no THREE.
 */

export const UNIFORM_CLASSES = ['classA', 'classB', 'tactical', 'bike', 'motor', 'swat', 'detective'] as const;
export type UniformClass = (typeof UNIFORM_CLASSES)[number];

export const HAT_IDS = [
  'none',
  'peakedCap',
  'campaign',
  'ballCap',
  'beanie',
  'motorHelmet',
  'bikeHelmet',
  'tacticalHelmet',
  'watchCap',
] as const;
export type HatId = (typeof HAT_IDS)[number];

export const CARRIER_IDS = ['none', 'internal', 'external', 'plateCarrier'] as const;
export type CarrierId = (typeof CARRIER_IDS)[number];

export const COLD_IDS = ['none', 'jacket', 'parka', 'rainShell'] as const;
export type ColdId = (typeof COLD_IDS)[number];

export const HAIR_STYLES = ['bald', 'buzz', 'short', 'medium', 'long', 'bun', 'ponytail', 'braids'] as const;
export type HairStyle = (typeof HAIR_STYLES)[number];

export const RANK_IDS = ['officer', 'corporal', 'sergeant', 'lieutenant', 'captain', 'chief'] as const;
export type RankId = (typeof RANK_IDS)[number];

/** Body part frame an accessory box is attached to (PeopleRenderer part order). */
export const ATTACH = {
  torso: 0,
  head: 1,
  leftArm: 2,
  rightArm: 3,
  pelvis: 4,
  leftThigh: 5,
  rightThigh: 6,
  leftShin: 7,
  rightShin: 8,
} as const;
export type AttachId = (typeof ATTACH)[keyof typeof ATTACH];

/** One coloured box in a part frame of the 1.75 m reference figure (centre x, y, z; size sx, sy, sz; metres). */
export interface AccessoryBox {
  attach: AttachId;
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  /** 0xRRGGBB. */
  color: number;
}

/** `OutfitDef.shins` sentinel: draw bare shins (the figure's skin colour). */
export const SKIN_SHINS = 0x1000000;
/** Most boxes one outfit may hold (`buildOutfit` throws above this). */
export const MAX_OUTFIT_BOXES = 24;

export interface OutfitDef {
  id: string;
  /** Shirt colour (0xRRGGBB). */
  top: number;
  /** Trouser colour (0xRRGGBB). */
  bottom: number;
  /** Shin colour: null = the trouser colour, `SKIN_SHINS` = bare skin, else a colour (boots). */
  shins: number | null;
  boxes: readonly AccessoryBox[];
  hideHair: boolean;
}

export interface PatchSpec {
  shape: 'shield' | 'circle' | 'roundedRect' | 'arch' | 'polygon';
  points?: [number, number][];
  base: number;
  border: number;
  accent: number;
  /** At most 4 characters. */
  initials: string;
  /** At most 16 characters. */
  text: string;
}

export interface BadgeSpec {
  shape: 'star' | 'shield' | 'circle' | 'ellipse' | 'polygon';
  starPoints?: number;
  points?: [number, number][];
  metal: number;
  enamel: number;
  /** At most 12 characters. */
  text: string;
}

export interface OutfitSpec {
  uniform: UniformClass;
  hat: HatId | 'default';
  carrier: CarrierId | 'default';
  cold: ColdId;
  hairStyle: HairStyle;
  hairColor: number;
  namePlate: boolean;
  patch: PatchSpec;
  badge: BadgeSpec;
  /** null = the class colours. */
  colors: { top: number; bottom: number } | null;
}

export interface OutfitContext {
  lastName: string;
  rank: RankId;
}

export interface PronounSet {
  id: 'she' | 'he' | 'they' | 'custom';
  subject: string;
  object: string;
  possessive: string;
  possessivePronoun: string;
  reflexive: string;
  /** Verb agreement: true = "they are", false = "she is". */
  plural: boolean;
}

export interface CharacterProfile {
  version: 1;
  /** 1..24 characters: letters, spaces, apostrophe, period, hyphen. */
  firstName: string;
  lastName: string;
  /** /^[0-9]{3,6}$/ */
  badge: string;
  pronouns: PronounSet;
  body: {
    /** 1.5..2.05 */
    heightM: number;
    /** 0.8..1.3 */
    build: number;
    /** 0.85..1.2 */
    shoulders: number;
    /** 0.85..1.2 */
    hips: number;
  };
  skin: number;
  hairStyle: HairStyle;
  hairColor: number;
  rank: RankId;
  outfit: OutfitSpec;
}

export interface CharacterSave {
  version: 1;
  profile: CharacterProfile;
}
