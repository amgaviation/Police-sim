# vitest 5 + eslint 10 + typescript-eslint 8 + @eslint/js 10 + globals 17 + fake-indexeddb 6 (toolchain bundle for Vite+TS "Patrol"; per-package pins in apiNotes) — pinned 5.0.5

Sources:
- https://vitest.dev/guide/ (requirements: Vite >=6.4.0, Node >=22.12.0; `vitest run`)
- https://vitest.dev/guide/migration.html (Migrating to Vitest 5: requirements, changed defaults, removals)
- https://vitest.dev/config/ (vitest.config.ts vs vite.config.ts `test` block, /// <reference types="vitest/config" />, defineConfig from 'vitest/config')
- https://vitest.dev/config/environment (default 'node')
- https://vitest.dev/config/globals (default false; tsconfig types vitest/globals)
- https://vitest.dev/config/include (default glob)
- https://vitest.dev/guide/coverage (v8 default; requires @vitest/coverage-v8)
- https://vitest.dev/guide/cli (vitest / vitest run / --run / CI behaviour)
- npm registry: `npm view vitest@5.0.0 / @5.0.5 peerDependencies engines time` (vite ^6.4.0 || ^7.0.0 || ^8.0.0; node ^22.12.0 || ^24.0.0 || >=26.0.0; 5.0.5 published 2026-10-15)
- https://eslint.org/docs/latest/use/configure/configuration-files (defineConfig, globalIgnores, extends, files/ignores, config file names, jiti for .ts config)
- https://eslint.org/docs/latest/use/migrate-to-10.0.0 (Node >=20.19.0, eslintrc removed, config lookup from file, eslint:recommended additions)
- npm registry: `npm view eslint@10.13.0 engines exports` (node ^20.19.0 || ^22.13.0 || >=24; exports './config'; type commonjs; published 2026-10-16)
- https://typescript-eslint.io/getting-started/ (defineConfig + js.configs.recommended + tseslint.configs.recommended)
- https://typescript-eslint.io/getting-started/typed-linting/ (recommendedTypeChecked, projectService: true)
- https://typescript-eslint.io/packages/typescript-eslint/ (`config(...)` deprecated in favor of ESLint core defineConfig; parser/plugin re-exports)
- https://typescript-eslint.io/users/configs/ (disableTypeChecked example for **/*.js, eslintRecommended)
- https://typescript-eslint.io/packages/parser/ (projectService, allowDefaultProject, tsconfigRootDir: import.meta.dirname)
- https://typescript-eslint.io/users/dependency-versions/ (TypeScript >=4.8.4 <6.1.0; ESLint ^8.57.0 || ^9.0.0 || ^10.0.0; Node ^18.18.0 || ^20.9.0 || >=21.1.0)
- https://github.com/typescript-eslint/typescript-eslint/issues/12518 (TypeScript 7.0.2 Support — closed 'not planned'; no TS 7 API; use TS 6 side-by-side)
- https://github.com/eslint/eslint/issues/21070 (ESLint repos blocked on typescript-eslint TS7 support)
- npm registry: `npm view typescript-eslint@8.71.2 peerDependencies engines`, `@typescript-eslint/typescript-estree@8.71.2 peerDependencies` (typescript >=4.8.4 <6.1.0)
- https://github.com/eslint/eslint/blob/main/packages/js/README.md (@eslint/js: js.configs.recommended / extends ['js/recommended'])
- npm registry: `npm view @eslint/js@10.0.1 peerDependencies engines` (eslint ^10.0.0)
- https://github.com/sindresorhus/globals (globals.browser, globals.node)
- npm registry: `npm view globals@17.13.0 engines` (node >=18)
- https://github.com/dumbmatter/fakeIndexedDB (README: import 'fake-indexeddb/auto'; new IDBFactory() reset; no structuredClone polyfill since v5)
- https://github.com/dumbmatter/fakeIndexedDB/blob/master/CHANGELOG.md (6.0.0 DOMException; 6.2.x auto-entry fixes; 5.0.0 dropped Node 16)
- npm registry: `npm view fake-indexeddb@6.2.6 exports engines` (./auto has import+require conditions; node >=18)
- npm registry: `npm view typescript dist-tags time` (latest 7.0.2 published 2026-07-08; 6.0.3 published 2026-04-16; 5.9.3 published 2025-09-30)
- npm registry: `npm view vite@8.3.4 engines peerDependencies` (node ^20.19.0 || >=22.12.0; @types/node ^20.19.0 || >=22.12.0)

