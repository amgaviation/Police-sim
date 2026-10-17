import districtsJson from '../data/world/districts.json';
import districtTypesJson from '../data/world/districtTypes.json';
import landmarksJson from '../data/world/landmarks.json';
import roadClassesJson from '../data/world/roadClasses.json';
import streetNamesJson from '../data/world/streetNames.json';
import zonesJson from '../data/world/zones.json';
import { CELLS_PER_SIDE, DISTRICT_CELL, WORLD_HALF_SIZE } from './constants';
import {
  DISTRICT,
  DISTRICT_NAMES,
  ROAD_CLASS,
  ROAD_CLASS_NAMES,
  SURFACE,
  type DistrictId,
  type RoadClassId,
  type RoadClassName,
  type SurfaceId,
} from './ids';

// --- Validated shapes ------------------------------------------------------------

export interface HighwayDef {
  readonly name: string;
  /** 'x' runs east-west at z = coord; 'z' runs north-south at x = coord. */
  readonly axis: 'x' | 'z';
  readonly coord: number;
  readonly from: number;
  readonly to: number;
}

export interface DistrictsData {
  readonly cellSize: number;
  /** District id per cell, row-major, row 0 = north, col 0 = west. */
  readonly cells: Uint8Array;
  readonly highways: readonly HighwayDef[];
}

export type RoofStyle = 'flat' | 'pitched' | 'mixed';

export interface DistrictTypeDef {
  readonly subdivisions: number;
  readonly jitter: number;
  readonly oneWayPairs: boolean;
  readonly removeLocalFraction: number;
  readonly ground: SurfaceId;
  readonly sidewalk: boolean;
  readonly trafficDensity: number;
  readonly buildings: {
    readonly lotFrontage: readonly [number, number];
    readonly lotDepth: readonly [number, number];
    readonly setback: number;
    readonly coverage: number;
    readonly height: readonly [number, number];
    readonly centerBoost: number;
    readonly roof: RoofStyle;
    /** 0xRRGGBB colours. */
    readonly palette: readonly number[];
  };
  readonly props: {
    /** 0 = streetlights at junctions only. */
    readonly streetlightSpacing: number;
    readonly treesPer1000m2: number;
    /** 0 = none. */
    readonly hydrantSpacing: number;
    /** 0 = none. */
    readonly benchSpacing: number;
  };
}

export interface RoadClassDef {
  /** Lanes per direction. */
  readonly lanes: number;
  readonly laneWidth: number;
  readonly median: number;
  readonly shoulder: number;
  readonly sidewalk: number;
  readonly speedMph: number;
  readonly surface: SurfaceId;
  /** Relative green-time weight of an approach of this class at a signal. */
  readonly signalWeight: number;
}

export interface RoadClassesData {
  /** Indexed by RoadClassId. */
  readonly classes: readonly RoadClassDef[];
  /** [district][class] speed override in mph, 0 = none. */
  readonly districtSpeedMph: readonly (readonly number[])[];
  readonly signals: {
    readonly yellow: number;
    readonly allRed: number;
    readonly minGreen: number;
    /** Cycle length (s) per RoadClassId, 0 when the class has no entry. */
    readonly cycle: readonly number[];
  };
}

export interface ZonesData {
  readonly schoolZone: {
    readonly limitMph: number;
    /** [startHour, endHour) windows of game time. */
    readonly windows: readonly (readonly [number, number])[];
    readonly weekdaysOnly: boolean;
    readonly radius: number;
    readonly schoolsPerSuburbCell: number;
  };
  readonly construction: {
    readonly edgeFraction: number;
    readonly limitReductionMph: number;
    readonly minLimitMph: number;
    readonly classes: readonly RoadClassId[];
  };
}

export interface LandmarksData {
  readonly station: { readonly x: number; readonly z: number; readonly yaw: number };
  readonly fuelStationsPerHighwayCell: number;
  readonly fuelStationsPerUrbanCell: number;
}

export interface StreetNamesData {
  readonly words: readonly string[];
  /** Suffix per RoadClassId. */
  readonly suffix: readonly string[];
}

