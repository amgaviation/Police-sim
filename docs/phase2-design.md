# Phase 2 design: Police Vehicle, MDT, CAD, Radio

Status: design (technical director). Implementation is split into 10 modules (§20) plus an integrator (§21).
Read with `docs/ARCHITECTURE.md`, `docs/phase1-design.md` (conventions §2, road graph §5, traffic §9) and
`docs/research/*.md`. Browser API facts used below were checked against MDN on 2026-10-17 (§10.6).

## 1. Scope

At the end of Phase 2 the shift is a working police job: the officer drives a patrol car with a cockpit
(MDT laptop, radio head, siren controller, partition, long-gun rack), runs lights in data-driven
patterns and a synthesized siren, aims a real spotlight, pulls traffic over, runs plates against
persistent records, writes citations, reports, bookings and evidence entries in a keyboard-driven
CAD/MDT, and hears (and reads) a live radio: a dispatcher assigning a procedural call stream to six AI
patrol units that drive the road network, other agencies chattering on other channels, stepped-on
transmissions, status checks and an emergency button.

Non-goals (later phases): NPC people and dialogue (the "driver" of a stopped car is a records identity
with no mesh; Phase 3), call scenes with actors (calls are CAD/radio/driving events here), pursuits and
fleeing, use of force, weapons firing, Doppler (Phase 9), deployable cones/flares in the world (items
are inventory only; `deployable` is a Phase 3 hook), more than the handful of call types in §4.2.

## 2. Conventions (in addition to Phase 1 §2)

- **Two clocks.** Sim time (`GameClock.simTime`, s) drives every timer that changes state: call
  generation, on-scene durations, offers, status checks, radio scheduling. Game time
  (`env.time.totalSeconds`, 30x faster) is only *displayed* (CAD timestamps, narratives, documents).
  Both are carried together as `CadTime { sim: number; game: number }`. A call created at 14:00 game
  time that an AI unit reaches 90 sim seconds later shows 14:45: accepted Phase 1 time compression.
- **Calendar.** Game day 0 is **2026-06-01** (a Monday, matching `startWeekday` 0). Dates are integer
  *epoch days* (days since 1970-01-01) everywhere in data and saves; only UI formats them
  (`src/records/calendar.ts`, owned by [records]).
- **Determinism.** Everything that changes simulation state (dispatch, AI units, traffic, radio
  scheduling, records generation) runs in fixed steps and draws only from named streams:
  `'records:person:<id>'`, `'records:vehicle:<id>'`, `'records:bolo:<day>'` (pure, from `createRng(seed)`),
  `session.rng.stream('dispatch')` (+ children `'calls'`, `'units'`), `session.rng.stream('radio')`,
  the existing `'traffic'` stream (fleet cars draw from it too). Player input (radio menu, MDT, voice)
  is turned into `UnitRequest`s that the dispatcher **queues and applies at the start of its next fixed
  step**. TTS/audio timing, DOM, speech recognition and worker arrival never feed back into the sim;
  radio durations are *estimated* from word counts (§9.2), never measured from speech.
- **Ids.** Person ids `0 .. PERSON_POPULATION-1` (100 000). Registered vehicle ids `0 .. 59 999`
  (Phase 1 registry). AI fleet cars use vehicle ids `FLEET_ID_BASE + index` (`FLEET_ID_BASE = 1 << 20`),
  never valid registry ids. Calls: integer `id` from 1 and display number `C-00042`. Documents:
  `R-0001` (incident report), `CT-000001` (citation), `B-0001` (booking), `E-0001` (evidence),
  `S-0001` (supplemental). Units: callsign strings (`"12"` is the player, AI units `"21"`, `"23"`...).
- **Generic content only.** No real agency, place, court, company, gang or statute names; the agency
  is "City Police", courts "Municipal Court"/"County Court", statutes use a fictional `TR-`/`PC-`
  numbering, alarm callers are "Alarm monitoring center". Ten-codes are the generic APCO-style set;
  the phonetic alphabet is the APCO one (Adam, Boy, Charles...). No audio files: every sound is
  synthesized (Web Audio). `docs/ASSETS.md` stays empty.
- **TS rules** as Phase 1: no enums/namespaces/parameter properties; `as const` maps + unions;
  `import type`; `noUncheckedIndexedAccess`. Each module declares its bus topics by declaration merging
  in its own `events.ts` (`declare module '../core/event-map' { interface EventMap { ... } }`).
- **Data** in `src/data/<area>/*.json`, `"version": 1`, validated at import by a typed validator that
  throws an error naming the file and field (pattern: `src/vehicles/json.ts`, `src/environment/validate.ts`).
- **Headless.** Every DOM/Web Audio/Web Speech class constructs and runs as a no-op without
  `document`/`AudioContext`/`speechSynthesis` (vitest runs in node), keeping its pure model testable
  (pattern: `src/ui/hud/hud.ts` `hudText`). UI modules may ship a `.css` file imported from TS
  (verified to work under vite, vitest, tsc and eslint); class names are prefixed by module (`mdt-`,
  `radio-`, `panel-`).

## 3. Architecture

```
                     ┌──────────────────────────── fixed step (60 Hz, deterministic) ───────────────────────────┐
 input/UI ──UnitRequest──▶ Dispatcher (dispatch) ──mutates──▶ CadState (cad) ◀──reads── RadioSystem (radio)
  (MDT, radio menu,         │  call generator                 calls, units, AVL,        compose (events → text),
   voice, keys)             │  AI unit FSMs ──fleet API──▶ TrafficSystem (traffic)        RadioNet (channels, schedule,
                            │  status checks, emergency       pull-over, yield,           overlap/blocked), ambient
                            │  traffic-stop context           fleet cars, targeting
                            └──queries──▶ RecordsDb (records): persons, registrations, plates, BOLOs (pure + overlay)
 session: PatrolEquipment (police) per patrol car → PoliceLights store; push bumper via DamageSpec (vehicles)
                     └─────────────────────────────────────────────────────────────────────────────────────────┘
                     ┌──────────────────────────── per frame (presentation only) ─────────────────────────────────┐
  bus events ─▶ RadioPlayer (radio) ─▶ SpeechOut (TTS) + RadioFx (Web Audio)      AudioEngine/SirenBank (audio)
  CadState ───▶ MdtOverlay (mdt, DOM ≤ 4 Hz)   MdtScreen + CockpitRenderer (policeRender, canvas ≤ 2 Hz)
  PoliceLights ─▶ CarRenderer light bar patterns + spotlight (policeRender)   HUD, radio panel, panels (hud)
                     └─────────────────────────────────────────────────────────────────────────────────────────┘
```

- **AI patrol units are traffic cars.** Each AI unit is a *fleet car* inside `TrafficSystem`: pinned
  (never despawned), with an explicit patrol-car look, a route to follow (or wandering), urgency
  (patrol / respond = code 2 / emergency = code 3) and park-at-curb on arrival. They reuse IDM car
  following, junction logic, kinematic proxies near the player and the snapshot, and are simulated
  city-wide (traffic already steps every active car; six more cost < 0.01 ms). Ambient cars yield to
  emergency vehicles by the same curb-offset mechanism used for traffic stops (§7).
- **Event-driven decoupling.** Wave-2 modules never import each other. The dispatcher announces
  everything on the bus (`cad:*`, `dispatch:*`); the radio composes speech/text from those events and
  `CadState`; the MDT reads `CadState`/`RecordsDb` and emits requests through an injected callback; the
  integrator wires bus events to DOM panels. Shared shapes live in wave-1 `src/cad/types.ts`.
- **CAD state is one object** (`CadState`) holding calls, units (with AVL positions), documents and the
  traffic-stop context; the dispatcher owns the *behaviour* (generator, FSMs, timers) and its own save
  block.

## 4. Data formats

Owners in brackets (§20). Every file has `"version": 1`.

### 4.1 Records [records] `src/data/records/`
`names.json` — generic name lists: `{ "version": 1, "male": [...200], "female": [...200], "last": [...300], "middleInitials": "ABCDEFGHJKLMNPRSTW" }`.

`calendar.json` — `{ "version": 1, "startDate": "2026-06-01" }`.

`person.json`
```jsonc
{ "version": 1, "population": 100000, "ageRange": [16, 90],
  "physical": { "heightCm": { "M": [160, 196], "F": [150, 183] }, "weightKg": { "M": [58, 125], "F": [45, 105] },
                "eyes": ["brown", "blue", "green", "hazel", "gray"], "hair": ["black", "brown", "blond", "red", "gray", "bald"] },
  // latent risk r = u^exponent (u from the person stream) multiplies every "criminal" rate by (0.25 + 3 r)
  "risk": { "exponent": 3 },
  "license": { "none": 0.06, "suspended": 0.04, "revoked": 0.01, "expired": 0.03, "classes": { "C": 0.9, "A": 0.04, "B": 0.03, "M": 0.03 } },
  "warrants": { "rate": 0.03, "max": 3, "courts": ["Municipal Court", "County Court"],
                "kinds": [ { "kind": "bench", "label": "Failure to appear", "weight": 5, "bail": [250, 2500] },
                           { "kind": "arrest", "label": "Burglary", "weight": 1, "bail": [5000, 25000] } ] },
  "supervision": { "probation": 0.03, "parole": 0.01, "conditions": ["Search waiver", "No alcohol", "Curfew 22:00", "No contact with victim"] },
  "gang": { "rate": 0.012, "names": ["Copperline Crew", "Quarry Lane Set", "Bluegill Boys", "Ashgrove Collective"], "associateShare": 0.6 },
  "mentalHealth": { "rate": 0.02, "notes": ["Prior crisis contact - approach calmly", "Known to be suicidal - use caution"] },
  "officerSafety": { "rate": 0.012, "notes": ["Known to carry weapons", "Prior assault on officer", "Flight risk"] },
  "firearms": { "rate": 0.14, "max": 3, "types": ["Handgun 9mm", "Handgun .40", "Revolver .38", "Rifle .223", "Shotgun 12 ga"] },
  "protectiveOrders": { "rate": 0.008, "conditions": ["No contact", "Stay 100 yards away", "Surrender firearms"] },
  "priors": { "mean": 0.7, "max": 6,
              "kinds": [ { "kind": "trafficStop", "label": "Traffic stop", "weight": 6 }, { "kind": "fieldInterview", "label": "Field interview", "weight": 2 },
                         { "kind": "arrest", "label": "Arrest", "weight": 1 }, { "kind": "citation", "label": "Citation", "weight": 4 } ] },
  "phonePrefix": "555" }
```
`vehicle.json`
```jsonc
{ "version": 1,
  "plateAnomalies": { "cloned": 0.002, "mismatched": 0.004, "stolenPlate": 0.002 },   // per physical car, exclusive
  "intrinsic": { "plateReportedStolen": 0.004, "cloneAlert": 0.01 },                  // per registration (donor pools)
  "flags": { "rate": 0.008, "reasons": ["Associated with narcotics investigation", "Used in a robbery - BOLO", "Hit-and-run suspect vehicle"] },
  "driverIsOwner": 0.8,
  "registration": { "validMinDays": 60, "validMaxDays": 700, "expiredMaxDays": 400 },
  "colors": [ { "name": "black", "hex": "#16181d" }, { "name": "white", "hex": "#f2f2f2" } /* one per colour used by vehicle models */ ],
  "vinPrefix": "PT" }
```
`bolo.json` — `{ "version": 1, "perDay": [3, 6], "vehicleShare": 0.6, "vehicleReasons": [...], "personReasons": ["Wanted: failure to appear", "Missing person - endangered"] }`.

### 4.2 CAD [cad] `src/data/cad/`
`callTypes.json` — the call-type table (extensible: Phase 3 adds 150+ rows, no code change):
```jsonc
{ "version": 1, "types": [
  { "id": "trafficHazard", "label": "Traffic hazard", "codeKey": "hazard", "category": "traffic",   // crime timeOfDay category
    "generated": true, "weight": 1.2,                                // relative share in the generator
    "priority": { "2": 0.25, "3": 0.6, "4": 0.15 },                  // P1..P4 distribution
    "location": "road",                                              // road | block | intersection | poi:<kind>
    "districts": { "highway": 2, "rural": 1.3, "water": 0 },          // multipliers (missing = 1)
    "units": [1, 1], "onSceneS": [90, 240],                          // AI units assigned, sim seconds on scene
    "callers": { "citizen": 0.8, "anonymous": 0.2 },
    "narratives": ["RP reports {hazard} in the roadway near {cross}.", "{hazard} blocking the {dir} lane on {street}."],
    "fill": { "hazard": ["a mattress", "a large tire", "a fallen tree branch", "scattered debris"] },
    "dispositions": ["handled", "goneOnArrival", "unfounded"] } ] }
```
Generated types (Phase 2): `trafficHazard`, `suspiciousVehicle` (narrative includes a registry plate and
description via `{plate}`/`{vehicle}`), `noiseComplaint` (block, night-weighted through category
`disturbance`), `welfareCheck`, `minorCollision` (intersection), `alarm` (block, commercial districts),
`suspiciousPerson`, `parkingComplaint`. Non-generated (`"generated": false`): `trafficStop`
(self-initiated, P4), `officerAssist` (backup; P2 code 2, P1 code 3), `officerEmergency` (P1),
`officerWelfare` (status-check escalation, P1). Placeholders available to narratives: `{street}`,
`{cross}`, `{near}`, `{address}`, `{district}`, `{dir}`, `{plate}`, `{vehicle}`, `{caller}`, plus the
type's own `fill` keys.

`statutes.json` — fictional, data-driven statute table for citations and charges:
```jsonc
{ "version": 1, "statutes": [
  { "id": "TR-301", "title": "Speeding", "category": "traffic", "class": "infraction", "fine": 150, "citeable": true, "bookable": false, "speed": true },
  { "id": "TR-302", "title": "Failure to obey red signal", "category": "traffic", "class": "infraction", "fine": 238, "citeable": true, "bookable": false },
  { "id": "TR-330", "title": "Driving with suspended license", "category": "traffic", "class": "misdemeanor", "fine": 300, "citeable": true, "bookable": true },
  { "id": "PC-220", "title": "Outstanding warrant", "category": "criminal", "class": "warrant", "fine": 0, "citeable": false, "bookable": true } ],
  "violationMap": { "speeding": "TR-301", "redLight": "TR-302", "rollingStop": "TR-303", "tailgating": "TR-310", "weaving": "TR-350" },
  "plateMap": { "expired": "TR-320", "uninsured": "TR-321", "cloned": "PC-211", "stolen": "PC-210" } }
```
At least: speeding, red signal, stop sign, following too closely, unsafe lane use, expired registration,
no insurance, defective lamps, no license, suspended license, DUI, stolen vehicle, false/cloned plates,
outstanding warrant, obstructing, possession of stolen property.

