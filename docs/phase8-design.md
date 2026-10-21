# Phase 8 design: Career, Persistence, Multiplayer

Status: design (technical director). Implementation is split into 8 modules in 3 waves (§19) plus an integrator
(§20). Read with `docs/ARCHITECTURE.md`, `docs/phase7-design.md` §2-§4 (conventions carried over) and
`docs/research/*.md`. Every builder reads §1-§4 and the section of its own module. Names, ids, signatures and shapes
in this document are contracts: do not rename them. When a brief says "add", keep every existing export, behaviour
and test green unless the brief says otherwise.

Note on the save version: the task statement says "currently v5", but Phase 7 already shipped **v9**
(`CURRENT_SAVE_VERSION = 9`, `src/save/schema.ts`). Phase 8 adds **v10** with a tested `migrateV9ToV10`; every older
version (1..9) must still load. The user gave blanket approval for this one version bump. Only the integrator edits
`src/save/**`.

## 1. Scope

At the end of Phase 8 the officer has a career that spans many shifts in a city that remembers them:

- **Career** (`src/career`). A new *Career* game starts in the **academy**: five scored modules (driving course,
  firearms range, defensive tactics, report writing, legal quiz) with pass marks. Graduation starts **probation**
  (N shifts with a field training officer who files a daily observation report, DOR); passing it makes the officer a
  regular **patrol** officer. Later: the **FTO** assignment (rate a trainee every shift), six **specialty units**
  (traffic, K9, detective, SWAT, narcotics, air) with data-driven entry requirements and effects (call mix, unit class,
  uniform, pay), **promotions** (corporal .. captain, with an exam), **pay** (base by rank, night, specialty, FTO,
  overtime, court), **seniority-based shift bidding** (day / swing / night x beat against seeded AI officers),
  **fatigue, stress and health** that change during the shift and hurt performance (aim spread, steering lag, a
  vignette), and **off-duty life**: between shifts an apartment hub screen (rest, exercise, family time, second job;
  neglect raises stress, money below zero raises stress, no sleep carries fatigue into the next shift).
- **Shift rollover.** *End shift* (Phase 7 fleet flow) -> shift summary (pay, DOR) -> apartment -> *Report for duty*:
  the session is serialized, transformed by a pure rollover (time jumps to the next shift start, per-shift state is
  reset, persistent state is kept and the world evolves) and loaded again. One save holds a whole career.
- **Persistent world** (`src/worldstate`). Premise history per address (shown in the MDT and the dispatch console),
  a case register (cases linger across shifts, go to follow-up or cold), offenders (arrested persons are jailed, then
  released by verdict or time; released offenders **recidivate**: suspect roles of later calls prefer them), witnesses
  who **move** (their record address changes), neighborhoods whose **crime index** evolves from trust, offenders at
  large and arrests (feeding the call generator and drifting trust), repeat-address calls, follow-up warrant service
  calls for open cases with a known suspect.
- **Optional co-op multiplayer** (`src/net`, `/server`). A Node 22 script (`node server/main.ts`, built-in `http` +
  `crypto`, a hand-written RFC 6455 frame codec, no npm dependency) hosts rooms with an **authoritative shared CAD**:
  patrol players (up to 4, each a unit; two can partner), one dispatcher player (the dispatch console is the main UI)
  and one supervisor. Clients send intents; the server validates schema, role permissions, state transitions, rate
  limits and position plausibility, applies them and broadcasts events. Each client simulates its own world from the
  room seed; what is shared is the CAD layer (calls, assignments, unit status, notes, orders, radio text, presence on
  the map). Off by default; local only; configured only by environment variable names; nothing is deployed.
- **Mods** (`src/mods`). A mod is a JSON bundle (one file) or a folder with a `mod.json` manifest, picked with a file
  input, validated against documented schemas (`docs/MODDING.md`, `docs/schemas/*.schema.json`) with clear error
  messages, stored in IndexedDB, enabled / disabled / ordered in the mod manager and applied **at page load** (the data
  loaders merge the active overlay before validating): call types, statutes and jurisdiction rulesets (laws),
  vehicles, uniform patches, a district table (maps), voice packs (TTS pitch / rate / voice preference + radio phrase
  tables) and dispatch scripts.
- **Accessibility** (`src/a11y`). Rebinding coverage of every new action (audited by a test), colour-blind palettes
  (protanopia, deuteranopia, tritanopia) for the UI (CSS variables), the minimap / MDT / console markers and the light
  bar, the existing radio captions verified for the new radio sources, the existing text scale applied to every new
  surface (em units), the reduced-flash rule audited for every animation, and **one-handed layouts** (left-hand and
  right-hand binding presets).
- **Training / sandbox modes** (`src/training`, UI in `src/ui/*`). Driving academy (cone course on a straight road),
  dispatch-only (play as the dispatcher with the dispatch console against AI units, optional dispatch script, live
  score), report-writing-only (exercises, no world), academy drills (firearms / defensive / legal, no world) and a
  scenario editor (place NPCs, vehicles, evidence and a call type on a top-down map; save / load / export / import as
  validated JSON; run it in the world).

Non-goals: physics / NPC state replication between co-op clients (each client runs its own scene of a shared call);
district *geometry* mods (the chunk worker regenerates the city from module constants; the "map" mod kind is the
district table); a mod scripting language; voice chat; persistence of training scores outside the browser.

## 2. Conventions (in addition to Phase 1-7 §2)

- **TS rules** unchanged: no enums / namespaces / parameter properties; `as const` objects + unions; `import type`;
  `noUncheckedIndexedAccess`; JSDoc on exports; no per-step allocation in `step` hot paths and renderer `update`
  (requests, events, UI actions, screens and the rollover may allocate).
- **Determinism.** New simulation state changes only in fixed steps or between steps while the session is paused
  (off-duty choices, the rollover, sandbox spawns: these are recorded inputs and part of the save). Random draws only
  from named streams: `session.rng.stream('career')`, `'worldstate'`, `'training'`; quiz / range draws from
  `createRng(seed).stream('academy:<module>:<attempt>')`; AI bidders from `createRng(seed).stream('bid:<callsign>')`;
  scenario editor person picks from `createRng(seed).stream('sandbox:<scenarioId>')`. `Math.random`, `Date.now`,
  `performance.now` are forbidden in `src/career`, `src/worldstate`, `src/training` (except `src/render/training`),
  `src/net/room.ts`, `src/net/protocol.ts`, `src/net/mirror.ts` (the room takes `nowMs` as a parameter). Hooks that
  draw a random number **only draw when their pool is non-empty**, so Phase 1-7 runs (empty pools) are bit-identical.
  Co-op sessions are not replay-deterministic (network timing); single-player is.
- **UI -> sim through queues / requests.** Career, world and training requests are queued and applied at the start of
  the owner's next fixed step. Bus handlers only enqueue.
- **Data** in `src/data/<area>/*.json` with `"version": 1`, validated at import by a typed validator throwing `Error`
  naming the file and the dotted JSON path (pattern: `src/vehicles/json.ts` readers `readObject`, `readNumber`,
  `readString`, `readOneOf`, `readArray`, `readVersion`, `fail`). Export `parseX(json, file)` and the parsed constant
  `X_DATA` / `X_CONFIG`. **Untrusted input** (mods, scenarios, dispatch scripts, network messages) is validated by
  functions that **return** `{ ok: true, value } | { ok: false, errors }` and never throw.
- **Headless.** DOM classes construct and run as no-ops without `document` (vitest = node). Canvas drawing goes
  through a structural `Canvas2DLike`-style interface where tests need it.
- **Generic content only.** "City Police"; no real agencies, ranks titles beyond generic ones, brands or assets.
  Quiz questions describe generic principles (reasonable suspicion, probable cause, consent, Miranda-style warnings
  are called "rights advisement"), never a real statute or case name. `docs/ASSETS.md` stays empty.
- **Units.** Game seconds (`CadTime.game`) for career / world times, hours for wellbeing rates, game dollars
  (integers) for money, 0..1 for wellbeing values.
- **Flashes.** HUD one-liners go out as `<module>:flash` `{ text }`.
- **Network code** (`src/net/**`) imports values only from other `src/net` files **with an explicit `.ts`
  extension** (`import { ROLES } from './protocol.ts'`) and nothing else at runtime (`import type` from anywhere is
  fine): `server/*.ts` runs under Node 22's built-in type stripping (`node server/main.ts`, verified with Node
  22.22.0), which needs explicit extensions and erasable syntax only. `src/net/**` must not use DOM or Node types.

## 3. Architecture

```
 boot (main.ts)        bootMods(): IndexedDB 'patrol-mods' -> setActiveOverlay(overlay) -> import('./app')
                       data loaders (calls, statutes, rulesets, vehicles, uniforms, trust, voices, phrases) merge modOverlay()

 fixed step (60 Hz)
 ┌───────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ (session) coop inbox drained -> CoopMirror -> local CAD ops (co-op only)                                       │
 │ dispatch (-700)  + manual dispatch, generator on/off, scripted calls, location bias (repeat addresses),        │
 │                    category weights (specialty), assignUnit / unassignUnit / setCallPriority                   │
 │ scene (-690)     + person bias (recidivists, follow-up suspects) in pickPersonFor                              │
 │ force (-685)     + accuracy factor (fatigue / stress aim spread)                                               │
 │ ... Phase 1-7 systems unchanged ...                                                                            │
 │ fleet (-655)                                                                                                   │
 │ career (-654)    CareerState: requests (stress, stats, academy scores, bids, applications, exams, endShift),   │
 │                  per game minute on duty: fatigue / stress tick, shift-over flash, overtime                    │
 │ worldstate (-653) WorldState: requests (callClosed -> premises, arrest / verdict -> offenders, cases, witnesses) │
 │ training (-652)  driving course run, dispatch script runner, dispatch scoring (mode dependent)                 │
 │ vehicles.pre 40  (session) steering lag from career performance mods                                           │
 └───────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 between steps (paused): academy minigames, off-duty activities, rollover (serialize -> evolve -> transform -> load),
                         sandbox plan execution, mod manager, lobby
 presentation: academy / career / apartment / summary screens, dispatch console, scenario editor, mod manager, co-op
               lobby + panel, HUD chips (wellbeing, shift, course, co-op), cone renderer, palette remap, premise history
 server (Node, optional): http upgrade -> ws frames -> Room (authoritative shared CAD) -> broadcast
```

- **Wave 1 (no new Phase 8 imports):** `career`, `worldstate`, `training` (modes, course, scripts, scoring,
  scenarios, cone renderer + the dispatch / scene / force hooks), `net` (protocol, room authority, mirror, client,
  server), `a11y` (palette, layouts, settings, input actions, settings menu, styles, light-bar palette).
- **Wave 2:** `mods` (imports `training` for the dispatch-script validator).
- **Wave 3:** `uiCareer` (academy minigames, career / apartment / summary screens, MDT premise history and cases tab,
  HUD) and `uiModes` (dispatch console, scenario editor, mod manager, co-op lobby / panel, main menu). They never
  import each other's Phase 8 additions.
- Importing **pre-existing Phase 0-7 exports** of a file another module owns is always allowed; only Phase 8
  additions of a same-wave module are off limits (use the contract literal or a parameter).

## 4. Shared contracts

### 4.1 Fixed id lists (contracts)

| List | Ids | Defined by (file) |
|---|---|---|
| `CAREER_STAGES` | `academy probation patrol separated` | career `src/career/types.ts` |
| `CAREER_RANKS` | `officer corporal sergeant lieutenant captain` (a subset of the uniform `RANK_IDS`) | career |
| `SPECIALTY_IDS` | `traffic k9 detective swat narcotics air` | career |
| `DUTY_ASSIGNMENTS` | `patrol fto traffic k9 detective swat narcotics air` | career |
| `ACADEMY_MODULES` | `driving firearms defensive report legal` | career |
| `SHIFT_SLOTS` | `day swing night` (start hours 6, 14, 22; 8 h) | career |
| `BEATS` | `downtown suburbs industrial highway` | career |
| `OFF_DUTY_ACTIVITIES` | `rest exercise family secondJob` | career |
| `STRESS_EVENTS` | `forceUsed firearmDischarged officerInjured pursuit deceasedOnScene iaOpened iaSustained courtLoss commendation criticalIncident arrestMade callCleared` | career |
| `DOR_CATEGORIES` | `safety procedure reports community driving` | career |
| `PREMISE_FLAGS` | `weapon violence arrest officerSafety drugs mentalHealth repeat` | worldstate `src/worldstate/types.ts` |
| `CASE_STATUSES` | `open followUp cleared cold` | worldstate |
| `OFFENDER_CUSTODY` | `jailed released atLarge` | worldstate |
| `OFFENSE_CLASSES` | `infraction misdemeanor felony warrant` (= cad `STATUTE_CLASSES`) | worldstate |
| `GAME_MODES` | `freePatrol career drivingAcademy dispatchOnly sandbox coop` | training `src/training/mode.ts` |
| `NET_ROLES` | `patrol dispatcher supervisor` | net `src/net/protocol.ts` |
| `ORDER_KINDS` | `respond returnToStation terminatePursuit code4 backup` | net |
| `REJECT_CODES` | `malformed version unknownType forbidden notFound illegalState invalidValue rate full` | net |
| `ONE_HANDED_LAYOUTS` | `off left right` | a11y `src/a11y/layouts.ts` |
| `SEMANTIC_COLORS` | `unit unitBusy emergency suspect pursuit person ok caution alert accent accent2 p1 p2 p3 p4` | a11y `src/a11y/palette.ts` |
| `MOD_CONTENT_KINDS` | `callTypes statutes rulesets vehicles uniforms districts voicePacks dispatchScripts` | mods `src/mods/types.ts` |
| New input actions | `career.menu` (button, `Minus`), `coop.menu` (button, `Digit0`), `dispatch.console` (button, `Home`) | a11y `src/input/actions.ts`, `bindings.ts` |
| New MDT tab | `cases` (appended to `MDT_TABS`, arrow-reachable) | uiCareer `src/ui/mdt/types.ts` |

### 4.2 Shared types (owners export them; later waves import)

```ts
// career — src/career/types.ts
export interface Wellbeing { fatigue: number; stress: number; health: number; fitness: number; family: number; sleepDebtH: number }
export interface PerformanceMods { aimSpread: number; steerLagS: number; vignette: number }   // aimSpread >= 1
export interface EligibilityContext { points: number; credibility: number; sustainedIaRecent: number; avgReport: number }
export interface Eligibility { ok: boolean; reasons: string[] }
export interface CareerView { /* §5.8 */ }

// worldstate — src/worldstate/types.ts
export interface PremiseEntry { game: number; callNumber: string; typeId: string; nature: string; disposition: string; flags: PremiseFlag[] }
export interface CaseRecord { /* §6.2 */ }

// training — src/training/mode.ts, scenario.ts, script.ts
export interface ModeSave { /* §7.1 */ }
export interface SandboxScenario { /* §7.5 */ }
export interface DispatchScript { /* §7.4 */ }
export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

// net — src/net/protocol.ts (§8.1)
export interface NetCall { ... } export interface NetUnit { ... } export type RoomEvent = ...;
```

### 4.3 Event topics (declaration merging in the owner's `events.ts`)

| Topic | Owner file | Payload |
|---|---|---|
| `career:flash` | career `src/career/events.ts` | `{ text: string }` |
| `career:stage` | career | `{ stage: CareerStage; rank: CareerRank; assignment: DutyAssignment }` (emitted on any change of the three) |
| `career:shiftSummary` | career | `ShiftSummary` (§5.6), emitted by the `endShift` request |
| `career:points` | career | `{ delta: number; reason: string; key: string }` (FTO trainee rating, promotion bonus; bridged to conduct points) |
| `world:recidivist` | worldstate `src/worldstate/events.ts` | `{ personId: number; callId: number; arrests: number }` |
| `world:case` | worldstate | `{ caseId: string; callId: number; status: CaseStatus }` |
| `world:flash` | worldstate | `{ text: string }` |
| `training:course` | training `src/training/events.ts` | `{ gate: number; gates: number; cones: number; missed: number; done: boolean; score: number; timeS: number }` (on gate pass, cone hit, finish, abort) |
| `training:dispatchScore` | training | `{ callNumber: string; score: number; total: number }` (a scored call closed) |
| `training:flash` | training | `{ text: string }` |
| `coop:status` | integrator `src/core/event-map.ts` | `{ connected: boolean; role: string; unit: string; members: number; room: string }` |
| `coop:order` | integrator | `{ from: string; order: string; callId: number; text: string }` |
| `coop:flash` | integrator | `{ text: string }` |

No new components in `src/ecs/components.ts` (§14).

## 5. Career [career] — wave 1

Owns `src/career/**`, `src/data/career/**`, `test/career/**`. Imports pre-existing: `src/vehicles/json.ts`
readers, `src/core/rng.ts`, `src/core/events.ts` / `event-map.ts` (types), `src/cad/types.ts` (`CadTime`),
`src/environment/crime.ts` (`CRIME_CATEGORIES`), `src/environment/time.ts` (`SECONDS_PER_DAY`). Nothing else.

### 5.1 Types (`src/career/types.ts`)

The id lists of §4.1 as `as const` arrays plus their unions (`CareerStage`, `CareerRank`, `SpecialtyId`,
`DutyAssignment`, `AcademyModule`, `ShiftSlot`, `Beat`, `OffDutyActivity`, `StressEvent`, `DorCategory`) and:

```ts
export interface AcademyRecord { best: number; attempts: number; passed: boolean }   // best 0..100, -1 never tried
export interface ShiftAssignment { slot: ShiftSlot; beat: Beat }
export interface ShiftClock { onDuty: boolean; shiftNo: number; startGame: number; endGame: number; overFlashed: boolean }
export interface ShiftStats {
  calls: number; arrests: number; reports: number; reportSum: number;         // reportSum / reports = avg grade 0..100
  forceEvents: number; unjustifiedForce: number; unlawfulDeterminations: number;
  pursuits: number; fleetPoints: number; trustDelta: number; courtMinutes: number; overtimeMinutes: number;
}
export interface PayBreakdown { shiftNo: number; hours: number; base: number; night: number; specialty: number; fto: number;
  overtime: number; court: number; deductions: number; total: number }
export interface DorReport { shiftNo: number; scores: Record<DorCategory, number>; average: number; notes: string[] }
export type CareerEventKind = 'graduated' | 'probationPassed' | 'probationExtended' | 'separated' | 'promoted' | 'assigned'
  | 'bidAwarded' | 'stressLeave' | 'rent' | 'note';
export interface CareerEvent { game: number; kind: CareerEventKind; text: string }
export interface BidPref { slot: ShiftSlot; beat: Beat }
export interface Bidder { id: string; name: string; seniority: number; probation: boolean; prefs: readonly BidPref[] }
export interface BidAward { id: string; slot: ShiftSlot; beat: Beat; prefRank: number }   // 0-based, -1 = fallback
export interface OffDutyPlanItem { activity: OffDutyActivity; hours: number }
export interface Trainee { name: string; truth: Record<DorCategory, number> }            // FTO assignment
export interface ShiftSummary { shiftNo: number; pay: PayBreakdown; dor: DorReport | null; stats: ShiftStats;
  events: CareerEvent[]; wellbeing: Wellbeing; nextStartGame: number; nextEndGame: number }
```
`Wellbeing`, `PerformanceMods`, `EligibilityContext`, `Eligibility` as in §4.2.

