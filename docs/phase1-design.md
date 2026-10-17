# Phase 1 design: World and Driving

Status: design (technical director). Implementation is split into 8 modules (§16) plus an integrator.
Read with `docs/ARCHITECTURE.md` (Phase 0 contracts) and `docs/research/*.md` (verified library APIs).

## 1. Scope

At the end of Phase 1 the game is playable: the officer starts on foot at the police station of a
procedurally generated 51 km² city, walks to a parked patrol car, presses **E** to get in, and drives
(keyboard or gamepad) through streamed districts with day/night, weather, signals, signage and ambient
traffic that mostly obeys the law and sometimes does not. Every traffic car has a persistent id, plate
and violation flags derived from the seed. Phase 2 (CAD/AVL, dispatch routing) builds on the road graph
queries and the vehicle registry defined here.

Non-goals for Phase 1: pedestrians, police AI units, audio, pulling cars over (the `parked` traffic state
and violation events are reserved hooks), terrain elevation (the world is flat, y = 0).

## 2. Conventions (all modules)

- **Units**: metres, seconds, kilograms, radians, m/s internally. Speed limits are authored and shown in
  **mph** (`MPH = 0.44704` m/s per mph); temperatures in °C; fuel in litres.
- **Axes**: right-handed, **Y up**. +X = east, -Z = north. World origin = city centre. The world is flat:
  ground top at y = 0. All roads are axis-aligned straight lines (edges are still stored as polylines so
  curved roads can be added later without API changes).
- **Heading / yaw**: yaw is a rotation about +Y; yaw 0 faces -Z (north), positive yaw turns
  counter-clockwise seen from above (same as `src/game/playerController.ts`). Heading unit vector
  `h = (hx, hz) = (-sin yaw, -cos yaw)`; `yaw = atan2(-hx, -hz)`. Right of a heading = `(-hz, hx)`.
  Vehicle and on-foot rotations are `yawQuaternion(yaw)` (Phase 0 helper).
- **Vehicle frame**: local -Z is the front, +X the right side, +Y up. A vehicle entity's `Transform`
  origin is the centre of its body box; at rest it sits at `y = body.groundClearance + body.height / 2`.
- **Traffic drives on the right.** Lane index 0 is the curb-most (rightmost) lane of a direction.
- **Time**: sim time = `GameClock.simTime` (fixed 1/60 s steps, already saved). Game (wall) time of day
  runs `gameSecondsPerSimSecond` (data, default 30) times faster, so a game day lasts 48 real minutes.
  Signals, physics and traffic run on **sim** seconds; school zones, sky, weather and crime patterns use
  **game** time. Weekday 0 = Monday.
- **Determinism**: simulation code (city generation, colliders, vehicles, traffic, time, weather) draws
  randomness only from seeded `Rng` streams (`src/core/rng.ts`) and reads only sim state. Never
  `Math.random`, `Date.now`, `performance.now` (except for timing stats) or render settings (fog, draw
  distance) in sim code. Worker results are render-only. Iterate arrays in index order, never Maps whose
  insertion order depends on async arrival.
- **Hot loops** (per fixed step or per frame): no allocations after warm-up. Pass `out` objects, reuse
  typed arrays and scratch vectors; Rapier getters get a `target` argument.
- **TS rules**: no enums/namespaces/parameter properties (`erasableSyntaxOnly`); use `as const` maps plus
  unions; `import type` for types; `noUncheckedIndexedAccess` (`?? 0` on typed-array reads).
- **Data**: JSON under `src/data/**`, loaded through a typed validator that throws a readable error naming
  the file and field. Folders of same-shaped files (vehicle models) are loaded with
  `import.meta.glob<unknown>('../../data/vehicles/*.json', { eager: true, import: 'default' })`
  (verified to work under tsc, eslint and vitest), so adding a model needs no code change.
- **Generic content only**: no real brands, agencies, places, logos or liveries. Patrol cars are plain
  black/white with a generic light bar; plates are `ABC 1234`; street names come from generic word lists.

## 3. World layout

| Quantity | Value |
|---|---|
| World extent | x, z in [-3584, 3584] m (7168 m square, 51.4 km²) |
| District cell | 512 m; 14 x 14 cells authored as an ASCII map |
| Chunk | 256 m square; 28 x 28 = 784 chunks; chunk (cx, cz) covers `[cx*256, cx*256+256)` on x and z, cx, cz in [-14, 13] |
| Physics colliders | 3 x 3 chunks around the player's sim position |
| Render streaming | chunks whose AABB is within `viewDistance + 32` m of the camera (viewDistance = current linear fog far = 0.4 x draw distance, 320 m by default); unload beyond `viewDistance + 160` m |
| LOD | LOD0 when the chunk AABB is nearer than 300 m (back to LOD1 beyond 340 m), else LOD1 |

District types (canonical names, used as string keys by every module):
`downtown, suburbs, industrial, highway, rural, campus, hospital, airport, harbor, park, water`.

- `highway` cells are a commercial strip along an at-grade divided state highway (2+2 lanes, median,
  signals at crossings). There are no grade separations in Phase 1.
- `water` cells (harbor basin) have no roads or buildings; land/water borders get a quay wall collider.
- `hospital`, `campus`, `airport`, `harbor` host POIs (§4.5).

The authored map (`src/data/world/districts.json`) is the single place to reshape the city.

## 4. Data formats

Every file has `"version": 1`. Owners in brackets (module keys, §16).

### 4.1 World [world]
`src/data/world/districts.json`
```jsonc
{ "version": 1, "cellSize": 512,
  "legend": { "D": "downtown", "S": "suburbs", "I": "industrial", "H": "highway", "R": "rural", "C": "campus",
              "M": "hospital", "A": "airport", "P": "harbor", "K": "park", "W": "water" },
  // row 0 = north (z in [-3584, -3072)), col 0 = west (x in [-3584, -3072)); this is the authored map
  "rows": [
    "RRRRRRRRRRRRRR",
    "RRRRRRRRRRAAAR",
    "RRRSSSSSRRAAAR",
    "RRSSSSSSSSIIRR",
    "RRSSSKSSSSIIRR",
    "RRSSCCDDDSIIRR",
    "RRSSCCDDDMSSRR",
    "HHHHHHHHHHHHHH",
    "RRSSSKSSSSIIPW",
    "RRSSSSSSSIIPPW",
    "RRRSSSSSIIIPWW",
    "RRRRSSSSSIPPWW",
    "RRRRRSSSRRPWWW",
    "RRRRRRRRRRWWWW" ],
  // full-length authored highway lines; "axis": "x" runs east-west at z = coord
  "highways": [ { "name": "State Highway 9", "axis": "x", "coord": 256, "from": -3584, "to": 3584 } ] }
```
`src/data/world/districtTypes.json` — one entry per district type name:
```jsonc
{ "version": 1, "types": { "downtown": {
    "subdivisions": 4, "jitter": 0.1, "oneWayPairs": true, "removeLocalFraction": 0,
    "ground": "concrete", "sidewalk": true, "trafficDensity": 1.4,
    "buildings": { "lotFrontage": [18, 40], "lotDepth": [20, 45], "setback": 0, "coverage": 0.95,
                   "height": [18, 110], "centerBoost": 1.6, "roof": "flat", "palette": ["#8a8f99", "#a39d8f"] },
    "props": { "streetlightSpacing": 32, "treesPer1000m2": 0.05, "hydrantSpacing": 90, "benchSpacing": 120 } } } }
```
`subdivisions` = blocks per cell per axis (interior grid lines = subdivisions - 1, jittered by
`jitter x block size`); 0 means no roads (water). `roof` is `flat | pitched | mixed`.

`src/data/world/roadClasses.json` — lanes are per direction:
```jsonc
{ "version": 1,
  "classes": {
    "highway":   { "lanes": 2, "laneWidth": 3.65, "median": 4, "shoulder": 2.5, "sidewalk": 0,   "speedMph": 55, "surface": "asphalt" },
    "arterial":  { "lanes": 2, "laneWidth": 3.5,  "median": 0, "shoulder": 0.5, "sidewalk": 2.5, "speedMph": 40, "surface": "asphalt" },
    "collector": { "lanes": 1, "laneWidth": 3.5,  "median": 0, "shoulder": 0.5, "sidewalk": 2.5, "speedMph": 35, "surface": "asphalt" },
    "local":     { "lanes": 1, "laneWidth": 3.25, "median": 0, "shoulder": 0.5, "sidewalk": 2,   "speedMph": 25, "surface": "asphalt" },
    "county":    { "lanes": 1, "laneWidth": 3.4,  "median": 0, "shoulder": 1.5, "sidewalk": 0,   "speedMph": 50, "surface": "asphalt" },
    "gravel":    { "lanes": 1, "laneWidth": 3.0,  "median": 0, "shoulder": 0.5, "sidewalk": 0,   "speedMph": 35, "surface": "gravel" },
    "service":   { "lanes": 1, "laneWidth": 3.0,  "median": 0, "shoulder": 0,   "sidewalk": 0,   "speedMph": 15, "surface": "asphalt" } },
  "districtSpeedMph": { "downtown": { "arterial": 35, "collector": 30 }, "campus": { "local": 20 }, "rural": { "county": 55 } },
  "signals": { "yellow": 4, "allRed": 1.5, "minGreen": 15, "cycle": { "highway": 100, "arterial": 80, "collector": 60, "local": 50 } } }
```
`src/data/world/zones.json`
```jsonc
{ "version": 1,
  "schoolZone": { "limitMph": 20, "windows": [[7.0, 8.5], [14.25, 16.0]], "weekdaysOnly": true, "radius": 150, "schoolsPerSuburbCell": 0.35 },
  "construction": { "edgeFraction": 0.02, "limitReductionMph": 10, "minLimitMph": 20, "classes": ["arterial", "collector", "local"] } }
```
`src/data/world/landmarks.json` — `{ "version": 1, "station": { "x": 192, "z": -320, "yaw": 0 }, "fuelStationsPerHighwayCell": 0.5, "fuelStationsPerUrbanCell": 0.1 }`
`src/data/world/streetNames.json` — generic word lists: `{ "version": 1, "words": ["Oak", "Maple", ...], "suffix": { "arterial": "Avenue", "collector": "Street", "local": "Street", "county": "County Road", "gravel": "Lane", "service": "Drive" } }`. North-south lines take words, east-west lines take ordinals (`12th Street`), county roads take numbers (`County Road 14`), highways use the authored name.

