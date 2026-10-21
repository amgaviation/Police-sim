# Phase 7 design: Fleet, Uniforms, Customization

Status: design (technical director). Implementation is split into 8 modules in 3 waves (§19) plus an integrator
(§20). Read with `docs/ARCHITECTURE.md`, `docs/phase2-design.md` §2, `docs/phase3-design.md` §2-§3,
`docs/phase4-design.md` §2-§4, `docs/phase5-design.md` §2-§4, `docs/phase6-design.md` §2-§4 and
`docs/research/*.md`. Every builder reads §1-§4 and the section of its own module. Names, ids, signatures and shapes
in this document are contracts: do not rename them. When a brief says "add", keep every existing export, behaviour
and test green unless the brief says otherwise.

Note on the save version: the task statement says "currently v5", but Phase 6 already shipped **v8**
(`CURRENT_SAVE_VERSION = 8`, `src/save/schema.ts`). Phase 7 adds **v9** with a tested `migrateV8ToV9`; every older
version (1..8) must still load. The user gave blanket approval for this one version bump. Only the integrator edits
`src/save/**`.

## 1. Scope

At the end of Phase 7 the officer has a department behind them:

- **Fleet** (`src/vehicles`, `src/fleet`, `src/data/vehicles`, `src/data/fleet`). 17 generic, procedurally modelled
  vehicles (boxes, no brands): patrol sedan, patrol SUV (both exist), supervisor SUV, unmarked cruiser, traffic
  enforcement sedan, K9 SUV, motorcycle, bicycle, ATV, SWAT truck, armored rescue vehicle, prisoner transport van,
  command post (bus body), mobile crime lab (van), patrol boat (harbor water), helicopter (player-flyable, basic
  arcade model) and a camera drone (remote-controlled by the officer on foot). Every vehicle is one JSON file with
  data-driven handling, a control model (`car`, `bike`, `boat`, `helicopter`, `drone`), cargo capacity (kg, slots,
  long-gun rack slots) and patrol extras (cage seats, drone bay, radar, kennel). Each fleet unit (`fleet.json`) has a
  unit number, a livery, a vehicle loadout and a maintenance record. The station yard holds the units; the fleet
  panel checks a unit out (spawned at the garage exit), in (despawned with its condition stored) or opens service.
- **Control models.** Cars and the ATV keep the Phase 1 ray-cast vehicle. Motorcycle and bicycle are the same ray-cast
  vehicle on a narrow virtual track with an **upright assist** torque and a **visual lean** (the renderer draws two
  wheels in line and rolls the body). Boat, helicopter and drone are **kinematic crafts**: a pure, deterministic
  integrator (`src/vehicles/craft.ts`) plus a Rapier `KinematicCharacterController` that resolves collisions with
  buildings and quay walls. The boat stays on water blocks; the helicopter climbs / descends (Space / Shift) between
  the ground and its ceiling; the drone is flown in a new player mode **remote** (the officer stays standing where
  they deployed it, the drone is leashed to 350 m and has a battery).
- **Livery editor** (`src/livery`, `src/render/livery`, `src/ui/livery`). A versioned, validated JSON document
  (`patrol-livery` v1): base paint, wraps for unmarked units, up to 32 layered decals (stripes, procedural shapes
  including user-drawn polygons, text with the `{unit}` token, checker bands), reflective flags (the reflective
  layers glow under low light), light-bar style (roof / hidden / none) and pattern, siren tone, push bar, spotlight,
  partition and the vehicle loadout. Painted on a 1024x512 canvas atlas mapped onto a thin shell around the body; a
  live 3D preview (orbit camera on the real vehicle in the station lot); save to the fleet library; export / import as
  a `.json` file validated by the schema.
- **Equipment** (`src/gear`, `src/police`, `src/station`). A data-driven catalog of 20 officer items with weight,
  slot kind and size (radio, duty belt, holster with retention level 1-3, TASER, OC, baton, cuffs, flashlight, med
  kit, naloxone, tourniquet, ballistic vest, rifle, shotgun, less-lethal launcher, ram, Halligan, K9 treats, evidence
  kit) validated against per-assignment policy (weight limit, slot capacity, required / forbidden items, minimum
  holster retention, long-gun limit). Vehicle loadouts (trunk items + racked long guns) are validated against the
  vehicle's cargo. Items are really used by Phase 3-6 systems (§11): naloxone on overdose calls, tourniquet and med
  kit on injury calls, ram / Halligan breaching, K9 treats on K9 sweeps, the evidence kit fills the scene kit, armory
  sign-out of the loadout's weapons, holster retention (draw time and weapon-grab resistance), the vest stopping
  rounds fired at the officer.
- **Uniforms and character** (`src/uniform`, `src/render/people`, `src/ui/character`). Seven uniform classes (class
  A, class B, tactical, bike patrol, motor, SWAT, detective plain clothes) built parametrically into accessory boxes
  (hats, vest carriers, cold-weather gear, shoulder patches, rank insignia, name plate, badge, hair) drawn by the
  upgraded Phase 3 humanoid (one extra instanced mesh, body-shape sliders). AI officers get deterministic outfits
  per seed and callsign. A body-type and gender-inclusive character creator (first / last name, badge, pronouns with
  presets and custom sets, height, build, shoulders, hips, skin tone, hair style and colour) whose pronouns are used
  in radio lines and reports.
- **Maintenance** (`src/vehicles/wear.ts`, `src/fleet`). Fuel (exists), oil (drains with engine work; empty oil wears
  the engine), tyre tread per wheel (distance + slip; worn tyres lose grip, worse in the wet), damage (exists).
  Fleet-yard service at the station garage (refuel, oil change, tyres, repair) with a department cost ledger;
  **damage reports** for every crash (merged hits), **career charges** (career points deducted for at-fault damage,
  more for wrecks and unreported damage, less in pursuits / emergency runs), and a **shift-end inspection
  checklist** (data-driven) followed by "End shift".

Non-goals (later phases): real textures or skinned meshes; helicopter rotor aerodynamics; boat waves / buoyancy;
multiple drones; AI driving of the new archetypes (the Phase 6 resource units keep their models); NPCs reacting to
uniform class; persistence of liveries outside a save (export / import covers sharing).

## 2. Conventions (in addition to Phase 1-6 §2)

- **TS rules** unchanged: no enums / namespaces / parameter properties; `as const` objects + unions; `import type`;
  `noUncheckedIndexedAccess`; JSDoc on exports; `scratch*` temporaries in hot loops; **no per-step allocation** in
  `step` / `preStep` / `postStep` / renderer `update` hot paths (events, requests, UI actions and repaints may
  allocate).
- **Determinism.** All new simulation state changes in fixed steps and draws only from named streams:
  `session.rng.stream('fleet')` (reserved; the fleet draws nothing today), `session.rng.stream('gear')` (officer hit
  rolls), the vehicle's own `'vehicle:<slot>'` stream (damage of crafts). Pure per-entity randomness uses
  `createRng(seed).stream('uniform:<callsign>')` (AI outfits). `Math.random`, `Date.now`, `performance.now` are
  forbidden in `src/vehicles`, `src/fleet`, `src/gear`, `src/uniform`, `src/livery` (the livery id generator takes the
  existing ids, not the clock). Painting, previews, editors and the HUD never feed back into the simulation.
- **UI → sim through queues / requests.** The fleet panel, service and inspection produce `FleetRequest`s applied at
  the start of the fleet's next fixed step. Livery and loadout changes are applied by the integrator between steps
  (they change presentation and spawn-time state only). Bus handlers only enqueue.
- **Data** in `src/data/<area>/*.json`, `"version": 1`, validated at import by a typed validator throwing `Error`
  naming the file and the dotted JSON path (pattern: `src/vehicles/json.ts` readers, `src/police/data.ts`). Every
  validator is exported as `parseX(json, file)` and the parsed constant as `X_DATA` so tests can feed variants. The
  livery validator is the exception: user files are untrusted input, so it **returns** errors instead of throwing.
- **Headless.** DOM classes construct and run as no-ops without `document` (vitest = node). Canvas painting goes
  through the `Canvas2DLike` interface (§6.5) so tests use a recording fake.
- **Generic content only.** No real agency names, seals, badges, logos, liveries, vehicle brands or game assets. The
  department is "City Police" (initials "CP", already used by the Phase 3 dialogue). Badges and patches are procedural
  shapes or user-drawn polygons. Vehicle names are descriptive ("Patrol sedan"). No third-party assets;
  `docs/ASSETS.md` stays empty.
- **Units.** Metres, kg, seconds, litres, game dollars (integers) for costs; career points are integers.
- **Flashes.** HUD one-liners go out as `<module>:flash` `{ text }` (Phase 6 `FlashPayload`).

## 3. Architecture

```
 fixed step (60 Hz)
 ┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ ... Phase 1-6 systems unchanged in order ...                                                                   │
 │ force (-685)  + holster retention: draw delay, weapon-grab roll on npc:attack 'fight' (hooks)                 │
 │ investigation (-675) + K9 treat bonus (hooks)                                                                  │
 │ backup (-665) + AI officer outfits in the view (hooks)                                                        │
 │ conduct (-658) + { kind: 'points' } request → career points (hooks)                                          │
 │ fleet (-655)  FleetSystem: queued requests (service, report, inspect, endShift), damage incident merge       │
 │               (vehicle:damaged → incidents, closed 5 s after the last hit) ─▶ fleet:damage/charge/service/... │
 │ vehicles.pre 40  DrivableVehicle.preStep: car / bike (upright assist) / craft (kinematic integrator + character │
 │                  controller), tread grip; vehicles.post 110: wear (oil, tread, odometer), lean / rotor look   │
 └──────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 presentation (per frame)
   CarRenderer: new body styles, 2-wheel / no-wheel layouts, lean, rotors, per-instance trim (push bar, spotlight,
                hidden light bar);  LiveryRenderer: ≤ 8 decal shells (CanvasTexture + reflective emissive map)
   PeopleRenderer: + accessory mesh (outfits), shoulders / hips; sources gain `outfit`
   UI: character creator (new game, locker), livery editor (garage), fleet / service / inspection panels (ActionPanel),
       HUD wear / altitude / battery / fleet chip
```

- **Wave 1 (no new Phase 7 imports):** `vehicles` (models, control models, wear, crafts, player remote mode, input
  actions), `livery` (schema, validator, import / export, shapes, painter, shell atlas), `uniform` (uniform classes,
  outfits, character profile, pronouns), `gear` (item catalog, policy, loadout validation, officer gear state, police
  trunk / rack / cage additions, station locker / armory rows).
- **Wave 2 (import wave 1):** `fleet` (fleet roster, yard, maintenance accounting, damage reports, inspection,
  FleetSystem), `render` (vehicle parts, LiveryRenderer, people accessories), `hooks` (calls data, breach, force
  retention, K9 treats, backup outfits, conduct points).
- **Wave 3:** `ui` (livery editor, character creator, fleet panels, HUD, main menu; imports all).
- Importing **pre-existing Phase 0-6 exports** of a file another module owns is always allowed (e.g.
  `LIGHTBAR_PATTERNS` from `src/police/lightbar.ts`, `ActionPanelModel` from `src/ui/panels/actionPanel.ts`,
  `createRng`); only Phase 7 additions of a same-wave module are off limits (use the contract literal or a parameter).

## 4. Shared contracts

### 4.1 Fixed id lists (contracts)

| List | Ids | Defined by (file) |
|---|---|---|
| `BODY_STYLES` (13) | existing `sedan hatchback suv pickup van truck bus` + `motorcycle bicycle atv boat helicopter drone` | vehicles `src/vehicles/model.ts` |
| `CONTROL_KINDS` (5) | `car bike boat helicopter drone` | vehicles `src/vehicles/model.ts` |
| `CRAFT_KINDS` (3) | `boat helicopter drone` | vehicles `src/vehicles/craft.ts` |
| `TRIM` bits | `pushBar: 1, spotlight: 2, hiddenBar: 4, noBar: 8` | vehicles `src/vehicles/components.ts` |
| `PLAYER_MODE` | `onFoot: 0, driving: 1, remote: 2` (names `onFoot driving remote`) | vehicles `src/player/mode.ts` |
| New input actions | `vehicle.lift` (axis, bipolar: Space +1, ShiftLeft −1), `fleet.menu` (button, `Quote`), `drone.toggle` (button, `Equal`) | vehicles `src/input/actions.ts`, `bindings.ts` |
| `FLEET_CLASSES` (16) | `patrol supervisor unmarked traffic k9 motor bicycle atv swat armored transport command lab marine air drone` | fleet `src/fleet/types.ts`; wave-1 consumers (gear policy keys) use the literal strings |
| `LIVERY_FACES` (7) | `sides left right hood roof front rear` | livery `src/livery/types.ts` |
| `LAYER_TYPES` (4) | `stripe shape text checker` | livery |
| `SHAPE_KINDS` (10) | `rect roundedRect circle ellipse star shield chevron triangle arch polygon` | livery |
| `LIGHTBAR_STYLES` (3) | `roof hidden none` | livery |
| `WRAP_KINDS` (4) | `solid twoTone fade pinstripe` | livery |
| `FINISHES` (3) | `gloss matte metallic` | livery |
| `GEAR_SLOTS` (5) | `belt vest body longGun carry` | gear `src/gear/types.ts` |
| `ASSIGNMENTS` (10) | `patrol traffic k9 motor bicycle swat detective supervisor marine air` | gear |
| `GEAR_ITEM_IDS` (20) | `radio dutyBelt holster sidearm taser ocSpray baton cuffs flashlight medKit naloxone tourniquet ballisticVest rifle shotgun lessLethalLauncher ram halligan k9Treats evidenceKit` | gear `src/data/gear/items.json` |
| New trunk items (police `items.json`) | `naloxone tourniquet halligan k9Treats drone` | gear |
| New rack item (police `equipment.json`) | `lessLethal` ("Less-lethal launcher") | gear |
| New trunk loadouts (police `equipment.json`) | `supervisor unmarked traffic k9 motor bicycle atv swat armored transport command lab marine air` (+ existing `patrol`) | gear |
| `UNIFORM_CLASSES` (7) | `classA classB tactical bike motor swat detective` | uniform `src/uniform/types.ts` |
| `HAT_IDS` (9) | `none peakedCap campaign ballCap beanie motorHelmet bikeHelmet tacticalHelmet watchCap` | uniform |
| `CARRIER_IDS` (4) | `none internal external plateCarrier` | uniform |
| `COLD_IDS` (4) | `none jacket parka rainShell` | uniform |
| `HAIR_STYLES` (8) | `bald buzz short medium long bun ponytail braids` | uniform |
| `RANK_IDS` (6) | `officer corporal sergeant lieutenant captain chief` | uniform |
| `PRONOUN_PRESETS` (3 + custom) | `she he they` (+ `custom`) | uniform |
| `ATTACH` | `torso: 0, head: 1, leftArm: 2, rightArm: 3, pelvis: 4, leftThigh: 5, rightThigh: 6, leftShin: 7, rightShin: 8` | uniform `src/uniform/types.ts` |
| Fleet services | `refuel oil tires repair all` | fleet |

### 4.2 Shared types from wave 1 (owners export them; later waves import)

```ts
// vehicles — src/vehicles/drivableVehicle.ts
/** Snapshot of a vehicle's maintainable state (allocation-free when `out` is passed). */
export interface VehicleCondition {
  modelId: string;
  fuelFraction: number;        // 0..1
  fuelL: number;
  oilFraction: number;         // 0..1 (oilL / wear.oilL)
  tread: [number, number, number, number]; // 0..1 per wheel FL FR RL RR
  flats: [boolean, boolean, boolean, boolean];
  zones: [number, number, number, number]; // 0..1 front rear left right
  engineHealth: number;        // 0..1
  engineFailed: boolean;
  odometerKm: number;
}
/** Spawn-time build options (from the livery's equipment section). */
export interface VehicleBuild { pushBar: boolean }

// livery — src/livery/types.ts (full shape §6.1)
export interface LiveryDoc { ... }
export type LiveryResult = { ok: true; livery: LiveryDoc } | { ok: false; errors: string[] };

// gear — src/gear/types.ts (full shapes §8)
export interface VehicleLoadout { trunk: Record<string, number>; rack: string[] }
export interface VehicleCapacity { kg: number; slots: number; rackSlots: number }
export interface GearIssue { code: GearIssueCode; item: string | null; message: string }
export interface LoadoutValidation { ok: boolean; errors: GearIssue[]; warnings: GearIssue[]; weightKg: number; capacityKg: number;
  slots: Record<GearSlot, { used: number; cap: number }> }

// uniform — src/uniform/types.ts (full shapes §7)
export interface AccessoryBox { attach: AttachId; x: number; y: number; z: number; sx: number; sy: number; sz: number; color: number }
export interface OutfitDef { id: string; top: number; bottom: number; boxes: readonly AccessoryBox[]; hideHair: boolean }
export interface PronounSet { id: 'she' | 'he' | 'they' | 'custom'; subject: string; object: string; possessive: string;
  possessivePronoun: string; reflexive: string; plural: boolean }
export interface CharacterProfile { ... }  // §7.4
```

### 4.3 Event topics (declaration merging in the owner's `events.ts`)

| Topic | Owner file | Payload |
|---|---|---|
| `player:mode` | vehicles `src/player/events.ts` | unchanged shape; `mode` gains `'remote'` |
| `fleet:damage` | fleet `src/fleet/events.ts` | `{ unitId: string; incidentId: number; zone: 'front' \| 'rear' \| 'left' \| 'right'; amount: number; impactSpeed: number; pursuit: boolean; emergency: boolean }` (first hit of an incident only) |
| `fleet:incident` | fleet | `{ unitId: string; incidentId: number; cost: number; wreck: boolean }` (incident closed, 5 s after its last hit) |
| `fleet:charge` | fleet | `{ unitId: string; incidentId: number; points: number; cost: number; reason: string }` (`points` ≤ 0: the career delta) |
| `fleet:service` | fleet | `{ unitId: string; service: 'refuel' \| 'oil' \| 'tires' \| 'repair' \| 'all'; cost: number }` |
| `fleet:inspection` | fleet | `{ unitId: string; passed: number; failed: string[] }` (item ids that failed) |
| `fleet:shiftEnd` | fleet | `{ points: number; departmentCost: number; incidents: number; unreported: number }` |
| `fleet:flash` | fleet | `{ text: string }` |
| `conduct:points` | hooks `src/conduct/events.ts` | `{ delta: number; total: number; reason: string }` |

No new components in `src/ecs/components.ts`. `VehicleLook` (`src/vehicles/components.ts`, owner vehicles) gains
`lean`, `rotor` and `trim` arrays (§5.6).

## 5. Vehicles, control models, wear, player remote mode [vehicles] — wave 1

Owns `src/vehicles/**`, `src/data/vehicles/**`, `src/player/**`, `src/input/actions.ts`, `src/input/bindings.ts`,
tests `test/vehicles/**`, `test/player/**`, `test/input/**`. Imports nothing new from Phase 7.

### 5.1 Model schema additions (`src/vehicles/model.ts`)

Add (keep everything else):

