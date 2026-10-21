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
    schema.ts             SaveGame (v10) type, nested validators + CURRENT_SAVE_VERSION
    migrations.ts         ordered migration functions vN -> vN+1
    saveManager.ts        save/load/list/delete slots, autosave, validates & migrates; `peek` reads unvalidated data
    mods.ts               `describeModMismatch`: names the mods a save was made with when they differ from the active ones
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
  world/buildings.ts      BuildingIndex: stable building ids (block * 256 + local), kinds (12), front sides, nearest entrance, station, jail
  interior/               pure interior generator (BSP / corridor / suite templates in data/interior), doors, furniture, hiding spots, spawn and
                          item spots, station points; door-aware pathfinding (nav) and line of sight (los); no THREE, DOM or Rapier
  indoors/                InteriorSystem (residency <= 2 interiors, Rapier wall colliders, doors, lights, enter / exit fades, ambient occupants,
                          nav port for the npc module), occupant planner, InteriorSave
  render/interior/        InteriorRenderer (<= 6 draw calls per visible interior), InteriorLightPool (4 pooled point lights)
  tactical/               TacticalSystem: stance, lean, door slicing, footsteps, room-graph sound propagation to listening NPCs, notice pass (sight,
                          flashlight), partner placeholder; render/tactical FlashlightRig (one SpotLight)
  evidence/               pure rules: hash-chained custody ledger, plain-view / consent / warrant search rules, case file store, dusting, canvass, K9 sweep
  investigation/          InvestigationSystem: markers, photos, plain-view scan, container searches, custody requests, dusting, tape, bodycam,
                          canvass, K9; ui/investigation CameraOverlay, CaseFilePanel, FingerprintPanel, MarkerLabels
  station/                StationState: shift flow (locker, briefing, armory, garage), armory log, locker loadout, holding cells, interview room,
                          roll-call briefing, staff figures; ui/station BriefingScreen
  legal/                  pure legal engine (Phase 5): `Ruleset` JSON (generic + strict), indicator scores (reasonable suspicion, probable cause),
                          `evaluateIncident(log, ruleset)` -> determinations (Terry stop / frisk, search incident to arrest, automobile,
                          consent, exigency, premises entry, Miranda, tests, recording), force verdicts, pursuit policy, evidence
                          admissibility with taint (fruit of the poisonous tree) and `buildReportChoices`; no DOM, THREE or other module
  force/                  ForceSystem: tools (hands, OC, baton, TASER, less-lethal, firearm, K9), hit models, TASER cartridges / probes /
                          cycles / risk factors, fellow-officer misconduct episodes and the duty to intervene; `force.json`
  incidents/              IncidentSystem: the event-stream recorder (bus topics -> `IncidentLog` per incident with camera bits), live force
                          verdicts and pursuit advisories, closing, cached assessments and report choices; `mapping.json`
  conduct/                ConductState: report grading, IA triggers / cases / findings / discipline, commendations, community trust per
                          district (deltas, spill, drift), duty status, credibility
  court/                  CourtState: cases from bookings / citations, pleas, subpoenas, hearing window, cross-examination generation,
                          testimony scoring, motion rulings and verdicts
  recording/              MediaStore (IndexedDB `patrol-media`, memory twin), SnapshotScheduler / `captureSnapshot` (160x90 JPEG), review timeline
  ui/court, ui/ia, ui/review   CourtroomPanel, IA review source / footer, EvidenceReviewPanel (REC / MUTED / DASH strip, scrubber, events)
  units/                  Phase 6: unit types (`unitTypes.json`, 20 types, 23 resource slots), pure response-time estimation (`estimateResponse`,
                          `rankByEta`), officer personalities and mistakes (`officerProfile`, `mistakeChances`, `rollMistakes`), `RosterState`
                          (stress, fatigue, loyalty, counters; profiles are pure functions of seed + callsign)
  resources/              ResourceSystem: specialised unit pools (K9, EMS, fire, tow, SWAT, negotiator, air, coroner, detectives, CSU, animal
                          control, bomb squad, state patrol, federal) and the chain of command (sergeant, lieutenant, chief) as fleet cars
                          with turnout, live ETA, scene services, crews; the air unit's flight, orbit and FLIR reveal
  backup/                 BackupSystem: AI patrol officers on foot (pure FSM: cover / secondary / post / standby, callouts, deterministic mistakes),
                          posts, SWAT team (`SwatTeam`: stage, stack, breach, clear, plan)
  pursuit/                PursuitSystem: contact classification (PIT / ram / bump), policy, risk and the supervisor's termination rules, spike
                          strips, box-in, roadblock, air, foot-bail perimeter, jurisdiction handoff to the state patrol
  command/                CommandSystem: command post, levels, START triage and vitals, EMS transport, traffic control points, evacuation,
                          containment, negotiation minigame
  ui/backup, ui/pursuit, ui/command   pure panel models over `ActionPanel` (backup, pursuit tactics, command / triage / SWAT)
  ui/air, render/air, render/pursuit   FlirOverlay, `airCameraPose`, AirRenderer (helicopter + spotlight), SpikeRenderer
  game/
    phase6.ts             Phase6: constructs resources, pursuit, backup and command over the session's objects (ports), wires the bridges
    phase6Presenter.ts    Phase 6 presentation: backup / pursuit / command panels, negotiation dialogue, FLIR camera, helicopter and strips, HUD
    phase6Commands.ts     units / request / eta / roster / stress / backup / pursuit / swat / negotiate / mci / triage / ics / flir
    phase5.ts             Phase5: constructs force, incidents, conduct and court over the session's objects (ports) and wires the bridges
    phase5Presenter.ts    Phase 5 presentation: snapshot capture and media store, courtroom and review panels, IA flow, HUD additions
    phase5Commands.ts     law / jurisdiction / legal / incident / force / trust / career / ia / court / cam / media
    session.ts            GameSession: one shift in the city (officer, patrol cars and their equipment, colliders, traffic,
                          environment, CAD, records, dispatcher, radio, people, npc, contact, scene), interactions, save/load
    peoplePresenter.ts    Phase 3 presentation: people and props rendering, the officer's figure, dialogue / SFST panels,
                          subtitles and NPC speech, HUD weapon / contact / scene / pursuit feed, people minimap markers
    phase3Commands.ts     call / npc / dialogue / population console commands
    worldView.ts          render side of a session's city (chunk streamer, signal heads, streetlights, minimap)
    phase4Presenter.ts    Phase 4 presentation: interior meshes and lights, flashlight, fade, first-person camera, tactical inputs, briefing,
                          viewfinder, case file, dusting, marker labels, photo thumbnails, HUD additions
    phase4Commands.ts     building / interior / shift / armory / loadout / case / evidence / custody / ledger / k9 / tape / aware / sound / partner
    stationPanels.ts      door and partner panel models
    hudFeed.ts            fills the HUD snapshot from the session at 10 Hz
    policeFeed.ts         Phase 2 presentation: HUD police/unit/call/offer/target/carried lines, minimap markers,
                          in-car MDT screen model, cockpit state, radio menu context (never touches records)
    panels.ts             trunk / equipment / driver-contact panels on one ActionPanel
    target.ts             TargetTracker: the 10 Hz reticle pick for plate runs
    mdtDeps.ts            what the MDT reads from the session; patrolCommands.ts: cad / lookup / lights / radio shortcuts
    commands.ts           Phase 0 console commands; pauseMenu.ts, playerController.ts, sceneLayout.ts, route.ts
  career/ worldstate/ training/ net/ a11y/ mods/     Phase 8 modules (see "Career, persistence and multiplayer" below)
  ui/career/ ui/dispatch/ ui/sandbox/ ui/mods/ ui/coop/   Phase 8 screens (academy, apartment, summary, dispatch console, scenario editor, mod manager, co-op lobby)
  game/phase8.ts          Phase8: career, world, mode (training objects), the hooks and the bridges of design §14
  game/rollover.ts        the pure shift rollover (`rolloverSave`) and `prepareRollover` / `beginRolledShift`
  game/modes.ts           driving course start / leave, sandbox scenario run; game/courseSegments.ts (straight road chains)
  game/coop.ts            CoopSession (client, mirror, presence, intents) and the console port over the room
  game/consolePorts.ts    the dispatch console's port over the local CAD (dispatch-only)
  game/phase8Presenter.ts Phase 8 presentation: screens, hosts, cones, console, editor, mod manager, lobby, HUD feed
  game/phase8Commands.ts  career / world / course / dispatchmode / script / sandbox / scenario / mods / coop (mp)
  server/                 the optional co-op server (Node 22, no dependencies): wsFrames.ts, wsServer.ts, main.ts
  data/                   JSON content: world/, environment/, crime/, vehicles/, physics/, traffic/, records/, cad/,
                          dispatch/, radio/, police/, audio/, people/, calls/, npc/, dialogue/, scene/, interior/, evidence/, tactics/, station/,
                          legal/rulesets, force/, incidents/, conduct/, court/, recording/,
                          units/, backup/, pursuit/, command/
