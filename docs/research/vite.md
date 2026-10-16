# vite — pinned 8.3.4

Sources:
- https://vite.dev/guide/ (Node requirement, scaffolding, scripts)
- https://vite.dev/guide/migration (Vite 7 -> 8: Rolldown/Oxc, rolldownOptions rename, build.target bump)
- https://vite.dev/blog/announcing-vite8 (released 2026-03-12; Rolldown single bundler)
- https://vite.dev/config/ (defineConfig, vite.config.ts, config bundled by Rolldown, --configLoader native)
- https://vite.dev/config/build-options (build.target default + browser list, minify 'oxc', outDir, assetsInlineLimit, rolldownOptions)
- https://vite.dev/config/worker-options (worker.format default 'iife', worker.plugins, worker.rolldownOptions)
- https://vite.dev/config/dep-optimization-options (optimizeDeps.exclude/include/rolldownOptions)
- https://vite.dev/config/shared-options (esbuild deprecated -> oxc)
- https://vite.dev/config/server-options (port 5173) and https://vite.dev/config/preview-options (port 4173)
- https://vite.dev/guide/cli (vite build / vite preview flags and defaults)
- https://vite.dev/guide/build (Browser Compatibility: syntax transforms only, no polyfills)
- https://raw.githubusercontent.com/vitejs/vite/main/docs/guide/features.md (Web Workers, WebAssembly sections, TypeScript compiler options)
- https://raw.githubusercontent.com/vitejs/vite/main/packages/vite/CHANGELOG.md (8.1.0 added direct .wasm ESM imports #21779; 8.3.4 dated 2026-10-08)
- https://raw.githubusercontent.com/vitejs/vite/main/packages/vite/src/node/plugins/worker.ts (worker type module only when worker.format==='es' in build)
- https://raw.githubusercontent.com/vitejs/vite/main/packages/create-vite/template-vanilla-ts/{package.json,tsconfig.json,index.html,src/main.ts,src/counter.ts,src/style.css,_gitignore} and src/index.ts renameFiles
- https://rolldown.rs/in-depth/tla-in-rolldown (TLA only emitted in esm format)
- https://oxc.rs/docs/guide/usage/transformer/lowering (TLA is warned, never lowered)
- https://rapier.rs/docs/user_guides/javascript/getting_started_js (compat packages, init())
- npm registry: npm view vite@8.3.4 (engines ^20.19.0 || >=22.12.0; deps rolldown ~1.2.12, lightningcss, postcss; esbuild now optional peer ^0.27||^0.28)
- npm registry: create-vite 9.2.1, @dimforge/rapier3d 0.21.0, @dimforge/rapier3d-compat 0.21.0, vite-plugin-wasm 3.6.0 (peer vite ^2..^8), vite-plugin-top-level-await 1.6.0
- https://github.com/Menci/vite-plugin-wasm README (supports Vite 2.x–8.x; worker.plugins config)
- Unpacked tarballs of @dimforge/rapier3d(-compat)@0.21.0 (inspected in scratchpad, not installed into the project)

## API notes

## Versions (npm registry, 2026-10-16)
- vite latest = 8.3.4 (published 2026-10-08). engines: node "^20.19.0 || >=22.12.0" -> Node v22.22.0 is fine. Vite 8.0 released 2026-03-12.
- vite 8.3.4 runtime deps: rolldown ~1.2.12, lightningcss ^1.33, postcss ^8.5. esbuild is NOT a dependency anymore (optional peer ^0.27||^0.28, only needed for build.minify:'esbuild' / cssMinify:'esbuild' / transformWithEsbuild).
- create-vite 9.2.1; typescript template pins "typescript": "~6.0.2".
- @dimforge/rapier3d 0.21.0 and @dimforge/rapier3d-compat 0.21.0 (both 2026-09-25).
- vite-plugin-wasm 3.6.0 (peer vite ^2||^3||^4||^5||^6||^7||^8). vite-plugin-top-level-await 1.6.0 (peer vite >=2.8).

