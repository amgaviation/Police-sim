# typescript — pinned 6.0.3

Sources:
- https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/
- https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/
- https://github.com/microsoft/typescript-go/blob/main/README.md
- https://raw.githubusercontent.com/microsoft/typescript-go/main/CHANGES.md
- https://vite.dev/guide/features (TypeScript + Client Types sections)
- https://vite.dev/guide/migration (Vite 8)
- https://raw.githubusercontent.com/vitejs/vite/main/packages/create-vite/template-vanilla-ts/tsconfig.json (create-vite 9.2.1)
- https://raw.githubusercontent.com/vitejs/vite/main/packages/create-vite/template-vanilla-ts/package.json
- https://typescript-eslint.io/users/dependency-versions
- https://github.com/typescript-eslint/typescript-eslint/issues/12518 (closed, blocked on #10940)
- https://vitest.dev/config/typecheck
- https://vitest.dev/guide/testing-types
- https://github.com/vitest-dev/vitest/releases (v5.0.0: 'Require Node.js 22 and Vite 6.4')
- https://www.typescriptlang.org/tsconfig/
- npm registry: npm view typescript dist-tags / typescript@7.0.2 / typescript@6 / typescript-eslint@8.71 / vitest@5 / vite@8 / @types/three@0.186.0 / @typescript/typescript6
- Local verification in scratchpad (/tmp/claude-0/-home-user-Police-sim/50361fc2-1118-53d4-a10a-65feb5d6b6a8/scratchpad/probe): tsc 5.9.3 / 6.0.3 / 7.0.2 --noEmit -p against the create-vite tsconfig + three@0.186.1 + @types/three@0.186.0; tsc --help --all; tsc --showConfig; npm i --dry-run typescript-eslint@8.71.2 with each TS; vite@8.3.4 build

## API notes

## Registry facts (npm view, 2026-10-16)
- dist-tags: latest=7.0.2 (published 2026-07-08), next=7.1.0-dev.*, rc=7.0.1-rc, beta=6.0.0-beta. Also published: 6.0.3 (2026-04-16, last 6.x), 5.9.3 (2025-09-30, last 5.x).
- typescript@7.0.2: bin {"tsc": "./bin/tsc"}; engines node>=16.20.0; "type":"module"; depends on 20 platform packages @typescript/typescript-<os>-<arch>@7.0.2 (Go binary). Package exports: "." -> ./lib/version.cjs (require('typescript') returns ONLY {version, versionMajorMinor}); everything else is under "./unstable/sync|async|fs|proto|ast/*". There is no stable programmatic API (blog: "it does not ship with an API"; 7.1 is slated to add "a new (and different) API").
- @typescript/typescript6@6.0.2: the official side-by-side compat package; bin is "tsc6"; re-exports the 6.0 API. Blog-recommended pattern when you need both: "typescript": "npm:@typescript/typescript6@^6.0.2" plus "@typescript/native": "npm:typescript@^7.0.2".
- @types/three@0.186.0: typeScriptVersion "5.6" (min TS), no peerDependencies. three latest is 0.186.1.

## (1) tsc 7.0.2 CLI — VERIFIED by running it
`tsc --help` (7.0.2) lists: --help/-h, --watch/-w, --all, --version/-v, --init, --project/-p, --showConfig, --ignoreConfig (new: required to pass file paths when a tsconfig.json exists in cwd), --build/-b, plus common compiler options including --noEmit, --declaration, --emitDeclarationOnly, --sourceMap. New experimental flags: --checkers (default 4), --builders, --singleThreaded.
Verified commands that work identically to 5.9/6.0:
  tsc --noEmit -p tsconfig.json   # exit 0 on the create-vite template + three/@types/three
  tsc --showConfig -p tsconfig.json
So package.json scripts "typecheck": "tsc --noEmit -p tsconfig.json" and "build": "tsc && vite build" are unchanged across 5.9 -> 6.0 -> 7.0.

## (1) tsconfig options removed/changed in 7.0 — VERIFIED
tsc 7.0.2 on a legacy config emits hard errors (exit 1), and "ignoreDeprecations":"6.0" does NOT silence them (--ignoreDeprecations is not even listed in --help --all):
  error TS5108: Option 'moduleResolution=node10' has been removed.
  error TS5102: Option 'baseUrl' has been removed. Use '"paths": {"*": ["./*"]}' instead.
  error TS5090: Non-relative paths are not allowed. Did you forget a leading './'?   (paths entries must be './src/*', not 'src/*')
  error TS5108: Option 'esModuleInterop=false' has been removed.
