import { RACK_ITEMS, SIREN_TONES } from '../../police/equipment';
import type { VehicleModel } from '../../vehicles/model';
import { cabinBox } from '../vehicles/carParts';

/** What the cockpit shows (design §12); built each frame by the integrator from equipment and radio state. */
export interface CockpitState {
  readonly sirenOn: boolean;
  /** `SIREN_TONES` index. */
  readonly tone: number;
  readonly horn: boolean;
  readonly lightsOn: boolean;
  /** `LIGHTBAR_PATTERNS` index (not shown yet; kept for the controller display). */
  readonly pattern: number;
  readonly spotOn: boolean;
  readonly rackLocked: boolean;
  /** Per `RACK_ITEMS` entry: the gun is in the rack. */
  readonly racked: readonly boolean[];
  readonly caged: boolean;
  readonly radioChannel: string;
  readonly radioTx: boolean;
  readonly radioRx: boolean;
  readonly scanning: boolean;
  readonly emergency: boolean;
}

/** The six cockpit meshes; each part belongs to exactly one. */
export type CockpitGroup = 'interior' | 'trim' | 'led' | 'screen' | 'radio' | 'cage';

export type CockpitPartKind =
  | 'floor'
  | 'roof'
  | 'door'
  | 'pillar'
  | 'dash'
  | 'console'
  | 'seat'
  | 'partition'
  | 'wheel'
  | 'hub'
  | 'column'
  | 'laptopMount'
  | 'laptopBase'
  | 'laptopLid'
  | 'screen'
  | 'radioHead'
  | 'radioDisplay'
  | 'sirenController'
  | 'led'
  | 'rackFrame'
  | 'gun'
  | 'cageBar';

/**
 * One cockpit box (or plane for 'screen'/'radioDisplay', ring for 'wheel') in the vehicle frame
 * (origin = body box centre, -Z front, -X left): centre, full size, and rotation as Euler angles in
 * 'YXZ' order (`ry` about up first, then `rx` about the part's own X). Planes face local +Z.
 */
export interface CockpitPart {
  readonly kind: CockpitPartKind;
  readonly group: CockpitGroup;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  readonly ry: number;
  readonly rx: number;
  /** 'led': `COCKPIT_LED` slot; 'gun': `RACK_ITEMS` index; otherwise 0. */
  readonly index: number;
}

/** LED slots on the siren controller: one per siren tone, then lights, horn, spotlight, rack, cage. */
export const LED_TONE_COUNT = SIREN_TONES.length;
export const COCKPIT_LED = {
  lights: LED_TONE_COUNT,
  horn: LED_TONE_COUNT + 1,
  spot: LED_TONE_COUNT + 2,
  rack: LED_TONE_COUNT + 3,
  cage: LED_TONE_COUNT + 4,
} as const;
export const LED_COUNT = LED_TONE_COUNT + 5;

/** LED colours (linear RGB). */
export const LED_RGB = {
  dim: [0.05, 0.05, 0.05],
  tone: [1, 0.6, 0.05],
  lights: [1, 0.08, 0.05],
  horn: [1, 0.6, 0.05],
  spot: [1, 1, 0.9],
  locked: [1, 0.08, 0.05],
  unlocked: [0.1, 1, 0.2],
  caged: [1, 0.55, 0.05],
} as const satisfies Record<string, readonly [number, number, number]>;

function setLed(out: Float32Array, slot: number, rgb: readonly [number, number, number]): void {
  out[slot * 3] = rgb[0];
  out[slot * 3 + 1] = rgb[1];
  out[slot * 3 + 2] = rgb[2];
}

/**
 * LED colours for `state` into `out` (`LED_COUNT * 3` floats, `COCKPIT_LED` order; allocation-free):
 * the active tone lit while the siren is on, lights/horn/spot lit while active, rack red when locked
 * and green when unlocked, cage lit while occupied; everything else dim.
 */
export function ledColors(state: CockpitState, out: Float32Array): Float32Array {
  for (let i = 0; i < LED_TONE_COUNT; i++) setLed(out, i, state.sirenOn && state.tone === i ? LED_RGB.tone : LED_RGB.dim);
  setLed(out, COCKPIT_LED.lights, state.lightsOn ? LED_RGB.lights : LED_RGB.dim);
  setLed(out, COCKPIT_LED.horn, state.horn ? LED_RGB.horn : LED_RGB.dim);
  setLed(out, COCKPIT_LED.spot, state.spotOn ? LED_RGB.spot : LED_RGB.dim);
  setLed(out, COCKPIT_LED.rack, state.rackLocked ? LED_RGB.locked : LED_RGB.unlocked);
  setLed(out, COCKPIT_LED.cage, state.caged ? LED_RGB.caged : LED_RGB.dim);
  return out;
}