// --- Validation helpers -------------------------------------------------------------

type Obj = Record<string, unknown>;

function fail(file: string, field: string, message: string): never {
  throw new Error(`${file}: ${field} ${message}`);
}

function asObj(value: unknown, file: string, field: string): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(file, field, 'must be an object');
  return value as Obj;
}

function asArr(value: unknown, file: string, field: string): unknown[] {
  if (!Array.isArray(value)) fail(file, field, 'must be an array');
  return value;
}

function asNum(value: unknown, file: string, field: string, min = -Infinity, max = Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(file, field, 'must be a finite number');
  if (value < min || value > max) fail(file, field, `must be in [${min}, ${max}]`);
  return value;
}

function asInt(value: unknown, file: string, field: string, min: number, max: number): number {
  const n = asNum(value, file, field, min, max);
  if (!Number.isInteger(n)) fail(file, field, 'must be an integer');
  return n;
}

function asStr(value: unknown, file: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(file, field, 'must be a non-empty string');
  return value;
}

function asBool(value: unknown, file: string, field: string): boolean {
  if (typeof value !== 'boolean') fail(file, field, 'must be a boolean');
  return value;
}

function asRange(value: unknown, file: string, field: string): [number, number] {
  const arr = asArr(value, file, field);
  if (arr.length !== 2) fail(file, field, 'must be a [min, max] pair');
  const lo = asNum(arr[0], file, `${field}[0]`, 0);
  const hi = asNum(arr[1], file, `${field}[1]`, 0);
  if (hi < lo) fail(file, field, 'must have min <= max');
  return [lo, hi];
}

function checkVersion(root: Obj, file: string): void {
  if (root.version !== 1) fail(file, 'version', 'must be 1');
}

function asEnum<T extends string>(value: unknown, file: string, field: string, names: readonly T[]): T {
  const s = asStr(value, file, field);
  if (!(names as readonly string[]).includes(s)) fail(file, field, `must be one of ${names.join(', ')}`);
  return s as T;
}

const SURFACE_KEYS = Object.keys(SURFACE) as (keyof typeof SURFACE)[];

function asSurface(value: unknown, file: string, field: string): SurfaceId {
  return SURFACE[asEnum(value, file, field, SURFACE_KEYS)];
}

function asHexColor(value: unknown, file: string, field: string): number {
  const s = asStr(value, file, field);
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) fail(file, field, 'must be a #rrggbb colour');
  return parseInt(s.slice(1), 16);
}

// --- Validators -------------------------------------------------------------------------

/** Validates `districts.json`: 14 x 14 rows, every letter in the legend, highways inside the world. */
export function validateDistricts(raw: unknown): DistrictsData {
  const file = 'districts.json';
  const root = asObj(raw, file, '(root)');
  checkVersion(root, file);
  const cellSize = asNum(root.cellSize, file, 'cellSize');
  if (cellSize !== DISTRICT_CELL) fail(file, 'cellSize', `must be ${DISTRICT_CELL}`);
  const legendObj = asObj(root.legend, file, 'legend');
  const legend = new Map<string, DistrictId>();
  for (const [letter, name] of Object.entries(legendObj)) {
    if (letter.length !== 1) fail(file, `legend.${letter}`, 'key must be a single character');
    legend.set(letter, DISTRICT[asEnum(name, file, `legend.${letter}`, DISTRICT_NAMES)]);
  }
  const rows = asArr(root.rows, file, 'rows');
  if (rows.length !== CELLS_PER_SIDE) fail(file, 'rows', `must have ${CELLS_PER_SIDE} rows`);
  const cells = new Uint8Array(CELLS_PER_SIDE * CELLS_PER_SIDE);
  rows.forEach((row, r) => {
    const s = asStr(row, file, `rows[${r}]`);
    if (s.length !== CELLS_PER_SIDE) fail(file, `rows[${r}]`, `must have ${CELLS_PER_SIDE} characters`);
    for (let c = 0; c < CELLS_PER_SIDE; c++) {
      const id = legend.get(s.charAt(c));
      if (id === undefined) fail(file, `rows[${r}][${c}]`, `letter '${s.charAt(c)}' is not in the legend`);
      cells[r * CELLS_PER_SIDE + c] = id;
    }
  });
  const highways = asArr(root.highways, file, 'highways').map((h, i): HighwayDef => {
    const field = `highways[${i}]`;
    const o = asObj(h, file, field);
    const from = asNum(o.from, file, `${field}.from`, -WORLD_HALF_SIZE, WORLD_HALF_SIZE);
    const to = asNum(o.to, file, `${field}.to`, -WORLD_HALF_SIZE, WORLD_HALF_SIZE);
    if (!(to > from)) fail(file, `${field}.to`, 'must be greater than from');
    return {
      name: asStr(o.name, file, `${field}.name`),
      axis: asEnum(o.axis, file, `${field}.axis`, ['x', 'z'] as const),
      coord: asNum(o.coord, file, `${field}.coord`, -WORLD_HALF_SIZE, WORLD_HALF_SIZE),
      from,
      to,
    };
  });
  return { cellSize, cells, highways };
}

