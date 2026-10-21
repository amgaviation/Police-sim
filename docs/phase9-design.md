# Phase 9 design: Polish and Release

Status: design (technical director). Implementation is split into 7 modules in 2 waves (§18) plus an integrator
(§19). Read with `docs/ARCHITECTURE.md`, `docs/phase8-design.md` §2 (conventions carried over) and `docs/research/*.md`.
Every builder reads §1-§4 and the section of its own module. Names, ids, signatures and shapes in this document are
contracts: do not rename them. When a brief says "add", keep every existing export, behaviour and test green unless the
brief says otherwise.

Note on the save version: the task statement says "currently v5", but Phase 8 already shipped **v10**
(`CURRENT_SAVE_VERSION = 10`, `src/save/schema.ts`). Phase 9 adds **v11** with a tested `migrateV10ToV11`; every older
version (1..10) must still load. The user gave blanket approval for this one version bump. Only the integrator edits
`src/save/**`.

## 1. Scope

At the end of Phase 9 the game is a releasable build:

- **Audio pass** (`src/audio`). Sirens get **Doppler** (relative velocity of emitter and listener, applied as oscillator
  detune), the driven vehicle has a synthesized **engine** that follows RPM and throttle (profile per vehicle style),
  the three nearest traffic cars have a pooled engine voice, **tire squeal** follows the slip of the driven car (lateral
  slide, locked wheels, handbrake; gravel crunch off asphalt), **ambient city beds** per district, hour and weather
  (traffic rumble, mains hum, wind, rain, birds by day, crickets by night, water by the harbor, muffled indoors and in
  the cabin), **layered radio chatter** (a babble bed under live traffic and a babble burst for every audible
  transmission that is not spoken by text-to-speech), and **UI sounds** (move, select, back, open, close, error,
  notify). Everything is synthesized from oscillators and seeded noise: no audio files. Five volume buses
  (master, effects, radio, ambience, UI) follow the settings; pause mutes the world buses but keeps UI sounds.
- **VFX** (`src/render/vfx`). Cheap **glow sprites** (one instanced additive quad mesh) on lit light-bar segments,
  head and brake lamps, plus a coloured **ground light pool** under police cars with the bar on (the cheap substitute
  for bloom; dimmer and never pulsing faster than the bar under reduced flash); instanced **headlight cones** at night
  and in fog / rain; a GPU **particle pool** for muzzle flashes, TASER sparks, collision **sparks and dust** and wheel
  dust off-road; a **TASER arc** line while probes are attached; **rain splashes** on the ground and a **wet sheen**
  on roads (roughness and colour follow `weather.wetness`); **scene tape flutter** (vertex wave driven by the wind).
  A `graphics.effects` setting (off / low / high) scales all of it.
- **UI pass** (`src/ui`, `src/input`, `src/settings`, `src/a11y`). One set of design tokens (colours, spacing, type
  scale in em) used by every stylesheet (MDT, CAD console, menus, HUD, panels), a CSS audit test (no px font sizes, no
  literal colours outside the palette blocks, no removed focus outlines), WCAG contrast tests for every colour-vision
  palette, a visible focus ring, **keyboard navigation everywhere** (arrow keys move focus in any menu that does not
  handle them itself) and **gamepad navigation everywhere** (`GamepadNav`: D-pad / left stick move, A activates, B goes
  back, LB / RB switch tabs, Start pauses; the radio menu gains a cursor driven by the D-pad and A).
- **Tutorial** (`src/tutorial`, `src/ui/tutorial`). *Guided first shift* on the title screen: a data-driven script of
  interactive prompts (get in the car, drive, light bar, radio status, accept a call, drive to it, handle the scene and
  clear it, write the report, a traffic stop with a plate run and a citation or warning, finish). Steps complete on
  simulation events or probes, so the prompts react to what the player really does. The progress is saved (v11).
- **Performance** (`src/debug/profiler.ts`, `test/perf`, `scripts/perf.mjs`, `docs/PERFORMANCE.md`). A zero-allocation
  per-system profiler (mean, p95, max), a long-shift profile in Node (vitest) and in the browser (production build,
  Playwright, CDP heap usage after forced GC at checkpoints and optional heap snapshots), a memory plateau test, hot-spot
  fixes that keep every determinism fixture bit-identical, and a results document.
- **Release.** A legal-engine and CAD **test audit** (export coverage, rule coverage per ruleset, doctrine outcome
  matrix, seeded property tests, CAD state machine and invariant fuzz), a clean production build, the **README** with
  architecture docs (overview, how to run, controls, modding, multiplayer, testing, performance notes), the final
  `docs/ASSETS.md`, and **`scripts/e2e.mjs`**: a headless end-to-end test against the production build (`vite preview`)
  of the done-when flow: create an officer, start a shift, receive and resolve a call end to end (CAD -> scene ->
  report -> court), call backup, drive a customized patrol car, save and load, with zero console errors.

Non-goals: a full-screen bloom pass (it would conflict with the heat-haze post pass and cost a full-resolution blur;
the glow sprites and light pools stand in for it), recorded or licensed audio, music (the `audio.music` setting stays
hidden), gamepad text entry (form fields keep their prefilled text; free text needs a keyboard), localisation, a
tutorial for every Phase 4-8 system (the guided shift covers driving, radio, CAD, a call, a report and a traffic stop;
the other systems keep their HUD hints).

## 2. Conventions (in addition to Phase 1-8 §2)

- **TS rules** unchanged: no enums / namespaces / parameter properties; `as const` objects + unions; `import type`;
  `noUncheckedIndexedAccess`; JSDoc on exports; no per-frame or per-step allocation in hot paths (`update`, `step`,
  render loops). Event handlers, menu builds, one-shot sound scheduling and particle emission may allocate only where
  this document says so (sound sources created per one-shot sound are allowed: Web Audio source nodes are single-use).
- **Determinism.** Audio, VFX, UI and profiling are presentation: they never feed back into the simulation. Their
  randomness comes from render-only streams `createRng('audio:<name>')` / `createRng('vfx:<name>')` (fixed string seeds,
  like `createPrecipitation`); `Math.random` and `Date.now` stay forbidden everywhere in `src/` except where they already
  are. The tutorial is simulation: its runner steps in the fixed step (order -651), bus handlers only enqueue, its state is
  saved, and its probes read simulation state only (never DOM or UI state).
- **Data** in `src/data/<area>/*.json` with `"version": 1`, validated at import by a typed validator throwing `Error`
  naming the file and the dotted JSON path (pattern: `src/vehicles/json.ts` readers `readObject`, `readNumber`,
  `readString`, `readOneOf`, `readArray`, `readVersion`, `fail`). Export `parseX(json, file)` and the parsed constant.
- **Headless.** Every class constructs and runs as a no-op without `document`, `AudioContext` or a WebGL renderer
  (vitest = node). Three.js objects may be created in node (no renderer needed). Web Audio code is tested against the
  hand-written fake in `test/audio/fakeAudio.ts`.
- **Generic content only.** No real agencies, brands, logos, liveries or game assets; every sound and effect is
  synthesized or procedural. `docs/ASSETS.md` lists no third-party asset.
- **Flashes / reduced flash.** Nothing may change brightness faster than `MAX_FLASH_HZ` (3 Hz, `src/a11y/flash.ts`).
  With `accessibility.reducedFlash` on: glow sprites hold the bar's (already reduced) level, the muzzle flash light is not
  used and the flash sprite is dimmed to 40 %, the TASER arc does not flicker (static dim line), no UI element animates.
- **Verify before finishing** (every module): `npx tsc -p tsconfig.json` clean for your files, `npx eslint <your files>`
  clean, `npx vitest run <your test dirs>` passing. Modules touching shared behaviour also run the test dirs named in
  their brief.

## 3. Architecture

```
 fixed step (60 Hz)
 ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
 │ ... Phase 1-8 systems unchanged (bit-identical: profiler hooks and perf fixes add no draws) │
 │ tutorial (-651)  TutorialRunner: queued events / ack / skip / end, step enter actions        │
 │                  (createCall), probes every 15 steps, completion -> tutorial:step / :done   │
 └──────────────────────────────────────────────────────────────────────────────────────────────┘
 SystemRegistry.runAll -> SystemProfiler.record(name, ms) (allocation-free; browser + node)

 frame (App.update)
   input -> GamepadNav.update (menus open: synthesized keys / focus moves / clicks)
   ... Phase 1-8 frame order ...
   cars: CarRenderer.update -> GlowSink (VfxSystem: glow sprites, light pools, headlight cones)
   VfxSystem.update(camera, dt, nightFactor, weather, reducedFlash): particles, taser arc
   EnvironmentRenderer.update: + rain splashes;  ChunkStreamer.setWetness(wetness, snow)
   PropRenderer.setWind(time, wind)  (tape flutter)
   audio: listener pose + velocity, sirens (Doppler), vehicles (engine, tires, traffic engines),
          ambience (district, hour, weather, indoor, cabin), radio bed (RadioPlayer), UI sounds (UIRoot.onUiSound)
   HUD, tutorial card (revision-driven, 10 Hz)
 render: renderer.render -> profiler.frame('render', ms)

 offline tools: test/perf (node long shift, memory plateau), scripts/perf.mjs (browser, production build, CDP heap),
                scripts/e2e.mjs (production build, done-when flow), npm run build (clean)
```

- **Wave 1 (no new Phase 9 imports):** `audio`, `vfx`, `ui`, `tutorial`, `perf`, `legalcad`.
- **Wave 2:** `release` (e2e script, README, architecture and assets docs, package scripts, vite config). It imports no
  TypeScript; it documents and exercises what wave 1 and the existing game provide.
- Importing **pre-existing Phase 0-8 exports** of a file another module owns is always allowed; only Phase 9 additions
  of a same-wave module are off limits (use the contract literal or a parameter).

## 4. Shared contracts

### 4.1 Fixed id lists (contracts)

| List | Ids | Defined by (file) |
|---|---|---|
| `AUDIO_BUSES` | `master sfx radio ambience ui` | audio `src/audio/engine.ts` |
| `ENGINE_PROFILES` | `car v8 diesel twin single outboard rotor drone` | audio `src/audio/vehicleData.ts` |
| `AMBIENCE_LAYERS` | `traffic hum wind rain birds crickets water` | audio `src/audio/ambienceData.ts` |
| `UI_SOUND_KINDS` | `move select back open close error notify` | audio `src/audio/uiData.ts` **and** ui `src/ui/ui.ts` (`UiSoundKind`, same literals; the two modules do not import each other) |
| `VFX_PARTICLE_KINDS` | `spark dust muzzle taser splash` | vfx `src/render/vfx/types.ts` |
| `EFFECTS_QUALITY` | `off low high` | vfx `src/render/vfx/types.ts` **and** ui `src/settings/settings.ts` (`graphics.effects`, same literals) |
| `TUTORIAL_PROBES` | `speedKmh driving lightbar siren distanceToCallM` | tutorial `src/tutorial/types.ts` |
| `TUTORIAL_TOPICS` | `player:mode unit:request cad:unitAssigned cad:unitStatus cad:callClosed cad:documentSaved traffic:pulledOver traffic:released dispatch:plateResult dispatch:backup` | tutorial `src/tutorial/types.ts` |
| `TUTORIAL_ACTIONS` | `createCall flash` | tutorial `src/tutorial/types.ts` |
| New input actions | `radio.cursorPrev` (PageUp, GamepadButton12), `radio.cursorNext` (PageDown, GamepadButton13), `radio.cursorSelect` (Enter, GamepadButton0); scope modal (radio-menu option) | ui `src/input/actions.ts`, `bindings.ts`, `context.ts` |
| New settings | `audio.ambience` (0..1, default 0.7), `audio.ui` (0..1, default 0.6), `graphics.effects` (`off low high`, default `high`) | ui `src/settings/settings.ts` |

### 4.2 Shared types (owners export them; the integrator wires them)

```ts
// audio — src/audio/engine.ts
export interface AudioVolumes { master: number; sfx: number; radio: number; ambience: number; ui: number }
// audio — src/audio/math.ts (SirenEmitter gains velocity; existing fields unchanged)
export interface SirenEmitter { id: number; x: number; y: number; z: number; vx: number; vy: number; vz: number;
  tone: SirenToneName | null; horn: boolean; manual: boolean; inCabin: boolean }
// audio — src/audio/vehicleAudio.ts (§5.4), src/audio/ambience.ts (§5.5)
export interface DrivenAudioState { /* §5.4 */ }
export interface TrafficAudioSource { id: number; x: number; y: number; z: number; speed: number }
export interface AmbienceParams { /* §5.5 */ }

// vfx — src/render/vfx/types.ts
export type EffectsQuality = 'off' | 'low' | 'high';
export type VfxParticleKind = 'spark' | 'dust' | 'muzzle' | 'taser' | 'splash';
export interface GlowSink { /* §6.2 */ }

// ui — src/ui/ui.ts
export type UiSoundKind = 'move' | 'select' | 'back' | 'open' | 'close' | 'error' | 'notify';

// tutorial — src/tutorial/types.ts
export interface TutorialSave { /* §8.2 */ }
export interface TutorialPorts { /* §8.4 */ }
export interface TutorialView { /* §8.4 */ }

// perf — src/debug/profiler.ts
export interface ProfileRow { name: string; count: number; meanMs: number; p95Ms: number; maxMs: number; totalMs: number; share: number }
export interface ProfileReport { steps: number; frames: number; systems: ProfileRow[]; phases: ProfileRow[] }
```

### 4.3 Event topics (declaration merging in the owner's `events.ts`)

| Topic | Owner file | Payload |
|---|---|---|
| `tutorial:step` | tutorial `src/tutorial/events.ts` | `{ scriptId: string; index: number; id: string; count: number }` (a step became current) |
| `tutorial:done` | tutorial | `{ scriptId: string; completed: boolean; skipped: number }` (finished or ended) |
| `tutorial:flash` | tutorial | `{ text: string }` (the `flash` action) |

No other new topics. No new ECS components (§13).

## 5. Audio [audio] — wave 1