test/                     vitest unit tests, one folder per src module (node environment, no DOM/WebGL)
docs/
  ARCHITECTURE.md         this file
  phase1-design.md        Phase 1 design: data formats and the full module APIs
  phase2-design.md        Phase 2 design (police vehicle, MDT, CAD, radio): data formats, module APIs, topics, save v4
  phase3-design.md        Phase 3 design (people, calls, dialogue, scenes): data formats, module APIs, topics, save v5
  phase4-design.md        Phase 4 design (interiors, tactical movement, evidence and scene work, the station): data formats, module APIs, topics, save v6
  phase5-design.md        Phase 5 design (law, procedure, consequences): legal engine, force, recording, conduct, court, data formats, module APIs, topics, save v7
  phase6-design.md        Phase 6 design (backup, tactical, multi-agency): units, resources, backup, pursuit, command, UI, data formats, module APIs, topics, save v8
  phase8-design.md        Phase 8 design (career, persistent world, training modes, co-op, mods, accessibility), save v10
  MODDING.md, schemas/    the mod bundle format and its JSON schemas
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

Phase 4 adds (design §15):

| Order | System | Work |
|---|---|---|
| -810 | `interiors` | `InteriorSystem.step`: queued requests (enter, exit, door, switch), residency (the officer's building and the nearest entrance within 25 m, <= 2 resident, <= 1 load per step), the 0.3 + 0.3 s door fades -> `interior:moveOfficer`, ambient occupants |
| -690 | `scene` | + calls bind to a building (`BuildingIndex.nearestEntrance` of the call's door spot), people placed in rooms and hiding spots, door locks, knock answers, evidence through `EvidencePort.placeItem` |
| -675 | `investigation` | requests (marker, photo, collect / bag / tag / deposit, search, dust, tape, bodycam, canvass), plain-view scan (2 Hz), K9 sweep, dusting |
| -670 | `station` | shift flow, armory log, loadout, holding cells, interview |
| -640 | `tactical` | stance and lean, door slicing, footsteps, the sound field to the listeners, the notice pass (4 Hz), the partner |

Phase 5 adds (design §15):

| Order | System | Work |
|---|---|---|
| -685 | `force` | requests (cycle / select tool, apply along the camera aim, intervene, fellow test), target search (cone + range), hit models, TASER attachment and cycles, ammo refill on armory sign-out, fellow-officer episodes (4 Hz check) -> `force:applied` / `force:other` / `force:intervened` / `force:tool` / `force:flash` |
| -660 | `incidents` | requests (mute, dash, report, jurisdiction, close), camera bits on every event, pursuit samples (1 Hz) and the supervisor advisory, field-contact closing, at most one assessment per step -> `incident:closed` |
| -658 | `conduct` | queued requests (incident closed, report, IA statement, verdict, trust, reinstate); per game minute: trust drift, suspension end, IA auto-resolve |
| -656 | `court` | queued requests (open, attend, testify, advance); per game minute: reminders and missed hearings; once per game minute `incidents.retain(keysInUse)` |

Phase 6 adds (design §15):

| Order | System | Work |
|---|---|---|
| -700 | `dispatch` | + the unit ranker (`resources.rankPatrol`: nearest 4 ranked by ETA), directed units (pursuit tactics), the on-foot hold (`backup.onFoot`) |
| -698 | `resources` | requests (radio / MDT / scene provider / chain of command), unit FSMs (turnout, en route, on scene, returning, transporting), the air unit's flight, live ETAs (one unit per step), crews (10 Hz) |
| -678 | `pursuit` | contacts (one step late), strips, tactics, follow, supervisor (1 Hz), handoff, foot-bail perimeter (4 Hz) |
| -665 | `backup` | roster minute tick first, then the officers' FSM per step (observations 4 Hz) and the SWAT team |
| -662 | `command` | post, triage, transport, TCPs, evacuation, containment, negotiation (work at 4 Hz); traffic blockades and no-go zones on change |

`GameSession.fixedUpdate` multiplies the walking velocity by `tactical.speedFactor()` (no sprint while crouched) or moves the officer with `tactical.sliceMove` while slicing, and keeps the body's y at `levelY(building) + 0.9`.

Per frame (`App.update`): input -> toggles (Escape: console, then the radio menu, then pause; the MDT and action panels close themselves on Escape) -> mode actions (interact: enter / exit / refuel / trunk / driver contact; camera, headlights, light bar, map zoom, MDT, plate run, siren / tone / pattern / spotlight / equipment panel) -> on-foot look/move or `readDriverInput` and the held horn / manual (stored for the next fixed steps), spotlight aim -> `RadioController` (only while gameplay controls are active) -> `CameraRig` (spotlight aim zeroes the look) -> target pick (10 Hz, `pickTrafficCar` from the camera) -> MDT and action panels -> `EnvironmentRenderer.update` -> `WorldView.update` (chunk streaming at the fog distance, signal heads, streetlights) -> `CarRenderer.update` (+ spotlight target) -> `CockpitRenderer` + `MdtScreen` paint (cockpit view, <= 2 Hz) -> audio (listener from the camera, siren emitters from `PoliceLights`) -> HUD, minimap with markers and the route to the assigned call (10 Hz) -> radio channel strip (4 Hz). Radio lines and captions are written on `radio:start` / `radio:blocked`. Render: `meshes.syncFromEcs`, `renderer.render()`, perf sample (draw calls, triangles, entities, extras `chunks`, `traffic`, `cars`, `dispatch`, `radio`, `audio`, `cockpit`).

Pause rule (`App.refreshPause`): paused while the console `pause` is on or any menu whose `pausesGame !== false` is open. The MDT overlay and the action panels are non-pausing: the world keeps running behind them (`UIRoot` gives their layer the light, blur-free `menu-layer-live` style), gameplay controls are off while they are open (the car coasts). Audio is suspended and speech paused with the game.

### Determinism across sessions
Rapier does not return to a pristine state after bodies are removed, so `App` disposes the physics world and clears the ECS world before every new or loaded session (`createScenePhysics`: gravity, one ground slab of half size `WORLD_HALF_SIZE + 64` and four boundary walls `WORLD_WALL.offset` outside the world edge, which edge chunks draw along with the outer half of the perimeter roads). The session advances `world.time` and its `GameClock` once per fixed step; both are rewound when a session starts and restored from `clock.simTime` on load. The city is rebuilt from the seed (`generateCity` is pure; the app caches the last one). City, colliders, vehicles, traffic and weather depend only on the seed, the input sequence and sim time; every draw comes from a named stream (`'traffic'`, `'vehicle:<slot>'`, `'colors'`, `'world:*'`, `'registry:<id>'`, `'weather'`); worker, streaming and render state never feed back into the simulation. `test/game/session.test.ts` replays a scripted 1200-step shift twice and compares the saves.

Phase 2 keeps the same contract: everything that changes simulation state runs in fixed steps and draws only from named streams (`'dispatch'` with children `'calls'` / `'units'`, `'radio'`, `'traffic'` for fleet cars, `'lights:<slot>'` for light-bar phases; records from `'records:person:<id>'`, `'records:vehicle:<id>'`, `'records:bolo:<day>'` off `createRng(seed)`). Player input from the MDT, the radio menu, voice and keys becomes `UnitRequest`s that the dispatcher queues and applies at the start of its next step; bus handlers only enqueue. TTS / audio timing, the DOM, speech recognition and the 10 Hz target pick never feed back (presentation reads records through pure identities only, so the saved records snapshot is not touched by the HUD). `test/game/session.test.ts` replays a scripted patrol (calls, AI units, a light-bar traffic stop, radio plate run, citation, emergency button) to bit-identical v4 saves and checks that a loaded mid-shift save continues exactly.

Session teardown order (Phase 4): investigation, tactical, contact, scene, npc, interiors, then radio, dispatcher, traffic (fleet cars included), drivable vehicles, colliders, the officer and boxes (`GameSession.dispose`), then the render side (`WorldView.dispose`: streamer, signal heads, streetlights, minimap) and the per-session presentation (MDT overlay, radio log, radio controller, HUD feed), then the physics world is replaced.

### Event bus
```ts
type EventMap = { 'input:action': {...}, 'save:completed': {...}, ... }
bus.on('topic', handler): () => void  // returns unsubscribe
bus.emit('topic', payload)
```
Phase 1 modules add topics by declaration merging in their own `events.ts`: `env:hour`, `env:weather` (environment), `vehicle:damaged`, `vehicle:tireBurst`, `vehicle:engineStalled`, `vehicle:engineFailed`, `vehicle:fuelEmpty` (vehicles), `traffic:spawned`, `traffic:despawned`, `traffic:collision`, `traffic:violation` (traffic), `player:mode`, `camera:mode` (player). Payloads are emitted on rare events only.

Phase 2 topics (design §14): `cad:callCreated`, `cad:callUpdated`, `cad:callClosed`, `cad:unitAssigned`, `cad:unitStatus`, `cad:documentSaved`, `cad:trafficStop` (CadState), `unit:request` (radio, app), `dispatch:offer`, `dispatch:plateResult`, `dispatch:personResult`, `dispatch:backup`, `dispatch:emergency`, `dispatch:statusCheck`, `dispatch:location`, `dispatch:ack`, `dispatch:arrest` (dispatcher; declared in `cad/events.ts`), `traffic:pullingOver`, `traffic:pulledOver`, `traffic:released`, `traffic:fleetArrived` (traffic), `radio:start`, `radio:end`, `radio:blocked`, `radio:channel` (radio). The dispatcher consumes `unit:request`, `traffic:pulledOver` / `released` / `fleetArrived` and `cad:documentSaved`; the radio composer consumes `cad:*`, `dispatch:*` and `traffic:pullingOver`; the session seats the prisoner on `dispatch:arrest`; the app writes the radio log / captions and plays the plate-hit tone.

Phase 5 topics (design §14): `force:applied` / `force:other` / `force:intervened` / `force:tool` / `force:flash` (force), `contact:fact` / `said` / `action` / `miranda` (contact), `scene:command` and the `scene:pursuit` owner / person / end reason (scene), `incident:opened` / `closed` / `forceVerdict` / `advisory` / `report` / `flash` (incidents), `conduct:ia` / `iaResolved` / `report` / `commendation` / `discipline` / `status` / `trust` (conduct), `court:subpoena` / `reminder` / `session` / `verdict` / `flash` (court). `game/phase5.ts` wires them synchronously inside the emitting step: `incident:closed` -> `conduct.request(incidentClosed)`; MDT report submit -> `incidents.request(report)` + `conduct.request(report)` (`Phase5.submitReport`); `cad:documentSaved` (final booking / citation) -> `court.request(open)`; `court:verdict` -> `conduct.request(verdict)`; `conduct:status` -> the player unit out of service / available; `incident:advisory`, `court:subpoena` / `reminder`, `conduct:ia` / `iaResolved` -> radio lines; `incident:forceVerdict`, `incident:flash`, `force:flash`, `court:flash` -> the HUD legal line. The presenter turns `court:session` into the courtroom panel and `force:applied` / arrests into an immediate snapshot.

Phase 4 topics (design §14): `interior:resident` / `moveOfficer` / `transition` / `door` / `switch` / `flash` (indoors), `tactical:sound` / `stance` / `flashlight` / `partner` (tactical), `npc:aware` (npc), `contact:consent` (contact), `investigation:marker` / `photo` / `plainView` / `found` / `collected` / `custody` / `custodyComplete` / `tape` / `canvass` / `k9Alert` / `bodycam` / `print` / `radio` / `flash` (investigation), `station:step` / `armory` / `loadout` / `holding` / `interview` (station), `scene:service`. The session wires them in `GameSession.wireBridges`: `interior:moveOfficer` places the officer body (y = level + 0.9), moves followers and the partner; `interior:door` becomes a tactical sound and a scene door event; `contact:consent` / `contact:event` (statement, custody) feed the case file; `scene:service` k9 arrived starts the K9 sweep; `investigation:*` become scene flags; `npc:aware` reaches the scene; `station:step` onPatrol makes the unit available; `station:holding` seats the prisoner in a cell; `station:interview` moves them to the interview table and opens the contact.

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
The object-store key is the slot; `list()` names rows by key and `load()` repairs a disagreeing `slot` field. `migrateEnvelope(envelope)` applies `migrations[version]` until `CURRENT_SAVE_VERSION` (7), then validates with `isSaveGame`; `save()` validates before writing so a save that would not load is never stored. v2 stores each body's transform, linear/angular velocity and sleep state plus the camera pitch (v1 saves migrate with bodies at rest). v3 (Phase 1) adds `player { mode, vehicle, lastVehicle }` (`lastVehicle` is the last-driven vehicle for refuelling and its parked headlights, -1 for none), `camera.mode`, `vehicles` (each `SerializedVehicle` plus its colour and RNG stream), `traffic` (snapshot or null), `violations` (the observed-violation log, `[vehicleId, counts]` pairs) and `environment` (`timeOffset`, weather override); `lastVehicle` and `violations` are optional (absent in early v3 saves); v2 saves migrate on foot with the patrol cars re-parked and fresh traffic. v4 (Phase 2) adds `cad` (calls: open + the last 200 closed, units with AVL, documents, the traffic stop, counters), `dispatch` (the dispatcher's RNG states, timers, AI unit FSMs, offers, status checks, queued events and requests; null in migrated saves: a fresh roster and fleet start at load), `records` (touched person / registration snapshots, contacts, served warrants, added BOLOs, query log), `radio` (channel, scan list, log, queue with on-air entries, holds, ambient timers, RNG, composer state), `equipment` (one `EquipmentSave` or null per `vehicles` entry), `officerKit` and the optional `speeding` readings (citation prefill); the traffic snapshot stays version 1 with the optional fleet / stop / curb fields. Load order: environment, entities, vehicles and their equipment (+ `PoliceLights`), traffic, CAD, records, dispatcher (or `start` when null), radio. `migrateV3ToV4` fills empty CAD and records, a null dispatcher, the default radio with the seed's `'radio'` stream, null equipment and an empty kit. v5 (Phase 3, frozen) adds `people` (a `PeopleSave`: only the persons the shift touched, as deltas over the deterministic base identity: intoxication, mood, custody, injuries, added/seized items, officer contacts, statements, discovered facts, remembered lies, flags), `npc` (pedestrians, scene actors, occupant overrides and stepped-out seats; null in migrated saves: fresh pedestrians at load), `contacts` (open conversations with the subject's memory, transcript, pending answers and SFST state) and `scenes` (the scenarios of open calls with branch, variants, participants, flags, actions and services, up to 200 graded outcomes, props, pursuits, the officer's weapon and the queued requests and events; it holds hidden truth and is never shown). `migrateV4ToV5` adds empty people and contacts, a null npc and an empty scene block on the seed's `'scene'` stream (loading then gives every open CAD call a scenario with `adoptOpenCalls`). Phase 3 load order: environment, entities, vehicles + equipment, traffic, CAD, records, **people**, dispatcher, **npc**, **scenes** (`restore`, then `adoptOpenCalls`), **contacts**, radio. Loading regenerates the city from the seed. v6 (Phase 4, frozen) adds `interiors` (the officer's building, door states and light overrides that differ from the generated defaults, the pending fade, queued requests, the 'interior' RNG state, ids of the spawned ambient actors), `tactical` (stance, lean, flashlight, partner mode and place, queued sounds, the 'tactical' RNG state), `investigation` (case files with items, markers, photos with their optional 160x90 JPEG thumbnails (at most 32), prints, canvass results, consents, statements and bodycam segments, the hash-chained custody ledger, scene tapes, the K9 sweep, dusting, arrests, queued requests, the 'investigation' RNG state) and `station` (shift flow, armory log, loadout, holding cells, interview, queued requests). `migrateV5ToV6` adds empty blocks on the seed's own streams, a station already on patrol with the duty pistol and the taser signed out, the officer outdoors, and each patrol car's trunk gains the six Phase 4 items (counts from the `patrol` trunk loadout). Interior layouts are never saved: they are pure functions of (seed, building id). Phase 4 load order: environment, entities (the officer at its saved y), vehicles + equipment, traffic, CAD, records, people, dispatcher, **interiors** (the officer's building made resident), npc, **tactical**, scenes (`restore`, `adoptOpenCalls`), contacts, **investigation** (re-sends closed tapes as no-go zones), **station**, radio. v7 (Phase 5, current, frozen without user approval) adds `force` (selected tool, TASER cartridges / attachment / cycles, ammo, the fellow-officer episode, queued requests, the 'force' RNG state), `incidents` (jurisdiction id, the open and at most 24 closed incident logs of at most 600 events each, camera state, pursuit sampler, the assessment queue, queued requests), `conduct` (trust per district, duty status, points, credibility, commendations, discipline, IA cases, report grades, career stats, the 'conduct' RNG state) and `court` (at most 60 cases, the 'court' RNG state, queued requests); assessments and report choices are pure functions of the log and are recomputed on load. `migrateV6ToV7` adds the default force state, an empty generic incident block, baseline trust with an active career and an empty court on the seed's own streams. The snapshot blobs are not part of the save: they live in the IndexedDB database `patrol-media` under the keys `tag:incident:sim:source` (`tag` = one game, remembered per save slot in localStorage). Phase 5 load order: ... investigation, station, **force**, **incidents** (then `followCall` with the player's CAD call), **conduct**, **court**, radio. Tests assert every version from 1..current migrates and that each malformed block is rejected.