```ts
export const BODY_STYLES = ['sedan', 'hatchback', 'suv', 'pickup', 'van', 'truck', 'bus',
  'motorcycle', 'bicycle', 'atv', 'boat', 'helicopter', 'drone'] as const;
export const CONTROL_KINDS = ['car', 'bike', 'boat', 'helicopter', 'drone'] as const;
export type ControlKind = (typeof CONTROL_KINDS)[number];

export interface CraftSpec {
  readonly maxSpeedMps: number;   // > 0
  readonly reverseMps: number;    // >= 0
  readonly accelMps2: number;     // > 0
  readonly brakeMps2: number;     // > 0
  readonly turnRateDegS: number;  // > 0
  readonly climbMps: number;      // >= 0 (0 for the boat)
  readonly maxAltitudeM: number;  // >= 0 (0 for the boat)
  readonly dragPerS: number;      // 0..5, fraction of speed lost per second with no input
  readonly tiltDeg: number;       // 0..45, visual pitch / roll at full speed / turn
  readonly rangeM: number;        // >= 0, leash from the anchor (drone); 0 = none
}
export interface BikeSpec {
  readonly uprightStiffness: number; // > 0, N·m per rad per kg
  readonly uprightDamping: number;   // >= 0, N·m·s per rad per kg
  readonly maxLeanDeg: number;       // 0..60 (visual)
  readonly pedal: boolean;           // bicycle: no fuel burn, engine always runs
}
export interface WearSpec {
  readonly oilL: number;           // > 0 capacity
  readonly oilPerKWh: number;      // >= 0 litres burnt per kWh of engine work
  readonly oilWearPerS: number;    // >= 0 engine health lost per second running with empty oil
  readonly treadPerKm: number;     // >= 0 tread lost per km per wheel
  readonly treadSlipPerS: number;  // >= 0 tread lost per second of a slipping wheel
  readonly minTreadGrip: number;   // 0..1 grip factor of a bald tyre (dry)
  readonly wetTreadPenalty: number;// 0..1 extra grip lost by a bald tyre at full wetness
}
export interface CargoSpec { readonly kg: number; readonly slots: number; readonly rackSlots: number } // ints >= 0 (kg number)
export interface PatrolExtras {
  readonly cageSeats: number;  // int 0..8; default: equipment?.partition ? 1 : 0
  readonly droneBay: boolean;  // default false
  readonly radar: boolean;     // default false (traffic enforcement: speed readings at 2x range, see §20)
  readonly kennel: boolean;    // default false (K9 unit)
}
export interface RiderSpec { readonly x: number; readonly y: number; readonly z: number; readonly pose: 'seated' | 'stand' }

// VehicleModel gains:
readonly control: ControlKind;          // JSON "control", default 'car'
readonly craft: CraftSpec | null;       // JSON "craft": required iff control is boat | helicopter | drone, else must be absent
readonly bike: BikeSpec | null;         // JSON "bike": required iff control is 'bike', else must be absent
readonly wear: WearSpec;                // JSON "wear", optional; DEFAULT_WEAR when absent
readonly cargo: CargoSpec;              // JSON "cargo", optional; { kg: 0, slots: 0, rackSlots: 0 } when absent
readonly patrol: PatrolExtras;          // JSON "patrol", optional; defaults above
readonly rider: RiderSpec | null;       // JSON "rider", optional: an open vehicle shows its rider at this vehicle-local feet point

export const DEFAULT_WEAR: WearSpec = { oilL: 6, oilPerKWh: 0.004, oilWearPerS: 0.002, treadPerKm: 0.0015,
  treadSlipPerS: 0.02, minTreadGrip: 0.75, wetTreadPenalty: 0.2 };

/** Damage spec with or without the model's push bumper (no front fields when `pushBar` is false or the model has none). */
export function damageSpecFor(model: VehicleModel, pushBar: boolean): DamageSpec;
/** True for boat / helicopter / drone. */
export function isCraft(model: VehicleModel): boolean;
/** 'four' (cars, ATV), 'two' (motorcycle, bicycle), 'none' (crafts). */
export function wheelLayout(model: VehicleModel): 'four' | 'two' | 'none';
```

Validation rules (errors through `fail(source, path, msg)`): `control` one of `CONTROL_KINDS`; craft / bike sections
present exactly when required; numeric ranges above; `rider.pose` one of the two; `patrol.cageSeats` integer 0..8.
`damageSpecFor(model, false)` returns `model.damage` without `frontZoneStrength` / `frontEngineShare` (build a new
object with only the seven base keys); `damageSpecFor(model, true)` returns `model.damage` (it already has the front
fields when the model has `equipment.pushBumper`). Keep `parseVehicleModel` signature.

### 5.2 New vehicle files (`src/data/vehicles/*.json`)

Every new file: `"version": 1`, `"role": "police"`, `"trafficWeight": 0`, `"listOrder": 2` (so Phase 1-6
`VehicleLook.model` indices never move), `"traffic": { "maxAccel": 2, "comfortDecel": 2.5, "maxDecel": 7 }` unless
stated. "Copy X" means copy every section of file X, then apply the overrides listed. Crafts still carry the
`engine` / `steering` / `suspension` / `tires` / `brakes` sections (the validator requires them; the craft
integrator ignores them except `engine.maxPowerKw`).

| File / id | Name | Base | Overrides |
|---|---|---|---|
| `supervisor_suv` | Supervisor SUV | copy `patrol_suv` | colors `[{#f2f2f2,1}]`; equipment `{ pushBumper {1.8,0.5}, partition false, rack true, spotlight true, mdt true, trunk "supervisor" }`; cargo `{220,30,2}` |
| `unmarked_sedan` | Unmarked cruiser | copy `patrol_sedan` | colors `[{#3a3f47,2},{#5b6168,1},{#1f2a3a,1}]`; lightbar true (hidden style by livery); equipment `{ partition true, rack true, spotlight true, mdt true, trunk "unmarked" }` (no pushBumper key); cargo `{150,24,2}` |
| `traffic_sedan` | Traffic enforcement sedan | copy `patrol_sedan` | engine maxPowerKw 280, maxSpeedKmh 240; equipment trunk "traffic" (keep pushBumper etc.); patrol `{ radar: true }`; cargo `{150,26,1}` |
| `k9_suv` | K9 unit | copy `patrol_suv` | equipment trunk "k9" (partition true, keep rest); patrol `{ cageSeats: 0, kennel: true }`; cargo `{200,28,1}` |
| `police_motorcycle` | Patrol motorcycle | new | body `{style motorcycle, length 2.3, width 0.9, height 1.0, groundClearance 0.15, wheelbase 1.55, track 0.5, cabin {0.15,0.4,0.35,0.2}}`; colors `[{#f2f2f2,1}]`; lightbar true; mass 330; comHeight 0.55; engine `{3200, 85, 200, 6, 1100, 9000, [2.8,2.0,1.6,1.3,1.1,0.95], 3.0}` (field order maxForce, maxPowerKw, maxSpeedKmh, reverseMaxSpeedKmh, idleRpm, redlineRpm, gearRatios, finalDrive); drive rwd; steering `{28, 0.25, 160}`; suspension `{0.25, 32, 2.4, 3.2, 0.15, 8000}`; tires `{0.32, 0.16, 1.05, 1, 0.1}`; brakes `{6500, 0.7, true, 2000, 0.5, 0.003, 0.0005, 350, 650, 0.45}` (maxForce, frontBias, abs, handbrakeForce, heatPerKJ, coolingPerS, airflowCooling, fadeStartC, fadeEndC, minEfficiency); fuel `{22, 0.4, 0.28}`; damage `{2, 10, 0.6, 8, 0.3, 0.04, 0.05}` (minImpactSpeed, zoneStrength, engineFrontShare, tireBurstSpeed, stallBelow, stallChancePerS, failBelow); control "bike"; bike `{60, 12, 40, false}`; equipment `{partition false, rack false, spotlight false, mdt false, trunk "motor"}`; cargo `{25,6,0}`; rider `{0, 0.1, 0.15, "seated"}` |
| `police_bicycle` | Patrol bicycle | new | body `{bicycle, 1.8, 0.6, 1.0, 0.1, 1.08, 0.4, cabin {0.3,0.5,0.2,0.2}}`; colors `[{#1c1f24,1}]`; lightbar false; mass 95; comHeight 0.7; engine `{400, 0.6, 38, 4, 60, 120, [1], 1}`; drive rwd; steering `{30, 0.35, 160}`; suspension `{0.2, 30, 2.4, 3.2, 0.1, 3000}`; tires `{0.34, 0.05, 1.0, 1, 0.1}`; brakes `{1300, 0.6, false, 500, 0.5, 0.003, 0.0005, 350, 650, 0.45}`; fuel `{1, 0, 0}`; damage `{2, 6, 0, 7, 0, 0, 0}`; control "bike"; bike `{50, 10, 30, true}`; equipment `{partition false, rack false, spotlight false, mdt false, trunk "bicycle"}`; cargo `{12,4,0}`; rider `{0, 0.1, 0.1, "seated"}` |
| `police_atv` | Patrol ATV | new | body `{atv, 2.1, 1.2, 0.75, 0.28, 1.3, 0.95, cabin {0.35,0.6,0.2,0.3}}`; colors `[{#2b2f36,1}]`; lightbar true; mass 420; comHeight 0.6; engine `{3500, 40, 95, 15, 1200, 7500, [3,2,1.5,1.2,1], 3.5}`; drive awd; steering `{35, 0.5, 140}`; suspension `{0.3, 26, 2.5, 3.3, 0.2, 9000}`; tires `{0.3, 0.22, 1.1, 1, 0.15}`; brakes `{7000, 0.6, false, 3000, 0.4, 0.003, 0.0005, 350, 650, 0.45}`; fuel `{18, 0.5, 0.3}`; damage `{2, 10, 0.6, 9, 0.3, 0.04, 0.05}`; equipment `{partition false, rack false, spotlight false, mdt false, trunk "atv"}`; cargo `{40,8,0}`; rider `{0, 0.45, 0.1, "seated"}` |
| `swat_truck` | SWAT truck | copy `tactical_truck` | role police, listOrder 2; equipment `{ pushBumper {2.5,0.4}, partition false, rack true, spotlight true, mdt true, trunk "swat" }`; cargo `{900,80,4}` |
| `armored_truck` | Armored rescue vehicle | copy `tactical_truck` | body `{truck, 6.2, 2.5, 2.4, 0.45, 3.6, 2.0, cabin {0,0.35,0.9,0.05}}`; colors `[{#2a2e33,1}]`; mass 12000; engine maxForce 24000, maxPowerKw 250, maxSpeedKmh 110; brakes maxForce 90000, handbrakeForce 60000; damage `{4, 45, 0.3, 20, 0.3, 0.02, 0.05}`; equipment `{ pushBumper {3.0,0.3}, partition false, rack true, spotlight true, mdt true, trunk "armored" }`; cargo `{600,50,4}` |
| `prisoner_van` | Prisoner transport | copy `van` | colors `[{#f2f2f2,1}]`; lightbar true; equipment `{partition true, rack false, spotlight false, mdt true, trunk "transport"}`; patrol `{ cageSeats: 6 }`; cargo `{120,16,0}` |
| `command_post` | Mobile command post | copy `city_bus` | body `{bus, 10.5, 2.5, 2.9, 0.35, 6.2, 2.05, cabin {0,0.15,1.2,0.05}}`; colors `[{#f2f2f2,1}]`; lightbar true; mass 14000; engine maxPowerKw 220, maxSpeedKmh 110; equipment `{partition false, rack false, spotlight true, mdt true, trunk "command"}`; patrol `{ droneBay: true }`; cargo `{800,80,2}` |
| `crime_lab` | Mobile crime lab | copy `van` | colors `[{#f5f5f2,1}]`; lightbar true; equipment `{partition false, rack false, spotlight true, mdt true, trunk "lab"}`; cargo `{500,60,0}` |
| `patrol_boat` | Patrol boat | new | body `{boat, 8, 2.6, 1.4, 0, 5, 2.0, cabin {0.35,0.6,0.8,0.4}}`; colors `[{#f2f2f2,1}]`; lightbar true; mass 3500; comHeight 0.5; engine `{10000, 300, 70, 15, 700, 5000, [1], 1}`; steering / suspension / tires / brakes: copy `patrol_sedan`; fuel `{300, 4, 0.3}`; damage `{2, 14, 0.5, 99, 0.3, 0.02, 0.05}`; control "boat"; craft `{18, 4, 2.5, 3, 35, 0, 0, 0.08, 6, 0}` (maxSpeedMps, reverseMps, accelMps2, brakeMps2, turnRateDegS, climbMps, maxAltitudeM, dragPerS, tiltDeg, rangeM); equipment `{partition false, rack false, spotlight true, mdt true, trunk "marine"}`; cargo `{400,30,2}`; rider `{0, 0.2, 0.3, "stand"}` |
| `police_helicopter` | Patrol helicopter | new | body `{helicopter, 11, 2.4, 2.6, 0.5, 6, 2.0, cabin {0,0.3,1.6,0.2}}`; colors `[{#1f2a3a,1}]`; lightbar true; mass 2400; comHeight 1.2; engine `{10000, 450, 220, 30, 700, 6000, [1], 1}`; steering / suspension / tires / brakes: copy `patrol_sedan`; fuel `{500, 60, 0.25}`; damage `{3, 12, 0.6, 99, 0.3, 0.02, 0.1}`; control "helicopter"; craft `{60, 8, 5, 6, 50, 9, 400, 0.15, 12, 0}`; equipment `{partition false, rack false, spotlight true, mdt true, trunk "air"}`; cargo `{150,12,0}` |
| `police_drone` | Camera drone | new | body `{drone, 0.6, 0.6, 0.2, 0.1, 0.4, 0.4, cabin {0.3,0.7,0.08,0.15}}`; colors `[{#2b2f36,1}]`; lightbar false; mass 3; comHeight 0.15; engine `{100, 1, 60, 30, 100, 200, [1], 1}`; steering / suspension / tires / brakes: copy `patrol_sedan`; fuel `{1, 3, 0}` (the battery: 20 min); damage `{2, 4, 0.8, 99, 0.3, 0, 0.2}`; control "drone"; craft `{16, 8, 6, 8, 120, 5, 120, 0.6, 18, 350}`; no equipment section; no cargo |

Add `"cargo"` to the existing `patrol_sedan.json` (`{150,30,2}`) and `patrol_suv.json` (`{220,34,2}`); change
nothing else in Phase 1-6 files.

### 5.3 Craft integrator (`src/vehicles/craft.ts`, pure) — mandatory tests

```ts
export const CRAFT_KINDS = ['boat', 'helicopter', 'drone'] as const;
export type CraftKind = (typeof CRAFT_KINDS)[number];
export interface CraftState { x: number; y: number; z: number; yaw: number; speed: number; vy: number; pitch: number; roll: number }
export interface CraftInput { forward: number /* -1..1 (+ = ahead) */; steer: number /* -1..1, + = right */; lift: number /* -1..1 */ }
export interface CraftEnv { groundY: number; waterY: number; engineOk: boolean; anchorX: number; anchorZ: number }
export interface CraftStep { dx: number; dy: number; dz: number; yaw: number; pitch: number; roll: number; landed: boolean }
export function createCraftState(x: number, y: number, z: number, yaw: number): CraftState;
/** Advances `s.speed`, `s.vy` (in place) and writes the desired translation / attitude into `out`. Allocation-free. */
export function stepCraft(kind: CraftKind, spec: CraftSpec, clearance: number, s: CraftState, input: CraftInput,
  dt: number, env: CraftEnv, out: CraftStep): CraftStep;
```

Algorithm (all in this order, `fwd(yaw) = (-sin yaw, -cos yaw)` in x, z):
1. **Speed.** `target accel = forward > 0 ? forward * accelMps2 : forward < 0 ? (s.speed > 0.5 ? forward * brakeMps2 :
   forward * accelMps2) : 0`. `s.speed += accel * dt`; then drag `s.speed -= s.speed * dragPerS * dt`; clamp to
   `[-reverseMps, maxSpeedMps]`. When `!env.engineOk`: no accel, drag × 3.
2. **Yaw.** `rate = steer * turnRateDegS * π/180 * clamp(|speed| / 3, kind === 'boat' ? 0.15 : 1, 1)` (crafts that
   hover turn in place; the boat needs way on), times `-1` when `speed < -0.1` for the boat only. Project convention:
   yaw 0 faces −Z and a positive yaw turns left, so steering right (steer > 0) **decreases** yaw: `out.yaw = s.yaw -
   rate * dt`; then `s.yaw = out.yaw`.
3. **Vertical.** Boat: `out.dy = (env.waterY + clearance) - s.y`, `s.vy = 0`. Helicopter / drone: `targetVy =
   env.engineOk ? lift * climbMps : -6`; `s.vy += clamp(targetVy - s.vy, -4 * dt, 4 * dt)`; `ny = s.y + s.vy * dt`;
   floor `env.groundY + clearance`, ceiling `env.groundY + clearance + maxAltitudeM`; when `ny` hits the floor set
   `s.vy = 0` and `out.landed = true`; when landed and `lift <= 0`, `s.speed *= max(0, 1 - 4 * dt)`. `out.dy = ny -
   s.y`.
4. **Horizontal.** `d = s.speed * dt`; `out.dx = fwd.x * d`, `out.dz = fwd.z * d`. Drone leash when `rangeM > 0`: if
   the point after the move is farther than `rangeM` from `(anchorX, anchorZ)`, scale the move to the component that
   does not increase the distance (project out the radial component) and set `s.speed *= 0.5`.
5. **Attitude (visual).** `pitch = -(s.speed / maxSpeedMps) * tilt` (nose down for helicopter / drone, `+0.3 *` that
   for the boat: bow up), `roll = -steer * tilt * min(|s.speed| / 10, 1) * 0.5`, `tilt = tiltDeg * π/180`.

Tests (`test/vehicles/craft.test.ts`): boat accelerates to ≈ `maxSpeedMps` in < 15 s with forward 1; brake stops it,
then reverses up to `reverseMps`; boat `dy` keeps it at `waterY + clearance`; helicopter climbs at `climbMps` with lift
1 and never exceeds the ceiling or goes below the floor; engine failure descends at ~6 m/s; landed helicopter with
lift 0 bleeds speed; drone leash never lets the distance exceed `rangeM + 0.01`; same inputs → bit-identical states
(determinism).

### 5.4 DrivableVehicle changes (`src/vehicles/drivableVehicle.ts`)

Public API additions (all existing members keep their behaviour for `control: 'car'`):

```ts
static create(physics, eid, model, pose, rng, build?: VehicleBuild): DrivableVehicle;  // build default { pushBar: model.equipment?.pushBumper != null }
static restore(physics, eid, data, rng, build?: VehicleBuild): DrivableVehicle;        // build default from data.pushBar ?? model default
readonly pushBar: boolean;
readonly control: ControlKind;                   // model.control
/** Oil change: oil to capacity. */ changeOil(): void;
/** New tyres on `wheels` (default all four): tread 1, flat cleared, radius restored. */ replaceTires(wheels?: readonly number[]): void;
/** Body zones and engine (health 1, not failed), keeps tyres / oil / fuel. */ repairBody(): void;
/** Fills `out` (or a new object) with the maintainable state. */ condition(out?: VehicleCondition): VehicleCondition;
```
`repair()` keeps its Phase 1 meaning (body, engine, flats; it does not touch oil or tread).

