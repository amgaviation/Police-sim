import { createRng } from '../core/rng';
import { rankDef, UNIFORM_DATA, uniformClass } from './data';
import type { BeltKind } from './data';
import {
  BADGE_BELT,
  BADGE_CHEST,
  barBox,
  BELT_BOXES,
  BOOT_BOXES,
  CARRIER_PARTS,
  chevronBox,
  COLD_PARTS,
  HAIR_BOXES,
  HAIR_COVERING_HATS,
  HAT_BOXES,
  HELMETS,
  JACKET_PARTS,
  NAME_PLATE,
  PART_COLORS,
  patchBox,
  starBox,
  TIE_BOX,
  TORSO_DEPTH,
} from './parts';
import type { LayerParts, PartBox } from './parts';
import { ATTACH, HAIR_STYLES, MAX_OUTFIT_BOXES, SKIN_SHINS } from './types';
import type {
  AccessoryBox,
  BadgeSpec,
  HatId,
  OutfitContext,
  OutfitDef,
  OutfitSpec,
  PatchSpec,
  UniformClass,
} from './types';

/** Colour with every channel scaled by `factor` (0..1). */
function darken(color: number, factor: number): number {
  const r = Math.round(((color >> 16) & 0xff) * factor);
  const g = Math.round(((color >> 8) & 0xff) * factor);
  const b = Math.round((color & 0xff) * factor);
  return (r << 16) | (g << 8) | b;
}

function clonePatch(p: PatchSpec): PatchSpec {
  const out: PatchSpec = { ...p };
  if (p.points !== undefined) out.points = p.points.map(([x, y]) => [x, y]);
  return out;
}

function cloneBadge(b: BadgeSpec): BadgeSpec {
  const out: BadgeSpec = { ...b };
  if (b.points !== undefined) out.points = b.points.map(([x, y]) => [x, y]);
  return out;
}

/** Hat colours by box index (0 crown / shell, 1 peak / bill / visor); `dark` = the trouser colour. */
function hatColor(hat: HatId, index: number, dark: number): number {
  switch (hat) {
    case 'peakedCap':
      return index === 0 ? dark : PART_COLORS.capPeak;
    case 'ballCap':
      return dark;
    case 'campaign':
      return PART_COLORS.campaign;
    case 'beanie':
      return PART_COLORS.beanie;
    case 'watchCap':
      return PART_COLORS.watchCap;
    case 'motorHelmet':
      return index === 0 ? PART_COLORS.helmetMotor : PART_COLORS.helmetVisor;
    case 'bikeHelmet':
      return PART_COLORS.helmetBike;
    case 'tacticalHelmet':
      return PART_COLORS.helmetTactical;
    case 'none':
      return dark;
  }
}

function beltColor(belt: BeltKind, accent: number): number {
  return belt === 'dress' ? accent : belt === 'plain' ? PART_COLORS.plainBelt : PART_COLORS.belt;
}

/**
 * Pure: the boxes of `spec` for `ctx`, in the order hat -> hair -> carrier -> cold -> belt (+ boots) ->
 * tie / jacket -> patches -> badge -> name plate -> insignia. `'default'` hat / carrier take the class
 * default. Layers hide what they cover so the worst case stays within `MAX_OUTFIT_BOXES`: a cold layer
 * replaces the class jacket and tie and hides the vest carrier; a class jacket hides the carrier slab
 * (pouches stay). Hair volume boxes are skipped under helmets, bald heads and hair-covering hats. Tie,
 * badge and name plate sit in front of the thickest torso layer. Throws when over `MAX_OUTFIT_BOXES`.
 */