### 4.2 Vehicles [vehicles]
`src/data/vehicles/<id>.json`, one model per file (patrol_sedan, patrol_suv, compact, sedan, hatchback,
pickup, van, box_truck, city_bus):
```jsonc
{ "version": 1, "id": "patrol_sedan", "name": "Patrol Sedan", "role": "police",   // police | civilian | commercial
  "trafficWeight": 0,                     // relative spawn weight in traffic (0 = never)
  "body": { "style": "sedan",             // sedan | hatchback | suv | pickup | van | truck | bus
            "length": 5.1, "width": 1.95, "height": 1.15, "groundClearance": 0.32,  // body box (height excludes clearance)
            "wheelbase": 2.95, "track": 1.65, "cabin": { "start": 0.3, "end": 0.75, "height": 0.45, "inset": 0.1 } },
  "colors": [ { "hex": "#16181d", "weight": 3 }, { "hex": "#f2f2f2", "weight": 1 } ],
  "lightbar": true,
  "mass": 1850, "comHeight": 0.5,
  "engine": { "maxForce": 7500, "maxPowerKw": 230, "maxSpeedKmh": 225, "reverseMaxSpeedKmh": 30,
              "idleRpm": 750, "redlineRpm": 6200, "gearRatios": [3.2, 2.1, 1.5, 1.15, 0.9, 0.75], "finalDrive": 3.4 },
  "drive": "rwd",                          // fwd | rwd | awd
  "steering": { "maxAngleDeg": 34, "highSpeedFactor": 0.4, "rateDegPerS": 140 },
  "suspension": { "restLength": 0.3, "stiffness": 28, "compression": 2.4, "relaxation": 3.2, "maxTravel": 0.22, "maxForce": 25000 },
  "tires": { "radius": 0.36, "width": 0.25, "frictionSlip": 2.8, "sideStiffness": 1.0, "loadSensitivity": 0.3 },
  "brakes": { "maxForce": 60, "frontBias": 0.65, "abs": true, "handbrakeForce": 40,
              "heatPerKJ": 0.9, "coolingPerS": 0.025, "airflowCooling": 0.012, "fadeStartC": 350, "fadeEndC": 650, "minEfficiency": 0.45 },
  "fuel": { "capacityL": 70, "idleLph": 0.9, "litersPerKWh": 0.3 },
  "damage": { "minImpactSpeed": 2.0, "zoneStrength": 14, "engineFrontShare": 0.7, "tireBurstSpeed": 9,
              "stallBelow": 0.3, "stallChancePerS": 0.04, "failBelow": 0.05 },
  "traffic": { "maxAccel": 2.2, "comfortDecel": 2.5, "maxDecel": 7 } }
```
Rapier force units are tuned empirically against the acceptance tests in the vehicles brief; the numbers
above are starting points, not contracts. Field names and meanings are the contract.

`src/data/physics/surfaces.json` — grip multipliers per surface; ids are the index in this fixed order:
`asphalt=0, concrete=1, gravel=2, dirt=3, grass=4, sand=5` (the world module exports the same ids).
```jsonc
{ "version": 1, "surfaces": {
  "asphalt": { "grip": 1.0,  "rolling": 0.012, "wet": 0.72, "snow": 0.35 },
  "gravel":  { "grip": 0.66, "rolling": 0.03,  "wet": 0.9,  "snow": 0.55 },
  "grass":   { "grip": 0.5,  "rolling": 0.06,  "wet": 0.75, "snow": 0.6 } } }
```
Effective grip = `grip x lerp(1, wet, wetness) x lerp(1, snow, snowCover)`; wetness and snowCover come
from the environment (§10).

### 4.3 Traffic [traffic]
`src/data/traffic/violations.json`
```jsonc
{ "version": 1,
  // persistent per registered vehicle, drawn from the vehicle's own seeded record stream
  "vehicleFlags": { "expiredRegistration": 0.05, "noInsurance": 0.03, "stolen": 0.004,
                    "headlightOut": 0.02, "taillightOut": 0.02, "brakeLightOut": 0.015 },
  // driver tendencies; a record gets a propensity, the behaviour is rolled per trip at spawn
  "behaviors": {
    "speeding":   { "share": 0.12, "speedFactor": [1.12, 1.45] },
    "tailgating": { "share": 0.06, "headwayS": [0.35, 0.7] },
    "redLight":   { "share": 0.03, "lateRedS": 2.5 },
    "rollingStop":{ "share": 0.08 },
    "dui":        { "share": 0.004, "hourMultiplier": [6,6,7,5,3,1,0.3,0.2,0.2,0.2,0.2,0.3,0.4,0.4,0.4,0.5,0.6,0.8,1,1.5,2.5,3.5,4.5,5.5],
                    "weaveAmplitude": [0.4, 1.1], "weavePeriodS": [4, 9], "speedJitter": 0.15 } },
  "observeRadius": 150 }
```
`src/data/traffic/density.json`
```jsonc
{ "version": 1, "capacity": 192, "baseActive": 110,
  "district": { "downtown": 1.4, "suburbs": 0.8, "industrial": 0.7, "highway": 1.2, "rural": 0.25, "campus": 0.8,
                "hospital": 1.0, "airport": 0.5, "harbor": 0.6, "park": 0.4, "water": 0 },
  "hourMultiplier": [0.25,0.18,0.15,0.15,0.2,0.4,0.8,1.3,1.35,1,0.9,0.95,1.05,1,0.95,1.05,1.25,1.35,1.2,0.95,0.75,0.6,0.45,0.35],
  "radii": { "spawnMin": 280, "spawnMax": 400, "initialMin": 30, "despawn": 440, "proxy": 45, "proxyRelease": 55 },
  "spawnPerTick": 4, "tickS": 0.5 }
```
`src/data/traffic/registry.json` — `{ "version": 1, "population": 60000, "yearRange": [2004, 2026] }`.

### 4.4 Environment and crime [environment]
`src/data/environment/time.json` — `{ "version": 1, "startWeekday": 0, "startHour": 7.0, "gameSecondsPerSimSecond": 30 }`
`src/data/environment/sky.json`
```jsonc
{ "version": 1, "sunriseHour": 6.25, "sunsetHour": 19.0, "maxSunElevationDeg": 62,
  "keyframes": [   // by hour, interpolated with wrap-around; colours sRGB hex
    { "hour": 0,  "skyTop": "#05070d", "skyHorizon": "#141a26", "fog": "#10141c", "sunColor": "#9fb2ff", "sunIntensity": 0.0,
      "moonIntensity": 0.25, "ambientSky": "#26324a", "ambientGround": "#0c0c10", "ambientIntensity": 0.35 } ],
  "streetlights": { "onWhenSunBelowDeg": 4 }, "headlights": { "onWhenSunBelowDeg": 6 } }
```
`src/data/environment/weather.json`
```jsonc
{ "version": 1, "kinds": {
    "clear":  { "cloudCover": 0.1, "fogDensity": 0,      "precip": 0, "temperatureC": 22 },
    "cloudy": { "cloudCover": 0.8, "fogDensity": 0.0004, "precip": 0, "temperatureC": 16 },
    "rain":   { "cloudCover": 1,   "fogDensity": 0.0015, "precip": 1, "temperatureC": 12 },
    "storm":  { "cloudCover": 1,   "fogDensity": 0.0025, "precip": 1, "temperatureC": 11 },
    "fog":    { "cloudCover": 0.6, "fogDensity": 0.012,  "precip": 0, "temperatureC": 9 },
    "snow":   { "cloudCover": 1,   "fogDensity": 0.002,  "precip": 1, "temperatureC": -3 },
    "heat":   { "cloudCover": 0,   "fogDensity": 0.0003, "precip": 0, "temperatureC": 36 } },
  "transitions": { "clear": { "clear": 0.45, "cloudy": 0.3, "fog": 0.1, "heat": 0.15 }, "cloudy": { "clear": 0.3, "rain": 0.4, "snow": 0.1, "cloudy": 0.2 } },
  "segmentHours": [2, 8], "blendMinutes": 20, "wetRampMinutes": 15, "dryMinutes": 120, "snowRampMinutes": 60, "meltMinutes": 360 }
```
`src/data/crime/timeOfDay.json` (data only; consumed by the Phase 3 call generator)
```jsonc
{ "version": 1,
  "categories": {
    "traffic":  { "label": "Traffic incident", "baseRatePerHour": 0.8,
                  "hourly": [24 relative weights], "weekday": [7 multipliers, Monday first],
                  "district": { "downtown": 1.3, "highway": 1.6, "rural": 0.6 } } } }
```
Categories: `traffic, dui, theft, burglary, robbery, assault, domestic, disturbance, vandalism, suspicious,
alarm, medical, welfare`. Missing district keys mean multiplier 1.

