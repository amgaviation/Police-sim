# Phase log

Each phase entry records: what was completed, how to run it, and what to test manually.

## Phase 0 — Foundation

Status: complete. Screenshot: `docs/screenshots/phase0.png` (taken by the smoke test).

### Completed
- ✅ Vite 8 + TypeScript 6 (strict, no enums) toolchain; `npm run check` (typecheck + lint + tests) and `npm run build` are clean.
- ✅ `core/`: typed EventBus + EventMap, leveled logger feeding the console, seeded xoshiro128** RNG with named streams and serializable state, GameClock (time scale, pause), fixed-timestep GameLoop with accumulator, sub-step cap and interpolation alpha.
- ✅ `ecs/`: bitECS 0.4 world wrapper, SoA Transform/PrevTransform/Velocity stores, tag components, SystemRegistry with ordering and per-system timings.
- ✅ `physics/`: Rapier 0.21 world mapped to entity ids (box/sphere/ground, kinematic and dynamic bodies, collision events, raycasts, `syncToEcs`).
- ✅ `input/`: action map, default keyboard/mouse/gamepad bindings, InputManager with edges, pointer lock, rebinding capture and serializable bindings.
- ✅ `save/`: IndexedDB wrapper, versioned SaveEnvelope + migrations, SaveManager (slots, list, delete, autosave), settings blob.
- ✅ `settings/`: typed settings schema with field table, migration, debounced persistence; live-applied render scale, shadows, FOV, text scale and bindings.
- ✅ `render/`: three.js Renderer (pixel ratio, shadows, resize, debug orbit camera), MeshRegistry with one instanced box pool and PrevTransform→Transform interpolation.
- ✅ `debug/`: perf overlay (fps, frame/sim ms, 1 % low, draw calls, entities, system timings, heap, worker ping) and a debug console with history/completion.
- ✅ `ui/`: menu stack, main menu (seed input, continue list, delete), settings menu with rebinding, pause menu.
- ✅ `workers/`: typed RPC client + module worker (`ping`, `echo`, `rng.sample`); worker RNG is verified against the main thread at startup.
- ✅ `game/`: deterministic demo scene (kinematic player box + 150 dynamic boxes from the `scene` RNG stream), third-person camera, save/load reconstruction, autosave every 60 s, console commands.
- ✅ Browser smoke test (`npm run smoke`) under headless Chromium/SwiftShader.

### How to run
```
npm install
npm run dev        # http://localhost:5173
npm run check      # tsc + eslint + vitest
npm run build      # production bundle in dist/
npm run smoke      # headless browser test + docs/screenshots/phase0.png
```