### 5.2 Data (`src/data/career/*.json`, `src/career/data.ts`)

`career.json` (exact values; validator `parseCareerConfig(json, file)` -> `CAREER_CONFIG`):
```json
{ "version": 1,
  "academy": { "pass": { "driving": 70, "firearms": 75, "defensive": 70, "report": 70, "legal": 70 }, "quizQuestions": 10 },
  "probation": { "shifts": 5, "passAverage": 3.0, "extensionShifts": 3 },
  "shift": { "hours": 8, "startHour": { "day": 6, "swing": 14, "night": 22 }, "rotation": [1, 1, 1, 1, 1, 0, 0],
             "minRestH": 8, "commuteH": 1 },
  "bidding": { "everyShifts": 10, "capacity": 2, "maxPrefs": 4, "syntheticBidders": 9 },
  "pay": { "hourly": { "officer": 30, "corporal": 33, "sergeant": 38, "lieutenant": 44, "captain": 50 },
           "nightPerHour": 2, "ftoPerHour": 3, "overtimeMultiplier": 1.5, "courtMultiplier": 1.5,
           "rentPerWeek": 600, "startingMoney": 1500 },
  "wellbeing": {
    "fatiguePerHour": 0.06, "slotFactor": { "day": 1.0, "swing": 1.1, "night": 1.35 }, "sleepDebtFactor": 0.5,
    "stressDecayOnDutyPerHour": 0.01,
    "stress": { "forceUsed": 0.05, "firearmDischarged": 0.2, "officerInjured": 0.25, "pursuit": 0.06, "deceasedOnScene": 0.15,
                "iaOpened": 0.1, "iaSustained": 0.15, "courtLoss": 0.05, "commendation": -0.05, "criticalIncident": 0.12,
                "arrestMade": 0.01, "callCleared": -0.005 },
    "activities": {
      "rest":      { "fatigue": -0.09, "stress": -0.01, "fitness": 0, "family": 0, "money": 0, "sleep": 1, "maxPerDay": 12 },
      "exercise":  { "fatigue": 0.03, "stress": -0.05, "fitness": 0.03, "family": 0, "money": 0, "sleep": 0, "maxPerDay": 3 },
      "family":    { "fatigue": 0.0, "stress": -0.06, "fitness": 0, "family": 0.08, "money": 0, "sleep": 0, "maxPerDay": 6 },
      "secondJob": { "fatigue": 0.05, "stress": 0.02, "fitness": 0, "family": -0.02, "money": 25, "sleep": 0, "maxPerDay": 8 } },
    "idle": { "fatigue": -0.03, "stress": -0.005, "sleep": 0.5 },
    "neglect": { "familyPerDay": 0.05, "familyStressBelow": 0.3, "familyStress": 0.04, "exerciseGraceDays": 3,
                 "fitnessPerDay": 0.02, "debtStress": 0.05, "sleepNeedH": 8, "healthRecoveryPerDay": 0.05 },
    "performance": { "aimFatigue": 0.8, "aimStress": 0.6, "lagMaxS": 0.25, "lagFrom": 0.6, "vignetteFrom": 0.7 },
    "fit": { "minHealth": 0.35, "maxStress": 0.95 } },
  "range": { "targets": 12, "noShoot": 3, "durationS": 45, "radius": 0.06, "showS": [1.6, 2.6], "swayBase": 0.012 },
  "fto": { "minSeniorityShifts": 40, "minAvgReport": 70, "minPoints": 50, "pointsPerAccuracy": 10 },
  "promotions": {
    "corporal":   { "minSeniorityShifts": 40,  "minPoints": 100, "exam": 0,  "maxSustainedIa": 0 },
    "sergeant":   { "minSeniorityShifts": 80,  "minPoints": 250, "exam": 75, "maxSustainedIa": 0 },
    "lieutenant": { "minSeniorityShifts": 150, "minPoints": 500, "exam": 80, "maxSustainedIa": 0 },
    "captain":    { "minSeniorityShifts": 250, "minPoints": 900, "exam": 85, "maxSustainedIa": 0 } } }
```
`specialties.json` (`parseSpecialties(json, file)` -> `SPECIALTIES: Readonly<Record<SpecialtyId, SpecialtyDef>>`;
`callWeights` keys must be `CRIME_CATEGORIES`, academy keys `ACADEMY_MODULES`):
```json
{ "version": 1, "units": {
  "traffic":   { "label": "Traffic Unit", "description": "Collisions, speeding and impaired drivers.", "minSeniorityShifts": 10, "minRank": "officer",
                 "academy": { "driving": 80 }, "minPoints": 0, "maxSustainedIa": 0, "minHealth": 0.6, "minFitness": 0, "payPerHour": 2,
                 "fleetClass": "traffic", "uniformClass": "classB", "callWeights": { "traffic": 3, "dui": 2 } },
  "k9":        { "label": "K9 Unit", "description": "Searches, tracks and building sweeps.", "minSeniorityShifts": 20, "minRank": "officer",
                 "academy": { "defensive": 75 }, "minPoints": 50, "maxSustainedIa": 0, "minHealth": 0.7, "minFitness": 0.5, "payPerHour": 3,
                 "fleetClass": "k9", "uniformClass": "tactical", "callWeights": { "burglary": 1.6, "suspicious": 1.6, "robbery": 1.3 } },
  "detective": { "label": "Detective Bureau", "description": "Follow-ups, interviews and case work.", "minSeniorityShifts": 30, "minRank": "officer",
                 "academy": { "report": 85, "legal": 80 }, "minPoints": 100, "maxSustainedIa": 0, "minHealth": 0.4, "minFitness": 0, "payPerHour": 4,
                 "fleetClass": "unmarked", "uniformClass": "detective", "callWeights": { "burglary": 2, "theft": 2, "robbery": 1.5, "assault": 1.5 } },
  "swat":      { "label": "Tactical Team", "description": "High-risk warrants and barricades.", "minSeniorityShifts": 30, "minRank": "officer",
                 "academy": { "firearms": 85, "defensive": 80 }, "minPoints": 100, "maxSustainedIa": 0, "minHealth": 0.8, "minFitness": 0.7, "payPerHour": 4,
                 "fleetClass": "swat", "uniformClass": "swat", "callWeights": { "robbery": 1.5, "assault": 1.5 } },
  "narcotics": { "label": "Narcotics Unit", "description": "Drug activity and impaired subjects.", "minSeniorityShifts": 25, "minRank": "officer",
                 "academy": { "legal": 80 }, "minPoints": 75, "maxSustainedIa": 0, "minHealth": 0.5, "minFitness": 0, "payPerHour": 3,
                 "fleetClass": "unmarked", "uniformClass": "detective", "callWeights": { "suspicious": 2, "dui": 1.5 } },
  "air":       { "label": "Air Support", "description": "Overwatch for pursuits and searches.", "minSeniorityShifts": 40, "minRank": "officer",
                 "academy": { "driving": 85 }, "minPoints": 150, "maxSustainedIa": 0, "minHealth": 0.8, "minFitness": 0.4, "payPerHour": 4,
                 "fleetClass": "air", "uniformClass": "classB", "callWeights": { "traffic": 1.2 } } } }
```
`legalQuiz.json` (`parseLegalQuiz` -> `LEGAL_QUIZ`): `{ "version": 1, "questions": [ { "id": "q01", "level":
"academy" | "sergeant" | "lieutenant" | "captain", "topic": string, "q": string, "options": [4 strings], "answer":
0..3, "explain": string } ] }` — at least 30 `academy`, 12 `sergeant`, 12 `lieutenant`, 12 `captain` questions of
generic policing principles (stops and detention, reasonable suspicion vs probable cause, consent searches, plain view,
vehicle searches, rights advisement before custodial questioning, force continuum and de-escalation, duty to
intervene, report accuracy, evidence chain of custody, pursuit policy, supervision and discipline for the higher
levels). Ids unique.
`defensive.json` (`parseDefensive` -> `DEFENSIVE_DRILLS`): `{ "version": 1, "timeLimitS": 8, "drills": [ { "id",
"situation": string, "resistance": "compliant" | "passive" | "active" | "assaultive" | "lethal", "options": [ {
"text", "grade": "correct" | "partial" | "wrong" } ] (3-4, exactly one correct) } ] }` — at least 16 drills.
`reportExercises.json` (`parseReportExercises` -> `REPORT_EXERCISES`): `{ "version": 1, "exercises": [ { "id",
"title", "narrative": string[] (paragraphs), "statements": [ { "id", "text", "truth": boolean, "key": boolean } ]
(8-12; `key` only on true statements; >= 3 key) } ] }` — at least 6 exercises (traffic stop, shoplifting, domestic
disturbance, burglary report, collision, welfare check).

### 5.3 Wellbeing (`src/career/wellbeing.ts`, pure) — mandatory tests

All functions clamp every value to 0..1 (`sleepDebtH` to 0..24) and take the config section as a parameter
(default `CAREER_CONFIG.wellbeing`).
```ts
export function newWellbeing(): Wellbeing  // { fatigue 0.1, stress 0.15, health 1, fitness 0.6, family 0.7, sleepDebtH 0 }
/** base * slotFactor[slot] * (1 + sleepDebtFactor * min(sleepDebtH, 16) / 8) * (1.2 - 0.4 * fitness) */
export function fatigueRatePerHour(slot: ShiftSlot, w: Readonly<Wellbeing>, cfg?): number
/** On duty for `minutes`: fatigue += rate * minutes / 60; stress -= stressDecayOnDutyPerHour * minutes / 60. Mutates `w`. */
export function tickOnDuty(w: Wellbeing, minutes: number, slot: ShiftSlot, cfg?): void
/** delta = cfg.stress[ev]; positive deltas scale by (1.2 - 0.2 * fitness - 0.2 * family); returns the applied delta. */
export function applyStressEvent(w: Wellbeing, ev: StressEvent, cfg?): number
/** health -= amount; stress += 0.5 * amount. */
export function applyInjury(w: Wellbeing, amount: number): void
/** Per-hour activity deltas x hours (fatigue, stress, fitness, family); returns { moneyDelta, sleptH }. */
export function applyActivity(w: Wellbeing, a: OffDutyActivity, hours: number, cfg?): { moneyDelta: number; sleptH: number }
/** Unplanned off-duty hours: idle deltas x hours; returns sleptH = idle.sleep * hours. */
export function applyIdle(w: Wellbeing, hours: number, cfg?): number
/**
 * Once per off-duty period (at Report for duty): sleepDebtH += max(0, sleepNeedH - sleptH) then -= sleptH beyond the need
 * (never below 0); no family time -> daysWithoutFamily++ and family -= familyPerDay * daysWithoutFamily, else reset to 0;
 * family < familyStressBelow -> stress += familyStress; no exercise -> daysWithoutExercise++, beyond exerciseGraceDays
 * fitness -= fitnessPerDay, else reset; money < 0 -> stress += debtStress; health += healthRecoveryPerDay * days.
 */
export function applyNeglect(w: Wellbeing, n: { daysWithoutFamily: number; daysWithoutExercise: number },
  day: { family: boolean; exercise: boolean; sleptH: number; money: number; days: number }, cfg?): void
/** Allocation-free with `out`: aimSpread = 1 + aimFatigue * max(0, fatigue - 0.5) + aimStress * max(0, stress - 0.5);
 *  steerLagS = lagMaxS * max(0, fatigue - lagFrom) / (1 - lagFrom); vignette = max(0, fatigue - vignetteFrom) / (1 - vignetteFrom). */
export function performanceMods(w: Readonly<Wellbeing>, out: PerformanceMods, cfg?): PerformanceMods
/** health >= fit.minHealth and stress < fit.maxStress; reason text otherwise ("Injured: light duty", "Critical stress: mandatory leave"). */
export function fitForDuty(w: Readonly<Wellbeing>, cfg?): { ok: boolean; reason: string }
```
Tests (`test/career/wellbeing.test.ts`): night shift tires faster than day (same 8 h); sleep debt and low fitness
increase the rate; stress events add the table delta scaled by resilience, commendation lowers stress; values clamp at
0 and 1; activities: rest lowers fatigue and counts sleep, exercise raises fitness and fatigue, family raises family,
second job earns 25/h and costs family; neglect: no family two periods in a row lowers family by 0.05 then 0.10 and
adds stress below 0.3, exercise grace, debt stress, sleep debt accumulation and recovery; performance mods at
(0.2, 0.2) are exactly { 1, 0, 0 }, at fatigue 0.9 stress 0.8 aimSpread = 1 + 0.32 + 0.18, steerLag = 0.1875,
vignette = 0.6667; `fitForDuty` thresholds; `performanceMods` allocates nothing (same `out` returned).

### 5.4 Shift schedule and bidding (`src/career/bidding.ts`, pure) — mandatory tests

```ts
/**
 * Next shift start strictly after `afterGame + minRestH * 3600`: the first day d (epoch day of game seconds) whose
 * rotation[(d % 7 + 7) % 7] is 1, at startHour[slot]; returns { startGame, endGame = startGame + hours * 3600 }.
 */
export function nextShiftStart(afterGame: number, slot: ShiftSlot, cfg?): { startGame: number; endGame: number }
/** The 12 positions in canonical order: SHIFT_SLOTS x BEATS ('day:downtown', 'day:suburbs', ...). */
export function positionKeys(): readonly string[]
/** Synthetic + roster AI bidders: seniority = 20 + (hashString(`${seed}:bid:${id}`) % 400); prefs = the first `maxPrefs`
 *  of positionKeys() shuffled (Fisher-Yates) with createRng(seed).stream(`bid:${id}`), day slots moved ahead with
 *  probability 0.5 per pref (one draw each); probation false. `roster` = the AI patrol units (callsign, name); then
 *  `syntheticBidders` more with ids 'S1'.. and names from `names` (round robin). */
export function aiBidders(seed: number, roster: readonly { id: string; name: string }[], names: readonly string[], cfg?): Bidder[]
/**
 * Seniority order: non-probation first, then seniority descending, then id ascending (string compare). Each bidder takes
 * its first preference with capacity left (prefRank = index), else the first position of positionKeys() with capacity
 * (prefRank -1), else no award. `capacity` = remaining seats per position key (copied, not mutated).
 */
export function resolveBids(bidders: readonly Bidder[], capacity: Readonly<Record<string, number>>): BidAward[]
export function uniformCapacity(seats: number): Record<string, number>   // every position key -> seats
```
Tests (`test/career/bidding.test.ts`): highest seniority gets its first choice; a junior bidder with the same first
choice gets it only while capacity remains, else its second; probationers bid last regardless of seniority; ties by
id; fallback order; no award when every seat is taken; `resolveBids` does not mutate its inputs and is deterministic;
`aiBidders` deterministic per seed, different per seed; `nextShiftStart` skips rotation days off, respects the
minimum rest, night slot starts at 22:00 the same day when rest allows.

### 5.5 Progression, pay and academy grading (`progression.ts`, `pay.ts`, `academy.ts`, pure) — mandatory tests

```ts
// progression.ts
export function academyPassed(academy: Readonly<Record<AcademyModule, AcademyRecord>>, cfg?): boolean  // every module passed
/** Records an attempt: attempts++, best = max(best, score), passed ||= score >= pass[module]. Returns a new record. */
export function recordAcademyScore(r: AcademyRecord, module: AcademyModule, score: number, cfg?): AcademyRecord
/** DOR 1..5 per category (rounded to 0.5): safety = 5 - 2*unjustifiedForce - (forceEvents > 3 ? 1 : 0);
 *  procedure = 5 - 1.5*unlawfulDeterminations; reports = reports === 0 ? 3 : 1 + 4*(reportSum/reports)/100;
 *  community = 3 + clamp(trustDelta * 100, -2, 2); driving = 5 + fleetPoints / 10 (fleetPoints <= 0). Notes name every
 *  category below 3 ("Report writing needs work"). */
export function dorFromStats(shiftNo: number, s: Readonly<ShiftStats>): DorReport
/** After a probation shift: left - 1; at 0: average of the dors of this probation >= passAverage -> 'passed';
 *  else not extended -> 'extended' (left = extensionShifts) else 'separated'; otherwise 'continue'. */
export function probationStep(left: number, extended: boolean, dors: readonly DorReport[], cfg?):
  { outcome: 'continue' | 'passed' | 'extended' | 'separated'; left: number; extended: boolean }
export function rankIndex(r: CareerRank): number
/** Every unmet requirement as a reason ("Needs 20 shifts of seniority (have 12)", "Firearms score 85 required (best 78)",
 *  "Fitness 70% required", "No sustained IA findings allowed", "Career points 100 required (have 40)"). Stage must be
 *  'patrol'; the officer must not already be in that unit. */
export function specialtyEligibility(unit: SpecialtyId, c: CareerEligibilityInput, ctx: EligibilityContext): Eligibility
export function ftoEligibility(c: CareerEligibilityInput, ctx: EligibilityContext, cfg?): Eligibility
/** Next rank only (rankIndex + 1), seniority, points, sustained IA; `exam` > 0 means an exam is needed (UI runs the quiz). */
export function promotionEligibility(target: CareerRank, c: CareerEligibilityInput, ctx: EligibilityContext, cfg?): Eligibility & { exam: number }
export interface CareerEligibilityInput { stage: CareerStage; rank: CareerRank; assignment: DutyAssignment;
  seniorityShifts: number; academy: Readonly<Record<AcademyModule, AcademyRecord>>; wellbeing: Readonly<Wellbeing> }
/** accuracy = 1 - mean(|rating - truth|) / 4 over the categories; points = round(accuracy * pointsPerAccuracy). */
export function rateTrainee(ratings: Readonly<Record<DorCategory, number>>, t: Readonly<Trainee>, cfg?): { accuracy: number; points: number }
export function newTrainee(rng: Rng, names: readonly string[]): Trainee   // truth: rng.nextInt(1, 5) per category in DOR_CATEGORIES order
/** Effects of an assignment: the specialty row (callWeights, fleetClass, uniformClass, payPerHour) or the patrol / fto defaults
 *  ({}, 'patrol', 'classB', 0 / ftoPerHour). */
export function assignmentEffects(a: DutyAssignment, cfg?): { callWeights: Readonly<Record<string, number>>; fleetClass: string; uniformClass: string; payPerHour: number }

// pay.ts
/** hours = (endGame - startGame) / 3600 scheduled; base = hours * hourly[rank]; night = slot night ? hours * nightPerHour : 0;
 *  specialty / fto = hours * payPerHour; overtime = overtimeMinutes / 60 * hourly * overtimeMultiplier; court = courtMinutes / 60
 *  * hourly * courtMultiplier; deductions = suspended ? base + night + specialty + fto : 0; all rounded to whole dollars. */
export function payForShift(input: { shiftNo: number; rank: CareerRank; assignment: DutyAssignment; slot: ShiftSlot;
  startGame: number; endGame: number; stats: Readonly<ShiftStats>; suspended: boolean }, cfg?): PayBreakdown
/** Rent due when floor(epochDay / 7) advanced since lastRentDay: rentPerWeek per week elapsed. */
export function rentDue(lastRentDay: number, epochDay: number, cfg?): { amount: number; weeks: number }

// academy.ts
export function drawQuiz(level: 'academy' | 'sergeant' | 'lieutenant' | 'captain', n: number, rng: Rng, questions?): string[]  // Fisher-Yates of the level's ids, first n
export function gradeQuiz(ids: readonly string[], answers: readonly number[], questions?): { score: number; correct: number; total: number }
export function gradeDefensive(ids: readonly string[], picks: readonly number[], drills?): number   // correct 10, partial 5, wrong / -1 (timeout) 0; score = 100 * sum / (10 * n)
export function gradeReportExercise(exerciseId: string, selected: readonly string[], exercises?):
  { score: number; missing: string[]; falseSelected: string[] }   // round(70 * keyCompleteness + 30 - 15 * falseSelected), clamp 0..100
export interface RangeTarget { id: number; x: number; y: number; radius: number; appearAt: number; duration: number; noShoot: boolean }
/** `targets` targets, `noShoot` of them no-shoot, positions in 0.1..0.9, appearAt spread over durationS - 3, duration in showS;
 *  drawn from createRng(seed).stream(`academy:firearms:${attempt}`). Sorted by appearAt. */
export function rangeSchedule(seed: number, attempt: number, cfg?): RangeTarget[]
/** Aim sway in normalized screen units: amplitude = swayBase * aimSpread; x = a*sin(1.3 t) + 0.5a*sin(3.1 t), y = a*cos(1.7 t). */
export function swayOffset(tS: number, mods: Readonly<PerformanceMods>, out: { x: number; y: number }, cfg?): { x: number; y: number }
/** Each shot {t, x, y} hits the active target (appearAt <= t < appearAt + duration) nearest within radius; ring = 10 -
 *  floor(5 * d / radius); only each target's best shot counts; no-shoot hit -15 each; score = clamp(round(100 * rings /
 *  (10 * shootTargets) - 15 * noShootHits), 0, 100). */
export function scoreRange(targets: readonly RangeTarget[], shots: readonly { t: number; x: number; y: number }[]):
  { score: number; hits: number; noShootHits: number; misses: number }
```
Tests (`test/career/progression.test.ts`, `pay.test.ts`, `academy.test.ts`): graduation needs all five modules; best
score and attempts; DOR categories from stats (each formula, clamping, notes); probation passes, extends once, then
separates; specialty eligibility for each unit with one failing requirement at a time (reason text contains the
number), FTO and promotion eligibility (next rank only, exam value); pay for a day shift, a night shift with overtime
and court time, a suspended shift; rent per week; quiz draw deterministic and level-filtered; grading formulas;
range schedule deterministic per (seed, attempt) with exactly `noShoot` no-shoot targets; scoring of center hits,
ring edges, no-shoot hits and misses; `swayOffset` amplitude grows with `aimSpread`.