### 4.5 POIs
The generator emits `pois: Poi[]` with `kind` in `station | hospital | campus | airport | harbor | school |
fuel | park`. Each POI has a reserved block (special building set) and an `entrance` point on the nearest
road. The station POI is the session spawn point (player on foot plus two parked patrol vehicles in its
lot) and has a fuel pump; fuel POIs are refuel spots.

## 5. Road graph contract [world] (`src/world/roadGraph.ts`)

Phase 2 CAD/AVL, dispatch routing and backup response times depend on this API; keep it stable.

```ts
export const ROAD_CLASS = { highway: 0, arterial: 1, collector: 2, local: 3, county: 4, gravel: 5, service: 6 } as const;
export const JUNCTION = { none: 0, signal: 1, allWayStop: 2, minorStop: 3 } as const; // minorStop: lower class stops
export const EDGE_FLAG = { oneWay: 1, divided: 2, schoolZone: 4, construction: 8 } as const;
export const SURFACE = { asphalt: 0, concrete: 1, gravel: 2, dirt: 3, grass: 4, sand: 5 } as const;
export const DISTRICT = { downtown: 0, suburbs: 1, industrial: 2, highway: 3, rural: 4, campus: 5,
                          hospital: 6, airport: 7, harbor: 8, park: 9, water: 10 } as const;
export const ASPECT = { green: 0, yellow: 1, red: 2 } as const;
export const TURN = { straight: 0, left: 1, right: 2, uturn: 3 } as const;
// each also exports `type XId = (typeof X)[keyof typeof X]` and a NAMES array indexed by id

export interface RoadNode {
  readonly id: number; readonly x: number; readonly z: number;
  readonly junction: JunctionId;
  readonly edges: readonly number[];   // incident edges, sorted CCW (from +X) by the heading leaving the node
  readonly signal: number;             // index into graph.signals, -1 if none
  readonly setback: number;            // m from node centre to the stop line / lane start
}
export interface RoadEdge {
  readonly id: number; readonly from: number; readonly to: number;
  readonly roadClass: RoadClassId;
  readonly lanesForward: number;       // lanes travelling from -> to (>= 1)
  readonly lanesBackward: number;      // lanes travelling to -> from; 0 = one-way (from -> to is the travel direction)
  readonly laneWidth: number; readonly median: number; readonly shoulder: number; readonly sidewalk: number;
  readonly width: number;              // kerb to kerb: (lanesF + lanesB) * laneWidth + median + 2 * shoulder
  readonly speedLimitMph: number;      // class/district limit; zones are applied by effectiveSpeedLimitMph
  readonly flags: number;              // EDGE_FLAG bits
  readonly surface: SurfaceId;
  readonly length: number;             // m along the centreline polyline
  readonly points: Float32Array;       // centreline x0,z0,x1,z1,... first = from node, last = to node
  readonly name: string;               // generated street name
  readonly district: DistrictId;       // district at the edge midpoint
}
export interface SignalDef {
  readonly id: number; readonly node: number;
  readonly cycle: number; readonly offset: number;   // s; local t = (simTime + offset) mod cycle
  readonly green: readonly [number, number];         // green s for group 0 (x-axis approaches), group 1 (z-axis)
  readonly yellow: number; readonly allRed: number;  // cycle = g0 + g1 + 2 * (yellow + allRed)
}   // order: G0 green, G0 yellow, all red, G1 green, G1 yellow, all red

export type LaneRef = number;  // edge * 16 + dir * 8 + index; dir 0 = from -> to, 1 = to -> from; index 0 = curb lane
export function laneRef(edge: number, dir: 0 | 1, index: number): LaneRef;
export function laneEdge(lane: LaneRef): number;      // lane >>> 4
export function laneDir(lane: LaneRef): 0 | 1;        // (lane >>> 3) & 1
export function laneIndex(lane: LaneRef): number;     // lane & 7

export interface LanePoint { x: number; z: number; hx: number; hz: number; yaw: number }
export interface RoadHit { edge: number; s: number; t: number; x: number; z: number; distance: number; side: -1 | 1 }
export interface LaneConnection { readonly edge: number; readonly dir: 0 | 1; readonly turn: TurnId }
export interface ZoneTime { readonly hour: number; readonly isWeekday: boolean }   // environment's GameTime satisfies it
export interface RouteOptions { readonly cost?: 'time' | 'distance'; readonly ignoreOneWay?: boolean; readonly avoidEdges?: ReadonlySet<number> }
export interface Route { readonly nodes: readonly number[]; readonly edges: readonly number[]; readonly length: number; readonly time: number }
export interface PointRoute extends Route { readonly start: RoadHit; readonly end: RoadHit; readonly polyline: Float32Array }

export class RoadGraph {
  constructor(nodes: RoadNode[], edges: RoadEdge[], signals: SignalDef[]); // builds spatial hash (64 m) + connections
  readonly nodes: readonly RoadNode[]; readonly edges: readonly RoadEdge[]; readonly signals: readonly SignalDef[];
  nearestEdge(x: number, z: number, maxDistance: number, out: RoadHit): RoadHit | null;  // allocation-free
  edgesNear(x: number, z: number, radius: number, out: number[]): number[];             // clears + fills out, ascending
  nodesNear(x: number, z: number, radius: number, out: number[]): number[];
  laneCount(edge: number, dir: 0 | 1): number;
  laneOffset(lane: LaneRef): number;          // signed offset of lane centre from centreline, + = right of from -> to
  laneLength(lane: LaneRef): number;          // edge.length
  laneStartNode(lane: LaneRef): number; laneEndNode(lane: LaneRef): number;
  laneStart(lane: LaneRef): number; laneEnd(lane: LaneRef): number;  // usable s range [setback(start), length - setback(end)]
  lanePoint(lane: LaneRef, s: number, out: LanePoint): LanePoint;   // s from the lane's start node along travel
  connections(edge: number, dir: 0 | 1): readonly LaneConnection[]; // exits at the end node; U-turn only at dead ends
  approachGroup(edge: number, dir: 0 | 1): 0 | 1;                     // 0 = travelling along x, 1 = along z
  signalAspect(signal: number, group: 0 | 1, simTime: number): AspectId;
  signalTimeToChange(signal: number, group: 0 | 1, simTime: number): number;
  isSchoolZoneActive(edge: number, time: ZoneTime): boolean;
  effectiveSpeedLimitMph(edge: number, time: ZoneTime): number;     // school zone when active, construction reduction
  findRoute(fromNode: number, toNode: number, options?: RouteOptions): Route | null;      // A*
  routeBetweenPoints(ax: number, az: number, bx: number, bz: number, options?: RouteOptions): PointRoute | null;
}
```
Lane centre offsets (w = laneWidth, m = median): two-way, dir 0, index i: `+(m/2 + (lanesForward - i - 0.5) w)`;
dir 1: `-(m/2 + (lanesBackward - i - 0.5) w)`; one-way (dir 0 only): `+((lanesForward - 1) / 2 - i) w`.
A* uses a binary heap on reusable typed arrays and an admissible heuristic (straight distance; for time cost
divided by the fastest limit). Time cost = length / limit + junction penalty (signal 8 s, stop 4 s).
`ignoreOneWay` is for emergency driving (later phases). The graph is strongly connected (generator invariant).

