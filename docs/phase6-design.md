# Phase 6 design: Backup, Tactical, Multi-Agency

Status: design (technical director). Implementation is split into 8 modules in 3 waves (§19) plus an integrator
(§20). Read with `docs/ARCHITECTURE.md`, `docs/phase2-design.md` §2, `docs/phase3-design.md` §2-§3,
`docs/phase4-design.md` §2-§4, `docs/phase5-design.md` §2-§4 and `docs/research/*.md`. Every builder reads §1-§4 and
the section of its own module. Names, ids, signatures and shapes in this document are contracts: do not rename them.
When a brief says "add", keep every existing export, behaviour and test green unless the brief says otherwise.

Note on the save version: the task statement says "currently v5", but Phase 5 already shipped **v7**
(`CURRENT_SAVE_VERSION = 7`, `src/save/schema.ts`). Phase 6 adds **v8** with a tested `migrateV7ToV8`; every older
version (1..7) must still load. The user gave blanket approval for this one version bump.

## 1. Scope

At the end of Phase 6 the officer no longer works alone:

- **AI backup officers** (`src/backup`). The six Phase 2 AI patrol units (callsigns 21-33) and the supervisors get a
  persistent **roster** (`src/units`): a procedural name from the seed, personality traits (aggression, discipline,
  experience, composure, communication) and dynamic **stress, fatigue and loyalty** (saved). When an AI unit is on
  scene of the player's call, its officer **gets out and walks**: the first takes the **cover** role (a cover spot at
  45-60° off the contact line), the second the **secondary** role (watches and commands secondary subjects, chases a
  runner, cuffs a compliant one), others stand by or staff **posts** (inner perimeter, traffic control, evacuation).
  They **call out** what they see over the radio ("Gun! Right hand!", "Second subject by the car", "Runner,
  northbound"). Under stress and fatigue they make **deterministic mistakes** (per seed and officer): late callouts,
  poor positioning (in the crossfire line or too close) and, rarely, **excessive force** on a restrained subject that
  the player must stop with the Phase 5 duty-to-intervene key (H).
- **Backup and resource requests** via the radio menu (T → 4 → paged list), voice and the MDT *Resources* tab: routine
  (code 2), priority (code 3), officer needs assistance, K9, supervisor, SWAT, air unit, EMS, fire (and hazmat), tow,
  coroner, detectives, crime scene unit, animal control, bomb squad, negotiator, state patrol, federal. Each is a
  **data-driven unit type** (`src/data/units/unitTypes.json`: vehicle, crew, base, turnout, on-scene behaviour, the
  scene services it resolves).
- **Response times** from the unit's real position, a road-network route (`RoadGraph.routeBetweenPoints`), traffic
  density, weather and call priority (`estimateResponse`, pure, tested). Units **spawn at their base** (station,
  hospital, airport, highway end) and **drive** there as Phase 2 fleet cars (no instant spawns); the air unit flies.
  Every en-route unit has a live **ETA** in CAD (MDT Units and Call tabs, the radio acknowledgement, the HUD).
- **Chain of command** (`src/resources`): a sergeant responds automatically to uses of force above a threshold, to
  excessive-force verdicts and to vehicle pursuits (it monitors the pursuit by radio and may **terminate** it or
  grant **PIT authorization**); a lieutenant and the chief respond to major incidents and disasters and report to the
  **command post**.
- **Pursuits** (`src/pursuit`): the Phase 3 fleeing car keeps its AI road driving; added **PIT** (contact geometry
  classified from both poses + a policy check), **spike strips** (carried strip deployed by the player on foot, or an
  AI unit sent ahead along the predicted path; tyres deflate: speed cap, then the car stops; the player's own car
  crossing a strip bursts its front tyres through the Phase 1 damage model), **box-in**, **roadblock** (units ahead
  slow the car down), the **air unit** (follows the suspect, spotlight at night, FLIR camera view, keeps the suspect
  from "escaping" while it watches), a **perimeter** after a foot bail (posts on the road network, K9 and air,
  containment), **termination rules** (policy + supervisor) and **jurisdiction handoff** (state patrol takes primary at
  the county line).
- **Barricade / hostage** (`src/command` + `src/backup`): containment with an **inner perimeter** (backup officers on
  the corners of the building) and an **outer perimeter** (traffic control points + a no-go zone), a **negotiator
  dialogue minigame** (Phase 3 dialogue panel; active-listening tactics move trust and agitation; surrender,
  stall or breakdown), a **SWAT team** of 4 operators (AI walkers) with commands **stage, stack, breach, clear, hold,
  withdraw** and **plan adjustments** (entry point, tempo, less-lethal).
- **Mass-casualty and disaster scenes** (`src/command`, new call family `massCasualty`: multi-vehicle highway crash,
  building collapse, hazmat release): an **incident command post**, **START triage** tags on the victims (player
  assessment with vitals, EMS crews triage the rest), **traffic control points** (traffic blockades), **evacuation**
  of a zone, **EMS / fire coordination** (extrication, decontamination, transport in tag priority, ambulances shuttle
  to the hospital).

Non-goals (later phases): AI officers indoors (only SWAT operators enter buildings; patrol backup holds the door),
physically simulated PIT spin (the spin is a scripted traffic animation triggered by a physics contact), vehicle
interventions judged by the legal engine (PIT / box-in are judged by the Phase 6 pursuit policy and shown live, not
fed into IA), true thermal rendering (FLIR is a camera view with a CSS filter and a target box), multi-floor
buildings, fire simulation.

## 2. Conventions (in addition to Phase 1-5 §2)

- **TS rules** unchanged: no enums / namespaces / parameter properties; `as const` objects + unions; `import type`;
  `noUncheckedIndexedAccess`; JSDoc on exports; `scratch*` temporaries in hot loops; **no per-step allocation** in
  `step` hot paths (events, requests and rare transitions may allocate).
- **Determinism.** All new simulation state changes in fixed steps and draws only from named streams:
  `session.rng.stream('resources')`, `'backup'`, `'pursuit'`, `'command'`. Pure per-entity randomness uses
  `createRng(seed).stream('<kind>:<id>')` (officer profiles `roster:<callsign>`, mistake rolls
  `mistake:<callsign>:<seq>`, victim vitals `vitals:<personId>`). `Math.random`, `Date.now`, `performance.now` are
  forbidden in `src/units`, `src/resources`, `src/backup`, `src/pursuit`, `src/command`. Presentation (FLIR, panels,
  MDT, the worker ETA board) never feeds back into the simulation.
- **UI → sim through queues.** Panels, keys, the radio menu and the MDT produce request objects
  (`ResourceSystem.request`, `BackupSystem.request`, `PursuitSystem.request`, `CommandSystem.request`, the
  dispatcher's `UnitRequest`) applied at the start of the owner's next fixed step. Bus handlers only enqueue.
- **Data** in `src/data/<area>/*.json`, `"version": 1`, validated at import by a typed validator throwing `Error`
  naming the file and the dotted JSON path (pattern: `src/dispatch/data.ts`, `src/force/data.ts`). Every validator
  is exported as `parseX(json, file)` and the parsed constant as `X_CONFIG` / `X_DATA` so tests can feed variants.
- **Headless.** DOM classes construct and run as no-ops without `document` (vitest = node).
- **Generic content only.** No real agency names, ranks are generic (Officer, Sergeant, Lieutenant, Chief), unit
  callsigns are generic (`K9-1`, `MEDIC-2`, `ENGINE-1`, `AIR-1`, `STATE-7`), "state patrol" and "federal" are generic
  role names (no real agencies, seals or liveries). Vehicles are plain colours. No third-party assets;
  `docs/ASSETS.md` stays empty.
- **Time.** `t` = `CadTime` (`sim` seconds drive timers, `game` seconds are displayed). Durations in Phase 6 data are
  **sim seconds** unless the key ends in `Min` / `Hours` (game time).
- **Radio lines.** Every Phase 6 runtime module emits its radio traffic as `<module>:radio` with the shared payload
  `RadioLinePayload` (§4.3); the integrator bridges them to `RadioSystem.say`. HUD one-liners go out as
  `<module>:flash` `{ text }`.

## 3. Architecture

```
 fixed step (60 Hz)
 ┌───────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ dispatch (-700) + ETA ranker (resources), directUnit / undirectUnit / hold, officer names (units roster)       │
 │ resources (-698) ResourceSystem: unit-type pools, requests (radio / MDT / scene provider / chain of command), │
 │                  turnout → spawn at base → fleet car drive → on scene → work → return; air unit flight;       │
 │                  ETA tracker (1 unit per step); crews view ─▶ resource:dispatched/arrived/cleared/radio/flash │
 │ scene (-690)  + external services (provider), serviceRequest / serviceArrived / custody / commandFlag,         │
 │                 terminatePursuit { reason: 'handoff' }, massCasualty family                                     │
 │ force (-685)  + per-fellow misconductChance (backup officers are fellows)                                      │
 │ contact (-680)                                                                                                  │
 │ pursuit (-678) PursuitSystem: contact classification (PIT / ram / bump) + policy, spike strips, box-in,        │
 │                roadblock, air tracking, supervisor decisions (1 Hz), perimeter + containment, handoff          │
 │ investigation (-675), station (-670)                                                                            │
 │ backup (-665)  roster minute tick; BackupSystem: on-foot officers (exit, cover, secondary, posts, detain),     │
 │                callouts, mistakes, stress events; SwatTeam (stage, stack, breach, clear) ─▶ backup:*          │
 │ command (-662) CommandSystem: command post, triage (START), TCPs, evacuation, containment, negotiation, needs   │
 │ incidents (-660) + pursuit:order terminate → advisory event;  conduct (-658), court (-656)                      │
 │ radio (-650), tactical (-640), vehicles.pre 40, traffic 50 (+ deflate, spin-out, speed cap, tracked flee,      │
 │ blockades, fleeing cars survive contacts), npc 60, physics 100, vehicles.post 110                              │
 └───────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 presentation (per frame)
   PeopleRenderer sources: + backup.view (officers + SWAT), + resources.crews (EMS, fire, K9 handler + dog, ...)
   AirRenderer (helicopter, rotor, spotlight), SpikeRenderer (strips), FLIR camera mode + overlay
   HUD: backup roster lines, pursuit line (supervisor, tactic verdicts), resources chip (next ETA), command chip
   MDT: Units / Call tabs show ETA; new tabs Resources (request any type, unit list, worker ETA board) and Command
   panels: Backup (','), Command / triage / SWAT plan ('.'), Pursuit tactics (';'), negotiation (DialoguePanel)
   worker: sim.worker `eta.matrix` (presentation-only ETA board for the MDT)
```

- **Wave 1 (no new Phase 6 imports):** `units` (unit types, roster, ETA math, vehicle models, worker ETA board),
  `traffic` (traffic + drivable vehicle hooks), `hooks` (dispatch, cad, radio, scene, calls, force, incidents, legal
  hooks).
- **Wave 2 (import wave 1):** `resources`, `backup`, `pursuit`, `command`. Same-wave calls go through **structural
  ports** declared by the consumer (§4.5); the integrator wires the real objects and `tsc` checks assignability.
- **Wave 3:** `ui` (MDT tabs, HUD, panels, FLIR, helicopter and strip rendering, input actions; imports all).
- Importing **pre-existing Phase 0-5 exports** of a file another module owns is always allowed (e.g. `ActorInfo`
  from `src/npc/types.ts`, `DialogueView` from `src/ui/dialogue/types.ts`, `NAMES` from `src/records/data.ts`); only
  Phase 6 additions of a same-wave module are off limits (use the port or the re-declared literal union).

## 4. Shared contracts

### 4.1 Fixed id lists (contracts)

Each consuming module of a later wave imports them from the owner; same-wave consumers re-declare the tuple.

| List | Ids | Defined by (file) |
|---|---|---|
| `UNIT_BEHAVIORS` (17) | `patrol supervisor command k9 swat air ems fire tow coroner detectives csu animalControl bombSquad negotiator statePatrol federal` | units `src/units/types.ts` |
| `SEND_KINDS` (4) | `backup2 backup3 emergency resource` | units |
| `UNIT_BASES` (6) | `station hospital airport harbor highway edge` | units |
| `RANKS` (4) | `officer sergeant lieutenant chief` | units |
| `ROSTER_EVENTS` (11) | `shotsFired weaponSeen fight forceUsed pursuitMinute callHandled coveredByPlayer abandoned intervenedOnThem requestedAndArrived officerInjured` | units |
| `MISTAKE_KINDS` (3) | `lateCallout poorPosition excessiveForce` | units |
| `RESOURCE_STATUSES` (7) | `available turnout enRoute onScene transporting returning outOfService` | resources `src/resources/types.ts` |
| `BACKUP_STATES` (11) | `exiting approach cover secondary chase detain post standby returning gone swat` | backup `src/backup/types.ts` |
| `BACKUP_ROLES` (5) | `cover secondary post standby swat` | backup |
| `BACKUP_COMMANDS` (6) | `cover secondary detain standby release regroup` | backup |
| `SWAT_COMMANDS` (6) | `stage stack breach clear hold withdraw` | backup |
| `SWAT_PHASES` (8) | `enRoute staging stacked breaching clearing holding done withdrawn` | backup |
| `PURSUIT_TACTICS` (7) | `pit spikes boxIn roadblock air perimeter handoff` | pursuit `src/pursuit/types.ts` |
| `PURSUIT_ORDERS` (4) | `terminate authorizePit denyPit handoff` | **hooks** (`src/incidents/events.ts`, §7.6) |
| `CONTACT_KINDS` (4) | `pit ram bump none` | pursuit |
| `TRIAGE_TAGS` (4) | `minor delayed immediate expectant` (green, yellow, red, black) | command `src/command/types.ts` |
| `COMMAND_LEVELS` (4) | `none incident major disaster` | command |
| `NEGOTIATION_OUTCOMES` (4) | `ongoing surrender stalled breakdown` | command |
| `COMMAND_FLAGS` (12) | `commandPost contained perimeter evacuated trafficControl triaged transportedRed icsTransport negotiated swatResolved csuProcessed federalNotified` | **hooks** (`src/data/scene/scene.json` `commandFlags`, §7.4) |
| New scene `SERVICE_KINDS` (+6) | `detectives csu negotiator statePatrol federal airUnit` | **hooks** (`src/calls/types.ts`) |
| Radio channels (existing) | `dispatch tac car fireEms county state` (+ `current` = the player's channel, integrator resolves) | radio (Phase 2) |

### 4.2 Unit types (`src/data/units/unitTypes.json`, owner units)

```json
{
  "version": 1,
  "fleetIndexBase": 8,
  "maxFleetCars": 32,
  "airSpeedMps": 45,
  "airAltitudeM": 150,
  "types": [
    { "id": "routine", "label": "Routine backup", "menu": "Backup, routine", "voice": ["routine backup", "backup code 2", "cover unit"],
      "requestable": true, "menuOrder": 1, "send": "backup2", "behavior": "patrol",
      "resolves": "One patrol unit responds without lights and siren." },
    { "id": "priority", "label": "Priority backup", "menu": "Backup, code 3", "voice": ["priority backup", "backup code 3", "expedite"],
      "requestable": true, "menuOrder": 2, "send": "backup3", "behavior": "patrol", "resolves": "Two patrol units respond code 3." },
    { "id": "officerNeedsAssistance", "label": "Officer needs assistance", "menu": "Officer needs assistance", "voice": ["officer needs assistance", "need help now"],
      "requestable": true, "menuOrder": 3, "send": "emergency", "behavior": "patrol", "resolves": "Every available unit responds code 3 (the emergency button)." },
    { "id": "k9", "label": "K9 unit", "menu": "K9", "voice": ["k9", "canine", "dog unit"], "requestable": true, "menuOrder": 5,
      "send": "resource", "behavior": "k9", "callsign": "K9-{n}", "count": 1, "vehicle": "patrol_suv", "color": "#20242a",
      "base": "station", "turnoutS": [30, 120], "speedFactor": 1.0,
      "crew": { "count": 1, "dog": true, "top": "#1f2b3c", "bottom": "#191b1f" },
      "sceneServices": ["k9"], "onSceneS": [300, 600], "channel": "dispatch",
      "resolves": "Searches for hidden suspects and tracks runners; enables the K9 force tool." }
  ]
}
```

Fields (validator `parseUnitTypes(json, file)`, all required unless marked optional):

| Field | Type | Rule |
|---|---|---|
| `fleetIndexBase` | int | first traffic fleet index for resource units (the 6 patrol units use 0..5); 8 |
| `maxFleetCars` | int | must equal `src/data/traffic/pullover.json` `fleet.maxCars` (32); ground units (all non-air `count`s summed) must be ≤ `maxFleetCars - fleetIndexBase` |
| `airSpeedMps`, `airAltitudeM` | number > 0 | air unit flight |
| `types[].id` | string, unique | camelCase |
| `label`, `menu` | string | `menu` ≤ 28 chars (radio menu line) |
| `voice` | string[] | lowercase phrases for the voice grammar (may be empty) |
| `requestable` | boolean | false for `lieutenant`, `chief` (chain of command only) |
| `menuOrder` | int ≥ 1, unique among requestable | radio menu / MDT order |
| `send` | `SEND_KINDS` | `backup2` / `backup3` / `emergency` go to the Phase 2 dispatcher (`UnitRequest` backup / emergency); `resource` to `ResourceSystem` |
| `behavior` | `UNIT_BEHAVIORS` | what the unit does on scene (§8.5) |
| `resolves` | string | MDT description |
| `callsign` | string with `{n}` | resource types only; `{n}` = 1..count |
| `count` | int 1..4 | resource types only |
| `vehicle` | vehicle model id or `"none"` | `"none"` only for `behavior: "air"` |
| `color` | `#rrggbb` | fleet car body colour |
| `base` | `UNIT_BASES` | where the unit starts, returns to and is spawned |
| `turnoutS` | [p1, p4] seconds | turnout before driving (interpolated by priority, §5.3) |
| `speedFactor` | 0.5..1.5 | route speed multiplier (trucks 0.85) |
| `crew` | `{ count 0..4, dog?: boolean, top, bottom }` | on-foot figures shown by resources (SWAT operators are drawn by backup, so `swat` has `count: 0`) |
| `sceneServices` | `ServiceKind[]` | scene services the arrival resolves (`fire`: `["fire", "hazmat"]`) |
| `onSceneS` | [min, max] | stay after arrival when no work keeps the unit (chain of command: until the call closes) |
| `channel` | radio channel id | channel of its radio lines (`fireEms` for EMS / fire) |
| `rank` | optional `RANKS` | `supervisor`: sergeant, `lieutenant`, `chief` |

The shipped list (20 types, `menuOrder` in brackets; ids are contracts):

| id | send | behavior | callsign × count | vehicle | base | turnoutS | sceneServices |
|---|---|---|---|---|---|---|---|
| routine [1] | backup2 | patrol | – | – | – | – | – |
| priority [2] | backup3 | patrol | – | – | – | – | – |
| officerNeedsAssistance [3] | emergency | patrol | – | – | – | – | – |
| supervisor [4] | resource | supervisor (rank sergeant) | `SGT-{n}` × 2 | patrol_suv `#2b2f36` | station | [10, 60] | supervisor |
| k9 [5] | resource | k9 | `K9-{n}` × 1 | patrol_suv `#20242a` | station | [30, 120] | k9 |
| ems [6] | resource | ems | `MEDIC-{n}` × 3 | ambulance `#f2f2ee` | hospital | [20, 90] | ems |
| fire [7] | resource | fire | `ENGINE-{n}` × 2 | fire_engine `#a3261e` | station | [40, 90] | fire, hazmat |
| tow [8] | resource | tow | `TOW-{n}` × 2 | tow_truck `#d8a21a` | harbor | [120, 300] | tow |
| swat [9] | resource | swat | `TAC-{n}` × 1 | tactical_truck `#1c1f24` | station | [300, 600] | swat |
| negotiator [10] | resource | negotiator | `NEG-{n}` × 1 | sedan `#3a3f47` | station | [180, 420] | negotiator |
| air [11] | resource | air | `AIR-{n}` × 1 | none | airport | [60, 180] | airUnit |
| coroner [12] | resource | coroner | `CORONER-{n}` × 1 | van `#2a2c30` | hospital | [300, 900] | coroner |
| detectives [13] | resource | detectives | `DET-{n}` × 1 | sedan `#4a4e55` | station | [300, 900] | detectives |
| csu [14] | resource | csu | `CSU-{n}` × 1 | van `#e6e6e2` | station | [240, 600] | csu |
| animalControl [15] | resource | animalControl | `ANIMAL-{n}` × 1 | pickup `#e7e3d6` | harbor | [180, 480] | animalControl |
| bombSquad [16] | resource | bombSquad | `BOMB-{n}` × 1 | tactical_truck `#30353c` | station | [300, 600] | bombSquad |
| statePatrol [17] | resource | statePatrol | `STATE-{n}` × 2 | patrol_sedan `#c9c2a8` | highway | [10, 60] | statePatrol |
| federal [18] | resource | federal | `FED-{n}` × 1 | sedan `#16181b` | edge | [600, 1200] | federal |
| lieutenant [–] | resource | command (rank lieutenant) | `LT-{n}` × 1 | patrol_suv `#e9e9e9` | station | [60, 180] | – |
| chief [–] | resource | command (rank chief) | `CHIEF-{n}` × 1 | patrol_suv `#e9e9e9` | station | [120, 300] | – |

Ground units: 2+1+3+2+2+1+1+1+1+1+1+1+2+1+1+1 = 22 ≤ 24 (fleet indices 8..29). Crew counts: supervisor 1, k9 1 + dog,
ems 2, fire 3, tow 1, swat 0, negotiator 1, coroner 2, detectives 2, csu 2, animalControl 1, bombSquad 2, statePatrol 1,
federal 2, lieutenant 1, chief 1. `onSceneS` defaults [300, 600] except tow / coroner / animalControl [120, 240].

### 4.3 Shared payloads (`src/units/types.ts`, owner units)

```ts
/** A radio line of a Phase 6 module; the integrator calls RadioSystem.say(channel === 'current' ? radio.channel : channel, text, speaker). */
export interface RadioLinePayload {
  channel: 'dispatch' | 'tac' | 'car' | 'fireEms' | 'county' | 'state' | 'current';
  speaker: string;
  text: string;
  /** Interrupts lower-priority traffic (radio net priority); default false. */
  priority?: boolean;
}
export interface FlashPayload { text: string }
```

### 4.4 Event topics (declaration merging in the owner's `events.ts`)

| Topic | Owner file | Payload |
|---|---|---|
| `pursuit:order` | hooks `src/incidents/events.ts` | `PursuitOrderEvent { callId: number; order: 'terminate' \| 'authorizePit' \| 'denyPit' \| 'handoff'; by: string; text: string; sim: number }` |
| `resource:dispatched` | resources `src/resources/events.ts` | `{ callsign: string; typeId: string; callId: number; etaS: number }` |
| `resource:arrived` | resources | `{ callsign: string; typeId: string; callId: number }` |
| `resource:cleared` | resources | `{ callsign: string; typeId: string; callId: number }` |
| `resource:radio` / `resource:flash` | resources | `RadioLinePayload` / `FlashPayload` |
| `backup:callout` | backup `src/backup/events.ts` | `{ callsign: string; kind: CalloutKind; text: string; late: boolean; callId: number }` (the radio line also goes out as `backup:radio`) |
| `backup:mistake` | backup | `{ callsign: string; kind: 'lateCallout' \| 'poorPosition' \| 'excessiveForce'; callId: number }` |
| `backup:custody` | backup | `{ callId: number; personId: number; actorId: number; by: string }` (integrator → `scene.request({ kind: 'custody', ... })`) |
| `backup:swat` | backup | `{ phase: SwatPhase; text: string; callId: number }` |
| `backup:radio` / `backup:flash` | backup | `RadioLinePayload` / `FlashPayload` |
| `pursuit:tactic` | pursuit `src/pursuit/events.ts` | `{ callId: number; tactic: PursuitTactic; verdict: 'withinPolicy' \| 'outsidePolicy' \| 'failed' \| 'success'; text: string }` |
| `pursuit:handoff` | pursuit | `{ callId: number; to: string }` |
| `pursuit:radio` / `pursuit:flash` | pursuit | `RadioLinePayload` / `FlashPayload` |
| `command:post` | command `src/command/events.ts` | `{ callId: number; level: 'none' \| 'incident' \| 'major' \| 'disaster'; x: number; z: number; open: boolean }` |
| `command:triage` | command | `{ callId: number; personId: number; tag: TriageTag; correct: boolean; by: 'player' \| 'ems' }` |
| `command:negotiation` | command | `{ callId: number; outcome: 'ongoing' \| 'surrender' \| 'stalled' \| 'breakdown'; trust: number; agitation: number }` |
| `command:radio` / `command:flash` | command | `RadioLinePayload` / `FlashPayload` |

No new ECS components: all Phase 6 state lives in systems (`src/ecs/components.ts` unchanged). Resource fleet cars get
the existing `PoliceLights` component (light bar + siren) like the dispatcher's fleet.

### 4.5 Structural ports between same-wave modules (declared by the consumer; listed so both sides match)

```ts
// pursuit and command (wave 2) read resources (wave 2) through:
export interface ResourcePort {
  /** Queue a request (same as ResourceSystem.request({ kind: 'request', ... })). */
  requestType(typeId: string, callId: number, via: 'radio' | 'mdt' | 'auto'): void;
  /** Callsign of a sergeant (or higher) assigned to `callId` (en route or on scene), null none. */
  supervisorFor(callId: number): string | null;
  /** Units of `typeId` on scene of `callId`. */
  onScene(callId: number, typeId: string): number;
  /** Callsigns of units of `typeId` on scene of `callId` (fills and returns `out`). */
  onSceneUnits(callId: number, typeId: string, out: string[]): string[];
  /** The air unit (null while at base): position and whether it is over its target. */
  air(out: { x: number; z: number; y: number; onTarget: boolean; spot: boolean }): boolean;
  /** Point the air unit at a target; kind 'none' sends it back to orbit the call. */
  setAirTarget(kind: 'vehicle' | 'actor' | 'point' | 'none', id: number, x: number, z: number): void;
  /** EMS unit `callsign` loads patient `personId` and drives to the hospital; false when not an on-scene EMS unit. */
  transport(callsign: string, personId: number): boolean;
  /** Sends a ground unit to (x, z) (same call); false when unknown or not assigned. */
  directTo(callsign: string, x: number, z: number, urgency: 'respond' | 'emergency'): boolean;
  /** Pose of a resource unit's vehicle (false when not spawned). */
  unitPose(callsign: string, out: { x: number; z: number; yaw: number; speed: number }): boolean;
}
// command (wave 2) drives backup (wave 2) through:
export interface BackupPort {
  /** Asks an available on-foot officer of the call to staff a post; returns the callsign or null when none is free. */
  staffPost(post: { id: string; x: number; z: number; yaw: number; kind: 'inner' | 'tcp' | 'evac' }): string | null;
  /** Releases every post of `kind` (all when omitted). */
  clearPosts(kind?: 'inner' | 'tcp' | 'evac'): void;
  /** Posts currently staffed (officer within 3 m of it). */
  staffed(kind: 'inner' | 'tcp' | 'evac'): number;
  /** A SWAT command (+ optional plan change) for the team on `callId`'s building. */
  swat(callId: number, command: 'stage' | 'stack' | 'breach' | 'clear' | 'hold' | 'withdraw', plan?: { entry?: 'front' | 'rear'; tempo?: 'deliberate' | 'dynamic'; lessLethal?: boolean }): string;
  /** SWAT phase on the call ('enRoute' when the team has not arrived, null when no SWAT unit is assigned). */
  swatPhase(callId: number): string | null;
}
// pursuit (wave 2) reads the incidents ruleset through (integrator: incidents.ruleset.pursuit + offense):
export interface PursuitRulesPort {
  allowedOffenses(): readonly string[];
  maxDurationS(): number;
  terminateGraceS(): number;
  /** Allowed mph over the limit in `district` (legal `allowedOverMph`). */
  allowedOverMph(district: string, wet: boolean, night: boolean): number;
  /** The pursuit's offense from the incident assessment, null unknown. */
  offense(pursuitCallId: number): string | null;
}
```

## 5. Units, roster and response time [units] — wave 1

Owns `src/units/**`, `src/data/units/**`, `src/vehicles/model.ts`, `src/data/vehicles/ambulance.json`,
`src/data/vehicles/fire_engine.json`, `src/data/vehicles/tow_truck.json`, `src/data/vehicles/tactical_truck.json`,
`src/workers/protocol.ts`, `src/workers/sim.worker.ts`, `test/units/**`, `test/vehicles/model.test.ts`,
`test/workers/etaMatrix.test.ts`.

### 5.1 Files

| File | Exports |
|---|---|
| `src/units/types.ts` | id lists §4.1 (units rows), `RadioLinePayload`, `FlashPayload`, `UnitType`, `UnitTypesData`, `OfficerTraits`, `OfficerProfile`, `OfficerDynamic`, `RosterSave`, `EtaInput`, `EtaResult`, `EtaConfig`, `RosterConfig` |
| `src/units/data.ts` | `parseUnitTypes`, `UNIT_TYPES`, `unitType(id): UnitType \| null`, `requestableTypes(): readonly UnitType[]` (sorted by `menuOrder`), `resourceSlots(): readonly ResourceSlot[]` (§5.2), `parseEtaConfig`, `ETA_CONFIG`, `parseRosterConfig`, `ROSTER_CONFIG` |
| `src/units/eta.ts` | `urgencyFor`, `estimateResponse`, `airEta`, `remainingEta`, `expectedSpeed`, `rankByEta` |
| `src/units/personality.ts` | `officerName`, `officerProfile`, `mistakeChances`, `rollMistakes` |
| `src/units/roster.ts` | `RosterState`, `isRosterSave`, `emptyRosterSave` |
| `src/units/index.ts` | re-exports |
| `src/data/units/unitTypes.json` | §4.2 |
| `src/data/units/eta.json` | §5.3 |
| `src/data/units/roster.json` | §5.4 |

### 5.2 Resource slots

`resourceSlots()` expands every `send: "resource"` type with `vehicle !== "none"` in **file order** into slots:
`{ typeId, callsign, index: n, fleetIndex }` with `callsign = type.callsign.replace('{n}', String(n))` and
`fleetIndex = fleetIndexBase + k` (k = running count over all ground slots, starting at 0). Air types produce slots
with `fleetIndex: -1`. The order is a contract (saves store callsigns, the dispatcher never touches these indices).

### 5.3 Response time (`src/units/eta.ts`, pure) — mandatory tests

`src/data/units/eta.json`:
```json
{ "version": 1,
  "urgencyFactor": { "routine": 0.9, "respond": 1.05, "emergency": 1.35 },
  "trafficPenalty": { "routine": 0.45, "respond": 0.35, "emergency": 0.15 },
  "wetPenalty": 0.15, "minTravelS": 5, "rankCandidates": 4 }
```
(`urgencyFactor` matches the traffic fleet speed factors `patrolFactor 0.9 / respondFactor 1.05 / emergencyFactor 1.35`.)

```ts
export type Urgency = 'routine' | 'respond' | 'emergency';
export interface EtaInput {
  /** `PointRoute.time` (s, at the posted limits incl. junction penalties); 0 when already there. */
  routeTimeS: number;
  routeLengthM: number;
  priority: 1 | 2 | 3 | 4;
  urgency: Urgency;
  /** 0..2: district traffic density x hour factor (1 = normal). */
  trafficDensity: number;
  /** 0..1 road wetness. */
  wetness: number;
  turnoutS: readonly [number, number];
  speedFactor: number;
}
export interface EtaResult { etaS: number; turnoutS: number; travelS: number }

/** P1-P2 emergency, P3 respond, P4 routine. */
export function urgencyFor(priority: 1 | 2 | 3 | 4): Urgency;
export function estimateResponse(i: EtaInput, cfg: EtaConfig = ETA_CONFIG): EtaResult;
```
Algorithm (exact):
1. `turnout = turnoutS[0] + (turnoutS[1] - turnoutS[0]) * (priority - 1) / 3`.
2. If `routeLengthM <= 0`: `travel = 0`. Else `base = routeTimeS / (cfg.urgencyFactor[urgency] * speedFactor)`;
   `travel = base * (1 + cfg.trafficPenalty[urgency] * clamp(trafficDensity, 0, 2)) * (1 + cfg.wetPenalty * clamp(wetness, 0, 1))`;
   `travel = max(travel, cfg.minTravelS)`.
3. `etaS = turnout + travel`. Non-finite inputs throw `RangeError`.

```ts
/** Straight line at `speedMps` plus turnout (air unit). */
export function airEta(distanceM: number, speedMps: number, turnoutS: readonly [number, number], priority: 1 | 2 | 3 | 4): EtaResult;
/** Live ETA of a unit en route: routeLeftM / max(1, expectedMps); -1 when routeLeftM < 0 (no route). */
export function remainingEta(routeLeftM: number, expectedMps: number): number;
/** routeLengthM / max(1, travelS). */
export function expectedSpeed(routeLengthM: number, travelS: number): number;
export interface EtaCandidate { id: string; x: number; z: number }
export interface RankedCandidate { id: string; etaS: number; distanceM: number; routeLengthM: number }
/**
 * Prefilter by straight-line distance to (x, z) (ties by id ascending), keep the first `cfg.rankCandidates`, ask
 * `route(c)` for { timeS, lengthM } (null = unreachable: dropped), estimate each with `make(c, route)` and sort by
 * etaS, then distance, then id. Pure apart from the callbacks; allocates (called on requests only).
 */
export function rankByEta(cands: readonly EtaCandidate[], x: number, z: number,
  route: (c: EtaCandidate) => { timeS: number; lengthM: number } | null,
  make: (c: EtaCandidate, r: { timeS: number; lengthM: number }) => EtaResult, cfg?: EtaConfig): RankedCandidate[];
```
Tests (`test/units/eta.test.ts`, required): turnout interpolation P1 / P4 / P2 exact numbers; emergency faster than
respond faster than routine for the same route; traffic density 0 vs 2 (exact factor 1 + 0.15*2 for emergency, 1 +
0.35*2 respond); wetness factor; `minTravelS` floor; zero-length route = turnout only; `speedFactor` 0.85 slows;
`urgencyFor`; `airEta` = distance / speed + turnout; `remainingEta` (-1, division, floor 1 m/s); `rankByEta` prefers a
farther unit with a faster route over a nearer one with a slow route, drops unreachable, prefilters to 4 (the 5th
nearest is never routed: assert the callback count), deterministic tie order; RangeError on NaN.

### 5.4 Roster, personality, stress, fatigue, loyalty, mistakes — mandatory tests

`src/data/units/roster.json`:
```json
{ "version": 1,
  "traits": { "aggression": [0.1, 0.8], "discipline": [0.3, 0.95], "experience": [0.1, 0.95], "composure": [0.2, 0.95], "communication": [0.3, 0.95] },
  "rankTitles": { "officer": "Officer", "sergeant": "Sgt.", "lieutenant": "Lt.", "chief": "Chief" },
  "stress": { "start": 0.1, "decayPerMin": 0.03, "events": { "shotsFired": 0.45, "weaponSeen": 0.25, "fight": 0.2, "forceUsed": 0.1,
              "pursuitMinute": 0.06, "officerInjured": 0.4, "callHandled": -0.05 } },
  "fatigue": { "start": 0.05, "perHour": 0.06, "perCall": 0.015, "max": 1 },
  "loyalty": { "start": [0.4, 0.7], "events": { "coveredByPlayer": 0.04, "requestedAndArrived": 0.01, "abandoned": -0.04, "intervenedOnThem": -0.08 } },
  "mistakes": {
    "lateCallout":    { "base": 0.04, "stress": 0.30, "fatigue": 0.25, "experience": -0.08, "discipline": -0.05, "composure": -0.05, "loyalty": -0.03 },
    "poorPosition":   { "base": 0.03, "stress": 0.25, "fatigue": 0.20, "experience": -0.06, "discipline": -0.06, "composure": -0.04, "loyalty": 0 },
    "excessiveForce": { "base": 0.002, "stress": 0.10, "fatigue": 0.03, "aggression": 0.08, "discipline": -0.05, "composure": -0.04, "loyalty": 0 }
  },
  "maxChance": { "lateCallout": 0.6, "poorPosition": 0.5, "excessiveForce": 0.2 } }
```

```ts
export interface OfficerTraits { aggression: number; discipline: number; experience: number; composure: number; communication: number }
export interface OfficerProfile { callsign: string; rank: Rank; first: string; last: string; /** "Sgt. M. Chen" */ name: string; traits: OfficerTraits; /** 0xRRGGBB skin, hair for the figure */ skin: number; hair: number; height: number }
export interface OfficerDynamic { stress: number; fatigue: number; loyalty: number; calls: number; mistakes: number; arrivals: number }

/** Pure: name from `NAMES` (src/records/data.ts) with createRng(seed).stream('roster:' + callsign): sex 50/50, first by sex, last; "Officer J. Alvarez". */
export function officerName(seed: number, callsign: string, rank: Rank): { first: string; last: string; name: string };
/** Pure: officerName + traits uniformly inside the `traits` ranges (draw order: aggression, discipline, experience, composure, communication, skin, hair, height) from the same stream after the name draws. */
export function officerProfile(seed: number, callsign: string, rank: Rank, cfg?: RosterConfig): OfficerProfile;
/**
 * Pure: chance of each mistake kind for this officer now:
 *   p = clamp(base + stress*S + fatigue*F + sum(trait_k * w_k) + loyalty*L, 0, maxChance[kind])
 * where trait weights come from the kind's table (missing keys = 0).
 */
export function mistakeChances(traits: OfficerTraits, dyn: OfficerDynamic, cfg?: RosterConfig): { lateCallout: number; poorPosition: number; excessiveForce: number };
/**
 * Pure and deterministic per seed: rng = createRng(seed).stream(`mistake:${callsign}:${seq}`); draws in the order
 * lateCallout, poorPosition, excessiveForce; each `rng.next() < chance`. `seq` = the officer's arrival count.
 */
export function rollMistakes(seed: number, callsign: string, seq: number, chances: { lateCallout: number; poorPosition: number; excessiveForce: number }): { lateCallout: boolean; poorPosition: boolean; excessiveForce: boolean };

export class RosterState {
  constructor(seed: number, cfg?: RosterConfig);
  /** Adds the officer if missing (dynamic state from the profile: stress/fatigue start, loyalty from its range using the profile stream). */
  ensure(callsign: string, rank: Rank): OfficerProfile;
  profile(callsign: string): OfficerProfile | null;
  dynamic(callsign: string): OfficerDynamic | null;
  /** Applies the data delta of `kind` (clamped 0..1); 'callHandled' also adds fatigue.perCall and calls += 1. */
  applyEvent(callsign: string, kind: RosterEvent): void;
  /** Bumps the arrival counter and returns the new value (the `seq` of rollMistakes). */
  nextArrival(callsign: string): number;
  noteMistake(callsign: string): void;
  /** Per game minute (call with whole minutes elapsed): stress -= decayPerMin * (0.5 + composure), fatigue += perHour / 60. */
  stepMinutes(minutes: number): void;
  /** New shift: fatigue = start, stress = start (loyalty kept). */
  startShift(): void;
  callsigns(): readonly string[];
  revision: number;
  serialize(): RosterSave;
  restore(s: RosterSave): void;
}
export interface RosterSave { version: 1; officers: { callsign: string; rank: Rank; stress: number; fatigue: number; loyalty: number; calls: number; mistakes: number; arrivals: number }[] }
export function isRosterSave(x: unknown): x is RosterSave;
export function emptyRosterSave(): RosterSave;  // { version: 1, officers: [] }
```
Profiles are never saved (pure functions of seed and callsign). `RosterState` allocates nothing in `stepMinutes`.

Tests (`test/units/roster.test.ts`, required): same seed + callsign → identical profile, different callsigns
differ, traits inside ranges; `officerName` uses rank titles; `mistakeChances` monotone in stress and fatigue,
decreasing in experience / discipline, clamped to `maxChance`; **`rollMistakes` deterministic per seed** (same
inputs twice equal; across 200 seqs at chance 0.3 the hit rate is 0.2..0.4; seed 1 vs seed 2 differ in at least one
of 50 seqs); `applyEvent` deltas and clamping; `stepMinutes` decay depends on composure; `startShift`; serialize →
restore round trip; `isRosterSave` rejects malformed input.

### 5.5 New vehicle models and `src/vehicles/model.ts`

- `VEHICLE_ROLES` gains `'service'` (`['police', 'civilian', 'commercial', 'service']`).
- Optional model field `listOrder` (integer ≥ 0, default 0). `parseModels` sorts by `(listOrder, id)`; existing files
  have none (0), the four new files have `"listOrder": 1`, so **every existing model keeps its index** (saves store
  `VehicleLook.model` indices and traffic snapshots store `model`). Add a test that the indices of the nine existing
  ids are unchanged (`box_truck 0, city_bus 1, compact 2, hatchback 3, patrol_sedan 4, patrol_suv 5, pickup 6, sedan 7,
  van 8`) and that the new ones are 9..12 in id order (`ambulance 9, fire_engine 10, tactical_truck 11, tow_truck 12`).
- New files (`role: "service"`, `trafficWeight: 0`, `lightbar: true`, `"listOrder": 1`, no `equipment` section; copy
  the physics blocks of the named template and change only what is listed):
  - `ambulance.json`: template `van.json`; name "Ambulance"; body length 6.2, width 2.2, height 2.3, cabin start 0.05 end 0.25; colors `[{"hex": "#f2f2ee", "weight": 1}]`; mass 4200.
  - `fire_engine.json`: template `box_truck.json`; name "Fire engine"; length 9.5, width 2.5, height 2.4; colors `#a3261e`; mass 14000; maxSpeedKmh 120.
  - `tow_truck.json`: template `box_truck.json`; name "Tow truck"; length 7.5, width 2.3, height 2.0; colors `#d8a21a`; mass 7000.
  - `tactical_truck.json`: template `box_truck.json`; name "Tactical truck"; length 7.8, width 2.5, height 2.5; colors `#1c1f24`; mass 9000.
- `session.parkPatrolCars` filters `role === 'police'`, so service models are never parked at the station; the
  registry's `pickTrafficModel` ignores weight-0 models (assert in the test that `vehicleRecord(seed, id).modelIndex`
  for ids 0..999 of seed 42 equals the pre-change values: compute them in the test from the model ids, which must be
  among the 9 existing).
- If another existing test (outside your files) asserts the model count, list it for the integrator; do not edit it.

### 5.6 Worker ETA board (`src/workers/protocol.ts`, `src/workers/sim.worker.ts`)

Add to `WorkerRequestMap`:
```ts
/** Presentation-only ETA board: routes from each unit position to the target over the seed's city (generated once per seed in the worker). */
'eta.matrix': Rpc<{ seed: number; from: { id: string; x: number; z: number }[]; to: { x: number; z: number } }, { rows: { id: string; lengthM: number; timeS: number }[] }>;
```
Worker handler: validates (`from.length <= 64`, finite numbers), caches `generateCity(seed)` (import from
`src/world/generate.ts`; the module is pure and already runs in the chunk worker) keyed by seed, calls
`city.graph.routeBetweenPoints(f.x, f.z, to.x, to.z)` per row, skips unreachable rows. Test
`test/workers/etaMatrix.test.ts`: call the exported handler function directly (export `handlers` or a
`handleEtaMatrix(payload)` function from `sim.worker.ts` without starting `onmessage` side effects in node — guard the
`self` access as the file already does) on seed 42 with two points and compare with `generateCity(42).graph.routeBetweenPoints`.

### 5.7 Perf
`estimateResponse` ≤ 1 µs; `rankByEta` cost = 4 route calls (≤ 4 ms) per request (rare); `RosterState.stepMinutes`
≤ 5 µs for 30 officers.

## 6. Traffic and vehicle hooks [traffic] — wave 1

Owns `src/traffic/**`, `src/data/traffic/**`, `src/vehicles/drivableVehicle.ts`, `test/traffic/**`,
`test/vehicles/burstTire.test.ts`.

### 6.1 Data (`src/data/traffic/pullover.json`, validator in `src/traffic/data.ts`)
- `fleet.maxCars`: 16 → **32**.
- New sections (all required by the validator):
```json
"spikes": { "speedFactor": [1, 0.75, 0.5, 0.35, 0.25], "stopAfterS": 12, "minTires": 2 },
"spin": { "durationS": 1.4, "yawDeg": 150, "slideDecel": 9 },
"blockade": { "lookaheadM": 40, "waitS": 20, "noSpawnM": 80, "max": 16 },
"pit": { "crashOnRamMps": 11 }
```

### 6.2 API additions (`src/traffic/trafficSystem.ts`)

```ts
export interface Blockade { x: number; z: number; radius: number }
export interface FleeInfo extends FleeState { deflated: number; spinning: boolean; capMps: number; tracked: boolean }

/** Deflates `tires` (0..4, cumulative max 4) tyres of an active non-fleet car; speed cap = flee.maxSpeed * spikes.speedFactor[deflated]. A fleeing car with >= spikes.minTires deflated ends its flee with 'stopped' after spikes.stopAfterS (it pulls over). False when absent or a fleet car. */
deflate(vehicleId: number, tires: number): boolean;
/** PIT result: the car yaws by dir * spin.yawDeg over spin.durationS while decelerating at slideDecel, then becomes `crashed` with hazards (a fleeing car's flee ends 'crashed' at that moment). False when absent, fleet, crashed or already spinning. */
spinOut(vehicleId: number, dir: 1 | -1): boolean;
/** Ram: the car is crashed at once (flee ends 'crashed'). */
crashCar(vehicleId: number): boolean;
/** Caps a fleeing car's speed (m/s); Infinity clears. False when not fleeing. */
setFleeSpeedCap(vehicleId: number, capMps: number): boolean;
/** While tracked the flee's lose timer does not run (air unit overhead). False when not fleeing. */
setFleeTracked(vehicleId: number, tracked: boolean): boolean;
/** fleeState + the Phase 6 fields; false when not fleeing. */
fleeInfo(vehicleId: number, out: FleeInfo): boolean;
/** Replaces the blockade list (at most blockade.max; extra entries ignored). Copied into preallocated arrays. */
setBlockades(list: readonly Blockade[]): void;
get blockadeCount(): number;
```

Behaviour:
- **Fleeing cars survive contacts.** In `crash(eid, other)`, a slot with `fleeing === 1` is **not** set to crashed;
  the `traffic:collision` event is still emitted with the new optional field `fleeing: true` (add `fleeing?: boolean`
  to `TrafficCollisionEvent`). The pursuit module decides (spinOut / crashCar / nothing).
- **Spin-out**: per-slot `spinT` (s, -1 none), `spinDir`, `spinYaw0`. While spinning the car leaves IDM control:
  `v = max(0, v - slideDecel*dt)`, `yaw = spinYaw0 + dir * yawDeg * (spinT / durationS)` (radians conversion), the
  position advances along the **original** heading with `v` (stays in its lane geometry; no lane change), proxies
  follow. At `spinT >= durationS`: `state = crashed`, `v = 0`, hazards on, and if fleeing → `endFlee(slot, 'crashed')`.
- **Speed cap**: `capMps` per slot (Infinity default) clamps the IDM desired speed of fleeing cars (`min(fleeSpeed,
  cap)`); deflation lowers the cap (min of both).
- **Tracked**: `updateFlee` skips the `fleeLost` accumulation while `tracked`.
- **Blockades**: for every non-fleet, non-fleeing, driving car, each blockade within `radius + lookaheadM` that lies
  ahead (`dot(heading, b - p) > 0`) and whose centre is within `radius` of the car's heading line acts as a stopped
  leader at along-distance `max(0, along - radius)` in the IDM gap (take the min with the real leader gap). A car that
  has waited (speed < 0.5) behind a blockade for `waitS` despawns (`despawnSlot(slot, true)`) when farther than 30 m
  from the focus (it "turned around"). The density spawner never spawns within `radius + noSpawnM` of a blockade.
  Cost: ≤ 16 x 192 cheap checks per step; use a precomputed per-blockade bounding box.
- Snapshot (`TrafficCarSave`, version stays 1, all optional): `deflated?: number`, `spin?: [t, dir, yaw0]`,
  `cap?: number` (omitted when Infinity), `tracked?: 1`; `TrafficSnapshot.blockades?: [x, z, r][]`. Restore applies
  them; `isTrafficSnapshot` accepts them and rejects wrong types.

### 6.3 Drivable vehicle (`src/vehicles/drivableVehicle.ts`)
```ts
/** Bursts tyre `wheel` (0 FL, 1 FR, 2 RL, 3 RR) as a Phase 1 burst would (damage.tireFlat, friction), emitting 'vehicle:tireBurst' on `bus`; false when already flat or out of range. */
burstTire(wheel: number, bus?: EventBus<EventMap>): boolean;
```
Use the same code path as an impact burst (`tireFlat[i] = 1`, event payload `{ eid, wheel }`).

### 6.4 Tests (`test/traffic/phase6.test.ts`, `test/vehicles/burstTire.test.ts`; use `test/traffic/helpers.ts`)
fleet cars up to 32 spawn; `deflate` caps a fleeing car's speed (after a few seconds speed ≤ cap + 0.1) and 2 tyres end
the flee 'stopped' after `stopAfterS`; `spinOut` changes yaw by ~150° and ends with `traffic:fleeEnded` 'crashed';
`crashCar`; a collision with a fleeing car leaves it fleeing and the event has `fleeing: true` (use the existing
collision test pattern); `setFleeSpeedCap` / Infinity; tracked flee does not 'escape' past `loseS`; a blockade ahead
stops an ambient car short of it and no car spawns inside it; a fleet car passes through; snapshot round trip with the
new fields; `burstTire` sets the flag once and emits once. Perf: the existing `test/traffic/perf.test.ts` budget must
still pass with 16 blockades set.

## 7. Phase 2-5 gameplay hooks [hooks] — wave 1

Owns `src/dispatch/dispatcher.ts`, `src/dispatch/save.ts`, `src/cad/types.ts`, `src/cad/cadState.ts`,
`src/radio/menu.ts`, `src/radio/grammar.ts`, `src/radio/compose.ts`, `src/radio/requestTypes.ts` (new),
`src/scene/**`, `src/calls/**`, `src/data/calls/**`, `src/data/scene/**`, `src/data/cad/**`, `src/force/types.ts`,
`src/force/forceSystem.ts`, `src/incidents/events.ts`, `src/incidents/incidentSystem.ts`, `src/legal/pursuit.ts`,
tests `test/dispatch/**`, `test/cad/**`, `test/radio/**`, `test/scene/**`, `test/calls/**` (new files
`phase6.test.ts` in each, plus fixing existing tests there that the changes break), `test/force/phase6.test.ts`,
`test/incidents/phase6.test.ts`, `test/legal/phase6.test.ts`. Existing tests in `test/force`, `test/incidents`,
`test/legal` that break must be reported to the integrator, not edited.

### 7.1 CAD (`src/cad/types.ts`, `src/cad/cadState.ts`)
- `UnitKind = 'player' | 'ai' | 'resource'`; the CAD save validator (`isObj ... isOneOf(x.kind, ['player', 'ai', 'resource'])`) accepts it.
- `UnitRequest` gains `| { readonly kind: 'resource'; readonly typeId: string }`.
- Test: a `resource` unit round-trips through `serialize` / `restore`; the validator accepts the new request kind in saved dispatcher queues (§7.2).

### 7.2 Dispatcher (`src/dispatch/dispatcher.ts`, `src/dispatch/save.ts`)
```ts
export interface DispatchDeps { /* existing */ readonly officerName?: (callsign: string) => string | null }
/** ETA ranker: when set, pickUnits keeps the nearest ETA_RANK_K = 4 eligible units by straight line and picks by ranker(callsign, x, z, urgency) (Infinity = unreachable, skipped), ties by distance. */
setUnitRanker(fn: ((callsign: string, x: number, z: number, urgency: FleetUrgency) => number) | null): void;
/** Sends AI unit `callsign` (assigned to a call) to (x, z) at `urgency`; it stops following the player (retarget skips it) until undirected. CAD status enRoute; arrival → onScene as usual. False when unknown / not on a call. */
directUnit(callsign: string, x: number, z: number, urgency: FleetUrgency): boolean;
undirectUnit(callsign: string): void;
/** While fn(callsign) is true a release (Code 4 / releaseAt) is postponed (at most HOLD_MAX_S = 30 s past releaseAt). */
setUnitHold(fn: ((callsign: string) => boolean) | null): void;
/** AI patrol callsigns assigned to `callId` (fills and returns `out`). */
aiUnitsOnCall(callId: number, out: string[]): string[];
/** Sends `n` more patrol units to the player's current call at `code` (the backup request without the radio ack); returns their callsigns. */
sendBackup(code: 2 | 3, n: number): string[];
```
- `start` uses `deps.officerName?.(callsign) ?? data.officer` for every AI unit **and the player** is unchanged.
- `handleRequest` `case 'resource': break;` (resources handles it from the bus; no ack). `src/dispatch/save.ts`
  validates `{ kind: 'resource', typeId: string }` in saved queues.
- `reconcileRoster` removes only CAD units with `kind === 'ai'` that are missing from the roster (resource units stay).
- `UnitFsmSave` gains optional `directed?: boolean` (saved only when true).
- Tests: ranker changes the pick (a farther unit with a lower ranker value wins); directed unit is not retargeted and
  arrives on scene at the directed point; hold postpones release; `aiUnitsOnCall`; `sendBackup`; officer names;
  resource units survive `restore` reconcile; the existing dispatcher tests stay green.

### 7.3 Radio (`src/radio/requestTypes.ts`, `menu.ts`, `grammar.ts`, `compose.ts`)
```ts
// src/radio/requestTypes.ts
export interface RadioRequestType { id: string; menu: string; label: string; voice: readonly string[]; request: UnitRequest }
/** Set once by the integrator from `requestableTypes()` (patrol types map to backup 2 / backup 3 / emergency, others to { kind: 'resource', typeId }). Default []. */
export function setRadioRequestTypes(list: readonly RadioRequestType[]): void;
export function radioRequestTypes(): readonly RadioRequestType[];
export function requestLabel(typeId: string): string;   // label or the id
```
- Menu: root option 4 becomes `'Request ▸'`. The `backup` level shows the request types paged **8 per page** (keys
  1-8, in list order) and key 9 `'More ▸'` (next page; on the last page `'First page ▸'`); title `'Request 1/3'`.
  With an empty list it keeps the Phase 2 two options (backup code 2 / code 3). `RadioMenu` stores `page` (reset on
  `open`, `back` and `close`; `back` from page > 0 goes to page 0 of the root). The view cache key includes the
  page. `press` returns the chosen type's `request`.
- Grammar: an utterance matching `request <voice alias>` / `send <voice alias>` / `<voice alias> to my location`
  returns that type's request (longest alias wins). Existing commands keep precedence ("backup" alone stays code 2).
- Compose: `case 'resource'`: the player's line `"{unit}, requesting {label} to {near}."` (plain and ten-code mode
  identical).
- Tests: paging, labels, key 9 wraps, `press` results for page 2 key 3, grammar "request a k9" → k9, compose line.

### 7.4 Scene and calls (`src/scene/**`, `src/calls/**`, `src/data/calls/**`, `src/data/scene/**`, `src/data/cad/**`)

**Services.** `SERVICE_KINDS` += `detectives csu negotiator statePatrol federal airUnit`; `services.json` entries
(effect `none`; `sets`: detectives `["detectivesAssigned"]`, csu `["csuProcessed"]`, negotiator
`["negotiatorOnScene"]`, statePatrol `["statePatrolOnScene"]`, federal `["federalNotified"]`, airUnit
`["airSupport"]`; arriveS like comparable entries; radio / ack / arrivedText in the existing style, generic wording).
`actions.json` gains `requestDetectives requestCsu requestNegotiator requestStatePatrol requestFederal requestAirUnit`
(`"service": <kind>, "once": true`) and `establishCommand` (`"label": "Establish a command post", "requires":
"arrived", "sets": ["commandPost"], "once": true`). Add `requestNegotiator` to the `barricade` family actions,
`requestAirUnit` to `activeAssailant`, `vehiclePursuit` and `footPursuit` families (if those families have action lists).

```ts
// src/scene/types.ts
export interface ServiceState { /* existing */ external?: boolean }
export type SceneRequest = /* existing */
  | { readonly kind: 'terminatePursuit'; readonly reason?: 'terminated' | 'handoff' }
  | { readonly kind: 'serviceRequest'; readonly callId: number; readonly service: string }
  | { readonly kind: 'serviceArrived'; readonly callId: number; readonly service: string }
  | { readonly kind: 'custody'; readonly callId: number; readonly personId: number; readonly by: string }
  | { readonly kind: 'commandFlag'; readonly callId: number; readonly flag: string };
// src/scene/director.ts
/** Phase 6: real units. Called inside requestService; true = the provider dispatches a unit: the ServiceState is `external` (dueSim = Infinity, no scene ack / arrival line). */
setServiceProvider(fn: ((callId: number, kind: string) => boolean) | null): void;
/** True when service `kind` was requested (or arrived) on `callId`. */
serviceRequested(callId: number, kind: string): boolean;
/** True when the call has a scenario runtime. */
hasScenario(callId: number): boolean;
/** Participants of the call's scenario: role, person id and actor id (0 = not spawned). Allocates (UI / rare). */
participants(callId: number): { role: string; personId: number; actorId: number; injured: boolean; deceased: boolean }[];
/** Family id of the call's scenario, null without one. */
familyOf(callId: number): string | null;
/** The call's live flag set (read-only view of the runtime's set), null without a scenario. */
flagsOf(callId: number): ReadonlySet<string> | null;
/** Building the call is bound to (Phase 4 `rt.buildingId`), -1 none. */
buildingOfCall(callId: number): number;
```
- `terminatePursuit` with `reason: 'handoff'` ends the pursuit exactly like today but with `endReason: 'handoff'`, flag
  `pursuitHandoff` instead of `pursuitTerminated`, and the radio line `"{unit}, disengaging, state units have primary."`.
- `serviceRequest`: runs `requestService(rt, kind, t)` when the call has a scenario and the service is not yet
  requested (same as pressing the action); otherwise ignored.
- `serviceArrived`: for a requested, not-yet-arrived service: marks arrived and runs the existing arrival block
  (flags `arrived:<kind>`, `sets`, action state done, `applyServiceEffect`, `scene:service` arrived) **without** the
  arrivedText radio line; when the service was never requested on that call it is first added (external) then
  arrives. For an `external` service the `resolveBarricade` effect is **skipped** (SWAT / negotiation resolve it).
- `custody`: the participant with `personId` gets `custody:<role>`, `people.setCustody(personId, 'arrested')`,
  `noteArrest(rt, role)` (no scene radio line).
- `commandFlag`: sets `flag` on the call when it is listed in `src/data/scene/scene.json` `commandFlags` (§4.1,
  validator updated); others are ignored.
- `transportInjured` returns at once when the call has the flag `icsTransport` (the command module transports).
- Saves: `ServiceState.external` saved only when true; the scene save validator accepts it.

**New call family `massCasualty`** (`src/data/calls/types/massCasualty.json` + the family in `families.json`; mirror
how `barricade` / `collision` types are registered everywhere they appear: `grep -rn hostageSituation src/data` and
add the new type ids to the same tables, e.g. `src/data/cad/callTypes.json`, codes and `test/calls/expected.ts` if
the coverage tests require it):
- Types: `multiVehicleCrash` (anchor `roadside`, districts `highway: 3, industrial: 0.5, rural: 0.5`, weight 0.01),
  `buildingCollapse` (anchor `door`, districts `downtown: 1, industrial: 1.5, suburbs: 0.5`, weight 0.005),
  `hazmatRelease` (anchor `roadside`, districts `industrial: 2, harbor: 2, highway: 1`, weight 0.008); generic narratives.
- Family defaults: priority `{"1": 1}`, units `[3, 4]`, onSceneS `[1200, 2400]`, dispositions `["reportTaken", "handled"]`.
- Roles: `victim` count [4, 8] profile `victimInjured` injured 0.8; `walkingWounded` [2, 4] profile
  `victimDistraught` injured 0.3; `unconscious` [1, 2] profile `subjectUnconscious` injured 1; `deceased` [0, 2]
  profile `subjectDeceased` deceased; `bystander` [2, 5] profile `bystander` spot `crowd`.
  Vehicles (multiVehicleCrash branch only, via branches `remove`): `vehicleA`..`vehicleD`, each count [1, 1], mode `crashed`.
- Branches: `crash` (weight 1; flags `["mci", "roadway"]`), `collapse` (flags `["mci", "trapped"]`, removes the vehicles),
  `hazmat` (flags `["mci", "hazmat", "decon"]`, removes the vehicles); each type sets `branchWeights` so it uses its branch.
- Actions: `establishCommand trafficControl perimeter evacuate requestEms requestFire requestHazmat requestTow
  requestSupervisor requestCoroner requestAirUnit photograph writeReport`.
- Objectives: "Establish command" (`commandPost`), "Triage the victims" (`triaged`), "Control traffic"
  (`trafficControl`, show `roadway`), "Evacuate the zone" (`evacuated`, show `hazmat`), "Transport the critical
  patients first" (`transportedRed`).
- Outcomes: `wellRun` when all of `commandPost triaged transportedRed` → `handled` good; `noCommand` when
  `!commandPost` → `reportTaken` bad; `default` → `reportTaken` ok.
- Variants: escalation 0.3 (more victims via roleOverrides `victim` count [6, 10]), deescalation 0, false 0.1, duplicate 3, swatting 0, ambush 0.

Tests (`test/scene/phase6.test.ts`, `test/calls/*`): provider path (external, no scene ack, `serviceArrived`
applies effects and emits `scene:service`), `serviceArrived` for an unrequested service, SWAT external skips
`resolveBarricade`, custody, commandFlag whitelist, `icsTransport`, handoff end reason, `participants`, the catalog
validates and `call spawn multiVehicleCrash` materializes ≥ 7 people; existing calls tests (coverage, reachability)
pass with the new family.

### 7.5 Force (`src/force/types.ts`, `src/force/forceSystem.ts`)
`FellowOfficer` gains optional `misconductChance?: number` and `callsign?: string`. `fellowCheck` uses the nearest
fellow's `misconductChance` when present (else `cfg.fellow.chance`). The `force:other` payload's `officer` is the
fellow's `name`. Test: a fellow with chance 1 always starts an episode, 0 never; intervene still works.

### 7.6 Incidents and legal (`src/incidents/events.ts`, `src/incidents/incidentSystem.ts`, `src/legal/pursuit.ts`)
- Declare in `src/incidents/events.ts`:
  ```ts
  export interface PursuitOrderEvent { callId: number; order: 'terminate' | 'authorizePit' | 'denyPit' | 'handoff'; by: string; text: string; sim: number }
  // 'pursuit:order': PursuitOrderEvent   (declaration merging)
  ```
- The recorder subscribes to `pursuit:order`: for `order: 'terminate'` while a vehicle pursuit sampler runs for that
  pursuit call (`sampler.callId === e.callId`) and `sampler.advised` is false → add an `advisory` event
  (`advisory: 'terminatePursuit'`, `text: e.text`) to that log and set `advised = true` (no `incident:advisory`
  emit: the pursuit module already radios it). Other orders are ignored.
- `src/legal/pursuit.ts`: `terminated = p.end?.reason === 'terminated' || p.end?.reason === 'handoff'`.
- Tests: the advisory is recorded once and `evaluatePursuit` counts `advisoryIgnoredS` from it; a `handoff` end is
  not penalised by the duration rule.

## 8. Resources, chain of command and the air unit [resources] — wave 2

Owns `src/resources/**`, `test/resources/**`. Imports units (`UNIT_TYPES`, `resourceSlots`, `estimateResponse`,
`airEta`, `remainingEta`, `expectedSpeed`, `rankByEta`, `urgencyFor`, `RosterState`, `officerName`, payload types),
traffic types, cad types, scene request types (pre-existing + hooks additions).

### 8.1 Files
`types.ts` (statuses, `ResourceRequest`, `ResourceUnitView`, `ResourceHud`, `AirView`, `ResourceSave`, ports),
`bases.ts` (base positions, pure over `City`), `air.ts` (pure flight step), `chain.ts` (pure chain-of-command
table, §8.4), `resourceSystem.ts`, `crews.ts` (crew figure placement, pure), `events.ts`, `save.ts`, `index.ts`. All
unit data comes from `src/units` (`UNIT_TYPES`, `resourceSlots()`); this module adds no JSON.

### 8.2 Deps and ports
```ts
export interface ResourceTrafficPort {
  spawnFleetCar(index: number, x: number, z: number, look: { modelIndex: number; color: number }): number;
  removeFleetCar(index: number): void;
  setFleetDestination(index: number, x: number, z: number, urgency: 'respond' | 'emergency'): boolean;
  setFleetPatrol(index: number): void;
  fleetState(index: number, out: FleetState): FleetState | null;   // FleetState from src/traffic/trafficSystem
  fleeState(vehicleId: number, out: FleeState): boolean;
}
export interface ResourceScenePort {
  request(r: SceneRequest): void;           // serviceRequest / serviceArrived
  hasScenario(callId: number): boolean;
  serviceRequested(callId: number, kind: string): boolean;
}
export interface ResourceDispatchPort {
  readonly playerCallsign: string;
  /** Phase 3 API: opens a self-initiated call with the player assigned (used when a request has no call). */
  openSelfInitiated(typeId: string, priority: 1 | 2 | 3 | 4, at: { x: number; z: number }, narrative: string, t: CadTime): { id: number };
  locate(x: number, z: number): CadLocation;
}
export interface ResourceNpcPort {
  actorOfPerson(personId: number): number;
  actor(id: number, out: ActorInfo): ActorInfo | null;
  removeActor(id: number): void;
  reveal(id: number): void;
  actorIds(out: number[]): number[];
}
export interface ResourceDeps {
  readonly seed: number;
  readonly bus: EventBus<EventMap>;
  /** session.rng.stream('resources'). */
  readonly rng: Rng;
  readonly cad: CadState;
  readonly city: City;
  readonly world: GameWorld;
  readonly traffic: ResourceTrafficPort;
  readonly scene: ResourceScenePort;
  readonly dispatch: ResourceDispatchPort;
  readonly npc: ResourceNpcPort;
  readonly people: { setCustody(id: number, c: 'hospital'): void };
  readonly roster: RosterState;
  /** 0..1 road wetness, night flag (spotlight). */
  env(): { wetness: number; night: boolean };
  /** District traffic density x hour factor at (x, z) (integrator: districtTypes trafficDensity x density.json hour factor). */
  trafficDensity(x: number, z: number): number;
  readonly types?: UnitTypesData;
}
```

### 8.3 Runtime (`src/resources/resourceSystem.ts`)
```ts
export type ResourceRequest =
  | { readonly kind: 'request'; readonly typeId: string; readonly callId: number; readonly via: 'radio' | 'mdt' | 'auto' | 'scene' }
  | { readonly kind: 'cancel'; readonly callsign: string }
  | { readonly kind: 'release'; readonly callsign: string };

export class ResourceSystem implements ResourcePort {
  constructor(deps: ResourceDeps);
  /** New game: CAD units (kind 'resource', status available, position at base) for every slot; roster.ensure for ranked types. */
  start(t: CadTime): void;
  /** Fixed step (order -698). `player` = the officer's position. */
  step(dt: number, t: CadTime, player: { x: number; z: number }): void;
  request(r: ResourceRequest): void;
  /** Scene provider (integrator: scene.setServiceProvider((c, k) => resources.provide(c, k))): maps the service to the first type whose sceneServices contains it, queues a 'scene' request and returns true; false when no type covers it. */
  provide(callId: number, kind: string): boolean;
  /** Unit-ranker for the dispatcher (integrator: dispatcher.setUnitRanker(...)): routes from the CAD unit position, returns estimateResponse(...).etaS. */
  rankPatrol(callsign: string, x: number, z: number, urgency: 'respond' | 'emergency'): number;
  /** Live ETA (s) of any en-route unit (patrol or resource), -1 unknown / not en route. */
  eta(callsign: string): number;
  units(): readonly ResourceUnitView[];
  /** Crew figures of on-scene units (and the K9 dog). */
  readonly crews: HumanoidSource & { count: number };
  airView(): AirView | null;
  hud(): ResourceHud;
  readonly revision: number;
  serialize(): ResourceSave;
  restore(s: ResourceSave, t: CadTime): void;
  dispose(): void;
  // + ResourcePort (§4.5)
}
export interface ResourceUnitView { callsign: string; typeId: string; label: string; status: ResourceStatus; callId: number; etaS: number; x: number; z: number }
export interface AirView { x: number; y: number; z: number; yaw: number; spot: boolean; targetX: number; targetZ: number; onTarget: boolean; rotor: number }
export interface ResourceHud { next: string | null /* 'MEDIC-2 ETA 3:10' (soonest en route to the player's call) */; onScene: number }
```

**Request handling** (start of step):
1. Unknown type or `requestable: false` from radio / MDT → `resource:flash` "Unknown resource". `send !== 'resource'`
   types are ignored here (the dispatcher handles them).
2. Resolve the call: `callId > 0` and open → it; else the player's CAD call (`cad.unit(playerCallsign).callId`); else
   `dispatch.openSelfInitiated('officerAssist', 3, playerPos, 'Officer requesting <label>.', t)`.
3. Scene routing: when the type has `sceneServices`, the call `hasScenario` and the first service is not yet
   `serviceRequested` and `via !== 'scene'` → `scene.request({ kind: 'serviceRequest', callId, service })` and stop
   (the scene calls `provide`, which queues a `'scene'` request next step). This keeps the scene's flags and actions
   in sync.
4. Dedupe: if a unit of the type is already assigned to the call (turnout / enRoute / onScene) → stop (radio
   "`<callsign>` is already assigned, ETA m:ss" unless `via === 'scene'`; a `scene` request for a second service of
   the same unit, e.g. `hazmat` after `fire`, is satisfied by the arrival of that unit).
5. Pick: candidates = slots of the type with status `available` or `returning`; positions = base (available) or the
   car (returning). Air: `airEta(distance, airSpeedMps, turnoutS, priority)`. Ground: `rankByEta(cands, callX, callZ,
   route = city.graph.routeBetweenPoints(...) → { timeS: r.time, lengthM: r.length }, make = estimateResponse({ ...,
   priority: call.priority, urgency: urgencyFor(call.priority), trafficDensity: deps.trafficDensity(cx, cz), wetness,
   turnoutS, speedFactor }))`. None → radio "No `<label>` available" (dispatch voice) and `resource:flash`.
6. Assign: CAD `assign(callId, callsign, t, 'dispatch')`, status `enRoute` (CAD has no turnout status; the internal
   status is `turnout` until the car moves), store `etaS`, `expectedMps = expectedSpeed(length, travelS)`,
   `turnoutUntil = t.sim + result.turnoutS`; emit `resource:dispatched`; radio (type channel, speaker = channel
   dispatcher): `"Copy <unit>, <callsign> en route to <near>, ETA <m> minutes."` (`<m>` = ceil(etaS / 60)).
   `roster.applyEvent(callsign, 'requestedAndArrived')` happens on arrival for ranked units.

**Unit FSM** (per slot, steady state allocation-free; one ETA refresh per step round-robin over en-route units):
| Status | Work | Next |
|---|---|---|
| `available` | at base, no car (CAD position = base) | request → `turnout` |
| `turnout` | wait `turnoutUntil` | ground: `spawnFleetCar(fleetIndex, baseX, baseZ, look)` trying the dispatcher's `SPAWN_OFFSETS` pattern (copy the constant), attach `PoliceLights` (`attachPoliceLights(world, eid, phase = index * 0.37)`), `setFleetDestination(callX, callZ, urgency)` → `enRoute`; failure retries every 5 s. Air: → `enRoute` |
| `enRoute` | ETA = `remainingEta(fleet.routeLeftM, expectedMps)`; arrival when `fleet.arrived` or within 30 m of the destination or no route progress for 150 s (dispatcher rule); light bar on + siren while urgency emergency and moving (`PoliceLights.siren`, `VehicleLook.lights` light bar bit) | `onScene` |
| `onScene` | CAD `onScene`; `resource:arrived`; for each `sceneServices` kind requested on the call → `scene.request({ kind: 'serviceArrived', ... })` (if the call has no scenario: nothing); crews spawn (§8.6); behaviour (§8.5); `leaveAt = t + rng.nextFloat(onSceneS)` unless the behaviour holds the unit | `returning` when the call closes, `leaveAt` passes, `release` |
| `transporting` | EMS with a patient: drives to the hospital POI (`respond`) | at hospital: remove car, `available` (CAD available at base) |
| `returning` | CAD `available`, callId null (assignable again); drives to base (`respond`, lights off) | within 40 m of base: `removeFleetCar`, `available` |
| `outOfService` | never used by Phase 6 data (reserved) | – |

Bases: `station` = `city.pois` kind station entrance; `hospital`, `airport`, `harbor` = first POI of that kind
(fallback station); `highway` = the end of the state highway (`districts.json` `highways[0]`: x = ±3584, z = coord)
nearer to the call; `edge` = the world-edge point (x or z = ±3500) nearest to the call, snapped to the nearest road
(`graph.nearestEdge`).

**Air unit** (`src/resources/air.ts`, pure step): state `{ x, y, z, yaw, vx, vz, rotor, targetKind, targetId, tx, tz,
onStationUntil }`. Each step: target point from the target (vehicle: `traffic.fleeState`; actor: `npc.actor`; point;
none: the call location); if farther than `orbitR = 120` m: fly toward it at `airSpeedMps` (yaw follows the velocity,
max turn 0.6 rad/s); else orbit at radius 120 m (angular speed `airSpeedMps * 0.5 / orbitR`). `y = airAltitudeM`
(climb / descend 8 m/s at take-off / landing). `onTarget` = within 200 m horizontally. `spot` = night && onTarget.
FLIR reveal: every 0.5 s while onTarget, every actor of the call (or the pursued runner) with `hidden` true and
`building === -1` within 80 m of the target point → `npc.reveal(id)` once and radio `"AIR-1, I have a heat signature
<dir> of the <near>."`. On station limit 900 s after arrival → returns to base (flies) → `available`. CAD position is
updated at the AVL rate (2 Hz).

### 8.4 Chain of command (`src/resources/chain.ts`, pure) — tests
```ts
export const CHAIN = {
  sergeantForceLevels: ['hardHands', 'ocSpray', 'baton', 'taser', 'k9', 'lessLethal', 'firearm'],
  sergeantOnPursuit: true,
  sergeantOnExcessive: true,
  lieutenantLevels: ['major', 'disaster'],
  chiefLevels: ['disaster'],
} as const;
export type ChainTrigger =
  | { kind: 'force'; level: string; callId: number }
  | { kind: 'verdict'; verdict: 'justified' | 'questionable' | 'excessive'; callId: number }
  | { kind: 'pursuit'; callId: number }
  | { kind: 'post'; level: 'none' | 'incident' | 'major' | 'disaster'; callId: number };
/** Which ranked types to dispatch for a trigger: [] | ['supervisor'] | ['lieutenant'] | ['lieutenant', 'chief']. */
export function chainResponse(trigger: ChainTrigger): readonly ('supervisor' | 'lieutenant' | 'chief')[];
```
Runtime wiring (bus handlers enqueue `{ kind: 'request', typeId, callId, via: 'auto' }`): `force:applied` (level),
`incident:forceVerdict` (verdict; `callId` from the incident key `C-000NN` → the CAD call with that number, else the
player's call), `scene:pursuit` vehicle active (the pursuit call), `command:post` open (level). Ranked units on scene
stay until the call closes (no `leaveAt`). `supervisorFor(callId)` returns the callsign of a `supervisor` /
`lieutenant` / `chief` type unit assigned to the call whose status is `enRoute` or `onScene` (sergeant preferred).
Supervisors on arrival: `roster.applyEvent(sgt, 'callHandled')` when the call closes. Radio on dispatch from the
ranked unit itself: `"<callsign>, show me responding to <near>."`.

### 8.5 On-scene behaviours (data `behavior`)
| behavior | On arrival / on scene |
|---|---|
| `supervisor`, `command` | crew stands at the command post if one is open on the call (`command:post` remembered per call), else beside the vehicle; held until the call closes |
| `k9` | scene service k9 (the Phase 4 sweep starts from `scene:service`); the K9 force tool works through `serviceArrived` |
| `ems` | crew of 2; the command module calls `transport(callsign, personId)` for MCI calls; on other calls the scene's `transportInjured` effect runs; after a `transport`: `npc.removeActor(actor)`, `people.setCustody(personId, 'hospital')`, status `transporting` |
| `fire` | crew of 3 beside the engine; the command module uses `onScene(callId, 'fire')` for extrication / decon rates |
| `tow` | scene `towVehicles` effect; leaves after `onSceneS` |
| `coroner` | scene `removeDeceased` |
| `swat` | the backup module spawns the 4 operators when `onSceneUnits(callId, 'swat')` > 0 (resources draws no SWAT crew) |
| `air` | §8.3 |
| `negotiator`, `detectives`, `csu`, `federal`, `animalControl`, `bombSquad`, `statePatrol` | scene service flags / effects; crews stand; `statePatrol` units can be `directTo` by pursuit / command |

### 8.6 Crews (`src/resources/crews.ts`, pure placement)
`crewSpot(vehicleX, vehicleZ, vehicleYaw, k, n, out)`: k-th of n crew members 2.2 m to the right of the vehicle's
rear axle, spaced 0.9 m along the vehicle, facing away from it. The `crews` HumanoidSource (`createHumanoidSource(48)`
from `src/render/people/pose.ts`) is rewritten at 10 Hz (pose stand / walk, colours from data, `body: BODY.dog`
for the K9 dog, height 0.6). Max 48 figures (ignore extras).

### 8.7 Save (`src/resources/save.ts`)
```ts
export interface ResourceSave {
  version: 1;
  rng: RngState;
  units: { callsign: string; status: ResourceStatus; callId: number; etaS: number; expectedMps: number; turnoutUntil: number;
           leaveAt: number; destX: number; destZ: number; urgency: 'respond' | 'emergency'; patient: number; noProgressSince: number; progressLeftM: number }[];
  air: { x: number; y: number; z: number; yaw: number; targetKind: string; targetId: number; tx: number; tz: number; onStationUntil: number; revealed: number[] } | null;
  posts: [number, number, number, number][];   // command posts remembered: [callId, x, z, levelIndex]
  requests: ResourceRequest[];
}
export function isResourceSave(x: unknown): x is ResourceSave;
export function emptyResourceSave(rng: RngState): ResourceSave;
```
Restore: CAD units are restored by CAD first; `restore` adds missing slot units to CAD (reconcile like the
dispatcher), re-links fleet cars by `fleetIndex` (the traffic snapshot already restored them), re-attaches
`PoliceLights` on the next step.

### 8.8 Tests (`test/resources/**`, mandatory parts marked)
- **Response time (mandatory)**: a K9 request picks by ETA (two K9 slots in a test data variant: a near one with a
  blocked/slow route vs a farther fast one), the radio ETA text matches `estimateResponse`; a P1 call gets a shorter
  turnout than P4; the unit spawns at its base (not at the call), the car drives (position changes over steps),
  arrives, CAD status onScene, `scene.request(serviceArrived)` sent; live `eta()` decreases while driving.
- Chain of command: `chainResponse` table; `force:applied` taser → sergeant dispatched; excessive verdict → sergeant;
  `command:post` disaster → lieutenant + chief; `supervisorFor`.
- Air: flies at speed, orbits, reveals a hidden outdoor actor within 80 m once, returns after on-station limit.
- EMS transport removes the actor and goes `transporting` → `available`.
- Determinism: two runs of 2000 steps with the same requests → identical `serialize()`; save / restore mid-drive continues identically.
- Perf: 22 slots, 6 en route: `step` ≤ 0.03 ms average (exclude request steps).
Use a small test harness (`test/resources/helpers.ts`) with a real `generateCity(42)`, a real `TrafficSystem` (see
`test/traffic/helpers.ts`) or fakes implementing the ports.

## 9. Backup officers and SWAT [backup] — wave 2

Owns `src/backup/**`, `src/data/backup/**`, `test/backup/**`. Imports units (roster, `rollMistakes`,
`mistakeChances`, payload types), npc types, tactical `InteriorQuery` type, interior `findPath` / `roomAt`, render
people `createHumanoidSource` / `POSE` / `HELD`, force `FellowOfficer` type.

### 9.1 Data (`src/data/backup/backup.json`)
```json
{ "version": 1,
  "spawn": { "maxCarDistanceM": 120, "maxOfficers": 8, "exitS": 1.5 },
  "move": { "walk": 1.6, "run": 4.8, "chase": 6.4, "arriveM": 0.4 },
  "cover": { "distanceM": [4.5, 6.5], "angleDeg": [45, 60], "poorAngleDeg": 170, "poorDistanceM": 2.0, "repositionS": 4 },
  "secondary": { "standoffM": 2.5, "commandEveryS": 10, "detectRangeM": 20 },
  "chase": { "tackleRangeM": 1.6, "giveUpM": 150 },
  "callout": { "delayS": [0.4, 1.0], "lateDelayS": [3, 6], "weaponRangeM": 15, "cooldownS": 8 },
  "post": { "staffedM": 3 },
  "stress": { "sampleS": 0.5 },
  "callouts": {
    "weapon": ["Gun! {side} hand!", "Weapon! He's got a {weapon}!"],
    "secondSubject": ["I've got a second subject, {desc}, by the {spot}.", "Second party {spot}, I'm on him."],
    "runner": ["Runner! {dir} on {street}!", "He's running, {dir}!"],
    "handsClear": ["Hands are clear.", "His hands are empty."],
    "fight": ["He's fighting! Get him down!"],
    "covering": ["I've got cover.", "On cover."],
    "inCustody": ["One in custody.", "He's cuffed."]
  } }
```
`src/data/backup/swat.json`:
```json
{ "version": 1, "operators": 4, "speed": { "walk": 1.3, "move": 2.4 }, "stackOffsetM": 0.7,
  "roomS": { "deliberate": 5, "dynamic": 2 }, "breachS": 3, "stageDistanceM": 30,
  "contact": { "surrenderBase": 0.55, "negotiationTrust": 0.35, "dynamicSurprise": 0.15, "lessLethal": 0.1, "hostagePenalty": 0.15, "armedPenalty": 0.15,
               "hostageInjuryBase": 0.1, "hostageInjuryDynamic": 0.1, "subjectInjuryLessLethal": 0.3 },
  "colors": { "top": 1316380, "bottom": 1316380 } }
```

### 9.2 Pure FSM (`src/backup/fsm.ts`) — mandatory tests
```ts
export type BackupState = 'exiting' | 'approach' | 'cover' | 'secondary' | 'chase' | 'detain' | 'post' | 'standby' | 'returning' | 'gone' | 'swat';
export type BackupRole = 'cover' | 'secondary' | 'post' | 'standby' | 'swat';
export interface OfficerFsm { state: BackupState; role: BackupRole; timer: number }
export interface FsmInputs {
  dt: number;
  /** The unit is still assigned to the player's call and within reach. */
  onCall: boolean;
  /** Distance to the current goal spot (m). */
  goalDistance: number;
  /** A secondary subject is fleeing (role secondary) / the chase target was caught or lost. */
  runner: boolean;
  caught: boolean;
  lost: boolean;
  /** A player command for this officer this step, else null. */
  command: 'cover' | 'secondary' | 'detain' | 'standby' | 'release' | 'regroup' | null;
  /** A post assigned (command module). */
  post: boolean;
  /** The detain target is cuffed. */
  detained: boolean;
  /** Back at the car (returning). */
  atCar: boolean;
}
export interface FsmOutput { changed: boolean; /** callout to schedule this step */ callout: 'covering' | 'runner' | 'inCustody' | null }
/** Mutates `s`; pure apart from `s`. */
export function stepOfficerFsm(s: OfficerFsm, i: FsmInputs, cfg: BackupConfig, out: FsmOutput): FsmOutput;
/** Role for the k-th officer (arrival order) on the call: 0 cover, 1 secondary, others standby. */
export function initialRole(k: number): BackupRole;
```
Transition table (first match wins each step):
1. `!onCall` and state ∉ {returning, gone, swat} → `returning`.
2. `returning`: `atCar` → `gone`.
3. `exiting`: `timer += dt`; ≥ `spawn.exitS` → `approach`.
4. `command`: `release` → `returning`; `cover` → role cover, `approach`; `secondary` → role secondary, `approach`;
   `standby`/`regroup` → role standby, `approach`; `detain` → `detain`.
5. `post` true and role ≠ post → role `post`, `approach`; `post` false and role post → role standby, `approach`.
6. `approach`: `goalDistance ≤ move.arriveM` → state = role (cover / secondary / post / standby); entering `cover`
   emits callout `covering`.
7. `secondary`: `runner` → `chase` (callout `runner`).
8. `chase`: `caught` → `detain`; `lost` → `approach` (role secondary).
9. `detain`: `detained` → callout `inCustody`, then role / state back to `approach`.
10. `cover` / `secondary` / `post` / `standby`: `goalDistance > 1.5` → `approach` (the goal moved).
Tests: every row; a full sequence exit → approach → cover with the covering callout; release → returning → gone;
runner → chase → detain → inCustody; post assignment and removal.

### 9.3 Geometry (`src/backup/geometry.ts`, pure) — tests
```ts
/** Cover spot for an officer covering the player (px, pz) talking to subject (sx, sz): rotate the subject→player vector by ±angle (side = +1 / -1, the side away from traffic chosen by the caller), at `distance` from the subject. */
export function coverSpot(px: number, pz: number, sx: number, sz: number, angleRad: number, distance: number, side: 1 | -1, out: { x: number; z: number; yaw: number }): void;
/** Poor position (mistake): on the line beyond the subject (crossfire, angle poorAngleDeg) at poorDistanceM. */
export function poorCoverSpot(px: number, pz: number, sx: number, sz: number, cfg: BackupConfig, out: { x: number; z: number; yaw: number }): void;
/** 0..1: 1 = ideal 45-60° and 4.5-6.5 m; 0 = in the crossfire line or < 2 m. */
export function positionQuality(px: number, pz: number, sx: number, sz: number, ox: number, oz: number, cfg: BackupConfig): number;
```

### 9.4 Runtime (`src/backup/backupSystem.ts`)
```ts
export interface BackupNpcPort {
  actorIds(out: number[]): number[];
  actor(id: number, out: ActorInfo): ActorInfo | null;
  actorsOfCall(callId: number, out: number[]): number[];
  evaluateCommand(id: number, cmd: NpcCommand, ctx: CommandContext): CommandOutcome;
  applyCommand(id: number, cmd: NpcCommand, outcome: CommandOutcome): void;
  forceState(id: number, state: 'handsUp' | 'kneel' | 'prone' | 'hold' | 'leave'): void;
  cuff(id: number): 'ok' | 'resist' | 'notReady';
  tackle(officerX: number, officerZ: number, officerYaw: number, building?: number): number;
  incapacitate(id: number, seconds: number, by: 'beanbag' | 'strike'): boolean;
  actorsInBuilding(buildingId: number, out: number[]): number[];
}
export interface BackupDeps {
  readonly seed: number;
  readonly bus: EventBus<EventMap>;
  /** session.rng.stream('backup'). */
  readonly rng: Rng;
  readonly roster: RosterState;
  readonly cad: CadState;
  readonly npc: BackupNpcPort;
  /** Pose of a unit's car (AI patrol via the dispatcher's fleet index, resource via resources.unitPose); false when absent. */
  unitCar(callsign: string, out: { x: number; z: number; yaw: number }): boolean;
  /** Interiors (SWAT): layout, door states. */
  readonly interiors: InteriorQuery;
  /** Queues an interior door request (SWAT breach: 'ram'; open: 'open'). */
  doorRequest(buildingId: number, door: number, action: 'open' | 'ram' | 'kick'): void;
  /** Building footprint and front door (BuildingIndex.building). */
  building(id: number): { minX: number; minZ: number; maxX: number; maxZ: number; door: { x: number; z: number; yaw: number } } | null;
  /** The call's bound building (scene.callOfBuilding inverse: the scenario's buildingId), -1 none. */
  callBuilding(callId: number): number;
  /** SWAT unit callsigns on scene of the call (resources.onSceneUnits(callId, 'swat')). */
  swatOnScene(callId: number): number;
  /** The SWAT negotiation trust 0..1 of the call (command), 0 when none. */
  negotiationTrust(callId: number): number;
  readonly config?: BackupConfig;
  readonly swatConfig?: SwatConfig;
}
export interface BackupContext {
  x: number; z: number; yaw: number; building: number; onFoot: boolean;
  /** The player's CAD call, 0 none. */
  callId: number;
  /** Person id of the player's open contact (contact.active), -1 none: the cover target. */
  contactPersonId: number;
  /** Current game seconds (roster minute tick is the integrator's). */
  game: number;
}
export type BackupRequest =
  | { readonly kind: 'command'; readonly callsign: string | 'all'; readonly command: 'cover' | 'secondary' | 'detain' | 'standby' | 'release' | 'regroup'; readonly targetPersonId?: number }
  | { readonly kind: 'post'; readonly id: string; readonly x: number; readonly z: number; readonly yaw: number; readonly postKind: 'inner' | 'tcp' | 'evac' }
  | { readonly kind: 'clearPosts'; readonly postKind?: 'inner' | 'tcp' | 'evac' }
  | { readonly kind: 'swat'; readonly callId: number; readonly command: SwatCommand; readonly plan?: Partial<SwatPlan> };
export interface BackupOfficerView { callsign: string; name: string; role: BackupRole; state: BackupState; stress: number; fatigue: number; loyalty: number; quality: number; post: string | null }

export class BackupSystem implements BackupPort {
  constructor(deps: BackupDeps);
  step(dt: number, t: CadTime, ctx: BackupContext): void;   // order -665
  request(r: BackupRequest): void;
  officers(): readonly BackupOfficerView[];
  /** Force port fellows: on-foot officers (name, x, z, building -1, callsign, misconductChance = 1 when this arrival rolled the excessiveForce mistake, else 0: the deterministic roll decides, the force module only needs a restrained, previously violent subject nearby). Reused array. */
  fellows(): readonly FellowOfficer[];
  /** True while an officer of `callsign` is on foot (dispatcher hold). */
  onFoot(callsign: string): boolean;
  /** Officers + SWAT operators. */
  readonly view: HumanoidSource & { count: number };
  readonly revision: number;
  serialize(): BackupSave;
  restore(s: BackupSave): void;
  dispose(): void;
  // + BackupPort (§4.5): staffPost, clearPosts, staffed, swat, swatPhase
}
```
Step algorithm:
1. **Spawn.** For every CAD unit with `kind 'ai'` (patrol) or a resource unit of type `supervisor` / `lieutenant` /
   `chief` / `statePatrol` (ranked + state units also get out), status `onScene`, `callId === ctx.callId !== 0`,
   car pose available and within `maxCarDistanceM` of the player, not yet on foot, and fewer than `maxOfficers` on
   foot: create an officer at the car's driver door (car pose + 1.2 m left of the heading), state `exiting`, role
   `initialRole(k)` (supervisors always `standby`), `seq = roster.nextArrival(callsign)`, `mistakes = rollMistakes(seed,
   callsign, seq, mistakeChances(profile.traits, dynamic))` — each rolled mistake emits `backup:mistake` when it first
   shows (late callout: at the first callout; poor position: on reaching cover; excessive force: when the system sees
   a `force:other` whose `officer` equals this officer's name) and `roster.noteMistake`. Figure colours: uniform from `tactics.json`
   partner colours, skin / hair / height from the profile.
2. **Goals.** cover: target = the contact person's actor (else the nearest actor of the call within 25 m that is not
   cuffed, else the player); goal = `coverSpot(...)` with the profile-chosen side (side = +1 when `hash(callsign)` even)
   or `poorCoverSpot` when `poorPosition` was rolled; recomputed every `repositionS`. secondary: target = the nearest
   actor of the call within `detectRange` that is not the contact person, not cuffed and not the cover target; goal
   = `standoffM` from it toward the player; every `commandEveryS` issue `showHands` then `stop` (`evaluateCommand` with
   `{ tone: 'commanding', rapport: 0, commMode: 'verbal', weapon: 'sidearm', backup: officers on scene, lights: false }`
   + `applyCommand`). A target in state `flee` sets `runner`. chase: run at `chase.chase` toward the runner; within
   `tackleRangeM` → `npc.tackle(x, z, yaw)` (the caught id ≠ 0 → `caught`); farther than `giveUpM` from the player →
   `lost`. detain: walk to the target; when within 1.2 m and the actor state is handsUp / kneel / prone / down or
   incapacitated → `npc.cuff(id)`; `ok` → `backup:custody` + `detained`. post: the assigned post spot. standby: 3 m
   behind the player's right shoulder. Movement: straight line at walk / run (run when > 6 m), yaw toward the goal,
   writes the view (POSE walk / run / aim when covering with a weapon threat, HELD sidearm when the target is armed
   or fighting, else none).
3. **Observations and callouts** (4 Hz): weapon (an actor of the call within `weaponRangeM` of the officer with
   `weaponDrawn`), second subject (a new actor of the call within `detectRange` that is neither contact nor cover
   target), runner (FSM), hands clear (the cover target was searched / `handsUp` for the first time), fight (actor
   state `fight`). Each kind once per target per `cooldownS`; delay `callout.delayS` (or `lateDelayS` with the
   `lateCallout` mistake); text = a template from data (`rng.pick` on the backup stream), placeholders `{side}`
   (left / right from `rng`), `{weapon}` (the actor's weapon item id → 'gun' for firearms, 'knife'), `{desc}`
   (`'male'`/`'female'` + age decade from people via the integrator? — keep: "subject"), `{spot}` ('car', 'curb',
   'house'), `{dir}` (compass of the runner's yaw), `{street}` (left as 'the street'). Emit `backup:callout` and
   `backup:radio` (`channel: 'current'`, speaker = the officer's callsign, priority for weapon / runner).
4. **Stress** (every `stress.sampleS`): officers within 25 m of a `fight` → `roster.applyEvent(cs, 'fight')` once per
   actor; weapon seen → `weaponSeen` once per actor; subscribed bus events: `npc:attack` (kind fire within 60 m →
   `shotsFired`), `force:applied` within 20 m → `forceUsed`; `scene:pursuit` vehicle active → each officer en route
   `pursuitMinute` per game minute (integrator ticks; keep simple: once per pursuit). When the player is within 15 m
   of an officer during a `fight` → `coveredByPlayer` once per call; when the player is > 200 m from the call while
   officers are on foot for > 60 s → `abandoned` once per call. On `force:intervened` for an episode whose officer
   name matches → `intervenedOnThem`.
5. **Release.** When the CAD unit leaves the call (status / callId changed) the officer returns to the car (run) and
   is removed at the car (`gone`); the dispatcher's hold port (`onFoot(callsign)`) keeps the car waiting.
6. **Posts** (`staffPost`): picks the on-foot officer with role standby (else secondary, never cover) nearest to the
   post; else null (the command module then requests more backup). `staffed(kind)` = officers within
   `post.staffedM` of their post.

### 9.5 SWAT team (`src/backup/swat.ts`)
```ts
export type SwatCommand = 'stage' | 'stack' | 'breach' | 'clear' | 'hold' | 'withdraw';
export type SwatPhase = 'enRoute' | 'staging' | 'stacked' | 'breaching' | 'clearing' | 'holding' | 'done' | 'withdrawn';
export interface SwatPlan { entry: 'front' | 'rear'; tempo: 'deliberate' | 'dynamic'; lessLethal: boolean }
/** Pure: chance the subject surrenders on contact, and injury chances. */
export function swatContactOdds(plan: SwatPlan, s: { armed: boolean; hostage: boolean; negotiationTrust: number }, cfg: SwatConfig): { surrender: number; hostageInjury: number; subjectInjury: number };
/** Pure: rooms to clear in order: BFS over layout.roomDoors from the entry room, passing doors that are not locked (locked ones are breached: included). */
export function clearOrder(layout: InteriorLayout, entryRoom: number): number[];
/** Pure: the exterior door for the plan ('front' = the door marked main / with b === -1 nearest to building.door; 'rear' = the exterior door farthest from it), -1 none. */
export function entryDoor(layout: InteriorLayout, entry: 'front' | 'rear', frontX: number, frontZ: number): number;
```
`swatContactOdds`: `surrender = clamp(surrenderBase + negotiationTrust * trust + (dynamic ? dynamicSurprise : 0) +
(lessLethal ? lessLethal : 0) - (hostage ? hostagePenalty : 0) - (armed ? armedPenalty : 0), 0.05, 0.95)`;
`hostageInjury = hostage ? hostageInjuryBase + (dynamic ? hostageInjuryDynamic : 0) : 0`; `subjectInjury =
lessLethal ? subjectInjuryLessLethal : 0` (the remaining non-surrender outcome is "subdued").

Team runtime (one team, the call with a SWAT unit on scene): operators spawn beside the tactical truck when
`swatOnScene(callId) > 0` (phase `staging`, they walk to a staging point `stageDistanceM` from the building door on the
truck's side). Commands (queued; invalid ones answer `backup:swat` with a refusal text):
- `stage` → walk back to staging.
- `stack` → walk to the exterior side of the entry door: operators in a line `stackOffsetM` apart along the wall
  (partner `stackSpot` logic, outdoors) → `stacked`.
- `breach` (from stacked) → `doorRequest(building, door, 'ram')` (locked) or `'open'`; after `breachS` → `breaching`
  done → operators move to the interior entry (`layout.entry`, y = INTERIOR_FLOOR_Y, building = id) → `clearing`.
- `clear` (from stacked: implies breach; from holding: continue) → room by room in `clearOrder`: the team walks to the
  room centre (`findPath`, passable unless locked; a locked inner door gets `doorRequest(..., 'ram')` and `breachS`),
  each room takes `roomS[tempo]`; when the subject actor (`actorsInBuilding`, role subject) is in the room →
  contact: roll `swatContactOdds` on the backup stream: surrender → `npc.forceState(id, 'handsUp')`, cuff (repeat
  `cuff` until ok) → `backup:custody` + `backup:swat` "Suspect in custody"; else subdued → `npc.incapacitate(id, 8,
  lessLethal ? 'beanbag' : 'strike')`, cuff, custody, with `subjectInjury` → integrator `people.setInjured` via the
  `backup:swat` text only (no extra port: keep injury out); hostage actor in the house: with `hostageInjury` the
  hostage is wounded (`backup:swat` text "Hostage injured", the command module notes it). Each cleared room:
  `backup:swat` "Room <n> clear". All rooms → `done` ("Building clear") and the operators walk out to staging.
- `hold` → stop where they are (`holding`); `withdraw` → walk out to staging (`withdrawn`).
- Plan changes apply when given with any command (entry ignored after the breach).
The operators are part of `view` (top / bottom from data, HELD rifle shown as `HELD.handgun`, POSE aim while
clearing). Radio: every `backup:swat` text also goes out as `backup:radio` on `tac`, speaker `TAC-1`.

### 9.6 Save (`src/backup/save.ts`)
```ts
export interface BackupSave {
  version: 1;
  rng: RngState;
  officers: { callsign: string; callId: number; fsm: { state: BackupState; role: BackupRole; timer: number }; x: number; z: number; yaw: number; building: number;
              seq: number; mistakes: [boolean, boolean, boolean]; targetActor: number; post: { id: string; x: number; z: number; yaw: number; kind: string } | null;
              sideSign: 1 | -1; nextCallout: number; calledOut: [number, string, number][] /* actorId, kind, sim */; flags: number }[];
  pendingCallouts: { callsign: string; kind: string; text: string; dueSim: number; priority: boolean }[];
  swat: { callId: number; phase: SwatPhase; plan: SwatPlan; building: number; door: number; rooms: number[]; roomIdx: number; timer: number;
          ops: [number, number, number, number][] /* x, z, yaw, building */ } | null;
  requests: BackupRequest[];
}
export function isBackupSave(x: unknown): x is BackupSave;
export function emptyBackupSave(rng: RngState): BackupSave;
```

### 9.7 Tests (`test/backup/**`) — mandatory
- FSM table (§9.2) incl. the full sequences.
- **Mistakes deterministic per seed**: with a fake roster officer at high stress, two `BackupSystem`s on the same seed
  produce the same mistakes, positions (poor cover spot) and callout delays; seed 2 differs for at least one of 10
  officers (vary callsigns); a calm officer (stress 0, fatigue 0, high experience) gets no mistakes in 50 seqs at the
  shipped weights (chance < 0.02 → assert ≤ 2 hits).
- Geometry: cover spot angle / distance, poor spot on the line, `positionQuality` 1 / 0 cases.
- Runtime with fakes: an AI unit onScene → officer exits, takes cover at the right spot, emits `covering` callout
  once; a second unit takes secondary and commands a passenger; the passenger flees → chase, tackle, cuff,
  `backup:custody`; weapon callout delayed by `lateDelayS` when the mistake is rolled; `fellows()` lists on-foot
  officers with the excessive-force-raised chance; release → returning → gone; posts staffed / cleared.
- SWAT: `clearOrder` BFS on a generated house layout (`generateInterior(42, building)` via `test/interior/helpers.ts`),
  `entryDoor` front / rear, `swatContactOdds` numbers; a runtime test stacking, breaching (door request seen) and
  clearing to `done` with a fake subject that surrenders (stream fixed).
- Save round trip; determinism of two 1500-step runs.
- Perf: 8 officers + 4 operators: `step` ≤ 0.05 ms average.

## 10. Pursuit system [pursuit] — wave 2

Owns `src/pursuit/**`, `src/data/pursuit/**`, `test/pursuit/**`. Imports units (payload types, `estimateResponse`),
traffic types (`FleeInfo`, `Blockade` additions), hooks additions (`PursuitOrderEvent`, `SceneRequest`), world
`RoadGraph`.

### 10.1 Data (`src/data/pursuit/pursuit.json`)
```json
{ "version": 1,
  "pit": { "minMph": 20, "maxMph": 45, "maxRelMph": 12, "rearZoneFrac": 0.3, "lateralMinFrac": 0.25, "maxHeadingDeg": 30,
           "ramMph": 25, "forbiddenModels": ["city_bus", "box_truck"], "requiresAuthorization": true, "allowedOffenses": ["violent", "felonyVehicle", "weapons", "warrant"] },
  "spikes": { "lengthM": 6, "aheadJunctions": 2, "setbackM": 25, "expireS": 120, "playerDeployRangeM": 6, "tiresOnHit": 2 },
  "boxIn": { "maxSuspectMph": 10, "radiusM": 25, "minAiUnits": 2, "requirePlayer": true },
  "roadblock": { "aheadM": 100, "lateralM": 12, "minUnits": 2, "decelMps2": 1.5, "stopMps": 2 },
  "risk": { "overLimitPer10Mph": 0.08, "district": { "downtown": 0.2, "campus": 0.25, "hospital": 0.2, "suburbs": 0.12, "park": 0.15 },
            "wet": 0.1, "night": 0.05, "density": 0.15, "perMinute": 0.04, "nonViolent": 0.15, "lostSight": 0.25, "airUnitRelief": -0.2 },
  "supervisor": { "monitorDelayS": 20, "riskTerminate": 0.75, "riskTerminateNonViolent": 0.5, "lostSightS": 30, "checkS": 1, "repeatS": 30 },
  "perimeter": { "radiusM": 200, "posts": 4, "postNearM": 50, "escapeM": 260, "requestK9": true, "requestAir": true, "lostSightS": 10 },
  "handoff": { "cityLimits": { "minX": -2560, "maxX": 2560, "minZ": -2560, "maxZ": 2560 }, "requestAheadS": 60, "takeoverM": 600,
               "resolveS": [60, 180], "catchChance": 0.7, "removeAfterS": 60 },
  "follow": { "replanS": 3 },
  "air": { "trackM": 300 } }
```

### 10.2 Pure functions — mandatory tests
```ts
// src/pursuit/pit.ts
export interface CarPose { x: number; z: number; yaw: number; speed: number; halfLength: number; halfWidth: number }
export interface ContactResult { kind: 'pit' | 'ram' | 'bump' | 'none'; dir: 1 | -1; relMph: number; reasons: string[] }
/**
 * Classifies a contact between the police car `p` and the suspect `s` (yaw convention: 0 = facing -Z, forward =
 * (-sin yaw, -cos yaw)). Contact point = p's front centre (p + forward * halfLength). In s's local frame:
 * along = dot(c - s, fwdS), lateral = dot(c - s, rightS) (rightS = (cos yaw, -sin yaw)).
 * PIT when: along <= -halfLengthS * (1 - 2 * rearZoneFrac) (rear rearZoneFrac of the body), |lateral| >= halfWidthS * lateralMinFrac,
 * |heading difference| <= maxHeadingDeg, relative speed |vP - vS| (along the headings, mph) <= maxRelMph and
 * suspect speed in [minMph, maxMph]. dir = lateral > 0 ? 1 : -1 (pushing the right rear spins clockwise).
 * Else ram when relMph >= ramMph, else bump. Reasons list the failed geometric checks (for the HUD).
 */
export function classifyContact(p: CarPose, s: CarPose, cfg?: PursuitConfig): ContactResult;
export interface PitPolicyInput { speedMph: number; offense: string | null; authorized: boolean; modelId: string; district: string; wet: boolean }
/** Policy: speed <= maxMph, offense in allowedOffenses, authorized when requiresAuthorization, model not forbidden, not wet and downtown/campus together. */
export function pitPolicy(i: PitPolicyInput, cfg?: PursuitConfig): { verdict: 'withinPolicy' | 'outsidePolicy'; reasons: string[] };

// src/pursuit/risk.ts
export interface RiskInput { speedMph: number; limitMph: number; district: string; wet: boolean; night: boolean; trafficDensity: number;
  durationS: number; offense: string | null; violentOffenses: readonly string[]; lostSightS: number; airOnTarget: boolean }
/** 0..1: overLimitPer10Mph * max(0, speed - limit) / 10 + district + wet + night + density * trafficDensity + perMinute * minutes + (nonViolent when offense not violent) + (lostSight when lostSightS > 0) + (airUnitRelief when air on target), clamped. */
export function pursuitRisk(i: RiskInput, cfg?: PursuitConfig): number;
export interface DecisionInput extends RiskInput { allowedOffenses: readonly string[]; maxDurationS: number; supervisorMonitoring: boolean; monitoringS: number }
export type PursuitDecision = { action: 'continue'; reason: '' } | { action: 'terminate'; reason: string };
/**
 * Termination rules, first match wins (only when supervisorMonitoring && monitoringS >= monitorDelayS; else continue):
 * 1 offense known and not in allowedOffenses → "pursuit not authorized for this offense";
 * 2 durationS > maxDurationS → "time limit reached";
 * 3 lostSightS >= lostSightS limit and !airOnTarget → "lost visual, no air support";
 * 4 risk >= riskTerminate → "risk to the public too high";
 * 5 offense not violent and risk >= riskTerminateNonViolent → "risk outweighs a non-violent offense";
 * else continue.
 */
export function pursuitDecision(i: DecisionInput, cfg?: PursuitConfig): PursuitDecision;

// src/pursuit/tactics.ts
export function canBoxIn(suspect: { x: number; z: number; yaw: number; speedMph: number }, police: readonly { x: number; z: number; player: boolean }[], cfg?: PursuitConfig): { ok: boolean; reason: string };
/** Units ahead: dot((u - s), fwd) in (0, aheadM] and |lateral| <= lateralM. */
export function unitsAhead(suspect: { x: number; z: number; yaw: number }, police: readonly { x: number; z: number }[], cfg?: PursuitConfig): number;

// src/pursuit/strips.ts
export interface Strip { id: number; x0: number; z0: number; x1: number; z1: number; placedSim: number; owner: string; active: boolean }
/** Segment (ax, az)→(bx, bz) crosses the strip segment (proper or touching intersection). */
export function crossesStrip(ax: number, az: number, bx: number, bz: number, s: Strip): boolean;
/** A strip across the lanes of the travel direction at distance `along` before `node` on `edge` (perpendicular to the edge, length lengthM, centred on the travel half of the road). */
export function stripAcrossEdge(graph: RoadGraph, edge: number, towardNode: number, setbackM: number, lengthM: number, out: Strip): boolean;

// src/pursuit/predict.ts
/** The node sequence a fleeing car is likely to take: from its edge's end node in travel direction, at each junction the outgoing edge with the smallest heading change (ties by edge id), `steps` junctions; returns nodes (allocates; 1 Hz). */
export function predictPath(graph: RoadGraph, edge: number, x: number, z: number, yaw: number, steps: number): number[];

// src/pursuit/perimeter.ts
/** Up to `n` road nodes around (x, z) at about radiusM: for each of n equal sectors the node in the sector whose distance is nearest radiusM (graph.nodesNear(x, z, radiusM * 1.5)); sectors without a node are skipped. */
export function perimeterPosts(graph: RoadGraph, x: number, z: number, radiusM: number, n: number): { x: number; z: number; node: number }[];

// src/pursuit/jurisdiction.ts
export function inCity(x: number, z: number, cfg?: PursuitConfig): boolean;
/** Seconds until the point leaves the city limits moving at speed along yaw (straight line), Infinity when never. */
export function timeToBoundary(x: number, z: number, yaw: number, speedMps: number, cfg?: PursuitConfig): number;
```
Tests (`test/pursuit/policy.test.ts`, `pit.test.ts`, `tactics.test.ts`, required): PIT classification for a textbook
rear-quarter push (both sides → dir), a T-bone (not PIT, ram at speed), a head-on, a too-fast suspect (reason), a
low-speed rear tap (bump); `pitPolicy` each reason incl. unauthorized and forbidden model; `pursuitRisk` component
sums and clamp; **every `pursuitDecision` rule** incl. the "not monitoring" and "monitor delay" gates and rule order;
`canBoxIn` (speed too high, too few units, ok); `unitsAhead`; `crossesStrip` (cross, miss, parallel, touching
endpoint); `stripAcrossEdge` on a generated city edge is perpendicular and centred; `predictPath` straight on a grid;
`perimeterPosts` count ≤ n and distances near the radius; `timeToBoundary`.

### 10.3 Runtime (`src/pursuit/pursuitSystem.ts`)
```ts
export interface PursuitDeps {
  readonly seed: number;
  readonly bus: EventBus<EventMap>;
  /** session.rng.stream('pursuit'). */
  readonly rng: Rng;
  readonly graph: RoadGraph;
  readonly cad: CadState;
  readonly traffic: {
    fleeInfo(vehicleId: number, out: FleeInfo): boolean; deflate(vehicleId: number, tires: number): boolean; spinOut(vehicleId: number, dir: 1 | -1): boolean;
    crashCar(vehicleId: number): boolean; setFleeSpeedCap(vehicleId: number, capMps: number): boolean; setFleeTracked(vehicleId: number, tracked: boolean): boolean;
    stopFlee(vehicleId: number): boolean; removeVehicle(vehicleId: number): boolean; slotOfVehicle(vehicleId: number): number;
    fleetState(index: number, out: FleetState): FleetState | null;
  };
  readonly dispatcher: { directUnit(cs: string, x: number, z: number, u: 'respond' | 'emergency'): boolean; undirectUnit(cs: string): void; aiUnitsOnCall(callId: number, out: string[]): string[]; sendBackup(code: 2 | 3, n: number): string[] };
  readonly resources: ResourcePort;
  readonly scene: { request(r: SceneRequest): void };
  readonly npc: { actorOfPerson(personId: number): number; actor(id: number, out: ActorInfo): ActorInfo | null; forceState(id: number, s: 'handsUp'): void };
  readonly rules: PursuitRulesPort;
  /** Registry model id of a vehicle (vehicleRecord(seed, id).modelId). */
  modelOf(vehicleId: number): string;
  /** District name and effective limit at (x, z). */
  roadAt(x: number, z: number): { district: string; limitMph: number };
  env(): { wet: boolean; night: boolean };
  trafficDensity(x: number, z: number): number;
  readonly config?: PursuitConfig;
}
export interface PursuitContext {
  /** The player's driven police car, or null on foot. */
  car: CarPose | null;
  carId: number;               // entity id of the driven car (collision `other`), 0 none
  lights: boolean; siren: boolean;
  onFoot: boolean; x: number; z: number; yaw: number;
  /** The officer carries a spike strip (OfficerKit). */
  carryingStrip: boolean;
  playerCallsign: string;
}
export type PursuitRequest =
  | { readonly kind: 'requestPit' }            // ask the supervisor for PIT authorization
  | { readonly kind: 'spikesAhead' }           // an AI unit deploys strips ahead
  | { readonly kind: 'deployStrip' }           // the player (on foot, carrying) deploys at the nearest road
  | { readonly kind: 'boxIn' }
  | { readonly kind: 'roadblock' }
  | { readonly kind: 'air' }
  | { readonly kind: 'perimeter' };
export class PursuitSystem {
  constructor(deps: PursuitDeps);
  step(dt: number, t: CadTime, ctx: PursuitContext): void;   // order -678
  request(r: PursuitRequest): void;
  /** Ports the integrator needs. */
  takeStripFromKit: (() => boolean) | null;        // set by the integrator: consumes one carried spike strip
  burstPlayerTires: (() => void) | null;           // set by the integrator: drivenVehicle.burstTire(0) + (1)
  active(): boolean;
  hud(): PursuitHud | null;
  menu(): readonly { id: PursuitRequest['kind']; label: string; enabled: boolean; hint: string }[];
  strips(): readonly Strip[];
  readonly revision: number;
  serialize(): PursuitSave;
  restore(s: PursuitSave): void;
  dispose(): void;
}
export interface PursuitHud { line: string /* 'PURSUIT · 62 mph · risk 0.48 · SGT-1 monitoring · AIR on target' */; verdict: string | null /* last tactic verdict */ }
```
Event intake (bus handlers enqueue): `scene:pursuit` (vehicle start: track `{ callId, vehicleId (CAD call vehicles[0]),
personId, startSim }`; vehicle end: stop tracking, release directed units (`undirectUnit`), clear caps / tracked,
remove strips after 10 s; foot start within 30 s of the vehicle pursuit's crash end by the same person → foot bail:
`bail = { personId, actorId, x, z, sinceSim }`), `traffic:collision` with `fleeing: true` and `other === ctx.carId`
(queue the contact), `pursuit:order` is emitted by this module only.

Per step (vehicle pursuit active):
1. **Contact** (queued): `classifyContact(ctx.car, suspectPose)`: `pit` → `pitPolicy({ authorized: this.pitAuthorized,
   ... })` → `traffic.spinOut(vehicleId, dir)`; emit `pursuit:tactic` (pit, verdict) and HUD verdict "PIT: within
   policy" / "PIT: outside policy — <reason>"; `ram` → `traffic.crashCar` + tactic (ram, outsidePolicy "Ramming");
   `bump` → nothing (flash "Contact, no effect").
2. **Strips**: for each active strip: `crossesStrip(prevSuspect, suspect, s)` → `traffic.deflate(vehicleId,
   spikes.tiresOnHit)`, strip inactive, radio "<owner>, spikes hit, he's losing tyres", tactic success. The player's
   driven car crossing an active strip → `burstPlayerTires()` and flash "You drove over your own spike strip".
   Strips expire after `expireS`.
3. **Spikes ahead** (request): pick the AI unit on the pursuit call with the best ETA to the target node = the
   `aheadJunctions`-th node of `predictPath` (estimate via `estimateResponse` with `routeBetweenPoints` from the unit's
   car); `directUnit(cs, node.x, node.z, 'emergency')`; when that unit's fleet car is parked / within 30 m of the node
   (check 1 Hz) and the suspect is still ≥ 80 m away and heading toward the node → place a strip with
   `stripAcrossEdge(graph, the edge of the predicted path entering the node, node, setbackM, lengthM)`; radio "<cs>,
   spikes deployed at <near>". If the suspect passes the node first → tactic failed, undirect.
4. **Deploy strip (player)**: on foot, `carryingStrip`, nearest road edge within `playerDeployRangeM`: strip across the
   lane at the projection, perpendicular to the edge, owner = the player callsign; `takeStripFromKit()` must return
   true.
5. **Box-in** (request): `canBoxIn(suspect, AI cars on the call + the player car)` → `traffic.stopFlee(vehicleId)` +
   tactic success, else flash the reason (tactic failed).
6. **Roadblock** (request): direct up to 3 AI units to the 2nd predicted node (`'emergency'`); while
   `unitsAhead(...) >= minUnits`: cap -= `decelMps2 * dt` from the current speed (`setFleeSpeedCap`); below `stopMps`
   → `stopFlee` + tactic success. The roadblock is cancelled when the suspect leaves the predicted path.
7. **Air** (request or auto when `perimeter.requestAir` on a bail): `resources.requestType('air', callId, 'radio')`;
   every step while the air unit exists: `setAirTarget('vehicle', vehicleId, ...)`; `air.onTarget` and within
   `air.trackM` → `traffic.setFleeTracked(vehicleId, true)` else false.
8. **Supervisor** (every `checkS`): `sup = resources.supervisorFor(callId)`; `monitoringS` from the first step it is
   non-null; build `DecisionInput` (speed / limit from `fleeInfo` + `roadAt`, `lostSightS` = seconds the player was >
   250 m from the suspect, `airOnTarget`, offense from `rules.offense`, `allowedOffenses`, `maxDurationS`);
   `pursuitDecision` → terminate (at most once per `repeatS`): emit `pursuit:order` (`order: 'terminate', by: sup,
   text: "<sup> to <unit>, terminate the pursuit — <reason>."`) and `pursuit:radio` (priority, speaker sup, dispatch
   channel). The player complies by switching the light bar off (Phase 5 path → scene terminatePursuit); after
   `rules.terminateGraceS()` without compliance flash "Supervisor order ignored" once.
   PIT authorization (`requestPit`): no supervisor → radio "No supervisor available, PIT not authorized" (denyPit);
   else `pitPolicy` without the authorization check → `authorizePit` / `denyPit` order with the reason; the grant lasts
   until the pursuit ends.
9. **Handoff**: `ttb = timeToBoundary(suspect)`; when `inCity` and `ttb <= requestAheadS` and no state unit assigned →
   `resources.requestType('statePatrol', callId, 'auto')`; each step a state unit is on the call: `directTo(cs,
   suspect.x, suspect.z, 'emergency')` every `follow.replanS`. When the suspect is outside the city and a state unit
   is within `takeoverM` → emit `pursuit:order` (`handoff`) + `pursuit:handoff` + radio ("<state cs>, we have primary,
   <unit> you're clear"), `scene.request({ kind: 'terminatePursuit', reason: 'handoff' })`, keep tracking the car as a
   "state pursuit": after `rng.nextFloat(resolveS)` roll `catchChance` → `traffic.stopFlee` and radio "<state cs>,
   suspect in custody"; `removeVehicle` after `removeAfterS`; else the car is left to escape.
10. **Follow**: AI units on the pursuit call (not directed by a tactic) are directed to the suspect every
    `follow.replanS` (`directUnit(cs, suspect.x, suspect.z, 'emergency')`); undirected when the pursuit ends.
11. **Foot bail perimeter** (auto after `perimeter.lostSightS` with the runner > 60 m from the player, or on request):
    `posts = perimeterPosts(graph, bail.x, bail.z, radiusM, posts)`; for each post the nearest AI unit on the call
    (else `sendBackup(3, missing)` and assign as they come) is directed there; request K9 and air per data; radio
    "Units, setting a perimeter around <near>". Containment (4 Hz): runner actor beyond `radiusM - 20` from the centre
    with a post unit's car within `postNearM` → `npc.forceState(actor, 'handsUp')`, radio "Perimeter unit has the
    suspect at gunpoint", tactic perimeter success (the scene's foot pursuit ends when the runner stops running);
    beyond `escapeM` with no post near → the npc's own escape logic applies. Air target = the runner while bailed.
12. **Risk / HUD** at 1 Hz.

### 10.4 Save (`src/pursuit/save.ts`)
```ts
export interface PursuitSave {
  version: 1; rng: RngState;
  pursuit: { callId: number; vehicleId: number; personId: number; startSim: number; pitAuthorized: boolean; monitorSince: number; lastOrderSim: number;
             ordered: boolean; lostSince: number; prevX: number; prevZ: number; tactic: { kind: string; unit: string; node: number; sinceSim: number } | null;
             handoff: { unit: string; resolveAt: number; removeAt: number; done: boolean } | null } | null;
  bail: { personId: number; actorId: number; x: number; z: number; sinceSim: number; posts: [number, number, string][] } | null;
  strips: Strip[]; nextStripId: number; contacts: { relX: number; relZ: number }[] /* unused queue placeholder, may be [] */; requests: PursuitRequest[];
}
export function isPursuitSave(x: unknown): x is PursuitSave;
export function emptyPursuitSave(rng: RngState): PursuitSave;
```

### 10.5 Runtime tests (`test/pursuit/system.test.ts`)
With a real `generateCity(42)`, a real `TrafficSystem` + fake dispatcher / resources / scene: a fleeing car hit by a
fake contact queue → spinOut and the tactic event; strip ahead deflates when crossed; box-in stops a slow car;
supervisor terminate order emitted once after `monitorDelayS` for a non-allowed offense; PIT authorization request
granted / denied; handoff when the car leaves the city with a state unit near (scene request with reason handoff);
perimeter posts directed and a runner at the edge forced to handsUp; save / restore round trip; two identical runs →
identical saves. Perf: active pursuit step ≤ 0.02 ms average (excluding 1 Hz path predictions).

## 11. Incident command, triage, containment, negotiation [command] — wave 2

Owns `src/command/**`, `src/data/command/**`, `test/command/**`. Imports units (payload types), npc / people types,
world `RoadGraph` / `BuildingIndex` types, `DialogueView` type (`src/ui/dialogue/types.ts`, pre-existing), hooks
scene request types.

### 11.1 Data (`src/data/command/command.json`)
```json
{ "version": 1,
  "levels": { "families": { "barricade": "major", "activeAssailant": "major", "massCasualty": "disaster", "hazard": "incident" },
              "majorUnitsOnScene": 5 },
  "post": { "standoffM": 60, "autoOnArrival": true },
  "triage": { "roles": ["victim", "walkingWounded", "unconscious", "deceased", "hostage"], "assessS": 6, "rangeM": 2.2, "aiAssessS": 20, "aiErrorRate": 0.05 },
  "transport": { "order": ["immediate", "delayed", "minor"], "loadS": 45, "perUnit": { "immediate": 1, "delayed": 2, "minor": 3 } },
  "fire": { "extricateS": 90, "deconS": 60 },
  "tcp": { "radiusM": 140, "max": 4, "blockadeRadiusM": 8 },
  "evac": { "radiusM": { "hazmat": 220, "package": 160, "barricade": 70, "default": 120 }, "buildingS": 25, "fireFactor": 2, "segments": 12 },
  "inner": { "offsetM": 8 },
  "needs": { "emsPerImmediate": 1, "emsPerDelayed": 0.5, "firePerTrapped": 0.5, "fireHazmat": 1, "maxEms": 3, "maxFire": 2 },
  "negotiation": { "startTrust": 0.15, "startAgitation": 0.55, "surrenderTrust": 0.75, "surrenderAgitation": 0.35, "surrenderTurns": 2,
                   "breakdownAgitation": 0.95, "stallTurns": 25, "noiseSd": 0.03, "negotiatorBonus": 0.25 } }
```
`src/data/command/negotiation.json` (the dialogue content; categories are the panel topics):
```json
{ "version": 1,
  "categories": [
    { "id": "listen", "label": "Active listening", "options": [
      { "id": "minimal", "text": "I'm here. Go on.", "trust": 0.04, "agitation": -0.03, "stages": ["contact", "rapport", "problem"] },
      { "id": "label", "text": "It sounds like you feel nobody is listening to you.", "trust": 0.08, "agitation": -0.06, "stages": ["rapport", "problem"] },
      { "id": "paraphrase", "text": "So you're saying they took the kids and you've had enough.", "trust": 0.07, "agitation": -0.04, "stages": ["rapport", "problem"] },
      { "id": "openQuestion", "text": "What happened today?", "trust": 0.05, "agitation": -0.02, "stages": ["contact", "rapport"] },
      { "id": "pause", "text": "(stay silent and let them talk)", "trust": 0.03, "agitation": -0.05, "stages": ["rapport", "problem"] } ] },
    { "id": "problem", "label": "Problem solving", "options": [
      { "id": "iMessage", "text": "I get worried when I hear you talk about the gun.", "trust": 0.05, "agitation": -0.04, "stages": ["problem"] },
      { "id": "offer", "text": "If you put the gun down, I'll make sure you can talk to your sister.", "trust": 0.06, "agitation": -0.02, "stages": ["problem", "resolution"], "minTrust": 0.4 },
      { "id": "plan", "text": "Here's how this ends safely: you walk out, hands empty, and I'll be right there.", "trust": 0.06, "agitation": -0.05, "stages": ["resolution"], "minTrust": 0.6 } ] },
    { "id": "pressure", "label": "Pressure", "options": [
      { "id": "deadline", "text": "You have five minutes to come out.", "trust": -0.1, "agitation": 0.15, "stages": ["contact", "rapport", "problem", "resolution"] },
      { "id": "demand", "text": "Come out now with your hands up!", "trust": -0.06, "agitation": 0.12, "stages": ["contact", "rapport", "problem", "resolution"] },
      { "id": "threat", "text": "The tactical team is ready to come in.", "trust": -0.12, "agitation": 0.2, "stages": ["contact", "rapport", "problem", "resolution"] } ] }
  ],
  "replies": {
    "calm": ["...yeah. Yeah, okay.", "Nobody ever asked me that."],
    "neutral": ["I don't know.", "What do you want from me?"],
    "agitated": ["Back off! I swear!", "Don't come any closer!"],
    "surrender": ["Okay. Okay. I'm coming out. Don't shoot."],
    "breakdown": ["That's it! I'm done talking!"] },
  "toneFactor": { "polite": 1.1, "neutral": 1.0, "commanding": 0.8, "aggressive": 0.5 },
  "stageTrust": { "contact": 0, "rapport": 0.25, "problem": 0.45, "resolution": 0.65 },
  "subject": { "temperament": { "calm": -0.1, "timid": -0.05, "irritable": 0.05, "volatile": 0.15 }, "hostage": 0.05, "intoxicated": 0.08, "crisis": -0.05 } }
```

### 11.2 Pure functions — mandatory tests (incident command / triage)
```ts
// src/command/triage.ts
export type TriageTag = 'minor' | 'delayed' | 'immediate' | 'expectant';
export interface Vitals { walking: boolean; breathing: boolean; breathesAfterAirway: boolean; respRate: number; radialPulse: boolean; capRefillS: number; followsCommands: boolean; trapped: boolean; contaminated: boolean }
/**
 * START: walking → minor; not breathing → (breathesAfterAirway ? immediate : expectant); respRate > 30 → immediate;
 * !radialPulse or capRefillS > 2 → immediate; !followsCommands → immediate; else delayed.
 */
export function startTriage(v: Vitals): TriageTag;
/**
 * Pure per (seed, personId): rng = createRng(seed).stream('vitals:' + personId). Severity = role base (victim 0.6, walkingWounded 0.2,
 * unconscious 0.85, deceased 1, hostage 0.3) + injured * 0.3, clamped 0..1. Draw order: u1..u6 = rng.next() x6.
 * walking = severity < 0.3 && u1 < 0.9; breathing = role !== 'deceased' && !(severity > 0.9 && u2 < 0.5);
 * breathesAfterAirway = !breathing && role !== 'deceased' && u3 < 0.4; respRate = breathing ? round(12 + severity * 24 + u4 * 6) : 0;
 * radialPulse = breathing && !(severity > 0.6 && u5 < 0.5); capRefillS = round1(1 + severity * 2.5 * u6);
 * followsCommands = role !== 'unconscious' && role !== 'deceased' && severity < 0.8; trapped = flags.trapped && severity >= 0.4 && u1 >= 0.5;
 * contaminated = flags.hazmat.
 */
export function victimVitals(seed: number, personId: number, role: string, injured: number, flags: { trapped: boolean; hazmat: boolean }): Vitals;
/** Sort for transport: tag order immediate, delayed, minor (expectant never), then person id. */
export function transportOrder(v: readonly { personId: number; tag: TriageTag | null; transported: boolean; trapped: boolean; contaminated: boolean }[]): number[];
export const TRIAGE_COLORS: Readonly<Record<TriageTag, string>>;  // minor '#3a9d4a', delayed '#d8b31a', immediate '#c8322b', expectant '#202020'

// src/command/levels.ts
export function commandLevel(family: string, unitsOnScene: number, cfg?: CommandConfig): 'none' | 'incident' | 'major' | 'disaster';
/** Recommended additional resources: ems = min(maxEms, ceil(immediate * emsPerImmediate + delayed * emsPerDelayed)) - onSceneEms (≥ 0); fire = min(maxFire, ceil(trapped * firePerTrapped) + (hazmat ? fireHazmat : 0)) - onSceneFire (≥ 0); supervisor 1 when none. */
export function resourceNeeds(i: { immediate: number; delayed: number; trapped: number; hazmat: boolean; onSceneEms: number; onSceneFire: number; supervisor: boolean }, cfg?: CommandConfig): { ems: number; fire: number; supervisor: number };

// src/command/geometry.ts
/** Command post spot: standoffM from the incident along the direction from the incident to the player (or +X when equal), snapped to the nearest road point (graph.nearestEdge within 200 m). */
export function postSpot(graph: RoadGraph, ix: number, iz: number, px: number, pz: number, standoffM: number): { x: number; z: number };
/** Traffic control points: road nodes from graph.nodesNear(x, z, radiusM * 1.3) whose distance is within [0.6, 1.3] * radiusM and that have an incident edge whose other node is nearer to (x, z); sorted by distance to radiusM then node id; at most `max`; each with yaw facing the incident. */
export function tcpPoints(graph: RoadGraph, x: number, z: number, radiusM: number, max: number): { x: number; z: number; yaw: number; node: number }[];
/** Inner perimeter: the 4 footprint corners pushed out diagonally by offsetM, yaw facing the building centre. */
export function innerPosts(rect: { minX: number; minZ: number; maxX: number; maxZ: number }, offsetM: number): { x: number; z: number; yaw: number }[];
/** Evacuation progress 0..1: cleared building-seconds / (buildings * buildingS). */
export function evacProgress(clearedS: number, buildings: number, buildingS: number): number;
/** Closed 12-gon (segments from data) as a NoGoZone-shaped polygon (points x,z pairs) around (x, z). */
export function circleZone(id: number, x: number, z: number, r: number, segments: number): { id: number; points: Float32Array; minX: number; minZ: number; maxX: number; maxZ: number };

// src/command/negotiation.ts
export type NegStage = 'contact' | 'rapport' | 'problem' | 'resolution';
export interface NegState { trust: number; agitation: number; turns: number; goodTurns: number; stage: NegStage; outcome: 'ongoing' | 'surrender' | 'stalled' | 'breakdown'; lastReply: string; history: string[] }
export interface NegSubject { temperament: 'calm' | 'timid' | 'irritable' | 'volatile'; hostage: boolean; intoxicated: boolean; crisis: boolean }
export function newNegotiation(cfg?: CommandConfig): NegState;
/** Options available in the state's stage (and minTrust), per category. */
export function negotiationOptions(s: NegState, data?: NegotiationData): { category: string; label: string; options: { id: string; text: string; enabled: boolean; hint: string }[] }[];
/**
 * One turn (mutates s): option deltas d_t, d_a (an option not allowed in the stage counts as half and adds +0.05 agitation);
 * trust += d_t * toneFactor[tone] * (negotiatorOnScene ? 1 + negotiatorBonus : 1) + noise; agitation += d_a + subject bias (temperament
 * + hostage + intoxicated + crisis terms) * BIAS_WEIGHT (0.1: best play wins against every subject) + noise; noise = (rng.next() - 0.5) * 2 * noiseSd (two draws: trust then agitation);
 * clamp 0..1; turns++; stage = highest stage with trust >= stageTrust; goodTurns = (trust >= surrenderTrust && agitation <= surrenderAgitation) ? goodTurns + 1 : 0;
 * outcome: goodTurns >= surrenderTurns → surrender; agitation >= breakdownAgitation → breakdown; turns >= stallTurns → stalled; reply text from
 * replies[outcome !== ongoing ? outcome : agitation > 0.7 ? 'agitated' : trust > 0.5 ? 'calm' : 'neutral'] picked with the same rng.
 */
export function negotiationTurn(s: NegState, optionId: string, tone: 'polite' | 'neutral' | 'commanding' | 'aggressive', subject: NegSubject, negotiatorOnScene: boolean, rng: Rng, cfg?: CommandConfig, data?: NegotiationData): NegState;
```
Tests (`test/command/triage.test.ts`, `levels.test.ts`, `geometry.test.ts`, `negotiation.test.ts`, required):
`startTriage` all 7 branches with hand-built vitals; `victimVitals` deterministic per (seed, person) and
`startTriage(victimVitals(...))` gives `minor` for most walking wounded and `immediate` / `expectant` for unconscious /
deceased across 100 persons; `transportOrder`; `commandLevel` by family and by units on scene; `resourceNeeds` (exact
numbers, caps, zero floor); `postSpot` / `tcpPoints` on a generated city (count ≤ max, distances in range, deterministic);
`innerPosts` corners; `evacProgress`; `circleZone` closed and bounded; negotiation: listening raises trust and lowers
agitation, pressure does the opposite, aggressive tone reduces gains, negotiator bonus, surrender after 2 good turns,
breakdown at 0.95, stall at 25 turns, stage progression, deterministic with a fixed stream.

### 11.3 Runtime (`src/command/commandSystem.ts`)
```ts
export interface CommandDeps {
  readonly seed: number;
  readonly bus: EventBus<EventMap>;
  /** session.rng.stream('command'). */
  readonly rng: Rng;
  readonly graph: RoadGraph;
  readonly cad: CadState;
  readonly scene: { request(r: SceneRequest): void; participants(callId: number): { role: string; personId: number; actorId: number; injured: boolean; deceased: boolean }[]; hasScenario(callId: number): boolean;
                    familyOf(callId: number): string | null; flagsOf(callId: number): ReadonlySet<string> | null; buildingOfCall(callId: number): number };
  readonly npc: { actor(id: number, out: ActorInfo): ActorInfo | null; removeActor(id: number): void; forceState(id: number, s: 'leave' | 'handsUp'): void; actorsOfCall(callId: number, out: number[]): number[]; walkTo(id: number, x: number, z: number): void };
  readonly people: { identity(id: number): { temperament: 'calm' | 'timid' | 'irritable' | 'volatile'; mental: string }; intoxication(id: number): { bac: number; drug: string }; setInjured(id: number, v: number): void };
  readonly resources: ResourcePort;
  readonly backup: BackupPort;
  /** BuildingIndex.near / building. */
  buildingsNear(x: number, z: number, r: number): number;
  building(id: number): { minX: number; minZ: number; maxX: number; maxZ: number; door: { x: number; z: number } } | null;
  readonly config?: CommandConfig;
}
export interface CommandContext { x: number; z: number; yaw: number; onFoot: boolean; building: number; callId: number }
export type CommandRequest =
  | { readonly kind: 'establish'; readonly callId?: number }
  | { readonly kind: 'assess' }                                  // start assessing the nearest untagged victim in range
  | { readonly kind: 'tag'; readonly personId: number; readonly tag: TriageTag }
  | { readonly kind: 'tcp'; readonly on: boolean }
  | { readonly kind: 'evacuate' }
  | { readonly kind: 'contain' }
  | { readonly kind: 'requestNeeds' }
  | { readonly kind: 'negotiate'; readonly optionId: string; readonly tone: 'polite' | 'neutral' | 'commanding' | 'aggressive' }
  | { readonly kind: 'negotiationOpen' } | { readonly kind: 'negotiationClose' }
  | { readonly kind: 'swat'; readonly command: 'stage' | 'stack' | 'breach' | 'clear' | 'hold' | 'withdraw'; readonly plan?: { entry?: 'front' | 'rear'; tempo?: 'deliberate' | 'dynamic'; lessLethal?: boolean } }
  | { readonly kind: 'standDown' };
export class CommandSystem {
  constructor(deps: CommandDeps);
  step(dt: number, t: CadTime, ctx: CommandContext): void;   // order -662
  request(r: CommandRequest): void;
  /** The open command post of the player's call, null none. */
  post(): CommandPostView | null;
  board(): CommandBoard;                       // MDT Command tab (rebuilt on revision)
  /** The triage panel model: the victim being assessed / in range, or null. */
  triage(): TriagePrompt | null;
  /** DialogueView for the DialoguePanel while the negotiation is open, else null (built on revision change only). */
  negotiationView(): DialogueView | null;
  negotiationTrust(callId: number): number;
  /** NoGoZones of evacuation zones (merged by the integrator with the investigation tape zones). */
  zones(): readonly { id: number; points: Float32Array; minX: number; minZ: number; maxX: number; maxZ: number }[];
  /** TCP + outer perimeter blockades for traffic.setBlockades. */
  blockades(): readonly { x: number; z: number; radius: number }[];
  hud(): string | null;   // 'ICS · DISASTER · RED 3 YEL 4 GRN 2 BLK 1 · EMS 2 en route · EVAC 60%'
  readonly revision: number;
  serialize(): CommandSave;
  restore(s: CommandSave): void;
  dispose(): void;
}
export interface CommandPostView { callId: number; level: string; x: number; z: number; commander: string }
export interface VictimRow { personId: number; actorId: number; label: string; tag: TriageTag | null; by: 'player' | 'ems' | null; correct: boolean | null; trapped: boolean; contaminated: boolean; transported: boolean }
export interface CommandBoard { post: CommandPostView | null; victims: readonly VictimRow[]; counts: Record<TriageTag | 'untagged', number>; tcps: { staffed: number; total: number };
  evac: { progress: number; radiusM: number } | null; inner: { staffed: number; total: number } | null; swat: string | null; negotiation: { trust: number; agitation: number; outcome: string; stage: string } | null;
  needs: { ems: number; fire: number; supervisor: number }; units: readonly { callsign: string; label: string; status: string; etaS: number }[] }
/** What the triage panel shows. It never contains the START answer (graded inside the system only). */
export interface TriagePrompt { personId: number; label: string; progress: number /* 0..1 while assessing */; vitals: Vitals | null /* set once assessed */; tag: TriageTag | null }
```

Step algorithm:
1. **Establish.** When the player's call (`ctx.callId`) has a scenario, its family has a level in `levels.families`
   (or `commandLevel(family, unitsOnScene)` ≠ none), the player is on scene (within 80 m) and `post.autoOnArrival`,
   or on the `establish` request: open the post at `postSpot(...)`, level = `commandLevel`; `scene.request({ kind:
   'commandFlag', flag: 'commandPost' })`; MCI (`massCasualty`): also flag `icsTransport`; emit `command:post`
   (open), radio (dispatch, speaker the player callsign) "`<unit>`, establishing command at `<near>`, `<level>`
   incident."; commander = the player, later the lieutenant / chief callsign when they arrive (radio "`LT-1` assuming
   command"). The post closes when the call closes (`command:post` open false) — everything below is per post.
2. **Victims** (MCI and any call with triage roles): on first materialized step, build rows from
   `scene.participants(callId)` with roles in `triage.roles` (vitals via `victimVitals(seed, personId, role, injured,
   { trapped: flags has 'trapped', hazmat: flags has 'hazmat' })`).
3. **Player triage.** `assess` request: the nearest untagged victim actor within `triage.rangeM` of the player (on
   foot) → assessing for `assessS` (cancelled if the player moves > 1 m away); then the prompt shows the vitals; `tag`
   request sets the tag, `correct = tag === startTriage(vitals)`, emits `command:triage` (by player), flash "Tagged
   RED — correct" / "Tagged YELLOW — START says RED".
4. **EMS triage.** Per EMS unit on scene (`resources.onScene(callId, 'ems')`) one untagged, reachable (not trapped,
   not contaminated) victim per `aiAssessS`; tag = START, wrong with `aiErrorRate` (rng: then the next tag in the order
   immediate→delayed→minor→immediate); `command:triage` (by ems).
5. **Fire.** Per fire unit on scene: one trapped victim freed per `extricateS` (trapped=false), else one contaminated
   victim deconned per `deconS` (contaminated=false); radio on fireEms "`ENGINE-1`, one patient extricated."
6. **Transport.** Each EMS unit on scene (from `onSceneUnits`), not busy: next patients from `transportOrder` (up to
   `perUnit[tag]` of the first patient's tag), skipping trapped / contaminated / untagged; after `loadS` →
   `resources.transport(callsign, personId)` for the first and `npc.removeActor` + `people` hospital for the
   others (resources handles the first), rows transported. When every `immediate` victim is transported → flag
   `transportedRed`; when every victim has a tag → flag `triaged`. Expectant victims stay for the coroner.
7. **TCPs** (`tcp on` request or automatically for `roadway` / `hazmat` flags when the post opens): `tcpPoints(graph,
   incident, tcp.radiusM, tcp.max)`; blockades of radius `blockadeRadiusM` at each; `backup.staffPost({ id:
   'tcp<n>', kind: 'tcp' })` for each (none free → `resources`? no: request patrol backup through the dispatcher is
   not available here; flash "TCP <n> unstaffed — request backup"); flag `trafficControl` when `backup.staffed('tcp')
   >= 2` (or the player stands at a TCP). `tcp off` clears blockades and posts.
8. **Evacuation** (`evacuate`): radius from `evac.radiusM` (flags hazmat / package / family barricade, else default);
   `buildings = buildingsNear(incident, r)`; zone = `circleZone`; actors of the call with role bystander / caller /
   resident / crowd within r → `npc.forceState(id, 'leave')`; progress accrues per step `dt * (officers on evac posts +
   1 + fireFactor * fire units)` until `evacProgress >= 1` → flag `evacuated`; staffs up to 2 `evac` posts at the
   zone edge.
9. **Containment** (`contain`, or automatically for `barricade` when the post opens): inner posts =
   `innerPosts(building rect, inner.offsetM)` staffed through `backup.staffPost` (kind inner); outer = TCPs at 150 m
   (step 7); flags `contained` when `staffed('inner') >= 2`, `perimeter` when ≥ 2 TCPs staffed.
10. **Negotiation** (barricade calls): `negotiationOpen` allowed when the post is open (the negotiator boosts it when
    on scene: `resources.onScene(callId, 'negotiator') > 0`); subject = the participant with role `subject` (identity
    temperament, intoxication bac > 0.08, crisis = mental ≠ none, hostage = a `hostage` participant exists).
    `negotiate` → `negotiationTurn` (command stream). Outcomes: surrender → the subject actor walks out
    (`npc.walkTo(actor, door.x, door.z)` then `forceState('handsUp')`), flags `negotiated`, radio; breakdown → radio
    "Negotiations have broken down", `backup.swat(callId, 'stack')` if SWAT on scene (else flash "Request SWAT"); stalled
    → flash. Emits `command:negotiation` every turn.
11. **SWAT** requests are forwarded to `backup.swat(callId, command, plan)` (text reply → flash); when the subject's
    `custody:subject` flag appears after SWAT → flag `swatResolved`.
12. **Needs**: `requestNeeds` → `resourceNeeds(...)` → `resources.requestType('ems' | 'fire' | 'supervisor', callId,
    'mdt')` that many times.
13. Revision bumps on every board change; the board / view objects are rebuilt lazily on `revision` change only.

### 11.4 Save (`src/command/save.ts`)
```ts
export interface CommandSave {
  version: 1; rng: RngState;
  post: { callId: number; level: string; x: number; z: number; commander: string } | null;
  victims: { personId: number; actorId: number; role: string; tag: TriageTag | null; by: string | null; correct: boolean | null; trapped: boolean; contaminated: boolean; transported: boolean }[];
  assessing: { personId: number; progress: number } | null;
  emsTimers: [string, number][]; fireTimer: number;
  tcp: { on: boolean; points: [number, number, number][] };
  evac: { radiusM: number; clearedS: number; buildings: number; x: number; z: number } | null;
  contain: boolean;
  negotiation: (NegState & { open: boolean; subjectPersonId: number }) | null;
  requests: CommandRequest[];
}
export function isCommandSave(x: unknown): x is CommandSave;
export function emptyCommandSave(rng: RngState): CommandSave;
```

### 11.5 Runtime tests (`test/command/system.test.ts`)
With fakes for the ports: an MCI call establishes a post automatically (flags `commandPost` + `icsTransport`,
`command:post` event); player assess + tag (correct / wrong); EMS triages the rest at `aiAssessS`; transport order
(immediate first) and `transportedRed`; fire extrication frees trapped victims; TCP blockades + posts; evacuation
progress → `evacuated`; barricade containment flags; negotiation to surrender drives the subject out; breakdown
triggers `backup.swat(stack)`; `requestNeeds` requests the computed counts; save / restore round trip; determinism.
Perf: ≤ 0.02 ms per step average with 15 victims.

## 12. UI, rendering and input [ui] — wave 3

Owns `src/ui/mdt/**`, `src/ui/hud/**`, `src/ui/panels/**`, `src/ui/backup/**` (new), `src/ui/pursuit/**` (new),
`src/ui/command/**` (new), `src/ui/air/**` (new), `src/render/air/**` (new), `src/render/pursuit/**` (new),
`src/input/actions.ts`, `src/input/bindings.ts`, tests `test/mdt/**`, `test/hud/**`, `test/panels/**`,
`test/ui6/**` (new), `test/airrender/**` (new), `test/input/actions.test.ts`, `test/input/bindings.test.ts`.
Imports every Phase 6 module's exported types. DOM classes are no-ops without `document`; pure model functions get the
tests.

### 12.1 Input (`src/input/actions.ts`, `bindings.ts`)
New button actions (label; default key): `backup.menu` ("Backup officers"; `Comma`), `command.menu` ("Incident
command / triage"; `Period`), `pursuit.menu` ("Pursuit tactics"; `Semicolon`), `air.flir` ("Air unit camera
(FLIR)"; `Slash`). No gamepad defaults. They appear in the rebinding UI automatically; extend the actions /
bindings tests (no key collides with an existing default).

### 12.2 Panels (models pure, DOM via the existing `ActionPanel`)
- `src/ui/backup/backupPanel.ts`:
  `backupPanelModel(officers: readonly BackupOfficerView[], selected: string | 'all'): ActionPanelModel` — title
  "Backup", subtitle = selected officer ("21 Officer J. Alvarez · COVER · stress 0.42"), options in order: `Select:
  <callsign>` rows (one per officer, then "All units"), then commands Cover me / Take the secondary / Detain my subject
  / Stand by / Regroup on me / Release (Code 4) — each disabled with a hint when no officer is selected / on scene.
  `backupPanelPick(model index, officers, selected): { select?: string | 'all'; request?: BackupRequest } | null`.
- `src/ui/pursuit/pursuitPanel.ts`: `pursuitPanelModel(menu: ReturnType<PursuitSystem['menu']>, hud: PursuitHud |
  null): ActionPanelModel` (labels: Request PIT authorization, Spike strip ahead (AI unit), Deploy my spike strip,
  Box in, Roadblock, Request air unit, Set a perimeter); `pursuitPanelPick(index, menu): PursuitRequest | null`.
- `src/ui/command/commandPanel.ts`: `commandPanelModel(board: CommandBoard, triage: TriagePrompt | null, swatPhase:
  string | null): ActionPanelModel` with two modes: **triage mode** when `triage` is non-null (title "Triage — <label>";
  while assessing a progress line; once vitals are known the four vitals lines as disabled rows ("Walking: no",
  "Breathing: yes, 34 / min", "Radial pulse: absent", "Capillary refill: 3.1 s", "Follows commands: yes") and four tag
  options GREEN minor / YELLOW delayed / RED immediate / BLACK expectant), else **command mode**: Establish command /
  Assess nearest victim / Traffic control on|off / Evacuate the zone / Contain the location / Request recommended
  resources ("EMS 2, fire 1") / Negotiate (opens the dialogue) / SWAT ▸ (submenu: Stage, Stack, Breach, Clear, Hold,
  Withdraw, Plan: entry front|rear, tempo deliberate|dynamic, less-lethal on|off) / Stand down.
  `commandPanelPick(index, model state): CommandRequest | { submenu: 'swat' | 'root' } | null`.
- Negotiation uses the existing `DialoguePanel` with `command.negotiationView()` (handlers: `say(optionId, tone)` →
  `command.request({ kind: 'negotiate', optionId, tone })`, `close` → `negotiationClose`). No new DOM.
- `src/ui/panels/radioMenuView.ts`: shows the menu title (now "Request 2/3") unchanged otherwise; verify it renders
  9 options.

### 12.3 MDT (`src/ui/mdt/**`)
- `MdtDeps` (types.ts) gains optional fields (absent in Phase 1-5 tests):
  ```ts
  /** Live ETA (s) of an en-route unit, -1 unknown. */
  eta?(callsign: string): number;
  resources?: {
    revision(): number;
    units(): readonly ResourceUnitView[];
    /** Requestable types in menu order. */
    types(): readonly { id: string; label: string; resolves: string; send: string }[];
    /** Queues a request for the player's call (resource types via ResourceSystem, patrol types via the dispatcher). */
    request(typeId: string): void;
    /** Presentation-only ETA board from the worker: resolves to rows for the selected call (empty when the worker is unavailable). */
    etaBoard?(callId: number): Promise<readonly { callsign: string; label: string; etaS: number }[]>;
  };
  command?: { revision(): number; board(): CommandBoard; request(r: CommandRequest): void };
  ```
- `MDT_TABS` appends `'resources'` and `'command'` (keys: right arrow beyond the existing ones, like the Community
  tab; `tabKeyLabel` handles them).
- Units tab: a new `ETA` column (`m:ss` or blank) and resource units listed after the patrol units (kind badge).
  Call tab: assigned units with their ETA.
- Resources tab: left list = requestable types (Enter requests for the player's current call, footer "requests go to
  <call number>" or "a new officer-assist call"); right = live unit list (callsign, type, status, call, ETA); "ETA
  BOARD" button (when `etaBoard` exists) fetches and shows the worker's table (stale results are discarded when the
  selected call changes).
- Command tab: post (level, commander), triage counts with colour chips (`TRIAGE_COLORS`), victim list (tag, by,
  correct mark, trapped / contaminated / transported), TCP and inner perimeter staffing, evacuation progress bar,
  SWAT phase, negotiation trust / agitation bars, needs line with a REQUEST button (→ `requestNeeds`), units list.
- Rebuilds only on `revision` change, at most 4 Hz.

### 12.4 HUD (`src/ui/hud/**`)
`HudSnapshot` gains optional (absent = hidden):
```ts
/** Up to 4 lines: '21 Alvarez · COVER', '23 Park · SECONDARY · chasing', posts 'TCP 2/4'. */
backup?: readonly string[] | null;
/** 'PURSUIT · 62 mph · risk 0.48 · SGT-1 monitoring · AIR on target'. */
pursuit6?: string | null;
/** Last pursuit tactic verdict ('PIT: within policy'), shown 6 s. */
pursuitVerdict?: string | null;
/** 'MEDIC-2 ETA 3:10'. */
resourceEta?: string | null;
/** Command chip ('ICS · DISASTER · RED 3 YEL 4 GRN 2 BLK 1 · EVAC 60%'). */
command?: string | null;
/** FLIR overlay on (the app swaps the camera). */
flir?: boolean;
```
DOM writes on change at the existing 10 Hz HUD rate; tests in `test/hud/phase6.test.ts`.

### 12.5 FLIR (`src/ui/air/flirOverlay.ts`) and the air camera
- `FlirOverlay` (DOM, no-op headless): `show(on: boolean)` toggles the CSS class `flir-on` on the canvas
  (`filter: grayscale(1) contrast(1.9) brightness(1.15)`; a `flir-black-hot` variant adds `invert(1)`), and an
  overlay with a reticle, "FLIR WHT", altitude, the target box and a compass; `update(target: { sx: number; sy:
  number; visible: boolean } | null, alt: number, heading: number)` (screen coordinates computed by the app with
  `Vector3.project`, scratch vectors). Styles in `src/ui/air/air.css` (prefix `air-`).
- `src/render/air/airCamera.ts` (pure): `airCameraPose(air: AirView, out: { x; y; z; lookX; lookY; lookZ; fov })`
  — camera 3 m below the helicopter, looking at `(targetX, 0, targetZ)`, fov 25 (zoomed).

### 12.6 Rendering (`src/render/air/airRenderer.ts`, `src/render/pursuit/spikeRenderer.ts`)
- `AirRenderer(scene)`: one group (fuselage box 9 x 2.2 x 2.6 m, tail boom, two skids, a rotor disc of 2 thin boxes
  rotated by `rotor` angle, a tail rotor) merged into 2 meshes (body, rotor) + one `SpotLight` created once
  (intensity 0 when off, `castShadow` false; the target follows the AirView target). `update(view: AirView | null,
  alpha: number)`: hidden when null. ≤ 3 draw calls. Dispose releases geometries / materials.
- `SpikeRenderer(scene, max = 8)`: one `InstancedMesh` of a flat dark box (strip width 0.25 m, height 0.04 m) +
  spikes as a second thin instanced box; `update(strips: readonly Strip[])` sets matrices for active strips only
  (scratch matrices, no allocation). ≤ 2 draw calls.
- Tests (`test/airrender/**`): constructs with a `THREE.Scene` (three works in node for math / scene graph), update
  hides / shows and positions, dispose; `airCameraPose` numbers.

### 12.7 Other UI tests (`test/ui6/**`)
Panel models: option labels / enabled states per input, pick results (requests), triage mode shows vitals only after
assessment and never a START hint, SWAT submenu, pursuit menu disabled hints; MDT resources / command tabs build
from fake deps (use `test/mdt/helpers.ts`); FLIR overlay no-op headless.

## 13. UI structure

| Surface | Owner | Opens on | Pauses |
|---|---|---|---|
| Radio menu Request ▸ (paged 8 + More) | hooks (model) / ui (view) | T → 4 | no |
| Backup panel (select officer, commands) | ui `backupPanel` + ActionPanel | `,` | no |
| Pursuit tactics panel | ui `pursuitPanel` + ActionPanel | `;` (enabled during a vehicle pursuit / foot bail; on foot shows "Deploy my spike strip") | no |
| Command / triage / SWAT panel | ui `commandPanel` + ActionPanel | `.` | no |
| Negotiation dialogue | DialoguePanel + `command.negotiationView()` | command panel → Negotiate | no |
| FLIR camera + overlay | ui `FlirOverlay`, app camera | `/` while an air unit is up | no |
| MDT Resources tab (request any type, units + ETA, worker ETA board) | ui | MDT | no |
| MDT Command tab (ICS board) | ui | MDT | no |
| MDT Units / Call ETA column | ui | MDT | no |
| HUD: backup lines, pursuit line + verdict, resource ETA, command chip | ui HUD, integrator feed | always | – |
| Radio lines: callouts, acknowledgements with ETA, supervisor orders, SWAT, command, handoff | integrator (`RadioSystem.say`) | `*:radio` | – |
| World: backup officers, SWAT operators, crews, helicopter + spotlight, spike strips | PeopleRenderer sources, AirRenderer, SpikeRenderer | always | – |

## 14. ECS components and event topics

No new ECS components (`src/ecs/components.ts` unchanged); resource fleet cars use the existing `PoliceLights` and
`VehicleLook`. Topics: §4.4 (the integrator updates the `src/core/event-map.ts` header comment). Integrator bridges
(bus handlers, synchronous inside the emitting step):

| From | To |
|---|---|
| `resource:radio`, `backup:radio`, `pursuit:radio`, `command:radio` | `RadioSystem.say(channel === 'current' ? radio.channel : channel, text, speaker)` |
| `resource:flash`, `backup:flash`, `pursuit:flash`, `command:flash`, `pursuit:tactic` | HUD legal / flash line (`pursuitVerdict` for tactics) |
| `backup:custody` | `scene.request({ kind: 'custody', callId, personId, by })` |
| `force:other` whose officer is a backup officer | `backup:mistake` excessiveForce is emitted by backup itself when it sees `force:other` with its officer's name; nothing else |
| `command:post` | `resources` (subscribed itself, chain of command); HUD |
| investigation tape zones + `command.zones()` | `npc.setNoGoZones(concat)` (the investigation port stores its list; the integrator merges at 1 Hz or on change) |
| `command.blockades()` | `traffic.setBlockades` on change (revision) |
| `scene.setServiceProvider((c, k) => resources.provide(c, k))`; `dispatcher.setUnitRanker((cs, x, z, u) => resources.rankPatrol(cs, x, z, u))`; `dispatcher.setUnitHold((cs) => backup.onFoot(cs))` | wiring at session construction |
| `setRadioRequestTypes(requestableTypes().map(...))` | at app start (patrol types → `{ kind: 'backup', code: 2 }`, `{ kind: 'backup', code: 3 }`, `{ kind: 'emergency' }`; others `{ kind: 'resource', typeId }`) |

## 15. Step order, frame order, determinism, workers

| Order | System | Work |
|---|---|---|
| -700 | `dispatch` | + ranker, directed units, hold |
| **-698** | **`resources`** | requests (radio / MDT / scene provider / chain of command), unit FSMs, air flight, ETA (1 unit / step), crews (10 Hz) |
| -690 | `scene` | + external services, custody, commandFlag, handoff |
| -685 / -680 | force / contact | force: per-fellow chance |
| **-678** | **`pursuit`** | contacts, strips, tactics, follow, supervisor (1 Hz), handoff, perimeter (4 Hz) |
| -675 / -670 | investigation / station | unchanged |
| **-665** | **`backup`** | roster minute tick (integrator, before), officers (FSM per step, observations 4 Hz), SWAT |
| **-662** | **`command`** | post, triage, transport, TCP, evacuation, containment, negotiation (on requests) |
| -660 / -658 / -656 | incidents / conduct / court | incidents: + pursuit:order advisory |
| -650 / -640 / 40 / 50 / 60 | radio / tactical / vehicles.pre / traffic / npc | traffic: + deflate, spin, cap, tracked, blockades |

Per frame (`App.update`): `,` / `.` / `;` open the panels (non-pausing ActionPanels), `/` toggles FLIR (only while
`resources.airView()` is non-null; the camera rig is bypassed and `airCameraPose` drives the camera; leaving FLIR or
losing the air unit restores the previous camera); panel picks → `request(...)` of the owning system; HUD feed (10 Hz);
`AirRenderer.update`, `SpikeRenderer.update`, `PeopleRenderer` sources `[npc.view, officer, partner.view, backup.view,
resources.crews]`; FLIR overlay target projection.

**Determinism.** Every Phase 6 state change happens in fixed steps from the named streams (`resources`, `backup`,
`pursuit`, `command`) or pure seeded functions (profiles, mistakes, vitals); requests are queued; the worker ETA board,
the FLIR view and the panels never feed back. The replay test compares v8 saves bit-identically.

**Workers.** The heavy sim work of Phase 6 is A* routing: unit selection routes at most `rankCandidates` (4) units per
request (≈ 4 ms worst case on a request step, rare) and live ETAs reuse the traffic system's `routeLeftM` (no A*), so the
simulation stays on the main thread (a worker would return results with timing jitter and break replay). The
**presentation-only** MDT ETA board (every unit of every type to the selected call, up to 32 routes ≈ 30 ms) runs in
the existing Phase 0 sim worker (`eta.matrix`, §5.6), which generates its own city from the seed (≈ 100 ms once). The
chunk worker is unchanged.

## 16. Save schema v8 (integrator only)

```ts
export interface SaveGameV8 extends SaveGameV7 {
  roster: RosterSave;        // stress, fatigue, loyalty, counters per officer (profiles are pure functions of seed + callsign)
  resources: ResourceSave;   // unit slots (status, call, timers, ETA basis), air unit, remembered posts, queued requests, rng
  backup: BackupSave;        // on-foot officers (FSM, pose, rolled mistakes, post, callout memory), pending callouts, SWAT team, requests, rng
  pursuit: PursuitSave;      // tracked pursuit (authorization, supervisor monitoring, tactic, handoff), foot bail perimeter, strips, requests, rng
  command: CommandSave;      // post, victims + tags, assessment, TCPs, evacuation, containment, negotiation, requests, rng
}
// traffic snapshot: optional deflated / spin / cap / tracked per car, optional blockades (version stays 1)
// dispatch UnitFsmSave: optional directed; scene ServiceState: optional external; CAD units may have kind 'resource'
```
`CURRENT_SAVE_VERSION = 8`. `migrateV7ToV8(data)`: `roster: emptyRosterSave()`, `resources:
emptyResourceSave(stream('resources'))`, `backup: emptyBackupSave(stream('backup'))`, `pursuit:
emptyPursuitSave(stream('pursuit'))`, `command: emptyCommandSave(stream('command'))` with `stream(name) =
createRng(data.seed).stream(name).state()`. Loading a migrated save: `resources.restore` adds the resource units to
CAD at their bases (reconcile), `roster.ensure` is called for every AI patrol and ranked callsign (profiles regenerate).
Load order: … investigation → station → force → incidents → conduct → court → **roster → resources → backup →
pursuit → command** → radio → primeContacts. `isSaveGameV8` = v7 checks + `isRosterSave`, `isResourceSave`,
`isBackupSave`, `isPursuitSave`, `isCommandSave`. Tests (`test/save`): v1..v7 → v8 migrate and validate; v8 round trip;
each malformed new block rejected; a migrated v7 save starts a pursuit and requests a K9 unit that drives to the call.

## 17. Performance budget (60 FPS, mid-range desktop)

| Subsystem | Budget | Notes |
|---|---|---|
| Resources step | ≤ 0.03 ms/step avg; ≤ 5 ms on a request step | 22 slots, one ETA refresh per step, A* only on requests (≤ 4 candidates) |
| Air unit | ≤ 0.005 ms/step | pure flight; FLIR reveal 2 Hz |
| Backup step | ≤ 0.05 ms/step avg (8 officers + 4 SWAT) | FSM per step, observations 4 Hz, `findPath` only indoors for SWAT on goal change |
| Pursuit step | ≤ 0.02 ms/step avg | contact / strip checks per step (≤ 8 strips), 1 Hz risk / supervisor / path prediction, 4 Hz perimeter |
| Command step | ≤ 0.02 ms/step avg (15 victims) | timers per step, board rebuilt lazily on revision |
| Traffic additions | ≤ +0.02 ms/step with 16 blockades | bounding-box rejection first |
| Roster | ≤ 0.005 ms per game minute | |
| Rendering | helicopter ≤ 3 draw calls, strips ≤ 2, figures through the existing instanced PeopleRenderer (+0 draw calls), service vehicles through CarRenderer (+3 per visible new model) | |
| FLIR | CSS filter only (compositor), overlay DOM writes ≤ 30 Hz | |
| Worker ETA board | ≤ 50 ms in the worker per request, ≤ 1 in flight | presentation only |
| MDT tabs / HUD | rebuild on revision, ≤ 4 Hz / 10 Hz | |
| Save size | + ≤ 40 KiB typical | 22 units, ≤ 12 officers, ≤ 20 victims |
| Per-frame / per-step allocations | none in hot loops | strings only on events and throttled UI |

## 18. Requirement map

| Requirement | Code |
|---|---|
| AI backup officers with personalities, skills, fatigue, stress, loyalty; persistent roster from Phase 2 units; procedural names | `src/units/personality.ts` (`officerProfile`, `officerName`), `src/units/roster.ts` (`RosterState`, saved), dispatcher `officerName` dep, `roster.json` |
| They arrive, follow protocol (cover positions, contact/cover roles), call out over radio, give cover, handle secondary subjects | `src/backup/backupSystem.ts` (spawn at the car, roles, `coverSpot`, secondary commands / chase / detain), `fsm.ts`, callouts (`backup.json`, `backup:radio`) |
| Mistakes under stress: late callouts, poor positioning, rarely excessive force; duty to intervene | `mistakeChances` + `rollMistakes` (deterministic per seed), `poorCoverSpot`, `lateDelayS`, `FellowOfficer.misconductChance` → Phase 5 force episode + H intervene |
| Backup request types (17 + chain-of-command ranks) via radio menu / MDT / voice, data-driven with vehicle, behaviour, resolves | `unitTypes.json` (§4.2), `src/radio/requestTypes.ts` + paged menu + grammar, MDT Resources tab, `ResourceSystem`, scene services (+6 kinds) |
| Response times from positions, routing, traffic, priority; units drive; ETA in CAD | `estimateResponse` / `rankByEta` (tests), dispatcher ranker, resources spawn-at-base + fleet drive, live `eta()`, MDT ETA columns, radio ETA acks, worker ETA board |
| Supervisors: sergeants respond to use of force and pursuits and may terminate pursuits; lieutenants / chiefs at major incidents (command post) | `chainResponse` (§8.4), `supervisorFor`, `pursuitDecision` + `pursuit:order` (incidents advisory), command post commander hand-over |
| Pursuit: AI road driving, PIT (physics + policy), spike strips (trunk / AI ahead, deflation), box-in, rolling roadblock, helicopter (follow, FLIR, spotlight), perimeter after foot bail, termination rules, jurisdiction handoff | traffic flee (Phase 3) + §6 additions; `classifyContact` / `pitPolicy`, strips (`crossesStrip`, `stripAcrossEdge`, `burstTire`), `canBoxIn`, `unitsAhead` roadblock, air unit (resources) + `AirRenderer` + FLIR, `perimeterPosts`, `pursuitDecision`, `timeToBoundary` handoff + scene `terminatePursuit` reason handoff |
| SWAT / negotiation: containment (inner / outer), negotiator minigame, SWAT AI (stack, breach, clear), plan adjustments | command containment (`innerPosts`, TCPs, no-go zone), `negotiationTurn` + DialoguePanel, `SwatTeam` (`clearOrder`, `entryDoor`, `swatContactOdds`), command panel SWAT submenu |
| Mass casualty / disaster: command post, START triage, traffic control points, evacuation, EMS / fire coordination | `massCasualty` family, `CommandSystem` (post, `victimVitals` / `startTriage`, `tcpPoints` + blockades, evacuation zone + progress, extrication / decon, `transportOrder` + `resources.transport`), MDT Command tab |
| Save version + tested migration | §16 |
| Determinism, perf, workers, no new dependencies | §15, §17, §19 (blockers: none) |

## 19. Modules, ownership and waves

| Key | Wave | Owns (exclusively) | May import (new Phase 6 code) |
|---|---|---|---|
| units | 1 | `src/units/**`, `src/data/units/**`, `src/vehicles/model.ts`, `src/data/vehicles/{ambulance,fire_engine,tow_truck,tactical_truck}.json`, `src/workers/protocol.ts`, `src/workers/sim.worker.ts`, `test/units/**`, `test/vehicles/model.test.ts`, `test/workers/etaMatrix.test.ts` | none |
| traffic | 1 | `src/traffic/**`, `src/data/traffic/**`, `src/vehicles/drivableVehicle.ts`, `test/traffic/**`, `test/vehicles/burstTire.test.ts` | none |
| hooks | 1 | `src/dispatch/dispatcher.ts`, `src/dispatch/save.ts`, `src/cad/types.ts`, `src/cad/cadState.ts`, `src/radio/menu.ts`, `src/radio/grammar.ts`, `src/radio/compose.ts`, `src/radio/requestTypes.ts`, `src/scene/**`, `src/calls/**`, `src/data/calls/**`, `src/data/scene/**`, `src/data/cad/**`, `src/force/types.ts`, `src/force/forceSystem.ts`, `src/incidents/events.ts`, `src/incidents/incidentSystem.ts`, `src/legal/pursuit.ts`, `test/dispatch/**`, `test/cad/**`, `test/radio/**`, `test/scene/**`, `test/calls/**`, `test/force/phase6.test.ts`, `test/incidents/phase6.test.ts`, `test/legal/phase6.test.ts` | none |
| resources | 2 | `src/resources/**`, `test/resources/**` | units, traffic, hooks |
| backup | 2 | `src/backup/**`, `src/data/backup/**`, `test/backup/**` | units, traffic, hooks |
| pursuit | 2 | `src/pursuit/**`, `src/data/pursuit/**`, `test/pursuit/**` | units, traffic, hooks |
| command | 2 | `src/command/**`, `src/data/command/**`, `test/command/**` | units, traffic, hooks |
| ui | 3 | `src/ui/mdt/**`, `src/ui/hud/**`, `src/ui/panels/**`, `src/ui/backup/**`, `src/ui/pursuit/**`, `src/ui/command/**`, `src/ui/air/**`, `src/render/air/**`, `src/render/pursuit/**`, `src/input/actions.ts`, `src/input/bindings.ts`, `test/mdt/**`, `test/hud/**`, `test/panels/**`, `test/ui6/**`, `test/airrender/**`, `test/input/actions.test.ts`, `test/input/bindings.test.ts` | all |
| integrator | 4 | `src/app.ts`, `src/game/**`, `src/core/event-map.ts`, `src/ecs/components.ts`, `src/save/**`, `docs/PHASES.md`, `scripts/smoke.mjs`, and unowned files (`docs/ARCHITECTURE.md`, `README.md`, `src/main.ts`, other `src/**`, `test/game/**`, `test/save/**`, other tests) | all |

Same-wave rule (wave 2): resources, backup, pursuit and command never import each other; they use the ports of
§4.5 (pursuit / command → `ResourcePort`, command → `BackupPort`, backup → plain callbacks in `BackupDeps`). A module
that needs a change in a file it does not own lists it for the integrator in its final report instead of editing it.

## 20. Integrator plan

1. **Save v8** (`src/save/**`, `test/save/**`): types, validators, `migrateV7ToV8`, fixtures, tests (§16).
2. **Session** (`src/game/session.ts` + new `src/game/phase6.ts` holding the construction and ports):
   - `RosterState(seed)`; `roster.ensure` for the six patrol callsigns (`officer`), and for the ranked resource slots;
     dispatcher dep `officerName: (cs) => roster.ensure(cs, 'officer').name` for AI units (the player keeps
     `units.json`'s name).
   - `ResourceSystem` (`rng.stream('resources')`; ports: traffic, scene, dispatcher (`openSelfInitiated`, `locate`,
     `playerCallsign`), npc, people, roster, `env` from the environment (wetness, night factor > 0.5),
     `trafficDensity(x, z)` = `DENSITY.district[<district name at (x, z)>] * DENSITY.hourMultiplier[env.time.hour]`
     from `src/data/traffic/density.json` via the traffic module's parsed `DENSITY`); `resources.start(t)` after `dispatcher.start`.
   - `PursuitSystem` (`rng.stream('pursuit')`; ports; `rules` from `incidents.ruleset.pursuit` + `allowedOverMph` +
     offense from the incident assessment of the pursuit's owner call; `modelOf` = `vehicleRecord(seed, id).modelId`;
     `roadAt` from `graph.nearestEdge` + `effectiveSpeedLimitMph` + district name; `takeStripFromKit` =
     `officerKit` carried `spikeStrip` decrement; `burstPlayerTires` = `drivenVehicle.burstTire(0/1, bus)`).
   - `BackupSystem` (`rng.stream('backup')`; `unitCar` via `cad.unit(cs).fleetIndex` → `traffic.fleetState` or
     `resources.unitPose`; `interiors`; `doorRequest` → `interiors.request({ kind: 'door', ... })`; `building` →
     `BuildingIndex`; `callBuilding` → `scene.buildingOfCall`; `swatOnScene` → `resources.onScene(callId, 'swat')`;
     `negotiationTrust` → `command.negotiationTrust`). Force `fellows` = partner fellows + `backup.fellows()`.
   - `CommandSystem` (`rng.stream('command')`; scene / npc / people / resources / backup ports; buildings).
   - Wiring of §14 (provider, ranker, hold, bridges); register `resources` -698, `pursuit` -678, `backup` -665 (roster
     `stepMinutes` on game-minute change first), `command` -662; traffic blockades and npc no-go merge; serialize /
     load v8 in the §16 order; dispose phase 6 systems before force; roster `startShift` on a new game.
3. **App** (`src/app.ts`): `setRadioRequestTypes` at start; input actions (`,` `.` `;` `/`); panels (backup,
   pursuit, command; negotiation via DialoguePanel); FLIR camera mode + overlay; `AirRenderer`, `SpikeRenderer`;
   PeopleRenderer sources; MDT deps (`eta`, `resources` incl. `etaBoard` through the worker client, `command`); HUD feed
   fields (§12.4); perf extras `resources` (en route / on scene), `backup` (officers), `pursuit` (risk), `command`
   (victims).
4. **Console** (`src/game/phase6Commands.ts`): `units [type]`, `request <typeId>`, `eta <callsign>`, `roster
   [callsign]` (traits, stress, fatigue, loyalty, mistake chances), `stress <callsign> <v>`, `backup list | <callsign>
   <command>`, `pursuit spawn` (a fleeing car ahead) | `pit` | `spikes` | `strip` | `box` | `roadblock` | `air` |
   `perimeter` | `status`, `swat <command> [entry|tempo|lessLethal]`, `negotiate <optionId> [tone]`, `mci spawn
   <multiVehicleCrash|buildingCollapse|hazmatRelease>`, `triage list | assess | tag <personId> <tag>`, `ics post | tcp
   on|off | evac | contain | needs`, `flir`.
5. **Determinism test** (`test/game/phase6.test.ts`): new game; an AI unit requested as backup to a traffic stop
   (officer exits, cover role, a callout); a K9 request driving from the station; a spawned pursuit with a PIT
   contact, a supervisor order, spikes ahead; an MCI call with a command post, a player triage tag and EMS
   transport; two runs → bit-identical v8 saves; a load mid-pursuit continues exactly; a v7 save loads.
6. **Smoke** (`scripts/smoke.mjs`): Phase 6 steps (real keys where they exist): T → 4 → request backup code 3 (an AI
   officer gets out and covers, HUD backup line, callout in the radio log); MDT Resources tab request EMS (ETA shown,
   ambulance drives); `pursuit spawn`, `;` → request air (helicopter visible, `/` FLIR screenshot), spikes ahead, PIT
   via `pursuit pit`; supervisor termination line; `mci spawn multiVehicleCrash`, `.` → establish command, assess and
   tag a victim, MDT Command tab screenshot; `call spawn barricadedSubject`, contain, negotiate a few lines, SWAT stack /
   breach / clear; save / load v8; screenshots `phase6-backup.png`, `phase6-flir.png`, `phase6-command.png`.
7. **Docs**: event-map comment, `ARCHITECTURE.md` Phase 6 section, `PHASES.md` Phase 6 entry (controls, checklist,
   perf, limitations), README controls.

## 21. Known limitations and later-phase hooks

- Patrol backup officers stay outdoors (they hold the door); only the SWAT team enters buildings.
- The PIT spin is a scripted traffic animation triggered by a real physics contact; vehicle interventions (PIT,
  ramming, box-in) are judged by the Phase 6 pursuit policy and shown live, but are not part of the Phase 5 legal
  assessment or IA triggers.
- The roadblock is an approximation: AI units ahead (parked or moving) cap the suspect's speed; there is no
  formation driving.
- FLIR is a zoomed camera with a grayscale / contrast filter and a target box, not a thermal render.
- Crews of service vehicles stand by their vehicles; EMS loading is a timer (no stretcher animation).
- Jurisdiction is a rectangle (city limits); the state unit's resolution after a handoff is a roll, off-screen.
- Building collapse has no rubble geometry; trapped victims are a flag freed by fire units.
- New service vehicles (ambulance, fire engine, tow truck, tactical truck) are plain-coloured boxes with a light bar.
