# Patrol

## Overview

Patrol is a browser-based, hyper-realistic police patrol simulator. You start a shift in a procedurally generated city:
walk through the station (locker, roll call, armory), take a patrol car, answer dispatched calls, work traffic stops and
scenes with people who have their own identities, temperaments and lies, write reports that are graded against what really
happened, and testify in court. Every action is recorded and judged against a configurable jurisdiction (a generic state
ruleset or a stricter one), with citations. Backup, pursuits, incident command, a fleet of 17 vehicle types with a livery
editor, a career with an academy and promotions, a persistent city that remembers, training modes, mods and optional
co-op multiplayer sit on top.

Everything is **generic and procedural**: no real agencies, badges, logos, liveries, vehicle brands or game assets. The
city, the people, the calls, the textures, the meshes and every sound are generated in code (see [Assets and
licensing](#assets-and-licensing)). The simulation is **deterministic**: the same seed and the same inputs give the same
shift.

Stack: Vite 8, TypeScript 6 (strict), three.js, Rapier (WASM), bitECS, Web Workers, IndexedDB, Web Audio, Web Speech
(optional, degrades gracefully), vitest.

## Requirements

- Node 22.18 or newer and npm 10 (the co-op server runs as TypeScript with Node's built-in type stripping).
- A desktop browser with WebGL 2 and Web Audio. The automated tests run on Chromium; other current browsers with the
  same features should work. Speech output and voice commands (`speechSynthesis`, `SpeechRecognition`) are optional and
  only used where the browser provides them.
- A mid-range desktop GPU for 60 FPS. The game does not need a GPU to be tested: the automated browser tests run under
  software rendering (SwiftShader).
- For `npm run smoke`, `npm run e2e` and `npm run perf`: Playwright at `/opt/node-tools/node_modules/playwright` (falls
  back to a resolvable `playwright` package) and browsers at `$PLAYWRIGHT_BROWSERS_PATH` (default `/opt/pw-browsers`).

## How to run

```
npm install
npm run dev        # dev server at http://localhost:5173
npm run build      # typecheck (app, tooling, server) + production bundle in dist/
npm run preview    # serve dist/ (http://localhost:4173)
npm run server     # the optional co-op server on ws://127.0.0.1:8787 (see Multiplayer)
```

Open the page, click the canvas to lock the pointer and press **Esc** for the pause menu (quick save, settings, quit).
The title screen offers **Guided first shift**, **New career**, **New game** (free patrol, with an optional seed: the same
seed generates the same city and the same shift), **Training**, **Multiplayer**, **Mods** and **Continue**.

Query parameters of the page:

- `?nomods` starts without any enabled mod (nothing is deleted).
- `?e2e` exposes the running app as `window.patrol` in a production build (dev builds always expose it). It exists for the
  automation scripts (`npm run smoke`, `npm run e2e`, `npm run perf`) and is not needed to play.

## Controls

| | Keyboard / mouse | Gamepad |
|---|---|---|
| Move / sprint (on foot) | WASD / Shift | left stick / L3 |
| Look | mouse | right stick |
| Enter / exit vehicle, refuel at a pump | E | A |
| Throttle / brake (hold at a stop to reverse) | W / S (or arrow keys) | RT / LT |
| Steer | A / D | left stick |
| Handbrake (driving) · Tackle (on foot) | Space | B |
| Camera: chase, hood, cockpit | V | View |
| Headlights / light bar · next light pattern | H / L · K | D-pad up / X · - |
| Siren on/off · tone · air horn (hold) · manual (hold) | Q · R · G · F | Y · LB · R3 · - |
| Spotlight · aim it (hold, move the mouse) | J · right mouse button | |
| Equipment panel (gun rack, spotlight, rear seat) | X (in a patrol car) | |
| MDT (non-pausing; Esc closes) | Tab (in a patrol car or at its driver door) | |
| Run the targeted (else the stopped) car's plate | P | D-pad right |
| Trunk / talk to the stopped driver / talk to a person / put a prisoner in the rear seat | E at a patrol car's rear / at the driver window / facing them within 2 m / at a rear door | A |
| Cycle the force tool (hands, OC spray, baton, TASER, less-lethal, sidearm, K9 - what the armory log and ammo allow) · apply it at the camera aim · shout a command (on foot) | C · left mouse · G | Start · RT · - |
| Intervene when your partner abuses a restrained subject (on foot) · mute / unmute the bodycam (on foot) | H · J | - |
| Enter / exit a building, open or close a door, switch lights, use a station point · door panel | E · hold E at a door | A |
| Crouch · lean left / right (hold) · slice a doorway (hold) | X · Q / R · right mouse | R3 · - · LT |
| Flashlight · bodycam · first-person camera outdoors | F · U · V | D-pad up · - · - |
| Investigation tools · evidence camera (shutter Space / Enter) · partner commands | I · O · N | |
| Collect a found item | E at the item | A |
| Scene panel of your call | Y | |
| Dialogue: topic / line / tone / tab / mode / back / close | 1-9 · ←→ · Tab · M · Backspace · Esc | |
| Radio menu · options | T · 1-9 | D-pad left |
| Radio menu cursor: previous / next / choose the highlighted option (while the menu is open) | PageUp · PageDown · Enter | D-pad up · D-pad down · A |
| Radio channel · scan · emergency button (hold 1.2 s) | [ / ] · \ · Z | |
| Push-to-talk voice commands (off by default) | B (hold) | RB |
| Backup panel · incident command (post, triage, SWAT) panel · pursuit tactics panel · air unit camera (FLIR) | , · . · ; · / | |
| Fleet / garage panel (check out any of 17 units, customize its livery, service, inspect, end shift) · deploy / recall the camera drone | ' · = | |
| Climb / descend (helicopter, drone) | Space / Shift | |
| Minimap zoom | M | D-pad down |
| Career screen (the apartment between shifts, the academy before graduation) | - | |
| Co-op panel · dispatch console (dispatch-only mode, co-op dispatcher / supervisor) | 0 · Home | |
| Perf overlay / debug console | F3 / ` | |

Every action can be rebound under *Settings > Controls*. Click the canvas to lock the pointer; **Esc** (gamepad Start)
opens the pause menu.

**Radio menu cursor (Phase 9).** While the radio menu is open a highlighted row follows **PageUp / PageDown** (gamepad
D-pad up / down), **Enter** (gamepad A) sends the highlighted option exactly like pressing its digit, and a digit moves
the cursor onto the option it pressed. The cursor starts on the first enabled option, wraps over the enabled ones and
resets on every level or page change. While the menu is open these keys belong to the cursor; they are free again when it
closes.

**Menus with the keyboard and the gamepad (Phase 9).** Every menu, panel and screen can be used without a mouse. Arrow
keys move the focus (a menu that handles the arrows itself keeps them), **Tab** / **Shift+Tab** step through the controls,
**Enter** / **Space** activate and **Esc** goes back. On a gamepad, while a menu is open: **D-pad / left stick** move the
focus (they repeat when held), **A** activates, **B** goes back, **LB / RB** are Shift+Tab / Tab (tab switching) and
**Start** pauses and resumes. The pad sends real key events, so every menu behaves the same with either device.
Free-text fields (names, notes) need a keyboard; forms keep their prefilled text.

**The tutorial.** *Guided first shift* (title screen) is an interactive walk through the core loop: get in the car, drive,
the light bar, a radio status check, accept a call with the radio (**T**, then **7**), drive to it, handle the scene and
clear it, write the report in the MDT (**Tab**) and make a traffic stop with a plate run (**P**) and a citation or
warning. The prompts name your current keys and complete when you really do the thing (they follow simulation events, not
a script). A card at the bottom of the screen shows the current step; the pause menu has *Skip tutorial step* and *End
tutorial*, and the console command `tutorial [status|skip|end|start]` does the same. Progress is part of the save.

### Console commands

`help` lists everything (open it with `` ` ``). Per phase:

- Career, world and modes (Phase 8): `career [show|set <rank>|stress <0..1>|fatigue <0..1>|shift end|offduty|academy <module|*> <score>|graduate|promote <rank> <score>|assign <unit|patrol|fto>|report]`, `world [premise [address]|cases|offenders|evolve <days>|news]`, `course [list|start <id>|stop]`, `dispatchmode [on|off]`, `script [list|run <id>|stop]`, `sandbox [open|run <id>]`, `scenario [list|load <id>]`, `mods [list]`, `coop|mp [status|connect <url> <room> [role]|disconnect]`.
- Fleet and customization (Phase 7): `fleet list|checkout <unit>|spawn <type>|checkin|service <kind>|inspect|report <id>|endshift|ledger`, `livery list|apply <id>|export [id]|import '<json>'`, `gear show|validate|preset <id>|retention <1-3>` (alias `loadout`), `uniform <class> [hat] [cold]`, `char show|pronouns <she|he|they>`, `drone`, `wear oil|tread <0..1>`, `hit [m]`.
- Backup, tactical and multi-agency (Phase 6): `units [roster|<type>]`, `request <type>`, `eta <callsign>`, `roster [callsign]`, `stress <callsign> <0..1>`, `backup list|<type>|<callsign|all> <command>`, `pursuit spawn|pit|spikes|strip|box|roadblock|air|perimeter|status`, `swat test|stage|stack|breach|clear|hold|withdraw`, `negotiate open|close|<option> [tone]`, `mci start [multiVehicleCrash|buildingCollapse|hazmatRelease]`, `triage list|assess|tag <personId> <red|yellow|green|black>`, `ics post|tcp on|off|evac|contain|needs|down|status`, `flir`.
- Law, procedure and consequences (Phase 5): `law ruleset [generic|strict]`, `law explain [incident]`, `legal`, `jurisdiction [id]`, `incident list|show|close`, `force test|tool <id>|stats`, `trust [district [delta]]`, `career`, `ia list|show|review|statement`, `court list|next|advance|attend`, `cam mute|dash|status`, `media stats|clear|prune`.
- Interiors and scene work (Phase 4): `building [id|here|kind]`, `interior info|enter <id|kind>|exit|gen <kind> <seed>|doors|unlock|lights on|off`, `shift [step]`, `armory [out|in <item>]`, `loadout [field]`, `case [callId]`, `evidence list`, `custody <itemId>`, `ledger verify`, `k9 <callId>`, `tape clear`, `aware`, `sound <kind>|debug`, `partner follow|stack|hold|clear|dismiss|summon`, `call spawn <type> building <id>`.
- Console (`help` lists everything): `time 21:00`, `weather rain|snow|fog|heat|auto`, `timescale 4`, `tp downtown`, `tp hospital`, `tp 1000 -1500`, `route hospital`, `road`, `car info|refuel|repair|spawn van`, `traffic list|stats|density 2|clear`, `plate ABC 1234`, `chunks`, `spawn box 20`, `save`, `load`.
- People and calls (Phase 3): `call spawn <type> [here] [duplicate|false|escalation|...]`, `call list`, `call types <filter>`, `npc spawn calm|timid|irritable|volatile|armed|flee`, `npc info`, `dialogue debug`, `population density 2`, `peds stats`, `actors`, `who <id>`, `intox <id> 0.12`, `scene info|outcomes|flags <id>`, `weapon`, `catalog stats`, `flee`.
- Patrol (Phase 2): `cad call alarm` (`cad call <type> here` at the player), `cad calls`, `cad units`, `cad clear [disposition]`, `lookup plate ABC 1234`, `lookup person 17` / `lookup person smith`, `radio say Testing`, `radio channel tac`, `radio scan`, `siren yelp|wail|phaser|hilo|off`, `lights on|off|next|<pattern>`, `pullover`, `fleet`, `equip`, `dispatch stats`, `bolos`, `docs`.

Save and settings commands: `save [slot]`, `load [slot]`, `saves`, `settings get|set|list`. Phase 9 adds `tutorial
[status|skip|end|start]`, `ambience [district hour weather]`, `uisound <kind>`, `voices` and `sirentest <tone|horn|off>` for the
audio engine. In dev builds, and in any build opened with `?e2e`, the app is exposed as `window.patrol`.

## Game modes

### Guided first shift
The recommended start for a new player (highlighted on the title screen while there are no saves). The shift begins
outside the station and the tutorial card walks you through the core loop (see Controls > The tutorial). It is a normal
shift in the normal city: you can ignore the card and play on, skip a step or end the tutorial at any time.

### Free patrol
**New game** with a seed (blank = random). You start inside the police station's locker room as unit 12 (out of service
until you leave through the garage or get into a patrol car), with two patrol cars in the lot. Dispatch generates calls
from a catalog of 163 types, offers nearby ones to you and sends six AI units (fleet cars) to the rest; the radio log, the
HUD unit chip and the minimap follow the shift. Pick the jurisdiction (generic or strict law) on the title screen.

### Career
**New career** starts in the academy and runs through probation to patrol, specialty units, promotions, pay and shift
bidding, with fatigue, stress and health that affect aim, steering and vision. Between shifts: the shift summary, the
apartment (rest, exercise, family time, a second job) and *Report for duty*. The city remembers: premise history,
recidivists, cold cases and neighborhood crime levels persist across shifts.

### Training
*Academy drills* and *Report writing* (no world), the *Driving academy* (cone course in a patrol car), *Dispatch-only* (you
are the dispatcher; optional scripts `quiet-weekday`, `friday-night`, `multi-alarm` or a mod's, with a live score) and the
*Scenario editor* (place NPCs, vehicles, evidence and a call type on a top-down map, save, export / import as JSON and run
it in the world).

### Co-op
Optional, local network, off by default: up to four patrol units, one dispatcher and one supervisor share a CAD through the
co-op server. See [Multiplayer](#multiplayer).

### Gameplay guide

What each system adds, by phase (the details and manual test checklists are in `docs/PHASES.md`):

- Light bar behind a car pulls it over (a traffic stop with a CAD call); walk to the driver window to talk to the driver (licence, VIN, citation, warning, release, arrest). The MDT (Tab) holds the call queue, call details, the unit roster, the AVL map, person / vehicle queries, BOLOs, reports (incident, citation, booking, evidence) and the stop.
- People: pedestrians walk the sidewalks (denser downtown and by day); calls come from a catalog of 163 types with their own scenes (people appear when you arrive). Walk up to a person and press **E** to talk: a dialogue panel (digits pick a topic, then a line; Tab switches Talk / Actions / Notes; ←/→ set your tone; M changes how you communicate) with ID requests, questions, consent (search, breath test, field sobriety tests), commands and field actions (frisk, search, cuff, escort, release, citation). Statements are kept and inconsistencies show on the Notes tab once you have something to compare. **Y** opens the scene panel of your call (knock, separate parties, request EMS, canvass, write the report, clear). **C** cycles holstered / sidearm / TASER, the left mouse button fires the TASER with it drawn, **Space** tackles, **G** shouts a command. Escort a cuffed prisoner to a patrol car's rear door and press **E** to put them in the rear seat.
- Phase 4, the shift: **E** at the locker (gear), at the roll-call podium (briefing) and at the armory (sign out the pistol and TASER), then leave through the garage door (or walk to a patrol car). Buildings: walk to a door and press **E** to go in (a short fade); a tap at a door acts on release, **holding E** opens the door panel (knock, announce, open, kick, ram from the trunk, lock, canvass a neighbour, enter). Indoors the camera is first person (**V** toggles it outdoors). **X** crouches, **Q** / **R** lean (hold), the right mouse button slices a doorway (hold), **F** is the flashlight, **U** the bodycam, **N** the partner, **I** the investigation tools (marker, photo, collect, bag, tag, search, dust, scene tape, canvass, K9, case file), **O** the evidence camera (Space / Enter takes the photo). Evidence needs the right basis: consent, a warrant, exigency or plain view are recorded on every item; deposit it at the station's evidence room (**E** there) to complete the chain of custody. Book a prisoner and they sit in a holding cell; the interview room brings them to the table.
- Phase 5, law and consequences: everything you do in an incident (observations, lookups, statements, questions, consent, frisks, searches, tests, arrests, force, pursuits, the cameras) is recorded and judged against the **jurisdiction** picked on the title screen (generic state law, or the stricter ruleset) with citations (`law explain`); **C** / left mouse use the force tools (each application is scored at once on the HUD and again in the review), **H** intervenes when your partner abuses a restrained subject, **J** mutes the bodycam. File your report from the MDT: tick the statements of fact you assert (false or unsupported ones count against you; the bodycam record makes contradictions worse) and it is graded. Bookings and citations become court cases: a subpoena puts a hearing on the MDT *Career* tab and the HUD; **attend** it (the courtroom pauses the game: Enter, then 1 yes / 2 no / 3 don't recall) and cross-examination questions are built from your report and the log. Bad stops and searches get evidence suppressed and cases dismissed; excessive force opens an internal-affairs case (review the bodycam timeline, give a statement, face discipline up to suspension, which takes your unit out of service). Community trust per district (MDT *Community* tab) moves with how you police and feeds back into cooperation, tips, hostility and crime.
- Phase 6, backup and multi-agency: the radio menu (**T**, then **4** *Request*, paged 8 per page with 9 *More*) and the MDT *Resources* tab request any of 17 unit types (routine / priority backup, supervisor, K9, EMS, fire, tow, SWAT, negotiator, air unit, coroner, detectives, crime scene unit, animal control, bomb squad, state patrol, federal) with the response time estimated from where the unit is, the route, the traffic and the call priority; the unit drives in from its base and its ETA shows on the HUD, the MDT and the radio. AI backup officers get out at your call, take cover, call out what they see and can make mistakes when stressed or tired (they have names, traits, stress, fatigue and loyalty that persist); **,** commands them (cover, secondary, detain, stand by, regroup, release). A chase starts when a stopped car runs: **;** opens the pursuit tactics (PIT, spike strips ahead or from your trunk, box-in, roadblock, air unit, perimeter after a bail-out); a sergeant monitors it by the policy and orders it terminated when the risk outweighs the offense; the air unit's camera is **/** (FLIR); past the city limits the state patrol takes over. At a mass-casualty incident or a barricade **.** opens incident command: the command post, START triage (assess and tag every patient), traffic control points, evacuation, containment, resource needs, the negotiator minigame and the SWAT team (stage, stack, breach, clear, plan).
- Phase 7, fleet, uniforms and customization: **Create officer** on the title screen (name, badge, pronouns, body, hair, uniform class, hat, vest carrier, cold-weather layer, patch and badge designers, loadout with weight and slot limits) and the locker's *Uniform & gear*. **'** opens the fleet panel: check out any of 17 generic vehicles (patrol sedan and SUV, supervisor, unmarked, traffic, K9, motorcycle, bicycle, ATV, SWAT truck, armored rescue vehicle, prisoner van, command post, crime lab, patrol boat, helicopter, camera drone), *Customize* its livery in the editor (layered stripes, shapes including hand-drawn polygons, text with the unit number, reflective decals, light bar style, siren tone, push bar, spotlight, partition, vehicle loadout; export and import as a JSON file), service it at the station pump, inspect it and end the shift. Tyres and oil wear, crashes become damage reports and career-point charges. **=** launches the camera drone from a trunk that carries one. Loadout items are used: naloxone, tourniquet, Halligan, ram, K9 treats, the evidence kit, holster retention and the ballistic vest.
- Phase 8, career, persistence and multiplayer. The title screen has **New career**, **New game** (free patrol), **Training**, **Multiplayer**, **Mods** and **Continue**.
  - **Career**: a new officer starts in the **academy** (five scored modules: the driving course, the firearms range, defensive tactics, report writing and the legal quiz; pass marks per module) and graduates into **probation** (five shifts with a field training officer's daily observation reports), then **patrol**. Later: the **FTO** assignment (rate a trainee every shift), six **specialty units** (traffic, K9, detective, tactical, narcotics, air) with entry requirements that change the call mix, **promotions** (corporal to captain, with an exam), **pay** (rank, night, specialty, overtime, court) and **seniority-based shift bidding** (day / swing / night x beat against seeded AI officers). Fatigue, stress and health change during the shift and hurt your aim, steering and vision (a vignette); **-** opens the career screen. **End shift** (fleet panel) leads to the **shift summary**, the **apartment** (rest, exercise, family time, a second job; neglect raises stress, no money raises stress) and **Report for duty**, which starts the next shift at its scheduled time in the same save.
  - **A city that remembers**: closed calls build **premise history** per address (shown in the MDT call tab and the dispatch console, repeat addresses draw calls), arrested people are jailed and then released and **recidivate** (later suspects are picked from them, with a flash "Known offender: ..."), cases linger across shifts (MDT *Cases* tab, follow-up warrant calls, going cold), witnesses move house, and each district's crime level drifts with community trust, offenders at large and arrests.
  - **Training modes** (title screen *Training*): academy drills and report writing without a world, the **driving academy** (cone course on a long straight road in P-101), **dispatch-only** (you are the dispatcher: the dispatch console assigns AI units, optional scripts `quiet-weekday`, `friday-night`, `multi-alarm` or a mod's, a live score) and the **scenario editor** (place NPCs, vehicles, evidence and a call type on a top-down map, save, export, import as JSON, and run it in the world; `scenario load <id>`).
  - **Multiplayer** (optional, local network, off by default): run `npm run server` (`node server/main.ts`, no dependencies; configuration by environment variable: `PATROL_SERVER_PORT`, `PATROL_SERVER_HOST`, `PATROL_SERVER_ORIGINS`, `PATROL_SERVER_MAX_ROOMS`, see `server/README.md`), then on each player's title screen choose *Co-op lobby*, enter `ws://localhost:8787`, a room name and a role (up to four **patrol** units, one **dispatcher** and one **supervisor**) and press Connect, then Start. The server is authoritative for the **shared CAD** (calls, assignments, unit status, notes, orders, radio text, positions): it checks every message's schema, role, state transition, rate and plausibility and rejects illegal actions (`coop:flash`). Each client simulates its own world from the room seed. **0** opens the co-op panel (partner up, send a radio line, disconnect), **Home** the dispatch console for the dispatcher and supervisor; the console `coop status|connect <url> <room> [role]|disconnect` (alias `mp`) works too. No TLS or accounts: local use only.
  - **Mods**: *Manage mods* installs a `.json` bundle or a folder with `mod.json` (call types, statutes and rulesets, vehicles, uniform patches, a district table, voice packs, dispatch scripts), validates it against `docs/schemas/*.schema.json` with clear error messages and applies the enabled mods in load order at the next page load (`?nomods` or a failed start switches them off). `examples/mods/night-shift-pack.json` is a ready example; `docs/MODDING.md` documents the format. The save records the active mods.
  - **Accessibility**: colour-blind palettes (protanopia, deuteranopia, tritanopia) for the HUD, maps, console and light bars, one-handed key layouts (left or right hand, *Settings > Accessibility*), every new action rebindable, radio captions, text scale and the reduced-flash setting apply to the new screens.

## Architecture

The long form is `docs/ARCHITECTURE.md` (module layout, contracts, fixed-step order, save versions); the design documents
of each phase carry the data formats and module APIs. In short:

**Module map.** `src/core` (loop, event bus, seeded RNG, clock) and `src/ecs` (bitECS, system registry) are the
foundation; `src/world`, `src/environment`, `src/vehicles`, `src/physics`, `src/traffic` and `src/player` are the city and
driving; `src/records`, `src/cad`, `src/dispatch`, `src/radio` and `src/police` are the patrol job; `src/people`, `src/npc`,
`src/calls`, `src/scene`, `src/dialogue` and `src/contact` are people and calls; `src/interior`, `src/indoors`,
`src/tactical`, `src/evidence`, `src/investigation` and `src/station` are scene work; `src/legal`, `src/force`,
`src/incidents`, `src/conduct`, `src/court` and `src/recording` are law and consequences; `src/units`, `src/resources`,
`src/backup`, `src/pursuit` and `src/command` are multi-agency work; `src/fleet`, `src/gear`, `src/livery` and
`src/uniform` are fleet and customization; `src/career`, `src/worldstate`, `src/training`, `src/net`, `src/mods` and
`src/a11y` are Phase 8; `src/audio`, `src/render/vfx`, `src/tutorial` and `src/debug/profiler.ts` are Phase 9. `src/game`
composes a session (`GameSession`, one module per phase) and `src/app.ts` is the composition root that owns the renderers,
the HUD, the workers and the frame order. Content lives in `src/data/**/*.json` with validators, so adding a call type,
law, vehicle or sound does not need engine changes.

**Fixed step and frame order.** The simulation advances in fixed steps of 1/60 s (`src/core/loop.ts`); rendering runs at
the display rate and interpolates. All simulation work is a registered system with an order number (dispatch -700, scene
-690, force -685, ..., tutorial -651, radio -650, vehicles.pre 40, traffic 50, npc 60, physics 100, vehicles.post 110).
Per frame: input (and gamepad navigation) -> mode actions and driver input -> camera -> environment -> world streaming ->
cars and effects -> audio -> HUD -> render. Systems talk through a typed event bus; presentation never feeds back.

**Determinism.** Every random decision draws from a named stream of a seeded RNG (`src/core/rng.ts`); `Math.random` and
`Date.now` are not used in simulation code. Audio, VFX, UI, navigation and profiling are presentation only. Test suites
replay scripted shifts twice and compare the saves bit for bit.

**Workers.** The chunk worker meshes the city and the sim worker answers RPC and ETA matrices; both are render- or
display-side, so their timing never touches the simulation. Traffic and everything else that is simulation stays on the main
thread in fixed steps.

**Saves.** IndexedDB, versioned envelopes, forward migrations `vN -> vN+1` (`src/save/migrations.ts`) validated on load, so
saves from every older version still load. Version 11 (Phase 9) adds the `tutorial` block (the runner's progress, queue and
pending events, or `null`); version 10 added career, world state, mode and mods. The title screen lists the slots and the
pause menu has *Quick save*.

## Modding

A mod is plain JSON: it adds or tunes call types, statutes and rulesets, vehicles, uniform patches, a district table,
voice packs and dispatch scripts. There is no scripting; every mod is validated at install with clear errors (mod id,
dotted path, message) against `docs/schemas/*.schema.json` and the TypeScript validators, and nothing is accepted
partially. Install a `.json` bundle or a folder with `mod.json` in the title screen's *Manage mods*, enable and order the
mods, and reload: mods apply once, at page load. A failed start with mods active switches them off (safe mode); `?nomods`
starts without them. A save records the active mods and names the difference when they change. See `docs/MODDING.md` for
the format and precedence rules and `examples/mods/` for working examples.

## Multiplayer

Optional and off by default. `npm run server` starts `node server/main.ts` (no dependencies; Node 22.18+) on
`ws://127.0.0.1:8787`; configure it with `PATROL_SERVER_PORT`, `PATROL_SERVER_HOST`, `PATROL_SERVER_ORIGINS` and
`PATROL_SERVER_MAX_ROOMS`. On each player's title screen choose *Co-op lobby...*, enter the address, a room name and a role
and connect. A room has up to **four patrol units** (`N1`..`N4`), one **dispatcher** and one **supervisor**; the server is
authoritative for the shared CAD (calls, assignments, unit status, notes, orders, radio text and positions) and validates
every message (schema, role, state transition, rate, plausibility). Each client simulates its own world from the room seed,
so co-op sessions are not replay-deterministic and are not saved as co-op. Limits: 8 rooms by default, text frames of at
most 64 KiB, silent sockets dropped after 45 s. There is **no TLS and no accounts**: use it on a trusted local network
only. Protocol, limits and the security note are in `server/README.md`.

## Testing

```
npm run check       # typecheck (app, tooling, server) + eslint + the whole vitest suite
npm test            # vitest only (node environment, no DOM or WebGL)
npm run smoke       # headless Chromium smoke test of every phase against the dev server; writes docs/screenshots/*.png
npm run e2e         # headless end-to-end test of the production build (below)
npm run perf        # browser performance and memory profile of the production build -> docs/perf/browser-profile.json
npm run perf:node   # 8-game-hour long shift and memory plateau in Node (PATROL_LONG=1)
npm run test:long   # every test/perf test in its long mode (PATROL_LONG=1)
```

**Where tests live.** `test/<area>/` has one folder per source module (for example `test/legal`, `test/cad`, `test/court`,
`test/audio`, `test/vfx`, `test/tutorial`, `test/perf`); `test/game` holds the integration and determinism tests that
replay whole shifts and compare saves; `test/save` the migrations from every version; `test/ui9` the CSS audit, contrast
and navigation tests. The legal engine and the CAD have audits that check every export, every rule of every ruleset, a
doctrine outcome matrix, seeded property tests and a state-machine fuzz. `scripts/smoke.mjs` drives the dev server through
every phase; `scripts/e2e.mjs` is the release gate.

**The e2e test** (`scripts/e2e.mjs`) builds with `npx vite build` (a `(!)` or `warning` line in the output fails it; skip
the build with `E2E_NO_BUILD=1`), serves `dist/` with `vite preview` on `E2E_PORT` (default 4173), opens `/?e2e` in
Chromium under SwiftShader at 1280x720 and runs the done-when flow in one session: create an officer, start a shift
(seed 4242), customize a patrol car's livery and drive it with the real keys, receive a dispatched call and accept it with
the radio keys, call backup, pull over a speeding car, resolve it (ID, odor, consent breath test, arrest, rights, booking,
call cleared), write and submit the graded report in the MDT, hold the contested court hearing with the real keys until a
verdict, then quick save, quit to title, continue the save and check that the officer, the livery, the closed calls, the
graded report, the verdict and the career stats survived, with zero console errors or warnings. It prints `E2E PASSED`
(exit 0) or the list of failures (exit 1) and takes a few minutes under software GL.

## Performance notes

The target is 60 FPS on a mid-range desktop GPU. Heavy work stays off the frame: meshing runs in a worker, the audio graph
is built once and only has AudioParams written per frame, effects are instanced or run in shaders (at most 6 draw calls
for all of them), DOM updates are throttled (HUD at 10 Hz, panels when their data changes) and hot loops allocate
nothing. The F3 overlay shows frame time, draw calls, the simulation step and the top systems by mean and p95.

| Subsystem | Budget | Measured |
|---|---|---|
| Whole fixed step (Node, idle patrol) | mean <= 1.5 ms, p95 <= 4 ms | mean 0.72 ms, p95 1.25 ms over 8 game hours |
| Audio graph | <= 120 live nodes, <= 0.1 ms per frame | about 0.02 ms per frame |
| VFX | <= 0.3 ms CPU, <= 6 draw calls | |
| Draw calls (whole scene) | <= 300 (target <= 200) | mean 88, max 95 |
| Heap after GC | browser < 25 % growth over a run; Node plateau < 16 MB per hour of game time | +5 % over 4 minutes (browser) |
| Build | `vite build` without warnings; app chunk < 3 MB (the Rapier WASM chunk is separate) | clean |

Method, per-system tables, the hot spots that were fixed and the ones left are in `docs/PERFORMANCE.md`; raw data is in
`docs/perf/`. Browser numbers under SwiftShader measure CPU cost and leaks, not GPU frame time.

## Accessibility

*Settings > Accessibility* and *Controls*:

- **Text size** from 0.8x to 1.6x: all type and the HUD scale with it (rem / em units; a CSS audit test rejects fixed pixel
  font sizes).
- **Colour-blind palettes** (protanopia, deuteranopia, tritanopia) recolour the HUD, the maps, the dispatch console and the
  light bars; the colour pairs are tested for WCAG contrast, and the HUD adds shape cues (marks) next to colour.
- **Reduce flashing lights**: nothing flashes faster than 3 Hz; with the setting on the light-bar glow holds its level, the
  muzzle flash is dimmed and without a light, the TASER arc does not flicker and no UI element animates.
- **Radio captions** show every transmission as text; the radio log works without speech output.
- **One-handed layouts** (left or right hand) remap the keys that need two hands; every action can be rebound, keyboard,
  mouse or gamepad.
- **Keyboard and gamepad navigation** of every menu, with a visible focus ring (see Controls). Sounds have their own
  volumes (master, effects, radio, ambience, interface) and *Effects* (glow, light cones, particles) can be turned off or
  down.

## Assets and licensing

Patrol uses **no third-party assets**: no models, textures, fonts, images or audio files. All sounds are synthesized at
run time (sirens, engines, tires, ambience, radio effects and chatter, interface sounds), all textures are generated on
canvases (windows, livery atlases) or are flat colours, and all meshes are built from code. There is no real agency, badge,
logo, livery, vehicle brand or content from any other game. `docs/ASSETS.md` lists the procedural content and the rules,
and any future third-party asset must be listed there before it is committed. The code and data in this repository are the
project's own.

## Docs

- `docs/ARCHITECTURE.md` - module layout, contracts, step order, save versions
- `docs/phase1-design.md` - Phase 1 (world and driving)
- `docs/phase2-design.md` - Phase 2 (police vehicle, MDT, CAD, radio)
- `docs/phase3-design.md` - Phase 3 (people, calls, dialogue, scenes)
- `docs/phase4-design.md` - Phase 4 (interiors, tactical movement, evidence and scene work, the station)
- `docs/phase5-design.md` - Phase 5 (law, procedure, consequences: legal engine, use of force, recording, conduct, court)
- `docs/phase6-design.md` - Phase 6 (backup, tactical, multi-agency: units, resources, pursuit, incident command)
- `docs/phase7-design.md` - Phase 7 (fleet, uniforms, customization: vehicles and crafts, livery, gear, maintenance)
- `docs/phase8-design.md` - Phase 8 (career, persistent world, training modes, co-op multiplayer, mods, accessibility)
- `docs/phase9-design.md` - Phase 9 (polish and release: audio, VFX, UI pass, tutorial, performance, e2e)
- `docs/PERFORMANCE.md` - profiler, long-shift and memory results, hot spots, how to run the profiles
- `docs/MODDING.md` - the mod bundle format, precedence rules and schemas (`docs/schemas/`); `examples/mods/` has working examples
- `server/README.md` - the co-op server: protocol, limits and configuration
- `docs/ASSETS.md` - asset licensing and the procedural content rules
- `docs/PHASES.md` - per-phase log with manual test checklists and known limitations
- `docs/research/` - verified API notes for the pinned libraries