City-level API (`src/world/city.ts`, `generate.ts`, `surface.ts`, `chunkLayout.ts`):
```ts
export const WORLD_HALF_SIZE = 3584, CHUNK_SIZE = 256, DISTRICT_CELL = 512, CHUNKS_PER_SIDE = 28;
export function chunkCoord(v: number): number;            // floor(v / CHUNK_SIZE)
export function chunkKey(cx: number, cz: number): number; // (cx + 64) * 128 + (cz + 64), stable int key
export interface Block { readonly id: number; readonly minX: number; readonly minZ: number; readonly maxX: number;
  readonly maxZ: number; readonly district: DistrictId; readonly kind: BlockKindId; readonly poi: number }
export const BLOCK_KIND = { lots: 0, park: 1, parking: 2, plaza: 3, runway: 4, water: 5, farm: 6, yard: 7, green: 8 } as const;
export interface Poi { readonly id: number; readonly kind: PoiKind; readonly name: string; readonly x: number; readonly z: number;
  readonly yaw: number; readonly block: number; readonly entrance: { readonly x: number; readonly z: number; readonly edge: number } }
export interface City {
  readonly seed: number; readonly graph: RoadGraph; readonly blocks: readonly Block[]; readonly pois: readonly Poi[];
  readonly spawn: { readonly x: number; readonly z: number; readonly yaw: number };           // station door, on foot
  readonly parking: readonly { readonly x: number; readonly z: number; readonly yaw: number }[]; // station lot slots
  districtAt(x: number, z: number): DistrictId;   // water outside the map
  surfaceAt(x: number, z: number): SurfaceId;     // road -> class surface, sidewalk -> concrete, else block ground; allocation-free
  blocksIn(minX: number, minZ: number, maxX: number, maxZ: number, out: number[]): number[];
}
export function generateCity(seed: number): City;            // deterministic, < 400 ms on desktop
export function chunkLayout(city: City, cx: number, cz: number): ChunkLayout;   // deterministic, order-independent
```

## 6. City generation (pure, `generateCity(seed)`)

All randomness from `createRng(seed).stream(name)` with stable names (`'world:lines'`, `'world:cell:<col>,<row>'`,
`'world:block:<id>'`, `'world:signals'`, `'world:zones'`, `'world:pois'`).
1. **District map**: parse `districts.json` (validate 14x14, legend). `districtAt` is an O(1) cell lookup.
2. **Grid lines**: every district-cell boundary (x and z = -3584 + 512k) is a road line, except where both
   neighbouring cells are `water` (and the map border, which is only a road next to non-water). Inside each
   cell, `subdivisions - 1` interior lines per axis at `block * k + jitter`, clipped to the cell (they end in
   T-junctions on the boundary lines). Interior lines parallel to and within 64 m of an authored highway are
   dropped; the authored highway lines are added at their exact coordinates.
3. **Classes**: highway lines -> `highway`; boundary lines -> `arterial` in urban cells, `county` in rural or
   airport cells (a line takes the higher class of its two sides per segment); the middle interior line of a
   downtown/suburbs cell -> `collector`; other interior lines -> `local`; rural cells get one `gravel` interior
   line with probability 0.3; airport and harbor interior lines -> `service`.
4. **Nodes and edges**: intersect all lines (axis-aligned, so exact); a node at every crossing/T/end; an edge
   between consecutive nodes on a line. Downtown interior local lines alternate one-way direction (odd east or
   north, even west or south, 2 lanes, `oneWay` flag, `from -> to` = travel direction). `divided` flag on
   highway edges.
5. **Variety**: in suburbs remove `removeLocalFraction` of local edges whose end nodes keep degree >= 3; then
   verify strong connectivity (Tarjan) and restore removed edges in reverse order until it holds.
6. **Junction control**: any incident highway edge -> signal; two or more incident edges of class
   collector or higher and degree >= 3 -> signal; degree >= 3 all local -> allWayStop; other degree >= 3 ->
   minorStop; degree <= 2 -> none. `setback` = half of the widest crossing road + 1.5 m (crosswalk).
7. **Signals**: cycle by the highest incident class (roadClasses.json); greens split by the class weight of
   each axis, at least `minGreen`; offset = stream draw in [0, cycle).
8. **Zones**: schools are POIs on suburb blocks (`schoolsPerSuburbCell`); edges with any point within
   `radius` of a school get `schoolZone`. `construction` on `edgeFraction` of edges of the listed classes.
9. **Names**: one name per grid line (§4.1); highway names from the data.
10. **Blocks and POIs**: blocks are the rectangles between consecutive lines inside a cell; block kind from
   the district (park cells -> park, airport centre -> runway, harbor quays -> yard, rural -> farm, etc.).
   POIs reserve blocks: station (block containing `landmarks.station`, which also gets a parking lot and a
   fuel pump), hospital, campus, airport terminal, harbor office, schools, fuel stations. `spawn` is the station
   door; `parking` has at least 4 lot slots.
11. **Buildings/props per block** (in `chunkLayout`, using the block's own stream so results do not depend on
   which chunk asks first): lots along each block side (frontage/depth ranges, setback), one box per lot,
   height from the district range (downtown boosted toward the city centre), colour from the palette, roof
   kind; POI blocks use fixed building sets (hospital tower + wings, terminal + hangars, container stacks,
   campus quads). Streetlights every `streetlightSpacing` m along kerbs (both sides in urban districts, at
   junctions only in rural), trees by density in yards/parks/farm hedges, hydrants, benches, cones/barriers
   along construction edges, fuel pumps. Signs: stop/yield at controlled approaches, speed limit after each
   junction exit, school zone at zone ends, one-way at one-way entries, construction at zone ends. Signal
   heads: one per approach at the far-right corner facing the approach. A chunk returns the buildings, props
   and signs whose centre lies inside it, and every edge/node that touches it.

## 7. Chunks: layout, colliders, meshes, streaming

### 7.1 Chunk layout [world] (`src/world/chunkLayout.ts`)
Flat typed arrays so the worker can transfer them and the main thread can read them without allocation.
```ts
export const BUILDING_STRIDE = 8; // minX, minZ, maxX, maxZ, height, roof (ROOF id), color (0xRRGGBB as float), style (district id)
export const PROP_STRIDE = 5;     // kind (PROP id), x, z, yaw, scale
export const SIGN_STRIDE = 5;     // kind (SIGN id), x, z, yaw, value (mph for speedLimit, else 0)
export const HEAD_STRIDE = 5;     // signal id, group (0|1), x, z, yaw (faces the approaching traffic)
export const GROUND_STRIDE = 6;   // minX, minZ, maxX, maxZ, surface (SURFACE id), block kind (BLOCK_KIND id)
export const COLLIDER_STRIDE = 7; // centre x, y, z, half x, y, z, yaw
export const ROOF = { flat: 0, pitched: 1 } as const;
export const PROP = { streetlight: 0, tree: 1, bush: 2, hydrant: 3, bench: 4, cone: 5, barrier: 6, container: 7,
                      fuelPump: 8, bollard: 9, lotLight: 10 } as const;
export const SIGN = { stop: 0, yield: 1, speedLimit: 2, schoolZone: 3, oneWay: 4, construction: 5, noEntry: 6 } as const;
export interface ChunkLayout {
  readonly cx: number; readonly cz: number;
  readonly buildings: Float32Array; readonly props: Float32Array; readonly signs: Float32Array;
  readonly signalHeads: Float32Array; readonly ground: Float32Array;   // ground clipped to the chunk
  readonly edges: Uint32Array; readonly nodes: Uint32Array;           // touching the chunk
  readonly colliders: Float32Array;  // buildings, poles, trunks, containers, pumps, quay walls (centre inside chunk)
}
```

### 7.2 Physics colliders [world] (`src/world/colliders.ts`)
```ts
export class WorldColliders {
  constructor(physics: PhysicsWorld, city: City, options?: { radiusChunks?: number /* 1 = 3x3 */; maxChunkOpsPerStep?: number /* 1 */ });
  update(x: number, z: number): void;   // fixed step, player sim position; adds then removes, sorted (cz, cx) order
  prime(x: number, z: number): void;    // loads the whole window now (session start, load, teleport)
  readonly loadedChunks: number; readonly colliderCount: number;
  dispose(): void;                      // removes the colliders it created (skip when the physics world is being disposed)
}
```
Fixed cuboid colliders are created with `physics.raw.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz)
.setTranslation(x, y, z).setRotation(yawQuat))` (no parent body, no entity id; collision events report
`undefined` for them like the ground). The ground stays one big fixed slab (integrator:
`createScenePhysics` with half size `WORLD_HALF_SIZE + 64`). Collider streaming follows the player's sim
position in the fixed step, so it is deterministic for a given input sequence.

### 7.3 Worker split
- **Chunk worker** [cityRender] (`src/world/render/chunk.worker.ts`): `init { seed }` runs `generateCity(seed)`
  inside the worker (same pure code, identical result); `build { cx, cz, lod }` returns mesh buffers
  (positions, normals, colours, uvs, indices per material group, bounding sphere) as transferables. Requests
  made before `init` resolves are queued. Render-only: arrival timing never touches the simulation.
- **Main thread, fixed step**: city generation (once per session, ~0.1-0.4 s during the load screen),
  colliders, vehicles and traffic. Traffic stays on the main thread because a worker would deliver results
  with timing jitter and break the "same seed + same inputs = same shift" rule; it is allocation-free SoA
  and pure enough to move to a lock-step worker later.
- The Phase 0 `sim.worker.ts` (ping/RNG check) is unchanged.