### 5.6 CareerState (`src/career/careerState.ts`, `save.ts`, `events.ts`)

```ts
export interface CareerSave {
  version: 1;
  rng: RngState;                                   // session stream 'career'
  stage: CareerStage; rank: CareerRank; assignment: DutyAssignment;
  seniorityShifts: number; probationShiftsLeft: number; probationExtended: boolean;
  academy: Record<AcademyModule, AcademyRecord>;
  wellbeing: Wellbeing; money: number; lastRentDay: number;
  shift: ShiftClock; slot: ShiftAssignment;
  bid: { nextBidShift: number; prefs: BidPref[]; lastAwards: BidAward[] };
  stats: ShiftStats;
  pay: PayBreakdown[];                             // newest last, <= 30
  dor: DorReport[];                                // newest last, <= 20 (probation DORs carry the probation's shiftNo)
  history: CareerEvent[];                          // newest last, <= 100
  neglect: { daysWithoutFamily: number; daysWithoutExercise: number };
  offDuty: { hoursLeft: number; plan: OffDutyPlanItem[]; nextStartGame: number; nextEndGame: number } | null;
  trainee: Trainee | null;
  queue: CareerRequest[];
}
export function newCareerSave(rng: RngState, opts: { stage: CareerStage; rank?: CareerRank; startGame: number }): CareerSave
/** v9 -> v10: stage 'patrol', rank officer, seniority 0, academy all { best -1, attempts 0, passed: true } (grandfathered),
 *  slot night downtown, shift on duty from `nowGame` for 8 h, startingMoney. */
export function legacyCareerSave(rng: RngState, nowGame: number): CareerSave
export function isCareerSave(x: unknown): x is CareerSave          // full structural check of every field and enum
export type CareerRequest =
  | { kind: 'stress'; event: StressEvent }
  | { kind: 'injury'; amount: number }
  | { kind: 'stat'; key: keyof ShiftStats; delta: number }
  | { kind: 'academyScore'; module: AcademyModule; score: number }
  | { kind: 'graduate' }
  | { kind: 'endShift'; ctx: EligibilityContext; suspended: boolean }
  | { kind: 'submitBid'; prefs: BidPref[] }
  | { kind: 'resolveBids'; bidders: Bidder[] }
  | { kind: 'applySpecialty'; unit: SpecialtyId; ctx: EligibilityContext }
  | { kind: 'applyFto'; ctx: EligibilityContext }
  | { kind: 'returnToPatrol' }
  | { kind: 'promotion'; rank: CareerRank; examScore: number; ctx: EligibilityContext }
  | { kind: 'traineeRating'; ratings: Record<DorCategory, number> };

export interface CareerDeps { readonly bus: EventBus<EventMap>; readonly rng: Rng; readonly config?: CareerConfig;
  /** Trainee / bidder names (the integrator passes roster officer names). */ readonly names: readonly string[] }

export class CareerState {
  constructor(deps: CareerDeps, save?: CareerSave)
  get revision(): number
  get view(): CareerView                     // cached per revision
  performance(out: PerformanceMods): PerformanceMods   // performanceMods(wellbeing), allocation-free
  request(r: CareerRequest): void
  /** Fixed step (-654): drain requests; then once per game minute (floor(t.game / 60) changed): when shift.onDuty,
   *  tickOnDuty(1 min); when t.game > shift.endGame: stats.overtimeMinutes++ and, once, `career:flash`
   *  "Shift over — return to the station and End shift (overtime counts)". Never draws random numbers per minute. */
  step(dt: number, t: CadTime): void
  // Between steps (the apartment screen pauses the game):
  /** Validates hours (> 0, <= hoursLeft, <= maxPerDay minus hours already planned for that activity), applies it, money += delta. */
  planActivity(a: OffDutyActivity, hours: number): { ok: boolean; reason: string }
  /** Ends the off-duty period: idle for the hours left, applyNeglect, rent (rentDue at epochDay), shift.startGame /
   *  endGame = offDuty.next*, onDuty true, shiftNo + 1, stats reset, offDuty null, a new trainee when assignment 'fto';
   *  bids resolve when shiftNo >= bid.nextBidShift (the integrator queues 'resolveBids' first); returns fitForDuty. */
  reportForDuty(epochDay: number): { ok: boolean; reason: string }
  serialize(): CareerSave
  restore(s: CareerSave): void
}
```
Request semantics (applied in `step`): `stress` -> `applyStressEvent`; `injury` -> `applyInjury`; `stat` -> add;
`academyScore` -> `recordAcademyScore` (stage must be academy, or any stage for re-qualification of firearms / driving:
always recorded); `graduate` -> when `academyPassed`: stage probation, `probationShiftsLeft = probation.shifts`, slot
night / first beat, history `graduated`, `career:stage`; `endShift` -> pay (`payForShift`, money += total), DOR when
stage probation (`dorFromStats`, then `probationStep`: passed -> stage patrol, history, `career:stage`; extended /
separated likewise), seniorityShifts + 1 when stage patrol, onDuty false, `offDuty = { hoursLeft = (next.start -
t.game) / 3600 - commuteH, plan: [], next = nextShiftStart(t.game, slot) }`, emit `career:shiftSummary`;
`submitBid` -> store up to `maxPrefs` unique prefs; `resolveBids` -> the player is a `Bidder` (id 'player', seniority
= seniorityShifts, probation = stage !== 'patrol', prefs = bid.prefs or the current slot), `resolveBids(all,
uniformCapacity(capacity))`, the player's award (or the current slot when none) becomes `slot`, history
`bidAwarded`, `nextBidShift += everyShifts`; `applySpecialty` / `applyFto` -> eligibility, then assignment +
history `assigned` + `career:stage`, or `career:flash` with the first reason; `returnToPatrol` -> assignment patrol;
`promotion` -> eligibility and `examScore >= exam` -> rank + 1, history `promoted`, `career:stage`, `career:points`
{ delta 25, reason 'Promotion', key `promo:<rank>` }; else flash; `traineeRating` (assignment fto, trainee present)
-> `rateTrainee`, `career:points`, trainee null.

`CareerView` = `{ stage, rank, assignment, seniorityShifts, probationShiftsLeft, academy, wellbeing, money, shift,
slot, bid, stats, pay, dor, history, offDuty, trainee, performance: PerformanceMods }` (read-only references,
rebuilt per revision).

Tests (`test/career/careerState.test.ts`): an academy -> graduation -> probation (5 shifts with scripted stats) ->
patrol run; end shift pays and opens off duty with the right hours; planActivity limits; reportForDuty applies idle,
neglect, rent and starts the next shift; overtime counted after endGame with exactly one flash; bids resolved at the
bid shift; specialty application success and refusal; promotion with and without an exam; FTO trainee rating points;
serialize -> restore -> serialize round trip is identical; `isCareerSave` rejects each malformed field.

## 6. Persistent world [worldstate] — wave 1

Owns `src/worldstate/**`, `src/data/worldstate/**`, `test/worldstate/**`. Imports pre-existing `core/rng`,
`core/events`, `cad/types` (types), `environment/crime` (`CRIME_DISTRICTS`), `vehicles/json` readers.

### 6.1 Data (`src/data/worldstate/world.json`, `parseWorldConfig` -> `WORLD_CONFIG`)

```json
{ "version": 1,
  "premises": { "max": 400, "entriesPerPremise": 12, "repeatWindowDays": 30, "repeatThreshold": 2 },
  "cases": { "max": 120, "coldAfterShifts": 10, "followUpChance": 0.5, "maxFollowUpsPerShift": 2,
             "categories": ["theft", "burglary", "robbery", "assault", "domestic", "vandalism"] },
  "offenders": { "max": 300, "jailDays": { "infraction": 0, "misdemeanor": 2, "felony": 10, "warrant": 1 },
                 "pendingReleaseDays": 1, "riskBase": 0.25, "riskPerPrior": 0.12, "riskJuvenile": 0.15, "riskConvicted": 0.05,
                 "riskMax": 0.9, "riskMin": 0.05, "riskDecayPerDay": 0.01 },
  "recidivism": { "pickChanceScale": 0.6, "maxPickChance": 0.45, "sameDistrictWeight": 2 },
  "witnesses": { "max": 200, "movePerDay": 0.04, "unknownAddressShare": 0.3 },
  "neighborhoods": { "relax": 0.15, "trustWeight": 0.6, "offenderWeight": 0.02, "arrestWeight": 0.01, "noise": 0.03,
                     "min": 0.05, "max": 0.95, "historyDays": 14, "crimeToTrust": 0.02, "factorRange": [0.7, 1.5],
                     "baseCrime": { "downtown": 0.6, "suburbs": 0.35, "industrial": 0.5, "highway": 0.4, "rural": 0.25, "campus": 0.35,
                                    "hospital": 0.3, "airport": 0.3, "harbor": 0.45, "park": 0.4, "water": 0 } },
  "repeatCalls": { "chance": 0.2, "minEntries": 2 } }
```

### 6.2 Types and save (`types.ts`, `save.ts`)

```ts
export interface ClosedCallInfo { callId: number; number: string; typeId: string; nature: string; category: string;
  x: number; z: number; edge: number; text: string; district: string; disposition: string; flags: PremiseFlag[];
  persons: number[]; game: number }
export interface PremiseRecord { key: string; text: string; x: number; z: number; edge: number; district: string; entries: PremiseEntry[] }
export interface CaseRecord { id: string /* 'CS-0001' */; callId: number; callNumber: string; typeId: string; nature: string;
  status: CaseStatus; openedGame: number; lastGame: number; shiftsOpen: number; locationText: string; x: number; z: number;
  suspects: number[]; witnesses: number[]; evidence: number }
export interface OffenderRecord { personId: number; arrests: number; lastArrestGame: number; custody: OffenderCustody;
  releaseGame: number; risk: number; district: string; lastCallNumber: string; x: number; z: number; juvenile: boolean;
  offenseClass: OffenseClass; convicted: boolean }
export interface WitnessRecord { personId: number; caseId: string; addressText: string; movedGame: number /* -1 never */ }
export interface NeighborhoodState { crime: number; trend: number; history: number[] }
export interface WorldStateSave { version: 1; rng: RngState; lastEvolveGame: number; nextCase: number;
  premises: PremiseRecord[]; cases: CaseRecord[]; offenders: OffenderRecord[]; witnesses: WitnessRecord[];
  neighborhoods: Record<string, NeighborhoodState>; bias: [number, number][] /* [callId, personId] */;
  news: { game: number; text: string }[] /* <= 30 */; queue: WorldRequest[] }
export function newWorldStateSave(rng: RngState, baseCrime?: Readonly<Record<string, number>>): WorldStateSave  // crime = base
export function isWorldStateSave(x: unknown): x is WorldStateSave
```

### 6.3 Pure rules (`premises.ts`, `offenders.ts`, `neighborhoods.ts`, `cases.ts`) — mandatory tests

```ts
/** Upper case, trimmed, inner whitespace collapsed: '1240 n oak  street' -> '1240 N OAK STREET'. */
export function premiseKey(text: string): string
/** Flags of a closed call: arrest (disposition arrestMade), weapon (weaponSeen), violence (category assault | domestic |
 *  robbery), officerSafety (forceUsed | officerInjured), drugs (category dui | drugsFound), mentalHealth (family 'crisis'). */
export function premiseFlagsFor(i: { disposition: string; category: string; familyId: string | null; weaponSeen: boolean;
  forceUsed: boolean; officerInjured: boolean; drugsFound: boolean }): PremiseFlag[]
/** Adds an entry (newest last, capped); adds 'repeat' when >= repeatThreshold entries within repeatWindowDays. */
export function addPremiseEntry(p: PremiseRecord, e: PremiseEntry, cfg?): void
export function offenderRisk(priors: number, juvenile: boolean, convicted: boolean, cfg?): number  // clamp(base + perPrior*priors + ..., riskMin, riskMax)
/** Release game after a verdict: convicted / plea -> game + jailDays[class] * 86400 (jailed); acquitted / dismissed -> game (released). */
export function releaseAfterVerdict(o: OffenderRecord, verdict: 'convicted' | 'plea' | 'acquitted' | 'dismissed', game: number, cfg?): void
/**
 * Recidivist pick (design §6.4). pool = offenders with custody released | atLarge, releaseGame <= game and fits(personId),
 * in personId order. Empty pool -> -1 WITHOUT calling draw. pAny = min(maxPickChance, pickChanceScale * max risk); u = draw();
 * u >= pAny -> -1 (one draw). Else weights w = risk * (district === o.district ? sameDistrictWeight : 1); v = draw() * sum(w);
 * the first offender whose cumulative weight exceeds v.
 */
export function pickRecidivist(offenders: readonly OffenderRecord[], game: number, district: string,
  fits: (personId: number) => boolean, draw: () => number, cfg?): number
/** crime += (target - crime) * (1 - exp(-relax * days)) + noise * (2u - 1) * min(1, days); target = base * (1 + trustWeight *
 *  (0.5 - trust) * 2) + offenderWeight * atLarge - arrestWeight * arrests; clamp [min, max]; history push (<= historyDays); trend. */
export function evolveNeighborhood(n: NeighborhoodState, base: number, trust: number, atLarge: number, arrests: number,
  days: number, u: number, cfg?): void
/** clamp(crime / base, factorRange); 1 when base is 0. */
export function crimeFactor(n: Readonly<NeighborhoodState>, base: number, cfg?): number
```
Tests (`test/worldstate/*.test.ts`, mandatory "persistent world evolution"): recidivism — a jailed offender is never
picked; a released one is picked when draws are low; risk weighting picks the higher-risk offender for a mid draw;
same-district weighting; empty pool never calls `draw` (spy); `fits` filters; release by verdict and by pending days;
risk formula and decay. Neighborhood — 30 days of high trust (0.9) lower crime below base; low trust (0.1) and 20
offenders at large raise it above base; arrests lower it; zero days change nothing; the same inputs give the same
output; `crimeFactor` clamps. Premises — key normalisation, entry cap, repeat flag window, flags table.

### 6.4 WorldState (`src/worldstate/worldState.ts`, `evolve.ts`, `events.ts`)

```ts
export type WorldRequest =
  | { kind: 'callClosed'; call: ClosedCallInfo }
  | { kind: 'arrest'; personId: number; district: string; callNumber: string; x: number; z: number; game: number;
      offenseClass: OffenseClass; juvenile: boolean; priors: number }
  | { kind: 'verdict'; personId: number; verdict: 'convicted' | 'plea' | 'acquitted' | 'dismissed'; game: number }
  | { kind: 'caseOpen'; callId: number; number: string; typeId: string; nature: string; game: number; locationText: string;
      x: number; z: number; suspects: number[]; witnesses: number[]; evidence: number }
  | { kind: 'caseUpdate'; callId: number; game: number; suspectsAdd?: number[]; witnessesAdd?: number[]; evidenceDelta?: number; status?: CaseStatus }
  | { kind: 'witness'; personId: number; callId: number; addressText: string };

export interface EvolveInput { fromGame: number; toGame: number; trust: Readonly<Record<string, number>>;
  arrestsByDistrict: Readonly<Record<string, number>>; addressAt: (u: number) => string | null }
export interface FollowUpCall { caseId: string; callId: number; typeId: 'warrantService'; personId: number; x: number; z: number }
export interface EvolveResult { days: number; released: number[]; moves: { personId: number; address: string | null }[];
  followUps: FollowUpCall[]; trustDeltas: { district: string; delta: number }[]; news: string[] }

export class WorldState {
  constructor(deps: { bus: EventBus<EventMap>; rng: Rng /* stream 'worldstate' */; config?: WorldConfig;
    baseCrime?: Readonly<Record<string, number>> /* mods district table; default config.neighborhoods.baseCrime */ }, save?: WorldStateSave)
  get revision(): number
  request(r: WorldRequest): void
  step(dt: number, t: CadTime): void                       // drain requests only (no per-step work otherwise)
  premiseHistory(text: string): readonly PremiseEntry[]    // [] unknown; O(1) via a Map<key, PremiseRecord>
  premiseFlags(text: string): readonly PremiseFlag[]       // union of the entries' flags
  cases(): readonly CaseRecord[]
  caseOfCall(callId: number): CaseRecord | null
  offender(personId: number): OffenderRecord | null
  neighborhood(district: string): Readonly<NeighborhoodState>
  crimeFactor(district: string): number
  news(): readonly { game: number; text: string }[]
  /** Scene hook (§7.6): a designated person for `callId` (bias map; removed when used and fits) else pickRecidivist; emits
   *  `world:recidivist` when an offender was picked. */
  pickPerson(callId: number, district: string, game: number, fits: (personId: number) => boolean, draw: () => number): number
  /** Dispatcher hook: premises with >= minEntries entries (sorted by key); empty -> null without drawing; u = draw() >= chance ->
   *  null; else the premise at floor(draw() * n) as { x, z }. */
  pickRepeatLocation(draw: () => number): { x: number; z: number } | null
  /** Follow-up calls created by the integrator get their suspect: bias [callId, personId]. */
  bindPerson(callId: number, personId: number): void
  /** Rollover (between sessions, §20): days = floor((toGame - fromGame) / 86400) clamped 0..30; releases (releaseGame <=
   *  toGame -> custody released, listed), risk decay, witness moves (array order; p = 1 - (1 - movePerDay)^days; u < p ->
   *  moved; second draw < unknownAddressShare -> null address else addressAt(third draw)), neighborhoods in CRIME_DISTRICTS
   *  order (one draw each, only when days > 0), trust deltas (-crimeToTrust * (crime - base)), cases: shiftsOpen + 1, cold
   *  after coldAfterShifts, open cases with a suspect who is released / atLarge -> followUp with followUpChance (one draw per
   *  eligible case, at most maxFollowUpsPerShift), news lines; lastEvolveGame = toGame. Uses only the 'worldstate' stream. */
  evolve(input: EvolveInput): EvolveResult
  serialize(): WorldStateSave
  restore(s: WorldStateSave): void
}
```
Request semantics: `callClosed` -> premise upsert (`premiseKey(text)`), cap `max` premises by evicting the one with
the oldest last entry; `arrest` -> offender upsert (arrests + 1, custody jailed, releaseGame = game +
pendingReleaseDays * 86400, risk = `offenderRisk(arrests - 1 + priors, ...)`), cases with that suspect -> cleared
(`world:case`); `verdict` -> `releaseAfterVerdict`; `caseOpen` (id `CS-` + 4 digits from `nextCase`) / `caseUpdate`;
`witness` -> witness upsert (cap). Lists capped by evicting the oldest (lastGame / movedGame / releaseGame).

