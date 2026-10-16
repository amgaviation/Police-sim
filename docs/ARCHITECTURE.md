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
  main.ts                 bootstrap: creates App, mounts UI, starts loop
  app.ts                  App composition root; owns systems, exposes `app` on window in dev
  core/
    loop.ts               fixed-timestep game loop (accumulator, maxSubSteps, interpolation alpha)
    events.ts             typed EventBus (on/off/once/emit), event map in core/event-map.ts
    rng.ts                seeded PRNG (PCG32/xoshiro), named streams, fork(), serialize/restore state
    time.ts               GameClock (sim time, time scale, pause)
    log.ts                leveled logger that also feeds the debug console
  ecs/
    world.ts              bitECS world wrapper, entity lifecycle helpers
    components.ts         SoA component definitions (Transform, Velocity, ...)
    systems.ts            system registration/order; each system = (world, dt) => void
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
    worker-protocol.ts    typed message protocol for worker RPC
    sim.worker.ts         placeholder AI/traffic worker (ping/pong) — proves worker pipeline
tests/                    vitest unit tests (rng determinism, event bus, save migrations, loop accumulator)
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
Accumulator clamps to `maxFrameTime` (0.25 s) to avoid spiral-of-death; at most `maxSubSteps` (5) fixed steps per frame.

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
interface SaveEnvelope<T> { version: number; createdAt: number; updatedAt: number; data: T }
```
`migrate(envelope)` applies `migrations[version]` until `CURRENT_SAVE_VERSION`. Tests assert every version from 1..current migrates.

### Input
Actions are abstract (`'move.forward'`, `'vehicle.siren'`...). Bindings map device inputs → actions. Rebinding UI edits bindings and persists through Settings.

### Debug console commands (Phase 0)
`help`, `clear`, `seed [n]`, `timescale <x>`, `save <slot>`, `load <slot>`, `perf`, `fps`, `spawn test`.

## Workers
Heavy AI/traffic/pathfinding run in Web Workers (Phase 1+). Protocol: `{ id, type, payload }` request/response with transferables where possible. Main thread never blocks on a worker.