### 7.4 Meshes, LOD, culling [cityRender]
Per chunk and LOD, one `THREE.Group` with merged, vertex-coloured meshes (no instancing needed for static
content): `ground` (block ground + sidewalks + roads + junctions), `markings` (lane lines, stop lines,
crosswalks; y = 0.02 with polygonOffset), `buildings` (one material for all buildings: canvas-generated
window texture as `map` and `emissiveMap`, world-metre UVs, emissive intensity = night factor), `props`
(trees, poles, signs, benches, pumps, cones merged), `lamps` (emissive lamp heads and sign faces). LOD1 =
ground + buildings (no windows texture detail beyond the material, no markings, no props) + lamps. Budget:
<= 5 draw calls per LOD0 chunk, <= 3 per LOD1 chunk; only LOD0 `buildings` and `props` cast shadows.
Frustum culling is three's per-mesh test; the worker sends each mesh's bounding sphere so the main thread
never computes it. Traffic signal heads are one global `InstancedMesh` (lamp colours via `instanceColor`,
refreshed each frame for heads within 200 m). Streetlights: emissive heads plus a fixed pool of 4
`PointLight`s (never added/removed, so shaders never recompile) moved to the streetlights nearest the
camera at night, intensity 0 by day.

### 7.5 Streaming (`ChunkStreamer`)
Pure core `desiredChunks(camX, camZ, viewDistance, current, out)` returns the wanted set with LOD and
hysteresis (§3 numbers); the streamer requests missing chunk/LOD pairs nearest-first (at most 3 in flight),
keeps the old LOD visible until the new one arrives, uploads at most 1 chunk per frame, disposes geometry of
unloaded chunks, and caps residency at 96 chunks. Without a worker (headless, tests, worker failure) it
meshes synchronously, 1 chunk per frame.

## 8. Vehicle physics [vehicles] (`src/vehicles/**`)

Player-drivable vehicles use Rapier's `DynamicRayCastVehicleController` (see `docs/research/rapier.md`:
create with `world.createVehicleController(chassis)`, forward axis via the setter property
`vehicle.setIndexForwardAxis = 2`, `indexUpAxis = 1`, call `updateVehicle(dt, QueryFilterFlags.EXCLUDE_DYNAMIC
| EXCLUDE_SENSORS, undefined, notOwnChassis)` before every `world.step()`, read wheels back with the
`wheel*` getters using `target` objects). Traffic does not use it (§9).

- **Chassis**: dynamic body, cannot sleep, `setAdditionalMassProperties`/collider placement so the centre of
  mass sits at `comHeight` above the ground; cuboid collider = body box. The body is registered with
  `PhysicsWorld.registerBody(eid, body)` (new small API in `src/physics/physics.ts`, owned by [vehicles]) so
  `syncToEcs`, `getBody` and collision events map it to the entity.
- **Weight transfer feel** comes from the raised COM and per-model suspension; tyre `frictionSlip` per wheel
  is scaled by load (`(Fz / Fz_static) ^ -loadSensitivity`, clamped) so the loaded tyres saturate.
- **Grip by surface**: every step each wheel's contact point is classified with the injected
  `env.surfaceAt(x, z)` and its `frictionSlip`/`sideFrictionStiffness` scaled by
  `surfaceGrip(surface, env.wetness, env.snowCover)` (§4.2).
- **Drivetrain**: automatic gearbox (ratios for rpm display and shift points), force =
  `min(maxForce, maxPower / max(v, 1))` on the driven wheels, reverse when stopped and the brake is held
  (`mapDriverInput`), rolling resistance and aero drag (drag area derived from max power and top speed).
  Steering: max angle shrinks with speed (`highSpeedFactor`), rate-limited (`rateDegPerS`).
- **ABS**: a wheel locks when the demanded brake exceeds what its current grip can carry. Without ABS a
  locked wheel keeps full brake but loses most side grip (no steering, longer stops on low grip); with ABS
  the brake is held just under the limit and pulsed at ~12 Hz, side grip is kept, `telemetry.absActive` is
  true. Pure helper `absModulate`.
- **Brake fade**: per-axle temperature rises with braking energy (`heatPerKJ`), cools toward ambient
  (`coolingPerS` + `airflowCooling * speed`); efficiency is 1 below `fadeStartC`, falls linearly to
  `minEfficiency` at `fadeEndC`. Pure helpers `updateBrakeTemp`, `brakeEfficiency`.
- **Fuel**: litres per step = `idleLph * dt / 3600 + litersPerKWh * engineKw * dt / 3600`; an empty tank cuts
  the engine (`vehicle:fuelEmpty`, once). `refuel()` at the station pump / fuel POIs (interact, stopped).
