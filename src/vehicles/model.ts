import { modOverlay } from '../mods/registry';
import type { VehicleEquipmentSpec } from '../police/equipment';
import {
  fail,
  readArray,
  readBoolean,
  readColor,
  readNumber,
  readObject,
  readOneOf,
  readString,
  readVersion,
  type JsonObject,
} from './json';

export const VEHICLE_ROLES = ['police', 'civilian', 'commercial', 'service'] as const;
export type VehicleRole = (typeof VEHICLE_ROLES)[number];
export const BODY_STYLES = [
  'sedan',
  'hatchback',
  'suv',
  'pickup',
  'van',
  'truck',
  'bus',
  'motorcycle',
  'bicycle',
  'atv',
  'boat',
  'helicopter',
  'drone',
] as const;
export type BodyStyle = (typeof BODY_STYLES)[number];
/** How a vehicle is driven: the ray-cast car, the ray-cast bike (upright assist), or a kinematic craft. */
export const CONTROL_KINDS = ['car', 'bike', 'boat', 'helicopter', 'drone'] as const;
export type ControlKind = (typeof CONTROL_KINDS)[number];
export const DRIVE_TYPES = ['fwd', 'rwd', 'awd'] as const;
export type DriveType = (typeof DRIVE_TYPES)[number];

/** Kinematic craft handling (boat, helicopter, drone); integrated by `craft.ts`. */
export interface CraftSpec {
  readonly maxSpeedMps: number;
  readonly reverseMps: number;
  readonly accelMps2: number;
  readonly brakeMps2: number;
  readonly turnRateDegS: number;
  readonly climbMps: number;
  readonly maxAltitudeM: number;
  /** Fraction of speed lost per second with no input. */
  readonly dragPerS: number;
  /** Visual pitch / roll at full speed / turn. */
  readonly tiltDeg: number;
  /** Leash from the anchor (drone); 0 = none. */
  readonly rangeM: number;
}

/** Two-wheeler tuning: the upright assist torque and the visual lean. */
export interface BikeSpec {
  /** N·m per rad per kg. */
  readonly uprightStiffness: number;
  /** N·m·s per rad per kg. */
  readonly uprightDamping: number;
  readonly maxLeanDeg: number;
  /** Bicycle: no fuel burn, the engine always runs. */
  readonly pedal: boolean;
}

/** Oil and tyre wear tuning (`wear.ts`). */
export interface WearSpec {
  /** Oil capacity (L). */
  readonly oilL: number;
  /** Litres burnt per kWh of engine work. */
  readonly oilPerKWh: number;
  /** Engine health lost per second running with empty oil. */
  readonly oilWearPerS: number;
  /** Tread lost per km per wheel. */
  readonly treadPerKm: number;
  /** Tread lost per second of a slipping wheel. */
  readonly treadSlipPerS: number;
  /** Grip factor of a bald tyre on a dry road. */
  readonly minTreadGrip: number;
  /** Extra grip a bald tyre loses at full wetness. */
  readonly wetTreadPenalty: number;
}

/** Cargo capacity of a vehicle (validated against loadouts by the gear module). */
export interface CargoSpec {
  readonly kg: number;
  readonly slots: number;
  readonly rackSlots: number;
}

/** Patrol extras: cage seats, drone bay, radar and kennel. */
export interface PatrolExtras {
  readonly cageSeats: number;
  readonly droneBay: boolean;
  readonly radar: boolean;
  readonly kennel: boolean;
}

/** Where an open vehicle shows its rider (vehicle-local feet point). */
export interface RiderSpec {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly pose: 'seated' | 'stand';
}

/** Defaults of a model without a `wear` section. */
export const DEFAULT_WEAR: WearSpec = {
  oilL: 6,
  oilPerKWh: 0.004,
  oilWearPerS: 0.002,
  treadPerKm: 0.0015,
  treadSlipPerS: 0.02,
  minTreadGrip: 0.75,
  wetTreadPenalty: 0.2,
};

const NO_CARGO: CargoSpec = { kg: 0, slots: 0, rackSlots: 0 };

export interface VehicleColor {
  readonly hex: string;
  /** Parsed `hex` as 0xRRGGBB (what `VehicleLook.color` stores). */
  readonly rgb: number;
  readonly weight: number;
}