`tenCodes.json` — the radio code table (ten-code and plain-language forms of every coded phrase):
```jsonc
{ "version": 1, "codes": {
  "ack": { "code": "10-4", "plain": "copy" }, "repeat": { "code": "10-9", "plain": "say again" },
  "available": { "code": "10-8", "plain": "in service" }, "outOfService": { "code": "10-7", "plain": "out of service" },
  "busy": { "code": "10-6", "plain": "busy" }, "enRoute": { "code": "10-76", "plain": "en route" },
  "onScene": { "code": "10-23", "plain": "on scene" }, "transporting": { "code": "10-15", "plain": "transporting" },
  "location": { "code": "10-20", "plain": "location" }, "registration": { "code": "10-28", "plain": "registration check" },
  "wants": { "code": "10-29", "plain": "wants check" }, "emergency": { "code": "10-33", "plain": "emergency traffic" },
  "assist": { "code": "10-78", "plain": "need assistance" }, "trafficStop": { "code": "10-38", "plain": "traffic stop" },
  "allOk": { "code": "Code 4", "plain": "all OK" }, "hazard": { "code": "10-49", "plain": "traffic hazard" },
  "collision": { "code": "10-50", "plain": "collision" } },
  "statusKeys": { "available": "available", "enRoute": "enRoute", "onScene": "onScene", "busy": "busy",
                  "outOfService": "outOfService", "transporting": "transporting" } }
```
`dispositions.json` — `{ "version": 1, "dispositions": [ { "id": "handled", "label": "Handled" }, { "id": "reportTaken", ... }, citationIssued, warningIssued, arrestMade, goneOnArrival, unfounded, referred, cancelled ] }`.

`address.json` — `{ "version": 1, "metresPerHundred": 100, "intersectionRadius": 40, "agency": "City Police" }`.

### 4.3 Traffic [traffic] `src/data/traffic/pullover.json`
```jsonc
{ "version": 1,
  "detect": { "minDistance": 3, "maxDistance": 35, "lateral": 2.5, "headingDot": 0.8, "delayS": 1.5 },
  "curb": { "clearance": 0.15, "lateralSpeed": 0.9, "decel": 2.0, "noPullNearLineM": 30, "hazards": true },
  "release": { "lateralSpeed": 0.7, "autoReleaseM": 150 },
  "yield": { "range": 50, "lateral": 6, "passMargin": 10, "timeoutS": 20 },
  "fleet": { "maxCars": 16, "patrolFactor": 0.9, "respondFactor": 1.05, "emergencyFactor": 1.35,
             "maxEmergencySpeed": 30, "crossSpeed": 5, "arriveDistance": 25 } }
```

### 4.4 Police equipment [equipment] `src/data/police/` and vehicle models
`lightbar.json` — 8 segments left to right; frames are strings of 8 characters `.` off, `R` red,
`B` blue, `W` white, `A` amber, with a duration in seconds:
```jsonc
{ "version": 1, "segments": 8, "reducedFlash": { "minFrameS": 0.34, "level": 0.55 },
  "patterns": [
    { "id": "alternate", "label": "Alternating", "frames": [["RRRR....", 0.25], ["....BBBB", 0.25]] },
    { "id": "quad", "label": "Quad flash", "frames": [["RRRR....", 0.06], ["........", 0.05], ["RRRR....", 0.06], ["........", 0.05],
                                                      ["....BBBB", 0.06], ["........", 0.05], ["....BBBB", 0.06], ["........", 0.05]] },
    { "id": "sweep", "label": "Sweep", "frames": [["R.......", 0.07], [".R......", 0.07], ["..R.....", 0.07], ["...R....", 0.07],
                                                  ["....B...", 0.07], [".....B..", 0.07], ["......B.", 0.07], [".......B", 0.07]] },
    { "id": "takedown", "label": "Takedown", "frames": [["RWWWWWWB", 0.3], ["BWWWWWWR", 0.3]] },
    { "id": "cruise", "label": "Cruise (steady)", "frames": [["B......B", 1.0]] },
    { "id": "arrowLeft", "label": "Traffic advisor left", "frames": [["......AA", 0.12], ["....AAAA", 0.12], ["..AAAAAA", 0.12], ["AAAAAAAA", 0.18], ["........", 0.2]] } ] }
```
`items.json` — trunk items: `{ "version": 1, "items": [ { "id": "cones", "label": "Traffic cones", "carryMax": 4, "deployable": true }, flares, firstAid, aed, spikeStrip, evidenceKit, fireExtinguisher, trafficVest (all eight required) ] }`.

`equipment.json`
```jsonc
{ "version": 1,
  "siren": { "tones": ["wail", "yelp", "phaser", "hilo"], "defaultTone": "wail" },
  "spotlight": { "yawMin": -1.0, "yawMax": 2.6, "pitchMin": -0.5, "pitchMax": 0.25, "defaultYaw": 0.25, "defaultPitch": -0.08, "aimRate": 0.0025 },
  "rack": { "items": [ { "id": "shotgun", "label": "Patrol shotgun" }, { "id": "rifle", "label": "Patrol rifle" } ], "unlockRequiresStop": true },
  "trunkLoadouts": { "patrol": { "cones": 6, "flares": 8, "firstAid": 1, "aed": 1, "spikeStrip": 1, "evidenceKit": 1, "fireExtinguisher": 1, "trafficVest": 1 } } }
```
Vehicle model JSON (`src/data/vehicles/patrol_*.json`) gains an optional section; `parseVehicleModel`
exposes `VehicleModel.equipment: VehicleEquipmentSpec | null` and folds the push bumper into the
damage spec:
```jsonc
"equipment": { "pushBumper": { "frontStrength": 1.8, "engineShare": 0.5 }, "partition": true, "rack": true,
               "spotlight": true, "mdt": true, "trunk": "patrol" }
```

### 4.5 Audio [audio] `src/data/audio/sirens.json`
```jsonc
{ "version": 1,
  "tones": { "wail":   { "lowHz": 650, "highHz": 1500, "periodS": 4.5,  "shape": "triangle" },
             "yelp":   { "lowHz": 650, "highHz": 1500, "periodS": 0.32, "shape": "sawtooth" },
             "phaser": { "lowHz": 800, "highHz": 1700, "periodS": 0.09, "shape": "sawtooth" },
             "hilo":   { "lowHz": 770, "highHz": 960,  "periodS": 1.3,  "shape": "square" } },
  "horn": { "freqsHz": [311, 392], "attackS": 0.03, "releaseS": 0.15 },
  "manual": { "minHz": 200, "maxHz": 1500, "riseS": 2.5, "fallS": 4 },
  "voice": { "wave": "sawtooth", "lowpassHz": 3200, "gain": 0.35 },
  "panner": { "model": "inverse", "refDistance": 12, "rolloff": 1.1, "maxDistance": 900 },
  "voices": 4, "maxAudibleM": 700, "cabin": { "gain": 0.45, "lowpassHz": 2500 } }
```

### 4.6 Dispatch [dispatch] `src/data/dispatch/`
`units.json`
```jsonc
{ "version": 1,
  "player": { "callsign": "12", "beat": "downtown" },
  "units": [ { "callsign": "21", "officer": "Officer Reyes", "model": "patrol_sedan", "beat": "downtown" },
             { "callsign": "23", "officer": "Officer Park", "model": "patrol_suv", "beat": "suburbs" } /* 6 units */ ] }
```
`dispatch.json`
```jsonc
{ "version": 1,
  "generator": { "meanIntervalS": 75, "firstCallDelayS": 20, "maxOpenCalls": 8, "nearPlayerShare": 0.6,
                 "nearRadiusM": 1800, "minDistanceM": 150, "crimeReferenceRate": 0.5 },
  "offer": { "radiusM": 2500, "timeoutS": 25 },
  "assign": { "maxDistanceM": 6000, "p1Units": 2 },
  "statusCheck": { "afterS": 300, "responseS": 30, "attempts": 2, "escalateUnits": 2 },
  "backup": { "code2Units": 1, "code3Units": 2, "retargetS": 5, "retargetMoveM": 30 },
  "emergency": { "units": 3 },
  "aiUnits": { "stuckS": 60, "forceArriveS": 150, "beatRadiusM": 1500, "breakChancePerHour": 0.1, "breakS": [300, 600] },
  "avlIntervalS": 0.5 }
```

### 4.7 Radio [radio] `src/data/radio/`
`channels.json`
```jsonc
{ "version": 1,
  "channels": [ { "id": "dispatch", "label": "City Dispatch", "short": "DISP", "dispatcher": "Dispatch", "ambientPerMin": 1.2, "requests": true },
                { "id": "tac", "label": "Tactical 2", "short": "TAC2", "dispatcher": null, "ambientPerMin": 0.3, "requests": false },
                { "id": "car", "label": "Car-to-car", "short": "CAR", "dispatcher": null, "ambientPerMin": 0.4, "requests": false },
                { "id": "fireEms", "label": "Fire / EMS", "short": "F/EMS", "dispatcher": "Fire Dispatch", "ambientPerMin": 1.0, "requests": false },
                { "id": "county", "label": "County", "short": "CNTY", "dispatcher": "County", "ambientPerMin": 0.8, "requests": false },
                { "id": "state", "label": "State", "short": "STATE", "dispatcher": "State Dispatch", "ambientPerMin": 0.5, "requests": false } ],
  "defaultSelected": "dispatch", "defaultScan": ["dispatch", "tac", "fireEms"],
  "wordsPerSecond": 2.6, "keyUpS": 0.35, "tailS": 0.3, "doubleKeyChance": 0.04, "scanVolume": 0.7, "logSize": 100 }
```
`phrases.json` — message kinds, each with `tenCode` and `plain` template arrays (one picked by the radio
stream): `assign`, `unitAck`, `enRoute`, `onScene`, `clear`, `dispatchAck`, `offer`, `offerTimeout`,
`plateRequest`, `plateClear`, `plateHit`, `personReturn`, `backupRequest`, `backupDispatch`,
`noUnits`, `emergencyAlert`, `emergencyClear`, `statusCheck`, `statusCheckRepeat`, `statusEscalate`,
`locationAsk`, `locationGive`, `locationAnswer`, `trafficStop`, `trafficStopAck`, `stopClear`,
`blocked`, `wrongChannel`, `code4`, `status` (generic status change). Placeholders: `{unit}`, `{player}`,
`{nature}`, `{address}`, `{cross}`, `{near}`, `{priority}`, `{plate}`, `{desc}`, `{owner}`, `{hits}`,
`{units}`, `{code:<key>}` (from `tenCodes.json` in the active mode), `{time}`.
Example: `"assign": { "tenCode": ["{unit}, {nature}, {address}, cross {cross}, P{priority}."], "plain": ["{unit}, respond to a {nature} at {address}, near {cross}, priority {priority}."] }`.

`ambient.json` — per channel `{ "units": [...callsigns], "templates": [...] }` (fire: "Engine 4",
"Medic 2", "Truck 1"; county "County 31"...; state "Trooper 12"...); template placeholders as above
plus `{randomPlate}` (a registry plate) and `{randomAddress}`.

`phonetic.json` — `{ "version": 1, "letters": { "A": "Adam", "B": "Boy", "C": "Charles", ... }, "digits": { "0": "zero", ..., "9": "nine" } }`.

`commands.json` — voice-command synonyms (§9.5): `{ "version": 1, "status": { "available": ["10-8", "ten eight", "in service", "available", "clear"], ... }, "runPlate": ["run plate", "run a plate", "ten twenty eight"], "backup": [...], "location": [...], "code4": [...], "trafficStop": [...] }`.

## 5. Records [records] (`src/records/**`)

Every record is a pure function of `(seed, id)` (+ the city for home addresses), generated lazily,
cached, and snapshotted into the save once *touched* (looked up or referenced), so a saved game keeps
the exact records it showed even if data tables change in a later version. Player actions add an
*overlay* (contacts from this shift, served warrants, added BOLOs) that is also saved.

### 5.1 Identities and bijections (`ids.ts`, `calendar.ts`)
- Owner map: `ownerOfVehicle(seed, v) = (v * A + B(seed)) mod PERSON_POPULATION` with `A` coprime to the
  population (same affine-bijection technique as plates, Phase 1 §9.1); `vehicleOfOwner` inverts it
  (−1 when the preimage is ≥ 60 000). Every registered vehicle has exactly one distinct registered owner;
  `VehicleRecord.ownerSeed` seeds secondary registration details (insurer, expiry day).
- DL number `"D" + 7 digits` = affine bijection of the person id over `[0, 10^7)`; `personIdFromDl`
  inverts and rejects ids ≥ population. VIN: 17 characters from `0-9A-Z` without `I O Q`, prefix from
  data, 6-character base-33 serial = bijection of the vehicle id mixed with the seed, plus a check
  character; `vehicleIdFromVin` decodes then verifies `vinOf(seed, id) === vin`.
- **Fast identity**: `personIdentity(seed, id)` (sex, first, middle initial, last, DOB) uses integer
  hashing only (no RNG stream), so the name index over all 100 000 persons builds in < 10 ms
  (counting sort by last-name index, `Int32Array` buckets) the first time a name search runs.

### 5.2 Person record (`person.ts`)
Full record = identity + draws from `createRng(seed).stream('records:person:<id>')` in a fixed,
append-only order: physical (height, weight, eyes, hair), home address (edge from `ctx.homeEdges`,
position along it, text from `ctx.formatAddress`), phone, risk, license (class, status, expiry),
warrants (0..max: id `W<id>-<n>`, kind, offense label, bail, court, issued day), supervision
(probation/parole, agent, conditions, until), gang (name, member/associate), mental-health note,
officer-safety notes, firearm registrations (type, serial, registered day), protective orders (as
restrained party: protected person id, conditions, expiry), prior contacts (day, kind, location text,
summary). Criminal-ish rates scale with the latent risk (data `risk.exponent`), so flags cluster on
the same people.

### 5.3 Vehicles and plates (`vehicle.ts`)
`generateRegistration(seed, v)` uses the Phase 1 `vehicleRecord(seed, v)` (model, colour, year,
expired, insured, stolen) **unchanged** plus `'records:vehicle:<v>'` draws: VIN, owner (§5.1), expiry
day (valid ≥ start + `validMinDays`, expired ≤ start), insurer, vehicle flag (rate, reason), intrinsic
`plateReportedStolen` and `cloneAlert` (fast hashes so donor searches are cheap).

What is physically on traffic car `A` (`mountedPlate(seed, A)`), exclusive anomalies drawn from A's
stream: `cloned` (plate of donor B with the same model and colour and an intrinsic `cloneAlert`),
`mismatched` (plate of a donor with a different model), `stolenPlate` (plate of a donor whose plates
were reported stolen), else `none` (its own plate). Donors are found by probing ids from a hash start
with stride 7919 (coprime), first match wins (≤ 0.2 ms).

