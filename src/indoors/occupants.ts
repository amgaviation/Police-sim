/**
 * Ambient occupants of an interior (design §6.3): a pure planner over (seed, layout, game time). Every choice is an
 * integer hash, so the same inputs give the same spawns and nothing depends on call history.
 */
import type { InteriorLayout, InteriorRoom, SpawnSpot } from '../interior/types';
import { PERSON_POPULATION } from '../records/ids';
import { hash3 } from '../records/hash';
import type { OccupantSpawn } from './types';

const SECONDS_PER_DAY = 86400;
/** Residents per building are numbered 0..7 (the hash id is `buildingId * 8 + k`). */
const MAX_RESIDENTS = 8;
/** Residential "night" (counts) is 19:00-07:00; residents are asleep (lying) from 22:00 to 06:00. */
const NIGHT_FROM = 19;
const NIGHT_TO = 7;
const ASLEEP_FROM = 22;
const ASLEEP_TO = 6;

const SALT_RESIDENT = 0x2e51;
const SALT_STAFF = 0x51af;
const SALT_COUNT = 0x51a0;
const SALT_SPOT = 0x5ea0;
const SALT_POINT = 0x5ec0;
/** Free-floor placement of patrons: margin from walls, from furniture, and between people (m), and tries per person. */
const WALL_MARGIN = 0.8;
const FURNITURE_MARGIN = 0.45;
const PERSON_GAP = 0.9;
const POINT_TRIES = 8;

type Range = readonly [number, number];

/** Patrons or extra staff a kind has on top of its template occupancy (typed table: content, not logic). */
const EXTRA: Readonly<Partial<Record<string, { patrons?: Range; staff?: Range }>>> = {
  convenienceStore: { patrons: [0, 3] },
  bar: { staff: [1, 1] },
};

/** True when `hour` (integer 0..23) is inside [open, close) of a window that may wrap past midnight (24 = midnight). */
export function isOpenAt(openHours: Range | null, hour: number): boolean {
  if (openHours === null) return true;
  const [open, close] = openHours;
  return open <= close ? hour >= open && hour < close : hour >= open || hour < close;
}