/**
 * One vehicle model (`src/data/vehicles/<id>.json`, design §4.2). Units: metres, kg, N, kW, °C,
 * litres. Body dimensions describe the body box; `height` excludes the ground clearance.
 */
export interface VehicleModel {
  /** Position in `VEHICLE_MODELS` (sorted by `listOrder`, then id); stored in `VehicleLook.model`. */
  readonly index: number;
  readonly id: string;
  readonly name: string;
  readonly role: VehicleRole;
  /** Relative spawn weight in traffic; 0 = never. */
  readonly trafficWeight: number;
  /** List group (integer >= 0, default 0): models sort by `(listOrder, id)`, so later groups never move earlier indices. */
  readonly listOrder: number;
  readonly body: {
    readonly style: BodyStyle;
    readonly length: number;
    readonly width: number;
    readonly height: number;
    readonly groundClearance: number;
    readonly wheelbase: number;
    readonly track: number;
    /** Glasshouse: start/end as fractions of the length from the front, height and side inset in m. */
    readonly cabin: { readonly start: number; readonly end: number; readonly height: number; readonly inset: number };
  };
  readonly colors: readonly VehicleColor[];
  readonly lightbar: boolean;
  readonly mass: number;
  /** Centre of mass above the ground. */
  readonly comHeight: number;
  readonly engine: {
    /** Peak tractive force at the wheels (N). */
    readonly maxForce: number;
    readonly maxPowerKw: number;
    readonly maxSpeedKmh: number;
    readonly reverseMaxSpeedKmh: number;
    readonly idleRpm: number;
    readonly redlineRpm: number;
    readonly gearRatios: readonly number[];
    readonly finalDrive: number;
  };
  readonly drive: DriveType;
  readonly steering: { readonly maxAngleDeg: number; readonly highSpeedFactor: number; readonly rateDegPerS: number };
  /** Rapier ray-cast suspension tuning; stiffness and damping are per unit chassis mass. */
  readonly suspension: {
    readonly restLength: number;
    readonly stiffness: number;
    readonly compression: number;
    readonly relaxation: number;
    readonly maxTravel: number;
    /** Per wheel (N). */
    readonly maxForce: number;
  };
  /** `frictionSlip` is the peak tyre friction coefficient on dry asphalt at static load. */
  readonly tires: {
    readonly radius: number;
    readonly width: number;
    readonly frictionSlip: number;
    readonly sideStiffness: number;
    readonly loadSensitivity: number;
  };
  readonly brakes: BrakeSpec;
  readonly fuel: FuelSpec;
  readonly damage: DamageSpec;
  /** IDM parameters for ambient traffic (m/s²). */
  readonly traffic: { readonly maxAccel: number; readonly comfortDecel: number; readonly maxDecel: number };
  /** Patrol-car equipment (optional `equipment` JSON section, design §4.4); null for every other model. */
  readonly equipment: VehicleEquipmentSpec | null;
  /** JSON `control`, default 'car'. */
  readonly control: ControlKind;
  /** Required for boat / helicopter / drone, null otherwise. */
  readonly craft: CraftSpec | null;
  /** Required for `control: 'bike'`, null otherwise. */
  readonly bike: BikeSpec | null;
  readonly wear: WearSpec;
  readonly cargo: CargoSpec;
  readonly patrol: PatrolExtras;
  /** An open vehicle shows its rider at this point; null for enclosed vehicles. */
  readonly rider: RiderSpec | null;
}

export interface BrakeSpec {
  /** Total service-brake force at full pedal and full efficiency (N). */
  readonly maxForce: number;
  readonly frontBias: number;
  readonly abs: boolean;
  /** Total handbrake force on the rear axle (N). */
  readonly handbrakeForce: number;
  /** °C per kJ dissipated by one axle. */
  readonly heatPerKJ: number;
  /** Newtonian cooling rate toward ambient (1/s) plus a per-(m/s) airflow term. */
  readonly coolingPerS: number;
  readonly airflowCooling: number;
  readonly fadeStartC: number;
  readonly fadeEndC: number;
  readonly minEfficiency: number;
}

export interface FuelSpec {
  readonly capacityL: number;
  readonly idleLph: number;
  readonly litersPerKWh: number;
}