## Bundler: Rolldown + Oxc (docs confirm; memory of esbuild/Rollup is wrong for 8.x)
- "Vite 8 uses Rolldown and Oxc based tools instead of esbuild and Rollup." Config compat layer auto-converts old options, but the canonical names are:
  - build.rollupOptions -> build.rolldownOptions (old name is a deprecated alias)
  - worker.rollupOptions -> worker.rolldownOptions
  - esbuild: {...} -> oxc: {...} (esbuild option deprecated, converted internally). oxc.target defaults to 'esnext' in dev; build.target wins in build.
  - optimizeDeps.esbuildOptions -> optimizeDeps.rolldownOptions
  - build.minify default is 'oxc' (type boolean | 'oxc' | 'terser' | 'esbuild'); 'esbuild' deprecated. CSS minified by Lightning CSS.
  - build.commonjsOptions is a no-op. output.manualChunks object form removed; function form deprecated in favor of Rolldown codeSplitting.
  - The config file itself is bundled with Rolldown (or `--configLoader native` to let Node 22.18+ run vite.config.ts directly).

## vite.config.ts (official shape)
```ts
import { defineConfig } from 'vite'

export default defineConfig({
  // or export default defineConfig(({ command, mode, isSsrBuild, isPreview }) => ({ ... }))
  build: {
    target: 'baseline-widely-available', // default; see below
    rolldownOptions: { /* RolldownOptions */ },
  },
  worker: {
    format: 'es',        // default is 'iife'; set 'es' for module workers / TLA in workers
    plugins: () => [],   // function returning NEW plugin instances; config.plugins does NOT apply to worker builds
  },
  optimizeDeps: { exclude: [] },
})
```
Also valid: `export default { ... } satisfies UserConfig` (import type { UserConfig } from 'vite').

