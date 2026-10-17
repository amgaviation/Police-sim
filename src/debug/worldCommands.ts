import type { Environment } from '../environment/environment';
import { formatClock } from '../environment/time';
import { WEATHER_KINDS, isWeatherKind } from '../environment/weather';
import { formatFuel, formatGear, formatSpeedMph, roadClassLabel } from '../ui/hud/format';
import type { VehicleTelemetry } from '../vehicles/drivableVehicle';
import { VEHICLE_MODELS } from '../vehicles/model';
import type { City, Poi, PoiKind } from '../world/city';
import { CELLS_PER_SIDE, DISTRICT_CELL, WORLD_HALF_SIZE } from '../world/constants';
import { DISTRICT, DISTRICT_NAMES, EDGE_FLAG, SURFACE_NAMES, type DistrictName } from '../world/ids';
import type { RoadEdge, RoadHit } from '../world/roadGraph';
import type { Command } from './console';

/** What the Phase 1 world commands need from the running session; each getter returns null when unavailable. */
export interface WorldCommandDeps {
  city(): City | null;
  playerPosition(): { x: number; z: number } | null;
  environment(): Environment | null;
  teleport(x: number, z: number): void;
  setRoute(polyline: Float32Array | null): void;
  vehicle(): { telemetry: Readonly<VehicleTelemetry>; refuel(): void; repair(): void } | null;
  spawnVehicle(modelId: string): void;
  trafficStats(): { active: number; proxies: number; spawned: number; despawned: number } | null;
  clearTraffic(): void;
  /** Multiplies the traffic density target (0 stops spawning). */
  setTrafficDensity(scale: number): void;
  /** Traffic cars nearest the player first, at most `limit`. */
  trafficCars(limit: number): readonly TrafficCarLine[] | null;
  lookupPlate(plate: string): Record<string, unknown> | null;
  chunkStats(): { loaded: number; inFlight: number; lod0: number; lod1: number } | null;
}

/** One traffic car for `traffic list`. */
export interface TrafficCarLine {
  readonly vehicleId: number;
  readonly plate: string;
  readonly modelId: string;
  readonly distance: number;
  readonly speedMph: number;
  readonly crashed: boolean;
  /** Violations observed this session, by kind. */
  readonly violations: Readonly<Partial<Record<string, number>>>;
  /** Registration flags (stolen, expired registration, uninsured). */
  readonly flags: readonly string[];
}

export const POI_KINDS: readonly PoiKind[] = ['station', 'hospital', 'campus', 'airport', 'harbor', 'school', 'fuel', 'park'];
/** Traffic density scale accepted by `traffic density`. */
export const MAX_TRAFFIC_DENSITY = 5;
/** Cars listed by `traffic list` without a count. */
const TRAFFIC_LIST_DEFAULT = 10;

/** Search radius (m) of the `road` command. */
const ROAD_SEARCH_M = 100;

function isPoiKind(value: string): value is PoiKind {
  return (POI_KINDS as readonly string[]).includes(value);
}

function isDistrictName(value: string): value is DistrictName {
  return Object.hasOwn(DISTRICT, value);
}

/** Centre of the district cell of `district` nearest to (x, z); null when the map has none. */
export function nearestDistrictCell(city: City, district: DistrictName, x: number, z: number): { x: number; z: number } | null {
  let best: { x: number; z: number } | null = null;
  let bestD = Infinity;
  for (let row = 0; row < CELLS_PER_SIDE; row++) {
    for (let col = 0; col < CELLS_PER_SIDE; col++) {
      const cx = -WORLD_HALF_SIZE + (col + 0.5) * DISTRICT_CELL;
      const cz = -WORLD_HALF_SIZE + (row + 0.5) * DISTRICT_CELL;
      if (city.districtAt(cx, cz) !== DISTRICT[district]) continue;
      const d = Math.hypot(cx - x, cz - z);
      if (d < bestD) {
        bestD = d;
        best = { x: cx, z: cz };
      }
    }
  }
  return best;
}

function need<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`${what} unavailable (no game running?)`);
  return value;
}

function parseCoord(text: string | undefined, usage: string): number {
  const v = Number(text);
  if (text === undefined || text === '' || !Number.isFinite(v)) throw new Error(`Usage: ${usage}`);
  if (Math.abs(v) > WORLD_HALF_SIZE) throw new RangeError(`Coordinate ${text} is outside the world (|v| <= ${String(WORLD_HALF_SIZE)})`);
  return v;
}

/** Closest POI of `kind` to (x, z) by straight distance; null when the city has none. */
export function nearestPoi(city: City, kind: PoiKind, x: number, z: number): Poi | null {
  let best: Poi | null = null;
  let bestD = Infinity;
  for (const poi of city.pois) {
    if (poi.kind !== kind) continue;
    const d = Math.hypot(poi.x - x, poi.z - z);
    if (d < bestD) {
      bestD = d;
      best = poi;
    }
  }
  return best;
}