export interface DamageSpec {
  readonly minImpactSpeed: number;
  /** Impact speed (m/s) that fully damages a zone. */
  readonly zoneStrength: number;
  readonly engineFrontShare: number;
  readonly tireBurstSpeed: number;
  readonly stallBelow: number;
  readonly stallChancePerS: number;
  readonly failBelow: number;
  /**
   * Front-zone strength with a push bumper (`zoneStrength * pushBumper.frontStrength`); absent without
   * one, when front hits use `zoneStrength`.
   */
  readonly frontZoneStrength?: number;
  /** Engine share of front hits with a push bumper (`engineFrontShare * pushBumper.engineShare`); absent without one. */
  readonly frontEngineShare?: number;
}

type Ranges<K extends string> = Record<K, readonly [number, number]>;

const POS = [1e-6, Infinity] as const;
const UNIT = [0, 1] as const;
const NONNEG = [0, Infinity] as const;

function readNumbers<K extends string>(obj: JsonObject, ranges: Ranges<K>, source: string, path: string): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const key of Object.keys(ranges) as K[]) {
    const [min, max] = ranges[key];
    out[key] = readNumber(obj[key], source, `${path}.${key}`, min, max);
  }
  return out;
}

function section(root: JsonObject, key: string, source: string): JsonObject {
  return readObject(root[key], source, key);
}

function readListOrder(value: unknown, source: string): number {
  const n = readNumber(value, source, 'listOrder', 0);
  if (!Number.isInteger(n)) fail(source, 'listOrder', `must be an integer, got ${n}`);
  return n;
}

/** Parses the optional `equipment` section; null when absent. */
function parseEquipment(value: unknown, source: string): VehicleEquipmentSpec | null {
  if (value === undefined) return null;
  const eq = readObject(value, source, 'equipment');
  const bumper =
    eq.pushBumper === undefined
      ? null
      : readNumbers(
          readObject(eq.pushBumper, source, 'equipment.pushBumper'),
          { frontStrength: POS, engineShare: UNIT },
          source,
          'equipment.pushBumper',
        );
  return {
    pushBumper: bumper,
    partition: readBoolean(eq.partition, source, 'equipment.partition'),
    rack: readBoolean(eq.rack, source, 'equipment.rack'),
    spotlight: readBoolean(eq.spotlight, source, 'equipment.spotlight'),
    mdt: readBoolean(eq.mdt, source, 'equipment.mdt'),
    trunk: eq.trunk === null ? null : readString(eq.trunk, source, 'equipment.trunk'),
  };
}


const CRAFT_CONTROLS: readonly ControlKind[] = ['boat', 'helicopter', 'drone'];

function readInteger(value: unknown, source: string, path: string, min: number, max = Infinity): number {
  const n = readNumber(value, source, path, min, max);
  if (!Number.isInteger(n)) fail(source, path, `must be an integer, got ${n}`);
  return n;
}

function parseCraft(value: unknown, source: string): CraftSpec {
  return readNumbers(
    readObject(value, source, 'craft'),
    {
      maxSpeedMps: POS,
      reverseMps: NONNEG,
      accelMps2: POS,
      brakeMps2: POS,
      turnRateDegS: POS,
      climbMps: NONNEG,
      maxAltitudeM: NONNEG,
      dragPerS: [0, 5],
      tiltDeg: [0, 45],
      rangeM: NONNEG,
    },
    source,
    'craft',
  );
}

function parseBike(value: unknown, source: string): BikeSpec {
  const obj = readObject(value, source, 'bike');
  return {
    ...readNumbers(obj, { uprightStiffness: POS, uprightDamping: NONNEG, maxLeanDeg: [0, 60] }, source, 'bike'),
    pedal: readBoolean(obj.pedal, source, 'bike.pedal'),
  };
}

/** Optional `wear`: any key left out keeps its `DEFAULT_WEAR` value. */
function parseWear(value: unknown, source: string): WearSpec {
  if (value === undefined) return DEFAULT_WEAR;
  const obj = readObject(value, source, 'wear');
  const merged: JsonObject = { ...DEFAULT_WEAR };
  for (const key of Object.keys(DEFAULT_WEAR)) if (obj[key] !== undefined) merged[key] = obj[key];
  return readNumbers(
    merged,
    {
      oilL: POS,
      oilPerKWh: NONNEG,
      oilWearPerS: NONNEG,
      treadPerKm: NONNEG,
      treadSlipPerS: NONNEG,
      minTreadGrip: UNIT,
      wetTreadPenalty: UNIT,
    },
    source,
    'wear',
  );
}

