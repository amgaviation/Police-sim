import { LIGHTBAR_SEGMENTS } from '../../police/lightbar';
import type { VehicleModel } from '../../vehicles/model';

export type CarPartKind =
  | 'body'
  | 'cabin'
  | 'glass'
  | 'headLeft'
  | 'headRight'
  | 'tailLeft'
  | 'tailRight'
  | 'lightbar'
  | 'trim';

/** One box of the procedural car: centre and full size in the vehicle frame (origin = body box centre, -Z front). */
export interface CarPart {
  kind: CarPartKind;
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  /** 'lightbar' lenses only: segment index 0..LIGHTBAR_SEGMENTS-1, left (-X) to right. */
  segment?: number;
}

/** Kinds drawn with the shared emissive lens mesh. */
export const LENS_KINDS: readonly CarPartKind[] = ['headLeft', 'headRight', 'tailLeft', 'tailRight', 'lightbar'];

/** Gap between light-bar segments (m). */
const SEGMENT_GAP = 0.02;
/** Push bumper: distance in front of the body and depth of its bar (m). */
const BUMPER_OUT = 0.06;
const BUMPER_DEPTH = 0.08;
/** Spotlight housing size (m): x, y, z. */
const HOUSING_SX = 0.1;
const HOUSING_SY = 0.1;
const HOUSING_SZ = 0.16;

/** The painted parts stop this far inside the body box ends so the lamp lenses show in front of them. */
const LENS_DEPTH = 0.04;
/** Glass sticks out of the cabin by this much so the window band is visible. */
const GLASS_OUT = 0.01;

function part(kind: CarPartKind, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): CarPart {
  return { kind, x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2, sx: x1 - x0, sy: y1 - y0, sz: z1 - z0 };
}

/** Cabin footprint shared by the car parts, the spotlight mount and the cockpit. */
export interface CabinBox {
  /** Half width of the cabin. */
  readonly cx: number;
  /** Cabin front and rear z (vehicle frame, -Z front). */
  readonly z0: number;
  readonly z1: number;
  /** Top of the lower body (belt line) and of the roof. */
  readonly lowerTop: number;
  readonly top: number;
}

export function cabinBox(model: VehicleModel): CabinBox {
  const { width: w, height: h, length: l, cabin } = model.body;
  const ch = Math.min(cabin.height, h * 0.8);
  const front = -l / 2 + LENS_DEPTH;
  const rear = l / 2 - LENS_DEPTH;
  return {
    cx: w / 2 - Math.max(cabin.inset, GLASS_OUT * 2),
    z0: Math.max(-l / 2 + cabin.start * l, front + GLASS_OUT * 2),
    z1: Math.min(-l / 2 + cabin.end * l, rear - GLASS_OUT * 2),
    lowerTop: h / 2 - ch,
    top: h / 2,
  };
}

/**
 * Spotlight housing box at the driver-side A-pillar: left side (-X), at the cabin start, sitting on
 * the top of the lower body, inside the body width.
 */
export function spotlightHousing(model: VehicleModel): CarPart {
  const { width: w } = model.body;
  const c = cabinBox(model);
  const x = -(w / 2 - 0.01 - HOUSING_SX / 2);
  return part('trim', x - HOUSING_SX / 2, x + HOUSING_SX / 2, c.lowerTop, c.lowerTop + HOUSING_SY, c.z0, c.z0 + HOUSING_SZ);
}

/**
 * Low-poly boxes for `model` by `body.style`: a lower body (full length), a cabin from the cabin
 * fractions with a glass band around it, a full-height rear block for vans and trucks, four lamp
 * lenses, for light-bar models `LIGHTBAR_SEGMENTS` light-bar lenses on the roof (left to right), and
 * for patrol equipment 'trim' boxes: a push bumper (a bar in front of the body below the lamps and two
 * uprights) and a spotlight housing at the driver A-pillar. Everything lies inside the body box
 * except the light bar, which sits on top of it, and the push bumper, which sits in front of it.
 */
