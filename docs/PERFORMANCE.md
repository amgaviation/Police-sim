# Performance and memory

Phase 9 added a zero-allocation per-system profiler, a long-shift profile in Node, a memory plateau test, a browser
profile of the production build with forced-GC heap checkpoints, and a round of hot-spot fixes. This document records
the method, the measured numbers (before and after the fixes), the budget, and how to run everything.

Contents: [Tools](#tools) · [Method](#method) · [Budget](#budget) · [Results](#results) · [Memory](#memory) ·
[Hot spots](#hot-spots) · [How to run](#how-to-run)

## Tools

| Tool | File | What it gives |
|---|---|---|
| `SystemProfiler` | `src/debug/profiler.ts` | Per-system mean, p95, max, total and share (fixed step) and per-phase times (`sim`, `update`, `render`). `record` is allocation-free after a name was first seen (34 ns per call measured). |
| `SystemRegistry.setProfiler` | `src/ecs/systems.ts` | `runAll` passes each system's duration (one clock read per boundary) to `record` and calls `endStep`. |
| `GameLoop.setPhaseSink` | `src/core/loop.ts` | Reports `sim`, `update` and `render` time of every frame (also in `loop.stats.updateMs` / `renderMs`). A `SystemProfiler` is a valid sink. |
| `PerfOverlay.setProfiler` | `src/debug/perfOverlay.ts` | F3 panel: top 5 systems by mean (mean / p95 ms), rebuilt at 2 Hz. |
| Node long shift | `test/perf/longShift.test.ts` | 1 game hour (7 200 steps) by default, 8 game hours (57 600) with `PATROL_LONG=1`. |
| Node memory | `test/perf/memory.test.ts` | Session churn and plateau with forced GC. |
| Browser profile | `scripts/perf.mjs` | Production build under Chromium (SwiftShader), CDP heap usage and DOM counters after GC, optional heap snapshots. |

One simulation second is 30 game seconds (`src/data/environment/time.json`), so 7 200 fixed steps (120 sim seconds)
are one game hour and 57 600 steps are an 8-hour shift.

## Method

**Node (`test/perf`).** `test/game/harness.ts` builds a session the way `App` does (`Harness(undefined, undefined,
true)`, Rapier initialised in `beforeAll`). A `SystemProfiler` is attached to the harness registry. The shift is free
patrol from seed 4242 with the officer idle in the station: the dispatcher, AI units, ~190 ambient cars, pedestrians
and the call stream all run. 120 warm-up steps are discarded. Every step (session fixed update plus all registered
systems) is timed on its own for the whole-step mean, p95 and max; the profiler gives the per-system rows. All
numbers are single-threaded V8 under vitest (module namespace lookups make it slightly slower than the production
bundle).

**Memory (Node).** `v8.setFlagsFromString('--expose-gc')` plus `vm.runInNewContext('gc')`, called twice before every
`heapUsed` reading. Churn: six times start seed 77, 600 steps, `reset`; the bus listener count after each reset must
equal the first one. Plateau: one session, four segments of 1 800 steps (six of 7 200 with `PATROL_LONG=1`), heap
after GC compared between the end of segment 2 and the last segment.

**Browser (`scripts/perf.mjs`).** `vite build`, `vite preview` on port 4174, headless Chromium with SwiftShader
(`--use-gl=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist --enable-precise-memory-info`), page
`/?e2e` (exposes `window.patrol` in the production build). New game seed 4242 with indoor scenes, the station flow of
smoke phase 7 (loadout signed out, locker / briefing / armory / garage completed, out of the door), the officer seated
in P-101, `timescale 8`, then a scripted drive (W held, A / D taps on a fixed plan, reverse when stuck) for
`PERF_MINUTES` real minutes (default 4). At t = 0.5 min, 1/3, 2/3 and the end of the run the script calls
`HeapProfiler.collectGarbage` twice, then `Runtime.getHeapUsage` and `Memory.getDOMCounters`. `PERF_SNAPSHOT=1` also
takes a heap snapshot at the first and last checkpoint (streamed to `$TMPDIR/patrol-heap-<n>.heapsnapshot`; size and
node count are printed). Per-system rows come from `app.profiler` when the app exposes one; otherwise the page samples
`app.systems.timings` once per animation frame, which sees only the last fixed step of each frame (the output and
`docs/perf/browser-profile.json` say which source was used). The script exits 1 when the heap after GC grows more than
25 % or 40 MB between the second and the last checkpoint, when DOM nodes or JS event listeners grow more than 20 % over
the same span, when draw calls exceed 300, or on any console error.

Software GL dominates browser frame time (SwiftShader rasterises on the CPU in another process): a frame takes about a
second there. The browser numbers are for CPU cost per phase and for leaks, not for frame rate.

## Budget

Design §16, with what was measured at the end of Phase 9.

| Subsystem | Budget | Measured |
|---|---|---|
| Whole fixed step (Node, idle patrol) | mean <= 1.5 ms, p95 <= 4 ms | mean 0.72 ms, p95 1.25 ms (8 game hours) |
| Profiler | <= 0.0005 ms per record, no allocation | 0.000034 ms; no heap growth over 100 000 records |
| Draw calls (smoke scene, browser drive) | <= 300 cap, target <= 200 | mean 88, max 95 |
| Heap after GC, Node churn | < 12 MB over cycles 2 to 6 | +2.2 MB (84.5 -> 86.2 MB) |
| Heap after GC, Node plateau | < 16 MB per 4 x 1 800 steps; < 24 MB per 6 x 7 200 | +1.4 MB (4 x 1 800); +3.8 MB (6 x 7 200, 6 game hours) |
| Heap after GC, browser | < 25 % between 2nd and last checkpoint | +5.0 % (+1.4 MB) over 4 minutes |
| Test-only limits (CI machines vary) | `longShift`: mean < 4 ms, p95 < 12 ms | |

Audio, VFX, UI, tutorial and build budgets belong to the modules that own them (design §16).

## Results

All numbers from this machine (a shared container; run-to-run noise is about +/- 0.02 ms per system).

### Node: 8 game hours, seed 4242 (57 600 steps)

Raw data: `docs/perf/node-long-shift.json` / `.md` (after) and `node-long-shift.before.json` / `.md` (before the Phase 9
fixes).

| | before | after |
|---|---:|---:|
| Whole step mean | 0.746 ms | 0.717 ms |
| Whole step p95 | 1.218 ms | 1.246 ms |
| Whole step max | 24.0 ms | 22.5 ms |

| system (mean ms per step) | before | after | p95 after | max after | share after |
|---|---:|---:|---:|---:|---:|
| physics | 0.285 | 0.281 | 0.431 | 11.3 | 40.1 % |
| traffic | 0.255 | 0.237 | 0.431 | 11.2 | 33.8 % |
| npc | 0.043 | 0.045 | 0.091 | 4.0 | 6.4 % |
| vehicles.pre | 0.045 | 0.044 | 0.091 | 4.9 | 6.3 % |
| copyPrevTransform | 0.016 | 0.015 | 0.027 | 2.7 | 2.1 % |
| dispatch | 0.013 | 0.013 | 0.023 | 13.3 | 1.8 % |
| vehicles.post | 0.011 | 0.012 | 0.023 | 6.8 | 1.7 % |
| environment | 0.008 | 0.007 | 0.013 | 4.1 | 1.0 % |

The `max` column is single-step outliers (GC pauses, a chunk of lazy initialisation, the dispatcher generating a
call); p95 is 3 to 10 times below it and is the number that matters for frame pacing. p95 values are upper bucket
edges of the profiler's log2 histogram (quarter-octave buckets), so they are accurate to about +19 %.

Traffic is down about 7 % in CPU and about 48 % in allocation (below). Physics is 40 % of the step and almost all of
it is avoidable; see [Hot spots](#hot-spots).

### Allocation per traffic step (V8 sampling heap profiler, 198 cars, objects collected by GC included)

| | before | after |
|---|---:|---:|
| bytes allocated per step by `src/traffic` code and `Math.hypot` | 38 100 | 19 800 |

Measured by `test/traffic/allocation.test.ts`, which fails above 32 KB per step. Most of what remains is boxed doubles
returned from non-inlined calls inside `computeAccel` and `pose` (V8 behaviour, 16 bytes each); it all dies young.

### Browser: production build, 4 minutes at `timescale 8` (SwiftShader, 1280x720)

Raw data: `docs/perf/browser-profile.json`. Per-system rows came from the in-page sampler (the integrator wires
`app.profiler` afterwards, then re-run `npm run perf` and update this table).

| phase (ms per frame) | mean | p95 | max |
|---|---:|---:|---:|
| sim (40 fixed steps per frame at scale 8) | 28.5 | 46.3 | 66.4 |
| update (input, camera, environment, streaming, cars, HUD) | 2.0 | 4.1 | 6.4 |
| render hook (CPU side of mesh sync and draw submission) | 2.2 | 3.4 | 7.2 |

8 080 fixed steps (141 simulation seconds) and 203 frames in the 4 minutes; the rest of each 1.3 s frame is the
software rasteriser. Draw calls: mean 88, max 95; triangles: mean 194 000, max 212 000.

Per step the browser agrees with Node: physics 0.28 ms, traffic 0.17 ms, vehicles.pre 0.06 ms, npc 0.05 ms.

## Memory

Node, after GC (`test/perf/memory.test.ts`):

| test | readings (MB) | verdict |
|---|---|---|
| churn: 6 x (seed 77, 600 steps, reset) | 84.0, 84.5, 85.4, 85.6, 85.5, 86.2; bus listeners 0 after every reset | +2.2 MB from cycle 2 to 6 (limit 12) |
| plateau, 4 x 1 800 steps | 90.1, 90.6, 91.6, 92.0 | +1.4 MB from segment 2 to 4 (limit 16) |
| plateau, 6 x 7 200 steps (`PATROL_LONG=1`) | 92.4, 94.4, 95.8, 96.7, 97.4, 98.1 | +3.8 MB from segment 2 to 6 (limit 24) |

The slow rise is bounded caches filling up, not a leak. A census of every collection reachable from the session
(array lengths, Map and Set sizes) after 2 and after 6 game hours shows growth only in LRU caches
(`records.personCache`, `people.cache`: capped by `CACHE_SIZE` / `IDENTITY_CACHE`), the interior layout cache (one
layout per building visited) and a few logs (`radio.net.logList`, `phase5.incidents.violations`, `violationLog`: tens
of entries per game hour). Nothing that grows with simulation steps alone.

Browser, after two forced GCs (`docs/perf/browser-profile.json`, 4-minute drive, `PERF_SNAPSHOT=1`):

| checkpoint | heap | DOM nodes | JS listeners |
|---|---:|---:|---:|
| 0.5 min | 27.45 MB | 1 638 | 232 |
| 1.33 min | 27.73 MB | 1 643 | 226 |
| 2.67 min | 28.69 MB | 1 647 | 229 |
| 4.0 min | 29.11 MB | 1 667 | 235 |

Growth from the second to the last checkpoint: heap +1.4 MB (+5.0 %), DOM nodes +1.5 %, listeners +4.0 %. Heap
snapshots: 34.1 MB / 478 501 nodes at the first checkpoint, 35.9 MB / 504 772 nodes at the last (the 26 000 extra
nodes are the same caches filling). Zero console errors.

To compare two snapshots by hand, load both in Chrome DevTools > Memory and use the Comparison view on the second.

## Hot spots

Fixed in this phase (all verified bit-identical: the JSON saves of seeds 4242, 77 and 5 after 3 000 to 4 000 steps
hash the same before and after, and `test/game` passes unchanged):

| File | Change | Effect |
|---|---|---|
| `src/traffic/trafficSystem.ts`, `src/traffic/fastMath.ts` | `Math.hypot` (a variadic V8 builtin that allocates a scratch array and a boxed result, ~48 bytes per call) replaced by `hypot2`, the same algorithm for two numbers; compared bit for bit with `Math.hypot` over 2 million random pairs in `test/traffic/fastMath.test.ts` | -11 KB allocation per step |
| `src/traffic/trafficSystem.ts` | `graph.laneStart` / `laneEnd` (called from 26 sites in the per-car passes, returning a boxed double when not inlined) read from per-lane `Float64Array` tables built in the constructor | -6 KB allocation per step, fewer calls |
| `src/traffic/trafficSystem.ts` | Posted speed limit cached per edge for the step (`limitOf`) instead of recomputed (construction and school-zone checks) for every car | fewer calls |
| `src/traffic/trafficSystem.ts` | Proxy-body quaternion (two trig calls) computed only for cars that have or get a Rapier proxy, not for every car | 2 trig calls per car per step saved |
| `src/ecs/systems.ts` | `runAll` reads the clock once per system boundary instead of twice per system; indexed loop instead of iterator | half the clock reads |
| `src/core/loop.ts` | `stepAccumulatorInto` reuses one result object per frame; new `updateMs` / `renderMs` stats and `setPhaseSink` | no per-frame allocation in `tick` |
| `src/render/meshSync.ts` | `syncFromEcs` iterates the object map with a preallocated `forEach` callback instead of `for (const [eid, object] of map)` | no entry arrays per frame |

Not in files this module owns (for the integrator, in order of value):

1. **`src/physics/physics.ts`, `PhysicsWorld.step` (0.28 ms per step, 40 % of the whole step; ~360 KB allocated per
   step).** Rapier's `World.step()` ends with `mapNewSoftBodies()`, which walks every body and collider through a
   wasm-to-JS callback (`forEachColliderHandle`, `unmapRemovedColliders` building `map.getAll()` arrays) to keep the
   JS wrapper maps in sync. With 1 204 colliders (mostly static city geometry) and 8 bodies that is ~90 % of the step.
   Measured: replacing `world.mapNewSoftBodies` with a no-op on the instance took the step from 0.29 ms to 0.025 to
   0.034 ms, and a 1 500-step session serialised to the identical JSON. The wrappers for bodies and colliders created
   through the JS API are registered when they are created, and `removeRigidBody` / `removeCollider` unmap their own
   colliders, so the per-step pass only matters for handles created inside wasm (the game has none). Suggested fix:
   after `new World(...)` in the `PhysicsWorld` constructor set
   `(world as unknown as { mapNewSoftBodies(): void }).mapNewSoftBodies = () => undefined;` with a comment, then run
   `test/game`, `test/physics`, `test/vehicles` and `npm run smoke`. A second, independent lever is fewer colliders
   (merge static chunk colliders into one compound or trimesh per chunk).
2. **`src/vehicles/drivableVehicle.ts`, `preStep` / `preStepCraft` / `postStep` (vehicles.pre 0.044 ms, vehicles.post
   0.012 ms; 0.7 + 0.6 + 0.5 KB per step).** Small, steady allocations from `preStep`, `preStepCraft` and
   `stepCraft` in `src/vehicles/craft.ts`: reuse scratch vectors and avoid `Math.hypot` (use `hypot2` from
   `src/traffic/fastMath.ts` or `Math.sqrt(x * x + z * z)` where bit-identity is not required).
3. **`src/npc/npcSystem.ts`, `step` (0.045 ms; `publishOccupants` 1 KB per step, `updatePeds` 0.3 KB).** Per-step
   allocation in `publishOccupants` and `updatePeds`; scratch arrays would remove it.
4. **`src/world/roadGraph.ts`, `lanePoint` / `laneOffset` / `laneStart` / `laneEnd`.** `lanePoint` calls `Math.atan2`
   for `yaw` on every call although most callers ignore it, and the lane helpers return boxed doubles when they are not
   inlined. Other per-step callers (the fleet and pursuit code) can use the same per-lane tables as the traffic system.
5. **`src/ecs/components.ts`, `copyTransformSlot` via `copyPrevTransform` (0.015 ms).** Copies all 7 transform values
   of every entity every step, including static ones; a dirty flag per entity would skip the static majority (the
   interpolation then reads equal prev and current values).
6. **`Math.hypot` elsewhere (~0.4 KB per step in Node).** Anything per step or per frame: use `hypot2` (bit-identical).

## How to run

```sh
# Node: 1 game hour (default, part of npm test) and the full 8-hour shift with the memory plateau at 6 x 7 200 steps
npx vitest run test/perf
PATROL_LONG=1 npx vitest run test/perf/longShift.test.ts test/perf/memory.test.ts   # npm run perf:node
PATROL_LONG=1 npx vitest run test/perf                                              # npm run test:long

# Browser: production build + preview + Chromium (needs Playwright at /opt/node-tools and browsers in /opt/pw-browsers)
node scripts/perf.mjs                                                               # npm run perf
PERF_MINUTES=1 PERF_NO_BUILD=1 node scripts/perf.mjs                                # quick run on the existing dist/
PERF_SNAPSHOT=1 node scripts/perf.mjs                                               # + heap snapshots in $TMPDIR
```

The release module adds the `perf`, `perf:node` and `test:long` package scripts; until then use the raw commands above.
`PATROL_LONG=1` rewrites `docs/perf/node-long-shift.json` and `.md`; `scripts/perf.mjs` rewrites
`docs/perf/browser-profile.json`. Pass `PATROL_DATE=<ISO string>` to fix the date written into the Node report.

Environment variables for `scripts/perf.mjs`: `PERF_MINUTES` (default 4), `PERF_SNAPSHOT=1`, `PERF_NO_BUILD=1`,
`PERF_SIZE=WxH` (default 1280x720). Exit code 1 on any limit breach or console error.

### Using the profiler in code

```ts
const profiler = new SystemProfiler();
systems.setProfiler(profiler);          // per-system rows
perf.setProfiler(profiler);             // F3 panel: top 5 by mean at 2 Hz
loop.setPhaseSink(profiler);            // sim / update / render per frame
console.log(formatProfile(profiler.report()));
```

`report()` allocates; call it from tools, tests and the 2 Hz overlay, not from a per-frame path.
