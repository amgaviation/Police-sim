# Patrol

Browser-based police patrol simulator: Vite + TypeScript, three.js, Rapier (WASM), bitECS, Web Workers, IndexedDB.

## Requirements
Node 22.13+ and npm 10.

## Scripts
```
npm install
npm run dev        # dev server at http://localhost:5173
npm run build      # typecheck + production bundle in dist/
npm run preview    # serve dist/
npm run check      # typecheck + eslint + vitest
npm run test       # vitest only
npm run smoke      # headless Chromium smoke test (Phases 0-4); writes docs/screenshots/phase1.png, phase1-night.png,
                   # phase2.png (cockpit with the in-car MDT), phase2-mdt.png (MDT overlay), phase3.png (a call scene
                   # with people), phase3-dialogue.png (the dialogue panel), phase4.png (an interior with the flashlight
                   # and markers), phase4-station.png (roll call) and phase4-case.png (the case file)
```

`npm run smoke` expects Playwright at `/opt/node-tools/node_modules/playwright` (falls back to a resolvable `playwright` package) and browsers at `$PLAYWRIGHT_BROWSERS_PATH` (default `/opt/pw-browsers`).

## In-game
- **New game** with a seed (blank = random); the same seed generates the same city and the same shift. You start inside the police station's locker room as unit 12 (out of service until you leave through the garage or get into a patrol car), with two patrol cars in the lot. Dispatch generates calls, offers nearby ones to you and sends six AI units (fleet cars) to the rest; the radio log, the HUD unit chip and the minimap follow the shift.
- Light bar behind a car pulls it over (a traffic stop with a CAD call); walk to the driver window to talk to the driver (licence, VIN, citation, warning, release, arrest). The MDT (Tab) holds the call queue, call details, the unit roster, the AVL map, person / vehicle queries, BOLOs, reports (incident, citation, booking, evidence) and the stop.
- People: pedestrians walk the sidewalks (denser downtown and by day); calls come from a catalog of 163 types with their own scenes (people appear when you arrive). Walk up to a person and press **E** to talk: a dialogue panel (digits pick a topic, then a line; Tab switches Talk / Actions / Notes; ←/→ set your tone; M changes how you communicate) with ID requests, questions, consent (search, breath test, field sobriety tests), commands and field actions (frisk, search, cuff, escort, release, citation). Statements are kept and inconsistencies show on the Notes tab once you have something to compare. **Y** opens the scene panel of your call (knock, separate parties, request EMS, canvass, write the report, clear). **C** cycles holstered / sidearm / TASER, the left mouse button fires the TASER with it drawn, **Space** tackles, **G** shouts a command. Escort a cuffed prisoner to a patrol car's rear door and press **E** to put them in the rear seat.
- Phase 4, the shift: **E** at the locker (gear), at the roll-call podium (briefing) and at the armory (sign out the pistol and TASER), then leave through the garage door (or walk to a patrol car). Buildings: walk to a door and press **E** to go in (a short fade); a tap at a door acts on release, **holding E** opens the door panel (knock, announce, open, kick, ram from the trunk, lock, canvass a neighbour, enter). Indoors the camera is first person (**V** toggles it outdoors). **X** crouches, **Q** / **R** lean (hold), the right mouse button slices a doorway (hold), **F** is the flashlight, **U** the bodycam, **N** the partner, **I** the investigation tools (marker, photo, collect, bag, tag, search, dust, scene tape, canvass, K9, case file), **O** the evidence camera (Space / Enter takes the photo). Evidence needs the right basis: consent, a warrant, exigency or plain view are recorded on every item; deposit it at the station's evidence room (**E** there) to complete the chain of custody. Book a prisoner and they sit in a holding cell; the interview room brings them to the table.
- Phase 5, law and consequences: everything you do in an incident (observations, lookups, statements, questions, consent, frisks, searches, tests, arrests, force, pursuits, the cameras) is recorded and judged against the **jurisdiction** picked on the title screen (generic state law, or the stricter ruleset) with citations (`law explain`); **C** / left mouse use the force tools (each application is scored at once on the HUD and again in the review), **H** intervenes when your partner abuses a restrained subject, **J** mutes the bodycam. File your report from the MDT: tick the statements of fact you assert (false or unsupported ones count against you; the bodycam record makes contradictions worse) and it is graded. Bookings and citations become court cases: a subpoena puts a hearing on the MDT *Career* tab and the HUD; **attend** it (the courtroom pauses the game: Enter, then 1 yes / 2 no / 3 don't recall) and cross-examination questions are built from your report and the log. Bad stops and searches get evidence suppressed and cases dismissed; excessive force opens an internal-affairs case (review the bodycam timeline, give a statement, face discipline up to suspension, which takes your unit out of service). Community trust per district (MDT *Community* tab) moves with how you police and feeds back into cooperation, tips, hostility and crime.
- Phase 6, backup and multi-agency: the radio menu (**T**, then **4** *Request*, paged 8 per page with 9 *More*) and the MDT *Resources* tab request any of 17 unit types (routine / priority backup, supervisor, K9, EMS, fire, tow, SWAT, negotiator, air unit, coroner, detectives, crime scene unit, animal control, bomb squad, state patrol, federal) with the response time estimated from where the unit is, the route, the traffic and the call priority; the unit drives in from its base and its ETA shows on the HUD, the MDT and the radio. AI backup officers get out at your call, take cover, call out what they see and can make mistakes when stressed or tired (they have names, traits, stress, fatigue and loyalty that persist); **,** commands them (cover, secondary, detain, stand by, regroup, release). A chase starts when a stopped car runs: **;** opens the pursuit tactics (PIT, spike strips ahead or from your trunk, box-in, roadblock, air unit, perimeter after a bail-out); a sergeant monitors it by the policy and orders it terminated when the risk outweighs the offense; the air unit's camera is **/** (FLIR); past the city limits the state patrol takes over. At a mass-casualty incident or a barricade **.** opens incident command: the command post, START triage (assess and tag every patient), traffic control points, evacuation, containment, resource needs, the negotiator minigame and the SWAT team (stage, stack, breach, clear, plan).
- Click the canvas to lock the pointer; **Esc** opens the pause menu (quick save, settings, quit).

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
| Radio channel · scan · emergency button (hold 1.2 s) | [ / ] · \ · Z | |
| Push-to-talk voice commands (off by default) | B (hold) | RB |
| Backup panel · incident command (post, triage, SWAT) panel · pursuit tactics panel · air unit camera (FLIR) | , · . · ; · / | |
| Minimap zoom | M | D-pad down |
| Perf overlay / debug console | F3 / ` | |

Every action can be rebound under *Settings > Controls*.

Backup, tactical and multi-agency (Phase 6): `units [roster|<type>]`, `request <type>`, `eta <callsign>`, `roster [callsign]`, `stress <callsign> <0..1>`, `backup list|<type>|<callsign|all> <command>`, `pursuit spawn|pit|spikes|strip|box|roadblock|air|perimeter|status`, `swat test|stage|stack|breach|clear|hold|withdraw`, `negotiate open|close|<option> [tone]`, `mci start [multiVehicleCrash|buildingCollapse|hazmatRelease]`, `triage list|assess|tag <personId> <red|yellow|green|black>`, `ics post|tcp on|off|evac|contain|needs|down|status`, `flir`.
Law, procedure and consequences (Phase 5): `law ruleset [generic|strict]`, `law explain [incident]`, `legal`, `jurisdiction [id]`, `incident list|show|close`, `force test|tool <id>|stats`, `trust [district [delta]]`, `career`, `ia list|show|review|statement`, `court list|next|advance|attend`, `cam mute|dash|status`, `media stats|clear|prune`.
Interiors and scene work (Phase 4): `building [id|here|kind]`, `interior info|enter <id|kind>|exit|gen <kind> <seed>|doors|unlock|lights on|off`, `shift [step]`, `armory [out|in <item>]`, `loadout [field]`, `case [callId]`, `evidence list`, `custody <itemId>`, `ledger verify`, `k9 <callId>`, `tape clear`, `aware`, `sound <kind>|debug`, `partner follow|stack|hold|clear|dismiss|summon`, `call spawn <type> building <id>`.
Console (`help` lists everything): `time 21:00`, `weather rain|snow|fog|heat|auto`, `timescale 4`, `tp downtown`, `tp hospital`, `tp 1000 -1500`, `route hospital`, `road`, `car info|refuel|repair|spawn van`, `traffic list|stats|density 2|clear`, `plate ABC 1234`, `chunks`, `spawn box 20`, `save`, `load`.
People and calls (Phase 3): `call spawn <type> [here] [duplicate|false|escalation|...]`, `call list`, `call types <filter>`, `npc spawn calm|timid|irritable|volatile|armed|flee`, `npc info`, `dialogue debug`, `population density 2`, `peds stats`, `actors`, `who <id>`, `intox <id> 0.12`, `scene info|outcomes|flags <id>`, `weapon`, `catalog stats`, `flee`.
Patrol (Phase 2): `cad call alarm` (`cad call <type> here` at the player), `cad calls`, `cad units`, `cad clear [disposition]`, `lookup plate ABC 1234`, `lookup person 17` / `lookup person smith`, `radio say Testing`, `radio channel tac`, `radio scan`, `siren yelp|wail|phaser|hilo|off`, `lights on|off|next|<pattern>`, `pullover`, `fleet`, `equip`, `dispatch stats`, `bolos`, `docs`.

In dev builds the app is exposed as `window.patrol`.

## Docs
- `docs/ARCHITECTURE.md` — module layout and contracts
- `docs/phase1-design.md` — Phase 1 (world and driving) design and module APIs
- `docs/phase2-design.md` — Phase 2 (police vehicle, MDT, CAD, radio) design and module APIs
- `docs/phase3-design.md` — Phase 3 (people, calls, dialogue, scenes) design and module APIs
- `docs/phase4-design.md` — Phase 4 (interiors, tactical movement, evidence and scene work, the station) design and module APIs
- `docs/phase5-design.md` — Phase 5 (law, procedure, consequences: legal engine, use of force, recording, conduct, court) design and module APIs
- `docs/phase6-design.md` — Phase 6 (backup, tactical, multi-agency: units and response times, resources, backup and SWAT, pursuit, incident command) design and module APIs
- `docs/PHASES.md` — per-phase log with manual test checklists and known limitations
- `docs/research/` — verified API notes for the pinned libraries