/** Validates `districtTypes.json`; every district name must be present. Result is indexed by DistrictId. */
export function validateDistrictTypes(raw: unknown): DistrictTypeDef[] {
  const file = 'districtTypes.json';
  const root = asObj(raw, file, '(root)');
  checkVersion(root, file);
  const types = asObj(root.types, file, 'types');
  return DISTRICT_NAMES.map((name): DistrictTypeDef => {
    const f = `types.${name}`;
    if (!(name in types)) fail(file, f, 'is missing');
    const t = asObj(types[name], file, f);
    const b = asObj(t.buildings, file, `${f}.buildings`);
    const p = asObj(t.props, file, `${f}.props`);
    const palette = asArr(b.palette, file, `${f}.buildings.palette`).map((c, i) =>
      asHexColor(c, file, `${f}.buildings.palette[${i}]`),
    );
    if (palette.length === 0) fail(file, `${f}.buildings.palette`, 'must not be empty');
    return {
      subdivisions: asInt(t.subdivisions, file, `${f}.subdivisions`, 0, 8),
      jitter: asNum(t.jitter, file, `${f}.jitter`, 0, 0.3),
      oneWayPairs: asBool(t.oneWayPairs, file, `${f}.oneWayPairs`),
      removeLocalFraction: asNum(t.removeLocalFraction, file, `${f}.removeLocalFraction`, 0, 1),
      ground: asSurface(t.ground, file, `${f}.ground`),
      sidewalk: asBool(t.sidewalk, file, `${f}.sidewalk`),
      trafficDensity: asNum(t.trafficDensity, file, `${f}.trafficDensity`, 0),
      buildings: {
        lotFrontage: asRange(b.lotFrontage, file, `${f}.buildings.lotFrontage`),
        lotDepth: asRange(b.lotDepth, file, `${f}.buildings.lotDepth`),
        setback: asNum(b.setback, file, `${f}.buildings.setback`, 0),
        coverage: asNum(b.coverage, file, `${f}.buildings.coverage`, 0, 1),
        height: asRange(b.height, file, `${f}.buildings.height`),
        centerBoost: asNum(b.centerBoost, file, `${f}.buildings.centerBoost`, 1),
        roof: asEnum(b.roof, file, `${f}.buildings.roof`, ['flat', 'pitched', 'mixed'] as const),
        palette,
      },
      props: {
        streetlightSpacing: asNum(p.streetlightSpacing, file, `${f}.props.streetlightSpacing`, 0),
        treesPer1000m2: asNum(p.treesPer1000m2, file, `${f}.props.treesPer1000m2`, 0, 10),
        hydrantSpacing: asNum(p.hydrantSpacing, file, `${f}.props.hydrantSpacing`, 0),
        benchSpacing: asNum(p.benchSpacing, file, `${f}.props.benchSpacing`, 0),
      },
    };
  });
}