`PLATE_FLAG = { expired: 1, stolen: 2, cloned: 4, mismatched: 8, flagged: 16 }`. Truth for car A
(`plateFlags`): `stolen` = A's vehicle is stolen or anomaly `stolenPlate`; `cloned`/`mismatched` = the
anomaly; `expired`/`flagged` = the registration *the mounted plate belongs to* is expired / has a
vehicle flag or an owner with an active warrant. **Detection** (`RecordsDb.runPlate(plate, observed)`)
reports: stolen vehicle and reported-stolen plate hits, a "possible cloned plate - verify VIN" hit for
`cloneAlert` registrations, "DESCRIPTION MISMATCH" when `observed` (model/colour of the car the officer
targeted) differs from the registration, expired registration, flag/BOLO reasons, RO warrant, plus
owner hits (DL status, officer safety...). A VIN check (`runVin(vinOf(A))`) returns A's own
registration, whose plate differs from the mounted one: the clone is confirmed.

`driverOf(seed, v)`: the owner with probability `driverIsOwner`, else another person from the stream;
never the owner when the vehicle is stolen or the plate anomalous.

### 5.4 API
```ts
// calendar.ts
export const CALENDAR: { readonly startEpochDay: number };
export function epochDayOfGameSeconds(gameSeconds: number): number;
export function ymdOfEpochDay(day: number): { y: number; m: number; d: number };
export function epochDayFromYmd(y: number, m: number, d: number): number;
export function formatDate(epochDay: number): string;              // "06/01/2026"
export function formatClockTime(gameSeconds: number): string;      // "14:32"
export function formatStamp(gameSeconds: number): string;          // "06/01/2026 14:32"
export function ageOn(dob: number, epochDay: number): number;
// ids.ts
export const PERSON_POPULATION: number;
export function ownerOfVehicle(seed: number, vehicleId: number): number;
export function vehicleOfOwner(seed: number, personId: number): number;          // -1 none
export function dlNumberOf(seed: number, personId: number): string;
export function personIdFromDl(seed: number, dl: string): number | null;
export function vinOf(seed: number, vehicleId: number): string;
export function vehicleIdFromVin(seed: number, vin: string): number | null;
// person.ts
export interface PersonIdentity { readonly id: number; readonly first: string; readonly middle: string; readonly last: string; readonly sex: 'M' | 'F'; readonly dob: number }
export type LicenseStatus = 'valid' | 'suspended' | 'revoked' | 'expired' | 'none';
export interface Warrant { readonly id: string; readonly kind: string; readonly offense: string; readonly bail: number; readonly court: string; readonly issued: number }
export interface PriorContact { readonly day: number; readonly kind: string; readonly location: string; readonly summary: string; readonly ref: string }
export interface PersonRecord extends PersonIdentity {
  readonly heightCm: number; readonly weightKg: number; readonly eyes: string; readonly hair: string;
  readonly address: string; readonly phone: string;
  readonly license: { readonly number: string; readonly cls: string; readonly status: LicenseStatus; readonly expires: number };
  readonly warrants: readonly Warrant[];
  readonly supervision: { readonly kind: 'none' | 'probation' | 'parole'; readonly agent: string; readonly until: number; readonly conditions: readonly string[] };
  readonly gang: { readonly name: string; readonly role: 'member' | 'associate' } | null;
  readonly mentalHealth: string | null; readonly officerSafety: readonly string[];
  readonly firearms: readonly { readonly type: string; readonly serial: string; readonly registered: number }[];
  readonly protectiveOrders: readonly { readonly protectedId: number; readonly conditions: readonly string[]; readonly expires: number }[];
  readonly priors: readonly PriorContact[] }
/** Generation never depends on `today` (records must not change from day to day); only ages, summaries and BOLO day use it. */
export interface RecordsContext { readonly homeEdges: readonly number[]; formatAddress(edge: number, t: number): string; today(): number /* epoch day */ }
export function personIdentity(seed: number, id: number): PersonIdentity;
export function generatePerson(seed: number, id: number, ctx: RecordsContext): PersonRecord;
// vehicle.ts
export const PLATE_FLAG: { readonly expired: 1; readonly stolen: 2; readonly cloned: 4; readonly mismatched: 8; readonly flagged: 16 };
export type PlateAnomaly = 'none' | 'cloned' | 'mismatched' | 'stolenPlate';
export interface MountedPlate { readonly vehicleId: number; readonly plate: string; readonly plateVehicleId: number; readonly anomaly: PlateAnomaly }
export interface ObservedVehicle { readonly modelId: string; readonly color: number }
export interface RegistrationRecord { readonly vehicleId: number; readonly plate: string; readonly vin: string; readonly year: number;
  readonly modelId: string; readonly modelName: string; readonly color: number; readonly colorName: string; readonly ownerId: number;
  readonly expires: number; readonly expired: boolean; readonly insured: boolean; readonly insurer: string; readonly stolen: boolean;
  readonly plateReportedStolen: boolean; readonly cloneAlert: boolean; readonly flag: string | null }
export function mountedPlate(seed: number, vehicleId: number): MountedPlate;
export function plateFlags(seed: number, vehicleId: number): number;
export function observedVehicle(seed: number, vehicleId: number): ObservedVehicle;   // the car's true model/colour
export function generateRegistration(seed: number, vehicleId: number): RegistrationRecord;
export function driverOf(seed: number, vehicleId: number): number;
export function vehicleDescription(r: { year: number; colorName: string; modelName: string }): string;  // "2019 black Sedan"
// hits + queries (db.ts)
export type HitSeverity = 'info' | 'caution' | 'alert';
export interface RecordHit { readonly kind: string; readonly severity: HitSeverity; readonly text: string }
export interface PlateQueryResult { readonly plate: string; readonly found: boolean; readonly registration: RegistrationRecord | null;
  readonly owner: PersonRecord | null; readonly hits: readonly RecordHit[]; readonly flags: number; readonly observed: ObservedVehicle | null }
export interface VinQueryResult { readonly vin: string; readonly found: boolean; readonly registration: RegistrationRecord | null; readonly hits: readonly RecordHit[] }
export interface PersonQuery { readonly last?: string; readonly first?: string; readonly dob?: number; readonly dl?: string }
export interface PersonSummary { readonly personId: number; readonly name: string; readonly dob: string; readonly dl: string; readonly dlStatus: string; readonly hits: readonly string[]; readonly severity: 'clear' | 'caution' | 'alert' }
export interface PlateSummary { readonly plate: string; readonly found: boolean; readonly description: string; readonly owner: string; readonly ownerPersonId: number; readonly hits: readonly string[]; readonly severity: 'clear' | 'caution' | 'alert' }
export interface Bolo { readonly id: string; readonly day: number; readonly kind: 'vehicle' | 'person'; readonly vehicleId: number; readonly personId: number; readonly text: string }
export interface ContactEntry { readonly gameSeconds: number; readonly kind: 'citation' | 'arrest' | 'warning' | 'trafficStop' | 'fieldInterview'; readonly ref: string; readonly summary: string }
export interface QueryLogEntry { readonly gameSeconds: number; readonly kind: 'plate' | 'vin' | 'person' | 'dl'; readonly text: string; readonly summary: string; readonly severity: 'clear' | 'caution' | 'alert' }
export class RecordsDb {
  constructor(seed: number, ctx: RecordsContext);
  person(id: number): PersonRecord;                         // RangeError outside the population; overlay applied
  registration(vehicleId: number): RegistrationRecord;
  personHits(id: number): RecordHit[];
  runPlate(plate: string, observed?: ObservedVehicle, gameSeconds?: number): PlateQueryResult;   // logs the query
  runVin(vin: string, gameSeconds?: number): VinQueryResult;
  findPersons(q: PersonQuery, limit?: number): PersonSummary[]; // name index built lazily; deterministic order (last, first, dob, id)
  personSummary(id: number): PersonSummary;
  bolos(epochDay: number): readonly Bolo[];                 // daily bulletin (pure from seed + day) + added ones
  addBolo(b: Omit<Bolo, 'id'>): Bolo;
  addContact(personId: number, c: ContactEntry): void;      // shows up first in `priors`
  serveWarrant(personId: number, warrantId: string): void;  // removes it from active warrants and hits
  readonly queryLog: readonly QueryLogEntry[];              // newest last, <= 50
  serialize(): RecordsSave; restore(save: RecordsSave): void;
}
export function plateSummary(r: PlateQueryResult): PlateSummary;      // same shape as cad PlateReadback
export function homeEdgesOf(city: City): number[];                     // local/collector edges in suburbs, downtown, rural
export interface RecordsSave { version: 1; persons: PersonRecord[]; vehicles: RegistrationRecord[]; contacts: [number, ContactEntry[]][];
  served: [number, string[]][]; bolos: Bolo[]; queries: QueryLogEntry[] }
export function emptyRecordsSave(): RecordsSave;
export function isRecordsSave(x: unknown): x is RecordsSave;   // structural; malformed snapshots are dropped on restore (regenerated)
export function createRecordsCommands(deps: { records(): RecordsDb | null; seed(): number | null }): Command[]; // person, runplate, vin, dl, platestates, bolos
```
Snapshot caps: 500 persons + 500 registrations, least-recently-touched first out, but anything
referenced by a contact, served warrant or BOLO is kept.

## 6. CAD core [cad] (`src/cad/**`)

### 6.1 Types (`types.ts`) — the shared contract of wave 2
```ts
export type Priority = 1 | 2 | 3 | 4;
export const UNIT_STATUSES = ['available', 'enRoute', 'onScene', 'busy', 'outOfService', 'transporting'] as const;
export type UnitStatus = (typeof UNIT_STATUSES)[number];
export type RequestVia = 'radio' | 'mdt' | 'voice' | 'key' | 'auto';
export type RadioMode = 'tenCode' | 'plain';
export interface CadTime { readonly sim: number; readonly game: number }
export interface CadLocation { readonly x: number; readonly z: number; readonly edge: number; readonly text: string;
  readonly street: string; readonly cross: string; readonly near: string; readonly district: string }
export type CallerKind = 'citizen' | 'anonymous' | 'alarm' | 'business' | 'officer';
export interface CallerInfo { readonly kind: CallerKind; readonly name: string; readonly phone: string; readonly personId: number }
export interface NarrativeEntry { readonly sim: number; readonly game: number; readonly source: string; readonly text: string }
export type CallStatus = 'pending' | 'active' | 'closed';
export interface CadCall { readonly id: number; readonly number: string; readonly typeId: string; priority: Priority; readonly nature: string;
  readonly location: CadLocation; readonly caller: CallerInfo; readonly narrative: NarrativeEntry[]; status: CallStatus;
  units: string[]; primary: string | null; offeredTo: string | null; offerExpires: number;
  readonly created: CadTime; dispatched: CadTime | null; firstOnScene: CadTime | null; closed: CadTime | null;
  disposition: string | null; readonly selfInitiated: boolean; persons: number[]; vehicles: number[]; documents: string[] }
export interface CadUnit { readonly callsign: string; readonly kind: 'player' | 'ai'; readonly officer: string; readonly beat: string;
  readonly fleetIndex: number; status: UnitStatus; callId: number | null; statusSince: CadTime; x: number; z: number; emergency: boolean }
export type StopAction = 'license' | 'vin' | 'warn' | 'release' | 'arrest';
export type UnitRequest =
  | { readonly kind: 'status'; readonly status: UnitStatus }
  | { readonly kind: 'acceptCall'; readonly callId: number }
  | { readonly kind: 'declineCall'; readonly callId: number }
  | { readonly kind: 'selfAssign'; readonly callId: number }
  | { readonly kind: 'clearCall'; readonly callId: number; readonly disposition: string }
  | { readonly kind: 'narrative'; readonly callId: number; readonly text: string }
  | { readonly kind: 'runPlate'; readonly plate: string; readonly vehicleId: number }   // vehicleId -1 when typed
  | { readonly kind: 'runPerson'; readonly personId: number }
  | { readonly kind: 'backup'; readonly code: 2 | 3 }
  | { readonly kind: 'location' }
  | { readonly kind: 'code4' }
  | { readonly kind: 'emergency' }
  | { readonly kind: 'trafficStop' }                      // announce/confirm the current stop
  | { readonly kind: 'stopContact'; readonly action: StopAction }
  | { readonly kind: 'repeat' };
export interface PlateReadback { readonly plate: string; readonly found: boolean; readonly description: string; readonly owner: string;
  readonly ownerPersonId: number; readonly hits: readonly string[]; readonly severity: 'clear' | 'caution' | 'alert' }
export interface PersonReadback { readonly personId: number; readonly name: string; readonly dob: string; readonly dl: string;
  readonly dlStatus: string; readonly hits: readonly string[]; readonly severity: 'clear' | 'caution' | 'alert' }
export interface TrafficStopInfo { callId: number; readonly vehicleId: number; readonly plate: string; x: number; z: number;
  readonly started: CadTime; driverId: number /* -1 until 'license' */; readonly trueDriverId: number; plateRun: boolean;
  vinChecked: boolean; vinResult: string; citations: string[]; outcome: 'active' | 'released' | 'arrest' | 'lost' }
```
`PlateReadback`/`PersonReadback` are structurally identical to records' `PlateSummary`/`PersonSummary`.

### 6.2 Tables (`data.ts`, `codes.ts`)
```ts
export interface CallType { readonly id: string; readonly label: string; readonly codeKey: string | null; readonly category: string; readonly generated: boolean;
  readonly weight: number; readonly priority: readonly [number, number, number, number]; readonly location: string;
  readonly districts: Readonly<Record<string, number>>; readonly units: readonly [number, number]; readonly onSceneS: readonly [number, number];
  readonly callers: Readonly<Partial<Record<CallerKind, number>>>; readonly narratives: readonly string[];
  readonly fill: Readonly<Record<string, readonly string[]>>; readonly dispositions: readonly string[] }
export const CALL_TYPES: readonly CallType[]; export function callType(id: string): CallType;   // throws on unknown
export interface Statute { readonly id: string; readonly title: string; readonly category: 'traffic' | 'criminal'; readonly cls: 'infraction' | 'misdemeanor' | 'felony' | 'warrant';
  readonly fine: number; readonly citeable: boolean; readonly bookable: boolean; readonly speed: boolean }
export const STATUTES: readonly Statute[]; export function statute(id: string): Statute;
export function statuteForViolation(kind: string): Statute | null; export function statuteForPlateIssue(issue: 'expired' | 'uninsured' | 'cloned' | 'stolen'): Statute | null;
export const DISPOSITIONS: readonly { readonly id: string; readonly label: string }[];
export function codeText(key: string, mode: RadioMode): string;     // "10-8" | "in service"; throws on unknown key
export function statusText(status: UnitStatus, mode: RadioMode): string;
export function statusLabel(status: UnitStatus): string;            // "10-8 AVAILABLE" style for UIs
```

