# Phase 5 design: Law, Procedure, Consequences

Status: design (technical director). Implementation is split into 8 modules in 3 waves (§19) plus an
integrator (§20). Read with `docs/ARCHITECTURE.md`, `docs/phase1-design.md` §2, `docs/phase2-design.md` §2,
`docs/phase3-design.md` §2-§3, `docs/phase4-design.md` §2-§4 and `docs/research/*.md`. Every builder reads §1-§4
and the sections named in its brief. Names, ids, signatures and shapes in this document are contracts: do not
rename them. When a brief says "add", keep every existing export, behaviour and test green unless the brief says
otherwise.

Note on the save version: the task statement says "currently v5", but Phase 4 already shipped **v6**
(`CURRENT_SAVE_VERSION = 6`, `src/save/schema.ts`). Phase 5 adds **v7** with a tested `migrateV6ToV7`; every
older version (1..6) must still load.

## 1. Scope

At the end of Phase 5 everything the officer does is recorded, judged against a swappable body of law, and has
consequences:

- **Legal engine** (`src/legal`, pure). A structured **incident log** (`IncidentLog`, §4.3) of everything the
  officer did and observed during an incident (observations, lookups, statements, questions, consents, frisks,
  searches, seizures, tests, arrests, force, pursuits, entries, camera state) is evaluated against a **JSON
  ruleset** (`src/data/legal/rulesets/*.json`; default `generic` = generic US state law; alternate `strict` proves
  swapping) into a `LegalAssessment`: reasonable suspicion, probable cause, Terry stop and frisk (incl. scope /
  plain feel), search incident to arrest (time window, vehicle rule), automobile exception, consent (validity,
  scope, coercion), exigency, premises entry, Miranda / custodial interrogation (warning, waiver, invocation),
  breath / sobriety tests, use-of-force continuum and justification, duty to intervene, pursuit policy, recording
  policy (bodycam / dashcam), evidence admissibility with the fruit-of-the-poisonous-tree chain and exceptions.
  Every determination cites ruleset rule ids (`"GS-4.1"` …) whose text names a generic citation.
- **Use of force** (`src/force`). Tools: presence, verbal (Phase 3 commands), soft hands (cuffing / struggle),
  hard hands (strike, tackle), OC spray, baton, TASER (2 cartridges, probe spread and hit model, 5 s cycles, cycle
  limit, risk factors: elderly, pregnant, elevated position, running, restrained, juvenile), K9 apprehension
  (needs the Phase 4 K9 unit on scene), less-lethal launcher (beanbag), firearm (aim along the camera, hit model,
  NPC injury and death). Every application records the subject's **resistance level** (`compliant passive active
  assaultive lethal`, derived from Phase 3 NPC behaviour) and is scored immediately (justified / questionable /
  excessive, HUD line) and again in the assessment. A fellow-officer misconduct episode (the Phase 4 partner
  striking a restrained subject) exercises the **duty to intervene** (key H).
- **Outcomes** (`src/conduct`). Incident reports gain a **statements of fact** checklist (true facts, plausible
  false facts, conclusions); reports are graded for completeness, contradictions (heavier when the bodycam
  recorded the truth) and unsupported conclusions. Internal-affairs **triggers** (data rules) open IA cases;
  the officer reviews the bodycam timeline and gives a statement; findings lead to counselling, reprimands,
  suspensions, termination, civil suits or criminal charges. Good policing earns **commendations**.
- **Community trust** per district (the 11 district types of `districts.json`), persisted, shown on the MDT, and
  feeding NPC cooperation (dialogue rapport), tips (dispatch information quality), hostility (hostile onlookers on
  arrests / force) and crime rates (call generator multiplier).
- **Court** (`src/court`). Bookings and citations become cases; pleas are rolled; the officer is **subpoenaed**
  (a hearing time on the game clock, shown on the HUD and the MDT Career tab); the **courtroom** panel shows the
  judge's motion rulings (suppression, dismissal) and a cross-examination whose questions are generated from the
  officer's report and the event log; inconsistent answers (with the log, with the report, with themselves)
  cost credibility and the case.
- **Bodycam and dashcam recording** (`src/recording` + `src/incidents`). The event stream carries camera state
  bits; periodic low-res frame snapshots (160×90 JPEG `Blob`s, size-capped, IndexedDB database `patrol-media`,
  retention limits) are captured from the rendered frame; the **evidence review** panel (timeline scrubber,
  events, snapshots, REC / MUTED strip) is used by IA and court. Activation, late activation and muting are
  evaluated by the ruleset's recording policy.

Non-goals (later phases): free-text narrative understanding (the narrative stays a required free-text field;
grading uses the statements checklist), video recording (snapshots only), separate dashcam camera view (snapshots
come from the rendered frame while the officer is in the car), multiple AI officers on foot (the partner
placeholder is the only fellow officer), courtroom 3D scene (a full-screen panel), off-duty time skipping (the
hearing takes place "off-clock": no sim time passes in the courtroom), real legal advice (the rules are a
simplified, generic model).

## 2. Conventions (in addition to Phase 1-4 §2)

- **TS rules** unchanged: no enums / namespaces / parameter properties; `as const` objects + unions; `import
  type`; `noUncheckedIndexedAccess`; JSDoc on exports; `scratch*` temporaries in hot loops; no per-step allocation
  in `step` hot paths (events and requests may allocate: they are rare).
- **Determinism.** All new simulation state changes in fixed steps and draws only from named streams:
  `session.rng.stream('force')`, `'conduct'`, `'court'` (the incidents system and the legal engine draw nothing;
  report choice order and cross-examination order use `createRng(seed).stream('report:' + key)` /
  `stream('court:' + caseId)`, pure functions of seed and id). `Math.random`, `Date.now`, `performance.now` are
  forbidden in `src/legal`, `src/force`, `src/incidents`, `src/conduct`, `src/court`. Presentation (snapshots,
  media store, panels) never feeds back into the simulation.
- **UI → sim through queues.** Panels and keys produce request objects (`ForceSystem.request`,
  `IncidentSystem.request`, `ConductState.request`, `CourtState.request`) applied at the start of the owner's next
  fixed step.
- **Data** in `src/data/<area>/*.json`, `"version": 1`, validated at import by a typed validator throwing `Error`
  naming the file and the dotted JSON path (pattern `src/cad/data.ts`, `src/npc/data.ts` `parseBehaviors`).
  Multi-file folders use `import.meta.glob('<dir>/*.json', { eager: true, import: 'default' })` processed
  **sorted by path** (rulesets).
- **Headless.** DOM classes construct and run as no-ops without `document` (vitest = node); IndexedDB code has an
  in-memory twin; tests may use `fake-indexeddb` (already a dev dependency: `import 'fake-indexeddb/auto'`; Blobs
  round-trip through it in Node 22, verified).
- **Generic content only.** No real agency names, badges, case names or statute numbers: rule citations are
  invented generic strings ("Gen. Crim. Proc. § 4.1"); doctrine labels ("Terry stop", "fruit of the poisonous
  tree") are generic legal vocabulary. No third-party assets; `docs/ASSETS.md` stays empty.
- **Time.** `t` = sim seconds (`CadTime.sim`), `game` = game seconds (`CadTime.game`, `env.time.totalSeconds`).
  Durations in rulesets are **sim seconds** (gameplay feel) except court / IA / suspension / trust drift which use
  **game hours / days**.

## 3. Architecture

```
 fixed step (60 Hz)
 ┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ scene (-690)  + setWeapon (driven by force), scene:command, pursuit owner/person/endReason, terminatePursuit,│
 │               trust hooks (info error scale, hostile onlookers)                                              │
 │ force (-685)  tool selection, apply (cone target, hit models, effects via npc / people), TASER cycles,      │
 │               fellow-officer misconduct + intervene ─▶ force:applied / force:other / force:intervened        │
 │ contact (-680)+ contact:fact / :said / :action / :miranda, Miranda waiver / invocation                       │
 │ investigation (-675), station (-670)                                                                         │
 │ incidents (-660) IncidentRecorder: bus topics ─▶ IncidentLog per incident (cam bits on every event),         │
 │                  pursuit samples (1 Hz), live force verdicts + advisories, closes incidents,                  │
 │                  evaluateIncident (src/legal, pure, ≤ 1 per step) ─▶ incident:closed                         │
 │ conduct (-658)  report grading, IA triggers / cases / findings / discipline, commendations,                  │
 │                 community trust (deltas, spill, drift), duty status, credibility                            │
 │ court (-656)    cases, pleas, subpoenas, hearing window, cross-exam session, verdicts                        │
 │ radio (-650), tactical (-640), vehicles.pre 40, traffic 50, npc 60 (+ resistance, incapacitate, wound)      │
 └──────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 presentation (per frame)
   after renderer.render(): SnapshotScheduler.due ─▶ captureSnapshot (160×90, same task) ─▶ toBlob ─▶ MediaStore
   HUD: force tool / cartridges, REC · MUTED · DASH chips, force verdict line, duty status, court due line, trust
   MDT: Career tab (calendar, cases, IA, commendations, discipline, credibility), Community tab (trust per district),
        incident report form + statements checklist
   panels: CourtroomPanel (pausing), EvidenceReviewPanel (pausing; IA statement footer), main-menu jurisdiction
```

- **Wave 1 (no new Phase 5 imports):** `legal` (pure engine, types, rulesets, report choices), `force` (pure tool
  models + `ForceSystem`), `hooks` (Phase 3/4 gameplay hooks in npc, contact, dialogue, scene, calls, dispatch
  generator), `recording` (media store, snapshot capture, review timeline + panel).
- **Wave 2:** `incidents` (recorder; imports legal, force events, hooks events), `conduct` (imports legal),
  `court` (imports legal).
- **Wave 3:** `ui` (MDT tabs, report checklist, courtroom, IA flow, HUD, input, main menu; imports all).
- Same-wave cross-module calls go through **structural port interfaces** declared by the consumer; the
  integrator wires the real objects and `tsc` checks assignability. Importing **pre-existing Phase 0-4 exports**
  of a file another module owns is always allowed (e.g. `ActorInfo` from `src/npc/types.ts`, `TRUST` from
  `src/dialogue`, `hash3` from `src/records/hash.ts`); only Phase 5 additions of a same-wave module are off limits.

## 4. Shared contracts

### 4.1 Fixed id lists (contracts)

| List | Ids | Defined by | Referenced by |
|---|---|---|---|
| `RESISTANCE_LEVELS` (5) | `compliant passive active assaultive lethal` | legal `src/legal/types.ts` | force, hooks (npc `resistance`), incidents, conduct, court, ui |
| `FORCE_LEVELS` (10) | `presence verbal softHands hardHands ocSpray baton taser k9 lessLethal firearm` | legal | force, incidents, conduct, ui |
| `FORCE_TOOLS` (8) | `none hands ocSpray baton taser lessLethal firearm k9` | force `src/force/types.ts` | ui (HUD), integrator |
| `CONSENT_KINDS` (7) | `entry searchPremises searchRoom searchPerson searchVehicle pbt sfst` | Phase 4 (dialogue) | legal (re-declares) |
| `CLAIMED_BASES` (7) | `plainView consent warrant incidentToArrest exigency protectiveSweep publicArea` (= Phase 4 `SEARCH_BASES`) | legal | incidents |
| `SEARCH_TARGETS` (5) | `person vehicle premises room container` | legal | incidents |
| `DOCTRINES` (15) | `detention frisk friskScope search arrest consent exigency entry miranda test force intervene pursuit recording evidence` | legal | conduct (IA rules), court, ui |
| `INCIDENT_EVENT_KINDS` (29) | `start person indicator detention command question statement miranda consent frisk search seizure test arrest charges release force otherForce intervene entry exigency warrant service pursuitStart pursuitSample pursuitEnd advisory cam close` | legal | incidents, conduct, court, ui |
| `OFFENSES` (9) | `traffic dui drugs weapons warrant felonyVehicle property violent obstruction` | legal (ruleset keys) | incidents, court |
| `INDICATORS` (26) | §5.2 table | legal (ruleset keys) | incidents (`mapping.json`) |
| `MIRANDA_RESULTS` (3) | `waived invoked misunderstood` | hooks (`src/dialogue/types.ts`) | legal, incidents |
| `IA_FINDINGS` (4) | `exonerated unfounded notSustained sustained` | conduct | ui |
| `DUTY_STATUSES` (4) | `active suspended adminLeave terminated` | conduct | ui, integrator |
| `DISCIPLINE_ACTIONS` (6) | `counseling writtenReprimand suspension termination civilSuit criminalCharges` | conduct | ui |
| `CASE_STATUSES` (7) | `pending pleaded scheduled inSession heard missed closed` | court | ui |
| `VERDICTS` (4) | `convicted acquitted dismissed paid` | court | conduct, ui |
| `ANSWERS` (3) | `yes no dontRecall` | court | ui |
| `CAM` bits | `body: 1, muted: 2, dash: 4` | legal | incidents, recording, ui |

Each referencing module of the same wave re-declares the tuple it validates against (the Phase 3 rule).

### 4.2 Resistance (shared semantics)

`resistance` of an actor at an instant (implemented in npc by hooks §7.1; the force module reads it through a port):

| Level | Actor condition (first match wins) |
|---|---|
| `lethal` | state `armed` with a drawn weapon in `LETHAL_WEAPONS` (`handgun rifle shotgun knife`), or an `npc:attack` `fire` within the last 5 s |
| `assaultive` | state `fight`, or state `armed` (other weapon drawn), or an `npc:attack` `fight` within the last 5 s |
| `active` | state `flee`, or a cuffing struggle (`cuff()` returned `'resist'`) within the last 10 s |
| `passive` | refused or was confused by a command (`applyCommand` outcome `refuse` / `confused`) within the last 15 s |
| `compliant` | everything else (incl. `down`, `cuffed`, `handsUp`, `kneel`, `prone`, `seated`, `lying`) |

### 4.3 Incident log (`src/legal/types.ts`, owned by legal; the central contract)

```ts
export const CAM = { body: 1, muted: 2, dash: 4 } as const;
export type Resistance = 'compliant' | 'passive' | 'active' | 'assaultive' | 'lethal';
export type ForceLevel = 'presence' | 'verbal' | 'softHands' | 'hardHands' | 'ocSpray' | 'baton' | 'taser' | 'k9' | 'lessLethal' | 'firearm';
export type ConsentKind = 'entry' | 'searchPremises' | 'searchRoom' | 'searchPerson' | 'searchVehicle' | 'pbt' | 'sfst';
export type ClaimedBasis = 'plainView' | 'consent' | 'warrant' | 'incidentToArrest' | 'exigency' | 'protectiveSweep' | 'publicArea';
export type SearchTarget = 'person' | 'vehicle' | 'premises' | 'room' | 'container';
export type IndicatorSource = 'observation' | 'lookup' | 'statement' | 'evidence' | 'test' | 'call';

/** An item found or seized. `ref` is the people item instance id or the investigation item id. */
export interface FoundItem { ref: string; item: string; label: string; category: string; weapon: boolean; incriminating: boolean }

/** Fields of every event. `personId` -1 = the incident as a whole (vehicle hits, call information). */
export interface EventBase { id: number; t: number; game: number; personId: number; cam: number }

export interface StartEvent extends EventBase { kind: 'start'; callId: number; typeId: string; family: string; field: boolean }
export interface PersonEvent extends EventBase { kind: 'person'; role: string; label: string }
export interface IndicatorEvent extends EventBase { kind: 'indicator'; indicator: string; source: IndicatorSource; sourceEvent: number; detail: string }
export interface DetentionEvent extends EventBase { kind: 'detention'; how: 'trafficStop' | 'command' | 'cuffed' | 'takedown' | 'other' }
export interface CommandEvent extends EventBase { kind: 'command'; command: string; outcome: string }
export interface QuestionEvent extends EventBase { kind: 'question'; fact: string; utterance: string; custody: boolean; gunpoint: boolean }
export interface StatementEvent extends EventBase { kind: 'statement'; fact: string; value: string; display: string; custody: boolean }
export interface MirandaEvent extends EventBase { kind: 'miranda'; result: 'waived' | 'invoked' | 'misunderstood'; custody: boolean }
export interface ConsentEvent extends EventBase { kind: 'consent'; consent: ConsentKind; granted: boolean; valid: boolean; weaponDrawn: boolean; aggressiveLines: number; buildingId: number }
export interface FriskEvent extends EventBase { kind: 'frisk'; found: FoundItem[] }
export interface SearchEvent extends EventBase { kind: 'search'; target: SearchTarget; claimedBasis: ClaimedBasis | null; found: FoundItem[]; buildingId: number; vehicleId: number }
export interface SeizureEvent extends EventBase { kind: 'seizure'; item: FoundItem; fromEvent: number }
export interface TestEvent extends EventBase { kind: 'test'; test: 'pbt' | 'sfst'; result: 'over' | 'under' | 'fail' | 'pass' }
export interface ArrestEvent extends EventBase { kind: 'arrest'; how: 'cuff' | 'booking' }
export interface ChargesEvent extends EventBase { kind: 'charges'; statutes: string[]; docId: string }
export interface ReleaseEvent extends EventBase { kind: 'release'; how: 'release' | 'warn' | 'citation' | 'uncuff' }
export interface ForceEvent extends EventBase {
  kind: 'force'; forceId: number; tool: string; level: ForceLevel; resistance: Resistance; hit: boolean;
  injury: number; fatal: boolean; cycle: number; riskFactors: string[]; distance: number; restrained: boolean;
}
export interface OtherForceEvent extends EventBase { kind: 'otherForce'; officer: string; level: ForceLevel; resistance: Resistance; distanceToOfficer: number; seq: number; restrained: boolean }
export interface InterveneEvent extends EventBase { kind: 'intervene'; otherEvent: number }
export interface EntryEvent extends EventBase { kind: 'entry'; buildingId: number; publicPlace: boolean }
export interface ExigencyEvent extends EventBase { kind: 'exigency'; reason: string }
export interface WarrantEvent extends EventBase { kind: 'warrant'; scope: 'arrest' | 'search' }
export interface ServiceEvent extends EventBase { kind: 'service'; service: string; phase: 'requested' | 'arrived' }
export interface PursuitStartEvent extends EventBase { kind: 'pursuitStart'; pursuit: 'vehicle' | 'foot'; pursuitCallId: number }
export interface PursuitSampleEvent extends EventBase { kind: 'pursuitSample'; speedMph: number; limitMph: number; district: string; wet: boolean; night: boolean; lights: boolean; siren: boolean }
export interface PursuitEndEvent extends EventBase { kind: 'pursuitEnd'; reason: string }
export interface AdvisoryEvent extends EventBase { kind: 'advisory'; advisory: 'terminatePursuit' | 'activateBodycam'; text: string }
export interface CamEvent extends EventBase { kind: 'cam'; body: boolean; muted: boolean; dash: boolean }
export interface CloseEvent extends EventBase { kind: 'close'; disposition: string; outcomeId: string }

export type IncidentEvent = StartEvent | PersonEvent | IndicatorEvent | DetentionEvent | CommandEvent | QuestionEvent
  | StatementEvent | MirandaEvent | ConsentEvent | FriskEvent | SearchEvent | SeizureEvent | TestEvent | ArrestEvent
  | ChargesEvent | ReleaseEvent | ForceEvent | OtherForceEvent | InterveneEvent | EntryEvent | ExigencyEvent
  | WarrantEvent | ServiceEvent | PursuitStartEvent | PursuitSampleEvent | PursuitEndEvent | AdvisoryEvent | CamEvent | CloseEvent;
export type IncidentEventKind = IncidentEvent['kind'];

/** The officer's filed report on an incident (statements of fact checked in the MDT). */
export interface ReportRecord { docId: string; assertions: string[]; sim: number; game: number }

export interface IncidentPerson { personId: number; role: string; label: string }