### Input
Actions are abstract (`'move.forward'`, `'vehicle.steer'`, `'vehicle.handbrake'`...). Bindings map device inputs → actions. Rebinding UI edits bindings and persists through Settings; new actions appear in it automatically. Phase 5 actions (on foot): `officer.intervene` (H), `officer.bodycamMute` (J); `officer.weapon` (C) now cycles the force tool and `officer.fire` (mouse 0) applies it; switching the light bar off during a vehicle pursuit ends it. Phase 4 actions (design §11.4, shared keys are chosen by context: on foot vs in a car): `officer.crouch` (X), `officer.leanLeft` / `officer.leanRight` (Q / R, held), `officer.slice` (right mouse, held), `officer.flashlight` (F), `officer.bodycam` (U), `investigate.menu` (I), `camera.photo` (O), `partner.menu` (N); V toggles the first-person camera on foot. Phase 3 actions (on foot): `officer.weapon` (C), `officer.fire` (mouse 0, only with a weapon drawn), `officer.tackle` (Space), `officer.shout` (G), `scene.menu` (Y). Phase 2 actions: `vehicle.sirenTone`, `vehicle.horn`, `vehicle.manual`, `vehicle.lightPattern`, `vehicle.spotlight`, `vehicle.spotAim`, `vehicle.equipment`, `mdt.toggle`, `target.runPlate`, `radio.menu`, `radio.option1..9`, `radio.ptt`, `radio.emergency`, `radio.channelPrev`, `radio.channelNext`, `radio.scan` (defaults in `input/bindings.ts`, design §11.5).

