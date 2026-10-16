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
npm run smoke      # headless Chromium smoke test; writes docs/screenshots/phase0.png
```

`npm run smoke` expects Playwright at `/opt/node-tools/node_modules/playwright` (falls back to a resolvable `playwright` package) and browsers at `$PLAYWRIGHT_BROWSERS_PATH` (default `/opt/pw-browsers`).

## In-game
- **New game** with a seed (blank = random); the same seed reproduces the same scene.
- **WASD** move, **Shift** sprint, mouse look (click the canvas to lock the pointer), **Esc** pause menu.
- **F3** perf overlay, **`** debug console (`help` lists commands).
- In dev builds the app is exposed as `window.patrol`.

## Docs
- `docs/ARCHITECTURE.md` — module layout and contracts
- `docs/PHASES.md` — per-phase log with manual test checklists
- `docs/research/` — verified API notes for the pinned libraries
