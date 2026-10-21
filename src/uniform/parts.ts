import { ATTACH } from './types';
import type { AccessoryBox, AttachId, CarrierId, ColdId, HairStyle, HatId } from './types';

/**
 * Accessory box tables in the part frames of the 1.75 m reference figure used by PeopleRenderer
 * (design Phase 7 §7.2): x right, y up, +z behind the figure (the chest front is z = -0.12); torso frame
 * origin = pelvis pivot; head frame origin = neck; arm frames origin = shoulder, hanging -y; thigh / shin
 * frames origin = hip / knee, hanging -y; pelvis frame = the body frame at the pelvis (does not bend).
 * Colours are not part of the tables: `outfit.ts` assigns them.
 */

export type PartBox = Omit<AccessoryBox, 'color'>;

function box(attach: AttachId, x: number, y: number, z: number, sx: number, sy: number, sz: number): PartBox {
  return { attach, x, y, z, sx, sy, sz };
}

/** Torso box depth (chest front z = -0.12). */
export const TORSO_DEPTH = 0.24;

/** Hat boxes, head frame. Index 0 is the crown / shell / main piece; index 1 (when present) the peak / bill / visor. */
export const HAT_BOXES: Readonly<Record<HatId, readonly PartBox[]>> = {
  none: [],
  peakedCap: [box(ATTACH.head, 0, 0.27, 0.01, 0.24, 0.07, 0.25), box(ATTACH.head, 0, 0.235, -0.13, 0.2, 0.015, 0.08)],
  campaign: [box(ATTACH.head, 0, 0.25, 0, 0.4, 0.015, 0.4), box(ATTACH.head, 0, 0.3, 0, 0.2, 0.1, 0.2)],
  ballCap: [box(ATTACH.head, 0, 0.265, 0.01, 0.235, 0.06, 0.24), box(ATTACH.head, 0, 0.24, -0.15, 0.17, 0.012, 0.1)],
  beanie: [box(ATTACH.head, 0, 0.255, 0, 0.235, 0.08, 0.235)],
  watchCap: [box(ATTACH.head, 0, 0.255, 0, 0.235, 0.08, 0.235)],
  motorHelmet: [box(ATTACH.head, 0, 0.2, 0.01, 0.28, 0.22, 0.29), box(ATTACH.head, 0, 0.15, -0.15, 0.24, 0.08, 0.02)],
  bikeHelmet: [box(ATTACH.head, 0, 0.27, 0.01, 0.25, 0.08, 0.3)],
  tacticalHelmet: [box(ATTACH.head, 0, 0.2, 0.01, 0.28, 0.22, 0.29)],
};

/** Hats that hide the hair completely (`OutfitDef.hideHair`). */
export const HELMETS: readonly HatId[] = ['motorHelmet', 'bikeHelmet', 'tacticalHelmet'];
/** Hats that cover the hair volume (no hair boxes under them); a ball cap or no hat leaves it free. */
export const HAIR_COVERING_HATS: readonly HatId[] = ['peakedCap', 'campaign', 'beanie', 'watchCap'];

/** Hair volume boxes, head frame; styles without boxes are drawn as the figure's hair colour only. */
export const HAIR_BOXES: Readonly<Record<HairStyle, readonly PartBox[]>> = {
  bald: [],
  buzz: [],
  short: [],
  medium: [],
  long: [box(ATTACH.head, 0, 0.1, 0.1, 0.22, 0.24, 0.06)],
  bun: [box(ATTACH.head, 0, 0.2, 0.14, 0.09, 0.09, 0.08)],
  ponytail: [box(ATTACH.head, 0, 0.1, 0.15, 0.06, 0.2, 0.05)],
  braids: [box(ATTACH.head, -0.08, 0.06, 0.1, 0.04, 0.2, 0.04), box(ATTACH.head, 0.08, 0.06, 0.1, 0.04, 0.2, 0.04)],
};