### Debug console commands
Phase 0: `help`, `clear`, `echo`, `seed [n]`, `timescale [x]`, `pause`, `save [slot]`, `load [slot]`, `saves`, `perf`, `fps`, `spawn box [n]`, `entities`, `settings get <path> | set <path> <value> | list`, `worker ping`, `debugcam`.
Phase 1: `time [HH:MM]`, `weather [kind [intensity] | auto]`, `tp <x> <z> | <poi kind> | <district>`, `route <poi kind> | <x> <z> | off`, `road`, `car info | refuel | repair | spawn <modelId>`, `traffic stats | list [n] | density <x> | clear`, `plate <ABC 1234>`, `chunks`.
Phase 3: `call spawn <type> [here] [variant...] | list | types [filter]`, `npc spawn <temperament|profile> | info`, `dialogue debug`, `population density <n> | stats` (`game/phase3Commands.ts`); module commands `scene spawn|info|outcomes|flags`, `weapon` (scene), `peds stats|density|clear`, `actors` (npc), `who <id>`, `intox <id> <bac> [drug]` (people), `catalog stats|families|type <id>` (calls), `flee [stop]` (traffic).
Phase 5 (`game/phase5Commands.ts`): `law ruleset [id] | explain [incident] | list`, `jurisdiction [id]`, `legal [incident]`, `incident list | show [key] | close <key>`, `force test | tool <id> | stats`, `trust [district [delta]]`, `career [reinstate]`, `ia list | show | review | statement <id> <n>`, `court list | next | advance <id> | attend <id>`, `cam mute | dash | status`, `media stats | clear | prune`.

Phase 4 (`game/phase4Commands.ts`): `building [id|here|kind]`, `interior info | enter <id|kind> | exit | gen <kind> <seed> | doors | unlock | lights on|off`, `shift [step]`, `armory [out|in <item>]`, `loadout [field]`, `case [callId]`, `evidence list`, `custody <itemId>`, `ledger verify`, `k9 <callId>`, `tape clear`, `aware`, `sound <kind> | debug`, `partner <command>`, and `call spawn <type> building <id>` (binds the call to that building).
Phase 2: `cad call <type> [here] | calls | show <id> | units | clear [disposition] | docs [kind]`, `lookup plate <p> | person <id|last [first]>`, `lights <pattern|on|off|next>`, `radio say [channel] <text> | channel [id] | scan | log [n]` (integrator shortcuts, `game/patrolCommands.ts`); module commands `calls`, `call <id>`, `units`, `docs` (cad), `person`, `runplate`, `vin`, `dl`, `platestates`, `bolos` (records), `dispatch call|backup|emergency|stats|units`, `pullover [release|abandon]`, `fleet` (traffic), `equip`, `pattern`, `siren <tone|off>` (police), `voices`, `sirentest <tone|horn|off>` (audio).