### 6.3 Addresses (`address.ts`) — the only address formatter in the game
Block numbers count away from the city centre: a north-south street numbers by `|z|` with prefix `N`
(z < 0) / `S`, an east-west street by `|x|` with `E`/`W`; `number = 100 * floor(d / metresPerHundred) +
2 * floor(frac * 49) + (side === -1 ? 1 : 0)`. Highways and county roads get no prefix. The cross
street is the differently named street at the nearest junction along the edge (else the other end);
`near` = `"Oak Street at 5th Street"` within `intersectionRadius` of that junction, else
`"1200 block of N Oak Street"`.
```ts
export interface Address { readonly edge: number; readonly s: number; readonly number: number; readonly street: string; readonly cross: string;
  readonly district: string; readonly text: string /* "1240 N Oak Street" */; readonly near: string }
export function addressAt(graph: RoadGraph, x: number, z: number, districtOf?: (x: number, z: number) => string, maxDistance?: number): Address | null;
export function addressOnEdge(graph: RoadGraph, edge: number, s: number, districtOf?: (x: number, z: number) => string): Address;
export function locationOf(graph: RoadGraph, x: number, z: number, districtOf?: (x: number, z: number) => string): CadLocation | null;
```

### 6.4 State (`cadState.ts`) and documents (`documents.ts`)
```ts
export interface NewCall { readonly typeId: string; readonly priority: Priority; readonly location: CadLocation; readonly caller: CallerInfo;
  readonly narrative: string; readonly selfInitiated?: boolean; readonly persons?: readonly number[]; readonly vehicles?: readonly number[] }
export interface NewUnit { readonly callsign: string; readonly kind: 'player' | 'ai'; readonly officer: string; readonly beat: string; readonly fleetIndex: number }
export class CadState {
  constructor(bus?: EventBus<EventMap>);
  readonly revision: number;            // bumps on every change except AVL (UI throttling)
  readonly avlRevision: number;         // bumps on setUnitPosition
  readonly docs: DocumentStore;
  readonly trafficStop: TrafficStopInfo | null;
  addUnit(u: NewUnit, t: CadTime): CadUnit;
  unit(callsign: string): CadUnit | null; units(): readonly CadUnit[]; playerUnit(): CadUnit | null;
  createCall(c: NewCall, t: CadTime): CadCall;                      // pending; emits cad:callCreated
  call(id: number): CadCall | null; calls(): readonly CadCall[];
  openCalls(): CadCall[];                                           // pending + active: P1 first, then oldest
  addNarrative(callId: number, source: string, text: string, t: CadTime): void;
  setPriority(callId: number, p: Priority, t: CadTime): void;
  offer(callId: number, callsign: string | null, expiresSim: number, t: CadTime): void;
  assign(callId: number, callsign: string, t: CadTime, by: 'dispatch' | 'self' | 'backup'): void;   // unit leaves its previous call; status enRoute
  unassign(callsign: string, t: CadTime): void;                     // a call left with no units goes back to pending
  setUnitStatus(callsign: string, status: UnitStatus, t: CadTime, via: RequestVia): boolean;        // false = transition refused
  closeCall(callId: number, disposition: string, t: CadTime): void; // unassigns everyone; units -> available
  setUnitPosition(callsign: string, x: number, z: number): void;
  setEmergency(callsign: string, on: boolean, t: CadTime): void;
  setTrafficStop(info: TrafficStopInfo | null, t: CadTime): void;
  updateTrafficStop(patch: Partial<TrafficStopInfo>, t: CadTime): void;
  serialize(): CadSave; restore(save: CadSave): void;
}
export function emptyCadSave(): CadSave; export function isCadSave(x: unknown): x is CadSave;
export const MAX_CLOSED_CALLS = 200;   // older closed calls are dropped from state and saves (documents are kept)
```
Transitions (others refused): available → enRoute/onScene/busy/outOfService; enRoute → onScene/available/busy;
onScene → busy/transporting/available/enRoute; busy → available/onScene/enRoute/transporting;
transporting → available/onScene/busy; outOfService → available. Every status change emits
`cad:unitStatus` with `via`.

Documents (all ids per §2, timestamps `CadTime`, `author` "Officer Doe #4071"):
```ts
export type DocKind = 'report' | 'citation' | 'booking' | 'evidence' | 'supplement';
export interface DocBase { readonly id: string; readonly kind: DocKind; readonly created: CadTime; updated: CadTime; readonly author: string; callId: number | null; status: 'draft' | 'final' }
export interface IncidentReport extends DocBase { kind: 'report'; title: string; offenseIds: string[]; location: string; occurredGame: number;
  persons: { personId: number; role: 'victim' | 'suspect' | 'witness' | 'reportingParty' | 'involved' }[];
  vehicles: { vehicleId: number; plate: string; role: string }[]; narrative: string; evidenceIds: string[] }
export interface Citation extends DocBase { kind: 'citation'; personId: number; vehicleId: number; plate: string; location: string;
  violations: { statuteId: string; fine: number; detail: string }[]; totalFine: number; recordedSpeedMph: number | null; limitMph: number | null; notes: string }
export interface Booking extends DocBase { kind: 'booking'; personId: number; charges: string[]; arrestedGame: number; arrestLocation: string; property: string; notes: string }
export interface EvidenceItem extends DocBase { kind: 'evidence'; description: string; category: 'property' | 'drugs' | 'weapon' | 'document' | 'digital' | 'other';
  foundAt: string; custody: { game: number; action: 'collected' | 'transferred' | 'booked' | 'released'; by: string; note: string }[] }
export interface Supplement extends DocBase { kind: 'supplement'; parentId: string; narrative: string }
export type CadDocument = IncidentReport | Citation | Booking | EvidenceItem | Supplement;
export class DocumentStore {
  create<K extends DocKind>(kind: K, fields: DraftFields<K>, t: CadTime, author: string): Extract<CadDocument, { kind: K }>;  // status draft
  update(id: string, patch: Partial<DraftFields<DocKind>>, t: CadTime): CadDocument;   // drafts only (throws on final)
  finalize(id: string, t: CadTime): CadDocument;   // throws DocumentValidationError(messages) when invalid
  addCustody(evidenceId: string, entry: EvidenceItem['custody'][number], t: CadTime): void;   // append-only, also after final
  get(id: string): CadDocument | null; list(kind?: DocKind): readonly CadDocument[]; byCall(callId: number): CadDocument[];
}
export function validateDocument(doc: CadDocument): string[];   // [] when valid; e.g. "Citation needs at least one violation"
export function citationTotal(violations: readonly { fine: number }[]): number;
```
Every create/update/finalize/custody change emits `cad:documentSaved { id, kind, final }`. Citations
are finalized when issued (immutable); a report gets supplements after it is final.

`createCadCommands(deps: { cad(): CadState | null })`: `calls`, `call <id>`, `units`, `docs [kind]`.

## 7. Traffic: stops, yielding, fleet cars, targeting [traffic] (`src/traffic/**`)

`registry.ts` is **frozen** (records depends on its draws, plates and ids). All additions are
allocation-free per step, keep every Phase 1 test green, and keep the snapshot exact.

### 7.1 Curb offset (shared by pull-over, yield and fleet parking)
New SoA `shoulder` (current lateral offset to the right, m) and `pull` phase per slot:
`PULL = { none: 0, pulling: 1, stopped: 2, merging: 3, yielding: 4, parking: 5, parked: 6 }`.
Target offset for a car on lane index `i` of its edge: `(i + 0.5) * laneWidth + halfWidth + clearance`
(the body just clear of the lane, on the shoulder or half on the sidewalk). The offset moves at
`lateralSpeed` m/s; `pose` adds it to the DUI weave. While pulling the car brakes to a stop at
`curb.decel` with a virtual stopped leader; on the last 30 m before a stop line it continues through
the junction and pulls over on the next lane. A car whose body is clear of its lane is **skipped as a
leader** by cars behind it on that lane (and as "first car on the next lane"), so traffic and units
pass it. Stopped pulled-over cars are `TRAFFIC_STATE.parked` with hazards (`LIGHT.hazard`).

### 7.2 Traffic stops
`TrafficFocus` gains optional `heading?: number` (yaw of the player car), `lights?: boolean` (player car
light bar on) and `siren?: boolean`. With `lights`, the nearest ambient car ahead in the same direction
(`detect` window: 3-35 m ahead, |lateral| < 2.5 m, heading dot > 0.8) that stays the candidate for
`delayS` becomes the **stop target**: it emits `traffic:pullingOver`, pulls to the curb, stops, emits
`traffic:pulledOver` and is pinned (never despawned) while stopped. `releaseStop()` merges it back
(`traffic:released { reason: 'released' }`); `abandonStop()` (arrest) leaves it parked with hazards,
unpinned, despawning normally (`reason: 'abandoned'`); a focus more than `autoReleaseM` away releases
it (`reason: 'lost'`). One stop target at a time; fleet cars are never stop targets.

### 7.3 Yielding
Emergency sources: the focus with `lights && siren`, and fleet cars in `emergency` urgency. An ambient
car within `yield.range` ahead of a source along the source's heading (|lateral| < `yield.lateral`,
same direction) moves to the curb and slows to a stop (`PULL.yielding`), then merges back once the
source is `passMargin` ahead of it, farther than 80 m, or after `timeoutS`.

### 7.4 Fleet cars (AI police units)
Fleet car `index` (0..`maxCars`-1) has vehicle id `FLEET_ID_BASE + index`, an explicit model/colour,
is never despawned by distance (excluded from the density target and the despawn tick), is never put
in `crashed` (a collision still emits `traffic:collision`), is excluded from stop/yield targeting, and
gets kinematic proxies near the focus like any car. `clear()` (teleport, `traffic clear`) removes
**ambient cars only**; fleet cars go with `removeFleetCar`, `restore` and `dispose`.
- **Patrol**: wanders like traffic (random exits) at `patrolFactor` x limit.
- **Destination** (`setFleetDestination`): the traffic module snaps the point to its nearest edge,
  runs `graph.findRoute` from the car's lane end node to that edge's `from` (and `to` when two-way),
  keeps the cheaper, and follows it (next lane chosen from the route at each lane change; recomputed
  if it ever cannot be followed; one-way rules always obeyed). `respond` drives at `respondFactor`;
  `emergency` at `emergencyFactor` (≤ `maxEmergencySpeed`) with `LIGHT.lightbar` on, treating red
  signals and stop signs as yields (slow to `crossSpeed`, go when no other approach holds the node).
  Arrival = within `arriveDistance` of the point or past it on the destination edge: the car parks at
  the curb (`PULL.parking` → `parked`) and emits `traffic:fleetArrived`; an emergency arrival keeps
  its light bar on (scene lights).
- `setFleetPatrol` leaves the curb (merge) and wanders again.

### 7.5 API
```ts
export const FLEET_ID_BASE = 1 << 20;
export function isFleetVehicleId(id: number): boolean;
export const PULL: { readonly none: 0; readonly pulling: 1; readonly stopped: 2; readonly merging: 3; readonly yielding: 4; readonly parking: 5; readonly parked: 6 };
export type FleetUrgency = 'respond' | 'emergency';
export interface FleetLook { readonly modelIndex: number; readonly color: number }
export interface FleetState { eid: number; x: number; z: number; yaw: number; speed: number; edge: number;
  mode: 'patrol' | FleetUrgency; arrived: boolean; parked: boolean; routeLeftM: number /* -1 without a route */ }
export interface StopState { vehicleId: number; eid: number; phase: 'pulling' | 'stopped' | 'merging'; x: number; z: number; yaw: number }
// TrafficView gains: readonly model: Uint8Array (VehicleModel.index per slot).
class TrafficSystem {
  // stops
  readonly stopVehicleId: number;                          // -1 none
  stopState(out: StopState): StopState | null;
  releaseStop(): boolean; abandonStop(): boolean;
  // fleet
  spawnFleetCar(index: number, x: number, z: number, look: FleetLook): number;   // entity id; 0 when no lane fits within 200 m
  removeFleetCar(index: number): void;
  fleetEntity(index: number): number;                      // 0 when absent
  setFleetDestination(index: number, x: number, z: number, urgency: FleetUrgency): boolean;   // false: unreachable
  setFleetPatrol(index: number): void;
  fleetState(index: number, out: FleetState): FleetState | null;
}
// pick.ts — target lock (pure, allocation-free): 2D ray (camera position + forward projected on XZ) vs every
// ambient car's oriented box inflated by `assist` m; fleet cars skipped; nearest hit within maxDistance.
export interface PickResult { slot: number; vehicleId: number; eid: number; distance: number }
export function pickTrafficCar(view: TrafficView, ox: number, oz: number, dx: number, dz: number, maxDistance: number, assist: number, out: PickResult): PickResult | null;
export function createTrafficCommands(deps: { traffic(): TrafficSystem | null; playerPosition(): { x: number; z: number } | null }): Command[]; // pullover, fleet
```
Snapshot: `TrafficCarSave` gains optional fields `model`, `color` (fleet look), `fleet` (index),
`route` (edge ids), `routePos`, `destX`, `destZ`, `urgency` (0 patrol, 1 respond, 2 emergency), `pull`,
`shoulder`, `pullTimer`, `pinned`; `TrafficSnapshot` gains optional `stopVehicleId`, `stopCandidate`,
`stopTimer`. `isTrafficSnapshot` validates them when present; a Phase 1 snapshot still restores.

## 8. Dispatch [dispatch] (`src/dispatch/**`)

The dispatcher brain: call generation, assignment, AI unit behaviour, offers, backup, emergency,
status checks, traffic-stop context, plate/person runs, and keeping `CadState` (statuses, AVL) and
records in step. Bus handlers only enqueue; all work happens in `step` (deterministic).

- **Generator**: a Poisson process in sim time with mean `meanIntervalS`, scaled by
  `crimeWeight(category, hour, weekday, district) / crimeReferenceRate` (Phase 1 crime table); first
  call after `firstCallDelayS`; at most `maxOpenCalls` open. Type by weight x district multiplier;
  location `nearPlayerShare` within `nearRadiusM` of the player (never within `minDistanceM`), else
  anywhere on land; `road` = random edge point, `block` = a lots block snapped to its nearest edge,
  `intersection` = a junction node, `poi:<kind>` = that POI's entrance; address via `locationOf`.
  Caller: a random person (citizen: name + phone from records) / anonymous / alarm centre. Narrative
  template filled from `fill`, address parts and (for `{plate}`/`{vehicle}`) a random registry vehicle.
- **Assignment**: pending calls in priority order. If the player unit is available, in a police
  vehicle and within `offer.radiusM`, the call is **offered** to the player first (`dispatch:offer`);
  declined or `offer.timeoutS` without an answer goes to AI units. AI: nearest available unit by
  straight-line distance (≤ `assign.maxDistanceM`; P1 gets `p1Units`); P1/P2 respond `emergency`,
  P3/P4 `respond`.
- **AI unit FSM** (one per fleet car): `patrol` (CAD available, wanders, returns toward its beat centre
  when farther than `beatRadiusM`) → `enRoute` (destination set) → `onScene` (on `traffic:fleetArrived`
  or `forceArriveS`; on-scene timer from the call type) → close the call (if no player is assigned)
  with a disposition from the type → `patrol`. Stuck (`speed < 0.5` for `stuckS`) re-plans once.
  Occasional `outOfService` breaks (at most one unit at a time). AVL: unit positions into
  `CadState.setUnitPosition` every `avlIntervalS`. Fleet cars get `PoliceLights` (attach if missing):
  pattern 0, siren `wail` while `emergency` and moving, off when parked.