function parseCargo(value: unknown, source: string): CargoSpec {
  if (value === undefined) return NO_CARGO;
  const obj = readObject(value, source, 'cargo');
  return {
    kg: readNumber(obj.kg, source, 'cargo.kg', 0),
    slots: readInteger(obj.slots, source, 'cargo.slots', 0),
    rackSlots: readInteger(obj.rackSlots, source, 'cargo.rackSlots', 0),
  };
}

function parsePatrol(value: unknown, source: string, equipment: VehicleEquipmentSpec | null): PatrolExtras {
  const obj = value === undefined ? {} : readObject(value, source, 'patrol');
  return {
    cageSeats: obj.cageSeats === undefined ? (equipment?.partition ? 1 : 0) : readInteger(obj.cageSeats, source, 'patrol.cageSeats', 0, 8),
    droneBay: obj.droneBay === undefined ? false : readBoolean(obj.droneBay, source, 'patrol.droneBay'),
    radar: obj.radar === undefined ? false : readBoolean(obj.radar, source, 'patrol.radar'),
    kennel: obj.kennel === undefined ? false : readBoolean(obj.kennel, source, 'patrol.kennel'),
  };
}

function parseRider(value: unknown, source: string): RiderSpec | null {
  if (value === undefined) return null;
  const obj = readObject(value, source, 'rider');
  return {
    ...readNumbers(obj, { x: [-100, 100], y: [-100, 100], z: [-100, 100] }, source, 'rider'),
    pose: readOneOf(obj.pose, ['seated', 'stand'] as const, source, 'rider.pose'),
  };
}

/** Damage spec with or without the model's push bumper (no front fields when `pushBar` is false or the model has none). */
export function damageSpecFor(model: VehicleModel, pushBar: boolean): DamageSpec {
  const d = model.damage;
  if (pushBar || (d.frontZoneStrength === undefined && d.frontEngineShare === undefined)) return d;
  return {
    minImpactSpeed: d.minImpactSpeed,
    zoneStrength: d.zoneStrength,
    engineFrontShare: d.engineFrontShare,
    tireBurstSpeed: d.tireBurstSpeed,
    stallBelow: d.stallBelow,
    stallChancePerS: d.stallChancePerS,
    failBelow: d.failBelow,
  };
}

/** True for boat / helicopter / drone (kinematic crafts). */
export function isCraft(model: VehicleModel): boolean {
  return model.craft !== null;
}

/** 'four' (cars, ATV), 'two' (motorcycle, bicycle), 'none' (crafts). */
export function wheelLayout(model: VehicleModel): 'four' | 'two' | 'none' {
  if (model.craft !== null) return 'none';
  return model.body.style === 'motorcycle' || model.body.style === 'bicycle' ? 'two' : 'four';
}

