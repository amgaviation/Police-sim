# Phase 4 design: Interiors and Scene Work

Status: design (technical director). Implementation is split into 8 modules in 3 waves (§19) plus an
integrator (§20). Read with `docs/ARCHITECTURE.md`, `docs/phase1-design.md` §2, `docs/phase2-design.md` §2,
`docs/phase3-design.md` §2-§3 and `docs/research/*.md`. Every builder reads §1-§4 and the sections named in
its brief. Names, ids, signatures and shapes in this document are contracts: do not rename them. When a brief
says "add", keep every existing export, behaviour and test green unless the brief says otherwise.

## 1. Scope

At the end of Phase 4 the officer can walk into buildings and work a scene inside them:

- **Enterable buildings.** Every generated building with a usable footprint gets a stable id, a building kind
  (`house apartment convenienceStore bank bar hospital school warehouse office parkingStructure jail
  policeStation`) and a front entrance. A modular, data-driven interior generator (room templates per kind)
  produces rooms, walls with door gaps, doors (open / close / lock / kick / ram), procedural box furniture,
  hiding spots, light switches with real pooled point lights, spawn spots and evidence spots. Interiors stream
  in (layout, colliders, meshes) when the officer comes within 25 m of an entrance; stepping through a door is a
  0.6 s fade (no loading screen).
- **Indoor calls.** Burglary, domestic, welfare check, barricade, death investigation and shoplifting calls
  (and a few related types, §12.1) bind to a real building: "inside" participants stand in rooms, "hidden" ones
  in hiding spots, the deceased lies in a bedroom, evidence lies on surfaces or in drawers, the door may be
  locked. Ambient occupants (residents, clerks, patrons, staff) fill other interiors.
- **Tactical movement.** Crouch, lean left / right (first-person peek), door slicing (slow pie around a door
  frame), an AI partner placeholder that follows and stacks on doors, a flashlight (NPCs notice the light),
  a sound model (footsteps by surface and speed, doors, radio chirps, voices) propagated through a room graph
  that NPCs hear, line-of-sight checks and cover (crouching behind furniture lowers exposure).
- **Scene investigation.** Numbered evidence markers, a camera mode (thumbnail + metadata in the case file),
  a fingerprint dusting minigame placeholder, bodycam (mount chosen at the locker, toggled on duty), scene tape
  perimeters that pedestrians respect, a hash-chained chain-of-custody ledger (collect → bag → tag → transfer →
  deposit), witness interviews (Phase 3 dialogue), a neighbourhood canvass (knock doors of nearby buildings),
  a K9 stub that indicates hidden people and items, plain-view flagging and consent searches with scope.
- **Police station interior** with lobby, locker room, roll call, armory, report room (MDT desktop), evidence
  room, holding cells, interview room, sally port and garage. **A new shift starts in the locker room →
  briefing → armory → garage**, then patrol.

Non-goals (later phases): multi-storey interiors and stairs (one ground floor per building; apartments,
offices, hospitals are one floor), NPC physics bodies, NPCs opening/closing door panels (they pass unlocked
doors without animating them), windows, outdoor line-of-sight occlusion by buildings, search warrants as
documents (a `warrant` flag exists for warrant-service calls only), Phase 5 grading of the recorded basis,
real use of force, uniform visuals beyond a colour (Phase 7).

## 2. Conventions (in addition to Phase 1-3 §2)

- **TS rules** unchanged: no enums / namespaces / parameter properties; `as const` objects + unions;
  `import type`; `noUncheckedIndexedAccess`; JSDoc on exports; `scratch*` temporaries in hot loops.
- **Determinism.** Everything that changes simulation state runs in fixed steps and draws only from named
  streams: `session.rng.stream('interior')`, `'tactical'`, `'investigation'`, `'station'` (streams are derived
  from the seed and the name only, adding them does not disturb Phase 1-3 streams). Interior layouts are pure:
  `createRng(seed).stream('interior:' + buildingId)`. Building kinds, residents and ambient occupants use
  integer hashing (`records/hash.ts` `hash3` / `unitHash`). `Math.random`, `Date.now`, `performance.now` are
  forbidden in `src/interior`, `src/indoors`, `src/tactical`, `src/evidence`, `src/investigation`,
  `src/station` (pure parts), `src/npc`, `src/scene`, `src/contact`, `src/dialogue`.
- **UI → sim through queues.** Panels and keys produce request objects (`InteriorSystem.request`,
  `TacticalSystem.request`, `InvestigationSystem.request`, `StationState.request`) applied at the start of the
  owner's next fixed step. Per-frame held inputs (crouch is a toggle; lean and slice are held) are stored by the
  app and read in the fixed step (the Phase 1 `driverInput` pattern).
- **Data** in `src/data/<area>/*.json`, `"version": 1`, validated at import by a typed validator throwing
  `Error` naming the file and the JSON path (pattern `src/cad/data.ts`). Multi-file folders use
  `import.meta.glob('<dir>/*.json', { eager: true, import: 'default' })` processed **sorted by path**.
- **Headless.** DOM / THREE classes construct and run as no-ops without `document` / WebGL (vitest = node).
- **Generic content only.** No real agency, brand, product, person or place names. Building and room labels
  are generic ("Convenience store", "Teller area"). No third-party assets (`docs/ASSETS.md` stays empty).
- **Units.** Metres, seconds (sim seconds for timers), decibels (dB, a relative SPL-like scale), radians, yaw 0
  = facing −Z (`forward = (−sin yaw, −cos yaw)`).