Owns: `src/audio/**`, `src/data/audio/**`, `src/radio/player.ts`, `test/audio/**`, `test/radio/player.test.ts`,
`test/radio/chatter.test.ts` (new). Must also keep green: `test/radio/**` (run it).

### 5.1 Engine graph and buses (`src/audio/engine.ts`)

Graph after `unlock()`: `destination <- master <- { sfx, radio, ambience, ui }`. `sfx` carries sirens, engines, tires;
`radio` carries radio FX and chatter; `ambience` the beds; `ui` the UI sounds.

```ts
export const AUDIO_BUSES = ['master', 'sfx', 'radio', 'ambience', 'ui'] as const;
export interface AudioVolumes { master: number; sfx: number; radio: number; ambience: number; ui: number }
export class AudioEngine {
  readonly stats: AudioStats;            // + engine: 0|1, traffic: number, ambienceLayers: number, uiPlaying: number, chatter: number
  readonly sirens: SirenBank;
  readonly radio: RadioFx;               // + chatter(), setBed() (§5.6)
  readonly vehicles: VehicleAudio;       // §5.4
  readonly ambience: AmbienceBed;        // §5.5
  readonly ui: UiSounds;                 // §5.7
  setVolumes(v: AudioVolumes): void;     // missing ambience / ui (old callers) default to 1
  setListener(x, y, z, fx, fy, fz, ux, uy, uz): void;            // unchanged
  setListenerVelocity(vx: number, vy: number, vz: number): void; // m/s, used by Doppler
  suspend(): void;  // CHANGED: pause = sfx, radio and ambience buses glide to 0 (tau 0.03 s); ui stays; context keeps running
  resume(): void;   // buses glide back to their volumes
  ...unchanged: available, unlocked, unlock(), dispose()
}
```
`suspend()` no longer suspends the AudioContext (UI sounds must play in pause menus). While paused, `sirens.update`,
`vehicles.update` and `ambience.update` still accept calls (the integrator keeps calling them; they only write params).
Update the existing engine test "suspends and resumes with the pause state" to assert the bus gains instead of
`ctx.suspend` calls.

### 5.2 Doppler (`src/audio/math.ts`, `src/audio/sirens.ts`)

```ts
/** Doppler frequency ratio f'/f for a source and a listener (world m, m/s). Classic formula with c = speed of sound:
 *  ratio = (c + vL) / (c - vS), vL = listener velocity component toward the source,
 *  vS = source velocity component toward the listener; clamped to [min, max]; 1 when the distance < 0.01 m. */
export function dopplerRatio(sx, sy, sz, svx, svy, svz, lx, ly, lz, lvx, lvy, lvz, c = 343, min = 0.5, max = 2): number;
/** 1200 * log2(ratio). */
export function ratioToCents(ratio: number): number;
```
`SirenEmitter` gains `vx, vy, vz` (m/s). In `SirenBank.apply` every voice writes `detune` of its siren oscillator and of
every horn oscillator with `glide(param, cents, now, VEHICLE_AUDIO.dopplerTau)` (0.06 s); in-cabin emitters use 0 cents.
The listener velocity comes from `engine.setListenerVelocity` (stored in the shared `ListenerState`, which gains
`vx, vy, vz`). Constants in `src/data/audio/vehicleAudio.json`: `speedOfSound` 343, `dopplerClamp` [0.5, 2],
`dopplerTau` 0.06. Tests: approaching source at 30 m/s gives ratio 343/313 (±1e-9); receding 343/373; perpendicular
motion gives 1; listener moving toward a still source at 20 m/s gives 363/343; clamp at both ends; cents of 2 = 1200;
the bank writes detune on siren and horn oscillators (fake context), 0 in cabin, and still creates zero nodes over 1000
updates.

### 5.3 Data (`src/data/audio/vehicleAudio.json`, `ambience.json`, `ui.json`, `chatter.json`)

Validated by `src/audio/vehicleData.ts` (`parseVehicleAudio` -> `VEHICLE_AUDIO`), `ambienceData.ts`
(`parseAmbience` -> `AMBIENCE_DATA`), `uiData.ts` (`parseUiSounds` -> `UI_SOUNDS`), `chatterData.ts`
(`parseChatter` -> `CHATTER_DATA`). Initial content (builders may tune numbers, not shapes):

```jsonc
// vehicleAudio.json
{ "version": 1, "speedOfSound": 343, "dopplerClamp": [0.5, 2], "dopplerTau": 0.06,
  "engine": {
    "profiles": {
      "car":      { "cylinders": 6, "wave": "sawtooth", "lowpassBaseHz": 260, "lowpassPerRpm": 0.55, "subGain": 0.5, "noiseGain": 0.12, "am": 0,    "gain": 0.30 },
      "v8":       { "cylinders": 8, "wave": "sawtooth", "lowpassBaseHz": 220, "lowpassPerRpm": 0.5,  "subGain": 0.7, "noiseGain": 0.10, "am": 0,    "gain": 0.32 },
      "diesel":   { "cylinders": 6, "wave": "square",   "lowpassBaseHz": 180, "lowpassPerRpm": 0.6,  "subGain": 0.8, "noiseGain": 0.25, "am": 0,    "gain": 0.34 },
      "twin":     { "cylinders": 2, "wave": "sawtooth", "lowpassBaseHz": 300, "lowpassPerRpm": 0.35, "subGain": 0.6, "noiseGain": 0.15, "am": 0,    "gain": 0.30 },
      "single":   { "cylinders": 1, "wave": "square",   "lowpassBaseHz": 350, "lowpassPerRpm": 0.3,  "subGain": 0.3, "noiseGain": 0.18, "am": 0,    "gain": 0.26 },
      "outboard": { "cylinders": 4, "wave": "sawtooth", "lowpassBaseHz": 400, "lowpassPerRpm": 0.4,  "subGain": 0.4, "noiseGain": 0.30, "am": 0,    "gain": 0.30 },
      "rotor":    { "cylinders": 4, "wave": "triangle", "lowpassBaseHz": 160, "lowpassPerRpm": 0.1,  "subGain": 0.9, "noiseGain": 0.45, "am": 0.85, "gain": 0.40 },
      "drone":    { "cylinders": 8, "wave": "sawtooth", "lowpassBaseHz": 1800,"lowpassPerRpm": 2.0,  "subGain": 0.0, "noiseGain": 0.20, "am": 0,    "gain": 0.12 }
    },
    "idleGain": 0.35, "cabin": { "gain": 0.65, "lowpassHz": 1600 },
    "traffic": { "voices": 3, "maxDistanceM": 60, "profile": "car", "idleRpm": 750, "redlineRpm": 5500,
                 "gearRatios": [3.5, 2.1, 1.4, 1.0, 0.8], "finalDrive": 3.7, "wheelRadiusM": 0.33, "shiftRpm": 3000 } },
  "tires": { "slipStartMs": 1.5, "slipFullMs": 6, "lockSpeedMs": 3, "squealHzMin": 650, "squealHzMax": 1100,
             "noiseHz": 1200, "noiseQ": 1.5, "gain": 0.35, "gravelGain": 0.3,
             "surfaceSqueal": [1, 1, 0, 0, 0, 0], "surfaceCrunch": [0, 0, 1, 0.8, 0.4, 0.6] } }
```
Surface indices follow `SURFACE` (`asphalt concrete gravel dirt grass sand`).

```jsonc
// ambience.json — one entry per AMBIENCE_LAYERS id, in that order
{ "version": 1, "indoorLowpassHz": 600, "cabinLowpassHz": 900, "cabinFactor": 0.5,
  "layers": [
    { "id": "traffic",  "source": "noise", "filter": { "type": "lowpass",  "hz": 220,  "q": 0.7 }, "gain": 0.45, "drive": "none",
      "district": { "downtown": 1, "suburbs": 0.45, "industrial": 0.7, "highway": 1, "rural": 0.15, "campus": 0.4, "hospital": 0.6, "airport": 0.75, "harbor": 0.5, "park": 0.3, "water": 0.1 },
      "hours": [0.35,0.3,0.25,0.25,0.3,0.5,0.8,1,1,0.9,0.85,0.85,0.9,0.9,0.9,0.95,1,1,0.9,0.75,0.6,0.5,0.45,0.4],
      "weather": { "clear": 1, "cloudy": 1, "rain": 1.1, "storm": 1.1, "fog": 0.9, "snow": 0.7, "heat": 1 }, "indoor": 0.25 },
    { "id": "hum",      "source": "hum",   "hz": 60, "gain": 0.06, "drive": "none", "district": { "downtown": 1, "industrial": 1, "hospital": 0.8, "*": 0.3 }, "hours": "flat", "weather": {}, "indoor": 1.5 },
    { "id": "wind",     "source": "noise", "filter": { "type": "bandpass", "hz": 500,  "q": 0.6 }, "gain": 0.4,  "drive": "wind", "lfoHz": 0.15, "district": { "*": 1 }, "hours": "flat", "weather": {}, "indoor": 0.1 },
    { "id": "rain",     "source": "noise", "filter": { "type": "highpass", "hz": 1800, "q": 0.5 }, "gain": 0.5,  "drive": "rain", "district": { "*": 1 }, "hours": "flat", "weather": {}, "indoor": 0.2 },
    { "id": "birds",    "source": "chirps", "ratePerS": 0.6, "gain": 0.12, "drive": "none", "district": { "suburbs": 1, "park": 1.4, "campus": 1, "rural": 1.2, "*": 0.3 },
      "hours": [0,0,0,0,0,0.4,1,1,0.8,0.6,0.5,0.5,0.5,0.5,0.5,0.6,0.7,0.8,0.5,0.1,0,0,0,0], "weather": { "rain": 0.2, "storm": 0, "snow": 0.2 }, "indoor": 0 },
    { "id": "crickets", "source": "crickets", "hz": 4600, "amHz": 28, "gain": 0.05, "drive": "none", "district": { "suburbs": 1, "park": 1.4, "rural": 1.5, "*": 0.2 },
      "hours": [1,1,1,1,0.6,0.1,0,0,0,0,0,0,0,0,0,0,0,0,0,0.3,0.8,1,1,1], "weather": { "rain": 0.3, "storm": 0, "snow": 0, "fog": 0.7 }, "indoor": 0 },
    { "id": "water",    "source": "noise", "filter": { "type": "lowpass",  "hz": 400,  "q": 0.8 }, "gain": 0.3,  "drive": "none", "lfoHz": 0.2,
      "district": { "harbor": 1, "water": 1, "park": 0.3, "*": 0 }, "hours": "flat", "weather": { "storm": 1.5 }, "indoor": 0 } ] }
```
`"hours": "flat"` = 1 for every hour; `"*"` in `district` is the default for districts not listed (absent `"*"` = 0);
an absent weather key = 1. `drive`: `none` (1), `rain` (`params.rain`), `wind` (`clamp(params.wind / 12, 0, 1)`).

```jsonc
// ui.json: each sound is 1..3 tones played back to back
{ "version": 1, "rateLimitMs": 60, "sounds": {
  "move":   [{ "hz": 880,  "toHz": 880,  "durS": 0.03, "wave": "sine",     "gain": 0.20 }],
  "select": [{ "hz": 660,  "toHz": 990,  "durS": 0.06, "wave": "sine",     "gain": 0.25 }],
  "back":   [{ "hz": 700,  "toHz": 440,  "durS": 0.06, "wave": "sine",     "gain": 0.22 }],
  "open":   [{ "hz": 520,  "toHz": 520,  "durS": 0.04, "wave": "triangle", "gain": 0.2 }, { "hz": 780, "toHz": 780, "durS": 0.05, "wave": "triangle", "gain": 0.2 }],
  "close":  [{ "hz": 780,  "toHz": 780,  "durS": 0.04, "wave": "triangle", "gain": 0.2 }, { "hz": 520, "toHz": 520, "durS": 0.05, "wave": "triangle", "gain": 0.2 }],
  "error":  [{ "hz": 220,  "toHz": 200,  "durS": 0.10, "wave": "square",   "gain": 0.15 }, { "hz": 220, "toHz": 200, "durS": 0.10, "wave": "square", "gain": 0.15 }],
  "notify": [{ "hz": 1320, "toHz": 1320, "durS": 0.05, "wave": "sine",     "gain": 0.18 }, { "hz": 1760, "toHz": 1760, "durS": 0.06, "wave": "sine", "gain": 0.18 }] } }
// chatter.json
{ "version": 1, "formantsHz": [500, 1500, 2500], "formantQ": 6, "syllableHz": [3.5, 6.5], "bandHz": [300, 3000],
  "burstLevel": 0.12, "bedLevel": 0.035, "bedPerTransmission": 0.5, "maxBursts": 3 }
```

### 5.4 Vehicles: engine, tires, traffic engines (`src/audio/vehicleAudio.ts`, `src/audio/vehicleMath.ts`)

Pure maths (`vehicleMath.ts`, mandatory tests):
```ts
/** Engine profile for a vehicle model's control kind and body style; null = silent (bicycle).
 *  sedan|hatchback -> car; suv|pickup|van -> v8; truck|bus -> diesel; motorcycle -> twin; atv -> single;
 *  boat -> outboard; helicopter -> rotor; drone -> drone; bicycle -> null; anything else -> car. */
export function engineProfileFor(control: string, style: string): EngineProfileId | null;
/** Four-stroke firing frequency: rpm / 60 * cylinders / 2 (Hz). */
export function firingHz(rpm: number, cylinders: number): number;
/** Low-pass cutoff: lowpassBaseHz + lowpassPerRpm * rpm * (0.3 + 0.7 * throttle), clamped to [80, 12000]. */
export function engineCutoffHz(profile: EngineProfile, rpm: number, throttle: number): number;
/** Engine gain: profile.gain * (idleGain + (1 - idleGain) * throttle) when running, else 0. */
export function engineGain(profile: EngineProfile, idleGain: number, throttle: number, running: boolean): number;
/** Slip (m/s) of the driven car: lateral = sqrt(max(0, groundSpeed^2 - speed^2)); longitudinal = |speed| when
 *  (handbrake || (brake > 0.8 && !absActive)) and |speed| > lockSpeedMs, else 0; returns lateral + longitudinal. */
export function tireSlip(speed: number, groundSpeed: number, brake: number, absActive: boolean, handbrake: boolean, lockSpeedMs: number): number;
/** Squeal level 0..1: smoothstep(slipStartMs, slipFullMs, slip) * surfaceSqueal[surface]; 0 when airborne. */
export function squealLevel(slip: number, surface: number, airborne: boolean, t: TireAudioData): number;
/** Gravel / dirt crunch level 0..1: clamp(groundSpeed / 15, 0, 1) * surfaceCrunch[surface] * gravelGain; 0 airborne. */
export function crunchLevel(groundSpeed: number, surface: number, airborne: boolean, t: TireAudioData): number;
/** Squeal pitch: lerp(squealHzMin, squealHzMax, clamp(slip / (2 * slipFullMs), 0, 1)). */
export function squealHz(slip: number, t: TireAudioData): number;
/** RPM of a traffic car from its speed: picks the highest gear whose rpm >= shiftRpm * 0.5 (gear 1 below that),
 *  rpm = |speed| / wheelRadius * 60 / (2 pi) * ratio * finalDrive, clamped to [idleRpm, redlineRpm]. */
export function rpmFromSpeed(speedMs: number, t: TrafficEngineData): number;
```