## API notes

## Verified pins (npm registry, 2026-10-16; Node v22.22.0 / npm 10.9.4 satisfy every engines range below)

```json
"devDependencies": {
  "@eslint/js": "10.0.1",
  "@types/node": "22.20.5",
  "eslint": "10.13.0",
  "fake-indexeddb": "6.2.6",
  "globals": "17.13.0",
  "typescript": "6.0.3",
  "typescript-eslint": "8.71.2",
  "vite": "8.3.4",
  "vitest": "5.0.5"
},
"scripts": {
  "dev": "vite",
  "build": "tsc --noEmit && vite build",
  "preview": "vite preview",
  "test": "vitest run",
  "test:watch": "vitest",
  "lint": "eslint ."
}
```
Set `"type": "module"` in package.json (so `eslint.config.js` / `vite.config.ts` are ESM and `import.meta.dirname` works).
NOT installed on purpose: jsdom, happy-dom, @vitest/coverage-v8 (all optional peers of vitest; only needed for `environment: 'jsdom'` / `--coverage`).
`@types/node` is optional (vitest optional peer `^22.0.0 || >=24.0.0`; vite peer `^20.19.0 || >=22.12.0`); keep it so `import.meta.dirname` / `node:path` type-check in config files.

Engines verified via `npm view`: vitest 5.0.5 `node ^22.12.0 || ^24.0.0 || >=26.0.0`; eslint 10.13.0 `^20.19.0 || ^22.13.0 || >=24`; @eslint/js 10.0.1 same as eslint, peer `eslint ^10.0.0`; typescript-eslint 8.71.2 `^18.18.0 || ^20.9.0 || >=21.1.0`; globals 17.13.0 `>=18`; fake-indexeddb 6.2.6 `>=18`; vite 8.3.4 `^20.19.0 || >=22.12.0`.

## (A) Vitest 5.0.5
- Peer: `vite: "^6.4.0 || ^7.0.0 || ^8.0.0"` (non-optional) — it does NOT require Vite 8; Vite 8.3.4 is simply the current latest and is in range. Docs: "Vitest 5.0 requires Vite >= 6.4.0 and Node.js >= 22.12.0." vitest 5.0.0 published 2026-09-03, 5.0.5 on 2026-10-15.
- Config: Vitest reads `vite.config.*` by default; a separate `vitest.config.*` "will have the higher priority" (it replaces, not merges, your vite config). Two documented forms:
```ts
// vite.config.ts  (single-file form, recommended for this project)
/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
export default defineConfig({
  test: {
    environment: 'node',                 // default is 'node' (docs: Default: 'node'); no jsdom needed
    globals: false,                      // default false; keep explicit imports: import { describe, it, expect } from 'vitest'
    include: ['src/**/*.{test,spec}.ts'],// default is ['**/*.{test,spec}.?(c|m)[jt]s?(x)'] resolved from root (process.cwd())
    setupFiles: ['./test/setup.ts'],
  },
});
```
```ts
// vitest.config.ts (alternative standalone form)
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { /* same */ } });
```
Docs: the triple-slash `/// <reference types="vitest/config" />` is needed "if you are importing `defineConfig` from `vite` itself"; importing `defineConfig` from `'vitest/config'` already carries the `test` types.
- `globals: true` would additionally need `"types": ["vitest/globals"]` in tsconfig — we leave it false.
- Coverage: provider defaults to `v8`; it requires `npm i -D @vitest/coverage-v8` (Vitest prompts to install it when `--coverage` / `coverage.enabled` is used). We skip coverage entirely.
- CLI: `vitest` = "Start Vitest in the current directory. Will enter the watch mode in development environment and run mode in CI (or non-interactive terminal) automatically." `vitest run` = "Perform a single run without watch mode." (`--run` is the flag form). `--environment <name>` default `node`; `--globals` injects APIs globally.
- Test file skeleton:
```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
```

