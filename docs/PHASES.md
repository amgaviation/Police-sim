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

## Phase 3 — People and Calls

Status: ✅ complete. Screenshots: `docs/screenshots/phase3.png` (a call scene on the street: the people of a domestic disturbance with the call's objectives and the minimap markers) and `docs/screenshots/phase3-dialogue.png` (the dialogue panel mid-conversation), both taken by the smoke test. Design and module contracts: `docs/phase3-design.md`.

### Completed
- ✅ **Persistent people** (`people/`, `data/people/`): any of the 100 000 Phase 2 person ids becomes a full person on demand from `(seed, id)` and its CAD record: name, DOB, address, employer, vehicle, family (parents, partners, children, siblings, a guardian for 16-17 year olds), temperament, honesty, attitude, language and English level, hearing (deaf, hard of hearing), dementia, mental health, health conditions, drinker and drug use (a deterministic blood-alcohol curve over the day), appearance (clothes change per day) and hidden items (weapons, drugs, a fake ID, stolen goods ...) with concealment levels. The same id and seed give the same person in every session and after every load; the identity is regenerated when the CAD overlay changes (served warrant, new prior) so the record and the person never contradict. Only touched persons are saved, as deltas (cap 3 000, protected persons are never evicted).
- ✅ **Ambient pedestrians and occupants** (`npc/`): up to ~160 pedestrians on the sidewalks (density by district and hour: dense downtown at midday, thin at night; LOD ticks, no physics bodies) and the occupants of cars (drivers and passengers of the pulled-over car, who can step out and be sent back).
- ✅ **Procedural humanoids** (`render/people/`): instanced boxes with bone-less limb transforms (head, hair, torso, arms, thigh + shin so knees bend, dogs, held items), 7 draw calls for up to 320 figures; clothes, skin, hair and build from the identity; poses for walking, running, hands up, kneeling, prone, cuffed, seated, aiming, fighting and lying. The officer is drawn as a figure too (sidearm / TASER in hand). Props (cones, flares, tape, evidence markers, weapons, bottles ...) in 12 draw calls.
- ✅ **Behaviour state machine** (`npc/`, `data/npc/behaviors.json`): 32 profiles (cooperative caller, upset victim, evasive suspect, intoxicated, crisis, suicidal, armed hostile, barricaded, juvenile, guardian, protester, ambusher, dog ...) with compliance, flee, fight, draw-weapon and surrender chances; commands (stop, hands up, get down, turn around, come here, follow me, sit, step out, drop the weapon ...) are rolled against stress, rapport, tone, weapon, backup and lights; actors flee along the sidewalks, fight, kneel, can be cuffed, follow when escorted and are tackled or tasered.
- ✅ **Dialogue** (`dialogue/`, `data/dialogue/`, `ui/dialogue/`): a data-driven menu of 42 utterances in 9 topics (greeting, reason, ID, questions, consent, commands, support, rights, closing) with four tones (polite, neutral, commanding, aggressive) whose effect depends on the person, the hour and the neighbourhood; deaf people need written notes or gestures, non-English speakers an interpreter or a translation app (delayed, sometimes garbled), juveniles a guardian for consent, people with dementia answer unreliably; consent for search, breath test and field sobriety tests can be refused and asked again after building rapport. The panel is keyboard-first (digits, ←/→ tone, Tab tabs, M comm mode, Backspace, Esc), with a transcript, an Actions tab and a Notes tab (statements, facts, inconsistencies), and subtitles for every spoken line; English NPC lines are spoken with per-person voices when text-to-speech is on.
- ✅ **Lies and inconsistencies** (`dialogue/respond.ts`, `dialogue/inconsistency.ts`, `data/dialogue/rules.json`): people lie about their name and date of birth (invented, altered, or a relative's), destination, car contents and drinking, repeat the lie or change it under stress, hand over fake IDs; 16 rules compare what was said with CAD lookups, documents, physical evidence and earlier statements. An inconsistency shows on the Notes tab only once both facts are known to the player (nothing leaks before a lookup).
- ✅ **Field actions** (`contact/`): ID request (CAD gets the claimed identity), run name / DL number / plate / VIN, frisk and search with consent or custody (items found are listed and can be seized), visual vehicle check, PBT, the SFST minigame (HGN, walk-and-turn, one-leg stand with a key prompt panel), cuff, escort (the prisoner follows), put in the rear seat, release, warn and release, citation (opens the MDT form), notify a guardian, translation app, interpreter. Statements, facts, lies and officer history are saved on the person; a booking adds the booking identity as a fact and puts the person in jail.
- ✅ **150+ call types** (`calls/`, `data/calls/`): 163 call types in 27 families validated at startup (strict schema, every condition atom checked against the family, every outcome reachable): traffic stop, impaired driver, collisions, domestic disturbance, welfare check, noise, trespass, shoplifting, burglary, robbery, shots fired, active assailant, armed person, suicidal subject, overdose, missing person, juvenile runaway, wanted subject, felony stop, vehicle and foot pursuit, hostage and barricade, K9 track, warrant service, protest, special event traffic, parking, strays, hazmat, bomb threat, stolen vehicle, fraud, stalking, sexual assault, death investigation, school threat and more. Each family has roles (with profiles, items, weapons, intoxication), branches, variants, actions, services and outcomes; the call generator weights types by hour and district.
- ✅ **Scenes** (`scene/`): every CAD call gets a deterministic scenario: imperfect dispatch information (wrong address, wrong description, a later correction), a timeline of CAD narrative updates, and the variants escalation, de-escalation, false call, duplicate call (a linked, closed second call), swatting and ambush at configured rates. People appear when the assigned officer comes within 220 m; arrival is detected within 50 m. The scene panel (**Y**) offers the family's actions (knock and announce, separate the parties, request EMS / fire / supervisor / K9 / tow / interpreter with a radio acknowledgement and arrival, photograph, collect evidence, canvass, search the area, barricade perimeter, write the report) and clearing the call, which is graded (`CallOutcome`: branch, variant, objectives met, force used, suggested versus recorded disposition) for Phase 5.
- ✅ **Use of force and pursuits (placeholder with hooks)**: **C** cycles holstered / sidearm / TASER, the left mouse button fires the TASER (sidearm discharge is not modelled), **Space** tackles, **G** shouts a context command; `force:used` events and `CallOutcome.forceUsed` feed Phase 5. A suspect who flees starts a foot pursuit (HUD line, minimap marker, tackle, cuff); a pulled-over car may flee (wanted, stolen, drunk or carrying contraband drivers do so more often, `traffic.flee`): a basic vehicle pursuit (HUD line, the car leaves, crashes, gives up or escapes).
- ✅ **Dispatch integration**: the generator draws from the catalog (varied calls, AI units take some, the player can accept any), a pulled-over car owned by the player's call runs its stop on that call, a fled stop closes as lost, duplicate calls are linked (`cad.linkCalls`), scene radio lines go out on dispatch.
- ✅ **Save schema v5** (`save/`): `people` (touched-person deltas: intoxication, mood, custody, injuries, items, statements, facts, lies, flags), `npc` (pedestrians, actors, occupant state), `contacts` (open conversations with memory, transcript, SFST), `scenes` (scenarios with branch state, flags, actions and services, graded outcomes, props, pursuits, officer weapon) with a v4 → v5 migration (open calls get scenarios at load); every older version migrates and each malformed block is rejected. **The schema is frozen after this phase.**
- ✅ **Console**: `call spawn <type> [here] [variant...]`, `call list`, `call types <filter>`, `npc spawn <temperament|profile>`, `npc info`, `dialogue debug`, `population density <n>`, `population stats`, plus the module commands (`scene`, `weapon`, `peds`, `actors`, `who`, `intox`, `catalog`, `flee`).
- ✅ **Determinism**: a scripted Phase 3 shift (a spawned domestic call: accept, walk, knock, victim contact with ID and account, cuff, escort, cage; then a DUI stop with ID, drinking question and PBT) replays to bit-identical v5 saves, and a save made mid-scene continues exactly (people, scenes, contacts, npc, CAD, dispatch, records, traffic) (`test/game/phase3.test.ts`). Population determinism and CAD consistency, the call generator (all types valid, outcomes reachable, variants at their rates), the dialogue state machine and the inconsistency engine each have their own unit tests.
- ✅ **End-to-end flows verified in the real game** (`npm run smoke`, through `window.patrol`): traffic stop with dialogue, ID, citation and release; DUI to booking (odor, PBT, SFST, step out, cuff, cage, booking → jail); domestic (separate, statements, inconsistencies, arrest, cage); shoplifting (store guard and suspect, arrest); lie detection (fake IDs); foot pursuit (flee, chase, tackle); vehicle flee; false call; duplicate call linked in CAD.
- ✅ 2 171 unit and integration tests (209 files); the browser smoke test covers Phases 0-3 (106 checks).
- ✅ No third-party assets, no new dependencies; `docs/ASSETS.md` stays empty.

### How to run
```
npm install
npm run dev        # http://localhost:5173
npm run check      # tsc + eslint + vitest
npm run build      # production bundle in dist/
npm run smoke      # headless browser test (Phases 0-3) + docs/screenshots/phase1*.png, phase2*.png, phase3*.png
```

### Controls (Phase 3 additions)
| | Keyboard / mouse | Gamepad |
|---|---|---|
| Talk to the person in front (within 2.2 m) / the stopped driver | E | A |
| Put the escorted prisoner in the rear seat | E at a patrol car's rear door | A |
| Dialogue: topic, line / tone / tab / comm mode / back / close | 1-9 · ←→ · Tab · M · Backspace · Esc | |
| Scene panel of your call | Y | |
| Cycle weapon (holstered, sidearm, TASER) | C | Start |
| Fire the TASER (weapon drawn, on foot) | left mouse | RT |
| Tackle (on foot) | Space | B |
| Shout a command (stop, drop the weapon, hands up) | G | |
| SFST prompts | A / D (or ←/→), W (or ↑), Space | |

Space, G and the mouse button keep their driving meaning (handbrake, horn) in a vehicle. Every action can be rebound under *Settings > Controls*.

### Manual test checklist
1. **New game**, seed `42`: pedestrians walk around the station; `tp downtown` and `time 12:00`: the sidewalks fill (F3 shows `npc` peds / actors / occupants, `people` touched / drawn / draw calls). `population density 2` doubles them, `population density 0` removes them.
2. Calls: wait for a call (the radio and the MDT queue show a mix of types), or `call types` and `call spawn domesticDisturbance here`. Accept it (MDT or **T 7**), walk to it: the people of the scene appear when you are within ~220 m; the HUD box lists the objectives. **Y** opens the scene panel: *Knock and announce* (1), then *Separate the parties* once they are out.
3. Walk up to a person: the prompt shows `E Talk`. In the dialogue: **2** (Reason for contact) / **3** (Identification) → **1** asks for ID; the person answers (after a moment), the transcript and the subtitle line show it. Try **←/→** (tone), **M** (communication mode, once you notice a barrier), **Tab** → Actions (frisk, search, PBT, SFST, run name / ID, cuff, escort, release, citation) and Notes (statements, facts, inconsistencies). Ask the same question again, or run the name after hearing a name and a date of birth: a lie shows on the Notes tab only after the lookup.
4. Traffic stop with dialogue: light bar behind a car, walk to the driver window, **E**: ask for ID (CAD gets the identity: the MDT Stop tab), ask where they are going and whether they have been drinking (odor of alcohol shows on the chip and the Notes tab), run the name, **Actions → Write citation** opens the MDT form, **Release**.
5. DUI: with a drinking driver ask *Have you been drinking?*, then *Would you be willing to blow into a handheld breath tester?* (Consent) and **Actions → Breath test (PBT)**; *Order the subject out of the vehicle* (Commands) then consent to the sobriety tests and **Actions → Field sobriety tests**: follow the prompts with A / D / W / Space (a finished summary lingers for 8 s); *Hands up*, **Actions → Cuff**, **Escort** (the person follows), walk to the patrol car's rear door and press **E** (the cage); drive to the station and complete the booking in the MDT (the person is in jail; the booking adds a fact on the person).
6. Domestic: separate the parties, take statements from both (account, injuries), compare them on the Notes tab, then cuff and cage the suspect or write a report; clear the call from the scene panel (the suggested disposition follows what you did).
7. Foot pursuit: arrive at a call whose suspect is flee-prone (or `weapon` then shout **G** at a hostile person: "Drop the weapon!"): the suspect runs, a red `FOOT PURSUIT` line and a marker follow; chase and press **Space** within ~2 m (a tackle), then cuff. A car you pull over may run (wanted, stolen or drunk drivers more often): a `vehicle pursuit` call opens, the HUD shows a `PURSUIT` line and the minimap marker follows the car; the console `flee` makes the nearest ambient car run.
8. `call spawn loudParty here duplicate`: a second, linked call appears and closes as a duplicate (`call list`, MDT Call tab shows the link); `call spawn noiseComplaint here false`: nobody is there (graded unfounded).
9. **Esc** → *Quick save* mid-conversation or mid-scene, *Quit to title*, load `quicksave`: the pedestrians and actors, the conversation (transcript, statements, discovered facts), the scenes and their flags, the prisoner in the cage and the touched people are back; a v4 save loads with fresh pedestrians and scenarios for its open calls.
10. Console: `npc spawn volatile` then `npc info` / `dialogue debug`; `who 17` prints a person; `intox 17 0.12`; `scene info|outcomes`; `catalog stats`.

### Performance
- Fixed step in Node (seed 42, default pedestrian density at the station, 18 000 steps): 0.59 ms per step on average, of which npc 0.025 ms (160-pedestrian rig with 30 actors and car occupants: 0.06-0.08 ms, budget 0.15), scene 0.011 ms, contact 0.0004 ms, dispatch 0.005 ms, traffic 0.29 ms, physics 0.15 ms. A new identity costs ~0.06 ms (2 000 in ~120 ms); the family name index (built once per seed) a few MB.
- People renderer: 300 figures in about 0.22 ms CPU per frame (budget 0.6), at most 7 draw calls (+ at most 12 for props); no allocation per figure. The dialogue panel is rebuilt only when the contact's revision changes (at most 10 Hz), the SFST panel at most 30 Hz while a test runs.
- Headless Chromium with SwiftShader (1280x720, `npm run smoke`): downtown at midday the pedestrian cap (160) is reached and 149 figures are drawn in 5 draw calls (6 with the scene's props); the whole frame stays at 34-81 draw calls (cars 20-22). The Phase 3 scene frame: 1.5 fps = sim 2.8 ms (5 capped steps) + update 1.2 ms + render 1.2 ms (draw submit 1.2 ms) + 648 ms waiting for the software rasteriser, which sets the frame time as in the earlier phases. Fast-forwarding 20 simulated minutes with 160 pedestrians, the call stream, AI units and traffic costs 0.34 ms per step (24 s for 72 000 steps).
- A v5 save with a shift's worth of state is ~113 KiB of JSON (npc 25 KiB, scenes 8 KiB, traffic 52 KiB, the people deltas a few hundred bytes per touched person).

### Known limitations
- People have no physics bodies: they do not block the officer or cars, cars do not hit them, and they keep to sidewalks and road shoulders and never enter buildings ("inside" participants appear at the door).
- Use of force is a placeholder: the TASER and tackles work, the sidearm never fires (`force:used` events and `CallOutcome.forceUsed` feed Phase 5), NPC gunfire does not injure the officer, and nobody is hurt in a fight.
- Pursuits are basic: a fleeing car leaves at speed along the road graph until it crashes, gives up or escapes; no PIT, spikes or air support (Phase 6). A foot chase ends in a tackle (no wrestling).
- Juveniles are 16-17 only (the registry's age range); family members may live at different addresses; neighbourhood trust is a per-district table (Phase 5 makes it dynamic); the rights utterance is a Phase 5 stub.
- NPC voices use the browser's English text-to-speech voices; non-English lines are shown as untranslated text. Headless Chromium has no voices.
- When an AI unit is also assigned to the player's call, the CAD disposition is the last unit's (the scene's graded outcome is separate, with the suggested disposition).
- The first-person weapon is not drawn in the cockpit view; the officer's figure is hidden while driving.
- Under software GL (SwiftShader) the game runs at about 1-5 fps and the loop hits its 5-sub-step cap; on a real GPU it runs at the display rate.
- Integration fixes outside the integrator's own files: `OfficerKit.consume` (new, with tests), `Population.touchedCount` and `emptyPeopleSave`, the `dispatch` perf test's worst-step allowance (20 -> 50 ms: it flaked under parallel test load), `test/game` Phase 2 tests adapted (no automatic cage seating on an arrest; the scripted-patrol replay no longer asserts a chance call was generated).

## Phase 4 — Interiors and Scene Work

Status: ✅ complete. Screenshots: `docs/screenshots/phase4.png` (inside a house with the flashlight on and an evidence marker), `docs/screenshots/phase4-station.png` (the roll-call briefing in the station) and `docs/screenshots/phase4-case.png` (the case file), all taken by the smoke test. Design and module contracts: `docs/phase4-design.md`.

### Completed
- ✅ **Enterable buildings** (`world/buildings.ts`, `data/interior/buildingKinds.json`): every generated building has a stable id (`block * 256 + local`), one of 12 kinds (house, apartment, convenience store, bank, bar, hospital, school, warehouse, office, parking structure, jail, police station) from district / block / POI rules, a front side, an address from the nearest street and an entrance (`BuildingIndex`: `building`, `near`, `nearestEntrance`, `at`, `station`, `jail`); about 14 800 buildings per city classify in ~0.1 ms each.
- ✅ **Modular interior generator** (`interior/`, `data/interior/`): `generateInterior(seed, building)` is a pure function of (seed, building id) over 12 data-driven templates (BSP, corridor and apartment-suite layouts): rooms, walls with door gaps, interior and exterior doors (open, closed, locked, broken; `strength` for kick and ram; wide openings for garages and sally ports), procedural box furniture with containers (drawer, cabinet, closet, safe) and print surfaces, hiding spots, spawn and item spots, light switches and ceiling fixtures, the station's points (locker, briefing, armory, evidence, report desk, interview, cells, front desk, garage). Every room is reachable, door and lock data are consistent, and every building the index classifies as enterable generates (unit tests over ~14 800 buildings of two seeds).
- ✅ **Interior runtime** (`indoors/`, `render/interior/`): interiors stream in within 25 m of an entrance (layout, Rapier wall and door-panel colliders, at most 2 resident, one load per step) and stepping through a door is a 0.6 s fade; doors open, close, lock, unlock, can be kicked and rammed (the ram is a trunk item); light switches drive real pooled point lights (`InteriorLightPool`, 4 lights); ambient occupants (residents by hour, clerks, patrons, staff) are spawned through the npc module; the interior mesh draws in at most 6 draw calls; the city chunks are hidden and precipitation off while indoors.
- ✅ **Indoor calls**: burglary, domestic, welfare check, barricade, death investigation, shoplifting and related types bind to a real building (`data/scene/indoor.json`): "inside" participants stand in rooms, hidden ones in hiding spots, the deceased lies in a bedroom, evidence lies on surfaces or in containers, the front door may be locked or barricaded, a knock is answered by the resident after a few seconds, a forced entry is recorded. `call spawn <type> building <id>` binds a call to a chosen building.
- ✅ **Tactical movement** (`tactical/`, `player/cameraRig.ts`): crouch (X), lean left / right (Q / R, held), door slicing (right mouse, held: a slow pie around the frame), first-person camera indoors with the stance and lean applied (V toggles it outdoors), a flashlight SpotLight (F; NPCs notice the light), an AI partner placeholder (N: follow, stack on the door, clear, hold, dismiss / summon), the officer figure's crouch pose.
- ✅ **Sound, sight and awareness**: footsteps by surface and speed, door sounds, radio chirps and voices propagate through the room graph with door attenuation to the NPCs that listen; a notice pass (line of sight, exposure, light) feeds NPC awareness (`npc:aware`: alert, then a rolled reaction: none, hide, flee, confront, surrender, arm); the HUD shows a 5-step noise meter and a visibility readout; crouching behind furniture lowers exposure.
- ✅ **Evidence and the chain of custody** (`evidence/`, `investigation/`, `ui/investigation/`): numbered evidence markers with labels, photographs (viewfinder with zoom; the case file keeps the camera position, time, subjects and a 160x90 JPEG thumbnail captured right after `renderer.render()`), a fingerprint dusting minigame, scene tape that NPCs respect, the bodycam (mount chosen at the locker; REC chip; segments in the case file), witness interviews (Phase 3 dialogue, canvass witnesses answer `Did you see or hear anything?`), a neighbourhood canvass (door panel: Knock (canvass)), a K9 sweep, plain-view flagging and consent searches with scope; every item records the legal basis (plain view, consent, warrant, incident to arrest, exigency, protective sweep, public area) and an item found without one is flagged suppressed. The **hash-chained custody ledger** records collect, bag, tag, transfer and deposit; `ledger verify` detects any edit; depositing at the station's evidence point completes the chain.
- ✅ **The police station** (`station/`, `ui/station/`): lobby, locker room, roll call, armory, report room, evidence room, three holding cells, interview room, sally port and garage. **A new shift starts in the locker room**: choose the loadout (uniform colours, vest, bodycam mount, radio audio, flashlight), attend roll call (`BriefingScreen`: BOLOs, district notes, open calls, roster, crime trends), sign out the duty pistol and TASER (`ArmoryLog`; the scene's weapon gate reads it), leave through the garage door or get into a patrol car; the unit is out of service until then. The report desk opens the MDT, booked prisoners sit in holding cells (a prisoner goes to county after 30 minutes; with every cell taken the longest-held one goes first) and the interview room brings them to the table (a Phase 3 conversation).
- ✅ **HUD and panels**: shift objective, location chip, stance / light chips, noise and visibility, REC, case line, a floor plan on the minimap, the fade overlay; door, locker, armory, interview, partner and investigation-tools panels, the viewfinder, case file and dusting panels (`game/phase4Presenter.ts`, `game/stationPanels.ts`). Nine new input actions with default bindings (shared keys are chosen by on foot vs in a car).
- ✅ **Save schema v6** (`save/`): `interiors` (door and light overrides, the officer's building, the pending fade), `tactical`, `investigation` (case files with photo thumbnails, ledger, tapes, K9, dusting, bodycam) and `station` (flow, armory log, loadout, cells, interview) with a tested v5 → v6 migration (empty blocks on the seed's streams, a shift already on patrol with the pistol and TASER out, trunks gain the six new items); every older version still migrates; each malformed block is rejected. **The schema is frozen after this phase.**
- ✅ **Console**: `building`, `interior info|enter|exit|gen <kind> <seed>|doors|unlock|lights`, `shift`, `armory`, `loadout`, `case`, `evidence list`, `custody <id>`, `ledger verify`, `k9`, `tape clear`, `aware`, `sound <kind>|debug`, `partner`, `call spawn <type> building <id>`.
- ✅ **Determinism**: a scripted shift (loadout, roll call, armory, the garage door; a domestic call bound to the nearest house: knock, marker, photo, collect / bag / tag, entry, crouch, flashlight, lean, a kicked door) replays to bit-identical v6 saves, and a v6 save made mid-scene continues exactly (interiors, tactical, investigation, station, scenes, npc, contacts, CAD, people, records); a v5 save loads outdoors with the station on patrol (`test/game/phase4.test.ts`). Unit tests cover the interior generator (determinism per building id and seed, every room reachable, doors and locks consistent), the sound propagation model, the chain-of-custody ledger (no gaps, tamper detection) and the plain-view / consent search rules.
- ✅ **End-to-end flows verified in the real game** (`npm run smoke`, real keys where the keys exist): the new shift through locker, roll call, armory and the garage door; a house entered with E (hold E for the door panel), the interior drawn in at most 6 draw calls, flashlight / crouch / lean, a door kick, a domestic call bound to the house with the suspect inside, a marker, the camera with its thumbnail, the case file, the deposit that completes the custody chain at the station, a prisoner in a cell and the interview, a v6 save and load, the console commands.
- ✅ 2 905 unit and integration tests (287 files) pass under `npm run check`.
- ✅ No third-party assets, no new dependencies; `docs/ASSETS.md` stays empty.

### How to run
```
npm install
npm run dev        # http://localhost:5173
npm run check      # tsc + eslint + vitest (2 905 tests)
npm run build      # production bundle in dist/
npm run smoke      # headless browser test (Phases 0-4) + docs/screenshots/phase1*.png ... phase4*.png
```

### Controls (Phase 4 additions)
| | Keyboard / mouse | Gamepad |
|---|---|---|
| Enter / exit a building, open or close a door, switch lights, use a station point, collect a found item | E | A |
| Door panel (knock, announce, open, kick, ram, lock, canvass, enter) | hold E at a door | hold A |
| Crouch · lean left / right (hold) · slice a doorway (hold) | X · Q / R · right mouse | R3 · - · LT |
| Flashlight · bodycam · first-person camera on foot | F · U · V | D-pad up · - · - |
| Investigation tools · evidence camera (shutter Space or Enter, zoom ↑ / ↓) · partner commands | I · O · N | |

X, Q, R, F and the right mouse button keep their driving meaning (equipment panel, siren, tone, manual siren, spotlight aim) in a vehicle. Every action can be rebound under *Settings > Controls*.

### Manual test checklist
1. **New game**, seed `42`: you stand in the locker room; the HUD says `Shift: choose your gear at the locker (E)`, the minimap shows the floor plan and the unit chip says `10-7 OUT OF SERVICE`. **E** at the lockers: **1-5** cycle the options, **6** is Done. Walk (WASD, mouse) to the roll-call podium (the room east of the lobby): **E**, read the sheet, **Enter**. The armory (north-west): **E**, **1** pistol, **2** TASER, **7** Done. Leave by the garage door (west end of the south wall, **E**) or walk to a patrol car: the unit goes `10-8 AVAILABLE`. `shift` and `armory` print the state.
2. Houses: `building house` prints the nearest one; `tp` or drive there, walk to a door: `E Enter building` (a locked door shows `E Locked door: options`). Tap **E** to go in; **hold E** for the door panel (**1** knock, **2** announce, **3** open / close, **4** kick, **5** ram (take the ram from the trunk first), **6** lock / unlock, **8** enter). Indoors: **X** crouch, hold **Q** / **R** to lean, **F** flashlight, hold the right mouse button at an open doorway to slice it, **V** is first person outdoors, **E** at a light switch toggles the lights, `interior doors` lists the door states.
3. A domestic call: `call spawn domesticDisturbance building <id of that house>`, accept it (**T 7** or MDT), knock: the resident answers at the door; talk to them (**E**, topic *Consent*: *May I come in?*), go in, find the suspect (hiding spots; a K9 unit from the tools panel or `k9 <callId>` indicates hidden people), the HUD shows the objectives.
4. Evidence: **I** opens the tools (**1** marker, **2** camera, **3** collect, **4** bag, **5** tag, **6** secure tagged evidence in a patrol car trunk, **7** search a container, **8** dust, **9-11** tape, **12** canvass, **13** K9, **14** bodycam, **15** case file); **O** opens the viewfinder (**Space** photographs, **↑↓** zoom, **Esc**). **E** at a found item collects it. Items found in plain view or by consent show their basis in the case file; an item found without one shows as suppressed. Carry it to the evidence room (`interior enter policeStation`, then **E** at the evidence point) to deposit it: the case file shows the chain complete; `custody <id>` and `ledger verify` print it.
5. Scene tape: tools → *Tape post* at several points, *Tape close*: pedestrians no longer walk through the polygon. A neighbour: walk to another house's door, hold **E** → *Knock (canvass)* (only while a call is active and nearby).
6. Prisoners: arrest and book someone (Phase 3 DUI flow) and complete the booking in the MDT at the report desk (**E** in the report room, or in a patrol car near the station): the person sits in a holding cell; **E** at the interview point → *Bring in <name>* opens a conversation at the table.
7. **Esc** → *Quick save* indoors, *Quit to title*, load `quicksave`: the interior, the doors you kicked, the lights, the case file, the custody ledger and the cells are back; a v5 save loads outdoors with the station already on patrol.
8. Console: `sound debug`, `sound kick`, `aware`, `partner summon`, `interior gen bank 3`, `evidence list`.

### Performance
- Node (seed 4242, a whole session in the station, 1200 fixed steps after a 120-step warm-up): 1.11 ms per fixed step for everything (physics, 145 traffic cars, npc, dispatch, interiors, tactical). Design budgets (§17): interiors 0.02 ms, investigation 0.02 ms, station 0.005 ms, tactical 0.05 ms; the perf overlay's per-system counters read 0.0 ms for interiors, investigation and station and 0.0-0.1 ms for tactical in every smoke phase.
- Generation: ~0.1 ms per building including classification; an interior load (layout + colliders) 1-3 ms once (first cold load ~9 ms).
- Interior renderer: at most 6 draw calls per visible interior; the light pool is 4 point lights plus one spot for the flashlight; the people renderer gets at most +3 figures (partner, dog, handler) + 5 staff; props are merged into one source (<= 1 024).
- Headless Chromium with SwiftShader (1280x720, software GL, 1-2 fps, so these are draw-call and sim counts, not frame rates): the station interior draws in 6 draw calls and the whole frame in 37-38 draw calls (136k triangles) with the city chunks hidden; a house interior in 6 (37 total). Sim cost per frame (5 steps) 4.3-9.4 ms across the phases; npc 0.1-0.7 ms, traffic 0.1-0.6 ms.
- A v6 save with a case file, a ledger and one thumbnail adds a few KiB; thumbnails are capped at 32 (~3 KiB each).

### Known limitations
- **Layout change in review round 1**: furniture keeps the arrival poses, stand points and doors reachable, so interiors generated by an earlier build differ for some buildings; items and furniture of a v6 save made before this fix may sit at positions of the old layout (interiors themselves are never saved).
- The officer collider is an upright cylinder (0.8 m wide whatever the facing), so every 0.9 m door passes at any yaw; the generator keeps the arrival poses, the point stand positions and the doors of every room reachable around the furniture (`interior/walk.ts`).
- One floor per building (no stairs); the interior is a below-grade copy of the footprint entered with a short fade; windows do not show the interior and the outdoor world does not see inside.
- NPCs pass closed unlocked doors without opening them visually and never lock doors; ambient occupants do not path between buildings; a resident answering a knock stands at the door and the tap hint prefers talking to them (hold **E**, door panel, *Enter*).
- Line of sight outdoors ignores buildings (only interiors occlude); sound between two buildings is not modelled; the tactical notice pass (NPCs noticing the officer) is off in the Phase 1-3 compatibility mode used by their tests (`GameContext.indoorScenes = false`).
- Consent is granted or denied with a scope; there is no revocation dialogue; warrants exist only for warrant-service calls; the recorded search basis is graded in Phase 5.
- The partner is a placeholder (no combat, no voice commands, straight-line moves between doorway waypoints); the K9 is a stub that indicates hidden people and items.
- Uniform choices only change the officer figure's colours (Phase 7 gear); the locker and armory panels have no animations.
- Photo thumbnails are small JPEGs captured from the frame (presentation output, null without WebGL); tagged evidence can be secured in a patrol car trunk (tools panel row 6, or Enter on the item in the case file at a trunk) and the evidence-room deposit takes it from the trunk.
- A new shift carries a field kit (8 markers, 8 bags, the camera, the dust kit, a tape roll); the ram stays in the trunk (the trunk panel moves items).
- Under software GL (SwiftShader) the game runs at about 1-5 fps; on a real GPU it runs at the display rate.
- Integration fixes outside the integrator's own files: `InteriorSystem.leaveBuilding`, `residentPerson` (indoors), `SceneDirector.ownsBuilding` / `addWitness` / a forced building for `spawnCall` (scene), `test/input/input.test.ts` (the example unbound key `KeyU` is the bodycam now; `F5`), `test/save/*` and `test/game/*` adapted to v6 (the Phase 1-3 game tests run with `indoorScenes: false` and start outdoors, `Harness.start(seed, inStation)`).

## Phase 5 — Law, Procedure, Consequences

Status: ✅ complete. Screenshots (taken by the smoke test): `docs/screenshots/phase5-mdt.png` (the MDT Career tab), `docs/screenshots/phase5-court.png` (the courtroom) and `docs/screenshots/phase5-review.png` (the evidence review of an internal-affairs case). Design and module contracts: `docs/phase5-design.md`.

### Completed
- ✅ **Jurisdiction-aware legal engine** (`legal/`, `data/legal/rulesets/*.json`, pure, no other module): `evaluateIncident(log, ruleset)` judges an incident's structured event log against a JSON ruleset (`generic` generic state law, `strict` proves the swap; 34 rules, 26 indicators, 9 offenses each; a new `<id>.json` in the folder is picked up automatically). Reasonable suspicion and probable cause from weighted indicators, Terry stops and frisks (scope, plain feel), search incident to arrest (time window, vehicle rule), the automobile exception, consent (validity, scope, coercion), exigency and premises entry, Miranda / custodial interrogation (warning, waiver, invocation), breath and sobriety tests, the use-of-force continuum and justification, the duty to intervene, pursuit policy, recording policy (bodycam activation and muting) and **evidence admissibility with the fruit-of-the-poisonous-tree chain** (attenuation, independent source, inevitable discovery). Every determination cites ruleset rule ids that `citation()` renders as generic citations ("GS-4.1 Gen. Crim. Proc. § 4.1 — Search incident to arrest").
- ✅ **Structured event log built from the Phase 2-4 events** (`incidents/`, `data/incidents/mapping.json`): observations, lookups, statements, questions, consents, frisks, searches, seizures, tests, arrests, force, pursuits (1 Hz samples), entries and camera state, every event with body / muted / dash camera bits; field contacts get their own logs and merge into the call's log; capped at 600 events per log, 24 closed logs kept.
- ✅ **Use of force** (`force/`, `data/force/force.json`): hands, OC spray, baton, TASER (2 cartridges, probe spread and hit model, clothing and cold, 5 s cycles, cycle limit, risk factors: elderly, pregnant, elevated position, running, restrained, juvenile), K9 apprehension, less-lethal launcher, firearm (aim along the camera, hit zones, NPC injury and death); tools need their armory item signed out and ammo (refilled on sign-out). Every application records the subject's resistance level (compliant ... lethal, from the NPC's behaviour) and is scored at once (HUD line "TASER on assaultive resistance: within policy (GS-8.1)") and again in the assessment. The partner placeholder can strike a restrained subject; **H** intervenes.
- ✅ **Reports graded** (`conduct/report.ts`, MDT statements checklist): the report form lists true facts, plausible false facts and conclusions (the truth is never sent to the UI); the grade counts completeness, contradictions (heavier when the bodycam recorded the truth) and unsupported claims.
- ✅ **Bad stops and searches have consequences**: suppressed evidence weakens the case, an unlawful-arrest motion dismisses it (court), and a dismissal for misconduct costs trust and credibility.
- ✅ **Internal affairs, discipline, commendations** (`conduct/`, `ui/ia`, `ui/review`): data-rule triggers (excessive force, doctrine violations, injury after arrest, complaints), a case with the **evidence review** (bodycam timeline: scrubber, REC / MUTED / DASH strip, events, snapshots), the officer's statement from the review footer (an untruthful account of on-camera force is sustained), findings and discipline (counselling, reprimand, suspension that puts the unit out of service, termination, civil suit, criminal charges); commendations for good policing.
- ✅ **Community trust per district** (11 districts, persisted, MDT *Community* tab, HUD chip): deltas from lawful and unlawful conduct, a spill to the other districts and drift back to the baselines; it feeds NPC cooperation (dialogue), tip quality (dispatch-error scale), hostile onlookers at arrests and force, and the call generator's crime factor.
- ✅ **Court** (`court/`, `ui/court`): every final booking or citation opens a case (pleas rolled), a hearing is scheduled on the game clock with a subpoena (radio, HUD line, MDT *Career* calendar), the officer attends in a window around it; the courtroom shows the judge's rulings on the motions, then a cross-examination built from the report choices and the event log (yes / no / don't recall), scores contradictions (with the log, the report, themselves, the camera), decides the verdict and moves credibility, trust and discipline.
- ✅ **Bodycam and dashcam recording** (`recording/`): the camera bits ride on the event stream; the bodycam (U) and a mute key (J) are judged by the ruleset's recording policy; 160x90 JPEG snapshots of the live canvas every 3 sim seconds while recording (and at once after force or a booking) go to IndexedDB `patrol-media` with caps (3 000 snapshots, 16 MiB, 200 per incident) and retention (pruned against the incidents still referenced); playback in the evidence review.
- ✅ **Save schema v7** (`save/`): `force`, `incidents` (jurisdiction, open + closed logs, camera state, pursuit sampler), `conduct` (trust, duty, credibility, commendations, discipline, IA cases, report grades, stats) and `court` (cases, calendar) with a tested v6 → v7 migration (default blocks on the seed's own streams); every older version still migrates; each malformed block is rejected. Snapshot blobs live in IndexedDB under migration-safe keys (`tag:incident:sim:source`), the tag is remembered per save slot. **The schema is frozen after this phase.**
- ✅ **Console**: `law ruleset [id]`, `law explain [incident]`, `law list`, `jurisdiction`, `legal`, `incident list|show|close`, `force test|tool|stats`, `court next|list|advance|attend`, `ia list|show|review|statement`, `trust [district [delta]]`, `career`, `cam mute|dash|status`, `media stats|clear|prune`.
- ✅ **Determinism**: a scripted stop (a speeding car seen before the lights, bodycam on, odor, consent PBT, the driver fights, a TASER application, cuffs, rights, a question in custody, a booking that opens a court case, the call cleared) replays to bit-identical v7 saves; a v7 save made mid-incident continues exactly (force, incidents, conduct, court, CAD, people); a v6 save loads (incidents empty, trust at its baselines) and a stop played on it closes an incident (`test/game/phase5.test.ts`). The legal engine has 270 unit tests driven by the JSON rulesets (suspicion, Terry stop and frisk scope, searches, consent, exigency, Miranda, force and the duty to intervene, pursuit policy, recording, evidence and taint, report grading, a 0.4 ms / 600-event performance test), conduct 112 (trust math, IA triggers, discipline ladder, commendations), the court 183 (cross-examination generation, testimony scoring, motion rulings, verdicts).
- ✅ **End-to-end flows verified in the real game** (`npm run smoke`, real keys and mouse where they exist): **C** cycles to the TASER (HUD chip `TASER 2/2`), a speeding car pulled over with the bodycam on, ID, odor and a consent PBT, the driver steps out and fights, **left mouse** fires the TASER and the HUD shows the verdict, arrest and booking (two cases: a plea and a scheduled hearing), `law explain` with citations, the MDT report form with the statements checklist graded, the Career and Community tabs, **the courtroom answered with Enter / 1** to a verdict, an unlawful frisk and an excessive TASER on a bystander that open an IA case, bodycam snapshots taken from the live canvas, the evidence review with the statement footer, a v7 save and load, the console commands.
- ✅ 3 976 unit and integration tests (344 files) pass under `npm run check`.
- ✅ No third-party assets, no new dependencies; `docs/ASSETS.md` stays empty.

### How to run
```
npm install
npm run dev        # http://localhost:5173
npm run check      # tsc + eslint + vitest (3 976 tests)
npm run build      # production bundle in dist/
npm run smoke      # headless browser test (Phases 0-5) + docs/screenshots/phase1*.png ... phase5*.png
```

### Controls (Phase 5 additions)
| | Keyboard / mouse | Gamepad |
|---|---|---|
| Cycle the force tool (hands, OC spray, baton, TASER, less-lethal launcher, sidearm, K9; only what the armory log, ammo and the scene allow) | C | Start |
| Apply the selected tool along the camera aim | left mouse | RT |
| Intervene when your partner abuses a restrained subject · mute / unmute the bodycam (on foot) | H · J | - |
| Switch the light bar off during a vehicle pursuit: ends the pursuit (the supervisor advises it when it is unjustified) | L | X |
| Career tab (calendar, cases, IA, discipline, reports) · Community tab | MDT, **0** · MDT, right arrow | |
| Courtroom: begin · yes / no / don't recall · previous · submit | Enter · 1 / 2 / 3 · Backspace · Enter | |
| Evidence review: play / pause · 1 s (Shift 10 s) · event · IA statement option | Space · ← → · ↑ ↓ · 1-9 | |

The main menu has a **Jurisdiction** select (generic or strict state law); `law ruleset <id>` switches it in game. Every action can be rebound under *Settings > Controls*.

### Manual test checklist
1. New game, seed `42`. Sign out the pistol and TASER at the armory (or `shift garage`), leave in a patrol car. Press **U** (bodycam on). Light a car (**L**) until it pulls over, talk to the driver (**E**): ID, *Have you had anything to drink*, *consent to a breath test*, *Step out*.
2. Press **C** until the HUD shows `TASER 2/2`, aim at the driver (use `npc spawn flee`/the scene `fight` state or `force tool taser` + an aggressive subject), left mouse: probes attach, the HUD line reads `TASER on assaultive resistance: within policy (GS-8.1)`. Try the same on a compliant bystander: `... excessive (GS-8.1)`.
3. Cuff, read the rights (*Rights* topic), ask a question, book the person at the station (MDT, Reports): the MDT *Career* tab lists the case; `court next` shows the hearing, `court advance <id>` brings it to now, **ATTEND** in the Career tab (or `court attend <id>`) opens the courtroom: **Enter**, answer with **1 / 2 / 3**, **Enter**. The verdict, credibility and trust change (`career`, `trust`).
4. `law explain` lists every determination with its citation; `law ruleset strict` re-judges the open incidents under the strict ruleset. Write the incident report in the MDT: tick the statements of fact (the unsupported ones are marked down) and finalize; the grade shows in the document.
5. Force on someone compliant, or an unlawful frisk, then close the incident (clear the call, or `incident close <key>`): an IA case appears on the Career tab and on the radio; **REVIEW** opens the evidence review (snapshots need the bodycam on and a WebGL canvas), **1-9** give a statement, **Esc** closes it; `ia list`, `career`.
6. **Esc** > *Quick save*, quit, load: incident logs, cases, IA cases, report grades, trust and the camera state are back; a v6 save loads with empty incidents and baseline trust.
7. Console: `jurisdiction`, `incident list`, `force stats`, `cam mute on`, `media stats`.

### Performance
- Node (seed 4242, a whole session, 1200 fixed steps after a 120-step warm-up): 1.07 ms per fixed step for everything (physics, ~130 traffic cars, npc, dispatch, interiors, tactical, the Phase 5 systems). Design budgets (§17): force 0.01 ms (measured 0.0065 ms per step with the registry's own timing overhead), incidents 0.01 ms (0.0032), conduct 0.005 ms (0.0021), court 0.005 ms (0.0020).
- Legal assessment: ~0.4 ms for a 600-event log (CI asserts < 2 ms); the recorder, conduct and court steps read 0.0 ms in the smoke perf overlay (event-driven; per-game-minute work only); the force step is idle-free of allocations.
- Snapshots: one 160x90 `drawImage` + async `toBlob` per 3 sim seconds of recording (~2-4 KiB each), IndexedDB writes off the frame; the HUD additions are DOM writes on change at the 10 Hz HUD rate.
- Headless Chromium with SwiftShader (1280x720, software GL, ~2 fps, so these are draw-call and sim counts, not frame rates): the Phase 5 patrol scene draws in 73 draw calls (140k triangles, the cap is 300); sim cost per frame (5 steps) 3.1 ms across the smoke phases (npc 0.1 ms, scene 0.0 ms); the perf overlay shows `force`, `incidents` and `media` extras next to the Phase 1-4 ones; one bodycam snapshot is ~2 KiB.
- Save size: a v7 save with two logs (22 and 5 events), two cases and one IA case adds a few KiB; the worst case (24 closed logs x 600 events) stays below 1.5 MiB.

### Known limitations
- The legal model is a simplified, generic teaching model, not legal advice; rule citations are invented.
- Report narratives are free text and not parsed; grading uses the statements checklist.
- Snapshots come from the rendered game view (the dashcam is the same view while the officer is in the car); no video or audio is stored; media lives in the browser's IndexedDB and is not part of the save slot (clearing site data loses the footage but not the event log, and the review then says NO VIDEO).
- The courtroom hearing takes place off-clock (no sim time passes) and there is no courthouse building.
- The only fellow officer who can misbehave is the partner placeholder; AI units on scene do not use force.
- Pregnancy and elevated position are derived risk factors (hash / room kind) and are not visible on the figure.
- Pursuits are judged on the officer's own speed and equipment; bystander risk and the fleeing car's driving are not modelled.
- A field contact's log closes when the contact ends: a force application right after closing the dialogue opens a separate ad hoc log (`FI-`), so keep the contact open (or work under a call) when the whole sequence should be one incident.
- A booking made from the MDT away from the station needs the prisoner caged and the officer at the station (Phase 3 rule); the smoke test files its bookings through the CAD document store.
- Under software GL (SwiftShader) the game runs at about 1-5 fps; on a real GPU it runs at the display rate. Headless Chromium never grants pointer lock, so the smoke test switches it off for its one real click.
- Integration fixes outside the integrator's own files: `ContactManager.activeIncident`, `SceneDirector.callOfBuilding`, `IncidentSystem.followCall` (and the playerCall / dash bit re-derivation on restore), `src/incidents/index.ts`, `test/game/phase3.test.ts` (trust is restored before the DUI stop: closing the domestic now moves community trust), `test/game/phase4.test.ts` and `test/game/session.test.ts` (v7 blocks, the new systems).

## Phase 6 — Backup, Tactical, Multi-Agency

Status: ✅ complete. Screenshots (taken by the smoke test): `docs/screenshots/phase6-backup.png` (the Backup panel with an AI officer on cover), `docs/screenshots/phase6-flir.png` (the air unit's FLIR camera) and `docs/screenshots/phase6-command.png` (the command panel at a mass-casualty scene). Design and module contracts: `docs/phase6-design.md`.

### Completed
- ✅ **AI backup officers with personalities, stress, fatigue and loyalty** (`units/personality.ts`, `units/roster.ts`, `data/units/roster.json`): every AI patrol officer and every ranked responder has a procedural name and five traits (aggression, discipline, experience, composure, communication) that are pure functions of the seed and the callsign; `RosterState` keeps stress (events: shots fired, weapon seen, fight, force, pursuit minutes, injury; decays per game minute with composure), fatigue (per hour and per call) and loyalty (covered by the player, abandoned, intervened on), saved in the v8 `roster` block. The dispatcher names its AI units from the roster.
- ✅ **They arrive, take cover, call out and detain** (`backup/`, `data/backup/backup.json`): the AI units on scene of your call get out of their cars (pure FSM `stepOfficerFsm`: exiting, approach, cover / secondary / post / standby, chase, detain, returning, gone), take `coverSpot` positions against the contact, call out weapons, second subjects, runners and hands, chase and cuff runners and hold the command module's posts; the dispatcher keeps the car until the officer is back. **,** opens the Backup panel (select an officer or all; cover, secondary, detain, stand by, regroup, release).
- ✅ **Mistakes under stress, deterministic per seed**: `mistakeChances(traits, stress, fatigue, loyalty)` and `rollMistakes(seed, callsign, arrival, chances)` give late callouts, poor positioning and (rarely) excessive force; a officer who rolls excessive force is the one fellow officer with a misconduct chance of 1 in the Phase 5 force system, so the duty to intervene (H) applies to them; the mistakes are announced (`backup:mistake`) and counted in the roster.
- ✅ **17 requestable unit types + the chain of command** (`data/units/unitTypes.json`, `units/data.ts`, `resources/`): routine / priority backup, officer needs assistance, supervisor, K9, EMS, fire, tow, SWAT, negotiator, air unit, coroner, detectives, crime scene unit, animal control, bomb squad, state patrol, federal (plus lieutenant and chief), each with a vehicle (four new plain-coloured service models: ambulance, fire engine, tow truck, tactical truck), base, turnout, crew, on-scene behaviour, scene services and radio channel. They come from the radio menu (**T**, **4** *Request*, 8 per page, **9** More), the voice grammar ("request a K9 unit", "ambulance to my location"), the MDT *Resources* tab and the console; scene services (K9, EMS, fire, ...) are now answered by real units that drive in and do the scene work on arrival.
- ✅ **Response times from positions, routes, traffic and priority** (`units/eta.ts`, pure, mandatory tests): `estimateResponse` from the route length, the road speed, the call priority (turnout 30-120 s and a speed factor), traffic density and rain; `rankByEta` ranks the nearest candidates (the dispatcher now sends the best of the nearest four); units spawn at their base after the turnout and drive; the live ETA (`resources.eta`) shows on the HUD, the radio acknowledgement ("ETA 3 minutes"), the CAD unit rows and the MDT; the MDT's ETA board (every unit to the selected call) is computed in the sim worker (`eta.matrix`) and never feeds back.
- ✅ **Supervisors**: a sergeant is sent for use of force above a level, an excessive-force verdict and every vehicle pursuit; a lieutenant or chief for a major incident or a disaster (`chainResponse`), and takes command of the post on arrival. In a pursuit the sergeant monitors by `pursuitDecision` and orders termination (`pursuit:order`, recorded by the incident system and shown on the HUD and the radio); ignoring the order is judged.
- ✅ **Pursuits** (`pursuit/`, `data/pursuit/pursuit.json`, traffic additions): AI road driving by the existing flee model; **PIT** classified from the real contact (rear quarter, closing speed, heading, suspect speed) and judged by policy (speed, offense, authorization, vehicle, wet downtown) with a scripted spin-out; **spike strips** dropped ahead by an AI unit (or from your trunk, **;**) deflate tyres (`traffic.deflate`; `burstTire` on your own car) and slow the car until it stops; box-in; rolling roadblock; the **air unit** (helicopter + spotlight, follows the car, FLIR camera on **/**, reveals hidden people); the **perimeter** (4 posts, K9, air) after a foot bail-out; **termination rules** (offense, time limit, lost visual, risk, non-violent offense) and the **jurisdiction handoff** to the state patrol at the city limits. The tactics panel (**;**) lists them with a hint when one is not available.
- ✅ **Incident command and multi-agency scenes** (`command/`, `data/command/*.json`): the command post (levels: none, incident, major, disaster), **START triage** (the player assesses a patient for a few seconds and tags them; every tag is graded; EMS triages and transports the rest with `transportOrder`), traffic control points (`traffic.setBlockades`, staffed by backup officers), evacuation zones (no-go zones for pedestrians), containment (inner posts), fire units extricating and decontaminating, the new `massCasualty` call family (multi-vehicle crash, building collapse, hazmat release); **.** opens the command panel and the MDT *Command* tab shows the board.
- ✅ **Barricades with a negotiator and SWAT**: the negotiator minigame (`negotiationTurn`: stages, trust, agitation, tone; the DialoguePanel) and the SWAT team (`SwatTeam`: four operators stage, stack, breach (a locked door is rammed), clear room by room and hold; plan: entry front / rear, tempo, less-lethal; contact odds from armed / hostage / negotiation trust) driven from the command panel or `swat <command>`.
- ✅ **Save schema v8** (`save/`): `roster`, `resources`, `backup`, `pursuit` and `command` blocks (officer traits' dynamic state, unit slots and queued requests, on-foot officers and the SWAT team, the tracked pursuit and its strips, the command post, victims and tags) with a tested v7 → v8 migration (empty blocks on the seed's own streams; loading adds the 23 resource units to the CAD and rebuilds every profile from the seed); every older version still migrates; each malformed block is rejected; the traffic snapshot gains optional deflation, spin, cap, tracked and blockade fields without a version change. **The schema is frozen after this phase.**
- ✅ **Console**: `units [roster|<type>]`, `request <type>`, `eta <callsign>`, `roster [callsign]`, `stress <callsign> <v>`, `backup list|<type>|<callsign> <command>`, `pursuit spawn|pit|spikes|strip|box|roadblock|air|perimeter|status`, `swat test|stage|stack|breach|clear|hold|withdraw`, `negotiate open|close|<option> [tone]`, `mci start <type>`, `triage list|assess|tag`, `ics post|tcp|evac|contain|needs|down|status`, `flir`.
- ✅ **Determinism**: a stop with backup (an AI officer covers and calls it out) and a K9 driving from the station, a pursuit with a PIT contact, spikes, the air unit, the supervisor's order, the bail-out and the perimeter, and a multi-vehicle crash with the command post, the player's triage tags and EMS triage each replay to bit-identical v8 saves; a save made mid-pursuit continues exactly; a v7 save loads, a pursuit starts on it and a K9 drives to the call (`test/game/phase6.test.ts`). The mandatory unit tests: response-time estimation (`test/units/eta.test.ts`), the backup state machine and the deterministic mistakes (`test/backup`, `test/units/roster.test.ts`), pursuit policy and termination (`test/pursuit`), incident command and triage (`test/command`).
- ✅ **End-to-end flows verified in the real game** (`npm run smoke`, real keys where they exist): **T 4 2** sends priority backup and **T 4 5** a K9 (paged `Request 1/3` menu), the HUD shows the K9's ETA, an AI officer gets out and calls it out (HUD line), **,** opens the Backup panel; `pursuit spawn`, **;** opens the tactics panel and **6** requests the air unit, the sergeant orders the pursuit terminated, AIR-1 arrives and **/** puts the camera on it; a multi-vehicle crash with the command post, **.** (command panel), an assessment and a tag, the MDT Command tab, EMS triaging; a barricade with the negotiator and SWAT on scene, the negotiation dialogue and the SWAT commands; a v8 save / load; the Phase 6 console commands. Zero console errors and zero app warnings.
- ✅ 4 739 unit and integration tests (402 files) pass under `npm run check`.
- ✅ No third-party assets, no new dependencies; `docs/ASSETS.md` stays empty.

### How to run
```
npm install
npm run dev        # http://localhost:5173
npm run check      # tsc + eslint + vitest (4 739 tests)
npm run build      # production bundle in dist/
npm run smoke      # headless browser test (Phases 0-6) + docs/screenshots/phase1*.png ... phase6*.png
```

### Controls (Phase 6 additions)
| | Keyboard / mouse | Gamepad |
|---|---|---|
| Request a unit: radio menu, **4** *Request* (8 types per page, **9** *More*), then the number | T, 4, 1-9 | D-pad left |
| Backup panel (select an officer or all; cover, secondary, detain, stand by, regroup, release) | , | |
| Incident command panel (post, assess / tag a patient, traffic control, evacuate, contain, resources, negotiate, SWAT) | . | |
| Pursuit tactics panel (PIT, spikes ahead, deploy your strip, box-in, roadblock, air unit, perimeter) | ; | |
| Air unit camera (FLIR) while an air unit is overhead | / | |
| MDT *Resources* tab (request any type, units with ETA, the ETA board) · *Command* tab (ICS board) | MDT, right arrow | |
| Voice (push-to-talk, off by default): "request a K9 unit", "send an ambulance", "supervisor to my location" | B (hold) | RB |

All four panel keys can be rebound under *Settings > Controls*. The panels do not pause the game.

### Manual test checklist
1. New game, seed `42`, drive out. Light a car (**L**) until it pulls over, talk to the driver (**E**), then **T 4 2** (priority backup) and **T 4 5** (K9): the HUD shows `K9-1 ETA m:ss`, `eta K9-1` counts down, AI units arrive; one gets out, takes cover and calls it out (HUD line `21 Chapman · COVER`); **,** commands it.
2. `units roster` and `roster 21` list the officers with traits, stress, fatigue, loyalty and mistake chances; `stress 21 0.9` then a new backup call makes late callouts and poor positions likely; the same seed always rolls the same mistakes.
3. `pursuit spawn` (in a patrol car with the lights on): a car runs; a sergeant is sent and monitors; **;** opens the tactics panel (**2** spikes ahead, **6** air unit, **1** PIT when the car is at 20-45 mph beside its rear quarter), the supervisor orders the pursuit terminated when the risk is too high; when the driver bails out **;** > *Perimeter*; AIR-1 arrives after about 3 minutes and **/** puts the camera on it.
4. `mci start multiVehicleCrash`, drive there: the lieutenant and chief come, **.** > *Assess nearest victim* then tag the patient (red / yellow / green / black); *Request recommended resources* brings EMS and fire; the MDT *Command* tab shows the board; EMS tags the rest and transports.
5. `swat test`: a barricade at the nearest building, SWAT requested; `ics post`, `request negotiator`; when they are on scene **.** > *Negotiate* (the dialogue), then *SWAT* > stack, breach, clear.
6. **Esc** > *Quick save*, quit, load: the roster, the units, the pursuit, the command post and the victims are back; a v7 save loads with an empty Phase 6 state and the units at their bases.
7. Console: `units`, `units ems`, `request fire`, `backup list`, `pursuit status`, `ics status`, `triage list`, `flir`.

### Performance
- Node (seed 4242, 1200 fixed steps after a 120-step warm-up, `performance.now` per system): an idle patrol shift costs 0.91 ms per fixed step for everything (physics 0.29, traffic 0.35, npc 0.04, dispatch 0.016); the Phase 6 systems read `resources` 0.0075 ms, `pursuit` 0.0029, `backup` 0.0060, `command` 0.0033. With a pursuit running and a K9, the air unit and a sergeant on the road: 0.62 ms per step in all, `resources` 0.025 ms, `pursuit` 0.033 ms, `backup` 0.008, `command` 0.005. At a mass-casualty incident with a post, units on scene and 12 patients: 0.51 ms per step, `resources` 0.016, `pursuit` 0.016, `backup` 0.006, `command` 0.006. Design budgets (§17): resources 0.03 (met), backup 0.05 (met), command 0.02 (met), pursuit 0.02 (the active pursuit step is 0.03 ms with the registry's own timing overhead, a miss by 0.01 ms for the duration of a chase; idle 0.003).
- Module benchmarks (CI-asserted): 8 officers and 4 SWAT operators clearing a house 0.005 ms per step, an active pursuit 0.003 ms, 15 victims 0.02 ms (far below), 16 traffic blockades +0.02 ms, a roster minute tick below 0.005 ms; steady-state steps allocate nothing (views and panel models are rebuilt on revision only).
- Response estimation routes at most four candidates per request (a few ms, on request steps only); the MDT ETA board (up to 32 routes) runs in the sim worker (~30 ms, the city is generated once per seed there), never feeds back and is dropped when stale.
- Headless Chromium with SwiftShader (1280x720, software GL, ~1 fps, so these are draw-call and sim counts, not frame rates): the Phase 6 scene (a crash scene with figures, service vehicles, the command HUD) draws in 45-48 draw calls (146-154k triangles, the cap is 300); sim cost per frame (5 steps) 3.9-5.4 ms across the smoke phase; the helicopter adds 2 draw calls and one always-present SpotLight, the spike strips 2, the service vehicles 3 per visible new model; the perf overlay shows `resources`, `backup`, `pursuit` and `command` extras.
- Save size: a v8 save adds the roster (29 officers, ~3 KiB), the resource units (23 x ~0.2 KiB), and per-incident officer, victim and command state (a few KiB; the 40 KiB design cap is far from reached).

### Known limitations
- Patrol backup officers stay outdoors (they hold the door); only the SWAT team enters buildings, and the team teleports just inside the entry door at the breach.
- The PIT spin is a scripted traffic animation triggered by a real physics contact: PIT, ramming and box-in are judged by the Phase 6 policy and shown live, but are not part of the Phase 5 legal assessment or the IA triggers. A fleeing car is no longer crashed by any contact; the pursuit module decides.
- The roadblock is an approximation: AI units ahead cap the suspect's speed; there is no formation driving. Jurisdiction is a rectangle (the city limits) and the state unit's resolution after a handoff is a roll, off screen.
- FLIR is a zoomed camera with a grey-scale / contrast CSS filter and a target box, not a thermal render.
- Crews of service vehicles stand by their vehicles; EMS loading is a timer (no stretcher animation); building collapse has no rubble geometry and trapped victims are a flag freed by fire units; the four new service vehicles are plain-coloured boxes with a light bar.
- Units can wait a long time at a signal or in a queue (the Phase 3 traffic model has no queue-jumping for emergency vehicles beyond lane choice), so a distant backup unit may take several minutes; the ETA shown is the estimate at dispatch and the live route length afterwards.
- A save from before Phase 6 keeps the AI units' Phase 2 CAD names; the roster names (backup panel, force verdicts) are generated for them at load.
- A pursuit started while driving hard cannot be reproduced bit-for-bit after a load (the driven car's physics state is restored by Rapier, not replayed); the Phase 6 systems themselves continue exactly (tested with the officer at the roadside).
- Under software GL (SwiftShader) the game runs at about 1-5 fps; on a real GPU it runs at the display rate.
- Integration fixes outside the integrator's own files: `ResourceSystem.leave` closes a call that a patrol unit worked and no unit is left on (a pending call would be offered again), `Dispatcher.closeOwnCall` lets resource units not hold a call open when the player clears it (supervisors and EMS are released with it), `SceneDirector.startPursuitOf` (console and tests), `src/data/records/vehicle.json` (colour names of the four service vehicles), `test/game/*` adapted to v8 (23 resource units in the CAD, the new systems in the step order, `phase5` waits for the sergeant), `test/save/*` for v8.


## Phase 7 — Fleet, Uniforms, Customization

Status: ✅ complete. Screenshots (taken by the smoke test): `docs/screenshots/phase7-character.png` (the character creator in the locker), `docs/screenshots/phase7-livery.png` (the livery editor orbiting the supervisor SUV) and `docs/screenshots/phase7-heli.png` (the patrol helicopter in the air). Design and module contracts: `docs/phase7-design.md`.

### Completed
- ✅ **Character creator** (`ui/character`, `uniform/character.ts`): "Create officer…" on the title screen (new game) and the locker's "Uniform & gear…" row (live 3D preview): first / last name, badge, pronouns (she, he, they or a custom set), height, build, shoulders, hips, skin tone, hair style and colour, rank, uniform class, hat, vest carrier, cold-weather layer, name plate, shoulder patch and badge designers (procedural shapes or a hand-drawn polygon) and the loadout. The pronouns are used in the officer-down and vest radio lines, damage reports and the MDT report header (`applyPronouns`, `data/uniform/lines.json`).
- ✅ **Uniforms on the officer and on AI officers** (`uniform/`, `render/people`): 7 classes (class A, class B, tactical, bike, motor, SWAT, detective), 9 hats, 4 carriers, 4 cold-weather layers, 6 ranks with insignia; `buildOutfit` makes at most 24 accessory boxes drawn in one extra instanced mesh; backup officers, SWAT operators, the partner and the station staff wear deterministic outfits (`aiOutfitSpec(seed, callsign, role, temperature)`); a uniform that breaks a unit's class rule flashes a policy line.
- ✅ **17 generic vehicles** (`data/vehicles`, `vehicles/`): patrol sedan and SUV, supervisor SUV, unmarked sedan, traffic-enforcement sedan (radar: twice the speed-reading range), K9 SUV, motorcycle, bicycle, ATV, SWAT truck, armored rescue vehicle, prisoner van (6 cage seats), command post bus, crime lab van, patrol boat, helicopter and camera drone — handling, cargo, rack slots and patrol extras are data. Cars and the ATV keep the ray-cast vehicle, the bikes add an upright assist and a visual lean, the boat, helicopter and drone are kinematic crafts.
- ✅ **Fleet** (`fleet/`, `game/phase7*.ts`): 17 units with a unit number, livery and vehicle loadout; **'** (or E at the station pump) opens the fleet panel: check out (spawned at the garage exit, the harbor slip or the helipad), return (stored with its wear and damage), customize, service, inspect. P-101 / P-102 are in the lot at the start as before, MAR-1 at the harbor and AIR-2 on the helipad. A boat only lets you out onto the quay, a helicopter only on the ground, the camera drone (**=**, from a trunk that carries one) is flown by the driver input while the officer stands still, with a battery and a 350 m leash.
- ✅ **Livery editor** (`livery/`, `ui/livery`, `render/livery`): a versioned, validated JSON document (`patrol-livery` v1): base paint and finish, wraps (solid, two tone, fade, pinstripe) for the unmarked units, up to 32 layers (stripes, ten procedural shapes including user-drawn polygons, text with the `{unit}` token, checker bands), reflective decals that glow at night, light bar style (roof, hidden, none) and pattern, siren tone, push bar, spotlight, partition and the vehicle loadout; painted on a 1024x512 atlas onto a shell around the vehicle; live preview with an orbit camera on the real vehicle; save to the fleet library (32 documents), export and import as `.json` with schema validation (`livery export` / `livery import` in the console).
- ✅ **Equipment with weight, slots and policy** (`gear/`, `data/gear`): 20 officer items, 10 assignment policies (weight limit, slot capacity, required and forbidden items, minimum holster retention, long-gun limit) and vehicle loadouts validated against the vehicle's cargo. The items are used: naloxone and tourniquet / med kit on overdose and injury calls, ram and Halligan on breaches, K9 treats on K9 sweeps, the evidence kit (the scene kit), the armory's "Sign out my loadout", holster retention (draw time, weapon-grab resistance) and the ballistic vest, which stops rounds fired at the officer (`officerHit`, the `'gear'` stream).
- ✅ **Maintenance** (`vehicles/wear.ts`, `fleet/`): oil (drains with engine work; an empty sump wears the engine), per-wheel tread (distance and slip; worn tyres lose grip, more in the wet), fuel and damage; service at the station (refuel, oil, tyres, repair, all) with a department ledger; **damage reports** for every crash (hits within 5 s merge), **career charges** (points deducted for at-fault damage: less in a pursuit or an emergency run, more for a wreck or unreported damage, bridged to `conduct`), and a **shift-end inspection** checklist (`data/fleet/inspection.json`) followed by End shift and a summary panel. The MDT Career tab shows the fleet's charges.
- ✅ **Save schema v9** (`save/`): `character`, `gear` and `fleet` blocks (units, saved liveries, loadouts, stored condition, incidents, reports, ledger, inspection), optional `wear` / `craft` / `pushBar` on vehicles, `player.mode` `remote`, `extraPrisoners` on equipment; a tested v8 → v9 migration (a legacy character, the default gear, a fleet bound to the saved cars by model); every older version still migrates; each malformed block is rejected.
- ✅ **Console**: `fleet list|checkout <unit>|spawn <type>|checkin|service <kind>|inspect|report <id>|endshift|ledger`, `livery list|apply <id>|export [id]|import '<json>'`, `gear show|validate|preset <id>|retention <1-3>` (alias `loadout`), `uniform <class> [hat] [cold]`, `char show|pronouns <she|he|they>`, `drone`, `wear oil|tread <0..1>`, `hit [m]`.
- ✅ **Determinism** (`test/game/phase7.test.ts`): a custom character, a motorcycle slalom, a patrol-car wall crash with its damage report, station service, a helicopter climb and landing, the drone deployed and recalled, inspection and End shift charging career points replay to bit-identical v9 saves; a save made mid-shift continues exactly; a v8 save loads, checks out the motorcycle and flies the drone. Mandatory unit tests: livery schema and round trip (`test/livery`), loadout validation (`test/gear`), uniform determinism (`test/uniform`), maintenance accounting (`test/fleet`).
- ✅ **End-to-end flows verified in the real game** (`npm run smoke`): Create officer (they/them) → New game, the locker's Uniform & gear (tactical, ball cap), Sign out my loadout, **'** → check out S-201 → Customize (a text decal, a polygon shape, the siren) → Save, export and re-import of the JSON, M-601 ridden, AIR-2 climbed with Space, **=** drone, a crash, the damage report, service, inspection and End shift, a v9 save / load, the Phase 7 console commands. Zero console errors and zero app warnings.
- ✅ No third-party assets, no new dependencies; `docs/ASSETS.md` stays empty.

### How to run
```
npm install
npm run dev        # http://localhost:5173
npm run check      # tsc + eslint + vitest
npm run build      # production bundle in dist/
npm run smoke      # headless browser test (Phases 0-7) + docs/screenshots/phase1*.png ... phase7*.png
```

### Controls (Phase 7 additions)
| | Keyboard / mouse | Gamepad |
|---|---|---|
| Fleet panel (check out / return / customize / service / inspect / end shift) | ' (or E at the station pump) | |
| Deploy / recall the camera drone | = | |
| Climb / descend (helicopter, drone) | Space / Shift | |
| Livery editor: orbit / zoom | drag / wheel | |

The fleet key can be rebound under *Settings > Controls*. The fleet panel does not pause the game; the editors do.

### Manual test checklist
1. Title screen → *Create officer…*: set a name, they/them, sliders, uniform; *Done*, *New game*. `char show` lists the officer.
2. Locker (**E**) → *Uniform & gear…* → tactical + ball cap; the officer figure changes. Armory → *Sign out my loadout*.
3. Go outside, **'**: select S-201 → *Check out*; stand next to it, **'** → S-201 → *Customize…*: add a text decal and a polygon, change the siren, drag to orbit, *Save*; `livery export`, `livery import '<json>' U-301`.
4. `fleet checkout M-601`, ride it (lean in corners); AIR-2 on the helipad: **E**, hold **Space** to climb, **Shift** to descend; try to leave it in the air; land and leave. MAR-1: drive off the slip and try **E** ("Dock first").
5. Next to S-201 press **=**: the drone flies on W / A / S / D and Space / Shift; **=** recalls it.
6. Crash P-101 into a wall, wait 5 s, **'** → *File damage report*; `wear oil 0.1` shows OIL LOW; **'** → *Service…* at the pump; *Inspect* → *End shift*: the summary shows the charge, `fleet ledger` lists it, the MDT Career tab lists the points.
7. Quick save, quit, load: character, gear, liveries, checked-out units and wear are back; a v8 save loads with the legacy character.

### Performance
- Node (seed 42, fixed steps with the four-unit fleet parked): the fleet system costs about 0 ms per idle step (event driven; a request step ≤ 0.2 ms), crafts use the O(1) integrator plus one character-controller query each, wear is a few typed-array operations per vehicle (see the per-system timings in the smoke output below).
- Headless Chromium with SwiftShader (1280x720, software GL, ~1 fps, so these are draw-call and sim counts, not frame rates): measured in the final smoke (Phase 7 on patrol, four-unit fleet, 157 cars): 71 draw calls (cap 300), 178k triangles, sim 4.0 ms for 5 steps (fleet 0 ms, vehicles.pre 0.1 ms, vehicles.post 0 ms, physics 0.2 ms), render submit 1.2 ms, 4 livery shells = 4 draw calls and 60 repaints. Frame breakdown on foot in the day: 2 fps = sim 6.3 ms + update 1.9 ms + render submit 1.4 ms + 500 ms GPU wait (software GL); the livery shells add at most 8 draw calls, the accessory mesh 1, each new vehicle model in view 2-3. Zero console errors and zero app warnings.
- Save size: a v9 save adds the character (~1 KiB), the gear (~1 KiB), the fleet (17 units, a few KiB; 32 custom liveries at most 8 KiB each).

### Known limitations
- Motorcycles and bicycles are four-wheel ray-cast vehicles on a narrow virtual track with an upright assist; the lean is visual; they cannot wheelie or fall over.
- The boat moves on a flat water plane (no waves, buoyancy or wake); the helicopter is an arcade model and collides with buildings only near the officer; the drone has a fixed 20-minute battery (recalled when empty).
- Liveries are canvas decals on a box shell; damage does not bend them; at most 8 shells are drawn. Only the car styles (sedan, hatchback, SUV, pickup, van, truck, bus) get a shell: a solid slab around a bicycle, motorcycle, ATV, boat, helicopter or drone would hide it, so those units show their `VehicleLook` body colour only. Uniform accessories are boxes: the 3D figure shows each emblem's footprint (patch and badge sized by shape, name plate as wide as the surname, colours from the spec), while the artwork (polygon outline, initials, text) is drawn only in the 2D designers.
- Checking a unit in restocks its trunk (the equipment state other than the loadout is not stored); the check-in condition (wear, damage, fuel) is stored.
- The new vehicle archetypes are player-driven only; the AI resource units keep their Phase 6 models. Cuffs, radio and flashlight are policy requirements (validation); the systems that use them do not refuse when they are missing.
- The fleet charges career points; it does not suspend officers for repeated wrecks. The default new-game officer keeps the Phase 1-6 name "Officer Doe" until a character is created or edited.
- Under software GL (SwiftShader) the game runs at about 1-5 fps; on a real GPU it runs at the display rate.
- Integration fixes outside the integrator's own files: `src/data/records/vehicle.json` (colour names), `src/ui/mdt` (`MdtDeps.fleet`, `reportHeader`), `game/target.ts` (radar range), `test/policerender/cockpitParts.test.ts` (the cockpit exists for the car styles), `test/game/*` and `test/save/*` adapted to the four-unit fleet and v9.
