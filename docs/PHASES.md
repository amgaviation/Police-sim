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

## Phase 2 — Police Vehicle, MDT, CAD, Radio

Status: ✅ complete. Screenshots: `docs/screenshots/phase2.png` (cockpit view with the in-car MDT laptop, radio log and caption) and `docs/screenshots/phase2-mdt.png` (the MDT overlay, AVL map tab), both taken by the smoke test. Design and module contracts: `docs/phase2-design.md`.

### Completed
- ✅ **Patrol car equipment** (`police/`, data in `src/data/police/*.json` and the vehicle models' `equipment` section): siren controller (wail, yelp, phaser, hi-lo, air horn, manual wind-up), six data-driven light-bar patterns with a reduced-flash mode, an aimable spotlight (a real three.js spot light), push bumper (sturdier front zone in the damage model), rear partition / prisoner cage, a lockable shotgun / rifle rack (unlocks only when stopped) and a trunk loadout of eight items; what the officer carries (`OfficerKit`) is saved.
- ✅ **Cockpit** (`render/police/`): first-person interior of the patrol car (dash, wheel, laptop with a live CAD screen, radio head with channel / TX / RX / SCAN / EMERG display, siren controller LEDs, partition cage, gun rack with the racked guns), ≤ 6 draw calls, only in cockpit view; light-bar segments per pattern on every police car, push-bumper trim, spotlight on the driven (or last driven) car.
- ✅ **MDT / CAD** (`ui/mdt/`, `cad/`): full-screen, keyboard-first, non-pausing overlay (Tab in a patrol car or within 3 m of its driver door; Escape closes): call queue (P1-P4, nature, address, caller, status, units, age) with accept / decline / self-assign / en route / on scene / clear, call detail with timestamped narrative, unit roster with statuses, AVL map with live AI units and calls, person and vehicle (plate / VIN) queries, BOLOs and the query history, reports (incident report, citation from a statute table, booking, evidence with chain of custody, supplements) and the traffic-stop tab. Addresses with block numbers, cross streets and "near" text from the road graph.
- ✅ **Records** (`records/`): 100 000 persons and 60 000 registered vehicles generated deterministically from the seed and the id (licence, warrants, supervision, gang, mental-health and officer-safety notes, firearms, protective orders, priors; owner, VIN, expiry, insurance, flags), plate states stolen / cloned / mismatched / expired / flagged with VIN checks, daily BOLOs; touched records, contacts from the shift, served warrants and the query log are saved.
- ✅ **Dispatch** (`dispatch/`): data-driven procedural call generator (8 generated call types, crime time-of-day and district weights), offers to the player (25 s), six AI units (callsigns 21-33) driving fleet cars on the road network with code 2 / code 3 urgency, statuses, on-scene timers, breaks and beat returns, backup (code 2 / code 3), the emergency button, status checks with escalation to a welfare call, 10-20 answers, plate / person runs, traffic-stop context, records upkeep (citations and bookings become priors; a PC-220 booking serves the warrants).
- ✅ **Traffic** (`traffic/`): light bar behind a car → it pulls to the curb and stops (hazards, pinned, a `trafficStop` CAD call), release / abandon, cars yield to lights + siren, fleet cars (routes, code-3 junction rules, curb parking on arrival), the reticle target pick (`pickTrafficCar`).
- ✅ **Radio** (`radio/`, `audio/`, `speech/`): six channels (dispatch, tactical, car-to-car, fire/EMS, county, state) with selection and scan, composed traffic from every CAD / dispatch event in ten-code or plain language, ambient chatter, stepped-on (blocked) transmissions with a heterodyne, the emergency button (hold Z, channel hold + priority tone), status checks, 10-20, number-key radio menu, optional push-to-talk voice commands (off by default), text-to-speech with per-speaker voices (falls back to captions), synthesized key-up / squelch / static / alert tones, positional synthesized sirens (4 voices, nearest first, in-cabin filter). No audio files: `docs/ASSETS.md` stays empty.
- ✅ **HUD and panels** (`ui/hud/`, `ui/panels/`): police status line, unit chip (status, EMERGENCY, STATUS CHECK), call strip with distance, offer line, reticle target with plate / description / run result, carried items, minimap call / unit / stop markers and the route to the assigned call (re-planned every 10 s or 60 m off route), radio log (6 lines) + channel strip, caption line (`accessibility.subtitles`), radio menu, and action panels for the trunk (take / stow), the equipment (rack lock, long guns, spotlight, rear seat) and the traffic-stop driver (licence, VIN, write citation, warn and release, release, arrest).
- ✅ **Player actions**: set status (10-8 / 10-7 / en route / on scene / busy / transporting) from the radio menu or the MDT, accept / decline offers, self-assign, get routed, run the targeted (or stopped) car's plate with P, run persons and DL numbers, traffic stops, citations, incident reports, arrests (cuffs → rear seat → booking at the station), evidence, siren tones, light patterns, spotlight, trunk, gun rack, radio channels and scan, the emergency button, 10-20 requests, status-check answers, voice commands where the browser supports them.
- ✅ **Integration** (`game/`, `app.ts`): session wiring (CAD → records → dispatcher → radio, equipment per patrol car with `PoliceLights`, fixed-step order of design §15, traffic focus heading / lights / siren, interactions), app wiring (audio unlock on the first gesture, pause rule for non-pausing overlays, Escape order, police input, radio controller, 10 Hz target pick, cockpit + MDT screen, siren emitters and listener, HUD / minimap feed, settings, perf extras, console commands). Integration fix in `radio/compose.ts`: the player's new radio line now waits for their own transmission still on the air instead of stepping on it (the automatic traffic-stop call-out blocked the first plate run), with a test.
- ✅ **Save schema v4** (CAD with documents and the traffic stop, dispatcher, records, radio, per-vehicle equipment, officer kit, last speeding readings) with a v3 → v4 migration; every older version migrates; each malformed block is rejected.
- ✅ **Determinism**: a scripted patrol (calls, AI units, a traffic stop with the light bar, a radio plate run, a citation, the emergency button and code 4) replays to bit-identical v4 saves, and a loaded mid-shift save continues exactly (CAD, dispatcher, records, radio, traffic, equipment) (`test/game/session.test.ts`).
- ✅ 1 442 unit/integration tests (138 files); the browser smoke test covers Phases 0-2.

### How to run
```
npm install
npm run dev        # http://localhost:5173
npm run check      # tsc + eslint + vitest
npm run build      # production bundle in dist/
npm run smoke      # headless browser test + docs/screenshots/phase1*.png, phase2.png, phase2-mdt.png
```

### Controls (Phase 2 additions)
| | Keyboard / mouse | Gamepad |
|---|---|---|
| Siren on/off · tone (wail → yelp → phaser → hi-lo) | Q · R | Y · LB |
| Air horn (hold) · manual wind-up (hold) | G · F | R3 · - |
| Light bar · next pattern | L · K | X · - |
| Spotlight · aim it (hold, move the mouse) | J · right mouse button | - |
| Equipment panel (rack, long guns, spotlight, rear seat) | X (in a patrol car) | - |
| MDT | Tab (in a patrol car or at its driver door); Esc closes | - |
| Run the targeted (else the stopped) car's plate | P | D-pad right |
| Trunk / talk to the stopped driver | E at a patrol car's rear / at the stopped car's driver window | A |
| Radio menu · options | T · 1-9 | D-pad left |
| Push-to-talk (voice commands, if enabled) | B (hold) | RB |
| Emergency button | Z (hold 1.2 s) | - |
| Radio channel · scan | [ / ] · \ | - |

Every action can be rebound under *Settings > Controls*. In the MDT: 1-9 or ←/→ switch tabs, ↑/↓ move in lists, Enter opens, Esc cancels a form or closes the MDT. In the action panels: 1-9 or ↑/↓ + Enter select, Esc closes.

### Manual test checklist
1. **New game** with seed `42`: as in Phase 1, plus the radio log (left, above the minimap) starts filling with chatter and the HUD shows the unit chip `12 · 10-8 AVAILABLE`. The minimap shows AI units (green dots) and, once calls come in, call markers coloured by priority.
2. Get into a patrol car, press **Tab**: the MDT opens over the world (which keeps running: the clock and the queue ages advance). Walk through the tabs with 1-9 / ←→: Queue, Call, Units (roster with statuses), Map (AVL: units move, calls), Person (search a last name, e.g. `Smith`), Vehicle (type a plate), BOLO, Reports, Stop. **Esc** closes it (no pause menu).
3. Wait for a call (1-2 min; or console `cad call noiseComplaint here`): when one is near, the offer line and the radio offer it to unit 12 — **T 7** (or the MDT's Accept) accepts it: the call strip shows it, the minimap draws the route, `12 · 10-76 EN ROUTE`. Otherwise an AI unit is assigned; follow it on the MDT map. Arriving: **T 1 3** (on scene); clearing: MDT Queue → disposition → *Clear call*.
4. **Q** / **R** / **G** / **F**: siren on and its tones, air horn, manual wind-up (hear the siren from the cabin; outside the car it pans and fades with distance); **L** / **K**: light bar and patterns (*Reduce flashing lights* slows and dims them); **J** and hold the right mouse button to aim the spotlight (best at night, `time 22:00`); **V** to the cockpit: the laptop shows the CAD summary, the radio head the channel, the siren controller LEDs light up.
5. Traffic stop: drive behind a car and switch the light bar on (siren off): after about 1.5 s it signals, pulls to the curb and stops with hazards; the radio calls the stop out (`12, 10-38, ABC 1234, ...`) and a `trafficStop` call appears with unit 12 on scene. Aim at it and press **P**: the plate result appears on the HUD and in the MDT (Stop tab).
6. Get out (**E**), walk to its driver window, press **E**: the contact panel. *Request licence* identifies the driver (person result on the MDT), *Check VIN* compares the VIN with the plate (cloned plates show here), *Write citation* opens the MDT citation form prefilled from the stop (observed violations, recorded speed, plate issues; add violations from the statute list, *Issue citation*), *Release* lets the car merge back and closes the call as citation issued / warning / handled.
7. Arrest: on a stop with a free patrol car cage within 40 m, *Arrest* cuffs the driver and seats them in the cage (equipment panel **X** shows the rear seat). Drive to the station; in the MDT write a booking (Reports → Bookings → new; prisoner prefilled, charges e.g. PC-220 for a warrant) and *Complete booking*: the prisoner is handed over and the person's record gets the arrest.
8. Trunk: on foot at the rear of a patrol car, **E**: take / stow cones, flares, the first-aid kit...; the HUD's carried line follows. In the car, **X**: unlock the rack (only when stopped), check out the shotgun, lock it again.
9. Radio: **T** opens the menu (status, run plate, location (10-20), backup code 2 / 3, code 4, traffic stop, accept / decline, say again); **[ ]** change channel, **\\** scan (the strip shows SCAN; scanned channels are quieter); hold **Z** for the emergency button: priority tone, dispatch holds the channel, three units come code 3; **T 5** (code 4) ends it. Leave the officer on scene for 5 min (`timescale 8`): a status check comes; answer with any request (e.g. **T 5**), or ignore it twice to see the escalation.
10. Settings > Audio: master / effects / radio volume, spoken radio on/off, the dispatcher voice (console `voices` lists them), ten-code / plain radio language, voice commands (push-to-talk B; Chromium sends audio to its speech service); Accessibility: radio captions.
11. Console: `cad call alarm`, `cad units`, `cad calls`, `cad clear`, `lookup plate ABC 1234`, `lookup person 17` / `lookup person smith`, `radio say Testing`, `radio channel tac`, `siren yelp`, `lights takedown`, `platestates`, `bolos`, `dispatch stats`, `pullover`, `fleet`, `equip`, `docs`.
12. **Esc** → *Quick save* mid-stop with a prisoner in the cage and the siren on, then *Quit to title* and load `quicksave`: calls, units, documents, the stop, records, radio channel / scan / log, equipment (siren, pattern, spotlight, rack, trunk, prisoner) and the officer's kit are back; AI units carry on. A Phase 1 (v3) save loads with a fresh roster and fleet.

### Performance
- Fixed step in Node (seed 42, 192 ambient cars + 6 fleet cars, driving at the station, 3 600 steps): 0.46-0.49 ms per step on average; dispatch 0.010 ms (warm worst step 1.65 ms; the first call of a session can take up to ~5 ms in one step: cold code paths plus A* for its units), radio 0.002-0.003 ms (worst 0.4 ms), traffic 0.19-0.21 ms, vehicles.pre with the equipment writes 0.025 ms, physics 0.19 ms. Design §18 budgets: dispatch 0.05 ms average / 2 ms spike, radio 0.02 ms, traffic +0.05 ms, writeLook 0.005 ms.
- Presentation: the Phase 1 + 2 HUD feed with minimap markers costs ~0.007 ms per 10 Hz tick in Node; the in-car MDT screen model is rebuilt only on CAD changes (~0.001 ms) and painted at most at 2 Hz; the MDT overlay refreshes at most at 4 Hz and only on CAD revision changes.
- Headless Chromium with SwiftShader (1280x720, see `npm run smoke`): ~1-5 fps, dominated by software rasterisation as in Phase 1 (per frame: sim 1.6-4.9 ms for the 5 capped steps, update 0.8-1.4 ms, render 0.8-2.5 ms; the rest, 540-875 ms, is the GPU process). Draw calls 60-76 (cars 22, cockpit 6 in cockpit view); the cockpit view frame is cheaper than the street view (less city in sight). The MDT and the action panels sit on a light, blur-free layer, so the live world behind them is not re-filtered every frame.
- A v4 save is ~75-80 KiB of JSON.

### Known limitations
- No people meshes: the stopped driver, the prisoner and callers are records only; calls have no scene content beyond CAD, radio and the location (Phase 3 adds NPCs, dialogue and 150+ call types as data rows).
- Traffic never changes lanes: a car pulled over from an inner lane slides across the lanes to its right; cars only yield in their own direction of travel; a car in an inner lane pulling to the curb does not check the outer lanes.
- Fleet cars drive through a red junction under code 3 only when no other approach holds it, and wait behind queued traffic instead of weaving around it (ambient cars ahead yield to the curb).
- Time compression (30x) makes CAD timestamps advance quickly relative to driving times.
- Speech output depends on the browser's voices (headless Chromium has none: captions only); recognition is browser-provided (Chromium sends audio to a vendor service unless on-device recognition is available) and is off by default.
- Trunk items have no world use yet (deployables are Phase 3) and the rack's guns cannot be fired; the booking is a form at the station (no transport or jail scene).
- The reticle target wins over the stopped car for **P** and the radio menu's plate run; the MDT closes with Escape only (Tab moves focus between its fields).
- A traffic stop needs the patrol car moving behind the car with the light bar on and the siren off (lights + siren only make traffic yield; a parked car with scene lights stops no one); while the player is on another call a pull-over is refused (the car drives on, the MDT shows why).
- Radio-menu requests wait for a clear dispatch channel and key up first when it clears; voice push-to-talk keys up at once and can step on traffic. During an emergency, routine unit traffic is not voiced (radio silence) and "resume normal traffic" goes out first after Code 4.
- The dispatcher assigns all pending calls in one step, so a burst of calls can spike a single step to a few milliseconds (first call of a session up to ~5 ms).
- Under software GL (SwiftShader) the game runs at about 1-5 fps and the loop hits its 5-sub-step cap; on a real GPU it runs at the display rate.
