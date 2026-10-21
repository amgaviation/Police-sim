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
  /** Other dark parts: skids, racks, handlebars, masts, bicycle forks. */
  | 'trim'
  /** Push bumper boxes (drawn only with `TRIM.pushBar`). */
  | 'pushBar'
  /** Spotlight housing (drawn only with `TRIM.spotlight`). */
  | 'spotHousing'
  /** Spinning parts (helicopter blades, drone discs): turned about their own vertical axis. */
  | 'rotor';

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
/** Hidden light-bar lens size (m): x, y, z. */
const HIDDEN_SX = 0.12;
const HIDDEN_SY = 0.05;
const HIDDEN_SZ = 0.03;

/** The painted parts stop this far inside the body box ends so the lamp lenses show in front of them. */
export const LENS_DEPTH = 0.04;
/** Glass sticks out of the cabin by this much so the window band is visible. */
const GLASS_OUT = 0.01;

function part(kind: CarPartKind, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): CarPart {
  return { kind, x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2, sx: x1 - x0, sy: y1 - y0, sz: z1 - z0 };
}

/** Box of size (sx, sy, sz) centred at (x, y, z). */
function boxAt(kind: CarPartKind, x: number, y: number, z: number, sx: number, sy: number, sz: number): CarPart {
  return { kind, x, y, z, sx, sy, sz };
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

/** True for the seven car-family styles (built from the generic body / cabin / glass layout). */
function isCarStyle(model: VehicleModel): boolean {
  switch (model.body.style) {
    case 'sedan':
    case 'hatchback':
    case 'suv':
    case 'pickup':
    case 'van':
    case 'truck':
    case 'bus':
      return true;
    default:
      return false;
  }
}

/**
 * Spotlight housing box. Cars: at the driver-side A-pillar, left side (-X), at the cabin start, sitting on the
 * top of the lower body, inside the body width. Helicopter: under the nose (a searchlight). Other styles (boat,
 * ATV, ...): on the roof of the cabin box, front left.
 */
export function spotlightHousing(model: VehicleModel): CarPart {
  const { width: w, height: h, length: l, style } = model.body;
  const c = cabinBox(model);
  if (style === 'helicopter') {
    const belly = -h / 2 + h * 0.2;
    const z0 = -l / 2 + LENS_DEPTH + l * 0.1;
    return part('spotHousing', -0.35 - HOUSING_SX / 2, -0.35 + HOUSING_SX / 2, belly - HOUSING_SY, belly, z0, z0 + HOUSING_SZ);
  }
  if (!isCarStyle(model)) {
    const x = -(Math.max(c.cx, 0.2) - 0.15);
    return part('spotHousing', x - HOUSING_SX / 2, x + HOUSING_SX / 2, c.top, c.top + HOUSING_SY, c.z0, c.z0 + HOUSING_SZ);
  }
  const x = -(w / 2 - 0.01 - HOUSING_SX / 2);
  return part('spotHousing', x - HOUSING_SX / 2, x + HOUSING_SX / 2, c.lowerTop, c.lowerTop + HOUSING_SY, c.z0, c.z0 + HOUSING_SZ);
}

/**
 * The four lamp lenses: head lamps at the front end (`-length/2 .. +LENS_DEPTH`), tails at the rear end, centred at
 * height `y` and at `xHead` / `xTail` (mirrored), `lw` wide and `lh` high.
 */
function pushLamps(
  parts: CarPart[],
  model: VehicleModel,
  xHead: number,
  xTail: number,
  y: number,
  lw: number,
  lh: number,
): void {
  const l = model.body.length;
  const front = -l / 2 + LENS_DEPTH;
  const rear = l / 2 - LENS_DEPTH;
  const lamp = (kind: CarPartKind, x: number, z0: number, z1: number): CarPart => part(kind, x - lw / 2, x + lw / 2, y - lh / 2, y + lh / 2, z0, z1);
  parts.push(lamp('headLeft', -xHead, -l / 2, front), lamp('headRight', xHead, -l / 2, front));
  parts.push(lamp('tailLeft', -xTail, rear, l / 2), lamp('tailRight', xTail, rear, l / 2));
}

/** `count` light-bar lenses across `x0..x1`, segments `first..first+count-1` left to right. */
function pushLenses(parts: CarPart[], count: number, first: number, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void {
  const segW = (x1 - x0 - SEGMENT_GAP * (count - 1)) / count;
  for (let s = 0; s < count; s++) {
    const xs = x0 + s * (segW + SEGMENT_GAP);
    const lens = part('lightbar', xs, xs + segW, y0, y1, z0, z1);
    lens.segment = first + s;
    parts.push(lens);
  }
}

/** The classic roof bar over the cabin: `LIGHTBAR_SEGMENTS` lenses, same extent as the Phase 1 two-half bar. */
function pushRoofBar(parts: CarPart[], model: VehicleModel): void {
  const { cx, z0, z1, top } = cabinBox(model);
  const half = Math.min(cx * 2 * 0.85, 1.4) / 2;
  const z = z0 + (z1 - z0) * 0.4;
  pushLenses(parts, LIGHTBAR_SEGMENTS, 0, -half, half, top, top + 0.1, z - 0.12, z + 0.12);
}

function motorcycleParts(model: VehicleModel): CarPart[] {
  const { width: w, height: h, length: l } = model.body;
  const front = -l / 2 + LENS_DEPTH;
  const rear = l / 2 - LENS_DEPTH;
  const bottom = -h / 2;
  const at = (f: number): number => bottom + f * h;
  const parts: CarPart[] = [];
  // Frame at the bottom, tank / seat above it.
  parts.push(boxAt('body', 0, at(0.175), 0, 0.3 * w, 0.35 * h, 0.85 * l));
  parts.push(boxAt('body', 0, at(0.475), 0.05 * l, 0.35 * w, 0.25 * h, 0.45 * l));
  // Fairing (painted cabin) at the front, windscreen on top of it, handlebar behind it.
  parts.push(part('cabin', -0.3 * w, 0.3 * w, at(0.4), at(0.75), front, front + 0.18 * l));
  parts.push(boxAt('glass', 0, at(0.875), front + 0.09 * l, 0.5 * w, 0.25 * h, 0.03));
  parts.push(boxAt('trim', 0, at(0.75) + 0.02, front + 0.2 * l + 0.02, 0.8 * w, 0.04, 0.04));
  // Top case at the rear.
  parts.push(boxAt('body', 0, at(0.525), rear - 0.09 * l, 0.5 * w, 0.25 * h, 0.18 * l));
  pushLamps(parts, model, 0.06, 0.15 * w, at(0.5), 0.1, 0.08);
  // Tail lamps sit lower on the top case than the default height.
  for (const p of parts) if (p.kind === 'tailLeft' || p.kind === 'tailRight') p.y = at(0.45);
  if (model.lightbar) {
    const half = 0.2 * w;
    pushLenses(parts, 4, 0, -half, half, at(0.62), at(0.67), -l / 2, front);
    pushLenses(parts, 4, 4, -half, half, at(0.55), at(0.6), rear, l / 2);
  }
  return parts;
}

function bicycleParts(model: VehicleModel): CarPart[] {
  const { width: w, height: h, length: l, wheelbase } = model.body;
  const rear = l / 2 - LENS_DEPTH;
  const bottom = -h / 2;
  const forkZ = -wheelbase / 2;
  const seatZ = 0.3 * wheelbase;
  const topY = bottom + 0.6 * h;
  const parts: CarPart[] = [];
  // Frame: top tube, low down tube, seat post and rear stay.
  parts.push(part('body', -0.03, 0.03, topY, topY + 0.06, forkZ - 0.04, forkZ - 0.04 + 0.6 * l));
  parts.push(part('body', -0.025, 0.025, bottom + 0.2 * h, bottom + 0.2 * h + 0.05, forkZ, seatZ));
  parts.push(part('body', -0.025, 0.025, bottom + 0.2 * h, topY + 0.32 * h, seatZ - 0.02, seatZ + 0.02));
  parts.push(part('body', -0.02, 0.02, bottom + 0.2 * h, bottom + 0.2 * h + 0.04, seatZ, -forkZ));
  // Fork, handlebar and saddle.
  parts.push(part('trim', -0.02, 0.02, bottom + 0.2 * h, topY + 0.2 * h, forkZ - 0.02, forkZ + 0.02));
  parts.push(boxAt('trim', 0, topY + 0.2 * h, forkZ, 0.5 * w, 0.03, 0.03));
  parts.push(boxAt('trim', 0, topY + 0.32 * h + 0.02, seatZ, 0.1, 0.04, 0.2));
  // Rear rack pannier (painted) and its reflector.
  parts.push(part('cabin', -0.15 * w, 0.15 * w, topY + 0.02, topY + 0.02 + 0.2 * h, rear - 0.25 * l, rear));
  parts.push(boxAt('glass', 0, topY + 0.02 + 0.15 * h, rear + 0.005, 0.05, 0.03, 0.01));
  pushLamps(parts, model, 0.03, 0.05, topY + 0.1, 0.05, 0.05);
  // The head lamp rides on the fork, in front of the handlebar.
  for (const p of parts) {
    if (p.kind === 'headLeft' || p.kind === 'headRight') {
      p.y = topY + 0.2 * h + 0.06;
      p.z = forkZ - 0.04;
      p.sz = 0.06;
    }
  }
  return parts;
}

function atvParts(model: VehicleModel): CarPart[] {
  const { width: w, height: h, length: l, cabin } = model.body;
  const front = -l / 2 + LENS_DEPTH;
  const rear = l / 2 - LENS_DEPTH;
  const bottom = -h / 2;
  const lowerTop = bottom + 0.45 * h;
  const parts: CarPart[] = [part('body', -w / 2, w / 2, bottom, lowerTop, front, rear)];
  // Seat (cabin) over the middle, racks front and rear, a gauge behind the front rack.
  const seatZ = -l / 2 + ((cabin.start + cabin.end) / 2) * l;
  parts.push(boxAt('cabin', 0, lowerTop + 0.125 * h, seatZ, 0.4 * w, 0.25 * h, 0.35 * l));
  parts.push(part('trim', -0.45 * w, 0.45 * w, lowerTop, lowerTop + 0.04, front, front + 0.25 * l));
  parts.push(part('trim', -0.45 * w, 0.45 * w, lowerTop, lowerTop + 0.04, rear - 0.25 * l, rear));
  parts.push(boxAt('glass', 0, lowerTop + 0.025, front + 0.3 * l, 0.15, 0.05, 0.02));
  const lowerH = lowerTop - bottom;
  const lampW = Math.min(Math.max(w * 0.16, 0.2), 0.35);
  pushLamps(parts, model, w / 2 - 0.06 - lampW / 2, w / 2 - 0.06 - lampW / 2, bottom + Math.min(lowerH * 0.65, 0.6), lampW, Math.min(0.12, lowerH * 0.2));
  if (model.lightbar) {
    const half = 0.45 * w * 0.95;
    pushLenses(parts, LIGHTBAR_SEGMENTS, 0, -half, half, lowerTop + 0.04, lowerTop + 0.1, rear - 0.2, rear - 0.1);
  }
  return parts;
}

function boatParts(model: VehicleModel): CarPart[] {
  const { width: w, height: h, length: l } = model.body;
  const front = -l / 2 + LENS_DEPTH;
  const rear = l / 2 - LENS_DEPTH;
  const bottom = -h / 2;
  const hullTop = bottom + 0.55 * h;
  const c = cabinBox(model);
  const parts: CarPart[] = [];
  // Hull, with a narrower bow block at the front.
  parts.push(part('body', -w / 2, w / 2, bottom, hullTop, front + 0.15 * l, rear));
  parts.push(part('body', -0.35 * w, 0.35 * w, bottom, hullTop, front, front + 0.15 * l + 0.01));
  // Console with its windscreen band.
  const ch = c.top - hullTop;
  parts.push(part('cabin', -c.cx, c.cx, hullTop, c.top, c.z0, c.z1));
  const gx = c.cx + GLASS_OUT;
  parts.push(part('glass', -gx, gx, hullTop + ch * 0.12, c.top - ch * 0.15, c.z0 - GLASS_OUT, c.z1 + GLASS_OUT));
  pushLamps(parts, model, 0.25 * w, 0.38 * w, hullTop - 0.2, 0.3, 0.12);
  if (model.lightbar) pushRoofBar(parts, model);
  return parts;
}

function helicopterParts(model: VehicleModel): CarPart[] {
  const { width: w, height: h, length: l } = model.body;
  const front = -l / 2 + LENS_DEPTH;
  const rear = l / 2 - LENS_DEPTH;
  const belly = -h / 2 + 0.2 * h;
  const roofY = belly + 0.75 * h;
  const noseEnd = front + 0.42 * l;
  const parts: CarPart[] = [];
  // Fuselage, tail boom to the rear end, and a fin on top of the boom.
  parts.push(part('body', -w / 2, w / 2, belly, roofY, front, noseEnd));
  parts.push(part('body', -0.125 * w, 0.125 * w, belly + 0.4 * h, belly + 0.6 * h, noseEnd, rear));
  parts.push(part('cabin', -0.025, 0.025, h / 2 - 0.1 - 0.6 * h, h / 2 - 0.1, rear - 0.08 * l, rear));
  // Front bubble.
  parts.push(part('glass', -0.45 * w, 0.45 * w, roofY - 0.45 * h, roofY + GLASS_OUT, front - GLASS_OUT, front - GLASS_OUT + 0.12 * l));
  // Skids and struts.
  const skidZ0 = front + 0.02 * l;
  const skidZ1 = skidZ0 + 0.4 * l;
  for (const sx of [-1, 1]) {
    const x = sx * 0.4 * w;
    parts.push(part('trim', x - 0.04, x + 0.04, -h / 2, -h / 2 + 0.06, skidZ0, skidZ1));
    for (const f of [0.2, 0.8]) {
      const z = skidZ0 + f * (skidZ1 - skidZ0);
      parts.push(part('trim', x - 0.025, x + 0.025, -h / 2 + 0.06, belly, z - 0.025, z + 0.025));
    }
  }
  // Main rotor: a mast over the fuselage and two crossed blades (they sweep wider than the body).
  const mastZ = front + 0.3 * l;
  parts.push(part('trim', -0.08, 0.08, roofY, h / 2 - 0.03, mastZ - 0.08, mastZ + 0.08));
  parts.push(boxAt('rotor', 0, h / 2 - 0.015, mastZ, 0.12, 0.03, 0.95 * l));
  parts.push(boxAt('rotor', 0, h / 2 - 0.015, mastZ, 0.95 * l, 0.03, 0.12));
  pushLamps(parts, model, 0.5, 0.12, belly + 0.3 * h, 0.3, 0.15);
  for (const p of parts) if (p.kind === 'tailLeft' || p.kind === 'tailRight') {
    p.sx = 0.15;
    p.y = belly + 0.5 * h;
  }
  // Belly beacon: eight small lenses in a row under the fuselage.
  if (model.lightbar) {
    const z = (front + noseEnd) / 2;
    pushLenses(parts, LIGHTBAR_SEGMENTS, 0, -0.6, 0.6, belly - 0.05, belly, z - 0.05, z + 0.05);
  }
  return parts;
}

function droneParts(model: VehicleModel): CarPart[] {
  const { width: w, height: h, length: l } = model.body;
  const bottom = -h / 2;
  const parts: CarPart[] = [];
  parts.push(boxAt('body', 0, 0, 0, 0.3 * w, h, 0.3 * l));
  const arm = 0.3 * h;
  parts.push(boxAt('cabin', 0, 0, 0, w, arm, 0.06));
  parts.push(boxAt('cabin', 0, 0, 0, 0.06, arm, l));
  // Four rotor discs at the arm ends.
  const dy = arm / 2 + 0.005;
  const ex = w / 2 - 0.11;
  const ez = l / 2 - 0.11;
  parts.push(boxAt('rotor', ex, dy, 0, 0.22, 0.01, 0.22), boxAt('rotor', -ex, dy, 0, 0.22, 0.01, 0.22));
  parts.push(boxAt('rotor', 0, dy, ez, 0.22, 0.01, 0.22), boxAt('rotor', 0, dy, -ez, 0.22, 0.01, 0.22));
  // Camera under the front of the body.
  parts.push(part('glass', -0.04, 0.04, bottom, bottom + 0.08, -0.13, -0.05));
  // Lamps on the front / rear arm tips.
  pushLamps(parts, model, 0.04, 0.04, 0, 0.04, 0.04);
  return parts;
}

/**
 * Low-poly boxes for `model` by `body.style`.
 *
 * Car styles (sedan, hatchback, suv, pickup, van, truck, bus): a lower body (full length), a cabin from the cabin
 * fractions with a glass band around it, a full-height rear block for vans and trucks, four lamp lenses, for
 * light-bar models `LIGHTBAR_SEGMENTS` light-bar lenses on the roof (left to right), and for patrol equipment a
 * push bumper ('pushBar': a bar in front of the body below the lamps and two uprights) and a spotlight housing
 * ('spotHousing') at the driver A-pillar.
 *
 * Motorcycle, bicycle, ATV, boat, helicopter and drone have their own layouts (see the style builders); each has
 * a body, glass, four lamp lenses and, where the model has a light bar, `LIGHTBAR_SEGMENTS` lenses (segments 0-3
 * and 4-7 split front / rear on the motorcycle). Everything lies inside the body box except the roof light bar
 * (on top of it), the push bumper (in front of it) and the helicopter / drone 'rotor' parts (they sweep wider).
 */
export function buildCarParts(model: VehicleModel): CarPart[] {
  let parts: CarPart[];
  switch (model.body.style) {
    case 'motorcycle':
      parts = motorcycleParts(model);
      break;
    case 'bicycle':
      parts = bicycleParts(model);
      break;
    case 'atv':
      parts = atvParts(model);
      break;
    case 'boat':
      parts = boatParts(model);
      break;
    case 'helicopter':
      parts = helicopterParts(model);
      break;
    case 'drone':
      parts = droneParts(model);
      break;
    default:
      return carParts(model);
  }
  if (model.equipment?.spotlight) parts.push(spotlightHousing(model));
  return parts;
}

function carParts(model: VehicleModel): CarPart[] {
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
  pushLamps(parts, model, lampX, lampX, lampY, lampW, lampH);

  if (model.lightbar) pushRoofBar(parts, model);

  const equipment = model.equipment;
  if (equipment?.pushBumper) {
    const z1 = -l / 2 - BUMPER_OUT;
    const z0 = z1 - BUMPER_DEPTH;
    const barTop = lampY - lampH / 2 - 0.02;
    const barBottom = Math.max(bottom, barTop - 0.12);
    const barX = w * 0.38;
    parts.push(part('pushBar', -barX, barX, barBottom, barTop, z0, z1));
    // Uprights inboard of the head lamps, from the bar to the bonnet line.
    const upX = Math.min(w * 0.2, lampX - lampW / 2 - 0.06);
    for (const sx of [-1, 1]) {
      parts.push(part('pushBar', sx * upX - 0.035, sx * upX + 0.035, barBottom, lowerTop - 0.02, z0 + 0.01, z1 - 0.01));
    }
  }
  if (equipment?.spotlight) parts.push(spotlightHousing(model));
  return parts;
}

/**
 * One of the eight lenses of a hidden light bar (the livery's `hidden` style): segments 0-3 sit behind the
 * grille (x from -0.3w to 0.3w, at the head lamp height + 0.05, poking 0.01 m out of the front face), 4-7 at the
 * top of the rear window (y = roof - 0.08, just proud of the glass; at the rear face of vans and trucks). Size
 * 0.12 x 0.05 x 0.03. Pure; allocates one part.
 */
export function hiddenBarLens(model: VehicleModel, segment: number): CarPart {
  const { width: w, length: l, style } = model.body;
  const half = LIGHTBAR_SEGMENTS / 2;
  const s = Math.min(Math.max(Math.floor(segment), 0), LIGHTBAR_SEGMENTS - 1);
  const x = (-0.3 + (0.6 * (s % half)) / (half - 1)) * w;
  if (s < half) {
    const head = buildCarParts(model).find((p) => p.kind === 'headLeft');
    const y = (head?.y ?? 0) + 0.05;
    const lens = boxAt('lightbar', x, y, -l / 2 - 0.01 + HIDDEN_SZ / 2, HIDDEN_SX, HIDDEN_SY, HIDDEN_SZ);
    lens.segment = s;
    return lens;
  }
  const c = cabinBox(model);
  const z = style === 'van' || style === 'truck' ? l / 2 - 0.02 : c.z1 + 0.005;
  const lens = boxAt('lightbar', x, c.top - 0.08, z, HIDDEN_SX, HIDDEN_SY, HIDDEN_SZ);
  lens.segment = s;
  return lens;
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

/**
 * Two in-line wheels for motorcycles and bicycles: front (0, y, -wheelbase/2) then rear (0, y, +wheelbase/2), as
 * x, y, z triples into `out` (length >= 6). Same hub height as `wheelLocalPositions`.
 */
export function twoWheelPositions<T extends { [i: number]: number }>(model: VehicleModel, out: T): T {
  const { wheelbase, height, groundClearance } = model.body;
  const y = -(height / 2 + groundClearance) + model.tires.radius;
  for (let i = 0; i < 2; i++) {
    out[i * 3] = 0;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = (i === 0 ? -1 : 1) * (wheelbase / 2);
  }
  return out;
}
