/**
 * Procedural call content (design §8 "Generator"): call-type choice, location, caller and narrative.
 * Type-agnostic and table-driven (`callTypes.json`): new rows need no code. Every draw comes from the
 * Rng passed in (the dispatcher's 'calls' stream), so generation is deterministic. Runs only when a
 * call is created (allocation is fine here).
 */
import { locationOf } from '../cad/address';
import { CALL_TYPES, type CallType } from '../cad/data';
import { CALLER_KINDS, type CadLocation, type CallerInfo, type Priority } from '../cad/types';
import type { Rng } from '../core/rng';
import { crimeWeight } from '../environment/crime';
import { TIME_CONFIG } from '../environment/time';
import type { RecordsDb } from '../records/db';
import { PERSON_POPULATION } from '../records/ids';
import { canBeOnRoad, mountedPlate, vehicleDescription } from '../records/vehicle';
import { REGISTRY_POPULATION } from '../traffic/registry';
import { BLOCK_KIND, type City } from '../world/city';
import { DISTRICT, DISTRICT_NAMES } from '../world/ids';
import type { RoadEdge, RoadHit } from '../world/roadGraph';
import type { DispatchConfig } from './data';

/** Location attempts per call before the generator gives up (design §8). */
export const LOCATION_TRIES = 20;
/** Redraws of the call type when the drawn one has no location. */
const TYPE_REDRAWS = 4;
/** Tries to find a registry vehicle that can be on the road for a `{plate}` / `{vehicle}` placeholder (design §11.8). */
const VEHICLE_TRIES = 20;
/** A block is snapped to a road within this distance (m). */
const BLOCK_SNAP = 400;
/** `locationOf` fallback radius when the point is farther than the default 60 m from a road (m). */
const WIDE_SNAP = 2000;

export interface GeneratedCall {
  readonly typeId: string;
  readonly priority: Priority;
  readonly location: CadLocation;
  readonly caller: CallerInfo;
  readonly narrative: string;
  readonly persons: number[];
  readonly vehicles: number[];
}

/** Hour of day [0, 24) and weekday (0 = Monday) of a game-seconds stamp. */
export function clockParts(gameSeconds: number): { hour: number; weekday: number } {
  const day = Math.floor(gameSeconds / 86400);
  const hour = (gameSeconds - day * 86400) / 3600;
  const weekday = (((Math.floor(TIME_CONFIG.startWeekday) + day) % 7) + 7) % 7;
  return { hour, weekday };
}

/** Weighted index into `weights` for `u` in [0, 1); -1 when every weight is 0. */
function weightedIndex(weights: readonly number[], u: number): number {
  let total = 0;
  for (const w of weights) total += w > 0 ? w : 0;
  if (total <= 0) return -1;
  let x = u * total;
  let last = -1;
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i] ?? 0;
    if (w <= 0) continue;
    last = i;
    x -= w;
    if (x < 0) return i;
  }
  return last;
}

function capitalise(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

/** Centreline point `s` metres along an edge (clamped). */
function pointAlong(e: RoadEdge, s: number, out: { x: number; z: number }): void {
  const p = e.points;
  let rest = Math.max(0, s);
  out.x = p[0] ?? 0;
  out.z = p[1] ?? 0;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i] ?? 0, az = p[i + 1] ?? 0, bx = p[i + 2] ?? 0, bz = p[i + 3] ?? 0;
    const len = Math.hypot(bx - ax, bz - az);
    if (rest <= len || i + 4 >= p.length) {
      const t = len > 0 ? Math.min(1, rest / len) : 0;
      out.x = ax + (bx - ax) * t;
      out.z = az + (bz - az) * t;
      return;
    }
    rest -= len;
  }
}

/** Builds calls (type, location, caller, narrative) for one city and records database. */
export class CallGenerator {
  readonly districtOf: (x: number, z: number) => string;
  private readonly city: City;
  private readonly records: RecordsDb;
  private readonly seed: number;
  private readonly config: DispatchConfig['generator'];
  private readonly generatedTypes: readonly CallType[];
  /** Land edges (not water) and their cumulative lengths, for length-weighted picks. */
  private readonly landEdges: number[] = [];
  private readonly landCum: number[] = [];
  private readonly lotBlocks: number[] = [];
  private readonly junctions: number[] = [];
  private readonly scratchIds: number[] = [];
  private readonly scratchW: number[] = [];
  private readonly hit: RoadHit = { edge: -1, s: 0, t: 0, x: 0, z: 0, distance: 0, side: 1 };
  private readonly pt = { x: 0, z: 0 };
  private crimeFactor: ((district: string) => number) | null = null;
  private categoryWeight: ((category: string) => number) | null = null;