export function buildOutfit(spec: OutfitSpec, ctx: OutfitContext): OutfitDef {
  const cls = uniformClass(spec.uniform);
  const top = spec.colors?.top ?? cls.top;
  const bottom = spec.colors?.bottom ?? cls.bottom;
  const hat = spec.hat === 'default' ? cls.hat : spec.hat;
  const carrier = spec.carrier === 'default' ? cls.carrier : spec.carrier;
  const boxes: AccessoryBox[] = [];
  const add = (part: PartBox, color: number, dz = 0): void => {
    boxes.push({ ...part, z: part.z + dz, color });
  };
  const hideHair = HELMETS.includes(hat) || spec.hairStyle === 'bald';
  let torsoDepth = TORSO_DEPTH;

  // hat
  HAT_BOXES[hat].forEach((part, i) => add(part, hatColor(hat, i, bottom)));
  // hair
  if (!hideHair && !HAIR_COVERING_HATS.includes(hat)) {
    for (const part of HAIR_BOXES[spec.hairStyle]) add(part, spec.hairColor);
  }
  // carrier: hidden by a cold layer; under the class jacket only the pouches show
  const cold = COLD_PARTS[spec.cold];
  const jacketWorn = cls.jacket && cold === null;
  if (cold === null) {
    const parts = CARRIER_PARTS[carrier];
    if (parts.slab !== null && !jacketWorn) {
      add(parts.slab, carrier === 'internal' ? top : carrier === 'plateCarrier' ? PART_COLORS.plateCarrier : PART_COLORS.externalCarrier);
      torsoDepth = Math.max(torsoDepth, parts.slab.sz);
    }
    for (const pouch of parts.pouches) add(pouch, PART_COLORS.pouch);
  }
  // cold layer
  const addLayer = (layer: LayerParts, torsoColor: number, sleeveColor: number): void => {
    add(layer.torso, torsoColor);
    torsoDepth = Math.max(torsoDepth, layer.torso.sz);
    for (const attach of [ATTACH.leftArm, ATTACH.rightArm]) {
      boxes.push({ attach, x: 0, y: layer.sleeveY, z: 0, ...layer.sleeveSize, color: sleeveColor });
    }
    if (layer.hood !== null) add(layer.hood, torsoColor);
  };
  if (cold !== null) {
    const color =
      spec.cold === 'rainShell' ? PART_COLORS.rainShell : spec.cold === 'parka' ? PART_COLORS.parka : PART_COLORS.coldJacket;
    addLayer(cold, color, color);
  }
  // belt, then boots
  BELT_BOXES[cls.belt].forEach((part, i) => add(part, i === 0 ? beltColor(cls.belt, cls.accent) : PART_COLORS.belt));
  if (cls.tallBoots) for (const part of BOOT_BOXES) add(part, PART_COLORS.boots);
  // tie / class jacket (a cold layer covers both)
  if (cold === null && cls.jacket) addLayer(JACKET_PARTS, darken(top, 0.85), darken(top, 0.85));
  const frontDz = TORSO_DEPTH / 2 - torsoDepth / 2;
  if (cold === null && cls.tie) add(TIE_BOX, PART_COLORS.tie, frontDz);
  // patches
  add(patchBox(-1), spec.patch.base);
  add(patchBox(1), spec.patch.base);
  // badge
  if (cls.badgeOnBelt) add(BADGE_BELT, spec.badge.metal);
  else add(BADGE_CHEST, spec.badge.metal, frontDz);
  // name plate
  if (spec.namePlate && spec.uniform !== 'detective') add(NAME_PLATE, PART_COLORS.namePlate, frontDz);
  // insignia
  rankDef(ctx.rank).insignia.forEach((kind, k) => {
    for (const sign of [-1, 1] as const) {
      if (kind === 'chevron') add(chevronBox(sign, k), cls.accent);
      else if (kind === 'bar') add(barBox(sign, k), cls.accent);
      else add(starBox(sign, k), cls.accent);
    }
  });

  if (boxes.length > MAX_OUTFIT_BOXES) {
    throw new Error(`buildOutfit: ${boxes.length} boxes exceed the limit of ${MAX_OUTFIT_BOXES}`);
  }
  return {
    id: `${spec.uniform}/${spec.hat}/${spec.carrier}/${spec.cold}/${spec.hairStyle}/${ctx.rank}/${spec.namePlate}`,
    top,
    bottom,
    shins: cls.shorts ? SKIN_SHINS : null,
    boxes,
    hideHair,
  };
}

/** Outfit of a spec for the department's default patch and badge; hair as given. */
function baseSpec(uniform: UniformClass, hairStyle: OutfitSpec['hairStyle'], hairColor: number): OutfitSpec {
  return {
    uniform,
    hat: 'default',
    carrier: 'default',
    cold: 'none',
    hairStyle,
    hairColor,
    namePlate: true,
    patch: clonePatch(UNIFORM_DATA.department.patch),
    badge: cloneBadge(UNIFORM_DATA.department.badge),
    colors: null,
  };
}

/** The default spec of a class (class hat and carrier, short dark-brown hair, name plate, department patch and badge). */
export function defaultOutfitSpec(uniform: UniformClass = 'classB'): OutfitSpec {
  return baseSpec(uniform, 'short', 0x2a1d14);
}

/**
 * Deterministic AI spec drawn only from `createRng(seed).stream('uniform:<callsign>')` (four draws in a fixed
 * order whatever the role): patrol -> classB (70 %) / tactical (30 %), hat none 60 % / ballCap 25 % /
 * peakedCap 15 %; supervisor -> classB with a peaked cap; swat -> swat; detective -> detective; a
 * `jacket` when `coldC` < 8. Hair style and colour come from the stream, patch and badge from the department.
 */
export function aiOutfitSpec(
  seed: number,
  callsign: string,
  role: 'patrol' | 'supervisor' | 'swat' | 'detective',
  coldC: number,
): OutfitSpec {
  const rng = createRng(seed).stream(`uniform:${callsign}`);
  const classRoll = rng.next();
  const hatRoll = rng.next();
  const hairStyle = rng.pick(HAIR_STYLES);
  const hairColor = rng.pick(UNIFORM_DATA.hairColors);
  const spec = baseSpec('classB', hairStyle, hairColor);
  if (role === 'patrol') {
    spec.uniform = classRoll < 0.7 ? 'classB' : 'tactical';
    spec.hat = hatRoll < 0.6 ? 'none' : hatRoll < 0.85 ? 'ballCap' : 'peakedCap';
  } else if (role === 'supervisor') {
    spec.hat = 'peakedCap';
  } else {
    spec.uniform = role;
  }
  if (coldC < 8) spec.cold = 'jacket';
  return spec;
}

/** Whether the uniform class suits the fleet class (`vehiclePolicy`; fleet classes without a rule allow anything). */
export function uniformAllowed(uniform: UniformClass, fleetClass: string): boolean {
  const allowed = UNIFORM_DATA.vehiclePolicy[fleetClass];
  return allowed === undefined || allowed.includes(uniform);
}