Tests (`test/worldstate/worldState.test.ts`): requests applied in `step`; premise history after two closed calls at
the same address (different spacing / case); arrest -> verdict convicted felony -> jailed for 10 days -> `evolve` 11
days later releases -> a later `pickPerson` with low draws returns the offender (the end-to-end recidivism test);
witness moves deterministic; follow-ups for open cases; `evolve` twice from the same save gives identical results;
`pickRepeatLocation` empty / chance / pick; round trip and `isWorldStateSave` rejections.

## 7. Training, modes and simulation hooks [training] — wave 1

Owns `src/training/**`, `src/data/training/**`, `src/render/training/**`, `src/dispatch/**`, `src/data/dispatch/**`,
`src/scene/**`, `src/data/scene/**`, `src/force/**`, `src/data/force/**`, `test/training/**`, `test/dispatch/**`,
`test/scene/**`, `test/force/**`.

### 7.1 Modes (`src/training/mode.ts`)

```ts
export const GAME_MODES = ['freePatrol', 'career', 'drivingAcademy', 'dispatchOnly', 'sandbox', 'coop'] as const;
export type GameMode = (typeof GAME_MODES)[number];
export interface ModeSave {
  version: 1; id: GameMode;
  course: CourseRunSave | null;          // driving course in progress (drivingAcademy, career academy)
  courseId: string | null;
  script: ScriptRunSave | null;          // dispatch script in progress
  dispatch: DispatchTrainingSave | null; // dispatch-only scoring
  scenario: SandboxScenario | null;      // the sandbox scenario last run (re-run / editor reopen)
  coopRole: 'patrol' | 'dispatcher' | 'supervisor' | null;   // informational; co-op loads offline as freePatrol
}
export function newModeSave(id: GameMode): ModeSave
export function isModeSave(x: unknown): x is ModeSave
```

### 7.2 Driving course (`src/training/course.ts`, `src/data/training/courses.json`) — tests

`courses.json` (`parseCourses` -> `COURSES`): 3 courses `basic`, `slalom`, `precision`, each `{ "id", "label",
"parTimeS", "gates": [ { "s", "offset", "width" } ], "cones": [ { "s", "offset" } ], "stopBox": { "s", "length" },
"penalties": { "cone": 2, "missedGate": 5, "stopBox": 5, "perSecondOver": 1 } }` with `s` in metres along the
course axis (0..300) and `offset` metres to the right of the axis (|offset| <= 3.5). `basic`: 8 gates, 12 cones,
par 45 s; `slalom`: 10 gates alternating +-2 m, 20 cones, par 50 s; `precision`: 6 narrow gates (width 2.8), 24
cones, stop box, par 60 s.
```ts
export interface CourseSegment { ax: number; az: number; bx: number; bz: number }
export interface CourseAnchor { x: number; z: number; dirX: number; dirZ: number; rightX: number; rightZ: number; length: number }
/** The segment with length >= minLength (default 320) whose start is nearest (sx, sz); null when none. Anchor at a,
 *  dir = unit(b - a), right = (-dirZ, dirX) (world x east, z south: facing north (0, -1) the right is east (1, 0)), so
 *  offset > 0 is the driver's right; length = |b - a|. Ties: the lower index. */
export function pickCourseSegment(segments: readonly CourseSegment[], sx: number, sz: number, minLength?: number): CourseAnchor | null
export function coursePoint(a: CourseAnchor, s: number, offset: number, out: { x: number; z: number }): { x: number; z: number }
/** Writes x, z per cone into out (length >= 2 * cones); returns the count. */
export function conePositions(a: CourseAnchor, c: CourseDef, out: Float32Array): number
export interface CourseRunSave { courseId: string; startSim: number; gateIdx: number; missed: number; coneHit: number[];
  lastS: number; stopped: boolean; done: boolean; aborted: boolean; finishSim: number }
export class DrivingCourseRun {
  constructor(course: CourseDef, anchor: CourseAnchor, bus: EventBus<EventMap>, save?: CourseRunSave)
  /** Fixed step, allocation-free: s / offset of (x, z) on the axis; crossing gates[gateIdx].s -> pass or miss (|offset - gate.offset|
   *  <= width / 2); a cone within 0.6 + 1.0 m of the vehicle centre counts once; speed < 0.5 m/s inside the stop box -> stopped;
   *  s > last gate / stop box end -> done (finishSim); |offset| > 15 or s < -30 -> aborted. Emits training:course on changes. */
  step(x: number, z: number, speed: number, sim: number): void
  get done(): boolean; get aborted(): boolean
  result(): { timeS: number; cones: number; missed: number; stopOk: boolean; score: number }   // score = clamp(100 - penalties, 0, 100)
  coneHits(): Uint8Array            // per cone 0 / 1 (renderer)
  serialize(): CourseRunSave
}
```
Tests (`test/training/course.test.ts`): a scripted straight drive through every gate centre scores 100 under par; a
drive that clips cones and misses a gate loses the penalties; stop box; abort; anchor picking; `step` allocates
nothing (heap delta guard pattern of the existing tests); serialize / restore mid-run continues identically.

### 7.3 Dispatch-only scoring (`src/training/dispatchScore.ts`) — tests

```ts
export interface DispatchCallRecord { callId: number; number: string; priority: 1 | 2 | 3 | 4; createdSim: number;
  firstAssignSim: number; minUnits: number; assigned: number; assignedDistM: number; nearestDistM: number; closed: boolean; score: number }
export interface DispatchTrainingSave { calls: DispatchCallRecord[] /* <= 200 */; total: number; scored: number }
export const TIMELY_S: Readonly<Record<1 | 2 | 3 | 4, readonly [number, number]>> = { 1: [30, 180], 2: [60, 300], 3: [120, 600], 4: [300, 1200] };
/** timeliness 0..50 (full at <= first, 0 at >= second, linear), coverage 0..25 (assigned >= minUnits), proximity 0..25
 *  (nearestDistM / assignedDistM, 1 when no unit was nearer). Unassigned when closed or created > second ago: 0. */
export function scoreCall(r: Readonly<DispatchCallRecord>, nowSim: number): number
export class DispatchTraining {
  constructor(bus: EventBus<EventMap>, save?: DispatchTrainingSave)
  onCreated(callId: number, number: string, priority: 1 | 2 | 3 | 4, minUnits: number, sim: number): void
  onAssigned(callId: number, sim: number, distM: number, nearestDistM: number): void
  onClosed(callId: number, sim: number): void     // scores, emits training:dispatchScore
  average(): number; grade(): 'A' | 'B' | 'C' | 'D' | 'F'   // 90 / 80 / 70 / 60
  serialize(): DispatchTrainingSave
}
```

### 7.4 Dispatch scripts (`src/training/script.ts`, `src/data/training/scripts/*.json`) — tests

```ts
export interface DispatchScriptStep { atS: number; typeId: string; priority: 1 | 2 | 3 | 4 | null;
  near: { poi: string } | { district: string } | { x: number; z: number }; narrative: string | null; radio: string | null }
export interface DispatchScript { format: 'patrol-dispatch-script'; version: 1; id: string; name: string; description: string;
  generator: 'on' | 'off'; durationS: number; steps: DispatchScriptStep[] }
/** Untrusted input: never throws. Rules: id /^[a-z0-9][a-z0-9-]{1,39}$/, name 1..60, description <= 400, durationS 60..7200,
 *  1..100 steps sorted by atS (0 <= atS <= durationS), typeId in ctx.callTypeIds, poi in ctx.poiKinds, district in
 *  ctx.districts, |x|, |z| <= 3584, narrative <= 280, radio <= 160; unknown keys are errors. Errors read "steps[3].typeId:
 *  unknown call type \"barFightt\"". */
export function parseDispatchScript(json: unknown, ctx?: ScriptContext): ParseResult<DispatchScript>
export interface ScriptContext { callTypeIds: ReadonlySet<string>; poiKinds: readonly string[]; districts: readonly string[] }
export function defaultScriptContext(): ScriptContext   // CALL_TYPES ids, cad POI_LOCATION_KINDS, CRIME_DISTRICTS
export const BUILTIN_SCRIPTS: readonly DispatchScript[]  // src/data/training/scripts/*.json (glob, sorted), validated at import (throws)
export interface ScriptRunSave { scriptId: string; startSim: number; next: number }
export class ScriptRunner {
  constructor(script: DispatchScript, save?: ScriptRunSave)
  start(sim: number): void
  /** Steps with startSim + atS <= sim not yet emitted, appended to out (no allocation when none). */
  due(sim: number, out: DispatchScriptStep[]): number
  get finished(): boolean
  serialize(): ScriptRunSave
}
```
Built-in scripts: `quiet-weekday` (8 calls over 20 min, generator on), `friday-night` (22 calls over 30 min with two
P1s, generator off), `multi-alarm` (12 calls in 10 min across districts, generator off).
Tests: valid scripts parse; every rule produces its error path; the built-ins validate; runner emits in order across
`due` calls and after restore.

### 7.5 Sandbox scenario (`src/training/scenario.ts`, `src/data/training/scenarios/*.json`) — tests

```ts
export interface SandboxScenario {
  format: 'patrol-scenario'; version: 1; id: string; name: string; description: string;
  anchor: { x: number; z: number };
  call: { typeId: string; priority: 1 | 2 | 3 | 4 } | null;
  npcs: { x: number; z: number; yaw: number; profile: string; role: string; weapon: string | null; hidden: boolean }[];   // <= 24
  vehicles: { modelId: string; x: number; z: number; yaw: number }[];                                                    // <= 8
  evidence: { item: string; x: number; z: number; concealed: boolean }[];                                                // <= 24
  timeOfDay: number | null;   // hour 0..23
  weather: string | null;     // environment weather kind
}
export interface ScenarioContext { callTypeIds: ReadonlySet<string>; profiles: ReadonlySet<string>; vehicleModels: ReadonlySet<string>;
  items: ReadonlySet<string>; weapons: ReadonlySet<string>; weatherKinds: readonly string[] }
export function defaultScenarioContext(): ScenarioContext  // CALL_TYPES, npc behaviour profiles, VEHICLE_MODELS (role !== 'police'
                                                             // allowed too), people item ids, weapon item ids, weather kinds
/** Untrusted input, never throws; positions within 150 m of the anchor; role 1..24 chars [a-zA-Z]; same error style as §7.4. */
export function parseSandboxScenario(json: unknown, ctx?: ScenarioContext): ParseResult<SandboxScenario>
export function exportScenario(s: SandboxScenario): string     // canonical JSON (keys in declaration order, 2-space indent)
export type SpawnOp =
  | { op: 'call'; typeId: string; priority: 1 | 2 | 3 | 4; x: number; z: number }
  | { op: 'actor'; index: number; personId: number; x: number; z: number; yaw: number; profile: string; role: string; weapon: string | null; hidden: boolean }
  | { op: 'vehicle'; modelId: string; x: number; z: number; yaw: number }
  | { op: 'evidence'; item: string; x: number; z: number; concealed: boolean }
  | { op: 'environment'; hour: number | null; weather: string | null };
/** Deterministic plan: environment first, then the call, vehicles, actors (person ids from pickPerson(rng) with
 *  rng = createRng(seed).stream(`sandbox:${s.id}`), one call per actor), evidence. */
export function planScenario(s: SandboxScenario, seed: number, pickPerson: (rng: Rng) => number): SpawnOp[]
export const SAMPLE_SCENARIOS: readonly SandboxScenario[]   // 2 samples: 'parking-lot-fight', 'abandoned-car'
```
Tests: samples validate; each rule error; export -> parse round trip; plan order and determinism.

### 7.6 Hooks in existing systems (all optional setters; null / default keeps Phase 1-7 behaviour bit-identical)

**Dispatcher** (`src/dispatch/dispatcher.ts`, `generator.ts`):
```ts
setGeneratorEnabled(on: boolean): void              // false: generate() returns at once (no draw)
setManualDispatch(on: boolean): void                // true: no offers to the player, assign() does nothing (AI units stay on
                                                    // patrol until assignUnit); release / return logic unchanged
/** An AI unit (not the player) in mode patrol (or returning) is dispatched to the call exactly like the automatic path
 *  (dispatchUnit with 'emergency' for P1-2 else 'respond'); false when the unit or call is unknown, closed or the unit busy. */
assignUnit(callsign: string, callId: number, t: CadTime): boolean
unassignUnit(callsign: string, t: CadTime): boolean // the AI unit leaves the call and resumes patrol (cad.unassign)
setCallPriority(callId: number, p: Priority, t: CadTime): void   // cad.setPriority
/** generator.generate(callsRng, x, z, playerCallsign, t.game, findCallType(typeId), { x, z }) then priority / narrative
 *  overrides; opens the call with openCall (plans, assignDirty); null when the type or location fails. */
createScriptedCall(spec: { typeId: string; priority?: Priority; x: number; z: number; narrative?: string }, t: CadTime): CadCall | null
/** Called in generate() before generator.generate when set: returns a location or null; the dispatcher passes
 *  () => this.callsRng.next() as `draw`. The world hook draws only when it has repeat premises. */
setLocationBias(fn: ((draw: () => number) => { x: number; z: number } | null) | null): void
/** Multiplies each type's weight in CallGenerator.pickType by fn(type.category) (specialty call mix). */
setCategoryWeights(fn: ((category: string) => number) | null): void
/** Straight-line distance from (x, z) to the nearest AI unit in patrol mode, Infinity when none (dispatch scoring). */
nearestAvailableDistance(x: number, z: number): number
```
`CallGenerator.setCategoryWeight(fn)` implements the multiplication. None of these flags is saved in `DispatchSave`
(the mode block restores them, §20).

**Scene director** (`src/scene/director.ts`):
```ts
export type PersonBias = (callId: number, district: string, fits: (personId: number) => boolean, draw: () => number) => number;
setPersonBias(fn: PersonBias | null): void
```
`createRuntime` passes the call id and the call's district into `pickPersonFor(c, rng, busy, callId, district)`. At
its start, only when `this.personBias !== null && (c.risk === true || c.warrant === true)`: `const id =
this.personBias(callId, district, (pid) => this.fitsConstraint(pid, c, busy, today), () => rng.next()); if (id >=
0) return id;` where `fitsConstraint` factors out the existing per-candidate checks (busy, warrant, age window, sex,
mental health, dementia, touched-person availability; `risk` is not required for a known offender). Behaviour with
no bias is unchanged (keep the loop exactly as it is).

**Force** (`src/force/forceSystem.ts`): `setAccuracyFactor(fn: (() => number) | null)`; where the firearm, TASER
probe and less-lethal hit models read their aim error / spread, multiply it by `fn?.() ?? 1` (factor >= 1).

Tests: dispatcher — manual mode leaves a new call pending with no offer and no AI unit; `assignUnit` sends the unit
(CAD status enRoute, fleet destination set); `unassignUnit`; generator off; scripted call at a point with the given
priority and narrative; location bias used; category weights change the type mix over 500 seeded picks; with no hooks
set an existing determinism fixture is unchanged. Scene — a bias returning a fitting id is used for a `risk` role,
ignored for a role without risk / warrant, an unfit id falls through to the normal pick; no bias = identical
scenario. Force — factor 1 gives the old results; factor 3 lowers the firearm hit rate at 15 m over 200 seeded trials.

### 7.7 Cone renderer (`src/render/training/coneRenderer.ts`)

`ConeRenderer(scene: THREE.Scene)`: one `InstancedMesh` (ConeGeometry r 0.18, h 0.5, 8 radial segments, orange
`MeshStandardMaterial` 0xff7a1a with a white band via vertex colours optional), capacity 64; `set(xz: Float32Array,
count: number, knocked: Uint8Array, groundY = 0)` (knocked cones are laid on their side, rotated 90° about x); `clear()`;
`dispose()`; 1 draw call, zero per-frame allocation (matrices written only in `set`). Headless-safe (no WebGL needed to
construct). Test: instance count and matrices.

### 7.8 Events (`src/training/events.ts`) and index

Topics `training:course`, `training:dispatchScore`, `training:flash` (§4.3). `src/training/index.ts` re-exports
everything except the renderer.

## 8. Multiplayer [net] — wave 1

Owns `src/net/**`, `server/**`, `test/net/**`, `test/server/**`. `src/net` value imports only `./*.ts` with the
extension; no DOM, no Node types.

### 8.1 Protocol (`src/net/protocol.ts`)