## build.target / top-level await
- build.target default 'baseline-widely-available' = ['chrome111','edge111','firefox114','safari16.4','ios16.4'] (bumped in Vite 8 from Vite 7's chrome107/edge107/firefox104/safari16.0). Lowest allowed: 'es2015'. 'esnext' = minimal transpiling. Value must be a valid Oxc Transformer target.
- Vite "only handles syntax transforms and does not cover polyfills". The build WARNS (not errors) on syntax Oxc cannot lower.
- Top-level await: Oxc never lowers TLA (its lowering page lists TLA under ES2022 "warnings only"). Rolldown: "input containing TLA could only be bundled and emitted with esm format". Every browser in the default target supports TLA, so with the DEFAULT build.target and ESM output, TLA works with no plugin and no 'esnext' needed. You do NOT need vite-plugin-top-level-await for the main bundle on Vite 8. If you ever lower build.target below es2022 you'll get a warning, not a transform. In the vanilla-ts template, tsconfig "target":"es2023" / "module":"esnext" already permits TLA type-checking.
- Caveat: TLA inside a WORKER requires worker.format: 'es' (IIFE cannot contain TLA; Rolldown will error). See Workers.

## Web Workers (features.md, verbatim-level)
- Recommended syntax: `const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`. Detection ONLY works if `new URL()` is literally inside `new Worker(...)` and all options are static literals (no variables).
- Suffix syntax: `import MyWorker from './worker?worker'` -> `new MyWorker()`; `?sharedworker`; `?worker&inline` (base64 inline); `?worker&url` (URL string). Types come from "vite/client" (template tsconfig has "types": ["vite/client"]).
- Worker scripts may use ESM `import`; in dev this relies on browser module-worker support; in build it is bundled into a separate chunk.
- worker.format default is 'iife'. Source (plugins/worker.ts): in build, Vite emits `{ type: "module" }` only when worker.format === 'es'; otherwise it emits a classic worker and rewrites import.meta. For a TS game using module workers + TLA/WASM in workers, set `worker: { format: 'es' }`. Vite 8.0.x changelog: build.target is now applied to worker bundles; `define` forwarded to workers.
- worker.plugins must be a function returning fresh plugin instances (e.g. `plugins: () => [wasm()]`) because worker builds run in parallel Rolldown workers.

## WebAssembly
- Two built-in modes (no plugin): (1) direct ESM import `import { add } from './add.wasm'` — Vite >= 8.1.0 implements the WebAssembly/ES Module Integration proposal: it reads the binary's imports/exports, resolves the wasm module's own imports as specifiers relative to the .wasm file, instantiates, and re-exports named exports; this is an async module and "requires top-level await support". (2) `import init from './x.wasm?init'` -> `init(importObject?) : Promise<WebAssembly.Instance>`. Also `?url` + `WebAssembly.instantiateStreaming(fetch(url))`. In build, .wasm smaller than build.assetsInlineLimit (4096 bytes) is base64-inlined, otherwise emitted as an asset.
- TypeScript for direct .wasm imports: enable "allowArbitraryExtensions" (template tsconfig already does) and add `{name}.d.wasm.ts` next to the file.

### @dimforge/rapier3d-compat (recommended for this project)
- package.json: "exports": { ".": { types: ./dist/rapier.d.ts, import: ./dist/rapier.mjs, require: ./dist/rapier.cjs } }. dist/rapier.mjs is ~4.2 MB with the .wasm base64-inlined (contains the "AGFzbQ" magic); there is NO runtime .wasm fetch, so Vite needs no wasm plugin and no special config.
- rapier.d.ts: `export * from "./exports"; export default RAPIER;` and init.d.ts: `export declare function init(): Promise<void>;` ("Has to be called and awaited before using any library methods"). Both default and named `init` exist in the .mjs.
```ts
import RAPIER from '@dimforge/rapier3d-compat'   // or: import * as RAPIER from '@dimforge/rapier3d-compat'
await RAPIER.init()                               // TLA ok at default build.target (main thread) or in an 'es' worker
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
```
- Docs' alternative pattern: `RAPIER.init().then(() => run(RAPIER))` if you want to avoid TLA entirely.

### @dimforge/rapier3d (non-compat)
- Ships wasm-bindgen "bundler" output: rapier_wasm3d.js line 2 is `import * as wasm from "./rapier_wasm3d_bg.wasm";` plus rapier_wasm3d_bg.wasm (which itself imports from ./rapier_wasm3d_bg.js). package.json has only "module": "rapier.js" (no "main", no "exports"). Rapier docs: must be loaded async: `import('@dimforge/rapier3d').then(RAPIER => {...})`.
- Documented/safe path on Vite: vite-plugin-wasm 3.6.0 (README: "supports Vite 2.x to 8.x"):
```ts
import { defineConfig } from 'vite'
import wasm from 'vite-plugin-wasm'
export default defineConfig({
  plugins: [wasm()],
  worker: { format: 'es', plugins: () => [wasm()] },
  optimizeDeps: { exclude: ['@dimforge/rapier3d'] }, // README workaround if the dep optimizer chokes on .wasm
})
```
  vite-plugin-top-level-await is NOT required on Vite 8 unless you set build.target below es2022 or must keep worker.format 'iife'.
- Possible but UNCONFIRMED: because Vite 8.1+ natively resolves a .wasm module's imports relative to the .wasm file (exactly the wasm-bindgen layout), the non-compat package may work with zero plugins; I found no official statement covering node_modules deps + the Rolldown dep optimizer, so treat it as an experiment, not a plan.

## optimizeDeps.exclude
- `optimizeDeps.exclude: string[]` — "Dependencies to exclude from pre-bundling." Docs warn: "CommonJS dependencies should not be excluded"; if an excluded ESM dep has a nested CJS dep, add that CJS dep to optimizeDeps.include. Pre-bundling is dev-only (removed from build since 5.1). Dev pre-bundling now runs on Rolldown; `optimizeDeps.rolldownOptions` replaces esbuildOptions. For rapier3d-compat nothing needs excluding (pure ESM .mjs). For three/@types etc. nothing special.

## `npm create vite@latest <name> -- --template vanilla-ts` (create-vite 9.2.1, template-vanilla-ts on main)
Files: index.html, package.json, tsconfig.json, _gitignore (renamed to .gitignore by create-vite's renameFiles map), public/favicon.svg, public/icons.svg, src/main.ts, src/counter.ts, src/style.css, src/assets/hero.png, src/assets/typescript.svg, src/assets/vite.svg. There is NO src/vite-env.d.ts anymore (docs memory of `/// <reference types="vite/client" />` is outdated; tsconfig "types" replaces it) and no README.md.
package.json (verbatim):
```json
{ "name": "vite-typescript-starter", "private": true, "version": "0.0.0", "type": "module",
  "scripts": { "dev": "vite", "build": "tsc && vite build", "preview": "vite preview" },
  "devDependencies": { "typescript": "~6.0.2", "vite": "^8.3.4" } }
```
tsconfig.json (verbatim):
```json
{ "compilerOptions": {
    "target": "es2023", "module": "esnext", "lib": ["ES2023", "DOM"], "types": ["vite/client"],
    "allowArbitraryExtensions": true, "skipLibCheck": true,
    "moduleResolution": "bundler", "allowImportingTsExtensions": true, "verbatimModuleSyntax": true,
    "moduleDetection": "force", "noEmit": true,
    "noUnusedLocals": true, "noUnusedParameters": true, "erasableSyntaxOnly": true, "noFallthroughCasesInSwitch": true },
  "include": ["src"] }
```
index.html (verbatim): `<!doctype html><html lang="en"><head><meta charset="UTF-8" /><link rel="icon" type="image/svg+xml" href="/favicon.svg" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>Vite + TS</title></head><body><div id="app"></div><script type="module" src="/src/main.ts"></script></body></html>` — index.html lives at project root and is the dev entry; script src is root-absolute `/src/main.ts`.
src/main.ts imports './style.css', asset images (`import heroImg from './assets/hero.png'`), and `{ setupCounter } from './counter.ts'` (explicit .ts extension works thanks to allowImportingTsExtensions). Note Oxc transpiles without type info -> isolatedModules semantics (verbatimModuleSyntax/erasableSyntaxOnly enforce it: use `import type`, no enums/namespaces/parameter properties). Vite IGNORES tsconfig "target"; set oxc.target/build.target instead.

## CLI defaults
- `vite` (aliases dev/serve): server.port 5173, host 'localhost', --strictPort, --open, --force (re-bundle deps), --experimentalBundle.
- `vite build`: --target "baseline-widely-available", --outDir dist, --assetsDir "assets", --assetsInlineLimit 4096, --sourcemap false, --minify "oxc", --base /, --emptyOutDir (default true when outDir inside root), --watch, --app, --manifest. build.chunkSizeWarningLimit 500 kB. build.modulePreload { polyfill: true }.
- `vite preview`: serves the build dir (default dist) on preview.port 4173 (auto-increments unless strictPort); host/strictPort/open default to the server.* values; "Do not use this as a production server". Run `vite build` first.
- Static files in public/ are served at / in dev and copied verbatim to dist/ root (publicDir default "public").

## Gotchas

- Vite 8 renamed build.rollupOptions -> build.rolldownOptions and worker.rollupOptions -> worker.rolldownOptions; old names still work via a deprecated alias/compat layer but emit deprecation notices. Write the new names.
- The `esbuild` config key is deprecated in 8.x (auto-converted to `oxc`). esbuild is no longer installed by Vite; `build.minify:'esbuild'`, `cssMinify:'esbuild'` or `transformWithEsbuild` require adding esbuild as a devDependency.
- Worker detection requires `new URL('./x.ts', import.meta.url)` literally inside `new Worker(...)` with static (string-literal) options; a variable URL or computed options silently becomes a plain asset URL and no worker bundle is built.
- worker.format defaults to 'iife'. In the production build Vite only emits `{ type: 'module' }` for workers when worker.format === 'es'; IIFE workers cannot contain top-level await (Rolldown only emits TLA as esm). For module workers that `await RAPIER.init()` at top level, set `worker: { format: 'es' }`.
- worker.plugins must be a FUNCTION returning new plugin instances (`plugins: () => [wasm()]`); top-level `plugins` apply to workers only in dev, not in build.
- Top-level await: Oxc does not lower it and only warns if the target lacks it; the default build.target (chrome111/edge111/firefox114/safari16.4/ios16.4) supports TLA, so no 'esnext' and no vite-plugin-top-level-await is needed on Vite 8 unless you lower build.target below es2022.
- @dimforge/rapier3d-compat needs no wasm plugin: dist/rapier.mjs (~4.2 MB) base64-inlines the .wasm. You must `await RAPIER.init()` (returns Promise<void>) before any other call. Both `import RAPIER from` (default) and named `init` exist.
- @dimforge/rapier3d (non-compat) has only a `module` field (no `exports`/`main`), uses wasm-bindgen bundler output (`import * as wasm from './rapier_wasm3d_bg.wasm'`), and per Rapier docs must be dynamically imported. Documented Vite path is vite-plugin-wasm 3.6.0 (+ optionally optimizeDeps.exclude:['@dimforge/rapier3d']). Vite 8.1+ native .wasm ESM integration might handle it with zero plugins, but no official source confirms this for node_modules deps — do not rely on it.
- create-vite's current vanilla-ts template has NO src/vite-env.d.ts; it uses tsconfig "types": ["vite/client"] instead. Memory of `/// <reference types="vite/client" />` is outdated. If you hand-write tsconfig, keep "types": ["vite/client"] or `?worker`/asset imports will not type-check.
- Template tsconfig enables verbatimModuleSyntax + erasableSyntaxOnly + moduleDetection 'force': use `import type` for type-only imports, avoid TS enums/namespaces/parameter properties (Oxc transpiles per-file without type info; isolatedModules semantics). Vite ignores tsconfig `target`.
- Template build script is `tsc && vite build` (single tsconfig.json with noEmit), not `tsc -b` with tsconfig.app.json/tsconfig.node.json — that project-references layout is from the framework templates, not vanilla-ts.
- Direct `.wasm` ESM imports (8.1+) in TypeScript need `allowArbitraryExtensions: true` (template has it) plus a `{name}.d.wasm.ts` declaration file.
- optimizeDeps.exclude: never exclude CommonJS deps; if an excluded ESM dep has a nested CJS dep, add that CJS dep to optimizeDeps.include. Pre-bundling is dev-only.
- Vite 8 changed CJS default-import interop (may break code importing CJS modules; `legacy.inconsistentCjsInterop: true` restores old behavior) and no longer sniffs `browser`/`module` fields — it follows resolve.mainFields order strictly.
- import.meta.url is no longer polyfilled in UMD/IIFE output (undefined) — another reason to use worker.format 'es' if worker code touches import.meta.
- `vite preview` is explicitly not a production server; it serves dist on port 4173 and auto-increments the port unless strictPort.

## Compatibility warnings

- Node v22.22.0 satisfies vite@8.3.4 engines ^20.19.0 || >=22.12.0 and create-vite@9.2.1 (same range). Node 22.18+ also allows `--configLoader native` for vite.config.ts.
- vite-plugin-wasm@3.6.0 declares peer vite ^2||^3||^4||^5||^6||^7||^8 and its README says Vite 2.x–8.x are supported; only needed for the NON-compat @dimforge/rapier3d. vite-plugin-top-level-await@1.6.0 (peer vite >=2.8) has no Vite 8/Rolldown notes and is unnecessary on Vite 8 at the default build.target.
- @dimforge/rapier3d-compat@0.21.0 and @dimforge/rapier3d@0.21.0 are the current versions; the compat package has an `exports` map (types/import/require) and works as plain ESM in Vite with no config.
- TypeScript ~6.0.2 is what create-vite 9.2.1 scaffolds; the template tsconfig uses TS 5.8+/6.x options (erasableSyntaxOnly, allowArbitraryExtensions), so do not pair this tsconfig with TypeScript < 5.8.
- Default build.target (Baseline Widely Available 2026-01-01: chrome111/edge111/firefox114/safari16.4/ios16.4) already supports top-level await, WebAssembly, module workers and SharedArrayBuffer syntax; no polyfills are generated. @vitejs/plugin-legacy is the only route to older browsers.
- Rolldown refuses to emit top-level await in non-esm output: IIFE workers (the default worker.format) cannot use TLA; choose worker.format 'es'.