/** Validates `roadClasses.json`; every road class must be present. */
export function validateRoadClasses(raw: unknown): RoadClassesData {
  const file = 'roadClasses.json';
  const root = asObj(raw, file, '(root)');
  checkVersion(root, file);
  const classesObj = asObj(root.classes, file, 'classes');
  const classes = ROAD_CLASS_NAMES.map((name): RoadClassDef => {
    const f = `classes.${name}`;
    if (!(name in classesObj)) fail(file, f, 'is missing');
    const c = asObj(classesObj[name], file, f);
    return {
      lanes: asInt(c.lanes, file, `${f}.lanes`, 1, 4),
      laneWidth: asNum(c.laneWidth, file, `${f}.laneWidth`, 2, 5),
      median: asNum(c.median, file, `${f}.median`, 0, 20),
      shoulder: asNum(c.shoulder, file, `${f}.shoulder`, 0, 5),
      sidewalk: asNum(c.sidewalk, file, `${f}.sidewalk`, 0, 6),
      speedMph: asNum(c.speedMph, file, `${f}.speedMph`, 5, 85),
      surface: asSurface(c.surface, file, `${f}.surface`),
      signalWeight: asNum(c.signalWeight, file, `${f}.signalWeight`, 0.1, 10),
    };
  });
  const dsObj = asObj(root.districtSpeedMph, file, 'districtSpeedMph');
  const districtSpeedMph = DISTRICT_NAMES.map(() => ROAD_CLASS_NAMES.map(() => 0));
  for (const [district, entry] of Object.entries(dsObj)) {
    const d = DISTRICT[asEnum(district, file, `districtSpeedMph.${district}`, DISTRICT_NAMES)];
    for (const [cls, mph] of Object.entries(asObj(entry, file, `districtSpeedMph.${district}`))) {
      const field = `districtSpeedMph.${district}.${cls}`;
      const c = ROAD_CLASS[asEnum(cls, file, field, ROAD_CLASS_NAMES)];
      (districtSpeedMph[d] as number[])[c] = asNum(mph, file, field, 5, 85);
    }
  }
  const s = asObj(root.signals, file, 'signals');
  const cycleObj = asObj(s.cycle, file, 'signals.cycle');
  const cycle = ROAD_CLASS_NAMES.map(() => 0);
  for (const [cls, value] of Object.entries(cycleObj)) {
    const field = `signals.cycle.${cls}`;
    cycle[ROAD_CLASS[asEnum(cls, file, field, ROAD_CLASS_NAMES)]] = asNum(value, file, field, 10, 300);
  }
  const yellow = asNum(s.yellow, file, 'signals.yellow', 1, 10);
  const allRed = asNum(s.allRed, file, 'signals.allRed', 0, 10);
  const minGreen = asNum(s.minGreen, file, 'signals.minGreen', 1, 120);
  for (const c of [ROAD_CLASS.highway, ROAD_CLASS.arterial, ROAD_CLASS.collector, ROAD_CLASS.local]) {
    const cyc = cycle[c] ?? 0;
    if (cyc === 0) fail(file, `signals.cycle.${ROAD_CLASS_NAMES[c] ?? ''}`, 'is missing');
    if (cyc < 2 * (minGreen + yellow + allRed)) fail(file, `signals.cycle.${ROAD_CLASS_NAMES[c] ?? ''}`, 'is too short for two minimum greens');
  }
  return { classes, districtSpeedMph, signals: { yellow, allRed, minGreen, cycle } };
}