```ts
export const PROTOCOL_VERSION = 1;
export const NET_ROLES = ['patrol', 'dispatcher', 'supervisor'] as const;
export const ROLE_LIMITS = { patrol: 4, dispatcher: 1, supervisor: 1 } as const;
export const NET_UNIT_STATUSES = ['available', 'enRoute', 'onScene', 'busy', 'outOfService', 'transporting'] as const; // = cad UNIT_STATUSES (test)
export const NET_DISPOSITIONS = ['handled', 'reportTaken', 'citationIssued', 'warningIssued', 'arrestMade', 'goneOnArrival',
  'unfounded', 'referred', 'cancelled', 'transported', 'duplicate'] as const;                                     // = cad DISPOSITIONS ids (test)
export const ORDER_KINDS = ['respond', 'returnToStation', 'terminatePursuit', 'code4', 'backup'] as const;
export const REJECT_CODES = ['malformed', 'version', 'unknownType', 'forbidden', 'notFound', 'illegalState', 'invalidValue', 'rate', 'full'] as const;
export const LIMITS = { messageBytes: 8192, name: 24, room: 32, typeId: 40, label: 60, address: 80, narrative: 280, note: 200,
  radio: 160, ref: 16, worldHalf: 3700, maxOpenCalls: 30, closedKept: 20, notesPerCall: 20, maxSpeedMps: 90 } as const;

export type ClientMsg =
  | { t: 'hello'; v: number; name: string; role: NetRole; room: string; seed?: number }
  | { t: 'presence'; x: number; z: number; heading: number; speed: number; driving: boolean }
  | { t: 'unitStatus'; status: NetUnitStatus; callId: number | null }
  | { t: 'callCreate'; ref: string; typeId: string; label: string; priority: 1 | 2 | 3 | 4; x: number; z: number; address: string;
      narrative: string; origin: 'dispatcher' | 'generator' | 'officer' }
  | { t: 'callAssign'; callId: number; unit: string }
  | { t: 'callUnassign'; callId: number; unit: string }
  | { t: 'callPriority'; callId: number; priority: 1 | 2 | 3 | 4 }
  | { t: 'callNote'; callId: number; text: string }
  | { t: 'callClose'; callId: number; disposition: NetDisposition }
  | { t: 'order'; unit: string; order: OrderKind; callId: number | null; text: string }
  | { t: 'partner'; unit: string }
  | { t: 'radio'; channel: 'main' | 'tac'; text: string }
  | { t: 'ping'; n: number };
export interface NetUnit { callsign: string; role: NetRole; name: string; status: NetUnitStatus; callId: number | null;
  x: number; z: number; heading: number; speed: number; driving: boolean; partner: string | null }
export interface NetNote { by: string; text: string; atMs: number }
export interface NetCall { id: number; ref: string; typeId: string; label: string; priority: 1 | 2 | 3 | 4; x: number; z: number;
  address: string; narrative: string; status: 'pending' | 'active' | 'closed'; units: string[]; primary: string | null;
  notes: NetNote[]; createdBy: string; origin: 'dispatcher' | 'generator' | 'officer'; createdAtMs: number; disposition: string | null }
export interface RoomSnapshot { room: string; seed: number; rev: number; host: string; units: NetUnit[]; calls: NetCall[] }
export type RoomEvent =
  | { k: 'joined'; unit: NetUnit } | { k: 'left'; callsign: string } | { k: 'host'; callsign: string }
  | { k: 'unitStatus'; callsign: string; status: NetUnitStatus; callId: number | null }
  | { k: 'callCreated'; call: NetCall }
  | { k: 'callAssigned'; callId: number; callsign: string; primary: string | null }
  | { k: 'callUnassigned'; callId: number; callsign: string }
  | { k: 'callPriority'; callId: number; priority: 1 | 2 | 3 | 4 }
  | { k: 'callNote'; callId: number; note: NetNote }
  | { k: 'callClosed'; callId: number; disposition: string }
  | { k: 'order'; to: string; from: string; order: OrderKind; callId: number | null; text: string }
  | { k: 'partnered'; a: string; b: string }
  | { k: 'radio'; from: string; channel: 'main' | 'tac'; text: string };
export type ServerMsg =
  | { t: 'welcome'; v: number; callsign: string; role: NetRole; snapshot: RoomSnapshot }
  | { t: 'event'; rev: number; ev: RoomEvent }
  | { t: 'presence'; units: { callsign: string; x: number; z: number; heading: number; speed: number; driving: boolean }[] }
  | { t: 'reject'; ref: string /* the rejected message's t */; code: RejectCode; reason: string }
  | { t: 'pong'; n: number }
  | { t: 'error'; code: RejectCode; reason: string };
/** Checks in order: utf8Length(raw) <= LIMITS.messageBytes ('malformed'), JSON.parse ('malformed'), a plain object whose `t`
 *  is a known type ('unknownType'), `hello.v === PROTOCOL_VERSION` ('version'), every field present with the right type,
 *  range, length and enum and no unknown fields ('malformed' for type / shape, 'invalidValue' for ranges, lengths and enums),
 *  text without control characters U+0000-U+001F / U+007F ('invalidValue'; text is never silently rewritten). Never throws. */
export function parseClientMsg(raw: string): { ok: true; msg: ClientMsg } | { ok: false; code: RejectCode; reason: string }
export function parseServerMsg(raw: string): { ok: true; msg: ServerMsg } | { ok: false; reason: string }   // client side, lenient on unknown fields
export function encode(msg: ClientMsg | ServerMsg): string
export function utf8Length(s: string): number
```

### 8.2 Room authority (`src/net/room.ts`) — mandatory tests

```ts
export interface RoomOptions { name: string; seed: number; maxMembers?: number /* 6 */ }
export class RateLimiter { constructor(capacity: number, refillPerS: number); take(nowMs: number): boolean }   // token bucket
export interface HandleResult { events: RoomEvent[]; reject: { code: RejectCode; reason: string } | null; direct: ServerMsg[] }
export class Room {
  constructor(opts: RoomOptions)
  get snapshot(): RoomSnapshot                    // open calls + the last LIMITS.closedKept closed
  get rev(): number                               // + 1 per applied event
  get size(): number
  /** Role limit -> reject 'full'; version mismatch -> 'version'. Callsigns: patrol 'N1'..'N4' (lowest free), dispatcher
   *  'DISPATCH', supervisor 'S1'. The first member becomes host and fixes the seed (hello.seed or the room's). */
  join(memberId: string, hello: Extract<ClientMsg, { t: 'hello' }>, nowMs: number): HandleResult & { callsign: string | null }
  leave(memberId: string): RoomEvent[]            // unassigns the unit from calls, 'left', new host (oldest patrol) -> 'host'
  handle(memberId: string, msg: ClientMsg, nowMs: number): HandleResult
  presence(): ServerMsg                            // batched presence of all units
}
```
Rules (each violated rule = a reject, state unchanged):
1. Rate: per member `RateLimiter(40, 20)`; `presence` additionally at most one per 80 ms (`rate`).
2. Permission matrix (`forbidden`):

| msg | patrol | dispatcher | supervisor |
|---|---|---|---|
| presence, unitStatus | own unit | forbidden | own unit |
| callCreate | origin `officer` within 150 m of own presence; origin `generator` only when host and no dispatcher, at most 1 per 10 s | origin `dispatcher` | origin `dispatcher` |
| callAssign / callUnassign | `unit` = own callsign only | any unit (not DISPATCH) | any unit |
| callPriority | forbidden | yes | yes |
| callNote | assigned to the call | yes | yes |
| callClose | the call's primary or any assigned unit | yes | yes |
| order | forbidden | `respond` only | all kinds |
| partner | to another patrol unit; pairs when both asked each other | forbidden | forbidden |
| radio | yes | yes | yes |

3. State (`notFound` / `illegalState`): call exists; closed calls are immutable; assigning a unit to a second open
call first unassigns it from the first; open calls <= `maxOpenCalls` (`illegalState`); status transitions
`canTransition(from, to)`: any -> outOfService; outOfService -> available; available -> enRoute | onScene | busy;
enRoute -> onScene | available | busy; onScene -> busy | available | transporting | enRoute; busy -> available |
onScene | enRoute; transporting -> available | onScene; `callId` of enRoute / onScene must be a call the unit is
assigned to; a unit becomes the call's primary when it is the first assigned; a call becomes active on the first
assignment.
4. Values (`invalidValue`): positions within `worldHalf`; heading finite; speed 0..120; movement plausibility
(distance since the last presence / max(0.05, dt) > maxSpeedMps and distance > 50 m); text lengths; `typeId`
`/^[A-Za-z0-9_]{1,40}$/`; dispositions in `NET_DISPOSITIONS`; no control characters in text.
Tests (`test/net/room.test.ts`, mandatory "server-authoritative checks reject illegal client actions"): every row of
the matrix both allowed and forbidden; each state rule; rate limit (41st message in one ms rejected, refill); presence
teleport rejected; role limits (`full`), version mismatch; host fallback on leave; snapshot after a sequence;
`test/net/protocol.test.ts`: malformed JSON, oversized, unknown type, missing / extra / wrong-typed fields, control
characters, NET constant lists equal the game's lists (`UNIT_STATUSES`, `DISPOSITIONS` ids).

### 8.3 Mirror (`src/net/mirror.ts`) — tests

```ts
export interface MirrorPort {
  createCall(c: NetCall): number;                                  // local call id
  assign(localCallId: number, callsign: string, self: boolean): void;
  unassign(localCallId: number, callsign: string, self: boolean): void;
  setPriority(localCallId: number, p: 1 | 2 | 3 | 4): void;
  addNote(localCallId: number, by: string, text: string): void;
  close(localCallId: number, disposition: string): void;
  upsertUnit(u: NetUnit): void;                                    // remote units only (never self)
  removeUnit(callsign: string): void;
  order(o: Extract<RoomEvent, { k: 'order' }>): void;              // only orders addressed to self
  radio(from: string, channel: 'main' | 'tac', text: string): void;
}
export class CoopMirror {
  constructor(selfCallsign: string)
  /** A call this client proposed (callCreate.ref) is already local: map it instead of creating a duplicate. */
  expectOwn(ref: string, localCallId: number): void
  applySnapshot(s: RoomSnapshot, port: MirrorPort): void           // creates missing calls, units, assignments
  applyEvent(ev: RoomEvent, port: MirrorPort): void
  localIdOf(netCallId: number): number                             // -1 unknown
  netIdOf(localCallId: number): number                             // -1 unknown
  applyPresence(units: Extract<ServerMsg, { t: 'presence' }>['units'], port: MirrorPort): void
}
```
Tests with a recording fake port: snapshot then events produce the right port calls; own proposals are mapped by
`ref`; self vs remote; unknown call ids ignored.

### 8.4 Client (`src/net/client.ts`) — tests

```ts
export interface WebSocketLike { readonly readyState: number; send(data: string): void; close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null; onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null; onerror: ((ev: unknown) => void) | null }
export type NetClientState = 'idle' | 'connecting' | 'joined' | 'closed' | 'failed';
export class NetClient {
  /** factory default: globalThis.WebSocket when present (feature-detected), else null -> state 'failed', reason 'WebSockets unavailable'. */
  constructor(factory?: ((url: string) => WebSocketLike) | null)
  connect(url: string, hello: Extract<ClientMsg, { t: 'hello' }>): void   // sends hello on open
  send(msg: ClientMsg): boolean                                           // false unless joined (presence dropped silently)
  /** Messages received since the last drain, in order (parsed; invalid ones dropped with a counted error). */
  drain(out: ServerMsg[]): number
  get state(): NetClientState; get reason(): string; get callsign(): string; get welcome(): Extract<ServerMsg, { t: 'welcome' }> | null
  close(): void
}
export const DEFAULT_SERVER_URL = 'ws://localhost:8787';
```

### 8.5 Server (`server/main.ts`, `server/wsServer.ts`, `server/wsFrames.ts`, `server/tsconfig.json`, `server/README.md`)

Every `server/*.ts` file starts with `/// <reference types="node" />`, imports Node built-ins with the `node:`
prefix and `src/net` files by relative path with the `.ts` extension. `server/tsconfig.json`: `{ "extends":
"../tsconfig.json", "compilerOptions": { "lib": ["ES2023"], "types": ["node"] }, "include": ["./**/*.ts"] }`.

`wsFrames.ts` (pure, RFC 6455):
```ts
export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export function acceptKey(secWebSocketKey: string): string     // base64(sha1(key + GUID)) via node:crypto createHash
export interface Frame { fin: boolean; opcode: number; payload: Buffer }
/** Parses as many complete frames as `buf` holds: byte0 FIN 0x80 | opcode; byte1 MASK 0x80 | len7; 126 -> 16-bit BE, 127 ->
 *  64-bit BE (> maxPayload -> error 1009); 4-byte mask key when MASK; unmask XOR mask[i % 4]. Returns frames and the
 *  number of bytes consumed; { error: closeCode } for protocol errors (unmasked client frame 1002, reserved bits 1002). */
export function parseFrames(buf: Buffer, maxPayload: number): { frames: Frame[]; consumed: number } | { error: number }
export function encodeFrame(opcode: number, payload: Buffer): Buffer          // FIN set, unmasked (server -> client)
export function encodeClose(code: number, reason: string): Buffer
```
`wsServer.ts`:
```ts
export interface ServerOptions { port: number; host: string; allowedOrigins: readonly string[] | null; maxRooms: number;
  log: (line: string) => void }
export interface RunningServer { port: number; close(): Promise<void> }
/** http.createServer (GET / -> 200 'Patrol co-op server'), 'upgrade': checks GET, Upgrade: websocket, Sec-WebSocket-Version 13,
 *  Sec-WebSocket-Key, Origin (allowedOrigins null -> any http://localhost:* / http://127.0.0.1:* or no Origin), then writes
 *  'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: <key>\r\n\r\n'.
 *  Per socket: buffer chunks, parseFrames(maxPayload 65536); text (opcode 1, FIN) -> UTF-8 decode (TextDecoder fatal; error
 *  -> close 1007) -> parseClientMsg -> first message must be hello (else error + close 1008) -> Room.join / Room.handle ->
 *  broadcast events to the room as { t: 'event' }, rejects to the sender; binary or fragmented (FIN 0 / opcode 0) -> close
 *  1003; ping -> pong; close -> echo close, end. Presence broadcast every 200 ms per room; ping every 15 s; a socket silent for
 *  45 s is destroyed; empty rooms are deleted; at most maxRooms rooms ('full'). */
export function startServer(opts: ServerOptions): Promise<RunningServer>
```
`main.ts`: reads only `process.env.PATROL_SERVER_PORT` (default 8787), `PATROL_SERVER_HOST` (default `127.0.0.1`),
`PATROL_SERVER_ORIGINS` (comma list, default null), `PATROL_SERVER_MAX_ROOMS` (default 8), `PATROL_SERVER_LOG`
(`1` = log joins / rejects), starts the server, logs `Patrol co-op server on ws://host:port`, closes on SIGINT /
SIGTERM. No secrets, no auth tokens, no deployment config. `server/README.md`: how to run (`npm run server`), the
variables, the security note (local network only, no TLS, no accounts).

Tests (`test/server/frames.test.ts`): accept key of the RFC example (`dGhlIHNhbXBsZSBub25jZQ==` ->
`s3pPLMBiTxaQ9kYGzzhZRbK+xOo=`), masked text frame decode, 16-bit and 64-bit lengths, split / coalesced buffers,
unmasked frame error, oversized error, encode / decode round trip. (`test/server/server.test.ts`, the file starts
with `/// <reference types="node" />`): start on port 0 at 127.0.0.1, connect two clients with Node's global
`WebSocket`, both get `welcome` (N1 host, DISPATCH), the dispatcher creates and assigns a call, the patrol client
receives the events, a patrol `callPriority` gets `reject` `forbidden`, a malformed message gets `reject`
`malformed`, close cleans the room; the server closes.

## 9. Accessibility [a11y] — wave 1

Owns `src/a11y/**`, `src/data/a11y/**`, `src/settings/**`, `src/input/**`, `src/ui/settingsMenu.ts`,
`src/ui/styles.css`, `src/render/vehicles/carRenderer.ts` (light-bar palette only), `test/a11y/**`,
`test/settings/**`, `test/input/**`.

### 9.1 Palette (`src/a11y/palette.ts`, `src/data/a11y/palettes.json`)

`palettes.json`: `{ "version": 1, "modes": { "none": {...}, "protanopia": {...}, "deuteranopia": {...},
"tritanopia": {...} } }`, each mode a hex colour per `SEMANTIC_COLORS` key plus `"lightbar": { "red": [r, g, b],
"blue": [...], "white": [...], "amber": [...] }` (linear 0..1). Values:

| key | none | protanopia / deuteranopia | tritanopia |
|---|---|---|---|
| unit | #4f8cff | #0072b2 | #4f8cff |
| unitBusy | #2a4f8f | #004466 | #2a4f8f |
| emergency | #ff3b3b | #ffb000 | #ff3b3b |
| suspect | #ff3b3b | #e69f00 | #ff3b8a |
| pursuit | #ff7a1a | #f0e442 | #ff7a1a |
| person | #ffffff | #ffffff | #ffffff |
| ok | #5fd35f | #56b4e9 | #00c2a0 |
| caution | #ffcc66 | #f0e442 | #ffd0e0 |
| alert | #ff5a5a | #ffb000 | #ff2e2e |
| accent | #3b9eff | #3b9eff | #3b9eff |
| accent2 | #ff3b5c | #ffb000 | #ff3b5c |
| p1 / p2 / p3 / p4 | #ff5a5a #ff9f40 #ffcc66 #8fa3b5 | #ffb000 #f0e442 #56b4e9 #8fa3b5 | #ff2e2e #ff8fb0 #00c2a0 #8fa3b5 |
| lightbar red | [1, 0.05, 0.05] | [1, 0.6, 0.0] | [1, 0.05, 0.05] |
| lightbar blue | [0.05, 0.15, 1] | [0.05, 0.3, 1] | [0.2, 1, 1] |
| lightbar white / amber | [1,1,1] / [1,0.55,0.05] | same | same |

`deuteranopia` repeats the protanopia values. API (presentation only, module-level mode, zero allocation):
```ts
export type PaletteMode = 'none' | 'protanopia' | 'deuteranopia' | 'tritanopia';   // = settings ColorblindMode
export function setPaletteMode(mode: PaletteMode): void
export function paletteMode(): PaletteMode
export function semanticColor(key: SemanticColor): string                 // '#rrggbb'
/** Writes the light-bar RGB of a SEGMENT_COLOR index (0 off -> 0,0,0) at out[offset..offset+2]; returns out. */
export function lightbarRgb(segment: number, out: Float32Array | number[], offset?: number): Float32Array | number[]
export function revision(): number                                        // bumps on mode change (canvas repaint trigger)
```
`styles.css`: semantic variables `--c-unit`, `--c-unit-busy`, `--c-emergency`, `--c-suspect`, `--c-pursuit`,
`--c-ok`, `--c-caution`, `--c-alert`, `--c-p1`..`--c-p4` in `:root` with the `none` values, and overrides under
`:root[data-colorblind="protanopia"]`, `"deuteranopia"`, `"tritanopia"` (also overriding `--danger`, `--accent-2`).
New Phase 8 CSS uses only these variables for status colours. `carRenderer.ts`: the lit-lens colour lookup reads
`lightbarRgb(segment, scratch)` instead of its private `SEGMENT_RGB` table (keep allocation-free; the reduced-flash
dimming unchanged).

### 9.2 One-handed layouts (`src/a11y/layouts.ts`, `src/data/a11y/layouts.json`)

`layouts.json`: `{ "version": 1, "left": { "<actionId>": [Binding...] }, "right": { ... } }` covering **every**
`ACTION_IDS` entry. Left hand: keyboard keys `Backquote Digit1-Digit6 KeyQ KeyW KeyE KeyR KeyT KeyA KeyS KeyD KeyF
KeyG KeyZ KeyX KeyC KeyV KeyB Tab CapsLock ShiftLeft ControlLeft AltLeft Space Escape F1-F6` only, plus no mouse
(look on `KeyQ` / `KeyE` as `look.x` -1 / +1 keys and `look.y` on `KeyR` / `KeyF`, steering shares A / D, radio
options 1-6 on digits and 7-9 on F4-F6). Right hand: mouse (`MouseX`, `MouseY`, `MouseButton0-2`, `MouseWheel`) plus
`ArrowUp ArrowDown ArrowLeft ArrowRight Numpad0-Numpad9 NumpadAdd NumpadSubtract NumpadMultiply NumpadDivide
NumpadDecimal NumpadEnter Enter Backspace Delete End Home PageUp PageDown Insert ShiftRight ControlRight Slash
Period Comma Semicolon Quote BracketLeft BracketRight Backslash Minus Equal F7-F12`. Context sharing follows the
existing rule (on foot vs in a car may share a key). Gamepad bindings are kept from the defaults in both presets.
```ts
export const ONE_HANDED_LAYOUTS = ['off', 'left', 'right'] as const;
export type OneHandedLayout = (typeof ONE_HANDED_LAYOUTS)[number];
export function layoutBindings(layout: OneHandedLayout): BindingMap   // 'off' -> cloneBindings(DEFAULT_BINDINGS)
export const LEFT_KEYS: ReadonlySet<string>; export const RIGHT_KEYS: ReadonlySet<string>;
```