### Manual test checklist
1. Title screen shows; type a seed (e.g. `42`) and press **New game**. The same seed always produces the same pyramid and scatter.
2. Click the canvas to lock the pointer. **WASD** moves the blue player box, **Shift** sprints, mouse turns the camera; walking into the pile pushes boxes.
3. **F3** toggles the perf overlay; **`** (backquote) opens the console. Try `help`, `fps`, `entities`, `spawn box 20`, `timescale 0.25`, `pause`, `seed 7`, `settings set graphics.fov 100`, `worker ping`, `debugcam`.
4. **Esc** opens the pause menu (simulation pauses, boxes freeze in place); **Resume** or Esc again continues. While the pointer is locked, the first Esc releases it and opens the pause menu. **Quick save** writes slot `quicksave`. The console `pause` stays paused through opening and closing menus until `pause` is run again.
5. From the pause menu open **Settings**: drag *Render scale*, *Field of view*, *Shadows*, *Frame cap*, *Draw distance*, *Gamepad deadzone* and *Text size* (also scales the console and perf overlay) and confirm they apply immediately; rebind a key or mouse button under *Controls*, then press Esc (closes Settings); reload the page and confirm settings persisted.
6. **Quit to title** → the `quicksave` (and `autosave` after 60 s in game) slots are listed under *Continue*; loading restores the box positions and motion, the player's facing and the camera pitch. A damaged or newer-version save shows a message under the list instead of doing nothing.
7. Resize the window: the canvas follows without stretching.

### Known limitations
- Saves (schema v2) restore every body's transform, velocity and sleep state exactly (loading runs one uncounted, gravity-free priming step to rebuild contact pairs, so a settled pile stays asleep and in place), but not Rapier's internal warm-start caches, so a pile that is being pushed at the moment of saving continues slightly differently after a load (a full Rapier snapshot would make it exact but costs ~0.5 MB per save). New games with the same seed and inputs replay exactly, including later sessions in the same page.
- Audio, colour-vision, subtitle and one-handed settings are stored but hidden from the menu until the systems that use them exist.
- The player is a box, not a character controller; there is no jumping, slopes or stairs.
- Under software GL (SwiftShader) the frame rate is ~10 fps and the loop hits its 5-sub-step cap; on a real GPU it runs at the display rate.
- The Rapier bundle (~4.3 MB) is imported statically; splitting it into a worker/dynamic import is Phase 1+ work.

## Phase 1 — World and Driving

Status: ✅ complete. Screenshots: `docs/screenshots/phase1.png` (day, downtown) and `docs/screenshots/phase1-night.png` (22:00, rain), both taken by the smoke test. Design and module contracts: `docs/phase1-design.md`.

### Completed
- ✅ `world/`: procedural 7.2 x 7.2 km city from the seed (`generateCity`, ~60-130 ms): 14 x 14 authored district map (downtown, suburbs, industrial, highway strip, rural, campus, hospital, airport, harbor, park, water), grid road network with classes, one-way pairs, a divided state highway, signalised/stop-controlled junctions, school and construction zones, generic street names, POIs (station, hospital, campus, airport, harbor, schools, fuel stations, parks).
- ✅ Road graph API for later phases: lanes, connections, signal timing, zone-aware speed limits, spatial queries and A* routing (`routeBetweenPoints` in ~1 ms across town).
- ✅ Chunk layout (buildings, props, signs, signal heads, ground, colliders) per 256 m chunk, deterministic and order-independent; static Rapier colliders streamed in a 3 x 3 chunk window around the player in the fixed step.
- ✅ City rendering: a chunk meshing worker (main-thread fallback), LOD0/LOD1 merged vertex-coloured meshes with a canvas window texture, streaming by the fog distance with hysteresis, one instanced mesh for all traffic signal heads, pooled streetlight point lights at night.
- ✅ `environment/`: game clock (Mon 07:00 start, 30x), sun/moon and sky keyframes, deterministic weather timeline (clear, cloudy, rain, storm, fog, snow, heat) with road wetness and snow cover, auto streetlights/headlights, sky dome, fog, precipitation, heat haze; crime time-of-day data for Phase 3.
- ✅ `vehicles/`: data-driven models (2 patrol, 7 civilian/commercial, no brands or liveries), Rapier ray-cast vehicle with automatic gearbox, speed-sensitive steering, ABS (or wheel lock without it), brake fade, surface and weather grip, fuel use and refuelling, zone damage with stalls, engine failure and tyre bursts.
- ✅ `player/`: on foot / driving modes, enter at the driver door, exit beside it (passenger side if blocked, refused while moving), chase / hood / cockpit cameras with wall avoidance; new actions `vehicle.handbrake`, `vehicle.headlights`, `map.toggle` in the rebinding UI.
- ✅ `traffic/`: up to 192 ambient cars on the main thread (IDM car following, signals, stop/yield rules, turns, kinematic physics proxies near the player, crashes), a 60 000-vehicle registry with plates and record flags, driver tendencies and violations (speeding, tailgating, red lights, rolling stops, DUI weaving) reported as events near the player.
- ✅ `render/vehicles/`: instanced car renderer (body, glass, wheels, lamp lenses, alternating light bar with a reduced-flash option, damage crumple and tint, headlight spot lights).
- ✅ HUD and minimap: speed, gear, ABS, fuel, warnings, damage, camera and lights status, clock and weather, street + district + live speed limit (school zone, work zone), interact prompts; heading-up minimap with traffic dots and the plotted route.
- ✅ Integration (`game/session.ts`, `app.ts`): city session replaces the Phase 0 demo (debug boxes kept), fixed-step system order of design §13, per-frame render wiring, settings (draw distance drives fog and streaming; graphics quality drives shadows, car shadows and the streetlight pool), perf overlay extras `chunks`, `traffic`, `cars`.
- ✅ Save schema v3 (player mode and vehicle, camera mode, drivable vehicles with their RNG streams, traffic snapshot, environment) with a v2 -> v3 migration; saves from Phase 0 load into the city with the patrol cars re-parked.
- ✅ Determinism: the same seed and inputs replay a 1200-step shift (walking, driving, weather, traffic) exactly (`test/game/session.test.ts`).
- ✅ 703 unit/integration tests; browser smoke test covering a new shift, streaming, traffic, driving, weather/night, world commands, save/load, settings and per-frame costs.

### How to run
```
npm install
npm run dev        # http://localhost:5173
npm run check      # tsc + eslint + vitest (703 tests)
npm run build      # production bundle in dist/ (chunk worker emitted as its own file)
npm run smoke      # headless browser test + docs/screenshots/phase1.png, phase1-night.png
```

### Controls
| | Keyboard / mouse | Gamepad |
|---|---|---|
| Move / sprint (on foot) | WASD / Shift | left stick / L3 |
| Look | mouse (click the canvas to lock the pointer) | right stick |
| Enter / exit vehicle, refuel at a pump | E | A |
| Throttle / brake (hold at a stop to reverse) | W / S (or arrow keys) | RT / LT |
| Steer | A / D | left stick |
| Handbrake | Space | B |
| Camera (chase -> hood -> cockpit) | V | View |
| Headlights / light bar | H / L | D-pad up / X |
| Minimap zoom (250 / 500 / 1000 m) | M | D-pad down |
| Perf overlay / console / pause | F3 / ` / Esc | - / - / Menu |