/** `"ABC 1234"`, `"abc1234"` or two tokens -> `"ABC 1234"`; null when malformed. */
export function normalizePlate(text: string): string | null {
  const m = /^([A-Z]{3})\s*(\d{4})$/.exec(text.trim().toUpperCase());
  return m ? `${m[1] ?? ''} ${m[2] ?? ''}` : null;
}

/** `"HH:MM"` -> fractional hour in [0, 24]; null when malformed. */
export function parseClock(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return null;
  return h + min / 60;
}

function fmt(v: number, digits = 0): string {
  return v.toFixed(digits);
}

function weatherLine(env: Environment): string {
  const w = env.weather;
  return (
    `weather ${w.kind} intensity ${fmt(w.intensity, 2)}  ${fmt(w.temperatureC)}°C  ` +
    `clouds ${fmt(w.cloudCover, 2)}  precip ${fmt(w.precipitation, 2)}  wet ${fmt(w.wetness, 2)}  snow ${fmt(w.snowCover, 2)}`
  );
}

function roadLine(city: City, hit: RoadHit, env: Environment | null): string {
  const graph = city.graph;
  const e = graph.edges[hit.edge] as RoadEdge;
  const lanes = e.lanesBackward > 0 ? `${String(e.lanesForward)}+${String(e.lanesBackward)} lanes` : `${String(e.lanesForward)} lanes one-way`;
  const zones: string[] = [];
  if (e.flags & EDGE_FLAG.schoolZone) {
    zones.push(`school zone (${env && graph.isSchoolZoneActive(e.id, env.time) ? 'active' : 'inactive'})`);
  }
  if (e.flags & EDGE_FLAG.construction) zones.push('construction');
  if (e.flags & EDGE_FLAG.divided) zones.push('divided');
  const limit = env ? graph.effectiveSpeedLimitMph(e.id, env.time) : e.speedLimitMph;
  return [
    `${e.name} (${roadClassLabel(e.roadClass)}), edge ${String(e.id)}, ${fmt(hit.distance, 1)} m away`,
    `  ${lanes}, ${fmt(e.width, 1)} m wide, ${SURFACE_NAMES[e.surface] ?? '?'}, ${DISTRICT_NAMES[e.district] ?? '?'}`,
    `  limit now ${fmt(limit)} mph (posted ${fmt(e.speedLimitMph)} mph)`,
    `  zones: ${zones.length > 0 ? zones.join(', ') : 'none'}`,
  ].join('\n');
}

function carInfo(t: Readonly<VehicleTelemetry>): string {
  const flats = t.tireFlat.map((f, i) => (f ? (['FL', 'FR', 'RL', 'RR'][i] ?? '?') : '')).filter((s) => s !== '');
  const [front, rear, left, right] = t.damage;
  return [
    `speed ${formatSpeedMph(t.speedMph)} mph  gear ${formatGear(t.gear)}  rpm ${fmt(t.rpm)}`,
    `fuel ${fmt(t.fuelL, 1)} L (${formatFuel(t.fuelFraction)})  engine ${t.engineRunning ? 'running' : 'off'} health ${fmt(t.engineHealth, 2)}`,
    `brakes ${fmt(t.brakeTempC)}°C efficiency ${fmt(t.brakeEfficiency, 2)}  abs ${t.absActive ? 'active' : 'idle'}`,
    `damage front ${fmt(front, 2)} rear ${fmt(rear, 2)} left ${fmt(left, 2)} right ${fmt(right, 2)}  flats ${flats.length > 0 ? flats.join(' ') : 'none'}`,
  ].join('\n');
}

function trafficLine(car: TrafficCarLine): string {
  const seen = Object.entries(car.violations).map(([kind, count]) => (count !== undefined && count > 1 ? `${kind} x${String(count)}` : kind));
  const notes = [...seen, ...car.flags, ...(car.crashed ? ['crashed'] : [])];
  return (
    `${String(car.vehicleId).padEnd(6)} ${car.plate.padEnd(9)} ${car.modelId.padEnd(10)} ${`${fmt(car.distance)} m`.padStart(6)} ` +
    `${fmt(Math.abs(car.speedMph)).padStart(4)}  ${notes.length > 0 ? notes.join(', ') : '-'}`
  );
}

function recordLines(record: Record<string, unknown>): string {
  return Object.entries(record)
    .map(([k, v]) => `  ${k.padEnd(20)} ${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`)
    .join('\n');
}