/** Validates `zones.json`. */
export function validateZones(raw: unknown): ZonesData {
  const file = 'zones.json';
  const root = asObj(raw, file, '(root)');
  checkVersion(root, file);
  const s = asObj(root.schoolZone, file, 'schoolZone');
  const c = asObj(root.construction, file, 'construction');
  return {
    schoolZone: {
      limitMph: asNum(s.limitMph, file, 'schoolZone.limitMph', 5, 85),
      windows: asArr(s.windows, file, 'schoolZone.windows').map((w, i) => {
        const range = asRange(w, file, `schoolZone.windows[${i}]`);
        if (range[1] > 24) fail(file, `schoolZone.windows[${i}]`, 'must end by hour 24');
        return range;
      }),
      weekdaysOnly: asBool(s.weekdaysOnly, file, 'schoolZone.weekdaysOnly'),
      radius: asNum(s.radius, file, 'schoolZone.radius', 0, 1000),
      schoolsPerSuburbCell: asNum(s.schoolsPerSuburbCell, file, 'schoolZone.schoolsPerSuburbCell', 0, 1),
    },
    construction: {
      edgeFraction: asNum(c.edgeFraction, file, 'construction.edgeFraction', 0, 1),
      limitReductionMph: asNum(c.limitReductionMph, file, 'construction.limitReductionMph', 0, 50),
      minLimitMph: asNum(c.minLimitMph, file, 'construction.minLimitMph', 5, 85),
      classes: asArr(c.classes, file, 'construction.classes').map(
        (v, i) => ROAD_CLASS[asEnum(v, file, `construction.classes[${i}]`, ROAD_CLASS_NAMES)],
      ),
    },
  };
}

/** Validates `landmarks.json`; the station must lie inside the world. */
export function validateLandmarks(raw: unknown): LandmarksData {
  const file = 'landmarks.json';
  const root = asObj(raw, file, '(root)');
  checkVersion(root, file);
  const st = asObj(root.station, file, 'station');
  return {
    station: {
      x: asNum(st.x, file, 'station.x', -WORLD_HALF_SIZE, WORLD_HALF_SIZE),
      z: asNum(st.z, file, 'station.z', -WORLD_HALF_SIZE, WORLD_HALF_SIZE),
      yaw: asNum(st.yaw, file, 'station.yaw', -2 * Math.PI, 2 * Math.PI),
    },
    fuelStationsPerHighwayCell: asNum(root.fuelStationsPerHighwayCell, file, 'fuelStationsPerHighwayCell', 0, 1),
    fuelStationsPerUrbanCell: asNum(root.fuelStationsPerUrbanCell, file, 'fuelStationsPerUrbanCell', 0, 1),
  };
}

/** Validates `streetNames.json`: unique words and a suffix for every road class. */
export function validateStreetNames(raw: unknown): StreetNamesData {
  const file = 'streetNames.json';
  const root = asObj(raw, file, '(root)');
  checkVersion(root, file);
  const words = asArr(root.words, file, 'words').map((w, i) => asStr(w, file, `words[${i}]`));
  if (words.length < 8) fail(file, 'words', 'must hold at least 8 words');
  if (new Set(words).size !== words.length) fail(file, 'words', 'must not contain duplicates');
  const suffixObj = asObj(root.suffix, file, 'suffix');
  const suffix = ROAD_CLASS_NAMES.map((name: RoadClassName) => {
    if (!(name in suffixObj)) fail(file, `suffix.${name}`, 'is missing');
    return asStr(suffixObj[name], file, `suffix.${name}`);
  });
  return { words, suffix };
}

// --- Loaded data ---------------------------------------------------------------------

export const DISTRICTS: DistrictsData = validateDistricts(districtsJson);
export const DISTRICT_TYPES: readonly DistrictTypeDef[] = validateDistrictTypes(districtTypesJson);
export const ROAD_CLASSES: RoadClassesData = validateRoadClasses(roadClassesJson);
export const ZONES: ZonesData = validateZones(zonesJson);
export const LANDMARKS: LandmarksData = validateLandmarks(landmarksJson);
export const STREET_NAMES: StreetNamesData = validateStreetNames(streetNamesJson);

/** District type definition by id. */
export function districtType(id: DistrictId): DistrictTypeDef {
  return DISTRICT_TYPES[id] as DistrictTypeDef;
}

/** Road class definition by id. */
export function roadClassDef(id: RoadClassId): RoadClassDef {
  return ROAD_CLASSES.classes[id] as RoadClassDef;
}

