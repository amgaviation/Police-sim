# Patrol: build summary

**Status:** all 9 phases are complete, verified and pushed to branch `claude/peaceful-bardeen-tn23af`. The final code is the commit "Phase 9: Polish and Release".

## Verification (final run)
- `npm run check`: typecheck and lint are clean, and all **8,045 tests** pass (560 files).
- `npm run build`: the production build succeeds with no warnings.
- `npm run e2e`: **48 checks** pass against the production build (`vite preview`). The run covers the full "done-when" flow: create an officer, start a shift, take a call through dispatch → scene → report → court, call backup, drive a customized patrol car, then save and load. It had **zero console errors**.
- `npm run smoke`: **334 checks** pass with zero console errors. One timing-sensitive traffic-stop step failed once under machine load and passed on the rerun.

## Play it

**GitHub Codespaces (browser):**
```sh
gh codespace create -R amgaviation/police-sim -b claude/peaceful-bardeen-tn23af -m basicLinux32gb && gh codespace code --web -R amgaviation/police-sim
```
The codespace builds the newest completed phase and serves it on port 4173, which opens in a new tab. If it doesn't, open the **Ports** panel and click the globe icon next to 4173.

**Cost:** Codespaces usage counts against your GitHub quota and is billed past the free tier, so stop the codespace when you're done.

**Locally (Node 22+):** `bash scripts/demo.sh`, then open http://localhost:4173. For development, use `npm ci && npm run dev` and open http://localhost:5173.

**Co-op (local network only):** start the server with `npm run server`. Configuration comes from environment variables only, and nothing is deployed.

## What was built
| Phase | Contents |
|---|---|
| 0 Foundation | Fixed-timestep loop, entity system (bitECS), Rapier physics, seeded RNG (same seed = same shift), rebindable keyboard/mouse/gamepad input, versioned IndexedDB saves with migrations, settings, debug console, perf overlay |
| 1 World & Driving | About 52 km² streamed procedural city with 9+ districts; road graph with signals, school and work zones; day/night; rain, fog, snow and heat haze; vehicle physics (grip by surface, ABS, brake fade, fuel, damage, flat tires); traffic AI that breaks the law |
| 2 Vehicle, MDT, CAD, Radio | In-car laptop, siren tones, light-bar patterns, spotlight, cage, gun rack, trunk; full dispatch system (CAD) with live map of units; deterministic person and vehicle records (warrants, flags, stolen/cloned/expired plates); reports, citations, bookings, evidence log; ten-code and plain-language radio, 6 channels, text-to-speech dispatcher, emergency button; optional voice commands |
| 3 People & Calls | Persistent people, pedestrians, 10 behavior types, dialogue driven by tone, lie detection, DUI tests, 163 data-driven call types (escalation, false, duplicate, swatting, ambush) |
| 4 Interiors & Scene Work | Enterable buildings, tactical movement, flashlight, sound propagation, evidence markers, photos, fingerprint dusting, scene tape, chain of custody, canvass, K9; station (locker, briefing, armory, evidence room, cells, interview room) |
| 5 Law & Consequences | Swappable JSON legal rulesets, use-of-force model (including a conducted energy device), report grading, internal affairs, community trust, court cross-examination built from your own reports, bodycam/dashcam review |
| 6 Backup & Tactical | AI backup officers with personalities, 17 backup types arriving by road, supervisors, pursuits (PIT, spike strips, air unit), SWAT and negotiator, mass-casualty triage |
| 7 Fleet & Customization | Sedan to helicopter, boat and drone; livery editor with JSON export and import; loadouts; uniforms; character creator; maintenance |
| 8 Career & Multiplayer | Academy, promotions, shift bidding, fatigue, off-duty life, persistent world (reoffending suspects, premise history), mods, accessibility settings, sandbox and scenario editor, local co-op |
| 9 Polish & Release | Doppler sirens and synthesized audio, visual effects, UI and gamepad navigation pass, guided first shift, performance profiling, end-to-end test |

## Known limitations
- **60 FPS is unconfirmed on a real GPU.** The headless test browser renders in software at 1–5 FPS. The game's own CPU work fits the frame budget; check the frame rate on your hardware with F3.
- **Co-op shares only the dispatch system (CAD).** Each player simulates their own scene.
- **Simplified models.** Motorcycles and bikes can't lean or fall. The boat and helicopter are arcade models. The thermal view is a filter. There is no music or crowd audio.
- **Lighter review from Phase 3 on.** Phases 3–9 got at most 2 review rounds, and minor findings were skipped, so expect more small bugs there.
- **Per-phase details.** See `docs/PHASES.md` for per-phase details, controls and limitations. `README.md` has the architecture overview, controls, modding and testing.

## No pull request
The repository has only this branch and no `main`, so there is nothing to open a pull request against yet.
