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

export const VEHICLE_ROLES = ['police', 'civilian', 'commercial'] as const;
export type VehicleRole = (typeof VEHICLE_ROLES)[number];
export const BODY_STYLES = ['sedan', 'hatchback', 'suv', 'pickup', 'van', 'truck', 'bus'] as const;
export type BodyStyle = (typeof BODY_STYLES)[number];
export const DRIVE_TYPES = ['fwd', 'rwd', 'awd'] as const;
export type DriveType = (typeof DRIVE_TYPES)[number];

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
  /** Position in `VEHICLE_MODELS` (sorted by id); stored in `VehicleLook.model`. */
  readonly index: number;
  readonly id: string;
  readonly name: string;
  readonly role: VehicleRole;
  /** Relative spawn weight in traffic; 0 = never. */
  readonly trafficWeight: number;
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

  return {
    index,
    id: readString(root.id, source, 'id'),
    name: readString(root.name, source, 'name'),
    role: readOneOf(root.role, VEHICLE_ROLES, source, 'role'),
    trafficWeight: readNumber(root.trafficWeight, source, 'trafficWeight', 0),
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
  };
}

/** Parses a glob result (`path -> json`) into models sorted by id; `index` is the sorted position. */
export function loadVehicleModels(files: Record<string, unknown>): VehicleModel[] {
  const parsed = Object.entries(files).map(([path, json]) => {
    const source = path.slice(path.lastIndexOf('/') + 1);
    const model = parseVehicleModel(json, source);
    if (`${model.id}.json` !== source) fail(source, 'id', `must match the file name, got ${JSON.stringify(model.id)}`);
    return model;
  });
  parsed.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (parsed.length > 255) throw new Error(`Too many vehicle models (${parsed.length}); VehicleLook.model is a Uint8`);
  return parsed.map((model, index) => ({ ...model, index }));
}

/** Every shipped model, sorted by id. Adding a JSON file adds a model; no code change needed. */
export const VEHICLE_MODELS: readonly VehicleModel[] = loadVehicleModels(
  import.meta.glob<unknown>('../data/vehicles/*.json', { eager: true, import: 'default' }),
);

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