### Manual test checklist
1. **New game** with seed `42`: the status line says *Generating city...*, then the officer (blue box) stands at the police station door downtown, Mon 07:00. Two patrol cars (black or white sedan and SUV with a light bar, no markings) are parked in the lot; traffic is moving on the streets; the HUD shows the district (plus the street name and its limit sign once you are on a road); the minimap shows roads and traffic dots.
2. Walk to the driver door (left side, front third) of a patrol car: the prompt shows **E Enter vehicle**. Press **E**: the camera switches to chase view behind the car.
3. Drive with **W/S/A/D** (or a gamepad: RT/LT/left stick). The HUD shows speed (mph), gear, fuel bar; **S** held at a standstill reverses (gear R). **Space** locks the rear wheels. Brake hard at speed: the ABS chip flashes and the car keeps steering. Try **V** (hood, cockpit with mouse free-look, back to chase), **H** (headlights), **L** (light bar alternates red/blue; slower and dimmer with *Reduce flashing lights*), **M** (map zoom).
4. Stop next to a wall and press **E**: the officer gets out on the driver side, or on the passenger side when the driver side is blocked; with both sides blocked the HUD says *Both doors are blocked*. While moving it says *Stop the vehicle to get out*.
5. Open the console (**`**): `weather heat` (heat haze near the horizon, daytime only), `weather fog`, `weather snow` (snow cover, very low grip), `weather rain` (rain, wet roads, longer braking), then `time 21:00` (night: lit windows, streetlights, auto headlights), `weather auto`, `timescale 4`.
6. Junctions: signals cycle green/yellow/red per axis and traffic stops for them; stop signs at minor roads (cars stop, a few roll through). `tp school` right after a new game (weekday morning) shows the yellow **SCHOOL 20** sign on the HUD; streets with the orange **WORK ZONE** tag (2 % of streets) have cones, barriers and a 10 mph lower limit (`road` prints the zones of the nearest street).
7. `traffic list` shows the nearest cars with id, plate, model, distance, speed, observed violations and record flags (stolen, expired registration, uninsured); `plate ABC 1234` looks a plate up; `traffic density 3` / `traffic density 0` / `traffic clear` change the traffic.
8. `tp downtown`, `tp rural`, `tp harbor`, `tp airport`, `tp 1000 -1500`: districts look different (towers, houses with yards, warehouses, farms, container yards, runways). `route hospital` / `route 0 0` prints the distance, ETA and streets and draws the route on the minimap; `route off` clears it. `road`, `car info`, `car spawn van`, `car repair`, `car refuel`, `chunks`.
9. Crash into a building at speed: the body crumples and darkens on the hit side, the HUD shows DAMAGE %, the engine may stall or fail; a hard corner hit can burst a tyre (the car pulls). `car repair` fixes everything. Park the car near the station pump (or a fuel station), get out, stand at the pump and press **E** to refuel.
10. **F3**: fps, frame/sim ms, draw calls (well under 200 at default settings), triangles, entities, system timings (`traffic`, `physics`, `vehicles.*`, `colliders`, `environment`), `chunks` loaded/in flight, `traffic` active/proxies, `cars` drawn.
11. While driving at night in the rain: **Esc** -> **Quick save**, drive on, then **Quit to title** and load `quicksave`: still driving the same car at the saved spot, same time, weather, camera mode, damage and fuel; traffic continues where it was. A Phase 0 save from the title list loads into the city on foot.
12. **Settings**: lowering *Draw distance* shortens the fog and streams fewer chunks (`chunks`); *Shadows* off/low/high changes shadow maps, car shadows (high) and the streetlight pool (2/4 lights); the new driving actions are listed under *Controls* and can be rebound.

### Performance
- Headless Chromium with SwiftShader (software GL, 1280x720, frame breakdown printed by `npm run smoke`): about 1.5 fps (650-730 ms per frame, varying run to run). The CPU work per frame is ~4-6 ms: sim 2.1-3.7 ms for the 5 capped fixed steps, update 0.7-0.8 ms (camera, environment, streaming, cars, HUD), render 0.9-1.7 ms (mostly the draw submission); the remaining 640-720 ms is the GPU process rasterising on the CPU. At render scale 0.5 the frame takes 290-305 ms (3.3-3.4 fps), so the software rasteriser, not the game, sets this number.
- Draw calls at default settings: 58-76 across downtown, suburbs, industrial, rural, harbor, airport, campus, park and the highway (target <= 200, cap 300); 100k-200k triangles; 12-14 chunks resident at the default 320 m view distance.
- Fixed step in Node: 0.29-0.34 ms per step on average downtown with 192 traffic cars (traffic 0.14 ms, physics 0.09-0.15 ms, vehicles 0.03 ms, environment 0.006 ms); driving 1.9 km of highway at 90 km/h with collider streaming: physics 0.11 ms, colliders 0.004 ms (worst chunk load 1.1 ms), vehicles 0.02 ms. Design §15 budgets: physics 1.0, traffic 0.5, vehicles 0.1, environment 0.05, colliders 0.5 ms per chunk op.

### Known limitations
- The officer on foot is a kinematic box moved by a character controller: buildings, poles, walls and vehicles block it, but it cannot jump or climb.
- Traffic stops for the player (the driven car or the officer on foot) and for up to 8 parked player vehicles near the focus (the car the officer last left first, then the nearest others); a ninth or later vehicle further away is not seen and gets driven into. Traffic never changes lanes or overtakes; no pedestrians, police AI, audio (the siren key does nothing yet) or traffic stops (Phase 2).
- The world is flat and every road is a straight axis-aligned grid line; the state highway crosses streets at grade with signals.
- Saves restore every body's pose and velocity but not Rapier's solver caches, so a car saved in motion continues within a few centimetres of the original path; traffic, time, weather and every RNG stream continue exactly.
- `time HH:MM` only moves forward (an earlier hour means the next day); the weather override lasts until `weather auto`.
- The plotted route is drawn on the minimap only, with no in-world guidance; the light bar does not light the surroundings (only the headlights have spot lights); four pooled point lights (two with shadows off) light the streetlights nearest the camera, the rest are emissive only.
- Under software GL (SwiftShader) the game runs at about 1.5 fps and the loop hits its 5-sub-step cap, so the simulation (and the car) runs slower than real time there; on a real GPU it runs at the display rate.