In 6.0.3 the same config gives TS5107/TS5101 "deprecated and will stop functioning in TypeScript 7.0" (exit 2) unless ignoreDeprecations:"6.0".
7.0.2 allowed values (from --help --all): moduleResolution: node16 | nodenext | bundler ONLY (default bundler unless module is node16/node18/nodenext); module: commonjs, es6/es2015, es2020, es2022, esnext, node16, node18, node20, nodenext, preserve (amd/umd/system/none gone); target: es2015..es2025, esnext, default es2025 (es5 gone); esModuleInterop default true (cannot be false); allowSyntheticDefaultImports default true; strict default true; types default [] (restore old behaviour with ["*"]); rootDir default ./; noUncheckedSideEffectImports default true; libReplacement default false; stableTypeOrdering forced on; downlevelIteration, outFile, alwaysStrict:false removed; `module` keyword for namespaces and `asserts` import attributes are errors (use `with`). Note `verbatimModuleSyntax: true` implies isolatedModules:true and preserveConstEnums:true (seen in --showConfig).

## (2) Ecosystem compatibility with typescript@7
- vite@8 (8.3.4 tested): NO typescript peer dependency. Vite transpiles TS with Oxc and "does NOT perform type checking"; it parses tsconfig itself. `vite build` succeeded with no typescript package installed at all. => Vite 8 is indifferent to TS 5.9/6.0/7.0.
- vitest@5 (5.0.x): peerDeps vite ^6.4.0||^7.0.0||^8.0.0, @types/node ^22||>=24, engines node ^22.12||^24||>=26; NO typescript peer dep. `--typecheck` spawns `tsc --noEmit --pretty false` (typecheck.checker default 'tsc', may be any command "implementing the same output format as tsc"). Would likely run TS 7's tsc, but Vitest docs/releases say nothing about TS 7; not officially claimed.
- typescript-eslint@8.71.x: peer "typescript": ">=4.8.4 <6.1.0" (docs: "The version range of TypeScript currently supported is >=4.8.4 <6.1.0"). `npm i --dry-run typescript@7.0.2 typescript-eslint@8.71.2` => ERESOLVE (verified); with 6.0.3 or 5.9.3 => resolves. Issue #12518 closed as not planned; maintainer: "typescript-eslint isn't compatible with TS 7 at this time, because there is no TS 7 API at this time." Tracking: #10940. => NOT compatible with 7.
- @types/three@0.186.0: min TS 5.6; type-checks cleanly under 5.9.3, 6.0.3 AND 7.0.2 (verified with the Vite template config, importing three + three/examples/jsm/controls/OrbitControls.js). No official TS-7 statement from DefinitelyTyped.

## Recommendation
Pin "typescript": "6.0.3" (exact). Rationale: it is what create-vite 9.2.1's vanilla-ts template ships ("typescript": "~6.0.2", "vite": "^8.3.4"); it is inside typescript-eslint's supported range; its deprecation errors (TS5101/TS5107) are the exact set that becomes hard errors in 7, so the config stays 7-ready; and @typescript/typescript6 is Microsoft's designated bridge. 5.9.3 also works with everything here, but 5.9 does not flag 7.0-removed options and is no longer the Vite default. Do not pin 7.0.2 while typescript-eslint is in the project.
Optional (not required): devDependency "@typescript/native": "npm:typescript@^7.0.2" and script "typecheck:fast": "node_modules/@typescript/native/bin/tsc --noEmit -p tsconfig.json" to get the 10x checker for CI/dev while ESLint keeps using 6.0.3. Only do this if the team wants it; the plain 6.0.3 setup is sufficient.

## package.json (devDependencies / scripts)
{
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit -p tsconfig.json && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest"
  },
  "devDependencies": {
    "typescript": "6.0.3",
    "vite": "^8.3.4",
    "vitest": "^5.0.0",
    "typescript-eslint": "^8.71.0",
    "@types/three": "^0.186.0"
  },
  "dependencies": { "three": "^0.186.1" }
}

## tsconfig.json — official create-vite 9.2.1 vanilla-ts template (verbatim), plus the strict additions the task asked about (marked)
{
  "compilerOptions": {
    "target": "es2023",
    "module": "esnext",
    "lib": ["ES2023", "DOM"],
    "types": ["vite/client"],
    "allowArbitraryExtensions": true,
    "skipLibCheck": true,

    /* Bundler mode */
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,

    /* Linting */
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "erasableSyntaxOnly": true,
    "noFallthroughCasesInSwitch": true,

    /* --- additions beyond the template (all options exist in 5.9/6.0/7.0) --- */
    "strict": true,                 // explicit; default true from 6.0, false in 5.9
    "isolatedModules": true,        // Vite docs: "should be set to true"; already implied by verbatimModuleSyntax
    "noUncheckedIndexedAccess": true,
    "useDefineForClassFields": true // explicit; default for target >= ES2022
  },
  "include": ["src"]
}
Notes: "lib": ["ES2023","DOM"] — DOM.Iterable is merged into lib.dom since 6.0 (harmless to list under 5.9 if you need for-of over NodeList; add "DOM.Iterable" only if you pin 5.9). Do NOT add "baseUrl"; use "paths": {"@/*": ["./src/*"]} (leading ./ required in 7) together with Vite `resolve.tsconfigPaths: true`. If Vitest globals are used, add "vitest/globals" to "types"; with types:[...] set, only listed packages enter global scope (Vite docs: recommended since TS 5.9; mandatory behaviour under 6.0+ where types defaults to []). For a Vitest config file typed under @types/node, put it in a separate tsconfig.node.json rather than adding "node" to this browser tsconfig.