/** Validates one model file; throws a readable error naming `source` and the field. */
export function parseVehicleModel(json: unknown, source: string, index = 0): VehicleModel {
  const root = readObject(json, source, '');
  readVersion(root, source);

  const bodyJson = section(root, 'body', source);
  const body = {
    style: readOneOf(bodyJson.style, BODY_STYLES, source, 'body.style'),
    ...readNumbers(
      bodyJson,
      { length: POS, width: POS, height: POS, groundClearance: [0, 3], wheelbase: POS, track: POS },
      source,
      'body',
    ),
    cabin: readNumbers(
      readObject(bodyJson.cabin, source, 'body.cabin'),
      { start: UNIT, end: UNIT, height: NONNEG, inset: NONNEG },
      source,
      'body.cabin',
    ),
  };
  if (body.wheelbase >= body.length) fail(source, 'body.wheelbase', `must be shorter than body.length (${body.length})`);
  if (body.track >= body.width) fail(source, 'body.track', `must be narrower than body.width (${body.width})`);
  if (body.cabin.start >= body.cabin.end) fail(source, 'body.cabin.start', 'must be less than body.cabin.end');

  const colors = readArray(root.colors, source, 'colors', 1).map((item, i) => {
    const c = readObject(item, source, `colors[${i}]`);
    const hex = readString(c.hex, source, `colors[${i}].hex`);
    return {
      hex,
      rgb: readColor(hex, source, `colors[${i}].hex`),
      weight: readNumber(c.weight, source, `colors[${i}].weight`, 1e-6),
    };
  });

  const engineJson = section(root, 'engine', source);
  const engine = {
    ...readNumbers(
      engineJson,
      {
        maxForce: POS,
        maxPowerKw: POS,
        maxSpeedKmh: POS,
        reverseMaxSpeedKmh: POS,
        idleRpm: POS,
        redlineRpm: POS,
        finalDrive: POS,
      },
      source,
      'engine',
    ),
    gearRatios: readArray(engineJson.gearRatios, source, 'engine.gearRatios', 1).map((r, i) =>
      readNumber(r, source, `engine.gearRatios[${i}]`, 1e-6),
    ),
  };
  if (engine.redlineRpm <= engine.idleRpm) fail(source, 'engine.redlineRpm', 'must be above engine.idleRpm');

  const brakesJson = section(root, 'brakes', source);
  const brakes = {
    ...readNumbers(
      brakesJson,
      {
        maxForce: POS,
        frontBias: UNIT,
        handbrakeForce: NONNEG,
        heatPerKJ: NONNEG,
        coolingPerS: NONNEG,
        airflowCooling: NONNEG,
        fadeStartC: [-100, 2000],
        fadeEndC: [-100, 2000],
        minEfficiency: UNIT,
      },
      source,
      'brakes',
    ),
    abs: readBoolean(brakesJson.abs, source, 'brakes.abs'),
  };
  if (brakes.fadeEndC <= brakes.fadeStartC) fail(source, 'brakes.fadeEndC', 'must be above brakes.fadeStartC');

  const comHeight = readNumber(root.comHeight, source, 'comHeight', 0);
  if (comHeight >= body.groundClearance + body.height) fail(source, 'comHeight', 'must be below the roof');

  const equipment = parseEquipment(root.equipment, source);
  const damage: DamageSpec = readNumbers(
    section(root, 'damage', source),
    {
      minImpactSpeed: POS,
      zoneStrength: POS,
      engineFrontShare: NONNEG,
      tireBurstSpeed: POS,
      stallBelow: UNIT,
      stallChancePerS: NONNEG,
      failBelow: UNIT,
    },
    source,
    'damage',
  );
  const bumper = equipment?.pushBumper ?? null;

  const control = root.control === undefined ? 'car' : readOneOf(root.control, CONTROL_KINDS, source, 'control');
  const needsCraft = CRAFT_CONTROLS.includes(control);
  if (needsCraft && root.craft === undefined) fail(source, 'craft', `is required for control "${control}"`);
  if (!needsCraft && root.craft !== undefined) fail(source, 'craft', `is only allowed for control boat, helicopter or drone, not "${control}"`);
  if (control === 'bike' && root.bike === undefined) fail(source, 'bike', 'is required for control "bike"');
  if (control !== 'bike' && root.bike !== undefined) fail(source, 'bike', `is only allowed for control "bike", not "${control}"`);

  return {
    index,
    id: readString(root.id, source, 'id'),
    name: readString(root.name, source, 'name'),
    role: readOneOf(root.role, VEHICLE_ROLES, source, 'role'),
    trafficWeight: readNumber(root.trafficWeight, source, 'trafficWeight', 0),
    listOrder: root.listOrder === undefined ? 0 : readListOrder(root.listOrder, source),
    body,
    colors,
    lightbar: readBoolean(root.lightbar, source, 'lightbar'),
    mass: readNumber(root.mass, source, 'mass', 1),
    comHeight,
    engine,
    drive: readOneOf(root.drive, DRIVE_TYPES, source, 'drive'),
    steering: readNumbers(
      section(root, 'steering', source),
      { maxAngleDeg: [1, 80], highSpeedFactor: UNIT, rateDegPerS: POS },
      source,
      'steering',
    ),
    suspension: readNumbers(
      section(root, 'suspension', source),
      { restLength: POS, stiffness: POS, compression: NONNEG, relaxation: NONNEG, maxTravel: POS, maxForce: POS },
      source,
      'suspension',
    ),
    tires: readNumbers(
      section(root, 'tires', source),
      { radius: POS, width: POS, frictionSlip: POS, sideStiffness: NONNEG, loadSensitivity: UNIT },
      source,
      'tires',
    ),
    brakes,
    fuel: readNumbers(
      section(root, 'fuel', source),
      { capacityL: POS, idleLph: NONNEG, litersPerKWh: NONNEG },
      source,
      'fuel',
    ),
    damage:
      bumper === null
        ? damage
        : {
            ...damage,
            frontZoneStrength: damage.zoneStrength * bumper.frontStrength,
            frontEngineShare: damage.engineFrontShare * bumper.engineShare,
          },
    traffic: readNumbers(
      section(root, 'traffic', source),
      { maxAccel: POS, comfortDecel: POS, maxDecel: POS },
      source,
      'traffic',
    ),
    equipment,
    control,
    craft: needsCraft ? parseCraft(root.craft, source) : null,
    bike: control === 'bike' ? parseBike(root.bike, source) : null,
    wear: parseWear(root.wear, source),
    cargo: parseCargo(root.cargo, source),
    patrol: parsePatrol(root.patrol, source, equipment),
    rider: parseRider(root.rider, source),
  };
}