- **Player requests** (`request`): `status` (with an offer pending, `enRoute` = accept), `acceptCall`,
  `declineCall`, `selfAssign`, `clearCall` (closes when the player is the last unit; ends an active
  traffic stop: releases the car), `narrative`, `runPlate` (records `runPlate` with the observed
  vehicle when `vehicleId ≥ 0` → `dispatch:plateResult`), `runPerson`, `backup` (nearest 1 / 2 units,
  pre-empting P3/P4 assignments; destination follows the player every `retargetS` when moved more than
  `retargetMoveM`; `dispatch:backup`, `noUnits` when none), `location` (answers with the player's
  address `near` text: `dispatch:location { asked: false }`), `code4` (acknowledges a status check, ends an
  emergency, releases backup units), `emergency` (emergency flag, `officerEmergency` P1 call at the
  player, `emergency.units` nearest units code 3, `dispatch:emergency { active: true }`), `trafficStop`,
  `stopContact` (§8.1). Each processed request emits `dispatch:ack` (except where a richer event says it).
- **Status checks**: while the player unit is `onScene`/`busy` for `afterS` since the status change or
  the last answer, `dispatch:statusCheck { attempt: 1 }`; no answer (any player request counts) within
  `responseS` → attempt 2, which also asks for the unit's 10-20 (`dispatch:location { asked: true }`;
  a `location` request answers it); again → escalation: `officerWelfare` P1 call at the player's last
  AVL position, `escalateUnits` units code 3, `dispatch:statusCheck { escalated: true }`.
- **Refusals**: a request that cannot be honoured (no offer pending, no stop, unknown call, refused
  status transition, no units free) emits `dispatch:ack { ok: false, text }` with a short reason.
- **Records upkeep**: on `cad:documentSaved` final citation → `records.addContact(person, citation)`;
  final booking → contact `arrest` + `serveWarrant` for every active warrant when a charge is `PC-220`.

### 8.1 Traffic stops
On `traffic:pulledOver` the dispatcher creates a self-initiated `trafficStop` call at the car, assigns
the player (status `onScene`, `via: 'auto'`), stores `TrafficStopInfo` in `CadState` (mounted plate,
`trueDriverId = driverOf(...)`), and emits `cad:trafficStop { active: true }` (the radio voices the
player's call-out and the dispatcher's acknowledgement). `stopContact` actions: `license` sets
`driverId` (person added to the call; a `none` licence still identifies the person) and runs a wants
check (`dispatch:personResult`); `vin` runs `records.runVin(vinOf(vehicle))` into `vinResult`;
`warn` records a warning contact; `release` → `traffic.releaseStop()`, outcome `released`, the call
closes with `citationIssued`/`warningIssued`/`handled`; `arrest` → `traffic.abandonStop()`, outcome
`arrest`, emits `dispatch:arrest { personId }` (the session seats the prisoner) and the call stays
open until the player clears it. `traffic:released { reason: 'lost' }` ends the stop with outcome `lost`.

### 8.2 API
```ts
export interface PlayerUnitState { x: number; z: number; speed: number; inPoliceVehicle: boolean }
export interface DispatchDeps { readonly seed: number; readonly city: City; readonly cad: CadState; readonly records: RecordsDb;
  readonly traffic: TrafficSystem; readonly world: GameWorld; readonly bus: EventBus<EventMap>; readonly rng: Rng }   // rng = session.rng.stream('dispatch')
export class Dispatcher {
  constructor(deps: DispatchDeps);
  readonly playerCallsign: string;
  start(t: CadTime, player: PlayerUnitState): void;   // roster -> CAD, fleet cars spawned at their beats (call before traffic populate)
  step(dt: number, t: CadTime, player: PlayerUnitState): void;      // fixed step, order -700
  request(callsign: string, r: UnitRequest, via: RequestVia): void; // queued; 'unit:request' bus events are queued the same way
  createCall(typeId: string, t: CadTime, at?: { x: number; z: number }): CadCall | null;   // debug/tests
  playerDestination(out: { x: number; z: number }): boolean;        // assigned call or backup target
  readonly stats: { readonly generated: number; readonly open: number; readonly aiBusy: number };
  serialize(): DispatchSave; restore(save: DispatchSave): void;     // after CadState and traffic were restored
  dispose(): void;
}
export function isDispatchSave(x: unknown): x is DispatchSave;
export function createDispatchCommands(deps: { dispatcher(): Dispatcher | null; now(): CadTime | null; playerPosition(): { x: number; z: number } | null }): Command[];
// dispatch call <type> [here], dispatch backup <2|3>, dispatch emergency, dispatch stats, dispatch units
```

## 9. Radio [radio] (`src/radio/**`)