## Gotchas

- Memory said 'latest TypeScript is 5.x' — docs/registry disagree: latest is 7.0.2 (Go native compiler), 6.0.3 is the last JS-based release, 5.9.3 the last 5.x. Trust the registry.
- typescript@7's require('typescript') returns only {version, versionMajorMinor}; any tool that imports the TypeScript API (typescript-eslint, ts-jest, ts-morph, vue-tsc, Volar, webpack ts-loader) crashes or refuses to install. Only stable API arrives in 7.1 per Microsoft.
- In TS 7, 'ignoreDeprecations': '6.0' does NOT rescue baseUrl / moduleResolution node10 / esModuleInterop:false — they are hard errors TS5102/TS5108 (verified). Fix the config instead; 6.0.3 will tell you exactly what to fix via TS5101/TS5107.
- TS 7 'paths' entries must be relative ('./src/*'); a bare 'src/*' is error TS5090 'Non-relative paths are not allowed'.
- TS 6.0+ defaults: strict=true, types=[], module=esnext, target=es2025, noUncheckedSideEffectImports=true. With types=[] you MUST list 'vite/client' (and 'vitest/globals' if used) or import.meta.env / asset imports lose their types.
- verbatimModuleSyntax:true implies isolatedModules:true and preserveConstEnums:true (seen in tsc --showConfig); const enums will not be inlined by Vite/Oxc — avoid them in a Vite project.
- Vite 8 switched the TS transform from esbuild to Oxc: native decorators are not lowered, legacy `namespace` is only partially supported, emitDecoratorMetadata partially supported. Vite ignores tsconfig 'target' (uses oxc.target / build.target).
- Vitest --typecheck spawns `tsc --noEmit --pretty false` and parses stdout; it will pick up whatever `tsc` resolves to in node_modules/.bin. If you install the TS 7 alias package, keep it out of .bin (use the npm: alias name) so Vitest and ESLint keep using 6.0.3.
- typescript-eslint peer range is `>=4.8.4 <6.1.0`: 6.0.3 is the highest allowed; npm ci will ERESOLVE on 7.x (verified). --legacy-peer-deps 'works' for install but ESLint then crashes at runtime (TypeError reading 'Cjs').

## Compatibility warnings

- typescript@7.0.2 is NOT compatible with typescript-eslint@8.71.x (peer `>=4.8.4 <6.1.0`, issue #12518 closed-not-planned, blocked on #10940 pending a TS 7 API). Pin typescript@6.0.3.
- vite@8.x (8.3.4 tested) has no typescript peer dependency and never loads the typescript package; compatible with 5.9 / 6.0 / 7.0 alike. engines node ^20.19.0 || >=22.12.0 (Node 22.22.0 OK).
- vitest@5.x has no typescript peer dependency; peer vite ^6.4.0 || ^7.0.0 || ^8.0.0; engines node ^22.12.0 || ^24.0.0 || >=26.0.0 (Node 22.22.0 OK). Typecheck mode shells out to `tsc --noEmit`; no official TS 7 statement.
- @types/three@0.186.0 requires TS >= 5.6 (typeScriptVersion); verified to type-check under 5.9.3, 6.0.3 and 7.0.2 with the Vite template tsconfig. Pair with three@0.186.x.
- create-vite 9.2.1 vanilla-ts template currently ships typescript ~6.0.2 and vite ^8.3.4 — the official pairing for a Vite 8 project today.
- If TS 7's speed is wanted alongside typescript-eslint, use Microsoft's documented alias pattern: "typescript": "npm:@typescript/typescript6@^6.0.2" (or plain typescript@6.0.3) plus "@typescript/native": "npm:typescript@^7.0.2"; never install bare typescript@7 as the project's `typescript`.
- Embedded-language toolchains (Vue/Svelte/Astro/MDX, Volar-based) must stay on TS 6.0 per the TS 7.0 announcement; not applicable to this vanilla project but relevant if any such plugin is added.