/** Hour of day (0..23) of a game time. */
export function hourOf(gameSeconds: number): number {
  const s = ((gameSeconds % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
  return Math.floor(s / 3600);
}

function isNight(hour: number): boolean {
  return hour >= NIGHT_FROM || hour < NIGHT_TO;
}

function rangeCount(range: Range, h: number): number {
  const lo = Math.max(0, Math.floor(range[0]));
  const hi = Math.max(lo, Math.floor(range[1]));
  return lo + (h % (hi - lo + 1));
}

/** Picks an unused spot from `pool` (indices into spots) starting at hash `h`; -1 when all are used. */
function pickSpot(pool: readonly number[], used: Uint8Array, h: number): number {
  if (pool.length === 0) return -1;
  const start = h % pool.length;
  for (let i = 0; i < pool.length; i++) {
    const s = pool[(start + i) % pool.length] as number;
    if (used[s] === 0) {
      used[s] = 1;
      return s;
    }
  }
  return -1;
}

/** Person id of resident `k` (0..7) of building `buildingId`: the same stable person the occupant planner places there. */
export function residentPerson(seed: number, buildingId: number, k: number): number {
  return hash3(seed, SALT_RESIDENT, buildingId * MAX_RESIDENTS + k) % PERSON_POPULATION;
}

/**
 * Clears `out` and fills it with the occupants of `layout` at `gameSeconds`.
 * Residential: `occupants.day|night` by hour, residents are the stable persons `hash3(seed, 0x2e51, buildingId*8+k)`.
 * Business: nobody when closed; otherwise staff from `occupants.day|night` plus the kind's extra patrons (`EXTRA`),
 * persons drawn by `hash3(seed, 0x51af + k, buildingId*24 + hour)`.
 */
export function occupantPlan(seed: number, layout: InteriorLayout, gameSeconds: number, out: OccupantSpawn[]): OccupantSpawn[] {
  out.length = 0;
  const spec = layout.occupants;
  const hour = hourOf(gameSeconds);
  if (!isOpenAt(spec.openHours, hour)) return out;
  const spots = layout.spawnSpots;
  if (spots.length === 0) return out;
  const night = isNight(hour);
  const range = night ? spec.night : spec.day;
  const epochDay = Math.floor(gameSeconds / SECONDS_PER_DAY);
  const id = layout.buildingId;
  const countKey = id * 97 + epochDay * 24 + hour;
  const used = new Uint8Array(spots.length);
  const standing: number[] = [];
  const lying: number[] = [];
  const publicSpots: number[] = [];
  spots.forEach((s: SpawnSpot, i: number) => {
    if (s.pose === 'lying') lying.push(i);
    else {
      standing.push(i);
      if (layout.rooms[s.room]?.public === true) publicSpots.push(i);
    }
  });

  const push = (personId: number, x: number, z: number, yaw: number, pose: OccupantSpawn['pose'], profile: string, role: OccupantSpawn['role']): void => {
    // The same person never appears twice in one plan.
    let pid = personId;
    for (let n = 0; n < PERSON_POPULATION && out.some((o) => o.personId === pid); n++) pid = (pid + 1) % PERSON_POPULATION;
    out.push({ buildingId: id, personId: pid, x, z, yaw, pose, profile, role });
  };
  const pushSpot = (personId: number, spot: number, profile: string, role: OccupantSpawn['role']): void => {
    const s = spots[spot] as SpawnSpot;
    push(personId, s.x, s.z, s.yaw, s.pose, profile, role);
  };

  if (layout.residential) {
    const count = Math.min(MAX_RESIDENTS, rangeCount(range, hash3(seed, SALT_COUNT, countKey)));
    const asleep = hour >= ASLEEP_FROM || hour < ASLEEP_TO;
    for (let k = 0; k < count; k++) {
      const personId = residentPerson(seed, id, k);
      const h = hash3(seed, SALT_SPOT + k, countKey);
      let spot = asleep ? pickSpot(lying, used, h) : -1;
      if (spot < 0) spot = pickSpot(standing, used, h);
      if (spot < 0) spot = pickSpot(lying, used, h);
      if (spot < 0) break;
      pushSpot(personId, spot, spec.profile, 'resident');
    }
    return out;
  }

  // Business: the kind's extra staff first (a bartender must have a place), then the template occupancy, then extra patrons.
  const extra = EXTRA[layout.kind];
  const groups: { count: number; role: OccupantSpawn['role']; profile: string }[] = [];
  if (extra?.staff) groups.push({ count: rangeCount(extra.staff, hash3(seed, SALT_COUNT + 1, countKey)), role: 'staff', profile: 'bystander' });
  groups.push({ count: rangeCount(range, hash3(seed, SALT_COUNT, countKey)), role: spec.role === 'resident' ? 'staff' : spec.role, profile: spec.profile });
  if (extra?.patrons) groups.push({ count: rangeCount(extra.patrons, hash3(seed, SALT_COUNT + 2, countKey)), role: 'patron', profile: 'bystander' });
  const publicRooms = layout.rooms.filter((r) => r.public);
  const pool = publicSpots.length > 0 ? publicSpots : standing;
  let k = 0;
  for (const g of groups) {
    for (let i = 0; i < g.count; i++, k++) {
      const personId = hash3(seed, SALT_STAFF + k, id * 24 + hour) % PERSON_POPULATION;
      const h = hash3(seed, SALT_SPOT + k, id * 24 + hour);
      // Patrons stand anywhere free on a public floor (a store has one spawn spot); staff use the spawn spots.
      const point = g.role === 'patron' && publicRooms.length > 0 ? freePoint(layout, publicRooms, out, seed, h, k) : null;
      if (point !== null) {
        push(personId, point.x, point.z, point.yaw, 'stand', g.profile, g.role);
        continue;
      }
      const spot = pickSpot(pool, used, h);
      if (spot < 0) break;
      pushSpot(personId, spot, g.profile, g.role);
    }
  }
  return out;
}

/** A free standing point on a public floor: clear of walls, furniture and the people already placed. */
function freePoint(
  layout: InteriorLayout,
  rooms: readonly InteriorRoom[],
  placed: readonly OccupantSpawn[],
  seed: number,
  h: number,
  k: number,
): { x: number; z: number; yaw: number } | null {
  const room = rooms[h % rooms.length] as InteriorRoom;
  const r = room.rect;
  const w = r.maxX - r.minX - 2 * WALL_MARGIN, d = r.maxZ - r.minZ - 2 * WALL_MARGIN;
  if (w <= 0 || d <= 0) return null;
  for (let t = 0; t < POINT_TRIES; t++) {
    const x = r.minX + WALL_MARGIN + (hash3(seed, SALT_POINT + 2 * t, h + k) / 4294967296) * w;
    const z = r.minZ + WALL_MARGIN + (hash3(seed, SALT_POINT + 2 * t + 1, h + k) / 4294967296) * d;
    if (layout.furniture.some((f) => f.solid && x > f.minX - FURNITURE_MARGIN && x < f.maxX + FURNITURE_MARGIN && z > f.minZ - FURNITURE_MARGIN && z < f.maxZ + FURNITURE_MARGIN)) continue;
    if (placed.some((o) => Math.hypot(o.x - x, o.z - z) < PERSON_GAP)) continue;
    return { x, z, yaw: ((hash3(seed, SALT_POINT + 64, h + k + t) >>> 8) % 4) * (Math.PI / 2) - Math.PI / 2 };
  }
  return null;
}