- **Damage**: impacts are detected from the chassis velocity change across the physics step (the part not
  explained by the vehicle's own forces): `impactSpeed = |Δv_horizontal|` above `damage.minImpactSpeed`
  counts as a hit; its direction in the chassis frame picks the zone (front/rear/left/right).
  - Cosmetic: zone damage 0..1 += impactSpeed / zoneStrength; written to `VehicleLook.damage` (tint +
    crumple drawn by [vehicleRender]).
  - Mechanical: front hits reduce `engineHealth` (`engineFrontShare`); below `stallBelow` the engine stalls
    at random (vehicle RNG stream) for 1-3 s; below `failBelow` it fails (`vehicle:engineFailed`). An impact
    above `tireBurstSpeed` near a wheel flattens that tyre (radius x0.85, grip x0.45: the car pulls).
  - `repair()` restores everything (debug command / station).
- Lights: `headlights` (auto-on from the environment or toggled with H), brake, reverse and light-bar bits are
  written to `VehicleLook.lights[eid]` every step.

```ts
export interface DriverInput { accelerate: number; brake: number; steer: number; handbrake: boolean } // raw, from [player]
export interface DriverControls { throttle: number; brake: number; steer: number; handbrake: boolean; reverse: boolean }
export function mapDriverInput(input: DriverInput, forwardSpeed: number, reversing: boolean, out: DriverControls): DriverControls;
export interface VehicleEnvironment { surfaceAt(x: number, z: number): number; wetness: number; snowCover: number; ambientC: number }
export interface VehiclePose { x: number; y: number; z: number; yaw: number }
export interface WheelPose { x: number; y: number; z: number; steer: number; spin: number; radius: number; inContact: boolean } // chassis-local
export interface VehicleTelemetry {
  speed: number; speedKmh: number; speedMph: number;          // signed forward speed
  rpm: number; gear: number;                                   // -1 reverse, 1..n
  throttle: number; brake: number; steer: number; absActive: boolean; handbrake: boolean;
  fuelL: number; fuelFraction: number; engineRunning: boolean; engineHealth: number;
  brakeTempC: number; brakeEfficiency: number;                 // hottest axle
  tireFlat: readonly [boolean, boolean, boolean, boolean];     // FL, FR, RL, RR
  damage: readonly [number, number, number, number];           // front, rear, left, right 0..1
  wheelSurface: readonly [number, number, number, number]; airborne: boolean }
export interface SerializedVehicle { modelId: string; x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number;
  vx: number; vy: number; vz: number; wx: number; wy: number; wz: number; fuelL: number; brakeTempC: [number, number];
  zones: [number, number, number, number]; engineHealth: number; engineFailed: boolean; tireFlat: [boolean, boolean, boolean, boolean];
  headlights: boolean; lightbar: boolean; reversing: boolean }
export class DrivableVehicle {
  static create(physics: PhysicsWorld, eid: EntityId, model: VehicleModel, pose: VehiclePose, rng: Rng): DrivableVehicle;
  static restore(physics: PhysicsWorld, eid: EntityId, data: SerializedVehicle, rng: Rng): DrivableVehicle;
  readonly eid: EntityId; readonly model: VehicleModel; readonly wheelCount: number;
  readonly telemetry: Readonly<VehicleTelemetry>;   // same object, updated in place
  headlights: boolean; lightbar: boolean;
  setControls(controls: DriverControls): void;
  preStep(dt: number, env: VehicleEnvironment): void;          // before physics.step()
  postStep(dt: number, bus?: EventBus<EventMap>): void;          // after physics.step(): damage, lights, events
  wheelPose(i: number, out: WheelPose): WheelPose;
  refuel(liters?: number): void; repair(): void;
  serialize(): SerializedVehicle;
  dispose(): void;                                             // removes controller, body and colliders
}
```
Wheels are indexed FL, FR, RL, RR. Wheel world pose = chassis pose x local `wheelPose`.

## 9. Ambient traffic [traffic] (`src/traffic/**`)

### 9.1 Vehicle registry (persistent identities for CAD)
The city has `population` registered vehicles, ids `0 .. population-1`. A record is a pure function of
`(seed, id)` (its own stream `'registry:<id>'`), so nothing is stored and CAD can look up any vehicle,
spawned or not. Plates are a bijection: `n = (id * A + B(seed)) mod M` with `M = 26^3 * 10^4`, `A` coprime
to M, rendered as `ABC 1234`; `vehicleIdFromPlate` inverts it (modular inverse) and rejects ids outside the
population.
```ts
export interface VehicleRecord { readonly id: number; readonly plate: string; readonly modelId: string; readonly modelIndex: number;
  readonly color: number; readonly year: number; readonly registrationExpired: boolean; readonly insured: boolean;
  readonly stolen: boolean; readonly faults: number;            // FAULT bits (vehicles module)
  readonly ownerSeed: number;                                   // Phase 2 derives the owner identity from this
  readonly tendencies: { readonly speeding: boolean; readonly tailgating: boolean; readonly redLight: boolean;
                         readonly rollingStop: boolean; readonly duiRisk: number } }
export function vehicleRecord(seed: number, id: number): VehicleRecord;
export function plateOf(seed: number, id: number): string;
export function vehicleIdFromPlate(seed: number, plate: string): number | null;
```
Spawns walk the registry with a stride coprime to the population (`id = (seq * STRIDE + offset) mod
population`), skipping ids that are already on the road, so ids repeat only after the whole population.

### 9.2 Simulation model (fixed step, main thread, allocation-free)
- **State**: SoA typed arrays sized to `capacity` (192): eid, vehicleId, model, lane, s, speed, desiredFactor,
  headway, nextLane, junction connector (p0, control, p2, t, length), state (`driving | waiting | crashed |
  parked`), behaviour bits, weave phase, lateral offset, x, z, yaw. Every active car is an ECS entity
  (`Transform`, `PrevTransform`, `VehicleLook`, `TrafficCar`, `EntityKind = KIND.Vehicle`).
- **Longitudinal**: IDM `a = aMax [1 - (v/v0)^4 - (s*/gap)^2]`, `s* = s0 + vT + v dv / (2 sqrt(aMax b))`,
  with `v0 = effectiveSpeedLimit x desiredFactor`, `T` = 1.2-1.6 s (tailgaters 0.35-0.7 s), `b` = model
  comfort decel; decel clamped to `maxDecel`. Leader = next car on the same lane (cars kept sorted by
  (lane, s) with an insertion sort each step), else the first car on the chosen next lane, else a virtual
  stopped obstacle at the stop line when the car must stop, else the player (§9.3) when in the lane ahead.
- **Junctions**: the next lane is chosen when a car enters a lane (seeded draw among `connections`, lane
  index clamped to the target's lane count, no U-turns). At the stop line: signal -> stop on red, on yellow
  when it can stop at comfort decel; stop signs -> full stop 1 s (rolling stoppers slow to 3 m/s), then a
  per-node occupancy check (one approach at a time); left turns at signals yield to oncoming cars within 35 m.
  Crossing uses a quadratic Bezier connector (stop line point, lane-lines intersection, next lane start).
- **Law breaking** (§4.3): speeding (desiredFactor > 1), tailgating (short headway), red-light running
  (continues if the light turned red less than `lateRedS` ago), rolling stops, DUI (sinusoidal lateral
  weave, speed jitter, late braking; probability x hour multiplier at spawn), equipment faults
  (`VehicleLook.faults` from the record: a dark headlight at night), expired registration (record flag
  only). When a violation happens within `observeRadius` of the player a `traffic:violation` event is emitted.
- **Player interaction**: `TrafficFocus` gives the player's position and an obstacle (player car or the
  officer on foot): a car treats it as its leader when it is within the lane width ahead. Cars within
  `radii.proxy` of the focus get a kinematic velocity-based Rapier box (`physics.addBox(eid, ..., { kinematic:
  true })`, velocity = (target - position) / dt, rotation set each step), released beyond `proxyRelease`. A
  collision between a proxy and the player car marks the car `crashed` (stops, hazards on) and emits
  `traffic:collision`.
- **Density**: every `tickS` despawn cars beyond `despawn` (crashed cars beyond 150 m), then spawn up to
  `spawnPerTick` cars on random lanes in the spawn ring until `baseActive x district x hour` (clamped to
  capacity) is reached; `populate(focus)` fills the target at session start (30-400 m, never within 25 m).
  Spawn/despawn radii are data constants, never render settings.

```ts
export interface TrafficFocus { x: number; z: number; obstacle: boolean; ox: number; oz: number; ovx: number; ovz: number; oRadius: number }
export interface TrafficDeps { world: GameWorld; physics: PhysicsWorld; graph: RoadGraph; seed: number;
  rng: Rng;                       // session.rng.stream('traffic')
  bus?: EventBus<EventMap> }
export const TRAFFIC_STATE = { driving: 0, waiting: 1, crashed: 2, parked: 3 } as const;
export class TrafficSystem {
  constructor(deps: TrafficDeps);
  populate(focus: TrafficFocus, time: ZoneTime): void;
  step(dt: number, simTime: number, time: ZoneTime, focus: TrafficFocus): void; // writes Transform/VehicleLook
  readonly activeCount: number; readonly capacity: number;
  readonly view: TrafficView;                    // read-only SoA for HUD/minimap: count, x, z, yaw, speed, state, vehicleId, eid
  slotOfEntity(eid: EntityId): number;           // -1 when not a traffic car
  vehicleIdOfEntity(eid: EntityId): number;      // -1 when not a traffic car
  snapshot(): TrafficSnapshot; restore(snapshot: TrafficSnapshot): void; // exact continuation after a load
  clear(): void; dispose(): void;
  readonly stats: { active: number; proxies: number; spawned: number; despawned: number };
}
```

## 10. Environment [environment] (`src/environment/**`)

- **Game time** from `GameClock.simTime`: `gameSeconds = startHour * 3600 + simTime * rate + timeOffset`
  (`timeOffset` is saved; the `time HH:MM` command moves it forward so time never runs backward).
- **Sun/moon**: sunrise/sunset hours from data; the sun moves east -> south -> west with elevation
  `maxSunElevation * sin(pi * dayFraction)`; the moon is opposite. `nightFactor` (0 day .. 1 night) is
  smooth around the horizon; streetlights and auto headlights switch on below the data thresholds.
- **Sky**: keyframes by hour interpolated with wrap-around, then darkened/desaturated by cloud cover.
- **Weather timeline**: deterministic from `(seed, game time)`: segments of `segmentHours` drawn from the
  Markov `transitions`, kinds blended over `blendMinutes`. Road `wetness` ramps up during rain/storm
  (`wetRampMinutes`) and dries over `dryMinutes` after; `snowCover` ramps over `snowRampMinutes` and melts
  over `meltMinutes`. Both are O(1) functions of the current and previous segment, so nothing but the
  optional debug override needs saving.
- **Rendering** (render-only, main thread): sky dome (inverted sphere, gradient + sun/moon discs, follows
  the camera, no fog), directional sun/moon light whose shadow camera follows the focus point (+-150 m,
  snapped to shadow texels; shadows off at night), hemisphere ambient, `THREE.Fog` colour from the sky and
  far distance = min(draw-distance far, weather visibility), GPU precipitation (one `Points`/instanced
  streak mesh in a 40 m box around the camera, animated in the vertex shader from a time uniform: zero
  per-frame CPU work), and a heat-haze post pass (render to a target, distort near the horizon) enabled only
  in `heat` weather. To support it [environment] owns two small changes to `src/render/renderer.ts`:
  `gl.info.autoReset = false` with one `info.reset()` per frame (draw-call stats stay correct for
  multi-pass frames) and `setPostProcess(pass: PostProcess | null)` used by `render()`.
- **Crime patterns**: `src/data/crime/timeOfDay.json` with a validator and a pure lookup; nothing consumes
  it until Phase 3.

```ts
export interface GameTime { totalSeconds: number; day: number; weekday: number; isWeekday: boolean; hour: number; minute: number }
export const WEATHER = { clear: 0, cloudy: 1, rain: 2, storm: 3, fog: 4, snow: 5, heat: 6 } as const;
export type WeatherKind = keyof typeof WEATHER;
export interface WeatherState { kind: WeatherKind; intensity: number; cloudCover: number; fogDensity: number; precipitation: number;
  wetness: number; snowCover: number; temperatureC: number; windX: number; windZ: number; heatHaze: number }
export interface LightingState { sunDirX: number; sunDirY: number; sunDirZ: number; sunIntensity: number; moonIntensity: number;
  nightFactor: number; streetlightsOn: boolean; headlightsOn: boolean }
export interface EnvironmentSave { timeOffset: number; override: { kind: WeatherKind; intensity: number } | null }
export class Environment {
  constructor(seed: number);
  update(simTime: number): void;              // fixed step; cheap, allocation-free; emits env:hour / env:weather via bus if given
  readonly time: Readonly<GameTime>;          // satisfies world's ZoneTime { hour, isWeekday }
  readonly weather: Readonly<WeatherState>;
  readonly lighting: Readonly<LightingState>;
  setTimeOfDay(hour: number): void;
  setWeatherOverride(kind: WeatherKind | null, intensity?: number): void;
  serialize(): EnvironmentSave; restore(save: EnvironmentSave): void;
}
export function gameTimeAt(simTime: number, timeOffset: number, out: GameTime): GameTime;
export function formatClock(time: GameTime): string;   // "Mon 07:42"
export class EnvironmentRenderer {
  constructor(scene: THREE.Scene, renderer: Renderer | null, options?: { shadows?: ShadowQuality });
  update(env: Environment, camera: THREE.PerspectiveCamera, focus: { x: number; y: number; z: number }, realDt: number): void;
  setShadowQuality(quality: ShadowQuality): void;
  readonly viewDistance: number;              // current fog far (m); the chunk streamer uses it
  dispose(): void;
}
export const CRIME_CATEGORIES: readonly string[];
export function crimeWeight(category: string, hour: number, weekday: number, district: string): number;
```
`EnvironmentRenderer` replaces Phase 0's `createTestScene` lights, fog, background and grid (the integrator
stops calling `createTestScene`; the chunk ground replaces the test plane).

