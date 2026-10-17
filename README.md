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
npm run smoke      # headless Chromium smoke test; writes docs/screenshots/phase1.png and phase1-night.png
```

`npm run smoke` expects Playwright at `/opt/node-tools/node_modules/playwright` (falls back to a resolvable `playwright` package) and browsers at `$PLAYWRIGHT_BROWSERS_PATH` (default `/opt/pw-browsers`).

## In-game
- **New game** with a seed (blank = random); the same seed generates the same city and the same shift. You start on foot at the police station door with two patrol cars in the lot.
- Click the canvas to lock the pointer; **Esc** opens the pause menu (quick save, settings, quit).

| | Keyboard / mouse | Gamepad |
|---|---|---|
| Move / sprint (on foot) | WASD / Shift | left stick / L3 |
| Look | mouse | right stick |
| Enter / exit vehicle, refuel at a pump | E | A |
| Throttle / brake (hold at a stop to reverse) | W / S (or arrow keys) | RT / LT |
| Steer | A / D | left stick |
| Handbrake | Space | B |
| Camera: chase, hood, cockpit | V | View |
| Headlights / light bar | H / L | D-pad up / X |
| Minimap zoom | M | D-pad down |
| Perf overlay / debug console | F3 / ` | |

Console (`help` lists everything): `time 21:00`, `weather rain|snow|fog|heat|auto`, `timescale 4`, `tp downtown`, `tp hospital`, `tp 1000 -1500`, `route hospital`, `road`, `car info|refuel|repair|spawn van`, `traffic list|stats|density 2|clear`, `plate ABC 1234`, `chunks`, `spawn box 20`, `save`, `load`.

In dev builds the app is exposed as `window.patrol`.

## Docs
- `docs/ARCHITECTURE.md` — module layout and contracts
- `docs/phase1-design.md` — Phase 1 (world and driving) design and module APIs
- `docs/PHASES.md` — per-phase log with manual test checklists and known limitations
- `docs/research/` — verified API notes for the pinned libraries