export interface IncidentLog {
  /** "C-00042" (call number) or "FC-<personId>-<epochDay>" (field contact) or "FI-<epochDay>-<n>" (ad hoc). */
  key: string;
  callId: number;
  typeId: string;
  family: string;
  /** District type name of the incident location ('' unknown). */
  district: string;
  openedSim: number;
  openedGame: number;
  closed: boolean;
  closedSim: number;   // -1 while open
  closedGame: number;  // -1 while open
  /** Ordered by `t`, then `id` (ids increase globally). */
  events: IncidentEvent[];
  people: IncidentPerson[];
  reports: ReportRecord[];
}
```

Event ordering invariant: `events` is sorted by `(t, id)`; `id`s are unique across all logs (one global counter,
saved). An event that "comes from" another (`sourceEvent`, `fromEvent`, `otherEvent`) always has a larger id.

### 4.4 Structural ports between same-wave modules (declared by the consumer; listed here so both sides match)

```ts
// force (wave 1) reads npc (hooks, wave 1) through:
export interface ForceNpcPort {
  actorIds(out: number[]): number[];
  actor(id: number, out: ActorInfo): ActorInfo | null;            // Phase 3 API (ActorInfo imported from src/npc/types)
  resistance(id: number): 'compliant' | 'passive' | 'active' | 'assaultive' | 'lethal';   // hooks §7.1
  incapacitate(id: number, seconds: number, by: 'oc' | 'strike' | 'baton' | 'beanbag' | 'k9' | 'taser' | 'shot'): boolean; // hooks
  wound(id: number, severity: number, fatal: boolean): void;      // hooks
  taserCycle(id: number, seconds: number): void;                  // hooks
}
// force reads / drives the scene (hooks) through:
export interface ForceScenePort {
  setWeapon(w: 'none' | 'sidearm' | 'taser'): void;               // hooks §7.4
  serviceArrived(callId: number, kind: string): boolean;          // hooks §7.4
}
// incidents (wave 2) reads conduct/court nothing; conduct and court (wave 2) read incidents through:
export interface IncidentSource {
  log(key: string): IncidentLog | null;
  assessment(key: string): LegalAssessment | null;
  reportChoices(key: string): readonly ReportChoice[];
}
```

## 5. Legal engine [legal] (`src/legal/**`, `src/data/legal/**`, `test/legal/**`) — pure, mandatory tests

Files: `types.ts` (§4.3 + rulesets + assessment types), `ruleset.ts` (parser, registry), `scores.ts` (indicator
book), `force.ts` (`forceVerdict`), `pursuit.ts`, `evaluate.ts` (`evaluateIncident`), `report.ts` (report
choices), `index.ts` (re-exports). No imports from other Phase 5 modules; may import `src/core/rng.ts`.

### 5.1 Ruleset format (`src/data/legal/rulesets/<id>.json`)

```ts
export interface RuleDef { id: string; doctrine: Doctrine; title: string; cite: string; text: string }
export interface IndicatorDef { label: string; offense: Offense; rs: number; pc: number; armed: number }
export interface OffenseDef { label: string; severity: number; arrestable: boolean; vehicleEvidence: boolean }
export interface Ruleset {
  version: 1;
  id: string;                        // file stem, e.g. "generic"
  name: string;                      // "Generic State (default)"
  description: string;
  rules: RuleDef[];                  // every *RuleId below must name one of these
  indicators: Record<string, IndicatorDef>;     // keys = INDICATORS (§5.2); all 26 required
  offenses: Record<Offense, OffenseDef>;        // all 9 required
  familyOffense: Record<string, Offense>;       // call family -> offense of its suspect role (missing family = none)
  statuteOffense: Record<string, Offense>;      // CAD statute id -> offense (all 47 statutes of statutes.json)
  thresholds: { rs: number; pc: number; armed: number };
  detention: { ruleId: string; attenuating: string[] };      // indicators that survive an unlawful detention (taint attenuation)
  frisk: { ruleId: string; scopeRuleId: string; plainFeel: boolean; plainFeelCategories: string[] };
  arrest: { ruleId: string; warrantRuleId: string };
  sita: { ruleId: string; vehicleRuleId: string; windowS: number; preArrestS: number; vehicle: 'broad' | 'gant' };
  automobile: { enabled: boolean; ruleId: string };
  consent: { ruleId: string; scopeRuleId: string; coercionRuleId: string; coercedByWeaponDrawn: boolean; maxAggressiveLines: number };
  exigency: { ruleId: string };
  entry: { ruleId: string };
  premises: { protectiveSweepRuleId: string; plainViewRuleId: string };
  test: { ruleId: string; impliedAfterArrest: boolean };
  miranda: { ruleId: string; invocationRuleId: string; custodyIncludesGunpoint: boolean; incriminatingFacts: string[]; responseWindowS: number };
  force: {
    ruleId: string; restrainedRuleId: string; lethalRuleId: string; displayRuleId: string;
    levels: Record<ForceLevel, number>;
    maxByResistance: Record<Resistance, number>;
    displayFirearmMin: Resistance;          // minimum resistance for pointing a firearm (event tool 'firearmDisplay')
    taser: { maxCycles: number; cycleRuleId: string; riskFactors: string[]; riskAllowedAt: Resistance; riskRuleId: string };
  };
  intervene: { ruleId: string; windowS: number; radiusM: number };
  pursuit: {
    ruleId: string; speedRuleId: string; terminateRuleId: string; equipmentRuleId: string;
    allowedOffenses: Offense[]; maxOverLimitMph: Record<string, number>;   // key 'default' required, others = district names
    maxOverS: number; wetFactor: number; nightFactor: number; requireLightsSiren: boolean;
    maxDurationS: number; terminateGraceS: number;
  };
  recording: { ruleId: string; muteRuleId: string; activationGraceS: number; requiredFor: string[]; dashCounts: string[] };
  evidence: { exclusionRuleId: string; fruitRuleId: string; inevitableDiscovery: boolean; inevitableRuleId: string };
}
```

`parseRuleset(raw: unknown, file: string): Ruleset` validates every field (types, ranges: weights ≥ 0, thresholds
> 0, `levels` contain all 10 levels with non-decreasing values in `FORCE_LEVELS` order **except** that
`hardHands` and `ocSpray` may be equal, every `*RuleId` exists in `rules`, every rule id unique, all 26
indicators, all 9 offenses, `maxByResistance` has all 5, `pursuit.maxOverLimitMph.default` present) and throws
`Error('<file>: <dotted.path>: <problem>')`.

Registry (`ruleset.ts`):
```ts
export const DEFAULT_RULESET_ID = 'generic';
/** Every ruleset file, sorted by path, keyed by id (= file stem; parse checks `id` equals the stem). */
export const RULESETS: ReadonlyMap<string, Ruleset>;
export function rulesetIds(): string[];                       // sorted
export function getRuleset(id: string): Ruleset;               // unknown id -> the default
export function ruleOf(rs: Ruleset, id: string): RuleDef;      // throws on unknown id
export function citation(rs: Ruleset, id: string): string;     // "GS-4.1 Gen. Crim. Proc. § 4.1 — Search incident to arrest"
```

### 5.2 Indicators (keys of `indicators`, all required in every ruleset)

| Indicator | Offense | generic rs / pc / armed | strict rs / pc / armed | Produced by (incidents §9.3) |
|---|---|---|---|---|
| `trafficViolation` | traffic | 1.0 / 2.0 / 0 | 1.0 / 2.0 / 0 | observed red light, rolling stop, tailgating |
| `speeding` | traffic | 1.0 / 2.0 / 0 | 1.0 / 2.0 / 0 | observed speeding |
| `weaving` | dui | 1.0 / 0.4 / 0 | 1.0 / 0.4 / 0 | observed weaving |
| `expiredRegistration` | traffic | 1.0 / 2.0 / 0 | 1.0 / 2.0 / 0 | plate hit |
| `licenseInvalid` | traffic | 0.5 / 2.0 / 0 | 0.5 / 2.0 / 0 | person hit (only counts for the driver) |
| `stolenVehicle` | felonyVehicle | 1.0 / 1.5 / 0.3 | 1.0 / 1.5 / 0.3 | plate hit |
| `stolenPlate` | felonyVehicle | 1.0 / 1.0 / 0 | 1.0 / 1.0 / 0 | plate hit |
| `plateMismatch` | felonyVehicle | 0.6 / 0.5 / 0 | 0.6 / 0.5 / 0 | plate hit |
| `ownerWarrant` | warrant | 0.6 / 0.0 / 0.2 | 0.4 / 0.0 / 0.2 | plate hit (RO WANTED) |
| `warrantHit` | warrant | 1.0 / 2.0 / 0.3 | 1.0 / 2.0 / 0.3 | person hit |
| `boloMatch` | property | 1.0 / 1.0 / 0.3 | 1.0 / 1.0 / 0.3 | plate / person hit |
| `odorAlcohol` | dui | 0.6 / 0.6 / 0 | 0.6 / 0.6 / 0 | contact fact |
| `admissionDrinking` | dui | 0.4 / 0.5 / 0 | 0.4 / 0.5 / 0 | statement |
| `sfstFail` | dui | 1.0 / 1.0 / 0 | 1.0 / 1.0 / 0 | test |
| `bacOver` | dui | 1.0 / 1.5 / 0 | 1.0 / 1.5 / 0 | test |
| `odorCannabis` | drugs | 0.6 / 1.0 / 0 | 0.3 / 0.0 / 0 | contact fact |
| `contrabandPlainView` | drugs | 1.0 / 2.0 / 0 | 1.0 / 2.0 / 0 | plain view (investigation, visual check) |
| `contrabandFound` | drugs | 1.0 / 2.0 / 0 | 1.0 / 2.0 / 0 | search / frisk fact |
| `weaponSeen` | weapons | 1.0 / 1.0 / 1.0 | 1.0 / 1.0 / 1.0 | brandish, plain-view weapon |
| `weaponFound` | weapons | 1.0 / 1.5 / 1.0 | 1.0 / 1.5 / 1.0 | frisk / search fact |
| `weaponCall` | weapons | 0.5 / 0.0 / 1.0 | 0.5 / 0.0 / 0.8 | dispatch said armed (suspect roles) |
| `callSuspect` | (family) `property` | 1.0 / 0.8 / 0 | 0.8 / 0.6 / 0 | person has a suspect role of the call |
| `victimInjury` | violent | 0.6 / 1.0 / 0 | 0.6 / 1.0 / 0 | victim says injured (statement) |
| `assaultOnOfficer` | violent | 2.0 / 2.0 / 1.0 | 2.0 / 2.0 / 1.0 | `npc:attack` fight / fire |
| `flight` | obstruction | 0.5 / 0.5 / 0 | 0.5 / 0.3 / 0 | `npc:fled` |
| `falseIdentity` | obstruction | 0.5 / 1.0 / 0 | 0.5 / 1.0 / 0 | contact flag `falseIdentity` |

`callSuspect`'s offense in the table is a fallback; the engine uses `familyOffense[log.family]` when present.

### 5.3 The two shipped rulesets

`generic.json` (id `generic`, rule prefix `GS-`) and `strict.json` (id `strict`, rule prefix `SS-`) contain the same
rule structure. Required differences (tests check each one):

| Field | generic | strict |
|---|---|---|
| `offenses.traffic.arrestable` | true | false |
| `detention.attenuating` | `["warrantHit"]` | `[]` |
| `frisk.plainFeel` | true (`["drugs"]`) | false |
| `sita.vehicle` | `broad` | `gant` |
| `sita.windowS` / `preArrestS` | 600 / 60 | 300 / 0 |
| `automobile.enabled` | true | true |
| `consent.coercedByWeaponDrawn` / `maxAggressiveLines` | true / 3 | true / 1 |
| `test.impliedAfterArrest` | true | false |
| `miranda.custodyIncludesGunpoint` | false | true |
| `force.maxByResistance` (compliant, passive, active, assaultive, lethal) | 2, 2, 4, 5, 6 | 2, 2, 3, 4, 6 |
| `force.displayFirearmMin` | `compliant` | `active` |
| `force.taser.maxCycles` / `riskAllowedAt` | 3 / `lethal` | 2 / `lethal` |
| `pursuit.allowedOffenses` | `violent felonyVehicle dui warrant weapons` | `violent weapons` |
| `pursuit.maxOverLimitMph` | default 40, downtown 25, suburbs 25, campus 20, hospital 20, park 20 | default 30, downtown 15, suburbs 15, campus 10, hospital 10, park 10 |
| `pursuit.maxOverS` / `maxDurationS` / `terminateGraceS` | 20 / 600 / 15 | 10 / 300 / 10 |
| `recording.activationGraceS` | 10 | 5 |
| `evidence.inevitableDiscovery` | true | false |
| indicators `odorCannabis`, `ownerWarrant`, `callSuspect`, `weaponCall`, `flight` | table §5.2 | table §5.2 |

Shared values: `thresholds { rs: 1.0, pc: 2.0, armed: 1.0 }`; `force.levels { presence 0, verbal 1, softHands 2,
hardHands 3, ocSpray 3, baton 4, taser 4, k9 4, lessLethal 5, firearm 6 }`; `force.taser.riskFactors ["elderly",
"pregnant", "elevated", "running", "restrained", "juvenile"]`; `intervene { windowS 5, radiusM 15 }`;
`pursuit.wetFactor 0.75`, `nightFactor 0.9`, `requireLightsSiren true`; `miranda.incriminatingFacts ["account",
"drinking", "drugs", "weapons", "vehicleContents", "suspectWhereabouts", "origin", "destination", "vehicleOwner"]`,
`responseWindowS 30`; `recording.requiredFor ["detention", "frisk", "search", "arrest", "force", "consent",
"question"]`, `dashCounts ["detention", "pursuitSample"]`; `familyOffense`: `trafficStop traffic, dui dui,
collision traffic, disturbance obstruction, domestic violent, crisis obstruction, property property, retail property,
trespass property, inProgress property, violent violent, weapons weapons, activeAssailant violent, barricade violent,
wanted warrant, vehicleWanted felonyVehicle, pursuit felonyVehicle, crowd obstruction, investigation property`;
`statuteOffense`: every `TR-*` → `traffic` except `TR-360 dui`, `TR-361 dui`, `TR-370 traffic`, `TR-371 violent`,
`TR-380 obstruction`; `PC-210 felonyVehicle`, `PC-211 felonyVehicle`, `PC-220 warrant`, `PC-221 obstruction`,
`PC-230 obstruction`, `PC-231 obstruction`, `PC-240 property`, `PC-250 property`, `PC-251 property`, `PC-252
violent`, `PC-253 property`, `PC-254 property`, `PC-255 property`, `PC-260 drugs`, `PC-261 drugs`, `PC-262 weapons`,
`PC-263 weapons`, `PC-270..274 violent`, `PC-280 obstruction`, `PC-281 dui`, `PC-282 violent`, `PC-283 violent`,
`PC-284 violent`, `PC-290 obstruction`, `PC-291 property`. Offense `severity`: traffic 1, obstruction 2, property 3,
dui 3, drugs 3, warrant 4, felonyVehicle 4, weapons 5, violent 6; `vehicleEvidence`: dui, drugs, weapons,
felonyVehicle, property true; others false; `arrestable` true for all but traffic (see table).

Rules (ids, doctrine; `cite` = "Gen. Crim. Proc. § x.y" for generic, "Model Strict Code § x.y" for strict; `title`
and one-sentence `text` written by the builder): `X-1.1 detention`, `X-2.1 frisk`, `X-2.2 friskScope`, `X-3.1
arrest`, `X-3.2 arrest (warrant)`, `X-4.1 search (incident to arrest)`, `X-4.2 search (vehicle incident to arrest)`,
`X-4.3 search (automobile exception)`, `X-5.1 consent`, `X-5.2 consent (scope)`, `X-5.3 consent (voluntariness)`,
`X-6.1 exigency`, `X-6.2 entry`, `X-6.3 search (protective sweep)`, `X-6.4 search (plain view)`, `X-7.1 miranda`,
`X-7.2 miranda (invocation)`, `X-7.3 test`, `X-8.1 force (continuum)`, `X-8.2 force (restrained)`, `X-8.3 force
(TASER cycles)`, `X-8.4 force (TASER risk)`, `X-8.5 force (lethal)`, `X-8.6 force (display)`, `X-9.1 intervene`,
`X-10.1 pursuit (initiation)`, `X-10.2 pursuit (termination)`, `X-10.3 pursuit (speed)`, `X-10.4 pursuit
(equipment)`, `X-11.1 recording`, `X-11.2 recording (muting)`, `X-12.1 evidence (exclusion)`, `X-12.2 evidence
(fruit)`, `X-12.3 evidence (inevitable discovery)` with `X` = `GS` / `SS`.

### 5.4 Assessment types

```ts
export type Outcome = 'lawful' | 'unlawful' | 'questionable';
export interface Determination {
  id: string;                 // "d1", "d2", … in creation order
  doctrine: Doctrine; eventId: number; personId: number; t: number;
  outcome: Outcome; ruleIds: string[]; reason: string;   // reason: one plain sentence for the UI
  basis: string | null;       // search basis that made it lawful ('consent', 'incidentToArrest', 'automobile', …)
  eventIds: number[];         // recording: every violating event; others: [eventId]
}
export interface EvidenceRuling {
  eventId: number; ref: string; label: string; personId: number;
  kind: 'item' | 'statement' | 'test';
  offense: Offense | null; admissible: boolean; ruleIds: string[];
  taintedBy: number;          // root event id of the taint, -1 when admissible
  reason: string;
}
export interface ForceRuling {
  eventId: number; personId: number; level: ForceLevel; tool: string; resistance: Resistance;
  maxAllowed: ForceLevel; verdict: 'justified' | 'questionable' | 'excessive'; factors: string[]; ruleIds: string[];
  other: boolean;             // a fellow officer's force (otherForce)
}
export interface PursuitRuling {
  startEventId: number; personId: number; offense: Offense | null; startAllowed: boolean; overLimitS: number;
  lightsSirenOk: boolean; advisoryIgnoredS: number; durationS: number; terminated: boolean;
  outcome: Outcome; ruleIds: string[]; reasons: string[];
}
export interface PersonAssessment {
  personId: number;
  detained: boolean; detentionLawful: boolean | null;        // null = never detained
  arrested: boolean; arrestLawful: boolean | null;
  arrestOffense: Offense | null;                             // best offense with PC at the first arrest
  pcAtArrest: Partial<Record<Offense, number>>;              // untainted pc per offense at the first arrest
  rsAtDetention: number;                                     // untainted rs sum at the first detention (0 if none)
  suppressedStatements: number;
}
export interface LegalAssessment {
  rulesetId: string; key: string;
  determinations: Determination[]; evidence: EvidenceRuling[]; force: ForceRuling[]; pursuits: PursuitRuling[];
  persons: PersonAssessment[];
  summary: { unlawful: number; questionable: number; suppressed: number; excessiveForce: number; questionableForce: number; score: number };
}
```

`summary.score` = clamp(round(100 − 15·unlawful(non-force, non-recording) − 8·recordingUnlawful − 10·questionable
− 10·questionableForce − 30·excessiveForce), 0, 100).

### 5.5 Indicator book (`scores.ts`)

```ts
export class IndicatorBook {
  constructor(rs: Ruleset);
  /** The call family (resolves `callSuspect`'s offense through `rs.familyOffense`). */
  setFamily(family: string): void;
  /** A person's role (`licenseInvalid` counts only for role `driver`). */
  setRole(personId: number, role: string): void;
  /** Records an indicator for `personId` (-1 = applies to every person of the incident). */
  add(personId: number, indicator: string, eventId: number, t: number, tainted: boolean): void;
  /** Sums over untainted entries with t <= `t` for the person plus personId -1 entries. */
  rs(personId: number, t: number): number;
  pc(personId: number, offense: Offense, t: number): number;
  armed(personId: number, t: number): number;
  /** Offense with the highest pc at `t` among those with pc >= thresholds.pc, filtered by `arrestable` when asked; null when none. */
  bestPc(personId: number, t: number, arrestableOnly: boolean): Offense | null;
  /** Highest-severity offense with any untainted indicator (pc > 0 or rs > 0) at `t`, null when none. */
  knownOffense(personId: number, t: number): Offense | null;
  has(personId: number, indicator: string, t: number): boolean;     // untainted only
}
```
`callSuspect`'s offense comes from `familyOffense[family]` (set via `book.setFamily(family)`). `licenseInvalid`
counts only for persons whose role is `driver` (the book is told roles through `setRole(personId, role)`).

### 5.6 Force verdict (`force.ts`)

```ts
export interface ForceInput { level: ForceLevel; tool: string; resistance: Resistance; cycle: number; riskFactors: readonly string[]; restrained: boolean }
export function resistanceRank(r: Resistance): number;   // index in RESISTANCE_LEVELS
export function forceVerdict(e: ForceInput, rs: Ruleset): { verdict: 'justified' | 'questionable' | 'excessive'; maxAllowed: ForceLevel; factors: string[]; ruleIds: string[] };
```
Algorithm (first matching block decides; `lvl = rs.force.levels[e.level]`, `max = rs.force.maxByResistance[e.resistance]`,
`maxAllowed` = the highest `FORCE_LEVELS` entry whose level value ≤ max):
1. `e.level === 'presence'`: if `e.tool === 'firearmDisplay'` and `resistanceRank(e.resistance) <
   resistanceRank(rs.force.displayFirearmMin)` → questionable `[displayRuleId]`, factor `display`; else justified `[ruleId]`.
2. `e.restrained && lvl > levels.softHands` → excessive `[restrainedRuleId]`, factor `restrained`.
3. `e.level === 'firearm' && e.resistance !== 'lethal'` → excessive `[lethalRuleId]`, factor `lethal`.
4. `e.level === 'taser'`: `e.cycle > taser.maxCycles` → excessive `[cycleRuleId]`, factor `cycles`; else if
   `risk = e.riskFactors ∩ taser.riskFactors` non-empty and `resistanceRank(e.resistance) <
   resistanceRank(taser.riskAllowedAt)` → excessive `[riskRuleId]`, factors = risk.
5. `lvl ≤ max` → justified `[ruleId]`; `lvl ≤ max + 1` → questionable `[ruleId]`; else excessive `[ruleId]`.

### 5.7 Pursuit (`pursuit.ts`)

```ts
export interface PursuitInput {
  start: PursuitStartEvent; samples: readonly PursuitSampleEvent[]; end: PursuitEndEvent | null;
  advisory: AdvisoryEvent | null; offense: Offense | null; nowT: number;   // nowT used when end is null
}
export function evaluatePursuit(p: PursuitInput, rs: Ruleset): PursuitRuling;
/** Live check for the recorder: the first policy problem so far (excluding the advisory rule), null when none. */
export function pursuitAdvisory(p: PursuitInput, rs: Ruleset): string | null;
export function allowedOverMph(rs: Ruleset, district: string, wet: boolean, night: boolean): number;
```
`evaluatePursuit` (vehicle pursuits only; foot pursuits get no ruling): `startAllowed = offense !== null &&
allowedOffenses.includes(offense)`; `overLimitS` = Σ over samples of `dt` (t − previous sample t, the first
sample counts 1 s) where `speedMph > limitMph + allowedOverMph(...)`; `lightsSirenOk` = !requireLightsSiren or every
sample has lights and siren; `endT = end?.t ?? nowT`; `durationS = endT − start.t`; `terminated = end?.reason ===
'terminated'`; `advisoryIgnoredS = advisory ? max(0, endT − advisory.t) : 0`. Reasons / rule ids:
!startAllowed → `ruleId` "Pursuit initiated for <offense label | an unknown offense>"; overLimitS > maxOverS →
`speedRuleId`; !lightsSirenOk → `equipmentRuleId`; advisoryIgnoredS > terminateGraceS → `terminateRuleId`;
durationS > maxDurationS && !terminated → `terminateRuleId`. `outcome` = unlawful when any reason else lawful.
`pursuitAdvisory` returns the first reason string of the same checks (without the advisory rule), or null.

### 5.8 `evaluateIncident(log: IncidentLog, rs: Ruleset): LegalAssessment`

Pure, single pass over `log.events` in order, ≤ 1 ms for 600 events, no randomness. State:
`taint: Map<eventId, rootEventId>`; per person: `detainedAt` (event id, -1), `detentionLawful`, `taintFrom`
(root id of an unlawful detention, -1), `arrests: {eventId, t, lawful, offense}[]`, `custodySince` (t, -1),
`miranda: 'none' | 'waived' | 'invoked' | 'misunderstood'`, `questions: QuestionEvent[]` with an `unwarned`
flag, `consents: ConsentEvent[]`, `taserCycles`; per building: `entryTaint` (root id, -1), `entryLawful`;
incident: `exigencyAt` (-1), `warrantSearch`, `warrantArrest`, pursuits; `book = new IndicatorBook(rs)`.
`isTainted(id)` = `taint.has(id)`; `taintOf(ids…)` = the first tainted dependency's root.

Helper `custodial(p, e)` = `p.custodySince >= 0 && e.t >= p.custodySince` or `(e as {custody?: boolean}).custody`
or (`rs.miranda.custodyIncludesGunpoint` and `e.gunpoint`). A `cuffed` detention or an `arrest` sets
`custodySince`; a `release` clears it.

Per event kind:

- `start`: `book.setFamily(e.family)`. `person`: `book.setRole(personId, role)`.
- `indicator`: tainted when `isTainted(e.sourceEvent)` (root = that root) or (person `taintFrom ≥ 0` and `e.source`
  ≠ `call` and `e.indicator ∉ rs.detention.attenuating`) (root = taintFrom). `book.add(...)` with the flag; when
  tainted also `taint.set(e.id, root)`.
- `detention`: only the first per person counts. `lawful = book.rs(p, t) ≥ thresholds.rs || book.bestPc(p, t,
  false) !== null`. Determination `detention` with `[detention.ruleId]` and reason ("Stop supported by: <indicator
  labels>" / "No reasonable suspicion: <n> of <threshold>"). Unlawful → `taint.set(e.id, e.id)`, person
  `taintFrom = e.id`. `how === 'cuffed'` also sets `custodySince`.
- `command`: no determination.
- `consent`: `coerced = (rs.consent.coercedByWeaponDrawn && e.weaponDrawn) || e.aggressiveLines >
  rs.consent.maxAggressiveLines`; stored with `effective = granted && valid && !coerced && !tainted(person taintFrom)`.
  A granted but invalid or coerced consent produces a `consent` determination unlawful (`[consent.ruleId]` or
  `[coercionRuleId]`); a granted effective one a lawful `consent` determination. Denied: none. When the person has
  `taintFrom ≥ 0` the consent is tainted (root = taintFrom; consent does not purge an unlawful stop).
- `frisk`: lawful when the person has an effective `searchPerson` consent earlier, or (`(detentionLawful ||
  lawful arrest earlier)` and `book.armed(p, t) ≥ thresholds.armed`), or a lawful arrest earlier (then it is a
  search incident to arrest: basis `incidentToArrest`). Determination `frisk` (`[frisk.ruleId]`, basis). Unlawful
  → taint e.id (root e.id, or the person's `taintFrom` when that exists). Each found item: weapons follow the frisk;
  non-weapons: when the frisk was a consent search or SITA they follow the frisk; otherwise admissible only when
  `rs.frisk.plainFeel && plainFeelCategories.includes(item.category)` — else a `friskScope` unlawful determination
  (`[scopeRuleId]`) and the item is tainted (root e.id). Record one `EvidenceRuling` per found item (kind `item`,
  offense from category: `weapon`→weapons, `drugs`/`paraphernalia`→drugs, `property`→property, else null).
- `search`: try bases in order, first passing wins (record which):
  1. `consent`: an effective consent earlier by the same person (or, for `premises`/`room`/`container`, by any person
     with that `buildingId`) whose kind covers the target: person→`searchPerson`; vehicle→`searchVehicle`;
     premises/container→`searchPremises`; room→`searchRoom` or `searchPremises`. A consent of another kind only →
     fails with `[scopeRuleId]` noted.
  2. `incidentToArrest`: a lawful arrest of the person with `0 ≤ t − arrest.t ≤ sita.windowS`, or (pre-arrest) a
     lawful arrest with `0 < arrest.t − t ≤ sita.preArrestS` and `book.bestPc(p, t, true) !== null`. Vehicle targets
     additionally need `sita.vehicle === 'broad'` or (`gant`: the person not in custody at t — i.e. not cuffed —
     or `offenses[arrest.offense].vehicleEvidence`) → `[sita.vehicleRuleId]`; persons `[sita.ruleId]`.
     Premises / room / container targets pass only when `claimedBasis === 'incidentToArrest'` and a lawful arrest of
     any person of the log lies within `windowS` before t → `[sita.ruleId]`.
  3. `automobile` (vehicle only, `automobile.enabled`): some offense with `vehicleEvidence` has `book.pc(p, o, t) ≥
     thresholds.pc` → `[automobile.ruleId]`.
  4. `exigency` (premises/room/container): an `exigency` event earlier → `[exigency.ruleId]`.
  5. `warrant`: a `warrant` event with scope `search` earlier → `[arrest.warrantRuleId]`.
  6. `protectiveSweep` (claimed, container/room): a lawful arrest in the same building earlier → `[premises.protectiveSweepRuleId]`.
  7. `plainView` / `publicArea` (claimed): the building's entry lawful (or `buildingId < 0`) → `[premises.plainViewRuleId]`.
  None → unlawful `search` determination `[exclusionRuleId]` reason "No lawful basis for the search of the
  <target>"; taint e.id. When a basis depends on a tainted event (an arrest or consent that is tainted) it does not
  pass. Inside a building whose `entryTaint ≥ 0` the search is tainted (root = entryTaint) even when lawful.
  Every found item gets an `EvidenceRuling` following the search's taint.
- `seizure`: an `EvidenceRuling` for the item if none exists yet for `ref` (follows `fromEvent`'s taint).
- `test`: lawful with an effective consent of that kind (`pbt`/`sfst`) earlier, or (`test.impliedAfterArrest` and a
  lawful arrest earlier). Determination `test` (`[test.ruleId]`); unlawful → taint e.id. `EvidenceRuling` kind `test`
  (offense `dui`). The recorder emits the indicator of a test **after** the test with `sourceEvent` = the test id.
- `arrest`: `warrant` = `book.has(p, 'warrantHit', t)` or a `warrant` event with scope `arrest`; else `offense =
  book.bestPc(p, t, true)`. Lawful when warrant or offense ≠ null → `[arrest.warrantRuleId]` / `[arrest.ruleId]`;
  unlawful → taint e.id, reason lists the best pc found ("Probable cause for dui: 1.2 of 2.0"). Sets
  `custodySince`. Records `pcAtArrest` (first arrest only). An arrest of a person with `taintFrom ≥ 0` is lawful
  only when its PC rests on attenuating / untainted indicators (the book already excludes tainted ones).
- `question`: `unwarned = custodial(p, e) && incriminatingFacts.includes(e.fact) && p.miranda !== 'waived'`; when
  `p.miranda === 'invoked'` and the fact is incriminating → `miranda` unlawful `[invocationRuleId]`; else when
  unwarned → `miranda` unlawful `[miranda.ruleId]`. Only one `miranda` determination per person per rule id (the
  first), the others are folded into its `eventIds`.
- `statement`: find the latest question of the person with `0 ≤ e.t − q.t ≤ responseWindowS` and the same fact,
  else any incriminating question in the window. When that question is unwarned or after invocation → the
  statement is tainted (root = the question id), `EvidenceRuling` kind `statement` inadmissible
  `[miranda.ruleId]`; else admissible. Non-incriminating facts (name, dob, address, identity) are always admissible
  (booking questions).
- `miranda`: `p.miranda = e.result` (a `misunderstood` result does not count as a waiver).
- `force`: `forceVerdict(e, rs)` → `ForceRuling` (`other: false`); questionable / excessive also push a `force`
  determination (`questionable` / `unlawful`). TASER `cycle` is taken from the event (the force system counts
  cycles per subject).
- `otherForce`: `forceVerdict` (`cycle 1`, no risk factors) → `ForceRuling` with `other: true`. When excessive and
  `e.distanceToOfficer ≤ intervene.radiusM`: look for an `intervene` event with `otherEvent === e.id` and `t − e.t ≤
  intervene.windowS` → `intervene` lawful (reason "Officer intervened"), else unlawful `[intervene.ruleId]` (one per
  episode: consecutive otherForce events of the same `officer` and person within 10 s share one determination).
- `entry`: lawful when `e.publicPlace`, or an effective `entry` consent with that `buildingId` earlier, or an
  exigency or search-warrant event earlier → `entry` determination; unlawful → taint e.id, building `entryTaint =
  e.id`. Only the first entry per building is judged.
- `exigency` / `warrant`: set the incident flags (no determination).
- `pursuitStart` / `pursuitSample` / `pursuitEnd` / `advisory`(terminatePursuit): collected per pursuit
  (`pursuitCallId` + personId); at the end of the pass each vehicle pursuit is evaluated with `evaluatePursuit`
  (`offense = book.knownOffense(personId, start.t)`, falling back to `familyOffense[log.family]` when the person's
  role is `suspect` or `driver`; `nowT` = the last event's t) → `PursuitRuling` + a `pursuit` determination.
- Recording (after the pass): for each event whose kind is in `recording.requiredFor` (`question` only when
  custodial; `force` only with level ≠ presence) and whose `t − t0 > activationGraceS` (`t0` = the incident's first
  event t of that person, or `log.openedSim`): ok when `(cam & CAM.body) && !(cam & CAM.muted)` or (`kind ∈
  dashCounts` and `cam & CAM.dash`). Violations form **one** `recording` determination (`[ruleId]`, `eventIds` all)
  and muted ones a second one `[muteRuleId]`. Vehicle `pursuitSample`s need `CAM.dash` or `CAM.body`.
- Inevitable discovery (after the pass, `evidence.inevitableDiscovery`): an inadmissible `item` ruling of a frisk /
  person search whose person has a lawful arrest **later** whose PC does not depend on that item (the book's PC at
  that arrest excludes the item's indicator because it is tainted) becomes admissible with
  `[inevitableRuleId]`, reason "Would have been found in a search incident to the later lawful arrest".
- Evidence rule ids: inadmissible rulings carry `[exclusionRuleId]` when `taintedBy === eventId` of their own
  event, else `[fruitRuleId, exclusionRuleId]` (fruit of an earlier illegality).

### 5.9 Report choices (`report.ts`, templates `src/data/legal/report.json`)

```ts
export interface ReportChoice {
  id: string;                 // stable, see below
  group: string | null;       // exclusive group (at most one may be asserted), null = independent
  text: string;               // first person, past tense
  personId: number;
  truth: 'true' | 'false' | 'unsupported';   // hidden from the UI
  key: boolean;               // a complete report must assert it
  eventId: number;            // the event it is about (-1 for distractors without one)
}
export function buildReportChoices(log: IncidentLog, assessment: LegalAssessment, rs: Ruleset, seed: number): ReportChoice[];
```
`report.json`: `{ "version": 1, "templates": { "<template id>": "<text with {person} {indicator} {tool} {level}
{target} {consent} {offense} {item} {officer}>" } }` with template ids `indicator action.frisk action.search
consent miranda resistance arrest pc seize intervene cam`. `{person}` = `log.people[].label`.

Construction (deterministic; sort persons by first appearance):
- `ind:<indicator>:<pid>` per distinct indicator of the person (truth `true`; key when the indicator's `pc > 0` or
  `armed > 0` and the person was arrested or frisked). Distractors: up to 2 indicators the person never had whose
  offense is one of the person's offenses (or the family offense), picked in order of
  `createRng(seed).stream('report:' + log.key)` shuffle of the sorted candidate list (truth `false`).
- `frisk:<eventId>` / `search:<eventId>` per frisk/search (true, key); one distractor action (frisk when no frisk
  happened, else a vehicle search when none) `frisk:x:<pid>` / `search:x:<pid>` (false).
- `consent:<kind>:<pid>` per granted consent (true, key when a search relied on it); one distractor consent kind
  never granted, preferring the kind of a search that did happen (false).
- `miranda:<pid>` "I advised {person} of their rights before questioning" when the person had a custodial
  incriminating question: truth true when waived/invoked before the first one, else false; key true.
- `res:<eventId>:<level>` for every non-presence force event, five choices in group `res:<eventId>` (true for the
  logged resistance, false otherwise; the true one is key).
- `arrest:<pid>` per arrested person (true, key); `pc:<pid>:<offense>` for the person's arrest offense and one other
  offense with indicators (truth `true` when `persons[].pcAtArrest[offense] ≥ thresholds.pc`, else `unsupported`;
  key when true and it is `arrestOffense`).
- `seize:<eventId>` per seizure (true, key).
- `intervene:<eventId>` per otherForce episode root: true when an intervene event exists (key), else false.
- `cam:full` "My body camera recorded the entire contact": true when the assessment has no `recording`
  determination, else false (key false).
Output order: by person, then id (stable for the UI).

### 5.10 Tests (`test/legal/**`) — mandatory, extensive

`test/legal/helpers.ts`: a `LogBuilder` (`new LogBuilder('C-00001', 'trafficStop')`, `.at(t)`, `.person(pid,
role)`, `.indicator(pid, ind, source?, sourceEvent?)`, `.detain(pid, how)`, `.consent(pid, kind, granted, valid,
opts)`, `.frisk(pid, items)`, `.search(pid, target, items, opts)`, `.arrest(pid)`, `.question(pid, fact,
custody)`, `.statement(pid, fact, value)`, `.miranda(pid, result)`, `.force(pid, level, resistance, opts)`,
`.other(pid, level, resistance, dist)`, `.intervene(otherId)`, `.entry(building, public)`, `.exigency()`,
`.pursuit(...)`, `.cam(body, muted, dash)`, `.build()` returning a valid `IncidentLog`; events get ids in call
order and the current cam bits). At least these cases (each asserts outcome and rule ids):
- **Ruleset**: both files parse; `rulesetIds()` = `['generic', 'strict']`; unknown id → default; each malformed
  field (missing indicator, bad level order, unknown rule id, duplicate rule id, negative weight) throws naming the
  path; every table difference of §5.3 holds.
- **Reasonable suspicion**: speeding then detention → lawful; no indicator → unlawful and later contraband found in
  a consent search suppressed (fruit `[fruitRuleId, exclusionRuleId]`); callSuspect + weaponCall → lawful;
  consensual contact (no detention) → no detention determination; a warrant hit after an unlawful stop: generic
  attenuated (arrest lawful, items of the SITA admissible), strict not.
- **Probable cause / arrest**: bacOver → lawful (dui); odorAlcohol alone → unlawful (0.6 < 2); odor + admission +
  sfstFail (2.1) → lawful; warrantHit → lawful `[X-3.2]`; a statement suppressed under Miranda does not count;
  speeding-only arrest: generic lawful, strict unlawful.
- **Terry**: weaponCall + lawful detention → frisk lawful; no armed indicators → unlawful; frisk with consent but
  no detention → lawful; frisk finds drugs: generic admissible (plain feel), strict suppressed with `friskScope`;
  frisk finds a weapon → admissible.
- **Search incident to arrest**: person search 100 s after a lawful arrest → lawful; 700 s after → unlawful
  (generic window 600); 30 s before a lawful arrest with PC → lawful generic, unlawful strict (`preArrestS` 0);
  vehicle search after a cuffed warrant arrest: generic (broad) lawful, strict (gant) unlawful; cuffed DUI arrest:
  gant lawful (vehicleEvidence); after an unlawful arrest → unlawful and its items are fruit.
- **Automobile exception**: contrabandPlainView then a vehicle search without consent or arrest → lawful, basis
  `automobile`; odorCannabis alone → unlawful under both (generic pc 1.0 < 2.0, strict 0); odorCannabis +
  weaponSeen → generic lawful only when some vehicleEvidence offense reaches 2.0 (assert weapons 1.0 → unlawful);
  `automobile.enabled false` in a test copy of the ruleset → unlawful.
- **Consent**: granted valid → lawful; denied then search → unlawful; person consent, vehicle searched → unlawful
  (scope); weapon drawn at consent → coerced → unlawful `[X-5.3]`; invalid (juvenile) → unlawful; consent after an
  unlawful detention → tainted, items suppressed.
- **Exigency / entry**: premises search with an exigency event → lawful; without → unlawful; entry without
  consent / exigency / warrant into a non-public building → unlawful and a plain-view indicator inside it is
  tainted; public place entry → lawful.
- **Miranda**: custodial `account` question without warning → statement suppressed; waived → admissible; invoked
  then questioned → `[X-7.2]` violation; non-custodial question → admissible; booking question (name) in custody →
  admissible; gunpoint questioning: generic not custodial, strict custodial.
- **Tests**: PBT without consent before arrest → unlawful, its bacOver indicator tainted; after a lawful arrest:
  generic lawful (implied), strict unlawful.
- **Force**: matrix over the 5 resistances × the 10 levels against the generic `maxByResistance` (justified ≤ max,
  questionable = max+1, excessive beyond); firearm vs assaultive → excessive `[X-8.5]`; TASER on active: generic
  justified, strict questionable; 4th TASER cycle generic → excessive, 3rd strict → excessive; TASER on an elderly
  active subject → excessive `[X-8.4]`; any strike on a restrained subject → excessive `[X-8.2]`; firearm display at
  a compliant subject: generic justified, strict questionable `[X-8.6]`.
- **Duty to intervene**: excessive otherForce at 5 m + intervene after 2 s → lawful; no intervene → unlawful; at
  30 m → no determination; justified otherForce → none.
- **Pursuit**: known stolenVehicle: generic start allowed, strict not; 25 s over the limit → speed violation
  (generic 20 s); lights off in a sample → equipment violation; advisory then 20 s more → terminate violation;
  ended `terminated` → lawful; wet + night allowance maths; `pursuitAdvisory` returns null until the first problem.
- **Recording**: search with the body cam off 30 s after the first contact → recording violation; within the grace
  → none; muted during force → mute violation; dash counts for the detention and pursuit samples only.
- **Evidence chain**: unlawful entry → plain view → seizure → all inadmissible with `taintedBy` = the entry;
  inevitable discovery generic admissible, strict not; independent lawful second search of the same item → the
  later ruling admissible.
- **Ruleset swap**: one fixed log evaluated with both rulesets gives at least 4 different determinations.
- **Report choices**: deterministic for a seed; contains every key fact; distractors are never true; each force
  event has exactly 5 grouped choices with one true; `pc` choice `unsupported` when below threshold.
- **Perf**: a 600-event log evaluates in < 2 ms average over 50 runs (generous for CI).

## 6. Use of force [force] (`src/force/**`, `src/data/force/**`, `test/force/**`)

### 6.1 Data (`src/data/force/force.json`, validator `parseForceConfig`)

```json
{ "version": 1,
  "tools": [
    { "id": "hands", "label": "Hands", "level": "hardHands", "armory": null, "rangeM": [0, 1.3], "coneDeg": 40, "hit": 0.85, "incapacitate": { "chance": 0.35, "seconds": 2 }, "injury": [0.03, 0.12] },
    { "id": "ocSpray", "label": "OC spray", "level": "ocSpray", "armory": "ocSpray", "rangeM": [0.8, 4], "coneDeg": 15, "hit": 0.9, "incapacitate": { "chance": 0.85, "seconds": 20 }, "injury": [0, 0.02], "uses": 10 },
    { "id": "baton", "label": "Baton", "level": "baton", "armory": "baton", "rangeM": [0, 1.8], "coneDeg": 35, "hit": 0.8, "incapacitate": { "chance": 0.5, "seconds": 4 }, "injury": [0.1, 0.35] },
    { "id": "taser", "label": "TASER", "level": "taser", "armory": "taser", "rangeM": [0, 7.6], "coneDeg": 12, "hit": 1, "incapacitate": { "chance": 1, "seconds": 5 }, "injury": [0.02, 0.06] },
    { "id": "lessLethal", "label": "Less-lethal launcher", "level": "lessLethal", "armory": "beanbag", "rangeM": [2, 30], "coneDeg": 10, "hit": 1, "incapacitate": { "chance": 0.8, "seconds": 6 }, "injury": [0.1, 0.3], "rounds": 5 },
    { "id": "firearm", "label": "Sidearm", "level": "firearm", "armory": "sidearm", "rangeM": [0, 50], "coneDeg": 8, "hit": 1, "incapacitate": { "chance": 1, "seconds": 60 }, "injury": [0.5, 0.9], "rounds": 15 },
    { "id": "k9", "label": "K9 apprehension", "level": "k9", "armory": null, "rangeM": [0, 40], "coneDeg": 60, "hit": 0.9, "incapacitate": { "chance": 1, "seconds": 15 }, "injury": [0.15, 0.4] }
  ],
  "taser": { "cartridges": 2, "spreadDeg": 8, "minSpreadM": 0.1, "torsoHalfWidthM": 0.22, "targetHeightM": 1.4, "sigmaDeg": 2.0,
             "movingPenalty": 0.6, "runningPenalty": 0.8, "clothingFail": 0.2, "coldC": 5, "nmiSuccess": 0.85, "painComply": 0.25,
             "cycleS": 5, "attachMaxS": 30, "reattachRangeM": 8.5 },
  "firearm": { "sigmaDeg": 1.2, "torsoHalfWidthM": 0.25, "zoneWeights": { "torso": 0.7, "limb": 0.25, "head": 0.05 },
               "injury": { "limb": [0.2, 0.4], "torso": [0.5, 0.9], "head": [0.9, 1.0] }, "fatal": { "limb": 0.02, "torso": 0.25, "head": 0.8 } },
  "lessLethal": { "sigmaDeg": 1.5, "torsoHalfWidthM": 0.25, "minSafeM": 6, "closeInjury": [0.4, 0.7] },
  "modifiers": { "officerMoving": 0.6, "targetRunning": 0.8, "crouched": -0.2 },
  "risk": { "elevatedRoomKinds": ["deck", "stairwell", "loading", "dock"], "pregnancyRate": 0.04, "pregnancyAge": [18, 42] },
  "fellow": { "chance": 0.25, "delayS": [2, 4], "repeatS": 2, "maxStrikes": 3, "injury": 0.05, "interveneRadiusM": 15 }
}
```

### 6.2 Pure models (`src/force/models.ts`, `src/force/math.ts`) — mandatory tests

```ts
/** Standard normal from exactly two `rng.next()` draws (Box-Muller, u1 clamped to >= 1e-12). */
export function gauss(rng: Rng): number;
export interface ShotContext { distance: number; officerMoving: boolean; officerCrouched: boolean; targetRunning: boolean }
export function sigmaDeg(base: number, c: ShotContext, mods: ForceConfig['modifiers']): number;   // base × (1 + moving·m + running·r + crouched·c), ≥ 0.2 × base
export interface TaserShotResult { inRange: boolean; probes: 0 | 1 | 2; spreadM: number; nmi: boolean; painOnly: boolean }
/** Always draws exactly 5 numbers: gauss (2), clothing per probe (2), nmi (1). */
export function taserShot(c: ShotContext & { cold: boolean }, cfg: ForceConfig['taser'], maxRangeM: number, rng: Rng): TaserShotResult;
export interface BallisticResult { hit: boolean; zone: 'miss' | 'limb' | 'torso' | 'head'; injury: number; fatal: boolean }
/** Always draws exactly 5 numbers: gauss (2), zone (1), injury (1), fatal (1). */
export function firearmShot(c: ShotContext, cfg: ForceConfig['firearm'], rng: Rng): BallisticResult;
/** Beanbag: like firearmShot with lessLethal sigma; zone head → injury from closeInjury; closer than minSafeM → closeInjury; never fatal unless head and distance < minSafeM (fatal chance 0.05). 5 draws. */
export function lessLethalShot(c: ShotContext, tool: ToolDef, cfg: ForceConfig['lessLethal'], rng: Rng): BallisticResult;
export interface MeleeResult { hit: boolean; incapacitated: boolean; injury: number }
/** hands / baton / ocSpray / k9: 3 draws (hit, incapacitate, injury). OC chance × 0.7 when the target is intoxicated or in crisis. */
export function meleeApply(tool: ToolDef, targetImpaired: boolean, rng: Rng): MeleeResult;
export function isPregnant(seed: number, personId: number, sex: string, age: number, cfg: ForceConfig['risk']): boolean; // unitHash(hash3(seed, personId, 0x50524547)) < rate, female, age in range
export function riskFactors(i: { elderly: boolean; juvenile: boolean; pregnant: boolean; elevated: boolean; running: boolean; restrained: boolean }): string[]; // in that order of names: elderly juvenile pregnant elevated running restrained
```
`taserShot`: `inRange = distance ≤ maxRangeM`; `err = gauss·σ` (degrees); `lateral = distance·tan(|err|)`; top
probe hits when inRange and `lateral ≤ torsoHalfWidthM`; `spreadM = distance·tan(spreadDeg)`; bottom probe hits when
the top hits and `spreadM ≤ targetHeightM`; when `cold` each hitting probe fails with `u < clothingFail`;
`nmi = probes === 2 && spreadM ≥ minSpreadM && u5 < nmiSuccess`; `painOnly = probes ≥ 1 && !nmi`. `firearmShot`:
`hit = lateral ≤ torsoHalfWidthM` (lateral as above with the firearm σ); zone from `zoneWeights` (cumulative over
`torso limb head`); injury uniform in the zone's range; `fatal = u < fatal[zone]`; a miss has injury 0.

Tests: draw counts fixed (rng state after a call equals state after N `next()`); taser hit rate at 3 m ≥ 0.9 and at
7 m lower than at 3 m (10 000 trials, seeded); spread < minSpread at 0.5 m → never nmi; beyond range → 0 probes;
cold weather lowers the nmi rate; firearm hit rate falls with distance and with movement; zone frequencies within
±3 % of the weights; pregnancy only for females in range, rate ≈ 4 % over 20 000 ids; `riskFactors` order.

### 6.3 Runtime (`src/force/forceSystem.ts`, `src/force/types.ts`, `src/force/events.ts`, `src/force/save.ts`)

```ts
export const FORCE_TOOLS = ['none', 'hands', 'ocSpray', 'baton', 'taser', 'lessLethal', 'firearm', 'k9'] as const;
export type ForceToolId = (typeof FORCE_TOOLS)[number];
export type ForceRequest =
  | { readonly kind: 'cycleTool' }                         // C: none → hands → ocSpray → baton → taser → lessLethal → firearm → k9 → none, skipping unavailable
  | { readonly kind: 'selectTool'; readonly tool: ForceToolId }
  | { readonly kind: 'apply'; readonly dirX: number; readonly dirZ: number }   // mouse 0 (camera forward on the ground plane)
  | { readonly kind: 'intervene' }                         // H
  | { readonly kind: 'fellowTest' };                       // console: start a fellow-officer episode on the nearest cuffed actor
export interface ForceOfficer { x: number; z: number; yaw: number; building: number; onFoot: boolean; moving: boolean; crouched: boolean; callId: number }
export interface FellowOfficer { name: string; x: number; z: number; building: number }
export interface ForceDeps {
  readonly seed: number;
  readonly bus: EventBus<EventMap>;
  readonly rng: Rng;                                       // session.rng.stream('force')
  readonly npc: ForceNpcPort;                              // §4.4
  readonly people: Pick<Population, 'identity' | 'state' | 'intoxication' | 'setInjured' | 'setDeceased'>;
  readonly scene: ForceScenePort;                          // §4.4
  armoryHas(item: string): boolean;                        // station ArmoryLog (sidearm, taser, ocSpray, baton, beanbag)
  temperatureC(): number;
  elevatedAt(building: number, x: number, z: number): boolean;
  fellows(): readonly FellowOfficer[];
  readonly config?: ForceConfig;
}
export interface ForceHud { tool: ForceToolId; label: string; ammo: string; attached: boolean; cycle: number; episode: string | null }
export class ForceSystem {
  constructor(deps: ForceDeps);
  get tool(): ForceToolId;
  get hud(): ForceHud;            // reused object, updated on change
  get revision(): number;
  request(r: ForceRequest): void;
  /** Fixed step (order -685). */
  step(dt: number, t: CadTime, officer: ForceOfficer): void;
  serialize(): ForceSave;
  restore(s: ForceSave): void;
  dispose(): void;
}
```
Behaviour (all inside `step`, requests drained first):
- **Availability**: `hands` always; `ocSpray`/`baton`/`taser`/`lessLethal`/`firearm` need `armoryHas(tool.armory)`
  and ammo (`taser` cartridges > 0 or probes attached; `lessLethal` rounds > 0; `firearm` rounds > 0; `ocSpray` uses
  > 0); `k9` needs `scene.serviceArrived(officer.callId, 'k9')`. Tools are usable only `onFoot`. After a change the
  system calls `scene.setWeapon(presence)` with `firearm → 'sidearm'`, `taser`/`lessLethal → 'taser'`, others
  `'none'`, emits `force:tool`, and when the firearm is drawn with a target actor within 15 m emits
  `force:applied` with level `presence`, tool `firearmDisplay` (no effect; the legal display rule).
- **Apply**: target = nearest visible actor (same building, not hidden, human body — never a dog, within the tool's
  `rangeM` and `coneDeg/2` of `(dirX, dirZ)`), using the same cone search as the scene's `findActor`. No target →
  flash "No target in range"; for `taser` (a cartridge), `lessLethal` and `firearm` (a round) the shot is still fired
  and the ammo used, but no `force:applied` is emitted (a `force:flash` "Missed" is).
  `resistance = npc.resistance(id)` **before** the effect. Per tool: `taser` → if probes are attached to this
  target (`attachMaxS`, distance ≤ `reattachRangeM`) a **new cycle** (no cartridge; `npc.taserCycle(id, cycleS)`),
  else a cartridge `taserShot` (`cold = temperatureC() < coldC`): nmi → `npc.taser`-like `incapacitate(id, cycleS +
  3, 'taser')` and attach; pain only → `incapacitate` with chance `painComply`; cycle counter per person
  (`Map<personId, number>`, reset 120 s after the last cycle). `firearm`/`lessLethal` → shot model; hit →
  `npc.wound(id, injury, fatal)` (`lessLethal` → `incapacitate(id, seconds, 'beanbag')` + injury);
  `people.setInjured(pid, max(old, injury))`; fatal → `people.setDeceased(pid)`. `hands`/`baton`/`ocSpray`/`k9` →
  `meleeApply`; incapacitated → `npc.incapacitate(id, seconds, by)`; injury as above. Every application emits
  `force:applied` (§6.4) and `force:flash` ("TASER: probes hit (2/2), cycle 1").
- **Risk factors** at application: `elderly`/`juvenile` from `people.identity(pid)`, `pregnant` via `isPregnant`,
  `elevated` via `elevatedAt`, `running` = actor state flee, `restrained` = actor cuffed.
- **Fellow officer** (4 Hz check): when `fellows()` is non-empty, for every actor of `officer.callId` that is cuffed,
  whose person was seen at resistance `assaultive`/`lethal` in a `force:applied` of this session (set
  `violentPersons`), within 3 m of a fellow, not yet rolled: one draw `u < fellow.chance` → episode (strike after
  `delayS`, then every `repeatS`, up to `maxStrikes`): each strike emits `force:other` (level `hardHands`,
  resistance `npc.resistance(id)`, `restrained` true, `distanceToOfficer`), `setInjured(+fellow.injury)`, and a flash
  "<name> is striking the restrained subject — press H to intervene". `intervene` request: with an active
  episode and the officer within `interveneRadiusM` → the episode ends, `force:intervened` emitted, flash "You
  intervened"; without an episode → flash "Nothing to intervene in". `fellowTest` starts an episode at once on the
  nearest cuffed actor within 10 m (console / smoke).
- **Ammo**: full at a new shift (`defaultForceSave`); a tool's ammo refills to full when `armoryHas(item)` goes
  false → true (signed in and out again at the armory; the system keeps last step's values in `armorySeen`).

### 6.4 Events (`src/force/events.ts`, declaration merging)

```ts
export interface ForceAppliedEvent {
  seq: number; tool: string; level: string; personId: number; actorId: number; callId: number;
  resistance: string; hit: boolean; injury: number; fatal: boolean; cycle: number; riskFactors: string[];
  distance: number; restrained: boolean; sim: number;
}
export interface ForceOtherEvent { seq: number; officer: string; level: string; personId: number; actorId: number; callId: number; resistance: string; restrained: boolean; distanceToOfficer: number; injury: number; sim: number }
export interface ForceIntervenedEvent { otherSeq: number; personId: number; callId: number; sim: number }
export interface ForceToolEvent { tool: string }
export interface ForceFlashEvent { text: string }
// 'force:applied' | 'force:other' | 'force:intervened' | 'force:tool' | 'force:flash'
```
`level`/`resistance` are typed as `string` here (the force module re-declares the unions locally for its own code;
the recorder narrows them with its validator).

### 6.5 Save

```ts
export interface ForceSave {
  version: 1; rng: RngState; tool: string; seq: number;
  cartridges: number; rounds: { firearm: number; lessLethal: number; ocSpray: number };
  attached: { personId: number; actorId: number; sinceSim: number } | null;
  cycles: [number, number, number][];        // personId, count, last sim
  violent: number[];                          // person ids seen assaultive/lethal
  rolled: number[];                           // person ids already rolled for a fellow episode
  episode: { personId: number; actorId: number; callId: number; officer: string; nextSim: number; strikes: number; firstSeq: number } | null;
  armorySeen: string[];                       // tools whose armory item was signed out last step
  queue: ForceRequest[];
}
export function defaultForceSave(rng: RngState): ForceSave;   // tool none, full ammo from force.json, empty
export function isForceSave(x: unknown): x is ForceSave;
```

### 6.6 Tests (`test/force/**`)

Pure models (§6.2); `ForceSystem` with fake ports: cycle skips unavailable tools and calls `setWeapon`
correctly; apply picks the nearest target in the cone; TASER cartridge count decreases, re-cycle on the attached
target does not use one and increments `cycle`; resistance recorded before the effect; risk factors in the event;
firearm display event emitted once per draw with a target; fellow episode: strikes every `repeatS`, intervene within
radius ends it and emits `force:intervened`, out of radius refused; serialize/restore round trip continues the same
draws; no allocation per `step` without requests (perf test: 10 000 steps < 20 ms).

## 7. Gameplay hooks [hooks] (`src/npc/**`, `src/contact/**`, `src/dialogue/**`, `src/scene/**`, `src/calls/**`, `src/dispatch/generator.ts`, `src/dispatch/dispatcher.ts`, their data and tests)

Additions only; every Phase 3-4 test stays green (existing replay tests must not change their RNG draws unless the
new feature is exercised: every new draw below happens only in the new code path).

### 7.1 npc (`src/npc/npcSystem.ts`, `src/npc/types.ts`, `src/npc/save.ts`)

```ts
export const LETHAL_WEAPONS = ['handgun', 'rifle', 'shotgun', 'knife'] as const;
export type ResistanceLevel = 'compliant' | 'passive' | 'active' | 'assaultive' | 'lethal';
// ActorInfo gains (always written by actor()):
resistance?: ResistanceLevel;
// NpcSystem gains:
resistance(id: number): ResistanceLevel;                       // §4.2; 'compliant' for unknown ids
incapacitate(id: number, seconds: number, by: 'oc' | 'strike' | 'baton' | 'beanbag' | 'k9' | 'taser' | 'shot'): boolean;
wound(id: number, severity: number, fatal: boolean): void;
taserCycle(id: number, seconds: number): void;
```
- The system keeps a step clock `simT` (accumulated `dt`) and per actor `refusedAt`, `resistedAt`, `attackedAt`,
  `attackKind` (−1e9 = never). `applyCommand` with outcome `refuse`/`confused` sets `refusedAt`; `cuff` returning
  `'resist'` sets `resistedAt`; `noteAttack` sets `attackedAt`/`attackKind`.
- `incapacitate`: like `takeDown` (drop a drawn weapon, state `down`, timer `seconds`), emits `npc:caught` with `by:
  'force'` (extend the `NpcCaughtEvent.by` union with `'force'`); false for hidden / dog / untackleable states
  except that `oc`, `taser`, `shot` also work on `armed` actors.
- `wound`: `fatal` → state `lying` permanently (flag `dead`, never wakes, not tackleable, `resistance` compliant),
  weapon dropped; `severity ≥ 0.5` → `down` for 60 s then `kneel`; else `incapacitate(id, 3, 'shot')`.
- `taserCycle`: when the actor is `down`, sets `timer = max(timer, seconds)`; else `incapacitate(id, seconds, 'taser')`.
- Save: `ActorSave` optional `ra?`, `rs?`, `at?` (ages in s), `ak?` (attack kind 0 fight 1 fire 2 brandish) and
  flag bit `dead` (pick the next free bit, document it in the type comment); old saves read as never.
- Tests: resistance table (each row), timers expire (passive after 15 s), incapacitate / wound / taserCycle effects,
  save round trip of the new fields, old `ActorSave` without them loads.

### 7.2 dialogue (`src/dialogue/**`, `src/data/dialogue/**`)

- `src/data/dialogue/miranda.json`: `{ "version": 1, "waiveBase": 0.6, "priorPenalty": 0.08, "intoxBonus": 0.15,
  "stressPenalty": 0.2, "hostilePenalty": 0.25 }` + parser. Responses (`responses.json`): `miranda.waive` ("Yeah, I
  understand. I'll talk."), `miranda.invoke` ("I want a lawyer. I'm not saying anything."), `miranda.confused` ("I
  don't understand."), `miranda.silent` ("I already said I want a lawyer."), with a few variants each.
- `SubjectMemory.miranda?: 'waived' | 'invoked' | 'misunderstood'` (optional for old saves); `DialogueResult.miranda?:
  'waived' | 'invoked' | 'misunderstood'`. `MIRANDA_RESULTS` exported.
- `respond` case `miranda`: when not understood (language barrier without interpreter / app, deaf without notes:
  the existing `understood` logic) → `misunderstood`, line `miranda.confused`; else one draw `u <
  clamp(waiveBase − priorPenalty·priors − stressPenalty·stress + intoxBonus·intoxLevel − (demeanor hostile ?
  hostilePenalty : 0), 0.05, 0.95)` → `waived` (line `miranda.waive`) else `invoked` (`miranda.invoke`).
  `mem.mirandized = true`; `mem.miranda = result`. `priors` = the person record's prior count (`subject.identity.record`
  priors length; 0 when absent).
- After `invoked`: an `ask` utterance whose fact is in `INCRIMINATING_FACTS` (`account drinking drugs weapons
  vehicleContents suspectWhereabouts origin destination vehicleOwner`, exported) answers `miranda.silent` with no
  statement and no draw.
- The `miranda` topic label in `utterances.json` becomes "Rights".
- Tests: waiver rates by profile (seeded), invocation silences incriminating questions but not `askName`, confused
  without interpreter, memory field round trip, existing dialogue tests unchanged.

### 7.3 contact (`src/contact/**`)

New topics (declare in `src/contact/events.ts`):
```ts
export interface ContactFactEvent { incident: string; callId: number; personId: number; role: string; topic: string; value: string; source: string; display: string; detail: string; sim: number }
export interface ContactSaidEvent {
  incident: string; callId: number; personId: number; role: string;
  utteranceId: string; intent: string; topic: string; fact: string | null; consent: string | null; command: string | null;
  tone: string; outcome: string | null;     // commands: 'comply' | 'refuse' | 'flee' | 'fight' | 'confused'; else null
  custody: boolean;                          // the subject's actor is cuffed or the person is caged / arrested
  gunpoint: boolean;                         // presence().weapon === 'sidearm'
  sim: number;
}
export interface ContactActionEvent {
  incident: string; callId: number; personId: number; role: string;
  action: string;                            // CONTACT_ACTIONS id, or 'sfstResult'
  ok: boolean;
  items: { ref: string; item: string; label: string; category: string; weapon: boolean; incriminating: boolean }[];
  vehicleId: number;
  result: string | null;                     // pbt: 'over' | 'under'; sfstResult: 'fail' | 'pass'; cuff: 'ok' | 'resist' | 'notReady'
  custody: boolean;
  sim: number;
}
export interface ContactMirandaEvent { incident: string; callId: number; personId: number; result: 'waived' | 'invoked' | 'misunderstood'; custody: boolean; sim: number }
// 'contact:fact' | 'contact:said' | 'contact:action' | 'contact:miranda'
```
- `contact:fact` is emitted from `storeFact` for every new fact (after storing).
- `contact:said` for every officer utterance applied (before the answer is scheduled); commands carry the
  evaluated outcome.
- `contact:action` after every field action resolves (frisk, searchPerson, searchVehicle, visualCheck (items =
  seen items, `ok` true), pbt (`result`), sfst start (`ok`), `sfstResult` when the SFST finishes (`result`), cuff
  (`result`), uncuff, escort, release, warnRelease, writeCitation, seize (items = seized), checkId, runName, runId,
  runPlate, checkVin, notifyGuardian). `items[].incriminating` = item category in `drugs paraphernalia weapon
  evidence` or `itemDef.stolen === true` (whatever flag exists; else category rule only).
- `contact:miranda` when a `miranda` answer is applied (with `result.miranda`).
- Tests: each topic emitted once per action with the documented payloads; ordering: `contact:said` before the
  answer's `contact:fact`; `custody` true after cuffing.

### 7.4 scene and calls (`src/scene/**`, `src/calls/**`)

```ts
// SceneDirector gains:
setWeapon(w: OfficerWeapon): void;     // like cycleWeapon's tail: sets weapon + presence + rev; emits force:used sidearmDrawn / taserDrawn for the nearest actor within forceNearM (as cycleWeapon does); 'none' emits nothing
serviceArrived(callId: number, kind: string): boolean;
// SceneRequest gains:  | { readonly kind: 'terminatePursuit' }
// SceneDeps gains (all optional; absent = Phase 4 behaviour):
trustAt?(x: number, z: number): number;          // replaces trustOf(district) in the shout dialogue context
errorScaleAt?(x: number, z: number): number;     // multiplies the scenario dispatch-error rates (tips quality)
hostilityAt?(x: number, z: number): number;      // chance of hostile onlookers on an arrest / force (0..1)
```
- New topic `scene:command` (`src/scene/events.ts`): `{ callId: number; personId: number; actorId: number; command:
  string; outcome: string; sim: number }`, emitted by `shout()` after `applyCommand`.
- `ScenePursuitEvent` gains optional `ownerCallId?: number` (the call whose stop / scene the pursuit came from, 0
  none), `personId?: number` (the pursued driver / runner, -1 unknown) and `endReason?: string` on `active: false`
  (`escaped crashed stopped gaveUp caught terminated` — the traffic flee reasons, `caught` for a tackled runner).
- `terminatePursuit`: ends the active **vehicle** pursuit: removes it from `pursuits`, flags `pursuitTerminated`,
  `escaped:driver`, emits `scene:pursuit` inactive with `endReason: 'terminated'`, radio "<cs>, terminating the
  pursuit." (the fleeing traffic car keeps fleeing and despawns as `escaped`; `onFleeEnded` then finds no pursuit).
- `calls/scenario.ts`: `ScenarioInput.errorScale?: number` (default 1) multiplies `cfg.dispatchErrors.wrongAddress`,
  `wrongDescription` and `missingWeapon` before the existing comparisons (same draws). The scene passes
  `errorScaleAt(anchor)` when given.
- Hostile onlookers: on `custody:<role>` flag set or a `force:used`/`force:applied` against an actor of an outdoor
  materialized call, once per call: when `hostilityAt` is given and `rng.next() < hostilityAt(x, z)` (the draw only
  happens when the dep is given), spawn 2-4 (`2 + floor(u·3)`) actors with profile `protester`, role `onlooker`,
  `callId` of the call, 8-14 m from the officer on the sidewalk side, and emit two `scene:line`s ("Leave him alone!",
  "I'm filming this!"). They count as crowd actors (existing `crowd` state).
- Tests: setWeapon emits like cycleWeapon; serviceArrived; terminatePursuit; command topic; pursuit payload fields;
  errorScale 0 → no dispatch errors, 3 → more (seeded counts over 400 scenarios); onlookers only with the dep.

### 7.5 dispatch (`src/dispatch/generator.ts`, `src/dispatch/dispatcher.ts`)

`CallGenerator.setCrimeFactor(fn: ((district: string) => number) | null): void` — `multiplier()` multiplies its
result by `fn(district)` before the existing clamp; `Dispatcher.setCrimeFactor(fn)` forwards to its generator.
Test: factor 2 doubles the unclamped multiplier; null restores.

## 8. Recording media and review [recording] (`src/recording/**`, `src/ui/review/**`, `src/data/recording/**`, `test/recording/**`, `test/review/**`)

### 8.1 Data (`src/data/recording/recording.json`)

`{ "version": 1, "width": 160, "height": 90, "quality": 0.5, "intervalS": 3, "perIncidentMax": 200, "maxCount": 3000,
"maxBytes": 16777216, "dashRangeM": 30 }`.

### 8.2 Media store (`src/recording/mediaStore.ts`)

```ts
export interface SnapshotMeta { key: string; tag: string; incident: string; source: 'body' | 'dash'; sim: number; game: number; bytes: number; w: number; h: number }
export interface RetentionPolicy { maxCount: number; maxBytes: number; perIncidentMax: number }
export interface MediaStore {
  put(meta: Omit<SnapshotMeta, 'key' | 'bytes'>, blob: Blob): Promise<SnapshotMeta>;   // key = `${tag}:${incident}:${sim.toFixed(2)}:${source}`
  list(tag: string, incident: string): Promise<SnapshotMeta[]>;                        // sorted by sim
  get(key: string): Promise<Blob | null>;
  /** Deletes incidents of `tag` not in `keep` (when given), then oldest-first until within the caps; returns deleted count. */
  prune(policy: RetentionPolicy, tag: string, keep?: ReadonlySet<string>): Promise<number>;
  stats(): Promise<{ count: number; bytes: number }>;
  clear(): Promise<void>;
}
export class MemoryMediaStore implements MediaStore { /* Map-based */ }
export class IdbMediaStore implements MediaStore {
  /** DB 'patrol-media' version 1, store 'snapshots' (keyPath 'key'), indexes 'incident' ([tag, incident]) and 'sim'. Values { ...meta, blob }. */
  constructor(factory?: IDBFactory);
}
export function createMediaStore(): MediaStore;   // IdbMediaStore when indexedDB exists, else MemoryMediaStore; IDB open failure → memory (logged)
```
`put` enforces `perIncidentMax`: when the incident already holds that many snapshots, the oldest one of that
incident is deleted first. Uses `openDb` / `requestToPromise` from `src/save/db.ts` (pre-existing exports).

### 8.3 Capture (`src/recording/capture.ts`)

```ts
export class SnapshotScheduler {
  constructor(cfg?: RecordingConfig);
  /** True when a snapshot is due: recording (body bit and not muted, or dash) and sim − last ≥ intervalS, or an immediate request is pending. */
  due(sim: number, cam: number, incident: string): boolean;
  /** Marks a capture taken (resets the timer, clears the immediate flag). */
  taken(sim: number, incident: string): void;
  /** Asks for a capture on the next frame (force applied, arrest). */
  immediate(): void;
}
/** Draws `canvas` centre-cropped to 16:9 into a reused w×h 2D canvas synchronously (must run right after renderer.render() in the same task), then encodes with toBlob('image/jpeg', quality). Resolves null on failure or without a DOM. */
export function captureSnapshot(canvas: HTMLCanvasElement, w: number, h: number, quality: number): Promise<Blob | null>;
```

### 8.4 Review timeline (`src/recording/timeline.ts`, pure) and panel (`src/ui/review/reviewPanel.ts`, `review.css`, prefix `rev-`)

```ts
export interface ReviewEvent { id: number; t: number; label: string; kind: string; severity: 'info' | 'warn' | 'bad'; cam: number }
export interface ReviewSource {
  title: string; t0: number; t1: number; events: readonly ReviewEvent[];
  snapshots(): Promise<readonly SnapshotMeta[]>;
  image(key: string): Promise<Blob | null>;
}
export interface ReviewFooter { lines(): readonly string[]; options(): readonly string[]; pick(index: number): void }
export interface CamSegment { t0: number; t1: number; state: 'rec' | 'muted' | 'off' | 'dash' }
export function camSegments(events: readonly ReviewEvent[], t0: number, t1: number): CamSegment[];  // from consecutive cam bits
export function nearestSnapshot(snaps: readonly SnapshotMeta[], t: number): number;             // index of the last snapshot with sim ≤ t (binary search), -1 none
export function eventIndexAt(events: readonly ReviewEvent[], t: number): number;                // last event with t ≤ t
export interface ReviewState { t: number; playing: boolean; focus: number }
export function reduceReviewKey(s: ReviewState, key: string, src: { t0: number; t1: number; events: readonly ReviewEvent[] }): { state: ReviewState; emit: 'close' | { pick: number } | null; consumed: boolean };
// ←/→ −/+ 1 s (Shift ×10), ↑/↓ previous / next event (t jumps to it), Space play/pause, Home/End, digits 1-9 → pick footer option, Escape close.
export class EvidenceReviewPanel implements Menu {
  readonly id = 'review'; readonly pausesGame = true;
  constructor(ui: UIRoot | null);
  open(src: ReviewSource, footer?: ReviewFooter): void;
  close(): void;
  get isOpen(): boolean;
  get time(): number;
  /** Per frame while open: playback (1 sim s per 250 ms real), image swap when the nearest snapshot changes (object URLs revoked). */
  update(nowMs: number): void;
}
```
Layout: title; image (160×90 scaled ×3, "NO VIDEO" placeholder when none); a range input scrubber with the camera
strip (`rec` red, `muted` amber, `off` grey, `dash` blue) under it; the event list (time mm:ss, label, severity
colour) with the current event highlighted; footer lines + numbered options. Tests (node): reducer, `camSegments`,
`nearestSnapshot`, `MemoryMediaStore` and `IdbMediaStore` (fake-indexeddb) put/list/get/prune caps/keep set,
scheduler timing; the panel constructs headless.

## 9. Incident recorder [incidents] (`src/incidents/**`, `src/data/incidents/**`, `test/incidents/**`) — wave 2

### 9.1 API (`src/incidents/incidentSystem.ts`, `types.ts`, `events.ts`, `save.ts`, `mapping.ts`)

```ts
export interface IncidentPorts {
  /** Call facts at materialize / stop time. */
  callInfo(callId: number): { typeId: string; family: string; exigency: boolean; warrant: boolean; suspects: readonly number[]; weaponReported: boolean; district: string } | null;
  personLabel(personId: number): string;                    // what the officer knows: claimed name, else "Male, about 30"
  personRole(personId: number, callId: number): string;     // scene / contact role, '' unknown
  stopDriver(): { personId: number; vehicleId: number; callId: number } | null;   // active traffic stop
  observedViolations(vehicleId: number): Readonly<Partial<Record<string, number>>>;
  itemInfo(itemId: string): (FoundItem & { ownerPersonId: number; buildingId: number }) | null;   // investigation items
  booking(docId: string): { personId: number; callId: number; charges: string[] } | null;         // CAD booking document
  buildingIncident(buildingId: number): number;             // callId of the open call bound to the building, 0 none
  publicPlace(buildingId: number): boolean;                 // store / bar / bank / hospital / school lobby during open hours, station
  officer(out: { x: number; z: number; building: number; inVehicle: boolean; weapon: 'none' | 'sidearm' | 'taser' }): void;
  bodycamWorn(): boolean;
  dashcam(out: { lights: boolean; nearCar: boolean }): void;   // light bar of the last-driven patrol car, officer within dashRangeM or inside
  pursuitProbe(out: { speedMph: number; limitMph: number; district: string; wet: boolean; night: boolean; lights: boolean; siren: boolean }): boolean;   // false when not driving
  activeContactIncident(): string | null;
}
export type IncidentRequest =
  | { readonly kind: 'mute'; readonly on: boolean }
  | { readonly kind: 'dashManual'; readonly on: boolean }
  | { readonly kind: 'report'; readonly key: string; readonly docId: string; readonly assertions: readonly string[] }
  | { readonly kind: 'jurisdiction'; readonly id: string }
  | { readonly kind: 'close'; readonly key: string };      // console / tests
