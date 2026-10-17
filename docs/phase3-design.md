# Phase 3 design: People and Calls

Status: design (technical director). Implementation is split into 8 modules (§19) plus an integrator (§20).
Read with `docs/ARCHITECTURE.md`, `docs/phase1-design.md` (§2 conventions), `docs/phase2-design.md` (§2
conventions, §5 records, §6 CAD, §8 dispatch) and `docs/research/*.md`. Every builder reads §1-§3 and the
sections named in its brief. Names, ids and shapes in this document are contracts: do not rename them.

## 1. Scope

At the end of Phase 3 the city is populated and calls are scenes, not just CAD rows:

- Every person in the 100 000-person registry (Phase 2 records) has a persistent in-world identity
  (name, DOB, address, employer, vehicle, family, history, temperament, intoxication, health, mental
  health, attitude, language, hearing, hidden items). The CAD record and the person are the same entity
  (same id); identities are generated lazily from `(seed, id)` and only *deltas* of touched persons are saved.
- Ambient pedestrians walk the sidewalks near the player (density by district and hour); drivers and
  passengers sit visibly in nearby traffic cars and can be ordered out at a stop.
- People are procedural instanced humanoids (no external models). The officer can approach and talk,
  order stop / hands up / get down / follow / step out, frisk, search with consent, request ID (the person
  may refuse, lie or hand a fake ID), cuff / uncuff, escort and place a prisoner in a patrol car cage,
  run PBT and a field-sobriety minigame, check a vehicle interior, tackle a runner, draw a sidearm or a
  TASER (placeholder use-of-force hooks for Phase 5).
- A data-driven dialogue system (officer utterances by topic and tone, NPC responses driven by demeanor,
  tone, presence, time, intoxication, temperament, prior contacts, neighborhood trust; deaf / hard of
  hearing, non-English, juvenile, dementia and crisis behaviour), subtitles, and a statement log per
  person per incident. A lie model and an inconsistency engine list the contradictions the player has
  *discovered* (never undiscovered ones).
