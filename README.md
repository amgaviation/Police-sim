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
npm run smoke      # headless Chromium smoke test (Phases 0-3); writes docs/screenshots/phase1.png, phase1-night.png,
                   # phase2.png (cockpit with the in-car MDT), phase2-mdt.png (MDT overlay), phase3.png (a call scene
                   # with people) and phase3-dialogue.png (the dialogue panel)
```

`npm run smoke` expects Playwright at `/opt/node-tools/node_modules/playwright` (falls back to a resolvable `playwright` package) and browsers at `$PLAYWRIGHT_BROWSERS_PATH` (default `/opt/pw-browsers`).

## In-game
- **New game** with a seed (blank = random); the same seed generates the same city and the same shift. You start on foot at the police station door as unit 12, with two patrol cars in the lot. Dispatch generates calls, offers nearby ones to you and sends six AI units (fleet cars) to the rest; the radio log, the HUD unit chip and the minimap follow the shift.
- Light bar behind a car pulls it over (a traffic stop with a CAD call); walk to the driver window to talk to the driver (licence, VIN, citation, warning, release, arrest). The MDT (Tab) holds the call queue, call details, the unit roster, the AVL map, person / vehicle queries, BOLOs, reports (incident, citation, booking, evidence) and the stop.
- People: pedestrians walk the sidewalks (denser downtown and by day); calls come from a catalog of 163 types with their own scenes (people appear when you arrive). Walk up to a person and press **E** to talk: a dialogue panel (digits pick a topic, then a line; Tab switches Talk / Actions / Notes; ←/→ set your tone; M changes how you communicate) with ID requests, questions, consent (search, breath test, field sobriety tests), commands and field actions (frisk, search, cuff, escort, release, citation). Statements are kept and inconsistencies show on the Notes tab once you have something to compare. **Y** opens the scene panel of your call (knock, separate parties, request EMS, canvass, write the report, clear). **C** cycles holstered / sidearm / TASER, the left mouse button fires the TASER with it drawn, **Space** tackles, **G** shouts a command. Escort a cuffed prisoner to a patrol car's rear door and press **E** to put them in the rear seat.
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
| Cycle weapon · fire TASER (weapon drawn) · shout a command (on foot) | C · left mouse · G | Start · RT · - |
| Scene panel of your call | Y | |
| Dialogue: topic / line / tone / tab / mode / back / close | 1-9 · ←→ · Tab · M · Backspace · Esc | |
| Radio menu · options | T · 1-9 | D-pad left |
| Radio channel · scan · emergency button (hold 1.2 s) | [ / ] · \ · Z | |
| Push-to-talk voice commands (off by default) | B (hold) | RB |
| Minimap zoom | M | D-pad down |
| Perf overlay / debug console | F3 / ` | |

Every action can be rebound under *Settings > Controls*.

Console (`help` lists everything): `time 21:00`, `weather rain|snow|fog|heat|auto`, `timescale 4`, `tp downtown`, `tp hospital`, `tp 1000 -1500`, `route hospital`, `road`, `car info|refuel|repair|spawn van`, `traffic list|stats|density 2|clear`, `plate ABC 1234`, `chunks`, `spawn box 20`, `save`, `load`.
People and calls (Phase 3): `call spawn <type> [here] [duplicate|false|escalation|...]`, `call list`, `call types <filter>`, `npc spawn calm|timid|irritable|volatile|armed|flee`, `npc info`, `dialogue debug`, `population density 2`, `peds stats`, `actors`, `who <id>`, `intox <id> 0.12`, `scene info|outcomes|flags <id>`, `weapon`, `catalog stats`, `flee`.
Patrol (Phase 2): `cad call alarm` (`cad call <type> here` at the player), `cad calls`, `cad units`, `cad clear [disposition]`, `lookup plate ABC 1234`, `lookup person 17` / `lookup person smith`, `radio say Testing`, `radio channel tac`, `radio scan`, `siren yelp|wail|phaser|hilo|off`, `lights on|off|next|<pattern>`, `pullover`, `fleet`, `equip`, `dispatch stats`, `bolos`, `docs`.

In dev builds the app is exposed as `window.patrol`.

## Docs
- `docs/ARCHITECTURE.md` — module layout and contracts
- `docs/phase1-design.md` — Phase 1 (world and driving) design and module APIs
- `docs/phase2-design.md` — Phase 2 (police vehicle, MDT, CAD, radio) design and module APIs
- `docs/phase3-design.md` — Phase 3 (people, calls, dialogue, scenes) design and module APIs
- `docs/PHASES.md` — per-phase log with manual test checklists and known limitations
- `docs/research/` — verified API notes for the pinned libraries