**`VehicleEnvironment`** gains optional fields (absent = defaults): `isWater?(x: number, z: number): boolean` (default
`() => false`), `waterY?: number` (default −0.05), `groundY?: number` (default 0), `anchorX?: number`, `anchorZ?: number`
(drone leash anchor; default the craft's own position = no leash).

**`DriverControls`** (`src/vehicles/controls.ts`) gains optional `lift?: number`; `DriverInput` gains optional
`lift?: number`; `mapDriverInput` copies `out.lift = clamp(input.lift ?? 0, -1, 1)` (optional so the integrator's
literal objects keep compiling).

**`VehicleTelemetry`** gains `oilFraction`, `treadMin` (lowest of the four), `odometerKm`, `altitudeM` (crafts:
`y - groundY - clearance`, boats 0, cars 0) and `lean` (rad, + = leaning right).

**`SerializedVehicle`** gains optional `wear?: { oilL: number; tread: [number, number, number, number]; odometerM:
number }`, `craft?: { speed: number; vy: number; yaw: number; pitch: number; roll: number }`, `pushBar?: boolean`.
`serialize()` always writes them (craft only for crafts); `restore` reads them when present (absent: full oil and
tread, odometer 0, craft at rest with the yaw from the quaternion).

**Car / bike path** (control `car` | `bike`):
- Wear inputs per `preStep`: per wheel `mu *= treadGrip(tread[i], env.wetness, model.wear)` (§5.5). Slipping wheel
  `i` = it locked this step (`absOut.locked`) or (`handbrake && rear && absSpeed > 3`).
- `postStep`: `stepWear(...)` with `engineKw` (already computed), `distanceM = absSpeed * dt`, running flag and the
  slip flags (kept in a `Uint8Array(4)` field); subtract the returned `engineWear` from `damage.engineHealth` (and fail
  the engine below `failBelow`, emitting `vehicle:engineFailed` once, as an impact does).
- Bike (control `bike`): after `ctl.updateVehicle`, upright assist: with the chassis basis already computed in
  `preStep` (`rx..bz` + `ry = 2(qx·qy + qw·qz)`), roll `φ = asin(clamp(ry, -1, 1))` (positive = right side up),
  forward axis `f = (-bx, -by, -bz)`, roll rate `ω = angvel · f`; torque impulse `τ = -(uprightStiffness·φ +
  uprightDamping·ω) · mass · dt` applied along `f` with `body.applyTorqueImpulse({x: f.x·τ, y: f.y·τ, z: f.z·τ}, true)`
  (scratch object, no allocation). Lean (visual) in `postStep`: `lean = clamp(atan(v² · tan(steerAngle) / (wheelbase ·
  9.81)), ±maxLeanDeg)` with `v = speed`, sign so that steering right leans right (+). Pedal bikes: `engineRunning()`
  ignores fuel and stalls; no fuel burn; `fuelEmpty` never emitted.
- `writeLook` writes `VehicleLook.lean[eid]` (0 for cars) and `VehicleLook.rotor[eid] = 0`.

**Craft path** (control `boat` | `helicopter` | `drone`), built in the constructor instead of the dynamic body:
- `RigidBodyDesc.kinematicPositionBased()` at the pose; cuboid collider with the body dimensions,
  `COLLISION_EVENTS`; `physics.registerBody(eid, body)`; **no** ray-cast controller (`controller` becomes
  `DynamicRayCastVehicleController | null`, every use guarded); a character controller
  `physics.raw.createCharacterController(0.02)` with `disableSnapToGround()`, `setSlideEnabled(true)`,
  `setApplyImpulsesToDynamicBodies(false)`; filter predicate `(c) => c.handle !== ownHandle &&
  !physics.isGround(c.handle)`; `dispose` removes the character controller (`physics.raw.removeCharacterController`).
- `clearance = model.body.groundClearance + model.body.height / 2` (the body-centre height above the floor / water).
- `preStep(dt, env)`: `forward = c.reverse ? -c.throttle : c.throttle - c.brake`, `steer = c.steer`, `lift = c.lift ??
  0`; `engineOk = engineOn && fuelL > 0 && !engineFailed`; `stepCraft(...)`; then the boat rule: when
  `env.isWater` exists and the point `(x + dx, z + dz)` is not water, set `dx = dz = 0` and `speed = 0`;
  `computeColliderMovement(collider, {dx, dy, dz}, EXCLUDE_SENSORS, undefined, predicate)`; if
  `numComputedCollisions() > 0` and the horizontal requested length ≥ `computedMovement` horizontal length + 0.01, it
  hit something: when `|speed| ≥ damage.minImpactSpeed` apply `applyImpact(damage, 0, -1, |speed|, -1, spec, rng,
  impact)` (front zone) and emit `vehicle:damaged` in `postStep` (store a pending impact); set `speed = 0`. A
  helicopter landing with `vy < -4` m/s applies the same impact with `|vy|`. `setNextKinematicTranslation(pos +
  computed)` and `setNextKinematicRotation(quaternion of yaw, pitch, roll)` (YXZ order: yaw about Y, then pitch about
  X, then roll about Z; scratch quaternion maths, no THREE).
- Fuel: `fuelBurnLiters(engineKw, dt, model.fuel)` with `engineKw = maxPowerKw × load`, `load` = boat `|forward|`,
  helicopter airborne `0.5 + 0.5·max(|forward|, max(lift, 0))`, helicopter landed `0.15`, drone `0.5`; zero when the
  engine is off. Oil and tread are not used by crafts (oil still drains for the boat and helicopter by `engineKw`).
- `postStep`: telemetry (`speed`, `groundSpeed = |speed|`, `rpm = engineOk ? idleRpm + (redlineRpm - idleRpm)·load :
  0`, `gear 1`, `airborne = altitudeM > 0.3` (boat false), `altitudeM`), the pending impact events,
  `VehicleLook.rotor[eid] = engineOk ? (helicopter/drone 1, boat 0) : 0`, lights as for cars.
- `wheelPose(i, out)` for crafts returns the static hub of `wheelLocalPositions`-style numbers with `inContact
  false`, `spin 0`, `steer 0` (the renderer draws no wheels for crafts anyway). `burstTire` returns false for crafts.

### 5.5 Wear (`src/vehicles/wear.ts`, pure) — tests

```ts
export interface WearState { oilL: number; readonly tread: Float32Array /* 4 */; odometerM: number }
export interface WearInputs { engineKw: number; dt: number; distanceM: number; running: boolean; slipping: Uint8Array /* 4 */ }
export function createWearState(spec: WearSpec): WearState;          // full oil, tread 1, odometer 0
/** Updates `s` in place; returns the engine health to subtract this step (0 unless the oil is empty and the engine runs). */
export function stepWear(s: WearState, spec: WearSpec, i: WearInputs): number;
/** Grip factor of one tyre: lerp(minTreadGrip - wetTreadPenalty * wetness, 1, tread) clamped to [0.3, 1]. */
export function treadGrip(tread: number, wetness: number, spec: WearSpec): number;
```
`stepWear`: `oilL -= running ? engineKw * dt / 3600 * oilPerKWh : 0` (≥ 0); each tread `-= distanceM / 1000 *
treadPerKm + (slipping[i] ? treadSlipPerS * dt : 0)` (≥ 0); `odometerM += distanceM`; return `running && oilL <= 0 ?
oilWearPerS * dt : 0`. Tests: oil falls by `kWh × oilPerKWh`; tread falls with distance and faster with slip;
`treadGrip(1, w) = 1`, `treadGrip(0, 0) = minTreadGrip`, wet bald < dry bald; engine wear only with empty oil; a
DrivableVehicle driven 2 km loses tread ≈ `2 × treadPerKm` and its odometer reads ≈ 2 km; `changeOil`,
`replaceTires`, `condition` round-trip through `serialize` / `restore`.

### 5.6 `VehicleLook` additions (`src/vehicles/components.ts`)

```ts
export const TRIM = { pushBar: 1, spotlight: 2, hiddenBar: 4, noBar: 8 } as const;
VehicleLook.lean: Float32Array(MAX_ENTITIES)   // rad, + = right side down
VehicleLook.rotor: Float32Array(MAX_ENTITIES)  // 0..1 rotor speed
VehicleLook.trim: Uint8Array(MAX_ENTITIES)     // TRIM bits
/** TRIM bits for a build: pushBar when the model has a push bumper and build.pushBar; spotlight when the model has one and `spotlight`; hiddenBar / noBar from the livery's light-bar style. */
export function trimBits(model: VehicleModel, pushBar: boolean, spotlight: boolean, lightbarStyle: 'roof' | 'hidden' | 'none'): number;
```
`attachVehicleLook` resets the three (trim default: `trimBits(model, true, true, 'roof')` for the model's own
equipment, i.e. Phase 1-6 look unchanged; it takes the model through `VEHICLE_MODELS[modelIndex]`).

### 5.7 Player module (`src/player/**`)

- `PLAYER_MODE = { onFoot: 0, driving: 1, remote: 2 }`, `PLAYER_MODE_NAMES = ['onFoot', 'driving', 'remote']`,
  `PlayerModeName = 'onFoot' | 'driving' | 'remote'`.
- `PlayerModeMachine.remote(eid: number): boolean` — only from on foot, eid > 0; `endRemote(): boolean` — only from
  remote, back to on foot with vehicle 0; `vehicle` returns the drone's eid in remote; `reset(mode, vehicle)` accepts
  remote. `enter` / `exit` refuse while remote.
- `exitPoint(c, side, out, offset = EXIT_OFFSET)` gains the optional `offset` (boats use `halfWidth + 2`, §20).
- `readDriverInput` fills `out.lift = input.axis('vehicle.lift')`; the player `DriverInput` gains `lift?: number`.
- Tests: remote transitions and events; `exitPoint` offset; `readDriverInput` lift.

### 5.8 Input actions (`src/input/actions.ts`, `bindings.ts`)

`'vehicle.lift': { kind: 'axis', label: 'Climb / descend (aircraft)', bipolar: true }` bound to `key('Space')`,
`key('ShiftLeft', -1)` (both shared with handbrake / sprint by context: aircraft have no handbrake, a remote drone pilot
does not walk); `'fleet.menu': { kind: 'button', label: 'Fleet / garage panel' }` → `key('Quote')`; `'drone.toggle':
{ kind: 'button', label: 'Deploy / recall drone' }` → `key('Equal')`. Extend the bindings tests: `Quote` and `Equal`
collide with no other default; the two lift keys are documented shared keys.

### 5.9 Tests (`test/vehicles/**`, `test/player/**`, `test/input/**`)

`model.test.ts`: all 28 models parse; new ones are role police, listOrder 2, trafficWeight 0; Phase 1-6 model
indices unchanged (patrol_sedan / patrol_suv / tactical_truck keep their index); every bad craft / bike / cargo
section is rejected with its path; `damageSpecFor`. `fleetModels.test.ts` (use `test/vehicles/harness.ts`): each
`car` / `bike` model reaches 8 m/s within 20 s on flat asphalt and stops with the brake; the motorcycle stays upright
(|roll| < 0.17 rad) through a 30 s slalom at 12 m/s and `telemetry.lean` has the steering's sign; the bicycle burns
no fuel; a boat with `isWater = (x) => x < 50` stops at x ≈ 50; a helicopter climbs to 50 m and lands; a drone with an
anchor never leaves `rangeM`; crafts serialize / restore bit-identically (two 300-step runs, one restored at step 150);
`pushBar: false` front hits use the base zone strength.

## 6. Livery schema, validator, painter [livery] — wave 1

Owns `src/livery/**`, `src/data/livery/**`, `test/livery/**`. Imports pre-existing `LIGHTBAR_PATTERNS`
(`src/police/lightbar.ts`) and `SIREN_TONE_NAMES` (`src/police/data.ts`) only.

### 6.1 Document (`src/livery/types.ts`)

```ts
export const LIVERY_FORMAT = 'patrol-livery';
export const LIVERY_VERSION = 1;
export const LIVERY_LIMITS = { layers: 32, textChars: 24, polygonPoints: 24, nameChars: 40, fileBytes: 65536, loadoutEntries: 40 } as const;
export type Hex = string; // '#rrggbb' lowercase or uppercase

export interface LiveryDoc {
  format: 'patrol-livery';
  version: 1;
  id: string;          // /^[a-zA-Z0-9_-]{1,40}$/
  name: string;        // 1..40 chars
  author: string;      // 0..40 chars
  base: { color: Hex; finish: 'gloss' | 'matte' | 'metallic' };
  wrap: null | { kind: 'solid' | 'twoTone' | 'fade' | 'pinstripe'; colors: Hex[] /* 1..3 */; split: number /* 0..1 */ };
  layers: LiveryLayer[];
  lights: { style: 'roof' | 'hidden' | 'none'; pattern: string /* LIGHTBAR_PATTERNS id */; siren: 'wail' | 'yelp' | 'phaser' | 'hilo' };
  equipment: { pushBar: boolean; spotlight: boolean; partition: boolean };
  loadout: null | { trunk: Record<string, number> /* ids /^[a-zA-Z][a-zA-Z0-9]*$/, ints 0..99 */; rack: string[] /* ≤ 4 */ };
}
export type Face = 'sides' | 'left' | 'right' | 'hood' | 'roof' | 'front' | 'rear';
export type LiveryLayer =
  | { type: 'stripe'; face: Face; u0: number; u1: number; v: number; height: number; angleDeg: number; color: Hex; reflective: boolean }
  | { type: 'shape'; face: Face; shape: ShapeKind; u: number; v: number; w: number; h: number; rotationDeg: number; color: Hex;
      outline: Hex | null; reflective: boolean; starPoints?: number; points?: [number, number][] }
  | { type: 'text'; face: Face; text: string; u: number; v: number; size: number; color: Hex; outline: Hex | null;
      font: 'sans' | 'serif' | 'mono' | 'stencil'; weight: 'normal' | 'bold'; italic: boolean; reflective: boolean }
  | { type: 'checker'; face: Face; v: number; height: number; cells: number; rows: number; colors: [Hex, Hex]; reflective: boolean };
```
Ranges: `u, u0, u1, v ∈ [0, 1]`, `u0 < u1`; `height ∈ (0, 1]`; `angleDeg ∈ [-45, 45]`; `w, h ∈ (0, 1]`;
`rotationDeg ∈ [-180, 180]`; `size ∈ [0.05, 1]` (fraction of the face height); `starPoints` int 3..12 (only for
`star`, default 5); `points` 3..24 pairs in [−1, 1] (required for `polygon`, forbidden otherwise); `cells` int 2..40;
`rows` int 1..3; `text` 1..24 printable characters (code points 0x20-0x7E plus Latin-1 0xA0-0xFF), may contain the
tokens `{unit}` and `{dept}`.

### 6.2 Validation and import / export (`src/livery/schema.ts`) — mandatory tests

```ts
export function parseLivery(json: unknown): LiveryResult;      // never throws; collects every error ("layers[3].color: must be #rrggbb")
export function importLivery(text: string): LiveryResult;      // > fileBytes → error 'file: larger than 64 KiB'; JSON.parse error → 'file: not valid JSON'
export function exportLivery(doc: LiveryDoc): string;          // JSON.stringify(canonical(doc), null, 2) + '\n'
export function canonicalLivery(doc: LiveryDoc): LiveryDoc;    // a deep copy with keys in the §6.1 declaration order; optional keys omitted when undefined
export function newLiveryId(base: string, taken: readonly string[]): string; // slug of base ([a-zA-Z0-9_-], ≤ 32) + '-2', '-3', ... until unused
```
Rules: unknown top-level or layer keys are errors ("layers[0].foo: unknown key"); missing required keys are errors;
`format` must equal `patrol-livery` and `version` 1 (version > 1: "version: newer than supported (1)"); colours are
normalized to lowercase in the returned doc; `lights.pattern` must be a `LIGHTBAR_PATTERNS` id and `siren` a
`SIREN_TONE_NAMES` value; the loadout is only checked for shape (gear validates it against the vehicle at apply time).
Mandatory tests (`test/livery/schema.test.ts`): every shipped default validates; `importLivery(exportLivery(d))`
deep-equals `canonicalLivery(d)` for every default and for a fuzzed doc with every layer type (round trip);
`exportLivery` is stable (export of an import equals the original text); each rule above rejected with the expected
path (≥ 20 cases: wrong format, version 2, bad hex, u0 ≥ u1, 33 layers, 25-char text, polygon with 2 points, points on
a star, unknown pattern, unknown siren, unknown key, 70 KiB file, non-JSON text, loadout count 100, ...); errors never
throw for arbitrary input (`null`, arrays, numbers, deeply nested junk).

### 6.3 Default liveries (`src/data/livery/<id>.json`, one doc per file; `src/livery/defaults.ts`)

`DEFAULT_LIVERIES: readonly LiveryDoc[]` loaded with `import.meta.glob('../data/livery/*.json', { eager: true,
import: 'default' })`, each passed through `parseLivery` (throw `Error('<file>: <errors>')` on failure; file stem must
equal `id`), sorted by id. `defaultLivery(id): LiveryDoc` throws on unknown. Ship these 17 (all text generic; colours
listed; every marked livery has a reflective stripe on `sides` and `{unit}` on `roof`):

| id | base | wrap | key layers | lights style / pattern / siren | equipment |
|---|---|---|---|---|---|
| patrolMarked | #f2f2f2 | – | sides stripe #1d3f8f v .55 h .18 reflective; sides text "POLICE" #1d3f8f bold v .35 size .3 u .55; sides shape star #c9a646 u .2 v .4 w .18 h .5; roof text "{unit}" #111111 size .7; rear text "{unit}" | roof / alternate / wail | push, spot, partition |
| supervisorMarked | #f2f2f2 | – | as patrolMarked + sides text "SUPERVISOR" size .18 v .75 | roof / quad / yelp | push, spot, no partition |
| unmarkedGrey | #3a3f47 | solid [#3a3f47] | none | hidden / quad / yelp | no push, spot, partition |
| unmarkedBlue | #1f2a3a | solid [#1f2a3a] | none | hidden / takedown / phaser | no push, spot, partition |
| trafficMarked | #f2f2f2 | – | sides checker v .62 h .12 cells 24 rows 2 [#1d3f8f, #f2f2f2] reflective; sides text "TRAFFIC" | roof / sweep / hilo | push, spot, partition |
| k9Marked | #f2f2f2 | – | patrolMarked stripe + text "K9 UNIT" + "CAUTION: POLICE DOG" small on rear | roof / alternate / wail | push, spot, partition |
| motorMarked | #f2f2f2 | – | sides text "POLICE" size .45; sides stripe reflective | roof / quad / yelp | none |
| bicyclePatrol | #1c1f24 | – | sides text "POLICE" #f2f2f2 size .5 reflective | none / cruise / wail | none |
| atvPatrol | #2b2f36 | – | sides text "POLICE" #f2f2f2 reflective | roof / alternate / wail | none |
| swatTactical | #1c1f24 | – | sides text "TACTICAL" #c9c9c9 size .25; roof "{unit}" #c9c9c9 | roof / takedown / hilo | push, spot |
| armoredRescue | #2a2e33 | – | sides text "RESCUE" #c9c9c9; front text "POLICE" | roof / takedown / hilo | push, spot |
| prisonerTransport | #f2f2f2 | – | sides text "PRISONER TRANSPORT" size .2; stripe | roof / alternate / wail | partition |
| commandPost | #f2f2f2 | – | sides text "MOBILE COMMAND" size .25; checker band | roof / cruise / hilo | spot |
| crimeLab | #f5f5f2 | – | sides text "CRIME SCENE UNIT" size .22; stripe #2a2e33 | roof / cruise / wail | spot |
| marinePatrol | #f2f2f2 | – | sides text "MARINE PATROL"; sides stripe #1d3f8f reflective | roof / alternate / yelp | spot |
| airSupport | #1f2a3a | – | sides text "AIR SUPPORT" #f2f2f2; sides text "{unit}" | roof / cruise / wail | spot |
| droneUnit | #2b2f36 | – | roof text "{unit}" #f2f2f2 | none / cruise / wail | none |

`loadout` is `null` in every default (the fleet unit's loadout preset applies).

### 6.4 Shapes (`src/livery/shapes.ts`, pure) — tests

```ts
/** Closed polygon of `kind` as flat x,y pairs in [-1, 1] (y down), appended to `out` (cleared first). */
export function shapePolygon(kind: ShapeKind, opts: { starPoints?: number; points?: readonly (readonly [number, number])[]; segments?: number }, out: number[]): number[];
```
`rect` 4 corners; `roundedRect` corner radius 0.25 with 4 segments per corner; `circle` / `ellipse` `segments ?? 32`
points on the unit circle (the caller scales w/h); `star` `2n` points alternating radius 1 and 0.45 starting at the
top (−y); `shield` `[(−1,−1), (1,−1), (1,0.2), (0,1), (−1,0.2)]` with the lower edges subdivided by 6 points along a
quadratic curve; `chevron` 6 points (a "^" of thickness 0.45); `triangle` `[(0,−1), (1,1), (−1,1)]`; `arch` a half
annulus (outer radius 1, inner 0.55, 12 segments each side); `polygon` = the user `points`. Tests: point counts,
bounds within [−1, 1], star alternation, polygon pass-through. The badge / patch designers (ui) reuse this.

### 6.5 Painter and shell atlas (`src/livery/painter.ts`, pure over an interface) — tests

```ts
export interface Canvas2DLike {
  fillStyle: string; strokeStyle: string; lineWidth: number; font: string; textAlign: string; textBaseline: string; globalAlpha: number;
  save(): void; restore(): void; translate(x: number, y: number): void; rotate(a: number): void; scale(x: number, y: number): void;
  beginPath(): void; moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; closePath(): void;
  rect(x: number, y: number, w: number, h: number): void; fill(): void; stroke(): void; clip(): void;
  fillRect(x: number, y: number, w: number, h: number): void; clearRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number, maxWidth?: number): void; strokeText(text: string, x: number, y: number, maxWidth?: number): void;
}
export type AtlasFace = 'left' | 'right' | 'hood' | 'roof' | 'front' | 'rear';
export const SHELL_ATLAS: { readonly width: 1024; readonly height: 512;
  readonly regions: Readonly<Record<AtlasFace, readonly [x: number, y: number, w: number, h: number]>> } = {
  width: 1024, height: 512,
  regions: { left: [0, 0, 1024, 192], right: [0, 192, 1024, 192], hood: [0, 384, 512, 128], roof: [512, 384, 256, 128],
             front: [768, 384, 128, 128], rear: [896, 384, 128, 128] } };
export interface PaintOptions { unit: string; dept: string; reflectiveOnly: boolean }
/** Clears the atlas and paints `doc` (wrap first, then layers in order); `reflectiveOnly` paints only reflective layers in white (emissive map). */
export function paintLivery(ctx: Canvas2DLike, doc: LiveryDoc, opts: PaintOptions): void;
export function resolveText(text: string, unit: string, dept: string): string;
```
Face orientation (contract shared with the shell geometry in §10.3): every region is the face **seen from outside**,
canvas x left→right as the viewer sees it, canvas y top→bottom. `left` (−X side): canvas x = 0 at the front; `right`
(+X): x = 0 at the rear; `hood` / `roof` seen from above with the front at the top, x = 0 at the vehicle's left (−X);
`front` seen from ahead: x = 0 at the vehicle's right (+X); `rear` seen from behind: x = 0 at the vehicle's left
(−X). A layer at `(u, v)` paints at `region.x + u·w, region.y + v·h`. `face: 'sides'` paints on `left` at `(u, v)` and
on `right` at `(1 − u, v)` with `angleDeg` / `rotationDeg` negated (mirrored placement, never mirrored glyphs).
Wraps: `solid` fills every region with `colors[0]`; `twoTone` fills the side regions above `split` (v < split) with
`colors[0]` and below with `colors[1]`, top regions `colors[0]`; `fade` 8 bands lerping `colors[0]→colors[1]` along v;
`pinstripe` = `solid` + a 3 px `colors[1]` line at `v = split` on both sides. Text: font string `${italic ? 'italic '
: ''}${weight} ${size·h}px ${family}` with family `sans-serif | serif | monospace | 'Arial Black', sans-serif`
(`stencil` uses a heavy sans fallback; no web fonts), `textAlign 'center'`, `textBaseline 'middle'`, outline stroked
at `max(2, size·h·0.08)` px before the fill, `maxWidth = 0.96·w`. Checker: `cells` columns × `rows` rows between
`v - height/2` and `v + height/2` across the full width, alternating colours. Stripes: a parallelogram from `u0` to
`u1` of height `height·h` centred on `v`, sheared by `angleDeg`.
Tests (`test/livery/painter.test.ts`) with a recording fake context: a `sides` text draws twice (left and right
regions) at mirrored x; `reflectiveOnly` skips non-reflective layers and paints white; `{unit}` is replaced; the
call sequence for a doc is identical on repeated paints (deterministic); every default paints without throwing.

## 7. Uniforms, outfits, character profile, pronouns [uniform] — wave 1

Owns `src/uniform/**`, `src/data/uniform/**`, `test/uniform/**`. Imports `createRng` (pre-existing) only.

### 7.1 Data (`src/data/uniform/uniforms.json`, validator `parseUniformData(json, file)` → `UNIFORM_DATA`)

```json
{ "version": 1,
  "classes": [
    { "id": "classA", "label": "Class A (dress)", "top": "#1b2a44", "bottom": "#141c2b", "accent": "#c9a646", "sleeves": "long", "tie": true,  "jacket": true,  "hat": "peakedCap",      "carrier": "internal",     "belt": "dress" },
    { "id": "classB", "label": "Class B (duty)",  "top": "#24375a", "bottom": "#18202e", "accent": "#c9a646", "sleeves": "short","tie": false, "jacket": false, "hat": "none",           "carrier": "internal",     "belt": "duty" },
    { "id": "tactical", "label": "Tactical utility", "top": "#2a2f36", "bottom": "#2a2f36", "accent": "#9aa0a6", "sleeves": "long", "tie": false, "jacket": false, "hat": "ballCap", "carrier": "external", "belt": "duty" },
    { "id": "bike", "label": "Bike patrol", "top": "#c8d43a", "bottom": "#1c1f24", "accent": "#1c1f24", "sleeves": "short", "tie": false, "jacket": false, "hat": "bikeHelmet", "carrier": "external", "belt": "duty", "shorts": true },
    { "id": "motor", "label": "Motor", "top": "#24375a", "bottom": "#1c1f24", "accent": "#c9a646", "sleeves": "long", "tie": false, "jacket": true, "hat": "motorHelmet", "carrier": "internal", "belt": "duty", "tallBoots": true },
    { "id": "swat", "label": "SWAT", "top": "#2e3527", "bottom": "#2e3527", "accent": "#7d8670", "sleeves": "long", "tie": false, "jacket": false, "hat": "tacticalHelmet", "carrier": "plateCarrier", "belt": "duty" },
    { "id": "detective", "label": "Detective (plain clothes)", "top": "#6b6f78", "bottom": "#2b2d33", "accent": "#c9a646", "sleeves": "long", "tie": true, "jacket": true, "hat": "none", "carrier": "none", "belt": "plain", "badgeOnBelt": true }
  ],
  "ranks": [
    { "id": "officer", "label": "Officer", "insignia": [] },
    { "id": "corporal", "label": "Corporal", "insignia": ["chevron", "chevron"] },
    { "id": "sergeant", "label": "Sergeant", "insignia": ["chevron", "chevron", "chevron"] },
    { "id": "lieutenant", "label": "Lieutenant", "insignia": ["bar"] },
    { "id": "captain", "label": "Captain", "insignia": ["bar", "bar"] },
    { "id": "chief", "label": "Chief", "insignia": ["star", "star", "star"] }
  ],
  "skinTones": ["#f3d5bf", "#e8bf9f", "#d6a07c", "#c68e6b", "#a86d4c", "#8a5a3c", "#6e432a", "#4f2e1c", "#3a2014"],
  "hairColors": ["#0f0d0b", "#2a1d14", "#4a3020", "#7a5230", "#b08a55", "#d9c08a", "#8a8a8a", "#d8d8d8", "#7a2e1e"],
  "vehiclePolicy": { "motor": ["motor"], "bicycle": ["bike"], "swat": ["swat", "tactical"], "armored": ["swat", "tactical"] },
  "department": { "name": "City Police", "initials": "CP", "patch": { "shape": "shield", "base": "#1d3f8f", "border": "#c9a646", "accent": "#f2f2f2", "initials": "CP", "text": "CITY POLICE" },
                  "badge": { "shape": "star", "starPoints": 7, "metal": "#c9a646", "enamel": "#1d3f8f", "text": "CITY" } }
}
```
Validator: ids unique and exactly `UNIFORM_CLASSES` / `RANK_IDS`; colours `#rrggbb`; `hat` in `HAT_IDS`, `carrier` in
`CARRIER_IDS`, `belt` in `dress duty plain`; insignia kinds in `chevron bar star`; ≥ 4 skin tones; vehiclePolicy keys
are fleet class strings (§4.1), values uniform class ids.

### 7.2 Outfit types and parts (`src/uniform/types.ts`, `src/uniform/parts.ts`)

```ts
export interface PatchSpec { shape: 'shield' | 'circle' | 'roundedRect' | 'arch' | 'polygon'; points?: [number, number][];
  base: number; border: number; accent: number; initials: string /* ≤ 4 */; text: string /* ≤ 16 */ }
export interface BadgeSpec { shape: 'star' | 'shield' | 'circle' | 'ellipse' | 'polygon'; starPoints?: number; points?: [number, number][];
  metal: number; enamel: number; text: string /* ≤ 12 */ }
export interface OutfitSpec {
  uniform: UniformClass; hat: HatId | 'default'; carrier: CarrierId | 'default'; cold: ColdId;
  hairStyle: HairStyle; hairColor: number; namePlate: boolean; patch: PatchSpec; badge: BadgeSpec;
  colors: { top: number; bottom: number } | null;  // null = the class colours
}
export interface OutfitContext { lastName: string; rank: RankId }
```
Accessory boxes are in the **part frames of the 1.75 m reference figure** used by `PeopleRenderer` (§10.4): x right,
y up, z back (+Z is behind the figure; the chest front is z = −0.12); torso frame origin = pelvis pivot (torso box
0.42 × 0.58 × 0.24 spans y 0..0.58); head frame origin = neck (head box 0.22 × 0.24 × 0.22 spans y 0.02..0.26);
arm frames origin = shoulder, the arm box 0.11 × 0.6 × 0.11 spans y −0.6..0; thigh / shin frames origin = hip /
knee, boxes 0.15 × 0.425 × 0.16 spanning y −0.425..0; pelvis frame = the body frame at the pelvis (does not bend with
the torso). `parts.ts` holds the TS tables (`HAT_BOXES: Record<HatId, readonly Omit<AccessoryBox, 'color'>[]>` in the
head frame, carrier boxes in the torso frame, etc.). Required geometry (centre x, y, z; size sx, sy, sz; metres):

| Part | Boxes |
|---|---|
| peakedCap | crown (0, 0.27, 0.01; 0.24, 0.07, 0.25) + peak (0, 0.235, −0.13; 0.2, 0.015, 0.08) |
| campaign | brim (0, 0.25, 0; 0.4, 0.015, 0.4) + crown (0, 0.3, 0; 0.2, 0.1, 0.2) |
| ballCap | crown (0, 0.265, 0.01; 0.235, 0.06, 0.24) + bill (0, 0.24, −0.15; 0.17, 0.012, 0.1) |
| beanie / watchCap | (0, 0.255, 0; 0.235, 0.08, 0.235) |
| motorHelmet / tacticalHelmet | shell (0, 0.2, 0.01; 0.28, 0.22, 0.29), visor for motor (0, 0.15, −0.15; 0.24, 0.08, 0.02) |
| bikeHelmet | (0, 0.27, 0.01; 0.25, 0.08, 0.3) |
| carrier internal | torso slab (0, 0.33, 0; 0.43, 0.36, 0.26) in the shirt colour (bulk only) |
| carrier external | (0, 0.33, 0; 0.45, 0.4, 0.28) colour #2a2d33 + 3 pouches (−0.12/0/0.12, 0.22, −0.15; 0.08, 0.1, 0.04) |
| plateCarrier | (0, 0.33, 0; 0.47, 0.42, 0.3) colour #3b4232 + pouches as external |
| belt duty | (0, 0.02, 0; 0.44, 0.07, 0.26) #15161a in the pelvis frame + holster (0.24, −0.06, 0; 0.06, 0.16, 0.1) |
| belt dress | (0, 0.02, 0; 0.43, 0.05, 0.25) accent colour |
| tie | (0, 0.38, −0.125; 0.05, 0.3, 0.01) #15161a |
| jacket | torso (0, 0.3, 0; 0.44, 0.62, 0.26) top colour darkened 15 %; arms sleeve (0, −0.28, 0; 0.12, 0.58, 0.12) on both arms |
| cold jacket / parka / rainShell | torso (0, 0.3, 0; 0.46, 0.64, 0.28) #1d2330 / #1d2330 / #c8d43a; parka adds hood (0, 0.18, 0.12; 0.26, 0.12, 0.08) in the head frame; arms (0, −0.28, 0; 0.13, 0.58, 0.13) |
| shorts (bike) | no boxes: `OutfitDef.shins` = `SKIN_SHINS` (the sentinel `0x1000000`), which `figureAppearance` (§7.5) replaces by the skin colour, so the renderer draws bare shins; trousers = `shins: null` |
| tall boots (motor) | both shins (0, −0.28, 0; 0.17, 0.3, 0.18) #101010 |
| patch | each arm (sign·0.06, −0.08, 0; 0.012, 0.09, 0.07) patch base colour (x outward: −0.06 left arm, +0.06 right arm) |
| badge | chest left (−0.11, 0.42, −0.125; 0.06, 0.07, 0.01) metal colour (detective: on the belt, pelvis frame (−0.12, 0.02, −0.135)) |
| name plate | chest right (0.11, 0.42, −0.125; 0.08, 0.02, 0.01) #c9a646 (only when `namePlate` and the class is not detective) |
| rank chevrons | each arm (sign·0.06, −0.18 − 0.035·k, 0; 0.012, 0.02, 0.08) accent colour, k = 0.. |
| rank bars / stars | collar, both sides (sign ±1): bar k at (sign·0.12, 0.555 − 0.02·k, −0.1; 0.04, 0.012, 0.012); star k at (sign·(0.09 + 0.03·k), 0.555, −0.1; 0.025, 0.025, 0.012) — so a lieutenant has 2 bar boxes, a chief 6 star boxes |
| hair styles | `long` (0, 0.1, 0.1; 0.22, 0.24, 0.06), `bun` (0, 0.2, 0.14; 0.09, 0.09, 0.08), `ponytail` (0, 0.1, 0.15; 0.06, 0.2, 0.05), `braids` two (±0.08, 0.06, 0.1; 0.04, 0.2, 0.04); `buzz` = hair colour only; `bald` hides hair |

`OutfitDef` (final, replaces the §4.2 sketch): `{ id: string; top: number; bottom: number; shins: number | null;
boxes: readonly AccessoryBox[]; hideHair: boolean }` with `export const SKIN_SHINS = 0x1000000`; at most
`MAX_OUTFIT_BOXES = 24` boxes (validated, throw in `buildOutfit`). `top` / `bottom` = `spec.colors` or the class
colours; a cold-weather layer does not change `top` (its torso box covers the shirt).

### 7.3 Builders (`src/uniform/outfit.ts`) — mandatory determinism tests

```ts
/** Pure: the boxes of `spec` for `ctx` (hat → hair → carrier → cold → belt → tie → patches → badge → plate → insignia). */
export function buildOutfit(spec: OutfitSpec, ctx: OutfitContext): OutfitDef;
/** Deterministic AI spec from createRng(seed).stream(`uniform:${callsign}`): role patrol → classB (70 %) / tactical (30 %), hat none 60 % / ballCap 25 % / peakedCap 15 %, cold none unless `coldC` < 8 (then jacket); swat → swat; supervisor → classB with peakedCap; detective → detective; hair style / colour from the stream; patch / badge from the department. */
export function aiOutfitSpec(seed: number, callsign: string, role: 'patrol' | 'supervisor' | 'swat' | 'detective', coldC: number): OutfitSpec;
export function defaultOutfitSpec(uniform?: UniformClass): OutfitSpec;
/** Whether the uniform class suits the fleet class (vehiclePolicy; classes without a rule allow anything). */
export function uniformAllowed(uniform: UniformClass, fleetClass: string): boolean;
```
`id` = a stable string of the spec (`${uniform}/${hat}/${carrier}/${cold}/${hairStyle}/${rank}/${namePlate}`) so the
integrator can dedupe outfit tables. Mandatory tests (`test/uniform/outfit.test.ts`): `buildOutfit` twice → deep
equal; `aiOutfitSpec(seed, cs, role)` twice → deep equal, across 50 callsigns at least two different specs, different
seeds can differ; insignia count per rank (sergeant 3 chevrons per arm = 6 boxes); helmets set `hideHair`; bald hides
hair; detective has no name plate and the badge on the belt; every box colour is an int 0..0xffffff; box count ≤ 24
for every class × hat × carrier × cold × hair combination (exhaustive loop); class colours come from the data.

### 7.4 Character profile (`src/uniform/character.ts`) — tests

```ts
export interface CharacterProfile {
  version: 1;
  firstName: string; lastName: string;          // 1..24 chars each, letters, spaces, ' . -
  badge: string;                                // /^[0-9]{3,6}$/
  pronouns: PronounSet;
  body: { heightM: number /* 1.5..2.05 */; build: number /* 0.8..1.3 */; shoulders: number /* 0.85..1.2 */; hips: number /* 0.85..1.2 */ };
  skin: number; hairStyle: HairStyle; hairColor: number;
  rank: RankId;
  outfit: OutfitSpec;
}
export interface CharacterSave { version: 1; profile: CharacterProfile }
export function parseCharacter(json: unknown): { ok: true; profile: CharacterProfile } | { ok: false; errors: string[] };
export function isCharacterSave(x: unknown): x is CharacterSave;
export function defaultCharacter(): CharacterProfile;        // "Jordan Doe", badge "4071", they/them, 1.75 m, build 1, skin #c68e6b, short #2a1d14, officer, classB
/** From a pre-v9 `officer { name, badge }`: strips a leading "Officer ", splits first / last at the first space (single word → lastName), keeps the badge when it is 3-6 digits. */
export function characterFromLegacy(name: string, badge: string): CharacterProfile;
export function displayName(p: CharacterProfile): string;   // `Officer ${firstName} ${lastName}` (rank label instead of Officer when rank ≠ officer)
```

### 7.5 Appearance (`src/uniform/appearance.ts`)

```ts
export interface FigureAppearance { skin: number; hair: number /* 0xFFFFFFFF = bald */; top: number; bottom: number; shins: number;
  height: number; build: number; shoulders: number; hips: number }
export function figureAppearance(p: CharacterProfile, outfit: OutfitDef): FigureAppearance;
```
`hair = outfit.hideHair || p.hairStyle === 'bald' ? 0xffffffff : p.hairColor`; `shins = outfit.shins === null ?
outfit.bottom : outfit.shins === SKIN_SHINS ? p.skin : outfit.shins`; `height / build / shoulders / hips` from
`p.body`; `top / bottom` from the outfit.

### 7.6 Pronouns and lines (`src/uniform/pronouns.ts`, `src/data/uniform/lines.json`) — tests

```ts
export const PRONOUN_PRESETS: Readonly<Record<'she' | 'he' | 'they', PronounSet>>;
// she: she/her/her/hers/herself singular; he: he/him/his/his/himself; they: they/them/their/theirs/themself plural
export function pronounLabel(p: PronounSet): string;          // 'she/her', 'they/them', custom 'xe/xem'
export function isPronounSet(x: unknown): x is PronounSet;    // custom: each word 1..12 letters
/** Replaces {they} {them} {their} {theirs} {themself} (and capitalised {They} ...), verb tokens {are} (is/are), {were} (was/were), {have} (has/have), {s} ('s'/'' after a verb stem), {name}, and any key of `vars` ({callsign}, {near}, ...). */
export function applyPronouns(template: string, p: PronounSet, vars: Readonly<Record<string, string>>): string;
export const CHARACTER_LINES: Readonly<Record<string, string>>;
```
`lines.json` (`{ "version": 1, "lines": { ... } }`): `officerDown`: "{callsign}, shots fired! {name} is hit, {they} {are}
down at {near}!", `vestStopped`: "{callsign}, I'm hit but the vest stopped it. I'm OK.", `damageReport`: "{name}
({pronouns}) reported that {they} {were} operating unit {unit} when it sustained {zone} damage at {speed} km/h{context}.
{They} {have} filed this report.", `reportHeader`: "Reporting officer: {name} ({pronouns}), badge {badge}.",
`inspection`: "{name} inspected unit {unit}: {result}.". Tests: each preset with each verb token ("she is", "they are",
"he has", "they have", "she report{s}" → "she reports", "they report"), capitalisation, custom sets, unknown tokens left
as-is.

## 8. Equipment catalog, policy and loadouts [gear] — wave 1

Owns `src/gear/**`, `src/data/gear/**`, `src/police/**`, `src/data/police/**`, `src/station/**`,
`src/data/station/**`, tests `test/gear/**`, `test/police/**`, `test/station/**`, `test/stationui/**`.

### 8.1 Officer item catalog (`src/data/gear/items.json`, `parseGearItems` → `GEAR_ITEMS`)

```json
{ "version": 1, "items": [
  { "id": "radio", "label": "Portable radio", "slot": "belt", "size": 1, "weightKg": 0.5 },
  { "id": "dutyBelt", "label": "Duty belt", "slot": "body", "size": 1, "weightKg": 0.7, "provides": { "belt": 10 } },
  { "id": "holster", "label": "Duty holster", "slot": "belt", "size": 1, "weightKg": 0.4, "retention": true },
  { "id": "sidearm", "label": "Duty pistol", "slot": "belt", "size": 0, "weightKg": 1.0, "armory": "sidearm", "requires": ["holster"] },
  { "id": "taser", "label": "TASER", "slot": "belt", "size": 1, "weightKg": 0.45, "armory": "taser" },
  { "id": "ocSpray", "label": "OC spray", "slot": "belt", "size": 1, "weightKg": 0.2, "armory": "ocSpray" },
  { "id": "baton", "label": "Expandable baton", "slot": "belt", "size": 1, "weightKg": 0.6, "armory": "baton" },
  { "id": "cuffs", "label": "Handcuffs", "slot": "belt", "size": 1, "weightKg": 0.3, "max": 2 },
  { "id": "flashlight", "label": "Flashlight", "slot": "belt", "size": 1, "weightKg": 0.3 },
  { "id": "medKit", "label": "Med kit", "slot": "belt", "size": 1, "weightKg": 0.6, "kit": { "firstAid": 1 } },
  { "id": "naloxone", "label": "Naloxone nasal spray", "slot": "belt", "size": 1, "weightKg": 0.05, "max": 3, "kit": { "naloxone": 1 } },
  { "id": "tourniquet", "label": "Tourniquet", "slot": "belt", "size": 1, "weightKg": 0.1, "max": 2, "kit": { "tourniquet": 1 } },
  { "id": "ballisticVest", "label": "Ballistic vest", "slot": "body", "size": 1, "weightKg": 3.2, "provides": { "vest": 4 }, "protection": 0.85 },
  { "id": "rifle", "label": "Patrol rifle", "slot": "longGun", "size": 1, "weightKg": 3.4, "armory": "rifle" },
  { "id": "shotgun", "label": "Patrol shotgun", "slot": "longGun", "size": 1, "weightKg": 3.6 },
  { "id": "lessLethalLauncher", "label": "Less-lethal launcher", "slot": "longGun", "size": 1, "weightKg": 3.2, "armory": "beanbag" },
  { "id": "ram", "label": "Door ram", "slot": "carry", "size": 2, "weightKg": 16, "kit": { "ram": 1 } },
  { "id": "halligan", "label": "Halligan bar", "slot": "carry", "size": 1, "weightKg": 5, "kit": { "halligan": 1 } },
  { "id": "k9Treats", "label": "K9 reward treats", "slot": "vest", "size": 1, "weightKg": 0.1, "max": 5, "kit": { "k9Treats": 1 } },
  { "id": "evidenceKit", "label": "Evidence kit", "slot": "vest", "size": 2, "weightKg": 1.5,
    "kit": { "evidenceKit": 1, "evidenceBags": 8, "evidenceMarkers": 8, "camera": 1, "fingerprintKit": 1, "sceneTape": 1 } }
] }
```
Fields: `slot` in `GEAR_SLOTS`; `size` int ≥ 0; `weightKg` ≥ 0; optional `max` (count cap, default 1), `provides`
(slot capacities), `retention` (the item takes a level 1..3), `armory` (an `ARMORY_ITEMS` id), `requires` (gear ids),
`kit` (trunk item id → count per unit; ids must exist in police `items.json`), `protection` (0..1). Capacities without
providers: `body 2`, `longGun 1`, `carry 2`, `belt 0`, `vest 0` (a belt or vest provides room). The class's external
carrier adds `vest +2` (passed in as `extraVestSlots`).

### 8.2 Policy and presets (`src/data/gear/policy.json`, `src/data/gear/loadouts.json`)

```json
{ "version": 1,
  "assignments": [
    { "id": "patrol", "label": "Patrol", "maxKg": 14, "required": ["radio", "dutyBelt", "holster", "sidearm", "cuffs", "flashlight", "ballisticVest"], "forbidden": [], "minRetention": 2, "maxLongGuns": 1 },
    { "id": "traffic", "label": "Traffic", "maxKg": 14, "required": ["radio", "dutyBelt", "holster", "sidearm", "cuffs", "flashlight", "ballisticVest"], "forbidden": ["ram"], "minRetention": 2, "maxLongGuns": 1 },
    { "id": "k9", "label": "K9 handler", "maxKg": 14, "required": ["radio", "dutyBelt", "holster", "sidearm", "cuffs", "flashlight", "ballisticVest", "k9Treats"], "forbidden": ["ram"], "minRetention": 2, "maxLongGuns": 1 },
    { "id": "motor", "label": "Motor officer", "maxKg": 10, "required": ["radio", "dutyBelt", "holster", "sidearm", "cuffs", "ballisticVest"], "forbidden": ["ram", "halligan", "rifle", "shotgun", "lessLethalLauncher"], "minRetention": 2, "maxLongGuns": 0 },
    { "id": "bicycle", "label": "Bike officer", "maxKg": 10, "required": ["radio", "dutyBelt", "holster", "sidearm", "cuffs", "flashlight", "ballisticVest"], "forbidden": ["ram", "halligan", "rifle", "shotgun", "lessLethalLauncher"], "minRetention": 2, "maxLongGuns": 0 },
    { "id": "swat", "label": "SWAT operator", "maxKg": 24, "required": ["radio", "dutyBelt", "holster", "sidearm", "ballisticVest"], "forbidden": [], "minRetention": 3, "maxLongGuns": 1 },
    { "id": "detective", "label": "Detective", "maxKg": 6, "required": ["radio", "holster", "sidearm", "cuffs"], "forbidden": ["rifle", "shotgun", "lessLethalLauncher", "ram", "halligan"], "minRetention": 1, "maxLongGuns": 0 },
    { "id": "supervisor", "label": "Supervisor", "maxKg": 14, "required": ["radio", "dutyBelt", "holster", "sidearm", "cuffs", "flashlight", "ballisticVest"], "forbidden": [], "minRetention": 2, "maxLongGuns": 1 },
    { "id": "marine", "label": "Marine unit", "maxKg": 12, "required": ["radio", "dutyBelt", "holster", "sidearm", "cuffs", "flashlight"], "forbidden": ["ram", "halligan"], "minRetention": 2, "maxLongGuns": 1 },
    { "id": "air", "label": "Air crew", "maxKg": 10, "required": ["radio", "holster", "sidearm"], "forbidden": ["ram", "halligan", "shotgun", "lessLethalLauncher"], "minRetention": 2, "maxLongGuns": 0 }
  ],
  "fleetAssignment": { "patrol": "patrol", "supervisor": "supervisor", "unmarked": "detective", "traffic": "traffic", "k9": "k9", "motor": "motor", "bicycle": "bicycle", "atv": "patrol", "swat": "swat", "armored": "swat", "transport": "patrol", "command": "supervisor", "lab": "detective", "marine": "marine", "air": "air", "drone": "patrol" },
  "vehicleRequired": { "patrol": ["firstAid", "aed", "cones", "flares"], "supervisor": ["firstAid", "aed"], "traffic": ["firstAid", "cones", "flares"], "k9": ["firstAid", "k9Treats"], "swat": ["firstAid", "ram"], "transport": ["firstAid"] },
  "ballistics": { "hitChance": 0.3, "torsoShare": 0.7, "maxRangeM": 30 }
}
```
`loadouts.json`: `{ "version": 1, "officer": { "<presetId>": { "assignment": "...", "items": [{ "id": "...", "count": n,
"retention": 1..3? }] } } }` with presets `patrolStandard`, `trafficStandard`, `k9Handler`, `motorOfficer`,
`bikeOfficer`, `swatOperator`, `detective`, `supervisor`, `marineUnit`, `airCrew` — each must validate cleanly
against its assignment (test). `patrolStandard`: radio, dutyBelt, holster (retention 2), sidearm, taser, ocSpray,
baton, cuffs ×2, flashlight, medKit, naloxone ×2, tourniquet, ballisticVest (≈ 9.6 kg).

### 8.3 Validation (`src/gear/validate.ts`, pure) — mandatory tests

```ts
export type GearSlot = 'belt' | 'vest' | 'body' | 'longGun' | 'carry';
export type GearIssueCode = 'unknownItem' | 'countRange' | 'overweight' | 'slotsFull' | 'missingRequired' | 'forbidden'
  | 'retentionTooLow' | 'retentionMissing' | 'tooManyLongGuns' | 'requiresItem' | 'notRackItem' | 'rackFull' | 'cargoWeight' | 'cargoSlots' | 'missingVehicleItem' | 'unknownTrunkItem';
export interface OfficerLoadoutItem { id: string; count: number; retention?: 1 | 2 | 3 }
export interface OfficerLoadout { assignment: Assignment; items: OfficerLoadoutItem[] }
export function validateOfficerLoadout(l: OfficerLoadout, opts?: { extraVestSlots?: number }): LoadoutValidation;
export function validateVehicleLoadout(l: VehicleLoadout, cap: VehicleCapacity, fleetClass: string | null): LoadoutValidation;
export function loadoutWeightKg(l: OfficerLoadout): number;
export function defaultVehicleLoadout(trunkLoadoutId: string | null, rack: boolean): VehicleLoadout; // trunk = equipment.json trunkLoadouts[id] (copy), rack = rack ? all RACK_ITEMS ids except 'lessLethal' : []
export function officerPreset(id: string): OfficerLoadout;        // deep copy from loadouts.json; throws on unknown
```
Officer rules in this order, every failure collected: unknown id → `unknownItem`; count < 1 or > `max` →
`countRange`; duplicate ids → `countRange`; slots: capacity = base + providers (+ extraVestSlots), used = Σ size ×
count per slot → `slotsFull` per slot over capacity; weight Σ `weightKg × count` > `maxKg` → `overweight`; each
`required` absent → `missingRequired`; each `forbidden` present → `forbidden`; a `retention` item without a level →
`retentionMissing`, below `minRetention` → `retentionTooLow`; long guns > `maxLongGuns` → `tooManyLongGuns`; an item
whose `requires` are absent → `requiresItem`. `ok = errors.length === 0`. Warnings: weight > 85 % of max
(`overweight` as a warning), no TASER on patrol / traffic / supervisor (`missingRequired` warning). Vehicle rules:
trunk ids must exist in police `items.json` (`unknownTrunkItem`), counts 0..99 (`countRange`); Σ weight ≤ `cap.kg`
(`cargoWeight`), Σ size ≤ `cap.slots` (`cargoSlots`); each rack id must be a `RACK_ITEMS` id (`notRackItem`), count ≤
`cap.rackSlots` (`rackFull`); `vehicleRequired[fleetClass]` items with count 0 → `missingVehicleItem` (error).
Mandatory tests (`test/gear/validate.test.ts`): every preset valid; each code produced by a minimal failing case;
weight arithmetic (two cuffs, three naloxone) exact; slots with and without belt / vest providers and the external
carrier bonus; detective preset rejects a rifle; motor rejects the ram; SWAT requires retention 3; vehicle loadout:
the `patrol` trunk loadout fits `patrol_sedan` cargo `{150, 30, 2}`; a ram in a bicycle (cargo `{12, 4, 0}`) fails
on weight and slots; three long guns in a 2-slot rack fail; the K9 class requires treats.

### 8.4 Officer gear state (`src/gear/officerGear.ts`)

```ts
export interface GearSave { version: 1; loadout: OfficerLoadout; presets: { name: string; loadout: OfficerLoadout }[] /* ≤ 8 */ }
export function defaultGearSave(): GearSave;                      // patrolStandard, no presets
export function isGearSave(x: unknown): x is GearSave;            // structural; ids are not required to be known (old saves stay loadable)
export class OfficerGear {
  constructor(save?: GearSave);
  get loadout(): Readonly<OfficerLoadout>;
  get validation(): LoadoutValidation;                            // cached per change
  setLoadout(l: OfficerLoadout): LoadoutValidation;               // applied even when invalid (the UI warns; policy errors show on the HUD at shift start)
  setVest(on: boolean): void;                                     // adds / removes ballisticVest (locker vest row bridge)
  has(id: string): boolean;
  retention(): 1 | 2 | 3;                                         // holster level, 1 without a holster
  protection(): number;                                           // vest protection, 0 without
  /** Trunk-item counts the officer carries at shift start (Σ kit × count), e.g. { firstAid: 1, naloxone: 2, ... }. */
  kitGrants(): Record<string, number>;
  /** Armory items of the loadout in ARMORY_ITEMS order (sidearm, taser, ocSpray, baton, beanbag, rifle). */
  armoryItems(): string[];
  savePreset(name: string): void; deletePreset(name: string): void; presets(): readonly { name: string; loadout: OfficerLoadout }[];
  serialize(): GearSave; static restore(s: GearSave): OfficerGear;
}
/** Pure: what a round fired at the officer does. `u1`, `u2` are two draws in [0, 1). */
export function officerHit(u1: number, u2: number, protection: number, distanceM: number): 'miss' | 'stopped' | 'wounded';
```
`officerHit`: beyond `ballistics.maxRangeM` → miss; `u1 >= hitChance` → miss; torso hit when `u2 < torsoShare`:
`stopped` when `protection > 0` and `u2 < torsoShare × protection`, else `wounded`; limb hit → `wounded`. Tests.

### 8.5 Police module additions (`src/police/**`, `src/data/police/**`)

- `items.json`: every item gains `"weightKg"` (number ≥ 0) and `"size"` (int ≥ 0); `parseItems` reads them (required).
  Values: cones 2.5/2, flares 0.2/0 (size 0: they ride in a box), firstAid 1.5/1, aed 2.5/2, spikeStrip 9/4,
  evidenceKit 3/2, fireExtinguisher 4.5/2, trafficVest 0.3/0, ram 16/4, sceneTape 1/1, evidenceMarkers 0.05/0,
  evidenceBags 0.02/0, fingerprintKit 1/1, camera 1/1. New items: `naloxone` (carryMax 3, 0.05/0), `tourniquet`
  (carryMax 2, 0.1/0), `halligan` (1, 5/2), `k9Treats` (5, 0.1/0), `drone` ("Camera drone", carryMax 1, deployable
  true, 3/3).
- `equipment.json`: rack item `{ "id": "lessLethal", "label": "Less-lethal launcher" }` appended (after rifle);
  `trunkLoadouts` add (counts; every listed id must be an item): `supervisor` {cones 4, flares 6, firstAid 1, aed 1,
  spikeStrip 1, evidenceKit 1, fireExtinguisher 1, trafficVest 1, naloxone 2, tourniquet 2, drone 1}, `unmarked`
  {firstAid 1, flares 4, evidenceKit 1, trafficVest 1, naloxone 1, tourniquet 1}, `traffic` {cones 8, flares 12,
  firstAid 1, aed 1, spikeStrip 1, fireExtinguisher 1, trafficVest 1, naloxone 1, tourniquet 1}, `k9` {firstAid 1, aed
  1, flares 4, k9Treats 5, evidenceKit 1, trafficVest 1, naloxone 1, tourniquet 1}, `motor` {flares 4, firstAid 1,
  tourniquet 1}, `bicycle` {firstAid 1, naloxone 1, tourniquet 1}, `atv` {firstAid 1, flares 4, tourniquet 1},
  `swat` {firstAid 2, aed 1, ram 2, halligan 2, tourniquet 2, naloxone 2, evidenceKit 1, drone 1}, `armored` {firstAid
  2, aed 1, ram 1, halligan 1, tourniquet 2, fireExtinguisher 1}, `transport` {firstAid 1, aed 1, naloxone 2,
  tourniquet 1}, `command` {cones 12, flares 12, firstAid 2, aed 1, sceneTape 4, evidenceKit 1, trafficVest 4, drone
  1}, `lab` {evidenceKit 2, evidenceMarkers 20, evidenceBags 20, fingerprintKit 2, camera 2, sceneTape 4, firstAid
  1}, `marine` {firstAid 1, aed 1, flares 6, naloxone 1, tourniquet 1}, `air` {firstAid 1, tourniquet 1}. The
  existing `patrol` loadout gains `naloxone 2, tourniquet 2, halligan 1`.
- `PatrolEquipment` (`equipment.ts`): constructor `(spec, opts?: { cageSeats?: number; trunk?: Readonly<Record<string,
  number>>; rack?: readonly string[] })` — `trunk` replaces the model's trunk loadout counts, `rack` lists the racked
  long guns (default: every rack item except `lessLethal` when `spec.rack`, i.e. Phase 2-6 behaviour);
  `cageSeats` default 1 (0 forces no cage even with a partition). The cage becomes an `Int32Array(cageSeats)` of
  person ids: `prisoner` = first occupied seat (−1 none), `prisoners(): number[]`, `seatPrisoner(id)` fills the
  first free seat, `releasePrisoner()` empties the **last** occupied seat and returns it, new `releaseAll():
  number[]`, `cageFree(): number`. `EquipmentSave` gains optional `extraPrisoners?: number[]` (seats 2..n); `prisoner`
  keeps seat 1 (old saves load unchanged). `restore(spec, save, opts?)`. Tests: multi-seat cage order, save round trip
  with and without `extraPrisoners`, loadout override, lessLethal not racked by default.
- `OfficerKit` unchanged except that it accepts the new items through `TRUNK_ITEMS`.

### 8.6 Station additions (`src/station/**`)

- Locker panel (`lockerModel`): rows Uniform, Vest, Bodycam mount, Radio audio, Flashlight, Done (index 5, as in
  Phase 4), then **"Uniform & gear…"** (index 6, detail "Customize"). `lockerSelect(index): 'customize' | null`
  returns `'customize'` for index 6 (no request), keeps every other index's Phase 4 behaviour and returns null.
  Appending after Done keeps `test/game/phase4.test.ts` (integrator-owned) valid.
- Armory panel (`armoryModel(loadoutItems?: readonly string[])`): rows = items (0..5), Done (index
  `ARMORY_ITEMS.length`, unchanged), then **"Sign out my loadout"** (index `ARMORY_ITEMS.length + 1`, detail "n
  items", enabled when at least one of `loadoutItems` is not out; disabled with detail "Nothing to sign out"
  otherwise or when `loadoutItems` is absent). `armorySelect(index, loadoutItems?)`: the loadout row queues `{ kind:
  'armory', item, action: 'out' }` for every loadout item not yet out, in `ARMORY_ITEMS` order. Existing indices keep
  their meaning.
- `StaffFigures` view (`staff.ts`) gains `outfit: Uint16Array` (all entries = `setOutfit(index)` value, default 0).

## 9. Fleet roster, yard, maintenance, damage reports, inspection [fleet] — wave 2

Owns `src/fleet/**`, `src/data/fleet/**`, `test/fleet/**`. Imports vehicles (types, `VehicleCondition`,
`VEHICLE_MODELS`, `vehicleModel`), livery (`LiveryDoc`, `parseLivery`, `DEFAULT_LIVERIES`), gear
(`validateVehicleLoadout`, `defaultVehicleLoadout`, `VehicleLoadout`), uniform (`applyPronouns`, `CHARACTER_LINES`,
`pronounLabel`, `PronounSet`), pre-existing world (`stationLayout`, `BLOCK_KIND`, `LANDMARKS`).

### 9.1 Data

`src/data/fleet/fleet.json` (`parseFleet` → `FLEET_DATA`):
```json
{ "version": 1,
  "units": [
    { "id": "P-101", "model": "patrol_sedan",      "class": "patrol",     "livery": "patrolMarked",      "trunk": "patrol" },
    { "id": "P-102", "model": "patrol_suv",        "class": "patrol",     "livery": "patrolMarked",      "trunk": "patrol" },
    { "id": "S-201", "model": "supervisor_suv",    "class": "supervisor", "livery": "supervisorMarked",  "trunk": "supervisor" },
    { "id": "U-301", "model": "unmarked_sedan",    "class": "unmarked",   "livery": "unmarkedGrey",      "trunk": "unmarked" },
    { "id": "T-401", "model": "traffic_sedan",     "class": "traffic",    "livery": "trafficMarked",     "trunk": "traffic" },
    { "id": "K-501", "model": "k9_suv",            "class": "k9",         "livery": "k9Marked",          "trunk": "k9" },
    { "id": "M-601", "model": "police_motorcycle", "class": "motor",      "livery": "motorMarked",       "trunk": "motor" },
    { "id": "B-651", "model": "police_bicycle",    "class": "bicycle",    "livery": "bicyclePatrol",     "trunk": "bicycle" },
    { "id": "A-671", "model": "police_atv",        "class": "atv",        "livery": "atvPatrol",         "trunk": "atv" },
    { "id": "X-701", "model": "swat_truck",        "class": "swat",       "livery": "swatTactical",      "trunk": "swat" },
    { "id": "X-711", "model": "armored_truck",     "class": "armored",    "livery": "armoredRescue",     "trunk": "armored" },
    { "id": "J-801", "model": "prisoner_van",      "class": "transport",  "livery": "prisonerTransport", "trunk": "transport" },
    { "id": "C-901", "model": "command_post",      "class": "command",    "livery": "commandPost",       "trunk": "command" },
    { "id": "L-951", "model": "crime_lab",         "class": "lab",        "livery": "crimeLab",          "trunk": "lab" },
    { "id": "MAR-1", "model": "patrol_boat",       "class": "marine",     "livery": "marinePatrol",      "trunk": "marine", "home": "boatSlip" },
    { "id": "AIR-2", "model": "police_helicopter", "class": "air",        "livery": "airSupport",        "trunk": "air", "home": "helipad" },
    { "id": "D-1",   "model": "police_drone",      "class": "drone",      "livery": "droneUnit",         "trunk": null, "home": "carried" }
  ],
  "startParked": ["P-101", "P-102"],
  "startHome": ["MAR-1", "AIR-2"],
  "garageSlot": 2
}
```
Rules: ids unique, `/^[A-Z]{1,3}-[0-9]{1,3}$/`; model ids exist; class in `FLEET_CLASSES`; livery in
`DEFAULT_LIVERIES`; `trunk` null or an equipment trunk loadout id; `home` `lot` (default) | `boatSlip` | `helipad` |
`carried`; `startParked` / `startHome` reference units. The **display unit number** painted for `{unit}` is the part
after the dash ("101").

`src/data/fleet/maintenance.json` (`parseMaintenance` → `MAINTENANCE`):
```json
{ "version": 1,
  "prices": { "fuelPerL": 2, "oilChange": 80, "tire": 180, "bodyPerZone": 2400, "enginePerHealth": 9000, "engineReplace": 14000 },
  "classMultiplier": { "patrol": 1, "supervisor": 1.1, "unmarked": 1, "traffic": 1.1, "k9": 1.2, "motor": 0.6, "bicycle": 0.05, "atv": 0.4,
                       "swat": 2.5, "armored": 4, "transport": 1.2, "command": 3, "lab": 1.5, "marine": 2, "air": 8, "drone": 0.3 },
  "charges": { "pointsPer1000": 1, "wreckPoints": 10, "pursuitFactor": 0.25, "emergencyFactor": 0.5, "unreportedFactor": 2, "maxPointsPerIncident": 20 },
  "wreck": { "zoneSum": 2.5, "engineFailed": true },
  "incidentMergeS": 5,
  "limits": { "incidents": 100, "reports": 50, "ledger": 200 }
}
```
`src/data/fleet/inspection.json` (`parseInspection` → `INSPECTION_ITEMS`):
```json
{ "version": 1, "items": [
  { "id": "fuel",      "label": "Fuel at least a quarter tank", "check": "fuelMin",        "value": 0.25, "fix": "refuel" },
  { "id": "oil",       "label": "Oil level",                     "check": "oilMin",         "value": 0.3,  "fix": "oil" },
  { "id": "tread",     "label": "Tyre tread",                    "check": "treadMin",       "value": 0.3,  "fix": "tires" },
  { "id": "flats",     "label": "No flat tyres",                 "check": "noFlats",                       "fix": "tires" },
  { "id": "engine",    "label": "No engine warning",             "check": "engineMin",      "value": 0.6,  "fix": "repair" },
  { "id": "body",      "label": "All damage reported",           "check": "damageReported" },
  { "id": "lamps",     "label": "Lamps working",                 "check": "noFaults" },
  { "id": "equipment", "label": "Equipment complete",            "check": "loadoutComplete" },
  { "id": "longGuns",  "label": "Long guns racked, rack locked",  "check": "rackSecured" },
  { "id": "cage",      "label": "Rear cage empty",               "check": "cageEmpty" } ] }
```
`check` one of `fuelMin oilMin treadMin noFlats engineMin damageReported noFaults loadoutComplete rackSecured
cageEmpty`; `fix` optional, one of the fleet services.

### 9.2 Accounting (`src/fleet/accounting.ts`, pure) — mandatory tests

```ts
export interface QuoteLine { kind: 'fuel' | 'oil' | 'tire' | 'body' | 'engine'; label: string; cost: number }
export interface Quote { lines: QuoteLine[]; total: number }
/** Cost of `service` for a vehicle in `cond` of `fleetClass` (integers, Math.round per line). */
export function serviceQuote(service: 'refuel' | 'oil' | 'tires' | 'repair' | 'all', cond: VehicleCondition, capacityL: number, fleetClass: string, cfg?: MaintenanceConfig): Quote;
/** Cost of an incident's damage: zone deltas × bodyPerZone + engine delta × enginePerHealth (engineReplace when it failed in it) + tire per new flat, × classMultiplier. */
export function damageCost(zoneDelta: readonly number[], engineDelta: number, newFlats: number, engineFailed: boolean, fleetClass: string, cfg?: MaintenanceConfig): number;
export function isWreck(zonesAfter: readonly number[], engineFailed: boolean, cfg?: MaintenanceConfig): boolean;
/** Career points (≤ 0) charged for one incident. */
export function chargePoints(cost: number, ctx: { pursuit: boolean; emergency: boolean; reported: boolean; wreck: boolean }, cfg?: MaintenanceConfig): number;
export class FleetLedger {
  add(e: Omit<LedgerEntry, 'seq'>): LedgerEntry;  entries(): readonly LedgerEntry[];
  get departmentCost(): number; get officerPoints(): number;  // running totals (kept when old entries are evicted)
  serialize(): LedgerSave; static restore(s: LedgerSave): FleetLedger;
}
export interface LedgerEntry { seq: number; game: number; unitId: string; kind: 'fuel' | 'oil' | 'tire' | 'repair' | 'charge'; cost: number; points: number; note: string }
```
`serviceQuote`: refuel = `(1 - fuelFraction) × capacityL × fuelPerL` (no multiplier); oil = `oilChange` when
`oilFraction < 1`; tires = `tire × (flats + wheels with tread < 1)`; repair = body Σ zones × bodyPerZone + engine
(`engineReplace` if failed else `(1 - engineHealth) × enginePerHealth`); `all` = every line; multiplier on oil / tire
/ body / engine lines. `chargePoints`: `base = cost / 1000 × pointsPer1000`; `factor = pursuit ? pursuitFactor :
emergency ? emergencyFactor : 1`; `p = base × factor + (wreck ? wreckPoints : 0)`; `× (reported ? 1 :
unreportedFactor)`; `round`, clamp to `maxPointsPerIncident`; return `-p` (0 → 0, never −0). Ledger evicts the
oldest entries beyond `limits.ledger` but keeps the totals. Mandatory tests (`test/fleet/accounting.test.ts`): exact
numbers for each quote kind and class multiplier; a clean vehicle quotes 0; refuel never multiplied; damage cost with
an engine failure uses `engineReplace`; charge for a $4 800 reported patrol crash = −5, in a pursuit = −1, emergency
= −2, unreported = −10, wreck adds 10 before the unreported factor, clamp at 20; ledger totals across eviction;
ledger serialize / restore round trip.

### 9.3 Inspection (`src/fleet/inspection.ts`, pure) — tests

```ts
export interface InspectionInput { condition: VehicleCondition; faults: number; unreportedIncidents: number;
  loadoutMissing: readonly string[]; hasRack: boolean; rackSecured: boolean; hasCage: boolean; cageEmpty: boolean }
export interface InspectionRow { id: string; label: string; pass: boolean; applicable: boolean; detail: string; fix: string | null }
export interface InspectionResult { rows: InspectionRow[]; passed: number; failed: string[] }
export function runInspection(input: InspectionInput, items?: readonly InspectionItem[]): InspectionResult;
```
Non-applicable rows (no rack, no cage) pass with detail "n/a". Details: "Fuel 18 %", "Oil 22 %", "Tread 25 % (RL)",
"Flat: FL", "Engine 54 %", "2 unreported", "Missing: flares ×2, aed", "Rack unlocked", "Prisoner aboard".

### 9.4 Yard (`src/fleet/yard.ts`, pure) — tests

```ts
export interface YardLayout { slots: Pose2[]; garage: Pose2; helipad: Pose2 | null; boatSlip: Pose2 | null; service: { x: number; z: number } }
export function fleetYard(city: City): YardLayout;
```
- Station block = the `BLOCK_KIND.parking` block containing `city.spawn` (the station door); `layout =
  stationLayout(block, LANDMARKS.station.yaw)`. Local frame exactly as `stationLayout`: `q = round(yaw / (π/2)) mod 4`,
  `snapped = q·π/2`, `f = (round(-sin snapped), round(-cos snapped))`, `r = (-f.z, f.x)`, centre `c` of the block,
  `hf`, `hr` half sizes along f / r; local `(u, v)` → `c + r·u + f·v`.
- `slots` = the 6 `layout.slots` first (Phase 1-6 order), then row extension `u = ±(3 + j)·3.6` for `j = 0..3`
  (alternating +, −) at the slot row `v_s` (= `(layout.slots[0] − c)·f`), then a second row at `v_s + 7`, `u = (k −
  3.5)·3.6` for `k = 0..7`; keep a candidate only if it is inside the block with a 2.5 m margin, ≥ 5 m from
  `layout.pump`, outside the building rectangle + 2 m, and ≥ 10 m from the helipad. Yaw = `snapped` for all.
- `garage` = `slots[garageSlot]` from fleet.json (2) — where a checked-out unit spawns (the integrator frees it first).
- `helipad`: `u = −sign(u_pump)·(hr − 9)`, `v = hf − 9` (yaw `snapped`), null when `hr < 20` or `hf < 20` or within
  12 m of the building or the pump.
- `boatSlip`: harbor POI (`city.pois` kind `harbor`); water blocks (`BLOCK_KIND.water`); the nearest block to the POI;
  its rectangle side nearest the POI is the quay; `t` = the POI projected onto that side clamped to [side start + 8,
  side end − 8] (centre when the side is < 16 m); position = quay point moved `2.0` m into the water along the inward
  normal; yaw so the boat's local −X (driver side) faces the land: with outward normal `n` (water → land), `yaw =
  atan2(n.z, −n.x)`. Null when no harbor POI or no water block.
- `service` = `layout.pump` (the station pump: the fleet service point).
Tests (`test/fleet/yard.test.ts`, generated cities for seeds 1, 2, 3, 42): ≥ 10 slots; slots pairwise ≥ 3.4 m apart,
inside the block, clear of the building and pump; first 6 equal `city.parking`; helipad null or ≥ 10 m from every
slot; boat slip inside a water block and its driver door point (`driverDoorPoint` from `src/player/mode.ts` with
halfWidth 1.3, halfLength 4) within 1.2 m of the block edge.

### 9.5 Fleet system (`src/fleet/fleetSystem.ts`)

```ts
export interface FleetVehiclePort {           // DrivableVehicle satisfies it structurally
  readonly eid: number; readonly model: { readonly id: string; readonly fuel: { readonly capacityL: number } };
  condition(out?: VehicleCondition): VehicleCondition;
  refuel(liters?: number): void; changeOil(): void; replaceTires(wheels?: readonly number[]): void; repair(): void;
}
export interface FleetDeps {
  readonly bus: EventBus<EventMap>;
  readonly rng: Rng;                                    // session.rng.stream('fleet') (state saved; nothing drawn yet)
  vehicleOf(unitId: string): FleetVehiclePort | null;  // the spawned vehicle of a unit
  damageContext(eid: number): { pursuit: boolean; emergency: boolean; callId: number };
  officer(): { name: string; badge: string; pronouns: PronounSet };
  readonly config?: Partial<FleetConfigs>;
}
export type FleetRequest =
  | { readonly kind: 'service'; readonly unitId: string; readonly service: 'refuel' | 'oil' | 'tires' | 'repair' | 'all' }
  | { readonly kind: 'report'; readonly incidentId: number }
  | { readonly kind: 'inspect'; readonly unitId: string; readonly input: Omit<InspectionInput, 'condition' | 'unreportedIncidents'> }
  | { readonly kind: 'endShift' };
export interface FleetUnitView { id: string; number: string; modelId: string; label: string; cls: string; liveryId: string;
  spawned: boolean; assigned: boolean; fuel: number; oil: number; tread: number; damage: number; status: 'ready' | 'service' | 'damaged' | 'out' }
export class FleetSystem {
  constructor(deps: FleetDeps, save?: FleetSave);
  get revision(): number;
  units(): readonly FleetUnitView[];                   // rebuilt on revision change, cached
  unitIds(): readonly string[];
  unitOfEid(eid: number): string | null;
  bindVehicle(unitId: string, eid: number): void;      // after the integrator spawned / restored it
  unbindVehicle(unitId: string, stored: SerializedVehicle | null): void; // despawn: keep its condition for the next spawn
  storedVehicle(unitId: string): SerializedVehicle | null;
  assigned(): string | null;  assign(unitId: string | null): void;
  livery(unitId: string): LiveryDoc;                   // the unit's livery (library or default)
  setLivery(unitId: string, doc: LiveryDoc): void;     // stores doc in the library (replacing same id) and points the unit at it
  library(): readonly LiveryDoc[];                     // custom docs (≤ 32), then defaults
  removeLivery(id: string): boolean;                   // custom only; units using it fall back to their default
  loadout(unitId: string): VehicleLoadout;             // custom or default (gear defaultVehicleLoadout)
  setLoadout(unitId: string, l: VehicleLoadout): LoadoutValidation; // stored only when valid
  incidents(): readonly DamageIncident[]; openReports(): number; reports(): readonly DamageReport[];
  lastInspection(): InspectionResult | null;
  /** Quote for a spawned unit (null when not spawned). */
  quote(unitId: string, service: 'refuel' | 'oil' | 'tires' | 'repair' | 'all'): Quote | null;
  readonly ledger: FleetLedger;
  startShift(t: CadTime): void;                        // marks the shift start (incidents after it belong to this shift)
  request(r: FleetRequest): void;
  /** Fixed step (order -655): closes incidents 5 s after their last hit, applies queued requests. */
  step(dt: number, t: CadTime): void;
  /** `indexOfEid` maps a bound eid to its `session.vehicles` index (−1 none) for `FleetUnitSave.vehicleIndex`. */
  serialize(indexOfEid: (eid: number) => number): FleetSave;
  /** Saved `vehicleIndex` per unit (the integrator binds the restored vehicles with it after construction from a save). */
  savedVehicleIndex(unitId: string): number;
  dispose(): void;                                     // unsubscribes
}
export interface DamageIncident { id: number; unitId: string; shift: number; startSim: number; lastSim: number; game: number;
  zoneDelta: [number, number, number, number]; engineDelta: number; newFlats: number; engineFailed: boolean; maxImpact: number;
  pursuit: boolean; emergency: boolean; callId: number; closed: boolean; cost: number; wreck: boolean; reported: boolean; charged: boolean }
export interface DamageReport { id: number; incidentId: number; unitId: string; game: number; text: string }
```
Behaviour:
- Constructor subscribes `vehicle:damaged` and `vehicle:tireBurst` (push to a small pending array; no work in the
  handler). In `step`: for a pending hit on a bound eid, open an incident when none is open for that unit (snapshot the
  condition **before** the hit is not available: keep a per-unit `baseline` condition captured at bind time and after
  each closed incident / service), emit `fleet:damage` on open, extend `lastSim`. Close when `t.sim - lastSim ≥
  incidentMergeS`: deltas = current condition − baseline (zones, engine health, flats), `cost = damageCost(...)`,
  `wreck = isWreck(...)`, emit `fleet:incident`, refresh the baseline. A flash "Damage to P-101: file a damage report
  (fleet panel)" on close.
- `report`: marks the incident reported (allowed open or closed) and stores a `DamageReport` with
  `applyPronouns(CHARACTER_LINES.damageReport, ...)` vars `{name, pronouns, unit, zone (largest delta zone name),
  speed (round maxImpact × 3.6), context (' during a pursuit' | ' on an emergency run' | '')}`.
- `service`: requires the unit spawned (`vehicleOf`); computes `serviceQuote`, applies the vehicle mutation(s)
  (`refuel()`, `changeOil()`, `replaceTires()`, `repair()`), adds ledger entries (one per line kind), emits
  `fleet:service`, refreshes the baseline (repairs never count as new damage).
- `inspect`: `runInspection` with the unit's condition and its unreported incident count; stores
  `lastInspection`; emits `fleet:inspection`.
- `endShift`: closes open incidents at once, then for each incident of the current shift not yet charged:
  `points = chargePoints(cost, {pursuit, emergency, reported, wreck})` → ledger `charge` entry and `fleet:charge`
  (skip points 0); emits `fleet:shiftEnd` with totals of the shift; increments the shift number.
- `units()` status: `out` when assigned and spawned away from the yard is not tracked — use: `damaged` when any zone
  > 0.05 or a flat or engine < 0.6, `service` when fuel < 0.25 or oil < 0.3 or tread < 0.3, else `ready`; stored units
  read their stored condition (or new-vehicle defaults when never spawned).
- No allocation in `step` when nothing is pending.

### 9.6 Save (`src/fleet/save.ts`)

```ts
export interface FleetUnitSave { id: string; liveryId: string; loadout: VehicleLoadout | null; vehicleIndex: number; stored: SerializedVehicle | null }
export interface FleetSave { version: 1; rng: RngState; shift: number; shiftStartGame: number; assigned: string | null;
  units: FleetUnitSave[]; liveries: LiveryDoc[]; incidents: DamageIncident[]; reports: DamageReport[];
  ledger: LedgerSave; lastInspection: InspectionResult | null; queue: FleetRequest[]; nextIncident: number; nextReport: number }
export function isFleetSave(x: unknown): x is FleetSave;   // liveries through parseLivery; stored through a structural SerializedVehicle check
export function emptyFleetSave(rng: RngState): FleetSave;   // every unit, default livery, null loadout, vehicleIndex -1, stored null
/** v8 → v9: binds each existing saved vehicle (by model id, first unused unit of that model) to a unit. */
export function migratedFleetSave(rng: RngState, vehicleModelIds: readonly string[]): FleetSave;
```
Tests (`test/fleet/system.test.ts`, fake ports, no physics): an incident merges hits within 5 s and closes after;
costs match `damageCost`; reported vs unreported charges at end shift; service applies the mutation and the ledger;
inspection rows; serialize → restore → serialize identical; `isFleetSave` rejects each malformed field;
`migratedFleetSave(['patrol_sedan', 'patrol_suv', 'sedan'])` binds P-101 → 0, P-102 → 1, nothing → 2.

## 10. Rendering: vehicles, liveries, people [render] — wave 2

Owns `src/render/vehicles/**`, `src/render/livery/**` (new), `src/render/people/**`, tests `test/vehiclerender/**`,
`test/liveryrender/**` (new), `test/peoplerender/**`. Imports vehicles (`VehicleLook.lean / rotor / trim`, `TRIM`,
`wheelLayout`, `isCraft`), livery (`paintLivery`, `SHELL_ATLAS`, `LiveryDoc`), uniform (`OutfitDef`, `ATTACH`).

### 10.1 Car parts (`carParts.ts`)

- New part kinds: `'pushBar'` and `'spotHousing'` (replace the two uses of `'trim'` for the push bumper and the
  spotlight housing), `'rotor'` (spinning parts), keep `'trim'` for other dark parts (skids, racks, handlebars).
- `buildCarParts(model)` adds per style (all boxes inside or touching the body box unless stated; `w h l` = width,
  height, length; y measured from the body-box centre):
  - `motorcycle`: body = frame (`0.3w × 0.35h × 0.85l`, bottom), tank / seat (`0.35w × 0.25h × 0.45l` above the frame,
    centred z +0.05l), fairing as `cabin` (`0.6w × 0.35h × 0.18l` at the front), glass windscreen (`0.5w × 0.25h ×
    0.03`) on top of the fairing, top case (`0.5w × 0.25h × 0.18l` at the rear, painted); trim handlebar (`0.8w × 0.04 ×
    0.04` at the fairing top); one head lamp (headLeft and headRight both at x ±0.06, small) and tail lamps on the top
    case; light-bar lenses: segments 0-3 across the fairing front (x spread 0.4w), 4-7 across the top-case rear.
  - `bicycle`: body = top tube (`0.06 × 0.06 × 0.6l`), down tube, seat post and fork as thin boxes; cabin = rear rack
    pannier (`0.3w × 0.2h × 0.25l`, painted); glass = a tiny reflector (`0.05 × 0.03 × 0.01`) at the rear; lamps small.
  - `atv`: body low box (`w × 0.45h × l`), seat (cabin, `0.4w × 0.25h × 0.35l`), trim racks front / rear (`0.9w × 0.04 ×
    0.25l`), glass = gauge (`0.15 × 0.05 × 0.02`); light bar on the rear rack (8 lenses across).
  - `boat`: body = hull (`w × 0.55h × l`) with a bow block (`0.7w × 0.55h × 0.15l` at the front), cabin console (cabin
    fractions) with glass windscreen, light bar on the console roof.
  - `helicopter`: body = fuselage (`w × 0.75h × 0.42l` front part) + tail boom (`0.25w × 0.2h × 0.55l` behind it) + tail
    fin (`0.05 × 0.6h × 0.08l`); glass = front bubble (`0.9w × 0.45h × 0.12l`); trim = two skids (`0.08 × 0.06 × 0.4l` at
    x ±0.4w, bottom) and struts; rotor = main rotor two crossed blades (`0.12 × 0.03 × 0.95l` and rotated 90°: as two
    boxes `0.95l × 0.03 × 0.12` and `0.12 × 0.03 × 0.95l` at the top centre); light-bar lenses under the fuselage (belly
    beacon, 8 small lenses in a row).
  - `drone`: body centre (`0.3w × h × 0.3l`) + 4 arms (`0.06 × 0.3h × 0.45` diagonal approximated as x / z arms); rotor =
    4 discs (`0.22 × 0.01 × 0.22`) at the arm ends; glass = camera (`0.08 × 0.08 × 0.08`) below the front.
- `hiddenBarLens(model, segment): CarPart` (pure): segments 0-3 behind the grille (x from −0.3w to 0.3w, y at the head
  lamp height + 0.05, z = front face − 0.01, size `0.12 × 0.05 × 0.03`), 4-7 at the rear window top (y = top − 0.08,
  z = cabin rear − 0.02, same size).
- `wheelLocalPositions` unchanged for 'four'; new `twoWheelPositions(model, out)`: front `(0, y, −wheelbase/2)`, rear
  `(0, y, +wheelbase/2)`.

### 10.2 CarRenderer changes (`carRenderer.ts`)

- Per-model slot: `trimBar` and `trimSpot` meshes (from `pushBar` / `spotHousing` parts) plus `trim` (other trims);
  rotor parts go to one shared `rotorMesh` (InstancedMesh, capacity 64 instances: cars with rotors × parts), rotated by
  a per-eid renderer angle `angle += rotor × 40 rad/s × frameDt` (presentation; keep a `Float32Array(MAX_ENTITIES)`).
- Instance capacity per model: `maxPerModel` for traffic / service models, **16** for `listOrder ≥ 2` police models.
- Per car: `trim = VehicleLook.trim[eid]`; draw `trimBar` only with `TRIM.pushBar`, `trimSpot` only with
  `TRIM.spotlight` (and the police spotlight light only with it); light-bar lenses at `hiddenBarLens` positions with
  `TRIM.hiddenBar`, not drawn with `TRIM.noBar`.
- Lean: after the interpolated basis, apply a roll of `−lean` about the local forward axis with the pivot at the
  ground contact (local y = −(height/2 + groundClearance)) to body, glass, trims, lenses, rotors and wheels.
- Wheels by `wheelLayout`: 'four' unchanged; 'two' draws 2 wheels at `twoWheelPositions` using the WheelSource poses 0
  (front, steer + spin) and 2 (rear, spin); 'none' draws no wheels. Wheel width from `tires.width` as now.
- Export `vehicleRenderBasis(eid: EntityId, alpha: number, outPos: THREE.Vector3, outQuat: THREE.Quaternion): void`
  (interpolated transform with lean applied) for the LiveryRenderer.
- Draw calls: +1 rotor mesh (only when visible); per visible new model as now (body, glass, trims).
- Tests: parts per new style (counts, segment indices 0-7, bounds), hidden-bar positions, two-wheel layout, trim bits
  hide the meshes' instances, rotor mesh count, lean moves the roof sideways with the right sign.

### 10.3 LiveryRenderer (`src/render/livery/liveryRenderer.ts`, `shell.ts`)

```ts
/** Pure: shell quads around `model` with UVs into SHELL_ATLAS (§6.5 orientation), inflated by 0.006 m. */
export function shellGeometryData(model: VehicleModel): { positions: Float32Array; uvs: Float32Array; indices: Uint16Array };
export interface LiveryRendererOptions { maxVisible?: number /* 8 */; maxDistance?: number /* 150 */;
  canvasFactory?: (w: number, h: number) => { getContext(kind: '2d'): Canvas2DLike | null } | null }
export class LiveryRenderer {
  constructor(scene: THREE.Scene, options?: LiveryRendererOptions);
  /** Sets (or clears with null) the livery of a vehicle; repaints its two canvases only when doc / unit / dept changed. */
  set(eid: EntityId, model: VehicleModel, doc: LiveryDoc | null, unit: string, dept: string): void;
  remove(eid: EntityId): void;
  /** Places the nearest ≤ maxVisible liveried vehicles within maxDistance of the camera; `night` 0..1 drives the reflective glow. */
  update(alpha: number, camX: number, camZ: number, night: number): void;
  readonly stats: { shells: number; drawCalls: number; repaints: number };
  dispose(): void;
}
```
Shell quads (car styles): `left` / `right` sides of the lower body (y bottom..lowerTop, z front..rear, at x = ∓(w/2 +
0.006)), `hood` (y = lowerTop + 0.006, x ±w/2, z front..cabin start), `roof` (y = top + 0.006, x ±cabin half width, z
cabin start..end), `front` (z = −l/2 − 0.006), `rear` (z = l/2 + 0.006), each mapped to its atlas region with the §6.5
orientation (`uv.y = 1 - canvasY / 512` because three.js textures have `flipY` true). For non-car styles use the whole
body box faces (sides full height; hood = top front half, roof = top rear half). One `Mesh` per shell with its own
`MeshStandardMaterial({ map, emissiveMap, emissive: 0xffffff, emissiveIntensity: 0.9 × night, transparent: true,
alphaTest: 0.04, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, roughness by finish (gloss 0.35, matte
0.85, metallic 0.3 + metalness 0.6) })`; `map` and `emissiveMap` are `CanvasTexture`s (colorSpace SRGB for the map);
repaint = `paintLivery` twice (colour, reflective-only) and `texture.needsUpdate = true`. Meshes are pooled
(`maxVisible`); shells beyond the pool are hidden. Headless (no canvas from the factory, default factory returns
null without `document`): `set` records the doc, `update` only counts. Tests: `shellGeometryData` face count / UV
ranges / orientation (a point at the vehicle front-left maps to u ≈ 0 of the `left` region), repaint only on change,
nearest-N selection, dispose.

### 10.4 People renderer (`src/render/people/**`)

- `HumanoidSource` gains optional `outfit?: Uint16Array`, `shoulders?: Float32Array`, `hips?: Float32Array`,
  `shins?: Uint32Array`; `createHumanoidSource(cap)` allocates all four (outfit 0, shoulders 1, hips 1, shins 0).
  Reading rules: a missing array or `outfit[i] === 0` means no accessories and shins in the `bottom` colour;
  `shoulders` / `hips` missing or ≤ 0 read as 1; `shins[i]` is used only when `outfit[i] > 0`.
- `PeopleRenderer.setOutfits(defs: readonly (OutfitDef | null)[])`: index 0 = none; converts each def to grouped
  `Float32Array`s per attach part once (x, y, z, sx, sy, sz, colour bits) — no per-frame conversion.
- One more instanced mesh `people-gear` (unit box, instance colours, capacity `options.gearCapacity ?? 2048`): for each
  drawn human with `outfit > 0`, after each part is placed, emit that part's accessory boxes in the part's frame
  (scale x/z by the figure width `w` and y by height `s`, like the parts; positions `origin + R·(x·w, y·s, z·w)`).
  `hideHair` scales the hair instance to 0. Legs use `shins[i]` colour for the shin instances when an outfit is set.
- `shoulders` scales `SHOULDER_X` and the torso / arm x size; `hips` scales `HIP_X` and the leg x size.
- Draw calls: ≤ 8 (adds `people-gear`). No allocation per frame (the gear loop uses `reg` registers like the limbs).
- Tests: a figure with an outfit of N boxes yields N gear instances; capacity overflow stops cleanly; hats follow the
  head (pitching the head moves the hat); shoulder slider widens the arm offset; no outfit → no gear instances.

## 11. Phase 3-6 hooks: item use, retention, outfits, career points [hooks] — wave 2

Owns `src/calls/**`, `src/data/calls/**`, `src/indoors/**`, `src/force/**`, `src/data/force/**`, `src/evidence/**`,
`src/investigation/**`, `src/backup/**`, `src/conduct/**`, tests `test/calls/phase7.test.ts`,
`test/indoors/phase7.test.ts`, `test/force/phase7.test.ts`, `test/evidence/phase7.test.ts`,
`test/backup/phase7.test.ts`, `test/conduct/phase7.test.ts` (and updates to existing tests in those folders when a
contract below changes them). May import gear / uniform types; needs none.

### 11.1 Calls data (`src/data/calls/actions.json`, `families.json`)

- Actions: `{ "id": "naloxone", "label": "Administer naloxone", "requires": "arrived", "sets": ["naloxone"],
  "consumes": { "naloxone": 1 }, "once": true }`, `{ "id": "tourniquet", "label": "Apply a tourniquet", "requires":
  "arrived", "sets": ["tourniquet"], "consumes": { "tourniquet": 1 }, "once": true }`; relabel `firstAid` to "Treat
  with the med kit" (id unchanged).
- Families: `medical` actions add `naloxone` (after `firstAid`); objective `{"text": "Administer naloxone", "done":
  "naloxone", "show": "branch:overdose"}` after "Render first aid"; outcome inserted **before** `transported`: `{"id":
  "overdoseUntreated", "when": {"all": ["branch:overdose", "!naloxone", "!variant:false"]}, "disposition": "handled",
  "grade": "bad"}`. `collision`, `domestic`, `violent`, `investigation`, `welfare`: actions add `firstAid` and
  `tourniquet` (before `requestEms`); objective `{"text": "Control the bleeding", "done": {"any": ["tourniquet",
  "firstAid"]}, "show": "<that family's injury flag>"}` (collision `injury:driverB`, domestic / violent /
  investigation `injury:victim`, welfare `injury:subject`).
- The catalog validator already checks `consumes` ids against the police items (gear adds them in wave 1). Tests:
  catalog parses; the overdose branch shows the naloxone objective; a scenario run (test helpers) with a kit holding
  naloxone grades `transported` good and without it `overdoseUntreated` (use the existing scenario test harness in
  `test/scene/helpers.ts` / `test/calls/helpers.ts`).

### 11.2 Breaching (`src/indoors/interiorSystem.ts`)

`breach` for `action === 'ram'`: allowed when the kit carries `ram` **or** `halligan` (flash "No forced-entry tool"
otherwise). Success chance with strength `s` (below `UNBREACHABLE`): ram only `clamp(1.1 − 0.8 s, 0, 0.95)` (as now),
Halligan only `clamp(1.0 − 0.7 s, 0, 0.9)`, both `clamp(1.25 − 0.8 s, 0, 0.98)`. Kick unchanged. Test the three
probabilities through a stubbed rng and the missing-tool flash.

### 11.3 Holster retention (`src/force/**`)

- `force.json` new section `"retention": { "drawS": [0.25, 0.45, 0.7], "grabChance": [0.15, 0.06, 0.02],
  "grabRangeM": 1.5 }` (validator updated; index = level − 1).
- `ForceDeps.holsterLevel?(): number` (1..3; absent = 1). Selecting `firearm` starts `drawingS = drawS[level − 1]`;
  while `drawingS > 0` an `apply` is refused with flash "Drawing…" (no `force:applied`); `step` counts it down.
- Subscribe `npc:attack` (queue `{ actorId }` when kind `fight`; unsubscribe in `dispose`). In `step`, for each queued
  attack while the tool is `firearm`: when the actor (`deps.npc.actor`) is within `grabRangeM` of the officer, roll
  `rng.next() < grabChance[level − 1]`: on success `setTool('hands')` and flash "Weapon retention: the subject grabbed
  for your sidearm, you kept it holstered" (the roll happens only when the condition holds, so other runs draw nothing
  new).
- `ForceSave` gains optional `drawingS?: number`. Tests: draw delay per level, grab chance per level (seeded loop
  statistics within ±0.03 over 2 000 rolls), no roll beyond range, save round trip.

### 11.4 K9 treats (`src/evidence/k9.ts`, `src/investigation/**`)

`k9Sweep(order, targets, u, bonus = 0)`: alert chance `min(0.99, K9_ALERT_CHANCE[scent] + bonus)`.
`InvestigationPorts` gains optional `k9Treat?(): boolean` (consumes one carried treat, true when one was used); the K9
sweep start calls it once and passes `bonus = 0.05` when true, and the K9 run's summary line gains " (rewarded)". Tests.

### 11.5 Backup officer outfits (`src/backup/**`)

`BackupDeps.appearanceOf?(callsign: string, role: 'patrol' | 'supervisor' | 'swat'): { outfit: number; top: number;
bottom: number } | null`. The backup view becomes `createHumanoidSource(cap)` plus an own `outfit: Uint16Array(cap)`
when the render module's optional field is absent (type it as `HumanoidSource & { count: number; outfit: Uint16Array
}`, allocate `outfit` explicitly so wave-2 order does not matter). `writeOfficerView` writes `outfit`, `top`, `bottom`
from `appearanceOf(callsign, rank === 'sergeant' ? 'supervisor' : 'patrol')` (falls back to the Phase 6 colours and 0);
`SwatTeam.writeView` uses role `swat` with callsign `TAC-op<k>`. Cache per callsign (allocates once per officer).
Tests: outfit index written; fallback without the dep.

### 11.6 Career points (`src/conduct/**`)

`ConductRequest` gains `{ readonly kind: 'points'; readonly delta: number; readonly reason: string; readonly key:
string }` → `points += delta` (integer), `rev++`, emit `conduct:points { delta, total, reason }` (new topic in
`src/conduct/events.ts`). The save validator accepts the kind in the queue. Tests: points move, event, save round
trip with a queued points request.

## 12. UI, editors, panels, HUD, main menu [ui] — wave 3

Owns `src/ui/livery/**` (new), `src/ui/character/**` (new), `src/ui/fleet/**` (new), `src/ui/hud/**`,
`src/ui/mainMenu.ts`, `src/ui/mdt/career.ts`, `src/ui/styles.css` (only to import new css files if needed), tests
`test/ui7/**` (new), `test/hud/phase7.test.ts`, `test/mainMenu/**`, `test/mdt/career.test.ts`. Imports everything.
DOM classes are `Menu`s (see `src/ui/ui.ts`), no-ops headless; every behaviour sits in pure reducers / models tested
in node.

### 12.1 Livery editor (`src/ui/livery/liveryEditor.ts`, `editorState.ts`, `polygonPad.ts`, `livery.css`)

```ts
export interface LiveryEditorHost {
  readonly unitId: string; readonly unitNumber: string; readonly dept: string;
  readonly model: VehicleModel; readonly fleetClass: string; readonly capacity: VehicleCapacity;
  library(): readonly LiveryDoc[];
  validateLoadout(l: VehicleLoadout): LoadoutValidation;
  preview(doc: LiveryDoc): void;        // live 3D preview: the integrator applies the draft to the vehicle (throttled by the editor to ≤ 10 Hz)
  save(doc: LiveryDoc): void;           // store in the library and apply to the unit
  cancel(): void;                       // restore the unit's livery
  sirenPreview?(tone: string): void;    // plays 1.5 s of the tone
  orbit(dYaw: number, dPitch: number, dZoom: number): void; // preview camera
}
export interface EditorState { doc: LiveryDoc; selected: number; tab: 'paint' | 'decals' | 'lights' | 'equipment' | 'loadout' | 'library'; dirty: boolean; errors: string[] }
export type EditorAction =
  | { kind: 'setBase'; color?: string; finish?: string } | { kind: 'setWrap'; wrap: LiveryDoc['wrap'] }
  | { kind: 'addLayer'; layer: LiveryLayer['type'] } | { kind: 'removeLayer'; index: number } | { kind: 'moveLayer'; index: number; dir: -1 | 1 }
  | { kind: 'select'; index: number } | { kind: 'updateLayer'; index: number; patch: Record<string, unknown> }
  | { kind: 'setLights'; patch: Partial<LiveryDoc['lights']> } | { kind: 'setEquipment'; patch: Partial<LiveryDoc['equipment']> }
  | { kind: 'setLoadout'; loadout: LiveryDoc['loadout'] } | { kind: 'rename'; name: string } | { kind: 'tab'; tab: EditorState['tab'] }
  | { kind: 'load'; doc: LiveryDoc } | { kind: 'import'; text: string };
export function editorReducer(s: EditorState, a: EditorAction): EditorState; // pure; re-validates with parseLivery: invalid results keep the previous doc and set `errors`
export function newLayer(type: LiveryLayer['type']): LiveryLayer;        // sensible defaults (stripe on sides, text "POLICE", star shape, checker band)
export class LiveryEditor implements Menu { constructor(ui: UIRoot | null, host: LiveryEditorHost, start: LiveryDoc); /* pausesGame true */ }
```
Layout: right-side panel 380 px wide (`livery-` CSS prefix), the world view stays visible on the left (orbit with
mouse drag on the canvas area → `host.orbit`, wheel zoom). Tabs: **Paint** (base colour `input[type=color]`, finish
select, wrap kind / colours / split), **Decals** (layer list with type icon and text, add buttons per type, delete,
up / down; the selected layer's fields: face select, sliders for u / v / u0 / u1 / height / size / w / h / angle /
rotation, colour pickers, outline toggle + colour, reflective checkbox, text input (24 chars), font / weight /
italic, shape select, star points, the **polygon pad**: a 200x200 canvas where clicks add points (max 24), drag moves,
right-click deletes — produces `points` in [−1, 1]), **Lights** (style, pattern, siren + Preview button),
**Equipment** (push bar / spotlight / partition checkboxes; disabled with a hint when the model lacks the part:
`model.equipment?.pushBumper == null`, `!model.equipment?.spotlight`, `!model.equipment?.partition`), **Loadout**
(trunk item rows with − / + counts, rack checkboxes, weight and slot bars, validation messages; "Use default"
button), **Library** (list of `host.library()` with Apply / Duplicate; **Export** builds `exportLivery(doc)` into a
`Blob` (`application/json`) and clicks a temporary `<a download="<id>.json">` (URL revoked after); **Import** opens
`<input type=file accept=".json,application/json">`, reads with `FileReader.readAsText`, dispatches `import`; errors
list under the button). Footer: Save (disabled while `errors.length`), Cancel. Every change calls `host.preview` via a
100 ms throttle. Tests (`test/ui7/liveryEditor.test.ts`): reducer add / move / delete / update; invalid update keeps
the previous doc and reports the error path; import of exported text loads an equal doc; import of junk reports
errors; equipment disabling per model; loadout validation messages from a fake host.

### 12.2 Character creator and uniform / gear editor (`src/ui/character/**`)

```ts
export interface CreatorHost {
  readonly mode: 'newGame' | 'locker';
  validateGear(l: OfficerLoadout, extraVestSlots: number): LoadoutValidation;
  preview?(p: CharacterProfile, gear: OfficerLoadout): void;   // locker: live update of the 3D officer figure
  done(p: CharacterProfile, gear: OfficerLoadout): void;
  cancel(): void;
}
export interface CreatorState { profile: CharacterProfile; gear: OfficerLoadout; tab: 'identity' | 'body' | 'uniform' | 'badge' | 'gear'; errors: string[] }
export function creatorReducer(s: CreatorState, a: CreatorAction): CreatorState;   // pure; validates via parseCharacter / validateGear
export function figureSketchRects(app: FigureAppearance, outfit: OutfitDef): { x: number; y: number; w: number; h: number; color: number }[]; // front orthographic sketch of the standing figure (parts + accessory boxes), metres, y up
export class CharacterCreator implements Menu { constructor(ui: UIRoot | null, host: CreatorHost, start: { profile: CharacterProfile; gear: OfficerLoadout }) }
```
Tabs: **Identity** (first / last name, badge number, pronoun preset buttons she/her · he/him · they/them · custom with
five text fields and a singular / plural toggle, a sample sentence rendered with `applyPronouns`), **Body** (sliders
height 1.50-2.05 m, build, shoulders, hips; skin tone swatches + a fine slider that lerps between neighbouring tones;
hair style select, hair colour swatches), **Uniform** (class select, hat, carrier, cold-weather, name plate toggle,
colour override pickers, a 2D sketch canvas 220x420 drawn from `figureSketchRects`), **Badge & patch** (badge shape,
star points, custom polygon pad (reuse `polygonPad.ts`), metal / enamel colours, text; patch shape, colours,
initials, text; both drawn on 2D canvases with `shapePolygon` from livery), **Gear** (assignment select, preset
select, item rows with counts and the holster retention select, weight bar `x / max kg`, slot bars, errors /
warnings). Done is disabled while the identity is invalid (gear errors only warn). The new-game creator opens from
the main menu; the locker mode opens from the locker row "Uniform & gear…". Tests: reducer (pronoun preset, custom
pronouns validation, slider clamps), `figureSketchRects` (helmet over the head, rank chevrons count), gear errors
surfaced.

### 12.3 Fleet panels (`src/ui/fleet/fleetPanels.ts`, pure models over `ActionPanel`)

```ts
export type FleetIntent =
  | { kind: 'checkout'; unitId: string } | { kind: 'checkin'; unitId: string } | { kind: 'customize'; unitId: string }
  | { kind: 'service'; unitId: string } | { kind: 'inspect'; unitId: string } | { kind: 'report'; incidentId: number }
  | { kind: 'request'; request: FleetRequest } | { kind: 'endShift' } | { kind: 'back' };
export function garagePanelModel(units: readonly FleetUnitView[], ctx: { atStation: boolean; driving: string | null; nearUnit: string | null }): ActionPanelModel;
export function garagePanelPick(index: number, units: readonly FleetUnitView[], ctx: ...): FleetIntent | null;
export function servicePanelModel(unit: FleetUnitView, quotes: Readonly<Record<'refuel' | 'oil' | 'tires' | 'repair' | 'all', Quote | null>>): ActionPanelModel;
export function servicePanelPick(index: number, unit: FleetUnitView): FleetIntent | null;
export function inspectionPanelModel(result: InspectionResult | null, incidents: readonly DamageIncident[], unitId: string): ActionPanelModel;
export function inspectionPanelPick(index: number, ...): FleetIntent | null;
export function shiftSummaryModel(e: EventMap['fleet:shiftEnd'], charges: readonly LedgerEntry[]): ActionPanelModel;
```
Garage panel: title "Fleet", subtitle "City Police · yard", one row per unit ("P-101 Patrol sedan", detail "READY ·
fuel 80 % · in yard" / "OUT (you)" / "DAMAGED"), a row's pick toggles a submenu (Check out, Return, Customize…,
Service…, Inspect); away from the station the panel lists units read-only plus "File damage report" rows. Service
panel: "Refuel ($ 46)", "Oil change ($ 80)", "Replace tyres ($ 360)", "Repair ($ 2 640)", "Everything ($ 3 126)",
disabled when the quote is 0. Inspection panel: one row per inspection row ("✓ Fuel at least a quarter tank" /
"✗ Tyre tread — Tread 25 % (RL) · fix: tires"), "File damage report: P-101 front, 34 km/h" per unreported incident,
"Re-inspect", "End shift" (enabled at the station). Tests for each model / pick.

### 12.4 HUD (`src/ui/hud/**`)

`HudSnapshot` optional additions: `wear?: { oil: number; tread: number } | null` → chips "OIL LOW" (< 0.25), "TYRES
WORN" (< 0.25); `altitude?: number | null` → "ALT 120 m"; `battery?: number | null` → "BATT 64 %" (drone, replaces
the fuel gauge label); `fleet?: string | null` → a chip ("P-101 · damage report due"); `gearWarning?: string | null` →
the legal / flash line style ("Loadout: overweight 15.2 / 14 kg"). DOM writes on change at 10 Hz; tests in
`test/hud/phase7.test.ts`.

### 12.5 Main menu (`src/ui/mainMenu.ts`)

`MainMenuCallbacks.newGame(seed, jurisdiction?, character?: { profile: CharacterProfile; gear: OfficerLoadout })`
(third argument optional: old callers keep working). The menu gains a "Create officer…" button beside New game that
opens the `CharacterCreator` (mode `newGame`; `done` stores the result in the menu and shows "Officer: Jordan Doe
(they/them)" under the button); New game passes it (or undefined). Test with the existing main menu harness.

### 12.6 MDT career tab (`src/ui/mdt/career.ts`)

`MdtDeps.fleet?: { summary(): { points: number; departmentCost: number; incidents: number; unreported: number };
charges(): readonly LedgerEntry[] }` (optional, absent in older tests) → a "Fleet" block in the Career tab (points
charged this career, department cost, unreported damage, the last 10 charges). Extend `test/mdt/career.test.ts`.

## 13. UI structure

| Surface | Owner | Opens on | Pauses |
|---|---|---|---|
| Character creator (identity, body, uniform, badge & patch, gear) | ui `CharacterCreator` | main menu "Create officer…"; locker row "Uniform & gear…" | yes |
| Livery editor (paint, decals, lights, equipment, loadout, library, export / import) + orbit preview of the real vehicle | ui `LiveryEditor`, app camera | garage panel → Customize… (vehicle at the station) | yes (rendering continues; fixed steps paused) |
| Fleet / garage panel | ui `garagePanelModel` + ActionPanel | `'` anywhere; E at the station service point | no |
| Service panel (refuel, oil, tyres, repair, all) | ui | garage → Service…, E at the station pump | no |
| Inspection / damage reports / End shift | ui | garage → Inspect | no |
| Shift summary | ui | `fleet:shiftEnd` | no |
| Locker / armory rows ("Uniform & gear…", "Sign out my loadout") | gear models, existing panels | station | no |
| Drone deploy / recall | app | `=` | – |
| HUD: wear chips, altitude, battery, fleet chip, gear warning | ui HUD, integrator feed | always | – |
| Radio: officer down / vest stopped lines (pronouns) | integrator | officer hit | – |

## 14. ECS components and event topics

No new components in `src/ecs/components.ts`. `VehicleLook` gains `lean`, `rotor`, `trim` (§5.6). Topics: §4.3
(the integrator updates the `src/core/event-map.ts` header comment). Integrator bridges (synchronous in the emitting
step, enqueue only):

| From | To |
|---|---|
| `fleet:charge` | `conduct.request({ kind: 'points', delta: points, reason, key: 'fleet:' + incidentId })` |
| `fleet:flash`, `conduct:points` | HUD flash line |
| `fleet:shiftEnd` | presenter opens the shift summary panel |
| `station:loadout` (vest toggled) | `gear.setVest(loadout.vest)` |
| `npc:attack` kind `fire` within `ballistics.maxRangeM` of the officer on foot | `officerHit(gearRng.next(), gearRng.next(), gear.protection(), d)` in the next session step → `wounded`: radio `officerDown` line + `dispatcher` emergency request (Phase 2 `UnitRequest` emergency), flash; `stopped`: radio `vestStopped` line, flash |
| `player:mode` remote | camera rig follows the drone; officer movement input off |

## 15. Step order, frame order, determinism, workers

| Order | System | Work |
|---|---|---|
| -685 | `force` | + draw delay, weapon-grab rolls (hooks) |
| -675 | `investigation` | + K9 treat bonus |
| -665 | `backup` | + outfits in the view |
| -658 | `conduct` | + points requests |
| **-655** | **`fleet`** | incident merge / close, queued requests (service, report, inspect, endShift) |
| (session) | officer hit | queued `npc:attack` fire events resolved with the `'gear'` stream (integrator, in `fixedUpdate` before the systems) |
| 40 | `vehicles.pre` | + bike upright assist, crafts (stepCraft + character controller), tread grip, craft env (water, anchor = officer for the drone) |
| 110 | `vehicles.post` | + wear, lean / rotor look, craft impacts |

Per frame (`App.update`): `'` / E at the service point open the fleet panels; `=` deploys / recalls the drone; while
remote, `readDriverInput` drives the drone and on-foot movement input is zero; while the livery editor is open the
camera uses the editor's orbit pose (`liveryPreviewPose`, ui pure helper in `src/ui/livery/preview.ts`:
`(target pose, dims, yaw, pitch, zoom, out)`); `LiveryRenderer.update(alpha, camX, camZ, env.lighting.nightFactor)`
after `CarRenderer.update`; PeopleRenderer `setOutfits` when the outfit table changes (character edit, new AI
officers) and sources carry `outfit`.

**Determinism.** Every Phase 7 simulation change happens in fixed steps: crafts, bikes and wear in the vehicles'
steps (own `'vehicle:<slot>'` stream for impacts), the fleet from bus-queued hits and requests (no randomness), officer
hit rolls from `'gear'`, the force grab from `'force'`. Liveries, outfits, editors, painting and the HUD never feed
back. Livery / build changes alter spawn-time state only between steps (push bar damage spec, cage seats, trunk
counts): they are part of the save (fleet units + equipment), so a replay with the same inputs is bit-identical. The
replay test compares v9 saves.

**Workers.** Phase 7 adds no heavy simulation: crafts are O(1) per vehicle, the fleet is event-driven. Livery
painting (≤ 6 ms for a 1024x512 atlas with 32 layers) is presentation on the main thread, at most one repaint per frame
(the editor throttles to 10 Hz) — an `OffscreenCanvas` worker would add a transfer per edit for no gain and is not
needed. The sim worker and the chunk worker are unchanged.

## 16. Save schema v9 (integrator only)

```ts
export interface SaveGameV9 extends SaveGameV8 {
  character: CharacterSave;  // the officer's profile (name, badge, pronouns, body, outfit)
  gear: GearSave;            // officer loadout + presets
  fleet: FleetSave;          // units (livery id, loadout, vehicleIndex, stored condition), custom liveries, incidents, reports, ledger, inspection, queue, rng
}
// vehicles[i]: optional wear / craft / pushBar (SerializedVehicle); player.mode may be 'remote' (vehicle = the drone's index);
// equipment[i]: optional extraPrisoners
```
`CURRENT_SAVE_VERSION = 9`. `migrateV8ToV9(data)`: `character: { version: 1, profile:
characterFromLegacy(data.officer.name, data.officer.badge) }`, `gear: defaultGearSave()`, `fleet:
migratedFleetSave(createRng(data.seed).stream('fleet').state(), data.vehicles.map((v) => v.modelId))`. Load order: …
command → **character → gear → fleet** (rebind units to the restored vehicles by `vehicleIndex`, re-apply liveries and
trim bits) → radio → primeContacts. `isSaveGameV9` = v8 checks + `isCharacterSave`, `isGearSave`, `isFleetSave`, the
optional vehicle fields (finite numbers / 4-tuples) and the `remote` mode. `officer { name, badge }` stays in the save,
kept equal to `displayName(profile)` / `profile.badge`. Tests (`test/save`): v1..v8 → v9 migrate and validate; v9
round trip; each malformed new block rejected; a migrated v8 save checks out the motorcycle and flies the drone.

## 17. Performance budget (60 FPS, mid-range desktop)

| Subsystem | Budget | Notes |
|---|---|---|
| Crafts (boat / helicopter / drone) | ≤ 0.02 ms per craft per step | O(1) integrator + one character-controller query |
| Bike upright assist | ≤ 0.002 ms per bike per step | a few multiplies + one torque impulse |
| Wear | ≤ 0.002 ms per vehicle per step | typed arrays, no allocation |
| Fleet step | ≤ 0.005 ms/step idle; ≤ 0.2 ms on a request | event-driven |
| Parked fleet | ≤ 6 dynamic vehicles + 2 crafts spawned at start; others stored (no physics) | check-out spawns one at a time |
| CarRenderer | +1 rotor draw call when visible; +2-3 calls per visible new model; police model capacity 16 | instanced |
| LiveryRenderer | ≤ 8 shells = ≤ 8 draw calls; repaint ≤ 6 ms, only on change (editor ≤ 10 Hz) | 2 × 1024x512 canvases per liveried vehicle (≤ 17 × 4 MiB textures worst case; dispose on remove) |
| PeopleRenderer | +1 draw call (`people-gear`), ≤ 24 boxes per outfit figure, ≤ 2 048 instances | no per-frame allocation |
| Editors | DOM rebuild on change only | pausing |
| HUD additions | 10 Hz, write on change | |
| Save size | + ≤ 60 KiB typical (32 custom liveries ≤ 8 KiB each worst case 256 KiB) | |

## 18. Requirement map

| Requirement | Code |
|---|---|
| 17 generic procedurally modelled archetypes (sedan / SUV patrol, supervisor SUV, unmarked, traffic, K9, motorcycle, bicycle, ATV, SWAT truck, armored, prisoner transport, command post, crime lab, boat, helicopter, drone) | §5.2 JSON models, `carParts` styles (§10.1), `fleet.json` units (§9.1) |
| Data-driven handling and equipment slots | model JSON (engine, steering, craft / bike sections, cargo, patrol extras), gear vehicle loadout validation (§8.3) |
| Simple control models: motorcycle / bicycle / ATV / boat / helicopter / drone | bike upright assist + lean (§5.4), ATV = car, `stepCraft` boat / helicopter / drone (§5.3), `vehicle.lift`, remote player mode (§5.7) |
| Livery editor: layered decals, procedural shapes / text, user-made shapes, colour schemes, reflective striping, unit numbers, light bar + siren tone, push bar, spotlight, partition, loadout, wraps for unmarked | `LiveryDoc` (§6.1), `paintLivery` + `shapePolygon` (§6.4-6.5), polygon pad, `LiveryEditor` tabs (§12.1), `TRIM` bits + hidden light bar (§10.2), `PatrolEquipment` siren / pattern, unmarked defaults (§6.3) |
| Live 3D preview | `LiveryRenderer` on the real vehicle + editor orbit camera (§10.3, §15) |
| Save / share as JSON, export / import file, schema validation | `exportLivery` / `importLivery` / `parseLivery` (§6.2, mandatory tests), fleet library (§9.5), Blob download / FileReader (§12.1) |
| Equipment per vehicle and per officer with weight / slots, data-driven | `items.json` (gear + police), `policy.json`, `loadouts.json`, `validateOfficerLoadout` / `validateVehicleLoadout` (mandatory tests) |
| Items used by Phase 3-6 systems | naloxone / tourniquet / med kit actions + outcomes (§11.1), ram + Halligan breach (§11.2), holster retention (§11.3), K9 treats (§11.4), evidence kit → scene kit, armory "Sign out my loadout", vest → `officerHit` (§8.4, §14), long guns racked per vehicle loadout, drone in the trunk |
| Uniform classes, parametric patches, rank insignia, name plates, badges (generic / user shapes), hats, vest carriers, cold weather | `uniforms.json`, `parts.ts`, `buildOutfit` (§7.2-7.3), badge / patch designers (§12.2) |
| Applied to the officer humanoid (Phase 3 figure upgraded) and AI officers | `PeopleRenderer` gear mesh + shoulders / hips (§10.4), `aiOutfitSpec` (deterministic), backup `appearanceOf` (§11.5), station staff outfits |
| Body-type and gender-inclusive creator; pronouns in radio / reports | `CharacterProfile` (§7.4), `CharacterCreator` (§12.2), `applyPronouns` + `lines.json` (officer down radio, damage report, report header) (§7.6, §20) |
| Maintenance: fuel, oil, tyre wear, station garage repair, damage reports, career-score charges, shift-end inspection | `wear.ts` (§5.5), `FleetSystem` service / incidents / reports / endShift (§9.5), `accounting.ts` (mandatory tests), `inspection.json` + `runInspection` (§9.3), conduct points (§11.6) |
| Mandatory tests | livery schema + round trip (§6.2), loadout validation (§8.3), uniform determinism (§7.3), maintenance accounting (§9.2) |
| Save version + tested migration | §16 |
| Determinism, perf, workers, no new dependencies | §15, §17, §19 (blockers: none) |

## 19. Modules, ownership and waves

| Key | Wave | Owns (exclusively) | May import (new Phase 7 code) |
|---|---|---|---|
| vehicles | 1 | `src/vehicles/**`, `src/data/vehicles/**`, `src/player/**`, `src/input/actions.ts`, `src/input/bindings.ts`, `test/vehicles/**`, `test/player/**`, `test/input/**` | none |
| livery | 1 | `src/livery/**`, `src/data/livery/**`, `test/livery/**` | none |
| uniform | 1 | `src/uniform/**`, `src/data/uniform/**`, `test/uniform/**` | none |
| gear | 1 | `src/gear/**`, `src/data/gear/**`, `src/police/**`, `src/data/police/**`, `src/station/**`, `src/data/station/**`, `test/gear/**`, `test/police/**`, `test/station/**`, `test/stationui/**` | none |
| fleet | 2 | `src/fleet/**`, `src/data/fleet/**`, `test/fleet/**` | vehicles, livery, uniform, gear |
| render | 2 | `src/render/vehicles/**`, `src/render/livery/**`, `src/render/people/**`, `test/vehiclerender/**`, `test/liveryrender/**`, `test/peoplerender/**` | vehicles, livery, uniform |
| hooks | 2 | `src/calls/**`, `src/data/calls/**`, `src/indoors/**`, `src/force/**`, `src/data/force/**`, `src/evidence/**`, `src/investigation/**`, `src/backup/**`, `src/conduct/**`, `test/calls/**`, `test/indoors/**`, `test/force/**`, `test/evidence/**`, `test/investigation/**`, `test/backup/**`, `test/conduct/**` | gear, uniform (types only) |
| ui | 3 | `src/ui/livery/**`, `src/ui/character/**`, `src/ui/fleet/**`, `src/ui/hud/**`, `src/ui/mainMenu.ts`, `src/ui/mdt/career.ts`, `src/ui/styles.css`, `test/ui7/**`, `test/hud/**`, `test/mainMenu/**`, `test/mdt/career.test.ts` | all |
| integrator | 4 | `src/app.ts`, `src/game/**`, `src/core/event-map.ts`, `src/ecs/components.ts`, `src/save/**`, `docs/PHASES.md`, `scripts/smoke.mjs`, and unowned files (`docs/ARCHITECTURE.md`, `README.md`, `src/main.ts`, other `src/**`, `test/game/**`, `test/save/**`, other tests) | all |

A module that needs a change in a file it does not own lists it for the integrator in its final report instead of
editing it. Same-wave modules never import each other's Phase 7 additions (wave 2: fleet, render and hooks are
independent; hooks allocates its own `outfit` array rather than relying on render's `createHumanoidSource` change).

## 20. Integrator plan

1. **Save v9** (`src/save/**`, `test/save/**`): types, validators, `migrateV8ToV9`, fixtures, tests (§16).
2. **Session** (`src/game/session.ts` + new `src/game/phase7.ts` holding the construction and ports):
   - `OfficerGear` (from the save or the new-game creator), `CharacterProfile` (keeps `officer.name / badge` in sync),
     `FleetSystem` (`rng.stream('fleet')`; ports: `vehicleOf` = the bound `DrivableVehicle`; `damageContext(eid)` =
     pursuit when the scene / pursuit system has an active vehicle pursuit owned by the player, emergency when the
     vehicle's `lightbar` and its equipment `sirenOn`; `officer()` from the profile); register `fleet` at −655.
   - **Fleet spawning:** replace `parkPatrolCars` with `parkFleet()`: `fleetYard(city)`; `startParked` units in
     `slots[0..]` (P-101, P-102: same models and slots as Phase 1-6, so old determinism expectations hold), `startHome`
     units at `boatSlip` / `helipad` when non-null; each spawn = `spawnVehicle(model, pose, build)` with `build.pushBar
     = livery.equipment.pushBar`, `PatrolEquipment(spec', { cageSeats: model.patrol.cageSeats, trunk:
     fleet.loadout(u).trunk, rack: fleet.loadout(u).rack })` where `spec'` = `model.equipment` with `spotlight` /
     `partition` and-ed with the livery's equipment flags; tone / pattern from `livery.lights`;
     `VehicleLook.color[eid]` from `livery.wrap?.colors[0] ?? livery.base.color`; `VehicleLook.trim[eid] =
     trimBits(...)`; `LiveryRenderer.set(eid, model, doc, number, 'City Police')`; `fleet.bindVehicle(u, eid)`.
   - **Check out / in:** new `GameSession.removeVehicle(index)` (dispose the vehicle, equipment, RNG slot bookkeeping;
     keep the vehicle stream names stable by never reusing a slot index: the RNG stream is `'vehicle:' + spawnCounter`
     with a saved counter, or store each vehicle's stream state as today), clears `lastVehicle` when it pointed there.
     Check out spawns the unit at `garage` (moving any parked vehicle off that slot first: store it), check in (unit
     parked within the yard, nobody in it) despawns with `fleet.unbindVehicle(u, vehicle.serialize())`; a stored unit
     respawns with `DrivableVehicle.restore` of its stored data at the garage pose.
   - **Crafts:** `vehicleEnv.isWater = (x, z) => blockKindAt(x, z) === BLOCK_KIND.water` (via `city.blocksIn` on a
     tiny rect; cache the last block), `waterY = −0.05`, `groundY = 0`, anchor = the officer's position for the drone.
     Boats: exit only when the driver-side exit point (`exitPoint(c, -1, out, halfWidth + 2)`) is not water ("Dock
     first"); helicopter: exit only when `altitudeM < 0.5`.
   - **Drone:** `=` on foot near (≤ 4 m) a vehicle whose trunk has a `drone` (or carrying one) → spawn `police_drone`
     2 m ahead at y = 1.2, take the item from the trunk, `modes.remote(eid)`; `=` again (or battery empty / out of
     range 20 s) → recall: despawn, return the item, `modes.endRemote()`. While remote the officer stays put (zero
     movement input) and the camera follows the drone (chase or cockpit).
   - **Gear at shift start:** `beginShiftInStation` / new game: OfficerKit gets `gear.kitGrants()` (replaces
     `FIELD_KIT`); armory panel gets `gear.armoryItems()`; `force` gets `holsterLevel: () => gear.retention()`;
     investigation `k9Treat: () => officerKit.consume('k9Treats')`; flash the policy errors once at shift start
     (`gearWarning` HUD line while invalid).
   - **Officer hit:** queue `npc:attack` kind `fire` events; resolve in `fixedUpdate` with `rng.stream('gear')` (§14).
   - **Backup outfits:** `appearanceOf(cs, role)` → outfit table index (dedupe by `OutfitDef.id`) built from
     `aiOutfitSpec(seed, cs, role, env.weather.temperatureC)`; partner and station staff likewise; the player's outfit
     from the profile.
   - **Radar:** traffic enforcement unit (`model.patrol.radar`) doubles the speed-reading range in `observedSpeed` (the
     Phase 2 target pick / `speedLog`), nothing else.
   - **Uniform policy:** entering a vehicle whose fleet class has a `vehiclePolicy` rule the uniform breaks → flash
     "Policy: wear the motor uniform for this unit" (not blocking).
   - Bridges of §14; serialize / load v9 in the §16 order; dispose the fleet before force.
3. **App** (`src/app.ts`): `LiveryRenderer`; `PeopleRenderer.setOutfits` and sources with outfits; the rider figure
   for open vehicles (`model.rider`: the officer figure anchored to the vehicle in pose seated / stand); cockpit
   interior only for car styles; input actions (`'`, `=`, lift); panels (garage, service, inspection, shift summary);
   livery editor host (preview applies the draft through the same apply path as spawning, on the live vehicle; cancel
   restores); character creator in the main menu and locker (`lockerSelect` returns `'customize'`); HUD feed fields
   (§12.4); MDT `fleet` deps; perf extras `fleet` (incidents open), `shells`, `gear` (instances).
4. **Console** (`src/game/phase7Commands.ts`): `fleet list | checkout <unit> | checkin | service <kind> | inspect |
   report <incidentId> | endshift | ledger`, `livery list | apply <id> | export <id> | import <json>`, `gear show |
   validate | preset <id> | retention <1-3>`, `uniform <class> [hat] [cold]`, `char show | pronouns <she|he|they>`,
   `drone`, `wear oil|tread <0..1>`, `hit` (simulate a round at the officer).
5. **Determinism test** (`test/game/phase7.test.ts`): new game with a custom character; check out the motorcycle,
   ride a slalom; crash P-101 into a wall (incident, report filed); service at the station; fly the helicopter up and
   land; deploy and recall the drone; inspection + end shift (charges applied to career points); two runs →
   bit-identical v9 saves; a load mid-flight continues exactly; a v8 save loads.
6. **Smoke** (`scripts/smoke.mjs`): Phase 7 steps: main menu → Create officer (they/them, sliders) → New game; locker
   → Uniform & gear (switch to tactical, ballCap) — screenshot `phase7-character.png`; armory "Sign out my loadout";
   `'` → check out S-201 → Customize… → add a text decal and a polygon shape, change siren → Save — screenshot
   `phase7-livery.png`; export JSON and re-import it; `fleet checkout M-601`, ride; `fleet checkout AIR-2` (at the
   helipad), climb with Space — screenshot `phase7-heli.png`; `=` drone; crash, service, inspect, End shift (career
   points change); save / load v9.
7. **Docs**: event-map comment, `ARCHITECTURE.md` Phase 7 section, `PHASES.md` Phase 7 entry (controls, checklist,
   perf, limitations), README controls.

## 21. Known limitations and later-phase hooks

- Motorcycles and bicycles are four-wheel ray-cast vehicles on a narrow virtual track with an upright assist; the lean
  is visual. They cannot wheelie or fall over.
- The boat moves on a flat water plane (no waves, buoyancy or wake); docking is any point next to a quay.
- The helicopter is an arcade model (no torque, translational lift or autorotation flare); it collides with streamed
  building colliders only near the officer's position (3 x 3 chunks).
- Liveries are canvas decals on a box shell; damage deformation does not bend them; at most 8 shells are drawn.
- Uniform accessories are boxes; badges and patches are detailed only in the 2D designers.
- Cuffs, radio and flashlight are policy requirements (validation); the systems that use them (arrest, radio,
  flashlight) do not yet refuse when they are missing from a non-compliant loadout.
- The fleet charges career points; it does not suspend officers for repeated wrecks (the IA rules could read the
  ledger later).
- AI resource units keep their Phase 6 models; the new archetypes are player-driven only.