### 9.1 Channels and the player's radio
Six channels (§4.7). The player's radio has a **selected** channel (transmit + priority listen), a
**scan** toggle and a scan list; audible = selected, or scanning and in the scan list. Player requests
are transmitted on the selected channel; only a channel with `requests: true` (dispatch) acts on them,
others answer `wrongChannel` (from that channel's dispatcher, if any). The emergency button works on
any channel.

### 9.2 Transmissions and scheduling (`RadioNet`)
A transmission has an id, channel, speaker (callsign / dispatcher name), speaker kind, display text,
spoken text, start (sim s), duration = `keyUpS + words / wordsPerSecond + tailS`, kind, priority,
blocked flag and game clock. `queue()` starts it at its earliest time when the channel is clear (or
immediately when `waitClear` is false: ambient double keys with `doubleKeyChance`, the player's own
keying). **Stepped-on**: a transmission starting while another is active on the same channel marks both
`blocked` (`radio:blocked`); a blocked player transmission is not acted on and the dispatcher answers
`blocked` ("unit transmitting, you were blocked, say again"). **Emergency hold**: `hold(channel)` lets
only priority transmissions start there until released. Queue ≤ 32 (oldest ambient dropped), log of the
last `logSize` transmissions with their audibility at start.

### 9.3 Composition (`compose.ts`) and ambient traffic (`ambient.ts`)
The composer subscribes to `cad:*`, `dispatch:*`, `traffic:pullingOver` and queues text from
`phrases.json` in the current mode (`mode()` reads the setting at compose time): dispatcher assignment
+ unit acknowledgement (2-3 s later), AI unit status changes (`via: 'auto'`) + dispatcher ack (50 %),
offers, plate/person readbacks (alert tone first on hits), backup and emergency broadcasts (priority
tone, hold the dispatch channel, release on `active: false`), status checks (repeat, escalation),
location answers, traffic-stop call-out + ack. `repeat` re-queues the last dispatcher transmission to
the player. **Voicing rule**: answers to player requests made by radio or voice are spoken; answers to
requests made with `via` `mdt`, `key` or `auto` are silent (MDT/HUD only), except offers, backup,
emergency, status checks and the traffic-stop call-out, which are always on the air.

Ambient chatter per channel is a Poisson process (`ambientPerMin`, suppressed by holds) filling
`ambient.json` templates with random units, registry plates (`plateOf`) and addresses; it uses
`session.rng.stream('radio')` only.

### 9.4 Spoken text (`spoken.ts`)
`toSpoken(text)`: ten-codes `10-8` → "ten eight", `Code 4` → "code four", `P2` → "priority two",
plates `ABC 1234` → "Adam, Boy, Charles, one two three four" (phonetic table), callsign digits as
numbers; everything else unchanged. Display text keeps codes.

### 9.5 Commands: voice grammar and radio menu
`parseVoiceCommand(text, ctx)` normalises (lower case, number words ↔ digits, punctuation removed)
and matches synonyms from `commands.json`: `show me 10-8 | in service | available` → status available,
`show me en route` (accept when an offer is pending), `show me on scene | 10-23`, `show me busy | 10-6`,
`show me out of service | 10-7`, `run plate <plate>` (letters as letters or phonetic words, digits as
digits or words; falls back to the target/stop plate when none is spoken), `requesting backup code
2|3` (`need backup` = code 2), `ten-twenty | 10-20 | location | what's my twenty`, `code 4 | all ok`,
`traffic stop`, `say again | repeat`, `accept`, `decline`; anything else → null. The radio menu (number
keys) offers the same requests:
```
1 Status ▸ 1 In service (10-8)  2 En route (10-76)  3 On scene (10-23)  4 Busy (10-6)  5 Out of service (10-7)  6 Transporting (10-15)
2 Run plate (target / stopped vehicle)   3 Location (10-20)   4 Backup ▸ 1 Code 2  2 Code 3   5 Code 4
6 Traffic stop   7 Accept offered call   8 Decline offered call   9 Say again (10-9)
```
Labels follow the radio mode; options that do not apply are disabled.

### 9.6 Presentation (`player.ts`, `controller.ts`)
`RadioPlayer` (per frame, presentation only) plays audible transmissions: `RadioFx.keyUp` →
`SpeechOut.speak(spoken, voiceProfileFor(speaker, kind))` → `squelchTail` at the end; scanned channels
at `scanVolume`; at most one utterance pending (a new selected-channel transmission cancels a scanned
one; otherwise the newer one is subtitle-only); blocked → `speech.cancel()` + `heterodyne(overlap)`;
priority → `priorityTone`; game paused → speech paused. Without TTS everything still appears in the
log/subtitles. `RadioController` (per frame, only while gameplay controls are active) maps actions:
`radio.menu`, `radio.option1..9`, `radio.ptt` (hold: `SpeechIn.start/stop`, result → parse → player
request; "say again" hint on no match), `radio.emergency` (hold 1.2 s), `radio.channelPrev/Next`,
`radio.scan`.

### 9.7 API
```ts
export type ChannelId = 'dispatch' | 'tac' | 'car' | 'fireEms' | 'county' | 'state';
export type SpeakerKind = 'dispatcher' | 'officer' | 'agency' | 'player';
export interface Transmission { readonly id: number; readonly channel: ChannelId; readonly speaker: string; readonly speakerKind: SpeakerKind;
  readonly text: string; readonly spoken: string; readonly start: number; readonly duration: number; blocked: boolean;
  readonly priority: boolean; readonly kind: string; readonly clock: string; readonly audible: boolean }
export interface RadioDeps { readonly seed: number; readonly rng: Rng; readonly bus: EventBus<EventMap>; readonly cad: CadState; readonly graph: RoadGraph;
  readonly playerCallsign: string; mode(): RadioMode }
export class RadioSystem {
  constructor(deps: RadioDeps);
  step(dt: number, t: CadTime, player: { x: number; z: number }): void;   // fixed step, order -650
  playerRequest(request: UnitRequest, via: 'radio' | 'voice' | 'key'): void; // player's transmission; unit:request when it ends unblocked
  emergencyButton(): void;                                                    // immediate unit:request {emergency} + priority traffic
  selectChannel(id: ChannelId): void; stepChannel(dir: 1 | -1): void; toggleScan(): void;
  readonly selected: ChannelId; readonly scanning: boolean; readonly scanList: readonly ChannelId[];
  readonly busy: boolean;           // selected channel has an active transmission (menu shows BUSY)
  readonly transmitting: boolean;   // player is keyed up
  readonly log: readonly Transmission[];
  readonly menu: RadioMenu;
  serialize(): RadioSave; restore(save: RadioSave): void; dispose(): void;
}
export class RadioMenu { readonly isOpen: boolean; open(): void; close(): void; back(): void;
  view(ctx: MenuContext): MenuView; press(key: number, ctx: MenuContext): UnitRequest | null }   // closes on a request
export interface MenuContext { readonly mode: RadioMode; readonly hasTarget: boolean; readonly hasStop: boolean; readonly pendingOffer: boolean;
  readonly onCall: boolean; readonly emergency: boolean }
export interface MenuView { readonly title: string; readonly options: readonly { readonly key: number; readonly label: string; readonly enabled: boolean }[] }
export function parseVoiceCommand(text: string, ctx?: { readonly fallbackPlate?: string }): UnitRequest | null;
export function toSpoken(text: string): string;
export class RadioPlayer { constructor(deps: { bus: EventBus<EventMap>; audio: AudioEngine; speech: SpeechOut; scanVolume?: number });
  setPaused(paused: boolean): void; dispose(): void }
export class RadioController { constructor(deps: { input: InputManager; radio: RadioSystem; speechIn: SpeechIn | null });
  update(dt: number, active: boolean, ctx: MenuContext & { readonly fallbackPlate: string | null }): RadioControllerState; dispose(): void }
export interface RadioControllerState { readonly menu: MenuView | null; readonly voice: 'off' | 'ready' | 'listening' | 'unavailable'; readonly hint: string | null; readonly emergencyCharge: number /* 0..1 */ }
export interface RadioSave { version: 1; selected: ChannelId; scanning: boolean; scanList: ChannelId[]; log: Transmission[];
  queue: QueuedTransmission[] /* module-defined plain data: pending transmissions incl. an attached player request */;
  nextId: number; holds: ChannelId[]; ambientNext: Partial<Record<ChannelId, number>>; rng: RngState; lastToPlayer: number }
export function defaultRadioSave(seedState: RngState): RadioSave; export function isRadioSave(x: unknown): x is RadioSave;
export function createRadioCommands(deps: { radio(): RadioSystem | null }): Command[];   // radio say <ch> <text>, radio channel <id>, radio scan, radio log
```

## 10. Audio and speech [audio] (`src/audio/**`, `src/speech/**`, `src/settings/settings.ts`)

### 10.1 Engine
One `AudioContext`, created lazily by `unlock()` from the first user gesture (a new context starts
`suspended`; browsers allow `resume()` after user activation). Graph: `master` gain ← `sfx` bus (sirens)
and `radio` bus (radio FX); volumes from settings (`audio.master`, `audio.sfx`, `audio.radio`). Without
`AudioContext` (node, old browsers) every call is a no-op and `available` is false. `suspend()`/`resume()`
follow the pause state.

### 10.2 Siren voices (positional)
A pool of `voices` (4) siren voices, each: main oscillator (`voice.wave`) whose `frequency` is the centre
`(low + high) / 2` plus an LFO (`OscillatorNode` of the tone's `shape` at `1 / periodS`, through a gain of
`(high - low) / 2`, connected to `frequency`, which mixes additively with the intrinsic value) →
lowpass → waveshaper (soft clip) → voice gain → `PannerNode` (`panningModel 'equalpower'`, distance
model/ref/rolloff/max from data) → sfx bus. Tone change = `setTargetAtTime` on LFO frequency/depth and
type swap. Air horn: two sawtooth oscillators gated by an attack/release envelope. Manual: LFO depth 0,
frequency ramps to `maxHz` over `riseS` while held and decays to `minHz` over `fallS` after release.
`SirenBank.update` picks the nearest `voices` emitters within `maxAudibleM` (pure `chooseNearest`),
reassigns voices without allocation, writes `positionX/Y/Z` and the listener (`positionX..`,
`forwardX..`, `upX..`) every frame; `inCabin` (the listener sits in that car) bypasses the panner
distance (gain `cabin.gain`, lowpass `cabin.lowpassHz`). Doppler is Phase 9.

### 10.3 Radio FX (non-positional, radio bus)
Noise from a 1 s buffer filled by a tiny deterministic LCG (no `Math.random`): `keyUp` (mic click 15 ms
+ 120 ms static), `squelchTail` (bandpassed noise burst, fast decay), `static(durationS, level)`,
`heterodyne(durationS)` (1000 Hz + 1037 Hz sines + noise), `priorityTone()` (6 x 125 ms alternating
1400/850 Hz), `alertTone('hit' | 'offer' | 'statusCheck')` (short beep patterns).

### 10.4 Speech output (TTS)
`SpeechOut` wraps `speechSynthesis`: voices load asynchronously (`getVoices()` may be empty until
`voiceschanged`); the pool is the English voices (`lang` starts with `en`), **local voices
(`localService`) preferred**, sorted by name for determinism; the dispatcher uses `audio.ttsVoice` when
it names an available voice; other speakers use `pool[profile.voiceIndex % pool.length]`; pitch and
rate from `voiceProfileFor(key, kind)` (hash of the speaker key: dispatcher pitch 0.95-1.1 / rate
1.05, officers pitch 0.8-1.2 / rate 0.95-1.15). Disabled (`audio.tts` off), unavailable, or no voices:
`speak` returns false and calls `onEnd` at once (subtitles only).

### 10.5 Speech input (voice commands)
TypeScript's DOM lib has the `SpeechRecognitionEvent/Result/Alternative` types but **not** the
`SpeechRecognition` constructor: `speech/recognition.ts` declares a minimal structural
`SpeechRecognitionLike` and finds `globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition`.
`continuous = false`, `interimResults = false`, `maxAlternatives = 3`, `lang = 'en-US'`; `start()` on
PTT down, `stop()` on PTT up; `result` → alternatives best first; `error`/`nomatch` reported; off unless
`audio.voiceCommands` is on (default **off**).

### 10.6 Verified browser facts
MDN (SpeechRecognition, Using the Web Speech API, SpeechSynthesis, PannerNode, AudioNode.connect) and
the W3C Web Audio 1.1 spec: Chromium exposes `webkitSpeechRecognition`; by default recognition is
server-based (audio is sent to a web service) unless `processLocally` is set and a language pack is
installed; `getVoices()` is filled asynchronously in Chromium; `PannerNode` defaults `equalpower`,
`inverse`, ref 1, max 10000, rolloff 1; inverse gain = `ref / (ref + rolloff * (max(d, ref) - ref))`;
connecting a node to an `AudioParam` mixes it with the intrinsic value; a new `AudioContext` starts
`suspended`; `AudioListener` position/forward/up are `AudioParam`s (forward default (0, 0, -1)).

### 10.7 Settings (all in existing sections, so the settings menu shows them with no menu change)
| Path | Kind | Default | Notes |
|---|---|---|---|
| `audio.master`, `audio.sfx`, `audio.radio` | number 0..1 | 0.8, 1, 1 | now `implemented` |
| `audio.ttsVoice` | text, nullable | null | "Dispatcher voice", now `implemented` |
| `audio.tts` | boolean | true | "Spoken radio (text-to-speech)" |
| `audio.radioMode` | enum `tenCode` / `plain` | `tenCode` | "Radio language" |
| `audio.voiceCommands` | boolean | false | "Voice commands (push-to-talk, browser speech service)" |
| `accessibility.subtitles` | boolean | true | now `implemented`: caption line for the latest radio transmission (the radio log is always shown) |

`SETTINGS_VERSION` stays 1 (new fields are filled with defaults by `parseSettings`).

### 10.8 API
```ts
export type SirenToneName = 'wail' | 'yelp' | 'phaser' | 'hilo';
export interface AudioVolumes { master: number; sfx: number; radio: number }
export interface SirenEmitter { id: number; x: number; y: number; z: number; tone: SirenToneName | null; horn: boolean; manual: boolean; inCabin: boolean }
export class AudioEngine {
  constructor(options?: { contextFactory?: (() => AudioContext) | null });
  readonly available: boolean; readonly unlocked: boolean;
  unlock(): void; setVolumes(v: AudioVolumes): void; suspend(): void; resume(): void;
  setListener(x: number, y: number, z: number, fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
  readonly sirens: SirenBank; readonly radio: RadioFx;
  readonly stats: { voices: number; active: number };
  dispose(): void;
}
export class SirenBank { update(emitters: readonly SirenEmitter[], count: number, listenerX: number, listenerZ: number): void }
export class RadioFx { keyUp(): void; squelchTail(): void; static(durationS: number, level: number): void; heterodyne(durationS: number): void;
  priorityTone(): void; alertTone(kind: 'hit' | 'offer' | 'statusCheck'): void }
// pure (math.ts)
export function sirenFrequency(tone: SirenToneName, t: number): number;                    // Hz at time t (matches the LFO shapes)
export function distanceGain(d: number, ref: number, rolloff: number, max: number): number; // Web Audio inverse model
export function chooseNearest(emitters: readonly SirenEmitter[], count: number, lx: number, lz: number, capacity: number, maxDist: number, out: Int32Array): number;
// speech
export interface VoiceProfile { readonly pitch: number; readonly rate: number; readonly voiceIndex: number }
export function voiceProfileFor(speakerKey: string, kind: 'dispatcher' | 'officer' | 'agency' | 'player'): VoiceProfile;
export class SpeechOut { constructor(options?: { synth?: SpeechSynthesisLike | null; utteranceFactory?: (text: string) => UtteranceLike });
  readonly available: boolean; enabled: boolean; preferredVoice: string | null; volume: number;
  speak(text: string, profile: VoiceProfile, options?: { dispatcher?: boolean; onEnd?: () => void }): boolean;
  cancel(): void; pause(): void; resume(): void; voiceNames(): readonly string[]; dispose(): void }
export class SpeechIn { constructor(options?: { factory?: (() => SpeechRecognitionLike) | null; lang?: string });
  readonly available: boolean; enabled: boolean; readonly listening: boolean;
  start(): boolean; stop(): void; onResult(fn: (alternatives: readonly { transcript: string; confidence: number }[]) => void): () => void;
  onError(fn: (code: string) => void): () => void; dispose(): void }
export function createAudioCommands(deps: { audio(): AudioEngine | null; speech(): SpeechOut | null }): Command[];   // voices, sirentest <tone|off>
```

## 11. Patrol car equipment [equipment] (`src/police/**`, `src/vehicles/{damage,model}.ts`, input)

### 11.1 Components
```ts
// src/police/components.ts — sized MAX_ENTITIES; attach resets the slot (ids are recycled)
export const PoliceLights: { pattern: Uint8Array; siren: Uint8Array /* 0 off, 1 + SIREN_TONES index */; sirenFlags: Uint8Array /* SIREN_FLAG */;
  spot: Uint8Array; spotYaw: Float32Array /* rad rel. heading, + = left */; spotPitch: Float32Array /* + = up */; phase: Float32Array /* s */ };
export const SIREN_FLAG: { readonly horn: 1; readonly manual: 2 };
export function attachPoliceLights(world: GameWorld, eid: EntityId, phase: number): void;
export function hasPoliceLights(world: GameWorld, eid: EntityId): boolean;
```

### 11.2 Light bar patterns (`lightbar.ts`)
```ts
export const LIGHTBAR_SEGMENTS = 8;
export const SEGMENT_COLOR: { readonly off: 0; readonly red: 1; readonly blue: 2; readonly white: 3; readonly amber: 4 };
export interface LightbarPattern { readonly id: string; readonly label: string; readonly frames: readonly { readonly colors: Uint8Array; readonly durationS: number }[]; readonly periodS: number }
export const LIGHTBAR_PATTERNS: readonly LightbarPattern[];          // data order; PoliceLights.pattern indexes it
export const REDUCED_FLASH: { readonly minFrameS: number; readonly level: number };
export function patternIndex(id: string): number;                    // -1 unknown
/** Segment colours at time t (allocation-free). With reducedFlash the pattern's clock is slowed so that its shortest frame
 *  lasts minFrameS (no segment toggles more than 3 times per second) and the caller dims by REDUCED_FLASH.level. */
export function lightbarColors(pattern: number, timeS: number, reducedFlash: boolean, out: Uint8Array): Uint8Array;
export function maxTogglesPerSecond(pattern: number, reducedFlash: boolean): number;   // test helper (photosensitivity rule)
```

### 11.3 Siren controller, spotlight, rack, trunk, cage (`equipment.ts`, `inventory.ts`)
```ts
export type SirenTone = 'wail' | 'yelp' | 'phaser' | 'hilo';   // defined here; identical union to audio's SirenToneName (no import)
export const SIREN_TONES: readonly SirenTone[];        // order from data/police/equipment.json (validated against the union)
export interface EquipmentSave { version: 1; sirenOn: boolean; tone: SirenTone; pattern: string /* pattern id, not index */;
  spotOn: boolean; spotYaw: number; spotPitch: number; rackLocked: boolean; racked: Record<string, boolean>;
  trunk: Record<string, number>; prisoner: number }
export interface OfficerKitSave { version: 1; carried: Record<string, number>; longGun: string | null }
export interface VehicleEquipmentSpec { readonly pushBumper: { readonly frontStrength: number; readonly engineShare: number } | null;
  readonly partition: boolean; readonly rack: boolean; readonly spotlight: boolean; readonly mdt: boolean; readonly trunk: string | null }
export interface TrunkItem { readonly id: string; readonly label: string; readonly carryMax: number; readonly deployable: boolean }
export const TRUNK_ITEMS: readonly TrunkItem[]; export const RACK_ITEMS: readonly { readonly id: string; readonly label: string }[];
export class OfficerKit { carried(itemId: string): number; readonly longGun: string | null; serialize(): OfficerKitSave; static restore(s: OfficerKitSave): OfficerKit }
export class PatrolEquipment {
  constructor(spec: VehicleEquipmentSpec);
  // siren
  readonly sirenOn: boolean; readonly tone: SirenTone; toggleSiren(): void; cycleTone(): void;
  horn: boolean; manual: boolean;                      // held this frame
  // lights (on/off stays DrivableVehicle.lightbar; the pattern lives here)
  readonly pattern: number; cyclePattern(): void; setPattern(index: number): void;
  // spotlight
  readonly spotOn: boolean; readonly spotYaw: number; readonly spotPitch: number; toggleSpot(): void; aimSpot(dYaw: number, dPitch: number): void;   // clamped
  // rack
  readonly rackLocked: boolean; rackHas(itemId: string): boolean;
  toggleRackLock(stopped: boolean): boolean;           // false when unlockRequiresStop and moving
  checkOut(itemId: string, kit: OfficerKit): boolean;  // unlocked, racked, kit has no long gun
  checkIn(itemId: string, kit: OfficerKit): boolean;
  // trunk
  trunkCount(itemId: string): number; take(itemId: string, kit: OfficerKit): boolean; stow(itemId: string, kit: OfficerKit): boolean;
  // cage
  readonly prisoner: number;                           // person id, -1 empty
  seatPrisoner(personId: number): boolean; releasePrisoner(): number;
  /** PoliceLights for this car's entity (every fixed step); `lightbarOn` = DrivableVehicle.lightbar. */
  writeLook(eid: EntityId, lightbarOn: boolean): void;
  serialize(): EquipmentSave; static restore(spec: VehicleEquipmentSpec, save: EquipmentSave): PatrolEquipment;
}
export function isEquipmentSave(x: unknown): x is EquipmentSave; export function isOfficerKitSave(x: unknown): x is OfficerKitSave;
export function emptyOfficerKit(): OfficerKitSave;
// controls.ts
export interface PoliceInput { toggleSiren: boolean; cycleTone: boolean; horn: boolean; manual: boolean; toggleLights: boolean;
  cyclePattern: boolean; toggleSpot: boolean; spotAim: boolean; equipmentPanel: boolean }
export function readPoliceInput(input: InputManager, out: PoliceInput): PoliceInput;
export function createPoliceCommands(deps: { equipment(): PatrolEquipment | null }): Command[];   // equip, pattern <id>, siren <tone|off>
```

### 11.4 Push bumper (damage model)
`DamageSpec` gains optional `frontZoneStrength` and `frontEngineShare`; `parseVehicleModel` sets them
to `zoneStrength * frontStrength` and `engineFrontShare * engineShare` when the model has a push
bumper. `applyImpact` uses them for front-zone hits (same impact → less front crumple, less engine
damage). `VehicleModel.equipment: VehicleEquipmentSpec | null` (null for every model without the JSON
section). `drivableVehicle.ts` is unchanged.

### 11.5 Input actions (owned here; defaults in `bindings.ts`)
| Action | Kind | Keyboard | Gamepad | Use |
|---|---|---|---|---|
| `vehicle.siren` (exists) | button | Q | Button3 | siren on/off |
| `vehicle.sirenTone` | button | R | Button4 | cycle wail → yelp → phaser → hi-lo |
| `vehicle.horn` | button | G | Button11 | air horn (hold) |
| `vehicle.manual` | button | F | - | manual wind-up (hold) |
| `vehicle.lights` (exists) | button | L | Button2 | light bar on/off |
| `vehicle.lightPattern` | button | K | - | next pattern |
| `vehicle.spotlight` | button | J | - | spotlight on/off |
| `vehicle.spotAim` | button | MouseButton2 | - | hold: mouse aims the spotlight |
| `vehicle.equipment` | button | X | - | equipment panel (rack, cage) |
| `mdt.toggle` | button | Tab | - | open the MDT |
| `target.runPlate` | button | P | Button15 | run the targeted / stopped car's plate (MDT query) |
| `radio.menu` | button | T | Button14 | radio menu |
| `radio.option1` .. `radio.option9` | button | Digit1 .. Digit9 | - | radio menu choices |
| `radio.ptt` | button | B | Button5 | push-to-talk (voice commands) |
| `radio.emergency` | button | Z | - | emergency button (hold 1.2 s) |
| `radio.channelPrev` / `radio.channelNext` | button | BracketLeft / BracketRight | - | channel |
| `radio.scan` | button | Backslash | - | scan on/off |

## 12. Rendering [policeRender] (`src/render/vehicles/**`, `src/render/police/**`)

- **Light bar**: `buildCarParts` replaces the two light-bar halves by `LIGHTBAR_SEGMENTS` lens boxes
  across the bar. `CarRenderer.update` colours them from `lightbarColors(PoliceLights.pattern[eid] (0
  without the component), timeSec + PoliceLights.phase[eid], reducedFlash)` when `LIGHT.lightbar` is
  set, dimmed by `REDUCED_FLASH.level` with reduced flash; unlit segments at 0.12 as today.
- **Push bumper**: models with `equipment.pushBumper` get a bumper frame (front, below the lamps) in a
  per-model `trim` instanced mesh (dark rubber material, +1 draw call per police model).
- **Spotlight**: one `THREE.SpotLight` (created at construction, intensity 0, no shadows: fixed light
  count, no shader recompiles) + its target, placed at the driver-side A-pillar of
  `setSpotlightTarget(eid)`'s car and aimed by `PoliceLights.spotYaw/spotPitch` relative to the car;
  on when `PoliceLights.spot[eid]`; angle 0.12 rad, penumbra 0.3, distance 160 m, decay 1.5, intensity
  300 x (0.3 + 0.7 night). A small emissive lens on the housing.
- **Cockpit interior** (`CockpitRenderer`): merged boxes in the vehicle frame (dash, console, steering
  wheel, laptop on a mount with a screen plane using a `CanvasTexture` of the MDT screen, radio head
  with a small canvas display (channel, TX/RX/SCAN/EMERG), siren controller with LED quads (tone,
  lights, horn), partition cage (bar grid), long-gun rack (bars + racked guns shown/hidden)); one group
  placed from the interpolated transform each frame; visible only in cockpit view of a police vehicle
  with `equipment` (≤ 6 draw calls).
- **MDT screen** (`MdtScreen`): paints a compact CAD summary (unit, status, clock, current call, top of
  the queue, offer/alert/stop lines) into a 512 x 320 canvas, at most 2 Hz and only when the model text
  changed (headless: no canvas, `paint` returns false).
```ts
export class CarRenderer { /* Phase 1 API plus */ setSpotlightTarget(eid: EntityId): void }
export interface CockpitState { readonly sirenOn: boolean; readonly tone: number /* SIREN_TONES index */; readonly horn: boolean; readonly lightsOn: boolean;
  readonly pattern: number; readonly spotOn: boolean; readonly rackLocked: boolean; readonly racked: readonly boolean[]; readonly caged: boolean;
  readonly radioChannel: string; readonly radioTx: boolean; readonly radioRx: boolean; readonly scanning: boolean; readonly emergency: boolean }
export class CockpitRenderer { constructor(scene: THREE.Scene);
  setVehicle(eid: EntityId, model: VehicleModel | null): void; setScreenSource(canvas: HTMLCanvasElement | null): void; markScreenDirty(): void;
  update(alpha: number, visible: boolean, state: CockpitState): void; readonly stats: { drawCalls: number }; dispose(): void }
export interface MdtScreenModel { readonly callsign: string; readonly status: string; readonly clock: string;
  readonly call: { readonly number: string; readonly priority: number; readonly nature: string; readonly address: string; readonly status: string } | null;
  readonly queue: readonly { readonly priority: number; readonly nature: string; readonly address: string }[];
  readonly offer: string | null; readonly alert: string | null; readonly stop: string | null }
export class MdtScreen { constructor(width?: number, height?: number); readonly canvas: HTMLCanvasElement | null; paint(model: MdtScreenModel, nowMs: number): boolean }
```

## 13. UI

### 13.1 Layout (DOM, `#ui`)
| Element | Owner | Place | Update |
|---|---|---|---|
| HUD (Phase 1) + police status line, unit status chip | hud | bottom-right panel | 10 Hz |
| Call strip (number, P, nature, address, status, distance) + offer line | hud | top-left | 10 Hz |
| Target reticle + plate/description/result | hud | screen centre | 10 Hz |
| Radio log (6 lines: time, channel tag, speaker, text, blocked/priority marks) + channel strip (CH, SCAN, TX/RX/BUSY, EMERG, mode, voice) | hud (`RadioPanel`) | left, above the minimap | on events + 4 Hz strip |
| Radio menu | hud (`RadioMenuView`) | left, above the log | on change |
| Caption line (latest audible transmission, when `accessibility.subtitles`) | hud | bottom-centre above the road name | on events |
| Minimap call/unit markers | hud | minimap | 10 Hz |
| Action panel (trunk, rack/equipment, driver contact) | hud (`ActionPanel`, a non-pausing `Menu`) | centre | on change |
| MDT overlay | mdt (`MdtOverlay`, a non-pausing `Menu`) | full screen (inset 2 %) | ≤ 4 Hz when CAD revision changed |

Non-pausing menus expose `readonly pausesGame = false`; the integrator's pause rule ignores them, so
the world keeps running while the MDT or a panel is open (the car coasts: gameplay controls are off
while any menu is open, as with the console).

### 13.2 MDT (`src/ui/mdt/**`)
Dark theme (`mdt.css`, palette variables from `styles.css`), monospace data grid, keyboard first:
tab bar (`role=tablist`, Left/Right, digits 1-9 when no text field has focus), Up/Down in lists, Enter
opens/submits, Escape cancels the form or closes the overlay. Tabs:
1. **Queue** — open calls: number, P (coloured), nature, address, status, units, age; selected call
   actions: Accept (offer), Self-assign, En route, On scene, Clear (disposition select).
2. **Call** — caller (name, phone, kind), location (address, cross street, district), timestamped
   narrative (+ add narrative), assigned units, linked documents, "Write report".
3. **Units** — roster: callsign, officer, status (10-code + label), call, location (`near` text), time
   in status; player status buttons (10-8, en route, on scene, busy, 10-7).
4. **Map** — AVL: road layer pre-rendered once per city into an offscreen canvas (by road class, from
   the road graph), dynamic layer ≤ 4 Hz: units (colour by status, emergency flashing slowly), calls
   (colour by priority), player; pan with arrows/drag, zoom with +/-/wheel, click/Enter selects.
5. **Person** — query by last/first/DOB/DL#, results, record (identity, DL, warrants, supervision, gang,
   mental health, officer safety, firearms, protective orders, priors; hits highlighted by severity),
   "Wants check" (radio-less).