### People and calls (Phase 3)
Persons are never stored: `Population` (`src/people`) generates an `NpcIdentity` for any of the 100 000 Phase 2 person ids from the seed, the id and the Phase 2 record (so CAD and the world never disagree), caches it per game day (LRU 2 048) and keeps deltas only for persons the shift touched (cap 3 000, protected persons are never dropped). `NpcSystem` (`src/npc`) owns structure-of-arrays pools of ambient pedestrians (density by district and hour, LOD ticks), scene actors (a state machine from behaviour profiles: comply, flee, fight, armed, kneel, cuffed, following) and the occupants of cars, with no physics bodies and no ECS entities; `npc.view` is the `HumanoidSource` the `PeopleRenderer` (`src/render/people`: 7 instanced meshes, bone-less limb transforms) draws. The 163-type call catalog (`src/data/calls`, validated by `src/calls`) maps types to 27 families (roles, branches, variants, actions, services, objectives, outcomes); `SceneDirector` (`src/scene`) builds a deterministic `Scenario` per CAD call (imperfect dispatch information, timeline of narrative updates, escalation, false, duplicate, swatting and ambush variants), materializes it when the assigned officer comes within 220 m, runs actions, services and pursuits and grades the clearing as a `CallOutcome`. `ContactManager` (`src/contact`) runs conversations (the pure dialogue engine in `src/dialogue`: tone, topics, comm modes, consent, lies, escalation; the inconsistency engine over the facts the player discovered; PBT, frisk, search and the SFST session), forwards identity claims and arrests to the dispatcher, and cages escorted prisoners. Fixed-step order: dispatch -700, **scene -690**, **contact -680**, radio -650, vehicles.pre 40, traffic 50, **npc 60**, physics 100, vehicles.post 110. The presentation (`game/peoplePresenter.ts`) renders the people and props, opens the dialogue and SFST panels from `contact.active` / `sfstView()` (revision-driven, at most 10 Hz), shows subtitles and speaks English NPC lines, and feeds the HUD (weapon chip, contact chip, scene objectives, pursuit line) and the minimap markers.

### Interiors and scene work (Phase 4)
Every building of the generated city has a stable id (`block * 256 + local`), a kind (`BuildingIndex`, 12 kinds from `data/interior/buildingKinds.json`) and a front side; `generateInterior(seed, building)` is a pure function of (seed, building) that fills one floor from a data-driven template (rooms, walls with door gaps, doors with lock state and strength, box furniture, hiding spots, spawn and item spots, light switches, station points) in about 0.1 ms. The **interior is a below-grade copy of the footprint**: its floor is at y = -40, the officer, NPCs and props keep their x / z inside the footprint (so every Phase 2-3 distance check keeps working) and a `building` id (-1 outdoors) names the level. `InteriorSystem` makes the officer's building and the building whose footprint is nearest within 25 m (back, side and sally-port doors count) resident (wall and door-panel colliders, no floor collider: the body's y is held), runs the 0.3 + 0.3 s fade and teleports the officer through `interior:moveOfficer`; `GameSession` hides the city chunks while the officer is indoors, `InteriorRenderer` draws the resident interior in at most 6 draw calls and `InteriorLightPool` lights the nearest rooms with four pooled point lights.

`TacticalSystem` adds stance (crouch is a toggle, lean and slice are held keys read in the fixed step), a sound model (footsteps by surface and speed, doors, radio chirps, voices) that propagates over the room graph with door attenuation to the NPCs that listen (`npc.listeners` / `stimulate`; reactions come back as `npc:aware`), a notice pass (line of sight and exposure, the flashlight's light stimulus) and the partner placeholder. NPCs navigate interiors through `InteriorSystem.navPort()` (locked doors block, unlocked ones are passed without animating).

Calls bind to buildings: the scene module picks a building near the call's door spot (kind from `data/scene/indoor.json`), places the people in rooms and hiding spots, locks the door, answers knocks and places evidence through the investigation system (`EvidencePort`). `InvestigationSystem` owns the case files: numbered markers, photos (the thumbnail is the only presentation output stored in a save), the plain-view scan, container searches under the lawful-presence rules (`src/evidence/searchRules.ts`: consent, warrant, exigency, protective sweep, incident to arrest, public area; every item records its legal basis), the custody ledger (collect, bag, tag, transfer, deposit; each entry hashes the previous one, `verifyLedger` detects any edit), fingerprint dusting, scene tape that NPCs respect (`npc.setNoGoZones`), the bodycam, the canvass and the K9 stub. The station (`StationState`) turns the shift start into a flow: the officer begins in the locker room (`interiors.placeOfficerInside`), chooses a loadout, attends roll call (`BriefingScreen`), signs out equipment (`ArmoryLog`, which gates the scene's weapons) and leaves through the garage or by entering a patrol car; the unit is out of service until then. Booked prisoners sit in holding cells (`HoldingCells`) and can be brought to the interview room.

Presentation (`game/phase4Presenter.ts`): first-person camera indoors (and V on foot) with the tactical eye offset and lean, the flashlight SpotLight, the fade overlay, marker number labels (10 Hz), the thumbnail captured right after `renderer.render()` in the same task (the drawing buffer is not preserved), the HUD chips (stance, light, noise, visibility, REC, location, shift objective, case line) and the floor plan on the minimap. Panels: door (hold E at a door), locker, armory, interview, partner (N), investigation tools (I), viewfinder (O), case file, fingerprint dusting. The Phase 1-3 tests keep the outdoor scenes with `GameContext.indoorScenes = false`, which also leaves the tactical notice pass off (it draws on the npc streams); the app and the Phase 4 tests run with it on.

### Patrol job (Phase 2)
`CadState` is the single CAD object (calls, units with AVL positions, documents, the traffic-stop context); the `Dispatcher` owns the behaviour (generator, AI unit FSMs that drive traffic fleet cars, offers, backup, emergency, status checks) and its own save block; `RecordsDb` answers plate / VIN / person queries from pure generators plus a saved overlay. The `RadioSystem` composes radio traffic from the bus and schedules it on six channels; `RadioPlayer` (FX + TTS) and the radio panel present it. The MDT (`ui/mdt`) reads `CadState` / `RecordsDb` and sends CAD changes as requests; documents are written to the CAD store directly. Each patrol car has a `PatrolEquipment` (siren, light-bar pattern, spotlight, rack, trunk, cage) that writes the `PoliceLights` store read by the car renderer, the cockpit and the siren audio. The session wires them in the order CAD → records → dispatcher → radio and handles the interactions (trunk, driver contact, MDT reach, arrest → cage → booking at the station).

## Workers
Protocol: `{ id, type, payload }` request/response with transferables where possible (`workers/workerClient.ts`). Main thread never blocks on a worker. The Phase 0 `sim.worker.ts` answers pings and checks the RNG. The chunk worker (`world/render/chunk.worker.ts`) generates its own copy of the city from the seed and returns chunk mesh buffers as transferables; it is render-only, so its timing never touches the simulation. Traffic stays on the main thread because a worker would deliver results with timing jitter and break "same seed + same inputs = same shift".