### 9.3 Settings and input changes

- `src/input/actions.ts` + `bindings.ts`: `'career.menu': { kind: 'button', label: 'Career / schedule' }` ->
  `[key('Minus')]`; `'coop.menu': { kind: 'button', label: 'Co-op panel' }` -> `[key('Digit0')]`;
  `'dispatch.console': { kind: 'button', label: 'Dispatch console' }` -> `[key('Home')]`.
- `src/settings/settings.ts`: `SETTINGS_VERSION = 2`; `SETTINGS_MIGRATIONS[1]` maps `accessibility.oneHanded` `true`
  -> `'left'`, anything else -> `'off'`; `AccessibilitySettings.oneHanded: OneHandedLayout` (enum field 'One-handed
  layout': Off / Left hand / Right hand, implemented); `accessibility.colorblind` implemented (remove `implemented:
  false`); defaults unchanged otherwise (`oneHanded: 'off'`).
- `src/ui/settingsMenu.ts`: changing `accessibility.oneHanded` replaces `controls.bindings` with
  `layoutBindings(value)` and shows the hint "Key bindings replaced by the <label> layout (rebind any key below)";
  the colour-vision select shows a 6-swatch preview row (unit, emergency, suspect, ok, caution, alert) using the CSS
  variables.

### 9.4 Flash and audit helpers (`src/a11y/flash.ts`, `src/a11y/audit.ts`) — tests

```ts
export const MAX_FLASH_HZ = 3;
/** 0..1 pulse for a UI highlight: a 1 Hz sine when allowed; constant 1 when reduced. */
export function pulse(tMs: number, reduced: boolean): number
export function isReducedFlash(): boolean   // document.documentElement.dataset.reducedFlash === 'true' (false headless)
/** Action ids added in Phase 8 (career.menu, coop.menu, dispatch.console). */
export const PHASE8_ACTIONS: readonly ActionId[]
```
Tests (`test/a11y/*.test.ts`): every `ACTION_IDS` entry has at least one default binding and one binding in each
layout; the left layout uses only `LEFT_KEYS` codes and no mouse; the right layout only `RIGHT_KEYS` and mouse codes;
every binding passes `isBinding`; settings migration v1 -> v2; each palette mode defines every key with a valid hex;
`lightbarRgb` per mode; CSS audit — load every `src/ui/**/*.css` with `import.meta.glob(..., { query: '?raw',
import: 'default', eager: true })` and assert each `animation:` rule's selector has a matching `[data-reduced-flash]`
override or the global rule in `styles.css` disables it (the global `animation: none !important` rule must stay),
and that no `@keyframes` toggles opacity/visibility faster than `MAX_FLASH_HZ` (a keyframes block used with a
duration < 0.34 s fails); the light-bar reduced-flash test of Phase 2 still passes.

## 10. Mods [mods] — wave 2

Owns `src/mods/**`, `docs/MODDING.md`, `docs/schemas/**`, `examples/mods/**`, `test/mods/**`, and the overlay
hooks in `src/calls/catalog.ts`, `src/calls/cadRows.ts`, `src/cad/data.ts`, `src/legal/ruleset.ts`,
`src/vehicles/model.ts`, `src/uniform/data.ts`, `src/dialogue/data.ts`, `src/speech/profile.ts`,
`src/speech/synthesis.ts`, `src/radio/data.ts`. Imports `training` (`parseDispatchScript`, `ScriptContext`).

### 10.1 Bundle format (`src/mods/types.ts`)

```ts
export const MOD_FORMAT = 'patrol-mod'; export const MOD_FORMAT_VERSION = 1; export const MOD_MAX_BYTES = 2 * 1024 * 1024;
export interface ModManifest { format: 'patrol-mod'; version: 1; id: string /* /^[a-z0-9][a-z0-9-]{1,39}$/ */; name: string /* 1..60 */;
  author: string /* <= 60 */; description: string /* <= 400 */; modVersion: string /* /^\d+\.\d+\.\d+$/ */ }
export interface ModContent {
  callTypes?: { family: string; types: unknown[] }[];          // same shape as src/data/calls/types/*.json without "version"
  statutes?: unknown[];                                         // statute rows (statutes.json "statutes" entries)
  rulesets?: unknown[];                                         // full ruleset documents (src/data/legal/rulesets/*.json)
  vehicles?: unknown[];                                         // vehicle model documents (src/data/vehicles/*.json)
  uniforms?: { classes?: ({ id: string } & Record<string, unknown>)[]; department?: Record<string, unknown> };
  districts?: Record<string, { label?: string; crimeFactor?: number; trustBaseline?: number }>;
  voicePacks?: VoicePackDef[];
  dispatchScripts?: unknown[];                                  // patrol-dispatch-script documents (§7.4)
}
export interface ModBundle extends ModManifest { content: ModContent }
export interface VoicePackDef { id: string; name: string;
  voices: Partial<Record<'dispatcher' | 'officer' | 'agency' | 'player', { pitch: [number, number]; rate: [number, number]; prefer: string[] }>>;
  phrases?: Record<string, { tenCode?: string[]; plain?: string[] }> }   // keys = radio PHRASE_KINDS
export interface ModError { mod: string; path: string; message: string }
export interface ModRef { id: string; modVersion: string; hash: string }   // hash = 8-hex FNV-1a (hashString) of canonical JSON
export interface ModOverlay {
  refs: ModRef[];
  callTypes: { file: string; json: unknown }[];   // file 'mod:<modId>:<n>.json', json = { version: 1, family, types }
  statutes: unknown[]; rulesets: { file: string; json: unknown }[]; vehicles: { file: string; json: unknown }[];
  uniforms: { classes: ({ id: string } & Record<string, unknown>)[]; department: Record<string, unknown> | null }[];
  districts: Record<string, { label?: string; crimeFactor?: number; trustBaseline?: number }>;   // later mods win per key
  voicePack: VoicePackDef | null;                  // the last enabled pack
  dispatchScripts: unknown[];
}
```
Folder form: the picked files contain `mod.json` = manifest + `"files": { "<kind>": ["relative/path.json", ...] }`;
each referenced file holds one document (for `callTypes` a `{ family, types }` file, for `uniforms` / `districts` the
patch object, otherwise one document per file). The loader assembles the same `ModBundle`.

### 10.2 Registry (`src/mods/registry.ts`) — dependency-free

```ts
export function emptyOverlay(): ModOverlay
export function setActiveOverlay(o: ModOverlay | null): void    // null = empty; only main.ts / tests call it
export function modOverlay(): Readonly<ModOverlay>
export function activeModRefs(): readonly ModRef[]
export function districtLabel(district: string): string        // overlay label or the district name
```
This file imports **types only**. The data loaders call `modOverlay()` while their module evaluates, so the overlay
must be set before the app is imported (§20 boot). Tests reset it with `setActiveOverlay(null)`.

### 10.3 Validation (`src/mods/schema.ts`, `src/mods/combine.ts`) — mandatory tests

```ts
export interface ModValidationContext {
  baseCallTypeIds: ReadonlySet<string>; familyIds: ReadonlySet<string>; baseVehicleIds: ReadonlySet<string>;
  baseRulesetIds: ReadonlySet<string>; baseStatuteIds: ReadonlySet<string>; districts: readonly string[];
  uniformClassIds: readonly string[]; phraseKinds: readonly string[];
  /** Each wraps an existing throwing validator and returns its message(s); [] when valid. */
  checkCallTypes(files: readonly { file: string; json: unknown }[]): string[];   // validateCatalog + validateCallTypes with base + files
  checkVehicle(json: unknown, source: string): string[];                         // parseVehicleModel
  checkRuleset(json: unknown, file: string): string[];                           // parseRuleset
  checkStatutes(rows: readonly unknown[]): string[];                             // validateStatutes(base + rows)
  checkUniforms(patches: ModOverlay['uniforms']): string[];                      // parseUniformData(applyUniformPatches(base, patches))
  checkPhrases(phrases: VoicePackDef['phrases']): string[];                      // validatePhrases(mergePhrases(base, phrases))
  checkScript(json: unknown): string[];                                          // parseDispatchScript
}
export function defaultModContext(): ModValidationContext   // imports the live data modules (never from boot.ts!)
/** Untrusted input, never throws. Size <= MOD_MAX_BYTES (measured by the caller), manifest fields, `content` keys in
 *  MOD_CONTENT_KINDS (unknown keys are errors), at least one content kind; per kind: new ids must not exist in the base game
 *  ("vehicles[0].id: \"patrol_sedan\" already exists in the base game"), ruleset id = its declared id, district keys in
 *  ctx.districts, crimeFactor 0.2..3, trustBaseline 0.05..0.95, label 1..40, voice pitch 0.5..2, rate 0.5..2, prefer <= 8
 *  strings, uniform class ids in ctx.uniformClassIds (patches only), phrase kinds in ctx.phraseKinds; then the ctx.check*
 *  validators. Every error = { mod, path, message } with a dotted path. */
export function validateModBundle(json: unknown, ctx: ModValidationContext): { ok: true; mod: ModBundle } | { ok: false; errors: ModError[] }
export function modRef(m: ModBundle): ModRef
/** Load order = `order` (ids); duplicate content ids across mods -> the later mod is excluded with an error naming both;
 *  missing ids ignored. */
export function resolveActiveMods(mods: readonly ModBundle[], order: readonly string[]): { active: ModBundle[]; errors: ModError[] }
/** All active mods' content merged and run through the ctx.check* validators together. */
export function validateCombination(active: readonly ModBundle[], ctx: ModValidationContext): ModError[]
export function buildOverlay(active: readonly ModBundle[]): ModOverlay
export function formatModErrors(errors: readonly ModError[]): string[]   // '<mod>: <path>: <message>'
// helpers used by the loaders (pure):
export function applyUniformPatches(base: unknown, patches: ModOverlay['uniforms']): unknown   // shallow merge per class id, department merge
export function mergePhrases(base: unknown, phrases: VoicePackDef['phrases'] | undefined): unknown // replaces kinds[k].tenCode / plain arrays
export function mergeStatutes(base: unknown, rows: readonly unknown[]): unknown                     // appends to "statutes"
```
Tests (`test/mods/*.test.ts`, mandatory "reject invalid mods with clear errors"): the example bundle validates; each
of: wrong `format`, bad id, missing name, unknown content key, empty content, call type of an unknown family,
duplicate call type id (base and between mods), bad vehicle field (path names the field), ruleset id mismatch, unknown
district, crimeFactor out of range, unknown uniform class, unknown phrase kind, invalid dispatch script step — is
rejected with an error whose `path` and `message` are asserted; the bundle is never partially accepted; load order
and patch precedence (later wins); `buildOverlay` content; `validateCombination` catches cross-mod duplicates;
helpers merge correctly; the overlay hooks — with an overlay set before importing a fresh module instance
(`vi.resetModules()` + dynamic `import()`), `VEHICLE_MODELS` ends with the mod vehicle, `CALL_TYPES` contains the
mod call type, `RULESETS` the mod ruleset, `STATUTES` the mod statute, `UNIFORM_DATA` the patched colour, `TRUST`
the patched baseline, `PHRASES` the replaced lines, `voiceProfileFor` uses the pack ranges.

### 10.4 Store, loader and boot (`store.ts`, `loader.ts`, `boot.ts`)

```ts
// store.ts — IndexedDB 'patrol-mods' v1, object store 'mods' keyed by id (value StoredMod); enabled order in localStorage
// 'patrol-mods-enabled' (JSON string array; try/catch, empty on failure). Uses openDb / requestToPromise from src/save/db.ts.
export interface StoredMod { id: string; bundle: ModBundle; ref: ModRef; size: number; installedAt: number }
export class ModStore {
  constructor(factory?: IDBFactory, storage?: Pick<Storage, 'getItem' | 'setItem'> | null)
  list(): Promise<StoredMod[]>; get(id: string): Promise<StoredMod | null>; put(m: StoredMod): Promise<void>; remove(id: string): Promise<void>
  enabled(): string[]; setEnabled(ids: readonly string[]): void; close(): void
}
// loader.ts
export interface FileLike { readonly name: string; readonly webkitRelativePath?: string; readonly size: number; text(): Promise<string> }
/** One .json file -> a bundle document; several files with a mod.json -> the assembled folder bundle; errors otherwise
 *  ("No mod.json in the selected folder", "calls/x.json: not valid JSON (Unexpected token ...)", "Mod is 3.1 MiB; the limit is 2 MiB"). */
export function readModFiles(files: readonly FileLike[]): Promise<{ ok: true; json: unknown; size: number } | { ok: false; errors: string[] }>
// boot.ts — imports ONLY ./registry, ./store, ./combine (buildOverlay, resolveActiveMods), ./types, core/log, core/rng.
export interface BootResult { active: ModRef[]; errors: string[]; safeMode: boolean }
/** Unless `skip` (URL ?nomods or the 'patrol-mods-safe' flag): read the store and the enabled order, resolveActiveMods,
 *  setActiveOverlay(buildOverlay(active)). Never throws (errors -> empty overlay). */
export function bootMods(opts?: { skip?: boolean; store?: ModStore }): Promise<BootResult>
/** Sets the 'patrol-mods-safe' localStorage flag (main.ts calls it when importing the app failed with mods active). */
export function enterSafeMode(): void
export function leaveSafeMode(): void
```
Bundles are validated with `validateModBundle(json, defaultModContext())` by the mod manager **when installed** and
the full set with `validateCombination` **when the enabled list is saved**; boot only applies stored, validated
bundles. A combination that still fails while the data modules load (e.g. a game update) makes `import('./app')`
reject: `main.ts` calls `enterSafeMode()` and reloads; the mod manager shows "Mods were disabled after a failed start".

### 10.5 Loader hooks (exact)

- `src/calls/catalog.ts`: `types: [...loadTypeFiles(glob), ...modOverlay().callTypes]`; `src/calls/cadRows.ts`
  `catalogCadRows()`: same append (mod files after the sorted base files).
- `src/cad/data.ts`: `validateStatutes(mergeStatutes(statutesJson, modOverlay().statutes))` (helper inlined or
  imported from `src/mods/combine.ts` — combine must stay free of data-module imports).
- `src/legal/ruleset.ts` `loadRulesets()`: after the base files, each overlay ruleset (`parseRuleset(json, file)`,
  duplicate id -> throw).
- `src/vehicles/model.ts`: `VEHICLE_MODELS = [...sortedBase, ...modModels]` with indices continuing after the base
  (base indices never change); still <= 255.
- `src/uniform/data.ts`: `parseUniformData(applyUniformPatches(uniformsJson, modOverlay().uniforms), 'uniforms.json')`.
- `src/dialogue/data.ts`: `TRUST` baselines overridden by `districts[d].trustBaseline`.
- `src/speech/profile.ts`: `RANGES[kind]` from `voicePack.voices[kind]` when present; export
  `preferredVoices(kind: VoiceKind): readonly string[]` (the pack's `prefer`, [] default); `src/speech/synthesis.ts`:
  when `preferredVoices('dispatcher')` (or the profile kind) is non-empty, the pool is narrowed to voices whose name or
  lang contains one of the strings (case-insensitive), falling back to the whole pool when none match.
- `src/radio/data.ts`: `PHRASES = validatePhrases(mergePhrases(phrasesJson, modOverlay().voicePack?.phrases))`.

### 10.6 Docs and schemas

`docs/MODDING.md`: overview, install / enable / order / safe mode (`?nomods`), the bundle and folder formats, one
section per content kind (fields, rules, an example, which base files to copy from), load-order rules, determinism
note (a save records the active mods; loading it without them fails with a message naming them), limits, error
message format, "no copyrighted content" rule. `docs/schemas/`: `patrol-mod.schema.json` (draft 2020-12, the
manifest + `content` with `$ref`s), `call-types.schema.json`, `statute.schema.json`, `ruleset.schema.json`
(top-level structure), `vehicle.schema.json` (top-level structure + required sections), `uniforms.schema.json`,
`districts.schema.json`, `voice-pack.schema.json`, `dispatch-script.schema.json`, `scenario.schema.json` (the
sandbox format of §7.5). The TS validators are authoritative; a test asserts every schema parses as JSON, has
`$schema` and `$id`, and lists the same required top-level properties as the validator. `examples/mods/`:
`night-shift-pack.json` (a bundle with one call type in an existing family, one statute, one vehicle, a uniform
colour patch, a district table, a voice pack, a dispatch script) and `example-folder/mod.json` + content files.

## 11. Career and world UI [uiCareer] — wave 3

Owns `src/ui/career/**`, `src/ui/mdt/**`, `src/ui/hud/**`, `test/uicareer/**`, `test/mdt/**`, `test/hud/**`.
Imports career, worldstate (types), training (types), a11y (palette, pulse). All screens are `Menu`s (`ui.ts`),
headless-safe, built with `el(...)`, sizes in em, colours from the §9.1 CSS variables, no flashing (any highlight
uses `pulse(t, isReducedFlash())`), keyboard reachable (Tab / Enter / Escape). Pure models are exported for tests.

### 11.1 Academy (`src/ui/career/academy.ts`, `range.ts`, `defensive.ts`, `reportExercise.ts`, `legalQuiz.ts`)

```ts
export interface AcademyHost {
  seed(): number;
  records(): Readonly<Record<AcademyModule, AcademyRecord>>;
  mods(): Readonly<PerformanceMods>;                 // for the range sway
  submit(module: AcademyModule, score: number): void;
  startDrivingCourse(courseId: string): void;        // closes the screen (integrator)
  canGraduate(): boolean; graduate(): void;          // hidden in standalone hosts
  close(): void;
  readonly standalone: boolean;
}
export class AcademyScreen implements Menu { id = 'academy'; constructor(ui: UIRoot | null, host: AcademyHost); open(): void; refresh(): void }
export function academyModel(records, passMarks): { rows: { module; label; best: string; attempts: number; passed: boolean }[]; canGraduate: boolean }
/** localStorage 'patrol-training-records' (try/catch): best / attempts per module for the no-world drills. */
export function standaloneAcademyHost(storage: Pick<Storage, 'getItem' | 'setItem'> | null, onClose: () => void): AcademyHost
```
- `RangeMinigame` (pausing Menu, canvas 640x360 scaled to fit): crosshair follows the pointer plus
  `swayOffset`; click = shot; targets drawn as circles with rings, no-shoot targets as a grey square with an open
  hand glyph; a shot leaves a small static mark (no screen flash); timer bar; at the end the score and
  `submit('firearms', score)`. Attempt number = `records.firearms.attempts`.
- `DefensiveDrill`: 8 drills drawn with `createRng(seed).stream('academy:defensive:<attempt>')`, situation text, the
  options as buttons (keys 1-4), a time bar of `timeLimitS` (timeout = -1), feedback after each, `gradeDefensive`.
- `ReportExerciseScreen`: exercise picked round robin by attempt, narrative paragraphs, statement checkboxes, Submit ->
  `gradeReportExercise` with the missing / false lists. Also the **report-writing-only mode** (standalone host).
- `LegalQuizScreen`: `drawQuiz(level, quizQuestions, rng)`, one question at a time with 4 options, explanation after
  answering; mode `academy` submits 'legal', mode `exam` returns the score via a callback (promotion exam).

### 11.2 Career screens (`careerScreen.ts`, `apartment.ts`, `summary.ts`, `trainee.ts`)

```ts
export interface CareerHost {
  view(): CareerView; eligibility(): EligibilityContext; names(): readonly string[];
  request(r: CareerRequest): void;                    // queued for the next career step
  startExam(rank: CareerRank, done: (score: number) => void): void;   // opens LegalQuizScreen in exam mode
  close(): void;
}
export class CareerScreen implements Menu   // pausing; tabs Overview / Schedule & bids / Units / Promotion / Pay / Evaluations
export function careerOverviewModel(v: CareerView): { lines: { label: string; text: string; severity: 'clear' | 'caution' | 'alert' }[] }
export function unitsModel(v: CareerView, ctx: EligibilityContext): { id: SpecialtyId | 'fto'; label: string; eligible: boolean; reasons: string[]; current: boolean }[]
export function bidModel(v: CareerView): { prefs: BidPref[]; nextBidShift: number; options: { key: string; label: string }[] }
export interface ApartmentHost { view(): CareerView; plan(a: OffDutyActivity, hours: number): { ok: boolean; reason: string };
  courtLines(): readonly string[]; reportForDuty(): void; openCareer(): void }
