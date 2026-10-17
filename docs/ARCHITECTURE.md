# Patrol — Architecture

Browser-based law-enforcement patrol simulator. Vite + TypeScript (strict), three.js, Rapier (WASM), bitECS, Web Workers, IndexedDB, Web Audio, Web Speech.

## Guiding rules

- **Deterministic simulation.** Every random decision goes through a seeded RNG stream (`src/core/rng.ts`). Same seed + same inputs = same shift.
- **Fixed-timestep simulation, variable-rate render.** `src/core/loop.ts` accumulates real time and steps the simulation at `SIM_HZ` (60). Rendering interpolates.
- **Data-driven content.** Calls, laws, vehicles, uniforms, names, dialogue live in `src/data/**/*.json` (+ TS types/validators). Adding content must not require engine changes.
- **Versioned persistence.** Every persisted schema has `version`; `src/save/migrations.ts` holds forward migrations; loading an older version migrates then validates.
- **Everything subscribes through the event bus.** `src/core/events.ts` — typed topics, no direct cross-system coupling.
- **Perf budget first.** 60 FPS target on mid-range desktop GPU; perf overlay from Phase 0.

## Directory layout

```
src/
  main.ts                 bootstrap: creates App, mounts UI, starts loop; exposes the App as `window.patrol` in dev builds
  app.ts                  App composition root; owns systems, renderers, HUD and workers; a fresh physics world per session
  core/
    loop.ts               fixed-timestep game loop (accumulator, maxSubSteps, interpolation alpha)
    events.ts             typed EventBus (on/off/once/emit), event map in core/event-map.ts
    rng.ts                seeded PRNG (xoshiro128**), named child streams via stream(name), serialize/restore state
    time.ts               GameClock (sim time, time scale, pause)
    log.ts                leveled logger that also feeds the debug console
  ecs/
    world.ts              bitECS world wrapper, entity lifecycle helpers
    components.ts         SoA component definitions (Transform, Velocity, ...); Phase 1 stores live in their modules
    systems.ts            system registration/order; a System is { name: string; run(world, dt): void }, registered with an order number (lower runs first)
  physics/
    physics.ts            Rapier world mapped to entity ids (boxes, ground, kinematic/dynamic bodies, registerBody, collision events, raycasts, syncToEcs)
  input/
    input.ts              InputManager: action map, keyboard/mouse/gamepad sources, rebinding
    bindings.ts           default bindings + serializable binding schema
    actions.ts            action ids with kind and label
  save/
    db.ts                 IndexedDB wrapper (open, get, put, delete, list) with versioned object stores
    schema.ts             SaveGame (v5) type, nested validators + CURRENT_SAVE_VERSION
    migrations.ts         ordered migration functions vN -> vN+1
    saveManager.ts        save/load/list/delete slots, autosave, validates & migrates
  settings/
    settings.ts           Settings schema (graphics/audio/controls/accessibility), defaults, persistence
  render/
    renderer.ts           three.js WebGLRenderer setup, resize, pixel ratio, draw distance, optional post pass, scene/camera holders
    meshSync.ts           MeshRegistry: one instanced box pool (debug boxes and the on-foot officer), Transform interpolation
    vehicles/             CarRenderer (instanced bodies, glass, wheels, lamp lenses, light bars, headlight spots), carParts, damageVisual
  world/                  procedural city (pure: no THREE/DOM, also runs in the chunk worker)
    constants.ts, ids.ts  world size, chunk/district grid, id maps (road class, junction, surface, district, ...)
    data.ts               validated world data (districts, district types, road classes, zones, landmarks, street names)
    generate.ts           generateCity(seed): districts, road lines, classes, junction control, signals, zones, names, blocks, POIs
    roadGraph.ts          RoadGraph: lanes, connections, signal aspects, zone limits, spatial queries, A* routing
    city.ts               City (graph, blocks, POIs, spawn, parking, districtAt, surfaceAt)
    chunkLayout.ts        per-chunk buildings/props/signs/signal heads/ground/colliders as flat typed arrays
    colliders.ts          WorldColliders: static Rapier colliders streamed around the player (fixed step)
    stationLayout.ts, geom.ts, spatialHash.ts
    render/               chunk mesher, chunk worker (+ protocol, host), ChunkStreamer, CityMaterials, SignalHeads, StreetlightPool
  environment/
    time.ts, sky.ts, weather.ts  game clock, sun/moon and sky keyframes, deterministic weather timeline
    environment.ts        Environment: time, weather, lighting per fixed step; serialize/restore
    crime.ts              crime time-of-day table (consumed from Phase 3)
    render/               EnvironmentRenderer (sky dome, sun/moon light, hemisphere, fog, precipitation, heat-haze pass)
  vehicles/
    drivableVehicle.ts    DrivableVehicle: Rapier ray-cast vehicle, gearbox, steering, ABS, brake fade, fuel, damage, lights
    model.ts              vehicle models loaded from src/data/vehicles/*.json
    controls.ts, brakes.ts, fuel.ts, damage.ts, surfaces.ts   pure helpers
    components.ts         VehicleLook, Drivable stores + attach helpers
  player/
    mode.ts               PlayerModeMachine (on foot / driving), driver door / exit points, findEnterable
    driverInput.ts        readDriverInput
    cameraRig.ts          CameraRig: on-foot orbit, chase / hood / cockpit cameras (pure pose maths)
  traffic/
    trafficSystem.ts      TrafficSystem: SoA ambient traffic (IDM, junctions, proxies, violations, snapshot/restore)
    registry.ts           60 000 persistent vehicle records and plates derived from the seed
    data.ts, idm.ts, components.ts
  debug/
    perfOverlay.ts        frame time, fps, draw calls, triangles, entities, sim step time, memory, extras
    console.ts            in-game debug console (` key), command registry, history, autocomplete
    worldCommands.ts      Phase 1 commands (time, weather, tp, route, road, car, traffic, plate, chunks)
  ui/
    ui.ts                 DOM UI root, layering, menu stack
    settingsMenu.ts       settings menu bound to Settings
    mainMenu.ts           new game / continue / settings
    hud/                  Hud (speed, gear, fuel, warnings, damage, clock, weather, street, limit, prompts), Minimap
  workers/
    protocol.ts           typed message protocol for worker RPC
    sim.worker.ts         Phase 0 worker (ping, RNG check) — proves the worker pipeline
  records/                persons, registrations, plates, VINs, BOLOs: pure functions of (seed, id) + a saved overlay (RecordsDb)
  cad/                    CAD core: shared types, call-type / statute / ten-code / disposition tables, addresses, CadState
                          (calls, units, AVL, documents, traffic-stop context), bus topics (cad:*, dispatch:*, unit:request)
  dispatch/               Dispatcher: call generator, offers, AI unit FSMs on fleet cars, backup, emergency, status checks
  radio/                  RadioSystem (channels, scan, composer, ambient chatter, RadioNet scheduling), RadioPlayer (FX + TTS),
                          RadioController (keys, menu, push-to-talk), voice grammar, spoken text
  police/                 PatrolEquipment (siren, light-bar pattern, spotlight, rack, trunk, cage), OfficerKit, PoliceLights store
  audio/                  AudioEngine (lazy AudioContext), SirenBank (4 positional synthesized voices), RadioFx (synthesized FX)
  speech/                 SpeechOut (speechSynthesis wrapper, per-speaker voices), SpeechIn (SpeechRecognition wrapper)
  render/police/          CockpitRenderer (patrol-car interior, <= 6 draw calls), MdtScreen (in-car laptop canvas), spotlight pose
  ui/mdt/                 MdtOverlay: the full-screen keyboard-first MDT (queue, call, units, map, person, vehicle, BOLO, reports, stop)
  ui/panels/              ActionPanel (non-pausing option list), RadioPanel (log, channel strip, caption), RadioMenuView
  people/                 Population: lazy deterministic identities (name, DOB, address, family, temperament, honesty, language,
                          hearing, health, drinker/drug use, appearance, hidden items) over the Phase 2 records, per-person deltas
  calls/                  call catalog types + validator (27 families, 163 types), condition engine, scenario builder, CAD rows
  npc/                    NpcSystem: ambient pedestrians (LOD), scene actors (behaviour state machine), car occupants, `view`
  dialogue/               pure dialogue engine (tone, topics, consent, lies, escalation), inconsistency rules, PBT / frisk / SFST tools
  contact/                ContactManager: conversations, field actions, statements and facts, escort and cage
  scene/                  SceneDirector: scenario runtime of the calls (materialize, timeline, actions, services, pursuits, outcomes)
  render/people/          PeopleRenderer (7 instanced meshes, bone-less limbs), PropRenderer, pose maths (pure)
  ui/dialogue/            DialoguePanel, SfstPanel, SubtitleBar
  game/
    session.ts            GameSession: one shift in the city (officer, patrol cars and their equipment, colliders, traffic,
                          environment, CAD, records, dispatcher, radio, people, npc, contact, scene), interactions, save/load
    peoplePresenter.ts    Phase 3 presentation: people and props rendering, the officer's figure, dialogue / SFST panels,
                          subtitles and NPC speech, HUD weapon / contact / scene / pursuit feed, people minimap markers
    phase3Commands.ts     call / npc / dialogue / population console commands
    worldView.ts          render side of a session's city (chunk streamer, signal heads, streetlights, minimap)
    hudFeed.ts            fills the HUD snapshot from the session at 10 Hz
    policeFeed.ts         Phase 2 presentation: HUD police/unit/call/offer/target/carried lines, minimap markers,
                          in-car MDT screen model, cockpit state, radio menu context (never touches records)
    panels.ts             trunk / equipment / driver-contact panels on one ActionPanel
    target.ts             TargetTracker: the 10 Hz reticle pick for plate runs
    mdtDeps.ts            what the MDT reads from the session; patrolCommands.ts: cad / lookup / lights / radio shortcuts
    commands.ts           Phase 0 console commands; pauseMenu.ts, playerController.ts, sceneLayout.ts, route.ts
  data/                   JSON content: world/, environment/, crime/, vehicles/, physics/, traffic/, records/, cad/,
                          dispatch/, radio/, police/, audio/, people/, calls/, npc/, dialogue/, scene/