/** Vest carriers, torso frame: the torso slab (null = none) and the front pouches. */
export interface CarrierParts {
  readonly slab: PartBox | null;
  readonly pouches: readonly PartBox[];
}
const POUCHES: readonly PartBox[] = [-0.12, 0, 0.12].map((x) => box(ATTACH.torso, x, 0.22, -0.15, 0.08, 0.1, 0.04));
export const CARRIER_PARTS: Readonly<Record<CarrierId, CarrierParts>> = {
  none: { slab: null, pouches: [] },
  internal: { slab: box(ATTACH.torso, 0, 0.33, 0, 0.43, 0.36, 0.26), pouches: [] },
  external: { slab: box(ATTACH.torso, 0, 0.33, 0, 0.45, 0.4, 0.28), pouches: POUCHES },
  plateCarrier: { slab: box(ATTACH.torso, 0, 0.33, 0, 0.47, 0.42, 0.3), pouches: POUCHES },
};

/** Cold-weather layer: torso, both sleeves (left, right) and a hood (head frame, parka only). */
export interface LayerParts {
  readonly torso: PartBox;
  readonly sleeveSize: { readonly sx: number; readonly sy: number; readonly sz: number };
  readonly sleeveY: number;
  readonly hood: PartBox | null;
}
const COLD_TORSO = box(ATTACH.torso, 0, 0.3, 0, 0.46, 0.64, 0.28);
const COLD_SLEEVE = { sx: 0.13, sy: 0.58, sz: 0.13 } as const;
export const COLD_PARTS: Readonly<Record<ColdId, LayerParts | null>> = {
  none: null,
  jacket: { torso: COLD_TORSO, sleeveSize: COLD_SLEEVE, sleeveY: -0.28, hood: null },
  parka: { torso: COLD_TORSO, sleeveSize: COLD_SLEEVE, sleeveY: -0.28, hood: box(ATTACH.head, 0, 0.18, 0.12, 0.26, 0.12, 0.08) },
  rainShell: { torso: COLD_TORSO, sleeveSize: COLD_SLEEVE, sleeveY: -0.28, hood: null },
};

/** The class uniform jacket worn over the shirt. */
export const JACKET_PARTS: LayerParts = {
  torso: box(ATTACH.torso, 0, 0.3, 0, 0.44, 0.62, 0.26),
  sleeveSize: { sx: 0.12, sy: 0.58, sz: 0.12 },
  sleeveY: -0.28,
  hood: null,
};

/** Belts, pelvis frame: index 0 the belt, index 1 (duty) the holster. */
export const BELT_BOXES: Readonly<Record<'dress' | 'duty' | 'plain', readonly PartBox[]>> = {
  duty: [box(ATTACH.pelvis, 0, 0.02, 0, 0.44, 0.07, 0.26), box(ATTACH.pelvis, 0.24, -0.06, 0, 0.06, 0.16, 0.1)],
  dress: [box(ATTACH.pelvis, 0, 0.02, 0, 0.43, 0.05, 0.25)],
  plain: [box(ATTACH.pelvis, 0, 0.02, 0, 0.43, 0.04, 0.25)],
};

/** Tie, torso frame (z is for a bare torso: `outfit.ts` moves it in front of thicker layers). */
export const TIE_BOX: PartBox = box(ATTACH.torso, 0, 0.38, -0.125, 0.05, 0.3, 0.01);

/** Tall boots on both shins (motor). */
export const BOOT_BOXES: readonly PartBox[] = [
  box(ATTACH.leftShin, 0, -0.28, 0, 0.17, 0.3, 0.18),
  box(ATTACH.rightShin, 0, -0.28, 0, 0.17, 0.3, 0.18),
];

/** Shoulder patch for one arm (`sign` -1 = left arm, +1 = right arm; x points outward). */
export function patchBox(sign: -1 | 1): PartBox {
  return box(sign < 0 ? ATTACH.leftArm : ATTACH.rightArm, sign * 0.06, -0.08, 0, 0.012, 0.09, 0.07);
}

/** Badge on the chest (torso frame) or on the belt (pelvis frame, detective). z as for a bare torso. */
export const BADGE_CHEST: PartBox = box(ATTACH.torso, -0.11, 0.42, -0.125, 0.06, 0.07, 0.01);
export const BADGE_BELT: PartBox = box(ATTACH.pelvis, -0.12, 0.02, -0.135, 0.06, 0.07, 0.01);
/** Name plate, chest right. z as for a bare torso. */
export const NAME_PLATE: PartBox = box(ATTACH.torso, 0.11, 0.42, -0.125, 0.08, 0.02, 0.01);