### Law, procedure and consequences (Phase 5)
**The record.** `IncidentSystem` (`src/incidents`, fixed step -660) listens to the topics the Phase 2-5 owners already emit (`scene:*`, `cad:*`, `dispatch:*`, `traffic:violation`, `contact:fact / said / consent / action / miranda`, `npc:fled / attack`, `investigation:*`, `interior:transition`, `force:*`; `mapping.json` holds the row tables) and appends typed events to one `IncidentLog` per call (field contacts get `FC-` / `FI-` logs that merge into the call's log when a call is attached). Every event carries camera bits (body, muted, dash) and, for indicators (the observations that justify reasonable suspicion or probable cause), the event they came from, so taint can follow the fruit of an unlawful stop or search. Logs are plain JSON, at most 600 events each (pursuit samples, camera and command events are evicted first), 24 closed logs are kept. The recorder draws no random numbers; the only inputs from the session are the ports in `game/phase5.ts` (`callInfo`, `personLabel`, `personRole`, `stopDriver`, `observedViolations`, `itemInfo`, `booking`, `buildingIncident`, `publicPlace`, `officer`, `bodycamWorn`, `dashcam`, `pursuitProbe`, `activeContactIncident`).

**The judge.** `evaluateIncident(log, ruleset)` (`src/legal`, pure, ~0.4 ms for 600 events) replays the log with an `IndicatorBook` (reasonable suspicion and probable cause per person and offense, from the ruleset's indicator table) and returns determinations (lawful / questionable / unlawful with `GS-` / `SS-` rule ids that `citation()` turns into generic citations), evidence rulings (admissible or suppressed with the root of the taint, exceptions: attenuation, independent source, inevitable discovery, good faith), force rulings (the continuum against the subject's resistance, risk factors, the duty to intervene), pursuit rulings and a summary score. Jurisdictions are JSON files in `src/data/legal/rulesets/` (the id is the file stem; `generic` and `strict` ship): the main menu, `law ruleset <id>` and the incident system's `jurisdiction` request swap them and open incidents are re-judged. A closed incident is assessed once (queued, at most one per step) and cached per log version; the UI may also read the assessment of an open incident.

**Use of force.** `ForceSystem` (-685) owns the selected tool and the scene's weapon (`SceneDirector.setWeapon` on every tool change). `apply` finds the target the way the scene's `findActor` does (cone around the aim, tool range), reads the subject's resistance from the NPC module BEFORE any effect (`npc.resistance(id)`: compliant ... lethal, derived from behaviour, weapons and aggression), rolls the tool's hit model from the `force` stream (TASER probe spread and clothing, firearm zones and fatality, less-lethal close-range injury, melee), applies the effect through the NPC module (`incapacitate`, `wound`, `taserCycle`) and the people module (`setInjured`, `setDeceased`) and emits `force:applied` with the resistance, distance, risk factors and cycle count. The recorder judges each application at once (`incident:forceVerdict`: "TASER on assaultive resistance: within policy (GS-8.1)") and again in the assessment. After a restrained, previously violent subject the partner placeholder may start a misconduct episode (`force:other`); `H` within range emits `force:intervened`.

**Consequences.** `ConductState` (-658) takes `incident:closed` with the assessment, grades reports (`gradeReport` against the log's true statements: completeness, contradictions heavier when the bodycam recorded the truth, unsupported claims), opens IA cases from data rules (`ia.json`: excessive force, unlawful doctrine violations, injury after arrest, complaints rolled from trust and aggressive dialogue lines), resolves them from the officer's statement (an untruthful account of on-camera force is sustained) into counselling, reprimand, suspension (the unit goes out of service until it ends), termination, civil suit or criminal charges, grants commendations, and moves community trust per district (`trust.json`: lawful arrests, unlawful stops / searches / force, injuries, convictions, dismissals for misconduct, missed court; a share spills to every district; drift back to the baselines by days). Trust feeds back through `effects(district)`: cooperation in the dialogue (`trustAt`), the scene's dispatch-error scale (tip quality), hostile onlookers at arrests and force, and the call generator's crime factor. `CourtState` (-656) opens a case for every final booking or citation (a plea or a paid citation settles it at once; otherwise a hearing is scheduled on the game clock and a subpoena goes to the radio and the Career tab), generates the cross-examination from the report choices and the log when the officer attends (`generateCrossExam`: yes / no / don't-recall questions whose truth, report line and camera flag are hidden), scores the answers (contradictions with the log, with the report, with themselves; impeachment by the recorded camera), rules on the suppression motions of the assessment and decides the verdict (`convictionChance` from evidence strength, testimony and report grade); credibility, trust and discipline follow through `court:verdict`.

**Recording and review.** The camera bits come from `incidents.cam`; `Phase5Presenter.afterRender` takes a 160x90 JPEG of the live canvas every 3 sim seconds while a camera records and an incident is current (and at once after force or a booking), into `MediaStore` (IndexedDB `patrol-media`, caps 3 000 snapshots / 16 MiB / 200 per incident, pruned every 60 s against the incident keys still in use). `EvidenceReviewPanel` plays an incident back (nearest snapshot, REC / MUTED / DASH strip, event list); the IA flow adds the statement footer, the Career tab's REVIEW button opens it. Snapshots are presentation only: nothing in the simulation reads them.

### Backup, tactical and multi-agency (Phase 6)
**Units and response times.** `src/units` holds the data (`unitTypes.json`: patrol request types plus 17 requestable resource types and the sergeant, lieutenant and chief of the chain of command; `eta.json`, `roster.json`) and the pure logic. `estimateResponse(input)` turns a route length, the road speed, the call priority (turnout 30-120 s and a speed factor by urgency), traffic density and rain into seconds; `rankByEta` orders candidates. The unit selection routes at most four candidates per request with `graph.routeBetweenPoints` on the main thread (the sim must not wait on a worker); live ETAs reuse the traffic system's `routeLeftM`. The MDT's ETA board (every unit to the selected call) is presentation only and runs in the sim worker (`eta.matrix`). Officers have a seeded personality (`officerProfile(seed, callsign, rank)`: name, traits) and `RosterState` keeps stress, fatigue and loyalty (per game minute: stress decays with composure, fatigue grows; events from the other modules move them). `mistakeChances` + `rollMistakes(seed, callsign, arrival, chances)` give late callouts, poor positions and (rarely) excessive force, deterministically per seed and arrival.

**Resources.** `ResourceSystem` (-698) owns 22 ground fleet cars (fleet indices 8..29, shared with the traffic system's fleet pool of 32) and the air unit (no car). A request (radio / voice / MDT / the scene's service provider / the chain of command) picks the first free unit of the type, waits its turnout, spawns the car at its base (station, fire house, hospital, county) and sends it with `setFleetDestination` (emergency lights and siren above a speed), then reports `resource:dispatched / arrived / cleared`; on arrival it tells the scene (`serviceArrived`) so K9, EMS, fire and the others do their scene work for real. Crews stand by their vehicles (`resources.crews`, 10 Hz). `chainResponse` sends a sergeant for use of force above a level, an excessive verdict and every pursuit, a lieutenant for a major incident and a chief for a disaster; the command post holds every unit of its call on scene. The air unit flies a straight line to the call, orbits, follows `setAirTarget`, reveals hidden outdoor actors near its target (FLIR) and goes home after 15 minutes.

**Backup officers.** `BackupSystem` (-665) lets the AI patrol units (and supervisors) on scene of the player's call get out of their cars (`exiting`), walk to the cover position (`coverSpot`: 3-8 m off the contact's axis; a stressed officer may take a poor position), call out what they see (weapon, second subject, runner, hands clear), detain runners, cuff and hold posts for the command module. Their name comes from the roster, and the force system sees them as fellow officers with a per-officer misconduct chance (1 only for the officer who rolled excessive force on this arrival). The player commands them with the Backup panel (`,`).

**Pursuit.** `PursuitSystem` (-678) listens to `scene:pursuit` and `traffic:collision` with `fleeing: true` (a fleeing car is no longer crashed by a contact: the pursuit decides). It classifies the contact with the suspect's pose (`classifyContact`: PIT, ram, bump), judges it against the PIT policy (speed, offense, authorization, vehicle, wet downtown) and applies `spinOut` / `crashCar`; spike strips (dropped ahead by an AI unit or by the player) deflate tyres (`traffic.deflate`, `burstTire` for the player's own car) and cap the speed until the car stops; box-in and the rolling roadblock cap the speed with `setFleeSpeedCap`; the air unit tracks the car (`tracked` flees never lose the player). The supervisor monitors from the moment a sergeant is assigned and orders termination from `pursuitDecision` (offense not allowed, time limit, lost visual, risk, a non-violent offense); `pursuit:order` is also recorded by the incident system. After a foot bail the perimeter (four posts, a K9 and the air unit) goes up; past the city limits the state patrol takes primary (`scene` ends the pursuit as a handoff).

**Command.** `CommandSystem` (-662) opens the post at the scene (on arrival or on request), picks the level (`commandLevel`), runs START triage (`victimVitals` + `startTriage`: the player assesses a victim for a few seconds and tags; every tag is graded against the answer; EMS triages the rest and transports in `transportOrder`), traffic control points (`traffic.setBlockades`, staffed by backup officers), evacuation (a no-go zone merged with the investigation tape zones for `npc.setNoGoZones`), containment (inner posts) and the negotiation minigame (`negotiationTurn`: stages, trust, agitation; the DialoguePanel). Scene flags go through `scene.request({ kind: 'commandFlag' })`. The SWAT team (backup module) stages, stacks, breaches, clears and holds on the command panel's orders; the contact odds (`swatContactOdds`) use armed / hostage / negotiation trust and the plan.

**Integration (`game/phase6.ts`).** Ports are structural: resources get the traffic system as `ResourceTrafficPort`, the scene director as a service provider (`scene.setServiceProvider`), the dispatcher's `openSelfInitiated` / `locate`; the dispatcher gets `setUnitRanker` and `setUnitHold`; the force system gets `mergeFellows`. Bridges: `*:radio` -> `RadioSystem.say` (`current` = the selected channel), `*:flash` and `pursuit:tactic` -> the HUD legal line, `backup:custody` -> `scene.request({ kind: 'custody' })`, `unit:request` of kind `resource` -> `resources.request`. Presentation (`phase6Presenter.ts`): the panels are non-pausing `ActionPanel`s over pure models (`ui/backup`, `ui/pursuit`, `ui/command`), the negotiation uses its own `DialoguePanel`, FLIR swaps the camera rig for `airCameraPose` (fov 25, CSS filter on the canvas, a target box projected with `Vector3.project`), `AirRenderer` (2 meshes + one always-present SpotLight) and `SpikeRenderer` (2 instanced meshes), the PeopleRenderer gains `backup.view` and `resources.crews`.

**Save v8.** `roster`, `resources`, `backup`, `pursuit` and `command` blocks (each with its own RNG stream state, validated by its module); the traffic snapshot gains optional deflation / spin / cap / tracked / blockade fields (version unchanged), the dispatch `UnitFsmSave` an optional `directed`, the scene `ServiceState` an optional `external`. `migrateV7ToV8` writes empty blocks on the seed's own streams; loading adds the resource units to the CAD at their bases and `roster.ensure` rebuilds every profile from the seed. Load order: ... court -> roster -> resources -> backup -> pursuit -> command.

### Fleet, uniforms and customization (Phase 7)
**Vehicles.** 17 data-driven models (`src/data/vehicles/*.json`, `VehicleModel.control` = `car | bike | boat | helicopter | drone`). Cars and the ATV keep the Phase 1 ray-cast vehicle; the motorcycle and bicycle are the same vehicle on a narrow virtual track with an upright-assist torque (visual lean only); the boat, helicopter and drone are kinematic crafts (`stepCraft`, pure, plus a Rapier character controller) with `VehicleEnvironment.isWater / waterY / groundY / anchorX / anchorZ`. `WearState` (oil, per-wheel tread, odometer; worn tyres lose grip) is stepped in `vehicles.post`. The player mode machine gains `remote`: the officer stands still and the driver input flies the drone (`GameSession.controlledVehicle`; `drivenVehicle` stays the car the officer sits in).

**Fleet.** `FleetSystem` (`src/fleet`, fixed step -655, event driven, draws no random numbers) owns 17 units (`fleet.json`): livery id, vehicle loadout, the checked-out vehicle (bound by entity id) or its stored condition, damage incidents (hits within 5 s merge; closed 5 s after the last), damage reports, the maintenance ledger, the last inspection and the queued requests (`service`, `report`, `inspect`, `endShift`, applied at the start of the next step). Accounting (`accounting.ts`) prices services and damage by class and turns an incident into career points (`chargePoints`: less in a pursuit or emergency run, more for a wreck or an unreported incident); `fleet:charge` is bridged to `conduct.request({ kind: 'points' })`. The yard (`fleetYard(city)`, pure) holds up to 20 slots, the garage exit (slot 2), the helipad and the harbor slip.

**Session (`game/phase7.ts`, `session.ts`).** `Phase7` holds the officer's `CharacterProfile`, `OfficerGear`, the `FleetSystem`, the deduplicated `OutfitTable` (the people renderer's accessory table: officer, AI officers by `aiOutfitSpec(seed, callsign, role, temperature)`, the partner and the station staff) and the officer-hit rolls (`npc:attack` kind `fire` within `ballistics.maxRangeM` is queued and resolved in `fixedUpdate` from the `'gear'` stream: miss, vest stopped or wounded with the pronoun-aware radio line and an emergency request). `parkFleet()` replaces the Phase 1-6 `parkPatrolCars`: P-101 and P-102 in yard slots 0 and 1 (as before), MAR-1 at the harbor slip and AIR-2 on the helipad. `spawnUnit` builds a unit's vehicle from its livery (body colour from the wrap or base, `TRIM` bits, tone and pattern, push bar as a build option) and its loadout (`PatrolEquipment` with cage seats, trunk and rack), `checkOut` / `checkIn` / `removeVehicle` move units between the yard and the road (a checked-in unit keeps its wear and damage), `applyUnitLivery` rebuilds a vehicle on the same entity when a build option changed, `toggleDrone` launches the camera drone from the kit or a trunk (2 m ahead at 1.2 m) and recalls it on `=`, an empty battery or 20 s at the end of the 350 m leash. Fleet units draw their random streams by unit id (`vehicle:<unitId>`), so streams stay stable when vehicles come and go. A boat lets the officer out only onto the quay ("Dock first"), a helicopter only below 0.5 m.