/**
 * Parses a glob result (`path -> json`) into models sorted by `(listOrder, id)`; `index` is `firstIndex` plus the sorted
 * position (mod models continue after the base table, so base indices never change).
 */
export function loadVehicleModels(files: Record<string, unknown>, firstIndex = 0): VehicleModel[] {
  const parsed = Object.entries(files).map(([path, json]) => {
    const source = path.slice(path.lastIndexOf('/') + 1);
    const model = parseVehicleModel(json, source);
    if (`${model.id}.json` !== source) fail(source, 'id', `must match the file name, got ${JSON.stringify(model.id)}`);
    return model;
  });
  parsed.sort((a, b) => a.listOrder - b.listOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (firstIndex + parsed.length > 255) throw new Error(`Too many vehicle models (${firstIndex + parsed.length}); VehicleLook.model is a Uint8`);
  return parsed.map((model, index) => ({ ...model, index: firstIndex + index }));
}

/** The shipped models followed by the active mods' models (`<id>.json` files; a duplicate id throws). */
function loadAllVehicleModels(): VehicleModel[] {
  const base = loadVehicleModels(import.meta.glob<unknown>('../data/vehicles/*.json', { eager: true, import: 'default' }));
  const mods = modOverlay().vehicles;
  if (mods.length === 0) return base;
  const files: Record<string, unknown> = {};
  for (const { file, json } of mods) files[file] = json;
  const extra = loadVehicleModels(files, base.length);
  const ids = new Set(base.map((m) => m.id));
  for (const m of extra) {
    if (ids.has(m.id)) fail(`${m.id}.json`, 'id', `duplicates the vehicle model ${JSON.stringify(m.id)}`);
    ids.add(m.id);
  }
  return [...base, ...extra];
}

/** Every shipped model, sorted by `(listOrder, id)`. Adding a JSON file adds a model; no code change needed. */
export const VEHICLE_MODELS: readonly VehicleModel[] = loadAllVehicleModels();

/** Models that appear in ambient traffic (`trafficWeight > 0`), in `VEHICLE_MODELS` order. */
export const TRAFFIC_MODELS: readonly VehicleModel[] = VEHICLE_MODELS.filter((m) => m.trafficWeight > 0);

/** Model by id; throws on an unknown id. */
export function vehicleModel(id: string): VehicleModel {
  const model = VEHICLE_MODELS.find((m) => m.id === id);
  if (!model) throw new Error(`Unknown vehicle model "${id}"`);
  return model;
}

/** Height of the body-box centre (the entity origin) above the ground at rest. */
export function restHeight(model: VehicleModel): number {
  return model.body.groundClearance + model.body.height / 2;
}

/** Weighted colour pick for `u` in [0, 1) (pass an `Rng.next()` draw); returns 0xRRGGBB. */
export function pickModelColor(model: VehicleModel, u: number): number {
  let total = 0;
  for (const c of model.colors) total += c.weight;
  let x = u * total;
  for (const c of model.colors) {
    x -= c.weight;
    if (x < 0) return c.rgb;
  }
  return model.colors[model.colors.length - 1]?.rgb ?? 0;
}