- 163 new call types (175 with Phase 2's 12) in `src/data/calls/`, grouped into 27 families with shared
  scene templates (roles, spots, behaviour profiles, evidence, vehicles, branches, actions, objectives,
  outcomes). Calls may escalate, de-escalate, be false, duplicated (linked CAD calls), swatting or an
  ambush; dispatch information is imperfect and corrected live in the CAD narrative.
- Vehicle pursuits (basic flee), foot pursuits (chase and tackle), barricades (contain and wait for a SWAT
  stub), K9 / EMS / fire / coroner / interpreter / animal control / tow / bomb squad service stubs.
- Every call ends with a disposition (arrest, citation, report only, unfounded, referred, transported,
  GOA, ...) in CAD and a graded `CallOutcome` record for Phase 5.

Non-goals (later phases): real use-of-force model and firearm discharge (Phase 5: only hooks/events here),
officer injury, NPC physics bodies and collisions with cars or the officer, NPCs entering buildings,
pursuit tactics (PIT, spike strips: Phase 6), juveniles under 16 (the registry is 16-90), voice dialogue.

## 2. Conventions (in addition to Phase 1 §2 and Phase 2 §2)

- **TS rules** unchanged: no enums, namespaces or parameter properties; `as const` objects + unions;
  `import type`; `noUncheckedIndexedAccess`; strict. Match the existing code style (JSDoc on exports,
  `readonly` view interfaces, `scratch*` module-level temporaries for hot loops).
- **Determinism.** All simulation (people state, pedestrians, actors, dialogue, scenes, services,
  pursuits) runs in fixed steps and draws only from named streams:
  `session.rng.stream('npc')` (children `'peds'`, `'actors'`), `session.rng.stream('scene')`,
  `session.rng.stream('contact')`; scenario generation uses `createRng(seed).stream('scenario:' + callId)`
  (a pure function of seed and call id). Identity traits use integer hashing (`records/hash.ts`
  `hash3`, `unitHash`) of `(seed, salt, id)` (and the epoch day for daily traits): no stream, no state.
  `Math.random`, `Date.now`, `performance.now` are forbidden in `src/people`, `src/calls`, `src/npc`,
  `src/dialogue`, `src/contact`, `src/scene`, `src/traffic`, `src/dispatch`.
- **UI → sim through queues.** The dialogue panel, scene panel, SFST panel and officer keys produce
  request objects; `ContactManager.request` / `SceneDirector.request` queue them and apply them at the
  start of their next fixed step (the Phase 2 dispatcher pattern). Bus handlers only enqueue, except the
  integrator's `scene:radio` → `RadioSystem.say` bridge (synchronous, inside the fixed step).
- **Two clocks** as Phase 2: sim seconds drive timers; game seconds (30x) are displayed and used for
  time-of-day effects (`clockParts(game)` in `dispatch/generator.ts`: hour, weekday).
- **Data** in `src/data/<area>/*.json`, `"version": 1`, validated at import by a typed validator that
  throws `Error` naming the file and the JSON path (pattern: `src/cad/data.ts`, `src/environment/validate.ts`).
  Multi-file folders are loaded with `import.meta.glob('<dir>/*.json', { eager: true, import: 'default' })`
  and processed **sorted by path** (generation order must not depend on the file system).
- **Headless.** DOM / THREE classes construct and run as no-ops without `document` / WebGL (vitest runs in
  node), keeping their pure model testable (pattern: `ui/panels/actionPanel.ts`).
- **Generic content only.** No real agency, company, brand, product, place, person or programme names
  (no trademarked alert programme names). Language names (Spanish, Vietnamese...) are fine. Employers are
  generic ("Riverside Diner"). No real-person likeness: faces are plain boxes, skin tones a neutral palette.
- **Ids.** Person ids `0..99 999` (Phase 2). Actor ids are positive integers from 1, never reused within a
  save (`nextActorId`). Item instance ids are strings `"<ownerKind><ownerId>:<itemId>:<n>"`, e.g.
  `"p17:knife:0"`, `"v4021:openContainer:0"`. Incident keys are strings: `"C-00042"` (a call number) or
  `"FC-<personId>-<epochDay>"` (field contact without a call).
- **Fixed lists.** Several modules reference each other's data ids before both exist (parallel waves).
  The lists in §4.0 are contracts: the owning module must provide every listed id (it may add more);
  referencing modules validate against the list constants, and the scene module cross-checks at load.

## 3. Architecture

```
 fixed step (60 Hz, deterministic)
 ┌──────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ dispatch (-700) ── cad:callCreated ──▶ SceneDirector (scene, -690) ──buildScenario──▶ calls (pure)    │
 │     ▲  requests                         │ materialize: spawnActor / spawnSubjectCar / props          │
 │     │                                   │ timeline → CAD narrative, priority, linked calls           │
 │     │                                   │ actions, services, pursuits, officer weapon/tackle/TASER   │
 │     │                                   ▼                                                             │
 │ ContactManager (contact, -680) ◀── open/requests ── UI ; dialogue.respond (pure) ; tools (pure)       │
 │     │ statements/facts ─▶ Population (people) deltas      inconsistencies = findInconsistencies(facts)│
 │     │ commands/cuff/escort ─▶ NpcSystem                                                               │
 │ radio (-650)  ◀── scene:radio (bridge: RadioSystem.say)                                               │
 │ traffic (50): stops, yield, fleet, + flee mode, subject/scene cars                                    │
 │ NpcSystem (npc, 60): ambient pedestrians (LOD), actors FSM (LOD), occupants, view arrays             │
 └──────────────────────────────────────────────────────────────────────────────────────────────────────┘
 per frame (presentation only)
   NpcSystem.view + officer figure ─▶ PeopleRenderer (instanced humanoids, ≤ 8 draw calls)
   SceneDirector.props ─▶ PropRenderer (cones, flares, tape, evidence)
   ContactManager.view() ─▶ DialoguePanel / SfstPanel (DOM, on revision change ≤ 10 Hz)
   scene:line / contact:line ─▶ SubtitleBar (+ SpeechOut for English speakers)
   SceneDirector.hud() + contact chip + weapon ─▶ HUD (10 Hz), minimap markers
```

- **People are not ECS entities.** Pedestrians and actors live in SoA pools inside `NpcSystem` (like the
  traffic view), with no physics bodies. They are rendered from a read-only view; no new ECS component
  (`src/ecs/components.ts` unchanged; `KIND.Civilian` stays reserved).
- **Population (people)** is the identity and state layer: pure generators of `(seed, id)` plus a delta
  map of touched persons, on top of `RecordsDb` (records are part of the people module this phase).
- **Calls (calls)** is pure data + pure engine: catalog, schema validation, scenario builder (hidden
  truth), variants, conditions, outcomes, reachability. It also owns CAD (`src/cad/**`) to merge the
  catalog into the CAD call-type table and to add CAD features (linked calls, dispositions, statutes).
- **NpcSystem (npc)** moves people and decides their reactions (behaviour state machine with compliance,
  flee, fight, surrender), with tick LOD.
- **Dialogue (dialogue)** is pure: utterance/response engine, lie model, inconsistency engine, field tools.
- **ContactManager (contact)** runs conversations: it binds a person (actor, pedestrian, or car occupant)
  to an incident, calls the dialogue engine, records statements and facts, executes field actions
  (frisk, search, PBT, SFST, ID check, cuff, escort, cage, release, cite), and presents `DialogueView`.
- **SceneDirector (scene)** runs scenarios: from CAD call creation to materialization, timeline, actions,
  services, pursuits, officer tactics, outcome and disposition; it also owns dispatch (`src/dispatch/**`)
  for the Phase 3 dispatcher changes.
- **Presentation (presentation)** owns the humanoid / prop renderers, the dialogue / SFST / subtitle DOM,
  the HUD additions and the new input actions.

## 4. Data formats

### 4.0 Fixed id lists (contracts)

| List | Ids | Defined by | Referenced by |
|---|---|---|---|
| `ITEM_IDS` (26) | `driversLicense fakeId wallet phone keys cashRoll openContainer liquorBottle cannabis narcotics pills syringe pipe knife handgun brassKnuckles burglaryTools stolenGoods sprayPaint creditCards backpack suspiciousPackage shellCasing bloodEvidence brokenGlass threatNote` | people `src/data/people/items.json` | calls (roles/evidence), dialogue (tools), scene, contact |
| `PROFILE_IDS` (32) | `bystander callerHelpful callerUpset victimDistraught victimInjured witnessReluctant suspectCalm suspectNervous suspectEvasive suspectAgitated suspectHostile suspectArmedHostile suspectFleeRisk subjectCrisis subjectSuicidal subjectIntoxicated subjectConfused subjectUnconscious subjectDeceased juvenileScared guardianWorried protester crowdMember ambusher barricaded driverCooperative driverNervous passenger residentInnocent securityGuard animalDog animalAggressiveDog` | npc `src/data/npc/behaviors.json` | calls (roles), scene |
| `SERVICE_KINDS` (11) | `ems fire hazmat swat k9 coroner interpreter animalControl bombSquad tow supervisor` | calls `src/data/calls/services.json` | scene, contact (interpreter) |
| `VARIANT_KINDS` (6) | `escalation deescalation false duplicate swatting ambush` | calls | scene, tests |
| `SPOTS` (10) | `door curb yard street roadside vehicle inside hidden crowd distance` | calls | scene (placement) |
| `NPC_COMMANDS` (17) | `stop handsUp getDown turnAround comeHere stayBack followMe sitDown stepOut dropWeapon showHands leaveArea disperse calmDown turnOffEngine tossKeys walkBackward` (+ internal `release`, `returnToVehicle`) | npc | dialogue utterances, contact, scene |
| `FACT_TOPICS` (16) | `name dob address identity idCard appearance destination origin account drinking drugs weapons vehicleContents vehicleOwner injured suspectWhereabouts` | dialogue | contact, people (stored as strings) |
| `DRUG_KINDS` | `none cannabis stimulant opioid depressant` | people | npc, dialogue |
| `TRUNK_ITEM_IDS` (Phase 2) | `cones flares firstAid aed spikeStrip evidenceKit fireExtinguisher trafficVest` | police (Phase 2) | calls actions `consumes` |

Each list is exported as a `readonly` tuple constant **by the referencing module too** (e.g. calls exports
`ITEM_IDS`, `PROFILE_IDS`) so wave-1 modules can validate without importing each other. The scene
module's test asserts that the defining data contains every listed id.

### 4.1 People data [people] `src/data/people/`

`people.json`
```jsonc
{ "version": 1,
  "temperament": { "calm": 0.45, "timid": 0.2, "irritable": 0.25, "volatile": 0.1 },
  "honesty": { "min": 0.35, "max": 1.0, "riskPenalty": 0.45 },          // honesty = lerp(min,max,u) - risk*riskPenalty, clamp 0..1
  "attitude": { "min": -0.3, "max": 0.8, "perPrior": -0.06, "perArrestPrior": -0.15, "gang": -0.35, "minClamp": -1, "maxClamp": 1 },
  "language": { "englishShare": 0.9,
                "others": [ { "id": "spanish", "label": "Spanish", "weight": 6 }, { "id": "vietnamese", "label": "Vietnamese", "weight": 2 },
                            { "id": "mandarin", "label": "Mandarin", "weight": 2 }, { "id": "arabic", "label": "Arabic", "weight": 1 },
                            { "id": "russian", "label": "Russian", "weight": 1 }, { "id": "tagalog", "label": "Tagalog", "weight": 1 },
                            { "id": "portuguese", "label": "Portuguese", "weight": 1 } ],
                "noEnglishShare": 0.4 },                                // of non-English speakers: 'none', the rest 'limited'
  "hearing": { "deaf": 0.006, "hardOfHearing": 0.025, "elderlyHardOfHearing": 0.15, "elderlyAge": 70 },
  "dementia": { "minAge": 70, "rate": 0.1 },
  "mental": { "withRecordNote": { "depression": 2, "bipolar": 1, "schizophrenia": 1, "ptsd": 1 }, "baseRate": 0.04,
              "base": { "anxiety": 2, "depression": 2 } },
  "health": { "diabetic": 0.06, "epilepsy": 0.01, "heart": { "rate": 0.08, "minAge": 50 }, "asthma": 0.05 },
  "drinking": { "propensityExponent": 2, "weekday": [0.5, 0.5, 0.6, 0.7, 1.0, 1.3, 0.9], "sessionRate": 0.6,
                "startHour": [17, 23], "durationH": [1.5, 5], "peakBac": [0.02, 0.2], "riseH": 1, "eliminationPerHour": 0.015 },
  "drugs": { "rate": 0.06, "riskFactor": 2.5, "kinds": { "cannabis": 6, "stimulant": 2, "opioid": 1, "depressant": 1 }, "dailyUseRate": 0.5 },
  "employment": { "employers": ["Riverside Diner", "Northside Hardware", "City Hospital", "Metro Transit", "Elm Street Grocery",
                  "Harbor Freight Yard", "Lakeview School District", "Summit Construction", "Pinecrest Auto Repair", "Oak Valley Clinic",
                  "Central Library", "Bayside Warehouse", "Maple Street Bakery", "Westgate Mall Security", "City Sanitation",
                  "Granite Insurance Office", "Sunrise Daycare", "Coastal Shipping Office", "Midtown Hotel", "County Records Office"],
                  "unemployed": 0.08, "retiredAge": 66, "studentMaxAge": 22, "studentShare": 0.5 },
  "appearance": {
    "skinTones": ["#f1c9a5", "#e0ac69", "#c68642", "#a26a42", "#8d5524", "#5c3a21"],
    "hair": { "black": "#1b1b1b", "brown": "#4b3621", "blond": "#c9a54e", "red": "#8d3b1f", "gray": "#9c9c9c", "bald": null },
    "tops": [ { "name": "black", "hex": "#1c1c1f" }, { "name": "white", "hex": "#e8e8e8" }, { "name": "gray", "hex": "#7a7a7a" },
              { "name": "red", "hex": "#a3262a" }, { "name": "blue", "hex": "#2b4f9e" }, { "name": "green", "hex": "#2f6b3a" },
              { "name": "yellow", "hex": "#d1b32c" }, { "name": "brown", "hex": "#6b4a2b" }, { "name": "navy", "hex": "#1d2a4a" },
              { "name": "orange", "hex": "#c8642a" } ],
    "bottoms": [ { "name": "blue jeans", "hex": "#34507a" }, { "name": "black pants", "hex": "#1e1e22" }, { "name": "khaki pants", "hex": "#a8946a" },
                 { "name": "gray pants", "hex": "#5f6266" }, { "name": "dark shorts", "hex": "#2c2c30" } ] },
  "items": { "daily": { "phone": 0.92, "wallet": 0.85, "keys": 0.8, "cashRoll": 0.02, "backpack": 0.15 },
             "driversLicenseCarry": 0.9, "fakeIdIfRisk": 0.06,
             "knife": 0.03, "knifeIfSafetyNote": 0.3, "handgunIfSafetyNote": 0.35, "handgunIfRegistered": 0.06,
             "brassKnucklesIfGang": 0.1, "drugsIfUser": 0.5, "paraphernaliaIfUser": 0.4, "stolenGoodsIfRisk": 0.03,
             "creditCardsIfRisk": 0.02 },
  "vehicleItems": { "openContainerIfDrinking": 0.35, "liquorBottleIfDrinker": 0.08, "drugsIfUser": 0.25, "weaponIfCarrier": 0.3,
                    "stolenGoods": 0.01, "burglaryToolsIfRisk": 0.03 },
  "occupants": { "passengers": [0.6, 0.28, 0.09, 0.03] },               // P(0..3 passengers) for registry vehicles
  "family": { "clusterSize": 3 } }
```
`items.json` — the item table (every id of `ITEM_IDS`):
```jsonc
{ "version": 1, "items": [
  { "id": "openContainer", "label": "Open container of alcohol", "category": "alcohol", "contraband": false, "weapon": false,
    "concealment": 0.1, "odor": "alcohol", "statute": "TR-361", "prop": "bottle", "inVehicle": true },
  { "id": "handgun", "label": "Handgun", "category": "weapon", "contraband": false, "weapon": true, "concealment": 0.4,
    "odor": null, "statute": "PC-262", "prop": "handgun", "inVehicle": true }
  /* ... */ ] }
```
Fields: `id`, `label`, `category` (`document | personal | alcohol | drugs | paraphernalia | weapon | tools |
property | evidence`), `contraband` (illegal to possess), `weapon`, `concealment` 0..1 (0 obvious, 1 well
hidden; frisk/search find chance uses it), `odor` (`"alcohol" | "cannabis" | null`), `statute` (statute id
or null; charge suggestion), `prop` (a `PROP` name of §12.1 or null), `inVehicle` (may be placed in a car).
Suggested values: documents/personal concealment 0.1-0.3; drugs 0.6; knife 0.5; handgun 0.4; fakeId 0.2;
`cannabis` odor cannabis; `openContainer`/`liquorBottle` odor alcohol; evidence items (shellCasing,
bloodEvidence, brokenGlass, threatNote, suspiciousPackage) are ground items, concealment 0.2.

### 4.2 Calls catalog [calls] `src/data/calls/`

Files: `families.json` (27 families), `types/<family>.json` (one per family, 163 new types), `actions.json`
(scene action library), `services.json` (service stubs), `variants.json` (rates), `legacy.json` (families
of Phase 2 types). All `"version": 1`.

**Condition language** (`Cond`), used by outcomes, objectives and action requirements:
```ts
type Cond = string | { all: Cond[] } | { any: Cond[] } | { not: Cond };
// string atom = a flag name (§11.3); "true" is always true; a leading "!" negates an atom ("!custody:suspect").
```

`families.json`
```jsonc
{ "version": 1, "families": [
  { "id": "domestic", "label": "Domestic disturbance", "anchor": "door",
    "defaults": {                                     // CAD row defaults merged under every type row of the family (row wins)
      "codeKey": null, "priority": { "2": 0.6, "3": 0.4 }, "location": "block", "units": [1, 2], "onSceneS": [240, 600],
      "callers": { "citizen": 0.85, "anonymous": 0.15 }, "districts": { "industrial": 0.3, "highway": 0, "water": 0 },
      "dispositions": ["arrestMade", "reportTaken", "handled", "referred", "unfounded", "goneOnArrival"] },
    "roles": [
      { "role": "caller", "count": [1, 1], "person": "caller", "spot": "curb", "profile": "callerUpset" },
      { "role": "victim", "count": [1, 1], "person": { "minAge": 18 }, "spot": "door", "profile": "victimDistraught" },
      { "role": "suspect", "count": [1, 1], "person": { "minAge": 18, "risk": true }, "spot": "inside", "profile": "suspectAgitated",
        "items": [ { "item": "knife", "chance": 0.08 } ], "intoxication": { "chance": 0.5, "bac": [0.06, 0.18], "drug": "none" } } ],
    "vehicles": [],
    "evidence": [ { "item": "brokenGlass", "spot": "door", "chance": 0.3 } ],
    "describe": "suspect",                            // role described in the first CAD narrative update (null: none)
    "branches": [
      { "id": "verbal", "weight": 4 },
      { "id": "assault", "weight": 3, "flags": ["injury:victim"], "roleOverrides": { "victim": { "injured": 1, "profile": "victimInjured" } } },
      { "id": "suspectGone", "weight": 2, "remove": ["suspect"] },
      { "id": "weapon", "weight": 1, "roleOverrides": { "suspect": { "weapon": "knife", "profile": "suspectArmedHostile" } } } ],
    "variants": { "escalation": 1, "deescalation": 1, "false": 0.5, "duplicate": 1, "swatting": 0, "ambush": 0.2 },
    "escalation": { "narratives": ["Caller now reports the suspect is breaking things inside."],
                    "roleOverrides": { "suspect": { "profile": "suspectHostile" } } },
    "deescalation": { "narratives": ["Caller advises the suspect has calmed down and is sitting outside."],
                      "roleOverrides": { "suspect": { "profile": "suspectCalm", "spot": "curb" } } },
    "actions": ["knock", "separateParties", "requestEms", "photograph", "collectEvidence", "canvass", "requestInterpreter"],
    "objectives": [
      { "text": "Contact the reporting party", "done": "contacted:caller", "show": "role:caller" },
      { "text": "Locate and separate the parties", "done": { "any": ["separated", "custody:suspect"] } },
      { "text": "Get a statement from the victim", "done": "statement:victim", "show": "role:victim" },
      { "text": "Victim injured: request EMS", "done": "service:ems", "show": "injury:victim" } ],
    "outcomes": [
      { "id": "unfounded", "when": { "any": ["variant:false", "variant:swatting"] }, "disposition": "unfounded", "grade": "good" },
      { "id": "arrestSuspect", "when": "custody:suspect", "disposition": "arrestMade", "grade": "good" },
      { "id": "suspectFled", "when": { "any": ["escaped:suspect", "branch:suspectGone"] }, "disposition": "reportTaken", "grade": "ok" },
      { "id": "assaultNoArrest", "when": "branch:assault", "disposition": "reportTaken", "grade": "bad" },
      { "id": "verbalHandled", "when": { "all": ["statement:victim", "separated"] }, "disposition": "handled", "grade": "good" },
      { "id": "default", "when": "true", "disposition": "handled", "grade": "ok" } ] } ] }
```
Field rules (validator, `src/calls/catalog.ts`):
- `anchor` ∈ `door curb street intersection lot roadside vehicle`.
- `roles[]`: `role` (unique in the family, `[a-zA-Z]+`), `count` `[min, max]` ints 0..20, `person` =
  `"caller"` (the CAD caller's person id; only when the caller kind is citizen, else a random adult),
  `"driver"` (the true driver of the role's vehicle: `occupantsOf(seed, vehicleId)[0]`), `"given"` (ids
  passed by the creator: stops, field contacts), or a `PersonConstraint` object `{ minAge?, maxAge?,
  warrant?, mentalHealth?, risk?, sex? }`; `spot` ∈ `SPOTS`; `profile` ∈ `PROFILE_IDS`; optional `items`
  `[{ item, chance }]` (`ITEM_IDS`), `weapon` (`ITEM_IDS` with `weapon: true`, or null), `intoxication`
  `{ chance, bac: [a, b], drug }`, `injured` 0..1 (chance), `deceased` (bool), `body` (`"human" | "dog"`,
  default human; dogs have no person: `person` must be `{}` and is ignored), `vehicle` (a vehicle role id: the
  person is *associated* with that vehicle (incident vehicle, ownership questions) and sits in it only when
  `spot` is `vehicle`; when the family has exactly one vehicle role, `vehicle` defaults to it for roles with
  spot `vehicle` or person `driver`).
- `vehicles[]`: `{ role, count [0..2], mode: "driving" | "parked" | "crashed", behavior: "normal" | "dui",
  reported: bool (the CAD narrative's `{plate}` vehicle is this one), flee: 0..1 (chance the driver flees
  when the player lights it up) }`.
- `evidence[]`: `{ item, spot, chance }` ground items (props).
- `branches[]` (≥ 1): `{ id, weight > 0, flags?: string[], remove?: string[] (role or vehicle role ids),
  roleOverrides?: { [role]: Partial<{ count, person, spot, profile, items, weapon, intoxication, injured,
  deceased }> }, vehicleOverrides?: { [role]: Partial<{ count, mode, behavior, flee }> } }`. A family with
  `"derived": true` (trafficStop, contact) has branches chosen by the scene from the truth (§11.2), not by weight.
- `variants`: multiplier per `VARIANT_KINDS` (≥ 0; 0 disables). Derived families and `pursuit` use all 0.
- `escalation` / `deescalation`: `{ narratives: string[] ≥ 1, roleOverrides?, remove? }` or null (null with a
  multiplier > 0 is an error).
- `actions[]`: ids in `actions.json`. `objectives[]`: `{ text, done: Cond, show?: Cond }`.
- `outcomes[]` (≥ 1, last one must be `"when": "true"`): `{ id, when: Cond, disposition (dispositions.json id),
  grade: "good" | "ok" | "bad" }`. First match wins.
- Every flag atom used in a `Cond` must be in the flag vocabulary of §11.3 for that family (validator
  check: prefix known; role-scoped flags name an existing role; `branch:` names an existing branch;
  `variant:` a `VARIANT_KINDS` id; `service:` / `arrived:` a `SERVICE_KINDS` id; `itemFound:` an item id).

`types/<family>.json`
```jsonc
{ "version": 1, "family": "domestic", "types": [
  { "id": "domesticDisturbance", "label": "Domestic disturbance", "category": "domestic", "generated": true, "weight": 1.0,
    "narratives": ["RP reports {noise} coming from {address}.", "Neighbor reports a couple {noise} near {near}."],
    "fill": { "noise": ["yelling and screaming", "loud arguing", "things being thrown"] },
    "branchWeights": { "weapon": 0.5 } } ] }
```
A type row carries the Phase 2 CAD fields (any `defaults` field may be overridden in the row) plus:
`branchWeights` (optional: weight per branch id, missing = family weight, 0 disables; at least one
branch must stay > 0) and `variants` (optional multipliers that replace the family's for this type).
`label`, `category` (a `CRIME_CATEGORIES` id), `generated`, `weight` and `narratives` (≥ 2, placeholders as
Phase 2 §4.2) are required in every row. `codeKey` defaults to the family default.

`actions.json` — the scene action library:
```jsonc
{ "version": 1, "actions": [
  { "id": "knock", "label": "Knock and announce", "requires": "arrived", "sets": ["knocked"], "reveals": "inside", "once": true },
  { "id": "trafficControl", "label": "Deploy cones and flares", "requires": "arrived", "sets": ["trafficControl"],
    "consumes": { "cones": 2, "flares": 2 }, "props": { "kind": "cone", "count": 4, "pattern": "line", "spacing": 4 }, "once": true },
  { "id": "requestEms", "label": "Request EMS", "service": "ems", "once": true },
  { "id": "searchArea", "label": "Search the area", "requires": "arrived", "durationS": 20, "sets": ["areaSearched"], "reveals": "hidden" },
  { "id": "disperseCrowd", "label": "Order the crowd to disperse", "requires": "arrived", "command": { "command": "disperse", "roles": ["organizer", "protester", "agitator", "bystander"] } } ] }
```
Fields: `id`, `label`, `requires?: Cond`, `sets?: string[]` (flags set when done), `service?` (a
`SERVICE_KINDS` id: requests it; sets `service:<id>`), `reveals?: "inside" | "hidden"`, `durationS?`
(flags set after this many sim seconds; the player must stay within 60 m or it is cancelled), `once?`,
`consumes?: { [trunkItemId]: n }` (from the officer's kit; refused when missing), `props?: { kind (PROP name),
count, pattern: "line" | "ring" | "point", spacing?, radius? }`, `narrative?` (CAD narrative text),
`radio?` (radio line text; placeholders `{unit}`, `{address}`, `{near}`), `command?: { command (NPC_COMMANDS),
roles: string[] }`, `opens?: "citation" | "report"` (asks the integrator to open that MDT form).

The library must contain at least: `knock`, `separateParties`, `perimeter` (tape ring r 12, sets
`perimeter`), `trafficControl`, `preserveScene` (tape ring r 8, sets `scenePreserved`), `searchArea`,
`canvass` (30 s, `canvassed`), `photograph` (`photographed`), `collectEvidence` (requires `photographed`;
sets `evidenceCollected`; collects ground items as CAD evidence documents), `evacuate` (30 s, `evacuated`),
`disperseCrowd`, `secureAnimal` (requires `near:animal`, sets `animalSecured`), `notifyGuardian` (30 s,
`guardianNotified`), `firstAid` (consumes firstAid 1, sets `firstAid`), `citeVehicle` (sets `vehicleCited`,
opens citation), `writeReport` (opens report), `contain` (requires `arrived`, sets `contained` when the
player stays within 80 m for 60 s: `durationS` 60), and one `request<Service>` per service kind
(`requestEms`, `requestFire`, `requestHazmat`, `requestSwat`, `requestK9`, `requestCoroner`,
`requestInterpreter`, `requestAnimalControl`, `requestBombSquad`, `requestTow`, `requestSupervisor`).

`services.json`
```jsonc
{ "version": 1, "services": [
  { "id": "ems", "label": "EMS", "arriveS": [60, 150], "effect": "transportInjured", "sets": [],
    "radio": "{unit}, requesting EMS to {near}.", "ack": "Copy, EMS en route to {near}.", "arrivedText": "EMS on scene." } ] }
```
`effect` ∈ `none transportInjured resolveBarricade revealHidden removeDeceased interpreter secureAnimal towVehicles`
(§11.6). Values: ems 60-150 transportInjured; fire 90-180 none sets `fireOnScene`; hazmat 120-240 none sets
`hazmatHandled`; swat 150-300 resolveBarricade; k9 90-180 revealHidden; coroner 180-300 removeDeceased;
interpreter 60-120 interpreter; animalControl 120-240 secureAnimal; bombSquad 180-360 none sets
`areaCleared`; tow 120-240 towVehicles; supervisor 90-180 none.

`variants.json`
```jsonc
{ "version": 1,
  "rates": { "escalation": 0.12, "deescalation": 0.08, "false": 0.1, "duplicate": 0.15, "swatting": 0.02, "ambush": 0.01 },
  "escalation": { "delayS": [40, 180], "priorityDelta": -1 },
  "deescalation": { "delayS": [40, 180], "priorityDelta": 1 },
  "duplicate": { "callers": [1, 3], "delayS": [10, 90], "linkedCallChance": 0.5 },
  "ambush": { "triggerDistanceM": 20, "delayS": [3, 12] },
  "dispatchErrors": { "wrongAddress": 0.12, "wrongDescription": 0.15, "missingWeapon": 0.3,
                      "addressShiftM": [40, 120], "correctionDelayS": [30, 150] } }
```
Variant picking (`pickVariants`, §6.3): exclusive group `false | swatting | ambush` first (one draw:
`u < r_false*m` → false, else `u < r_false*m + r_swat*m` → swatting, else ... → ambush; `m` = the
type's multiplier for that kind), then `duplicate` independently, then one draw for `escalation` vs
`deescalation` (escalation if `u < r_esc*m`, else deescalation if `u < r_esc*m + r_de*m`). `false`,
`swatting` and `ambush` exclude escalation/deescalation.

`legacy.json` — `{ "version": 1, "families": { "trafficHazard": "hazard", "suspiciousVehicle": "inProgress",
"noiseComplaint": "disturbance", "welfareCheck": "welfare", "minorCollision": "collision", "alarm": "inProgress",
"suspiciousPerson": "inProgress", "parkingComplaint": "parking", "trafficStop": "trafficStop" } }` (the three
officer call types have no family: no scene).

### 4.3 The 27 families and 163 new types [calls]

Notation per family: anchor; CAD defaults (priority weights P1..P4, location, AI units, onSceneS);
roles `role(count) person @spot profile [items/weapon/intox]`; vehicles; branches (weight); variant
multipliers (esc/de/false/dup/swat/amb); actions; outcomes in order (`id: when → disposition grade`);
types (id — category, location override if any, `gen` = generated, weight, branch weights). Narratives and
fills are written by the builder (≥ 2 narratives per type, generic wording, Phase 2 placeholders only).
Every family also gets the `default: true → <first listed default disposition> ok` outcome last. `[c]` =
`person: "caller"`, `[a]` = `{ minAge: 18 }`, `[r]` = `{ minAge: 18, risk: true }`, `[w]` = `{ minAge: 18, warrant: true }`.

1. **trafficStop** (`derived`) — anchor vehicle; P4 road, units [1,1], onScene [180,420]. Roles: driver(1) given
   @vehicle driverCooperative; passenger(0-3) given @vehicle passenger. Vehicles: subjectVehicle(1) driving
   (the stopped car, not spawned). Branches (derived): stolenVehicle, wanted, dui, contraband, suspended, clean.
   Variants all 0. Actions: photograph, requestTow, requestSupervisor, requestInterpreter, writeReport.
   Outcomes: arrest: `{any:[custody:driver, custody:passenger]}` → arrestMade good; cited: `cited` →
   citationIssued good; warned: `warned:driver` → warningIssued good; fled: `escaped:driver` → reportTaken bad;
   missedDui: `{all:[branch:dui, !custody:driver]}` → handled bad. New types: none (Phase 2 `trafficStop`).
2. **contact** (`derived`) — anchor curb; P4 road, [1,1], [120,300]. Roles: subject(1) given @curb suspectCalm.
   Branches (derived): wanted, contraband, clean. Variants 0. Actions: photograph, writeReport, requestInterpreter.
   Outcomes: arrest `custody:subject` arrestMade good; cited `cited` citationIssued good; default handled ok.
   Types: `pedestrianStop` (category suspicious, road, not generated, weight 0), `fieldInterview` (suspicious,
   road, not generated, weight 0). Branches wanted/contraband/clean each weight 1 (derived: weights unused).
3. **dui** — anchor roadside; P2 .5 P3 .5, road, [1,1], [300,600]. Roles: driver(1) driver @vehicle subjectIntoxicated
   intox {chance 1, bac [0.08,0.22]} items openContainer .3; passenger(0-1) {minAge 16} @vehicle passenger.
   Vehicles: subjectVehicle(1) driving dui reported flee .1. Branches: drunk 6; drugged 2 (driver intox
   {chance 1, bac [0,0.03], drug "depressant"}); medical 1 (driver profile subjectConfused, intox null, flags
   [medicalEmergency]); tired 1 (intox null, profile driverNervous); asleepParked 0 (vehicleOverrides
   subjectVehicle mode parked; driver profile subjectIntoxicated). Variants 0.5/0.5/1/1/0/0. Actions:
   requestTow, requestEms, photograph, writeReport. Outcomes: unfounded `variant:false` goneOnArrival good;
   duiArrest `{all:[custody:driver, {any:[bacOver, sfstFail]}]}` arrestMade good; medicalTransport
   `{all:[branch:medical, transported:driver]}` transported good; medicalMissed `{all:[branch:medical,
   custody:driver]}` arrestMade bad; released `{all:[{any:[pbt:driver, sfst:driver]}, !bacOver, !sfstFail]}`
   handled good; fled `escaped:driver` goneOnArrival bad. Types (category `dui`, location road, generated):
   `impairedDriver` 1.0; `wrongWayDriver` 0.4; `recklessDriver` 0.8 (category traffic; tired 3);
   `driverAsleepAtWheel` 0.4 (asleepParked 1, others 0); `erraticDriverHighway` 0.5; `intoxicatedDriverParkingLot`
   0.4 (asleepParked 1, drunk 1, others 0).
4. **collision** — anchor intersection; P2 .3 P3 .7, intersection, [1,2], [300,600]. Roles: driverA(1) [a]
   @street driverCooperative vehicle vehicleA; driverB(1) [a] @street driverNervous vehicle vehicleB;
   passenger(0-2) {} @curb passenger; witness(0-2) {} @curb bystander. Vehicles: vehicleA(1) crashed,
   vehicleB(1) crashed. Branches: propertyOnly 5; injuries 3 (flags [injury:driverB], driverB injured 1
   profile victimInjured); duiDriver 2 (driverB intox {1,[0.09,0.2]} profile subjectIntoxicated); hitAndRun 2
   (remove [driverB, vehicleB], flags [hitAndRun]); singleVehicle 0 (remove [driverB, vehicleB]); pedestrian 0
   (remove [vehicleB], driverB spot curb injured 1 profile victimInjured, flags [injury:driverB]).
   Variants .3/.3/.3/2/0/0 (escalation overrides driverB profile suspectAgitated). Actions: trafficControl,
   requestEms, requestTow, requestFire, photograph, canvass, writeReport. Outcomes: unfounded `variant:false`
   unfounded good; duiArrest `{all:[branch:duiDriver, custody:driverB]}` arrestMade good; duiMissed
   `branch:duiDriver` reportTaken bad; injuriesNoEms `{all:[injury:driverB, !service:ems]}` reportTaken bad;
   transported `transported:driverB` transported good; hitAndRun `{all:[branch:hitAndRun, statement:driverA]}`
   reportTaken good; exchange `{all:[statement:driverA, trafficControl]}` reportTaken good.
   Types (category traffic, gen): `injuryCollision` (injuries 6) .6; `hitAndRunCollision` (hitAndRun 6) .5;
   `pedestrianStruck` (pedestrian 1, others 0) .25; `singleVehicleCrash` (singleVehicle 3, duiDriver 1) .4;
   `motorcycleCrash` (injuries 4, singleVehicle 2) .2; `parkingLotCollision` (location block, propertyOnly 6, hitAndRun 2) .5;
   `collisionBlockingLanes` .4; `rolloverCrash` (singleVehicle 3, injuries 2) .15.
5. **disturbance** — anchor curb; P3 .5 P4 .5, block, [1,1], [180,420]. Roles: caller(0-1) [c] @distance
   callerUpset; subject(1-2) [a] @curb suspectAgitated intox {.4,[0.05,0.16]}; bystander(0-3) {} @crowd bystander.
   Branches: noisy 4 (subject profile suspectCalm); argument 3; intoxicated 2 (subject intox {1,[0.12,0.25]}
   profile subjectIntoxicated); gone 1 (remove [subject]). Variants 1/1/1/1/0/.2. Actions: separateParties,
   canvass, photograph, requestEms, requestInterpreter, writeReport. Outcomes: gone `{any:[branch:gone,
   variant:false]}` goneOnArrival good; arrest `custody:subject` arrestMade ok; transported `transported:subject`
   transported good; warned `warned:subject` warningIssued good; handled `contacted:subject` handled good.
   Types (category disturbance, gen unless noted): `loudParty` (block) 1.0; `neighborDispute` .7;
   `intoxicatedPerson` (intoxicated 6; road) .7; `disorderlyPerson` .6; `panhandling` (category suspicious) .4;
   `verbalDispute` .6; `landlordTenantDispute` (referred added to dispositions) .3; `customerDispute` .5;
   `roadRageReport` (category traffic, road) .3; `fireworksComplaint` (noisy 6) .3; `loudMusicVehicle` (road, noisy 6) .3.
6. **domestic** — as the §4.2 example. Types (category domestic, block, gen): `domesticDisturbance` 1.0;
   `domesticViolenceInjury` (assault 6, P1 .4 P2 .6) .5; `protectiveOrderViolation` (suspectGone 2, verbal 2) .3; `familyDispute` (verbal 6) .5; `childCustodyDispute` (verbal 6, referred) .3;
   `elderAbuseReport` (victim person {minAge 70}, assault 2, verbal 2) .2; `domesticWithWeapon` (weapon 6, P1) .2.
7. **welfare** — anchor door; P3 .7 P4 .3, block, [1,1], [180,420]. Roles: caller(0-1) [c] @curb callerHelpful;
   subject(1) [a] @inside residentInnocent. Branches: fine 5; confused 2 (subject person {minAge 70}, profile
   subjectConfused); medical 2 (subject profile subjectUnconscious, injured 1, flags [injury:subject]);
   deceased 1 (subject deceased true, profile subjectDeceased, flags [deceased:subject]); notHome 2 (remove [subject]);
   inVehicle 0 (subject spot curb, profile subjectUnconscious, injured 1, flags [injury:subject]);
   confusedOutside 0 (subject person {minAge 70}, spot curb, profile subjectConfused); stranded 0 (subject spot
   roadside, profile callerHelpful).
   Variants 0/0/.5/.5/0/0. Actions: knock, requestEms, requestCoroner, notifyGuardian, canvass, writeReport.
   Outcomes: fine `{all:[branch:fine, contacted:subject]}` handled good; transported `transported:subject`
   transported good; medicalMissed `{all:[injury:subject, !service:ems]}` handled bad; deceased
   `{all:[deceased:subject, service:coroner]}` reportTaken good; confusedHelped `{all:[branch:confused,
   guardianNotified]}` referred good; notHome `branch:notHome` goneOnArrival ok.
   Types (category welfare, gen; a branch not listed keeps its family weight): `welfareCheckElderly` (confused 4,
   fine 2) .5; `slumpedInVehicle` (road; inVehicle 1, all others 0) .4; `foundPersonConfused` (road;
   confusedOutside 1, all others 0) .3; `citizenAssist` (road; stranded 1, all others 0) .4;
   `welfareCheckNoAnswer` (notHome 3, medical 2, deceased 1, fine 0, confused 0) .4; `strandedMotorist`
   (category traffic, road; stranded 1, all others 0) .4.
8. **crisis** — anchor curb; P2 .7 P1 .3, block, [1,2], [600,1200]. Roles: caller(0-1) [c] @distance
   callerUpset; subject(1) {minAge 16, mentalHealth true} @curb subjectCrisis. Branches: talkDown 5;
   suicidal 3 (subject profile subjectSuicidal); armed 1 (subject weapon knife, profile subjectSuicidal);
   flees 1 (subject profile suspectFleeRisk). Variants .5/.5/.3/.5/0/0. Actions: requestEms, requestSupervisor,
   perimeter, requestInterpreter, notifyGuardian, writeReport. Outcomes: transported `transported:subject`
   transported good; calmedReferred `calmed:subject` referred good; forced `{all:[custody:subject, forceUsed]}`
   arrestMade bad; custody `custody:subject` referred ok; escaped `escaped:subject` reportTaken bad.
   Types (welfare unless noted, block, gen): `suicidalSubject` (suicidal 6) .4; `mentalHealthCrisis` .5;
   `suicidalSubjectArmed` (armed 6, P1) .15; `personOnLedge` (poi:harbor, suicidal 6) .1; `erraticBehavior`
   (category disturbance, road) .4; `crisisThirdParty` .3; `threatsOfSelfHarm` (suicidal 4, talkDown 2) .3.
9. **medical** — anchor curb; P2 .6 P1 .2 P3 .2, block, [1,1], [300,600]. Roles: caller(0-1) [c] @curb
   callerUpset; patient(1) {minAge 16} @curb subjectUnconscious injured 1; bystander(0-2) {} @crowd bystander.
   Branches: overdose 4 (patient intox {1,[0,0.02],"opioid"}, items syringe .5 pills .3, flags [injury:patient]);
   collapse 3 (flags [injury:patient]); intoxicated 2 (patient intox {1,[0.25,0.35]} profile subjectIntoxicated,
   flags [injury:patient]); refuses 1 (patient profile subjectIntoxicated injured 0). Variants 0/0/.3/1/0/0.
   Actions: firstAid, requestEms, requestFire, canvass, writeReport. Outcomes: transported
   `transported:patient` transported good; firstAidOnly `{all:[firstAid, !service:ems]}` handled bad;
   refused `branch:refuses` handled good; noEms `!service:ems` handled bad.
   Types (category medical, gen): `overdose` (overdose 6) .6; `personDown` (road) .7; `unconsciousPerson` .5;
   `injuredPerson` (road, collapse 4) .4; `medicalAssist` .4; `seizureInPublic` (road, collapse 6) .25;
   `intoxicatedUnconscious` (road, intoxicated 6) .4.
10. **property** (reports) — anchor door; P4 .8 P3 .2, block, [1,1], [300,600]. Roles: victim(1) [c] @door
   callerHelpful; witness(0-1) {} @curb witnessReluctant; suspect(0-1) [r] @hidden suspectEvasive items stolenGoods .6.
   Evidence: brokenGlass .4. Branches: reportOnly 6 (remove [suspect]); suspectNearby 1; insuranceFraud 1
   (remove [suspect], flags [fraudSuspected]). Variants 0/0/.3/.5/0/0. Actions: photograph, collectEvidence,
   canvass, searchArea, writeReport. Outcomes: arrest `custody:suspect` arrestMade good; report
   `{all:[statement:victim, report]}` reportTaken good; noReport `!report` reportTaken bad.
   Types (gen, block): `burglaryCold` (burglary) .7; `vehicleBurglaryCold` (theft, road) .6; `theftReport`
   (theft) .8; `vandalismReport` (vandalism) .6; `fraudReport` (theft, insuranceFraud 2) .4; `identityTheftReport`
   (theft) .3; `counterfeitCurrency` (theft) .2; `foundProperty` (theft, reportOnly 6, P4) .3; `lostProperty`
   (theft, reportOnly 6, P4) .3; `packageTheft` (theft, suspectNearby 1) .5.
11. **retail** — anchor door; P3 .7 P2 .3, block (districts downtown 2, campus 1.3, suburbs 0.8, rural 0.3), [1,1],
   [300,600]. Roles: guard(1) {} @door securityGuard; suspect(1) [a] @door suspectNervous items stolenGoods 1
   cashRoll .1 fakeId .1. Branches: detained 5; fled 3 (suspect spot hidden profile suspectFleeRisk);
   combative 1 (suspect profile suspectHostile). Variants .3/.3/.2/.3/0/0. Actions: photograph, collectEvidence,
   searchArea, writeReport. Outcomes: arrest `custody:suspect` arrestMade good; cited `citation:suspect`
   citationIssued good; fledReport `escaped:suspect` reportTaken ok.
   Types (theft, gen): `shopliftingDetained` (detained 6) .8; `shopliftingFled` (fled 6) .5;
   `shopliftingInProgress` (P2) .4; `dineAndDash` (fled 3, detained 2) .2; `gasDriveOff` (poi:fuel; fled 6) .3.
12. **trespass** — anchor door; P3 .6 P4 .4, block, [1,1], [180,420]. Roles: caller(1) [c] @door callerUpset;
   subject(1-2) [a] @yard suspectEvasive intox {.3,[0.05,0.15]}. Branches: leaves 5; refuses 3 (subject
   profile suspectAgitated); wanted 1 (subject person [w]); gone 1 (remove [subject]). Variants .5/.5/.5/.5/0/.1.
   Actions: searchArea, photograph, writeReport. Outcomes: gone `{any:[branch:gone, variant:false]}`
   goneOnArrival good; arrest `custody:subject` arrestMade good; warned `warned:subject` warningIssued good;
   left `left:subject` handled good.
   Types (suspicious unless noted, gen): `trespass` .7; `trespassVacantBuilding` (industrial 2) .4;
   `unwantedGuest` (disturbance) .5; `loiteringBusiness` .4; `squatters` (refuses 4) .2;
   `trespassSchoolGrounds` (poi:school, subject {minAge 16, maxAge 19}) .2.
13. **inProgress** — anchor door; P2 .6 P3 .4, block, [1,2], [300,600]. Roles: caller(0-1) [c] @distance
   callerHelpful; suspect(1-2) [r] @hidden suspectFleeRisk items burglaryTools .5 stolenGoods .4 knife .1.
   Evidence: brokenGlass .5. Branches: caught 3 (suspect spot yard profile suspectNervous); hiding 3;
   fled 3 (remove [suspect], flags [suspectFled]); nothing 2 (remove [suspect]). Variants 1/.5/1/1/0/.2.
   Actions: perimeter, searchArea, requestK9, photograph, collectEvidence, canvass, writeReport. Outcomes:
   unfounded `{any:[branch:nothing, variant:false]}` unfounded good; arrest `custody:suspect` arrestMade good;
   escaped `escaped:suspect` reportTaken bad; fledReport `{all:[branch:fled, report]}` reportTaken good.
   Types (gen): `burglaryInProgress` (burglary, P1 .3) .5; `prowler` (suspicious, nothing 4) .6;
   `vehicleBreakInProgress` (theft, road) .5; `theftInProgress` (theft) .4; `commercialBurglaryInProgress`
   (burglary, industrial 2) .3; `peepingPerson` (suspicious, fled 4) .2.
14. **violent** — anchor curb; P1 .5 P2 .5, block, [2,3], [420,900]. Roles: victim(1) [a] @curb victimDistraught;
   suspect(1) [r] @hidden suspectFleeRisk weapon null items cashRoll .5 stolenGoods .3; witness(0-2) {} @curb
   witnessReluctant. Branches: suspectFled 4 (flags [suspectFled]); suspectNearby 3; injured 2 (victim injured 1
   profile victimInjured flags [injury:victim]); armed 1 (suspect weapon handgun profile suspectArmedHostile).
   Variants 1/.5/.3/1.5/.3/.3. Actions: perimeter, searchArea, requestK9, requestEms, canvass, photograph,
   collectEvidence, writeReport. Outcomes: unfounded `{any:[variant:false, variant:swatting]}` unfounded good;
   arrest `custody:suspect` arrestMade good; injuredNoEms `{all:[injury:victim, !service:ems]}` reportTaken bad;
   report `{all:[statement:victim, report]}` reportTaken good.
   Types (gen): `robbery` (robbery) .5; `armedRobbery` (robbery, armed 5, P1) .3; `strongArmRobbery` (robbery) .3;
   `assaultInProgress` (assault, suspectNearby 4) .5; `fightInProgress` (assault, suspectNearby 6, witness 2-4) .6;
   `stabbingReported` (assault, injured 6, P1) .2; `assaultCold` (assault, suspectFled 6, P3) .5;
   `carjacking` (robbery, road, armed 3) .15.
15. **weapons** — anchor curb; P1 .7 P2 .3, block, [2,3], [420,900]. Roles: caller(0-1) [c] @distance callerUpset;
   subject(1) [r] @curb suspectArmedHostile weapon handgun; bystander(0-3) {} @crowd bystander.
   Evidence: shellCasing .5. Branches: brandishing 3; surrenders 2 (subject profile suspectNervous);
   gone 3 (remove [subject]); knife 1 (subject weapon knife); misidentified 1 (subject weapon null, items phone 1,
   profile residentInnocent, flags [misidentified]). Variants .5/.5/.5/1.5/1/.5. Actions: perimeter, evacuate,
   searchArea, requestK9, requestSwat, requestSupervisor, photograph, collectEvidence, canvass, writeReport.
   Outcomes: swatting `variant:swatting` unfounded good; misidentifiedForce `{all:[branch:misidentified,
   forceUsed]}` handled bad; arrest `custody:subject` arrestMade good; gone `branch:gone` goneOnArrival ok;
   escaped `escaped:subject` reportTaken bad.
   Types (gen, category assault unless noted): `shotsFired` (gone 5) .5; `armedPerson` .4; `personWithKnife`
   (knife 6) .3; `brandishing` .3; `personWithGun` (misidentified 2) .3; `driveByShooting` (road, gone 6) .1;
   `firearmDischargeRural` (rural 3, others .3; gone 4, misidentified 3) .15.
16. **activeAssailant** — anchor door; P1 1, block, [3,4], [600,1200]. Roles: assailant(1) [r] @hidden
   suspectArmedHostile weapon handgun; victim(1-3) [a] @curb victimInjured injured .7; bystander(2-6) {} @crowd
   bystander. Branches: engaged 5; surrenders 2 (assailant profile suspectNervous); fled 2 (assailant profile
   suspectFleeRisk). Variants .3/0/.2/2/1/0. Actions: perimeter, evacuate, searchArea, requestEms, requestSwat,
   requestK9, requestSupervisor, writeReport. Outcomes: swatting `variant:swatting` unfounded good; stopped
   `custody:assailant` arrestMade good; victimsNoEms `!service:ems` reportTaken bad; escaped
   `escaped:assailant` reportTaken bad. Types (assault, gen): `activeAssailant` .03; `activeAssailantBusiness`
   (downtown 2) .02; `massCasualtyReport` (fled 4, P1) .02.
17. **barricade** — anchor door; P1 1, block, [3,4], [900,1800]. Roles: subject(1) [r] @inside barricaded
   weapon handgun; hostage(0-1) [a] @inside victimDistraught; caller(0-1) [c] @distance callerUpset.
   Branches: barricaded 5 (remove [hostage]); hostage 3; surrenders 2 (subject profile suspectNervous, remove [hostage]).
   Variants .5/.5/.3/1/1.5/0. Actions: contain, perimeter, evacuate, requestSwat, requestSupervisor,
   requestEms, writeReport. Outcomes: swatting `variant:swatting` unfounded good; resolved
   `{all:[custody:subject, contained]}` arrestMade good; resolvedUncontained `custody:subject` arrestMade ok;
   noSwat `!service:swat` reportTaken bad. Types (gen): `hostageSituation` (assault, hostage 6) .03;
   `barricadedSubject` (disturbance) .05; `barricadedArmed` (assault) .03.
18. **wanted** — anchor door; P2 .5 P3 .5, block, [1,2], [300,600]. Roles: subject(1) [w] @inside
   suspectFleeRisk; resident(0-1) [a] @door residentInnocent. Branches: home 4; flees 3 (subject spot hidden);
   notHome 2 (remove [subject]); armed 1 (subject weapon handgun profile suspectArmedHostile); street 0
   (subject spot curb). Variants .3/.3/.5/.3/0/.1. Actions: knock, perimeter, searchArea, requestK9, writeReport. Outcomes:
   arrest `custody:subject` arrestMade good; notHome `branch:notHome` goneOnArrival good; escaped
   `escaped:subject` reportTaken bad. Types (gen): `wantedSubject` (suspicious, road; street 1, all others 0) .3;
   `warrantService` (suspicious) .1; `probationViolatorSighted` (suspicious, road) .2; `paroleeAbsconder` (suspicious) .15;
   `boloPersonSighted` (suspicious, road) .2.
19. **vehicleWanted** — anchor roadside; P2 .6 P1 .4, road, [2,3], [300,600]. Roles: driver(1) [r] @vehicle
   suspectNervous vehicle subjectVehicle; passenger(0-2) [r] @vehicle suspectNervous vehicle subjectVehicle.
   Vehicles: subjectVehicle(1) driving normal reported flee .35. Branches: stolen 5; armed 2 (driver weapon
   handgun, passenger weapon handgun, profile suspectArmedHostile); parked 2 (vehicleOverrides subjectVehicle
   mode parked; remove [passenger]; driver spot hidden); notFound 1 (remove [driver, passenger, subjectVehicle]).
   Variants .3/0/.5/.5/0/0. Actions: requestTow, requestK9, photograph, writeReport. Outcomes: arrest
   `custody:driver` arrestMade good; recovered `{all:[branch:parked, service:tow]}` reportTaken good;
   escaped `escaped:driver` reportTaken bad; notFound `branch:notFound` goneOnArrival ok.
   Types (gen): `stolenVehicleSighted` (theft) .4; `felonyStopVehicle` (assault, armed 6, P1) .15;
   `boloVehicleSighted` (suspicious) .3; `carjackedVehicleSighted` (robbery, armed 3) .1;
   `stolenVehicleRecovered` (theft, parked 6, P4) .3.
20. **pursuit** — anchor roadside; P1 1, road, [2,3], [300,600]. Roles: driver(1) given @vehicle suspectFleeRisk.
   Vehicles: subjectVehicle(1) driving normal flee 1 (always the existing fleeing car, never spawned).
   Branches: chase 1; footOnly 1 (remove [subjectVehicle], driver spot curb). Variants 0. Actions: requestK9,
   requestSupervisor, requestTow, writeReport. Outcomes: arrest `custody:driver` arrestMade good; escaped
   `{any:[escaped:driver, pursuitLost]}` goneOnArrival ok. Types (not generated, weight 0): `vehiclePursuit`
   (traffic, codeKey pursuit; footOnly 0), `footPursuit` (suspicious; chase 0).
21. **missing** — anchor curb; P2 .5 P3 .5, block, [1,2], [600,1200]. Roles: reporter(1) [c] @door
   guardianWorried; missing(1) {minAge 16} @distance juvenileScared. Branches: foundNearby 4; returnedHome 2
   (missing spot door, profile bystander); notFound 2 (missing spot hidden); elderly 2 (missing person
   {minAge 70}, profile subjectConfused). Variants .3/.3/.3/.3/0/0. Actions: canvass, searchArea, requestK9,
   notifyGuardian, writeReport. Outcomes: reunited `{all:[found:missing, guardianNotified]}` handled good;
   foundNoGuardian `{all:[found:missing, juvenile:missing, !guardianNotified]}` handled bad; found
   `found:missing` handled good; report `report` reportTaken ok.
   Types (gen): `missingPerson` (welfare) .3; `missingElderly` (welfare, elderly 6) .25; `juvenileRunaway`
   (welfare, missing {minAge 16, maxAge 17}) .3; `missingAtRisk` (welfare) .15; `foundJuvenile` (welfare,
   road, foundNearby 6, missing {minAge 16, maxAge 17}) .2.
22. **crowd** — anchor street; P2 .5 P3 .5, road (districts downtown 2, campus 2, park 1.5, rural .1), [2,3],
   [600,1200]. Roles: organizer(0-1) [a] @street protester; protester(4-12) {minAge 16} @crowd protester;
   agitator(0-2) [r] @crowd suspectAgitated; bystander(0-3) {} @crowd bystander. Branches: peaceful 5
   (remove [agitator]); unruly 3; fight 2 (agitator count 2, flags [fight]). Variants 1/1/.3/1.5/0/0.
   Actions: trafficControl, perimeter, disperseCrowd, requestSupervisor, requestEms, writeReport. Outcomes:
   managedPeaceful `{all:[branch:peaceful, trafficControl, !forceUsed]}` handled good; dispersed
   `crowdDispersed` handled good; arrests `{any:[custody:agitator, custody:protester]}` arrestMade ok;
   forcePeaceful `{all:[branch:peaceful, forceUsed]}` handled bad.
   Types (gen unless noted): `protest` (disturbance) .15; `crowdManagement` (disturbance) .15;
   `specialEventTraffic` (traffic, peaceful 6) .2; `largeFight` (assault, fight 6) .2;
   `unrulyCrowd` (disturbance, unruly 6) .15; `streetRacingGathering` (traffic, unruly 4) .1;
   `paradeTrafficControl` (traffic, peaceful 6) .05.
23. **hazard** — anchor roadside; P2 .5 P3 .5, road, [1,2], [300,900]. Roles: caller(0-1) [c] @distance
   callerHelpful; bystander(0-4) {} @crowd bystander. Evidence: none (the scene places a `suspiciousPackage` prop
   at the anchor when the flag `package` is set). Branches: debris 4 (flags [roadHazard]); spill 2 (flags [hazmat]);
   gasLeak 2 (flags [hazmat]); package 2 (flags [package]); downedLines 1 (flags [hazmat]). Variants .5/.5/.5/1/0/0. Actions: trafficControl,
   perimeter, evacuate, requestFire, requestHazmat, requestBombSquad, requestTow, writeReport. Outcomes:
   hazmatHandled `{all:[hazmat, perimeter, {any:[arrived:hazmat, arrived:fire]}]}` handled good; packageCleared
   `{all:[package, evacuated, arrived:bombSquad]}` handled good; hazmatNoPerimeter `{all:[hazmat, !perimeter]}`
   handled bad; debrisCleared `{all:[roadHazard, trafficControl]}` handled good.
   Types (gen): `hazmatSpill` (traffic, spill 6) .1; `gasLeak` (category alarm, block, gasLeak 6) .15; `bombThreat` (disturbance, block, package 6) .08; `suspiciousPackage` (suspicious, block, package 6) .15;
   `downedPowerLines` (traffic, downedLines 6) .15; `roadwayFlooding` (traffic, debris 6) .1;
   `treeDownBlockingRoad` (traffic, debris 6) .25; `fireReportAssist` (alarm, block, gasLeak 3, debris 3) .2.
24. **animal** — anchor curb; P3 .6 P4 .4, block, [1,1], [180,420]. Roles: caller(0-1) [c] @door callerHelpful;
   animal(1) {} @yard animalDog body dog; owner(0-1) [a] @door bystander. Branches: stray 4 (remove [owner]);
   aggressive 2 (animal profile animalAggressiveDog); owned 3; injured 1 (animal injured 1, remove [owner]).
   Variants .3/.3/.5/.5/0/0. Actions: secureAnimal, requestAnimalControl, writeReport. Outcomes: secured
   `{any:[animalSecured, arrived:animalControl]}` handled good; ownerWarned `{all:[branch:owned, warned:owner]}`
   warningIssued good; referred `service:animalControl` referred good.
   Types (category disturbance unless noted, gen): `strayDog` .4; `aggressiveDog` (aggressive 6, P2) .25;
   `animalBite` (assault, aggressive 4, owned 2) .15; `injuredAnimal` (injured 6, road) .2; `animalInHotVehicle`
   (welfare, owned 6, road) .1; `livestockOnRoadway` (traffic, rural 4, stray 6, road) .1; `animalNoiseComplaint` (owned 6) .3.
25. **parking** — anchor roadside; P4 1, road, [1,1], [120,300]. Roles: caller(0-1) [c] @door callerUpset;
   owner(0-1) [a] @distance driverCooperative. Vehicles: parkedVehicle(1) parked normal. Branches: cite 5
   (remove [owner]); ownerReturns 3; abandoned 2 (remove [owner], flags [abandoned]). Variants 0/0/.5/.3/0/0.
   Actions: citeVehicle, requestTow, photograph, writeReport. Outcomes: towed `{all:[abandoned, service:tow]}`
   handled good; cited `vehicleCited` citationIssued good; moved `{all:[branch:ownerReturns, contacted:owner]}`
   handled good. Types (traffic, gen): `blockedDriveway` .5; `abandonedVehicle` (abandoned 6) .3;
   `fireLaneViolation` .25; `disabledParkingViolation` .2; `doubleParked` (ownerReturns 4) .3;
   `vehicleBlockingTraffic` (ownerReturns 3, P3) .25.
26. **investigation** — anchor door; P3 .6 P2 .4, block, [1,2], [600,1200]. Roles: reporter(1) [c] @door
   callerHelpful; victim(0-1) [a] @door victimDistraught; suspect(0-1) [r] @distance suspectEvasive;
   deceased(0-1) {minAge 18} @inside subjectDeceased deceased true. Evidence: bloodEvidence .2, threatNote .2.
   Branches: report 5 (remove [suspect, deceased]); suspectPresent 2 (remove [deceased]); death 0 (remove
   [suspect, victim], deceased count 1, flags [deceased:deceased]); assaultScene 0 (deceased removed; victim
   injured 1, flags [injury:victim, sceneEvidence]). Variants 0/0/.3/.3/0/0. Actions: preserveScene, perimeter,
   photograph, collectEvidence, canvass, requestEms, requestCoroner, requestSupervisor, notifyGuardian, writeReport.
   Outcomes: deathHandled `{all:[deceased:deceased, scenePreserved, service:coroner]}` reportTaken good;
   deathUnpreserved `{all:[deceased:deceased, !scenePreserved]}` reportTaken bad; sceneHandled
   `{all:[sceneEvidence, scenePreserved, transported:victim]}` reportTaken good; arrest `custody:suspect`
   arrestMade good; report `{all:[statement:reporter, report]}` reportTaken good.
   Types (gen): `deathInvestigation` (welfare, death 6, P2) .1; `unattendedDeath` (welfare, death 6) .1;
   `sexualAssaultScene` (assault, assaultScene 6, P2) .08; `sexualAssaultReport` (assault, report 6) .1;
   `stalkingReport` (domestic, suspectPresent 2, report 4) .2; `harassmentReport` (disturbance) .3;
   `criminalThreats` (assault) .25; `schoolThreat` (disturbance, poi:school, suspect {minAge 16, maxAge 17},
   suspectPresent 4, report 2) .1; `extortionReport` (theft) .1.
27. **service** — anchor curb; P4 .7 P3 .3, road, [1,1], [180,420]. Roles: requester(1) [c] @curb callerHelpful;
   subject(0-1) [r] @hidden suspectFleeRisk. Branches: routine 6 (remove [subject]); k9Track 0 (subject present,
   flags [k9Needed]). Variants 0/0/.2/.2/0/0. Actions: requestK9, requestTow, searchArea, writeReport.
   Outcomes: k9Found `{all:[k9Needed, custody:subject]}` arrestMade good; k9NoDog `{all:[k9Needed,
   !service:k9]}` reportTaken bad; assisted `contacted:requester` handled good.
   Types (gen unless noted): `civilStandby` (domestic, block) .3; `propertyRetrieval` (domestic, block) .15;
   `vehicleLockout` (traffic) .3; `k9TrackRequest` (burglary, k9Track 6, P2) .1; `motoristAssist` (traffic) .4;
   `funeralEscort` (traffic, not generated) 0; `bankEscort` (theft, block) .1.

(27 families. New type count, from `contact` on: 2 + 6 + 8 + 11 + 7 + 6 + 7 + 7 + 10 + 5 + 6 + 6 + 8 +
7 + 3 + 3 + 5 + 5 + 2 + 5 + 7 + 8 + 7 + 6 + 9 + 7 = 163.) Express every per-type difference with `branchWeights`, the CAD
fields and narratives only; never invent new family or type fields. Where a type needs a different person constraint for a role (e.g. `trespassSchoolGrounds`), add a family
branch with that `roleOverrides.person` and weight 0, and enable it in the type's `branchWeights`.

### 4.4 NPC data [npc] `src/data/npc/`

`behaviors.json` — one row per `PROFILE_IDS` id:
```jsonc
{ "version": 1, "profiles": [
  { "id": "suspectFleeRisk", "demeanor": "evasive", "compliance": 0.45, "fleeChance": 0.45, "fightChance": 0.15,
    "weaponDrawChance": 0.3, "surrenderPerMin": 0.6, "startPose": "stand", "wander": false, "stress": 0.5 } ] }
```
`demeanor` ∈ `cooperative nervous evasive hostile distraught confused crisis unresponsive animal`;
`compliance`, `fleeChance` (rolled once when the officer first comes within `approachTriggerM`),
`fightChance` (rolled when cuffed / grabbed while not compliant), `weaponDrawChance` (rolled once on approach
when armed), `surrenderPerMin` (armed / barricaded / fleeing), `stress` (initial 0..1) all 0..1;
`startPose` ∈ `stand sit lying kneel`; `wander` (bystanders mill around). Suggested: cooperative profiles
compliance 0.85-0.95, flee 0; hostile 0.35, fight 0.3; armed hostile 0.25, weaponDraw 0.6, surrender 0.5;
subjectUnconscious/subjectDeceased compliance 0, startPose lying, demeanor unresponsive; animals demeanor animal.

`npc.json`
```jsonc
{ "version": 1,
  "actors": { "max": 64, "walkSpeed": [1.1, 1.5], "runSpeed": [5.2, 7.2], "staminaS": [15, 40], "tiredFactor": 0.55,
    "followDistance": 1.4, "approachTriggerM": 15, "revealDistanceM": 6, "tackleRangeM": 1.6, "taserRangeM": 7, "taserHit": 0.8,
    "taserDownS": 6, "tackleDownS": 4, "struggleS": 3, "officerWinBase": 0.6, "officerWinPerBackup": 0.1,
    "escapeDistanceM": 120, "escapeS": 15, "fleeRouteM": [150, 350], "armedActionS": [4, 9],
    "leaveDistanceM": 40, "crowdRadiusM": 12,
    "lod": { "nearM": 60, "midM": 200, "nearHz": 10, "midHz": 2, "farHz": 0.5 } },
  "occupants": { "renderRadiusM": 60, "seatY": -0.25,
                 "seats": [ [-0.22, -0.05], [0.22, -0.05], [-0.22, 0.28], [0.22, 0.28] ] },
  "peds": { "max": 160, "spawnRadiusM": 150, "despawnRadiusM": 200, "minSpawnM": 35, "spawnPerStep": 2,
            "walkSpeed": [1.0, 1.6], "retargetS": 1.0,
            "lod": { "nearM": 50, "midM": 120, "nearEvery": 1, "midEvery": 3, "farEvery": 10 } } }
```
`seats` are fractions of (body width, body length) in the vehicle frame (x right, z rear), seat 0 = driver.
`density.json` — `{ "version": 1, "perKm": { "downtown": 70, "campus": 50, "hospital": 30, "suburbs": 14,
"park": 18, "harbor": 8, "industrial": 6, "airport": 10, "rural": 2, "highway": 0, "water": 0 }, "hourly": [24
factors, e.g. 0.15 at 03:00, 1.0 at 12:00-18:00, 0.6 at 21:00] }` (pedestrians per km of sidewalk).

### 4.5 Dialogue data [dialogue] `src/data/dialogue/`

`utterances.json`
```jsonc
{ "version": 1,
  "topics": [ { "id": "greeting", "label": "Greeting" }, { "id": "reason", "label": "Reason for contact" }, { "id": "id", "label": "Identification" },
              { "id": "questions", "label": "Questions" }, { "id": "consent", "label": "Consent" }, { "id": "commands", "label": "Commands" },
              { "id": "support", "label": "Calm / support" }, { "id": "miranda", "label": "Rights (Phase 5)" }, { "id": "closing", "label": "Closing" } ],
  "utterances": [
    { "id": "greet", "topic": "greeting", "intent": "greet",
      "text": { "polite": "Good evening. I'm {officer} with City Police.", "neutral": "Hi, {officer}, City Police.",
                "commanding": "Police. I need to talk to you.", "aggressive": "Hey! Police. Over here, now." } },
    { "id": "askDestination", "topic": "questions", "intent": "ask", "fact": "destination", "requires": ["notRestrainedOrAny"],
      "text": { "polite": "Where are you headed tonight?", "neutral": "Where are you going?", "commanding": "Where are you going?", "aggressive": "Where do you think you're going?" } },
    { "id": "cmdStepOut", "topic": "commands", "intent": "command", "command": "stepOut", "requires": ["inVehicle"], "text": { ... } } ] }
```
Fields: `id`, `topic`, `intent` ∈ `greet explainReason requestId askName askDob ask consent command reassure
miranda release warn thank`, `fact?` (`FACT_TOPICS`, for `ask`), `consent?` ∈ `searchPerson searchVehicle pbt
sfst`, `command?` (`NPC_COMMANDS`), `requires?: Requirement[]` with `Requirement` ∈ `inVehicle notInVehicle
hasVehicle onCall armedSubject restrained notRestrained juvenile notJuvenile identityGiven
notRestrainedOrAny`, and `text` for all four tones (placeholders `{officer}`, `{reason}`).
The set must cover: greet; explainReason; requestId, askName, askDob; ask × each of destination, origin,
account, drinking, drugs, weapons, vehicleContents, vehicleOwner, address, injured, suspectWhereabouts;
consent × 4; command × every `NPC_COMMANDS` id; reassure ("Take a breath, I'm here to help"); miranda;
release ("You're free to go"); warn ("I'm giving you a warning"); thank.

`responses.json` — NPC lines keyed by line key (every key in the engine's `LINE_KEYS`, §9.4), 2-4 variants each:
```jsonc
{ "version": 1, "lines": {
  "greet.cooperative": ["Evening, officer.", "Hi. Is everything okay?"],
  "requestId.handDl": ["Here's my license."], "requestId.handFake": ["Yeah, here."], "requestId.noDlTrue": ["I don't have it on me. I'm {first} {last}, born {dob}."],
  "requestId.lieVerbal": ["Left it at home. Name's {first} {last}, {dob}."], "requestId.refuse": ["I don't have to show you anything."],
  "ask.truth": ["{value}."], "ask.lie": ["{value}."], "ask.refuse": ["I'd rather not say."], "ask.confused": ["I... I'm not sure. {value}?"],
  "drinking.no": ["No, nothing tonight."], "drinking.some": ["Just one beer with dinner."], "drinking.yes": ["Yeah, I had a few."],
  "deaf.noResponse": ["(Points to their ear and shakes their head.)"], "foreign.untranslated": ["({language}) ..."] },
  "values": { "destination": ["home", "work", "a friend's place", "the store", "the gas station", "my sister's place", "a bar downtown"],
              "origin": ["work", "a friend's house", "the gym", "dinner", "the movies", "my parents' place"],
              "account": ["We were just talking and it got loud.", "Nothing happened, really.", "They started it."],
              "suspectWhereabouts": ["They ran toward {street}.", "I didn't see where they went.", "They're still inside."] } }
```
`trust.json` — neighborhood trust placeholder per district (0..1; Phase 5 replaces):
`{ "version": 1, "districts": { "downtown": 0.45, "suburbs": 0.65, "industrial": 0.5, "rural": 0.6, "campus": 0.5,
"hospital": 0.6, "airport": 0.6, "harbor": 0.45, "park": 0.55, "highway": 0.5, "water": 0.5 } }`.

`rules.json` — inconsistency rules (§9.5):
```jsonc
{ "version": 1, "rules": [
  { "id": "nameVsId", "topic": "name", "a": "claim", "b": "document", "compare": "equal", "severity": "alert", "text": "Gave the name {a}, but the ID card reads {b}." },
  { "id": "drinkingDenial", "topic": "drinking", "a": "claim", "b": "evidence", "compare": "denial", "severity": "alert", "text": "Said \"{a}\" about drinking, but {bDetail}." } ] }
```
Required rules (id, topic, a, b, compare, severity): `nameVsId` name claim document equal alert; `dobVsId` dob
claim document equal alert; `nameNotOnFile` name claim record notOnFile alert; `dobVsRecord` dob claim
record equal alert; `idNotOnFile` idCard document record idCard alert; `appearanceVsRecord` appearance observation
record appearance caution; `addressVsRecord` address claim record equal caution; `storyDestination` destination
claim claim equal caution; `storyOrigin` origin claim claim equal caution; `storyAccount` account claim claim equal
caution; `drinkingDenial` drinking claim evidence denial alert; `drugsDenial` drugs claim evidence denial alert;
`weaponsDenial` weapons claim evidence denial alert; `contentsDenial` vehicleContents claim evidence denial alert;
`ownerVsRecord` vehicleOwner claim record equal caution; `identityVsBooking` identity claim booking equal alert.
Texts use `{a}`, `{b}` (display values) and `{aDetail}`, `{bDetail}`.

`tools.json`
```jsonc
{ "version": 1,
  "pbt": { "noiseSd": 0.004, "round": 0.001, "minReportable": 0.0 },
  "sfst": { "promptWindowS": 2.5, "promptGapS": 1.2, "minHitShare": 0.75,
            "tests": [ { "id": "hgn", "label": "Horizontal gaze nystagmus", "prompts": 6, "maxClues": 6, "threshold": 4, "bacStart": 0.03, "bacSpan": 0.07,
                         "instruction": "Follow the pen with your eyes only.", "keys": ["a", "d"] },
                       { "id": "walkTurn", "label": "Walk and turn", "prompts": 9, "maxClues": 8, "threshold": 2, "bacStart": 0.05, "bacSpan": 0.12,
                         "instruction": "Nine heel-to-toe steps, turn, nine steps back.", "keys": ["w", "space"] },
                       { "id": "oneLeg", "label": "One-leg stand", "prompts": 4, "maxClues": 4, "threshold": 2, "bacStart": 0.06, "bacSpan": 0.12,
                         "instruction": "Raise one foot and count out loud.", "keys": ["space"] } ],
            "drugClues": { "cannabis": { "oneLeg": 1 }, "stimulant": { "walkTurn": 1 }, "opioid": { "hgn": 1, "walkTurn": 2 }, "depressant": { "hgn": 2, "walkTurn": 1 } },
            "diabeticChance": 0.2, "diabeticClues": { "walkTurn": 2, "oneLeg": 1 }, "clueSd": 0.7 },
  "frisk": { "weaponFindBase": 0.95, "concealmentFactor": 0.5, "largeItemFind": 0.6 },
  "search": { "findBase": 0.98, "concealmentFactor": 0.35 },
  "visual": { "revealBelowConcealment": 0.3 },
  "odor": { "alcoholBac": 0.04, "distanceM": 2.5 } }
```

### 4.6 CAD data additions [calls] `src/data/cad/`

- `dispositions.json` gains `{ "id": "transported", "label": "Transported to hospital" }` and
  `{ "id": "duplicate", "label": "Duplicate call" }`.
- `statutes.json` gains (id, title, category, class, fine, citeable, bookable): `TR-361` Open container in a
  vehicle, traffic, infraction, 200, cite; `TR-371` Hit and run, traffic, misdemeanor, 500, cite+book;
  `TR-380` Evading a police officer, traffic, felony, 0, book; `TR-390` Parking violation, traffic, infraction,
  60, cite; `TR-391` Parking in a fire lane, traffic, infraction, 150, cite; `TR-392` Disabled parking
  violation, traffic, infraction, 350, cite; `PC-221` False identification to an officer, criminal,
  misdemeanor, 0, book; `PC-231` Resisting arrest, misdemeanor, book; `PC-251` Burglary, felony, book;
  `PC-252` Robbery, felony, book; `PC-253` Vandalism, misdemeanor, 250, cite+book; `PC-254` Trespass,
  misdemeanor, 150, cite+book; `PC-255` Fraud, felony, book; `PC-260` Possession of a controlled substance,
  felony, book; `PC-261` Possession of drug paraphernalia, misdemeanor, 100, cite+book; `PC-262` Carrying a
  concealed weapon, felony, book; `PC-263` Brandishing a weapon, misdemeanor, book; `PC-270` Assault,
  misdemeanor, book; `PC-271` Battery, misdemeanor, book; `PC-272` Domestic battery, misdemeanor, book;
  `PC-273` Protective order violation, misdemeanor, book; `PC-274` Assault on an officer, felony, book;
  `PC-280` Disorderly conduct, misdemeanor, 200, cite+book; `PC-281` Public intoxication, misdemeanor, 100,
  cite+book; `PC-282` Stalking, felony, book; `PC-283` Criminal threats, felony, book; `PC-284` Harassment,
  misdemeanor, 250, cite+book; `PC-290` Animal at large, criminal, infraction, 100, cite; `PC-291` Shoplifting
  (petty theft from a store), misdemeanor, 250, cite+book. (Unlisted fines are 0.)
- `tenCodes.json` gains `"pursuit": { "code": "10-80", "plain": "pursuit" }`, `"shotsFired": { "code": "10-71",
  "plain": "shots fired" }`, `"ems": { "code": "10-52", "plain": "ambulance" }`, `"custody": { "code": "10-15",
  "plain": "subject in custody" }` (codeKey candidates for new types: `vehiclePursuit` pursuit, `shotsFired`
  shotsFired). Do not change existing keys.

### 4.7 Traffic data addition [traffic] `src/data/traffic/pullover.json`
```jsonc
"flee": { "speedFactor": 1.45, "maxSpeed": 34, "crossSpeed": 7, "loseDistanceM": 450, "loseS": 20,
          "giveUpPerMin": 0.12, "minFleeS": 20, "awayBias": 0.75 }
```

## 5. People [people] (`src/people/**`, `src/records/**`, `src/data/people/**`)

### 5.1 Identity generation (pure)
`generateIdentity(seed, id, record, epochDay)` combines the Phase 2 record (the CAD truth: name, sex, DOB,
height, weight, eyes, hair, address, licence, warrants, supervision, gang, mental-health note, officer
safety notes, firearms, priors) with hashed traits. Every trait uses `unitHash(seed, SALT.x, id)` (or
`unitHash(seed, SALT.x ^ epochDay, id)` for daily traits) with one distinct salt constant per trait
(`SALT` object in `src/people/identity.ts`, values `0x5050_0001...`). Rules (all must hold; tests check them):
- `age = ageOn(record.dob, epochDay)`; `juvenile = age < 18`; `elderly = age >= 70`.
- `vehicleId = vehicleOfOwner(seed, id)` (-1 none).
- `employer`: retired when age ≥ `retiredAge`; student (`"Student"`) with `studentShare` when age ≤
  `studentMaxAge`; `"Unemployed"` with `unemployed`; else `employers[hash % n]`.
- `temperament` by weights; `honesty = clamp(lerp(min, max, u) - risk * riskPenalty, 0, 1)` where `risk` =
  `min(1, (warrants + priors with kind arrest + (gang ? 2 : 0) + officerSafety.length) / 6)` from the record.
- `attitude = clamp(lerp(min, max, u) + perPrior * priors + perArrestPrior * arrestPriors + (gang ? gang : 0), -1, 1)`.
- `language`: English with `englishShare`, else weighted `others`, `english` = `'none'` with `noEnglishShare`
  else `'limited'`.
- `hearing`: deaf / hardOfHearing by rate (elderly use `elderlyHardOfHearing` for hard of hearing).
- `dementia`: only when `age >= minAge`, with `rate`.
- `mental`: when `record.mentalHealth !== null` always a condition from `withRecordNote` weights (never
  `'none'`); otherwise `baseRate` → `base` weights; else `'none'`.
- `health`: independent flags; heart only at `minAge`+.
- `drinker` = `u ^ propensityExponent` (0..1); `drugUse` = `'none'` unless `u < rate * (1 + risk *
  riskFactor)`, then a weighted kind.
- `wanted` = the *viewed* record (overlay applied) has ≥ 1 warrant.
- `appearance`: `skin` palette index by hash; `hair` from `record.hair` (bald → hair hex null → renderer
  hides the hair cap); `top`/`bottom` daily (`SALT ^ epochDay`) palette indexes (+ names for descriptions);
  `heightM = record.heightCm / 100`; `build = clamp(0.85 + (bmi - 18) * 0.03, 0.85, 1.25)` with bmi from
  record weight/height.
- `family`: §5.2. `guardianId`: for a juvenile, the oldest `parent` link, else -1; adults -1.
- `baseItems` (§5.3).

### 5.2 Family links (symmetric, deterministic)
Clusters are formed inside each last-name bucket (`NameIndex.bucket(lastIndex, out)`, a new method returning
the ids with exactly that last-name index, ascending): a person's cluster key is
`hash3(seed, SALT.family, id) % max(1, ceil(bucketSize / clusterSize))`; the cluster = bucket members with the
same key. Relations between A and B in a cluster: if `|ageA - ageB| >= 18` and `<= 45` → the older is
`'parent'` of the younger (the younger is `'child'`); else if both ≥ 18 and `|diff| <= 12` and they are the
pair with the smallest difference among adults in the cluster → `'partner'`; else if `|diff| <= 15` →
`'sibling'`; else `'relative'`. `familyOf(A)` lists B with the relation *from A's point of view*
(A's parent B ⇔ B's child A). Family members may live at different addresses (records are independent);
nothing in the game may claim they live together.

### 5.3 Items, intoxication, occupants (pure)
- `baseItems(seed, id, record, identity, epochDay)`: daily personal items by `items.daily` rates; driver's
  licence when the licence status is not `none` and `u < driversLicenseCarry`; `fakeId` when risk > 0.4 and
  `u < fakeIdIfRisk` (persistent: no day salt); `knife` (`knife`, or `knifeIfSafetyNote` with an officer
  safety note); `handgun` with a "carry weapons" officer-safety note (`handgunIfSafetyNote`) or a registered
  handgun (`handgunIfRegistered`); `brassKnuckles` gang members; drugs of the person's kind (`cannabis` →
  `cannabis`, others → `narcotics` or `pills` for depressant/opioid) with `drugsIfUser` daily, paraphernalia
  (`pipe` for cannabis/stimulant, `syringe` for opioid) with `paraphernaliaIfUser`; `stolenGoods`,
  `creditCards` with risk. Returned as `CarriedItem[]` with instance ids `p<id>:<item>:<n>` and a `where`
  (`pocket` for documents/personal/drugs, `waistband` for weapons, `bag` when a backpack is carried).
- `vehicleItems(seed, vehicleId, epochDay, driver: { id, drinker, drugUse, intoxicated, weaponCarrier, risk })`:
  `openContainer` (driver intoxicated, `openContainerIfDrinking`, visible, `cabin`), `liquorBottle`,
  drugs, a weapon under the seat, stolen goods, burglary tools; ids `v<vehicleId>:<item>:<n>`.
- `baseIntoxication(seed, id, gameSeconds, drinker, drugUse)`: day `d = floor(game / 86400)`; a session
  happens on day d when `unitHash(seed, SALT.drinkDay ^ d, id) < drinker * weekday[weekday(d)] * sessionRate`;
  start hour, duration and peak BAC from further hashes; BAC rises linearly for `riseH` to the peak, holds
  until the session ends, then falls by `eliminationPerHour` (sessions of day d-1 that run past midnight
  count too). Drug use: on day d with `dailyUseRate`, level 0.3-0.8 between 18:00 and 02:00. Returns
  `{ bac, drug, level }` with `level = clamp(bac / 0.2, 0, 1)` or the drug level, whichever is larger.
- `occupantsOf(seed, vehicleId)`: `[driverOf(seed, vehicleId), ...passengers]`, passenger count drawn from
  `occupants.passengers` by `unitHash(seed, SALT.passengers, vehicleId)`, passenger ids
  `hash3(seed, SALT.passenger + k, vehicleId) % PERSON_POPULATION` (skip duplicates / the driver by +1).
  Fleet vehicle ids (`isFleetVehicleId`) return `[]`.

### 5.4 Population (state deltas) and API
```ts
// src/people/types.ts
export type Temperament = 'calm' | 'timid' | 'irritable' | 'volatile';
export type DrugKind = 'none' | 'cannabis' | 'stimulant' | 'opioid' | 'depressant';
export type MentalCondition = 'none' | 'anxiety' | 'depression' | 'bipolar' | 'schizophrenia' | 'ptsd';
export type HealthCondition = 'diabetic' | 'epilepsy' | 'heart' | 'asthma';
export type Relation = 'parent' | 'child' | 'partner' | 'sibling' | 'relative';
export type Custody = 'none' | 'detained' | 'arrested' | 'jailed' | 'hospital' | 'released';
export interface FamilyLink { readonly personId: number; readonly relation: Relation }
export interface Appearance { readonly skin: number; readonly hair: number | null /* 0xRRGGBB, null bald */; readonly top: number; readonly topName: string;
  readonly bottom: number; readonly bottomName: string; readonly heightM: number; readonly build: number }
export interface Intoxication { readonly bac: number; readonly drug: DrugKind; readonly level: number /* 0..1 */ }
export interface CarriedItem { readonly instance: string; readonly item: string; readonly where: 'pocket' | 'waistband' | 'bag' | 'hand' | 'cabin' | 'underSeat' | 'glovebox' | 'trunk' | 'ground'; readonly visible: boolean }
export interface NpcIdentity {
  readonly id: number; readonly record: PersonRecord; readonly age: number; readonly juvenile: boolean; readonly elderly: boolean;
  readonly employer: string; readonly vehicleId: number; readonly family: readonly FamilyLink[]; readonly guardianId: number;
  readonly temperament: Temperament; readonly honesty: number; readonly attitude: number; readonly risk: number;
  readonly language: { readonly id: string; readonly label: string; readonly english: 'fluent' | 'limited' | 'none' };
  readonly hearing: 'normal' | 'hardOfHearing' | 'deaf'; readonly dementia: boolean; readonly mental: MentalCondition;
  readonly health: readonly HealthCondition[]; readonly drinker: number; readonly drugUse: DrugKind; readonly wanted: boolean;
  readonly appearance: Appearance; readonly baseItems: readonly CarriedItem[] }
/** One answer the person gave (statement log, per person per incident). `truthful` is hidden truth: never shown to the player. */
export interface Statement { readonly incident: string; readonly fact: string; readonly value: string; readonly text: string; readonly game: number;
  readonly truthful: boolean; readonly confused: boolean }
export type FactSource = 'claim' | 'document' | 'record' | 'evidence' | 'observation' | 'booking';
/** Something the player has discovered about the person (inconsistency-engine input). */
export interface PersonFact { readonly id: number /* unique per person */; readonly incident: string; readonly topic: string; readonly value: string;
  readonly source: FactSource; readonly display: string; readonly detail: string; readonly game: number }
export interface OfficerHistory { readonly count: number; readonly lastGame: number; readonly lastOutcome: string; readonly rapport: number }
export interface NpcState { readonly intoxication: Intoxication; readonly mood: number; readonly custody: Custody; readonly injured: number;
  readonly deceased: boolean; readonly missing: boolean }

// src/people/population.ts
export class Population {
  constructor(deps: { readonly seed: number; readonly records: RecordsDb; now(): number /* game seconds */ });
  readonly seed: number;
  readonly revision: number;                                   // bumps on every delta change
  identity(id: number): NpcIdentity;                           // LRU cache 2048 keyed (id, epoch day); record via records.peekPerson
  appearance(id: number): Appearance;                          // identity(id).appearance
  state(id: number): NpcState;                                 // base (intoxication at now()) + deltas
  intoxication(id: number): Intoxication;                      // delta (decayed by eliminationPerHour since set) or base
  setIntoxication(id: number, bac: number, drug: DrugKind): void;
  ensureIntoxicated(id: number, minBac: number): void;         // raises BAC to minBac (DUI-behaviour drivers)
  setMood(id: number, mood: number): void; setCustody(id: number, c: Custody): void; setInjured(id: number, v: number): void;
  setDeceased(id: number): void; setMissing(id: number, missing: boolean): void;
  itemsOn(id: number): readonly CarriedItem[];                 // base items - seized + added
  vehicleItems(vehicleId: number, driverId: number): readonly CarriedItem[];
  addItem(owner: ItemOwner, item: string, where: CarriedItem['where'], visible: boolean): CarriedItem;   // scenario-placed items
  seize(owner: ItemOwner, instance: string): boolean;          // removes from the owner (evidence)
  occupantsOf(vehicleId: number): readonly number[];
  officerHistory(id: number): OfficerHistory;
  recordContact(id: number, outcome: string, rapportDelta: number): void;   // with the player officer
  addStatement(id: number, s: Statement): void; statements(id: number, incident?: string): readonly Statement[];
  addFact(id: number, f: Omit<PersonFact, 'id'>): PersonFact; facts(id: number, incident?: string): readonly PersonFact[];
  rememberLie(id: number, incident: string, fact: string, value: string): void; lieFor(id: number, incident: string, fact: string): string | null;
  setFlag(id: number, flag: string, on: boolean): void; hasFlag(id: number, flag: string): boolean;
  isTouched(id: number): boolean;
  serialize(): PeopleSave; restore(save: PeopleSave): void;    // malformed entries dropped silently
}
export type ItemOwner = { readonly kind: 'person'; readonly id: number } | { readonly kind: 'vehicle'; readonly id: number };
// pure exports
export function generateIdentity(seed: number, id: number, record: PersonRecord, epochDay: number): NpcIdentity;
export function familyOf(seed: number, id: number, index: NameIndex): FamilyLink[];
export function baseIntoxication(seed: number, id: number, gameSeconds: number, drinker: number, drugUse: DrugKind): Intoxication;
export function occupantsOf(seed: number, vehicleId: number): number[];
export function describePerson(identity: NpcIdentity): { sex: 'M' | 'F'; ageBand: string /* "in their 30s" */; top: string; bottom: string; hair: string; heightText: string };
export const ITEMS: readonly ItemDef[]; export function itemDef(id: string): ItemDef;   // throws on unknown
export const PEOPLE_DATA: PeopleData;
export function createPeopleCommands(deps: { people(): Population | null }): Command[];   // `who <id>` (identity + state + items), `intox <id> <bac>`
```
`RecordsDb` gains `peekPerson(id: number): PersonRecord` — the overlay view **without** marking the record
touched (ambient people must not grow the records snapshot); `NameIndex` gains `bucket(lastIndex, out)`.
The contact module calls `records.person(id)` (touching) when a conversation starts.

### 5.5 PeopleSave (frozen after this phase)
```ts
export interface PeopleSave { version: 1; identityVersion: 1; persons: PersonDeltaSave[] }
export interface PersonDeltaSave {
  id: number; touched: number /* game seconds of the last change */;
  intox?: { bac: number; drug: DrugKind; level: number; setAt: number };   // explicit intoxication (decays from setAt)
  mood?: number; custody?: Custody; custodySince?: number; injured?: number; deceased?: boolean; missing?: boolean;
  seized?: string[];                          // seized instance ids (person and vehicle-owned ids alike)
  added?: { instance: string; item: string; owner: 'person' | 'vehicle'; ownerId: number; where: string; visible: boolean }[];
  officer?: OfficerHistory;                   // contacts with the player officer
  statements?: Statement[];                   // newest last, <= 100 per person
  facts?: PersonFact[]; nextFactId?: number;  // <= 100 per person
  lies?: { incident: string; fact: string; value: string }[];
  flags?: string[];
}
```
Cap: 3 000 persons; when over, drop least-recently-touched persons that have no statements, facts, custody
other than `none`/`released`, officer history or added/seized items. `isPeopleSave(x)` structural validator.
Vehicle-owned seized/added items are stored on the delta of the vehicle's *owner* person id
(`ownerOfVehicle`), so the save stays person-keyed.

### 5.6 Tests (`test/people/**`, existing `test/records/**` stay green)
1. **Determinism**: `generateIdentity` for 2 000 ids twice and in reverse order → deep-equal; a second
   `Population` instance (new session, same seed) → equal identities; after `serialize` → JSON → `restore`
   into a fresh `Population` → equal identities *and* equal states; different seed → different identities.
2. **Records consistency (never contradict)**: for 2 000 ids: identity.record deep-equals `records.person(id)`
   view; `age === ageOn(dob, day)`; `juvenile ⇔ age < 18`; `vehicleId === vehicleOfOwner`; hair colour hex
   matches `record.hair` (null ⇔ bald); `heightM*100 === heightCm`; `mental !== 'none'` whenever
   `record.mentalHealth` is set; `dementia ⇒ age >= 70`; `wanted ⇔ warrants.length > 0` (and false after
   `records.serveWarrant` of all warrants); `driversLicense` ∈ items ⇒ licence status ≠ none; a carried
   `handgun` ⇒ safety note or a registered handgun.
3. Family symmetry: `B ∈ familyOf(A) as parent ⇔ A ∈ familyOf(B) as child`; partner/sibling/relative symmetric.
4. Intoxication curve: zero outside a session, peak inside, monotone fall after; deterministic.
5. Deltas: set/clear each field; seize/add items; statements/facts caps; save cap and retention rule.
6. `occupantsOf`: driver first equals `driverOf`; no duplicates; fleet ids → [].
Perf: `generateIdentity` ≤ 0.1 ms average (test with 2 000 ids, ≤ 400 ms total); no allocation rules apply
only to the hot paths of other modules (people is called on events).

## 6. Calls [calls] (`src/calls/**`, `src/cad/**`, `src/data/calls/**`, `src/data/cad/**`)

### 6.1 CAD merge and CAD additions
- `src/calls/cadRows.ts` (imports JSON only — **no import of `src/cad/**`**, to avoid a cycle):
  `catalogCadRows(): unknown[]` = every type row of `types/*.json` (files sorted by path, rows in order)
  merged over its family's `defaults` (shallow per key; the row wins), with only the Phase 2 CAD keys
  (`id label codeKey category generated weight priority location districts units onSceneS callers narratives
  fill dispositions`). Fallbacks when neither the row nor the family `defaults` gives a key: `codeKey` null,
  `fill` `{}`, `districts` `{ "water": 0 }`, `callers` `{ "citizen": 0.8, "anonymous": 0.2 }`, `units` `[1, 1]`,
  `onSceneS` `[180, 420]`, `dispositions` = the family's outcome dispositions (unique, in outcome order).
- `src/cad/data.ts`: `CALL_TYPES = [...validateCallTypes(callTypesJson, ctx), ...validateCallTypes({ version: 1,
  types: catalogCadRows() }, ctx, 'calls/types/*.json')]` and a duplicate-id check across both lists (throw).
- `CadCall` gains `links: number[]` (linked call ids). `CadState.linkCalls(a, b, t)`: adds each id to the
  other's `links` (no duplicates), narrative `"Linked to C-xxxxx"` on both, emits `cad:callUpdated { change:
  'links' }` (the `change` union gains `'links'`). `isCadSave` accepts calls without `links` (restore fills []).
- `UnitRequest` stop contact becomes `{ kind: 'stopContact'; action: StopAction; personId?: number }`
  (`personId` = the identity the driver *claimed*; the dispatcher handles it, §11.8).
- Data additions of §4.6.

### 6.2 Catalog API (`src/calls/catalog.ts`, `src/calls/types.ts`)
```ts
export const ITEM_IDS: readonly [...26 ids]; export const PROFILE_IDS: readonly [...32]; export const SERVICE_KINDS: readonly [...11];
export const VARIANT_KINDS: readonly ['escalation', 'deescalation', 'false', 'duplicate', 'swatting', 'ambush'];
export const SPOTS: readonly [...10]; export const ANCHORS: readonly [...7]; export const NPC_COMMAND_IDS: readonly [...17];
export type VariantKind = (typeof VARIANT_KINDS)[number]; export type ServiceKind = ...; export type Spot = ...; export type Grade = 'good' | 'ok' | 'bad';
export type Cond = string | { readonly all: readonly Cond[] } | { readonly any: readonly Cond[] } | { readonly not: Cond };
export interface PersonConstraint { readonly minAge?: number; readonly maxAge?: number; readonly warrant?: boolean; readonly mentalHealth?: boolean; readonly risk?: boolean; readonly sex?: 'M' | 'F' }
export interface RoleDef { readonly role: string; readonly count: readonly [number, number]; readonly person: 'caller' | 'driver' | 'given' | PersonConstraint;
  readonly spot: Spot; readonly profile: string; readonly items: readonly { readonly item: string; readonly chance: number }[]; readonly weapon: string | null;
  readonly intoxication: { readonly chance: number; readonly bac: readonly [number, number]; readonly drug: string } | null; readonly injured: number;
  readonly deceased: boolean; readonly body: 'human' | 'dog'; readonly vehicle: string | null }
export interface VehicleRoleDef { readonly role: string; readonly count: readonly [number, number]; readonly mode: 'driving' | 'parked' | 'crashed';
  readonly behavior: 'normal' | 'dui'; readonly reported: boolean; readonly flee: number }
export interface BranchDef { readonly id: string; readonly weight: number; readonly flags: readonly string[]; readonly remove: readonly string[];
  readonly roleOverrides: Readonly<Record<string, Partial<RoleDef>>>; readonly vehicleOverrides: Readonly<Record<string, Partial<VehicleRoleDef>>> }
export interface ObjectiveDef { readonly text: string; readonly done: Cond; readonly show: Cond | null }
export interface OutcomeDef { readonly id: string; readonly when: Cond; readonly disposition: string; readonly grade: Grade }
export interface FamilyDef { readonly id: string; readonly label: string; readonly anchor: string; readonly derived: boolean; readonly roles: readonly RoleDef[];
  readonly vehicles: readonly VehicleRoleDef[]; readonly evidence: readonly { readonly item: string; readonly spot: Spot; readonly chance: number }[];
  readonly describe: string | null; readonly branches: readonly BranchDef[]; readonly variants: Readonly<Record<VariantKind, number>>;
  readonly escalation: { readonly narratives: readonly string[]; readonly roleOverrides: Readonly<Record<string, Partial<RoleDef>>>; readonly remove: readonly string[] } | null;
  readonly deescalation: (same shape) | null; readonly actions: readonly string[]; readonly objectives: readonly ObjectiveDef[]; readonly outcomes: readonly OutcomeDef[] }
export interface CallTypeDef { readonly id: string; readonly family: string; readonly label: string; readonly generated: boolean; readonly weight: number;
  readonly category: string; readonly branchWeights: Readonly<Record<string, number>>; readonly variants: Readonly<Record<VariantKind, number>> | null }
export interface ActionDef { readonly id: string; readonly label: string; readonly requires: Cond | null; readonly sets: readonly string[]; readonly service: ServiceKind | null;
  readonly reveals: 'inside' | 'hidden' | null; readonly durationS: number; readonly once: boolean; readonly consumes: Readonly<Record<string, number>>;
  readonly props: { readonly kind: string; readonly count: number; readonly pattern: 'line' | 'ring' | 'point'; readonly spacing: number; readonly radius: number } | null;
  readonly narrative: string | null; readonly radio: string | null; readonly command: { readonly command: string; readonly roles: readonly string[] } | null;
  readonly opens: 'citation' | 'report' | null }
export interface ServiceDef { readonly id: ServiceKind; readonly label: string; readonly arriveS: readonly [number, number]; readonly effect: ServiceEffect;
  readonly sets: readonly string[]; readonly radio: string; readonly ack: string; readonly arrivedText: string }
export type ServiceEffect = 'none' | 'transportInjured' | 'resolveBarricade' | 'revealHidden' | 'removeDeceased' | 'interpreter' | 'secureAnimal' | 'towVehicles';
export interface VariantConfig { /* variants.json as typed fields */ }
export interface CallCatalog { readonly families: readonly FamilyDef[]; readonly types: readonly CallTypeDef[]; readonly actions: readonly ActionDef[];
  readonly services: readonly ServiceDef[]; readonly variants: VariantConfig; readonly legacy: Readonly<Record<string, string>> }
export function validateCatalog(input: { families: unknown; types: readonly { file: string; json: unknown }[]; actions: unknown; services: unknown;
  variants: unknown; legacy: unknown }, ctx: { dispositions: readonly string[]; crimeCategories: readonly string[]; trunkItems: readonly string[] }): CallCatalog;
export const CALL_CATALOG: CallCatalog;        // validated at import (ctx from DISPOSITIONS, CRIME_CATEGORIES, TRUNK_ITEMS)
export function familyForType(typeId: string): FamilyDef | null;   // catalog types, then legacy.json; null for officer calls
export function callTypeDef(typeId: string): CallTypeDef | null;
export function actionDef(id: string): ActionDef; export function serviceDef(id: ServiceKind): ServiceDef;
```

### 6.3 Scenario builder (`src/calls/scenario.ts`) — pure
```ts
export interface PersonDescription { readonly sex: 'M' | 'F'; readonly ageBand: string; readonly top: string; readonly bottom: string; readonly hair: string; readonly heightText: string }
export interface ScenarioInput {
  readonly seed: number; readonly callId: number; readonly typeId: string; readonly priority: number;
  readonly location: { readonly x: number; readonly z: number; readonly edge: number; readonly text: string; readonly near: string; readonly street: string };
  readonly callerPersonId: number;            // CAD caller person id, -1 when not a citizen
  readonly reportedVehicleId: number;         // CAD call vehicles[0] (the narrative {plate} car) or -1
  readonly existingVehicleId: number;         // an active traffic car the scenario is about (stop, pursuit) or -1: the first vehicle role uses it, `existing` true
  readonly given: readonly number[];          // person ids for `person: "given"` roles, in role order
  readonly derivedBranch: string | null;      // for `derived` families
  readonly graph: RoadGraph;
  pickPerson(c: PersonConstraint, rng: Rng): number;        // scene: constraint search, excludes busy persons
  driverOf(vehicleId: number): number;                      // people occupantsOf(...)[0]
  pickVehicle(rng: Rng): number;                            // a registry vehicle that can be on the road
  describe(personId: number): PersonDescription;
  addressAt(edge: number, s: number): string;               // cad addressOnEdge text
}
export interface Participant { readonly index: number; readonly role: string; readonly personId: number /* -1 animals */; readonly profile: string;
  readonly spot: Spot; readonly spotIndex: number /* nth person on that spot */; readonly items: readonly string[]; readonly weapon: string | null;
  readonly intoxication: { readonly bac: number; readonly drug: string } | null; readonly injured: boolean; readonly deceased: boolean;
  readonly body: 'human' | 'dog'; readonly vehicle: number /* scenario vehicle index, -1 */; readonly seat: number /* -1 */ }
export interface SceneVehicleSpec { readonly index: number; readonly role: string; readonly vehicleId: number; readonly mode: 'driving' | 'parked' | 'crashed';
  readonly behavior: 'normal' | 'dui'; readonly flee: number; readonly reported: boolean; readonly existing: boolean /* never spawned */ }
export interface GroundItemSpec { readonly item: string; readonly spot: Spot; readonly spotIndex: number }
export type TimelineKind = 'describe' | 'narrative' | 'priority' | 'escalate' | 'deescalate' | 'duplicateCaller' | 'linkedCall' | 'correction' | 'unitReport' | 'ambush';
export interface TimelineEntry { readonly atS: number /* sim s after creation */; readonly kind: TimelineKind; readonly text: string; readonly priority: number /* 0 none */;
  readonly callerPersonId: number /* -1 */ }
export interface Anchor { readonly x: number; readonly z: number; readonly edge: number; readonly s: number /* along edge, m */; readonly side: 1 | -1 }
export interface Scenario { readonly version: 1; readonly callId: number; readonly typeId: string; readonly family: string; readonly variants: readonly VariantKind[];
  readonly branch: string; readonly anchor: Anchor; readonly reported: Anchor; readonly participants: readonly Participant[];
  readonly vehicles: readonly SceneVehicleSpec[]; readonly evidence: readonly GroundItemSpec[]; readonly timeline: readonly TimelineEntry[];
  readonly flags: readonly string[]; readonly errors: { readonly wrongAddress: boolean; readonly wrongDescription: boolean; readonly missingWeapon: boolean } }
export function buildScenario(input: ScenarioInput, rng: Rng): Scenario;   // rng = createRng(seed).stream('scenario:' + callId)
export function pickVariants(rates: VariantConfig['rates'], multipliers: Readonly<Record<VariantKind, number>>, rng: Rng): VariantKind[];
export function pickBranch(family: FamilyDef, type: CallTypeDef | null, rng: Rng): BranchDef;
```
Algorithm of `buildScenario` (fixed draw order — tests replay it):
1. `type = callTypeDef(typeId)`, `family = familyForType(typeId)` (throw on null). `variants = pickVariants(...)`
   with the type's `variants ?? family.variants`. Branch: `derivedBranch` for derived families, else
   `pickBranch` with `branchWeights` overrides.
2. Effective roles/vehicles: family defs with the branch's `remove` and `roleOverrides`/`vehicleOverrides`
   applied. Variant effects on roles: `false` removes every role except `caller`/`reporter`/`requester`;
   `swatting` removes every role except `caller`, then adds one `resident` role (1, `{ minAge: 18 }`, @door,
   `residentInnocent`); `ambush` removes every role except `caller` and adds `ambusher` (1, risk, @hidden,
   `ambusher`, weapon handgun). A role whose `vehicle` was removed keeps `vehicle -1`; if its spot was
   `vehicle` it becomes `curb`.
3. Anchor: from `location` snapped to `edge` (`s` = projection on the edge, `side` = rng ±1). With
   `errors.wrongAddress` (rate `dispatchErrors.wrongAddress`, never for derived families) the true anchor
   moves along the edge by ± `addressShiftM` (clamped to [5, length-5]); `reported` keeps the CAD position.
4. Participants: for each role, `count = rng.nextInt(min, max)`; person source → id (`caller` uses
   `callerPersonId` when ≥ 0 else `pickPerson({ minAge: 18 })`; `driver` uses `driverOf(vehicle)`; `given`
   pops from `given`); items (`chance` rolls), weapon, intoxication (`chance` roll, BAC uniform in range),
   injured (`injured` roll), `spotIndex` = running count per spot. Vehicles: `vehicleId` = `reportedVehicleId`
   for the `reported` role when ≥ 0, else `pickVehicle`; persons with `vehicle` get seats 0..3 in order.
5. Evidence: chance rolls. Flags: `branch:<id>`, `variant:<kind>` each, `role:<role>` for every role with ≥ 1
   participant, `juvenile:<role>` when that participant is < 18, the branch `flags`.
6. Timeline (sorted by `atS`): `describe` at 0 when `family.describe` names a present role: text
   `"RP describes the subject as a {sexWord} {ageBand}, {heightText}, wearing a {top} top and {bottom}{weaponText}."`
   where `wrongDescription` (rate) replaces `top` with a different palette name and `missingWeapon` (rate;
   only when armed) drops `weaponText` (`", armed with a <item label>"`); corrections at
   `correctionDelayS`: `"Correction: subject is wearing a {top} top."`, `"Update: second caller advises the
   subject has a {weapon}."`, `"Correction: RP advises the location is {trueAddress}."` (wrongAddress).
   Escalation at `escalation.delayS`: kind `escalate`, text from `family.escalation.narratives`, `priority =
   max(1, p + priorityDelta)`; deescalation likewise (`min(4, ...)`). Duplicate: `callers` entries
   `duplicateCaller` at increasing delays with `callerPersonId = pickPerson({ minAge: 18 })` and text
   `"Additional caller {name} reports the same incident."` (name filled by the scene); with
   `linkedCallChance` one `linkedCall` entry. Ambush: one `ambush` entry at `ambush.delayS` (armed when the
   player is within `triggerDistanceM`, §11.5).

### 6.4 Conditions, outcomes, reachability (`src/calls/conditions.ts`)
```ts
export function evalCond(c: Cond, flags: ReadonlySet<string>): boolean;      // "true"; "!x"; all/any/not
export function condAtoms(c: Cond): string[];                                 // for validation
export function outcomeFor(family: FamilyDef, flags: ReadonlySet<string>): OutcomeDef;   // first match (last is "true")
export function objectivesFor(family: FamilyDef, flags: ReadonlySet<string>): { text: string; done: boolean }[];  // shown ones only
export function producibleFlags(family: FamilyDef, branch: BranchDef): Set<string>;     // §11.3 vocabulary for this family/branch
export interface Reachability { readonly outcome: string; readonly reachable: boolean; readonly witness: readonly string[] }
export function reachableOutcomes(family: FamilyDef): Reachability[];
```
`reachableOutcomes`: for each branch b and each variant set V in {∅, {false}, {swatting}, {ambush},
{duplicate}, {escalation}, {deescalation}} (only kinds with multiplier > 0), let `fixed` = {`branch:b`} ∪
`variant:` flags of V ∪ the branch flags ∪ `role:` flags of present roles, and `P = producibleFlags(family,
b)`. Expand each outcome condition to DNF terms (positive atoms, negative atoms). A term is satisfiable when
positives ⊆ `fixed ∪ P` and negatives ∩ `fixed` = ∅. Witness = `fixed ∪ positives`; the outcome is reachable
when for some term, `outcomeFor(family, witness)` returns that outcome (earlier outcomes do not shadow it).

### 6.5 Tests (`test/calls/**`, `test/cad/**`)
1. Schema: the catalog loads; ≥ 150 Phase 3 types (exactly the 163 ids of §4.3); every family has ≥ 1 type
   (legacy types count: `trafficStop` has the Phase 2 row); every type's CAD row passes `validateCallTypes`; `CALL_TYPES` has
   no duplicate ids and contains all 175 ids; every family references only existing actions, services,
   profile ids, item ids, roles, branches; every `Cond` atom is in the vocabulary; malformed fixtures fail
   with a message naming file and path (one test per rule).
2. Required coverage: a test lists the requirement types (§18 "call types") and asserts each id exists.
3. Branching outcomes reachable: for every family, every outcome is reachable (`reachableOutcomes`) and
   `outcomeFor(witness)` returns it.
4. Variant rates: 20 000 `pickVariants` draws with all multipliers 1 → each kind's frequency within 4
   binomial standard deviations of its configured rate (exclusive kinds: `r_k`; duplicate `r_dup`;
   escalation `(1 - Σexclusive) * r_esc` etc.); multiplier 0 → never.
5. `buildScenario` determinism (same input twice → deep-equal; different callId → different), branch
   removal works, `false`/`swatting`/`ambush` role rewrites, errors and corrections appear at configured
   rates (±4σ over 5 000 builds with a stub input), timeline sorted, every participant person satisfies its
   constraint (stub `pickPerson` asserts).
6. CAD: `linkCalls`, save without `links`, new dispositions/statutes/ten-codes present.

## 7. Traffic additions [traffic] (`src/traffic/**`, `src/data/traffic/**`)

`registry.ts` stays frozen. All additions allocation-free per step; all Phase 1/2 traffic tests stay green;
snapshot exact (new optional fields).
```ts
export type FleeEndReason = 'crashed' | 'escaped' | 'gaveUp' | 'stopped';
export interface SubjectCarOptions { readonly behavior?: number /* BEHAVIOR bits */; readonly mode: 'driving' | 'parked' | 'crashed'; readonly hazards?: boolean }
class TrafficSystem {
  /** Spawns registry vehicle `vehicleId` (not already active) on the nearest lane to (x, z) within 200 m: driving (normal flow), or
   *  parked / crashed at the curb (PULL.parked, stopped, hazards for crashed); pinned. Returns the entity id, 0 when nothing fits. */
  spawnSubjectCar(vehicleId: number, x: number, z: number, options: SubjectCarOptions): number;
  /** Pins / unpins an active car by vehicle id (pinned cars are never despawned by distance). False when not active. */
  pin(vehicleId: number, pinned: boolean): boolean;
  /** Removes an active ambient car by vehicle id (scene cleanup, tow). */
  removeVehicle(vehicleId: number): boolean;
  /** Active slot of a vehicle id, -1 when not active. */
  slotOfVehicle(vehicleId: number): number;
  /** Flee mode (§7.1). Works on a driving car, the stop target (pulling or stopped) or a parked subject car. */
  flee(vehicleId: number): boolean;
  /** Ends a flee: the car pulls to the curb and stops (reason 'stopped'). */
  stopFlee(vehicleId: number): boolean;
  readonly fleeingCount: number;
  fleeState(vehicleId: number, out: { x: number; z: number; yaw: number; speed: number; edge: number }): boolean;
  /** Sets behaviour bits of an active car (scene: DUI subject). */
  setBehavior(vehicleId: number, bits: number): boolean;
}
```
### 7.1 Flee mode
A fleeing car: `pinned`; desired speed `min(limit * speedFactor, maxSpeed)`; at each lane change prefers
the exit whose end node increases the distance from the focus (choose the farthest end with probability
`awayBias`, else random) — no route; red signals and stop signs are yields (slow to `crossSpeed`, go when
the junction box is free: reuse the fleet emergency rule); it never yields to emergency vehicles and is never
a stop or yield target. If it was the stop target, the stop ends with `traffic:released { reason: 'fled' }`
(the reason union gains `'fled'`). Every step: crash (`TRAFFIC_STATE.crashed`) → end `crashed`; distance to
the focus > `loseDistanceM` continuously for `loseS` → end `escaped` and despawn; after `minFleeS`, each
second with probability `giveUpPerMin / 60` → end `gaveUp`: pulls to the curb and stops with hazards
(`PULL.parked`, pinned; the scene calls `forceStop` to make it a stop). `stopFlee` → curb, `stopped`.
Events: `traffic:fleeing { eid, vehicleId }` on start, `traffic:fleeEnded { eid, vehicleId, reason, x, z }`.
Snapshot fields: `flee?: 1`, `fleeTimer?`, `fleeLost?`; `TrafficCarSave.pinned` exists.
### 7.2 Tests (`test/traffic/**`)
Subject car spawn (driving / parked / crashed), pin / remove, flee: speed above the limit, away from the
focus, runs a red signal at `crossSpeed`, escaped after `loseS` beyond `loseDistanceM`, gaveUp parks
(seeded), crashed ends, the stop target fleeing emits `released { reason: 'fled' }`, snapshot round trip
mid-flee continues identically, no allocation in `step` with a fleeing car (heap delta check pattern of
`test/traffic/perf.test.ts`).

## 8. NPC system [npc] (`src/npc/**`, `src/data/npc/**`)

### 8.1 Pools and view
`NpcSystem` owns two pools in SoA typed arrays sized from `npc.json`: **pedestrians** (`peds.max`) and
**actors** (`actors.max`), plus **seated occupants** of nearby traffic cars (rebuilt each step, ≤ 48). It
writes one combined read-only `NpcView` (structurally a `HumanoidSource` of §12.1) with capacity
`peds.max + actors.max + 48`: entries 0..peds-1 pedestrians, then actors, then occupants. Positions are
world metres; occupants use `anchor = vehicle eid` and vehicle-local offsets (x = seat fraction × body
width, y = `seatY`, z = seat fraction × body length; models from `VEHICLE_MODELS[VehicleLook.model[eid]]`).
`prevX/prevZ/prevYaw` are copied at the start of each step. `gait` advances by `speed * dt / strideM`
(strideM = 1.4 × height/1.75). Appearance colours come from `people.appearance(personId)` at spawn
(cached in the pool).

### 8.2 Ambient pedestrians (deterministic, LOD)
- Stream: `rng.stream('peds')` (rng = `session.rng.stream('npc')`).
- Target count every `retargetS`: Σ over edges within `spawnRadiusM` (`graph.edgesNear`, reused out array)
  with `sidewalk > 0` of `length_km * perKm[district] * hourly[hour]`, ×2 for both sides, capped at `max`.
- Spawn ≤ `spawnPerStep` per step while below target: a random edge from the near list weighted by length,
  side ±1, `s` uniform, distance to focus ≥ `minSpawnM`, person id = `nextInt(0, POP-1)` retried ≤ 4 times
  until not active (not a ped/actor/occupant), not in custody `arrested|jailed|hospital`, not deceased, and
  not a juvenile between 23:00 and 05:00. Lateral offset = `width/2 + sidewalk/2`. Direction ±1.
- Move along the sidewalk line at its speed; at the edge end pick a connected edge with a sidewalk at the
  end node (rng; U-turn when none) and continue from that edge's end at the same side.
- LOD by distance to focus: < `nearM` every step, < `midM` every `midEvery` steps, else every `farEvery`
  (accumulated dt applied). Despawn beyond `despawnRadiusM`.
- Ambient pedestrians do not react except: when the officer's weapon is drawn within 20 m they switch to
  run speed away from the officer for 10 s.
- `promotePedestrian(slot)` → creates an actor at its position/yaw (profile `bystander`, person id kept) and
  removes the pedestrian.

### 8.3 Actors and behaviour state machine
```ts
export const ACTOR_STATE = { idle: 0, wander: 1, talk: 2, follow: 3, hold: 4, handsUp: 5, kneel: 6, prone: 7, cuffed: 8, seated: 9,
  flee: 10, hide: 11, fight: 12, armed: 13, down: 14, lying: 15, leave: 16, crowd: 17, sit: 18, walkTo: 19 } as const;
export type ActorStateId = (typeof ACTOR_STATE)[keyof typeof ACTOR_STATE];
export type NpcCommand = 'stop' | 'handsUp' | 'getDown' | 'turnAround' | 'comeHere' | 'stayBack' | 'followMe' | 'sitDown' | 'stepOut' | 'dropWeapon' | 'showHands'
  | 'leaveArea' | 'disperse' | 'calmDown' | 'turnOffEngine' | 'tossKeys' | 'walkBackward' | 'release' | 'returnToVehicle';
export type CommandOutcome = 'comply' | 'refuse' | 'flee' | 'fight' | 'confused';
export interface ActorSpawn { readonly personId: number /* -1 animal */; readonly x: number; readonly z: number; readonly yaw: number; readonly profile: string;
  readonly role: string; readonly callId: number; readonly hidden: boolean; readonly body: 'human' | 'dog'; readonly weapon: string | null /* carried, not drawn */;
  readonly vehicleId: number /* associated vehicle (not seated: seated people are occupants, setOccupants), -1 */; readonly pose?: 'stand' | 'sit' | 'lying' | 'kneel' }
export interface ActorInfo { id: number; personId: number; role: string; callId: number; state: ActorStateId; x: number; z: number; yaw: number;
  stress: number; cuffed: boolean; following: boolean; hidden: boolean; armed: boolean; weaponDrawn: boolean; vehicleId: number; seat: number; profile: string; body: number }
export interface NpcFocus { x: number; z: number; yaw: number; speed: number; onFoot: boolean; weapon: 'none' | 'sidearm' | 'taser'; lights: boolean; backup: number }
export interface NpcDeps { readonly seed: number; readonly rng: Rng; readonly city: City; readonly people: Population; readonly traffic: TrafficSystem;
  readonly world: GameWorld; readonly bus: EventBus<EventMap>; now(): number /* game seconds */ }
export class NpcSystem {
  constructor(deps: NpcDeps);
  step(dt: number, simTime: number, focus: NpcFocus): void;        // fixed step, order 60
  readonly view: NpcView;                                           // HumanoidSource (presentation)
  readonly stats: { peds: number; actors: number; occupants: number; stepMs: number };
  // queries (no allocation; `out` reused)
  nearestPerson(x: number, z: number, yaw: number, maxDist: number, coneCos: number, out: PersonPick): PersonPick | null;   // actors (not hidden), peds, occupants of the stop car
  actor(id: number, out: ActorInfo): ActorInfo | null;
  actorOfPerson(personId: number): number;                          // actor id or 0
  actorsOfCall(callId: number, out: number[]): number[];
  isActivePerson(personId: number): boolean;
  // actors
  spawnActor(spec: ActorSpawn): number;                             // actor id, 0 when the pool is full; a person who is a pedestrian is promoted instead
  promotePedestrian(slot: number): number;
  removeActor(id: number): void;                                    // despawn (left, transported, caged)
  reveal(id: number): void;                                          // hidden → idle (rolls flee once)
  setProfile(id: number, profile: string): void; setStress(id: number, stress: number): void; setRole(id: number, role: string, callId: number): void;
  evaluateCommand(id: number, cmd: NpcCommand, ctx: CommandContext): CommandOutcome;   // rolls with the actors stream (call from fixed steps only)
  applyCommand(id: number, cmd: NpcCommand, outcome: CommandOutcome): void;
  forceState(id: number, state: 'flee' | 'fight' | 'armed' | 'handsUp' | 'kneel' | 'prone' | 'leave' | 'lying' | 'crowd' | 'hold'): void;
  cuff(id: number): 'ok' | 'resist' | 'notReady';                  // ok when handsUp/kneel/prone/down/hold+compliant; else roll fightChance → resist (fight) or notReady
  uncuff(id: number): boolean;
  follow(id: number, on: boolean): boolean;                          // cuffed or compliant only
  tackle(officerX: number, officerZ: number, officerYaw: number): number;   // actor id taken down, 0 none (range tackleRangeM, 70° cone)
  taser(id: number, distance: number): boolean;                      // hit chance taserHit within taserRangeM → down taserDownS
  drawWeapon(id: number): void; dropWeapon(id: number): void;        // weapon → ground item event npc:weaponDropped
  walkTo(id: number, x: number, z: number): void;                    // then hold
  // vehicles
  setOccupants(vehicleId: number, personIds: readonly number[]): void;   // scenario occupants override people.occupantsOf
  occupantsOf(vehicleId: number): readonly number[];                 // override or people.occupantsOf
  stepOut(vehicleId: number, seat: number): number;                  // actor id standing at the door on the curb side, 0 when gone/out
  isOut(vehicleId: number, seat: number): boolean;
  // persistence
  serialize(): NpcSave; restore(save: NpcSave): void; dispose(): void;
}
export interface CommandContext { readonly tone: 'polite' | 'neutral' | 'commanding' | 'aggressive' | 'shout'; readonly rapport: number; readonly commMode: string;
  readonly weapon: 'none' | 'sidearm' | 'taser'; readonly backup: number; readonly lights: boolean }
export interface PersonPick { kind: 'actor' | 'ped' | 'occupant'; id: number /* actor id, ped slot, or vehicle id */; seat: number; personId: number; distance: number }
export function complianceChance(p: BehaviorProfile, id: NpcIdentity | null, intox: Intoxication, stress: number, ctx: CommandContext, cmd: NpcCommand): number;   // pure
export function understands(id: NpcIdentity | null, commMode: string, cmd: NpcCommand): number;   // pure 0..1
export type NpcView = HumanoidSource & { count: number };          // from render/people/pose.ts createHumanoidSource
export const BEHAVIORS: readonly BehaviorProfile[]; export function behavior(id: string): BehaviorProfile;
export const NPC_CONFIG: NpcConfig; export function createNpcCommands(deps: { npc(): NpcSystem | null }): Command[];   // peds stats|density <x>|clear, actors
```
### 8.4 Transitions (evaluated at the LOD rate inside `step`; tested through `NpcSystem` with seeded streams)
- **Approach** (first time the officer is within `approachTriggerM`, not restrained): roll `fleeChance`
  (+0.15 wanted, +0.1 juvenile, +0.1 carrying contraband, ×0 when lying/deceased) → `flee`; else when the
  actor carries a weapon roll `weaponDrawChance` → `armed` (weapon drawn, held item shown).
- **Hidden** actors are not rendered or picked; the officer within `revealDistanceM` (or `reveal()`) →
  `idle` and the approach roll.
- **flee**: route = `graph.routeBetweenPoints(from, target)` to a node chosen at `fleeRouteM` distance in
  the direction away from the officer (best of 6 candidates by angle), followed at run speed on the
  sidewalk offset; stamina `staminaS` then ×`tiredFactor`; route end → new route. Escape when > 
  `escapeDistanceM` from the officer for `escapeS` → `npc:escaped`, actor removed. A tackle or TASER →
  `down` (`npc:caught`). Each second roll `surrenderPerMin/60` × (1 + 0.5·backup) → `kneel` (`npc:surrendered`).
- **armed**: faces the officer; every `armedActionS`: roll surrender `surrenderPerMin/60 × (1 + weapon drawn
  0.5 + backup 0.5 + max(0, rapport))` → drop weapon (`npc:weaponDropped`, held cleared) + `handsUp`; else if
  hostile and the officer within 12 m roll 0.3 → `npc:attack { kind: 'fire' }` (handgun) or, for a knife,
  advance (`walkTo` officer) and `fight` within 1.5 m. TASER hit → `down`, weapon dropped.
- **fight**: `struggleS`; result roll `officerWinBase + officerWinPerBackup·backup` → `down` (officer wins) else
  `flee` (`npc:attack { kind: 'fight' }` at start, `force:used` is emitted by the caller of `cuff`/scene).
- **down**: `taserDownS`/`tackleDownS` → `prone` (stays until a command or cuffs).
- **cuffed**: `hold`, or `follow` (1.4 m behind the officer, walk/run to keep up).
- **crowd**: mill within `crowdRadiusM` of the spawn point; `disperse` command compliance → `leave`.
- **leave**: walk `leaveDistanceM` away along the sidewalk, then removed (`npc:left`).
- **lying** (unconscious, deceased): no transitions; removed by `removeActor`.
- Commands (`applyCommand` with outcome `comply`): stop→hold, handsUp→handsUp, getDown→kneel (again →
  prone), turnAround→yaw away from officer, comeHere→walkTo 1.5 m in front of the officer, stayBack→hold,
  followMe→follow, sitDown→sit, stepOut→(seated) stand at the curb-side door point, dropWeapon→drop +
  handsUp, showHands→handsUp, leaveArea/disperse/release→leave, calmDown→stress −0.2, turnOffEngine /
  tossKeys→ no movement (flags only, the caller records them), walkBackward→walkTo a point 6 m toward the
  officer facing away, returnToVehicle→walk to the door and re-seat. `refuse`: stress +0.1. `flee`/`fight`
  → those states. `confused`: no change.
- **Compliance** (`complianceChance`): `p = profile.compliance + weaponBonus (sidearm 0.2, taser 0.15; ×1.5
  for hostile/armed demeanors) + 0.08·min(backup, 3) + (lights 0.05) + 0.2·rapport − 0.25·stress −
  0.2·intox.level − (wanted 0.15) − max(0, −attitude)·0.15 + tone (commanding +0.1, shout +0.1, aggressive
  +0.05, polite 0) + (juvenile +0.05)`, clamped [0.02, 0.98]; `understands`: deaf → 0 unless commMode
  `written`/`gesture` (gesture: 0.9 for stop/handsUp/getDown/comeHere/stayBack/showHands/dropWeapon, else 0),
  hard of hearing → 0.6 verbal; English `none` → 0.6 for those simple commands (gestures help), 0.1 others,
  unless commMode `interpreter`/`translationApp`; `limited` → 0.8/0.5; dementia → ×0.5. `evaluateCommand`:
  roll understands → else `confused`; roll compliance → `comply`; else roll flee chance (profile, +wanted)
  → `flee`; else hostile demeanor and roll `fightChance` within 2 m → `fight`; else `refuse`.
- Events (`src/npc/events.ts`): `npc:fled { actorId, personId }`, `npc:caught { actorId, personId, by: 'tackle' |
  'taser' | 'fight' }`, `npc:escaped`, `npc:surrendered`, `npc:attack { actorId, personId, kind: 'fight' | 'fire'
  | 'brandish' }`, `npc:weaponDropped { actorId, personId, item, x, z }`, `npc:left { actorId, personId }`,
  `npc:revealed { actorId, personId }`, all with `callId`.
### 8.5 LOD and budgets
Actor decisions: `nearHz` within `nearM`, `midHz` within `midM`, else `farHz` (schedule by
`stepCounter % period` with a per-actor phase offset = id % period). Movement every step within `midM`, else
with the decision. Pedestrians as §8.2. No allocation in `step` (routes are planned only on state changes:
allowed; store route polylines in a per-actor reused `Float32Array(64)`).
### 8.6 NpcSave
```ts
export interface NpcSave { version: 1; rng: RngState; pedsRng: RngState; actorsRng: RngState; step: number; nextActorId: number; retargetIn: number; target: number;
  peds: { personId: number; edge: number; s: number; side: number; dir: number; speed: number; gait: number; flee: number }[];
  actors: { id: number; personId: number; role: string; callId: number; profile: string; state: number; x: number; z: number; yaw: number; speed: number;
    stress: number; timer: number; stamina: number; flags: number /* bit: cuffed 1, following 2, hidden 4, armed 8, weaponDrawn 16, approached 32 */;
    weapon: string; vehicleId: number; seat: number; body: number; targetX: number; targetZ: number; route: number[]; routePos: number; lostTimer: number }[];
  occupants: [number, number[]][];   // overrides
  out: [number, number[]][];         // seats stepped out, per vehicle
}
export function isNpcSave(x: unknown): x is NpcSave;
```
### 8.7 Tests (`test/npc/**`)
Pedestrian determinism (two systems, same seed and focus path → identical `serialize`), density follows
district and hour (downtown noon > rural night), LOD update counts, no duplicate person ids active,
`promotePedestrian`; behaviour transitions table-driven (approach flee roll with a seeded rng, armed
surrender, fight resolution, down → prone, cuffed follow distance, crowd disperse, leave removal);
`complianceChance` monotonic (weapon drawn raises, stress lowers), `understands` for deaf/foreign/gesture;
flee route moves away from the officer and escapes; tackle within range only; occupants seated entries use
anchors and `stepOut` returns a standing actor at the curb side; save/restore mid-flee continues identically;
no allocation in `step` with 160 peds and 30 actors (heap delta test); step ≤ 0.15 ms average there.

## 9. Dialogue [dialogue] (`src/dialogue/**`, `src/data/dialogue/**`) — pure

### 9.1 Types
```ts
export type Tone = 'polite' | 'neutral' | 'commanding' | 'aggressive';
export type CommMode = 'verbal' | 'written' | 'gesture' | 'translationApp' | 'interpreter';
export type FactTopic = (typeof FACT_TOPICS)[number];
export type Intent = 'greet' | 'explainReason' | 'requestId' | 'askName' | 'askDob' | 'ask' | 'consent' | 'command' | 'reassure' | 'miranda' | 'release' | 'warn' | 'thank';
export type ConsentKind = 'searchPerson' | 'searchVehicle' | 'pbt' | 'sfst';
export interface Utterance { readonly id: string; readonly topic: string; readonly intent: Intent; readonly fact: FactTopic | null; readonly consent: ConsentKind | null;
  readonly command: string | null; readonly requires: readonly string[]; readonly text: Readonly<Record<Tone, string>> }
export interface IdentityClaim { readonly kind: 'true' | 'relative' | 'invented' | 'alteredDob'; readonly personId: number /* -1 invented */;
  readonly first: string; readonly middle: string; readonly last: string; readonly dob: number; readonly address: string;
  readonly document: 'dl' | 'fakeId' | 'none'; readonly dlNumber: string /* '' none */ }
export interface SubjectProfile {             // built by contact from people + scenario
  readonly personId: number; readonly identity: NpcIdentity; readonly intoxication: Intoxication; readonly demeanor: string; readonly role: string;
  readonly items: readonly CarriedItem[]; readonly vehicleItems: readonly CarriedItem[]; readonly vehicleOwnerId: number /* -1 none */;
  readonly guilty: boolean;                   // has a motive to lie (suspect role, wanted, contraband, intoxicated driver, stolen vehicle)
  readonly injured: boolean; readonly inVehicle: boolean; readonly restrained: boolean }
export interface IncidentTruth { readonly destination: string; readonly origin: string; readonly account: string; readonly suspectWhereabouts: string; readonly reason: string }
export interface DialogueContext { readonly tone: Tone; readonly commMode: CommMode; readonly hour: number; readonly officerName: string;
  readonly presence: { readonly lights: boolean; readonly backup: number; readonly weapon: 'none' | 'sidearm' | 'taser'; readonly uniform: boolean };
  readonly history: OfficerHistory; readonly trust: number; readonly truth: IncidentTruth; readonly guardianPresent: boolean; readonly interpreterAvailable: boolean }
export interface SubjectMemory {              // plain JSON (saved with the contact)
  rapport: number; stress: number; greeted: boolean; reasonGiven: boolean; mirandized: boolean; identity: IdentityClaim | null; identityRefusals: number;
  lies: Record<string, string>; asked: Record<string, number>; consent: Partial<Record<ConsentKind, 'granted' | 'denied'>>; consentAskedAt: Partial<Record<ConsentKind, number>> }
export interface DialogueResult { readonly lineKey: string; readonly text: string; readonly delayS: number; readonly understood: boolean;
  readonly statement: { readonly fact: FactTopic; readonly value: string; readonly display: string; readonly truthful: boolean; readonly confused: boolean } | null;
  readonly identity: IdentityClaim | null; readonly consent: { readonly kind: ConsentKind; readonly granted: boolean; readonly valid: boolean } | null;
  readonly escalate: 'flee' | 'fight' | null; readonly calmed: boolean; readonly memory: SubjectMemory }
```
### 9.2 API
```ts
export const UTTERANCES: readonly Utterance[]; export const TOPICS: readonly { id: string; label: string }[];
export function utterance(id: string): Utterance;
export function initialMemory(subject: SubjectProfile, ctx: DialogueContext): SubjectMemory;
export function available(subject: SubjectProfile, ctx: DialogueContext, memory: SubjectMemory): { utterance: Utterance; enabled: boolean; reason: string }[];
export function respond(u: Utterance, subject: SubjectProfile, ctx: DialogueContext, memory: SubjectMemory, rng: Rng): DialogueResult;
export function commandLine(outcome: 'comply' | 'refuse' | 'flee' | 'fight' | 'confused', subject: SubjectProfile, ctx: DialogueContext, rng: Rng): { lineKey: string; text: string };
export function officerLine(u: Utterance, tone: Tone, ctx: { officerName: string; reason: string }): string;
export function commModes(subject: SubjectProfile, ctx: DialogueContext): CommMode[];   // verbal always; written+gesture when hearing ≠ normal; translationApp when English ≠ fluent; interpreter when ctx.interpreterAvailable
export const LINE_KEYS: readonly string[];   // every key respond/commandLine can produce
```
### 9.3 Response algorithm (deterministic for a given rng)
1. Tone effect on memory: polite rapport +0.08 stress −0.03; neutral 0; commanding rapport −0.02 stress
   +0.05; aggressive rapport −0.12 stress +0.12 (×2 for demeanors `hostile`, `crisis`); `reassure` stress
   −0.15 (×1.5 polite). Night (22:00-05:00) stress +0.02 per utterance. Clamp rapport [−1, 1], stress [0, 1].
2. Understanding gate (§8.3 rules, questions use the "others" rates); not understood → `deaf.noResponse`,
   `hoh.repeat`, `foreign.untranslated` (text `({language}) ...`), `limited.confused`; `understood: false`,
   no statement. Delays: written 4 s, translationApp 6 s (10 % → `foreign.misunderstood`, no statement),
   interpreter 2 s, verbal 0.
3. Intent:
   - `greet` → `greet.<demeanor>`; `explainReason` → `reason.accept` or `reason.argue` (attitude < −0.3 or stress > 0.6).
   - `requestId` / `askName` / `askDob`: when `memory.identity` exists, repeat it (`identity.repeat`). Else
     refuse with `p = (demeanor hostile ? 0.5 : 0.1) − rapport·0.3` (`requestId.refuse`, refusals +1; after 2
     refusals and rapport < 0 the subject stays refusing). Lie with `L = clamp((1 − honesty)·0.8 + (wanted ?
     0.4 : 0) + (licence suspended/revoked/none and inVehicle ? 0.2 : 0) − rapport·0.2, 0, 0.95)` when `guilty`
     or wanted, else `L·0.2`. Lying: carries `fakeId` → claim from the fake (kind `relative` when a sibling
     or cousin exists else `invented`; document `fakeId`; dlNumber = the relative's DL or `D` + 7 hashed
     digits not on file) `requestId.handFake`; else verbal: 50 % `relative` (nearest-age sibling/relative,
     their record name/DOB/address), 30 % `invented` (random first/last from records `NAMES`, DOB = true
     DOB ± 1-4 years, address from a random street name and number), 20 % `alteredDob` (true name, DOB ±
     1-5 years) → `requestId.lieVerbal`. Truthful: `driversLicense` carried → `requestId.handDl` (document
     `dl`, dlNumber = `dlNumberOf`), else `requestId.noDlTrue`. Juvenile without DL → `requestId.juvenile`.
     Statements: `name` (`"FIRST LAST"`), `dob` (epoch day as string; display formatted), `identity`
     (`String(personId)`), `address`.
   - `ask` with fact: truth value — destination/origin/account/suspectWhereabouts from `ctx.truth`;
     `drinking` `'yes'` when bac ≥ 0.02 (`'some'` when < 0.05) else `'no'`; `drugs` `'yes'` when drug ≠ none
     or carrying drugs; `weapons` `'yes'` when carrying a weapon item; `vehicleContents` `'nothing'` or
     `'item:<id>'` of the first contraband/weapon/alcohol vehicle item; `vehicleOwner` `'self'` when
     `vehicleOwnerId === personId`, `'relative'` when the owner is family, else `'friend'`; `address` = record
     address (or the claimed identity's); `injured` `'yes'|'no'`. Lie when `guilty` and the fact is
     incriminating (drinking/drugs/weapons/vehicleContents/vehicleOwner/destination/origin/account for
     suspects) with `L` above: drinking lie = `'no'` (70 %) or `'some'`; drugs/weapons → `'no'`; contents →
     `'nothing'`; owner → `'self'` (stolen) ; destination/origin/account → a different value from `values`.
     The first lie per fact is stored in `memory.lies`; asking again: with `0.3 + 0.3·stress` choose a new
     different lie (**changed story**), else repeat. Truthful subjects repeat the truth; dementia → 50 %
     random value with `confused: true`. Refuse with `p = 0.15 + (hostile 0.3) − rapport·0.2` → `ask.refuse`.
     Line keys: `ask.truth`, `ask.lie`, `ask.refuse`, `ask.confused`, and for drinking `drinking.no|some|yes`.
   - `consent`: invalid for dementia (`consent.confused`, valid false) or juvenile without guardian present
     (`consent.needGuardian`); grant with `0.6 + 0.3·rapport − 0.2·stress + (polite 0.1) − (has relevant
     contraband 0.4)`; `pbt`/`sfst` add +0.1 for drinkers below 0.08 BAC. A denial can be asked again only after
     rapport rose by 0.3 since `consentAskedAt`. Keys `consent.grant`, `consent.deny`.
   - `miranda` → `miranda.ack` (mirandized true; Phase 5 placeholder); `release`/`warn`/`thank` →
     `release.ok`, `warn.ok`, `thank.ok`; `command` → not handled here (`commandLine`).
4. Escalation: after the tone effect, stress > 0.85 and demeanor `hostile`/`evasive` → `escalate = rng.chance(0.5)
   ? 'flee' : 'fight'` (fight only hostile); demeanor `crisis` with stress < 0.25 and rapport > 0.3 → `calmed: true`.
5. Text = `rng.pick(lines[lineKey])` with placeholders (`{first} {last} {dob} {value} {language} {officer}`);
   intoxication level > 0.6 → `slur(text)` (replace the first two `s` in words longer than 3 letters by `sh`).
### 9.4 Tests (`test/dialogue/**`)
**State machine transitions**: memory evolution under tone sequences (rapport/stress bounds, aggressive
escalation to flee/fight for hostile subjects, calmed for crisis), identity claim sticks once given,
refusal counter, consent denied → re-ask gated by rapport, comm-mode availability per subject (deaf →
written/gesture; foreign → translationApp; interpreter only when available), understanding gates and delays,
juvenile/dementia consent invalid. **Lying**: honest subjects never lie (honesty 1, not guilty) across 500
seeded asks; guilty low-honesty subjects lie at roughly `L` (±4σ); changed-story probability; lies are
consistent within an incident when not changed; identity lies produce `relative`/`invented`/`alteredDob`
claims with the right fields and fake IDs only when carried. `LINE_KEYS` ⊆ `responses.json` keys; every
utterance has four tones; every `NPC_COMMANDS` id has a command utterance.

### 9.5 Inconsistency engine (`src/dialogue/inconsistency.ts`)
```ts
export interface KnownFact extends PersonFact {}      // people.PersonFact
export interface Inconsistency { readonly key: string /* ruleId:factA:factB */; readonly ruleId: string; readonly topic: string; readonly factA: number; readonly factB: number;
  readonly text: string; readonly severity: 'caution' | 'alert' }
export const RULES: readonly InconsistencyRule[];
export function findInconsistencies(facts: readonly PersonFact[], rules?: readonly InconsistencyRule[]): Inconsistency[];   // facts of ONE person and ONE incident
export function compareFacts(rule: InconsistencyRule, a: PersonFact, b: PersonFact): boolean;
```
Canonical values (written by contact, §10.4): name `"FIRST LAST"` upper; dob epoch-day string; identity
person id string (`"-1"` invented); idCard document value = DL number, record value `"onFile:FIRST LAST"` or
`"notOnFile"`; appearance `"M|34|182|brown"` (sex | age | height cm | hair); address upper-cased text;
drinking/drugs/weapons claims `no|some|yes`, evidence `yes|heavy` (heavy = PBT ≥ 0.08 or ≥ threshold
clues on two SFST tests); vehicleContents claim `nothing|item:<id>`, evidence `item:<id>`; vehicleOwner claim
`owner:<personId>` (resolved from `'self'` and the claimed identity) or `other`, record `owner:<id>`;
destination/origin/account free values.
Comparators: `equal` (normalised `trim().toUpperCase()` values differ; for claim-vs-claim compare each claim
with the *previous* claim of the same topic, one inconsistency per change; claims with value `other` are
never compared); `denial` (a ∈ {no, nothing} and b present, or a = some and b = heavy); `appearance` (sex
differs, |age| > 10, |height| > 12 cm, or hair differs unless either is gray/bald and age ≥ 45); `idCard`
(b = notOnFile, or b = onFile:NAME and NAME ≠ the document's name fact); `notOnFile` (b = `NOTONFILE`). Rules only pair facts present in
the input: **undiscovered truth is never an input**, so nothing undiscovered can appear. Output sorted by
the later fact's id; `key` stable. Tests: each rule fires on a minimal fixture and stays silent on
consistent facts; facts from another incident or person are ignored; adding the hidden truth is impossible
through the API (only `PersonFact[]`); story change across three claims gives two inconsistencies.

### 9.6 Field tools (`src/dialogue/tools.ts`)
```ts
export function pbtReading(bac: number, rng: Rng): number;                       // max(0, bac + N(0, noiseSd)), rounded to 0.001
export function odorOf(items: readonly CarriedItem[], intox: Intoxication): ('alcohol' | 'cannabis')[];   // alcohol when bac >= odor.alcoholBac
export function frisk(items: readonly CarriedItem[], rng: Rng): CarriedItem[];   // weapons (find weaponFindBase - concealment*concealmentFactor) and large items (backpack/stolenGoods: largeItemFind)
export function search(items: readonly CarriedItem[], rng: Rng): CarriedItem[];  // every item, find = findBase - concealment*concealmentFactor
export function visualCheck(vehicleItems: readonly CarriedItem[]): CarriedItem[];   // visible, or concealment < revealBelowConcealment and where cabin
export interface SfstPrompt { readonly key: string; readonly label: string; readonly remainingS: number }
export interface SfstResult { readonly clues: Readonly<Record<'hgn' | 'walkTurn' | 'oneLeg', number>>; readonly administered: Readonly<Record<'hgn' | 'walkTurn' | 'oneLeg', boolean>>;
  readonly indicates: boolean; readonly summary: readonly string[] }
export class SfstSession {
  constructor(bac: number, drug: DrugKind, health: readonly HealthCondition[], rng: Rng);
  readonly test: 'hgn' | 'walkTurn' | 'oneLeg' | 'done'; readonly prompt: SfstPrompt | null; readonly progress: number /* 0..1 */;
  readonly instruction: string; readonly title: string;
  step(dt: number): void;          // timers: gap → prompt (key drawn from the test's keys) → window; a missed window counts as a miss
  press(key: string): void;        // correct key during a window = hit; wrong key = miss
  result(): SfstResult | null;     // when done
  serialize(): SfstSave; static restore(s: SfstSave): SfstSession;
}
```
Clues per test: `expected = maxClues · clamp((bac − bacStart)/bacSpan, 0, 1) + drugClues[drug][test] +
(diabetic && u < diabeticChance ? diabeticClues[test] : 0)` then `round(expected + N(0, clueSd))` clamped to
[0, maxClues] (drawn when the test starts). `administered[test]` = hits / prompts ≥ `minHitShare`.
`indicates` = any administered test with clues ≥ threshold. Summary lines: `"HGN: 4/6 clues"` or `"HGN: not
administered correctly"`. Tests: clue expectation monotone in BAC (mean over 500 sessions), sober subjects
mostly 0-1 clues, missed prompts → not administered, determinism, save/restore mid-test.

## 10. Contact [contact] (`src/contact/**`)

### 10.1 Role
`ContactManager` owns conversations (`Contact`), one *active* (shown in the panel) at a time, up to 8
open (one per person). A contact binds a person to an incident and keeps `SubjectMemory`, a transcript (≤ 40
lines), pending delayed responses, the SFST session, and the escort state. Statements and facts go to
`Population` (persisted); inconsistencies are recomputed by `findInconsistencies(people.facts(id, incident))`
when the facts revision changes.

### 10.2 API
```ts
export type ContactTarget = { readonly kind: 'actor'; readonly actorId: number } | { readonly kind: 'ped'; readonly slot: number }
  | { readonly kind: 'occupant'; readonly vehicleId: number; readonly seat: number };
export interface IncidentInfo { readonly key: string; readonly callId: number; readonly role: string; readonly truth: IncidentTruth; readonly guilty: boolean;
  readonly vehicleId: number /* the vehicle this person is associated with, -1 */; readonly stop: boolean /* traffic-stop driver/passenger */ }
export interface IncidentResolver { resolveIncident(personId: number, target: ContactTarget): IncidentInfo | null }   // implemented by SceneDirector
export interface Presence { readonly lights: boolean; readonly siren: boolean; readonly backup: number; readonly weapon: 'none' | 'sidearm' | 'taser' }
export type ContactActionId = 'frisk' | 'searchPerson' | 'searchVehicle' | 'visualCheck' | 'pbt' | 'sfst' | 'checkId' | 'runName' | 'runId' | 'runPlate'
  | 'checkVin' | 'cuff' | 'uncuff' | 'escort' | 'stopEscort' | 'release' | 'warnRelease' | 'writeCitation' | 'notifyGuardian' | 'useTranslationApp'
  | 'requestInterpreter' | 'seize';
export type ContactRequest =
  | { readonly kind: 'open'; readonly target: ContactTarget }
  | { readonly kind: 'say'; readonly contactId: number; readonly utteranceId: string; readonly tone: Tone }
  | { readonly kind: 'action'; readonly contactId: number; readonly action: ContactActionId }
  | { readonly kind: 'commMode'; readonly contactId: number; readonly mode: CommMode }
  | { readonly kind: 'activate'; readonly contactId: number } | { readonly kind: 'close'; readonly contactId: number }
  | { readonly kind: 'sfstKey'; readonly key: string } | { readonly kind: 'cage'; readonly vehicleIndex: number };
export interface ContactDeps { readonly seed: number; readonly bus: EventBus<EventMap>; readonly cad: CadState; readonly records: RecordsDb; readonly people: Population;
  readonly npc: NpcSystem; readonly rng: Rng /* session.rng.stream('contact') */; readonly playerCallsign: string;
  request(r: UnitRequest): void;                 // dispatcher.request(playerCallsign, r, 'auto')
  officer(): { name: string; badge: string }; presence(): Presence; officerPosition(out: { x: number; z: number; yaw: number }): void;
  trustAt(x: number, z: number): number; districtOf(x: number, z: number): string; stopVehicleId(): number /* active stop, -1 */;
  interpreterAvailable(callId: number): boolean }
export class ContactManager {
  constructor(deps: ContactDeps);
  setResolver(r: IncidentResolver): void;
  step(dt: number, t: CadTime): void;                       // fixed step -680: queued requests, delayed responses, SFST timers, escort checks
  request(r: ContactRequest): void;                         // queued (UI)
  open(target: ContactTarget, incident: IncidentInfo | null, t: CadTime): number;   // in-step (scene); returns contact id
  readonly active: number;                                  // active contact id, -1
  readonly revision: number;                                // bumps on any visible change
  contactOfPerson(personId: number): number;
  personOf(contactId: number): number;
  attachCall(incident: string, callId: number): void;       // field contact got a CAD call (scene, in-step)
  escorting(): number;                                      // actor id being escorted (cuffed + following), 0
  view(contactId: number): DialogueView | null;             // presenter (allocates; call on revision change only)
  sfstView(): SfstView | null;
  inconsistencies(incident: string, personId: number): readonly Inconsistency[];
  serialize(): ContactSave; restore(save: ContactSave): void; dispose(): void;
}
export interface ContactSave { version: 1; nextId: number; active: number; contacts: ContactSaveEntry[] }
export interface ContactSaveEntry { id: number; personId: number; incident: string; callId: number; role: string; target: ContactTarget; actorId: number;
  commMode: CommMode; memory: SubjectMemory; transcript: { id: number; speaker: 'officer' | 'subject' | 'system'; text: string }[]; nextLine: number;
  pending: { dueSim: number; result: DialogueResult /* plain JSON */ }[]; sfst: SfstSave | null; guardianNotifiedAt: number; truth: IncidentTruth; guilty: boolean;
  vehicleId: number; stop: boolean; appTranslation: boolean }
export function isContactSave(x: unknown): x is ContactSave;
```
`DialogueView` / `SfstView` are the presentation types of §12.3 (contact imports them as types from `src/ui/dialogue/types.ts`).

### 10.3 Behaviour
- **Open**: `ped` → `npc.promotePedestrian`; `occupant` → no actor until `stepOut`; `actor` as is. The
  person's record is touched (`records.person(id)`), the incident comes from the resolver (scene) or is a
  field contact `FC-<personId>-<day>` with truth values drawn once from `values` (rng) and `guilty =
  wanted || carries contraband || intoxication.bac >= 0.08 in a vehicle`. An `observation` fact for
  `appearance` is added at once (true sex, age rounded to the nearest 5, height rounded to 5 cm, hair),
  and evidence facts for odor when within `odor.distanceM` (alcohol → drinking `yes`, detail "odor of
  alcohol"; cannabis → drugs `yes`). Emits `contact:event { flag: 'contacted' }`.
- **say**: `officerLine` → transcript (officer); commands: `npc.evaluateCommand` (actor; for occupants
  `stepOut` creates the actor first via `npc.stepOut` when complied) → `commandLine` → `npc.applyCommand`;
  others: `respond(...)`; delayed results go to `pending` (due at `t.sim + delayS`), then: subject line to the
  transcript, `contact:line { personId, speaker, text, language }` (subtitles; `language` = 'en' or the
  label when untranslated), statement → `people.addStatement` + claim fact(s) (`name`, `dob`, `identity`,
  `address` for identity claims; topic value for `ask`), identity claim → for a stop driver
  `request({ kind: 'stopContact', action: 'license', personId: claim.personId })` (invented: no request; the
  CAD stop keeps `driverId -1` and a narrative "Driver identified verbally as NAME, DOB, no record on file" is
  added via `cad.addNarrative`); document handed → `document` facts (`name`, `dob`, `idCard` with dlNumber).
  `escalate` → `npc.forceState(flee|fight)`; `calmed` → event flag `calmed`. Memory stress → `npc.setStress`.
  The first `requestId`/`command`/`consent` utterance in a field contact without a call opens a
  self-initiated `pedestrianStop` call through the scene (event `contact:needsCall { personId, x, z,
  incident }`); the incident key stays `FC-...` and the scene reports the new call id back by calling
  `contact.attachCall(incident, callId)` (a ContactManager method; the scene's `ContactPort` includes it).
- **Actions** (each appends a `system` transcript line and emits `contact:event` flags; failures explain why):
  `frisk` (actor standing/handsUp/cuffed, no consent needed: `tools.frisk`; found weapons → evidence facts
  `weapons yes` + `contact:event weaponFound`, items removed to the officer: `people.seize`),
  `searchPerson` (consent granted or cuffed: `tools.search`, facts drugs/weapons per item, flags
  `itemFound:<item>`, `contrabandFound`), `searchVehicle` (consent `searchVehicle` or driver in custody:
  `tools.search` on vehicle items → `vehicleContents item:<id>` facts), `visualCheck` (within 3 m of the
  vehicle: `tools.visualCheck` → facts; open container → drinking `yes`), `pbt` (consent `pbt`:
  `pbtReading` → fact drinking `yes`/`heavy`/none, flag `pbt` and `bacOver` when ≥ 0.08, transcript
  "PBT: 0.112"), `sfst` (consent `sfst`, subject out of the vehicle: starts `SfstSession`; done → facts and
  flags `sfst`, `sfstFail`), `checkId` (a handed document must exist: shows it; already a fact),
  `runName` (needs a claimed name: `records.findPersons({ last, first })`; the match is the result whose DOB
  equals the claimed DOB, else the first result; facts from the match: `record` `name` = its name, `dob` =
  its DOB, `address`, `appearance` (`"sex|age|height|hair"`); no result → `record` `name` = `NOTONFILE` and
  the system line "No record for FIRST LAST"),
  `runId` (dlNumber → `personIdFromDl` → `idCard` record fact `onFile:NAME` or `notOnFile` + appearance of the
  record), `runPlate`/`checkVin` (stop: `request({ kind: 'runPlate'... })` / `stopContact vin`; the
  registration owner → `vehicleOwner` record fact `owner:<ownerId>`), `cuff` (`npc.cuff`: ok → people custody
  `arrested`, flag `custody`, `force:used { kind: 'cuff' }` only when it took a struggle; a stop driver →
  `request(stopContact arrest)`; resist → fight starts, flag `forceUsed` after the struggle), `uncuff`,
  `escort`/`stopEscort` (`npc.follow`), `release` (field: `npc.applyCommand(release)`; stop: occupants out
  are sent `returnToVehicle`, then `stopContact release` once all are seated; people `recordContact`),
  `warnRelease` (stop: `stopContact warn` then release; flag `warned`), `writeCitation` (emits
  `contact:openForm { kind: 'citation', personId: claimed identity id (or true id when none), vehicleId,
  callId }`; the integrator opens the MDT; a final citation linked to the call raises `cited` in the scene),
  `notifyGuardian` (juvenile: 30 s later `guardianNotified` and the guardian counts as present for consent),
  `useTranslationApp` / `requestInterpreter` (comm modes; interpreter via scene service), `seize` (all found
  items become CAD evidence documents via `cad.docs.create('evidence', ...)` finalized, linked to the call).
- **Cage** (`cage` request from the integrator when the escorted cuffed actor and the officer are at a
  patrol car rear door): `npc.removeActor`, people custody `arrested`, emits `contact:caged { personId,
  vehicleIndex, callId }` (the session seats the person: `equipment.seatPrisoner`) and flag `caged`.
- **Booking** (integrator forwards `cad:documentSaved` final booking): adds a `booking` fact `identity` =
  the true person id to the incident of that person → `identityVsBooking` fires when the claim differed.
- Events (`src/contact/events.ts`): `contact:event { incident, callId, personId, role, flag }`
  (flags: `contacted statement identified falseIdentity custody caged released warned searched frisked pbt
  sfst bacOver sfstFail weaponFound contrabandFound itemFound:<item> calmed forceUsed guardianNotified`),
  `contact:line { personId, speaker: 'officer' | 'subject' | 'system', text, language }`, `contact:caged`,
  `contact:openForm { kind: 'citation' | 'report', personId, vehicleId, callId }`, `contact:needsCall
  { personId, x, z, incident }`.
  `statement` is emitted for `ask account` answers and identity statements; `identified` when a
  document was handed or a name lookup matched; `falseIdentity` when an identity-topic inconsistency appears.
### 10.4 Presenter (`view()`)
Title: claimed name when known, else `"Unknown {male|female}, ~{age}"` (+ role, e.g. "Driver"); subtitle:
demeanor cue (`"Nervous"`, `"Hostile"`), `"Odor of alcohol"` when that fact exists, `"Cuffed"`, `"Deaf -
use written notes"`, `"Speaks {language}"`, `"Juvenile"`; topics from `available()` grouped by topic;
actions enabled by state (e.g. `sfst` only out of the vehicle); `transcript` newest last; `statements` = this
incident's statements as `"{time} {fact}: {display}"`; `facts` = known facts; `inconsistencies` =
`findInconsistencies` texts with severity. No hidden truth ever appears in a view (test: views built for a
lying subject contain no `truthful` value and no undiscovered item label).
### 10.5 Tests (`test/contact/**`)
With a real `Population`, `RecordsDb`, `CadState`, a stub `NpcSystem` (or the real one with a small city
fixture from `test/world/helpers.ts`), and an rng: open on an occupant; requestId with a liar → claim,
statements, `stopContact license personId` request recorded; `runName` facts → `dobVsRecord` /
`appearanceVsRecord` inconsistencies appear only after the lookup; changed story; drinking denial vs PBT;
deaf comm-mode gate; translation delay; juvenile consent needs guardian; cuff → custody flag; cage event;
save/restore mid-conversation with a pending delayed answer continues identically; views never contain
undiscovered items.

## 11. Scene director [scene] (`src/scene/**`, `src/dispatch/**`, `src/data/dispatch/**`)

### 11.1 Lifecycle
1. `cad:callCreated` (queued) → if `familyForType(typeId)` is non-null and not `derived`: build the scenario
   (`buildScenario` with `createRng(seed).stream('scenario:' + callId)`), store `ScenarioRuntime { scenario,
   flags: Set, createdSim, materialized: false, actorIds: number[] (per participant, 0 = not spawned),
   vehicleEids by vehicleId, timelineIdx, actionStates, arrivedSim, outcome: null }`.
2. Every step: timeline entries due (`createdSim + atS <= t.sim`) are applied whether or not the scene is
   materialized: `describe`/`narrative`/`correction`/`unitReport` → `cad.addNarrative(callId, 'CAD' |
   caller name | unit callsign, text)`; `priority` / `escalate` / `deescalate` → `cad.setPriority`,
   flags `escalated`/`deescalated`, role overrides (profiles via `npc.setProfile` when spawned);
   `duplicateCaller` → narrative with the caller's name (records); `linkedCall` → `cad.createCall` (same type,
   location, a new citizen caller, narrative "Duplicate report"; the scene remembers its id and never builds a
   scenario for it), `cad.linkCalls`, then close it at once with `duplicate`; `ambush` → arms the trigger.
   When an AI unit goes `onScene` on a scenario call (`cad:unitStatus`), the scene adds `"Unit {callsign} on
   scene."` plus `" Advises no evidence of an incident."` for `false`/`swatting` or `" Advises the suspect is
   gone."` when a role has `escaped:`/`branch` flags `suspectFled`/`suspectGone` (calls never generates
   `unitReport` entries; the kind stays reserved).
3. **Materialize** when the player unit is assigned to the call (CAD `units` includes the player) and the
   officer is within 220 m of the true anchor (or immediately for derived/self-initiated scenes): spawn
   participants (actors at spots, §11.2; `inside`/`hidden` spawned hidden; seated persons via
   `npc.setOccupants`), scene vehicles (`traffic.spawnSubjectCar(vehicleId, ...)`: `driving` vehicles spawn
   on the nearest lane within 150 m of the anchor *driving away*; parked/crashed at the anchor curb) with
   `setBehavior(dui)` for DUI subjects and `people.ensureIntoxicated(driver, bac)`; scenario intoxication /
   injury / deceased / added items into `people` deltas; ground evidence props. Emits `scene:materialized`.
4. **Arrival**: officer within 50 m of the anchor (on foot, or driving < 2 m/s) → flag `arrived`, and when
   the player's CAD status is `enRoute` → `dispatcher.request(pc, { kind: 'status', status: 'onScene' }, 'auto')`.
5. **Flags** (§11.3) from contact/npc/traffic/CAD events and actions; `objectivesFor` for the HUD.
6. **Close**: the call closes (player clears it via the scene panel or the MDT, or an AI unit) →
   `outcomeFor(family, flags)` → `CallOutcome` (§11.7) appended to `closed` (≤ 200), `scene:outcome` emitted;
   dematerialize: actors not in custody → `leave` (removed after 40 m), cuffed actors stay until caged or
   released, scene cars unpinned (towed ones removed), props removed after the player is 150 m away.
   AI-closed calls never materialized are dropped silently (outcome `resolvedBy: 'ai'`).
7. **Derived scenes**: `cad:trafficStop { active: true }` → if the vehicle is a subject vehicle of an open
   scenario, link the stop call to it (`cad.linkCalls`) and set `vehicleStopped`; else build a `trafficStop`
   scenario with `given = npc.occupantsOf(vehicleId)` and `derivedBranch` by truth priority: stolen
   vehicle (`vehicleRecord.stolen` or a plate anomaly) → `stolenVehicle`; driver wanted → `wanted`; driver
   BAC ≥ 0.08 or the car's DUI behaviour bit (then `people.ensureIntoxicated(driver, 0.09 + u·0.1)`) → `dui`;
   contraband in the vehicle or on the driver → `contraband`; licence suspended/revoked/none → `suspended`;
   else `clean`. Field contacts (`contact:needsCall`) → `dispatcher.openSelfInitiated('pedestrianStop', ...)`
   + a `contact` scenario with the person as `given` and `derivedBranch` = `wanted` (wanted) / `contraband`
   (carries a contraband item) / `clean`, then `contact.attachCall(incident, callId)`.

### 11.2 Spots (`src/scene/spots.ts`, pure)
For anchor (edge e, s, side): sidewalk lateral `L = e.width/2 + (e.sidewalk > 0 ? e.sidewalk/2 : 1.5)`,
door lateral `D = e.width/2 + (e.sidewalk > 0 ? e.sidewalk - 0.3 : 3)`, curb `C = e.width/2 + 0.4`, street
`S = e.width/2 - 1.2`. Spot positions (along offset a, lateral l, both relative to the anchor; the nth
person on a spot adds `a += 1.2·n`): door (0, D), curb (2, C), yard (6, D), street (0, S), roadside (−4,
C+1), vehicle (seated), inside (0, D, hidden until `knock`), hidden (±(20..40) by rng, D, hidden), crowd
(rng within 12 m along, lateral between C and D, both sides for `street` anchors), distance (25, L). Yaw
faces the street. `spotPosition(graph, anchor, spot, n, rng, out)`. Intersection anchors use the edge
nearest the node. Tests: positions are on the sidewalk band (not inside the road for door/curb/yard), stay
within the edge length, deterministic.

### 11.3 Flag vocabulary (used by calls conditions)
- Set at build: `branch:<id>`, `variant:<kind>`, `role:<role>`, `juvenile:<role>`, branch flags
  (`injury:<role>`, `deceased:<role>`, `hitAndRun`, `medicalEmergency`, `fraudSuspected`, `suspectFled`,
  `misidentified`, `roadHazard`, `hazmat`, `package`, `abandoned`, `fight`, `k9Needed`, `sceneEvidence`).
- Scene: `arrived`, `escalated`, `deescalated`, `vehicleStopped`, `pursuit`, `pursuitLost`, `pursuitEnded`,
  `shotsFired`, `attacked`, `forceUsed`, `report` (a final incident report with this call id), `cited` /
  `citation:<role>` (a final citation for the call / that role's person), `left:<role>`, `found:<role>`
  (officer within 3 m of that role's actor and it is revealed), `near:<role>` (officer within 3 m now;
  recomputed), action `sets`, `crowdDispersed` (families with `disperseCrowd`), `service:<kind>`,
  `arrived:<kind>`, service `sets`.
- From contact (`contact:event` → `<flag>:<role>` for person flags, global for item flags): `contacted:`,
  `statement:`, `identified:`, `falseIdentity:`, `custody:`, `caged:`, `warned:`, `released:`, `searched:`,
  `frisked:`, `pbt:`, `sfst:`, `calmed:`, `guardianNotified` (also global); global `bacOver`, `sfstFail`,
  `weaponFound`, `contrabandFound`, `itemFound:<item>`.
- From npc: `fled:<role>`, `escaped:<role>`, `caught:<role>` (also `custody` needs cuffs), `detained:<role>`
  (handsUp/kneel/prone after a command), `weaponDrawn:<role>`, `transported:<role>` (EMS).
`producibleFlags` (calls) must return exactly these for a family: role-scoped flags for every present role
(person roles only; `transported:` only when `requestEms` is in the family actions; `revealed`/`found`
only for hidden/inside spots or `missing` roles), item flags for items present in roles/evidence,
`bacOver`/`sfstFail`/`pbt:`/`sfst:` when any role has intoxication or the family is `trafficStop`/`dui`,
pursuit flags when a vehicle has `flee > 0` or the family is `pursuit`, `escalated`/`deescalated` when the
variant multiplier > 0, action and service flags of the family's actions, `report`, `cited`, `forceUsed`,
`attacked`/`shotsFired` when a role has a weapon or `ambush` > 0.

### 11.4 Scene actions and services
`request({ kind: 'action', callId, actionId })` (queued): checks `requires` (with flags), `once`, kit
`consumes` (`kit.use(item, n)` callback), the officer within 60 m of the anchor; then: `service` → schedule
arrival at `t.sim + uniform(arriveS)` with `scene:radio` line (`radio` text) and ack 3 s later; `reveals` →
`npc.reveal` for inside/hidden participants (inside: they come to the door spot; hidden: each with 0.6 when
`searchArea`, all with K9); `props` → props laid out by pattern around the anchor (line along the edge at
the street, ring of radius around the anchor); `command` → `npc.evaluateCommand`/`applyCommand` for every
actor of the listed roles (`disperse` compliance → `leave`; when ≥ 70 % of them leave → `crowdDispersed`);
`durationS` → pending timer (cancelled when the officer is > 60 m away); `narrative` → `cad.addNarrative`;
`opens` → `scene:openForm` (integrator opens the MDT form; `citeVehicle` prefills the parked vehicle's
plate and registered owner). Service arrival → `arrived:<kind>` + `sets`, `scene:radio` `arrivedText`, effect:
`transportInjured` (every injured / unconscious / overdose participant actor removed, people custody
`hospital`, flag `transported:<role>`; an EMS ambulance is not rendered), `resolveBarricade` (after a further
60-120 s: the barricaded subject surrenders → actor spawned cuffed at the door, flags `custody:<role>`;
hostage freed), `revealHidden` (all hidden participants revealed; a fled-and-escaped suspect is found with
0.5 → spawned prone near the anchor), `removeDeceased` (deceased actors removed), `interpreter` (contact
comm mode `interpreter` available for this call), `secureAnimal` (animal actors removed, `animalSecured`),
`towVehicles` (scene vehicles removed via `traffic.removeVehicle`).

### 11.5 Officer tactics (weapon, TASER, tackle, shout) and pursuits
- `officerWeapon: 'none' | 'sidearm' | 'taser'` (saved). `request({ kind: 'weapon' })` cycles none → sidearm →
  taser → none (on foot only), emitting `force:used { kind: 'sidearmDrawn' | 'taserDrawn' }` (Phase 5 hook)
  when drawn near a scene actor (within 25 m).
- `request({ kind: 'fire', dirX, dirZ })`: taser → nearest non-hidden actor within `taserRangeM` and 8° of
  the aim → `npc.taser(id, d)`; flag `forceUsed`, `force:used { kind: 'taser', personId, callId }`.
  Sidearm → `scene:flash { text: 'Firearm discharge is not modelled until Phase 5' }` and `force:used { kind:
  'sidearmFire' }` (no effect).
- `request({ kind: 'tackle' })` → `npc.tackle(officer)`; success flags `caught:<role>`, `forceUsed`, event.
- `request({ kind: 'shout' })` → context command to the nearest actor within 25 m in front: fleeing →
  `stop`; armed → `dropWeapon`; weapon drawn → `handsUp`; else `stop`; tone `shout`; `scene:line` officer text
  ("Police! Stop!" etc.) and the actor's `commandLine` answer.
- Ambush trigger: once armed, when the officer is within `triggerDistanceM` of the anchor: reveal the
  ambusher, `npc.forceState(armed)`, `scene:radio` priority line "Shots fired! Shots fired!" when it fires,
  flags `attacked`/`shotsFired`, and a CAD narrative "Officer reports being fired upon". The scene never
  presses the emergency button for the player (the player decides via the radio).
- **Vehicle pursuit**: on `traffic:pullingOver` (queued) for vehicle v: flee chance = scenario vehicle
  `flee` when v is a subject vehicle, else for ambient cars `0.03 + 0.25·wanted + 0.2·stolen + 0.1·(BAC ≥
  0.08) + 0.1·contraband` of the true driver; roll with the scene stream → `traffic.flee(v)`, a self-initiated
  `vehiclePursuit` call (`dispatcher.openSelfInitiated`, linked to the subject scenario's call when any), its
  scenario (`pursuit` family, driver given, `existingVehicleId` v); every pursuit flag and the driver's
  `fled`/`caught`/`escaped`/`custody` flags are also set on the subject vehicle's own scenario (DUI,
  vehicleWanted, trafficStop) when there is one; radio line "{unit}, in pursuit of {desc}, plate {plate},
  {dir} on {street}", `dispatcher.request(backup code 3)`, flags `pursuit`, `scene:pursuit { active: true }`.
  HUD line every step: `"PURSUIT {plate} · {desc} · {distance} m"`. `traffic:fleeEnded`: crashed → occupants
  spawned at the car (driver: flee on foot with 0.5, else `handsUp`), `vehicleStopped`; gaveUp →
  `traffic.forceStop(v)` (the dispatcher creates the trafficStop call; it is linked), `vehicleStopped`;
  escaped → flags `pursuitLost`, `escaped:driver`, radio "lost sight", pursuit call stays open for the player
  to clear (default outcome GOA).
- **Foot pursuit**: `npc:fled` for a scenario actor or a contact subject → flags `fled:<role>`, radio "{unit},
  foot pursuit, {desc}, {dir} on {street}" (only the first time), `scene:pursuit { kind: 'foot' }`, HUD line
  "FOOT PURSUIT · {distance} m"; when the player is not on a call, a `footPursuit` call is opened.
  `npc:caught` → `caught:<role>`; `npc:escaped` → `escaped:<role>`.

### 11.6 Presence, HUD, panel model
- `presence` each step: `lights` = any patrol car with its light bar on within 60 m of the officer;
  `siren` likewise; `backup` = AI units with status `onScene` on the player's current call within 80 m
  (positions from CAD AVL); `weapon` = `officerWeapon`.
- `hud(): { scene: { title: string; objectives: readonly { text: string; done: boolean }[] } | null; pursuit: string | null }`
  (the player's materialized call within 300 m; title `"C-00042 P2 Domestic disturbance"`).
- `panelModel(callId): ActionPanelModel | null` (the Phase 2 `ActionPanel` model): title = call title,
  subtitle = first open objective, options = the family actions (`enabled` per requires/once/consumes/range;
  detail = "In progress 12 s" / "Requested" / "On scene") + `"Clear call — {disposition label} (suggested)"`
  (suggested = `outcomeFor(flags).disposition`) + `"Clear call — choose disposition in MDT"`. `panelSelect(callId,
  index)` → queues the action / clear request. Clear → `dispatcher.request(pc, { kind: 'clearCall', callId,
  disposition }, 'key')`.
- `sceneAt(x, z): number` — the player's materialized call whose anchor is within 80 m, else −1.

### 11.7 CallOutcome (Phase 5 grading input)
```ts
export interface CallOutcome { callId: number; number: string; typeId: string; family: string; variants: VariantKind[]; branch: string; outcomeId: string;
  suggested: string; disposition: string /* what CAD recorded */; grade: Grade; flags: string[]; materialized: boolean; resolvedBy: 'player' | 'ai';
  createdSim: number; arrivedSim: number /* -1 */; closedSim: number; forceUsed: string[] /* force:used kinds */ }
```
### 11.8 Dispatch changes (scene owns `src/dispatch/**`)
1. `CallGenerator.pickType(rng, x, z, gameSeconds)`: weight = `t.weight × districtFactor × crimeWeight(t.category,
   hour, weekday, district)` (plain `weight × districtFactor` when all are 0); `generate(...)` passes the game
   time (`t.game`). (Call frequency already follows the crime table through `multiplier`.)
2. `narrative` picks `{plate}`/`{vehicle}` vehicles with `canBeOnRoad(seed, id)` (≤ 20 tries, then any).
3. `stopContact` `license` uses `r.personId` when given (≥ 0: `driverId = personId`, narrative with that
   person's record; when the claimed person ≠ the true driver this is the officer's mistake, kept), else the
   true driver as before.
4. `Dispatcher.openSelfInitiated(typeId: string, priority: Priority, at: { x: number; z: number }, narrative: string,
   t: CadTime, persons?: number[], vehicles?: number[]): CadCall` — creates the call self-initiated, assigns the
   player (`by: 'self'`), status `onScene`, plan 0 AI units.
5. Tests: update `test/dispatch/**` for the new type table (the generated sequence changes: assert
   properties, not exact sequences) and add: Phase 3 types are generated; DUI-category share at 02:00 >
   at 10:00 over 2 000 generated calls (seeded); `stopContact license personId`; `openSelfInitiated`.
### 11.9 SceneSave and API
```ts
export interface SceneDeps { readonly seed: number; readonly city: City; readonly bus: EventBus<EventMap>; readonly cad: CadState; readonly records: RecordsDb;
  readonly people: Population; readonly npc: NpcSystem; readonly traffic: TrafficSystem; readonly dispatcher: Dispatcher; readonly contact: ContactPort;
  readonly rng: Rng /* session.rng.stream('scene') */; kit(): { carried(item: string): number; use(item: string, n: number): boolean };
  patrolCars(): readonly { eid: number; lightbar: boolean; siren: boolean }[] }
export interface ContactPort { open(target: ContactTarget, incident: IncidentInfo | null, t: CadTime): number; attachCall(incident: string, callId: number): void }   // structurally ContactManager
export interface OfficerFocus { x: number; z: number; yaw: number; speed: number; onFoot: boolean }
export type SceneRequest = { readonly kind: 'weapon' } | { readonly kind: 'fire'; readonly dirX: number; readonly dirZ: number } | { readonly kind: 'tackle' }
  | { readonly kind: 'shout' } | { readonly kind: 'action'; readonly callId: number; readonly actionId: string }
  | { readonly kind: 'clear'; readonly callId: number; readonly disposition: string | null };
export class SceneDirector implements IncidentResolver {
  constructor(deps: SceneDeps);
  step(dt: number, t: CadTime, officer: OfficerFocus): void;   // fixed step -690
  request(r: SceneRequest): void;
  readonly officerWeapon: 'none' | 'sidearm' | 'taser'; readonly presence: Presence; readonly props: PropSource; readonly revision: number;
  readonly stats: { scenarios: number; materialized: number; stepMs: number };
  resolveIncident(personId: number, target: ContactTarget): IncidentInfo | null;
  sceneAt(x: number, z: number): number; hud(): SceneHud; panelModel(callId: number): ActionPanelModel | null; panelSelect(callId: number, index: number): void;
  runtime(callId: number): ScenarioRuntime | null; outcomes(): readonly CallOutcome[];
  spawnCall(typeId: string, t: CadTime, at: { x: number; z: number }, variants?: VariantKind[]): number;   // debug: dispatcher.createCall + forced variants
  serialize(): SceneSave; restore(save: SceneSave, t: CadTime): void;   // after cad, people, npc, traffic restore
  adoptOpenCalls(t: CadTime): void;                            // builds scenarios for open calls without one (v4 saves)
  dispose(): void;
}
export interface SceneSave { version: 1; rng: RngState; officerWeapon: 'none' | 'sidearm' | 'taser';
  scenarios: { scenario: Scenario; flags: string[]; createdSim: number; materialized: boolean; actorIds: number[]; timelineIdx: number; arrivedSim: number;
    actions: { id: string; state: 'done' | 'running' | 'requested'; dueSim: number }[]; services: { kind: string; dueSim: number; arrived: boolean; effectDueSim: number }[];
    ambushArmed: boolean; forceUsed: string[] }[];
  closed: CallOutcome[]; props: { x: number; y: number; z: number; yaw: number; kind: number; callId: number }[];
  pursuits: { kind: 'vehicle' | 'foot'; callId: number; vehicleId: number; actorId: number; startedSim: number; announced: boolean }[];
  queue: SceneRequest[]; eventQueue: unknown[] /* module-defined plain data */ }
export function isSceneSave(x: unknown): x is SceneSave;
export function createSceneCommands(deps: { scene(): SceneDirector | null; now(): CadTime | null; playerPosition(): { x: number; z: number } | null }): Command[];
// scene spawn <typeId> [here] [variant...], scene info, scene outcomes, scene flags <callId>, weapon
```
Events (`src/scene/events.ts`): `scene:materialized { callId }`, `scene:radio { channel: 'dispatch'; speaker: string
| null; text: string; priority: boolean }`, `scene:line { personId: number; speaker: string; text: string;
language: string }`, `scene:flash { text }`, `scene:pursuit { kind: 'vehicle' | 'foot'; active: boolean; callId }`,
`scene:outcome { outcome: CallOutcome }`, `scene:openForm { kind: 'citation' | 'report'; callId; personId; vehicleId }`,
`force:used { kind: 'sidearmDrawn' | 'taserDrawn' | 'taser' | 'sidearmFire' | 'tackle' | 'struggle' | 'cuff'; personId: number; callId: number }`.
### 11.10 Tests (`test/scene/**`, `test/dispatch/**`)
With a real city (`test/world/helpers.ts` city fixture or `generateCity(seed)`), records, people, CAD, a
real traffic system, npc, a stub contact port and a bus: a generated domestic call builds a scenario and
applies the describe entry; materialization only when the player is assigned and near; actors at the
right spots and hidden ones not visible; `knock` reveals inside participants; escalation entry raises the
priority and swaps the profile; duplicate creates a linked closed call; wrong-address correction narrative;
service arrival effects (EMS transports, SWAT resolves, K9 reveals); outcome on close = the expected outcome
for a scripted flag set; derived traffic-stop branch from truth (DUI bit → dui branch, stolen → stolenVehicle);
pursuit start on pull-over with a forced flee roll (subject vehicle flee 1) and end handling; TASER/tackle
flags; save/restore of an active scene continues identically (two runs compare `serialize()`); cross-check
that `ITEMS`/`BEHAVIORS`/services contain every id of the §4.0 lists; determinism (same seed and requests →
identical `SceneSave`).

## 12. Presentation [presentation] (`src/render/people/**`, `src/ui/dialogue/**`, `src/ui/hud/**`, `src/input/actions.ts`, `src/input/bindings.ts`)

### 12.1 Pose constants and sources (`src/render/people/pose.ts` — pure, no THREE import)
```ts
export const POSE = { stand: 0, walk: 1, run: 2, handsUp: 3, kneel: 4, prone: 5, cuffed: 6, seated: 7, aim: 8, fight: 9, lying: 10, sit: 11 } as const;
export const HELD = { none: 0, knife: 1, handgun: 2, bottle: 3, phone: 4, taser: 5, sidearm: 6 } as const;
export const BODY = { human: 0, dog: 1 } as const;
export const FIGURE_FLAG = { highlight: 1, hidden: 2 } as const;
export const PROP = { cone: 1, flare: 2, tape: 3, marker: 4, bottle: 5, bag: 6, knife: 7, handgun: 8, package: 9, casing: 10, glass: 11, note: 12 } as const;
export const PROP_BY_NAME: Readonly<Record<string, number>>;   // 'cone' -> 1 ...
export interface HumanoidSource { readonly count: number; readonly x: Float32Array; readonly y: Float32Array; readonly z: Float32Array; readonly yaw: Float32Array;
  readonly prevX: Float32Array; readonly prevY: Float32Array; readonly prevZ: Float32Array; readonly prevYaw: Float32Array; readonly anchor: Int32Array;
  readonly pose: Uint8Array; readonly gait: Float32Array; readonly speed: Float32Array; readonly height: Float32Array; readonly build: Float32Array;
  readonly skin: Uint32Array; readonly hair: Uint32Array /* 0xFFFFFFFF = bald */; readonly top: Uint32Array; readonly bottom: Uint32Array;
  readonly held: Uint8Array; readonly body: Uint8Array; readonly flags: Uint8Array }
export interface PropSource { readonly count: number; readonly x: Float32Array; readonly y: Float32Array; readonly z: Float32Array; readonly yaw: Float32Array; readonly kind: Uint8Array }
export interface LimbPose { bodyPitch: number; drop: number; torsoPitch: number; headPitch: number; leftLeg: number; rightLeg: number;
  leftArm: number; rightArm: number; leftArmOut: number; rightArmOut: number; leftKnee: number; rightKnee: number }
export function createLimbPose(): LimbPose;
/** Limb angles (rad) for a pose at walk-cycle phase `gait` (cycles; fractional part used) and speed (m/s). Allocation-free. */
export function limbPose(pose: number, gait: number, speed: number, out: LimbPose): LimbPose;
export function createHumanoidSource(capacity: number): HumanoidSource & { count: number };   // mutable helper for npc / officer figure
export function createPropSource(capacity: number): PropSource & { count: number };
```
`y` is the feet height (0 on the ground). `yaw` uses the project convention (0 = facing −Z). `limbPose`:
walk: legs ±0.45·sin(2πg) opposite, arms ∓0.35; run: ±0.9 legs, ±0.8 arms, torsoPitch 0.15; handsUp: arms
pitch π (up), small out roll; kneel: drop 0.45, knees π/2, legs −π/2 (thighs forward); prone and lying:
bodyPitch π/2 (face down / up: lying uses −π/2), drop to 0.12; cuffed: arms back (−0.5) and inward; seated:
legs −π/2 (forward), knees π/2, drop 0.45; sit: like seated with drop 0.5; aim: right arm π/2 forward (both
for handgun), fight: arms 0.9 forward alternating with g. Tests: symmetry of walk, handsUp arms above the
head, prone body pitch, no allocation.

### 12.2 Renderers
`PeopleRenderer(scene, { capacity = 320, shadows = false })`: five `InstancedMesh`es for humans — head (box
0.22 × 0.24 × 0.22, skin), hair cap (box on the head top, hair colour; scale 0 when bald), torso (box 0.42 ×
0.58 × 0.24, top colour), arms (2 per figure, box 0.11 × 0.6 × 0.11, top colour, pivot at the shoulder),
legs (2 per figure, box 0.15 × 0.85 × 0.16, bottom colour, pivot at the hip) — all sized for 1.75 m and
scaled by `height/1.75` (width by `build`); one `InstancedMesh` for dogs (merged body/head/legs at 1/3
human height, `top` colour as fur, legs not animated beyond a bob) and one for held items (small boxes by
`HELD`). `MeshLambertMaterial` with `instanceColor`; `DynamicDrawUsage`; `frustumCulled = false`.
`update(alpha, sources, camX, camZ, maxDistance)`: for every figure in every source (skip `hidden` flag,
skip beyond `maxDistance` from the camera), interpolate position/yaw (world) or compose with the anchor
vehicle's interpolated transform (`interpolateTransform(anchor, alpha, ...)`), compute `limbPose` (beyond 50 m:
static stand/walk pose without swing), and write the instance matrices with scratch `Matrix4`/`Quaternion`
objects; `count` per mesh; `needsUpdate` flags. Highlight flag: torso colour lightened 25 %. ≤ 8 draw calls.
`PropRenderer(scene, capacity = 256)`: one `InstancedMesh` per `PROP` kind with simple geometry (cone:
`ConeGeometry`, flare: thin box with emissive red; tape: post 1 m + yellow bar 3 m along yaw; marker: small
yellow tent; others small boxes/cylinders), `update(source, nightFactor)`; flare emissive scales with night.
Tests (`test/peoplerender/**`, node, no WebGL needed — three objects only): instance counts follow the
sources, hidden figures skipped, anchored figures follow the vehicle transform, bald → hair scale 0, draw
calls ≤ 8, no allocation in `update` (heap delta pattern of `test/vehiclerender`).

### 12.3 DOM: dialogue, SFST, subtitles (`src/ui/dialogue/**`, CSS prefix `dlg-`)
`src/ui/dialogue/types.ts` declares `export type Tone = 'polite' | 'neutral' | 'commanding' | 'aggressive'` and
`export type CommMode = 'verbal' | 'written' | 'gesture' | 'translationApp' | 'interpreter'` (identical to
dialogue §9.1; presentation is wave 1 and cannot import dialogue) plus every type below.
```ts
export type DialogueTab = 'talk' | 'actions' | 'notes';
export interface DialogueOptionView { readonly id: string; readonly label: string; readonly enabled: boolean; readonly hint?: string }
export interface DialogueTopicView { readonly id: string; readonly label: string; readonly options: readonly DialogueOptionView[] }
export interface TranscriptLine { readonly id: number; readonly speaker: 'officer' | 'subject' | 'system'; readonly text: string; readonly pending: boolean }
export interface NoteLine { readonly text: string; readonly severity: 'info' | 'caution' | 'alert' }
export interface DialogueView { readonly contactId: number; readonly title: string; readonly subtitle: string; readonly tone: Tone; readonly commMode: CommMode;
  readonly commModes: readonly CommMode[]; readonly topics: readonly DialogueTopicView[]; readonly actions: readonly DialogueOptionView[];
  readonly transcript: readonly TranscriptLine[]; readonly statements: readonly NoteLine[]; readonly facts: readonly NoteLine[];
  readonly inconsistencies: readonly NoteLine[]; readonly busy: boolean }
export interface DialogueHandlers { say(optionId: string, tone: Tone): void; action(actionId: string): void; commMode(mode: CommMode): void; close(): void }
export interface DialoguePanelState { readonly tab: DialogueTab; readonly topic: number /* -1 = topic list */; readonly tone: Tone; readonly focus: number }
export type DialogueKeyResult = { readonly state: DialoguePanelState; readonly emit: { readonly kind: 'say'; readonly id: string; readonly tone: Tone }
  | { readonly kind: 'action'; readonly id: string } | { readonly kind: 'mode'; readonly mode: CommMode } | { readonly kind: 'close' } | null; readonly consumed: boolean };
/** Pure key reducer (tested): 1-9 picks a topic then an option (talk) or an action (actions); Backspace back to topics; ←/→ tone;
 *  Tab next tab; M next comm mode; ↑/↓ + Enter as digits; Escape: back from an option list, else close. Disabled options are not emitted. */
export function reduceDialogueKey(state: DialoguePanelState, view: DialogueView, key: string): DialogueKeyResult;
export class DialoguePanel implements Menu { readonly id: 'dialogue'; readonly element: HTMLElement; readonly pausesGame: false;
  constructor(ui: UIRoot | null); open(view: DialogueView, handlers: DialogueHandlers): void; update(view: DialogueView): void; close(): void;
  readonly isOpen: boolean; readonly state: DialoguePanelState; onKeyDown(event: KeyboardEvent): boolean; dispose(): void }
export interface SfstView { readonly title: string; readonly instruction: string; readonly prompt: string | null /* key label, e.g. 'SPACE' */;
  readonly promptRemaining: number /* 0..1 */; readonly progress: number; readonly finished: boolean; readonly summary: readonly string[] }
export class SfstPanel implements Menu { readonly id: 'sfst'; readonly pausesGame: false; constructor(ui: UIRoot | null);
  open(view: SfstView, handlers: { key(key: string): void; close(): void }): void; update(view: SfstView): void; close(): void; readonly isOpen: boolean;
  onKeyDown(event: KeyboardEvent): boolean; dispose(): void }
export function sfstKeyName(event: { key: string; code: string }): string | null;   // 'space' | 'a' | 'd' | 'w' | null
export class SubtitleBar { constructor(parent: HTMLElement | null); show(speaker: string, text: string, nowMs: number, durationMs?: number /* 4000 + 50/char */): void;
  update(nowMs: number): void; clear(): void; setVisible(v: boolean): void; readonly current: string | null; dispose(): void }
```
Layout: dialogue panel docked right (40 % width, full height minus the HUD), header (title, subtitle chips,
tone selector `[Polite] Neutral Commanding Aggressive`, comm mode chip), tab bar (Talk / Actions / Notes),
body (topic list or option list with digit badges; the actions list; notes: statements, facts,
inconsistencies with severity colours), transcript (last 8 lines; officer right-aligned, system italic),
footer with key help. SFST panel centred, large prompt key. Subtitles bottom-centre above the radio caption,
`"Name: text"`. Tone, comm mode and the subtitle setting (`accessibility.subtitles`) are read by the app.
Tests (`test/dialogueui/**`): `reduceDialogueKey` table (topics → options → emit, disabled skipped, tone
wrap, Escape behaviour, tabs), headless construction, `sfstKeyName`, subtitle timing.

### 12.4 HUD and minimap additions (`src/ui/hud/**`)
`HudSnapshot` gains optional `officer?: { weapon: 'none' | 'sidearm' | 'taser' } | null` (chip "SIDEARM" /
"TASER"), `contact?: { name: string; state: string; distanceM: number } | null` (contact chip),
`scene?: { title: string; objectives: readonly { text: string; done: boolean }[] } | null` (objective box,
top-left under the call strip, ≤ 4 lines, done ones struck through), `pursuit?: string | null` (red line).
`MARKER` gains `suspect: 9`, `person: 10`, `pursuit: 11`. `hudText` (pure) covers them; tests extend
`test/hud/**`.

### 12.5 Input actions (owned here; defaults in `bindings.ts`, all rebindable)
| Action | Kind | Keyboard | Gamepad | Use |
|---|---|---|---|---|
| `officer.weapon` | button | KeyC | GamepadButton9 | cycle holstered → sidearm → TASER (on foot) |
| `officer.fire` | button | MouseButton0 | GamepadButton7 | deploy TASER / sidearm placeholder (weapon drawn, on foot) |
| `officer.tackle` | button | Space | GamepadButton1 | tackle the person ahead (on foot) |
| `officer.shout` | button | KeyG | - | context command ("Police! Stop!", "Drop the weapon!") |
| `scene.menu` | button | KeyY | - | scene panel of your call (on scene) |
Existing tests of `test/input/actions.test.ts`/`bindings.test.ts` are extended (labels, defaults, no
duplicate action ids). Same-key reuse across driving/on-foot actions is intended (Space = handbrake while
driving, tackle on foot; G = horn / shout; mouse 0 only acts with a weapon drawn).

## 13. ECS components and event topics

No new ECS component: people are SoA pools inside `NpcSystem` (no physics bodies, no Rapier cost; the
traffic view pattern). `src/ecs/components.ts` is unchanged. Topics are declared by declaration merging in
each owner's `events.ts`:

| Topic | Owner file | Payload |
|---|---|---|
| `traffic:fleeing` / `traffic:fleeEnded` | `src/traffic/events.ts` | `{ eid, vehicleId }` / `{ eid, vehicleId, reason: FleeEndReason, x, z }`; `traffic:released.reason` + `'fled'` |
| `npc:fled` `npc:caught` `npc:escaped` `npc:surrendered` `npc:attack` `npc:weaponDropped` `npc:left` `npc:revealed` | `src/npc/events.ts` | §8.4 (all carry `actorId, personId, callId`) |
| `contact:event` `contact:line` `contact:caged` `contact:openForm` `contact:needsCall` | `src/contact/events.ts` | §10.3 |
| `scene:materialized` `scene:radio` `scene:line` `scene:flash` `scene:pursuit` `scene:outcome` `scene:openForm` `force:used` | `src/scene/events.ts` | §11.9 |
| `cad:callUpdated.change` + `'links'` | `src/cad/events.ts` | |

`src/core/event-map.ts` (integrator): extend the header comment listing the Phase 3 owners.

## 14. Step order, frame order, determinism

| Order | System | Work |
|---|---|---|
| (before) | session `fixedUpdate` | time, clock, officer movement |
| -1000 | `copyPrevTransform` | |
| -900 / -800 | `environment` / `colliders` | |
| -700 | `dispatch` | + Phase 3 generator weights, `openSelfInitiated`, stop licence with claimed id |
| **-690** | **`scene`** | queued events and requests, scenario build, timeline, materialize, actions, services, tactics, pursuits, presence |
| **-680** | **`contact`** | queued requests, dialogue, delayed answers, tools, SFST timers, escort |
| -650 | `radio` | (scene lines arrive through `RadioSystem.say`) |
| 40 / 50 | `vehicles.pre` / `traffic` | + flee mode, subject cars |
| **60** | **`npc`** | pedestrians (LOD), actors FSM (LOD), occupants, view arrays |
| 100 / 110 | `physics` / `vehicles.post` | |

Per frame (`App.update`), after Phase 2: officer actions (weapon, fire with the camera's horizontal
direction, tackle, shout, scene menu) → scene/contact requests; dialogue panel open/update when
`contact.active` or `contact.revision` changed (≤ 10 Hz); SFST panel; `PeopleRenderer.update(alpha, [npc.view,
officerFigure], camera, 150)` and `PropRenderer.update(scene.props, night)`; subtitles on `contact:line` /
`scene:line` (+ `SpeechOut.speak` for English, hearing subjects when `audio.tts`); HUD feed (10 Hz) with weapon,
contact chip, scene objectives, pursuit line, minimap markers (actors of the player's scene: suspect roles
red, others white; the fleeing car / runner). Determinism: everything above the presentation line runs in
fixed steps on named streams; UI input becomes queued requests; `test/game/session.test.ts` extends the
scripted replay with a Phase 3 scene (§20) and compares v5 saves bit for bit.

## 15. Workers

No new workers. Every Phase 3 simulation part must stay in the fixed step for determinism (worker results
arrive with timing jitter; Phase 1 §7.3 / Phase 2 §16 reasoning), and the budgets of §17 fit the main thread:
pedestrians and actors ≤ 0.2 ms per step with LOD, scenario building ≤ 2 ms once per call, the family
name-bucket index ≤ 10 ms once. `src/people`, `src/calls`, `src/dialogue` are DOM/THREE-free so a later
phase can move identity batches or catalog validation into a worker. The chunk worker and the Phase 0 sim
worker are unchanged.

## 16. Save schema v5 (integrator only; frozen after this phase)

```ts
export interface SaveGameV5 extends SaveGameV4 {
  people: PeopleSave;          // touched person deltas: intoxication, mood, custody, injuries, items, officer contacts, statements, facts, lies
  npc: NpcSave | null;         // pedestrians + actors + occupant state; null: fresh pedestrians at load (migrated saves)
  contacts: ContactSave;       // open conversations (memory, transcript, pending answers, SFST)
  scenes: SceneSave;           // scenarios of open calls (+ branch state), closed outcomes (<= 200), props, pursuits, officer weapon, queues
}
// cad: CadSave calls gain `links` (optional when reading). Prisoners stay in EquipmentSave.prisoner (person ids).
```
`CURRENT_SAVE_VERSION = 5`. `migrateV4ToV5`: `people: emptyPeopleSave()`, `npc: null`, `contacts:
emptyContactSave()`, `scenes: emptySceneSave(seedStreamState('scene'))` (`createRng(seed).stream('scene').state()`).
Load order: environment → entities → vehicles (+ equipment) → traffic → CAD → records → **people** →
dispatcher → **npc** (restore, or start empty) → **scenes** (`restore`, then `adoptOpenCalls`) → **contacts** →
radio. `isSaveGameV5` = v4 checks + `isPeopleSave`, `isNpcSave` or null, `isContactSave`, `isSceneSave`.
Tests (`test/save`): v1..v4 → v5 migrate and validate; v5 round trip; each malformed new block rejected; a
migrated v4 save with open calls loads and gets scenarios (`adoptOpenCalls`).

## 17. Performance budget (60 FPS, mid-range desktop GPU, 1080p)

| Subsystem | Budget | Notes |
|---|---|---|
| NPC step (160 peds + 30 actors + occupants) | ≤ 0.15 ms/step avg, ≤ 1 ms spike | LOD; routes only on state change; no allocation |
| Scene step | ≤ 0.03 ms/step avg; ≤ 2 ms on build/materialize | events only; presence scan ≤ 4 cars |
| Contact step | ≤ 0.01 ms idle; ≤ 0.5 ms per utterance | dialogue + inconsistency on demand |
| Traffic flee additions | ≤ +0.02 ms/step | per fleeing car only |
| People identity | ≤ 0.1 ms per new identity; LRU 2048 | cached per day |
| People renderer | ≤ 0.6 ms/frame for 300 figures, ≤ 8 draw calls | CPU matrices, no shadows, static pose > 50 m, hidden > 150 m |
| Prop renderer | ≤ 0.05 ms/frame, ≤ 12 draw calls (only kinds in use, `count` 0 otherwise) | |
| Dialogue panel / SFST | on change only, ≤ 10 Hz, ≤ 1 ms per rebuild | 0 when closed |
| HUD | 10 Hz, + ≤ 0.05 ms | |
| Draw calls total | target ≤ 200, cap 300 | +≤ 20 |
| Per-frame allocations | none in hot loops | strings only in throttled UI and on events |
| Save size | + ≤ 60 KiB typical | people deltas capped, transcripts ≤ 40 lines |

## 18. Requirement map

| Requirement | Code |
|---|---|
| Persistent identities from the Phase 2 registry (same ids), lazily generated, deltas persisted | `people/identity.ts`, `people/population.ts`, `records/db.ts` `peekPerson`, save v5 `people` |
| Identity fields: name, DOB, address, employer, vehicle, family, history, temperament, intoxication, health, mental health, attitude, language, hidden items | `people/identity.ts`, `people/family.ts`, `people/intoxication.ts`, `people/items.ts`, `data/people/*.json` |
| Ambient pedestrians (density by district/time), drivers/occupants who can step out | `npc/peds.ts`, `npc/occupants.ts`, `data/npc/density.json`, `npc.stepOut` |
| Instanced procedural humanoids, bone-less limb transforms, clothing from identity | `render/people/peopleRenderer.ts`, `render/people/pose.ts` |
| Approach/talk prompt, follow/stop, hands-up, cuff/uncuff, cage, frisk/search with consent, ID request (refuse/lie/fake) | session hints (integrator), `contact/**`, `npc/actors.ts`, `dialogue/respond.ts` |
| NPC behaviour state machine (cooperative ... dementia) | `npc/behavior.ts` (`decide`, `complianceChance`, `understands`), `data/npc/behaviors.json`, `dialogue/respond.ts` |
| Data-driven dialogue graph/menu with tone/topics; response factors | `data/dialogue/utterances.json`, `responses.json`, `trust.json`, `dialogue/**` |
| Dialogue DOM panel with shortcuts + subtitles | `ui/dialogue/dialoguePanel.ts`, `subtitleBar.ts`, app wiring |
| Deaf (written notes/gestures), non-English (interpreter / translation app with delay), juvenile (guardian), dementia | `dialogue/respond.ts` gates, `contact` comm modes and `notifyGuardian`, `services.json` interpreter |
| Lie model (name/DOB, destination, car contents, drinking) | `dialogue/respond.ts` |
| Inconsistencies across CAD lookups, statements over time, physical evidence; discovered only | `dialogue/inconsistency.ts`, `data/dialogue/rules.json`, `contact` facts, Notes tab |
| PBT, SFST minigame, questions, vehicle interior check | `dialogue/tools.ts`, `ui/dialogue/sfstPanel.ts`, contact actions |
| 150+ call types in `src/data/calls/` with schema validation, families with scene templates | `data/calls/**`, `calls/catalog.ts`, `calls/cadRows.ts`, `cad/data.ts` merge |
| Required call types (traffic stop ... school threat) | §4.3 (trafficStop, impairedDriver, minorCollision/injuryCollision, domesticDisturbance, welfareCheck, noiseComplaint/loudParty, trespass, shopliftingDetained, burglaryInProgress/burglaryCold, robbery, shotsFired, activeAssailant, armedPerson, suicidalSubject, overdose, missingPerson/foundPersonConfused, juvenileRunaway, wantedSubject, felonyStopVehicle, vehiclePursuit, footPursuit, hostageSituation/barricadedSubject, k9TrackRequest, warrantService, protest/crowdManagement, specialEventTraffic, blockedDriveway/parkingComplaint, strayDog, hazmatSpill, bombThreat, stolenVehicleSighted, fraudReport, stalkingReport, sexualAssaultScene, deathInvestigation, schoolThreat) |
| Branching outcomes, escalate/de-escalate/false/duplicate/swatting/ambush | `calls/scenario.ts`, `calls/conditions.ts`, `scene/director.ts` timeline |
| Imperfect dispatch info, live CAD narrative updates | `calls/scenario.ts` errors + timeline, `scene` applies, `cad.linkCalls` |
| Frequency/types by time of day and district | `dispatch/generator.ts` `pickType` crime weights |
| Dispositions recorded in CAD; end-to-end flow | `scene` panel clear → dispatcher `clearCall`; `CallOutcome`; MDT reports |
| Weapons/combat placeholder with hooks | `npc` armed/fight/flee, `scene` tactics, `force:used` |
| Vehicle pursuit (basic flee), foot pursuit (chase + tackle) | `traffic` flee mode, `scene` pursuits, `npc` flee/tackle |
| Barricade (contain + SWAT stub), K9 stub, service stubs | `actions.json` `contain`, `services.json`, `scene` effects |
| Perf: instanced rendering, AI tick LOD, no per-frame allocations | §17, `npc` LOD, renderers |
| Save v5 with people/call/case persistence | §16 |

## 19. Modules, ownership and waves

| Key | Wave | Owns (exclusively) | May import (new Phase 3 code) |
|---|---|---|---|
| people | 1 | `src/people/**`, `src/records/**`, `src/data/people/**`, `src/data/records/**`, `test/people/**`, `test/records/**` | none |
| calls | 1 | `src/calls/**`, `src/cad/**`, `src/data/calls/**`, `src/data/cad/**`, `test/calls/**`, `test/cad/**` | none |
| traffic | 1 | `src/traffic/**` (registry.ts frozen), `src/data/traffic/**`, `test/traffic/**` | none |
| presentation | 1 | `src/render/people/**`, `src/ui/dialogue/**`, `src/ui/hud/**`, `src/input/actions.ts`, `src/input/bindings.ts`, `test/peoplerender/**`, `test/dialogueui/**`, `test/hud/**`, `test/input/actions.test.ts`, `test/input/bindings.test.ts` | none |
| npc | 2 | `src/npc/**`, `src/data/npc/**`, `test/npc/**` | people, traffic, presentation (`render/people/pose.ts` only) |
| dialogue | 2 | `src/dialogue/**`, `src/data/dialogue/**`, `test/dialogue/**` | people |
| contact | 3 | `src/contact/**`, `test/contact/**` | people, calls (types), npc, dialogue, presentation (`ui/dialogue` view types only) |
| scene | 3 | `src/scene/**`, `src/dispatch/**`, `src/data/dispatch/**`, `test/scene/**`, `test/dispatch/**` | people, calls, traffic, npc, dialogue (types), presentation (`pose.ts`, `ui/panels` model type is Phase 2), contact **types only** via its own `ContactPort` / `IncidentResolver` structural interfaces (no import of `src/contact`) |
| integrator | 4 | `src/app.ts`, `src/game/**`, `src/core/event-map.ts`, `src/ecs/components.ts`, `src/save/**`, `docs/PHASES.md`, `scripts/smoke.mjs`, and unowned files (`src/main.ts`, `src/ui/ui.ts`, `src/ui/styles.css`, `src/ui/mdt/**`, `src/police/**` (e.g. `OfficerKit.consume`), `src/radio/**`, `docs/ARCHITECTURE.md`, `docs/ASSETS.md`, `README.md`, `test/game/**`, `test/save/**`, `test/mdt/**`, `test/radio/**`, `test/police/**`) | all |

Contact and scene are both wave 3: contact must not import `src/scene/**`; scene must not import
`src/contact/**` (it declares `ContactPort`, `IncidentResolver`-compatible methods and the shared
`ContactTarget`/`IncidentInfo`/`Presence` shapes are declared **in `src/scene/types.ts` and duplicated
structurally in `src/contact/types.ts`** with identical definitions from §10.2 — the integrator's `tsc` checks
they are assignable). Every module may import Phase 0-2 code but must not edit files it does not own.

## 20. Integrator plan

1. **Session** (`src/game/session.ts`): construct `Population` (after records), `NpcSystem`
   (`rng.stream('npc')`), `ContactManager` (`rng.stream('contact')`), `SceneDirector` (`rng.stream('scene')`)
   with `contact.setResolver(scene)`; register `scene` (-690), `contact` (-680), `npc` (60); the `scene:radio`
   → `radio.say('dispatch', text, speaker ?? undefined)` bridge; `contact:caged` → `equipmentList[i].seatPrisoner`;
   remove the Phase 2 automatic seat on `dispatch:arrest` (seat only on `contact:caged`); booking completion →
   people custody `jailed` and the booking fact (forward `cad:documentSaved`); npc focus each step (officer
   x/z/yaw/speed, onFoot, `scene.officerWeapon`, `scene.presence.lights`, `.backup`); interaction hints
   `'talk'` (`npc.nearestPerson` within 2.2 m, 60° cone) and `'cage'` (escorted cuffed actor within 4 m and the
   officer within 1.8 m of a patrol car rear door with an empty cage); the `'driver'` hint now opens a contact
   with the stop car's driver occupant; teleport clears pedestrians; dispose order: contact, scene, npc,
   then Phase 2 order; serialize / `loadGame` v5 (§16 order); kit `use` for scene consumables.
2. **Save** (`src/save/**`): v5 types, validators, `migrateV4ToV5`, tests.
3. **App** (`src/app.ts`): `PeopleRenderer`, `PropRenderer`, officer humanoid figure (replace the officer box
   mesh by a one-entry `HumanoidSource` in uniform colours, held item per weapon), `DialoguePanel`, `SfstPanel`,
   `SubtitleBar`, input actions of §12.5 (on foot only; mouse 0 only with a weapon drawn), scene panel on the
   Phase 2 `ActionPanel`, `contact:openForm` / `scene:openForm` → `mdt.openForm('citation' | 'report', prefill)`,
   NPC speech (`SpeechOut.speak(text, voiceProfileFor('npc:' + id, 'officer'))` for English lines when TTS is
   on), HUD feed (weapon, contact chip, scene objectives, pursuit line, markers), `OfficerKit.consume(itemId, n):
   boolean` (new, `src/police/inventory.ts`, with a test) behind the scene's `kit().use`, interact prompts ("E Talk",
   "E Place in rear seat"), Escape order (dialogue panel and SFST close themselves), perf extras `npc`
   (`peds/actors/occupants`), `scene` (`scenarios/materialized`), `people` (touched count); console commands
   from people, npc, scene (and calls `catalog` if provided).
4. **Determinism test** (`test/game/session.test.ts`): scripted shift with `scene spawn domesticDisturbance here`,
   accept, walk to the anchor, knock, open a contact with the victim (requestId, ask account), cuff the
   suspect, escort, cage; a traffic stop with a DUI subject (forced via `traffic.setBehavior`), requestId, PBT;
   compare v5 saves of two runs bit for bit; a mid-scene save/load continues exactly.
5. **Smoke test**: pedestrians visible downtown, a spawned call materializes actors, the dialogue panel opens
   and answers, SFST panel opens, a pursuit starts on a forced flee, save/load v5; screenshots `phase3.png`
   (street with pedestrians and a scene) and `phase3-dialogue.png`.
6. **Docs**: PHASES.md Phase 3 entry (controls, checklist, perf, limitations), ARCHITECTURE.md, README; ASSETS.md
   stays empty (no third-party assets).

## 21. Known limitations and later-phase hooks

- People have no physics bodies: they do not block the officer or cars, and cars do not hit them; NPCs keep
  to sidewalks and road shoulders and never enter buildings ("inside" participants appear at the door).
- Use of force is a placeholder: TASER and tackle work, the sidearm never fires (`force:used` events and
  `CallOutcome.forceUsed` feed Phase 5), NPC gunfire does not injure the officer.
- Pursuits are basic: the fleeing car wanders away at speed; no PIT, spikes or air support (Phase 6).
- Juveniles are 16-17 only (registry age range); family members may live at different addresses.
- Neighborhood trust is a per-district placeholder table (Phase 5 replaces it with a dynamic model).
- NPC voices use the browser's English TTS voices only; non-English lines are shown as untranslated text.