  constructor(city: City, records: RecordsDb, seed: number, config: DispatchConfig['generator']) {
    this.city = city;
    this.records = records;
    this.seed = seed;
    this.config = config;
    this.districtOf = (x, z) => DISTRICT_NAMES[city.districtAt(x, z)] ?? '';
    this.generatedTypes = CALL_TYPES.filter((t) => t.generated && t.weight > 0);
    let cum = 0;
    for (const e of city.graph.edges) {
      if (e.district === DISTRICT.water || e.length <= 0) continue;
      cum += e.length;
      this.landEdges.push(e.id);
      this.landCum.push(cum);
    }
    for (const b of city.blocks) if (b.kind === BLOCK_KIND.lots && b.district !== DISTRICT.water) this.lotBlocks.push(b.id);
    for (const n of city.graph.nodes) if (n.edges.length >= 3 && city.districtAt(n.x, n.z) !== DISTRICT.water) this.junctions.push(n.id);
  }

  /**
   * Phase 5: a per-district factor (community trust: poor trust means more crime) multiplied into `multiplier()`
   * before its clamp; `null` removes it. A factor that is not a finite number counts as 1.
   */
  setCrimeFactor(fn: ((district: string) => number) | null): void {
    this.crimeFactor = fn;
  }

  /**
   * Phase 8: multiplies each generated type's weight in `pickType` by `fn(type.category)` (specialty call mix); `null`
   * removes it. A result that is not a finite number >= 0 counts as 1.
   */
  setCategoryWeight(fn: ((category: string) => number) | null): void {
    this.categoryWeight = fn;
  }

  private catWeight(t: CallType): number {
    if (this.categoryWeight === null) return 1;
    const f = this.categoryWeight(t.category);
    return Number.isFinite(f) && f >= 0 ? f : 1;
  }

  /**
   * Generator rate multiplier: weighted mean (type weights) of the crime weight of every generated
   * type's category at this hour, weekday and district, over `crimeReferenceRate`, times the crime factor
   * (`setCrimeFactor`), clamped to [0.25, 3].
   */
  multiplier(gameSeconds: number, district: string): number {
    const { hour, weekday } = clockParts(gameSeconds);
    let sum = 0;
    let weights = 0;
    for (const t of this.generatedTypes) {
      sum += t.weight * crimeWeight(t.category, hour, weekday, district);
      weights += t.weight;
    }
    let m = weights > 0 ? sum / weights / this.config.crimeReferenceRate : 1;
    if (this.crimeFactor) {
      const f = this.crimeFactor(district);
      if (Number.isFinite(f)) m *= f;
    }
    return Math.min(3, Math.max(0.25, m));
  }

  /**
   * A generated type by weight x the district factor x the crime weight of its category at the game time
   * and district (design §11.8); plain weight x district factor when every product is 0.
   */
  pickType(rng: Rng, x: number, z: number, gameSeconds: number): CallType | null {
    const district = this.districtOf(x, z);
    const { hour, weekday } = clockParts(gameSeconds);
    const w = this.scratchW;
    w.length = 0;
    for (const t of this.generatedTypes) w.push(t.weight * this.districtFactor(t, district) * crimeWeight(t.category, hour, weekday, district) * this.catWeight(t));
    const u = rng.next();
    let i = weightedIndex(w, u);
    if (i < 0) {
      w.length = 0;
      for (const t of this.generatedTypes) w.push(t.weight * this.districtFactor(t, district) * this.catWeight(t));
      i = weightedIndex(w, u);
    }
    if (i < 0) {
      w.length = 0;
      for (const t of this.generatedTypes) w.push(t.weight * this.catWeight(t));
      i = weightedIndex(w, u);
    }
    return this.generatedTypes[i] ?? null;
  }

  /** Priority drawn from the type's P1..P4 weights (P4 when all are 0). */
  pickPriority(type: CallType, rng: Rng): Priority {
    const i = weightedIndex(type.priority, rng.next());
    return (i < 0 ? 4 : i + 1) as Priority;
  }

  /** CAD location of (x, z), widening the road snap when needed; a bare point when no road is near. */
  locate(x: number, z: number): CadLocation {
    const g = this.city.graph;
    const loc = locationOf(g, x, z, this.districtOf) ?? locationOf(g, x, z, this.districtOf, WIDE_SNAP);
    if (loc) return loc;
    const district = this.districtOf(x, z);
    const label = district.length > 0 ? district.charAt(0).toUpperCase() + district.slice(1) : '';
    return { x, z, edge: -1, text: 'Unknown location', street: '', cross: '', near: 'Unknown location', district: label };
  }