/** Text of the radio head display (two lines joined by '\n'). Called only when an input changed. */
export function radioDisplayText(channel: string, tx: boolean, rx: boolean, scanning: boolean, emergency: boolean): string {
  const flags = [tx ? 'TX' : '', rx ? 'RX' : '', scanning ? 'SCAN' : '', emergency ? 'EMERG' : ''].filter((f) => f !== '');
  return `${channel.toUpperCase().slice(0, 12)}\n${flags.join(' ')}`;
}

/** Driver's eye in the vehicle frame; the same point as `cockpitCameraPose` (player/cameraRig.ts). */
export function driverEye(model: VehicleModel): { x: number; y: number; z: number } {
  const { width, height, length } = model.body;
  return { x: -width * 0.22, y: height * 0.2, z: -length * 0.05 };
}

/** Laptop yaw toward the driver (rad, screen normal turned toward -X) and lid tilt back from vertical. */
const LAPTOP_YAW = -0.7;
const LAPTOP_TILT = 0.25;
const WHEEL_TILT = -0.4;

/**
 * Cockpit geometry for `model` relative to the driver's eye: floor, roof liner, door panels and
 * A-pillars; dash ~0.55 m ahead of the eye with the steering wheel and column; centre console and
 * front seats; radio head and siren controller (with `LED_COUNT` LEDs) in the centre stack; the MDT
 * laptop on a console mount right of the driver, turned toward them (only with `equipment.mdt`);
 * the partition (lower panel and cage bars, at z = 0.15 length, only with `equipment.partition`);
 * and the long-gun rack between the seats against the partition with one gun per `RACK_ITEMS`
 * entry (only with `equipment.rack`). Every part lies inside the body box. Allocates; call once per
 * model.
 */