**Gear.** `validateOfficerLoadout` / `validateVehicleLoadout` (`src/gear`, pure) check weight, slots, required and forbidden items, holster retention and the long-gun limit against data (`items.json`, `policy.json`, `loadouts.json`). The loadout is used: `kitGrants()` fills the officer kit at shift start (med kit, naloxone, tourniquet, Halligan, ram, K9 treats, the evidence kit), `armoryItems()` feeds "Sign out my loadout", the holster retention is the force system's draw time and grab resistance, the vest comes from `station:loadout`, and K9 treats are consumed by K9 sweeps.

**Livery and uniform.** `src/livery` is pure (versioned JSON schema `patrol-livery` v1 with an error list instead of throwing, canonical export, import with a size limit, polygon shapes, a painter over a `Canvas2DLike` interface); `LiveryRenderer` paints a 1024x512 colour atlas and a reflective emissive atlas onto a thin shell around at most 8 nearby vehicles. `src/uniform` builds an outfit (`buildOutfit`, at most 24 accessory boxes) from a spec of 7 uniform classes, hats, carriers, cold-weather layers, patch, badge, name plate and rank; the people renderer draws the boxes in one extra instanced mesh. The pronoun-aware lines (`lines.json`) are used for the officer-down and vest radio lines, damage reports and the MDT report header.