6. **Vehicle** — query by plate or VIN, "Run target" / "Run stop vehicle"; registration, owner (link to
   person), hits (stolen, clone alert, mismatch with the observed car, expired, uninsured, flag, BOLO).
7. **BOLO** — today's bulletin + added BOLOs; query history.
8. **Reports** — list by kind (reports, citations, bookings, evidence, supplements); viewers; forms:
   incident report builder (title, offense statutes, location, time, persons with roles, vehicles,
   narrative, evidence links; save draft, finalize), citation writer (prefilled from the stop: driver,
   plate, vehicle, location, observed violations → statutes via `violationMap`, plate issues via
   `plateMap`, recorded speed; statute picker from citeable statutes, fines and total; issue = finalize),
   booking (prisoner prefilled, bookable charges, property, notes; "Complete booking" only at the station),
   evidence log (item, category, found at, custody entries), supplemental narrative (pick a report).
9. **Stop** — current traffic stop: plate, mounted-plate run results, vehicle, driver (after licence),
   VIN result, citations issued, actions (run plate, wants check, write citation, release).
```ts
export interface MdtDeps { readonly cad: CadState; readonly records: RecordsDb; readonly graph: RoadGraph; readonly callsign: string;
  officer(): { name: string; badge: string }; now(): CadTime; request(r: UnitRequest): void;
  target(): { vehicleId: number; plate: string; description: string } | null;
  observed(vehicleId: number): ObservedVehicle | null;   // records observedVehicle(seed, id) for registry ids, null otherwise
  observedViolations(vehicleId: number): Readonly<Partial<Record<string, number>>>;
  observedSpeed(vehicleId: number): { speedMph: number; limitMph: number } | null;
  prisoner(): number; atStation(): boolean; completeBooking(bookingId: string): void }
export type MdtTab = 'queue' | 'call' | 'units' | 'map' | 'person' | 'vehicle' | 'bolo' | 'reports' | 'stop';
export class MdtOverlay implements Menu { readonly id: 'mdt'; readonly element: HTMLElement; readonly pausesGame: false;
  constructor(ui: UIRoot | null, deps: MdtDeps); open(tab?: MdtTab): void; close(): void; readonly isOpen: boolean;
  update(nowMs: number): void; onKeyDown(event: KeyboardEvent): boolean; dispose(): void }
// pure helpers (tested): queueRows, callDetailLines, unitRows, personSections, vehicleSections, citationDraftFromStop,
// worldToMap/mapToWorld, tabFromKey
```
Records queries typed into the MDT call `RecordsDb` directly (they only add to the query log and the
touched set); everything that changes CAD calls/units goes through `request` (applied by the
dispatcher in its next step). Documents are written to `cad.docs` directly.

### 13.3 HUD and panels (`src/ui/hud/**`, `src/ui/panels/**`)
```ts
// HudSnapshot gains (all OPTIONAL so the Phase 1 hudFeed keeps compiling; absent = null / ''):
police?: { lights: boolean; pattern: string; siren: string /* '' off, 'WAIL' */; horn: boolean; spot: boolean } | null;
target?: { plate: string; description: string; result: string; severity: 'none' | 'clear' | 'caution' | 'alert' } | null;
call?: { number: string; priority: number; nature: string; address: string; status: string; distanceM: number } | null;
unit?: { callsign: string; status: string; emergency: boolean; statusCheck: boolean } | null;
offer?: string | null; carried?: string;
// Minimap.update(..., markers?: MinimapMarkers | null)
export interface MinimapMarkers { count: number; x: Float32Array; z: Float32Array; kind: Uint8Array }
export const MARKER: { readonly callP1: 1; readonly callP2: 2; readonly callP3: 3; readonly callP4: 4; readonly unitAvailable: 5; readonly unitBusy: 6; readonly unitEmergency: 7; readonly stop: 8 };
// panels
export interface PanelOption { readonly label: string; readonly detail?: string; readonly enabled?: boolean }
export interface ActionPanelModel { readonly title: string; readonly subtitle?: string; readonly options: readonly PanelOption[]; readonly footer?: string }
export class ActionPanel implements Menu { readonly id: 'action-panel'; readonly element: HTMLElement; readonly pausesGame: false;
  constructor(ui: UIRoot | null); open(model: ActionPanelModel, onSelect: (index: number) => void, onClose?: () => void): void;
  update(model: ActionPanelModel): void; close(): void; readonly isOpen: boolean; onKeyDown(event: KeyboardEvent): boolean }
export function panelKeyToIndex(key: string): number | null;   // '1'..'9' -> 0..8
export interface RadioLine { readonly id: number; readonly channel: string; readonly speaker: string; readonly text: string; readonly clock: string;
  readonly blocked: boolean; readonly priority: boolean; readonly self: boolean }
export interface RadioStatusView { readonly channel: string; readonly scanning: boolean; readonly tx: boolean; readonly rx: boolean; readonly busy: boolean;
  readonly emergency: boolean; readonly mode: string; readonly voice: 'off' | 'ready' | 'listening' | 'unavailable'; readonly emergencyCharge: number }
export class RadioPanel { constructor(parent: HTMLElement | null); addLine(line: RadioLine): void; markBlocked(id: number): void;
  setStatus(s: RadioStatusView, nowMs: number): void; setCaption(text: string | null, untilMs: number): void; update(nowMs: number): void;
  setVisible(v: boolean): void; readonly lines: readonly RadioLine[]; dispose(): void }
export class RadioMenuView { constructor(parent: HTMLElement | null); show(view: { title: string; options: readonly { key: number; label: string; enabled: boolean }[] } | null): void; dispose(): void }
```

### 13.4 Interactions (integrator, `src/game/**`)
New interact hints: `trunk` (on foot within 1.6 m of the rear centre of a patrol car → trunk panel:
take/stow per item, two-level), `driver` (on foot within 1.8 m of the driver window of the stopped car
→ contact panel: Request licence, Check VIN, Write citation (opens MDT citation), Warn and release,
Release, Arrest (enabled when the last patrol car is within 40 m and its cage is empty)). In a patrol car:
`X` opens the equipment panel (rack lock/unlock, check out/in shotgun and rifle, spotlight, prisoner).
The MDT opens with Tab in a patrol car or on foot within 3 m of its driver door.

## 14. ECS components and event topics

| Component | Owner / file | Fields |
|---|---|---|
| `PoliceLights` | [equipment] `src/police/components.ts` | `pattern`, `siren`, `sirenFlags`, `spot`, `spotYaw`, `spotPitch`, `phase` (§11.1); on player patrol cars (session) and fleet cars (dispatch) |

`src/ecs/components.ts` is unchanged. Topics are declared by declaration merging in each owner's
`events.ts`; payloads are emitted on rare events only:

| Topic | Owner | Payload |
|---|---|---|
| `cad:callCreated` | cad | `{ callId: number; typeId: string; priority: Priority; selfInitiated: boolean }` |
| `cad:callUpdated` | cad | `{ callId: number; change: 'narrative' \| 'priority' \| 'units' \| 'status' \| 'offer' }` |
| `cad:callClosed` | cad | `{ callId: number; disposition: string }` |
| `cad:unitAssigned` | cad | `{ callId: number; callsign: string; by: 'dispatch' \| 'self' \| 'backup' }` |
| `cad:unitStatus` | cad | `{ callsign: string; status: UnitStatus; prev: UnitStatus; callId: number \| null; via: RequestVia }` |
| `cad:documentSaved` | cad | `{ id: string; kind: DocKind; final: boolean }` |
| `cad:trafficStop` | cad | `{ active: boolean; callId: number; vehicleId: number }` |
| `unit:request` | cad (emitted by radio, integrator) | `{ callsign: string; request: UnitRequest; via: RequestVia }` |
| `dispatch:offer` | cad (emitted by dispatch) | `{ callId: number; callsign: string; expired: boolean }` |
| `dispatch:plateResult` | cad | `{ callsign: string; via: RequestVia; vehicleId: number; readback: PlateReadback }` |
| `dispatch:personResult` | cad | `{ callsign: string; via: RequestVia; readback: PersonReadback }` |
| `dispatch:backup` | cad | `{ requester: string; code: 2 \| 3; units: string[]; x: number; z: number; location: string }` |
| `dispatch:emergency` | cad | `{ callsign: string; active: boolean; units: string[]; location: string }` |
| `dispatch:statusCheck` | cad | `{ callsign: string; attempt: number; escalated: boolean; location: string }` |
| `dispatch:location` | cad | `{ callsign: string; text: string; asked: boolean }` |
| `dispatch:ack` | cad | `{ callsign: string; kind: UnitRequest['kind']; ok: boolean; text: string }` |
| `dispatch:arrest` | cad | `{ personId: number; callId: number }` |
| `traffic:pullingOver` / `traffic:pulledOver` | traffic | `{ eid; vehicleId }` / `{ eid; vehicleId; x; z; yaw }` |
| `traffic:released` | traffic | `{ eid: number; vehicleId: number; reason: 'released' \| 'abandoned' \| 'lost' }` |
| `traffic:fleetArrived` | traffic | `{ index: number; eid: number; x: number; z: number }` |
| `radio:start` / `radio:end` | radio | `{ tx: Readonly<Transmission> }` / `{ id: number; blocked: boolean }` |
| `radio:blocked` | radio | `{ ids: number[]; channel: ChannelId }` |
| `radio:channel` | radio | `{ selected: ChannelId; scanning: boolean }` |

The `dispatch:*` topics are declared in `src/cad/events.ts` (wave 1) so the radio and the integrator can
consume what the dispatcher emits without importing it.

## 15. Step order, frame order, determinism