export class ApartmentScreen implements Menu        // pausing; wellbeing bars, money, hours left, next shift, court dates, neglect warnings, activity steppers, log
export function apartmentModel(v: CareerView): { hoursLeft: number; nextShift: string; bars: { key: string; label: string; value: number; severity: string }[];
  warnings: string[]; activities: { id: OffDutyActivity; label: string; maxHours: number; enabled: boolean }[] }
export class ShiftSummaryScreen implements Menu     // pay breakdown, DOR, stats, events; Continue -> host callback (apartment)
export class TraineeEvalPanel implements Menu       // FTO: 5 categories x 1..5, submit -> request traineeRating
```
Warnings: "Family time neglected for N days", "Sleep debt Nh", "Money below zero", "Fitness falling", "Critical
stress" (from the view). Court lines come from the integrator.

### 11.3 HUD (`src/ui/hud/phase8.ts`, `hud.ts`, `minimap.ts`)

```ts
export interface HudCareer { fatigue: number; stress: number; shiftLine: string; vignette: number }
export function wellbeingChip(fatigue: number, stress: number): { text: string; severity: 'clear' | 'caution' | 'alert' } | null  // null below 0.6 / 0.6
export function shiftLine(nowGame: number, startGame: number, endGame: number): string   // 'Shift 06:00-14:00', 'OT +0:35'
export function courseLine(e: { gate: number; gates: number; cones: number; timeS: number } | null): string // 'Gate 4/8 · cones 1 · 0:42.3'
export function coopChip(s: { connected: boolean; unit: string; members: number } | null): string           // 'CO-OP N1 · 3 online' / 'CO-OP offline'
```
`Hud` gains `setCareer(c: HudCareer | null)`, `setCourseLine(text)`, `setCoopChip(text)`, `setOrderLine(text)` and
a fixed vignette element (`radial-gradient` overlay, opacity = vignette, no transition). `Minimap` and
`src/ui/mdt/map.ts` take marker colours from `semanticColor(...)` (repaint when `revision()` changes); remote co-op
units are drawn with the `unit` colour and their callsign.

### 11.4 MDT (`src/ui/mdt/**`)

- `MdtDeps` gains optional `premise?(callId: number): PremiseView | null`, `cases?: MdtCasesDeps`,
  `careerSummary?(): readonly { label: string; text: string }[]`.
  `PremiseView = { address: string; flags: readonly string[]; entries: readonly { when: string; text: string }[] }`
  (`when` formatted by the integrator's feed with `formatStamp`).
  `MdtCasesDeps = { revision(): number; rows(): readonly { id: string; status: string; nature: string; opened: string;
  location: string; suspects: string; witnesses: string }[] }`.
- Call tab: a "PREMISE HISTORY" block under the narrative: flags as chips (alert colour for weapon / violence /
  officerSafety), up to 6 entries, "No prior calls at this address" when empty.
- New tab `cases` (appended to `MDT_TABS`, label 'Cases', arrow-reachable): open / follow-up first, then cold and
  cleared.
- Career tab (`career.ts`): a "CAREER" section from `careerSummary()` before the existing sections.
Tests: models and DOM-free behaviour (`test/mdt/premise.test.ts`, `test/mdt/cases.test.ts`, `test/hud/phase8.test.ts`,
`test/uicareer/*.test.ts`: academy model, apartment model warnings and enablement, careerOverview, unitsModel reasons,
bidModel, range scoring path through the minigame's pure helpers, quiz flow state machine).

## 12. Modes UI [uiModes] — wave 3

Owns `src/ui/dispatch/**`, `src/ui/sandbox/**`, `src/ui/mods/**`, `src/ui/coop/**`, `src/ui/mainMenu.ts`,
`test/uimodes/**`, `test/mainMenu/**`. Same UI rules as §11.

### 12.1 Dispatch console (`src/ui/dispatch/console.ts`, `model.ts`, `map.ts`, `dispatch.css`)

```ts
export interface ConsoleCall { id: number; number: string; nature: string; priority: 1 | 2 | 3 | 4; status: 'pending' | 'active' | 'closed';
  address: string; district: string; ageS: number; units: readonly string[]; x: number; z: number; premise: readonly string[]; notes: readonly string[] }
export interface ConsoleUnit { callsign: string; label: string; status: string; callId: number | null; x: number; z: number; etaS: number; kind: 'ai' | 'player' | 'remote' }
export interface DispatchConsolePort {
  readonly title: string; readonly canCreate: boolean; readonly orders: readonly string[];   // [] = no orders
  readonly dispositions: readonly { id: string; label: string }[];
  revision(): number; calls(): readonly ConsoleCall[]; units(): readonly ConsoleUnit[];
  callTypes(): readonly { id: string; label: string }[]; score(): string | null;
  assign(callId: number, callsign: string): void; unassign(callId: number, callsign: string): void;
  setPriority(callId: number, p: 1 | 2 | 3 | 4): void; note(callId: number, text: string): void;
  close(callId: number, disposition: string): void; create(typeId: string, priority: 1 | 2 | 3 | 4, x: number, z: number): void;
  order(callsign: string, order: string, callId: number | null): void;
}
export class DispatchConsole implements Menu   // pausesGame false; constructor(ui, port, graph: RoadGraph, onEscape: () => void)
export function consoleModel(port: DispatchConsolePort, sel: { callId: number | null; unit: string | null }): ConsoleModel
export function suggestUnits(call: ConsoleCall, units: readonly ConsoleUnit[], n: number): string[]   // available, nearest first (ETA when >= 0)
```
Layout: queue table (priority chip colour `--c-p1..4`, age m:ss, status, units) left; map canvas centre (roads from
the `RoadGraph` drawn once to an offscreen canvas per zoom, calls and units on top at <= 4 Hz, colours from
`semanticColor`); unit list right (status, call, ETA); detail bottom (narrative, premise history, notes + input, unit
suggestion buttons, priority 1-4, close with a disposition select, orders). Keys: Up / Down select call, Left / Right
select unit, A assign, U unassign, 1-4 priority, N focus note, C create (then click the map), Escape -> `onEscape`.
Rebuild on `port.revision()` change, at most 4 Hz.

### 12.2 Scenario editor (`src/ui/sandbox/editor.ts`, `state.ts`, `sandbox.css`)

```ts
export type EditorTool = 'select' | 'npc' | 'vehicle' | 'evidence' | 'call';
export class EditorState {
  constructor(doc: SandboxScenario)
  get doc(): SandboxScenario; get selected(): { kind: 'npc' | 'vehicle' | 'evidence' | 'call'; index: number } | null
  place(tool: EditorTool, x: number, z: number, opts: Record<string, string | boolean>): string | null   // error text or null
  move(x: number, z: number): void; rotate(deltaYaw: number): void; remove(): void; select(x: number, z: number, radius: number): void
  setMeta(name: string, description: string): void; setCall(typeId: string | null, priority: 1 | 2 | 3 | 4): void
  setEnvironment(hour: number | null, weather: string | null): void
  validate(ctx?: ScenarioContext): string[]
}
export interface EditorHost { graph: RoadGraph; context: ScenarioContext; anchor(): { x: number; z: number };
  run(doc: SandboxScenario): void; close(): void }
export class ScenarioEditor implements Menu       // pausing; open(doc?)
export function libraryList(storage): { id: string; name: string }[]; export function librarySave(storage, doc): void; export function libraryLoad(storage, id): SandboxScenario | null
```
Library in localStorage `patrol-scenarios` (<= 32 docs, try/catch). Export: `Blob` + `URL.createObjectURL` +
an `<a download="<id>.json">` click; Import: file input -> `parseSandboxScenario` -> error list shown. Canvas:
top-down roads around the anchor (+-150 m), placed objects as glyphs (circle NPC, rectangle vehicle, diamond
evidence, star call), drag to move, Q / E rotate, Delete removes.

### 12.3 Mod manager (`src/ui/mods/modManager.ts`, `mods.css`)

```ts
export interface ModManagerHost { store: ModStore; context(): ModValidationContext; active(): readonly ModRef[];
  bootErrors(): readonly string[]; safeMode(): boolean; reload(): void; close(): void }
export class ModManager implements Menu           // pausing
export function modRows(stored: readonly StoredMod[], enabled: readonly string[], active: readonly ModRef[]): { id: string; name: string;
  version: string; author: string; kinds: string; size: string; enabled: boolean; active: boolean; order: number }[]
```
"Add mod..." (file input, `.json`, multiple) and "Add mod folder..." (`webkitdirectory`): `readModFiles` ->
`validateModBundle` -> errors listed per file with `formatModErrors` (nothing stored on error) or `store.put`. Rows:
enable checkbox, up / down, remove (confirm). "Save & reload": `resolveActiveMods` + `validateCombination` over the
enabled set; errors block saving; else `store.setEnabled(order)`, `leaveSafeMode()`, `host.reload()`. Shows the
active refs, boot errors and the safe-mode notice.

### 12.4 Co-op lobby and panel (`src/ui/coop/lobby.ts`, `panel.ts`)

```ts
export interface CoopLobbyHost { connect(url: string, room: string, name: string, role: NetRole): void; status(): { state: string; text: string };
  start(): void; cancel(): void }
export class CoopLobby implements Menu           // pausing; URL (default DEFAULT_SERVER_URL, remembered in localStorage 'patrol-coop'), room, name, role
export function coopPanelModel(s: { members: readonly NetUnit[]; self: string; partner: string | null; orders: readonly string[] }): ActionPanelModel
```
The lobby explains: "Optional. Run `npm run server` on this computer or your local network. Nothing is sent
anywhere else." The panel (non-pausing `ActionPanel`, `coop.menu`): members with status, request partner, send a
radio line (opens a one-line text prompt), last orders, Disconnect.

### 12.5 Main menu (`src/ui/mainMenu.ts`)

Sections: **Career** (New career: seed, jurisdiction, Create officer — existing controls reused), **Free patrol**
(the existing New game), **Training** (Academy drills, Report writing, Driving academy, Dispatch-only + script select
(built-in + mod scripts via `scripts()` callback), Scenario editor), **Multiplayer (optional)** (opens the lobby),
**Mods** (opens the manager; shows "N mods active"), Continue list, Settings. `MainMenuCallbacks` gains optional
`newCareer?(seed, jurisdiction, character)`, `training?(kind: 'drills' | 'report' | 'driving' | 'dispatch' |
'sandbox', option?: string)`, `openCoop?()`, `openMods?()`, `scripts?(): { id: string; name: string }[]`,
`modSummary?(): string`; existing callbacks and tests stay valid (absent callbacks hide their buttons).
Tests: console model selection / suggestions / ordering, editor state operations and validation, library round trip
with a fake storage, mod rows, lobby and panel models, main menu callbacks headless.

## 13. UI structure

| Surface | Owner | Opens on | Pauses |
|---|---|---|---|
| Academy hub + range / defensive / report / legal screens | uiCareer | career stage academy (auto at shift start), main menu Training > Academy drills | yes |
| Report writing only | uiCareer `ReportExerciseScreen` (standalone host) | main menu Training > Report writing | yes (no world) |
| Driving course HUD line | uiCareer HUD | course run | – |
| Career screen (overview, bids, units, promotion, pay, evaluations) | uiCareer | `career.menu` (Minus), MDT Career tab button | yes |
| Shift summary | uiCareer | `career:shiftSummary` (after End shift) | yes |
| Apartment (off duty) | uiCareer | Continue on the summary | yes |
| FTO trainee rating | uiCareer | summary when assignment fto | yes |
| MDT premise history (Call tab), Cases tab, career section | uiCareer | MDT | no |
| HUD: wellbeing chip, shift line, vignette, course line, co-op chip, order line | uiCareer + integrator feed | always | – |
| Dispatch console | uiModes | dispatch-only mode start, `dispatch.console` (Home) in dispatcher / supervisor co-op roles | no |
| Scenario editor | uiModes | sandbox mode start, pause menu > Scenario editor, `sandbox` console command | yes |
| Mod manager | uiModes | main menu > Mods | yes (title screen) |
| Co-op lobby | uiModes | main menu > Multiplayer | yes (title screen) |
| Co-op panel | uiModes | `coop.menu` (Digit0) in co-op | no |
| Settings: one-handed layout, colour vision preview | a11y | settings | yes |

## 14. ECS components and event topics

No new components in `src/ecs/components.ts`: career, world, training, co-op and mods state are plain objects owned
by their systems; cones are presentation (`ConeRenderer`), remote co-op officers are drawn through an extra
`HumanoidSource` built by the integrator from presence data (presentation only). Topics: §4.3 (the integrator
declares `coop:*` in `src/core/event-map.ts` and updates its header comment). Integrator bridges (synchronous in the
emitting step, enqueue only):

| From | To |
|---|---|
| `force:applied` (by the player) | career stress `forceUsed` (`firearmDischarged` for the firearm tool) + stat `forceEvents`; `incident:forceVerdict` excessive / questionable -> stat `unjustifiedForce` |
| officer wounded (Phase 7 `officerHit` result) | career `injury` 0.4 + stress `officerInjured` |
| `scene:pursuit` start (player) | stress `pursuit`, stat `pursuits` |
| scene outcome with a deceased participant | stress `deceasedOnScene` |
| `conduct:ia` / `conduct:iaResolved` sustained / `conduct:commendation` | stress `iaOpened` / `iaSustained` / `commendation` |
| `court:verdict` | not guilty / dismissed for misconduct -> stress `courtLoss`; world `verdict` for the case's person |
| `command:post` level major+ | stress `criticalIncident` |
| `dispatch:arrest` / booking document saved | stress `arrestMade`, stat `arrests`; world `arrest` (person, district, statute class of the booking's top charge, juvenile, priors = record prior count) |
| `cad:callClosed` | world `callClosed` (`premiseFlagsFor` from the scene runtime / outcome); player calls -> stat `calls`, stress `callCleared`; dispatch training `onClosed`; worldstate `caseOpen` when the category is in `cases.categories`, no arrest was made and the scene had a suspect role or evidence items |
| `investigation:canvass` / statement taken | world `witness` (person, call, record address) |
| `conduct:report` (grade) | stat `reports` + `reportSum` |
| `incident:closed` (assessment) | stat `unlawfulDeterminations`; trust delta of the shift summed into stat `trustDelta` |
| `fleet:charge` | stat `fleetPoints` (+ the Phase 7 conduct bridge) |
| `fleet:shiftEnd` | career `endShift` with the eligibility context from conduct (points, credibility, sustained IA cases in the last 20 shifts, average report) and `suspended` from the duty status |
| `career:points` | `conduct.request({ kind: 'points', delta, reason, key })` |
| `career:stage` | character profile rank (`uniform` rank id), dispatcher category weights (`assignmentEffects`), HUD flash |
| `career:flash`, `world:flash`, `training:flash`, `coop:flash`, `world:recidivist` ("Known offender: <name>, <n> prior arrests") | HUD flash line |
| `training:course` | HUD course line; done -> academy score (career) or the driving-academy result panel |
| `cad:callCreated` / `cad:unitAssigned` (dispatch-only) | dispatch training `onCreated` / `onAssigned` (distance of the unit, `dispatcher.nearestAvailableDistance`) |
| co-op local player status / self-assign / clear | `NetClient.send(unitStatus / callAssign / callClose)` |

## 15. Step order, frame order, determinism, workers

| Order | System | Work |
|---|---|---|
| (session, first) | co-op inbox | `NetClient.drain` -> `CoopMirror.applyEvent` -> local CAD / dispatcher ops (co-op only) |
| -700 | `dispatch` | + manual dispatch, generator flag, scripted calls (from the script runner of the previous step), location bias, category weights |
| -690 | `scene` | + person bias |
| -685 | `force` | + accuracy factor = `career.performance().aimSpread` |
| -655 | `fleet` | unchanged |
| **-654** | **`career`** | requests; per game minute fatigue / stress tick and overtime |
| **-653** | **`worldstate`** | requests |
| **-652** | **`training`** | course run step (officer's vehicle position), script runner `due` -> `dispatcher.createScriptedCall` queue, scoring |
| 40 | `vehicles.pre` | + steering lag: the driver's steer input passes a first-order lag with time constant `steerLagS` (integrator, `session.fixedUpdate` before `setControls`) |

Per frame (`App.update`): `career.menu` / `coop.menu` / `dispatch.console` keys; presence send at 5 Hz (co-op); HUD
career feed at 10 Hz; cone renderer `set` when the run's cone hits change; dispatch console / editor / screens rebuild
on revision; palette mode from settings (`setPaletteMode`) on change.

**Determinism.** Career and world state change in their fixed steps (bus-queued requests) or in the paused
between-step actions (academy scores, off-duty plan, report for duty, rollover, sandbox spawns), which are inputs
stored in the save. The new hooks draw from existing streams (`callsRng`, the scenario rng) only when their pools are
non-empty, so all Phase 1-7 determinism fixtures stay bit-identical; with a non-empty world the same save + inputs
gives the same shift. The rollover is a pure function of the save and the plan (tested twice -> identical). The
academy minigames are presentation; only their final score enters the simulation. Co-op inputs arrive in network
order and are applied at the start of a fixed step: co-op runs are not replayable (documented).

**Workers.** No new worker. The heavy Phase 8 work is rare and bounded: `evolve` (<= 5 ms) and the rollover (city
regeneration ~60-130 ms + load) run once per shift behind the "Starting next shift..." status; mod validation runs
once per install in the mod manager (<= 200 ms for 2 MiB) and boot only applies stored bundles (<= 30 ms); the
dispatch console's map is drawn once per zoom to an offscreen canvas. Networking is event-driven (the WebSocket
callbacks only enqueue). Moving these to a worker would add transfers and determinism risk for no frame-time gain.

## 16. Save schema v10 (integrator only)

```ts
export interface SaveGameV10 extends SaveGameV9 {
  career: CareerSave;          // §5.6
  worldState: WorldStateSave;  // §6.2
  mode: ModeSave;              // §7.1
  mods: ModRef[];              // §10.1, the overlay refs active when saved
}
```
`CURRENT_SAVE_VERSION = 10`. `migrateV9ToV10(data)`: `career: legacyCareerSave(createRng(data.seed).stream('career')
.state(), nowGame)` (`nowGame` = `gameSecondsAt(data.clock.simTime, data.environment.timeOffset)`), `worldState:
newWorldStateSave(createRng(data.seed).stream('worldstate').state())`, `mode: newModeSave('freePatrol')`, `mods: []`.
`isSaveGameV10` = v9 checks + `isCareerSave`, `isWorldStateSave`, `isModeSave`, the mod refs array. Load order: ...
command -> character -> gear -> fleet -> **career -> worldState -> mode** (re-applies the dispatcher flags, script
runner, course run, scoring) -> radio. Loading a save whose `mods` differ from `activeModRefs()` still tries; a
validation failure names the missing mods ("This save was made with mods: night-shift-pack 1.0.0"). Tests
(`test/save`): v1..v9 -> v10 migrate and validate; v10 round trip; each malformed new block rejected; a migrated v9
save ends a shift, rolls over and plays the next shift.

## 17. Performance budget (60 FPS, mid-range desktop)

| Subsystem | Budget | Notes |
|---|---|---|
| career step | <= 0.005 ms/step; <= 0.05 ms on a request step | per game minute work only |
| worldstate step | <= 0.005 ms idle; <= 0.1 ms per request | Map lookups, capped lists |
| person bias / repeat-location hook | <= 0.02 ms per call creation | pool <= 300 offenders / 400 premises |
| evolve + rollover | evolve <= 5 ms; rollover <= 1.5 s total (once per shift, behind a status screen) | city regeneration dominates |
| training step | course <= 0.002 ms/step, scripts / scoring O(1) per step | allocation-free `step` |
| cone renderer | 1 draw call, <= 64 instances, matrices only on change | |
| dispatch console | DOM rebuild <= 4 Hz on revision; map overlay <= 4 Hz; roads cached per zoom | non-pausing |
| HUD additions | 10 Hz, write on change; vignette opacity only | |
| co-op client | presence 5 Hz (<= 120 B each), inbound drain <= 0.2 ms/frame, mirror ops on events only | |
| co-op server | <= 6 members/room, 20 msg/s each, presence broadcast 5 Hz, frames <= 8 KiB (64 KiB hard cap) | Node, single thread |
| mods | boot apply <= 30 ms; data loaders + overlay <= 50 ms extra for 2 MiB of content; validation on install <= 200 ms | |
| palette | O(1) lookups, zero allocation; canvases repaint on `revision()` change | |
| save size | career ~6 KiB, world <= 120 KiB worst case (400 premises x 12 entries), mode <= 20 KiB | capped lists |

## 18. Requirement map

| Requirement | Code |
|---|---|
| Academy modules (driving course, firearms range, defensive tactics, report writing, legal quiz) with scores | `DrivingCourseRun` + `courses.json` (§7.2), `rangeSchedule` / `scoreRange` / `swayOffset`, `gradeDefensive`, `gradeReportExercise`, `drawQuiz` / `gradeQuiz` (§5.5), `AcademyScreen` + minigames (§11.1), `recordAcademyScore`, graduation |
| Probation period; FTO role | `probationStep`, `dorFromStats` (DOR by the FTO), `ftoEligibility`, assignment `fto`, `newTrainee` / `rateTrainee`, `TraineeEvalPanel` |
| Patrol; specialty units with entry requirements | stage `patrol`; `specialties.json`, `specialtyEligibility`, `assignmentEffects` (call mix via `setCategoryWeights`, fleet class, uniform class, pay), `unitsModel` |
| Promotions; pay | `promotionEligibility` + exam (`LegalQuizScreen` exam mode), `payForShift`, `rentDue`, Pay tab |
| Seniority-based shift bidding | `aiBidders`, `resolveBids`, `nextShiftStart`, `submitBid` / `resolveBids` requests, Schedule tab (mandatory tests §5.4) |
| Shift fatigue, health, stress | `wellbeing.ts` (mandatory tests §5.3), career step, stress bridges (§14), `performanceMods` -> force accuracy, steering lag, vignette, range sway |
| Off-duty life: apartment hub, rest / exercise / family / second job, neglect consequences | `ApartmentScreen`, `planActivity`, `applyActivity`, `applyIdle`, `applyNeglect`, `reportForDuty`, `fitForDuty` |
| Cases linger across shifts | `WorldState` case register, `caseOpen` bridge, MDT Cases tab, follow-ups after `evolve`, investigation block kept by the rollover |
| Suspects recidivate (released arrestees reappear in calls) | offenders (`arrest` / `verdict` / release), `pickRecidivist` via `setPersonBias` (mandatory tests §6.3), `world:recidivist` flash, people custody released at rollover |
| Witnesses move | witness records + `evolve` moves -> `records.setAddress` |
| Neighborhoods change (trust / crime evolve) | `evolveNeighborhood`, `crimeFactor` -> dispatcher crime factor, trust deltas -> conduct, community tab |
| Repeat addresses build history visible in CAD | premises (`addPremiseEntry`, flags, repeat), MDT premise history, dispatch console premise lines, `pickRepeatLocation` via `setLocationBias` |
| Co-op WebSocket authoritative server in /server, no deps | `server/*.ts` (built-in http / crypto, hand-written frames), `Room` (mandatory validation tests §8.2), env var names only |
| Partner patrol, dispatcher role (CAD main UI), supervisor role, shared CAD | `partner` message + mirror, `DispatchConsole` with the net port, supervisor orders, `CoopMirror` -> local CAD |
| Multiplayer off by default, single-player complete | lobby only on request; no network code runs otherwise |
| Mods: call types, laws, vehicles, uniforms, maps (district table), voice packs, dispatch scripts | `ModContent` kinds + loader hooks (§10.5), `ModStore`, `ModManager`, `bootMods`, `docs/MODDING.md`, `docs/schemas` |
| Mod loader validation with clear errors, enable / disable, load order | `validateModBundle`, `resolveActiveMods`, `validateCombination`, `formatModErrors` (mandatory tests §10.3) |
| Rebinding audit of new actions | 3 new actions in `ACTIONS` (rebinding UI lists them automatically) + `test/a11y` audit |
| Colour-blind modes (UI and key world indicators) | `palettes.json`, CSS variables, `semanticColor` (minimap, MDT map, console), `lightbarRgb` (light bar) |
| Radio subtitles | existing captions (`accessibility.subtitles`); co-op radio lines and voice-pack lines go through the same caption path (integrator) |
| Adjustable text sizes | existing `--text-scale`; every new surface in em units |
| Reduced flash | `pulse`, CSS audit test, no flashing in new UI, vignette without animation, range shots without screen flash |
| One-handed layouts | `layouts.json`, `layoutBindings`, settings `oneHanded` enum (v2 migration) |
| Dispatch-only, report-writing-only, driving academy, scenario editor | modes (§7.1), `DispatchTraining` + `DispatchConsole`, `ReportExerciseScreen` standalone, driving academy flow, `SandboxScenario` + `ScenarioEditor` + `planScenario` (§7.5, §12.2) |
| Save version + tested migration | §16 |
| Determinism, perf, workers, no new dependencies | §15, §17, §19 (blockers: none) |

## 19. Modules, ownership and waves

| Key | Wave | Owns (exclusively) | May import (new Phase 8 code) |
|---|---|---|---|
| career | 1 | `src/career/**`, `src/data/career/**`, `test/career/**` | none |
| worldstate | 1 | `src/worldstate/**`, `src/data/worldstate/**`, `test/worldstate/**` | none |
| training | 1 | `src/training/**`, `src/data/training/**`, `src/render/training/**`, `src/dispatch/**`, `src/data/dispatch/**`, `src/scene/**`, `src/data/scene/**`, `src/force/**`, `src/data/force/**`, `test/training/**`, `test/dispatch/**`, `test/scene/**`, `test/force/**` | none |
| net | 1 | `src/net/**`, `server/**`, `test/net/**`, `test/server/**` | none |
| a11y | 1 | `src/a11y/**`, `src/data/a11y/**`, `src/settings/**`, `src/input/**`, `src/ui/settingsMenu.ts`, `src/ui/styles.css`, `src/render/vehicles/carRenderer.ts`, `test/a11y/**`, `test/settings/**`, `test/input/**` | none |
| mods | 2 | `src/mods/**`, `src/calls/catalog.ts`, `src/calls/cadRows.ts`, `src/cad/data.ts`, `src/legal/ruleset.ts`, `src/vehicles/model.ts`, `src/uniform/data.ts`, `src/dialogue/data.ts`, `src/speech/profile.ts`, `src/speech/synthesis.ts`, `src/radio/data.ts`, `docs/MODDING.md`, `docs/schemas/**`, `examples/mods/**`, `test/mods/**` | training |
| uiCareer | 3 | `src/ui/career/**`, `src/ui/mdt/**`, `src/ui/hud/**`, `test/uicareer/**`, `test/mdt/**`, `test/hud/**` | career, worldstate, training, a11y |
| uiModes | 3 | `src/ui/dispatch/**`, `src/ui/sandbox/**`, `src/ui/mods/**`, `src/ui/coop/**`, `src/ui/mainMenu.ts`, `test/uimodes/**`, `test/mainMenu/**` | training, net, mods, a11y |
| integrator | 4 | `src/app.ts`, `src/game/**`, `src/core/event-map.ts`, `src/ecs/components.ts`, `src/save/**`, `docs/PHASES.md`, `scripts/smoke.mjs`, and unowned files (`src/main.ts`, `package.json` scripts, `tsconfig.json`, `docs/ARCHITECTURE.md`, `README.md`, other `src/**`, `test/game/**`, `test/save/**`, other tests) | all |

A module that needs a change in a file it does not own lists it for the integrator in its final report instead of
editing it. Same-wave modules never import each other's Phase 8 additions.

## 20. Integrator plan

1. **Boot and tooling.** `src/main.ts`: `const boot = await bootMods({ skip: new URLSearchParams(location.search).has
   ('nomods') })`, then `const { App } = await import('./app')` (keep `App.create`); on an import failure with active
   mods: `enterSafeMode()` + `location.reload()`; pass `boot` to the app (mod manager notices). `package.json`:
   `"server": "node server/main.ts"`; `typecheck` adds `tsc -p server/tsconfig.json`. `tsconfig.json` include adds
   `"server"`. ESLint already covers `server/*.ts` (typed via the nearest tsconfig).
2. **Save v10** (`src/save/**`, `test/save/**`): types, validators, `migrateV9ToV10`, fixtures, tests (§16).
3. **Session** (`src/game/phase8.ts` holding construction, ports and bridges; `session.ts` hooks):
   - `CareerState` (`rng.stream('career')`, names = roster officer names), `WorldState` (`rng.stream('worldstate')`,
     `baseCrime` from `world.json` merged with `modOverlay().districts[d].crimeFactor * base`), the mode block and the
     training objects; register `career` -654, `worldstate` -653, `training` -652.
   - Hooks: `scene.setPersonBias((callId, district, fits, draw) => world.pickPerson(callId, district, now.game, fits,
     draw))`; `dispatcher.setLocationBias((draw) => world.pickRepeatLocation(draw))`; the dispatcher crime factor =
     the Phase 5 trust factor x `world.crimeFactor(district)`; `setCategoryWeights` from `assignmentEffects`;
     `force.setAccuracyFactor(() => perf.aimSpread)`; steering lag in `session.fixedUpdate`.
   - Bridges of §14; the career eligibility context from conduct.
   - **End of shift and rollover** (`src/game/rollover.ts`): End shift (fleet) closes the player's open calls through
     the dispatcher first; `career:shiftSummary` -> presenter shows the summary, then the apartment. *Report for duty*:
     `career.reportForDuty(epochDay)` (resolve bids first when due); `world.evolve({ fromGame: now, toGame:
     career.shift.startGame, trust: conduct trust per district, arrestsByDistrict (counted from this shift's world
     arrest requests), addressAt })` -> apply: `people.setCustody(id, 'released')`, `records.setAddress`, conduct
     `trust` requests, court hearings inside the gap moved to `startGame + 2 h` (CourtSave edit after serialize);
     `serializeGame` -> `rolloverSave(save, plan)`: `environment.timeOffset += startGame - nowGame`; player on foot
     at the spawn; `traffic` null, `npc` null, `dispatch` null, empty `scenes` / `contacts` / `backup` / `pursuit` /
     `command` / `resources` blocks (the builders of `migrations.ts`), default `tactical` / `interiors` / `radio`,
     station flow back to `locker`; CAD: every open call closed `handled` with the narrative "Shift change: handled by
     the oncoming shift", non-player units removed, player unit outOfService, no traffic stop; vehicles, fleet,
     people, records, investigation, incidents, conduct, court, roster, character, gear, career, worldState, mode
     kept -> `loadGame` -> `beginShiftInStation()` -> follow-ups: `dispatcher.createScriptedCall({ typeId:
     'warrantService', x, z })` + `world.bindPerson(call.id, personId)`.
   - **Modes:** `startNewGame` options gain `mode` and `career` (`newCareerSave` stage academy for Career); career
     academy: the academy screen opens in the locker room; *Driving course*: the officer is seated in P-101 and the car
     is placed at `coursePoint(anchor, -15, 0)` facing the axis (anchor from `pickCourseSegment` over straight
     arterial / collector edge segments >= 320 m nearest the station, extracted from `city.graph`), the cone
     renderer shows the cones, the run steps at -652 with the driven vehicle's position and speed; done -> score ->
     back to the lot. **dispatchOnly**: player unit outOfService, the officer stays in the station, manual dispatch,
     generator per script (`on` when no script), `ScriptRunner` steps resolve `near` (POI kind: nearest POI of that
     kind to the station; district: a point drawn from `rng.stream('training')` inside that district via
     `city.districtAt`; x / z as is) -> `createScriptedCall` (+ radio line via `RadioSystem.say`), the console opens
     with the local port (AI units, `dispatcher.assignUnit`, `cad` notes / priority / close, scores). **sandbox**: the
     editor opens; Run executes `planScenario` ops with `env.setTimeOfDay` / weather override, `dispatcher
     .createScriptedCall`, `session` vehicle spawn (parked, no driver), `npc.spawnActor` (role / call id of the created
     call, `building` -1), `investigation.placeItem` (callId, y 0, outdoors); the mode block keeps the scenario.
     **coop**: §20.5.
   - Remote co-op officers: a `HumanoidSource` of up to 5 figures from presence (on foot only) with the patrol outfit.
4. **App** (`src/app.ts`): the new screens and their hosts (academy, career, apartment, summary, trainee, dispatch
   console with the local and net ports, scenario editor, mod manager, lobby, co-op panel), main menu callbacks, the
   three input actions, HUD feed fields (§11.3), MDT deps (`premise`, `cases`, `careerSummary`), palette mode from
   settings, `ConeRenderer`, perf extras `career`, `world` (premises / offenders), `net` (rev, rejects).
5. **Co-op** (`src/game/coop.ts`): lobby -> `NetClient.connect(url, hello)`; on `welcome` start a new game with the
   room seed, mode coop, role; manual dispatch on, generator off except host-without-dispatcher (then local generated
   calls are proposed with `callCreate` origin generator and `mirror.expectOwn(ref, localId)`); remote units in the
   CAD as `resource` units (`cad.addUnit`, positions from presence); the mirror port maps to dispatcher / CAD calls
   (`self` assignments -> `dispatcher.request(player, { kind: 'acceptCall' })`); local player status changes, self
   assignment and clears -> intents; orders -> `coop:order` (HUD + radio caption); radio lines -> radio log and
   caption (subtitles setting respected); dispatcher / supervisor roles open the console with the net port; presence
   5 Hz; disconnect -> flash and the session continues offline (manual dispatch off, generator on).
6. **Console** (`src/game/phase8Commands.ts`): `career [show|stress <v>|fatigue <v>|shift end|offduty|academy <module>
   <score>|graduate|promote <rank> <score>|assign <unit>]`, `world [premise [address]|cases|offenders|evolve <days>|
   news]`, `course [list|start <id>|stop]`, `dispatchmode [on|off]`, `script [list|run <id>|stop]`, `sandbox [open|
   run <id>]`, `mods [list]`, `coop [status|connect <url> <room> <role>|disconnect]`.
7. **Determinism test** (`test/game/phase8.test.ts`): a career run (academy scores, graduation, a probation shift with
   force and an arrest, End shift, apartment plan, Report for duty -> rollover -> the next shift where a released
   offender is picked for a risk role) twice -> bit-identical v10 saves; a dispatch-only run with a built-in script
   and manual assignments twice -> identical saves and score; a sandbox scenario run -> identical; a v9 save loads
   and rolls over.
8. **Smoke** (`scripts/smoke.mjs`): New career -> academy screen (a quiz answered, the defensive drill, the range
   with scripted clicks, a report exercise) — screenshot `phase8-academy.png`; driving course with the console
   `course start basic` and scripted driving; `career academy * 100` + graduate; End shift -> summary -> apartment
   (rest, family) — screenshot `phase8-apartment.png`; Report for duty (next shift, premise history in the MDT);
   dispatch-only mode with `friday-night`, two assignments — screenshot `phase8-dispatch.png`; scenario editor
   (place 2 NPCs, a vehicle, a knife, a call type, export, run); mod manager with `examples/mods/night-shift-pack.json`
   (validation ok, enable, reload, the mod vehicle in `fleet spawn`); colour-vision protanopia and the left-hand
   layout in settings; co-op: start `node server/main.ts` on a free port, two pages (patrol + dispatcher), the
   dispatcher creates and assigns a call, the patrol client sees it in the MDT, an illegal action is rejected;
   save / load v10; zero console errors.
9. **Docs**: event-map comment, `ARCHITECTURE.md` Phase 8 section, `PHASES.md` Phase 8 entry (controls, checklist,
   perf, limitations), README (modes, co-op server, mods).

## 21. Known limitations and later-phase hooks

- Co-op shares the CAD layer only: every client simulates its own world and its own scene for a shared call (the
  same call can play out differently on two machines); partners see each other on the map and as figures, not inside
  the same car. No reconnection, no TLS, no accounts: local network use only.
- "Map" mods are the district table (labels, crime, trust baselines); district geometry stays generated from the
  seed because the chunk worker regenerates the city from module constants.
- Mods cannot add call families, NPC behaviour profiles or new uniform classes (only patches); they apply on reload.
- Repeat-address and recidivism biases act on generated calls and on suspect roles (`risk` / `warrant` constraints)
  only; witnesses who move keep their identity but their old interviews keep the old address text.
- The academy minigames are 2D screens (range, drills, quiz); only the driving course uses the 3D world.
- Fatigue and stress affect aim, steering and a vignette; they do not change dialogue options or radio skill.
- Co-op sessions are not replay-deterministic; a co-op save loads as a free patrol shift.