/** Sleeve chevron number `k` (0..) on one arm. */
export function chevronBox(sign: -1 | 1, k: number): PartBox {
  return box(sign < 0 ? ATTACH.leftArm : ATTACH.rightArm, sign * 0.06, -0.18 - 0.035 * k, 0, 0.012, 0.02, 0.08);
}
/** Collar bar number `k` on one side. */
export function barBox(sign: -1 | 1, k: number): PartBox {
  return box(ATTACH.torso, sign * 0.12, 0.555 - 0.02 * k, -0.1, 0.04, 0.012, 0.012);
}
/** Collar star number `k` on one side. */
export function starBox(sign: -1 | 1, k: number): PartBox {
  return box(ATTACH.torso, sign * (0.09 + 0.03 * k), 0.555, -0.1, 0.025, 0.025, 0.012);
}

/** Fixed part colours (0xRRGGBB). Class-dependent colours come from the uniform data. */
export const PART_COLORS = {
  belt: 0x15161a,
  tie: 0x15161a,
  externalCarrier: 0x2a2d33,
  plateCarrier: 0x3b4232,
  pouch: 0x1f2227,
  coldJacket: 0x1d2330,
  parka: 0x1d2330,
  rainShell: 0xc8d43a,
  boots: 0x101010,
  namePlate: 0xc9a646,
  plainBelt: 0x2a211b,
  beanie: 0x22262c,
  watchCap: 0x1d2330,
  campaign: 0x6b5a3a,
  helmetMotor: 0x15161a,
  helmetVisor: 0x1a2a3a,
  helmetBike: 0xe8e8e8,
  helmetTactical: 0x3b4232,
  capPeak: 0x101010,
} as const;

/** Width / height of the bounding box of polygon `points` (1 without a usable polygon), clamped to 0.5..2. */
function polygonAspect(points: readonly (readonly [number, number])[] | undefined): number {
  if (!points || points.length < 3) return 1;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const w = maxX - minX;
  const h = maxY - minY;
  return w > 0 && h > 0 ? Math.min(2, Math.max(0.5, w / h)) : 1;
}

/**
 * A patch box sized by its shape (the 3D figure shows the footprint, not the artwork): width along the chest `sz`, height `sy`.
 * Shield 0.07 x 0.09, circle 0.08 x 0.08, rounded rectangle 0.09 x 0.07, arch 0.07 x 0.095, polygon by its bounds.
 */
export function shapedPatchBox(sign: -1 | 1, shape: 'shield' | 'circle' | 'roundedRect' | 'arch' | 'polygon', points?: readonly (readonly [number, number])[]): PartBox {
  const base = patchBox(sign);
  let w = base.sz;
  let h = base.sy;
  switch (shape) {
    case 'circle':
      w = 0.08;
      h = 0.08;
      break;
    case 'roundedRect':
      w = 0.09;
      h = 0.07;
      break;
    case 'arch':
      h = 0.095;
      break;
    case 'polygon':
      w = Math.min(0.1, Math.max(0.05, 0.09 * polygonAspect(points)));
      break;
    case 'shield':
      break;
  }
  return { ...base, sy: h, sz: w };
}

/** Width and height of a badge box by its shape (the department's star is the 0.06 x 0.07 default). */
export function badgeSize(shape: 'star' | 'shield' | 'circle' | 'ellipse' | 'polygon', points?: readonly (readonly [number, number])[]): { w: number; h: number } {
  switch (shape) {
    case 'star':
      return { w: 0.06, h: 0.07 };
    case 'circle':
      return { w: 0.065, h: 0.065 };
    case 'ellipse':
      return { w: 0.075, h: 0.055 };
    case 'polygon':
      return { w: Math.min(0.09, Math.max(0.045, 0.07 * polygonAspect(points))), h: 0.07 };
    case 'shield':
      return { w: 0.055, h: 0.075 };
  }
}

/** The name plate sized to the name: 0.04 m plus 0.005 m per letter, at most 0.09 m. */
export function namePlateBox(name: string): PartBox {
  return { ...NAME_PLATE, sx: Math.min(0.09, 0.04 + 0.005 * Math.min(name.length, 12)) };
}