- **Interiors live below grade.** An interior is built at its building's own x/z footprint with its floor at
  `INTERIOR_FLOOR_Y = -40` (the ground slab's top is y = 0, its bottom −1; building colliders span 0..h). The
  officer, NPCs and props keep their x/z inside the footprint, so every Phase 2-3 distance check (AVL, scene
  arrival, minimap, chunk streaming) keeps working; a `building` id (−1 = outdoors) disambiguates levels. The
  enclosed interior hides the city; the env renderer hides precipitation indoors.

## 3. Architecture

```
 fixed step (60 Hz)
 ┌───────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ session.fixedUpdate: officer move (× tactical speed factor; slicing velocity), y kept on its level         │
 │ interiors (-810): residency (≤ 2 interiors: layout + Rapier colliders), enter/exit fades, doors, switches, │
 │                   ambient occupants via OccupantPort ─▶ npc.spawnActor({ building })                      │
 │ colliders (-800), dispatch (-700)                                                                          │
 │ scene (-690): indoor binding (BuildingIndex), materialize inside rooms / hiding spots, door locks,        │
 │               knock → residents to the door, EvidencePort.placeItem, investigation/npc events → flags     │
 │ contact (-680): dialogue (+ entry / premises / room consents → contact:consent)                           │
 │ investigation (-675): markers, photos, dusting, custody ledger, tape → npc no-go zones, canvass, K9,     │
 │                       plain-view scan (LOS + light + lawful presence), container searches (authority)     │
 │ station (-670): shift flow, armory log, locker loadout, holding cells, interview                          │
 │ radio (-650)                                                                                               │
 │ tactical (-640): stance, footsteps, SoundField (room-graph attenuation) ─▶ npc.stimulate,                 │
 │                  NoticeSystem (LOS / exposure / flashlight) ─▶ npc.stimulate, partner placeholder         │
 │ vehicles.pre 40, traffic 50, npc 60 (indoor nav via IndoorNavPort, awareness reactions, no-go zones)      │
 └───────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 per frame (presentation)
   first-person camera indoors (cameraRig.updateFirstPerson + tactical eye/lean) · flashlight SpotLight
   InteriorRenderer (≤ 6 draw calls per visible interior) + InteriorLightPool (4 fixed PointLights)
   PeopleRenderer sources: npc.view, officer figure (crouch pose), partner, station staff, K9 dog
   PropRenderer: scene props + investigation props (markers, items, tape) merged into one PropSource
   HUD: stance / flashlight / noise / visibility, bodycam REC, shift objective, location chip, case line,
        floor plan on the minimap, fade overlay; panels: door, locker, armory, interview, partner, tools,
        BriefingScreen, CaseFilePanel, CameraOverlay, FingerprintPanel, MarkerLabels
```

- **Pure foundations (wave 1):** `src/world/buildings.ts` + `src/interior/**` (building index, interior
  generator, nav, line of sight), `src/evidence/**` (custody ledger, search rules, case file store, dusting,
  canvass, K9 sweep), `src/station/**` (shift flow, armory, locker, briefing, holding cells) with the station
  UI, HUD and input actions.
- **Runtime (wave 2):** `src/indoors/**` (InteriorSystem + `src/render/interior/**`), `src/tactical/**`
  (sound model, stance, notice, partner, slicing, first-person camera, flashlight rig), the people side
  (`src/npc/**`, `src/dialogue/**`, `src/contact/**`: indoor actors, awareness, consents) and
  `src/investigation/**` (+ `src/ui/investigation/**`).
- **Scenes (wave 3):** `src/scene/**` + `src/calls/**` bind calls to interiors and turn investigation events
  into scene flags.
- Cross-module calls in the same wave go through **structural port interfaces** declared by the consumer
  (the Phase 3 `ContactPort` trick); the integrator wires the real objects and `tsc` checks assignability.

## 4. Shared contracts (ids and constants)

### 4.1 Constants (`src/interior/constants.ts`, owned by interiorgen)
```ts
export const INTERIOR_FLOOR_Y = -40;      // feet height of every interior floor (officer body centre = -39.1)
export const WALL_HEIGHT = 3;             // floor to ceiling (m)
export const WALL_THICKNESS = 0.15;       // collider / mesh thickness; LOS treats walls as lines
export const DOOR_WIDTH = 0.9;            // interior and front doors
export const WIDE_DOOR_WIDTH = 2.8;       // garage, sally port, loading, deck openings
export const DOOR_HEIGHT = 2.1;
export const MIN_ROOM_SIDE = 2.6;         // BSP / slab minimum (m)
export const STREAM_RADIUS = 25;          // interiors become resident within this distance of an entrance (m)
export const MAX_RESIDENT = 2;            // resident interiors (the officer's + the nearest entrance)
/** Level of a building id: feet y of its floor; -1 (outdoors) → 0. */
export function levelY(building: number): number;   // building >= 0 ? INTERIOR_FLOOR_Y : 0
```

### 4.2 Fixed id lists (contracts)

| List | Ids | Defined by | Referenced by |
|---|---|---|---|
| `BUILDING_KINDS` (12) | `house apartment convenienceStore bank bar hospital school warehouse office parkingStructure jail policeStation` | interiorgen `src/world/buildings.ts` | indoors, scenes (`indoor.json`), station |
| `ROOM_KINDS` (55) | `living kitchen dining bedroom bathroom laundry hallway corridor lobby unitLiving unitBedroom unitBath mailroom salesFloor storage office restroom tellerArea vault breakRoom barRoom waiting exam patientRoom nurseStation supply classroom library floor loading conference deck stairwell sallyPort booking cell control visiting garage lockerRoom rollCall reportRoom armory evidenceRoom interview backOffice cooler security closet utility gym cafeteria pharmacy dock lounge` | interiorgen `src/interior/types.ts` | scenes (`indoor.json` room prefs), station |
| `POINT_KINDS` (10) | `locker briefing armory evidence reportDesk interview cell frontDesk garage booking` | interiorgen (template furniture `point`) | station, integrator |
| `SURFACE_KINDS` (floor, 5) | `carpet wood tile concrete linoleum` | interiorgen | tactical (footsteps) |
| `PRINT_SURFACES` (5) | `glass metal wood stone fabric` | interiorgen (furniture `surface`) | evidence (dust quality), investigation |
| `CONTAINERS` (5) | `none drawer cabinet closet safe` | interiorgen | evidence (search rules), scenes, investigation |
| `HIDE_KINDS` (5) | `closet underBed behindCounter shower cabinet` | interiorgen | npc (via nav port), scenes |
| `DOOR_STATES` | `closed:0 open:1 locked:2 broken:3` | indoors `DOOR_STATE` | tactical, investigation, npc nav, save |
| `SOUND_KINDS` (12) | `footstep doorOpen doorClose knock kick ram radioChirp voiceTalk voiceShout announce taser flashlightClick` | tactical | indoors / investigation events (bridged by tactical) |
| `CONSENT_KINDS` (+3) | `entry searchPremises searchRoom` added to Phase 3 `searchPerson searchVehicle pbt sfst` | people4 (`src/dialogue/types.ts`) | evidence, investigation, contact |
| `SEARCH_BASES` (7) | `plainView consent warrant incidentToArrest exigency protectiveSweep publicArea` | evidence | investigation, scenes (`CallOutcome.case`) |
| `CUSTODY_ACTIONS` (5) | `collect bag tag transfer deposit` | evidence | investigation, station |
| `SHIFT_STEPS` (5) | `locker briefing armory garage onPatrol` | station | integrator, HUD |
| `ARMORY_ITEMS` (6) | `sidearm taser ocSpray baton beanbag rifle` | station (`armory.json`) | scenes (weapon gate), integrator |
| new trunk items (6) | `ram sceneTape evidenceMarkers evidenceBags fingerprintKit camera` | indoors (`src/data/police/items.json`) | investigation, indoors (ram) |
| `AWARE_REACTIONS` (6) | `none hide flee confront surrender arm` | people4 (`behaviors.json` `onAware`) | scenes |

Each referencing module re-declares the tuple it validates against (the Phase 3 rule) so wave-1/2 modules do
not import each other; the scenes module's test cross-checks the defining data contains every listed id.

### 4.3 Structural types shared across waves

Declared **identically** in the files named (consumers may not import the producer in the same wave):

```ts
/** Door state numbers (indoors `DOOR_STATE`, tactical, investigation, npc). */
export type DoorStateName = 'closed' | 'open' | 'locked' | 'broken';

/** What tactical and scenes read from the InteriorSystem (declared in src/tactical/types.ts and src/scene/types.ts;
 *  InteriorSystem implements it; investigation uses its own InvestigationPorts instead). */
export interface InteriorQuery {
  /** Building the officer is in, -1 outdoors. */
  readonly officerBuilding: number;
  /** Pure layout (cached), null when the building is not enterable. */
  layout(buildingId: number): InteriorLayout | null;
  doorState(buildingId: number, door: number): DoorStateName;
  /** Increments whenever any door of the building changes state (sound graph cache key). */
  doorRevision(buildingId: number): number;
  roomLit(buildingId: number, room: number): boolean;
}
```
`InteriorLayout` and its parts are exported by interiorgen (`src/interior/types.ts`, §5.2) and may be imported
by every wave-2/3 module.

## 5. Buildings and the interior generator [interiorgen] (`src/world/buildings.ts`, `src/interior/**`, `src/data/interior/**`)

All pure: no THREE, DOM, Rapier or bus. Runs in node tests and could run in a worker later.

### 5.1 Building index (`src/world/buildings.ts`)

`src/world/chunkLayout.ts` gains one export and nothing else changes there (the chunk worker imports it too):
```ts
/** The buildings of one block (BUILDING_STRIDE floats each: minX, minZ, maxX, maxZ, height, roof, color, style),
 *  exactly as chunkLayout places them (same `world:block:<id>` stream). */
export function blockBuildingRects(city: City, blockId: number): Float32Array;   // runs blockContents into a fresh Sink
```
```ts
export const BUILDING_KINDS = ['house', 'apartment', 'convenienceStore', 'bank', 'bar', 'hospital', 'school', 'warehouse',
  'office', 'parkingStructure', 'jail', 'policeStation'] as const;
export type BuildingKind = (typeof BUILDING_KINDS)[number];
/** Front side: 0 = the minZ side (faces -Z), 1 = maxX (+X), 2 = maxZ (+Z), 3 = minX (-X). */
export type FrontSide = 0 | 1 | 2 | 3;
export interface BuildingInfo {
  readonly id: number;            // blockId * 256 + local index (index in blockBuildingRects / BUILDING_STRIDE)
  readonly block: number;
  readonly local: number;
  readonly minX: number; readonly minZ: number; readonly maxX: number; readonly maxZ: number;
  readonly height: number;
  readonly district: DistrictId;
  /** null: not enterable (too small, or no kind fits). */
  readonly kind: BuildingKind | null;
  readonly front: FrontSide;
  /** Approach point 0.6 m outside the front wall centre (the station: stationLayout door), yaw facing out. */
  readonly door: { readonly x: number; readonly z: number; readonly yaw: number };
  /** Street address text, filled by the index from the nearest edge (`addressOnEdge`), '' when none within 60 m. */
  readonly address: string;
}
export function buildingId(block: number, local: number): number;           // block * 256 + local (local < 256, else RangeError)
export function blockOfBuilding(id: number): number;                         // Math.floor(id / 256)
export function localOfBuilding(id: number): number;                         // id % 256
/** Front side of rect inside block: the side with the smallest gap to the block edge (ties: 0, 1, 2, 3). */
export function frontSideOf(rect: Rect4, block: Rect4): FrontSide;
/** Outward yaw per side: 0 → 0, 1 → -π/2, 2 → π, 3 → π/2. */
export function frontYaw(side: FrontSide): number;
/** Pure kind rule (§5.1.1); `jail` true when this building is the city's jail. */
export function classifyBuilding(seed: number, info: ClassifyInput): BuildingKind | null;
export interface ClassifyInput { id: number; minX: number; minZ: number; maxX: number; maxZ: number; height: number;
  district: DistrictId; blockKind: BlockKindId; poiKind: PoiKind | null; poiFirst: boolean; station: boolean; jail: boolean }
/** Lazy, cached (LRU of 256 blocks) building lookup over a city. */
export class BuildingIndex {
  constructor(city: City, options?: { cacheBlocks?: number; addressAt?: (x: number, z: number) => string });
  building(id: number): BuildingInfo | null;                                   // null for an unknown id
  /** Clears `out`, fills it with buildings whose footprint is within `radius` of (x, z), ascending id. */
  near(x: number, z: number, radius: number, out: BuildingInfo[]): BuildingInfo[];
  /** Enterable building whose `door` is nearest to (x, z) within maxDist (kinds filter optional); ties: lower id. */
  nearestEntrance(x: number, z: number, maxDist: number, kinds?: readonly BuildingKind[] | null): BuildingInfo | null;
  /** The building containing (x, z) in its footprint, else null. */
  at(x: number, z: number): BuildingInfo | null;
  station(): BuildingInfo | null;   // the police station POI's building
  jail(): BuildingInfo | null;      // §5.1.1
  readonly stats: { blocksCached: number; lookups: number };
}
```
`addressAt` defaults to `''`; the integrator passes `(x, z) => addressOnEdge(graph, edge, s, districtOf).text` of the
nearest edge. Block contents are generated on demand (`blockBuildingRects`) and cached per block.

#### 5.1.1 Kind rules (`classifyBuilding`, data `src/data/interior/buildingKinds.json`)
Order (first match wins):
1. `station` → `policeStation`. `jail` → `jail`.
2. Footprint min side < 5 m or area < 30 m² → `null`.
3. POI blocks: hospital → `hospital` for `poiFirst` (the first building of the block), else `office`; school and
   campus → `school` for `poiFirst`, else `office`; fuel → `convenienceStore`; harbor → `warehouse`; airport → `office`.
4. Block kind `yard` → `warehouse`; `farm` → `house` for local 0, `warehouse` otherwise; `park`/`green` → null.
5. District table: `u = unitHash(seed, SALT_KIND /* 0x4b1d */, id)`; candidates = the district's entries whose
   size constraints hold (`minArea`, `maxArea`, `minSide`, `maxHeight`, `minHeight`); weights renormalised; pick by `u`
   over the cumulative weights in file order; none → null. The kind's template min size (§5.4) is also a
   constraint (min side ≥ template `minWidth` and `minDepth` in either orientation).

`buildingKinds.json`:
```json
{ "version": 1,
  "districts": {
    "downtown":  [ { "kind": "office", "weight": 0.40, "minArea": 150 }, { "kind": "apartment", "weight": 0.22, "minArea": 200 },
                   { "kind": "bar", "weight": 0.08 }, { "kind": "bank", "weight": 0.05, "minArea": 150 },
                   { "kind": "convenienceStore", "weight": 0.12, "maxArea": 900 }, { "kind": "parkingStructure", "weight": 0.06, "minArea": 700 },
                   { "kind": "hospital", "weight": 0.01, "minArea": 1500 }, { "kind": "school", "weight": 0.01, "minArea": 1200 },
                   { "kind": "house", "weight": 0.05, "maxArea": 300 } ],
    "suburbs":   [ { "kind": "house", "weight": 0.84, "maxArea": 450 }, { "kind": "apartment", "weight": 0.08, "minArea": 300 },
                   { "kind": "convenienceStore", "weight": 0.04 }, { "kind": "bar", "weight": 0.02 }, { "kind": "bank", "weight": 0.02, "minArea": 150 } ],
    "industrial":[ { "kind": "warehouse", "weight": 0.7 }, { "kind": "office", "weight": 0.15, "minArea": 120 }, { "kind": "bar", "weight": 0.05 },
                   { "kind": "parkingStructure", "weight": 0.05, "minArea": 700 }, { "kind": "convenienceStore", "weight": 0.05 } ],
    "rural":     [ { "kind": "house", "weight": 0.85, "maxArea": 500 }, { "kind": "warehouse", "weight": 0.1 }, { "kind": "convenienceStore", "weight": 0.05 } ],
    "campus":    [ { "kind": "school", "weight": 0.6, "minArea": 400 }, { "kind": "office", "weight": 0.4 } ],
    "hospital":  [ { "kind": "hospital", "weight": 0.5, "minArea": 600 }, { "kind": "office", "weight": 0.5 } ],
    "airport":   [ { "kind": "office", "weight": 0.6 }, { "kind": "warehouse", "weight": 0.4 } ],
    "harbor":    [ { "kind": "warehouse", "weight": 0.85 }, { "kind": "office", "weight": 0.1 }, { "kind": "bar", "weight": 0.05 } ],
    "highway":   [ { "kind": "convenienceStore", "weight": 0.5 }, { "kind": "warehouse", "weight": 0.3 }, { "kind": "house", "weight": 0.2, "maxArea": 400 } ],
    "park": [], "water": []
  } }
```
**Jail:** among blocks of kind `lots` in `downtown` or `industrial` whose centre is within 2 000 m of the station,
sorted by centre distance (ties: id), examine the first 60; pick the building with the largest area whose min side
≥ 16 m (ties: lower id). Cached; `jail()` null when none. `building(id)` sets `jail: id === jailId`.

**Front and door:** `front = frontSideOf(rect, block)` where gaps are `rect.minZ - block.minZ` (0),
`block.maxX - rect.maxX` (1), `block.maxZ - rect.maxZ` (2), `rect.minX - block.minX` (3). `door` = front side midpoint
+ 0.6 m outward, `yaw = frontYaw(front)`. The station uses `stationLayout(block, LANDMARKS.station.yaw).door` and the
front side whose outward yaw equals that door yaw.

### 5.2 Layout types (`src/interior/types.ts`)
```ts
export interface Rect { readonly minX: number; readonly minZ: number; readonly maxX: number; readonly maxZ: number }
export type DoorKind = 'interior' | 'exterior' | 'cell' | 'wide';
export interface InteriorRoom {
  readonly index: number;
  readonly kind: RoomKind;
  readonly label: string;            // template label, e.g. 'Kitchen'
  readonly rect: Rect;               // world x/z
  readonly surface: FloorSurface;    // 'carpet' | 'wood' | 'tile' | 'concrete' | 'linoleum'
  readonly public: boolean;          // public area of a business (lawful presence while open)
  readonly light: { readonly x: number; readonly z: number } | null;   // ceiling fixture (room centre), null = no light
  readonly switchAt: { readonly x: number; readonly z: number; readonly yaw: number } | null;
}
export interface InteriorDoor {
  readonly index: number;
  readonly a: number;                // room index
  readonly b: number;                // room index, -1 = outside
  readonly x: number; readonly z: number;   // centre of the opening (on the wall line)
  /** 'x': the opening spans along world X (the wall runs along X, its normal is ±Z); 'z': spans along Z. */
  readonly axis: 'x' | 'z';
  readonly width: number;
  readonly kind: DoorKind;           // 'wide' openings have no door panel (always open, not lockable)
  readonly lockable: boolean;
  readonly lockedAtStart: boolean;   // implies lockable
  /** Room whose side holds the thumb-turn (interior lockable doors), -1 for exterior / not lockable. */
  readonly lockSide: number;
  readonly strength: number;         // 0..1 kick / ram resistance (≥ 0.95 = unbreachable)
  /** Exterior doors: outdoor pose 0.8 m outside (y = 0), facing out; null for interior doors. */
  readonly exit: { readonly x: number; readonly z: number; readonly yaw: number } | null;
  readonly main: boolean;            // the front entrance (exactly one per layout)
}
export interface FurnitureItem {
  readonly index: number; readonly id: string; readonly room: number;
  readonly x: number; readonly z: number; readonly yaw: number;     // yaw ∈ {0, π/2, π, -π/2}: front faces the room
  readonly w: number; readonly d: number; readonly h: number;       // width (local x), depth (local z), height
  readonly minX: number; readonly minZ: number; readonly maxX: number; readonly maxZ: number;   // world AABB
  readonly color: number; readonly solid: boolean;
  readonly cover: boolean;           // 0.8 ≤ h ≤ 1.3 (low cover)
  readonly surface: PrintSurface | null;   // printable top
  readonly container: Container;     // 'none' | 'drawer' | 'cabinet' | 'closet' | 'safe'
  readonly hide: HideKind | null;
  readonly seat: 'sit' | 'lie' | null;
}
export interface HidingSpot { readonly index: number; readonly room: number; readonly furniture: number; readonly kind: HideKind;
  readonly x: number; readonly z: number; readonly yaw: number }
export interface SpawnSpot { readonly room: number; readonly x: number; readonly z: number; readonly yaw: number; readonly pose: 'stand' | 'sit' | 'lying' }
export interface ItemSpot { readonly index: number; readonly room: number; readonly x: number; readonly y: number /* above the floor */;
  readonly z: number; readonly container: Container; readonly concealed: boolean; readonly furniture: number /* -1 floor */ }
export interface InteriorPoint { readonly kind: PointKind; readonly room: number; readonly furniture: number;
  readonly x: number; readonly z: number; readonly yaw: number /* stand here, facing the furniture */ }
export interface InteriorLayout {
  readonly buildingId: number; readonly kind: BuildingKind; readonly floorY: number;   // INTERIOR_FLOOR_Y
  readonly rect: Rect;                       // interior extent (inside the footprint)
  readonly rooms: readonly InteriorRoom[]; readonly doors: readonly InteriorDoor[];
  /** Wall lines without door gaps: x0, z0, x1, z1 per segment (axis-aligned). */
  readonly walls: Float32Array;
  readonly furniture: readonly FurnitureItem[];
  readonly hidingSpots: readonly HidingSpot[]; readonly spawnSpots: readonly SpawnSpot[];
  readonly itemSpots: readonly ItemSpot[]; readonly points: readonly InteriorPoint[];
  /** Officer arrival pose just inside the main door (1.0 m in), facing in. */
  readonly entry: { readonly x: number; readonly z: number; readonly yaw: number };
  /** Door indices per room (adjacency). */
  readonly roomDoors: readonly (readonly number[])[];
  readonly residential: boolean;             // template flag
  readonly occupants: OccupancySpec;         // template occupancy (§5.4)
}
```

### 5.3 Generator (`src/interior/generate.ts`)
```ts
/** Deterministic layout for (seed, building); null when the building has no kind or no template fits. */
export function generateInterior(seed: number, building: BuildingInfo, templates?: TemplateSet): InteriorLayout | null;
```
Algorithm (all draws from `rng = createRng(seed).stream('interior:' + building.id)`, in this order):

1. **Frame.** Local axes per front side (u along the front wall, v inward, origin at the front-left corner):
   front 0: world = (minX + u, minZ + v), W = maxX−minX, D = maxZ−minZ; front 2: (maxX − u, maxZ − v);
   front 1: (maxX − v, minZ + u), W = maxZ−minZ, D = maxX−minX; front 3: (minX + v, maxZ − u). Interior extent
   W' = min(W, tpl.maxWidth), D' = min(D, tpl.maxDepth), u ∈ [(W−W')/2, (W+W')/2], v ∈ [0, D'] (centred on the
   front wall). If W' < tpl.minWidth or D' < tpl.minDepth return null. All coordinates rounded to 0.05 m.
2. **Room list.** For each template room def in file order: required → `count = rng.nextInt(c0, c1)` (≥ 1);
   optional → `rng.chance(chance)` then `rng.nextInt(c0, c1)`, else 0. Expand to a list (entry kind first). Cap the
   list at `max(1, floor(W'·D' / tpl.minRoomArea))` by dropping optional rooms from the end, then required extras.
3. **Partition.**
   - `layout: "bsp"`: leaves = [extent]. While leaves < n: take the largest-area leaf (ties: oldest); split it
     perpendicular to its longer side at `t = rng.nextFloat(0.4, 0.6)` (rounded to 0.1 m and clamped so both parts
     have sides ≥ `MIN_ROOM_SIDE`); if that side is < 2·MIN_ROOM_SIDE try the other axis; if neither works, mark the
     leaf unsplittable and continue with the next largest; stop when none is splittable (n shrinks: drop rooms as in
     step 2). Record each split as an internal node `{ axis, coord, a, b }`.
     **Doors:** for every internal node, among pairs (leaf of a, leaf of b) touching the cut line from both sides,
     take the pair with the largest overlap along the line (ties: lowest leaf ids) and put a door at the overlap
     midpoint (overlap ≥ 1.3 m is guaranteed by `MIN_ROOM_SIDE`). This is a spanning tree: every room is reachable.
     **Kinds:** the entry leaf is the leaf touching v = 0 that contains u = W/2 (on a boundary: the lower-u leaf);
     it gets the entry kind. Remaining kinds sorted by template `size` (desc, stable) are zipped with the remaining
     leaves sorted by area (desc, ties: creation order).
   - `layout: "corridor"` (needs D' ≥ 2·MIN_ROOM_SIDE + corridor width, else falls back to bsp): front band
     v ∈ [0, fb], corridor v ∈ [fb, fb + cw], back band v ∈ [fb + cw, D'] with `cw = tpl.corridor.width`,
     `fb = clamp(round0.1(D'·tpl.corridor.frontShare), MIN_ROOM_SIDE, D' − cw − MIN_ROOM_SIDE)`. Rooms with
     `band: "front"` are laid left→right (u increasing) in list order across the front band, `band: "back"` across
     the back band; slab widths ∝ `size`, rounded to 0.1 m, last slab takes the rest; if a slab is < MIN_ROOM_SIDE
     drop the last optional room of that band and redo. The corridor is a room (kind `tpl.corridor.kind`, default
     `corridor`). Every slab gets a door to the corridor at its u-centre. Entry kind must be in the front band
     (validated).
   - **Suites** (`suite: ["unitLiving", "unitBedroom", "unitBath"]` on a room def): the slab is BSP-split into
     `suite.length` leaves as above; its internal doors follow the BSP rule; the corridor door goes to the suite
     leaf with the largest overlap with the corridor line (ties: lowest id), which gets `suite[0]`; the others take
     the remaining kinds by area.
4. **Exterior doors.** Main door: on v = 0 in the entry room at u = clamp(W/2, room.minU + 0.65, room.maxU − 0.65),
   width DOOR_WIDTH (or `tpl.mainDoorWidth`), `main: true`. Then each `tpl.exteriorDoors` entry
   `{ room, side: "front"|"back"|"left"|"right", width?, chance? }`: if `rng.chance(chance ?? 1)`, the first room of that
   kind touching that side of the extent gets a door at the midpoint of its touching segment (segment ≥ width + 0.4,
   else skipped). Kind `wide` when width ≥ 2, else `exterior`. Every exterior door's `exit` = door centre + 0.8 m
   along the outward normal, yaw outward (`frontYaw` of that side).
5. **To world.** Convert rooms, doors (axis: a door on a v-line is `'x'` for front 0/2 and `'z'` for front 1/3; on a
   u-line the opposite) and points to world coordinates.
6. **Walls.** Collect the 4 edges of every room as axis-aligned segments; group them by (orientation, line
   coordinate rounded to 0.01 m); union the intervals per line; subtract each door's opening (centre ± width/2) on
   its line; emit the remaining intervals (length > 0.01) in (orientation, coordinate, start) order.
7. **Locks.** `lockable` = exterior (not wide) or either room kind ∈ `tpl.lockableRooms` or a `cell`; `lockSide` =
   the room whose kind is in `lockableRooms` (if both, the one that is not `corridor`/`hallway`/`lobby`; exterior:
   −1); `lockedAtStart` = exterior ? `tpl.exteriorLocked` : either kind ∈ `tpl.lockedRooms`; `kind` = `cell` when either
   room is a `cell`. `strength` = exterior ? `tpl.exteriorStrength` : kind ∈ {`vault`} → 1, {`armory`, `evidenceRoom`,
   `cell`, `safe`} → 0.97, else 0.3.
8. **Furniture** (world space, rooms in index order, each room def's `furniture` entries in order; catalog
   `src/data/interior/furniture.json`): `n = rng.chance(chance ?? 1) ? rng.nextInt(c0, c1) : 0`; for each piece up to
   8 tries: `place: "wall"` → wall side `rng.nextInt(0, 3)` (0 minZ, 1 maxX, 2 maxZ, 3 minX), back 0.05 m from that
   wall, position along it `rng.nextFloat(lo, hi)` (keeps 0.1 m to the corners), yaw facing in (side 0 → π, 1 → π/2,
   2 → 0, 3 → −π/2); `"corner"` → corner `rng.nextInt(0, 3)`, against the corner's first wall (sides 0/1/2/3 for corners
   minX-minZ, maxX-minZ, maxX-maxZ, minX-maxZ); `"center"` → room centre + `rng.nextFloat(-j, j)` per axis
   (j = (room side − piece side)/4), yaw `rng.pick([0, π/2])`. AABB: yaw 0/π → (w along X, d along Z), ±π/2 swapped.
   Accept when the AABB is inside the room inset 0.05, does not overlap any accepted AABB inflated by 0.3, and does
   not overlap any **door clearance box** (door line ± (width/2 + 0.3) along the door, 1.0 m into each adjacent room).
9. **Derived spots.** Hiding spots: every piece with `hide` (position = piece centre). Spawn spots: every piece with
   `seat` (centre + 0.3 m toward its front; `sit` → pose `sit`, `lie` → `lying`) then, per room, its centre and one
   point 1 m from the centre toward `rng.nextInt(0,3)` side, kept when outside every AABB (pose `stand`). Item spots:
   pieces with `surface` → top (`y = h`, not concealed, container `none`); pieces with `container ≠ none` → inside
   (`y = h/2`, concealed); per room two floor points (y = 0, not concealed) at ±25 % of the room diagonal from the
   centre, kept when outside every AABB. Points: pieces with `point` → stand point = centre + facing·(d/2 + 0.6),
   yaw facing the piece. Lights: `light` (template default true) → centre. Switch: next to the room's lowest-index
   door, on its wall line at door centre + (width/2 + 0.35) along the door axis (the other side when that leaves the
   room), 0.08 m into the room, yaw facing into the room. `entry` = main door centre + 1.0 m inward, yaw inward.

Validation (`src/interior/templates.ts`, throws naming file + path): kinds ∈ `ROOM_KINDS`, furniture ids exist,
the entry room is required, corridor templates put the entry in the front band, sizes positive, counts
`[min ≤ max]`, every `point` ∈ `POINT_KINDS`, `exteriorDoors[].room` is a room of the template, the 12 kinds each have
exactly one template.

### 5.4 Data formats (`src/data/interior/`)

`furniture.json` (catalog; ids are referenced by templates):
```json
{ "version": 1, "items": [
  { "id": "sofa", "size": [2.0, 0.9, 0.85], "color": 7031114, "solid": true, "seat": "sit" },
  { "id": "bed", "size": [1.6, 2.0, 0.55], "color": 9474192, "solid": true, "seat": "lie", "hide": "underBed" },
  { "id": "wardrobe", "size": [1.2, 0.6, 2.0], "color": 8019507, "solid": true, "container": "closet", "hide": "closet" },
  { "id": "table", "size": [1.4, 0.9, 0.75], "color": 9132587, "solid": true, "surface": "wood" },
  { "id": "desk", "size": [1.4, 0.7, 0.75], "color": 6045747, "solid": true, "surface": "wood", "container": "drawer" },
  { "id": "counter", "size": [2.4, 0.7, 1.0], "color": 12632256, "solid": true, "surface": "stone", "container": "cabinet", "hide": "behindCounter" },
  { "id": "bathtub", "size": [0.8, 1.7, 0.6], "color": 15790320, "solid": true, "hide": "shower" },
  { "id": "shelf", "size": [1.8, 0.5, 1.8], "color": 10066329, "solid": true, "surface": "metal" } ...
] }
```
Fields: `id`, `size [w, d, h]`, `color` (0xRRGGBB as a decimal integer), `solid` (collider), optional `surface`
(`PRINT_SURFACES`), `container` (`CONTAINERS`, default `none`), `hide` (`HIDE_KINDS`), `seat` (`sit`/`lie`). The catalog
must contain at least: `sofa armchair chair stool bed wardrobe dresser nightstand table coffeeTable desk counter
kitchenCounter fridge stove sink toilet bathtub tvStand bookshelf shelf checkoutCounter cooler tellerCounter safe
barCounter barTable hospitalBed examTable schoolDesk teacherDesk whiteboard filingCabinet conferenceTable crate
palletRack pillar parkedCar locker bench podium armoryCounter evidenceLocker cellBench interviewTable frontDesk
computerDesk washer plant` (generic boxes; colours generic).

`templates/<kind>.json` (one per `BUILDING_KINDS` entry):
```json
{ "version": 1, "kind": "house", "label": "House", "layout": "bsp",
  "minWidth": 6, "minDepth": 6, "maxWidth": 16, "maxDepth": 14, "minRoomArea": 9,
  "entry": "living", "residential": true, "exteriorLocked": true, "exteriorStrength": 0.6,
  "lockableRooms": ["bedroom", "bathroom"], "lockedRooms": [],
  "corridor": null,
  "exteriorDoors": [ { "room": "kitchen", "side": "back", "chance": 0.6 } ],
  "occupants": { "day": [0, 2], "night": [1, 3], "profile": "residentInnocent", "role": "resident", "openHours": null },
  "rooms": [
    { "kind": "living", "label": "Living room", "size": 3, "required": true, "count": [1, 1], "surface": "wood",
      "furniture": [ { "id": "sofa", "place": "wall" }, { "id": "coffeeTable", "place": "center" },
                     { "id": "tvStand", "place": "wall", "chance": 0.8 } ] },
    { "kind": "kitchen", "label": "Kitchen", "size": 2, "required": true, "surface": "tile",
      "furniture": [ { "id": "kitchenCounter", "place": "wall" }, { "id": "fridge", "place": "corner" }, { "id": "table", "place": "center", "chance": 0.7 } ] },
    { "kind": "bedroom", "label": "Bedroom", "size": 2, "required": true, "count": [1, 3], "surface": "carpet",
      "furniture": [ { "id": "bed", "place": "wall" }, { "id": "wardrobe", "place": "wall" }, { "id": "nightstand", "place": "wall", "chance": 0.7 } ] },
    { "kind": "bathroom", "label": "Bathroom", "size": 1, "required": true, "surface": "tile",
      "furniture": [ { "id": "bathtub", "place": "corner" }, { "id": "toilet", "place": "wall" } ] }
  ] }
```
Room def fields: `kind`, `label`, `size` (> 0), `required`, `count` (default [1, 1]), `chance` (optional rooms),
`band` (`front`/`back`, corridor layout), `surface`, `public` (default false), `light` (default true), `suite`,
`furniture[]` (`id`, `place: wall|corner|center`, `count` default [1, 1], `chance`, `point`). Template fields:
`corridor: { "kind": "corridor", "width": 2.2, "frontShare": 0.4 } | null`, `mainDoorWidth` (default 0.9),
`occupants: { day: [min,max], night: [min,max], profile, role: 'resident'|'staff'|'patron', openHours: [open, close] | null }`
(a business is open when the game hour h satisfies open ≤ h < close, wrapping past midnight; residential
buildings use `day` 07-21 and `night` otherwise).

Template content (rooms → furniture; the builder authors them generously within these lists):

| Kind | Layout / size (W×D max) | Rooms (entry first) | Notes |
|---|---|---|---|
| house | bsp 16×14 | living, kitchen, bedroom×1-3, bathroom, laundry? dining? | back door 60 %, exterior locked |
| apartment | corridor 30×22, cw 2.0 | mailroom (entry, front), units `suite [unitLiving, unitBedroom, unitBath]` ×2-6 (front/back), laundry? | unit doors lockable, `lockableRooms: [unitLiving, unitBedroom, unitBath]` |
| convenienceStore | bsp 20×16 | salesFloor (public, entry), storage, backOffice (safe), restroom, cooler? | open 06-24, staff 1-2 clerks + patrons 0-3, checkoutCounter in salesFloor |
| bank | bsp 24×18 | lobby (public, entry), tellerArea, vault (locked, strength 1), office×1-2, breakRoom | open 09-17 |
| bar | bsp 20×16 | barRoom (public, entry), restroom×2, kitchen, storage, office | open 16-02 (wraps), patrons 3-8 |
| hospital | corridor 40×24, cw 2.4 | lobby (entry), waiting (public), exam×2-4, patientRoom×2-6, nurseStation, supply, pharmacy (locked) | 24 h, staff 2-4 |
| school | corridor 40×24 | lobby (entry), office, classroom×3-6, library, restroom×2, cafeteria? | open 07-16 |
| warehouse | bsp 40×30 | floor (entry, concrete, palletRack, crate), office, loading (wide back door), restroom | open 06-18 |
| office | corridor 36×22 | lobby (entry, public), office×3-8, conference, breakRoom, restroom | open 08-18 |
| parkingStructure | bsp 40×30 | deck (entry, concrete, pillars, parkedCar), stairwell | main door wide (2.8), never locked |
| jail | corridor 40×26 | lobby (entry), sallyPort (wide back door), booking (point `booking`), cell×4-6 (point `cell` on a cellBench), control, visiting | lockedRooms: [control] |
| policeStation | corridor 60×28 | front band, left→right: garage (wide front door, point `garage`), lockerRoom (lockers, point `locker`), lobby (entry, frontDesk point `frontDesk`), rollCall (podium point `briefing`, chairs), reportRoom (computerDesk point `reportDesk`); back band: armory (armoryCounter point `armory`), evidenceRoom (evidenceLocker point `evidence`), interview (interviewTable point `interview`, 2 chairs), cell×3 (cellBench point `cell`), sallyPort | exteriorLocked false; armory/evidence lockable not locked at start |

### 5.5 Navigation (`src/interior/nav.ts`)
```ts
/** Room index containing (x, z) (rect inclusive), -1 when none. */
export function roomAt(layout: InteriorLayout, x: number, z: number): number;
export type DoorPassable = (door: number) => boolean;
/**
 * Waypoints from (x, z) to (tx, tz) inside the layout: BFS over rooms through passable doors (ties: lower door index);
 * for each door crossed two points 0.5 m either side of the door centre along its normal, then the target.
 * Writes x, z pairs into `out` (Float32Array, capacity ≥ 64), returns the point count; 0 when unreachable or either
 * point is outside every room. Same room: 1 point (the target). Allocation-free.
 */
export function findPath(layout: InteriorLayout, x: number, z: number, tx: number, tz: number, passable: DoorPassable, out: Float32Array): number;
/** Path to the reachable exterior door with the fewest hops (ties: main door, then lower index), ending 0.4 m inside it;
 *  `door` receives its index (-1 none). */
export function exitPath(layout: InteriorLayout, x: number, z: number, passable: DoorPassable, out: Float32Array, door: { index: number }): number;
/** Rooms reachable from `room` through passable doors (BFS order). */
export function reachableRooms(layout: InteriorLayout, room: number, passable: DoorPassable, out: number[]): number[];
```

### 5.6 Line of sight (`src/interior/los.ts`)
```ts
export type DoorOpen = (door: number) => boolean;   // true = the opening is clear (open, broken or wide)
/** 2D: does the segment a→b cross a wall line or the panel line of a closed door? Proper crossings only
 *  (endpoints within 1e-4 of a line do not count). */
export function wallsBlock(layout: InteriorLayout, open: DoorOpen, ax: number, az: number, bx: number, bz: number): boolean;
/** 3D: does a→b (y relative to the floor) pass through any furniture AABB [minX,maxX]×[0,h]×[minZ,maxZ]? Slab test;
 *  `ignore` skips one furniture index (the surface an item lies on). */
export function furnitureBlocks(layout: InteriorLayout, ax: number, ay: number, az: number, bx: number, by: number, bz: number, ignore?: number): boolean;
export function lineOfSight(layout: InteriorLayout, open: DoorOpen, ax: number, ay: number, az: number, bx: number, by: number, bz: number, ignore?: number): boolean;
```
Wall heights equal the ceiling, so the 2D wall test is exact for any heights below `WALL_HEIGHT`.

### 5.7 Tests (`test/interior/**`, `test/world/buildings.test.ts`) — mandatory
Use `generateCity(42)` once per file (≈ 0.1 s) and a `BuildingIndex` over it; collect ≥ 20 buildings per kind where
the city has them (iterate blocks in id order) plus hand-made `BuildingInfo` rects for every kind (so each template is
exercised even if the city lacks it).
1. **Determinism:** `generateInterior(seed, b)` twice → deep-equal (compare JSON); a fresh index/city gives the same
   result; a different building id or seed changes at least one room rect for ≥ 90 % of samples.
2. **Reachability:** BFS through all doors (ignoring locks) from the main door's room reaches every room; with
   `passable = d => !lockedAtStart` the rooms behind locked doors are exactly those not reached — and become
   reachable when those doors pass.
3. **Door / lock consistency:** exactly one `main` door; every door's `a ≠ b`, both rooms touch the door line, the
   opening lies within the shared boundary of both rooms (or the room's outer edge for exterior doors) with 0.2 m
   margin; `lockedAtStart ⇒ lockable`; `wide ⇒ !lockable`; exterior ⇔ `b === -1` ⇔ `exit !== null`; `exit` points lie
   outside the building footprint; `lockSide` is `a` or `b` for interior lockable doors; wall segments never cover a
   door opening, and every room edge point not in an opening is covered by a wall segment.
4. **Geometry:** furniture AABBs inside their room inset 0.05, pairwise non-overlapping, outside every door
   clearance box; spawn / item / hiding spots inside their room; points inside their room; rooms tile the extent
   (areas sum to W'·D' ± 0.5 m² and rooms pairwise do not overlap); every room side ≥ 2.5 m except corridors (≥ 2.0 m).
5. **Templates:** each of the 12 kinds generates on its minimum and maximum size; the station layout contains every
   station point kind; validator rejections (unknown furniture, unknown room kind, missing entry) name the path.
6. **Buildings:** ids round-trip (`blockOfBuilding`/`localOfBuilding`); `blockBuildingRects` equals the buildings
   chunkLayout placed for that block (compare against `chunkLayout` of the chunks containing their centres);
   classification is deterministic and respects size constraints; the station building is `policeStation`; `jail()`
   exists for seed 42 and is downtown/industrial; `nearestEntrance` returns the nearest door; `frontSideOf` cases.
7. **Nav / LOS:** `findPath` crosses each door on the BFS route and ends at the target; closed doors block LOS,
   open ones do not; a 1.0 m counter blocks a ray at 0.8 m but not at 1.6 m; `exitPath` reaches the main door when
   it is the only exit.
8. **Perf:** `generateInterior` ≤ 3 ms average over 100 buildings in node; `nearestEntrance` ≤ 0.2 ms with a warm cache.

## 6. Interior runtime [indoors] (`src/indoors/**`, `src/render/interior/**`, `src/environment/render/environmentRenderer.ts`, `src/data/police/**`)

### 6.1 API (`src/indoors/interiorSystem.ts`, `src/indoors/types.ts`)
```ts
export const DOOR_STATE = { closed: 0, open: 1, locked: 2, broken: 3 } as const;
export type DoorStateId = (typeof DOOR_STATE)[keyof typeof DOOR_STATE];
export type DoorStateName = 'closed' | 'open' | 'locked' | 'broken';
export interface OccupantSpawn { buildingId: number; personId: number; x: number; z: number; yaw: number;
  pose: 'stand' | 'sit' | 'lying'; profile: string; role: 'resident' | 'staff' | 'patron' }
/** Implemented by the integrator over NpcSystem / RecordsDb / SceneDirector. */
export interface OccupantPort {
  spawn(spec: OccupantSpawn): number;          // actor id, 0 when the npc pool is full
  remove(actorId: number): void;
  /** Busy actors (in contact, cuffed, following, scene roles) are never removed on unload. */
  busy(actorId: number): boolean;
  /** True when a scene owns this building (no ambient occupants then). */
  sceneOwns(buildingId: number): boolean;
}
export interface InteriorDeps {
  readonly seed: number; readonly city: City; readonly physics: PhysicsWorld; readonly bus: EventBus<EventMap>;
  readonly rng: Rng;                          // session.rng.stream('interior')
  readonly buildings: BuildingIndex;
  readonly occupants: OccupantPort;
  now(): number;                              // game seconds
  kit(): { carried(item: string): number };
  readonly clock?: () => number;              // stats only
}
export interface OfficerAt { x: number; z: number; yaw: number; building: number; onFoot: boolean }
export type InteriorRequest =
  | { readonly kind: 'enter'; readonly buildingId: number; readonly door: number }
  | { readonly kind: 'exit'; readonly door: number }
  | { readonly kind: 'door'; readonly buildingId: number; readonly door: number;
      readonly action: 'toggle' | 'open' | 'close' | 'knock' | 'kick' | 'ram' | 'lock' | 'unlock' | 'announce' }
  | { readonly kind: 'switch'; readonly buildingId: number; readonly room: number };
export type InteriorInteractable =
  | { kind: 'entrance'; buildingId: number; door: number; distance: number }        // outdoors, at a resident building's exterior door
  | { kind: 'exit'; buildingId: number; door: number; distance: number }
  | { kind: 'door'; buildingId: number; door: number; state: DoorStateName; distance: number }
  | { kind: 'switch'; buildingId: number; room: number; on: boolean; distance: number }
  | { kind: 'point'; buildingId: number; point: number; pointKind: PointKind; distance: number };
export class InteriorSystem implements InteriorQuery {
  constructor(deps: InteriorDeps);
  readonly officerBuilding: number;                         // -1 outdoors
  readonly resident: readonly number[];                     // building ids with colliders, ≤ MAX_RESIDENT
  readonly revision: number;                                // bumps on residency / door / light changes (renderer)
  /** Fade state for the overlay: 0 = clear, 1 = black. */
  readonly fade: number;
  readonly stats: { resident: number; colliders: number; stepMs: number; occupants: number };
  layout(buildingId: number): InteriorLayout | null;         // generateInterior, LRU 16
  building(buildingId: number): BuildingInfo | null;
  doorState(buildingId: number, door: number): DoorStateName;
  doorRevision(buildingId: number): number;
  roomLit(buildingId: number, room: number): boolean;
  /** Scenes: force a door state (lock a barricade's front door, unlock after SWAT). Saved as an override. */
  setDoorState(buildingId: number, door: number, state: DoorStateName): void;
  setRoomLight(buildingId: number, room: number, on: boolean): void;
  /** The nearest thing within reach (≤ 1.8 m entrance/exit, 1.6 m door, 1.2 m switch, 1.8 m point), ahead of the
   *  officer (60° half cone; entrances/exits any direction). Scratch result, valid until the next call. */
  nearestInteractable(x: number, z: number, yaw: number, building: number): InteriorInteractable | null;
  /** Fixed step (order -810). */
  step(dt: number, officer: OfficerAt): void;
  request(r: InteriorRequest): void;
  /** Synchronously makes `buildingId` resident and puts the officer inside (new game in the station, loads). */
  placeOfficerInside(buildingId: number, pose: { x: number; z: number; yaw: number }): void;
  navPort(): IndoorNavPort;                                 // §8.2 (npc)
  floorPlan(buildingId: number): FloorPlan | null;          // §9.4 (HUD minimap)
  serialize(): InteriorSave; restore(save: InteriorSave): void; dispose(): void;
}
```
### 6.2 Behaviour
- **Residency** (every 15 steps while outdoors, every step on requests): wanted = { officerBuilding (when ≥ 0) } ∪
  { `buildings.nearestEntrance(officer.x, officer.z, STREAM_RADIUS)` when outdoors }. Unload the others (remove their
  colliders; `occupants.remove` every ambient actor of that building that is not `busy`), then load the new ones
  (≤ 1 load per step): layout → fixed cuboid colliders created on `physics.raw` (no entity id, so they block the
  officer like buildings): every wall segment (half extents length/2 × WALL_HEIGHT/2 × WALL_THICKNESS/2, centre y =
  floorY + WALL_HEIGHT/2), every `solid` furniture AABB (height h), every door whose state is closed/locked
  (panel box width × DOOR_HEIGHT × 0.05). Emits `interior:resident { buildingId, loaded }`. Spawns ambient occupants
  (§6.3) when `!occupants.sceneOwns(id)`.
- **Enter / exit**: `enter` requires the officer outdoors within 1.8 m of that building's exterior door `exit` pose
  (resident), the door not locked (a locked door: flash "Locked"; breach it first or knock). It starts a fade:
  `fade` rises 0 → 1 over 0.3 s; at 1 the system emits `interior:moveOfficer { buildingId, x, y: floorY, z, yaw }`
  (pose = 1.0 m inside that door, facing in; the main door uses `layout.entry`), sets `officerBuilding`, then `fade`
  falls 1 → 0 over 0.3 s; `interior:transition { buildingId, entering: true, phase: 'done' }` at the end. `exit` from
  inside within 1.8 m of an exterior door: the same, to the door's `exit` pose at y = 0 and `officerBuilding = -1`.
  An open/broken/wide door is passed through without opening; a closed one is opened first (state → open).
- **Doors** (officer within 1.6 m of the door centre, same building): `toggle/open/close` (locked → `interior:door`
  action `locked`, no change); `knock` (any state; `interior:door` action `knock`); `announce` ("Police!" — action
  `announce`, sound only); `kick` (on foot, not open; cooldown 1.0 s; success `rng.chance(clamp(0.7 − 0.6·strength,
  0, 0.7))`, strength ≥ 0.95 never; success → `broken`); `ram` (needs `kit().carried('ram') ≥ 1`; success
  `rng.chance(clamp(1.1 − 0.8·strength, 0, 0.95))`, strength ≥ 0.95 never; success → `broken`); `lock/unlock` (lockable
  doors; interior doors only from the `lockSide` room; exterior doors only from inside). Every change updates the
  door collider (when resident), bumps `doorRevision(id)` and `revision`, and emits `interior:door { buildingId,
  door, action, success, x, z, by: 'officer' }` (`action` ∈ `open close locked knock announce kick ram breached lock
  unlock`; `breached` follows a successful kick/ram).
- **Lights**: `roomLit` = override ?? default. Default: room has a light and (business open and the room is
  `public` or staff) or (residential and night (`hour ≥ 19 || hour < 7`) and `unitHash(seed, 0x11c7, id·64 +
  room) < 0.35`) or the building is a police station / hospital / jail (always). `switch` toggles (officer within
  1.2 m of `switchAt`); emits `interior:switch { buildingId, room, on }`.
- **Wide doors** are always `open`; `doorState` of a `wide` door is `'open'`, requests on it are ignored.

### 6.3 Ambient occupants (pure planner `src/indoors/occupants.ts`)
```ts
export function occupantPlan(seed: number, layout: InteriorLayout, gameSeconds: number, out: OccupantSpawn[]): OccupantSpawn[];
```
Count: residential → `occupants.day|night` range by hour; business → open hours: staff count from `occupants.day`
plus patrons (`role: 'patron'`, `[0, 3]` for stores, `[3, 8]` bars), closed → 0 (warehouse/office closed → 0).
Picks by `hash3(seed, salt, layout.buildingId * 97 + epochDay * 24 + hour)` streams (no rng state): residents use
`hash3(seed, 0x2e51, buildingId * 8 + k) % PERSON_POPULATION` (stable residents of the building; the integrator's
`spawn` sets their address with `records.setAddress`); staff/patrons use `hash3(seed, 0x51af + k, buildingId * 24 +
hour)`. Positions: spawn spots in public rooms for patrons/staff, any room for residents (night: `lying` spots in
bedrooms first). Profile `tpl.occupants.profile` (`residentInnocent` / `bystander`). Spawned once per residency.

### 6.4 Nav port (for npc, §8.2) and floor plan
`navPort()` returns `{ path, exit, hideSpot }` built on `findPath` / `exitPath` with `passable = door => state is
open, closed or broken` (NPCs pass closed unlocked doors without animating them; locked doors block NPCs),
`hideSpot` = the hiding spot of that building farthest from (awayX, awayZ) not already used by another hidden
actor (the port tracks claimed spots per building; `releaseHide(buildingId, index)` frees one).
`FloorPlan = { rooms: Float32Array /* minX,minZ,maxX,maxZ */; doors: Float32Array /* x, z, open 0|1 */; rect: Rect }`.

### 6.5 Save (`src/indoors/save.ts`)
```ts
export interface InteriorSave { version: 1; rng: RngState; officerBuilding: number;
  doors: [number, number, number][];   // [buildingId, door, DOOR_STATE] overrides (≤ 2 000, oldest dropped, the officer's building kept)
  lights: [number, number, 0 | 1][];   // [buildingId, room, on] overrides (≤ 2 000)
  kickCooldown: number; fade: number; pending: { kind: 'enter' | 'exit'; buildingId: number; door: number; phase: 0 | 1 | 2; t: number } | null;
  queue: InteriorRequest[]; spawned: [number, number[]][] /* buildingId → ambient actor ids */ }
export function isInteriorSave(x: unknown): x is InteriorSave;
export function emptyInteriorSave(rng: RngState): InteriorSave;   // officerBuilding -1, no overrides
```
`restore` re-applies overrides and makes the officer's building resident synchronously (colliders).

### 6.6 Rendering (`src/render/interior/**`)
```ts
export class InteriorRenderer {
  constructor(scene: THREE.Scene, options?: { maxInteriors?: number /* 2 */ });
  /** Rebuilds instance buffers when `sys.revision` changed; animates door panels (0.25 s swing, 95° into room `a`);
   *  only the officer's building is visible. */
  update(sys: InteriorSystem, dt: number, cameraX: number, cameraZ: number): void;
  readonly drawCalls: number;
  dispose(): void;
}
export class InteriorLightPool {   // 4 PointLights always in the scene (shader light count constant)
  constructor(scene: THREE.Scene, size?: number);
  /** Lit rooms of the officer's building nearest the camera get a light at the fixture (y = floorY + 2.7,
   *  intensity 12, distance 10, decay 2, colour 0xfff1d6); the rest intensity 0. */
  update(sys: InteriorSystem, cameraX: number, cameraZ: number): void;
  dispose(): void;
}
```
Per resident interior: `InstancedMesh` boxes for walls (light grey, `MeshLambertMaterial`), floors (one box per
room, colour by surface), ceiling (one box), furniture (instanceColor), door panels (wood colour; matrices updated
only while swinging), fixtures + switches (small emissive boxes) → ≤ 6 draw calls. `receiveShadow = castShadow =
false`, `frustumCulled = false` on the group, `visible` only for the officer's building. Geometry/material built once
per residency (no per-frame allocation). Headless constructs nothing heavy.

`EnvironmentRenderer.setIndoor(on: boolean)`: hides the precipitation points and the heat-haze pass while on
(nothing else changes). Default off.

### 6.7 Trunk items (`src/data/police/items.json`, `equipment.json`)
Append (labels generic):
`{ "id": "ram", "label": "Door ram", "carryMax": 1, "deployable": false }`, `sceneTape` ("Scene tape roll", 1),
`evidenceMarkers` ("Evidence marker tents", 20, deployable), `evidenceBags` ("Evidence bags", 20), `fingerprintKit`
("Fingerprint kit", 1), `camera` ("Evidence camera", 1). `trunkLoadouts.patrol` gains `ram: 1, sceneTape: 1,
evidenceMarkers: 20, evidenceBags: 20, fingerprintKit: 1, camera: 1`. Existing police tests stay green.

### 6.8 Events (`src/indoors/events.ts`)
`interior:resident { buildingId, loaded }`, `interior:moveOfficer { buildingId, x, y, z, yaw }`,
`interior:transition { buildingId, entering, phase: 'out' | 'in' | 'done' }`, `interior:door { buildingId, door,
action, success, x, z, by: 'officer' | 'scene' }`, `interior:switch { buildingId, room, on }`, `interior:flash { text }`.

### 6.9 Tests (`test/indoors/**`, `test/interiorrender/**`)
With `initRapier()` and a real `PhysicsWorld` + `generateCity(42)` + a stub `OccupantPort`: residency loads the
nearest entrance's colliders within 25 m and unloads them beyond (collider count returns to 0); the officer's
character controller (session-like test using `createCharacterController`) cannot walk through an interior wall but
passes an open door; enter → moveOfficer event at fade 1 with the entry pose, `officerBuilding` set, exit returns to
the exit pose; locked door blocks `open` and `enter`; kick/ram success odds by strength with a seeded rng (vault
never), ram requires the kit item; lock/unlock side rules; door collider removed when open/broken and back when
closed; light defaults by hour and overrides; `occupantPlan` deterministic, counts by hour/open hours, residents
stable across days; save round trip (overrides, pending fade, queue) continues identically; renderer headless
counts (draw calls ≤ 6, door swing no allocation); light pool picks the nearest lit rooms.

## 7. Tactical [tactical] (`src/tactical/**`, `src/player/cameraRig.ts`, `src/render/people/**`, `src/render/tactical/**`, `src/data/tactics/**`)

### 7.1 Sound propagation model (`src/tactical/sound.ts`, pure) — mandatory tests
```ts
export const SOUND_KINDS = ['footstep', 'doorOpen', 'doorClose', 'knock', 'kick', 'ram', 'radioChirp', 'voiceTalk', 'voiceShout', 'announce', 'taser', 'flashlightClick'] as const;
export type SoundKind = (typeof SOUND_KINDS)[number];
/** Attenuation matrix between the rooms of a layout plus the outside node (index = rooms.length). */
export interface SoundGraph { readonly n: number; readonly att: Float32Array /* n*n dB, Infinity = no path */; readonly revision: number }
export function doorAttenuation(state: DoorStateName, kind: DoorKind, cfg: TacticsConfig): number;   // open/broken/wide 2, closed 18, locked 18, cell (closed) 6
/**
 * Edges: rooms joined by a door → min over their doors of doorAttenuation; rooms sharing a wall (overlap ≥ 0.5 m, no door) →
 * cfg.wallDb (35); room ↔ outside: via exterior doors (doorAttenuation) and exterior walls (cfg.exteriorWallDb, 40).
 * All-pairs shortest path (Floyd-Warshall, n ≤ 64). Allocation only when `out` is too small.
 */
export function buildSoundGraph(layout: InteriorLayout, state: (door: number) => DoorStateName, cfg: TacticsConfig, revision: number, out?: SoundGraph): SoundGraph;
/** level − 20·log10(max(1, distance)) − att[src][dst]; -Infinity when no path. Distance = straight 2D distance. */
export function receivedLevel(level: number, srcNode: number, sx: number, sz: number, dstNode: number, lx: number, lz: number, g: SoundGraph | null): number;
export function hearingThreshold(hearing: 'normal' | 'hardOfHearing' | 'deaf', asleep: boolean, cfg: TacticsConfig): number;   // 20 / 40 / Infinity; asleep +20
/** 0 below threshold, else min(1, (level - threshold) / cfg.stimulusRangeDb (30)). */
export function stimulus(level: number, threshold: number, cfg: TacticsConfig): number;
/** Footstep level: cfg.footstepDb[surface] + (speed > 5 ? +8 : speed < 1.6 ? -6 : 0) + (crouched ? -10 : 0); -Infinity when speed < 0.3. */
export function footstepLevel(surface: string, speed: number, crouched: boolean, cfg: TacticsConfig): number;
export function sourceLevel(kind: SoundKind, cfg: TacticsConfig): number;   // table
```
Nodes: inside a building a point's node is `roomAt(layout, x, z)` (−1 → outside node); outdoors the outside node with
graph `null` (pure distance). Source and listener in different buildings → −Infinity; one outdoors, one inside
building B → use B's graph with the outdoor point on the outside node.

`src/data/tactics/tactics.json`:
```json
{ "version": 1,
  "sound": { "wallDb": 35, "exteriorWallDb": 40, "doorOpenDb": 2, "doorClosedDb": 18, "cellDoorDb": 6, "stimulusRangeDb": 30,
    "hearing": { "normal": 20, "hardOfHearing": 40, "asleepBonus": 20 },
    "footstepDb": { "carpet": 28, "wood": 40, "tile": 42, "concrete": 38, "linoleum": 36, "asphalt": 36, "grass": 24, "gravel": 44, "dirt": 28, "sand": 26 },
    "sources": { "doorOpen": 45, "doorClose": 55, "knock": 65, "kick": 95, "ram": 100, "radioChirp": 62, "radioEarpiece": 22,
                 "voiceTalk": 58, "voiceShout": 85, "announce": 90, "taser": 70, "flashlightClick": 25 },
    "footstepIntervalS": { "walk": 0.5, "run": 0.33, "crouch": 0.7 }, "listenRadiusM": 40 },
  "stance": { "standEye": 1.65, "crouchEye": 1.05, "crouchSpeed": 0.5, "leanOffset": 0.35, "leanRoll": 0.17, "leanSpeedFactor": 0.5, "leanRate": 6 },
  "slice": { "speed": 0.6, "radiusMin": 1.2, "radiusMax": 3.0, "radialSpeed": 0.5, "maxAngle": 1.4, "engageM": 3.0, "engageCone": 1.22 },
  "notice": { "rangeM": 25, "periodS": 0.25, "fovCos": 0.5, "peripheral": 0.3, "sightRate": 0.8, "lightRate": 0.6,
              "flashlightCone": 0.35, "flashlightRange": 20, "darkFactor": 0.3, "nightOutdoor": 0.5, "decayPerS": 0.05 },
  "partner": { "followM": 1.6, "speed": 3.0, "stackOffset": 0.6, "colors": { "top": 1985647, "bottom": 1250067 } } }
```
Tests (`test/tactical/sound.test.ts`, mandatory): same room = pure inverse-square (−6 dB per doubling); a closed
door between adjacent rooms attenuates 16 dB more than an open one; a chain of 3 rooms through open doors beats a
direct wall (path through doors chosen by Floyd-Warshall); unreachable (no doors, exterior walls only → wall path);
symmetry `att[a][b] === att[b][a]`; monotonic in distance; outdoor source → indoor listener through the exterior
door vs through walls; deaf never stimulated; asleep threshold +20; footstep levels (carpet < tile, crouch −10,
standing still −Infinity); revision reuse (`out` reused when the revision matches).

### 7.2 Stance, slicing, exposure (pure)
```ts
// src/tactical/stance.ts
export interface StanceState { crouched: boolean; lean: -1 | 0 | 1; leanAmount: number /* smoothed -1..1 */ }
export function stepLean(state: StanceState, dt: number, cfg: TacticsConfig): void;   // leanAmount → lean at cfg.leanRate per s (clamped)
/** Movement speed multiplier: crouched cfg.crouchSpeed (sprint ignored), leaning cfg.leanSpeedFactor, both multiply. */
export function speedFactor(state: StanceState, cfg: TacticsConfig): number;
/** Eye offset from the feet: lateral (right vector · leanAmount · leanOffset), y (crouch/stand eye), roll (−leanAmount · leanRoll). */
export function eyeOffset(state: StanceState, yaw: number, cfg: TacticsConfig, out: { x: number; y: number; z: number; roll: number }): void;
// src/tactical/slice.ts
export interface SliceDoor { x: number; z: number; nx: number; nz: number /* unit normal pointing to the officer's side */ }
/** Picks the open doorway (open/broken/wide) within cfg.engageM ahead (cone cfg.engageCone) of the officer, -1 none. */
export function pickSliceDoor(layout: InteriorLayout, state: (d: number) => DoorStateName, x: number, z: number, yaw: number, cfg: TacticsConfig, out: SliceDoor): number;
/**
 * One slicing step: polar coordinates around the door centre; strafe changes the angle at cfg.speed / r rad/s (right = +),
 * forward/back change r at cfg.radialSpeed within [radiusMin, radiusMax]; the angle from the normal is clamped to ±maxAngle
 * (the officer never crosses the door plane); yaw faces the door centre. Writes the target position and yaw.
 */
export function sliceStep(x: number, z: number, door: SliceDoor, forward: number, strafe: number, dt: number, cfg: TacticsConfig,
  out: { x: number; z: number; yaw: number }): void;
// src/tactical/exposure.ts
/** Three body points (head, chest, hips) of the officer: standing y 1.6/1.2/0.8, crouched 1.0/0.75/0.45; the head point
 *  is shifted by the lean offset. out: Float32Array(9) x,y,z (y above the floor). */
export function bodyPoints(x: number, z: number, yaw: number, stance: StanceState, cfg: TacticsConfig, out: Float32Array): Float32Array;
/** Fraction (0, 1/3, 2/3, 1) of the points visible from the viewer eye (y above the floor). Outdoors (layout null) → 1. */
export function exposure(layout: InteriorLayout | null, open: (d: number) => boolean, ex: number, ey: number, ez: number, points: Float32Array): number;
```
Tests: crouching behind a 1.0 m counter between viewer and officer lowers exposure from 1 to ≤ 1/3 while standing
gives ≥ 2/3; a closed door gives 0, open 1; lean shifts the head point by 0.35 m to the correct side; slice keeps the
officer on its side of the door plane, clamps the radius, strafe right increases the angle, yaw faces the door;
speed factors; `pickSliceDoor` ignores closed doors.

### 7.3 Runtime (`src/tactical/tacticalSystem.ts`)
```ts
export interface Listener { actorId: number; personId: number; x: number; z: number; building: number;
  hearing: 'normal' | 'hardOfHearing' | 'deaf'; asleep: boolean; yaw: number; eyeY: number }
/** Implemented by NpcSystem (§8.1). */
export interface ListenerPort {
  listeners(x: number, z: number, radius: number, out: Listener[]): number;      // fills out (reused objects), returns count
  stimulate(actorId: number, kind: 'sound' | 'sight' | 'light', amount: number, srcX: number, srcZ: number): void;
}
export interface OfficerPose { x: number; z: number; yaw: number; pitch: number; building: number; speed: number; onFoot: boolean }
export interface TacticalDeps { readonly seed: number; readonly bus: EventBus<EventMap>; readonly rng: Rng /* 'tactical' */;
  readonly city: City; readonly interiors: InteriorQuery; readonly listeners: ListenerPort;
  officer(out: OfficerPose): OfficerPose; radioEarpiece(): boolean; nightFactor(): number; readonly config?: TacticsConfig }
export type TacticalRequest =
  | { readonly kind: 'crouch' }                                   // toggle
  | { readonly kind: 'flashlight' }                               // toggle
  | { readonly kind: 'partner'; readonly command: 'follow' | 'stack' | 'hold' | 'clear' | 'dismiss' | 'summon' }
  | { readonly kind: 'sound'; readonly source: SoundKind; readonly x: number; readonly z: number; readonly building: number; readonly level?: number };
export class TacticalSystem {
  constructor(deps: TacticalDeps);
  step(dt: number, t: { sim: number; game: number }): void;      // order -640
  request(r: TacticalRequest): void;
  /** Held inputs, read in the fixed step: lean direction (Q/R) and slice (RMB). */
  setHeld(lean: -1 | 0 | 1, slice: boolean): void;
  readonly stance: Readonly<StanceState>; readonly flashlightOn: boolean; readonly slicing: boolean;
  speedFactor(): number;
  /** While slicing: the velocity (m/s) and yaw that move the officer one slicing step; false when not slicing. */
  sliceMove(x: number, z: number, forward: number, strafe: number, dt: number, out: { vx: number; vz: number; yaw: number }): boolean;
  eye(yaw: number, out: { x: number; y: number; z: number; roll: number }): void;
  readonly noise: number;        // 0..1: last officer-made sound level / 100, decays 0.5/s
  readonly visibility: number;   // 0..1: max over listeners of exposure × light at the last notice pass
  readonly partner: PartnerOfficer;
  /** Places the partner beside (x, z) on a level change (follow mode only). */
  teleportPartner(building: number, x: number, z: number, yaw: number): void;
  serialize(): TacticalSave; restore(s: TacticalSave): void; dispose(): void;
}
```
Each step: apply queued requests; `stepLean`; **footsteps**: while on foot and speed ≥ 0.3, a timer (interval by
gait: crouch / walk / run (speed > 5)) emits `footstep` at the officer (surface: room `surface` indoors, else
`city.surfaceAt` name); **bus sounds** collected by listeners registered in the constructor (Phase 2-3 topics only: tactical must not
import `src/indoors`) and queued for this step: `radio:start` (every
transmission the officer's radio plays: `radioChirp`, or `radioEarpiece` level when `radioEarpiece()`),
`contact:line` speaker `officer` → `voiceTalk` at the officer, `force:used` kind `taser` → `taser`, and requests of kind
`sound` (the integrator bridges `interior:door` → open→doorOpen, close→doorClose, knock, kick, ram, announce, and sends
`voiceShout` on G); the flashlight toggle → `flashlightClick`.
**SoundField**: for each queued sound, `listeners(x, z, listenRadiusM)`; per listener `receivedLevel` (graph per
building cached by `doorRevision`) → `stimulus` vs `hearingThreshold` → `stimulate(id, 'sound', s, x, z)` when
> 0; emits `tactical:sound { kind, x, z, building, level }` for officer-made sounds (noise meter). **Notice** every
`periodS`: for each listener within `rangeM` on the officer's level (same building, or both outdoors): FOV factor
(dot of the listener's facing with the direction to the officer ≥ fovCos → 1, else `peripheral`); light = officer's
room lit (or outdoors `1 − nightOutdoor·night`) else `darkFactor`; exposure from the listener's eye to `bodyPoints`;
`sight = exposure · light · fov · sightRate · periodS · (1 − d/rangeM)` → `stimulate(id, 'sight', …)`; when the
flashlight is on and the listener is within `flashlightRange` and inside the beam cone (angle from the officer's yaw
≤ flashlightCone) or has line of sight to the officer's head: `stimulate(id, 'light', lightRate · periodS, …)`.
`visibility` = max(exposure · light · fov). **Partner** (§7.4) steps last.

### 7.4 Partner placeholder (`src/tactical/partner.ts`)
```ts
export type PartnerMode = 'follow' | 'stack' | 'hold' | 'clear' | 'away';
export class PartnerOfficer {
  readonly view: HumanoidSource;        // one figure (createHumanoidSource(1)): uniform colours, pose walk/stand/aim
  readonly mode: PartnerMode; readonly building: number; readonly x: number; readonly z: number; readonly yaw: number;
  command(c: 'follow' | 'stack' | 'hold' | 'clear' | 'dismiss' | 'summon', officer: OfficerPose, q: InteriorQuery): string | null;   // reply text or null
  step(dt: number, officer: OfficerPose, q: InteriorQuery): void;
}
```
- `follow`: walk (cfg.partner.speed) to a point `followM` behind the officer (indoors through `findPath`, recomputed
  every 0.5 s); hidden (`FIGURE_FLAG.hidden`) while the officer drives (`onFoot` false) and re-placed beside the
  officer when they get out. `dismiss` → `away` (hidden), `summon` → follow at the officer.
- `stack`: the nearest door within 4 m of the officer (`pickSliceDoor`-like without the cone): position = door centre
  + normal·0.6 (officer's side) + along-door·(width/2 + stackOffset) on the side away from the officer; faces the door;
  reply "Stacked up on the door."
- `clear`: from a stack, walks through the doorway to the room's centre (nav), pose `aim`, then after 2 s `hold` and
  emits `tactical:partner { text: 'Room clear.' }` (or "Contact!" when an awake non-hidden actor is in that room — read
  through the ListenerPort's listeners).
- `hold`: stays. Commands reply via `tactical:partner { text }` (subtitles + optional TTS by the integrator).
Tests: stack position on the officer's side next to the frame opposite the officer; follow keeps ~1.6 m and uses the
nav path through a doorway; clear reaches the room centre and reports.

### 7.5 First-person camera, crouch pose, flashlight rig
- `src/player/cameraRig.ts` adds:
  ```ts
  /** First-person pose: camera at (x + eye.x, feetY + eye.y, z + eye.z) looking along yaw/pitch, rolled by eye.roll. */
  export function firstPersonPose(x: number, feetY: number, z: number, yaw: number, pitch: number, eye: { x: number; y: number; z: number }, out: CameraPose): CameraPose;
  // CameraRig:
  updateFirstPerson(x: number, feetY: number, z: number, yaw: number, pitch: number, eye: { x: number; y: number; z: number; roll: number }, camera: THREE.PerspectiveCamera): void;
  ```
  Pitch sign follows `PlayerController.pitch` (positive = looking down in the orbit camera; in first person positive
  pitch looks **down** too, so mouse handling is unchanged). Existing camera tests stay green.
- `src/render/people/pose.ts`: `POSE.crouch = 12` (append; `limbPose`: drop 0.35, knees 1.2, legs −0.6, torsoPitch
  0.25, arms as stand; walking while crouched swings legs ±0.3). Tests extended.
- `src/render/tactical/flashlightRig.ts`: `class FlashlightRig { constructor(scene); update(on, camera: THREE.Camera): void;
  dispose() }` — one `SpotLight` (0xfff4e0, intensity 60, distance 25, angle 0.35, penumbra 0.4, decay 2, no shadow)
  always in the scene (intensity 0 when off), positioned 0.2 m right/0.2 m down of the camera, target 10 m ahead.

### 7.6 Save and events
`TacticalSave { version: 1; rng: RngState; crouched: boolean; lean: -1 | 0 | 1; leanAmount: number; flashlight: boolean;
footTimer: number; noticeTimer: number; noise: number; partner: { mode: PartnerMode; building: number; x: number; z: number;
yaw: number; door: number; room: number; timer: number } ; queue: TacticalRequest[]; pendingSounds: { kind: SoundKind; x: number; z: number; building: number; level: number }[] }`,
`isTacticalSave`, `defaultTacticalSave(rng)`. Events (`src/tactical/events.ts`): `tactical:sound { kind, x, z, building,
level }`, `tactical:stance { crouched }`, `tactical:flashlight { on }`, `tactical:partner { text }`.
Runtime tests (`test/tactical/system.test.ts`) with a stub InteriorQuery (a generated house layout) and a stub
ListenerPort: footsteps stimulate a listener in the same room but not a deaf one; a closed door reduces the
stimulus; the flashlight stimulates `light` only in the cone; crouched behind a counter gives lower sight stimulus;
save → restore → identical next steps; no allocation per step after warm-up (heap delta pattern).

## 8. People indoors [people4] (`src/npc/**`, `src/dialogue/**`, `src/contact/**`, `src/data/npc/**`, `src/data/dialogue/**`)

### 8.1 NpcSystem additions (keep every Phase 3 behaviour for outdoor actors)
```ts
// src/npc/types.ts
export interface ActorSpawn { /* Phase 3 fields */ readonly building?: number /* default -1 */ }
export interface ActorInfo { /* Phase 3 fields */ building?: number; aware?: number }   // always written by actor(); optional so Phase 3 literals (session, scene) still compile
export interface NpcFocus { /* Phase 3 fields */ building?: number /* default -1 */ }
export interface ActorSave { /* Phase 3 fields */ building?: number; aware?: number; hideSpot?: number }
export interface IndoorNavPort {
  path(buildingId: number, x: number, z: number, tx: number, tz: number, out: Float32Array): number;
  exit(buildingId: number, x: number, z: number, out: Float32Array, pose: { x: number; z: number; yaw: number }): number;
  hideSpot(buildingId: number, x: number, z: number, awayX: number, awayZ: number, pose: { x: number; z: number; yaw: number }): number;
  releaseHide(buildingId: number, index: number): void;
}
export interface NoGoZone { readonly id: number; readonly points: Float32Array /* x, z pairs, closed polygon */;
  readonly minX: number; readonly minZ: number; readonly maxX: number; readonly maxZ: number }
export const AWARE_REACTIONS = ['none', 'hide', 'flee', 'confront', 'surrender', 'arm'] as const;
// NpcSystem
setIndoorNav(nav: IndoorNavPort | null): void;
/** Moves an actor to a level and position (scene: residents to the door; station: prisoners to cells). Clears its route. */
setActorPosition(id: number, building: number, x: number, z: number, yaw: number): void;
/** Every following (escorted) actor joins the officer on a level change, placed 1 m behind (x, z, yaw). */
transferFollowers(building: number, x: number, z: number, yaw: number): void;
/** Persons nearest (x, z) on `building` only (default -1: outdoors; pedestrians and occupants are outdoors). */
nearestPerson(x: number, z: number, yaw: number, maxDist: number, coneCos: number, out: PersonPick, building?: number): PersonPick | null;
/** ListenerPort (§7.3): actors within radius of (x, z) on any level; hearing from the identity
 *  (`people.identity(personId).hearing` mapped to normal / hardOfHearing / deaf; dogs normal); profiles subjectDeceased /
 *  subjectUnconscious → 'deaf'; asleep = state lying && not those profiles && game hour ∈ [0, 6). eyeY 1.6 (sit 1.1,
 *  lying 0.3), yaw = the actor's yaw. */
listeners(x: number, z: number, radius: number, out: Listener[]): number;
stimulate(actorId: number, kind: 'sound' | 'sight' | 'light', amount: number, srcX: number, srcZ: number): void;
setNoGoZones(zones: readonly NoGoZone[]): void;
/** Actors of a building (ids into out). */
actorsInBuilding(buildingId: number, out: number[]): number[];
```
`Listener` is declared structurally in `src/npc/types.ts` with the §7.3 shape (tactical declares the same).
Behaviour changes in `npcSystem.ts`:
1. **Level.** `ActorRec.building` (−1 default); `publish` writes `y = prevY = levelY(building)`; occupants and peds stay
   0. `nearestPerson`, `tackle`, `taser`, the follow logic and `inCone` consider only actors on the requested level
   (`tackle(officerX, officerZ, officerYaw, building = -1)` gains the same optional parameter).
2. **Indoor movement** (actor `building ≥ 0` and a nav port set): `startWalkTo` → `nav.path` route (route buffer of
   up to 32 points); `follow` → path to the officer's position every 1 s; `startFlee` → `nav.exit` route; when the last
   point is reached the actor steps outdoors at the exit pose (`building = -1`, x/z = pose) and continues with the
   Phase 3 `planAway`; when `exit` returns 0 → `hideSpot` (state `hide`, flag hidden) or `hold` when none; `leave` →
   exit then Phase 3 leave; `wander` and `crowd` are not used indoors (an indoor actor that would wander idles).
   Without a nav port indoor actors only idle/hold (tests).
3. **Awareness** `ActorRec.aware` 0..1: `stimulate` adds `amount` (sound × 1, sight × 1, light × 1.5) clamped to 1 and
   remembers the source; decays by `npc.json` `actors.awareDecayPerS` (0.05) at the actor LOD rate. Crossing
   `alertAt` (0.3) → faces the source (not hidden, not cuffed/fleeing) and emits `npc:aware { level: 'alert' }`;
   crossing `awareAt` (0.7) → once per actor rolls the profile's `onAware` weights (`behaviors.json`, optional
   `{ "hide": 0.6, "flee": 0.4 }`, default `{ "none": 1 }`) with the actors stream: `hide` (indoors: move to
   `nav.hideSpot`, hidden; outdoors: none), `flee` (reveal, `startFlee`), `confront` (reveal; armed → `startArmed`,
   else `startFight` when the officer is within 3 m, else `hold` facing the source), `surrender` (reveal, `handsUp`),
   `arm` (draw the carried weapon, `hold`), `none`; emits `npc:aware { actorId, personId, callId, level: 'aware',
   reaction, cause }`. Hidden actors are only stimulated by sound and light (they cannot see).
4. **No-go zones**: a pedestrian whose next position lies inside a zone (bbox then `pointInPolygon`, in
   `src/npc/geometry.ts`) turns away (`turnPedAway`); a pedestrian spawned inside a zone is not spawned; actors with
   `callId === 0` (ambient occupants, promoted pedestrians) that stand inside a zone get `leave`. Scene participants
   (`callId > 0`) ignore tape.
5. `behaviors.json` adds `onAware` to: suspectEvasive {hide .6, flee .4}, suspectFleeRisk {flee .8, hide .2},
   suspectNervous {surrender .3, flee .3, hide .4}, suspectAgitated {confront .5, flee .2, none .3},
   suspectHostile {confront .8, hide .2}, suspectArmedHostile {arm .5, confront .3, hide .2}, barricaded {hide .7,
   arm .3}, ambusher {arm 1}; every other profile none (they only turn toward the sound). `npc.json` adds
   `actors.awareDecayPerS 0.05, actors.alertAt 0.3, actors.awareAt 0.7`.
6. `isNpcSave` accepts the optional `building`, `aware`, `hideSpot`; v5 saves restore with `building -1`, `aware 0`.

### 8.2 Dialogue and contact
- `src/dialogue/types.ts`: `CONSENT_KINDS` gains `'entry', 'searchPremises', 'searchRoom'`; `REQUIREMENTS` gains
  `'premisesAuthority'` (met when `ctx.premises?.authority === true`; reason text "Not the resident or owner");
  `DialogueContext` gains optional `premises?: { readonly buildingId: number; readonly authority: boolean; readonly room: number }`.
  `consentChance` for the new kinds: entry `0.7 + 0.3·rapport − 0.2·stress` (−0.3 when the subject has incriminating
  items, −0.4 when the subject is the scenario suspect (`truth.suspect`)), premises `−0.2` more than entry, room = entry.
- `src/data/dialogue/utterances.json` (topic `consent`): `consentEntry` ("May I come in and talk with you?" / tones),
  `consentSearchPremises` ("Would you consent to a search of the residence?"), `consentSearchRoom` ("Do you mind if I
  look around this room?") — all `requires: ["premisesAuthority"]`; topic `questions`: `witnessSaw` ("Did you see or
  hear anything?", intent and fact as the existing account question). Responses use the existing `consent.*` keys.
- `src/contact/types.ts` `ContactDeps` gains optional `premises?(personId: number): { buildingId: number; authority: boolean;
  room: number } | null` (the integrator: authority when the person is a resident of the building the officer is in or
  at (records address = building address, or an ambient `resident`/`staff` actor of it); `room` = the officer's room).
  `ContactManager` passes it into the dialogue context and, whenever a dialogue result carries `consent`, emits
  `contact:consent { incident, callId, personId, kind, granted, valid, buildingId, room, sim }` (also for the Phase 3
  kinds; `buildingId`/`room` −1 when unknown).
- Contact distance checks use the subject's level: the talk prompt and an open contact require the same level
  (contact asks `npc.actor(...).building` vs the officer focus building; the integrator passes the officer's level
  through `officerPosition(out)` which gains an optional `building` field).
- `contact.open` works for actors whose person is `jailed` (interview room).

### 8.3 Events and tests
Events: `npc:aware` (`src/npc/events.ts`), `contact:consent` (`src/contact/events.ts`).
Tests (`test/npc/**`, `test/dialogue/**`, `test/contact/**`): an indoor actor spawned with `building` publishes
y = −40; `nearestPerson` ignores other levels; flee indoors follows the stub nav exit route then steps outdoors and
continues with the Phase 3 flee; follow indoors uses `nav.path`; `transferFollowers` moves an escorted prisoner;
stimulation thresholds emit `npc:aware` once per level crossing; `onAware` reactions per profile with a seeded rng
(hide → hidden at the stub hide spot, flee → fleeing, surrender → hands up); awareness decays; no-go zone keeps
pedestrians out of a square polygon over 2 000 steps and ambient actors inside leave; v5 `NpcSave` restores; consent
kinds `entry`/`searchPremises`/`searchRoom` gated by `premisesAuthority`, `contact:consent` emitted with the room; the
whole Phase 3 suites stay green.

## 9. Evidence rules and case data [evidence] (`src/evidence/**`, `src/data/evidence/**`) — pure

### 9.1 Chain-of-custody ledger (`src/evidence/ledger.ts`) — mandatory tests
```ts
export const CUSTODY_ACTIONS = ['collect', 'bag', 'tag', 'transfer', 'deposit'] as const;
export type CustodyAction = (typeof CUSTODY_ACTIONS)[number];
export interface CustodyEntry {
  readonly seq: number;            // 1, 2, 3 … across the whole ledger
  readonly itemId: string;         // 'E-<callId>-<n>'
  readonly action: CustodyAction;
  readonly from: string;           // 'scene' for collect; a custodian id otherwise
  readonly to: string;             // custodian id: 'officer:<badge>', 'locker:<car index>', 'evidenceRoom'
  readonly sim: number; readonly game: number;
  readonly location: string;       // free text ('1420 Oak St · Kitchen')
  readonly note: string;           // bag/tag label, transfer reason
  readonly prevHash: string;       // previous entry's hash, '00000000' for seq 1
  readonly hash: string;           // 8 lowercase hex chars
}
export type ItemCustodyState = 'none' | 'collected' | 'bagged' | 'tagged' | 'deposited';
/** FNV-1a (core/rng hashString) of `${seq}|${itemId}|${action}|${from}|${to}|${sim.toFixed(3)}|${game.toFixed(3)}|${location}|${note}|${prevHash}`, hex padded to 8. */
export function entryHash(e: Omit<CustodyEntry, 'hash'>): string;
export type AppendResult = { ok: true; entry: CustodyEntry } | { ok: false; reason: string };
export class CustodyLedger {
  constructor(entries?: readonly CustodyEntry[]);           // trusts the input (use verifyLedger to check)
  /** Validates the transition (state machine below), fills seq / prevHash / hash, appends. */
  append(e: { itemId: string; action: CustodyAction; from: string; to: string; sim: number; game: number; location: string; note: string }): AppendResult;
  entries(): readonly CustodyEntry[];
  itemEntries(itemId: string): readonly CustodyEntry[];
  state(itemId: string): ItemCustodyState;
  custodian(itemId: string): string;                         // '' before collect
  /** Item complete: collect, bag, tag, … deposit present in order. */
  complete(itemId: string): boolean;
  serialize(): CustodyEntry[];
}
export interface LedgerIssue { seq: number; itemId: string; kind: 'hash' | 'chain' | 'gap' | 'order' | 'custodian' | 'time' | 'duplicate'; text: string }
export function verifyLedger(entries: readonly CustodyEntry[]): { ok: boolean; issues: LedgerIssue[] };
```
State machine per item: `collect` (from must be `'scene'`, first entry of the item) → `bag` (from = to = current
custodian) → `tag` (same) → `transfer`* (from = current custodian, to ≠ from, not `'evidenceRoom'`) → `deposit` (from
= current custodian, to `'evidenceRoom'`); nothing after `deposit`; times non-decreasing over the whole ledger.
`verifyLedger` reports: `gap` (seq not previous + 1), `chain` (prevHash ≠ previous hash), `hash` (recomputed hash ≠
stored), `order` (illegal transition), `custodian` (from ≠ custodian), `time` (sim decreases), `duplicate` (a second
`collect`). Tests (mandatory): a full chain verifies ok; editing any field of a middle entry → `hash` at that entry
(and nothing else); deleting an entry → `gap` + `chain`; swapping two entries → `gap`/`chain`/`order`; illegal
`append`s are rejected with a reason (bag before collect, deposit twice, transfer from a non-custodian, collect from
a non-scene source); `complete` only after deposit; interleaved items keep independent states; serialize → new
ledger → verify ok.

### 9.2 Search rules (`src/evidence/searchRules.ts`) — mandatory tests
```ts
export const SEARCH_BASES = ['plainView', 'consent', 'warrant', 'incidentToArrest', 'exigency', 'protectiveSweep', 'publicArea'] as const;
export type SearchBasis = (typeof SEARCH_BASES)[number];
export interface ConsentRecord { readonly id: number; readonly personId: number;
  readonly kind: 'entry' | 'searchPremises' | 'searchRoom' | 'searchPerson' | 'searchVehicle' | 'pbt' | 'sfst';
  readonly granted: boolean; readonly valid: boolean; readonly authority: boolean;
  readonly buildingId: number; readonly room: number; readonly vehicleId: number; readonly sim: number; readonly revokedSim: number /* -1 */ }
export interface PresenceContext {
  readonly buildingId: number;            // -1 outdoors (always lawful)
  readonly room: number;
  readonly roomPublic: boolean; readonly businessOpen: boolean;
  readonly consents: readonly ConsentRecord[];
  readonly exigency: boolean;             // emergency aid, hot pursuit, in-progress crime, shots fired
  readonly warrant: boolean;
  readonly sim: number;
}
export function consentActive(c: ConsentRecord, sim: number): boolean;   // granted && valid && authority && (revokedSim < 0 || sim < revokedSim)
/** Officer lawfully present in that room: outdoors; public room of an open business ('publicArea'); warrant; exigency;
 *  an active consent of kind entry / searchPremises (same building) or searchRoom (same building and room). */
export function lawfulPresence(ctx: PresenceContext): { lawful: boolean; basis: SearchBasis | 'invited' | null };
export interface PlainViewInput { readonly presence: PresenceContext; readonly concealed: boolean; readonly visible: boolean /* LOS and lit */;
  readonly incriminating: boolean /* weapon, contraband or call evidence */ }
export function plainView(input: PlainViewInput): { plainView: boolean; reason: string };   // all four conditions
export interface SearchTarget { readonly kind: 'container' | 'room' | 'person' | 'vehicle'; readonly buildingId: number; readonly room: number;
  readonly container: Container; readonly hide: boolean /* a place a person could hide */; readonly personId: number; readonly vehicleId: number }
export interface SearchContext extends PresenceContext {
  readonly target: SearchTarget;
  /** Arrests made on this call: person, building, room, sim. */
  readonly arrests: readonly { personId: number; buildingId: number; room: number; sim: number }[];
}
/** First basis that allows the search, in order: warrant, consent (scope), incidentToArrest (same building and room,
 *  within 600 s of the arrest, containers and the room — not other rooms), protectiveSweep (exigency or an arrest
 *  on the premises: only `hide` places and rooms, never closed containers), exigency (rooms only), publicArea
 *  (open containers of the public room only: container 'none'); else not allowed with a reason. */
export function searchAuthority(ctx: SearchContext): { allowed: boolean; basis: SearchBasis | null; reason: string };
/** Evidence is admissible when found with a basis (or plain view). */
export function admissible(found: { basis: SearchBasis | null }): boolean;
```
Consent scope: `searchPremises` covers every room of that building (not another building); `searchRoom` only that
room; `entry` gives presence only (no search of containers; plain view still applies); `searchPerson`/`searchVehicle`
only the person / vehicle. Tests (mandatory): plain view requires lawful presence, visibility, not concealed and
incriminating (each condition alone fails); room-scope consent allows a drawer in that room but not in the next
room; premises consent allows any room of its building only; consent without authority or not granted or revoked
(after revokedSim) does nothing; entry consent: presence yes, drawer search no; public room of an open store is
lawful presence, a closed store is not, the back office never; exigency allows rooms but not drawers; protective
sweep allows a closet (`hide`) but not a drawer; incident to arrest allows the arrest room within 600 s, not after,
not the next room; warrant allows everything; admissible.

### 9.3 Case file store (`src/evidence/caseFile.ts`)
```ts
export interface EvidenceItem { id: string; callId: number; item: string /* people item id or 'latentPrint' */; label: string;
  x: number; y: number; z: number; buildingId: number; room: number; furniture: number; container: Container; concealed: boolean;
  ownerPersonId: number; state: 'inPlace' | 'found' | 'collected'; plainView: boolean; foundBasis: SearchBasis | null;
  suppressed: boolean; markerNo: number; k9Alert: boolean; incriminating: boolean }
export interface MarkerRecord { no: number; callId: number; x: number; y: number; z: number; buildingId: number; itemId: string | null; sim: number }
export interface PhotoRecord { id: string; callId: number; sim: number; game: number; x: number; y: number; z: number; yaw: number; pitch: number;
  buildingId: number; room: number; subjects: { kind: 'marker' | 'item' | 'person'; ref: string }[]; caption: string; thumb: string | null }
export interface PrintRecord { id: string; callId: number; buildingId: number; furniture: number; quality: number; personId: number; itemId: string | null; sim: number }
export interface CanvassRecord { callId: number; buildingId: number; sim: number; result: 'noAnswer' | 'nothingSeen' | 'sawSomething' | 'refused'; personId: number; text: string }
export interface StatementRecord { personId: number; role: string; text: string; sim: number }
export interface CaseFile { callId: number; incident: string; title: string; items: EvidenceItem[]; markers: MarkerRecord[]; photos: PhotoRecord[];
  prints: PrintRecord[]; canvass: CanvassRecord[]; consents: ConsentRecord[]; statements: StatementRecord[];
  k9: { sim: number; text: string }[]; bodycam: { start: number; end: number }[]; nextItem: number; nextMarker: number; nextPhoto: number; closed: boolean }
export class CaseStore {
  file(callId: number, incident?: string, title?: string): CaseFile;    // creates on demand
  get(callId: number): CaseFile | null; files(): readonly CaseFile[];
  item(itemId: string): EvidenceItem | null;
  addItem(callId: number, spec: Omit<EvidenceItem, 'id' | 'callId' | 'state' | 'plainView' | 'foundBasis' | 'suppressed' | 'markerNo' | 'k9Alert'>): EvidenceItem;
  /** Limits: 64 files (oldest closed dropped first), 40 items, 99 markers, 48 photos per file; thumbnails kept for the 32 newest photos overall. */
  serialize(): CaseFile[]; static restore(files: readonly CaseFile[]): CaseStore;
}
export function isCaseFile(x: unknown): x is CaseFile;
```
### 9.4 Fingerprint dusting (`src/evidence/fingerprint.ts`)
```ts
export interface DustState { surface: PrintSurface; hasPrint: boolean; personId: number; base: number /* 0..1 */; coverage: number[] /* 16 cells 0..1.5 */;
  cursor: number /* 0..15 */; overbrush: number; lifted: boolean }
export const SURFACE_QUALITY: Readonly<Record<PrintSurface, number>>;   // glass 0.9, metal 0.8, stone 0.6, wood 0.55, fabric 0.1
export function startDust(surface: PrintSurface, hasPrint: boolean, personId: number, u: number): DustState;  // base = SURFACE_QUALITY · (0.6 + 0.4u)
export function moveCursor(s: DustState, dir: 'up' | 'down' | 'left' | 'right'): void;   // 4×4 grid, clamped
export function brush(s: DustState, dt: number): void;   // coverage[cursor] += 2·dt; above 1.0 adds to overbrush
/** quality = base · mean(min(1, coverage)) − 0.15 · overbrush (clamped 0..1); usable when hasPrint && quality ≥ 0.35. */
export function lift(s: DustState): { quality: number; usable: boolean; personId: number };
```
### 9.5 Canvass and K9 helpers
```ts
// src/evidence/canvass.ts
export function canvassResult(seed: number, callId: number, buildingId: number, hour: number, sawChance: number):
  { answered: boolean; result: CanvassRecord['result']; residentIndex: number };
// u1 = unitHash(seed, 0x6a11, callId * 4099 + buildingId), u2 = unitHash(seed, 0x6a12, …), answered = u1 < (hour in 8..21 ? 0.75 : 0.35);
// result = !answered ? 'noAnswer' : u2 < 0.1 ? 'refused' : u2 < 0.1 + sawChance ? 'sawSomething' : 'nothingSeen'; residentIndex = floor(u3 · 3)
// src/evidence/k9.ts
export interface K9Target { kind: 'person' | 'item'; ref: string; room: number; x: number; z: number; scent: 'person' | 'narcotics' | 'firearm' | 'other' }
export interface K9Alert { ref: string; kind: 'person' | 'item'; room: number; x: number; z: number; atS: number }
/** Visits rooms in `order` (12 s each, first after 4 s); each target alerts with probability by scent (person 0.95,
 *  narcotics 0.9, firearm 0.6, other 0.2) using u(i) (a deterministic 0..1 per target index). */
export function k9Sweep(order: readonly number[], targets: readonly K9Target[], u: (i: number) => number): K9Alert[];
```
`src/data/evidence/evidence.json`: `{ "version": 1, "sawChance": { "default": 0.25, "domestic": 0.4, "property": 0.3, "inProgress": 0.35 },
"canvassTexts": { "noAnswer": "No answer at {address}.", "nothingSeen": "Resident at {address} saw nothing.", "refused": "Resident at
{address} declined to talk.", "sawSomething": "Resident at {address} saw {description} heading {direction}." }, "labels": { "latentPrint":
"Latent print" } }`.
Tests: dusting quality model (coverage, overbrush penalty, no print never usable); canvass determinism and
answer-rate by hour; k9 order/timing and odds over many seeds; case store limits and round trip.

Evidence is wave 1 and imports no other Phase 4 module: `src/evidence/types.ts` re-declares `Container =
'none' | 'drawer' | 'cabinet' | 'closet' | 'safe'` and `PrintSurface = 'glass' | 'metal' | 'stone' | 'wood' | 'fabric'`
(identical to interiorgen's).

## 10. Investigation runtime [investigation] (`src/investigation/**`, `src/ui/investigation/**`)

### 10.1 API (`src/investigation/investigationSystem.ts`, `src/investigation/types.ts`)
```ts
export interface InvestigationOfficer { x: number; y: number /* feet */; z: number; yaw: number; pitch: number; building: number;
  room: number; onFoot: boolean; badge: string; flashlight: boolean }
export interface CallContext { exigency: boolean; warrant: boolean; arrests: readonly { personId: number; buildingId: number; room: number; sim: number }[];
  buildingId: number /* the call's bound building, -1 */; family: string; suspectPersonId: number; anchorX: number; anchorZ: number }
/** Implemented by the integrator over SceneDirector / CAD / npc / records. */
export interface InvestigationPorts {
  callContext(callId: number): CallContext | null;
  /** The player's current call (assigned and materialized, nearest), 0 when none. */
  currentCall(): number;
  incidentOf(callId: number): string;                         // 'C-00042'
  /** Canvass: spawns the resident at the building's door (role 'witness' when sawSomething, else 'resident'); actor id or 0. */
  spawnResident(buildingId: number, personId: number, callId: number, role: 'witness' | 'resident'): number;
  residentOf(buildingId: number, index: number): number;      // person id (§6.3 resident rule)
  /** Hidden actors of a building for the K9 sweep. */
  hiddenActors(buildingId: number, out: { actorId: number; x: number; z: number }[]): number;
  setNoGoZones(zones: readonly NoGoZone[]): void;
  kit(): { carried(item: string): number; use(item: string, n: number): boolean; give(item: string, n: number): boolean };
  bodycamWorn(): boolean;
  nightFactor(): number;
  /** Line of sight on the officer's level using the live door states (integrator: interiorgen lineOfSight + interiors). */
  lineOfSight(building: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, ignoreFurniture: number): boolean;
  roomLit(building: number, room: number): boolean;
  businessOpen(building: number): boolean;
  layout(building: number): InteriorLayout | null;
  addressOf(building: number): string;
  describeDirection(fromX: number, fromZ: number, toX: number, toZ: number): string;   // 'north on Elm St'
  describePerson(personId: number): string;
}
export interface PlaceItemSpec { callId: number; item: string; label: string; x: number; y: number; z: number; buildingId: number; room: number;
  furniture: number; container: Container; concealed: boolean; ownerPersonId: number; incriminating: boolean }
export type InvestigationRequest =
  | { readonly kind: 'marker' }                                         // next tent at the aim point (2 m ahead on the floor), links an item within 1 m
  | { readonly kind: 'removeMarker'; readonly no: number }
  | { readonly kind: 'photo'; readonly fovDeg: number }
  | { readonly kind: 'collect'; readonly itemId: string }
  | { readonly kind: 'bag'; readonly itemId: string } | { readonly kind: 'tag'; readonly itemId: string }
  | { readonly kind: 'transfer'; readonly itemId: string; readonly to: string }
  | { readonly kind: 'deposit' }                                        // every tagged item the officer holds → evidenceRoom
  | { readonly kind: 'search'; readonly buildingId: number; readonly furniture: number; readonly force: boolean }
  | { readonly kind: 'dustStart'; readonly buildingId: number; readonly furniture: number }
  | { readonly kind: 'dustMove'; readonly dir: 'up' | 'down' | 'left' | 'right' } | { readonly kind: 'dustBrush'; readonly seconds: number }
  | { readonly kind: 'dustLift' } | { readonly kind: 'dustCancel' }
  | { readonly kind: 'tapePost' } | { readonly kind: 'tapeClose' } | { readonly kind: 'tapeClear' }
  | { readonly kind: 'bodycam'; readonly on: boolean }
  | { readonly kind: 'canvass'; readonly buildingId: number };
export class InvestigationSystem {
  constructor(deps: { seed: number; bus: EventBus<EventMap>; rng: Rng /* 'investigation' */; ports: InvestigationPorts; officer(out: InvestigationOfficer): InvestigationOfficer });
  step(dt: number, t: { sim: number; game: number }): void;              // order -675
  request(r: InvestigationRequest): void;
  /** EvidencePort for the scene (synchronous, inside its fixed step). Returns the item id. */
  placeItem(spec: PlaceItemSpec): string;
  removeCallItems(callId: number): void;                                  // in-place items of a dropped scenario
  /** Bridged by the integrator from `contact:consent`. */
  recordConsent(c: Omit<ConsentRecord, 'id'> & { callId: number }): void;
  /** Bridged from `contact:event` flag 'statement' (statements of the call's people). */
  recordStatement(callId: number, s: StatementRecord): void;
  /** K9 arrived on a call (bridged from `scene:service { kind: 'k9', phase: 'arrived' }`). */
  startK9(callId: number): void;
  /** An arrest on a call (bridged from `contact:event` flag 'custody'): feeds incidentToArrest. */
  recordArrest(callId: number, personId: number, buildingId: number, room: number, sim: number): void;
  readonly store: CaseStore; readonly ledger: CustodyLedger;
  readonly props: PropSource;              // markers (PROP.marker), in-place items (PROP by item kind, else 'bag'), tape posts/segments (PROP.tape)
  readonly dog: HumanoidSource;            // K9 dog + handler (2 figures) while a sweep runs
  readonly bodycamOn: boolean;
  readonly dust: DustView | null;          // FingerprintPanel model
  readonly revision: number;
  /** A shutter press waiting for its thumbnail (presentation captures the canvas after the next render). */
  pendingThumbnail(): string | null;       // photo id
  attachThumbnail(photoId: string, dataUrl: string | null): void;   // presentation only, not part of the replay
  nearestItem(x: number, z: number, building: number, maxDist: number): EvidenceItem | null;   // found items first
  /** Furniture with a container or printable surface within 1.5 m ahead, -1 none. */
  nearestFurniture(x: number, z: number, yaw: number, building: number, want: 'container' | 'surface'): number;
  toolsModel(): ActionPanelModel; toolsSelect(index: number): ToolAction;   // §10.4
  caseView(callId: number): CaseFileView | null;
  hud(): string | null;                    // 'C-00042 · items 3/5 · markers 2 · photos 4 · REC'
  summary(callId: number): CaseSummary;    // for CallOutcome.case (§12.2)
  serialize(): InvestigationSave; restore(s: InvestigationSave): void; dispose(): void;
}
export interface CaseSummary { items: number; found: number; plainView: number; suppressed: number; collected: number; custodyComplete: boolean;
  photos: number; markers: number; prints: number; canvass: number; consents: number; bodycam: boolean }
export type ToolAction = { kind: 'request'; request: InvestigationRequest } | { kind: 'camera' } | { kind: 'caseFile' } | { kind: 'k9' } | { kind: 'none' };
```
### 10.2 Behaviour (all in `step`, from queued requests; flash texts via `investigation:flash`)
- **Markers**: needs `kit().use('evidenceMarkers', 1)`; position = officer + forward·2 m, y = officer feet y; snaps to an
  uncollected, found item within 1 m (links `itemId`, sets `item.markerNo`); numbers 1, 2, 3 … per case file (the
  current call, else call 0 "Field case"). `removeMarker` gives the tent back (`kit().give`). Event `investigation:marker`.
- **Photos**: needs `camera` carried. Subjects: markers and found items within 15 m inside the horizontal FOV
  (`fovDeg`, default 60) with `lineOfSight` (people are not subjects in Phase 4); caption "Marker 3 — Knife (Kitchen)"
  (nearest subject to the view centre) or "Overview — <room label>"; `PhotoRecord` stored; `pendingThumbnail()` returns its id until `attachThumbnail`;
  event `investigation:photo { callId, photoId, subjects }`.
- **Plain view scan** every 0.5 s: for in-place items of every file within 10 m on the officer's level: `visible` =
  `lineOfSight(eye → item, ignore its furniture)` and lit (room lit, or flashlight on within 8 m and within 0.5 rad of
  the officer's yaw; outdoors: day (night < 0.5) or flashlight); `plainView({ presence, concealed, visible,
  incriminating })` → state `found`, `plainView: true`, `foundBasis: 'plainView'`, event `investigation:plainView
  { callId, itemId, label }`, flash "Plain view: <label> (<room>)". Presence context from `callContext` (exigency,
  warrant), consents of the file, room public / business open.
- **Search** (container furniture within 1.5 m): `searchAuthority`; allowed → every concealed in-place item of that
  furniture becomes `found` with the basis; not allowed and `force` false → flash the reason; `force` true → found with
  `foundBasis: null, suppressed: true`. Event `investigation:found { callId, itemId, basis, suppressed }`. The tools
  panel offers "Search <furniture> (consent: room)" or "Search anyway (no lawful basis)".
- **Custody**: `collect` (found item within 1.5 m; ledger collect from 'scene' to `officer:<badge>`; state collected;
  prop removed) → `bag` (needs `kit().use('evidenceBags', 1)`) → `tag` (note `"<incident> item <n>: <label>"`) →
  `transfer` (to `'locker:<n>'` or another custodian) → `deposit` (officer at the station's evidence point, integrator
  checks; deposits every tagged item held by the officer). Rejections flash the ledger reason. Events
  `investigation:custody { callId, itemId, action }`, `investigation:collected` (on collect), `investigation:custodyComplete`
  (on deposit).
- **Dusting**: needs `fingerprintKit`; a printable furniture within 1.5 m. Print present when `unitHash(seed, 0x9f31,
  callId * 4099 + buildingId * 64 + furniture) < (call suspect touched it: furniture in the call's building and its
  room is one of the suspect's rooms → 0.6, else 0.15)`; the person = the call's suspect (`callContext.suspectPersonId`),
  else a resident (`residentOf(building, 0)`). `startDust(surface, hasPrint, personId, u)`; moves/brush/lift requests;
  a usable lift adds a `PrintRecord` and an evidence item `latentPrint` (state `found`, basis = the presence basis).
- **Tape** (outdoors only, needs `sceneTape`): `tapePost` adds the officer position (≤ 16 posts); `tapeClose` (≥ 3) closes
  the polygon → `setNoGoZones(all closed tapes)`, event `investigation:tape { callId, closed: true, points }`;
  `tapeClear` removes the current tape. Props: a `tape` prop per post facing the next post plus one every 3 m along
  each segment.
- **Bodycam**: `bodycam { on }` needs `bodycamWorn()`; segments `{ start, end }` added to the current file (and to the
  file of any call that becomes current while recording); auto-on (when worn) on `force:used` kinds `sidearmDrawn` /
  `taserDrawn`; event `investigation:bodycam { on }`.
- **Canvass**: officer within 1.8 m of another building's exterior door (integrator resolves the building) and a
  current call within 150 m: `canvassResult` with the family's `sawChance`; answered → `spawnResident(...)` at the door;
  text from `evidence.json` (sawSomething: `describePerson(suspect)` + `describeDirection(anchor → building)`); the same
  building twice for a call → flash "Already canvassed"; event `investigation:canvass { callId, buildingId, result, personId }`.
- **K9** (`startK9`): the dog and handler appear at the building's main door exit (or the officer's position outdoors),
  walk the rooms in BFS order from the entry (12 s per room, nav straight lines between room centres); alerts from
  `k9Sweep` (targets: `hiddenActors` (person) and in-place concealed items: narcotics/pills/cannabis → narcotics,
  handgun/shellCasing → firearm, others → other); each alert at its time: item `k9Alert = true` + case note; person →
  event `investigation:k9Alert { callId, kind, actorId, itemId, room, text }` (the scene reveals the actor); radio line
  via `investigation:radio { text: 'K9 has an indication in the <room>.' }`. Outdoors the sweep covers the anchor's
  surroundings with the hidden actors of the call's building only.
- **Statements / consents**: appended to the file as bridged.

### 10.3 Save
`InvestigationSave { version: 1; rng: RngState; files: CaseFile[]; ledger: CustodyEntry[]; tapes: { callId: number; points: number[];
closed: boolean }[]; activeTape: number; bodycam: boolean; held: string[] /* item ids held by the officer */; dust: (DustState & { callId: number;
buildingId: number; furniture: number }) | null; k9: { callId: number; startedSim: number; alerts: K9Alert[]; fired: number; order: number[] } | null;
scanTimer: number; arrests: [number, number, number, number, number][]; queue: InvestigationRequest[] }`, `isInvestigationSave`,
`emptyInvestigationSave(rng)`. Thumbnails ride in `files[].photos[].thumb` (null in node; presentation-only, excluded
from replay comparisons by being null there).

### 10.4 UI (`src/ui/investigation/**`, CSS prefix `inv-`)
- **Tools panel** = the Phase 2 `ActionPanel` with `toolsModel()`: Place marker · Photograph (camera mode) · Collect
  <nearest item> · Bag / Tag <held item> · Search <container> · Dust <surface> · Tape: add post / close / clear ·
  Knock (canvass) · Request K9 (scene action) · Bodycam on/off · Case file. Disabled rows say why ("No evidence bags").
- `CameraOverlay` (`Menu`, non-pausing, `inv-camera`): viewfinder frame, FOV readout, case and room, last caption;
  `onKeyDown`: Space / Enter / mouse (the app maps `officer.fire`) → shutter callback, Escape → close.
- `CaseFilePanel` (`Menu`, non-pausing): tabs Items · Photos · Prints · Canvass · Custody · Consents · Statements;
  pure `reduceCaseKey(state, view, key)` (Tab next tab, ↑/↓ select, Enter = next custody step for the selected item,
  Escape close) and `CaseFileView` (rows of text + per-item status "Found (plain view) · Bagged · Tagged · Deposited ·
  SUPPRESSED"); photos show the thumbnail `<img>` when present. Ledger verdict line ("Chain intact" / issues).
- `FingerprintPanel` (`Menu`, non-pausing): 4×4 grid coloured by coverage, cursor, quality bar; arrows / WASD move,
  Space brush (held: the app sends `dustBrush` with the frame time while held), Enter lift, Escape cancel.
- `MarkerLabels`: absolutely positioned number labels; `update(labels: readonly { x: number; y: number; text: string }[])`
  (screen pixels; the app projects marker positions within 8 m at 10 Hz).
Tests (`test/investigation/**`, `test/investigationui/**`): with a generated house layout and stub ports: marker
numbering and kit use; plain view found only when lawful, lit and in LOS (dark room + flashlight works); search with
room consent finds a drawer item in that room only, force marks it suppressed; collect → bag → tag → deposit verifies
in the ledger, illegal order rejected; dusting lift creates a latent print item; tape closes into a no-go zone; canvass
deterministic and once per building; K9 alerts at their times and emits person alerts; bodycam needs the mount;
`summary`; save → restore → identical continuation; UI reducers and headless construction.

## 11. Police station and shift flow [station] (`src/station/**`, `src/data/station/**`, `src/ui/station/**`, `src/ui/hud/**`, `src/input/actions.ts`, `src/input/bindings.ts`)

### 11.1 Pure state (`src/station/*.ts`)
```ts
export const SHIFT_STEPS = ['locker', 'briefing', 'armory', 'garage', 'onPatrol'] as const;
export type ShiftStep = (typeof SHIFT_STEPS)[number];
export class ShiftFlow {
  readonly step: ShiftStep;
  /** Marks `step` done; advances when it is the current step or a later one (skipping is allowed, logged). */
  complete(step: ShiftStep, sim: number): boolean;
  objective(): string | null;   // 'Shift: choose your gear at the locker (E)', … null when onPatrol
  readonly log: readonly [ShiftStep, number][];
}
export interface ArmoryItemDef { id: string; label: string; serialPrefix: string; weapon: 'sidearm' | 'taser' | null }
export interface ArmoryEntry { seq: number; item: string; serial: string; action: 'out' | 'in'; officer: string; sim: number; game: number }
export class ArmoryLog {
  constructor(seed: number);
  signOut(item: string, officer: string, sim: number, game: number): ArmoryEntry | null;   // null when already out / unknown
  signIn(item: string, officer: string, sim: number, game: number): ArmoryEntry | null;
  has(item: string): boolean; out(): readonly string[]; entries(): readonly ArmoryEntry[];
  serial(item: string): string;  // `${prefix}-${1000 + hash3(seed, 0x7a11, index) % 9000}`
}
export const LOADOUT_FIELDS = ['uniform', 'vest', 'bodycamMount', 'radioAudio', 'flashlight'] as const;
export interface Loadout { uniform: string; vest: boolean; bodycamMount: 'chest' | 'shoulder' | 'none'; radioAudio: 'speaker' | 'earpiece';
  flashlight: 'handheld' | 'mounted' }
export function defaultLoadout(): Loadout;          // first uniform, vest true, chest, speaker, handheld
export function cycleLoadout(l: Loadout, field: (typeof LOADOUT_FIELDS)[number]): Loadout;
export function uniformColors(l: Loadout): { top: number; bottom: number };
export class HoldingCells {
  constructor(cellCount: number);
  place(personId: number, sim: number): number;     // cell index or -1 (full / already held)
  remove(personId: number): boolean; cellOf(personId: number): number; occupants(): readonly { cell: number; personId: number; since: number }[];
}
export interface BriefingInput { seed: number; gameSeconds: number; officer: { name: string; badge: string }; unit: { callsign: string; beat: string };
  district: string; bolos: readonly Bolo[]; openCalls: readonly { number: string; label: string; priority: number; location: string }[];
  roster: readonly { callsign: string; beat: string; status: string }[]; crime: readonly { category: string; weight: number }[] }
export interface BriefingView { title: string; date: string; assignment: string; sections: { heading: string; lines: string[] }[] }
export function buildBriefing(input: BriefingInput): BriefingView;   // sections: Assignment, BOLOs (≤ 6), District notes (data), Crime trends (top 3), Open calls (≤ 5), Units on duty
export type StationRequest =
  | { readonly kind: 'complete'; readonly step: ShiftStep }
  | { readonly kind: 'armory'; readonly item: string; readonly action: 'out' | 'in' }
  | { readonly kind: 'loadout'; readonly field: (typeof LOADOUT_FIELDS)[number] }
  | { readonly kind: 'hold'; readonly personId: number } | { readonly kind: 'release'; readonly personId: number }
  | { readonly kind: 'interview'; readonly personId: number | null };
export class StationState {
  constructor(seed: number, officer: () => { name: string; badge: string }, bus: EventBus<EventMap>, cellCount?: number /* 3 */);
  readonly flow: ShiftFlow; readonly armory: ArmoryLog; readonly loadout: Readonly<Loadout>; readonly holding: HoldingCells;
  readonly interviewing: number;                                   // person id, -1
  request(r: StationRequest): void;
  step(dt: number, t: { sim: number; game: number }): void;        // order -670: applies requests, emits station:* events
  lockerModel(): ActionPanelModel; lockerSelect(index: number): void;   // rows: Uniform · Vest · Bodycam mount · Radio audio · Flashlight · Done
  armoryModel(): ActionPanelModel; armorySelect(index: number): void;   // rows per item 'Sign out Duty pistol (SA-1042)' / 'Return …' · Done
  interviewModel(names: (personId: number) => string): ActionPanelModel; interviewSelect(index: number): void;
  weaponsAvailable(): { sidearm: boolean; taser: boolean };
  serialize(): StationSave; restore(s: StationSave): void;
}
export interface StationSave { version: 1; flow: ShiftStep; flowLog: [ShiftStep, number][]; armory: ArmoryEntry[]; loadout: Loadout;
  holding: [number, number, number][] /* cell, personId, since */; interviewing: number; queue: StationRequest[] }
export function isStationSave(x: unknown): x is StationSave;
export function newShiftStationSave(): StationSave;          // flow 'locker', nothing signed out, default loadout
export function migratedStationSave(badge: string): StationSave;   // flow 'onPatrol', sidearm + taser out at sim 0
/** Static staff figures from a station / jail layout's points (station is wave 1: it takes plain points, the integrator
 *  passes `layout.points`): desk sergeant (frontDesk), briefing sergeant (briefing), armorer (armory), evidence technician
 *  (evidence), booking officer (booking), each 1.2 m behind its point facing it; uniform colours, pose stand, y = floorY.
 *  Returns the figure count written into `out` (`createHumanoidSource` from `src/render/people/pose.ts`). */
export function stationStaff(points: readonly { kind: string; x: number; z: number; yaw: number }[], floorY: number,
  out: HumanoidSource & { count: number }): number;
```
Events (`src/station/events.ts`): `station:step { step }` (flow advanced), `station:armory { entry }`,
`station:loadout { loadout }`, `station:holding { personId, cell, placed }`, `station:interview { personId }`.
Data: `src/data/station/armory.json` (the six items, labels generic: "Duty pistol", "Conducted energy device",
"OC spray", "Expandable baton", "Less-lethal shotgun", "Patrol rifle"), `locker.json` (uniform options `{ id, label, top,
bottom }`: "Long sleeve", "Short sleeve", "Jacket", "Rain gear" with generic navy / charcoal / tan colours), `briefing.json`
(per district 3-5 note templates, e.g. downtown "Bars close at 02:00; expect disturbances on {street}.", plus generic
safety reminders). The armory step completes when the sidearm is signed out; the locker step on "Done".

### 11.2 Station UI (`src/ui/station/**`)
`BriefingScreen implements Menu` (`pausesGame: true`, prefix `brf-`): `open(view: BriefingView, onClose: () => void)`;
paper-like sheet with the sections, Enter / Escape / click closes (the integrator then completes `briefing`).
Headless-safe. Locker, armory and interview use the Phase 2 `ActionPanel` with the station models.

### 11.3 HUD and minimap (`src/ui/hud/**`)
`HudSnapshot` gains (all optional): `tactical?: { crouched: boolean; lean: -1 | 0 | 1; flashlight: boolean; noise: number; visibility: number;
slicing: boolean } | null` (chips CROUCH / LEAN L·R / LIGHT, a 5-step noise meter and a visibility eye),
`bodycam?: { recording: boolean } | null` (red "● REC" chip; grey "CAM" when worn and off), `shift?: string | null`
(objective line under the call strip), `location?: { building: string; room: string } | null` (chip "House · Kitchen"),
`caseLine?: string | null`. `hudText` (pure) covers them. `Minimap.setFloorPlan(plan: FloorPlan | null, officerX: number,
officerZ: number)` draws the room rectangles and doors (open green, closed grey) scaled to fit when indoors instead of
the city; `FloorPlan` is re-declared structurally in `src/ui/hud/types.ts`. `FadeOverlay` (`src/ui/hud/fade.ts`):
`constructor(parent: HTMLElement | null); set(level: number /* 0..1 */): void` (black full-screen div, opacity).
Tests extend `test/hud/**`.

### 11.4 Input actions (`src/input/actions.ts`, `src/input/bindings.ts`)
| Action | Kind | Keyboard / mouse | Gamepad | Use (on foot unless noted) |
|---|---|---|---|---|
| `officer.crouch` | button | KeyX | GamepadButton11 | toggle crouch |
| `officer.leanLeft` | button | KeyQ | - | hold: lean / peek left |
| `officer.leanRight` | button | KeyR | - | hold: lean / peek right |
| `officer.slice` | button | MouseButton2 | GamepadButton6 | hold near an open doorway: slice the pie |
| `officer.flashlight` | button | KeyF | GamepadButton12 | toggle flashlight |
| `officer.bodycam` | button | KeyU | - | bodycam on / off (also while driving) |
| `investigate.menu` | button | KeyI | - | investigation tools panel |
| `camera.photo` | button | KeyO | - | camera mode (shutter: left mouse / Space) |
| `partner.menu` | button | KeyN | - | partner commands (follow, stack, clear, hold, dismiss) |
Same-key reuse with driving actions is intended (X equipment, Q siren, R siren tone, F manual, RMB spot aim, pad 11
horn, pad 6 brake, pad 12 headlights: all only in a vehicle). Tests: labels, defaults, no duplicate ids.

## 12. Indoor scenes [scenes] (`src/scene/**`, `src/calls/**`, `src/data/calls/**`, `src/data/scene/**`)

### 12.1 Binding calls to buildings (`src/data/scene/indoor.json`, `src/scene/indoor.ts`)
```json
{ "version": 1,
  "families": {
    "domestic":      { "kinds": ["house", "apartment"], "rooms": { "suspect": ["living", "kitchen", "bedroom", "unitLiving"], "victim": ["living", "kitchen", "unitLiving"] },
                       "evidence": [ { "item": "bloodEvidence", "rooms": ["kitchen", "living", "unitLiving"], "chance": 0.4, "where": "floor" },
                                     { "item": "knife", "rooms": ["kitchen"], "chance": 0.3, "where": "container" } ], "doorLocked": 0.3 },
    "welfare":       { "kinds": ["house", "apartment"], "rooms": { "subject": ["bedroom", "living", "bathroom", "unitBedroom", "unitLiving"] }, "doorLocked": 0.7 },
    "property":      { "kinds": ["house", "apartment", "convenienceStore", "office"], "rooms": {},
                       "evidence": [ { "item": "brokenGlass", "rooms": ["living", "kitchen", "salesFloor", "lobby", "unitLiving"], "chance": 0.6, "where": "floor" },
                                     { "item": "burglaryTools", "rooms": ["bedroom", "office", "unitBedroom"], "chance": 0.3, "where": "surface" } ], "doorLocked": 0.0 },
    "inProgress":    { "kinds": ["house", "apartment", "convenienceStore", "warehouse", "office"], "rooms": { "suspect": ["bedroom", "office", "storage", "backOffice", "unitBedroom"] },
                       "evidence": [ { "item": "brokenGlass", "rooms": ["living", "salesFloor", "lobby", "floor"], "chance": 0.7, "where": "floor" } ], "doorLocked": 0.0 },
    "retail":        { "kinds": ["convenienceStore"], "rooms": { "guard": ["backOffice", "salesFloor"], "suspect": ["backOffice", "salesFloor"] },
                       "moveInside": ["guard", "suspect"],
                       "evidence": [ { "item": "stolenGoods", "rooms": ["backOffice", "salesFloor"], "chance": 0.9, "where": "surface" } ], "doorLocked": 0.0 },
    "barricade":     { "kinds": ["house", "apartment"], "rooms": { "subject": ["bedroom", "bathroom", "unitBedroom"], "hostage": ["bedroom", "unitBedroom"] }, "doorLocked": 1.0 },
    "investigation": { "kinds": ["house", "apartment"], "rooms": { "deceased": ["bedroom", "living", "bathroom", "unitBedroom", "unitLiving"] },
                       "evidence": [ { "item": "pills", "rooms": ["bathroom", "bedroom", "unitBath"], "chance": 0.3, "where": "container" } ], "doorLocked": 0.5 } },
  "types": {
    "schoolThreat": { "kinds": ["school"] }, "commercialBurglaryInProgress": { "kinds": ["convenienceStore", "warehouse", "office"] },
    "loudParty": { "kinds": ["house", "apartment"], "family": "disturbance" }, "squatters": { "kinds": ["house", "warehouse"], "family": "trespass" },
    "trespassVacantBuilding": { "kinds": ["warehouse"], "family": "trespass" }, "customerDispute": { "kinds": ["bar", "convenienceStore"], "family": "disturbance" } },
  "excludeTypes": ["vehicleBurglaryCold", "vehicleBreakInProgress", "slumpedInVehicle", "foundPersonConfused", "citizenAssist", "strandedMotorist", "gasDriveOff"] }
```
A call binds when its type is in `types`, or its family is in `families` and the type is not excluded and has no
`location` (`road` / `poi:*` types stay outdoors, except listed types). Building = `buildings.nearestEntrance(door spot of
the anchor, 60 m, kinds)` (fallback: any enterable kind of the same residential / commercial class within 60 m; none →
Phase 3 behaviour). Bound at scenario creation (also `adoptOpenCalls`), stored as `ScenarioRuntime.buildingId` (−1 none)
and saved (`SceneSave.scenarios[].buildingId?: number`). `scene:materialized` carries `buildingId`.
Required families (all indoor-capable types use real interiors): burglary (`property` burglaryCold, `inProgress`
burglaryInProgress), domestic, welfare check, barricade, death investigation (`investigation`), shoplifting (`retail`).

### 12.2 Materialization and runtime with a building
- Participants with spot `inside` (and roles in `moveInside`) → a spawn spot in the first preferred room present
  (`rooms[role]`, else any room except the entry), `building` = id, pose from the spot (deceased / unconscious → a
  `lying` spot, else `stand`/`sit`); `hidden` → a hiding spot (`npc.spawnActor({ hidden: true, building })`), the scene
  remembers the spot; `door` participants stay outdoors at the building's main door exit pose (not the road spot);
  other spots as Phase 3. Evidence: the family's Phase 3 `evidence` with spot `door` plus `indoor.json` `evidence`
  entries are placed via `EvidencePort.placeItem` (`where`: floor → a floor item spot, surface → a surface spot,
  container → a concealed spot; `incriminating` from the item def); outdoor ground evidence (unbound calls) also goes
  through `placeItem` (the scene's own ground-item props are removed in Phase 4).
- Door lock: at materialization the main door is set `locked` with `unitHash(seed, 0x51ce, callId) < doorLocked` (barricade
  1.0); `notHome` / `deceased` welfare branches always locked (`interiors.setDoorState`).
- **Knock**: the Phase 3 `knock` action and a real knock (`interior:door` action `knock` on the bound building's main door,
  bridged by the integrator into `scene.onDoorEvent`) set `knocked`; inside participants whose profile is not
  barricaded / deceased / unconscious / suspect (and the call is not `false`/`swatting`) walk to the door
  (`npc.setActorPosition(id, -1, exit pose)` after a delay of 4-10 s from the scene stream); a locked door is unlocked
  by the person who answers (`interiors.setDoorState(…, 'closed')`). No answer for welfare branches `notHome`/`deceased`.
- **Entry**: when the officer's level becomes the bound building: flag `entered`, plus `entry:<basis>` from
  `lawfulPresence` (consents of the call from `contact:consent`, exigency from `callContext`) or `entry:none`; forced
  doors (`interior:door` breached on the building) set `forcedEntry`.
- `callContext(callId)` (implements `InvestigationPorts.callContext` through the integrator): exigency = flags any of
  `shotsFired attacked fight medicalEmergency hostage injury:* deceased:* pursuit` or family ∈ {inProgress, barricade,
  activeAssailant} or (family welfare and `knocked` and no answer after 60 s); warrant = type `warrantService`; arrests
  from `custody:<role>` flags with the actor's building/room at that time; suspect = the scenario's `suspect` role person.
- Investigation events → flags: `investigation:photo` → `photographed`; `investigation:collected` → `evidenceCollected`;
  two `investigation:canvass` on the call → `canvassed`; `investigation:tape` closed with the anchor (or the building's
  door) inside the polygon → `perimeter` and `scenePreserved`; `investigation:plainView` → `plainView:<item>`;
  `investigation:custodyComplete` → `custodyComplete`; `investigation:k9Alert` person → `npc.reveal` + `k9Indicated`;
  `npc:aware` for a participant → `aware:<role>`. These are wired through `SceneDirector.onInvestigation(topic, payload)`
  and `onNpcAware(e)` methods the integrator calls from bus handlers (scenes does not import investigation; it declares
  the payload shapes structurally in `src/scene/types.ts`).
- **Tool actions**: `actions.json` gains optional `"tool": "camera" | "evidence" | "canvass" | "tape"` on `photograph`,
  `collectEvidence`, `canvass`, `perimeter`, `preserveScene` (the calls validator accepts it; producible flags keep using
  `sets`); the scene panel shows those rows disabled with detail "Use the camera (O)" / "Use the tools (I)" until their
  flags are set (then "Done"). Other actions unchanged.
- **K9**: for a bound call, the `k9` service arrival emits `scene:service { callId, kind: 'k9', phase: 'arrived' }` and
  skips its Phase 3 `revealHidden` effect (the investigation sweep reveals); unbound calls keep Phase 3.
  `scene:service` is emitted for every service request and arrival.
- **Levels**: `OfficerFocus.building?: number`; tackle, TASER, shout, `sceneAt`, `near:` / `found:` flags and the
  nearest-visible-actor scan only consider actors on the officer's level.
- **Weapons**: `SceneDeps.weaponsAvailable?(): { sidearm: boolean; taser: boolean }` (default both true): the weapon cycle
  skips weapons not signed out; with none → flash "No weapon signed out (armory)".
- `SceneDeps` gains optional `interiors?: SceneInteriorsPort` (`layout`, `building`, `officerBuilding`, `setDoorState`,
  `doorState`), `buildings?: BuildingIndex`, `evidence?: { placeItem(spec): string; removeCallItems(callId): void;
  summary(callId): CaseSummaryLike }`. Without them the scene behaves exactly as in Phase 3 (all Phase 3 tests stay green).
- `CallOutcome` gains optional `buildingId?: number; entry?: string | null; case?: CaseSummaryLike` (filled at close from
  `evidence.summary`).

### 12.3 Tests (`test/scene/**`, `test/calls/**`)
With `generateCity(42)`, a `BuildingIndex`, a real `InteriorSystem`-like stub (or the real one when importable — scenes
is wave 3 and may import `src/indoors`), npc with a stub nav port and a recording evidence port: a domestic call binds to
a house near its anchor and materializes the suspect inside with `building` set and y −40; the hidden burglar is in a
hiding spot; the deceased lies in a bedroom; retail participants are inside the store; evidence items are placed with
the right concealment; barricade door locked; knocking brings the victim to the door, not the barricaded subject;
`callContext` exigency cases; investigation events set the tool flags and the tool rows enable "Done"; a k9 arrival
on a bound call emits `scene:service` and does not reveal by itself; weapons gate; save/restore keeps `buildingId`;
outdoor calls unchanged (existing tests); the calls validator accepts `tool`; the §4.2 id lists are present in the
defining data (cross-check test).

## 13. UI structure

| Surface | Owner | Opens on | Pauses |
|---|---|---|---|
| Interact prompt (HUD line) | integrator (`hudFeed`) | always; Phase 4 hints below | – |
| Door panel (`ActionPanel`): Knock · Announce "Police!" · Open/Close · Kick · Ram (needs the ram) · Lock/Unlock · Knock (canvass) | integrator | E at a locked door, or held E (0.4 s) at any door | no |
| Locker / Armory / Interview panels (`ActionPanel`) | station models, integrator opens | E at the locker / armory / interview point | no |
| Briefing screen | station `BriefingScreen` | E at the roll-call podium | yes |
| Report room MDT | Phase 2 `MdtOverlay` | E at the report desk (or `Tab` within 2 m) | no |
| Partner panel (`ActionPanel`): Follow · Stack on door · Clear room · Hold · Dismiss/Summon | integrator | N | no |
| Investigation tools (`ActionPanel`) | investigation `toolsModel` | I | no |
| Camera mode (viewfinder) | investigation `CameraOverlay` | O (or the tools panel) | no |
| Case file | investigation `CaseFilePanel` | tools panel "Case file" | no |
| Fingerprint minigame | investigation `FingerprintPanel` | tools panel "Dust …" | no |
| Marker number labels | investigation `MarkerLabels` | markers within 8 m | – |
| Fade overlay | station `FadeOverlay` | `interiors.fade > 0` | – |
| HUD chips: stance, light, noise, visibility, REC, location, shift objective, case line; minimap floor plan | station HUD, integrator feed | – | – |

New interact hints (`InteractHint` in `src/game/session.ts`) and prompt texts: `enterBuilding` "E Enter <House>",
`exitBuilding` "E Exit", `door` "E Open door / Close door" (+ " · hold E: options"), `locked` "E Locked door: options",
`switch` "E Lights on/off", `locker` "E Locker", `briefing` "E Briefing", `armory` "E Armory", `evidence` "E Deposit
evidence", `reportDesk` "E Report desk (MDT)", `interview` "E Interview room", `cell` "E Holding cell", `collect` "E
Collect <item>", `knockCanvass` "E Knock (canvass)". Precedence on foot: cage > pump > enter vehicle > driver contact >
talk > collect > interior (exit/entrance/door/switch/point) > trunk.

## 14. ECS components and event topics

No new ECS component: interiors, partner, K9 and staff are not entities; the officer stays the Phase 0 kinematic
body (its `y` follows the level). `src/ecs/components.ts` is unchanged. Topics (declaration merging in each owner's
`events.ts`; `src/core/event-map.ts` header comment lists the Phase 4 owners):

| Topic | Owner file | Payload |
|---|---|---|
| `interior:resident` `interior:moveOfficer` `interior:transition` `interior:door` `interior:switch` `interior:flash` | `src/indoors/events.ts` | §6.8 |
| `tactical:sound` `tactical:stance` `tactical:flashlight` `tactical:partner` | `src/tactical/events.ts` | §7.6 |
| `npc:aware` | `src/npc/events.ts` | `{ actorId, personId, callId, level: 'alert' \| 'aware', reaction: string, cause: 'sound' \| 'sight' \| 'light' }` |
| `contact:consent` | `src/contact/events.ts` | `{ incident, callId, personId, kind, granted, valid, buildingId, room, sim }` |
| `investigation:marker` `:photo` `:plainView` `:found` `:collected` `:custody` `:custodyComplete` `:tape` `:canvass` `:k9Alert` `:bodycam` `:print` `:radio` `:flash` | `src/investigation/events.ts` | §10.2 (all carry `callId`) |
| `station:step` `station:armory` `station:loadout` `station:holding` `station:interview` | `src/station/events.ts` | §11.1 |
| `scene:service` (+ `scene:materialized.buildingId`) | `src/scene/events.ts` | `{ callId, kind, phase: 'requested' \| 'arrived' }` |

Cross-wave bridges (integrator bus handlers, synchronous inside the emitting fixed step): `interior:door` →
`tactical.request({ kind: 'sound', … })` and `scene.onDoorEvent`; `contact:consent` → `investigation.recordConsent`;
`contact:event` statement / custody → `investigation.recordStatement` / `recordArrest`; `scene:service` k9 arrived →
`investigation.startK9`; `investigation:*` → `scene.onInvestigation`; `investigation:k9Alert` person → (scene via
`onInvestigation`); `npc:aware` → `scene.onNpcAware`; `investigation:radio` and `tactical:partner` → radio / subtitles;
`interior:moveOfficer` → session officer placement + `npc.transferFollowers` + `tactical.teleportPartner`;
`cad:documentSaved` booking → `station.request({ kind: 'hold' })`.

## 15. Step order, frame order, determinism, workers

| Order | System | Work |
|---|---|---|
| (before) | session `fixedUpdate` | time, clock; officer velocity = `moveVelocity × tactical.speedFactor()` or `tactical.sliceMove`; body y held at `levelY(building) + 0.9` |
| -1000 | `copyPrevTransform` | |
| -900 | `environment` | |
| **-810** | **`interiors`** | requests, residency (≤ 1 load per step), fades → `interior:moveOfficer`, doors, switches, ambient occupants |
| -800 | `colliders` | unchanged (outdoor chunks by x/z) |
| -700 | `dispatch` | |
| -690 | `scene` | + indoor binding, levels, tool flags, door locks, knock answers |
| -680 | `contact` | + consents |
| **-675** | **`investigation`** | requests, plain-view scan (2 Hz), K9, dusting, tape zones |
| **-670** | **`station`** | requests (flow, armory, loadout, holding, interview) |
| -650 | `radio` | |
| **-640** | **`tactical`** | stance, footsteps, sound field, notice (4 Hz), partner |
| 40 / 50 / 60 / 100 / 110 | vehicles.pre / traffic / **npc** (+ indoor nav, awareness, no-go) / physics / vehicles.post | |

Per frame (`App.update`), after Phase 3: held tactical inputs (`setHeld(lean, slice)`), crouch / flashlight / bodycam /
partner / tools / camera keys → requests; first-person camera when `officerBuilding ≥ 0` or the on-foot camera toggle
(V) chose it (`rig.updateFirstPerson` with `tactical.eye`); `FlashlightRig.update`; `envRenderer.setIndoor`;
`InteriorRenderer.update` + `InteriorLightPool.update`; people sources (+ partner, staff, dog), merged props; fade
overlay; HUD (10 Hz) with tactical, bodycam, location, shift, case line, floor plan; marker labels (10 Hz); after
`renderer.render()`: when `investigation.pendingThumbnail()` is set, draw the WebGL canvas into a 160×90 2D canvas in
the **same task** (the drawing buffer is not preserved, so this must happen right after `render()` — MDN / WebGL
`preserveDrawingBuffer: false` semantics), `toDataURL('image/jpeg', 0.6)`, `attachThumbnail` (null when it fails).

Determinism: all Phase 4 simulation runs in fixed steps on named streams or pure hashes; layouts are pure functions
of (seed, building id); UI input becomes queued requests or per-frame held flags read in the fixed step; thumbnails are
the only presentation output stored in the save and they are null in node (the replay test compares saves without
them). `test/game/session.test.ts` gains a Phase 4 replay (§20 step 7).

**Workers:** none added. Interior layouts take ≤ 3 ms once per building and residency must happen in a known fixed
step (colliders), so the generator runs on the main thread inside the step; `src/interior`, `src/evidence` and the
station logic are DOM/THREE-free so a later phase can prefetch layouts in a worker (the result would be identical
because it is pure). The chunk worker and the Phase 0 sim worker are unchanged.

## 16. Save schema v6 (integrator only)

```ts
export interface SaveGameV6 extends SaveGameV5 {
  interiors: InteriorSave;          // officer level, door / light overrides, pending fade, ambient spawn ids
  tactical: TacticalSave;           // stance, flashlight, partner, timers, queued sounds
  investigation: InvestigationSave; // case files (items, markers, photos + thumbnails, prints, canvass, consents, statements, bodycam), ledger, tapes, K9, dusting
  station: StationSave;             // shift flow, armory log, loadout, holding cells, interview
}
// npc ActorSave gains optional building / aware / hideSpot; SceneSave scenarios gain optional buildingId; CallOutcome optional
// buildingId / entry / case. EquipmentSave trunks gain the six new items.
```
`CURRENT_SAVE_VERSION = 6`. `migrateV5ToV6(data)`: `interiors: emptyInteriorSave(stream('interior'))`, `tactical:
defaultTacticalSave(stream('tactical'))`, `investigation: emptyInvestigationSave(stream('investigation'))`, `station:
migratedStationSave(data.officer.badge)` (flow `onPatrol`, sidearm and taser signed out at sim 0, default loadout, empty
cells), every non-null `equipment[i].trunk` gets each new item of the `patrol` loadout that is missing (count from the
loadout). `stream(name)` = `createRng(data.seed).stream(name).state()`. Load order: environment → entities (officer body
at its saved y) → vehicles (+ equipment) → traffic → CAD → records → people → dispatcher → **interiors** (`restore`: the
officer's building resident) → npc → **tactical** → scenes (`restore`, `adoptOpenCalls`) → contacts → **investigation**
(then `setNoGoZones` from closed tapes) → **station** → radio → primeContacts. `isSaveGameV6` = v5 checks +
`isInteriorSave`, `isTacticalSave`, `isInvestigationSave`, `isStationSave`. Tests (`test/save`): v1..v5 → v6 migrate and
validate (the v5 fixture's trunks gain the new items, station `onPatrol` with two weapons out); v6 round trip; each
malformed new block rejected; a migrated v5 save loads outdoors with no interior resident except the nearest entrance.

## 17. Performance budget (60 FPS, mid-range desktop GPU, 1080p)

| Subsystem | Budget | Notes |
|---|---|---|
| Interior generation | ≤ 3 ms once per building (LRU 16 layouts) | pure; on residency only |
| Interior residency load | ≤ 3 ms once (≤ 400 cuboid colliders), ≤ 1 load per step | unload ≤ 1 ms |
| Interiors step | ≤ 0.02 ms/step avg | residency check every 15 steps; requests only |
| BuildingIndex | ≤ 0.2 ms per `nearestEntrance` (warm), ≤ 2 ms per new block | LRU 256 blocks |
| Tactical step | ≤ 0.05 ms/step avg; sound graph rebuild ≤ 0.3 ms per door change | Floyd-Warshall n ≤ 64 on door revision only; listeners ≤ 40 |
| Notice pass (4 Hz) | ≤ 0.2 ms per pass (≤ 20 listeners × 3 rays) | LOS = walls + furniture slab tests, no allocation |
| NPC indoor additions | ≤ +0.02 ms/step | nav paths on state change, ≤ 1 per actor per s |
| Investigation step | ≤ 0.02 ms/step; plain-view pass (2 Hz) ≤ 0.1 ms | ≤ 40 items in range |
| Station step | ≤ 0.005 ms | requests only |
| Interior renderer | ≤ 6 draw calls per visible interior, ≤ 0.1 ms/frame (door swings only) | buffers rebuilt on revision |
| Lights | 4 pooled point lights + 1 spot (fixed count) | intensities only per frame |
| People / props | + ≤ 3 figures (partner, dog, handler) + ≤ 5 staff; props merged (≤ 256) | same draw calls as Phase 3 |
| DOM panels | on revision ≤ 10 Hz; marker labels ≤ 10 Hz; HUD 10 Hz | 0 when closed |
| Thumbnail | ≤ 3 ms on the shutter frame (160×90 JPEG) | ≤ 32 kept |
| Draw calls total | target ≤ 200, cap 300 | the integrator hides the city chunk group while indoors; ≤ +16 |
| Per-frame allocations | none in hot loops | strings only on events / throttled UI |
| Save size | + ≤ 150 KiB worst case (thumbnails ≤ 32 × ~3 KiB) | overrides capped |

## 18. Requirement map

| Requirement | Code |
|---|---|
| Enterable houses, apartments, convenience stores, banks, bars, hospitals, schools, warehouses, offices, parking structures, jail/sally port, police station | `world/buildings.ts` (`BUILDING_KINDS`, `classifyBuilding`, jail pick), `data/interior/templates/*.json` (12 templates; jail and station with sally ports) |
| Modular interior generator, data-driven room templates per type | `interior/generate.ts` (bsp / corridor / suites), `interior/templates.ts`, `data/interior/**` |
| Furnished rooms (procedural box furniture) | generator step 8, `data/interior/furniture.json`, `render/interior/interiorRenderer.ts` |
| Doors open / lock / breach (kick, ram from trunk) | `indoors/interiorSystem.ts` door requests, `data/police/items.json` `ram`, door panel (integrator) |
| Hiding spots | generator `hidingSpots`, `IndoorNavPort.hideSpot`, scene `hidden` participants, npc `hide` reaction |
| Light switches, real pooled lights near the player | `InteriorRoom.switchAt`/`light`, `InteriorSystem` lights, `render/interior` `InteriorLightPool` |
| Per-room occupants (call scenes or ambient) | scene materialization in rooms (§12.2), `indoors/occupants.ts` `occupantPlan` + `OccupantPort` |
| Interiors stream in near an entrance; short fade | `InteriorSystem` residency (25 m) + fade (0.3 + 0.3 s), `FadeOverlay` |
| Indoor Phase 3 calls use real interiors (burglary, domestic, welfare, barricade, death investigation, shoplifting) | `data/scene/indoor.json`, `scene/indoor.ts`, §12 |
| Crouch, lean/peek, door slicing | `tactical/stance.ts`, `tactical/slice.ts`, `cameraRig.updateFirstPerson`, `POSE.crouch`, actions §11.4 |
| Stacking with AI partner placeholder | `tactical/partner.ts`, partner panel |
| Flashlight (toggle, NPCs notice light) | `TacticalSystem` flashlight + notice `light` stimulus, `render/tactical/flashlightRig.ts` |
| Sound propagation (footsteps by surface/speed, doors, radio chirps, voices) through a room-graph attenuation model that NPCs hear | `tactical/sound.ts` (mandatory tests), SoundField in `tacticalSystem.ts`, `npc.listeners/stimulate`, `npc:aware` reactions |
| Line of sight and cover (crouch behind furniture reduces exposure) | `interior/los.ts`, `tactical/exposure.ts`, notice pass, HUD visibility |
| Evidence markers (numbered tents) | investigation `marker`, `PROP.marker`, `MarkerLabels` |
| Photography (camera mode, screenshot-like record + metadata in the case file) | `CameraOverlay`, `photo` request, thumbnail capture (§15), `PhotoRecord` |
| Fingerprint dusting minigame placeholder | `evidence/fingerprint.ts`, `FingerprintPanel`, `dust*` requests |
| Bodycam placement/activation | locker `bodycamMount`, `officer.bodycam`, `bodycam` segments in case files, REC chip |
| Scene tape (perimeter, NPCs respect it) | `tapePost/Close`, `npc.setNoGoZones`, tape props |
| Chain of custody (collect → bag/tag → transfer → evidence room) | `evidence/ledger.ts` (mandatory tests), custody requests, station evidence point `deposit` |
| Witness interviews (Phase 3 dialogue, witness role) | contact (unchanged engine) + `witnessSaw` utterance, statements bridged into case files, canvass residents with role `witness` |
| Neighbourhood canvass | `evidence/canvass.ts`, `canvass` request, door panel "Knock (canvass)" |
| K9 search (stub unit indicating hidden items/suspects) | scene `requestK9` → `scene:service` → `investigation.startK9`, `evidence/k9.ts`, dog figures |
| Plain-view doctrine | `evidence/searchRules.ts` `plainView` / `lawfulPresence` (mandatory tests), plain-view scan |
| Consent searches (consent recorded; scope limits) | dialogue consent kinds + `contact:consent`, `searchAuthority` scope, case file consents tab |
| Station: roll call/briefing with BOLOs, district notes, assignments from CAD | `station/briefing.ts`, `BriefingScreen`, `data/station/briefing.json`, records `dailyBolos`, CAD units |
| Locker room (uniform and gear placeholder) | `station/locker.ts`, locker panel, `uniformColors` on the officer figure |
| Armory check-out recorded | `station/armory.ts` `ArmoryLog`, armory panel, scene weapon gate |
| Report room (MDT desktop) | `reportDesk` point → `MdtOverlay.open()` |
| Evidence room (deposit → custody complete) | `evidence` point → `deposit`, `custodyComplete` |
| Holding cells (prisoners placed) | `HoldingCells`, booking → `hold`, cell actors spawned on station residency |
| Interview room (interview a prisoner with Phase 3 dialogue) | interview panel → actor moved to the interview point → `contact.open` |
| Garage (patrol car spawn) | garage wide door exits to the lot next to the parked patrol cars; flow `garage` |
| New shift: locker → briefing → armory → garage | `ShiftFlow`, `startNewGame` in the station locker room, unit out of service until `garage` |
| Save version + tested migration | §16 |
| Determinism, perf, tests | §15, §17, per-module tests |

## 19. Modules, ownership and waves

| Key | Wave | Owns (exclusively) | May import (new Phase 4 code) |
|---|---|---|---|
| interiorgen | 1 | `src/world/buildings.ts`, `src/world/chunkLayout.ts` (one export), `src/interior/**`, `src/data/interior/**`, `test/interior/**`, `test/world/buildings.test.ts` | none |
| evidence | 1 | `src/evidence/**`, `src/data/evidence/**`, `test/evidence/**` | none |
| station | 1 | `src/station/**`, `src/data/station/**`, `src/ui/station/**`, `src/ui/hud/**`, `src/input/actions.ts`, `src/input/bindings.ts`, `test/station/**`, `test/stationui/**`, `test/hud/**`, `test/input/actions.test.ts`, `test/input/bindings.test.ts` | none |
| indoors | 2 | `src/indoors/**`, `src/render/interior/**`, `src/environment/render/environmentRenderer.ts`, `src/data/police/**`, `test/indoors/**`, `test/interiorrender/**` | interiorgen |
| tactical | 2 | `src/tactical/**`, `src/data/tactics/**`, `src/player/cameraRig.ts`, `src/render/people/**`, `src/render/tactical/**`, `test/tactical/**`, `test/player/cameraRig.test.ts`, `test/peoplerender/**` | interiorgen |
| people4 | 2 | `src/npc/**`, `src/dialogue/**`, `src/contact/**`, `src/data/npc/**`, `src/data/dialogue/**`, `test/npc/**`, `test/dialogue/**`, `test/contact/**` | interiorgen (constants, types) |
| investigation | 2 | `src/investigation/**`, `src/ui/investigation/**`, `test/investigation/**`, `test/investigationui/**` | interiorgen, evidence |
| scenes | 3 | `src/scene/**`, `src/calls/**`, `src/data/calls/**`, `src/data/scene/**`, `test/scene/**`, `test/calls/**` | all wave 1-2 modules |
| integrator | 4 | `src/app.ts`, `src/game/**`, `src/core/event-map.ts`, `src/ecs/components.ts`, `src/save/**`, `docs/PHASES.md`, `scripts/smoke.mjs`, and unowned files (`src/police/*.ts`, `src/dispatch/**`, `src/cad/**`, `src/records/**`, `src/people/**`, `src/radio/**`, `src/ui/ui.ts`, `src/ui/styles.css`, `src/ui/mdt/**`, `src/ui/panels/**`, `src/world/render/**`, `docs/ARCHITECTURE.md`, `docs/ASSETS.md`, `README.md`, `test/game/**`, `test/save/**`) | all |

Same-wave modules communicate only through the structural ports of this document: each consumer re-declares the
shapes it needs (`InteriorQuery`, `IndoorNavPort` (indoors declares it too), `Listener`/`ListenerPort` (npc declares it too),
`NoGoZone` (investigation declares it too), `FloorPlan` (station HUD declares it too), `DoorStateName`, `Container`,
`PrintSurface`, `CaseSummaryLike`, `PlaceItemSpec` (scenes)). Importing **pre-existing Phase 0-3 exports** of a file another
module owns is allowed (e.g. `createHumanoidSource`, `PROP`, `HELD` from `src/render/people/pose.ts`, `ActionPanelModel`,
`Bolo`); only the Phase 4 additions of a same-wave module are off limits. A module that needs a change in a
file it does not own lists it for the integrator in its final report instead of editing it.

## 20. Integrator plan

1. **Session** (`src/game/session.ts`): build `BuildingIndex(city, { addressAt })`, `InteriorSystem` (`rng.stream('interior')`,
   `OccupantPort` over `npc.spawnActor({ …, building, callId: 0 })` + `records.setAddress` for residents, `busy` =
   contact/escort/cuffed/scene role, `sceneOwns` = any open scenario bound to the building), `TacticalSystem`
   (`rng.stream('tactical')`, listeners = npc, `radioEarpiece` = loadout, `nightFactor` = env), `InvestigationSystem`
   (`rng.stream('investigation')`, ports over scene / CAD / npc / interiors / kit (`give` = `OfficerKit.adjust(+n)`) /
   station loadout), `StationState`; `npc.setIndoorNav(interiors.navPort())`; scene deps (`interiors`, `buildings`,
   `evidence: investigation`, `weaponsAvailable: station`); contact `premises` dep. Register `interiors` -810,
   `investigation` -675, `station` -670, `tactical` -640. Bus bridges of §14. `fixedUpdate`: speed factor, slicing,
   keep the body's y at `levelY(officerBuilding) + 0.9`; `npcFocus.building`, scene `OfficerFocus.building`;
   `interior:moveOfficer` → `placeOfficer(x, y, z, yaw)` (set translation, zero velocity, `writeInitialTransform`, no
   traffic repopulation) + `npc.transferFollowers` + `tactical.teleportPartner`; `teleport` (console) puts the officer
   outdoors first. Interact hints / actions of §13 (door panel model and selection, collect, canvass, station points:
   locker → locker panel; podium → briefing; armory → armory panel; evidence → `deposit`; report desk → MDT; interview →
   interview panel → `npc.setActorPosition(prisoner actor, station, interview point)` + `contact.request(open)`, back to
   the cell on close; cell + escorted prisoner → `station.request({ kind: 'hold' })` and the actor seated in the cell).
   `mdtReachable` also at the report desk. Booking (`cad:documentSaved` booking final): `station.request({ kind: 'hold' })`;
   on `station:holding` placed and on station residency: spawn/position the prisoner actor (profile `suspectCalm`,
   pose `sit`, role `prisoner`) at the cell point. Station staff figures (`stationStaff`) on station residency.
   Serialize / load v6 in the §16 order. Dispose order: investigation, tactical, contact, scene, npc, interiors, then
   Phase 3 order.
2. **New shift** (`startNewGame`): officer placed inside the station (`interiors.placeOfficerInside(station.id, locker
   point)`), patrol cars parked in the lot as before, station flow `locker`, dispatcher player unit
   `outOfService` (request at start); `station:step` garage → `dispatcher.request(status available)` and flow
   `onPatrol` (garage completes when the officer exits through the garage door or enters a patrol car). Old saves load
   outdoors (`migratedStationSave`).
3. **Save** (`src/save/**`): v6 types, validators, `migrateV5ToV6`, tests (§16).
4. **App** (`src/app.ts`): `InteriorRenderer`, `InteriorLightPool`, `FlashlightRig`, `envRenderer.setIndoor`, hide the city
   chunk group while indoors, first-person camera indoors (V toggles first/third person outdoors), officer figure: crouch
   pose, uniform colours from the loadout, hidden in first person; extra people sources (partner, staff, K9) and the merged
   prop source; input actions of §11.4 (on foot only except bodycam); panels (door, locker, armory, interview, partner,
   tools), `BriefingScreen`, `CameraOverlay` (shutter = `officer.fire` or Space), `CaseFilePanel`, `FingerprintPanel`
   (held Space → `dustBrush` with the frame dt), `MarkerLabels`, `FadeOverlay`; thumbnail capture right after
   `renderer.render()` (§15); HUD feed fields (§11.3) and the minimap floor plan; subtitles for `tactical:partner` and
   `investigation:radio` (radio `say`); Escape order (camera overlay, fingerprint and case panels close themselves);
   perf extras `interiors` (resident / colliders), `tactical` (listeners, noise), `investigation` (items, files).
5. **Event map** comment (§14), `ARCHITECTURE.md` Phase 4 sections, `PHASES.md` Phase 4 entry (controls, checklist,
   perf, limitations), README controls.
6. **Console** (`src/game/phase4Commands.ts`): `building [id|here]`, `interior info|enter <id>|exit|doors|unlock|lights`,
   `shift [step]`, `armory`, `loadout`, `case [callId]`, `ledger verify`, `k9 <callId>`, `tape clear`, `aware`, `sound
   <kind>`, `partner <command>`, `call spawn <type> building <id>` (binds the call to that building, for tests).
7. **Determinism test** (`test/game/session.test.ts`, Phase 4): new game (station locker) → loadout Done → briefing →
   sign out sidearm + taser → exit the garage door → enter the patrol car; `call spawn domesticDisturbance building
   <nearest house>`; accept, walk to the door, knock, crouch, flashlight on, enter (consent from the victim via contact),
   lean, kick the bedroom door, place a marker, photo, collect + bag + tag an item, tape is outdoors-only (skip), save
   mid-scene; two runs produce bit-identical v6 saves (thumbnails null); a load continues exactly; a v5 save loads.
8. **Smoke test** (`scripts/smoke.mjs`): new game starts in the locker room (HUD shift line), briefing screen opens,
   armory sign-out, exit to the lot; enter a house (interior visible, draw calls), a door kick, a marker + photo
   (thumbnail captured), a domestic call bound to a house with the suspect inside, save / load v6; screenshots
   `phase4.png` (an interior with flashlight and markers), `phase4-station.png` (briefing), `phase4-case.png` (case file).

## 21. Known limitations and later-phase hooks

- One floor per building (no stairs); the interior is a below-grade copy of the footprint entered with a short fade;
  outdoor windows do not show the interior.
- NPCs pass closed unlocked doors without opening them visually; they never lock doors; ambient occupants do not
  path between buildings.
- Line of sight outdoors ignores buildings (only interiors are occluded); sound between two different buildings is not
  modelled.
- Consent is modelled as granted/denied with scope; there is no revocation dialogue line (the data field exists);
  warrants exist only for warrant-service calls; the recorded search basis is graded in Phase 5.
- The partner is a placeholder: no combat, no voice commands, straight-line moves between doorway waypoints.
- Thumbnails are small JPEGs captured from the frame; they are presentation-only and capped at 32 per save.
- Uniform choices only change the officer figure's colours (Phase 7 gear).