test/                     vitest unit tests, one folder per src module (node environment, no DOM/WebGL)
docs/
  ARCHITECTURE.md         this file
  phase1-design.md        Phase 1 design: data formats and the full module APIs
  phase2-design.md        Phase 2 design (police vehicle, MDT, CAD, radio): data formats, module APIs, topics, save v4
  phase3-design.md        Phase 3 design (people, calls, dialogue, scenes): data formats, module APIs, topics, save v5
  ASSETS.md               third-party asset license tracking
  PHASES.md               per-phase completion log: what was done, how to run, what to test
```

## System contracts

### Game loop
```ts
interface LoopHooks {
  fixedUpdate(dtSeconds: number, step: number): void; // SIM_HZ, deterministic
  update(dtSeconds: number, alpha: number): void;      // per-frame (input polling, camera)
  render(alpha: number): void;
}
```
Accumulator clamps to `maxFrameTime` (0.25 s) to avoid spiral-of-death; at most `maxSubSteps` (5) fixed steps per frame (scaled up with `timeScale`, which is bounded to `MAX_TIME_SCALE` = 8 by the loop, `GameClock`, the `timescale` command and save validation, so a frame never runs more than 40 steps). A hook that throws is logged and the loop keeps scheduling frames.
`loop.timeScale` scales real time before it reaches the accumulator, so every fixed step is exactly `1 / SIM_HZ` of simulated time and the render `alpha` always interpolates the last two simulated states. `loop.paused` (owned by `App.refreshPause`: console pause or any open menu) skips fixed steps but keeps `alpha`. `loop.frameCap` limits frames per second.

### Fixed step and frame order (Phase 1)
Simulation work is registered in the `SystemRegistry` (timed in the perf overlay); `GameSession.systems` holds the session's own systems and `attachSystems` registers them:

| Order | System | Work |
|---|---|---|
| (before) | session `fixedUpdate` | world time, `GameClock`, the on-foot officer's kinematic velocity |
| -1000 | `copyPrevTransform` | Transform -> PrevTransform (interpolation) |
| -900 | `environment` | `env.update(simTime)`: game time, weather, lighting |
| -800 | `colliders` | `WorldColliders.update(player x, z)`: at most one chunk op per step |
| 0 | `integrateVelocity` | Phase 0 |
| 40 | `vehicles.pre` | driver input (or the parked handbrake) -> `mapDriverInput` -> `setControls`, `preStep(dt, envAdapter)` |
| 50 | `traffic` | `traffic.step(dt, simTime, env.time, focus)` (focus = the driven car or the officer, with velocity) |
| 100 | `physics` | `physics.step()`, `syncToEcs` |
| 110 | `vehicles.post` | `postStep(dt, bus)` (damage, fuel, lights, events); the driving officer's Transform follows the seat |

Phase 2 adds (design §15):

| Order | System | Work |
|---|---|---|
| -700 | `dispatch` | `dispatcher.step(dt, {sim, game}, player)`: queued requests and bus events, call generator, offers, assignment, AI unit FSMs (fleet state of the previous step), status checks, AVL (2 Hz), fleet `PoliceLights` |
| -650 | `radio` | `radio.step(dt, {sim, game}, player)`: ambient chatter, `RadioNet` start / end / overlap (stepped-on) of transmissions |
| 40 | `vehicles.pre` | + `PatrolEquipment.writeLook(eid, lightbar)` for every patrol car (`PoliceLights`: pattern, siren tone, horn / manual held by the driver, spotlight) |
| 50 | `traffic` | the focus now carries the driven patrol car's `heading`, `lights` and `siren`: traffic stops, yielding, fleet cars |

Per frame (`App.update`): input -> toggles (Escape: console, then the radio menu, then pause; the MDT and action panels close themselves on Escape) -> mode actions (interact: enter / exit / refuel / trunk / driver contact; camera, headlights, light bar, map zoom, MDT, plate run, siren / tone / pattern / spotlight / equipment panel) -> on-foot look/move or `readDriverInput` and the held horn / manual (stored for the next fixed steps), spotlight aim -> `RadioController` (only while gameplay controls are active) -> `CameraRig` (spotlight aim zeroes the look) -> target pick (10 Hz, `pickTrafficCar` from the camera) -> MDT and action panels -> `EnvironmentRenderer.update` -> `WorldView.update` (chunk streaming at the fog distance, signal heads, streetlights) -> `CarRenderer.update` (+ spotlight target) -> `CockpitRenderer` + `MdtScreen` paint (cockpit view, <= 2 Hz) -> audio (listener from the camera, siren emitters from `PoliceLights`) -> HUD, minimap with markers and the route to the assigned call (10 Hz) -> radio channel strip (4 Hz). Radio lines and captions are written on `radio:start` / `radio:blocked`. Render: `meshes.syncFromEcs`, `renderer.render()`, perf sample (draw calls, triangles, entities, extras `chunks`, `traffic`, `cars`, `dispatch`, `radio`, `audio`, `cockpit`).

Pause rule (`App.refreshPause`): paused while the console `pause` is on or any menu whose `pausesGame !== false` is open. The MDT overlay and the action panels are non-pausing: the world keeps running behind them (`UIRoot` gives their layer the light, blur-free `menu-layer-live` style), gameplay controls are off while they are open (the car coasts). Audio is suspended and speech paused with the game.

### Determinism across sessions
Rapier does not return to a pristine state after bodies are removed, so `App` disposes the physics world and clears the ECS world before every new or loaded session (`createScenePhysics`: gravity, one ground slab of half size `WORLD_HALF_SIZE + 64` and four boundary walls `WORLD_WALL.offset` outside the world edge, which edge chunks draw along with the outer half of the perimeter roads). The session advances `world.time` and its `GameClock` once per fixed step; both are rewound when a session starts and restored from `clock.simTime` on load. The city is rebuilt from the seed (`generateCity` is pure; the app caches the last one). City, colliders, vehicles, traffic and weather depend only on the seed, the input sequence and sim time; every draw comes from a named stream (`'traffic'`, `'vehicle:<slot>'`, `'colors'`, `'world:*'`, `'registry:<id>'`, `'weather'`); worker, streaming and render state never feed back into the simulation. `test/game/session.test.ts` replays a scripted 1200-step shift twice and compares the saves.

Phase 2 keeps the same contract: everything that changes simulation state runs in fixed steps and draws only from named streams (`'dispatch'` with children `'calls'` / `'units'`, `'radio'`, `'traffic'` for fleet cars, `'lights:<slot>'` for light-bar phases; records from `'records:person:<id>'`, `'records:vehicle:<id>'`, `'records:bolo:<day>'` off `createRng(seed)`). Player input from the MDT, the radio menu, voice and keys becomes `UnitRequest`s that the dispatcher queues and applies at the start of its next step; bus handlers only enqueue. TTS / audio timing, the DOM, speech recognition and the 10 Hz target pick never feed back (presentation reads records through pure identities only, so the saved records snapshot is not touched by the HUD). `test/game/session.test.ts` replays a scripted patrol (calls, AI units, a light-bar traffic stop, radio plate run, citation, emergency button) to bit-identical v4 saves and checks that a loaded mid-shift save continues exactly.

Session teardown order: radio, dispatcher, traffic (fleet cars included), drivable vehicles, colliders, the officer and boxes (`GameSession.dispose`), then the render side (`WorldView.dispose`: streamer, signal heads, streetlights, minimap) and the per-session presentation (MDT overlay, radio log, radio controller, HUD feed), then the physics world is replaced.

### Event bus
```ts
type EventMap = { 'input:action': {...}, 'save:completed': {...}, ... }
bus.on('topic', handler): () => void  // returns unsubscribe
bus.emit('topic', payload)
```
Phase 1 modules add topics by declaration merging in their own `events.ts`: `env:hour`, `env:weather` (environment), `vehicle:damaged`, `vehicle:tireBurst`, `vehicle:engineStalled`, `vehicle:engineFailed`, `vehicle:fuelEmpty` (vehicles), `traffic:spawned`, `traffic:despawned`, `traffic:collision`, `traffic:violation` (traffic), `player:mode`, `camera:mode` (player). Payloads are emitted on rare events only.

Phase 2 topics (design §14): `cad:callCreated`, `cad:callUpdated`, `cad:callClosed`, `cad:unitAssigned`, `cad:unitStatus`, `cad:documentSaved`, `cad:trafficStop` (CadState), `unit:request` (radio, app), `dispatch:offer`, `dispatch:plateResult`, `dispatch:personResult`, `dispatch:backup`, `dispatch:emergency`, `dispatch:statusCheck`, `dispatch:location`, `dispatch:ack`, `dispatch:arrest` (dispatcher; declared in `cad/events.ts`), `traffic:pullingOver`, `traffic:pulledOver`, `traffic:released`, `traffic:fleetArrived` (traffic), `radio:start`, `radio:end`, `radio:blocked`, `radio:channel` (radio). The dispatcher consumes `unit:request`, `traffic:pulledOver` / `released` / `fleetArrived` and `cad:documentSaved`; the radio composer consumes `cad:*`, `dispatch:*` and `traffic:pullingOver`; the session seats the prisoner on `dispatch:arrest`; the app writes the radio log / captions and plays the plate-hit tone.

### RNG
```ts
const rng = createRng(seed)          // master
const traffic = rng.stream('traffic') // deterministic sub-stream by name
traffic.next() / nextInt(min,max) / pick(arr) / chance(p) / state() / restore(s)
```

### World (`src/world`)
`generateCity(seed): City` builds the whole road network and block plan in ~60-130 ms. `City.graph` is a `RoadGraph` (lanes, `connections`, `signalAspect`, `effectiveSpeedLimitMph`, `nearestEdge`, `findRoute`, `routeBetweenPoints`) that later phases (CAD, dispatch) build on. `chunkLayout(city, cx, cz)` returns flat typed arrays for one 256 m chunk, independent of request order. `WorldColliders` streams fixed cuboid colliders (no entity id) in a 3 x 3 chunk window around the player's sim position. Rendering (`world/render`): `ChunkStreamer` requests chunk meshes (LOD0/LOD1, <= 5 / 3 draw calls) from the chunk worker (`createChunkWorker`, falling back to main-thread meshing), keeps chunks within the fog distance + 32 m and unloads beyond + 160 m; `SignalHeads` is one instanced mesh for all signal heads; `StreetlightPool` moves a fixed set of point lights to the nearest streetlights at night.

### Environment (`src/environment`)
`Environment(seed, bus)` exposes `time` (`GameTime`, also the road graph's `ZoneTime`), `weather` (kind, intensity, wetness, snow cover, temperature, fog, wind, heat haze) and `lighting` (sun/moon, night factor, streetlights/headlights on). Weather is a pure function of the seed and game time; only `timeOffset` and the debug override are saved. `EnvironmentRenderer` owns the sky, the sun/moon light, fog (far = min(0.4 x draw distance, weather visibility); its `viewDistance` drives chunk streaming) and precipitation.

### Vehicles and player (`src/vehicles`, `src/player`)
A drivable vehicle is an entity with `Transform`, `PrevTransform`, `PhysicsBody`, `VehicleLook` and `Drivable`, plus a `DrivableVehicle` (`create`/`restore`, `setControls`, `preStep`, `postStep`, `refuel`, `repair`, `serialize`, `telemetry`). `PlayerModeMachine` switches on foot / driving; while driving the officer has no body or mesh and its Transform follows the seat. `CameraRig` writes the three.js camera for the on-foot, chase, hood and cockpit views.

### Traffic (`src/traffic`)
`TrafficSystem` simulates up to 192 cars on the main thread in fixed steps (SoA typed arrays, no allocation per step). Each car is an entity with `Transform`, `PrevTransform`, `VehicleLook` and `TrafficCar`; cars near the player get kinematic Rapier proxies. `vehicleRecord(seed, id)`, `plateOf` and `vehicleIdFromPlate` give every one of the 60 000 registered vehicles a persistent identity without storing anything.

### Save
```ts
interface SaveEnvelope<T> { version: number; createdAt: number; updatedAt: number; slot: string; data: T }
```
The object-store key is the slot; `list()` names rows by key and `load()` repairs a disagreeing `slot` field. `migrateEnvelope(envelope)` applies `migrations[version]` until `CURRENT_SAVE_VERSION` (5), then validates with `isSaveGame`; `save()` validates before writing so a save that would not load is never stored. v2 stores each body's transform, linear/angular velocity and sleep state plus the camera pitch (v1 saves migrate with bodies at rest). v3 (Phase 1) adds `player { mode, vehicle, lastVehicle }` (`lastVehicle` is the last-driven vehicle for refuelling and its parked headlights, -1 for none), `camera.mode`, `vehicles` (each `SerializedVehicle` plus its colour and RNG stream), `traffic` (snapshot or null), `violations` (the observed-violation log, `[vehicleId, counts]` pairs) and `environment` (`timeOffset`, weather override); `lastVehicle` and `violations` are optional (absent in early v3 saves); v2 saves migrate on foot with the patrol cars re-parked and fresh traffic. v4 (Phase 2) adds `cad` (calls: open + the last 200 closed, units with AVL, documents, the traffic stop, counters), `dispatch` (the dispatcher's RNG states, timers, AI unit FSMs, offers, status checks, queued events and requests; null in migrated saves: a fresh roster and fleet start at load), `records` (touched person / registration snapshots, contacts, served warrants, added BOLOs, query log), `radio` (channel, scan list, log, queue with on-air entries, holds, ambient timers, RNG, composer state), `equipment` (one `EquipmentSave` or null per `vehicles` entry), `officerKit` and the optional `speeding` readings (citation prefill); the traffic snapshot stays version 1 with the optional fleet / stop / curb fields. Load order: environment, entities, vehicles and their equipment (+ `PoliceLights`), traffic, CAD, records, dispatcher (or `start` when null), radio. `migrateV3ToV4` fills empty CAD and records, a null dispatcher, the default radio with the seed's `'radio'` stream, null equipment and an empty kit. v5 (Phase 3, current, frozen without user approval) adds `people` (a `PeopleSave`: only the persons the shift touched, as deltas over the deterministic base identity: intoxication, mood, custody, injuries, added/seized items, officer contacts, statements, discovered facts, remembered lies, flags), `npc` (pedestrians, scene actors, occupant overrides and stepped-out seats; null in migrated saves: fresh pedestrians at load), `contacts` (open conversations with the subject's memory, transcript, pending answers and SFST state) and `scenes` (the scenarios of open calls with branch, variants, participants, flags, actions and services, up to 200 graded outcomes, props, pursuits, the officer's weapon and the queued requests and events; it holds hidden truth and is never shown). `migrateV4ToV5` adds empty people and contacts, a null npc and an empty scene block on the seed's `'scene'` stream (loading then gives every open CAD call a scenario with `adoptOpenCalls`). Phase 3 load order: environment, entities, vehicles + equipment, traffic, CAD, records, **people**, dispatcher, **npc**, **scenes** (`restore`, then `adoptOpenCalls`), **contacts**, radio. Loading regenerates the city from the seed. Tests assert every version from 1..current migrates and that each malformed block is rejected.

### Input
Actions are abstract (`'move.forward'`, `'vehicle.steer'`, `'vehicle.handbrake'`...). Bindings map device inputs → actions. Rebinding UI edits bindings and persists through Settings; new actions appear in it automatically. Phase 3 actions (on foot): `officer.weapon` (C), `officer.fire` (mouse 0, only with a weapon drawn), `officer.tackle` (Space), `officer.shout` (G), `scene.menu` (Y). Phase 2 actions: `vehicle.sirenTone`, `vehicle.horn`, `vehicle.manual`, `vehicle.lightPattern`, `vehicle.spotlight`, `vehicle.spotAim`, `vehicle.equipment`, `mdt.toggle`, `target.runPlate`, `radio.menu`, `radio.option1..9`, `radio.ptt`, `radio.emergency`, `radio.channelPrev`, `radio.channelNext`, `radio.scan` (defaults in `input/bindings.ts`, design §11.5).

### Debug console commands
Phase 0: `help`, `clear`, `echo`, `seed [n]`, `timescale [x]`, `pause`, `save [slot]`, `load [slot]`, `saves`, `perf`, `fps`, `spawn box [n]`, `entities`, `settings get <path> | set <path> <value> | list`, `worker ping`, `debugcam`.
Phase 1: `time [HH:MM]`, `weather [kind [intensity] | auto]`, `tp <x> <z> | <poi kind> | <district>`, `route <poi kind> | <x> <z> | off`, `road`, `car info | refuel | repair | spawn <modelId>`, `traffic stats | list [n] | density <x> | clear`, `plate <ABC 1234>`, `chunks`.
Phase 3: `call spawn <type> [here] [variant...] | list | types [filter]`, `npc spawn <temperament|profile> | info`, `dialogue debug`, `population density <n> | stats` (`game/phase3Commands.ts`); module commands `scene spawn|info|outcomes|flags`, `weapon` (scene), `peds stats|density|clear`, `actors` (npc), `who <id>`, `intox <id> <bac> [drug]` (people), `catalog stats|families|type <id>` (calls), `flee [stop]` (traffic).
Phase 2: `cad call <type> [here] | calls | show <id> | units | clear [disposition] | docs [kind]`, `lookup plate <p> | person <id|last [first]>`, `lights <pattern|on|off|next>`, `radio say [channel] <text> | channel [id] | scan | log [n]` (integrator shortcuts, `game/patrolCommands.ts`); module commands `calls`, `call <id>`, `units`, `docs` (cad), `person`, `runplate`, `vin`, `dl`, `platestates`, `bolos` (records), `dispatch call|backup|emergency|stats|units`, `pullover [release|abandon]`, `fleet` (traffic), `equip`, `pattern`, `siren <tone|off>` (police), `voices`, `sirentest <tone|horn|off>` (audio).

### People and calls (Phase 3)
Persons are never stored: `Population` (`src/people`) generates an `NpcIdentity` for any of the 100 000 Phase 2 person ids from the seed, the id and the Phase 2 record (so CAD and the world never disagree), caches it per game day (LRU 2 048) and keeps deltas only for persons the shift touched (cap 3 000, protected persons are never dropped). `NpcSystem` (`src/npc`) owns structure-of-arrays pools of ambient pedestrians (density by district and hour, LOD ticks), scene actors (a state machine from behaviour profiles: comply, flee, fight, armed, kneel, cuffed, following) and the occupants of cars, with no physics bodies and no ECS entities; `npc.view` is the `HumanoidSource` the `PeopleRenderer` (`src/render/people`: 7 instanced meshes, bone-less limb transforms) draws. The 163-type call catalog (`src/data/calls`, validated by `src/calls`) maps types to 27 families (roles, branches, variants, actions, services, objectives, outcomes); `SceneDirector` (`src/scene`) builds a deterministic `Scenario` per CAD call (imperfect dispatch information, timeline of narrative updates, escalation, false, duplicate, swatting and ambush variants), materializes it when the assigned officer comes within 220 m, runs actions, services and pursuits and grades the clearing as a `CallOutcome`. `ContactManager` (`src/contact`) runs conversations (the pure dialogue engine in `src/dialogue`: tone, topics, comm modes, consent, lies, escalation; the inconsistency engine over the facts the player discovered; PBT, frisk, search and the SFST session), forwards identity claims and arrests to the dispatcher, and cages escorted prisoners. Fixed-step order: dispatch -700, **scene -690**, **contact -680**, radio -650, vehicles.pre 40, traffic 50, **npc 60**, physics 100, vehicles.post 110. The presentation (`game/peoplePresenter.ts`) renders the people and props, opens the dialogue and SFST panels from `contact.active` / `sfstView()` (revision-driven, at most 10 Hz), shows subtitles and speaks English NPC lines, and feeds the HUD (weapon chip, contact chip, scene objectives, pursuit line) and the minimap markers.

### Patrol job (Phase 2)
`CadState` is the single CAD object (calls, units with AVL positions, documents, the traffic-stop context); the `Dispatcher` owns the behaviour (generator, AI unit FSMs that drive traffic fleet cars, offers, backup, emergency, status checks) and its own save block; `RecordsDb` answers plate / VIN / person queries from pure generators plus a saved overlay. The `RadioSystem` composes radio traffic from the bus and schedules it on six channels; `RadioPlayer` (FX + TTS) and the radio panel present it. The MDT (`ui/mdt`) reads `CadState` / `RecordsDb` and sends CAD changes as requests; documents are written to the CAD store directly. Each patrol car has a `PatrolEquipment` (siren, light-bar pattern, spotlight, rack, trunk, cage) that writes the `PoliceLights` store read by the car renderer, the cockpit and the siren audio. The session wires them in the order CAD → records → dispatcher → radio and handles the interactions (trunk, driver contact, MDT reach, arrest → cage → booking at the station).

## Workers
Protocol: `{ id, type, payload }` request/response with transferables where possible (`workers/workerClient.ts`). Main thread never blocks on a worker. The Phase 0 `sim.worker.ts` answers pings and checks the RNG. The chunk worker (`world/render/chunk.worker.ts`) generates its own copy of the city from the seed and returns chunk mesh buffers as transferables; it is render-only, so its timing never touches the simulation. Traffic stays on the main thread because a worker would deliver results with timing jitter and break "same seed + same inputs = same shift".
