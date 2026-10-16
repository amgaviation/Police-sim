# Phase log

Each phase entry records: what was completed, how to run it, and what to test manually.

## Phase 0 — Foundation

Status: complete. Screenshot: `docs/screenshots/phase0.png` (taken by the smoke test).

### Completed
- ✅ Vite 8 + TypeScript 6 (strict, no enums) toolchain; `npm run check` (typecheck + lint + tests) and `npm run build` are clean.
- ✅ `core/`: typed EventBus + EventMap, leveled logger feeding the console, seeded xoshiro128** RNG with named streams and serializable state, GameClock (time scale, pause), fixed-timestep GameLoop with accumulator, sub-step cap and interpolation alpha.
- ✅ `ecs/`: bitECS 0.4 world wrapper, SoA Transform/PrevTransform/Velocity stores, tag components, SystemRegistry with ordering and per-system timings.
- ✅ `physics/`: Rapier 0.21 world mapped to entity ids (box/sphere/ground, kinematic and dynamic bodies, collision events, raycasts, `syncToEcs`).
- ✅ `input/`: action map, default keyboard/mouse/gamepad bindings, InputManager with edges, pointer lock, rebinding capture and serializable bindings.
- ✅ `save/`: IndexedDB wrapper, versioned SaveEnvelope + migrations, SaveManager (slots, list, delete, autosave), settings blob.
- ✅ `settings/`: typed settings schema with field table, migration, debounced persistence; live-applied render scale, shadows, FOV, text scale and bindings.
- ✅ `render/`: three.js Renderer (pixel ratio, shadows, resize, debug orbit camera), MeshRegistry with one instanced box pool and PrevTransform→Transform interpolation.
- ✅ `debug/`: perf overlay (fps, frame/sim ms, 1 % low, draw calls, entities, system timings, heap, worker ping) and a debug console with history/completion.
- ✅ `ui/`: menu stack, main menu (seed input, continue list, delete), settings menu with rebinding, pause menu.
- ✅ `workers/`: typed RPC client + module worker (`ping`, `echo`, `rng.sample`); worker RNG is verified against the main thread at startup.
- ✅ `game/`: deterministic demo scene (kinematic player box + 150 dynamic boxes from the `scene` RNG stream), third-person camera, save/load reconstruction, autosave every 60 s, console commands.
- ✅ Browser smoke test (`npm run smoke`) under headless Chromium/SwiftShader.

### How to run
```
npm install
npm run dev        # http://localhost:5173
npm run check      # tsc + eslint + vitest
npm run build      # production bundle in dist/
npm run smoke      # headless browser test + docs/screenshots/phase0.png
```

### Manual test checklist
1. Title screen shows; type a seed (e.g. `42`) and press **New game**. The same seed always produces the same pyramid and scatter.
2. Click the canvas to lock the pointer. **WASD** moves the blue player box, **Shift** sprints, mouse turns the camera; walking into the pile pushes boxes.
3. **F3** toggles the perf overlay; **`** (backquote) opens the console. Try `help`, `fps`, `entities`, `spawn box 20`, `timescale 0.25`, `pause`, `seed 7`, `settings set graphics.fov 100`, `worker ping`, `debugcam`.
4. **Esc** opens the pause menu (simulation pauses, boxes freeze); **Resume** or Esc again continues. **Quick save** writes slot `quicksave`.
5. From the pause menu open **Settings**: drag *Render scale*, *Field of view*, *Shadows* and *Text scale* and confirm they apply immediately; rebind a key under *Controls*; reload the page and confirm settings persisted.
6. **Quit to title** → the `quicksave` (and `autosave` after 60 s in game) slots are listed under *Continue*; loading restores the box positions and the player's facing.
7. Resize the window: the canvas follows without stretching.

### Known limitations
- Velocities are not persisted (schema v1 stores transforms only), so loaded boxes start at rest.
- The player is a box, not a character controller; there is no jumping, slopes or stairs.
- Under software GL (SwiftShader) the frame rate is ~10 fps and the loop hits its 5-sub-step cap; on a real GPU it runs at the display rate.
- The Rapier bundle (~4.3 MB) is imported statically; splitting it into a worker/dynamic import is Phase 1+ work.