export function cockpitParts(model: VehicleModel): CockpitPart[] {
  const { width: w, height: h, length: l } = model.body;
  const eq = model.equipment;
  const c = cabinBox(model);
  const e = driverEye(model);
  const parts: CockpitPart[] = [];
  const add = (
    kind: CockpitPartKind,
    group: CockpitGroup,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    ry = 0,
    rx = 0,
    index = 0,
  ): void => {
    parts.push({ kind, group, x, y, z, sx, sy, sz, ry, rx, index });
  };
  /** Axis-aligned box from bounds. */
  const box = (kind: CockpitPartKind, group: CockpitGroup, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, index = 0): void =>
    add(kind, group, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, x1 - x0, y1 - y0, z1 - z0, 0, 0, index);

  const floorY = -h / 2 + 0.08;
  const dashBack = e.z - 0.55;
  const dashFront = Math.max(e.z - 0.95, -l / 2 + 0.1);
  const partitionZ = 0.15 * l;

  // Shell: the car body is not drawn from inside (back faces), so the cabin gets its own surfaces.
  box('floor', 'interior', -c.cx, c.cx, floorY - 0.03, floorY, c.z0, c.z1);
  box('roof', 'interior', -c.cx, c.cx, c.top - 0.04, c.top - 0.01, c.z0, c.z1);
  for (const s of [-1, 1]) {
    const x0 = w / 2 - 0.09;
    const x1 = w / 2 - 0.04;
    box('door', 'interior', s < 0 ? -x1 : x0, s < 0 ? -x0 : x1, floorY, c.lowerTop + 0.04, c.z0, c.z1);
    const px = c.cx - 0.04;
    box('pillar', 'interior', s * px - 0.03, s * px + 0.03, c.lowerTop, c.top - 0.02, c.z0, c.z0 + 0.07);
  }
  box('dash', 'interior', -c.cx + 0.02, c.cx - 0.02, e.y - 0.45, e.y - 0.13, dashFront, dashBack);
  box('console', 'interior', -0.13, 0.13, floorY, e.y - 0.4, dashBack, e.z + 0.45);
  for (const sx of [e.x, -e.x]) {
    box('seat', 'interior', sx - 0.25, sx + 0.25, e.y - 0.55, e.y + 0.12, e.z + 0.32, e.z + 0.44);
    box('seat', 'interior', sx - 0.25, sx + 0.25, e.y - 0.6, e.y - 0.48, e.z - 0.15, e.z + 0.32);
  }

  // Steering wheel (ring + hub) on a column into the dash, top tilted away from the driver.
  add('wheel', 'trim', e.x, e.y - 0.22, e.z - 0.38, 0.38, 0.38, 0.04, 0, WHEEL_TILT);
  add('hub', 'trim', e.x, e.y - 0.22, e.z - 0.38, 0.3, 0.045, 0.03, 0, WHEEL_TILT);
  add('column', 'trim', e.x, e.y - 0.27, e.z - 0.47, 0.06, 0.06, 0.18, 0, WHEEL_TILT);

  // Centre stack: radio head above the siren controller, protruding from the dash.
  const radioY = e.y - 0.24;
  box('radioHead', 'trim', -0.095, 0.095, radioY - 0.0275, radioY + 0.0275, dashBack, dashBack + 0.1);
  add('radioDisplay', 'radio', 0, radioY + 0.004, dashBack + 0.1015, 0.13, 0.03, 0);
  const sirenY = e.y - 0.33;
  box('sirenController', 'trim', -0.1, 0.1, sirenY - 0.035, sirenY + 0.035, dashBack, dashBack + 0.08);
  const ledZ = dashBack + 0.08 + 0.002;
  const row1 = LED_TONE_COUNT + 1;
  for (let i = 0; i < LED_COUNT; i++) {
    const first = i < row1;
    const n = first ? row1 : LED_COUNT - row1;
    const j = first ? i : i - row1;
    const x = (j - (n - 1) / 2) * 0.035;
    add('led', 'led', x, sirenY + (first ? 0.015 : -0.015), ledZ, 0.016, 0.016, 0.004, 0, 0, i);
  }

  if (eq?.mdt) {
    // Laptop on a console mount right of the driver, turned toward them; screen faces local +Z.
    const ax = 0.12;
    const ay = e.y - 0.17;
    const az = e.z - 0.32;
    const cy = Math.cos(LAPTOP_YAW);
    const sy = Math.sin(LAPTOP_YAW);
    const at = (lx: number, lz: number): [number, number] => [ax + lx * cy + lz * sy, az - lx * sy + lz * cy];
    const [mx, mz] = at(0, 0);
    box('laptopMount', 'trim', mx - 0.02, mx + 0.02, e.y - 0.4, ay - 0.0125, mz - 0.02, mz + 0.02);
    add('laptopBase', 'trim', ax, ay, az, 0.34, 0.025, 0.24, LAPTOP_YAW);
    const lidH = 0.23;
    const lidLy = 0.0125 + (lidH / 2) * Math.cos(LAPTOP_TILT);
    const lidLz = -0.12 - (lidH / 2) * Math.sin(LAPTOP_TILT);
    const [lx, lz] = at(0, lidLz);
    add('laptopLid', 'trim', lx, ay + lidLy, lz, 0.34, lidH, 0.015, LAPTOP_YAW, -LAPTOP_TILT);
    // Screen just in front of the lid along its normal (0, sin t, cos t) before the yaw.
    const off = 0.0085;
    const [sx, sz] = at(0, lidLz + off * Math.cos(LAPTOP_TILT));
    add('screen', 'screen', sx, ay + lidLy + off * Math.sin(LAPTOP_TILT), sz, 0.31, 0.2, 0, LAPTOP_YAW, -LAPTOP_TILT);
  }

  if (eq?.partition) {
    const barTop = c.top - 0.03;
    const panelTop = c.lowerTop - 0.05;
    box('partition', 'interior', -c.cx, c.cx, floorY, panelTop, partitionZ, partitionZ + 0.03);
    const t = 0.015;
    const z0 = partitionZ + 0.01;
    const span = c.cx - 0.03;
    const bars = Math.max(2, Math.round((2 * span) / 0.1));
    for (let i = 0; i <= bars; i++) {
      const x = -span + (2 * span * i) / bars;
      box('cageBar', 'cage', x - t / 2, x + t / 2, panelTop, barTop, z0, z0 + t);
    }
    for (let i = 0; i < 3; i++) {
      const y = panelTop + ((barTop - panelTop) * (i + 0.5)) / 3;
      box('cageBar', 'cage', -span, span, y - t / 2, y + t / 2, z0, z0 + t);
    }
  }

  if (eq?.rack) {
    const rz0 = partitionZ - 0.12;
    const rz1 = partitionZ - 0.02;
    const gunBottom = e.y - 0.37;
    const gunTop = Math.min(e.y + 0.3, c.top - 0.06);
    const n = RACK_ITEMS.length;
    const half = Math.max(0.12, (n * 0.09) / 2 + 0.03);
    box('rackFrame', 'trim', -half, half, e.y - 0.4, gunBottom, rz0, rz1);
    box('rackFrame', 'trim', -half, half, gunTop - 0.12, gunTop - 0.08, rz0, rz1);
    for (let i = 0; i < n; i++) {
      const x = (i - (n - 1) / 2) * 0.09;
      box('gun', 'cage', x - 0.025, x + 0.025, gunBottom, gunTop, rz0 + 0.015, rz0 + 0.085, i);
    }
  }
  return parts;
}