## 11. Player modes and cameras [player] (`src/player/**`)

- **On foot** stays the Phase 0 kinematic box with the orbit camera (`PlayerController` yaw/pitch).
- **Enter**: on foot, `interact` (E) within `ENTER_DISTANCE` (2.2 m) of a drivable vehicle's driver door
  (left side, a third back from the front) -> the integrator removes the officer's body and box mesh (the
  entity stays, its `Transform` follows the seat), attaches input to the vehicle and switches the camera to
  the vehicle's remembered mode. Interact near a fuel pump with the last-driven vehicle within 8 m refuels it.
- **Exit**: `interact` while `|speed| <= 2 m/s` -> the officer is re-added 1 m outside the driver door; if
  that spot is blocked (a box query against static colliders) the passenger side is tried, else exiting is
  refused (HUD hint). The vehicle keeps its handbrake on while unoccupied.
- **Driving input**: `readDriverInput` reads `vehicle.accelerate` / `vehicle.brake` (analog triggers or
  keys), `vehicle.steer`, `vehicle.handbrake`; [vehicles] `mapDriverInput` turns that into throttle, brake
  and automatic reverse. `vehicle.headlights` (H) toggles headlights, `vehicle.lights` (L) the light bar.
- **Camera modes** (`camera.toggle`, V, cycles while driving): `chase` (spring-damped follow behind and
  above, looks ahead along velocity, mouse/stick orbit that re-centres after 1.5 s, pulled in front of walls
  by an injected raycast), `hood` (fixed on the bonnet), `cockpit` (driver eye, free look within +-100°
  yaw / +-60° pitch). The FOV setting applies to all modes. All maths are pure functions; the rig writes an
  existing `THREE.PerspectiveCamera` without allocating.
- New input actions (owned by [player] in `src/input/actions.ts` / `bindings.ts`): `vehicle.handbrake`
  (Space, GamepadButton1), `vehicle.headlights` (KeyH, GamepadButton12), `map.toggle` (KeyM, GamepadButton13).

```ts
export const PLAYER_MODE = { onFoot: 0, driving: 1 } as const;
export const CAMERA_MODE = { onFoot: 0, chase: 1, hood: 2, cockpit: 3 } as const;
export interface EnterCandidate { readonly eid: number; readonly x: number; readonly z: number; readonly yaw: number;
  readonly halfWidth: number; readonly halfLength: number; readonly speed: number }
export function driverDoorPoint(c: EnterCandidate, out: { x: number; z: number }): { x: number; z: number };
export function exitPoint(c: EnterCandidate, side: -1 | 1, out: { x: number; z: number }): { x: number; z: number }; // -1 = driver side
export function findEnterable(px: number, pz: number, candidates: readonly EnterCandidate[]): number;   // index or -1
export class PlayerModeMachine { constructor(bus?: EventBus<EventMap>); readonly mode: PlayerModeId; readonly vehicle: number;
  enter(eid: number): boolean; exit(speed: number): boolean; reset(mode: PlayerModeId, vehicle: number): void }
export interface DriverInput { accelerate: number; brake: number; steer: number; handbrake: boolean }  // same shape as [vehicles]
export function readDriverInput(input: InputManager, out: DriverInput): DriverInput;
export interface FollowTarget { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number; vx: number; vz: number }
export interface BodyDims { length: number; width: number; height: number; groundClearance: number }  // VehicleModel.body satisfies it
export interface LookInput { mouseX: number; mouseY: number; stickX: number; stickY: number; sensitivity: number; invertY: boolean }
export type CameraRaycast = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDistance: number) => number; // Infinity = no hit
export class CameraRig { constructor(bus?: EventBus<EventMap>); readonly mode: CameraModeId;
  setVehicle(dims: BodyDims | null): void; cycleVehicleMode(): void; snap(): void;
  updateOnFoot(target: { x: number; y: number; z: number }, yaw: number, pitch: number, camera: THREE.PerspectiveCamera): void;
  updateVehicle(dt: number, target: FollowTarget, look: LookInput, camera: THREE.PerspectiveCamera, raycast?: CameraRaycast): void;
  readonly yawOffset: number; readonly pitchOffset: number }
```

## 12. ECS components and event topics

`src/ecs/components.ts` (integrator-owned) does not change: new stores live in their modules, sized to
`MAX_ENTITIES`, each with an `attach*` helper that adds the component and resets that entity's fields
(ids are recycled; `resetComponentSlot` only knows Phase 0 stores).

| Component | Owner / file | Fields |
|---|---|---|
| `VehicleLook` | [vehicles] `src/vehicles/components.ts` | `model` Uint8, `color` Uint32 (0xRRGGBB), `lights` Uint8 (`LIGHT`: head 1, brake 2, reverse 4, hazard 8, lightbar 16), `faults` Uint8 (`FAULT`: headLeftOut 1, headRightOut 2, tailOut 4, brakeOut 8), `damage` Float32 x4 per entity (front, rear, left, right) |
| `Drivable` (tag) | [vehicles] same file | player-drivable vehicle |
| `TrafficCar` | [traffic] `src/traffic/components.ts` | `slot` Int16 (traffic SoA slot) |

Both vehicle kinds set `EntityKind.kind = KIND.Vehicle` (existing). Event topics are added by each module
through declaration merging in its own `src/<module>/events.ts`
(`declare module '../core/event-map' { interface EventMap { ... } }`, verified to compile); the integrator
may later fold them into `event-map.ts`. Payloads are emitted on rare events only (never per step per car).

| Topic | Owner | Payload |
|---|---|---|
| `vehicle:damaged` | vehicles | `{ eid: number; zone: 'front' \| 'rear' \| 'left' \| 'right'; amount: number; impactSpeed: number }` |
| `vehicle:tireBurst` | vehicles | `{ eid: number; wheel: number }` |
| `vehicle:engineStalled` / `vehicle:engineFailed` / `vehicle:fuelEmpty` | vehicles | `{ eid: number }` |
| `traffic:spawned` / `traffic:despawned` | traffic | `{ eid: number; vehicleId: number }` |
| `traffic:collision` | traffic | `{ eid: number; vehicleId: number; other: number; impactSpeed: number }` |
| `traffic:violation` | traffic | `{ eid: number; vehicleId: number; kind: 'speeding' \| 'redLight' \| 'rollingStop' \| 'tailgating' \| 'weaving'; x: number; z: number; speedMph: number; limitMph: number }` (once per car per edge) |
| `env:hour` | environment | `{ day: number; weekday: number; hour: number }` (whole game hours) |
| `env:weather` | environment | `{ kind: WeatherKind; intensity: number }` (segment change or override) |
| `player:mode` | player | `{ mode: 'onFoot' \| 'driving'; vehicle: number }` |
| `camera:mode` | player | `{ mode: 'onFoot' \| 'chase' \| 'hood' \| 'cockpit' }` |

## 13. Step order and determinism (integrator wiring)

Fixed step (60 Hz). Simulation work is registered in the Phase 0 `SystemRegistry` so it is timed in the perf
overlay and runs after `copyPrevTransform` (otherwise interpolation breaks):

| Order | System | Work |
|---|---|---|
| (before `runAll`) | session | `advanceTime`, clock, on-foot kinematic velocity (zero while driving) |
| -1000 | `copyPrevTransform` | Phase 0 |
| -900 | `environment` | `env.update(simTime)` |
| -800 | `colliders` | `worldColliders.update(player x, z)` |
| 0 | `integrateVelocity` | Phase 0 |
| 40 | `vehicles.pre` | `vehicle.setControls(mapDriverInput(...))`, `vehicle.preStep(dt, envAdapter)` for every drivable vehicle |
| 50 | `traffic` | `traffic.step(dt, simTime, env.time, focus)` |
| 100 | `physics` | `physics.step()`, `syncToEcs` (Phase 0) |
| 110 | `vehicles.post` | `vehicle.postStep(dt, bus)`; seat sync of the driving officer |

Per frame (`update`): `input.update` -> toggles -> mode actions (enter/exit/refuel, headlights, light bar,
camera cycle) -> on-foot look/move or `readDriverInput` (stored for the next fixed steps) -> `CameraRig` ->
`EnvironmentRenderer.update` -> `ChunkStreamer.update(camera, env viewDistance)` -> `CarRenderer.update`
-> `SignalHeads/streetlight pool` -> `Hud.update` (DOM at 10 Hz). Render: `meshes.syncFromEcs`,
`renderer.render()`, perf sample (draw calls and entities as in Phase 0, plus extras `chunks` and `traffic`).

Determinism checklist: city, colliders, vehicles, traffic and weather depend only on the seed, the input
sequence and sim time; every random draw comes from a named stream (`'traffic'`, `'vehicle:<slot>'`,
`'world:*'`, `'registry:<id>'`, `'weather'`); worker/streaming/render state never feeds back into the sim.
A test in [traffic] and one in [vehicles] run the same scripted inputs twice and compare state bit for bit.