export interface IncidentDeps { readonly bus: EventBus<EventMap>; readonly ports: IncidentPorts; readonly seed: number; readonly mapping?: IncidentMapping }
export class IncidentSystem implements IncidentSource {
  constructor(deps: IncidentDeps);
  get ruleset(): Ruleset;
  get revision(): number;
  get cam(): { body: boolean; muted: boolean; dash: boolean; bits: number };
  /** The incident the officer is working (the active contact's, else the player's call, else the last active within 120 s), '' none. */
  get current(): string;
  request(r: IncidentRequest): void;
  /** Fixed step (order -660). */
  step(dt: number, t: CadTime): void;
  keys(): string[];                                          // open first, then closed newest first
  log(key: string): IncidentLog | null;
  assessment(key: string): LegalAssessment | null;           // cached; computed on demand (pure) for open logs too
  reportChoices(key: string): readonly ReportChoice[];       // buildReportChoices(log, assessment, ruleset, seed), cached per events length
  keyOfCall(callId: number): string;                         // callNumber(callId) (cad export)
  /** Keeps closed incidents referenced elsewhere (court cases, IA cases); called by the integrator once per game minute. */
  retain(keep: ReadonlySet<string>, game: number): void;
  serialize(): IncidentsSave;
  restore(s: IncidentsSave): void;
  dispose(): void;                                           // unsubscribes
}
```
Events (`src/incidents/events.ts`): `incident:opened { key }`, `incident:closed { key, callId, score: number,
unlawful: number, excessiveForce: number }`, `incident:forceVerdict { key, eventId, verdict, text }`,
`incident:advisory { key, advisory, text }`, `incident:report { key, docId }`, `incident:flash { text }`.

### 9.2 Keys, people, cam bits

- Key of a callId > 0 = `callNumber(callId)`; an event with an `incident` string uses it; else the `current`
  incident; else a new `FI-<epochDay>-<n>` ad-hoc log. An `FC-…` incident that later arrives with a callId (the
  contact attached a call) is **merged**: the FC log's events move into the call log (keeping ids; merge sorted by
  `(t, id)`), an alias `FC-… → C-…` is stored and later FC events go to the call log.
- First event of a person in a log appends `people[]` (`personLabel`, `personRole`) and a `person` event.
- Every appended event gets `cam` = current bits: `body` (from `investigation:bodycam` on/off), `muted` (request),
  `dash` (`dashcam()`: (lights or manual) and nearCar). Cam bit changes append a `cam` event to every **open** log
  that had an event in the last 120 s.

### 9.3 Mapping (bus → events; data `src/data/incidents/mapping.json` + parser in `mapping.ts`)

```json
{ "version": 1,
  "plateHits": [ { "prefix": "STOLEN VEHICLE", "indicator": "stolenVehicle" }, { "prefix": "PLATES REPORTED STOLEN", "indicator": "stolenPlate" },
                 { "prefix": "DESCRIPTION MISMATCH", "indicator": "plateMismatch" }, { "prefix": "REGISTRATION EXPIRED", "indicator": "expiredRegistration" },
                 { "prefix": "BOLO", "indicator": "boloMatch" }, { "prefix": "RO WANTED", "indicator": "ownerWarrant" } ],
  "personHits": [ { "prefix": "WARRANT", "indicator": "warrantHit" }, { "prefix": "BOLO", "indicator": "boloMatch" },
                  { "prefix": "LICENSE", "indicator": "licenseInvalid" }, { "prefix": "NO LICENSE", "indicator": "licenseInvalid" } ],
  "violations": { "speeding": "speeding", "redLight": "trafficViolation", "rollingStop": "trafficViolation", "tailgating": "trafficViolation", "weaving": "weaving" },
  "facts": [
    { "topic": "drinking", "source": "evidence", "detail": "odor of alcohol", "indicator": "odorAlcohol" },
    { "topic": "drugs", "source": "evidence", "detail": "odor of cannabis", "indicator": "odorCannabis" },
    { "topic": "drinking", "source": "evidence", "displayPrefix": "Breath test", "valueIn": ["heavy"], "indicator": "bacOver", "test": "pbt" },
    { "topic": "drinking", "source": "evidence", "displayPrefix": "Failed sobriety", "indicator": "sfstFail", "test": "sfst" },
    { "topic": "weapons", "source": "evidence", "indicator": "weaponFound" },
    { "topic": "drugs", "source": "evidence", "displayPrefix": "Found", "indicator": "contrabandFound" },
    { "topic": "drinking", "source": "claim", "valueIn": ["yes", "heavy"], "indicator": "admissionDrinking" },
    { "topic": "injured", "source": "claim", "valueIn": ["yes"], "roles": ["victim"], "indicator": "victimInjury" }
  ],
  "detainingCommands": ["stop", "handsUp", "getDown", "turnAround", "sitDown", "stepOut", "walkBackward", "showHands", "comeHere", "tossKeys", "turnOffEngine"],
  "attack": { "fight": "assaultOnOfficer", "fire": "assaultOnOfficer", "brandish": "weaponSeen" },
  "plainView": { "weapon": "weaponSeen", "default": "contrabandPlainView" },
  "forceUsed": { "tackle": ["hardHands", "tackle"], "struggle": ["softHands", "struggle"], "cuff": ["softHands", "cuffResisted"], "sidearmDrawn": ["presence", "firearmDisplay"] }
}
```
The parser checks every indicator name against `Object.keys(getRuleset('generic').indicators)`.

| Topic | Appends |
|---|---|
| `scene:materialized` | `start` (from `callInfo`), then `exigency` (reason `call`) when `exigency`, `warrant` (scope search + arrest) when `warrant`, `indicator weaponCall` (source `call`) and `callSuspect` for each suspect when `weaponReported` / always |
| `cad:trafficStop` active | `start` (if new); for the stop driver: `indicator` per observed violation kind (source `observation`; also the last 300 s of `traffic:violation`s of that vehicle kept in a ring of 64), then `detention` how `trafficStop` |
| `traffic:violation` | ring buffer only |
| `dispatch:plateResult` (player callsign) | `indicator`s (personId -1, source `lookup`) per mapped hit prefix of the incident whose stop / call vehicle it is (current incident otherwise) |
| `dispatch:personResult` (player) | `indicator`s for `readback.personId` |
| `contact:fact` | `statement` for `source === 'claim'` (custody from the last `contact:said` of that person); then `indicator` per matching `facts` row: `sourceEvent` = the statement (claims), the last `test` event of the row's `test` kind for that person (tests), the last `frisk`/`search` of the person within 5 s (evidence found), else -1 |
| `contact:said` | intent `ask` → `question` (fact, utterance, custody, gunpoint); intent `command` → `command`, and `detention` (how `command`) when outcome `comply` and the command is detaining and the person is not yet detained in this log; aggressive tone increments the person's `aggressiveLines` |
| `contact:consent` | `consent` (weaponDrawn from `officer().weapon !== 'none'`, aggressiveLines of the person) |
| `contact:action` | `frisk` → `frisk`; `searchPerson`/`searchVehicle` → `search` (target person / vehicle, claimedBasis null); `visualCheck` → `indicator` per incriminating item (`plainView` map, source `observation`); `pbt` → `test` (result); `sfstResult` → `test`; `cuff` ok → `detention` (cuffed) if not detained, then `arrest` (how `cuff`); `uncuff`/`release`/`warnRelease`/`writeCitation` → `release`; `seize` → `seizure` per item (fromEvent = the event that found `ref`, else -1) |
| `contact:miranda` | `miranda` |
| `contact:event` flag `falseIdentity` | `indicator falseIdentity` (source `evidence`) |
| `npc:fled` | `indicator flight` (source `observation`) |
| `npc:attack` | `indicator` per `attack` map (source `observation`) |
| `scene:command` | as `contact:said` commands |
| `force:used` | kinds in `forceUsed` map → `force` with that level / tool (resistance from `ports` is not available: use `'active'` for struggle/cuff, the last known resistance of the person from `force:applied`, else `'active'` for tackle); `taser`, `sidearmFire`, `taserDrawn` are ignored (the force system reports them) |
| `force:applied` | `force` (seq → forceId); then `incident:forceVerdict` with `forceVerdict(...)` text "TASER on active resistance: within policy (GS-8.1)" |
| `force:other` / `force:intervened` | `otherForce` / `intervene` (`otherEvent` = the otherForce event of that seq) |
| `investigation:found` | `search` (target `container`, `claimedBasis` = basis, found = [itemInfo], buildingId) |
| `investigation:plainView` | `indicator` for the item's owner (or -1) per `plainView` map, `sourceEvent` = the building's `entry` event in this log (-1 outdoors) |
| `investigation:collected` | `seizure` (fromEvent = the `search`/indicator event of that item) |
| `investigation:bodycam` | cam bits |
| `interior:transition` entering `done` | `entry` when `buildingIncident(building)` > 0 (first entry per building per log) |
| `scene:service` | `service` |
| `scene:pursuit` | `pursuitStart` / `pursuitEnd` in the log of `ownerCallId` (> 0) else of `callId`; samples while a vehicle pursuit is active: every 1 s of sim time when `pursuitProbe` is true → `pursuitSample`; after each sample `pursuitAdvisory(...)` → first non-null → `advisory terminatePursuit` + `incident:advisory` "Supervisor to <cs>: terminate the pursuit — <reason>." |
| `cad:documentSaved` booking final | `charges` (statutes, docId) for the booking's person (`ports.booking(docId)`) in the log of the booking's callId |
| `scene:outcome` | `close`, then the log closes and is queued for assessment |

Advisory `activateBodycam`: on the first `detention` / `frisk` / `search` / `force` of a log while `bodycamWorn()` and
the body bit is off → one advisory event + `incident:flash` "Bodycam is not recording (U)".

Closing: on `scene:outcome`, or a `close` request, or for `FC`/`FI` logs when no event was added for 600 s and
`activeContactIncident()` is not that key. Closed logs are assessed one per step (queue) and `incident:closed` is
emitted with the summary. Events arriving for a closed log (late booking charges, report) are still appended
(the assessment cache is invalidated).

Retention: at most 24 closed logs; `retain(keep, game)` drops closed logs not in `keep` that closed more than one
game day ago, then oldest unreferenced ones beyond 24. Per log at most 600 events (pursuit samples are thinned:
beyond 240 samples keep every second one).

### 9.4 Save (`IncidentsSave`)

```ts
export interface IncidentsSave {
  version: 1; jurisdiction: string; nextEventId: number; nextAdhoc: number;
  logs: IncidentLog[]; aliases: [string, string][];
  cam: { body: boolean; muted: boolean; dashManual: boolean };
  violations: { vehicleId: number; kind: string; sim: number }[];
  pursuit: { key: string; callId: number; nextSampleSim: number; advised: boolean } | null;
  assessQueue: string[];
  personState: [string, number, number, number][];   // key, personId, aggressiveLines, lastResistanceRank
  queue: IncidentRequest[];
}
export function emptyIncidentsSave(jurisdiction?: string): IncidentsSave;   // 'generic'
export function isIncidentsSave(x: unknown): x is IncidentsSave;          // shallow: version, arrays, each event has numeric id/t/game/personId/cam and a known kind
```

### 9.5 Tests (`test/incidents/**`)

A fake bus + fake ports harness: each mapping row produces the documented events; cam bits on events; FC → call
merge; keys; closing and the `incident:closed` summary; live force verdict text; pursuit sampling at 1 Hz with the
advisory once; retention; serialize / restore round trip then identical subsequent events; an end-to-end scripted
DUI stop (violation → stop → odor → PBT with consent → bacOver → cuff → miranda → question → statement → booking
charges → close) evaluates lawful under both rulesets; a frisk without RS evaluates unlawful.

## 10. Conduct, trust and career [conduct] (`src/conduct/**`, `src/data/conduct/**`, `test/conduct/**`) — wave 2

### 10.1 Data

`src/data/conduct/trust.json`:
```json
{ "version": 1, "min": 0.05, "max": 0.95, "spill": 0.25, "driftPerDay": 0.15,
  "deltas": { "lawfulArrest": 0.004, "unlawfulDetention": -0.02, "unlawfulSearch": -0.025, "unlawfulArrest": -0.03,
              "mirandaViolation": -0.005, "excessiveForce": -0.06, "questionableForce": -0.02, "justifiedForce": -0.004,
              "injuryMultiplier": 1.5, "fatalMultiplier": 3, "deEscalation": 0.02, "courteousContact": 0.003,
              "aggressiveLine": -0.002, "conviction": 0.004, "dismissedMisconduct": -0.01, "missedCourt": -0.004,
              "commendation": 0.01, "sustainedIa": -0.02, "civilSuit": -0.03 },
  "effects": { "errorScale": [1.6, 0.4], "crimeFactor": [1.3, 0.8], "hostilityThreshold": 0.6, "hostilityScale": 0.8 } }
```
Baselines are `TRUST` of `src/dialogue` (pre-existing, per district type); districts = the keys of `TRUST`.

`src/data/conduct/ia.json`:
```json
{ "version": 1, "complaint": { "base": 0.03, "perAggressiveLine": 0.05, "lowTrust": 0.2, "max": 0.6 }, "autoResolveH": 12,
  "rules": [
    { "id": "excessiveForce", "when": "forceVerdict", "verdict": "excessive", "severity": "major" },
    { "id": "lethalForce", "when": "forceTool", "level": "firearm", "severity": "critical" },
    { "id": "questionableForce", "when": "forceVerdict", "verdict": "questionable", "minCount": 2, "severity": "minor" },
    { "id": "failureToIntervene", "when": "doctrine", "doctrine": "intervene", "outcome": "unlawful", "severity": "major" },
    { "id": "recordingViolation", "when": "doctrine", "doctrine": "recording", "outcome": "unlawful", "severity": "minor" },
    { "id": "pursuitViolation", "when": "doctrine", "doctrine": "pursuit", "outcome": "unlawful", "severity": "minor" },
    { "id": "unlawfulSearch", "when": "doctrine", "doctrine": "search", "outcome": "unlawful", "minCount": 1, "severity": "minor" },
    { "id": "injuryInCustody", "when": "injury", "minInjury": 0.3, "severity": "major" },
    { "id": "complaint", "when": "complaint", "severity": "minor" }
  ] }
```
`src/data/conduct/discipline.json`:
```json
{ "version": 1,
  "ladder": { "minor": ["counseling", "writtenReprimand", "suspension:8"], "major": ["suspension:16", "suspension:40", "termination"], "critical": ["termination"] },
  "civilSuit": { "minInjury": 0.3, "base": 25000, "perInjury": 400000 },
  "criminal": { "fatal": true, "firearmMinInjury": 0.5 },
  "credibility": { "untruthful": -0.2, "sustained": -0.05 },
  "points": { "counseling": -5, "writtenReprimand": -10, "suspension": -25, "termination": -100 } }
```
`src/data/conduct/commendations.json`:
```json
{ "version": 1, "rules": [
  { "id": "deEscalation", "label": "De-escalation", "points": 20 },
  { "id": "lifesaving", "label": "Lifesaving", "points": 25, "withinS": 120 },
  { "id": "dutyToIntervene", "label": "Duty to intervene", "points": 30 },
  { "id": "excellentReport", "label": "Excellent report", "points": 10, "minScore": 95 },
  { "id": "cleanCase", "label": "Clean case", "points": 15, "minReport": 80 },
  { "id": "credibleTestimony", "label": "Credible testimony", "points": 10 } ] }
```

### 10.2 Pure functions — mandatory tests

```ts
// trust.ts
export interface TrustState { values: Record<string, number> }
export function newTrustState(): TrustState;                                         // baselines
export function applyTrustDelta(s: TrustState, district: string, delta: number, cfg: TrustConfig): void;  // district += delta, every other += delta·spill, clamp [min,max]; unknown district → spill to all only
export function driftTrust(s: TrustState, days: number, cfg: TrustConfig): void;    // v = base + (v − base)·exp(−driftPerDay·days)
export function trustDeltaForIncident(a: LegalAssessment, log: IncidentLog, aggressiveLines: number, cfg: TrustConfig): number;
export interface TrustEffects { cooperation: number; errorScale: number; crimeFactor: number; hostility: number }
export function trustEffects(v: number, cfg: TrustConfig): TrustEffects;            // cooperation v; lerps; hostility max(0, threshold − v)·scale
// report.ts
export interface ReportGrade { docId: string; key: string; score: number; letter: 'A' | 'B' | 'C' | 'D' | 'F'; completeness: number; missing: string[]; contradictions: { text: string; onCamera: boolean }[]; unsupported: string[]; game: number }
export function gradeReport(choices: readonly ReportChoice[], assertions: readonly string[], log: IncidentLog, docId: string, game: number): ReportGrade;
// ia.ts
export interface IaTrigger { rule: string; severity: 'minor' | 'major' | 'critical'; eventIds: number[] }
export function iaTriggers(a: LegalAssessment, log: IncidentLog, rules: IaConfig, complaintRoll: number, trust: number, aggressiveLines: number, injuryOf: (personId: number) => number): IaTrigger[];
export type IaStatement = { kind: 'account'; claims: { eventId: number; resistance: string }[] } | { kind: 'acknowledge' } | { kind: 'none' };
export interface IaStatementOption { text: string; statement: IaStatement }
export function iaStatementOptions(c: IaCase, log: IncidentLog): IaStatementOption[];
export function resolveIa(c: IaCase, a: LegalAssessment, log: IncidentLog, statement: IaStatement): { finding: IaFinding; untruthful: boolean; reasons: string[] };
export function disciplineFor(finding: IaFinding, severity: IaCase['severity'], priorSustained: number, maxInjury: number, fatal: boolean, firearm: boolean, cfg: DisciplineConfig): DisciplineAction[];
// commendations.ts
export function commendationsFor(log: IncidentLog, a: LegalAssessment, cfg: CommendationConfig): string[];   // incident-time rules: deEscalation, lifesaving, dutyToIntervene
```
- `trustDeltaForIncident`: Σ deltas: each unlawful `detention` / `search` (+ `frisk`, `friskScope`, `entry`) /
  `arrest` / `miranda` determination; each force ruling (justified / questionable / excessive, × injuryMultiplier
  when the force event's injury ≥ 0.3, × fatalMultiplier when fatal; `other` rulings count half); each lawful
  arrest; `deEscalation` when `commendationsFor` contains it; `courteousContact` when the log has a `release` and no
  force and no unlawful determination; `aggressiveLine` × `aggressiveLines` (the officer's aggressive-tone lines in
  the incident; tone is not in the log, so the integrator passes the recorder's count with the `incidentClosed`
  request).
- `gradeReport`: `keyTrue` = key choices with truth `true`; `completeness` = |asserted ∩ keyTrue| / |keyTrue| (1 when
  empty); asserted choices with truth `false` are contradictions, `onCamera` when the choice's event (or, for
  distractors, ≥ half of the person's events) has the body bit without muted; `unsupported` = asserted `unsupported`;
  two assertions of one group → one contradiction. `score = clamp(round(100·completeness − 12·offCam − 20·onCam −
  10·unsupported), 0, 100)`; letters A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, F. `missing` = texts of unasserted key facts (≤ 5).
- `iaTriggers`: one trigger per matching rule (`forceVerdict`: rulings with that verdict, `other` excluded, count ≥
  `minCount ?? 1`; `forceTool`: force events with that level and `hit`; `doctrine`: determinations; `injury`: a force
  event with injury ≥ minInjury after the person's first arrest; `complaint`: `complaintRoll < clamp(base +
  perAggressiveLine·aggressiveLines + max(0, 0.5 − trust)·lowTrust, 0, max)`).
- `resolveIa`: `violation` = any trigger backed by an excessive ruling, an unlawful doctrine or an injury trigger with
  a non-justified force ruling; `lethalForce` alone with all firearm rulings justified → `exonerated`; `complaint`
  alone with `summary.unlawful + excessiveForce + questionableForce === 0` → `unfounded`; a violation whose events
  all lack the body bit and severity ≠ critical and statement ≠ acknowledge → `notSustained`; else a violation →
  `sustained`; no violation → `exonerated`. `untruthful` = an `account` claim whose event is on camera and whose
  resistance differs from the log → finding `sustained` (reason `untruthfulness`).
- `iaStatementOptions`: per non-presence force event in the case's events: "When I used the <tool>, <person> was
  <level>" for the true level and the next higher level (two account options each, max 4); plus "I acknowledge the
  policy violation" and "I have nothing to add" (`none`).
- `disciplineFor`: `sustained` → the ladder entry at `min(priorSustained, len − 1)` (`acknowledge` mitigation is
  applied by the caller as `priorSustained − 1`, floor 0); plus `civilSuit` when maxInjury ≥ civilSuit.minInjury
  (amount `base + perInjury·injury`, rounded to 1000); plus `criminalCharges` + `termination` when fatal (and
  sustained) or (firearm and maxInjury ≥ firearmMinInjury and sustained). Other findings → [].
- `commendationsFor`: `deEscalation` when the log has `weaponSeen`/`weaponCall`/`assaultOnOfficer` indicators, no
  force event above `verbal` (presence displays allowed), and an `arrest` or `release`; `lifesaving` when a `service
  ems requested` event happens within `withinS` of the first `start`/`person` event on families `medical crisis
  collision` or after a force event with injury > 0; `dutyToIntervene` for each lawful `intervene` determination.

### 10.3 Runtime (`src/conduct/conductState.ts`, `types.ts`, `events.ts`, `save.ts`)

```ts
export type DutyStatus = 'active' | 'suspended' | 'adminLeave' | 'terminated';
export interface IaCase { id: string; key: string; openedGame: number; triggers: IaTrigger[]; severity: 'minor' | 'major' | 'critical'; status: 'open' | 'closed'; statement: IaStatement | null; finding: IaFinding | null; untruthful: boolean; discipline: DisciplineAction[]; closedGame: number }
export interface DisciplineAction { action: 'counseling' | 'writtenReprimand' | 'suspension' | 'termination' | 'civilSuit' | 'criminalCharges'; hours: number; amount: number; caseId: string; game: number }
export interface Commendation { id: string; label: string; key: string; game: number; points: number }
export interface CareerView {
  status: DutyStatus; statusUntilGame: number; statusReason: string;
  points: number; credibility: number;
  commendations: readonly Commendation[]; discipline: readonly DisciplineAction[]; ia: readonly IaCase[];
  reports: readonly ReportGrade[];
  stats: { incidents: number; arrests: number; lawfulArrests: number; excessiveForce: number; convictions: number; dismissals: number; reportsFiled: number; avgReport: number };
}
export type ConductRequest =
  | { readonly kind: 'incidentClosed'; readonly key: string; readonly aggressiveLines: number }
  | { readonly kind: 'report'; readonly key: string; readonly docId: string; readonly assertions: readonly string[] }
  | { readonly kind: 'iaStatement'; readonly caseId: string; readonly statement: IaStatement }
  | { readonly kind: 'verdict'; readonly key: string; readonly caseId: string; readonly verdict: string; readonly reason: string; readonly credibilityDelta: number; readonly impeached: boolean; readonly missed: boolean }
  | { readonly kind: 'trust'; readonly district: string; readonly delta: number; readonly reason: string }
  | { readonly kind: 'reinstate' };                     // console
export interface ConductDeps { readonly bus: EventBus<EventMap>; readonly rng: Rng; readonly incidents: IncidentSource; districtOf(key: string): string; injuryOf(personId: number): number; readonly configs?: Partial<ConductConfigs> }
export class ConductState {
  constructor(deps: ConductDeps);
  get revision(): number;
  get career(): CareerView;
  trust(district: string): number;
  trustRows(): readonly { district: string; value: number; baseline: number; trend: number }[];   // trend = value − value 1 game day ago (kept per district)
  effects(district: string): TrustEffects;
  dutyStatus(game: number): { status: DutyStatus; untilGame: number; reason: string };
  reportGrade(docId: string): ReportGrade | null;
  iaCase(id: string): IaCase | null;
  request(r: ConductRequest): void;
  /** Fixed step (order -658): requests; once per game minute: trust drift, suspension end, IA auto-resolve. */
  step(dt: number, t: CadTime): void;
  serialize(): ConductSave;
  restore(s: ConductSave): void;
}
```
Request behaviour:
- `incidentClosed`: `a = incidents.assessment(key)`, `log = incidents.log(key)`; trust delta in `districtOf(key)`;
  one complaint draw (`rng.next()`, always exactly one per closed incident); triggers → when non-empty an `IaCase`
  (`IA-0001`…, severity = max) and `conduct:ia { caseId, key, reasons }`; commendations; stats.
- `report`: `gradeReport(incidents.reportChoices(key), assertions, log, docId, t.game)`; stored (last 50), points
  `(score − 70) / 5` rounded; `excellentReport` commendation; `conduct:report { docId, key, score, letter }`.
- `iaStatement`: stored; resolution happens in the same step: `resolveIa` → finding → `disciplineFor` (prior sustained
  count of earlier closed cases; `acknowledge` mitigation) → apply: suspension sets `status suspended` until `game +
  hours·3600` (stacking extends), termination/criminal → `terminated` (`criminalCharges` → reason "Criminal charges
  filed"), civil suit → `civilSuit` record + trust; untruthful → credibility −0.2; sustained → credibility −0.05,
  trust `sustainedIa`; `conduct:iaResolved { caseId, finding, discipline: string[] }`.
- IA auto-resolve after `autoResolveH` game hours without a statement (statement `none`).
- `verdict`: credibility += delta (clamp 0..1); convictions / dismissals; `conviction` / `dismissedMisconduct`
  (dismissed with reason `suppression` or `unlawfulArrest`) / `missedCourt` trust; `cleanCase` commendation when
  convicted and the incident's report grade ≥ minReport; `credibleTestimony` when convicted and not impeached and
  not missed.
- Events (`src/conduct/events.ts`): `conduct:ia`, `conduct:iaResolved`, `conduct:report`, `conduct:commendation {
  id, label, key }`, `conduct:discipline { action, hours, amount, caseId }`, `conduct:status { status, untilGame,
  reason }`, `conduct:trust { district, value, delta, reason }` (only when |delta| ≥ 0.005).
- Save: `ConductSave { version: 1; rng: RngState; trust: Record<string, number>; trustDayAgo: Record<string, number>;
  lastDriftGame: number; status: DutyStatus; statusUntilGame: number; statusReason: string; points: number;
  credibility: number; commendations: Commendation[]; discipline: DisciplineAction[]; ia: IaCase[]; nextIa: number;
  reports: ReportGrade[]; stats: CareerView['stats']; queue: ConductRequest[] }`, `newConductSave(rng)`,
  `isConductSave`.

### 10.4 Tests (`test/conduct/**`) — mandatory

Trust: delta and spill, clamps, drift halves the gap after `ln2 / driftPerDay` days, effects monotonic and at the
documented endpoints, unknown district; report grading: perfect report 100 / A, missing key facts lower
completeness, a false resistance claim on camera −20, off camera −12, unsupported PC −10, two in a group;
IA triggers: each rule fires on a crafted assessment and not otherwise, `minCount`, complaint probability formula
at the roll boundaries; resolveIa: each finding branch, untruthful claim; discipline ladder by priors, civil suit
amount, criminal charges on fatal; commendations rules; `ConductState`: incident closed → IA case + trust event,
statement → finding → suspension until time → `dutyStatus` back to active after it, termination permanent,
verdict effects, save round trip.

## 11. Court [court] (`src/court/**`, `src/data/court/**`, `test/court/**`) — wave 2

### 11.1 Data (`src/data/court/court.json`, `src/data/court/questions.json`)

```json
{ "version": 1, "plea": { "base": 0.3, "strongBonus": 0.3 }, "citationContest": 0.25, "delayH": [2, 6], "hours": [9, 17],
  "windowBeforeMin": 30, "windowAfterMin": 120, "reminderMin": 60, "maxQuestions": 6,
  "credibility": { "consistent": 0.01, "evasive": -0.01, "reportMismatch": -0.02, "contradictOffCam": -0.05, "impeachOnCam": -0.15, "selfInconsistent": -0.08 },
  "testimony": { "base": 0.5, "consistent": 0.1, "impeached": -0.3, "contradiction": -0.1, "evasive": -0.05, "selfInconsistent": -0.2 },
  "conviction": { "base": 0.15, "strength": 0.45, "testimony": 0.25, "report": 0.15, "missedFactor": 0.4, "noReportGrade": 50 } }
```
`questions.json`: `{ "version": 1, "templates": { "resistanceAt": "Isn't it true that my client was {level} when you used the {tool}?", "consentGiven": "Did my client consent to the {search}?", "mirandaBefore": "Did you advise my client of their rights before asking about {fact}?", "camDuring": "Was your body camera recording when you {action}?", "reportAssertion": "Your report states: \"{text}\" Is that accurate?", "omission": "Your report does not mention this: \"{text}\" Did that happen?", "repeat": "So your testimony is that it is NOT true that {restated}?" }, "labels": { ... resistance / tool / search / fact / action labels ... } }`.

### 11.2 Pure functions — mandatory tests

```ts
export interface CrossExamQuestion {
  id: string; kind: 'resistanceAt' | 'consentGiven' | 'mirandaBefore' | 'camDuring' | 'reportAssertion' | 'omission' | 'repeat';
  text: string; truth: 'yes' | 'no'; reportSays: 'yes' | 'no' | null; eventId: number; onCamera: boolean; weight: number; pairOf: string | null;
}
export interface CrossExamInput { caseId: string; personId: number; log: IncidentLog; assessment: LegalAssessment; choices: readonly ReportChoice[]; assertions: readonly string[] | null }
export function generateCrossExam(input: CrossExamInput, rng: Rng, cfg: CourtConfig): CrossExamQuestion[];
export interface TestimonyResult { credibilityDelta: number; score: number; consistent: number; impeached: number; contradictions: number; evasive: number; selfInconsistent: number; reportMismatches: number; notes: string[] }
export function scoreTestimony(qs: readonly CrossExamQuestion[], answers: readonly ('yes' | 'no' | 'dontRecall')[], cfg: CourtConfig): TestimonyResult;
export interface MotionRuling { text: string; granted: boolean; ruleIds: string[]; dismissesCase: boolean }
export function motionRulings(a: LegalAssessment, personId: number, offenses: readonly Offense[], rs: Ruleset): MotionRuling[];
export function evidenceStrength(a: LegalAssessment, log: IncidentLog, personId: number, offense: Offense, rs: Ruleset): number;   // 0..1
export function convictionChance(strength: number, testimony: number | null, reportScore: number | null, missed: boolean, cfg: CourtConfig): number;
export function scheduleHearing(createdGame: number, u: number, cfg: CourtConfig): number;   // game seconds
```
- `generateCrossExam` candidates (only events of `personId`):
  1. `resistanceAt` per non-presence force event: `level` = the asserted `res:<eventId>:<level>` of the report when
     present, else the logged resistance; `truth = level === logged ? 'yes' : 'no'`; `reportSays` = 'yes' when the
     report asserted that level, null otherwise; weight 3 (+2 when its ruling is not justified).
  2. `consentGiven` per frisk / search: truth 'yes' when an effective consent covering it exists (same rules as
     §5.8 but only checking granted && valid kind match), else 'no'; `reportSays` from `consent:<kind>:<pid>`
     assertion; weight 3 when the search determination is unlawful else 1.5.
  3. `mirandaBefore` per custodial incriminating question (first per fact): truth 'yes' when waived/invoked before;
     `reportSays` from `miranda:<pid>`; weight 2.5.
  4. `camDuring` per search / frisk / force / arrest event: truth from its cam bits; weight 1.5.
  5. `reportAssertion` per asserted choice of the person with truth `false` / `unsupported` (truth 'no',
     reportSays 'yes', weight 2) and up to 2 asserted true ones (truth 'yes', reportSays 'yes', weight 0.5).
  6. `omission` per key true choice of the person not asserted (truth 'yes', reportSays 'no', weight 1).
  Without a report every `reportSays` is null and kinds 5-6 are skipped. `onCamera` = the event's body bit without
  muted (choices without event: false). Sort by weight desc, then id; dedupe by `(kind, eventId)`; take
  `maxQuestions − 1`; Fisher-Yates shuffle with `rng`; when ≥ 4 questions append a `repeat` of the highest-weight
  one (truth inverted, `pairOf` = its id, `reportSays` inverted when not null). Ids `q1…qn` after shuffling.
- `scoreTestimony`: per question: `dontRecall` → evasive; `answer === truth` → consistent (and `reportMismatch` when
  `reportSays !== null && answer !== reportSays`); else contradiction (`impeached` when `onCamera`). A `repeat` and
  its pair are `selfInconsistent` when both answered yes/no and `answer(repeat) === answer(pair)`.
  `credibilityDelta` = Σ cfg.credibility per category; `score = clamp(testimony.base + Σ testimony per category, 0, 1)`;
  `notes` human lines ("Impeached by bodycam footage on q3").
- `motionRulings`: for the person: unlawful arrest without warrant → "Motion to dismiss: unlawful arrest — GRANTED"
  (`dismissesCase`); each inadmissible `EvidenceRuling` → "Motion to suppress <label> — GRANTED (<rule ids>)";
  admissible items challenged? no: only list granted motions plus one denied motion "Motion to suppress <label> —
  DENIED" for the first admissible search item when any search determination exists (shows the lawful basis).
- `evidenceStrength`: Σ pc of admissible (untainted) indicators of the person with that offense + 1.0 per
  admissible `item` ruling whose offense matches + 2.0 when the offense is `warrant` and `warrantHit` is admissible;
  `min(1, sum / thresholds.pc)`.
- `convictionChance`: `base + strength·s + (testimony ?? 0.5)·t + ((reportScore ?? noReportGrade) / 100)·r`, × missedFactor
  when missed, clamp 0.02..0.98.
- `scheduleHearing`: `createdGame + (delayH[0] + u·(delayH[1] − delayH[0]))·3600`, rounded up to the next full hour;
  outside `hours` → next day at `hours[0]`:00.

### 11.3 Runtime (`src/court/courtState.ts`, `types.ts`, `events.ts`, `save.ts`)

```ts
export interface CourtCase {
  id: string;                     // "CR-0001"
  docId: string; docKind: 'booking' | 'citation'; personId: number; personLabel: string; key: string; callId: number;
  statutes: string[]; offenses: string[];
  createdGame: number; hearingGame: number;   // -1 when no hearing (plea, paid)
  status: 'pending' | 'pleaded' | 'scheduled' | 'inSession' | 'heard' | 'missed' | 'closed';
  questions: CrossExamQuestion[]; motions: MotionRuling[];
  verdict: 'convicted' | 'acquitted' | 'dismissed' | 'paid' | null; reason: string;
  testimony: TestimonyResult | null; reminded: boolean;
}
export type CourtRequest =
  | { readonly kind: 'open'; readonly docId: string; readonly docKind: 'booking' | 'citation'; readonly personId: number; readonly personLabel: string; readonly callId: number; readonly statutes: readonly string[] }
  | { readonly kind: 'attend'; readonly caseId: string }
  | { readonly kind: 'testify'; readonly caseId: string; readonly answers: readonly ('yes' | 'no' | 'dontRecall')[] }
  | { readonly kind: 'advance'; readonly caseId: string };     // console: hearing now
export interface CourtDeps { readonly bus: EventBus<EventMap>; readonly rng: Rng; readonly seed: number; readonly incidents: IncidentSource; ruleset(): Ruleset; reportGrade(key: string): number | null; readonly config?: CourtConfig }
export class CourtState {
  constructor(deps: CourtDeps);
  get revision(): number;
  cases(): readonly CourtCase[];                // newest first
  case(id: string): CourtCase | null;
  next(game: number): CourtCase | null;         // the soonest scheduled hearing (for HUD / calendar)
  canAttend(id: string, game: number): boolean; // scheduled and within [hearing − windowBefore, hearing + windowAfter]
  request(r: CourtRequest): void;
  /** Fixed step (order -656): requests; once per game minute: reminders, missed hearings. */
  step(dt: number, t: CadTime): void;
  serialize(): CourtSave;
  restore(s: CourtSave): void;
}
```
- `open`: key = `callNumber(callId)` (or the incident whose log has a `charges` event with that docId); offenses =
  `ruleset.statuteOffense` of the statutes (unique). Citations: one draw `u < citationContest` → contested
  (scheduled) else `paid` (closed, verdict paid). Bookings: plea draw `u < plea.base + plea.strongBonus·max
  strength` → `pleaded` (verdict convicted, closed); else `scheduled` with `scheduleHearing(createdGame, u2)` and
  `court:subpoena { caseId, hearingGame, label }`. Exactly 2 draws per open (unused second draw still consumed).
- Reminder: `reminderMin` before the hearing → `court:reminder` once.
- `attend` (only when `canAttend`): `motions` + `questions` (`generateCrossExam` with `createRng(seed).stream('court:'
  + caseId)`, report assertions = the latest report of the incident from the log's `reports`), status `inSession`,
  `court:session { caseId }` (the app opens the courtroom). When a motion `dismissesCase` the questions are cut to
  the first 3.
- `testify` (status inSession, answers length = questions length): `scoreTestimony` → verdict: dismissed (reason
  `suppression`/`unlawfulArrest`) when a motion dismisses or every offense strength is 0; else one draw `u <
  convictionChance(maxStrength, score, reportGrade, false)` → convicted / acquitted. Status `heard` → `closed`.
  `court:verdict { caseId, key, verdict, reason, credibilityDelta, impeached: testimony.impeached > 0, missed:
  false }`.
- Missed: still `scheduled` after `hearing + windowAfter` → motions applied, verdict by chance with testimony null and
  `missed` true (one draw) → `court:verdict` with `missed: true`.
- Events (`src/court/events.ts`): `court:subpoena`, `court:reminder { caseId, hearingGame }`, `court:session`,
  `court:verdict`, `court:flash { text }`.
- Save: `CourtSave { version: 1; rng: RngState; nextId: number; cases: CourtCase[] (≤ 60, closed oldest dropped);
  lastMinute: number; queue: CourtRequest[] }`, `emptyCourtSave(rng)`, `isCourtSave`.

### 11.4 Tests (`test/court/**`) — mandatory

Question generation: deterministic per case id; contains a `resistanceAt` question for each force event with truth
per log; report-asserted overstated level gives truth 'no' and reportSays 'yes'; omission questions only for
unasserted key facts; no report → no report questions; max count and repeat pairing; camera flags. Testimony: all
truthful → positive delta, no impeachment; a lie on camera → impeachOnCam; dontRecall evasive; repeat
inconsistency; reportMismatch for honest admission. Motions: unlawful arrest dismisses; suppressed items listed with
rule ids. Strength and conviction chance formula; scheduling (rounding, court hours, next day); `CourtState` flows:
plea / scheduled / reminder / attend window / testify verdict / missed hearing; save round trip.

## 12. UI, HUD, input [ui] (`src/ui/mdt/**`, `src/ui/court/**`, `src/ui/ia/**`, `src/ui/hud/**`, `src/ui/mainMenu.ts`, `src/input/actions.ts`, `src/input/bindings.ts`, tests `test/mdt/**`, `test/courtui/**`, `test/iaui/**`, `test/hud/**`, `test/input/actions.test.ts`, `test/input/bindings.test.ts`, `test/mainMenu/**`) — wave 3

### 12.1 MDT (`src/ui/mdt/**`)

- `MDT_TABS` appends `career` ("Career") and `community` ("Community"); digits 1-9 keep the first nine, the two new
  tabs are reached with ←/→ (and `0` jumps to Career).
- `MdtDeps` gains optional:
  ```ts
  career?: {
    revision(): number;
    view(): CareerView;                                     // conduct
    cases(): readonly CourtCase[];                          // court
    canAttend(caseId: string): boolean;
    attend(caseId: string): void;                           // → court.request attend
    openIa(caseId: string): void;                           // → the app opens the IA review
    jurisdiction(): { id: string; name: string };
    now(): CadTime;
  };
  community?: { revision(): number; rows(): readonly { district: string; value: number; baseline: number; trend: number }[] };
  reportChoices?(callId: number): readonly { id: string; group: string | null; text: string }[];
  submitReport?(docId: string, callId: number, assertionIds: readonly string[]): void;
  reportGrade?(docId: string): { score: number; letter: string; missing: readonly string[]; contradictions: readonly { text: string; onCamera: boolean }[]; unsupported: readonly string[] } | null;
  ```
- **Career tab** (pure model `careerModel(view, cases, now)` → sections; DOM rebuilt on revision change, ≤ 4 Hz):
  duty status line, jurisdiction, points, credibility (percent), calendar (scheduled hearings with day/time and
  "ATTEND" button when `canAttend`), cases list (status, verdict), IA cases (status, finding, "REVIEW" button for open
  ones), commendations, discipline, last reports (score, letter).
- **Community tab** (pure `communityModel(rows)`): one row per district: label, a bar (value), baseline marker,
  trend arrow (▲ ≥ +0.01, ▼ ≤ −0.01), percent text; colour bands < 0.3 red, < 0.5 amber, else green.
- **Report form**: for an incident report with a `callId` and `reportChoices` available, a "Statements of fact"
  section: one checkbox per choice (grouped choices render as radio buttons in a fieldset per group); finalize
  passes the checked ids to `submitReport` after the existing validation; the document view shows the grade
  (`reportGrade`) with missing / contradictions / unsupported lines.
- Tests: tab list and labels, models, the report form submit (headless model path), grade view text.

### 12.2 Courtroom (`src/ui/court/courtroomPanel.ts`, `court.css`, prefix `crt-`)

```ts
export interface CourtroomView { caseId: string; title: string; motions: readonly { text: string; granted: boolean }[]; questions: readonly { id: string; text: string }[] }
export interface CourtroomState { phase: 'motions' | 'questions' | 'review'; index: number; answers: ('yes' | 'no' | 'dontRecall' | null)[] }
export function reduceCourtKey(s: CourtroomState, view: CourtroomView, key: string): { state: CourtroomState; emit: { kind: 'submit'; answers: ('yes' | 'no' | 'dontRecall')[] } | { kind: 'close' } | null; consumed: boolean };
// motions: Enter → questions; questions: 1 yes, 2 no, 3 don't recall (then next), Backspace previous; review: Enter submit, Backspace back; Escape → close only in the motions phase (the testimony must be finished once begun)
export class CourtroomPanel implements Menu { readonly id = 'courtroom'; readonly pausesGame = true; constructor(ui: UIRoot | null, onSubmit: (caseId: string, answers: readonly ('yes' | 'no' | 'dontRecall')[]) => void); open(view: CourtroomView): void; close(): void; get isOpen(): boolean }
```
Layout: a bench header (generic "Superior Court — Department 3", case id, defendant label), judge's rulings list,
question card with "Q 2 / 6", answer keys, a progress strip; review page lists answers. Tests: reducer paths,
headless construction.

### 12.3 IA review flow (`src/ui/ia/iaReview.ts`)

```ts
/** Maps an incident log + IA case + statement options into the recording module's review source and footer. */
export function iaReviewSource(log: IncidentLog, c: IaCase, media: MediaStore, tag: string): ReviewSource;
export function iaReviewFooter(c: IaCase, options: readonly IaStatementOption[], submit: (s: IaStatement) => void): ReviewFooter;
export function reviewEventsOf(log: IncidentLog, a: LegalAssessment | null): ReviewEvent[];   // labels per kind; severity 'bad' for events with an unlawful determination / excessive ruling, 'warn' questionable
```
Labels (pure, tested): `force` "TASER — active resistance (justified)", `search` "Search of vehicle", `frisk`
"Frisk", `question` "Q: drinking (custody)", `statement` "A: drinking = yes", `consent` "Consent: searchVehicle
granted", `arrest` "Arrest", `cam` "Bodycam ON / OFF / MUTED", `indicator` "Observed: odor of alcohol", etc.

### 12.4 HUD (`src/ui/hud/**`)

`HudSnapshot` gains (optional, filled by the integrator's feed):
```ts
force?: { tool: string; ammo: string; attached: boolean; episode: string | null } | null;
cam?: { body: boolean; muted: boolean; dash: boolean; worn: boolean } | null;   // chips REC / MUTED / DASH (replaces the Phase 4 REC chip when present)
legal?: { text: string; severity: 'ok' | 'warn' | 'bad' } | null;               // last verdict / advisory line (the feed keeps it 6 s)
duty?: string | null;                                                            // "SUSPENDED until Tue 06:00" / "TERMINATED"
court?: string | null;                                                           // "COURT 14:00 · CR-0003 · in 1 h 20 min"
trust?: { district: string; value: number } | null;                              // chip "Trust · Suburbs 62 %"
```
Rendering follows the Phase 4 chip pattern (DOM writes only on change). Tests extend `test/hud/**`.

### 12.5 Input (`src/input/actions.ts`, `bindings.ts`) and main menu

New actions: `officer.intervene` (KeyH, on foot; "Intervene"), `officer.bodycamMute` (KeyJ; "Bodycam mute").
`officer.weapon` (C) keeps its id and binding: its label becomes "Cycle force tool". Main menu (`src/ui/mainMenu.ts`):
a "Jurisdiction" select under the seed field listing `rulesetIds()` with `getRuleset(id).name`, default `generic`; the
new-game callback receives it (`onNewGame(seed, jurisdiction)` — the integrator adapts `app.ts`). Tests: bindings
defaults, no conflicts on foot, menu model.

## 13. UI structure

| Surface | Owner | Opens on | Pauses |
|---|---|---|---|
| Force tool chip, ammo, verdict line, REC/MUTED/DASH chips, duty, court due, trust chip | ui HUD, integrator feed | always | – |
| MDT Career tab (calendar, cases, IA, commendations, discipline, reports) | ui | MDT (Tab), `0` | no |
| MDT Community tab (trust per district) | ui | MDT | no |
| Incident report statements checklist + grade view | ui (MDT form) | MDT Reports | no |
| Courtroom panel | ui `CourtroomPanel` | `court:session` after "ATTEND" | yes |
| Evidence review panel (IA statement footer; read-only from the Career tab for closed cases) | recording `EvidenceReviewPanel` + ui `iaReview` | Career → REVIEW | yes |
| Jurisdiction select | ui main menu | title screen | – |
| Radio lines: supervisor advisories, subpoena / reminder, IA notices | integrator (`RadioSystem.say`) | events | – |

## 14. ECS components and event topics

No new ECS component (all Phase 5 state lives in systems; `src/ecs/components.ts` unchanged). Topics (declaration
merging in each owner's `events.ts`; the integrator updates the `src/core/event-map.ts` header comment):

| Topic | Owner file | Payload |
|---|---|---|
| `force:applied` `force:other` `force:intervened` `force:tool` `force:flash` | `src/force/events.ts` | §6.4 |
| `contact:fact` `contact:said` `contact:action` `contact:miranda` | `src/contact/events.ts` | §7.3 |
| `scene:command` (+ `scene:pursuit` optional fields) | `src/scene/events.ts` | §7.4 |
| `npc:caught.by` += `'force'` | `src/npc/events.ts` | §7.1 |
| `incident:opened` `incident:closed` `incident:forceVerdict` `incident:advisory` `incident:report` `incident:flash` | `src/incidents/events.ts` | §9.1 |
| `conduct:ia` `conduct:iaResolved` `conduct:report` `conduct:commendation` `conduct:discipline` `conduct:status` `conduct:trust` | `src/conduct/events.ts` | §10.3 |
| `court:subpoena` `court:reminder` `court:session` `court:verdict` `court:flash` | `src/court/events.ts` | §11.3 |

Integrator bridges (bus handlers, synchronous inside the emitting step): `incident:closed` →
`conduct.request({ kind: 'incidentClosed', key, aggressiveLines })`; MDT submit → `incidents.request(report)` +
`conduct.request(report)`; `cad:documentSaved` final booking / citation → `court.request(open)`; `court:verdict` →
`conduct.request(verdict)`; `court:session` → open the courtroom; `conduct:status` → dispatcher player unit
out of service / available; `incident:advisory`, `court:subpoena`, `court:reminder`, `conduct:ia`,
`conduct:iaResolved` → radio lines + HUD; `incident:forceVerdict`, `force:flash`, `incident:flash`, `court:flash` →
HUD legal line; `force:applied` → `SnapshotScheduler.immediate()`.

## 15. Step order, frame order, determinism, workers

| Order | System | Work |
|---|---|---|
| -690 | `scene` | + setWeapon, terminatePursuit, scene:command, onlookers, errorScale |
| **-685** | **`force`** | requests (tool, apply, intervene), TASER attachment / cycles, fellow episodes (4 Hz check), ammo refill |
| -680 | `contact` | + new topics, Miranda |
| -675 / -670 | investigation / station | unchanged |
| **-660** | **`incidents`** | requests, cam bits, pursuit samples (1 Hz), FC/FI closing (1 Hz check), ≤ 1 assessment per step |
| **-658** | **`conduct`** | requests, per game minute: drift, suspension end, IA auto-resolve |
| **-656** | **`court`** | requests, per game minute: reminders, missed hearings |
| -650 / -640 / 40 / 50 / 60 | radio / tactical / vehicles.pre / traffic / npc | npc + resistance timers |

Per frame (`App.update`): C → `force.request(cycleTool)` (was `scene.request(weapon)`), mouse 0 on foot →
`force.request(apply, camera forward)` (was `scene.request(fire)`), H → intervene, J → `incidents.request(mute,
!muted)`, the light bar switched off during an active vehicle pursuit → `scene.request(terminatePursuit)`; HUD feed;
after `renderer.render()` (same task, after the Phase 4 thumbnail): when `scheduler.due(sim, incidents.cam.bits,
incidents.current)` and a WebGL canvas exists → `captureSnapshot(...)` → `media.put({ tag, incident, source: inCar ?
'dash' : 'body', sim, game, w, h }, blob)` and `scheduler.taken`; every 60 s real time `media.prune(policy, tag,
keep)` with `keep` = `incidents.keys()`.

Determinism: all Phase 5 sim state changes run in fixed steps from named streams (`force`, `conduct`, `court`) or pure
functions; report choices and cross-examinations are pure functions of (seed, key / case id, log); the courtroom's
answers and the IA statement become queued requests; snapshots, the media store, the review panel and the MDT never
feed back. `mediaTag` (the snapshot namespace) lives in the app (`String(Date.now())` at a new game, persisted in
`localStorage` per save slot; tests never see it). The replay test compares v7 saves bit-identically.

**Workers: none added.** Each assessment is ≤ 1 ms for a 600-event log and runs at most once per fixed step (queued
at incident close), so it fits the sim budget without the latency and ordering problems a worker would bring (its
result feeds IA / trust in the same step, which must stay deterministic). JPEG encoding is already off the main
thread inside the browser's `toBlob`; the only synchronous cost is the 160×90 `drawImage`. `src/legal` is DOM-free and
dependency-free, so a later phase can move batch re-evaluation (e.g. re-judging the whole career under another
jurisdiction) into the Phase 0 sim worker unchanged.

## 16. Save schema v7 (integrator only)

```ts
export interface SaveGameV7 extends SaveGameV6 {
  force: ForceSave;          // tool, ammo, TASER attachment / cycles, fellow episode, rng
  incidents: IncidentsSave;  // jurisdiction, open + retained closed logs (≤ 24 closed, ≤ 600 events each), cam state, pursuit sampler
  conduct: ConductSave;      // trust per district, career (status, points, credibility, commendations, discipline, IA cases, report grades), rng
  court: CourtSave;          // cases (≤ 60), rng
}
// npc ActorSave optional ra/rs/at/ak + a dead flag bit; dialogue SubjectMemory optional miranda; scene pursuit saves keep optional owner/person.
```
`CURRENT_SAVE_VERSION = 7`. `migrateV6ToV7(data)`: `force: defaultForceSave(stream('force'))`, `incidents:
emptyIncidentsSave('generic')`, `conduct: newConductSave(stream('conduct'))` (trust = baselines, active, credibility
0.85), `court: emptyCourtSave(stream('court'))` with `stream(name) = createRng(data.seed).stream(name).state()`. Load
order: … investigation → station → **force** → **incidents** → **conduct** → **court** → radio → primeContacts.
`isSaveGameV7` = v6 checks + `isForceSave`, `isIncidentsSave`, `isConductSave`, `isCourtSave`. Tests (`test/save`):
v1..v6 → v7 migrate and validate; v7 round trip; each malformed new block rejected; a migrated v6 save plays a
traffic stop and closes an incident.

## 17. Performance budget (60 FPS, mid-range desktop)

| Subsystem | Budget | Notes |
|---|---|---|
| Force step | ≤ 0.01 ms/step avg; apply ≤ 0.1 ms | cone search over ≤ 64 actors on requests only; fellow check 4 Hz |
| NPC resistance | ≤ +0.005 ms/step | three timestamps per actor, computed on `actor()` / `resistance()` calls only |
| Incident recorder | ≤ 0.01 ms/step avg | event-driven; pursuit sample 1 Hz; appends allocate (rare events) |
| Legal assessment | ≤ 1 ms per incident (600 events), ≤ 1 per step | queued at close; cached; recomputed on demand for open logs (UI ≤ 1 Hz) |
| Report choices | ≤ 0.5 ms per build | cached per log length |
| Conduct / court steps | ≤ 0.005 ms/step | per game minute work only |
| Cross-exam generation | ≤ 1 ms once per hearing | |
| Snapshot capture | ≤ 1.5 ms on a capture frame (160×90 `drawImage`), ≤ 1 per 3 sim s | `toBlob` async; ~3-4 KiB per JPEG |
| Media store | async only; prune every 60 s | caps 3 000 snapshots / 16 MiB / 200 per incident |
| Review panel | image swap only when the nearest snapshot changes; ≤ 30 Hz scrub | object URLs revoked |
| MDT Career / Community | rebuild on revision only, ≤ 4 Hz | |
| HUD additions | DOM writes on change at the HUD 10 Hz rate | |
| Save size | + ≤ 300 KiB typical, ≤ 1.5 MiB worst | 24 closed logs × 600 events cap |
| Per-frame allocations | none in hot loops | strings only on events / throttled UI |

## 18. Requirement map

| Requirement | Code |
|---|---|
| Jurisdiction-aware legal engine, data-driven JSON rulesets, default generic US state law + an alternate | `src/legal/ruleset.ts`, `src/data/legal/rulesets/generic.json`, `strict.json` (§5.3 differences), main-menu jurisdiction, `incidents.request(jurisdiction)`, console `jurisdiction` |
| Reasonable suspicion, probable cause, Terry stops, SITA, consent, exigency, Miranda, use-of-force continuum, duty to intervene, pursuit policy, admissibility | `src/legal/evaluate.ts` (§5.8), `force.ts`, `pursuit.ts`, `scores.ts`; tests §5.10 |
| Structured event log built from Phase 2-4 events → determinations with citations | `src/incidents` (§9.3 mapping of `scene:*`, `cad:*`, `dispatch:*`, `traffic:*`, `contact:*`, `npc:*`, `investigation:*`, `interior:*`, `force:*`), `Determination.ruleIds` + `citation()` |
| Use-of-force tools (presence … firearm), TASER cartridges / spread / hit / 5 s cycles / limits / risk factors, K9, less-lethal, firearm hit + NPC injury | `src/force/models.ts`, `forceSystem.ts`, `data/force/force.json`, npc `incapacitate` / `wound` / `taserCycle`, people injury / deceased |
| Articulable justification per application, scored; NPC resistance levels from Phase 3 behaviour | npc `resistance()` (§4.2), `force:applied.resistance`, `forceVerdict` live (`incident:forceVerdict` HUD line) and in the assessment, report `res:` statements graded |
| Reports graded (completeness, contradictions with bodycam / log, unsupported conclusions) | `buildReportChoices` (§5.9), MDT statements checklist, `gradeReport` (§10.2) |
| Bad stops / searches → cases dismissed (evidence suppressed) | `EvidenceRuling`, `motionRulings`, `evidenceStrength`, court verdict `dismissed` |
| Excessive force → IA (bodycam review UI), civil suits, suspension, criminal charges | `iaTriggers`, `IaCase`, `EvidenceReviewPanel` + `iaReview`, `resolveIa`, `disciplineFor`, duty status |
| Commendations and community trust for good policing | `commendationsFor`, conduct verdict rules, trust deltas |
| Community trust per district → cooperation, tips, hostility, crime rates; persisted; on the MDT | `ConductState` trust (save), `trustEffects` → contact `trustAt`, scene `trustAt` / `errorScaleAt` / `hostilityAt`, `Dispatcher.setCrimeFactor`, MDT Community tab |
| Court: cases from arrests / citations, subpoena on the calendar, courtroom cross-examination from reports + log, inconsistency hurts credibility and outcome | `CourtState`, `scheduleHearing`, HUD court line + Career calendar, `CourtroomPanel`, `generateCrossExam`, `scoreTestimony`, `convictionChance` |
| Bodycam / dashcam: event stream + periodic low-res snapshots in IndexedDB with caps / retention, timestamps; playback / review UI; activation / muting judged by policy | cam bits on every `IncidentEvent`, `SnapshotScheduler`, `captureSnapshot`, `IdbMediaStore` (`patrol-media`), `EvidenceReviewPanel` (scrubber, events, snapshots), ruleset `recording` doctrine |
| Save version + tested migration | §16 |
| Determinism, perf, no new dependencies | §15, §17, §19 blockers: none |

## 19. Modules, ownership and waves

| Key | Wave | Owns (exclusively) | May import (new Phase 5 code) |
|---|---|---|---|
| legal | 1 | `src/legal/**`, `src/data/legal/**`, `test/legal/**` | none |
| force | 1 | `src/force/**`, `src/data/force/**`, `test/force/**` | none |
| hooks | 1 | `src/npc/**`, `src/contact/**`, `src/dialogue/**`, `src/scene/**`, `src/calls/**`, `src/dispatch/generator.ts`, `src/dispatch/dispatcher.ts`, `src/data/npc/**`, `src/data/dialogue/**`, `src/data/scene/**`, `src/data/calls/**`, `test/npc/**`, `test/contact/**`, `test/dialogue/**`, `test/scene/**`, `test/calls/**`, `test/dispatch/generator.test.ts`, `test/dispatch/crimeFactor.test.ts` | none |
| recording | 1 | `src/recording/**`, `src/ui/review/**`, `src/data/recording/**`, `test/recording/**`, `test/review/**` | none |
| incidents | 2 | `src/incidents/**`, `src/data/incidents/**`, `test/incidents/**` | legal, force (types/events), hooks (events) |
| conduct | 2 | `src/conduct/**`, `src/data/conduct/**`, `test/conduct/**` | legal |
| court | 2 | `src/court/**`, `src/data/court/**`, `test/court/**` | legal |
| ui | 3 | `src/ui/mdt/**`, `src/ui/court/**`, `src/ui/ia/**`, `src/ui/hud/**`, `src/ui/mainMenu.ts`, `src/input/actions.ts`, `src/input/bindings.ts`, `test/mdt/**`, `test/courtui/**`, `test/iaui/**`, `test/hud/**`, `test/input/actions.test.ts`, `test/input/bindings.test.ts`, `test/mainMenu/**` | all |
| integrator | 4 | `src/app.ts`, `src/game/**`, `src/core/event-map.ts`, `src/ecs/components.ts`, `src/save/**`, `docs/PHASES.md`, `scripts/smoke.mjs`, and unowned files (`docs/ARCHITECTURE.md`, `README.md`, `src/people/**`, `src/station/**`, `src/investigation/**`, other `src/dispatch/**`, `test/game/**`, `test/save/**`, other tests) | all |

A module that needs a change in a file it does not own lists it for the integrator in its final report instead of
editing it.

## 20. Integrator plan

1. **Save v7** (`src/save/**`, `test/save/**`): types, validators, `migrateV6ToV7`, fixtures, tests (§16).
2. **Session** (`src/game/session.ts` + a new `src/game/phase5.ts` for the wiring helpers): build `ForceSystem`
   (`rng.stream('force')`; ports: npc, people, scene (`setWeapon`, `serviceArrived`), `armoryHas` = station armory,
   `temperatureC` = env weather, `elevatedAt` = interior room kind at (x, z) ∈ `force.json` `elevatedRoomKinds`,
   `fellows` = the tactical partner when active), `IncidentSystem` (ports §9.1 over CAD / scene / contact / records /
   investigation / interiors / equipment / env / traffic; `pursuitProbe` from the driven car's telemetry and the road
   graph's zone limit), `ConductState` (`rng.stream('conduct')`, `districtOf(key)` = the log's district),
   `CourtState` (`rng.stream('court')`, `ruleset` = `incidents.ruleset`, `reportGrade(key)` = the latest graded
   report of the incident); register force -685, incidents -660, conduct -658, court -656. Scene deps `trustAt` /
   `errorScaleAt` / `hostilityAt` and contact `trustAt` from `conduct.effects(districtOf(x, z))`;
   `dispatcher.setCrimeFactor((d) => conduct.effects(d).crimeFactor)`. Bridges §14. Duty status: when not `active`
   the player unit is `outOfService` (dispatcher request) and offers are declined automatically; back to available
   when the suspension ends. Booking / citation final → court open (personLabel from the incident's people).
   Serialize / load v7 in the §16 order; dispose force, incidents, conduct, court before investigation.
3. **App** (`src/app.ts`): input remap (C, mouse 0, H, J, pursuit lights-off → terminate), `createMediaStore()`,
   `SnapshotScheduler`, capture after render, prune; `CourtroomPanel` (opened on `court:session`, submit →
   `court.request(testify)`), `EvidenceReviewPanel` + `iaReview` (Career → REVIEW; submit →
   `conduct.request(iaStatement)`), MDT deps (§12.1), HUD feed fields (§12.4), main-menu jurisdiction → new game →
   `incidents.request({ kind: 'jurisdiction', id })` at start; radio lines for advisories / subpoenas / IA; perf
   extras `force`, `incidents` (open / closed / events), `media` (count / KiB).
4. **Console** (`src/game/phase5Commands.ts`): `jurisdiction [id]`, `incident list | show [key] | close <key>`, `legal
   [key]` (determinations with citations), `force tool <id> | fellow | stats`, `trust [district [delta]]`, `career`,
   `ia list | statement <caseId> <n>`, `court list | advance <caseId> | attend <caseId>`, `cam mute | dash`,
   `media stats | clear`.
5. **Determinism test** (`test/game/phase5.test.ts`): new game on patrol; a spawned traffic stop with an observed
   speeding violation (or a forced violation through the recorder's port), driver contact, odor, consent PBT, cuff,
   Miranda, a custodial question, a TASER application on a forced `fight` actor, booking → court case; close the
   call → assessment, conduct trust event; two runs → bit-identical v7 saves; a load mid-incident continues exactly;
   a v6 save loads (incidents empty, trust baselines).
6. **Smoke** (`scripts/smoke.mjs`): Phase 5 steps: draw the TASER (C), fire at a fighting actor (HUD verdict line), a
   frisk without suspicion → `legal` shows the unlawful frisk, the MDT report statements and grade, Career tab with a
   subpoena, `court advance` + attend → courtroom answers → verdict, an IA case → review panel with ≥ 1 snapshot
   (SwiftShader canvas), Community tab, save / load v7; screenshots `phase5-court.png`, `phase5-review.png`,
   `phase5-mdt.png`.
7. **Docs**: event-map comment, `ARCHITECTURE.md` Phase 5 sections, `PHASES.md` Phase 5 entry (controls,
   checklist, perf, limitations), README controls.

## 21. Known limitations and later-phase hooks

- The legal model is a simplified, generic teaching model, not legal advice; rule citations are invented.
- Report narratives are free text and not parsed; grading uses the statements checklist.
- Snapshots come from the rendered game view (the dashcam is the same view while the officer is in the car); no
  video or audio is stored; media lives in the browser's IndexedDB and is not part of the save slot (a deleted
  browser profile loses the footage but not the event log).
- The courtroom hearing takes place off-clock (no sim time passes); there is no courthouse building.
- The only fellow officer who can misbehave is the partner placeholder; AI units on scene do not use force.
- Pregnancy and elevated position are derived risk factors (hash / room kind) and are not visible on the figure.
- Pursuits are judged on the officer's own speed and equipment; bystander risk and the fleeing car's driving are not
  modelled.