## (B) ESLint 10.13.0 + typescript-eslint 8.71.2 + @eslint/js 10.0.1 + globals 17.13.0
- Flat config is the only format: migrate-to-10 docs: "Starting with ESLint v10.0.0, the old configuration format is no longer supported"; `FlatESLint`/`LegacyESLint` removed; `/* eslint-env */` comments are now lint errors; config lookup starts from each linted file's directory (`v10_config_lookup_from_file` flag removed). Node: "at least Node.js v20.19.0" (engines field is stricter: `^20.19.0 || ^22.13.0 || >=24` — 22.22.0 OK).
- File names searched: `eslint.config.js`, `.mjs`, `.cjs`, then `.ts/.mts/.cts` (TS config files need `jiti >= 2.2.0` installed — avoid; use `eslint.config.js`).
- Helpers: `import { defineConfig, globalIgnores } from "eslint/config";` — verified present in eslint 10.13.0 `exports["./config"]`. `globalIgnores([...patterns])` makes an ignores-only object; a config object's `ignores` is global only when it has no other keys (besides `name`). `extends: [...]` inside a config object accepts config objects/arrays or plugin-config name strings (e.g. `plugins: { js }, extends: ["js/recommended"]`); pair `extends` with `files`.
- `eslint:recommended` in v10 adds `no-unassigned-vars`, `no-useless-assignment`, `preserve-caught-error`; `no-shadow-restricted-names` now reports `globalThis` by default; `radix` always requires a radix.
- @eslint/js: `import js from "@eslint/js"; js.configs.recommended` (object; `js.configs.all` also exists). README uses `extends: ["js/recommended"]` with `plugins: { js }`; both forms are valid.
- globals: `import globals from "globals"; globals.browser`, `globals.node` (node = `nodeBuiltin` + CommonJS wrapper vars). Use in `languageOptions.globals: { ...globals.browser }`.
- typescript-eslint 8.71.2 (package is `"type": "commonjs"`; default-import from ESM works): `import tseslint from 'typescript-eslint'` exposes `configs`, `parser`, `plugin`, `config`. Docs state verbatim: "The `config(...)` utility function was deprecated in favor of ESLint core's `defineConfig(...)`" and "The core `defineConfig(...)` helper is a nearly exact clone of `tseslint.config(...)`". Use `defineConfig` from `eslint/config`. Configs: `recommended`, `recommendedTypeChecked`, `strict`, `strictTypeChecked`, `stylistic`, `stylisticTypeChecked`, `eslintRecommended`, `disableTypeChecked`. Typed linting needs `languageOptions.parserOptions.projectService: true` and (parser docs) `tsconfigRootDir: import.meta.dirname` ("// or, in CommonJS, __dirname"; default is the ESLint config file's directory). `projectService.allowDefaultProject: ['...']` lists files not covered by a tsconfig (`**` not allowed in these globs).
- TypeScript support (docs + npm peer): `typescript: ">=4.8.4 <6.1.0"` on typescript-eslint, @typescript-eslint/eslint-plugin and @typescript-eslint/typescript-estree 8.71.2. TypeScript 7.x is NOT supported (see gotchas) — pin typescript 6.0.3 (in range). ESLint peer `^8.57.0 || ^9.0.0 || ^10.0.0`.

### Complete eslint.config.js (ESM, project `"type": "module"`)
```js
// eslint.config.js
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['dist/**', 'node_modules/**', 'coverage/**', '.vitest/**']),

  // TypeScript sources: ESLint recommended + typescript-eslint type-checked recommended
  {
    files: ['**/*.{ts,mts,cts}'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: {
        projectService: {
          // config files are not part of the app tsconfig; lint them with the default project
          allowDefaultProject: ['vite.config.ts', 'vitest.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Plain JS files (this config file, scripts): no type-aware rules
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended, tseslint.configs.disableTypeChecked],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  // Tests and tooling run under Node
  {
    files: ['**/*.{test,spec}.ts', 'test/**/*.ts', 'vite.config.ts', 'vitest.config.ts'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
]);
```
If you prefer no typed linting at all, swap `tseslint.configs.recommendedTypeChecked` for `tseslint.configs.recommended` and drop `parserOptions` (this is exactly the getting-started example: `defineConfig({ files: ['**/*.{js,ts}'], extends: [js.configs.recommended, tseslint.configs.recommended] })`).

## (C) fake-indexeddb 6.2.6
- `exports["./auto"]` = `{ import: "./auto/index.mjs", require: "./auto/index.js" }`; package `"type": "module"` with CJS build — both `import "fake-indexeddb/auto"` and `require("fake-indexeddb/auto")` are supported. The auto entry "will put all the IndexedDB variables in the global scope" (`indexedDB`, `IDBKeyRange`, `IDBDatabase`, `IDBTransaction`, ...). Data is in-memory only.
- Node: engines `>=18`; Node 16 dropped in 5.0.0 together with the `structuredClone` polyfill ("As of version 5, fake-indexeddb no longer includes a `structuredClone` polyfill") — Node 22 has native `structuredClone`, and Vitest `environment: 'node'` keeps it, so nothing to add. 6.0.0 switched errors to `DOMException` (match on `err.name`, e.g. `'ConstraintError'`).
- Vitest wiring (Vitest docs: `setupFiles` runs before each test file; README's Jest `setupFiles` guidance maps 1:1):
```ts
// test/setup.ts
import 'fake-indexeddb/auto';
```
- Fresh DB per test (README: "creating a new instance of `IDBFactory`"; changelog 6.2.2 confirms overwriting the global `indexedDB` created by `/auto` works):
```ts
import { beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });
```
Named exports available from `'fake-indexeddb'`: `indexedDB`, `IDBFactory`, `IDBKeyRange`, `IDBDatabase`, `IDBTransaction`, `IDBObjectStore`, `IDBIndex`, `IDBCursor`, `IDBRequest`, etc.; `forceCloseDatabase` (6.2.0) simulates an abnormal close ("close" event).

## Where docs disagree with memory
- Memory: `tseslint.config(...)` is the canonical typescript-eslint wrapper. Docs: it is deprecated; use `defineConfig` from `eslint/config`.
- Memory: typescript-eslint supports "TS 5.x". Docs/npm: `>=4.8.4 <6.1.0` — TS 6.0.x is supported, TS 7.x is not.
- Memory: Vitest 5 might require Vite 8. npm peer: `^6.4.0 || ^7.0.0 || ^8.0.0`; docs: Vite >= 6.4.0.
- Memory: Vitest `clearMocks` default false. Vitest 5 migration guide: now defaults to `true`.

## Gotchas

- TypeScript 7.0.2 is npm `latest` but typescript-eslint 8.71.2 (and @typescript-eslint/typescript-estree) declare peer `typescript >=4.8.4 <6.1.0`; `npm ci` fails on the peer conflict and with plain `npm install` ESLint crashes inside typescript-estree (`Cannot read properties of undefined (reading 'Cjs')`) because TS 7 exposes no compiler API yet (issue #12518 closed 'not planned'; blocked on #10940). Pin `typescript` to 6.0.3 (or 5.9.3). Do not use the Go-based `tsc` 7 for the lint toolchain.
- Vitest 5 changed defaults: `clearMocks` is now true (mock call history cleared before each test); `test.sequential`/`describe.sequential` removed (use `concurrent: false`); `vi.mock`/`vi.unmock`/`vi.hoisted` throw unless called at module top level; `toThrow('')` matches any error; unawaited `expect(...).resolves/.rejects` fail the test; fake timers also mock `Temporal`.
- Vitest 5 no longer searches parent directories for a config file — the config must be in the cwd/root or passed with `--config`.
- A standalone `vitest.config.ts` takes priority over and does not merge with `vite.config.ts`; if you need Vite plugins in tests, put the `test` block in `vite.config.ts` with `/// <reference types="vitest/config" />` (documented form) rather than maintaining two files.
- Vitest 5 writes artifacts (JSON/JUnit reporter output, HTML, attachments) under a `.vitest/` directory, and `--reporter=json` now writes to `.vitest/json/output.json` instead of stdout. Add `.vitest/` to .gitignore and to ESLint `globalIgnores`.
- Vitest default `environment` is 'node'; `indexedDB` therefore does NOT exist until `fake-indexeddb/auto` is imported (use `test.setupFiles`). Do not set `environment: 'jsdom'` — jsdom is an optional peer that must be installed separately; also jsdom lacks `structuredClone` which fake-indexeddb >=5 no longer polyfills.
- ESLint 10 is flat-config only: any `.eslintrc*` file is ignored, `/* eslint-env */` comments are reported as errors, and config lookup starts from each linted file's directory (so running `eslint .` from the repo root is required for a single root `eslint.config.js`). `eslint.config.ts` additionally requires installing `jiti >= 2.2.0` — keep the config as `.js`.
- `eslint:recommended` in v10 adds `no-unassigned-vars`, `no-useless-assignment` and `preserve-caught-error` (the latter flags `catch (e) { throw new Error('...') }` without `{ cause: e }`), so expect new findings vs ESLint 9.
- With `projectService: true`, files not included by any tsconfig (e.g. `vite.config.ts`) fail with a parsing error; either list them in `projectService.allowDefaultProject` (globs may not contain `**`) or cover them with a tsconfig. JS files must get `tseslint.configs.disableTypeChecked` or they will also error under type-aware rules.
- `tseslint.config()` still works in 8.71.2 but is documented as deprecated in favor of ESLint core `defineConfig` from 'eslint/config'; new code should not use it.
- `import.meta.dirname` in eslint.config.js requires the project to be ESM (`"type": "module"` in package.json) and Node >= 20.11 (Node 22.22.0 OK); otherwise use `eslint.config.mjs` or `__dirname` in CJS.
- fake-indexeddb 6.x throws `DOMException` instances (not plain `Error`) — assert on `error.name` (e.g. 'ConstraintError', 'NotFoundError') rather than `instanceof Error` subclasses. Data is in-memory and persists across tests in the same file unless you reassign `globalThis.indexedDB = new IDBFactory()` in `beforeEach`.
- Vitest 5's `-t`/`--testNamePattern` now matches the full name joined with ' > ', and `vitest --ui` requires a token URL — minor, but affects scripts that filter by name.

## Compatibility warnings

- typescript-eslint 8.71.2 does not support TypeScript 7.x (peer `>=4.8.4 <6.1.0`, hard crash at runtime); TypeScript must be pinned to 6.0.3 or 5.9.3 for `eslint` to run. If TS 7's native compiler is wanted for `tsc`, install it under an npm alias (e.g. `"typescript-7": "npm:typescript@7.0.2"`) and keep `typescript@6.0.3` as the resolvable `typescript` package for ESLint.
- Vitest 5.0.5 requires Node ^22.12.0 || ^24.0.0 || >=26.0.0 and Vite ^6.4.0 || ^7.0.0 || ^8.0.0 (non-optional peer: `vite` must be in package.json). Node 22.22.0 + Vite 8.3.4 satisfy this; Vitest 5 does not force Vite 8.
- ESLint 10.13.0 engines `^20.19.0 || ^22.13.0 || >=24` and @eslint/js 10.0.1 peer `eslint ^10.0.0`: both satisfied by Node 22.22.0 / eslint 10.13.0. @eslint/js 9.x must NOT be mixed with eslint 10.
- typescript-eslint 8.71.2 peer `eslint ^8.57.0 || ^9.0.0 || ^10.0.0` — compatible with ESLint 10.13.0.
- Vite 8.3.4 peer `@types/node ^20.19.0 || >=22.12.0` and vitest optional peer `@types/node ^22.0.0 || >=24.0.0` — @types/node 22.20.5 satisfies both; do not pin @types/node 20.x.
- fake-indexeddb 6.2.6 engines node >=18 and ships both ESM (`auto/index.mjs`) and CJS (`auto/index.js`) entries; no structuredClone polyfill — fine on Node 22 with Vitest's default 'node' environment, but would need `core-js/stable/structured-clone` under jsdom.
- globals 17.13.0 engines node >=18; typescript-eslint is CommonJS (`"type": "commonjs"`) and eslint is CommonJS — both are default-importable from an ESM eslint.config.js.