| Order | System | Work |
|---|---|---|
| (before) | session `fixedUpdate` | time, clock, officer movement |
| -1000 | `copyPrevTransform` | |
| -900 | `environment` | |
| -800 | `colliders` | |
| **-700** | **`dispatch`** | queued requests, generator, assignment, AI FSMs (fleet state of the previous step), offers, status checks, AVL |
| **-650** | **`radio`** | composer queue → `RadioNet.step(simTime)`: start/end/overlap, ambient |
| 0 | `integrateVelocity` | |
| 40 | `vehicles.pre` | + `PatrolEquipment.writeLook` for every patrol car (PoliceLights) |
| 50 | `traffic` | focus with `heading`, `lights`, `siren`; stops, yield, fleet |
| 100 | `physics` | |
| 110 | `vehicles.post` | |

Per frame (App.update), after the Phase 1 order: police input (siren/lights/spot, spot aim suppresses
camera look) → radio controller (when gameplay controls are active) → target pick (10 Hz) → MDT/
panels update → `CarRenderer.update` (+ spotlight target) → cockpit renderer (cockpit view) + MDT
screen paint (≤ 2 Hz) → audio: listener from the camera, siren emitters from `PoliceLights` entities →
HUD/radio panel. Radio speech/FX and DOM never feed back. Requests from the UI are queued by the
dispatcher and applied in its next step. `test/game/session.test.ts` extends the scripted replay with
calls, AI units, a traffic stop and radio traffic and compares v4 saves bit for bit.

## 16. Workers

No new workers. Phase 2's heaviest work is one-off and small: the person name index (< 10 ms, lazily, on
the first name search), A* for an assignment (~1 ms, a few per minute), the MDT road-layer canvas (once
per city, ~30 ms on first open). Moving any of it to a worker would add RPC plumbing for no frame-time
gain, and the deterministic parts (dispatch, fleet, radio scheduling) must stay in the fixed step anyway
(Phase 1 §7.3 reasoning). `src/records/**` stays DOM/THREE-free so it can move into a worker later.
The Phase 0 sim worker and the chunk worker are unchanged.

## 17. Save schema v4 (integrator only)

```ts
interface SaveGameV4 extends SaveGameV3 {
  cad: CadSave;                       // calls (open + last 200 closed), units, documents, traffic stop, counters
  dispatch: DispatchSave | null;      // null: fresh roster/fleet at load (migrated saves)
  records: RecordsSave;               // touched snapshots, overlay, added BOLOs, query log
  radio: RadioSave;                   // channel, scan, scan list, log, queue, holds, rng
  equipment: (EquipmentSave | null)[];// same length/order as `vehicles`; null = not a patrol car (or defaults)
  officerKit: OfficerKitSave;         // carried trunk items, checked-out long gun
}
// traffic: TrafficSnapshot keeps version 1 with the optional Phase 2 fields (fleet, stop, curb offsets).
```
`migrateV3ToV4`: `cad: emptyCadSave()`, `dispatch: null`, `records: emptyRecordsSave()`,
`radio: defaultRadioSave(state of createRng(seed).stream('radio'))`, `equipment: vehicles.map(() => null)`,
`officerKit: emptyOfficerKit()`. Load order: environment → entities → vehicles (+ equipment, PoliceLights)
→ traffic restore → `cad.restore` → `records.restore` → `dispatch.restore` (or `start` when null) →
`radio.restore`. `isSaveGameV4` = v3 checks + every sub-validator + `equipment.length === vehicles.length`.
Tests (`test/save`): v1/v2/v3 → v4 migrate and validate; a v4 round trip; each malformed block rejected;
future version rejected; a migrated v3 save loads with a fresh roster and fleet.

## 18. Performance budget (60 FPS, mid-range desktop GPU, 1080p)

| Subsystem | Budget | Notes |
|---|---|---|
| Dispatch step | ≤ 0.05 ms/step average, ≤ 2 ms spike | FSM + AVL at 2 Hz; A* only on assignment/re-plan |
| Radio step | ≤ 0.02 ms/step | queue ≤ 32, no allocation unless a transmission starts |
| Traffic additions | ≤ +0.05 ms/step | ≤ 16 fleet cars, yield scan ≤ 17 sources per car, no allocation |
| Records lookup | ≤ 0.5 ms each; name index ≤ 10 ms once | on user action only |
| Equipment writeLook | ≤ 0.005 ms/step | a few typed-array writes per patrol car |
| Audio per frame | ≤ 0.1 ms | ≤ 4 voices, AudioParam writes only, no node creation after warm-up |
| Radio player | event-driven | TTS calls only on transmission start |
| MDT overlay | ≤ 4 Hz and only on CAD revision change, ≤ 2 ms per refresh; 0 when closed | map dynamic layer ≤ 4 Hz ≤ 2 ms |
| MDT screen | ≤ 2 Hz, ≤ 1.5 ms paint + texture upload, only in cockpit view | 512 x 320 |
| HUD + radio panel | 10 Hz, ≤ 0.3 ms | radio lines written on events only |
| Cockpit renderer | ≤ 0.1 ms/frame, ≤ 6 draw calls (cockpit view only) | |
| Car renderer | +8 light-bar lenses per police car, +1 trim draw call per police model, +1 spot light (fixed count) | |
| Draw calls | target ≤ 200, cap 300 (unchanged) | |
| Per-frame allocations | none in hot loops | strings only in throttled UI and on events |

## 19. Requirement map

| Requirement | Code |
|---|---|
| Cockpit view extended: MDT screen in-world + full-screen overlay | `render/police/cockpit.ts`, `render/police/mdtScreen.ts`; `ui/mdt/**` (overlay); Tab → integrator |
| Radio head unit | `render/police/cockpit.ts` (display), `radio/**` (logic) |
| Siren controller (wail/yelp/phaser/air horn/manual) | `police/equipment.ts`, `police/controls.ts`, `audio/siren.ts`, cockpit LEDs |
| Light bar patterns, data-driven, reduced flash | `data/police/lightbar.json`, `police/lightbar.ts`, `render/vehicles/carRenderer.ts` |
| Spotlight (aimable, real light) | `police/equipment.ts` (aim), `render/vehicles/carRenderer.ts` (SpotLight) |
| Push bumper (sturdier front) | `vehicles/model.ts`, `vehicles/damage.ts`, `data/vehicles/patrol_*.json`, `render/vehicles/carParts.ts` |
| Rear cage / prisoner seat | `police/equipment.ts` (cage), cockpit partition, `dispatch:arrest` → session, booking in MDT |
| Shotgun/rifle rack | `police/equipment.ts`, `ui/panels/actionPanel.ts`, cockpit rack |
| Trunk inventory (on foot, data-driven items) | `data/police/items.json`, `police/inventory.ts`, trunk hint + `ActionPanel` (integrator) |
| Siren audio, attenuation, panning | `audio/engine.ts`, `audio/siren.ts`, `data/audio/sirens.json` |
| CAD queue, P1-P4, nature, address, caller, narrative, assignments, statuses | `cad/cadState.ts`, `cad/address.ts`, `ui/mdt/**` |
| Roster + AVL map with live AI units | `dispatch/units.ts` (AVL), traffic fleet cars, `ui/mdt` map |
| AI units on the road network, dispatched, statuses | `traffic/trafficSystem.ts` (fleet), `dispatch/**` |
| Records: person/vehicle lookup, warrants, BOLOs, flags, priors, supervision, gang, mental health, firearms, protective orders | `records/**` |
| Deterministic, cached, persisted records; owner for every plate; plate states | `records/ids.ts`, `records/vehicle.ts`, `records/db.ts`, save v4 |
| Run plate of the targeted car | `traffic/pick.ts`, `target.runPlate`, `dispatch` runPlate, HUD target line |
| Documents: report, citation (statute table), booking, evidence, supplemental | `cad/documents.ts`, `data/cad/statutes.json`, `ui/mdt` forms |
| Procedural call generator (data-driven, extensible) | `data/cad/callTypes.json`, `dispatch/generator.ts` |
| Dispatcher assigns AI units or offers to the player | `dispatch/dispatcher.ts` |
| Traffic stop: lights behind → pull over, run plate, approach, cite | `traffic` (§7.2), `dispatch` (§8.1), integrator interactions, MDT citation |
| Ten-code / plain modes | `data/cad/tenCodes.json`, `data/radio/phrases.json`, `audio.radioMode` setting |
| TTS with distinct voices, fallback to subtitles | `speech/tts.ts`, `radio/player.ts`, `ui/panels/radioPanel.ts` |
| Multi-channel, selection, scanning | `radio/net.ts`, `data/radio/channels.json`, radio actions |
| Ambient radio traffic | `radio/ambient.ts`, `radio/compose.ts` |
| Stepped-on transmissions (heterodyne + blocked) | `radio/net.ts` overlap, `audio/radioFx.ts`, radio panel |
| Emergency button | `radio.emergency` → `dispatch` emergency, radio hold + priority tone |
| 10-20 with street/cross street | `cad/address.ts`, `dispatch` location, radio phrases |
| Status checks with escalation | `dispatch/statusCheck.ts`, radio phrases |
| Static/squelch synthesized, radio volume | `audio/radioFx.ts`, `audio.radio` |
| Optional push-to-talk voice commands (off by default) + keyboard menu | `speech/recognition.ts`, `radio/grammar.ts`, `radio/menu.ts`, `radio/controller.ts`, `audio.voiceCommands` |
| Perf: throttled DOM, cheap AI | §18 |
| Save: CAD, radio settings, equipment/trunk | §17 |

## 20. Modules, ownership and waves

| Key | Wave | Owns (exclusively) | May import (new Phase 2 code) |
|---|---|---|---|
| records | 1 | `src/records/**`, `src/data/records/**`, `test/records/**` | none |
| cad | 1 | `src/cad/**`, `src/data/cad/**`, `test/cad/**` | none |
| traffic | 1 | `src/traffic/**` (registry.ts frozen), `src/data/traffic/**`, `test/traffic/**` | none |
| equipment | 1 | `src/police/**`, `src/data/police/**`, `src/vehicles/damage.ts`, `src/vehicles/model.ts`, `src/data/vehicles/**`, `src/input/actions.ts`, `src/input/bindings.ts`, `test/police/**`, `test/vehicles/damage.test.ts`, `test/vehicles/model.test.ts`, `test/input/actions.test.ts`, `test/input/bindings.test.ts` | none |
| audio | 1 | `src/audio/**`, `src/speech/**`, `src/data/audio/**`, `src/settings/settings.ts`, `test/audio/**`, `test/speech/**`, `test/settings/**` | none |
| dispatch | 2 | `src/dispatch/**`, `src/data/dispatch/**`, `test/dispatch/**` | cad, records, traffic, equipment (PoliceLights) |
| radio | 2 | `src/radio/**`, `src/data/radio/**`, `test/radio/**` | cad, audio (incl. speech, settings types), equipment (action ids) |
| mdt | 2 | `src/ui/mdt/**`, `test/mdt/**` | cad, records |
| policeRender | 2 | `src/render/vehicles/**`, `src/render/police/**`, `test/vehiclerender/**`, `test/policerender/**` | equipment |
| hud | 2 | `src/ui/hud/**`, `src/ui/panels/**`, `test/hud/**`, `test/panels/**` | none required (plain view models); may import equipment/records for labels |
| integrator | 3 | `src/app.ts`, `src/game/**`, `src/core/event-map.ts`, `src/ecs/components.ts`, `src/save/**`, `docs/PHASES.md`, `scripts/smoke.mjs`, and unowned files (`src/main.ts`, `src/ui/ui.ts`, `src/ui/styles.css`, `docs/ARCHITECTURE.md`, `README.md`, `test/game/**`, `test/save/**`) | all |

Every module may import Phase 0/1 code (core, ecs, physics, render, input, ui, settings, world,
environment, vehicles, player, traffic registry) but must not edit files it does not own. Phase 1 files
owned by no Phase 2 module (e.g. `src/vehicles/drivableVehicle.ts`, `src/world/**`, `src/player/**`,
`src/debug/worldCommands.ts`) are not changed in Phase 2.

## 21. Integrator plan

1. Session (`src/game/session.ts`): construct `RecordsDb` (home edges, cad address formatter, today),
   `CadState`, `Dispatcher`, `RadioSystem`; `PatrolEquipment` per patrol car (model `equipment`) with
   `attachPoliceLights`; `OfficerKit`; register `dispatch` (-700) and `radio` (-650); `writeLook` in
   `vehicles.pre`; traffic focus `heading/lights/siren`; `trafficCars()` skips fleet ids; teleport keeps
   fleet cars; interactions (trunk, driver contact, equipment, MDT reach); `dispatch:arrest` seats the
   prisoner; booking completion releases it; serialize/load v4 (§17 order); `startNewGame` calls
   `dispatcher.start` before `populateTraffic`.
2. Save (`src/save/**`): v4 types, validators, `migrateV3ToV4`, tests.
3. App (`src/app.ts`): `AudioEngine` (unlock on first pointer/key), `SpeechOut`, `SpeechIn`,
   `RadioPlayer`, `RadioController`, `RadioPanel`/`RadioMenuView`, `MdtOverlay`, `MdtScreen` →
   `CockpitRenderer`, `ActionPanel`, spotlight target; pause rule ignores `pausesGame === false`
   menus; settings wiring (volumes, tts, voice commands, radio mode, subtitles); police input; target
   pick (`pickTrafficCar`, 10 Hz) and `target.runPlate`; siren emitters + listener per frame; HUD feed
   (police, target, call, unit, offer, carried) and minimap markers; route line to the player's
   destination (re-planned every 10 s or when off route by 60 m); perf extras `dispatch`, `radio`,
   `audio`; register module console commands.
4. Smoke test: new shift, a generated call reaches the queue, an AI unit is dispatched and moves, MDT
   opens/closes without pausing, pull-over of a car ahead, plate run, citation issued, radio log has
   lines, siren/lights/spotlight toggles, save/load v4 keeps CAD/records/radio/equipment, screenshots
   `phase2.png` (cockpit with MDT) and `phase2-mdt.png`.
5. Docs: PHASES.md Phase 2 entry (controls, checklist, perf, limitations), ARCHITECTURE.md, README.

## 22. Known limitations and Phase 3 hooks

- No people meshes: the stopped driver, prisoner and callers are records only; calls have no scene
  content beyond CAD/radio and the location. Phase 3 adds NPCs, dialogue and 150+ call types (table
  rows in `callTypes.json`; the generator and dispatcher are type-agnostic).
- Traffic never changes lanes: a car pulled over from an inner lane slides across the lanes to its
  right; cars only yield in their own direction of travel.
- Fleet cars drive through the junction box on red under code 3 only when no other approach holds it,
  but do not weave around queued traffic; they wait behind it (ambient cars ahead yield to the curb).
- Time compression (30x) makes CAD timestamps advance quickly relative to driving times.
- Speech output quality depends on the browser's voices; recognition is browser-provided (Chromium sends
  audio to a vendor service unless on-device recognition is available) and is off by default.
- Items have no world use yet (`deployable` items are Phase 3), the rack's guns cannot be fired.