**Presentation (`game/phase7Presenter.ts`).** Fleet panels (garage, service, inspection, shift summary) are pure models over a non-pausing `ActionPanel` (`'` or E at the station pump); Customize opens the `LiveryEditor` (pausing; the camera orbits the live vehicle through `liveryPreviewPose`, edits are previewed through the spawn-apply path at 10 Hz, cancel restores); the locker's "Uniform & gear" row and the title screen's "Create officer" open the `CharacterCreator`. Each frame the presenter hands new vehicles to the car renderer and new fleet documents to the `LiveryRenderer`.

**Save v9.** `character`, `gear` and `fleet` blocks; `vehicles[i]` may carry `wear`, `craft` and `pushBar`, `player.mode` may be `remote` (the drone's index) and `equipment[i]` `extraPrisoners`. `migrateV8ToV9` writes a legacy character, the default gear and a fleet that binds the saved cars by model. Load order: character -> gear -> fleet (so the vehicles are built from the units' liveries and loadouts) -> vehicles (each bound to its unit) -> ... -> radio.

### Career, persistence and multiplayer (Phase 8)
**Modules.** `src/career` (pure rules: wellbeing, bidding, progression, pay, academy grading; `CareerState` with a request queue), `src/worldstate` (premises, cases, offenders, witnesses, neighborhoods; `WorldState`), `src/training` (modes, the cone course, dispatch scripts and scoring, sandbox scenarios; hooks added to the dispatcher, scene director and force system), `src/net` and `server/` (protocol, `Room` authority, `CoopMirror`, `NetClient`, the Node server with a hand-written RFC 6455 codec), `src/a11y` (palettes, one-handed layouts, flash helpers), `src/mods` (bundle validation, IndexedDB store, boot, loader hooks in the data modules) and the screens in `src/ui/*`. Each owns its data in `src/data/<area>`.

**Boot.** `main.ts` imports only `mods/boot` statically: `bootMods` reads the enabled mods from IndexedDB, resolves the load order, installs the overlay (`setActiveOverlay`) and only then imports `./app`, so every data loader merges the overlay while its module evaluates. A failed app import with mods active sets the safe-mode flag and reloads without them; `?nomods` skips them. Mods therefore apply at page load.

**Session (`game/phase8.ts`).** `Phase8` constructs `CareerState` (stream `career`, fixed step -654), `WorldState` (stream `worldstate`, -653, base crime merged with the mod district table) and the mode block (training objects, step -652: the driving course run follows the driven vehicle, the script runner creates scripted calls). Hooks: `scene.setPersonBias` -> `world.pickPerson` (recidivists and follow-up suspects; no draw while the pool is empty), `dispatcher.setLocationBias` -> `world.pickRepeatLocation`, the dispatcher crime factor = the trust factor x `world.crimeFactor`, `setCategoryWeights` from the specialty, `force.setAccuracyFactor` -> `perf.aimSpread`, steering lag in `GameSession.laggedInput`. Bridges (design §14) enqueue requests only: force, pursuits, IA, commendations, court verdicts, bookings (arrest stat and world arrest), closed calls (premise history, case register, dispatch score), canvass witnesses, reports, trust and fleet charges feed the career stats, stress events and the world; `career:points` goes to the conduct points request and `career:stage` to the officer's rank, uniform class and call mix. With no hooks active Phase 1-7 runs stay bit-identical (the dispatcher, scene and force fixtures are regression tests).

**Rollover (`game/rollover.ts`).** End shift -> `career:shiftSummary` -> summary screen -> apartment -> Report for duty: `prepareRollover` resolves bids when due, ends the off-duty period (`career.reportForDuty`), evolves the world over the gap (`world.evolve`: release, case aging and follow-ups, witness moves, neighborhood drift, trust deltas applied through conduct requests), serializes the session and runs the pure `rolloverSave`: time offset to the next shift start, traffic, pedestrians, dispatcher, scenes, contacts, backup, pursuit, command, resources, interiors, tactical, radio and the station flow reset, open CAD calls closed `handled` with a shift-change note, AI units removed, court hearings in the gap moved to start + 2 h; everything persistent (vehicles, fleet, people, records, investigation, incidents, conduct, court, roster, character, gear, career, world, mode) is kept. The app loads the result into a fresh session (`App.applyRollover`) and `beginRolledShift` starts it in the locker room and opens the follow-up warrant-service calls (`world.bindPerson`).

**Modes.** `ModeSave.id` = freePatrol, career, drivingAcademy, dispatchOnly, sandbox, coop. Career opens the academy hub over the locker room (the driving module runs the cone course on a straight arterial / collector chain >= 320 m near the station: `straightSegments` + `pickCourseSegment`, the `ConeRenderer`, the officer seated in P-101). Dispatch-only turns manual dispatch on (`Dispatcher.setManualDispatch`, `assignUnit`, `createScriptedCall`), runs a `ScriptRunner` and scores with `DispatchTraining`; the console uses `LocalConsolePort`. The sandbox runs `planScenario` operations (environment, call, vehicles, actors, evidence) between steps. Co-op: see below.

**Co-op (`game/coop.ts`).** The lobby connects a `NetClient` and the room's seed starts a new game with mode coop. `CoopSession.update` (once per frame) drains the client: the welcome snapshot and events go through `CoopMirror` into the local CAD (`MirrorPort`: mirrored calls are created with `createScriptedCall`, remote officers are CAD `resource` units whose positions follow presence) and into a plain room copy that the dispatcher / supervisor console reads (`NetConsolePort`); the local officer's status changes, self assignments and clears are sent as intents (`unitStatus`, `callAssign`, `callClose`), presence at 5 Hz, and the host patrol proposes generated calls (`callCreate` origin `generator` with `expectOwn`) only while no dispatcher is in the room. Manual dispatch is on in co-op. The server (`server/wsServer.ts` over `Room`) validates every message (schema, role, state transition, rate, plausibility) and broadcasts events; co-op sessions are not replay-deterministic and are not saved as co-op (a co-op save loads as free patrol).

**Save v10.** `career` (`CareerSave`), `worldState` (`WorldStateSave`), `mode` (`ModeSave`: course run, dispatch script and score, sandbox scenario) and `mods` (`ModRef[]`). `migrateV9ToV10` writes a patrol-officer career from the save's game time, a blank world (both on the seed's own `career` / `worldstate` streams), free patrol and no mods. Load order: ... -> roster -> resources -> backup -> pursuit -> command -> radio -> **career -> world -> mode** (re-applies the dispatcher flags, script runner, course run and scoring). A save whose mods differ from the active ones still loads when it validates (a flash names the difference); one that fails validation reports "This save was made with mods: ...".

**Frame and fixed-step order.** Fixed: ... fleet -655, **career -654, worldstate -653, training -652**, radio -650, ..., vehicles.pre 40 (steering lag in `laggedInput`). Frame: career / co-op / dispatch-console keys, `Phase8Presenter.update` (co-op drain, console refresh at 4 Hz, editor, course finish), HUD career feed at 10 Hz, `setPaletteMode` on settings change. No new worker: `evolve` (<= 5 ms) and the rollover (city regeneration + load, once per shift) run behind a status line.
