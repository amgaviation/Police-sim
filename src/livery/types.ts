/** Livery document types and fixed id lists (Phase 7 §4.1, §6.1). Pure data, no DOM, no THREE. */

export const LIVERY_FORMAT = 'patrol-livery';
export const LIVERY_VERSION = 1;
export const LIVERY_LIMITS = {
  layers: 32,
  textChars: 24,
  polygonPoints: 24,
  nameChars: 40,
  fileBytes: 65536,
  loadoutEntries: 40,
} as const;

/** `sides` paints the left and right shell regions (mirrored placement); the others are one region each. */
export const LIVERY_FACES = ['sides', 'left', 'right', 'hood', 'roof', 'front', 'rear'] as const;
export type Face = (typeof LIVERY_FACES)[number];

export const LAYER_TYPES = ['stripe', 'shape', 'text', 'checker'] as const;
export type LayerType = (typeof LAYER_TYPES)[number];

export const SHAPE_KINDS = [
  'rect',
  'roundedRect',
  'circle',
  'ellipse',
  'star',
  'shield',
  'chevron',
  'triangle',
  'arch',
  'polygon',
] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];

export const LIGHTBAR_STYLES = ['roof', 'hidden', 'none'] as const;
export type LightbarStyle = (typeof LIGHTBAR_STYLES)[number];

export const WRAP_KINDS = ['solid', 'twoTone', 'fade', 'pinstripe'] as const;
export type WrapKind = (typeof WRAP_KINDS)[number];

export const FINISHES = ['gloss', 'matte', 'metallic'] as const;
export type Finish = (typeof FINISHES)[number];

/** Text families; `stencil` falls back to a heavy sans (no web fonts). */
export const LIVERY_FONTS = ['sans', 'serif', 'mono', 'stencil'] as const;
export type LiveryFont = (typeof LIVERY_FONTS)[number];

export const LIVERY_WEIGHTS = ['normal', 'bold'] as const;
export type LiveryWeight = (typeof LIVERY_WEIGHTS)[number];

/** Siren tones (same ids as `SIREN_TONE_NAMES`). */
export type LiverySiren = 'wail' | 'yelp' | 'phaser' | 'hilo';

/** `#rrggbb`, lowercase after validation. */
export type Hex = string;

export type StripeLayer = {
  type: 'stripe';
  face: Face;
  u0: number;
  u1: number;
  v: number;
  height: number;
  angleDeg: number;
  color: Hex;
  reflective: boolean;
};

export type ShapeLayer = {
  type: 'shape';
  face: Face;
  shape: ShapeKind;
  u: number;
  v: number;
  w: number;
  h: number;
  rotationDeg: number;
  color: Hex;
  outline: Hex | null;
  reflective: boolean;
  /** Only for `star` (int 3..12, default 5). */
  starPoints?: number;
  /** Only (and required) for `polygon`: 3..24 pairs in [-1, 1]. */
  points?: [number, number][];
};

export type TextLayer = {
  type: 'text';
  face: Face;
  text: string;
  u: number;
  v: number;
  size: number;
  color: Hex;
  outline: Hex | null;
  font: LiveryFont;
  weight: LiveryWeight;
  italic: boolean;
  reflective: boolean;
};

export type CheckerLayer = {
  type: 'checker';
  face: Face;
  v: number;
  height: number;
  cells: number;
  rows: number;
  colors: [Hex, Hex];
  reflective: boolean;
};

export type LiveryLayer = StripeLayer | ShapeLayer | TextLayer | CheckerLayer;

export interface LiveryWrap {
  kind: WrapKind;
  /** 1..3 colours; kinds that need a second colour fall back to the first. */
  colors: Hex[];
  split: number;
}

export interface LiveryDoc {
  format: 'patrol-livery';
  version: 1;
  /** `/^[a-zA-Z0-9_-]{1,40}$/` */
  id: string;
  name: string;
  author: string;
  base: { color: Hex; finish: Finish };
  wrap: null | LiveryWrap;
  layers: LiveryLayer[];
  lights: { style: LightbarStyle; pattern: string; siren: LiverySiren };
  equipment: { pushBar: boolean; spotlight: boolean; partition: boolean };
  /** Shape only here; gear validates it against the vehicle at apply time. */
  loadout: null | { trunk: Record<string, number>; rack: string[] };
}

export type LiveryResult = { ok: true; livery: LiveryDoc } | { ok: false; errors: string[] };
