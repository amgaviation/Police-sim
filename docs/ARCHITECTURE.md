# Patrol — Architecture

Browser-based law-enforcement patrol simulator. Vite + TypeScript (strict), three.js, Rapier (WASM), bitECS, Web Workers, IndexedDB, Web Audio, Web Speech.

## Guiding rules

- **Deterministic simulation.** Every random decision goes through a seeded RNG stream (`src/core/rng.ts`). Same seed + same inputs = same shift.
- **Fixed-timestep simulation, variable-rate render.** `src/core/loop.ts` accumulates real time and steps the simulation at `SIM_HZ` (60). Rendering interpolates.
- **Data-driven content.** Calls, laws, vehicles, uniforms, names, dialogue live in `src/data/**/*.json` (+ TS types/validators). Adding content must not require engine changes.
- **Versioned persistence.** Every persisted schema has `version`; `src/save/migrations.ts` holds forward migrations; loading an older version migrates then validates.
- **Everything subscribes through the event bus.** `src/core/events.ts` — typed topics, no direct cross-system coupling.
- **Perf budget first.** 60 FPS target on mid-range desktop GPU; perf overlay from Phase 0.

## Directory layout (Phase 0)

```
src/
  main.ts                 bootstrap: creates App, mounts UI, starts loop; exposes the App as `window.patrol` in dev builds
  app.ts                  App composition root; owns systems; a fresh physics world per session
  core/
    loop.ts               fixed-timestep game loop (accumulator, maxSubSteps, interpolation alpha)
    events.ts             typed EventBus (on/off/once/emit), event map in core/event-map.ts
    rng.ts                seeded PRNG (xoshiro128**), named child streams via stream(name), serialize/restore state
    time.ts               GameClock (sim time, time scale, pause)
    log.ts                leveled logger that also feeds the debug console
  ecs/
    world.ts              bitECS world wrapper, entity lifecycle helpers
    components.ts         SoA component definitions (Transform, Velocity, ...)
    systems.ts            system registration/order; a System is { name: string; run(world, dt): void }, registered with an order number (lower runs first)
  input/
    input.ts              InputManager: action map, keyboard/mouse/gamepad sources, rebinding
    bindings.ts           default bindings + serializable binding schema
    actions.ts            Action id enum/union
  save/
    db.ts                 IndexedDB wrapper (open, get, put, delete, list) with versioned object stores
    schema.ts             SaveGame type + CURRENT_SAVE_VERSION
    migrations.ts         ordered migration functions vN -> vN+1
    saveManager.ts        save/load/list/delete slots, autosave, validates & migrates
  settings/
    settings.ts           Settings schema (graphics/audio/controls/accessibility), defaults, persistence
  render/
    renderer.ts           three.js WebGLRenderer setup, resize, pixel ratio, scene/camera holders
  debug/
    perfOverlay.ts        frame time, fps, draw calls, triangles, entities, sim step time, memory
    console.ts            in-game debug console (` key), command registry, history, autocomplete
  ui/
    ui.ts                 DOM UI root, layering, menu stack
    settingsMenu.ts       settings menu bound to Settings
    mainMenu.ts           new game / continue / settings
  workers/
    protocol.ts           typed message protocol for worker RPC
    sim.worker.ts         placeholder AI/traffic worker (ping/pong) — proves worker pipeline
  game/
    testScene.ts          Phase 0 demo session (player + box pile), save/load of a session
test/                     vitest unit tests, one folder per src module (node environment, no DOM/WebGL)
docs/
  ARCHITECTURE.md         this file
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

### Determinism across sessions
Rapier does not return to a pristine state after bodies are removed, so `App` disposes the physics world and clears the ECS world before every new or loaded session (`createScenePhysics`). The session advances `world.time` and its `GameClock` once per fixed step; both are rewound when a session starts and restored from `clock.simTime` on load.

### Event bus
```ts
type EventMap = { 'input:action': {...}, 'save:completed': {...}, ... }
bus.on('topic', handler): () => void  // returns unsubscribe
bus.emit('topic', payload)
```

### RNG
```ts
const rng = createRng(seed)          // master
const traffic = rng.stream('traffic') // deterministic sub-stream by name
traffic.next() / nextInt(min,max) / pick(arr) / chance(p) / state() / restore(s)
```

### Save
```ts
interface SaveEnvelope<T> { version: number; createdAt: number; updatedAt: number; slot: string; data: T }
```
The object-store key is the slot; `list()` names rows by key and `load()` repairs a disagreeing `slot` field. `migrateEnvelope(envelope)` applies `migrations[version]` until `CURRENT_SAVE_VERSION` (2), then validates with `isSaveGame`; `save()` validates before writing so a save that would not load is never stored. v2 stores each body's transform, linear/angular velocity and sleep state plus the camera pitch (v1 saves migrate with bodies at rest). Tests assert every version from 1..current migrates.

### Input
Actions are abstract (`'move.forward'`, `'vehicle.siren'`...). Bindings map device inputs → actions. Rebinding UI edits bindings and persists through Settings.

### Debug console commands (Phase 0)
`help`, `clear`, `echo`, `seed [n]`, `timescale [x]`, `pause`, `save [slot]`, `load [slot]`, `saves`, `perf`, `fps`, `spawn box [n]`, `entities`, `settings get <path> | set <path> <value> | list`, `worker ping`, `debugcam`.

## Workers
Heavy AI/traffic/pathfinding run in Web Workers (Phase 1+). Protocol: `{ id, type, payload }` request/response with transferables where possible. Main thread never blocks on a worker.