Node classes (`vehicleAudio.ts`):
```ts
export interface DrivenAudioState {
  active: boolean;            // false: no driven / controlled vehicle (engine and tire voices fade out)
  profile: EngineProfileId | null;
  rpm: number; throttle: number; running: boolean;
  speed: number; groundSpeed: number; brake: number; handbrake: boolean; absActive: boolean;
  surface: number;            // SURFACE id under the front-left wheel (telemetry.wheelSurface[0])
  airborne: boolean;
  inCabin: boolean;           // camera is the cockpit / hood view or first person in the car: cabin gain + lowpass
  x: number; y: number; z: number;
}
export class VehicleAudio {
  /** @internal engine unlock: builds the driven voice (2 oscillators + sub + noise layer + lowpass + AM gain), the
   *  tire voice (bandpassed noise + squeal sine + crunch lowpassed noise) and `traffic.voices` pooled traffic voices
   *  (one oscillator + lowpass + panner each); never builds nodes later. */
  build(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer, listener: ListenerState): void;
  detach(): void;
  /** Per frame; AudioParam writes only (glide tau 0.05 s); no allocation. A profile change retunes in place. */
  update(driven: Readonly<DrivenAudioState>, traffic: readonly TrafficAudioSource[], trafficCount: number): void;
}
```
Driven voice: oscillator A at `firingHz`, oscillator B at `firingHz * 2` (gain 0.35), sub sine at `firingHz / 2` (gain
`subGain`), noise through a bandpass at `2 * firingHz` (gain `noiseGain * (0.3 + 0.7 * throttle)`), summed into a
lowpass at `engineCutoffHz`, then an AM gain (for `am > 0`: a sine LFO at `firingHz / 4` with depth `am`), then the
voice gain `engineGain`, then (in cabin) gain `cabin.gain` and an extra lowpass `cabin.lowpassHz`, positioned at the
car (panner, same settings as the sirens). Traffic voices: the `voices` nearest `TrafficAudioSource`s within
`maxDistanceM` (reuse `chooseNearest`'s insertion approach with your own scratch arrays), rpm from `rpmFromSpeed`,
gain `0.25 * engineGain`, sticky assignment like the siren bank. Tests (fake context): node count fixed after unlock
over 1000 updates; driven frequency = `firingHz(rpm, cylinders)` within 1e-6; inactive state glides gain to 0; cabin
lowpass applied in cabin only; squeal gain follows `squealLevel` (asphalt slide > 0, gravel 0, crunch > 0 on gravel);
traffic voices pick the nearest within range and drop cars beyond it; pure functions as specified (table tests).

### 5.5 Ambience (`src/audio/ambience.ts`, `src/audio/ambienceMath.ts`)

```ts
export interface AmbienceParams {
  district: string;   // DISTRICT_NAMES entry at the listener ('water' off the map)
  hour: number;       // 0..24 game hour
  weather: string;    // WEATHER_KINDS entry
  rain: number;       // 0..1 precipitation * (1 - precipSnow)
  wind: number;       // m/s, |wind|
  indoor: boolean;    // officer inside a building interior
  inCabin: boolean;   // listener inside a vehicle cabin
}
/** Pure: target gain per layer (AMBIENCE_LAYERS order) into `out` (length >= layers): gain x district factor x hour
 *  factor (linear between whole hours, wrapping 23 -> 0) x weather factor x drive x (indoor ? layer.indoor : 1)
 *  x (inCabin ? cabinFactor : 1). Allocation-free. */
export function ambienceGains(p: Readonly<AmbienceParams>, data: AmbienceData, out: Float32Array): Float32Array;
/** Seconds until the next chirp: exponential with rate `ratePerS * level` from `rng` (Infinity when the rate is 0). */
export function nextChirpS(rng: Rng, ratePerS: number, level: number): number;
export class AmbienceBed {
  build(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer): void;  // one node chain per layer; a shared low-pass
  detach(): void;                                                          // (indoor / cabin) after the layer mix
  /** Per frame: glides each layer gain (tau 0.5 s), the shared low-pass (indoor 600 Hz, cabin 900 Hz, else 20 kHz),
   *  schedules bird chirps (2-4 sine sweeps 2.5 -> 4.5 kHz of 80 ms, at most 3 concurrent sources) from
   *  createRng('audio:ambience'); `nowS` = ctx time is read inside. */
  update(p: Readonly<AmbienceParams>, dt: number): void;
}
```
Sources: `noise` = the shared seeded noise buffer looped (each layer starts at a different offset) through the layer
filter (optionally amplitude-modulated by a sine LFO at `lfoHz`, depth 0.5); `hum` = sine at `hz` + sine at `2 * hz`
(gain 0.5); `crickets` = sine at `hz` multiplied by a gain driven by a square LFO at `amHz`, with a second slow square LFO
(0.7 Hz) gating it; `chirps` = event sources scheduled on `update`. Tests: `ambienceGains` table cases (downtown 08:00
clear outdoors: traffic = 0.45; downtown 08:30 interpolates between hours 8 and 9; park 06:00 birds > 0, crickets
0.1 x; indoor multiplies; cabin factor 0.5; rain drive scales the rain layer linearly; wind 24 m/s clamps to 1; unknown
district uses `"*"` else 0); `nextChirpS` deterministic for a seed and Infinity at rate 0; node count fixed over 1000
updates except chirps (at most 3 live); gains glide toward targets.

### 5.6 Radio chatter (`src/audio/radioFx.ts`, `src/radio/player.ts`)

```ts
// RadioFx additions
/** Unintelligible voice-like babble for `durationS` at `level` (0..1) on the radio bus: looped noise through three
 *  formant band-passes (formantsHz, formantQ) summed, amplitude-modulated by a square-ish envelope whose syllable rate is
 *  drawn per burst from `syllableHz` with createRng('audio:chatter'), then band-limited to bandHz; at most `maxBursts`
 *  concurrent (the oldest is cut). Event-driven: sources are created per burst and cleaned up on `onended`. */
chatter(durationS: number, level: number): void;
/** Background bed level 0..1 x bedLevel: a permanent babble chain built at attach; glides (tau 0.3 s). */
setBed(level: number): void;
```
`RadioPlayer` (presentation) changes, keeping every existing behaviour and test: (1) when an audible transmission starts
and it is **not** going to be spoken (speech disabled or unavailable, `speak` returned false, or it is a scanned channel
while another transmission is being spoken), call `audio.radio.chatter(tx.duration, scanned ? 0.5 : 1)` after the
key-up; (2) the bed: count audible transmissions on air (+1 on `radio:start` audible, -1 on `radio:end` / blocked,
never below 0) and call `audio.radio.setBed(Math.min(1, onAir * CHATTER_DATA.bedPerTransmission))`; `reset()` and
`dispose()` set the bed to 0. `RadioPlayerDeps.audio` keeps the `AudioEngine` type. Tests (`test/radio/chatter.test.ts`
with a fake engine object): chatter on a non-spoken transmission, none when spoken, half level when scanned, the bed
follows the count, reset clears it; `test/audio`: the chatter burst creates nodes on the radio bus and cleans them up,
the bed exists once, `maxBursts` cap.

### 5.7 UI sounds (`src/audio/uiSounds.ts`)

```ts
export const UI_SOUND_KINDS = ['move', 'select', 'back', 'open', 'close', 'error', 'notify'] as const;
export type UiSoundName = (typeof UI_SOUND_KINDS)[number];
export class UiSounds {
  attach(ctx: BaseAudioContext, out: AudioNode): void;
  detach(): void;
  /** Schedules the tones of `kind` (ui.json) on the ui bus; the same kind within `rateLimitMs` (ctx time) is dropped;
   *  an unknown kind is ignored; never throws; no-op before unlock. */
  play(kind: string): void;
}
```
Tests: each kind schedules `tones.length` oscillators on the ui bus with the listed frequencies (setValueAtTime +
exponential ramp to `toHz`), the rate limit drops a repeat within 60 ms but not after, unknown kinds do nothing,
`setVolumes({ ..., ui: 0 })` sets the ui bus gain target 0, pause (`suspend`) leaves the ui bus at its volume.

### 5.8 Volumes and index

`setVolumes` applies all five buses (glide `VOLUME_TAU`); `src/audio/index.ts` re-exports the new classes, types, data
and pure functions. Test: each bus gets its own volume; master 0 silences everything; values outside 0..1 are clamped;
missing `ambience` / `ui` default to 1.

### 5.9 Console (`src/audio/commands.ts`)

Add `ambience [district hour weather]` (prints the target gains of `ambienceGains` for the given or a default set) and
`uisound <kind>` (plays a UI sound). `createAudioCommands` keeps its signature.

## 6. VFX [vfx] — wave 1

Owns: `src/render/vfx/**` (new), `src/data/vfx/**` (new), `src/render/vehicles/carRenderer.ts`,
`src/render/people/propRenderer.ts`, `src/world/render/cityMaterials.ts`, `src/world/render/chunkStreamer.ts`,
`src/environment/render/**`, `test/vfx/**` (new), `test/vehiclerender/**`, `test/cityrender/**`. Must also keep green
(run): `test/peoplerender`, `test/render`, `test/environment`, `test/liveryrender`.

### 6.1 Types and data (`src/render/vfx/types.ts`, `src/render/vfx/data.ts`, `src/data/vfx/vfx.json`)

```ts
export const EFFECTS_QUALITY = ['off', 'low', 'high'] as const;
export type EffectsQuality = (typeof EFFECTS_QUALITY)[number];
export const VFX_PARTICLE_KINDS = ['spark', 'dust', 'muzzle', 'taser', 'splash'] as const;
export type VfxParticleKind = (typeof VFX_PARTICLE_KINDS)[number];
```
`vfx.json` (validated by `parseVfxData` -> `VFX_DATA`):
```jsonc
{ "version": 1,
  "glow": { "capacity": 512, "barSize": 0.9, "headSize": 0.7, "tailSize": 0.45, "dayFactor": 0.35, "lowSizeFactor": 0.6,
            "pool": { "capacity": 16, "radiusM": 6, "intensity": 0.55 } },
  "cones": { "capacity": 32, "lengthM": 18, "radiusM": 3.2, "maxDistanceM": 140, "intensity": 0.12, "fogBoost": 1.8, "rainBoost": 1.5 },
  "particles": { "capacity": 2048,
    "kinds": {
      "spark":  { "count": [12, 28], "speed": [3, 9],    "lifeS": [0.25, 0.6], "gravity": -9.8, "size": 0.06, "color": [1.0, 0.75, 0.35], "additive": true },
      "dust":   { "count": [6, 14],  "speed": [0.5, 2],  "lifeS": [0.8, 1.6], "gravity": 0.3,  "size": 0.9,  "color": [0.55, 0.5, 0.42], "additive": false },
      "muzzle": { "count": [6, 10],  "speed": [1, 4],    "lifeS": [0.04, 0.09],"gravity": 0,    "size": 0.25, "color": [1.0, 0.85, 0.5], "additive": true },
      "taser":  { "count": [4, 8],   "speed": [0.5, 2],  "lifeS": [0.05, 0.15],"gravity": 0,    "size": 0.05, "color": [0.75, 0.85, 1.0], "additive": true },
      "splash": { "count": [3, 6],   "speed": [0.6, 1.4],"lifeS": [0.2, 0.35], "gravity": -9.8, "size": 0.04, "color": [0.8, 0.85, 0.9], "additive": false } } },
  "splashes": { "count": 1500, "radiusM": 18, "rateHz": 2.2, "ringM": 0.25 },
  "wet": { "dryRoughness": 0.95, "wetRoughness": 0.32, "darken": 0.25, "markingsWetRoughness": 0.4 },
  "tape": { "amplitudeM": 0.05, "freqHz": 1.6, "waveK": 2.3, "windFull": 10 },
  "arc": { "segments": 8, "jitterM": 0.06, "rateHz": 12 },
  "muzzleLight": { "intensity": 40, "distance": 12, "durationS": 0.05 } }
```

### 6.2 Glow sink in the car renderer (`carRenderer.ts`, `src/render/vfx/glow.ts`)

```ts
// src/render/vfx/types.ts
export interface GlowSink {
  /** Called once at the start of CarRenderer.update. */
  begin(): void;
  /** A lit lamp: world position, linear RGB (0..1+), kind 0 = light-bar segment, 1 = head lamp, 2 = tail / brake lamp. */
  glow(x: number, y: number, z: number, r: number, g: number, b: number, kind: number): void;
  /** A car with its light bar on: ground pool centre (x, z) and the mean colour of its lit segments. */
  pool(x: number, z: number, r: number, g: number, b: number): void;
  /** A car with headlights on: lamp-pair centre and unit forward direction (world). */
  beam(x: number, y: number, z: number, dx: number, dy: number, dz: number): void;
  /** Called once at the end of CarRenderer.update. */
  end(): void;
}
// CarRenderer addition
setGlowSink(sink: GlowSink | null): void;
```
In `CarRenderer.update`, when a sink is set: for every lens written, compute its world centre
`origin + rot * (lx * dmg.scaleX + dmg.offsetX, ly, lz * dmg.scaleZ + dmg.offsetZ)` (rot = the column-major basis used
by `putInstance`; add a small pure helper `lensWorld(rot, origin, lx, ly, lz, out)` and test it) and call `glow` for a
lit bar segment (its written colour), a head lamp with `LIGHT.head` on (colour as written), a tail lamp with brake or
hazard lit; call `pool` once per car with lit bar segments (mean colour of the lit segments, at the car's x / z); call
`beam` once per car with `LIGHT.head` on and no headlight fault on both lamps (midpoint of the two head lamps,
direction = -Z basis column). No allocation; with no sink the renderer behaves exactly as before (existing tests green).

`GlowSprites` (`glow.ts`): one `InstancedMesh` of a unit quad with a `ShaderMaterial` (camera-facing billboard in the
vertex shader, radial falloff `pow(1 - r, 2)` in the fragment, `AdditiveBlending`, `depthWrite: false`,
`depthTest: true`, `fog: false`, `toneMapped: false`), `capacity` 512 instances (`instanceColor` = colour x
intensity; scale = size per kind x quality factor). Intensity: `night + dayFactor * (1 - night)`; kind 0 is always
drawn (the bar is visible by day), kinds 1-2 only scale by night. `LightPools`: one `InstancedMesh` of a ground disc
(y = 0.03, radius `pool.radiusM`) with the same additive shader (no billboard), at most 16, intensity
`pool.intensity * night` (pools only at night or dusk: skipped when night < 0.05). Reduced flash: the bar colours
arrive already dimmed by the car renderer; the glow does not add any modulation of its own.

### 6.3 Headlight cones (`src/render/vfx/cones.ts`)

One `InstancedMesh` of an open cone (`CylinderGeometry(0.15, radiusM, lengthM, 16, 1, true)` rotated so its axis is
local -Z with the apex at the origin), `ShaderMaterial` (alpha = `intensity * (1 - axial^1.5) * rim`, where `axial` =
0..1 along the length and `rim` = `pow(1 - |dot(normal, viewDir)|, 1.5)`; additive; depthWrite false; double side),
at most `capacity` (32) beams within `maxDistanceM` of the camera, nearest first (allocation-free insertion like
`chooseNearest`). Visible only when `night > 0.2` (alpha scaled by night) and quality is `high`; fog
(`weather.fogDensity > 0.01`) multiplies by `fogBoost`, rain by `rainBoost`.

### 6.4 Particles and arc (`src/render/vfx/particles.ts`, `arc.ts`, `math.ts`)

`ParticlePool`: two `Points` (additive and normal blending), each a ring buffer of `capacity / 2` particles with
attributes `aStart` (vec3 position), `aVel` (vec3), `aGrav` (float, the kind's gravity), `aBirth` (float, render time
s), `aLife`, `aSize`, `aColor` (vec3). The vertex shader computes `age = uTime - aBirth`; hides the point
(`gl_PointSize = 0`, alpha 0) when `age > aLife` or `age < 0`; position `aStart + aVel * age + 0.5 * vec3(0, aGrav, 0)
* age^2`; size `aSize * uScale / -mv.z` capped at 64 px; alpha `1 - age / aLife`. `uTime` wraps at 600 s (births are
written relative to the same wrapped clock; a particle born before a wrap is simply hidden). CPU
work happens only on emission: writes into the next ring slots and calls `addUpdateRange` for the written range (one or
two ranges at the wrap); the ring overwrites the oldest. Pure helpers in `math.ts` (tested): `particleAt(start, vel,
gravity, age, out)`, `ringRanges(head, count, capacity, out)` (returns 1 or 2 ranges), `emitSpec(kind, rng, out)`
(count, speed, life drawn from the kind's ranges with the render rng `createRng('vfx:particles')`).

```ts
export class VfxSystem {
  constructor(scene: THREE.Scene | null, data?: VfxData);
  readonly glowSink: GlowSink;                      // hand to CarRenderer.setGlowSink
  readonly stats: { glows: number; pools: number; cones: number; particles: number; drawCalls: number };
  setQuality(q: EffectsQuality): void;              // off: nothing drawn, emissions ignored; low: no cones, no pools, glow size x lowSizeFactor, particle counts halved
  setReducedFlash(on: boolean): void;
  /** One-shot effects (presentation). dir may be zero (random hemisphere). intensity 0..1 scales the count. */
  burst(kind: VfxParticleKind, x: number, y: number, z: number, dirX: number, dirY: number, dirZ: number, intensity: number): void;
  /** Muzzle flash at the officer's or an NPC's weapon: a 'muzzle' burst plus the pooled PointLight for durationS
   *  (not with reduced flash: the burst is dimmed to 40 % instead). */
  muzzle(x: number, y: number, z: number, dirX: number, dirZ: number): void;
  /** TASER arc between two points for this frame; call every frame while attached, `null` hides it. Jagged polyline of
   *  `arc.segments` (jitter re-drawn at `arc.rateHz`; reduced flash: no jitter, dim). */
  arc(from: { x: number; y: number; z: number } | null, to?: { x: number; y: number; z: number }): void;
  /** Per frame after CarRenderer.update: uploads glow / pool / cone instances, advances uTime, places the camera
   *  uniforms. `night` 0..1, `weather` for the boosts, `dt` real seconds. Allocation-free. */
  update(camera: THREE.Camera, dt: number, night: number, fogDensity: number, rain: number): void;
  dispose(): void;
}
```
Draw calls: glow 1, pools 1, cones 1, particles 2, arc 1 (only when visible), muzzle light 0 (a pooled light toggled
via intensity; it is always in the scene so no shader recompiles) => at most 6.

### 6.5 Rain splashes and wet sheen (`src/environment/render/precipitation.ts`, `environmentRenderer.ts`,
`src/world/render/cityMaterials.ts`, `chunkStreamer.ts`)

- `createSplashes()` (next to `createPrecipitation`): a `Points` of `splashes.count` ground points scattered in a
  square of `2 * radiusM` around the camera (wrapped like the rain box in xz, y = 0.02), each with `aRand`; the shader
  draws an expanding ring (`fract(uTime * rateHz + aRand)` as the phase: radius grows to `ringM`, alpha fades); draw
  range = `count * precipitation * (1 - precipSnow)`; hidden indoors and with effects `off`. `EnvironmentRenderer`
  owns it and gains `setEffects(q: EffectsQuality)`.
- `CityMaterials.setWetness(wetness: number, snowCover: number)`: ground and markings roughness
  `lerp(dryRoughness, wetRoughness, w)` (markings use `markingsWetRoughness`), ground colour multiplied by
  `1 - darken * w` (via `material.color` scalar), where `w = wetness * (1 - snowCover)`; only writes when the value
  changed by more than 0.01 (no needless material updates). `ChunkStreamer.setWetness(w, snow)` forwards it.

### 6.6 Tape flutter (`src/render/people/propRenderer.ts`)

The tape kind's ribbon becomes a strip of 12 segments along local -Z (post unchanged), and its material gets
`onBeforeCompile` with uniforms `uTime`, `uWind` and a vertex displacement for vertices above y = 0.85:
`transformed.x += amplitudeM * uWind * sin(2*PI*freqHz*uTime + position.z*waveK + instancePhase) * sin(PI * (-position.z / 3.0))`
where `instancePhase = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.61` (zero at both ends of the 3 m ribbon).
New method `setWind(timeS: number, windSpeed: number)` sets `uTime` (wrapped at 600 s) and `uWind = clamp(windSpeed /
windFull, 0.15, 1)`. A pure twin `tapeOffset(z, timeS, wind, phase, tape)` in `src/render/vfx/math.ts` mirrors the
shader formula and is tested (0 at z = 0 and z = -3, bounded by amplitude).

### 6.7 Tests (`test/vfx/**`)

Pure: `lensWorld`, `particleAt`, `ringRanges` (wrap), `emitSpec` determinism per seed and ranges, `tapeOffset`, the wet
roughness / darken mapping, nearest-N cone selection. Objects (THREE.Scene in node): `VfxSystem` counts (`stats`) after a
fake sink feed (bar glows, pools, beams), quality off draws nothing, low drops cones and pools, `burst` beyond capacity
wraps without throwing, zero heap growth over 1000 `update` calls (heap-delta pattern of `test/traffic/flee.test.ts`),
draw calls <= 6; `CarRenderer` with a recording sink: a police car with the bar on emits bar glows of the written
colours and one pool, a car with headlights emits one beam along its forward axis, no sink = identical buffers to
before; `CityMaterials.setWetness` values; `createSplashes` draw range follows rain and is 0 for snow.

## 7. UI pass, keyboard and gamepad navigation, settings [ui] — wave 1

Owns: every existing stylesheet `src/ui/**/*.css` (`styles.css`, `mdt/mdt.css`, `panels/panels.css`,
`dialogue/dialogue.css`, `investigation/investigation.css`, `review/review.css`, `career/career.css`,
`livery/livery.css`, `station/station.css`, `court/court.css`, `air/air.css`, `dispatch/dispatch.css`,
`character/character.css`, `sandbox/sandbox.css`, `mods/mods.css`, `coop/coop.css`), every `.ts` file under `src/ui/**`
**except** `src/ui/mainMenu.ts` and `src/ui/tutorial/**` (tutorial module), plus `src/ui/gamepadNav.ts` (new),
`src/input/**`, `src/settings/**`, `src/a11y/**`, `src/data/a11y/**`, `src/radio/controller.ts`, and tests
`test/ui9/**` (new), `test/a11y/**`, `test/input/**`, `test/settings/**`, `test/radio/controller.test.ts`,
`test/radio/cursor.test.ts` (new), and the existing UI test dirs it has to adapt: `test/panels/**`, `test/mdt/**`,
`test/hud/**`, `test/dialogueui/**`, `test/courtui/**`, `test/iaui/**`, `test/investigationui/**`, `test/stationui/**`,
`test/uicareer/**`, `test/uimodes/**`, `test/ui6/**`, `test/ui7/**`, `test/review/**`. Must also keep green (run, do
not edit): `test/radio` (other files than the two above), `test/game/**` files that import `src/ui` (keep every existing
signature; additions only).

### 7.1 Design tokens (`src/ui/styles.css`)

Add to `:root` (keep every existing variable; palettes keep overriding the semantic ones):
```css
--focus: #ffd24a;            /* focus ring; yellow is distinguishable in every colour-vision mode */
--panel-2: #182330;          /* nested surfaces (list rows, tab bars) */
--border-strong: #3d5266;
--scrim: rgba(4, 8, 12, 0.6);
--scrim-live: rgba(4, 8, 12, 0.25);
--shadow: 0 0.75em 2.5em rgba(0, 0, 0, 0.6);
--sp-1: 0.25em; --sp-2: 0.5em; --sp-3: 0.75em; --sp-4: 1em; --sp-6: 1.5em;
--fs-xs: 0.75em; --fs-sm: 0.875em; --fs-md: 1em; --fs-lg: 1.25em; --fs-xl: 1.6em;
--line: 1.4;
```
Global rules: `:focus-visible { outline: 0.15em solid var(--focus); outline-offset: 0.1em; }` and
`[aria-selected="true"], .is-selected { box-shadow: inset 0.2em 0 0 var(--accent); }`; buttons, inputs and selects use
`--panel-2`, `--border-strong`, `--fg`, padding `var(--sp-2) var(--sp-3)`, `font: inherit`; `.panel` width
`min(92vw, 46em)`, `max-height: 92vh`, `overflow: auto`. Every stylesheet is rewritten to use the tokens: colours only
through `var(--...)` (scrims and shadows via the tokens above), font sizes only in `em` / `rem` / `%` / tokens, widths of
text containers in `em`, `vw` or `%`. Keep every class name (tests and TS code depend on them); this is a visual
refactor, not a structural one.

### 7.2 Audits (`test/ui9/cssAudit.test.ts`, `test/ui9/contrast.test.ts`) — mandatory

`cssAudit` reads every `src/**/*.css` (use `node:fs` + a recursive directory walk; the existing `test/a11y/css.test.ts`
shows a rule parser) and asserts, reporting `file:line rule` for each violation:
1. `font-size` values contain no `px`.
2. No colour literal (`#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(`, `rgba(`, `hsl(`, `hsla(`) outside the `:root` and
   `:root[data-colorblind=...]` blocks of `styles.css`. Named colours other than `transparent`, `currentColor`,
   `inherit` are violations too.
3. No `outline: none` / `outline: 0` unless the selector contains `:not(:focus-visible)`.
4. `styles.css` has a `:focus-visible` rule whose outline uses `var(--focus)`.
5. No `width`, `min-width` or `max-width` in `px` >= 120 unless the declaration line carries the comment
   `/* audit-allow: px-width <reason> */` (canvases and fixed-size thumbnails).
6. Every `var(--name)` used anywhere is defined in `styles.css` (or locally in the same rule).

`contrast` parses the `:root` block and each colour-vision block of `styles.css` (merge the overrides over `:root`) and
asserts WCAG 2.x contrast ratios (implement `relativeLuminance` and `contrastRatio` in `src/a11y/contrast.ts`, pure,
exported and unit-tested against known pairs: black/white 21, #777/#fff 4.48): `--fg` on `--bg`, `--panel`, `--panel-2`
>= 7; `--fg-dim` on `--panel` and `--panel-2` >= 4.5; `--accent`, `--focus`, `--danger` and every `--c-*` on `--panel`
>= 3. Adjust token values in `styles.css` and `src/data/a11y/palettes.json` (keep them equal; the existing palette test
checks that) until it passes.

### 7.3 Keyboard focus navigation (`src/ui/ui.ts`)

```ts
export type UiSoundKind = 'move' | 'select' | 'back' | 'open' | 'close' | 'error' | 'notify';
// UIRoot additions
/** Notified for UI sounds: 'open' on push, 'close' on pop, 'move' on a focus move made by moveFocus, 'select' on a
 *  click inside the menu layer (delegated listener on .ui-menus, buttons / [role=button] / checkbox / radio / select). */
onUiSound(listener: (kind: UiSoundKind) => void): () => void;
/** Plays a sound through the listeners (other modules: `ui.sound('error')`). */
sound(kind: UiSoundKind): void;
/** Moves focus inside the top menu to the next (dir 1) / previous (-1) focusable element in document order, wrapping;
 *  focusables = visible, enabled `button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])`.
 *  Returns false without a top menu or focusable. */
moveFocus(dir: 1 | -1): boolean;
```
`UIRoot.onKeyDown`: when the top menu's `onKeyDown` did not consume the event and the key is `ArrowDown` / `ArrowRight`
(dir 1) or `ArrowUp` / `ArrowLeft` (dir -1) and the target is not a text field, select or range input, call `moveFocus`
and `preventDefault`. A pure helper `nextFocusIndex(count, current, dir)` is exported and tested. Headless (`document`
undefined) everything stays a no-op.

### 7.4 Gamepad navigation (`src/ui/gamepadNav.ts`, `src/input/input.ts`)

`InputManager` additions (the gamepad is already polled in `update()`):
```ts
/** Raw value 0..1 of gamepad button `i` this frame (0 without a pad). */ padButton(i: number): number;
/** True on the frame button `i` went down. */ padPressed(i: number): boolean;
/** Raw axis value -1..1 (before deadzone). */ padAxis(i: number): number;
```
```ts
export interface PadSource { padPressed(i: number): boolean; padButton(i: number): number; padAxis(i: number): number }
export interface GamepadNavTarget {
  isMenuOpen(): boolean;
  /** The element keys are dispatched to (document.activeElement or the top menu element). */
  focusTarget(): EventTarget | null;
  moveFocus(dir: 1 | -1): boolean;
}
/** Standard-mapping buttons: 0 A, 1 B, 4 LB, 5 RB, 12 up, 13 down, 14 left, 15 right; axes 0 / 1 left stick. */
export class GamepadNav {
  constructor(pad: PadSource, target: GamepadNavTarget, dispatch?: (target: EventTarget, type: 'keydown' | 'keyup', key: string, code: string, shift: boolean) => boolean);
  /** Per frame (after input.update): only while a menu is open. D-pad or stick (|axis| > 0.5) -> Arrow keys with
   *  repeat (first after 400 ms, then every 120 ms held); A -> click() on a focused clickable element, else Enter;
   *  B -> Escape; LB -> Shift+Tab, RB -> Tab (key events; the browser does not move focus on synthetic Tab, so after an
   *  unconsumed Tab the nav calls moveFocus(+1 / -1) itself). Each synthesized key is a keydown followed by a keyup on
   *  the same target. Arrow keydowns that nothing consumed (dispatch returned true = not defaultPrevented) call
   *  moveFocus. */
  update(nowMs: number): void;
}
```
The default `dispatch` builds `new KeyboardEvent(type, { key, code, shiftKey, bubbles: true, cancelable: true })`,
dispatches it and returns `!event.defaultPrevented`. Keys reach `UIRoot` (document listener) and the `InputManager`
(window listener) like real keys, so `Escape` keeps its menu semantics. Pure helper `padRepeat(heldMs, lastFireMs,
nowMs)` decides the repeat and is tested; `GamepadNav` is tested with a fake pad, a fake target and a recording
`dispatch` (no DOM).

**Every menu operable by keys alone.** Audit each `Menu` (list: `src/ui/career/{academy,apartment,careerScreen,summary,
trainee}.ts`, `character/characterCreator.ts`, `coop/{lobby,prompt}.ts`, `court/courtroomPanel.ts`,
`dialogue/{dialoguePanel,sfstPanel}.ts`, `dispatch/console.ts`, `investigation/{cameraOverlay,caseFilePanel,
fingerprintPanel}.ts`, `livery/liveryEditor.ts`, `mdt/overlay.ts`, `mods/modManager.ts`, `panels/actionPanel.ts`,
`review/reviewPanel.ts`, `sandbox/editor.ts`, `settingsMenu.ts`, `station/briefingScreen.ts`; `game/pauseMenu.ts` and
`ui/mainMenu.ts` are buttons only and work through `moveFocus`): each must (a) close or go back on Escape, (b) move a
highlight or focus with the arrow keys (its own handling or the UIRoot fallback over real buttons), (c) activate with
Enter or a focused button. Menus whose choices are digit keys only (dialogue, SFST, courtroom answers, academy drills)
gain arrow-key highlight + Enter on the highlighted choice, keeping the digit keys. Write one headless test per changed
menu (`test/ui9/menuKeys.test.ts`: construct headless, call `onKeyDown` with `{ key, code, preventDefault }` objects,
assert the model / callback effect) and record the audit result as a table in the test file header.

### 7.5 Radio menu cursor (`src/input/*`, `src/radio/controller.ts`, `src/ui/panels/radioMenuView.ts`)

- Actions (`actions.ts`): `'radio.cursorPrev': { kind: 'button', label: 'Radio menu: previous' }`,
  `'radio.cursorNext'` ('Radio menu: next'), `'radio.cursorSelect'` ('Radio menu: select'). Bindings (`bindings.ts`):
  `[key('PageUp'), pad('GamepadButton12')]`, `[key('PageDown'), pad('GamepadButton13')]`,
  `[key('Enter'), pad('GamepadButton0')]`. Scopes (`context.ts`): `OPTION` (modal: they act only while the radio menu
  is open and then take their keys from every other action). One-handed layouts (`a11y/layouts.ts`,
  `data/a11y/layouts.json`): right hand binds PageUp / PageDown / Enter; left hand lists the three in
  `UNBOUND_BY_DESIGN.left` (it has digit keys for the options). Update `test/input` and `test/a11y` expectations
  (action count, layout audits) accordingly.
- `RadioController`: `RadioControllerState` gains `readonly cursor: number` (-1 when the menu is closed; 0 when it
  opens or changes level). `cursorNext` / `cursorPrev` move it over the **enabled** options of the current view
  (wrapping; 'move' semantics), `cursorSelect` presses option `cursor + 1` exactly like the digit key. Digit keys keep
  working and set the cursor to the pressed option. Tests in `test/radio/cursor.test.ts` (fake input like the existing
  controller tests): open -> cursor 0; next skips disabled; wraps; select sends the same request as the digit;
  level change resets to 0; closing sets -1.
- `RadioMenuView.show(menu: MenuView | null, cursor = -1)`: the row at `cursor` gets `class="is-selected"` and
  `aria-selected="true"`; no DOM rebuild when only the cursor changed (class toggle).

### 7.6 Settings (`src/settings/settings.ts`, `src/ui/settingsMenu.ts`)

Add `audio.ambience` (number 0..1 step 0.01, label 'Ambience volume', default 0.7), `audio.ui` (number, 'Interface
sounds volume', default 0.6) and `graphics.effects` (enum `off low high`, labels 'Off' / 'Low' / 'High', label
'Effects (glow, light cones, particles)', default `high`). `SETTINGS_VERSION` stays 2 (missing fields take their
defaults in `parseSettings`; add a test that a v2 blob without them parses to the defaults). The settings menu lists
them automatically; check its tests.

### 7.7 HUD and readability

HUD elements (`src/ui/hud/**`) use the tokens and `em` units; every HUD line has `max-width` in `em` / `vw` and
`overflow-wrap: anywhere` so text never leaves the screen at text scale 1.6; HUD chips use semantic colours **plus** a
text or shape cue (never colour alone: e.g. the emergency chip has a leading "!" or "EMERG"); note in the test header
which chips were changed. `src/ui/hud/**` DOM writes stay change-driven (write only when the text differs) and at the
existing 10 Hz.

### 7.8 Tests summary (`test/ui9/**`)

`cssAudit.test.ts`, `contrast.test.ts` (+ `test/a11y/contrast.test.ts` for the pure functions), `focus.test.ts`
(`nextFocusIndex`), `gamepadNav.test.ts`, `menuKeys.test.ts`, `uiSound.test.ts` (UIRoot emits open / close on
push / pop with a fake root element: construct with a minimal DOM stub, or test the emitter logic through an exported
pure `UiSoundEmitter` class used by UIRoot), plus the updated input / a11y / settings / radio controller tests.

## 8. Tutorial [tutorial] — wave 1

Owns: `src/tutorial/**` (new), `src/data/tutorial/**` (new), `src/ui/tutorial/**` (new), `src/ui/mainMenu.ts`,
`test/tutorial/**` (new), `test/mainMenu/**`.

### 8.1 Script format (`src/data/tutorial/firstShift.json`, `src/tutorial/script.ts`)

```ts
export interface TutorialEventMatch { topic: TutorialTopic; where?: Record<string, string | number | boolean> }
export type TutorialUntil =
  | { ack: true }                                                     // the player presses Continue
  | { any: TutorialEventMatch[] }                                     // the first matching bus event
  | { probe: TutorialProbe; gte?: number; lte?: number };            // a probe value (booleans as 0 / 1)
export type TutorialAction =
  | { do: 'createCall'; typeId: string; minM: number; maxM: number }  // binds `$call`
  | { do: 'flash'; text: string };
export interface TutorialStep { id: string; title: string; text: string; hint?: string; enter?: TutorialAction[]; until: TutorialUntil; skippable?: boolean }
export interface TutorialScript { version: 1; id: string; title: string; steps: TutorialStep[] }
/** Throws Error naming the file and the dotted path: unknown topic / probe / action, empty steps, duplicate step id,
 *  `where` values other than string / number / boolean, `createCall` with minM > maxM, an `any` list that is empty. */
export function parseTutorialScript(raw: unknown, file: string): TutorialScript;
export const TUTORIAL_SCRIPTS: Readonly<Record<string, TutorialScript>>;   // keyed by id; ships 'firstShift'
```
`where` keys are dotted paths into the payload (`request.kind`); the values `"$player"` and `"$call"` are replaced by
the player callsign and the call bound by `createCall`. Text tokens `{action.id}` (any `ActionId`, e.g.
`{interact}`, `{vehicle.lights}`) are replaced by the current key label at display time (§8.5).

`firstShift.json` steps (ids and completion are contract; wording may be polished):

| # | id | text (abridged) | until |
|---|---|---|---|
| 1 | `welcome` | Your first shift. Prompts like this one guide you; Escape > Pause has *Skip step* / *End tutorial*. | ack |
| 2 | `enterCar` | Walk to the patrol car in the lot and press {interact} to get in. | `player:mode` where `mode: "driving"` |
| 3 | `drive` | Accelerate {vehicle.accelerate}, brake {vehicle.brake}, steer {vehicle.steer}. Reach 30 km/h. | probe `speedKmh` gte 30 |
| 4 | `lights` | Emergency lights {vehicle.lights}, siren {vehicle.siren}. Switch the light bar on. | probe `lightbar` gte 1 |
| 5 | `radioStatus` | Open the radio {radio.menu}, choose 1 Status, then In service. ({radio.cursorNext} / {radio.cursorSelect} with a gamepad.) | `unit:request` where `callsign: "$player"`, `request.kind: "status"`, `request.status: "available"` |
| 6 | `takeCall` | enter: `createCall` `abandonedVehicle` 250-600 m. Dispatch offers you a call: accept it with radio 7 or in the MDT {mdt.toggle}. | `cad:unitAssigned` where `callsign: "$player"`, `callId: "$call"` |
| 7 | `driveToCall` | Follow the route on the minimap; you arrive on scene automatically. | `cad:unitStatus` where `callsign: "$player"`, `status: "onScene"` |
| 8 | `scene` | Look around, talk to people ({interact}), open the scene panel {scene.menu} and clear the call. | `cad:callClosed` where `callId: "$call"` |
| 9 | `report` | Write the incident report: MDT {mdt.toggle} > Reports > New report; tick the statements you can support and submit. | `cad:documentSaved` where `kind: "report"` |
| 10 | `trafficStop` | Find a car, get behind it and switch on the light bar to pull it over. | `traffic:pulledOver` |
| 11 | `runPlate` | Run its plate with {target.runPlate}. | `dispatch:plateResult` where `callsign: "$player"` |
| 12 | `contact` | Walk to the driver window, press {interact}, ask for the licence, then warn, cite or release. | any of `cad:documentSaved` where `kind: "citation"`, `traffic:released` |
| 13 | `backup` | Need help? Radio {radio.menu} > 4 Request > backup. Try it now (or skip). | `dispatch:backup` where `requester: "$player"`; `skippable: true` |
| 14 | `done` | That is the job. Citations and arrests go to court: hearings show in the MDT Career tab. | ack |

All steps except `welcome` and `done` are `skippable`.

### 8.2 Save block (`src/tutorial/save.ts`)

```ts
export interface TutorialSave {
  version: 1;
  scriptId: string;
  index: number;          // current step (== steps.length when finished)
  entered: boolean;       // the current step's `enter` actions ran
  callId: number;         // `$call`, -1 unbound
  probeTick: number;      // fixed steps since the last probe check (0..14)
  skipped: string[];      // step ids skipped by the player
  done: boolean;          // finished or ended
  completed: boolean;     // finished through the last step (false when ended early)
  queue: { topic: string; payload: Record<string, unknown> }[];   // unapplied events (<= 64; plain JSON copies)
  pending: ('ack' | 'skip' | 'end')[];                              // unapplied player commands (<= 8)
}
export function newTutorialSave(scriptId: string): TutorialSave;
export function isTutorialSave(x: unknown): x is TutorialSave;     // full structural check; unknown scriptId = false
```

### 8.3 Runner (`src/tutorial/runner.ts`) — mandatory tests

```ts
export interface TutorialPorts {
  playerCallsign(): string;
  /** Simulation state only (never DOM / UI state). Booleans as 0 / 1. distanceToCallM: Infinity when unbound. */
  probe(id: TutorialProbe, callId: number): number;
  /** Creates a call of `typeId` minM..maxM from the player and offers it to the player unit; returns the call id or -1. */
  createCall(typeId: string, minM: number, maxM: number): number;
}
export interface TutorialView {
  readonly active: boolean; readonly done: boolean; readonly completed: boolean;
  readonly scriptId: string; readonly title: string;
  readonly index: number; readonly count: number;
  readonly step: { readonly id: string; readonly title: string; readonly text: string; readonly hint: string; readonly ack: boolean; readonly skippable: boolean } | null;
  /** Bumps on every change of the fields above. */
  readonly revision: number;
}
export class TutorialRunner {
  constructor(bus: EventBus<EventMap>, ports: TutorialPorts, save: TutorialSave, script?: TutorialScript);
  /** Bus forwarding (integrator subscribes every TUTORIAL_TOPICS topic): copies the payload (JSON-safe fields only:
   *  string, number, boolean, nested plain objects of those; arrays dropped) into the queue; drops beyond 64. */
  onEvent(topic: string, payload: unknown): void;
  ack(): void;   skip(): void;   end(): void;      // queued; applied at the next step
  /** Fixed step: 1. apply `pending` in order (ack completes an ack step; skip completes a skippable step and records its
   *  id; end finishes with completed false); 2. if not entered: run the enter actions (createCall binds callId; flash
   *  emits tutorial:flash), entered = true; 3. events of the queue in order against the current step's `any` matches
   *  (a completion advances to the next step; the rest of the queue is matched against the new step, which runs its
   *  enter actions first); 4. probeTick += 1, at 15 check a probe step (then 0). Every step change emits
   *  tutorial:step; the end emits tutorial:done once. Allocation-free when nothing happens. */
  step(): void;
  get view(): TutorialView;
  serialize(): TutorialSave;       // deep copy
}
```
Tests (`test/tutorial/runner.test.ts`, fake ports and a real `EventBus`): the whole `firstShift` script driven by
synthetic events and probe values reaches `done` with `tutorial:step` x 14 and one `tutorial:done { completed: true }`;
`$player` / `$call` substitution (an assignment to another call does not complete step 6); dotted paths; probe checked
only every 15 steps; createCall runs exactly once per step even across serialize -> new runner -> step (the `entered`
flag); a mid-script save round trip (JSON) continues identically (same events after load -> same views); skip on a
non-skippable step is ignored; end mid-way -> `completed: false`; queue cap 64; two runners fed the same inputs give
deep-equal saves; no events -> no revision change. `test/tutorial/script.test.ts`: the shipped script parses; each
validation error names the path; every `{token}` in the shipped texts is an `ActionId` (`isActionId`).

### 8.4 Events (`src/tutorial/events.ts`) and index

Declares `tutorial:step`, `tutorial:done`, `tutorial:flash` (§4.3) by declaration merging. `src/tutorial/index.ts`
exports the runner, script, save, types, `formatTutorialText`.

### 8.5 UI (`src/ui/tutorial/tutorialCard.ts`, `tutorialDialog.ts`, `tutorial.css`) and the title screen

```ts
/** Replaces {action.id} tokens via labelOf (unknown tokens stay as written). Pure. */
export function formatTutorialText(text: string, labelOf: (actionId: string) => string): string;  // src/tutorial/format.ts
export class TutorialCard {          // HUD element (not a Menu): never takes input, role="status", aria-live="polite"
  constructor(hudParent: HTMLElement | null);
  /** Rebuilds only when view.revision changed: title, formatted text, hint, "Step n of m"; hidden when !active
   *  or the step is an ack step (the dialog shows those). */
  update(view: TutorialView, labelOf: (actionId: string) => string): void;
  dispose(): void;
}
export class TutorialDialog implements Menu {   // pausing; id 'tutorial-dialog'
  constructor(ui: UIRoot | null, actions: { ack(): void; end(): void });
  /** Opens for an ack step (once per step index), closes otherwise; buttons Continue (autofocus) and End tutorial;
   *  Enter = Continue, Escape = Continue (never ends by accident). */
  sync(view: TutorialView, labelOf: (actionId: string) => string): void;
}
```
Styling: `tutorial.css` uses only the existing Phase 0-8 variables (`--panel`, `--panel-border`, `--fg`, `--fg-dim`,
`--accent`, `--radius`, `--text-scale`) and `em` units; the card sits bottom-centre above the HUD bottom line, max-width
`36em`. Tests: `formatTutorialText`; card / dialog headless no-ops; the dialog's key handling.

**Title screen (`src/ui/mainMenu.ts`)**: `MainMenuCallbacks.tutorial?(seed: number | string, jurisdiction?: string,
character?: MainMenuCharacter): void`; a new section `'tutorial'` (first after `'setup'`) when the callback exists, with
the button **Guided first shift** (class `primary` and the line "Recommended for your first shift" while the save list
is empty, else plain); `visibleSections` includes it. Update `test/mainMenu/**`.

## 9. Performance [perf] — wave 1

Owns: `src/debug/**`, `src/ecs/systems.ts`, `src/core/loop.ts`, `src/traffic/**`, `src/render/meshSync.ts`,
`src/main.ts`, `scripts/perf.mjs` (new), `docs/PERFORMANCE.md` (new), `test/perf/**` (new), `test/debug/**`,
`test/ecs/**`, `test/core/**`, `test/traffic/**`. Must keep green (run): `test/game/**` (determinism fixtures; do not
edit them: any optimization must keep saves bit-identical), `test/render`.

### 9.1 Profiler (`src/debug/profiler.ts`) — tests

```ts
export const PROFILE_PHASES = ['sim', 'update', 'render'] as const;
export class SystemProfiler {
  constructor(maxSystems = 64);
  /** Zero allocation after a name was first seen (Map lookup -> slot index). */
  record(name: string, ms: number): void;
  /** Counts one fixed step (SystemRegistry.runAll calls it after the systems). */
  endStep(): void;
  /** Per frame phase time. */
  frame(phase: 'sim' | 'update' | 'render', ms: number): void;
  reset(): void;
  /** Allocates; rows sorted by totalMs desc; share = totalMs / sum of system totals. p95 from a 64-bucket log2
   *  histogram per slot: bucket = clamp(floor(4 * log2(ms / 0.001)), 0, 63); p95 = upper edge of the bucket holding
   *  the 95th percentile sample. */
  report(): ProfileReport;
}
export function formatProfile(report: ProfileReport, top = 15): string;   // Markdown table: system | mean ms | p95 | max | share
```
`SystemRegistry` (`src/ecs/systems.ts`): `setProfiler(p: { record(name: string, ms: number): void; endStep(): void } |
null): void`; `runAll` calls `record` with the duration it already measures and `endStep` at the end. Without a
profiler behaviour is unchanged. `PerfOverlay` shows the top 5 systems by mean (mean / p95 ms) when visible and a
profiler is attached (`setProfiler(p | null)`), refreshed at 2 Hz. Tests: means / max exact for synthetic samples;
p95 bucket for a known distribution; zero heap growth over 100 000 `record` calls; registry calls `record` per system
and `endStep` per run; `formatProfile` output shape.

### 9.2 Node long shift and memory (`test/perf/longShift.test.ts`, `test/perf/memory.test.ts`)

Both use `test/game/harness.ts` (`new Harness(undefined, undefined, true)`, `await initRapier()` in `beforeAll`) with
a `SystemProfiler` attached to `harness.registry`. GC: `import v8 from 'node:v8'; import vm from 'node:vm';
v8.setFlagsFromString('--expose-gc'); const gc = vm.runInNewContext('gc') as () => void;` (call `gc()` twice before each
reading of `process.memoryUsage().heapUsed`).

- `longShift`: default (always runs): 1 game hour (7 200 steps) of a free-patrol shift from seed 4242 with the officer
  idle at the station (the dispatcher, AI units, traffic, pedestrians and the calls run); asserts mean step time < 4 ms
  and p95 < 12 ms (generous: CI machines vary); prints `formatProfile`. With `PATROL_LONG=1`: a full 8-game-hour shift
  (57 600 steps) and writes `docs/perf/node-long-shift.json` (`{ date, steps, report }`) and `docs/perf/node-long-shift.md`
  (the table). Timeout 20 min under `PATROL_LONG`.
- `memory`: (a) session churn: 6 x (start seed 77, 600 steps, `reset`), heap after cycle 2 vs cycle 6 grows < 12 MB
  and `harness.bus.listenerCount()` after each reset equals the count after the first reset; (b) plateau: one session,
  4 segments of 1 800 steps (6 x 7 200 with `PATROL_LONG=1`), heap after GC at the end of segment 2 vs the last grows
  < 16 MB (< 24 MB long) — capped lists keep the state bounded; on failure print the heap per segment.

### 9.3 Browser profile (`scripts/perf.mjs`, `src/main.ts`)

`src/main.ts`: expose the app as `window.patrol` when `import.meta.env.DEV` **or** the page URL has the `e2e` query
parameter (`new URLSearchParams(location.search).has('e2e')`), so the production build can be driven by the e2e and
perf scripts. Update the JSDoc of `Window.patrol`.

`scripts/perf.mjs` (Node, no new dependency; Playwright from `/opt/node-tools/node_modules/playwright` like
`scripts/smoke.mjs`): unless `PERF_NO_BUILD=1`, run `npx vite build`; start `npx vite preview --port 4174 --strictPort`;
launch Chromium (`--use-gl=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`, plus
`--enable-precise-memory-info`); open `/?e2e`; new game (seed 4242, `app.indoorScenes = true`), wait for streaming;
read `app.profiler` (the integrator wires it, §19.3); when it is missing (before integration) fall back to sampling
`app.systems.timings` every frame through `requestAnimationFrame` in the page and say so in the output; complete the
station flow (as `smoke.mjs` phase 7 does), seat the officer in
P-101, `timescale 8`, drive a scripted loop (hold `KeyW`, steer periodically) for `PERF_MINUTES` (default 4) real
minutes; CDP session: `HeapProfiler.enable`, at checkpoints t = 0.5, 1/3, 2/3 and the end of the run call
`HeapProfiler.collectGarbage` twice then `Runtime.getHeapUsage` and `Memory.getDOMCounters`; with `PERF_SNAPSHOT=1` also
`HeapProfiler.takeHeapSnapshot` at the first and last checkpoint (stream the chunks to
`$TMPDIR/patrol-heap-<n>.heapsnapshot`) and print the size and node count of both. Output: per-system rows from
`app.profiler.report()`, frame phases, draw calls, heap per checkpoint, DOM counters; writes
`docs/perf/browser-profile.json`; exits 1 when the heap after GC grows more than 25 % or 40 MB between the second and the
last checkpoint, when DOM nodes or JS event listeners grow more than 20 % between them, or on any console error.

### 9.4 Hot-spot fixes and documentation

Run the Node profile (`PATROL_LONG=1 npx vitest run test/perf/longShift.test.ts`) and `node scripts/perf.mjs` (after
the integrator wired `app.profiler`; before that use the dev server and the existing `systems.timings`). For the top
three systems by total time inside your ownership (`traffic`, the loop, the registry, mesh sync; the baseline measured
for this design in Node: physics 0.29 ms, traffic 0.28 ms, vehicles.pre 0.05 ms, npc 0.04 ms per step, 0.81 ms per
step overall) remove per-step allocations and redundant work (e.g. repeated route / lane lookups, `Map` iteration in
hot loops, `performance.now` pairs per system that can be replaced by one clock read per boundary). Every optimization
must keep `test/game/**` passing unchanged (bit-identical saves). Hot spots outside your files go to the integrator as a
list in your final report (file, function, measured cost, suggested fix). Write `docs/PERFORMANCE.md`: method (Node and
browser), the measured tables (before and after your fixes), the memory results, the budget of §16 and how to run
(`npm run perf:node`, `npm run perf` — the release module adds these scripts).

## 10. Legal engine and CAD test audit [legalcad] — wave 1

Owns: `src/legal/**`, `src/data/legal/**`, `src/cad/**`, `src/data/cad/**`, `test/legal/**`, `test/cad/**`. Must keep
green (run): `test/incidents`, `test/court`, `test/conduct`, `test/dispatch`, `test/mdt`. Source changes only to fix
bugs the new tests expose (each fix gets a regression test and a line in your final report); no behaviour change
otherwise (rulings of existing fixtures stay identical).

New tests (all mandatory):
1. `test/legal/exportAudit.test.ts` and `test/cad/exportAudit.test.ts`: list every value export
   (`export function|const|class`) of `src/legal/*.ts` / `src/cad/*.ts` (regex over the source, skip `index.ts` and
   `events.ts`) and assert each name occurs as a whole word in at least one other test file of `test/legal` /
   `test/cad`. Today unreferenced (write tests that use them): legal `CONSENT_KINDS`, `CLAIMED_BASES`, `SEARCH_TARGETS`,
   `INDICATOR_SOURCES`; CAD `ADDRESS_MAX_DISTANCE`, `canAssign`, `plateRunNarrative`, `callDetail`, `STATUTE_CATEGORIES`,
   `STATUTE_CLASSES`, `POI_LOCATION_KINDS`, `VIOLATION_MAP`, `PLATE_MAP`, `findStatute`, `DOC_KINDS`, `DOC_ID_FORMAT`,
   `PERSON_ROLES`, `EVIDENCE_CATEGORIES`, `CUSTODY_ACTIONS`, `emptyCounters`, `knownPerson`, `isCadDocument`,
   `isDocumentsSave`, `isObj`, `isNum`, `isInt`, `isStr`, `isBool`, `isOneOf`, `isArrayOf`, `isStrArray`,
   `isIntArray`, `isCadTime`, `isNullOr`, `REQUEST_VIAS`, `CALLER_KINDS`, `CALL_STATUSES`, `STOP_ACTIONS`,
   `STOP_OUTCOMES` (re-run the audit to confirm the list).
2. `test/legal/corpus.ts` + `test/legal/ruleCoverage.test.ts`: a corpus of hand-built `IncidentLog`s (use
   `test/legal/helpers.ts`) with at least one scenario per rule; for each shipped ruleset (`generic`, `strict`) every
   `ruleset.rules[].id` occurs in the `ruleIds` of some determination, evidence, force or pursuit ruling of the corpus
   evaluated with that ruleset. A rule that the engine cannot produce is a bug: fix it or, if the rule is intentionally
   unreachable for one ruleset, assert that explicitly with the reason.
3. `test/legal/doctrineMatrix.test.ts`: for each `DOCTRINES` entry the corpus yields at least one `lawful` and one
   `unlawful` determination under `generic` (and for `strict` where the rule exists); exemptions listed with reasons.
   Plus strict-vs-generic differences: at least three corpus scenarios lawful under `generic` and not under `strict`
   (e.g. Gant vehicle search, consent with a weapon drawn, pursuit speed).
4. `test/legal/property.test.ts`: 200 seeded random logs per ruleset (`createRng('legal-prop')`, a generator that emits
   well-formed events of every `INCIDENT_EVENT_KINDS` kind with monotone `t` and ids, persons 1..3): `evaluateIncident`
   never throws; is deterministic (deep-equal twice); every determination / ruling references event ids present in the
   log; `summary` counts equal recounts of the arrays; every suppressed evidence ruling has `taintedBy` equal to an
   event id of the log; evaluating a prefix of a log never produces a determination for an event outside the prefix;
   `buildReportChoices` is deterministic and every `key` choice has truth `true`; runtime of 600-event logs < 5 ms each.
5. `test/cad/stateMachine.test.ts`: every pair (from, to) of `UNIT_STATUSES` through the `CadState` API, asserting the
   allowed table (derive it from `cadState.ts`; write it out in the test so a change is visible), the call lifecycle
   (create -> assign -> enRoute -> onScene -> close with each disposition of `dispositions.json`), `canAssign` for
   closed calls, out-of-service units and double assignment, closed-call cap (200) and id monotonicity.
6. `test/cad/fuzz.test.ts`: 2 000 seeded random operations (create, assign, unassign, status, note, close, document
   save, traffic stop start / end) on one `CadState`; after each operation: a unit's call is open or null, no closed
   call has assigned units, ids unique and increasing, serialize -> restore round trip deep-equals, `isDocumentsSave`
   holds for the documents block.
7. `test/cad/documents.test.ts` additions: every `DOC_KINDS` kind formats ids per `DOC_ID_FORMAT`, `isCadDocument`
   accepts a valid document of each kind and rejects each missing / mistyped field; `findStatute` finds every statute of
   `statutes.json` and returns null for an unknown id; `codeText` for every ten-code in both radio modes;
   `plateRunNarrative` per readback severity.

Report: the number of tests added per file and the before / after count of `test/legal` and `test/cad`.

## 11. Release: e2e, build, docs [release] — wave 2

Owns: `scripts/e2e.mjs` (new), `README.md`, `docs/ARCHITECTURE.md`, `docs/ASSETS.md`, `package.json` (scripts only),
`vite.config.ts`. Imports no TypeScript.

### 11.1 Package scripts and build

`package.json` scripts: `"e2e": "node scripts/e2e.mjs"`, `"perf": "node scripts/perf.mjs"`,
`"perf:node": "PATROL_LONG=1 vitest run test/perf/longShift.test.ts test/perf/memory.test.ts"`,
`"test:long": "PATROL_LONG=1 vitest run test/perf"`. `vite.config.ts`: `build.rolldownOptions.checks = { bundlerTimings:
false }` (the `[PLUGIN_TIMINGS]` note is informational and makes the build output look unclean; verified option name:
rolldown `InputOptions.checks.bundlerTimings`, boolean, default true). `npx vite build` must then print no line with
`(!)`, `warning` or `PLUGIN_TIMINGS`.

### 11.2 `scripts/e2e.mjs` (the done-when flow, exactly)

Structure like `scripts/smoke.mjs` (copy its helpers `loadPlaywright`, `waitForServer`, `waitFor`, `press`,
`waitFrames`, `check`, the console watcher, and the scripted-stop helpers `phase5Flow` / `stepSim` of its Phase 5
section; do not import from smoke.mjs). Steps:

1. Build: `npx vite build` (skip with `E2E_NO_BUILD=1`); fail when the output has `(!)` or `warning` lines.
2. `npx vite preview --port 4173 --strictPort` (override `E2E_PORT`); wait for it; Chromium with SwiftShader flags,
   viewport 1280x720; open `http://localhost:4173/?e2e`; wait for `window.patrol`; collect console errors, page errors
   and app warnings (ignore `GL Driver Message`).
3. **Create an officer**: title screen *Create officer...* button -> character creator (`ui.top.id ===
   'character-creator'`) -> set first / last name, badge, pronouns through `dispatch` (as smoke phase 7) -> `done()`;
   assert `mainMenu.character.profile.lastName`.
4. **Start a shift**: seed box `4242`, *New game*; wait for streaming; assert `session.officer.name` and the locker
   room start; complete the station flow (armory sign-out of sidearm and TASER, steps locker / briefing / armory /
   garage through `station.request`, as smoke phases 5 and 7).
5. **Customize a patrol car and drive it**: fleet panel with the real key (`Quote`), check out a patrol unit (S-201 as
   in smoke phase 7, or P-102), *Customize*
   -> livery editor: add a text layer, a stripe / shape layer and change the siren tone; *Save*; assert
   `session.fleet.livery(unit).layers.length` grew and the equipment tone changed; seat the officer in that unit's
   vehicle (`session.enterVehicle(session.unitVehicle(unit))` + `app.rig.setVehicle`), hold `KeyW` for 3 s real time
   with `timescale 2`: assert the speed rose above 10 km/h and the car moved more than 10 m.
6. **Receive a call (CAD)**: with the console `cad call <type> here` or the dispatcher offer (`dispatch call`), accept
   it with the real radio keys (`KeyT`, then the Accept digit) or the MDT; assert `cad:unitAssigned` reached the player
   (CAD unit `callId`).
7. **Resolve it on scene -> report -> court**: run the scripted traffic stop of smoke Phase 5 (stage 1: speeding car,
   ID, odor, consent PBT; stage 2: arrest, rights, booking, call cleared) or an equivalent call flow; the MDT report
   form with the true statements ticked, submit, assert a graded report (`conduct.reportGrade(docId).score > 0`); court:
   `court advance <case>`, attend through the MDT Career tab, answer with the real keys (Enter, digits, Enter), assert a
   verdict (`court.case(id).verdict != null`). If every case was settled by a plea, the script must create a contested
   case another way (book a second offense or choose a not-guilty plea through the court API) — the e2e must reach a
   verdict.
8. **Call backup**: radio keys `KeyT`, `Digit4` (Request), `Digit2` (priority backup); assert a `dispatch:backup` /
   an AI unit assigned to the player's call within 20 s real time at `timescale 4` and its arrival or en-route status.
9. **Save / load**: Escape -> pause menu *Quick save* (button) -> wait for `save:completed`; *Quit to title*;
   *Continue* the `quicksave` slot (button in the save list) -> wait for the session; assert officer name, livery
   layers, the closed call in the CAD, the graded report, the court verdict and the career stats survived.
10. Assert **zero console errors** and zero app warnings; print `E2E PASSED` and exit 0, else list failures and exit 1.
    Always stop the preview server (process group kill like smoke.mjs). Total runtime target < 10 min under SwiftShader.

### 11.3 Docs

- `README.md`: rewrite as the release README with sections **Overview** (what Patrol is; generic, procedural content),
  **Requirements**, **How to run** (`npm install`, `npm run dev`, `npm run build`, `npm run preview`, open
  `/?e2e` only for automation), **Controls** (the full table from the current README + the radio cursor, gamepad menu
  navigation, tutorial), **Game modes** (guided first shift, free patrol, career, training, co-op), **Architecture**
  (a summary of `docs/ARCHITECTURE.md`: module map, fixed step and frame order, determinism, workers, save versions,
  link), **Modding** (summary + link to `docs/MODDING.md`), **Multiplayer** (server, roles, limits, link to
  `server/README.md`), **Testing** (`npm run check`, `npm test`, `npm run smoke`, `npm run e2e`, `npm run perf`,
  `npm run perf:node`, `npm run test:long`; where tests live), **Performance notes** (budget table summary, link to
  `docs/PERFORMANCE.md`), **Accessibility** (text scale, palettes, reduced flash, captions, one-handed layouts, gamepad
  navigation), **Assets and licensing** (no third-party assets; everything procedural), **Docs** index (all design docs
  phase 1-9).
- `docs/ARCHITECTURE.md`: a "Polish and release (Phase 9)" section (audio graph and buses, VFX and the glow sink,
  UI tokens and navigation, tutorial runner and its step order, profiler, e2e / perf tooling, save v11) and the
  directory-layout lines for `src/tutorial`, `src/render/vfx`, `src/ui/tutorial`, `src/debug/profiler.ts`,
  `scripts/e2e.mjs`, `scripts/perf.mjs`; update "Save" with v11.
- `docs/ASSETS.md`: final: the table states "none"; add a section "Procedural content" listing what is generated in code
  (all audio: sirens, engines, tires, ambience, radio FX and chatter, UI sounds; textures: windows, livery atlases;
  meshes) and the rules (no real agencies, brands, game assets).

## 12. UI structure

| Surface | Owner | Opens on | Pauses |
|---|---|---|---|
| Guided first shift button | tutorial (`mainMenu.ts`) | title screen | – |
| Tutorial card (HUD) | tutorial (`TutorialCard`) | tutorial active, non-ack step | no |
| Tutorial dialog | tutorial (`TutorialDialog`) | ack steps (welcome, done) | yes |
| Pause menu *Skip tutorial step* / *End tutorial* | integrator (`game/pauseMenu.ts`) | tutorial active | yes |
| Settings: Ambience volume, Interface sounds volume, Effects | ui (field table) | settings | yes |
| Radio menu cursor highlight | ui (`RadioMenuView`) | radio menu open | no |
| Focus ring, gamepad navigation in every menu | ui (`UIRoot`, `GamepadNav`) | any menu | – |
| Perf overlay: top systems | perf (`PerfOverlay`) | F3 | no |

## 13. ECS components and event topics

No new components in `src/ecs/components.ts`: audio, VFX, UI and profiler state are presentation objects; the tutorial
is a plain object system. Topics: §4.3. Integrator bridges (presentation bridges run in bus handlers; simulation bridges
only enqueue):

| From | To |
|---|---|
| `TUTORIAL_TOPICS` (each) | `tutorial.onEvent(topic, payload)` (enqueue) |
| `tutorial:flash` | HUD flash line |
| `tutorial:done` | HUD flash ("Tutorial complete" / "Tutorial ended"), card hidden |
| `force:applied` (player) tool `firearm` / `lessLethal` | `vfx.muzzle` at the officer (y 1.4) along the aim; hit -> `vfx.burst('dust', target...)` |
| `force:applied` tool `taser` | `vfx.burst('taser', officer)`; while `force.hud.attached` each frame `vfx.arc(officer hand, target chest)` else `vfx.arc(null)` |
| `npc:attack` kind `fire` | `vfx.muzzle` at the actor |
| `vehicle:damaged` | `vfx.burst('spark', impact point, intensity = clamp(impactSpeed / 15))` + `burst('dust', ...)`; impact point = vehicle position + zone direction (front / rear: ±length / 2 along forward; left / right: ±width / 2 along right), y 0.5 |
| `traffic:collision` (impactSpeed > 3) | `vfx.burst('spark', car position, clamp(impactSpeed / 15))` |
| driven car on gravel / dirt / sand / grass at > 5 m/s | `vfx.burst('dust', rear wheels, 0.3)` at most 10 Hz |
| `UIRoot.onUiSound` | `audio.ui.play(kind)` |
| HUD `flash()` | `ui.sound('notify')` (the UiSounds rate limit protects against bursts) |

## 14. Step order, frame order, determinism, workers

| Order | System | Work |
|---|---|---|
| **-651** | **`tutorial`** | `TutorialRunner.step()` (only when a tutorial is active) |

Frame (`App.update`), additions in order: after `input.update()`: `gamepadNav.update(now)`; after the car renderer:
`vfx.update(camera, dt, night, fogDensity, rain)` (the glow sink is fed during `CarRenderer.update`);
`propRenderer.setWind` (people presenter); `streamer.setWetness` (WorldView); `envRenderer.setEffects` on settings
change; audio after the HUD inputs: listener velocity, emitters with velocity, `vehicles.update`, `ambience.update`;
the tutorial card and dialog after the HUD (revision-driven). Render: `profiler.frame('render', ms)`; the loop's
`simMs` and the update time go to `frame('sim')` / `frame('update')`.

**Determinism.** The only new simulation state is the tutorial: its runner steps at -651, takes bus events through a
queue that is saved, and its probes read simulation state. With no tutorial active nothing changes: every Phase 1-8
fixture stays bit-identical (the integrator's test asserts it). The profiler only reads clocks. Audio, VFX, UI and
navigation never write simulation state.

**Workers.** None added. Audio runs on the audio thread (Web Audio); VFX runs in shaders with per-frame uniform writes;
profiling and the tutorial are O(systems) / O(1) per step. Moving any of this to a worker would add transfer latency for
no gain. The existing chunk and sim workers are unchanged.

## 15. Save schema v11 (integrator only)

```ts
export interface SaveGameV11 extends SaveGameV10 {
  tutorial: TutorialSave | null;   // §8.2; null = no tutorial in this game
}
```
`CURRENT_SAVE_VERSION = 11`. `migrateV10ToV11(data)`: `tutorial: null`. `isSaveGameV11` = v10 checks + (`tutorial ===
null || isTutorialSave(tutorial)`). Load order: ... -> career -> world -> mode -> **tutorial** (a runner is created when
the block is non-null and not done) -> radio. The rollover (`rolloverSave`) keeps the block as is. Tests (`test/save`):
v1..v10 -> v11 migrate and validate; v11 round trip with a mid-tutorial block; malformed tutorial blocks rejected.

## 16. Performance budget (60 FPS, mid-range desktop)

| Subsystem | Budget | Notes |
|---|---|---|
| Whole fixed step (Node, idle patrol) | mean <= 1.5 ms, p95 <= 4 ms | measured 0.81 ms mean before Phase 9 |
| tutorial step | <= 0.005 ms idle; <= 0.05 ms on an event | queue <= 64 |
| profiler | <= 0.0005 ms per record | no allocation |
| audio per frame (main thread) | <= 0.1 ms | AudioParam writes only; nodes built once at unlock |
| audio graph | <= 120 live nodes steady (+ <= 3 chirps, <= 3 chatter bursts, UI tones) | |
| VFX per frame | <= 0.3 ms CPU, <= 6 draw calls | glow 512, cones 32, particles 2 048 |
| rain splashes | 1 draw call, GPU only | draw range by rain |
| UI | menus rebuild on change; HUD 10 Hz, tutorial card on revision; gamepad nav O(1) per frame | |
| CSS | no animation, no backdrop filter on live layers | reduced-flash audit stays green |
| Draw calls total (smoke scene) | <= 300 cap, target <= 200 | Phase 8: 48 |
| Memory | heap after GC: churn < 12 MB over 4 sessions, long run plateau < 16 MB per hour of game time (Node); browser < 25 % | |
| Build | `vite build` without warnings; app chunk < 3 MB (rapier 4.3 MB separate) | |

## 17. Requirement map

| Requirement | Code |
|---|---|
| Sirens with Doppler (relative velocity) | `dopplerRatio`, `SirenEmitter.vx/vy/vz`, detune in `SirenBank`, `setListenerVelocity` (§5.2), emitter velocities (integrator §19.4) |
| Tire squeal by slip | `tireSlip`, `squealLevel`, `crunchLevel`, tire voice in `VehicleAudio` (§5.4) |
| Engine sound by RPM | `engineProfileFor`, `firingHz`, `engineCutoffHz`, driven + traffic voices (§5.4) |
| Ambient city beds per district / time / weather | `ambience.json`, `ambienceGains`, `AmbienceBed` (§5.5) |
| Layered radio chatter | `RadioFx.chatter` / `setBed`, `RadioPlayer` layering (§5.6) |
| UI sounds | `UiSounds` (§5.7), `UIRoot.onUiSound` (§7.3) |
| Synthesized / procedural only; volume settings respected | oscillators + seeded noise; five buses, `setVolumes`, settings `audio.ambience` / `audio.ui` (§5.1, §5.8, §7.6) |
| Rain splashes / wet sheen | `createSplashes`, `CityMaterials.setWetness` (§6.5) |
| Light bar glow / bloom, cheap, reduced flash | `GlowSink` + `GlowSprites` + `LightPools` (§6.2) |
| Headlight cones | `HeadlightCones` (§6.3) |
| Muzzle / taser effects | `VfxSystem.muzzle`, `burst('taser')`, `arc` (§6.4) + bridges (§13) |
| Dust / sparks on collisions | `burst('spark' / 'dust')` + bridges (§13) |
| Scene tape flutter | tape ribbon shader, `PropRenderer.setWind` (§6.6) |
| Consistent styling MDT / CAD / menus / HUD | tokens and stylesheet refactor (§7.1), `cssAudit` (§7.2) |
| Readable at all text scales | em units, panel / HUD widths, audit rule 1 and 5, smoke text-scale overflow check (§19.8) |
| Colorblind-safe | `contrast` tests per palette, non-colour cues on HUD chips (§7.2, §7.7) |
| Keyboard and gamepad navigation everywhere | `UIRoot.moveFocus`, `GamepadNav`, menu key audit, radio cursor (§7.3-§7.5) |
| Tutorial: guided first shift (driving, radio, CAD, traffic stop, report) | `firstShift.json`, `TutorialRunner`, card / dialog, title button (§8), save v11 (§15) |
| CPU time per system across a long shift in Node and the browser | `SystemProfiler`, `test/perf/longShift`, `scripts/perf.mjs` (§9) |
| Fix hot spots | §9.4 (+ integrator list) |
| No memory growth over a long session (heap snapshot comparison) | `test/perf/memory`, CDP heap usage / snapshots in `scripts/perf.mjs` (§9.2, §9.3) |
| Document results | `docs/PERFORMANCE.md`, `docs/perf/*.json` (§9.4) |
| Automated legal engine and CAD tests (audit coverage) | §10 |
| Production build clean | §11.1 |
| README with architecture docs | §11.3 |
| docs/ASSETS.md final | §11.3 |
| Done-when e2e (vite preview, officer, shift, calls end to end, backup, customized car, save / load, zero errors) | `scripts/e2e.mjs` (§11.2), `?e2e` hook (§9.3) |

## 18. Modules, ownership and waves

| Key | Wave | Owns (exclusively) | May import (new Phase 9 code) |
|---|---|---|---|
| audio | 1 | `src/audio/**`, `src/data/audio/**`, `src/radio/player.ts`, `test/audio/**`, `test/radio/player.test.ts`, `test/radio/chatter.test.ts` | none |
| vfx | 1 | `src/render/vfx/**`, `src/data/vfx/**`, `src/render/vehicles/carRenderer.ts`, `src/render/people/propRenderer.ts`, `src/world/render/cityMaterials.ts`, `src/world/render/chunkStreamer.ts`, `src/environment/render/**`, `test/vfx/**`, `test/vehiclerender/**`, `test/cityrender/**` | none |
| ui | 1 | all existing `src/ui/**/*.css`; `src/ui/**/*.ts` except `src/ui/mainMenu.ts` and `src/ui/tutorial/**`; `src/ui/gamepadNav.ts`; `src/input/**`; `src/settings/**`; `src/a11y/**`; `src/data/a11y/**`; `src/radio/controller.ts`; `test/ui9/**`, `test/a11y/**`, `test/input/**`, `test/settings/**`, `test/radio/controller.test.ts`, `test/radio/cursor.test.ts`, `test/panels/**`, `test/mdt/**`, `test/hud/**`, `test/dialogueui/**`, `test/courtui/**`, `test/iaui/**`, `test/investigationui/**`, `test/stationui/**`, `test/uicareer/**`, `test/uimodes/**`, `test/ui6/**`, `test/ui7/**`, `test/review/**` | none |
| tutorial | 1 | `src/tutorial/**`, `src/data/tutorial/**`, `src/ui/tutorial/**`, `src/ui/mainMenu.ts`, `test/tutorial/**`, `test/mainMenu/**` | none |
| perf | 1 | `src/debug/**`, `src/ecs/systems.ts`, `src/core/loop.ts`, `src/traffic/**`, `src/render/meshSync.ts`, `src/main.ts`, `scripts/perf.mjs`, `docs/PERFORMANCE.md`, `docs/perf/**`, `test/perf/**`, `test/debug/**`, `test/ecs/**`, `test/core/**`, `test/traffic/**` | none |
| legalcad | 1 | `src/legal/**`, `src/data/legal/**`, `src/cad/**`, `src/data/cad/**`, `test/legal/**`, `test/cad/**` | none |
| release | 2 | `scripts/e2e.mjs`, `README.md`, `docs/ARCHITECTURE.md`, `docs/ASSETS.md`, `package.json` (scripts), `vite.config.ts` | none (scripts and docs only) |
| integrator | 3 | `src/app.ts`, `src/game/**`, `src/core/event-map.ts`, `src/ecs/components.ts`, `src/save/**`, `docs/PHASES.md`, `scripts/smoke.mjs`, `test/game/**`, `test/save/**`, and any file no module owns | all |

A module that needs a change in a file it does not own lists it for the integrator in its final report instead of
editing it. Same-wave modules never import each other's Phase 9 additions.

## 19. Integrator plan

1. **Save v11** (`src/save/**`, `test/save/**`): §15.
2. **Session** (`src/game/session.ts`, new `src/game/phase9.ts`): `NewGameOptions.tutorial?: string` (script id).
   `Phase9` holds the optional `TutorialRunner` (`newTutorialSave(id)` on a new game; the saved block on load when not
   done), registers system `tutorial` at -651, subscribes every `TUTORIAL_TOPICS` topic to `runner.onEvent`, and
   implements the ports: `playerCallsign` = `dispatcher.playerCallsign`; probes `speedKmh` = driven vehicle
   `telemetry.speedKmh` (0 on foot), `driving` = `session.driving`, `lightbar` = driven vehicle `lightbar`, `siren` =
   driven equipment siren on, `distanceToCallM` = distance from the player to the call's location (Infinity unbound);
   `createCall`: the POI (any kind) whose distance from the player is nearest to `(minM + maxM) / 2` within
   [minM, maxM] (else the nearest beyond minM), deterministic (no draw), then `dispatcher.createScriptedCall({ typeId,
   x, z }, t)` and offer it to the player unit the way generated calls are offered (or self-assign through
   `dispatcher.request(player, { kind: 'selfAssign', callId })` if no offer API exists — then step 6's text says the
   call is assigned). New game with a tutorial starts outside the station (`inStation: false`). `serializeGame` writes
   `tutorial: phase9.tutorial?.serialize() ?? null`.
3. **App** (`src/app.ts`):
   - `profiler = new SystemProfiler()`, `systems.setProfiler(profiler)`, `perf.setProfiler(profiler)`, loop phase
     times into `profiler.frame`; expose `app.profiler`.
   - `GamepadNav(input, { isMenuOpen: () => ui.isMenuOpen(), focusTarget: () => document.activeElement ??
     ui.top?.element ?? null, moveFocus: (d) => ui.moveFocus(d) })`, updated after `input.update()`.
   - `ui.onUiSound((k) => audio.ui.play(k))`; `flash()` also calls `ui.sound('notify')`.
   - `radioMenuView.show(state.menu, state.cursor)`.
   - Settings: `applyAudioSettings` passes `ambience` and `ui`; `graphics.effects` -> `vfx.setQuality`,
     `envRenderer.setEffects`; `accessibility.reducedFlash` -> `vfx.setReducedFlash`.
   - VFX: `vfx = new VfxSystem(scene)`; `carRenderer.setGlowSink(vfx.glowSink)`; `vfx.update(...)` after the car
     renderer; bridges of §13; `WorldView.update` gains wetness (`streamer.setWetness(weather.wetness,
     weather.snowCover)`); people presenter calls `props.setWind(renderTime, |wind|)`.
   - Audio (`updateAudio`): listener velocity = driven / controlled vehicle linear velocity (physics `linvel`) else
     (0, 0, 0); emitter velocity = (Transform - PrevTransform) * SIM_HZ for each emitter entity; `DrivenAudioState` from
     the controlled vehicle's telemetry (`engineProfileFor(model.control ?? 'car', model.body.style)`, `inCabin` = rig
     mode cockpit / hood or first person in the car); traffic sources from `session.traffic.view` (x, z, speed; y 0.6;
     reused objects); `AmbienceParams` from `city.districtAt` at the listener (`DISTRICT_NAMES`), `env.time.hour`,
     `env.weather` (kind, precipitation x (1 - precipSnow), |wind|), `officerBuilding >= 0`, in vehicle.
   - Tutorial presentation: `TutorialCard` in the HUD and `TutorialDialog` (ack -> `runner.ack()`, end ->
     `runner.end()`), label lookup = `keyLabel(bindings[action][0])`; main menu `tutorial` callback ->
     `newGame(seed, jurisdiction, character, { tutorial: 'firstShift', inStation: false })`; pause menu buttons *Skip
     tutorial step* / *End tutorial* while active; console `tutorial [status|skip|end|start]`.
   - Perf extras: `audio` line adds engine / traffic / ambience counts; `vfx` line (glows, cones, particles, draw calls).
4. **main / boot**: none beyond the perf module's `?e2e` hook.
5. **Determinism test** (`test/game/phase9.test.ts`): a tutorial run driven by scripted inputs (enter car, drive,
   lights, radio status request, the created call accepted, closed, a report document saved, a pulled-over car, a plate
   run, a warning) twice -> bit-identical v11 saves and `completed: true`; a v10 save loads with `tutorial: null` and
   plays on identically to Phase 8; a mid-tutorial save loads and finishes identically to the uninterrupted run; a
   free-patrol run with no tutorial gives the same save as before Phase 9 except for `version` and `tutorial: null`.
6. **Smoke** (`scripts/smoke.mjs`), Phase 9 section (`SMOKE_ONLY=9`): the tutorial from the title button through the
   first 5 steps with the real keys and the rest skipped, screenshot `phase9-tutorial.png`; a night drive with the light
   bar (glow and cones visible: `vfx.stats.glows > 0`, `cones > 0`) in rain (splashes, wetness), screenshot
   `phase9-night-rain.png`; a TASER and a firearm application (particles), a crash (sparks); audio stats after a
   synthetic gesture (engine voice active, ambience layers > 0); gamepad navigation with a fake
   `navigator.getGamepads` (pause menu: down, A -> Settings; B closes; radio menu cursor D-pad down + A sends the
   status menu); text scale 1.6: no horizontal overflow (`scrollWidth <= clientWidth + 1`) of the title screen,
   settings, pause menu, MDT and the HUD lines; each colour-vision palette applied without console errors; draw calls
   within the cap; zero console errors.
7. **Verification**: `npm run check`, `npm run build` (clean), `npm run smoke`, `npm run e2e`, `npm run perf:node`,
   `npm run perf` (record the numbers in `docs/PERFORMANCE.md` if they changed), fix the hot spots the perf module
   listed in integrator files.
8. **Docs**: `docs/PHASES.md` Phase 9 entry (completed list, how to run, controls, manual checklist, performance,
   known limitations), event-map header comment (tutorial topics are declared in `src/tutorial/events.ts`), and any
   correction of `docs/ARCHITECTURE.md` after integration.

## 20. Known limitations and later hooks

- No full-screen bloom: glow sprites and ground light pools approximate it; no shadowed headlight volumes.
- Doppler uses detune on the synthesized siren and horn oscillators; panning stays `equalpower` (HRTF costs more).
- Ambience is layered noise and tones; there are no recorded voices or crowds. Radio chatter is unintelligible babble
  by design (TTS speaks the real lines).
- Gamepad cannot type free text; MDT forms keep their prefilled fields and the tutorial texts say so.
- The tutorial covers the core loop only; later systems (interiors, force, pursuits, command) keep their HUD hints.
- Performance numbers under headless SwiftShader measure CPU-side work and draw calls, not GPU frame time.