/** Phase 1 world/driving debug commands: time, weather, tp, route, road, car, traffic, plate, chunks. */
export function createWorldCommands(deps: WorldCommandDeps): Command[] {
  const city = (): City => need(deps.city(), 'City');
  const env = (): Environment => need(deps.environment(), 'Environment');
  const player = (): { x: number; z: number } => need(deps.playerPosition(), 'Player position');

  return [
    {
      name: 'time',
      description: 'Print the game time or jump forward to a time of day',
      usage: '[HH:MM]',
      run(args) {
        const e = env();
        const arg = args[0];
        if (arg !== undefined) {
          const hour = parseClock(arg);
          if (hour === null) throw new Error('Usage: time [HH:MM]  (00:00 to 24:00)');
          e.setTimeOfDay(hour);
        }
        return `time ${formatClock(e.time)}`;
      },
    },
    {
      name: 'weather',
      description: 'Print the weather, force a kind or return to the timeline',
      usage: '[kind [intensity] | auto]',
      run(args) {
        const e = env();
        const [kind, rawIntensity] = args;
        if (kind === undefined) return weatherLine(e);
        if (kind === 'auto') {
          e.setWeatherOverride(null);
          return `weather auto: ${weatherLine(e)}`;
        }
        if (!isWeatherKind(kind)) throw new Error(`Usage: weather [kind [intensity] | auto]  kinds: ${WEATHER_KINDS.join(', ')}`);
        let intensity = 1;
        if (rawIntensity !== undefined) {
          intensity = Number(rawIntensity);
          if (!Number.isFinite(intensity) || intensity < 0 || intensity > 1) throw new RangeError('weather: intensity must be a number in 0..1');
        }
        e.setWeatherOverride(kind, intensity);
        return weatherLine(e);
      },
    },
    {
      name: 'tp',
      description: 'Teleport to coordinates, the nearest POI of a kind or the nearest district of a type',
      usage: `<x> <z> | <${POI_KINDS.join('|')}> | <${DISTRICT_NAMES.join('|')}>`,
      run(args) {
        const usage = `tp <x> <z> | tp <poi kind> | tp <district>  (POI kinds: ${POI_KINDS.join(', ')}; districts: ${DISTRICT_NAMES.join(', ')})`;
        const first = args[0];
        if (first !== undefined && isPoiKind(first)) {
          const from = deps.playerPosition() ?? { x: 0, z: 0 };
          const poi = nearestPoi(city(), first, from.x, from.z);
          if (!poi) throw new Error(`No ${first} in this city`);
          deps.teleport(poi.entrance.x, poi.entrance.z);
          return `Teleported to ${poi.kind} "${poi.name}" (${fmt(poi.entrance.x)}, ${fmt(poi.entrance.z)})`;
        }
        if (first !== undefined && isDistrictName(first) && args.length === 1) {
          const c = city();
          const from = deps.playerPosition() ?? { x: 0, z: 0 };
          const cell = nearestDistrictCell(c, first, from.x, from.z);
          if (!cell) throw new Error(`No ${first} district in this city`);
          // Land on the road nearest the cell centre (water cells have none inside).
          const hit: RoadHit = { edge: 0, s: 0, t: 0, x: 0, z: 0, distance: 0, side: 1 };
          const road = c.graph.nearestEdge(cell.x, cell.z, DISTRICT_CELL * 2, hit);
          const tx = road ? road.x : cell.x;
          const tz = road ? road.z : cell.z;
          deps.teleport(tx, tz);
          return `Teleported to ${first} (${fmt(tx)}, ${fmt(tz)})${road ? ` on ${(c.graph.edges[road.edge] as RoadEdge).name}` : ''}`;
        }
        if (args.length !== 2) throw new Error(`Usage: ${usage}`);
        const x = parseCoord(args[0], usage);
        const z = parseCoord(args[1], usage);
        deps.teleport(x, z);
        return `Teleported to (${fmt(x)}, ${fmt(z)})`;
      },
    },
    {
      name: 'route',
      description: 'Plot a route from the player to a POI kind or a point (shown on the minimap)',
      usage: `<${POI_KINDS.join('|')}> | <x> <z> | off`,
      run(args) {
        const usage = `route <${POI_KINDS.join('|')}> | route <x> <z> | route off`;
        const first = args[0];
        if (first === 'off') {
          deps.setRoute(null);
          return 'Route cleared';
        }
        const c = city();
        const from = player();
        let tx: number;
        let tz: number;
        let label: string;
        if (first !== undefined && isPoiKind(first) && args.length === 1) {
          const poi = nearestPoi(c, first, from.x, from.z);
          if (!poi) throw new Error(`No ${first} in this city`);
          tx = poi.entrance.x;
          tz = poi.entrance.z;
          label = `${poi.kind} "${poi.name}"`;
        } else if (args.length === 2) {
          tx = parseCoord(args[0], usage);
          tz = parseCoord(args[1], usage);
          label = `(${fmt(tx)}, ${fmt(tz)})`;
        } else {
          throw new Error(`Usage: ${usage}`);
        }
        const t0 = performance.now();
        const route = c.graph.routeBetweenPoints(from.x, from.z, tx, tz);
        const ms = performance.now() - t0;
        if (!route) throw new Error(`No route to ${label} (no road within reach of the start or the end)`);
        deps.setRoute(route.polyline);
        return `Route to ${label}: ${fmt(route.length / 1000, 2)} km, ETA ${fmt(route.time / 60, 1)} min (computed in ${fmt(ms, 2)} ms)`;
      },
    },
    {
      name: 'road',
      description: 'Describe the nearest street (name, class, lanes, limit now, zones)',
      run() {
        const c = city();
        const p = player();
        const hit: RoadHit = { edge: 0, s: 0, t: 0, x: 0, z: 0, distance: 0, side: 1 };
        if (!c.graph.nearestEdge(p.x, p.z, ROAD_SEARCH_M, hit)) return `No road within ${String(ROAD_SEARCH_M)} m`;
        return roadLine(c, hit, deps.environment());
      },
    },
    {
      name: 'car',
      description: 'Inspect, refuel or repair the current vehicle, or spawn one',
      usage: 'info | refuel | repair | spawn <modelId>',
      run(args) {
        const [verb = 'info', modelId] = args;
        if (verb === 'spawn') {
          const ids = VEHICLE_MODELS.map((m) => m.id);
          if (modelId === undefined || !ids.includes(modelId)) throw new Error(`Usage: car spawn <modelId>  models: ${ids.join(', ')}`);
          deps.spawnVehicle(modelId);
          return `Spawned ${modelId}`;
        }
        if (verb !== 'info' && verb !== 'refuel' && verb !== 'repair') throw new Error('Usage: car info | refuel | repair | spawn <modelId>');
        const v = deps.vehicle();
        if (!v) throw new Error('Not in a vehicle');
        if (verb === 'refuel') {
          v.refuel();
          return `Refuelled: ${fmt(v.telemetry.fuelL, 1)} L`;
        }
        if (verb === 'repair') {
          v.repair();
          return 'Repaired';
        }
        return carInfo(v.telemetry);
      },
    },
    {
      name: 'traffic',
      description: 'Ambient traffic: statistics, nearest cars, density scale, or remove all cars',
      usage: 'stats | list [n] | density <x> | clear',
      run(args) {
        const usage = `Usage: traffic stats | list [n] | density <0..${String(MAX_TRAFFIC_DENSITY)}> | clear`;
        const verb = args[0] ?? 'stats';
        if (verb === 'clear') {
          deps.clearTraffic();
          return 'Traffic cleared';
        }
        if (verb === 'density') {
          const scale = Number(args[1]);
          if (args[1] === undefined || !Number.isFinite(scale) || scale < 0 || scale > MAX_TRAFFIC_DENSITY) throw new Error(usage);
          deps.setTrafficDensity(scale);
          return `Traffic density x${fmt(scale, 2)}`;
        }
        if (verb === 'list') {
          const n = args[1] === undefined ? TRAFFIC_LIST_DEFAULT : Number(args[1]);
          if (!Number.isInteger(n) || n < 1 || n > 200) throw new RangeError('traffic list: n must be an integer in 1..200');
          const cars = need(deps.trafficCars(n), 'Traffic');
          if (cars.length === 0) return 'No traffic';
          return [`${'id'.padEnd(6)} ${'plate'.padEnd(9)} ${'model'.padEnd(10)} ${'dist'.padStart(6)} ${'mph'.padStart(4)}  violations / record`]
            .concat(cars.map(trafficLine))
            .join('\n');
        }
        if (verb !== 'stats') throw new Error(usage);
        const s = need(deps.trafficStats(), 'Traffic');
        return `traffic active ${String(s.active)}  proxies ${String(s.proxies)}  spawned ${String(s.spawned)}  despawned ${String(s.despawned)}`;
      },
    },
    {
      name: 'plate',
      description: 'Look up a vehicle registration by plate',
      usage: '<ABC 1234>',
      run(args) {
        const plate = normalizePlate(args.join(' '));
        if (!plate) throw new Error('Usage: plate <ABC 1234>');
        const record = deps.lookupPlate(plate);
        if (!record) return `No record for ${plate}`;
        return `${plate}\n${recordLines(record)}`;
      },
    },
    {
      name: 'chunks',
      description: 'Render chunk streaming statistics',
      run() {
        const s = need(deps.chunkStats(), 'Chunk streamer');
        return `chunks loaded ${String(s.loaded)} (lod0 ${String(s.lod0)}, lod1 ${String(s.lod1)})  in flight ${String(s.inFlight)}`;
      },
    },
  ];
}