## 14. Save schema v3 (integrator only)

`CURRENT_SAVE_VERSION = 3`; `migrateV2ToV3` keeps everything and adds defaults:
```ts
interface SaveGameV3 extends SaveGameV2 {
  player: { mode: 'onFoot' | 'driving'; vehicle: number };   // index into `vehicles`, -1 on foot
  camera: { pitch: number; mode: number };                    // CAMERA_MODE id remembered for driving
  vehicles: SerializedVehicle[];                              // drivable vehicles ([vehicles])
  traffic: TrafficSnapshot | null;                            // null -> fresh populate around the player
  environment: EnvironmentSave;                               // { timeOffset, override }
}
// v2 -> v3: player { mode: 'onFoot', vehicle: -1 }, camera { pitch, mode: CAMERA_MODE.chase }, vehicles [],
// traffic null, environment { timeOffset: 0, override: null }. An empty `vehicles` list on load re-parks
// the two station patrol cars. `world.entities` keeps the player and debug boxes as in v2.
```
Tests: every version 1..3 migrates and validates; round trip of a v3 save; malformed vehicles/traffic rejected.

## 15. Performance budget (60 FPS, mid-range desktop GPU, 1080p)

| Subsystem | Budget | Notes |
|---|---|---|
| Physics step | <= 1.0 ms/step | 1-3 vehicle controllers, <= 30 kinematic proxies, <= ~1500 static colliders (3x3 chunks) |
| Vehicles pre+post | <= 0.1 ms/step | allocation-free, Rapier `target` getters |
| Traffic | <= 0.5 ms/step at 160 cars | SoA, insertion sort, no allocation; tick work (spawn/despawn) <= 0.3 ms |
| Colliders streaming | <= 0.5 ms per chunk op, 1 op/step | spikes spread over steps |
| Environment update | <= 0.05 ms/step | O(1) |
| Chunk streamer (main) | <= 0.5 ms/frame + <= 2 ms per uploaded chunk (1/frame) | meshing in the worker (<= 20 ms/chunk there) |
| City generation | <= 400 ms once per session | load screen; worker generates its own copy in parallel |
| Car renderer | <= 0.4 ms/frame | instanced, 1 matrix compose per part per visible car |
| Camera + HUD | <= 0.3 ms/frame | HUD DOM writes at 10 Hz, minimap canvas at 10 Hz (<= 1 ms) |
| Draw calls | target <= 200, hard cap 300 | LOD0 chunk <= 5, LOD1 <= 3, cars ~20, signals/lights/sky/precip ~5, shadow pass only LOD0 casters |
| Triangles | <= 1.5 M | LOD1 buildings are plain boxes |
| Lights | 1 directional (shadow), 1 hemisphere, 2 headlight spots, 4 pooled points | fixed counts (no shader recompiles) |
| Shadow map | 1024 (low) / 2048 (high), +-150 m around the player | off at night |
| GPU memory | <= 150 MB city geometry at 2 km draw distance | ~1-2 MB per LOD0 chunk |
| Per-frame allocations | none in hot loops | strings only in throttled HUD/console |
The perf overlay keeps draw calls, triangles and entities, adds `chunks` (loaded/in-flight) and `traffic`
(active/proxies) extras, and lists `traffic`, `vehicles.*`, `colliders`, `environment` system timings.

## 16. Modules, ownership and waves

| Key | Wave | Owns (exclusively) | May import (new Phase 1 code) |
|---|---|---|---|
| world | 1 | `src/world/**` except `src/world/render/**`; `src/data/world/**`; `test/world/**` | none |
| environment | 1 | `src/environment/**`; `src/data/environment/**`; `src/data/crime/**`; `src/render/renderer.ts`; `test/environment/**` | none |
| vehicles | 1 | `src/vehicles/**`; `src/data/vehicles/**`; `src/data/physics/**`; `src/physics/physics.ts`; `test/vehicles/**` | none |
| player | 1 | `src/player/**`; `src/input/actions.ts`; `src/input/bindings.ts`; `test/player/**` | none |
| cityRender | 2 | `src/world/render/**`; `test/cityrender/**` | world |
| traffic | 2 | `src/traffic/**`; `src/data/traffic/**`; `test/traffic/**` | world, vehicles |
| vehicleRender | 2 | `src/render/vehicles/**`; `test/vehiclerender/**` | vehicles |
| hud | 2 | `src/ui/hud/**`; `src/debug/worldCommands.ts`; `test/hud/**` | world, environment, vehicles |
| integrator | 3 | `src/app.ts`, `src/game/**`, `src/core/event-map.ts`, `src/ecs/components.ts`, `src/save/**`, `docs/PHASES.md`, plus unowned files (`src/main.ts`, `src/ui/mainMenu.ts`, `src/ui/styles.css`, `docs/ARCHITECTURE.md`, `README.md`, `scripts/smoke.mjs`, `vite.config.ts`) | all |

Every module may import Phase 0 code (core, ecs, physics, render, input, workers, debug, ui, settings) but
must not edit files it does not own. Wave-1 modules share shapes only by contract (structural types with
identical field names: `DriverInput`, `ZoneTime`, surface ids, district names, `BodyDims`).

### 16.1 cityRender API (`src/world/render/**`)
```ts
export type ChunkWorkerMap = { init: Rpc<{ seed: number }, { ok: true }>;
  build: Rpc<{ cx: number; cz: number; lod: 0 | 1 }, ChunkMeshData> };
export function createChunkWorker(): WorkerClient<ChunkWorkerMap>;     // literal new Worker(new URL('./chunk.worker.ts', import.meta.url), { type: 'module' })
export function buildChunkMesh(city: City, layout: ChunkLayout, lod: 0 | 1): ChunkMeshData;   // pure; used by worker and fallback
export function desiredChunks(camX: number, camZ: number, viewDistance: number,
  current: ReadonlyMap<number, 0 | 1>, out: Map<number, 0 | 1>): Map<number, 0 | 1>;      // chunkKey -> LOD
export class ChunkStreamer {
  constructor(scene: THREE.Scene, city: City, options?: { worker?: WorkerClient<ChunkWorkerMap> | null; maxInFlight?: number; maxResident?: number; shadows?: boolean });
  update(cameraX: number, cameraZ: number, viewDistance: number): void;     // per frame
  setLighting(nightFactor: number, streetlightsOn: boolean): void;         // window emissive, lamps
  setShadows(enabled: boolean): void;
  readonly stats: { loaded: number; inFlight: number; lod0: number; lod1: number };
  dispose(): void;
}
export class SignalHeads { constructor(scene: THREE.Scene, city: City); update(simTime: number, cameraX: number, cameraZ: number): void; dispose(): void }
export class StreetlightPool { constructor(scene: THREE.Scene, city: City, size?: number); update(cameraX: number, cameraZ: number, on: boolean): void; dispose(): void }
```

### 16.2 vehicleRender API (`src/render/vehicles/**`)
```ts
export interface WheelSource { readonly wheelCount: number; wheelPose(i: number, out: WheelPose): WheelPose } // DrivableVehicle satisfies it
export class CarRenderer {
  constructor(scene: THREE.Scene, world: GameWorld, options?: { maxPerModel?: number; shadows?: boolean });
  setDrivable(eid: EntityId, source: WheelSource | null): void;   // wheels from physics instead of speed-based spin
  setHeadlightTarget(eid: EntityId): void;                         // 0 = none; gets two SpotLights when its head bit is on
  update(alpha: number, nightFactor: number, timeSec: number, reducedFlash: boolean): void;  // all VehicleLook entities
  setShadows(enabled: boolean): void;
  readonly stats: { cars: number; drawCalls: number };
  dispose(): void;
}
```
One `InstancedMesh` per model for body and cabin/glass, one shared wheel mesh, one shared emissive lens mesh
(`MeshBasicMaterial`, per-instance colour = lamp on/off/fault), light-bar halves alternating (slow and dim
with `reducedFlash`). Damage: per-instance tint toward dark grey and a crumple scale/offset of the body
along the hit axis (pure `damageTransform`).

### 16.3 hud API (`src/ui/hud/**`, `src/debug/worldCommands.ts`)
```ts
export interface HudSnapshot { mode: 'onFoot' | 'driving'; telemetry: Readonly<VehicleTelemetry> | null;
  time: Readonly<GameTime>; weather: Readonly<WeatherState>; roadName: string; speedLimitMph: number;
  schoolZoneActive: boolean; construction: boolean; prompt: string | null; cameraMode: string; headlights: boolean }
export class Hud { constructor(parent: HTMLElement); update(snapshot: HudSnapshot, nowMs: number): void; setVisible(visible: boolean): void; dispose(): void }
export class Minimap { constructor(parent: HTMLElement, city: City);
  update(x: number, z: number, yaw: number, traffic: { count: number; x: Float32Array; z: Float32Array } | null,
         route: Float32Array | null, nowMs: number): void;
  toggleZoom(): void; dispose(): void }
export function createWorldCommands(deps: WorldCommandDeps): Command[];  // time, weather, tp, route, road, car, traffic, plate, chunks
```