  /**
   * A location for `type` near the player (share `nearPlayerShare`, within `nearRadiusM`) or anywhere on
   * land, never within `minDistanceM` of the player and never where the type's district multiplier is 0;
   * up to `LOCATION_TRIES` attempts, null when none fits.
   */
  pickLocation(type: CallType, rng: Rng, px: number, pz: number): CadLocation | null {
    const near = rng.chance(this.config.nearPlayerShare);
    for (let attempt = 0; attempt < LOCATION_TRIES; attempt++) {
      if (!this.candidatePoint(type.location, rng, near, px, pz, this.pt)) continue;
      const { x, z } = this.pt;
      const d = Math.hypot(x - px, z - pz);
      if (d < this.config.minDistanceM || (near && d > this.config.nearRadiusM)) continue;
      if (this.city.districtAt(x, z) === DISTRICT.water) continue;
      if (this.districtFactor(type, this.districtOf(x, z)) <= 0) continue;
      const loc = locationOf(this.city.graph, x, z, this.districtOf);
      if (loc) return loc;
    }
    return null;
  }

  /** Caller from the type's caller weights; `officer` callers are "Unit <callsign>". */
  pickCaller(type: CallType, rng: Rng, officerCallsign: string): CallerInfo {
    const weights = CALLER_KINDS.map((k) => type.callers[k] ?? 0);
    const kind = CALLER_KINDS[weightedIndex(weights, rng.next())] ?? 'anonymous';
    switch (kind) {
      case 'citizen': {
        const id = rng.nextInt(0, PERSON_POPULATION - 1);
        const p = this.records.person(id);
        return { kind, name: `${p.last}, ${p.first}`, phone: p.phone, personId: id };
      }
      case 'alarm':
        return { kind, name: 'Alarm monitoring center', phone: '', personId: -1 };
      case 'business':
        return { kind, name: 'Business owner', phone: '', personId: -1 };
      case 'officer':
        return { kind, name: `Unit ${officerCallsign}`, phone: '', personId: -1 };
      default:
        return { kind: 'anonymous', name: 'ANONYMOUS', phone: '', personId: -1 };
    }
  }

  /**
   * Narrative from one of the type's templates: `fill` keys, address parts, {dir} from the edge axis,
   * {caller}, and {plate}/{vehicle} from one random registry vehicle (its mounted plate and true
   * description), whose id is appended to `vehicles`. `vehicleId` (>= 0) forces that vehicle.
   */
  narrative(type: CallType, rng: Rng, loc: CadLocation, caller: CallerInfo, vehicles: number[], vehicleId = -1): string {
    const template = type.narratives.length > 0 ? rng.pick(type.narratives) : type.label;
    const picked = new Map<string, string>();
    let vehicle = vehicleId;
    const ensureVehicle = (): number => {
      if (vehicle < 0) {
        vehicle = rng.nextInt(0, REGISTRY_POPULATION - 1);
        for (let tries = 1; tries < VEHICLE_TRIES && !canBeOnRoad(this.seed, vehicle); tries++) vehicle = rng.nextInt(0, REGISTRY_POPULATION - 1);
      }
      if (!vehicles.includes(vehicle)) vehicles.push(vehicle);
      return vehicle;
    };
    const text = template.replace(/\{([^{}]*)\}/g, (whole, key: string) => {
      const cached = picked.get(key);
      if (cached !== undefined) return cached;
      let value: string;
      switch (key) {
        case 'street':
          value = loc.street || 'the roadway';
          break;
        case 'cross':
          value = loc.cross || 'the next intersection';
          break;
        case 'near':
          value = loc.near;
          break;
        case 'address':
          value = loc.text;
          break;
        case 'district':
          value = loc.district;
          break;
        case 'dir':
          value = this.direction(loc.edge, rng);
          break;
        case 'caller':
          value = caller.name;
          break;
        case 'plate':
          value = mountedPlate(this.seed, ensureVehicle()).plate;
          break;
        case 'vehicle':
          value = vehicleDescription(this.records.registration(ensureVehicle()));
          break;
        default: {
          const options = Object.hasOwn(type.fill, key) ? type.fill[key] : undefined;
          value = options && options.length > 0 ? rng.pick(options) : whole;
        }
      }
      picked.set(key, value);
      return value;
    });
    return capitalise(text);
  }