export function buildCarParts(model: VehicleModel): CarPart[] {
  const { width: w, height: h, length: l, style } = model.body;
  const front = -l / 2 + LENS_DEPTH;
  const rear = l / 2 - LENS_DEPTH;
  const bottom = -h / 2;
  // Cabin footprint, kept clear of the body ends so the glass never meets an outer face.
  const { cx, z0: cz0, z1: cz1, lowerTop, top } = cabinBox(model);
  const ch = top - lowerTop;
  const parts: CarPart[] = [part('body', -w / 2, w / 2, bottom, lowerTop, front, rear)];

  parts.push(part('cabin', -cx, cx, lowerTop, top, cz0, cz1));
  const gx = cx + GLASS_OUT;
  parts.push(part('glass', -gx, gx, lowerTop + ch * 0.12, top - ch * 0.15, cz0 - GLASS_OUT, cz1 + GLASS_OUT));

  // Vans and trucks are full height behind the cab (cargo area).
  if ((style === 'van' || style === 'truck') && cz1 < rear) {
    parts.push(part('body', -w / 2, w / 2, lowerTop, top, cz1, rear));
  }

  const lowerH = lowerTop - bottom;
  const lampW = Math.min(Math.max(w * 0.16, 0.2), 0.35);
  const lampH = Math.min(0.12, lowerH * 0.2);
  const lampY = bottom + Math.min(lowerH * 0.65, 0.6);
  const lampX = w / 2 - 0.06 - lampW / 2;
  const box = (kind: CarPartKind, x: number, z0: number, z1: number): CarPart =>
    part(kind, x - lampW / 2, x + lampW / 2, lampY - lampH / 2, lampY + lampH / 2, z0, z1);
  parts.push(box('headLeft', -lampX, -l / 2, front), box('headRight', lampX, -l / 2, front));
  parts.push(box('tailLeft', -lampX, rear, l / 2), box('tailRight', lampX, rear, l / 2));

  if (model.lightbar) {
    // Same extent as the Phase 1 two-half bar, cut into equal lenses.
    const half = Math.min(cx * 2 * 0.85, 1.4) / 2;
    const z = cz0 + (cz1 - cz0) * 0.4;
    const segW = (2 * half - SEGMENT_GAP * (LIGHTBAR_SEGMENTS - 1)) / LIGHTBAR_SEGMENTS;
    for (let s = 0; s < LIGHTBAR_SEGMENTS; s++) {
      const x0 = -half + s * (segW + SEGMENT_GAP);
      const lens = part('lightbar', x0, x0 + segW, top, top + 0.1, z - 0.12, z + 0.12);
      lens.segment = s;
      parts.push(lens);
    }
  }

  const equipment = model.equipment;
  if (equipment?.pushBumper) {
    const z1 = -l / 2 - BUMPER_OUT;
    const z0 = z1 - BUMPER_DEPTH;
    const barTop = lampY - lampH / 2 - 0.02;
    const barBottom = Math.max(bottom, barTop - 0.12);
    const barX = w * 0.38;
    parts.push(part('trim', -barX, barX, barBottom, barTop, z0, z1));
    // Uprights inboard of the head lamps, from the bar to the bonnet line.
    const upX = Math.min(w * 0.2, lampX - lampW / 2 - 0.06);
    for (const sx of [-1, 1]) {
      parts.push(part('trim', sx * upX - 0.035, sx * upX + 0.035, barBottom, lowerTop - 0.02, z0 + 0.01, z1 - 0.01));
    }
  }
  if (equipment?.spotlight) parts.push(spotlightHousing(model));
  return parts;
}

/**
 * Writes the wheel hub centres FL, FR, RL, RR as x, y, z triples into `out` (length >= 12): x = ±track/2
 * (left = -X), z = ∓wheelbase/2 (front = -Z), y = -(height/2 + groundClearance) + tyre radius so the
 * tyres touch the ground with the body at rest height.
 */
export function wheelLocalPositions<T extends { [i: number]: number }>(model: VehicleModel, out: T): T {
  const { track, wheelbase, height, groundClearance } = model.body;
  const y = -(height / 2 + groundClearance) + model.tires.radius;
  for (let i = 0; i < 4; i++) {
    out[i * 3] = (i % 2 === 0 ? -1 : 1) * (track / 2);
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = (i < 2 ? -1 : 1) * (wheelbase / 2);
  }
  return out;
}
