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
    schema.ts             SaveGame (v3) type, nested validators + CURRENT_SAVE_VERSION
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
  game/
    session.ts            GameSession: one shift in the city (officer, patrol cars, colliders, traffic, environment), save/load
    worldView.ts          render side of a session's city (chunk streamer, signal heads, streetlights, minimap)
    hudFeed.ts            fills the HUD snapshot from the session at 10 Hz
    commands.ts           Phase 0 console commands; pauseMenu.ts, playerController.ts, sceneLayout.ts
  data/                   JSON content: world/, environment/, crime/, vehicles/, physics/, traffic/
test/                     vitest unit tests, one folder per src module (node environment, no DOM/WebGL)
docs/
  ARCHITECTURE.md         this file
  phase1-design.md        Phase 1 design: data formats and the full module APIs
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

Per frame (`App.update`): input -> toggles -> mode actions (interact: enter / exit / refuel; camera, headlights, light bar, map zoom) -> on-foot look/move or `readDriverInput` (stored for the next fixed steps) -> `CameraRig` -> `EnvironmentRenderer.update` -> `WorldView.update` (chunk streaming at the fog distance, signal heads, streetlights) -> `CarRenderer.update` -> HUD and minimap (10 Hz). Render: `meshes.syncFromEcs`, `renderer.render()`, perf sample (draw calls, triangles, entities, extras `chunks`, `traffic`, `cars`).

### Determinism across sessions
Rapier does not return to a pristine state after bodies are removed, so `App` disposes the physics world and clears the ECS world before every new or loaded session (`createScenePhysics`: gravity, one ground slab of half size `WORLD_HALF_SIZE + 64` and four boundary walls `WORLD_WALL.offset` outside the world edge, which edge chunks draw along with the outer half of the perimeter roads). The session advances `world.time` and its `GameClock` once per fixed step; both are rewound when a session starts and restored from `clock.simTime` on load. The city is rebuilt from the seed (`generateCity` is pure; the app caches the last one). City, colliders, vehicles, traffic and weather depend only on the seed, the input sequence and sim time; every draw comes from a named stream (`'traffic'`, `'vehicle:<slot>'`, `'colors'`, `'world:*'`, `'registry:<id>'`, `'weather'`); worker, streaming and render state never feed back into the simulation. `test/game/session.test.ts` replays a scripted 1200-step shift twice and compares the saves.

Session teardown order: traffic, drivable vehicles, colliders, the officer and boxes (`GameSession.dispose`), then the render side (`WorldView.dispose`: streamer, signal heads, streetlights, minimap), then the physics world is replaced.

### Event bus
```ts
type EventMap = { 'input:action': {...}, 'save:completed': {...}, ... }
bus.on('topic', handler): () => void  // returns unsubscribe
bus.emit('topic', payload)
```
Phase 1 modules add topics by declaration merging in their own `events.ts`: `env:hour`, `env:weather` (environment), `vehicle:damaged`, `vehicle:tireBurst`, `vehicle:engineStalled`, `vehicle:engineFailed`, `vehicle:fuelEmpty` (vehicles), `traffic:spawned`, `traffic:despawned`, `traffic:collision`, `traffic:violation` (traffic), `player:mode`, `camera:mode` (player). Payloads are emitted on rare events only.

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
The object-store key is the slot; `list()` names rows by key and `load()` repairs a disagreeing `slot` field. `migrateEnvelope(envelope)` applies `migrations[version]` until `CURRENT_SAVE_VERSION` (3), then validates with `isSaveGame`; `save()` validates before writing so a save that would not load is never stored. v2 stores each body's transform, linear/angular velocity and sleep state plus the camera pitch (v1 saves migrate with bodies at rest). v3 (Phase 1) adds `player { mode, vehicle, lastVehicle }` (`lastVehicle` is the last-driven vehicle for refuelling and its parked headlights, -1 for none), `camera.mode`, `vehicles` (each `SerializedVehicle` plus its colour and RNG stream), `traffic` (snapshot or null), `violations` (the observed-violation log, `[vehicleId, counts]` pairs) and `environment` (`timeOffset`, weather override); `lastVehicle` and `violations` are optional (absent in early v3 saves); v2 saves migrate on foot with the patrol cars re-parked and fresh traffic. Loading regenerates the city from the seed. Tests assert every version from 1..current migrates.

### Input
Actions are abstract (`'move.forward'`, `'vehicle.steer'`, `'vehicle.handbrake'`...). Bindings map device inputs → actions. Rebinding UI edits bindings and persists through Settings; new actions appear in it automatically.

### Debug console commands
Phase 0: `help`, `clear`, `echo`, `seed [n]`, `timescale [x]`, `pause`, `save [slot]`, `load [slot]`, `saves`, `perf`, `fps`, `spawn box [n]`, `entities`, `settings get <path> | set <path> <value> | list`, `worker ping`, `debugcam`.
Phase 1: `time [HH:MM]`, `weather [kind [intensity] | auto]`, `tp <x> <z> | <poi kind> | <district>`, `route <poi kind> | <x> <z> | off`, `road`, `car info | refuel | repair | spawn <modelId>`, `traffic stats | list [n] | density <x> | clear`, `plate <ABC 1234>`, `chunks`.

## Workers
Protocol: `{ id, type, payload }` request/response with transferables where possible (`workers/workerClient.ts`). Main thread never blocks on a worker. The Phase 0 `sim.worker.ts` answers pings and checks the RNG. The chunk worker (`world/render/chunk.worker.ts`) generates its own copy of the city from the seed and returns chunk mesh buffers as transferables; it is render-only, so its timing never touches the simulation. Traffic stays on the main thread because a worker would deliver results with timing jitter and break "same seed + same inputs = same shift".