  /** A full generated call (null when no type or location fits). */
  generate(
    rng: Rng,
    px: number,
    pz: number,
    officerCallsign: string,
    gameSeconds: number,
    typeOverride?: CallType,
    at?: { x: number; z: number },
  ): GeneratedCall | null {
    // A drawn type with no usable location (a point of interest the city lacks) is redrawn, not lost.
    let type = typeOverride ?? this.pickType(rng, px, pz, gameSeconds);
    if (!type) return null;
    let location = at ? this.locate(at.x, at.z) : this.pickLocation(type, rng, px, pz);
    for (let again = 0; !location && !typeOverride && again < TYPE_REDRAWS; again++) {
      type = this.pickType(rng, px, pz, gameSeconds);
      if (!type) return null;
      location = this.pickLocation(type, rng, px, pz);
    }
    if (!location) return null;
    const priority = this.pickPriority(type, rng);
    const caller = this.pickCaller(type, rng, officerCallsign);
    const vehicles: number[] = [];
    const narrative = this.narrative(type, rng, location, caller, vehicles);
    const persons = caller.personId >= 0 ? [caller.personId] : [];
    return { typeId: type.id, priority, location, caller, narrative, persons, vehicles };
  }

  private districtFactor(type: CallType, district: string): number {
    return Object.hasOwn(type.districts, district) ? (type.districts[district] ?? 1) : 1;
  }

  /** "northbound" / "southbound" / "eastbound" / "westbound" along the edge's main axis (north = -z). */
  private direction(edgeId: number, rng: Rng): string {
    const g = this.city.graph;
    const e = g.edges[edgeId];
    const a = e ? g.nodes[e.from] : undefined;
    const b = e ? g.nodes[e.to] : undefined;
    const dx = a && b ? b.x - a.x : 1;
    const dz = a && b ? b.z - a.z : 0;
    const forward = rng.chance(0.5);
    if (Math.abs(dz) > Math.abs(dx)) return (dz < 0) === forward ? 'northbound' : 'southbound';
    return (dx > 0) === forward ? 'eastbound' : 'westbound';
  }

  /** A raw candidate point for a location kind; false when none exists. */
  private candidatePoint(kind: string, rng: Rng, near: boolean, px: number, pz: number, out: { x: number; z: number }): boolean {
    const g = this.city.graph;
    const radius = this.config.nearRadiusM;
    if (kind === 'block') {
      const ids = this.scratchIds;
      ids.length = 0;
      if (near) {
        for (const id of this.lotBlocks) {
          const b = this.city.blocks[id];
          if (b && Math.hypot((b.minX + b.maxX) / 2 - px, (b.minZ + b.maxZ) / 2 - pz) <= radius) ids.push(id);
        }
      }
      const list = near && ids.length > 0 ? ids : this.lotBlocks;
      if (list.length === 0) return this.candidatePoint('road', rng, near, px, pz, out);
      const b = this.city.blocks[rng.pick(list)];
      if (!b) return false;
      const hit = g.nearestEdge((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2, BLOCK_SNAP, this.hit);
      if (!hit) return false;
      out.x = hit.x;
      out.z = hit.z;
      return true;
    }
    if (kind === 'intersection') {
      const ids = near ? g.nodesNear(px, pz, radius, this.scratchIds) : this.junctions;
      if (near) {
        let w = 0;
        for (const id of ids) if ((g.nodes[id]?.edges.length ?? 0) >= 3) ids[w++] = id;
        ids.length = w;
      }
      const list = ids.length > 0 ? ids : this.junctions;
      if (list.length === 0) return this.candidatePoint('road', rng, near, px, pz, out);
      const n = g.nodes[rng.pick(list)];
      if (!n) return false;
      out.x = n.x;
      out.z = n.z;
      return true;
    }
    if (kind.startsWith('poi:')) {
      const poiKind = kind.slice(4);
      const all = this.city.pois.filter((p) => p.kind === poiKind);
      const close = near ? all.filter((p) => Math.hypot(p.entrance.x - px, p.entrance.z - pz) <= radius) : all;
      const list = close.length > 0 ? close : all;
      if (list.length === 0) return this.candidatePoint('road', rng, near, px, pz, out);
      const p = rng.pick(list);
      out.x = p.entrance.x;
      out.z = p.entrance.z;
      return true;
    }
    // 'road' (and anything unknown): a random point on a land edge, weighted by length.
    let edgeId = -1;
    if (near) {
      const ids = g.edgesNear(px, pz, radius, this.scratchIds);
      const w = this.scratchW;
      w.length = 0;
      for (const id of ids) {
        const e = g.edges[id];
        w.push(e && e.district !== DISTRICT.water ? e.length : 0);
      }
      const i = weightedIndex(w, rng.next());
      if (i >= 0) edgeId = ids[i] ?? -1;
    }
    if (edgeId < 0) {
      const total = this.landCum[this.landCum.length - 1] ?? 0;
      if (total <= 0) return false;
      const x = rng.next() * total;
      let lo = 0, hi = this.landCum.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((this.landCum[mid] ?? 0) > x) hi = mid;
        else lo = mid + 1;
      }
      edgeId = this.landEdges[lo] ?? -1;
    }
    const e = g.edges[edgeId];
    if (!e) return false;
    pointAlong(e, rng.next() * e.length, out);
    return true;
  }
}
