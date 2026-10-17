import type { VehicleModel } from '../../vehicles/model';

export type CarPartKind =
  | 'body'
  | 'cabin'
  | 'glass'
  | 'headLeft'
  | 'headRight'
  | 'tailLeft'
  | 'tailRight'
  | 'lightbarRed'
  | 'lightbarBlue';

/** One box of the procedural car: centre and full size in the vehicle frame (origin = body box centre, -Z front). */
export interface CarPart {
  kind: CarPartKind;
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
}

/** Kinds drawn with the shared emissive lens mesh. */
export const LENS_KINDS: readonly CarPartKind[] = [
  'headLeft',
  'headRight',
  'tailLeft',
  'tailRight',
  'lightbarRed',
  'lightbarBlue',
];

/** The painted parts stop this far inside the body box ends so the lamp lenses show in front of them. */
const LENS_DEPTH = 0.04;
/** Glass sticks out of the cabin by this much so the window band is visible. */
const GLASS_OUT = 0.01;

function part(kind: CarPartKind, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): CarPart {
  return { kind, x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2, sx: x1 - x0, sy: y1 - y0, sz: z1 - z0 };
}

/**
 * Low-poly boxes for `model` by `body.style`: a lower body (full length), a cabin from the cabin
 * fractions with a glass band around it, a full-height rear block for vans and trucks, four lamp
 * lenses and, for light-bar models, two light-bar halves on the roof. Everything lies inside the body
 * box except the light bar, which sits on top of it.
 */
export function buildCarParts(model: VehicleModel): CarPart[] {
  const { width: w, height: h, length: l, cabin, style } = model.body;
  const ch = Math.min(cabin.height, h * 0.8);
  const front = -l / 2 + LENS_DEPTH;
  const rear = l / 2 - LENS_DEPTH;
  const bottom = -h / 2;
  const top = h / 2;
  const lowerTop = top - ch;
  const parts: CarPart[] = [part('body', -w / 2, w / 2, bottom, lowerTop, front, rear)];

  // Cabin footprint, kept clear of the body ends so the glass never meets an outer face.
  const cx = w / 2 - Math.max(cabin.inset, GLASS_OUT * 2);
  const cz0 = Math.max(-l / 2 + cabin.start * l, front + GLASS_OUT * 2);
  const cz1 = Math.min(-l / 2 + cabin.end * l, rear - GLASS_OUT * 2);
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
    const half = Math.min(cx * 2 * 0.85, 1.4) / 2;
    const z = cz0 + (cz1 - cz0) * 0.4;
    parts.push(part('lightbarRed', -half, -0.01, top, top + 0.1, z - 0.12, z + 0.12));
    parts.push(part('lightbarBlue', 0.01, half, top, top + 0.1, z - 0.12, z + 0.12));
  }
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
