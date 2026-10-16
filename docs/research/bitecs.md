# bitecs — pinned 0.4.0

Sources:
- https://www.npmjs.com/package/bitecs (npm view bitecs: dist-tags.latest=0.4.0, published 2025-12-06; 0.3.40 published 2023-08-07; no 0.4 prerelease versions exist)
- https://github.com/NateTheGreatt/bitECS (README.md on master; byte-identical to README.md in the 0.4.0 tarball)
- https://github.com/NateTheGreatt/bitECS/blob/master/docs/Intro.md (byte-identical to tarball docs/Intro.md)
- https://github.com/NateTheGreatt/bitECS/blob/master/docs/Serialization.md (byte-identical to tarball)
- https://github.com/NateTheGreatt/bitECS/blob/master/docs/API.md (byte-identical to tarball)
- https://github.com/NateTheGreatt/bitECS/blob/master/docs/Multithreading.md (byte-identical to tarball)
- bitecs@0.4.0 tarball: docs/RELEASE_NOTES_0.4.0.md and docs/MIGRATION_GUIDE_0.4.0.md (official, shipped in the npm package)
- bitecs@0.4.0 tarball: dist/core/index.d.ts, dist/core/{World,Entity,EntityIndex,Component,Query,Relation,Hierarchy}.d.ts, dist/serialization/index.d.ts, package.json exports map
- https://github.com/NateTheGreatt/bitECS/tags (single tag 0.4.0 dated Aug 19 2025; no v-prefixed, alpha, beta or rc tags; GitHub Releases page is empty)
- Runtime + tsc probes run in scratchpad against the installed bitecs@0.4.0 (node v22.22.0, typescript 5.9.3) at /tmp/claude-0/-home-user-Police-sim/50361fc2-1118-53d4-a10a-65feb5d6b6a8/scratchpad/bitecs-test/{runtime.mjs,live.mjs,mix.mjs,types-core.ts,types-legacy.ts}

## API notes

## Status / which version to pin
- `bitecs@0.4.0` is the npm `latest` dist-tag (published 2025-12-06; git tag `0.4.0` dated 2025-08-19). There is no prerelease suffix, no 0.4 alpha/beta/rc on npm, and neither README, docs nor the shipped RELEASE_NOTES_0.4.0.md label it beta. It is the current stable line. 0.3.40 (Aug 2023) is the old API and is only worth pinning if you have existing 0.3 code; for a new project pin `"bitecs": "0.4.0"` exactly (the author has a history of frequent patch releases; 0.4.x semver is "0.x" so minor bumps may break).
- Zero runtime dependencies, no peerDependencies, license MPL-2.0 (file-level copyleft; fine for a game that doesn't modify bitecs itself).
- package.json `exports`: `"."` (core), `"./serialization"`, `"./legacy"`. ESM entry `dist/core/index.min.mjs`, CJS `index.min.cjs`, types `dist/core/index.d.ts`. `typesVersions` maps `serialization` and `legacy` for old TS resolution. Vite resolves it with no config.

## Exact core exports (verified from dist/core/index.d.ts and `Object.keys(import('bitecs'))`)
World: `createWorld, resetWorld, deleteWorld, getWorldComponents, getAllEntities, $internal` — types `World<T>, InternalWorld, WorldContext`
Entity: `addEntity, removeEntity, getEntityComponents, entityExists, Prefab, addPrefab` — type `EntityId = number`
EntityIndex: `createEntityIndex, getId, getVersion, withVersioning` (NOTE: `addEntityId`, `removeEntityId`, `isEntityIdAlive` are declared in EntityIndex.d.ts but are NOT re-exported from `'bitecs'`, even though docs/Intro.md's versioning example calls `addEntityId(entityIndex)`; use `addEntity(world)` instead.)
Component: `registerComponent, registerComponents, hasComponent, addComponent, addComponents, setComponent, removeComponent, removeComponents, getComponent, set` — types `ComponentRef (= any), ComponentData`
Query: `query, registerQuery, removeQuery, commitRemovals, observe, onAdd, onRemove, onSet, onGet, Or, And, Not, Any, All, None, Hierarchy, Cascade, asBuffer, isNested, noCommit` — types `QueryResult, Query, QueryTerm, QueryOptions, QueryModifier, QueryOperator, ObservableHook, ObservableHookDef, HierarchyTerm`
Relation: `createRelation, withStore, makeExclusive, withAutoRemoveSubject, withOnTargetRemoved, getRelationTargets, Wildcard, IsA, Pair, isRelation, isWildcard` — types `Relation<T>, RelationTarget, OnTargetRemovedCallback`
Hierarchy: `getHierarchyDepth, getMaxHierarchyDepth`
Utils: `pipe, soa, aos`
NOT exported from core (memory from 0.3 is wrong here): `defineComponent, defineQuery, enterQuery, exitQuery, Changed, Types, defineSerializer, defineDeserializer, getSnapshot`. All except `getSnapshot` (which does not exist anywhere in 0.4) live only in `bitecs/legacy`.

## Signatures (from .d.ts)
```ts
function createWorld<T extends object = {}>(...args: Array<EntityIndex | T>): World<T>   // World<T> = T; returns the SAME object you pass in
function addEntity(world: World): EntityId
function addEntity(world: World, ...components: any[]): EntityId                      // variadic overload verified at runtime
const removeEntity: (world: World, eid: EntityId) => void
const entityExists: (world: World, eid: EntityId) => boolean
const getEntityComponents: (world: World, eid: EntityId) => ComponentRef[]
const addComponent: (world: World, eid: EntityId, componentOrSet: ComponentRef | {component, data}) => boolean  // ORDER CHANGED vs 0.3 (was world, component, eid). Returns false if already present. Throws if entity doesn't exist.
function addComponents(world, eid, components: (ComponentRef|Setter)[]): void
function addComponents(world, eid, ...components): void
const removeComponent: (world, eid, ...components: ComponentRef[]) => void
const hasComponent: (world, eid, component) => boolean
const set: <T>(component: T, data: any) => { component: T; data: any }
const setComponent: (world, eid, component, data) => void       // == addComponent(world, eid, set(component, data))
const getComponent: (world, eid, component) => any               // returns what your onGet observer returns ({} if none)
type QueryResult = Readonly<Uint32Array> | readonly EntityId[]
interface QueryOptions { commit?: boolean; buffered?: boolean }
function query(world: World, terms: QueryTerm[], ...modifiers: (QueryModifier | QueryOptions)[]): QueryResult
const Or, And, Not, Any, All, None: (...components: ComponentRef[]) => OpReturnType     // And==All, Or==Any, Not==None
const Hierarchy / Cascade: (relation: ComponentRef, depth?: number) => HierarchyTerm
const asBuffer, isNested, noCommit: QueryModifier    // isNested == noCommit == { commit: false }
function observe(world, hook: ObservableHook, callback: (eid: EntityId, ...args: any[]) => any): () => void   // returns unsubscribe
const onAdd, onRemove, onSet, onGet: (...terms: QueryTerm[]) => ObservableHook   // onSet/onGet accept exactly ONE component (throws otherwise)
function createRelation<T>(...modifiers: Array<(r: Relation<T>) => Relation<T>>): Relation<T>
function createRelation<T>(options: { store?: () => T; exclusive?: boolean; autoRemoveSubject?: boolean; onTargetRemoved?: (subject, target) => void }): Relation<T>
type Relation<T> = (target: EntityId | '*' | typeof Wildcard) => T   // call it with a target to get the pair-component to pass to addComponent/query
const getRelationTargets: (world, eid, relation) => number[]
const Wildcard: Relation<any>; const IsA: Relation<any>; const Pair: <T>(relation, target) => T
const createEntityIndex: (options?: ReturnType<typeof withVersioning> | typeof withVersioning) => EntityIndex
const withVersioning: (versionBits?: number) => { versioning: true; versionBits }
const pipe: (...fns) => (...args) => result     // plain left-to-right function composition
```

## Components in 0.4 (defineComponent is gone)
Any object reference is a component; identity is by reference. Recommended shapes (from docs/Intro.md + migration guide):
```ts
const Position = { x: [] as number[], y: [] as number[] }                 // SoA, plain arrays (grow automatically)
const Velocity = { x: new Float32Array(10_000), y: new Float32Array(10_000) }  // SoA typed (must be sized >= max eid)
const Player = [] as { level: number; name: string }[]                     // AoS
const Health = [] as number[]                                              // scalar-per-entity
const Dead = {}                                                            // tag
```
Components auto-register on first `addComponent`; `registerComponent(s)` is optional. No `Types.f32` etc. in core. The README pattern of `createWorld({ components: { ... } })` then `const { Position } = world.components` is only a convention (createWorld returns your object unchanged) — bitecs does not read `world.components`.

## Queries (defineQuery is gone)
Call `query(world, [A, B])` every frame; it hashes the terms, lazily registers a cached Query once, then returns the Query's internal live `dense` array (verified: same reference on repeated calls, not frozen, grows as entities match). `[A, B]` is implicit AND. `Not(X)` / `Or(X, Y)` go inside the array: `query(world, [Position, Not(Velocity)])`. Nested combinators (`Or(And(..))`) throw "Nested combinator ... not supported yet". Default result is `readonly number[]`; with `asBuffer` (or `{ buffered: true }`) it is a `Uint32Array` backed by SharedArrayBuffer when available (ArrayBuffer otherwise). `commit` (default true) flushes deferred entity/component removals before returning; pass `isNested`/`noCommit`/`{commit:false}` for a query executed inside another query's loop.

## Removal semantics (verified)
`removeEntity` marks the entity dead immediately (`entityExists` → false) but query result arrays are only updated on the next *committing* `query()` call (swap-remove, so order changes). Iterating `for (const eid of query(world,[A]))` and calling `removeEntity` inside is safe; calling a second committing `query()` inside that loop is not.

## Observers (enterQuery/exitQuery/Changed are gone)
```ts
const off = observe(world, onAdd(Position, Velocity), (eid) => { /* entity now matches */ })
observe(world, onRemove(Velocity), (eid) => { /* fires synchronously inside removeComponent/removeEntity */ })
observe(world, onSet(Position), (eid, data) => { Position.x[eid] = data.x; Position.y[eid] = data.y })
observe(world, onGet(Position), (eid) => ({ x: Position.x[eid], y: Position.y[eid] }))
```
`set()`/`setComponent()` do nothing but call the onSet observable: verified that `addComponent(world, eid, set(Position, {x:9}))` with no onSet observer leaves `Position.x[eid] === undefined`. For plain SoA just write fields directly after addComponent.

## Entity IDs
First eid is 1 (0 is never issued; safe as "null entity"). IDs are recycled immediately after removal by default (verified a===b). Default EntityIndex: `versioning:false, versionBits:8, entityMask: 0xFFFFFF (16,777,215)`; without versioning there is no enforced cap beyond that mask, ids simply increment. `createWorld(createEntityIndex(withVersioning(8)))` gives versioned ids (e.g. recycled 1 becomes 16777217) — docs say "default is 12 bits" but source is `config.versionBits ?? 8`, so `withVersioning()` with no arg = 8 bits; trust the code. Versioned ids are NOT safe as indexes into fixed-size TypedArrays (docs warn). For a game: no versioning, size typed arrays to a MAX_ENTITIES constant, and reset fields on addComponent since recycled slots keep stale values.

## Relations
```ts
const ChildOf = createRelation(withAutoRemoveSubject)        // or createRelation({ autoRemoveSubject: true })
const Targeting = createRelation(makeExclusive)              // one target at a time
const Contains = createRelation(withStore(() => ({ amount: [] as number[] })))
addComponent(world, child, ChildOf(parent)); Contains(gold).amount[inv] = 5
getRelationTargets(world, child, ChildOf)        // [parent]
query(world, [ChildOf(parent)])                  // children of parent
query(world, [ChildOf(Wildcard)]) / [ChildOf('*')]   // anything with a parent
query(world, [Wildcard(parent)])                 // anything related to parent by any relation
query(world, [Position, Hierarchy(ChildOf)])     // parents before children
```
Prefabs: `const P = addPrefab(world)`; `addComponent(world, e, IsA(P))` copies P's components; value inheritance only works if onSet+onGet observers exist for that component. Prefab entities never appear in queries.

## Serialization (`bitecs/serialization` sub-export; there is no getSnapshot)
Exports: `createSoASerializer, createSoADeserializer, createAoSSerializer, createAoSDeserializer, createSnapshotSerializer, createSnapshotDeserializer, createObserverSerializer, createObserverDeserializer, u8,i8,u16,i16,u32,i32,f32,f64,str,ref,array` + `$`-prefixed symbols.
```ts
import { createSnapshotSerializer, createSnapshotDeserializer, f32, u8 } from 'bitecs/serialization'
const Position = { x: f32([]), y: f32([]) }   // branded plain arrays tell the serializer the wire type; TypedArrays need no tag; untagged plain arrays default to f64
const serialize = createSnapshotSerializer(world, [Position, Health], new ArrayBuffer(1 << 20))  // 3rd arg optional; DEFAULT IS A 100MB ArrayBuffer
const deserialize = createSnapshotDeserializer(world, [Position, Health])
const packet: ArrayBuffer = serialize()            // optional (selectedEntities?: readonly number[])
const idMap: Map<number, number> = deserialize(packet)   // re-creates entities + components + data; verified roundtrip
// SoA: createSoASerializer(components, { diff?, buffer?, epsilon? })(eids) -> ArrayBuffer; createSoADeserializer(components, { diff? })(packet, idMap?)
// Observer (entity/component add/remove deltas): createObserverSerializer(world, NetworkedTag, components, { buffer? })() ; createObserverDeserializer(world, NetworkedTag, components, { idMap? })(packet, idMap?)
```
For a local save-game, JSON of your own SoA arrays is also perfectly viable; the snapshot serializer is binary and entity-id-preserving.

## Minimal correct 0.4.0 example (type-checks under strict TS, runs on Node 22)
```ts
import { createWorld, addEntity, removeEntity, addComponent, removeComponent, hasComponent,
         query, observe, onAdd, onRemove, Not, entityExists, type World, type EntityId } from 'bitecs'

const MAX = 10_000
export const Position = { x: new Float32Array(MAX), y: new Float32Array(MAX) }
export const Velocity = { x: new Float32Array(MAX), y: new Float32Array(MAX) }
export const Health   = [] as number[]
export const Dead     = {}

type Ctx = { time: { delta: number; elapsed: number } }
export const world: World<Ctx> = createWorld<Ctx>({ time: { delta: 0, elapsed: 0 } })

export function spawnUnit(x: number, y: number): EntityId {
  const eid = addEntity(world, Position, Velocity, Health)   // or addEntity(world) + addComponent calls
  Position.x[eid] = x; Position.y[eid] = y
  Velocity.x[eid] = 0; Velocity.y[eid] = 0                  // reset: ids are recycled, slots keep stale data
  Health[eid] = 100
  return eid
}

observe(world, onAdd(Dead), (eid) => console.log('died', eid))
observe(world, onRemove(Velocity), (eid) => console.log('stopped', eid))

export const movementSystem = (w: World<Ctx>) => {
  for (const eid of query(w, [Position, Velocity, Not(Dead)])) {
    Position.x[eid] += Velocity.x[eid] * w.time.delta
    Position.y[eid] += Velocity.y[eid] * w.time.delta
  }
}
export const deathSystem = (w: World<Ctx>) => {
  for (const eid of query(w, [Health])) {
    if (Health[eid] <= 0 && !hasComponent(w, eid, Dead)) addComponent(w, eid, Dead)
  }
}
export const cleanupSystem = (w: World<Ctx>) => {
  for (const eid of query(w, [Dead])) removeEntity(w, eid)   // safe: removals are deferred until next committing query
}

let then = performance.now()
function frame(now: number) {
  world.time.delta = (now - then) / 1000; world.time.elapsed += world.time.delta; then = now
  movementSystem(world); deathSystem(world); cleanupSystem(world)
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
```

## Gotchas

- addComponent/removeComponent/hasComponent argument order is (world, eid, component) in 0.4 — the reverse of 0.3's (world, component, eid). Migration guide calls this out explicitly; bitecs/legacy keeps the old order.
- defineComponent, defineQuery, enterQuery, exitQuery, Changed, Types, defineSerializer are NOT exported from 'bitecs' in 0.4 (RELEASE_NOTES_0.4.0.md 'Removed Features'). Components are plain objects; call query(world, terms) directly every frame (queries are cached internally by a term hash, so this is cheap); replace enter/exit with observe(world, onAdd(...)/onRemove(...)). Memory of a defineQuery-style API is 0.3-only.
- query() returns the Query's LIVE internal dense array (verified: same reference on every call, not frozen, .push is not blocked). Never mutate it, and do not hold it across frames expecting a snapshot — its contents and order change (swap-remove on commit).
- Entity removal is deferred from query results until the next query() call that commits (default). Calling a second committing query() inside a query loop mutates the outer array mid-iteration; pass isNested / noCommit / { commit: false } to inner queries.
- set()/setComponent() do NOTHING unless an onSet observer for that component exists — verified: addComponent(world, eid, set(Position, {x:9})) leaves Position.x[eid] undefined with no observer. getComponent() returns {} with no onGet observer. For plain SoA, write fields directly.
- Entity ids start at 1 and are recycled immediately by default (removed id 1 is reissued on the next addEntity). SoA slots keep stale data from the previous owner, so initialize every field when you add a component. Use 0 as your 'no entity' sentinel.
- Typed-array SoA stores (Float32Array(N)) must be sized >= the maximum entity id you will ever issue; out-of-range writes silently no-op and reads return undefined. Plain [] as number[] stores grow automatically but holes read as undefined (NaN propagation).
- withVersioning(): docs/Intro.md says the default is 12 version bits; the shipped source uses `config.versionBits ?? 8`, so no-arg withVersioning() gives 8 bits (16M entities / 256 recycles). Versioned ids are huge (recycled 1 becomes 16777217) and unsafe as TypedArray indexes (docs warn). Also addEntityId/removeEntityId used in the docs' versioning example are NOT exported from 'bitecs'.
- Once asBuffer (or { buffered: true }) is used for a given term set, the cached query is re-registered as buffered and ALL later plain query() calls with the same terms return a Uint32Array instead of an Array (verified). Uint32Array has no push/map-to-array; pick one mode per term set. QueryResult is typed as the union so TS will not catch it.
- Nested combinators are unsupported: query(world, [Or(And(A,B), C)]) throws 'Nested combinator And not supported yet'. Keep terms flat: [A, Or(B,C), Not(D)].
- onSet(...)/onGet(...) accept exactly one component; observe() throws 'Set and Get hooks can only observe a single component' otherwise. onAdd/onRemove accept full query terms including Not/Or.
- Observer callbacks fire synchronously inside addComponent/removeComponent/removeEntity. Don't add/remove entities from inside an onRemove callback of the same query without care; queue them instead (the migration guide's world.enteredMovers/exitedMovers queue pattern).
- Prefab entities (addPrefab) never appear in query results; IsA(prefab) copies component presence, but value inheritance only happens if BOTH onSet and onGet observers are registered for that component before addComponent(world, e, IsA(prefab)).
- createWorld(ctx) returns ctx itself (world === ctx). 'world.components' in the README is a convention, not an API — bitecs never reads it. Pass createEntityIndex() as another argument only if you need multiple worlds sharing ids.
- Serialization lives in the 'bitecs/serialization' sub-export only; there is no getSnapshot/defineSerializer in core. Every serializer instance preallocates a 100MB ArrayBuffer by default — pass your own `buffer` (3rd positional arg for snapshot, options.buffer for SoA/AoS/Observer). Plain-array fields must be branded with f32([])/u8([]) etc. or they serialize as f64.
- Serialization bundle imports 'bitecs' as an external (built with --external:bitecs), so both must resolve to the same package instance; fine with one installed copy, but avoid duplicate bitecs copies via linked packages.
- removeEntity on a relation target with withAutoRemoveSubject recursively removes subjects (verified child gone after parent removal); with the default relation it only strips the pair components. Plan which you want for e.g. patrol-car -> officer links.
- The 'bitecs/legacy' sub-export is runtime-only: package.json points types at dist/legacy/index.d.ts but that file is not in the tarball, so a TS import of 'bitecs/legacy' fails with TS7016 under noImplicitAny (verified with tsc 5.9.3). Avoid it in a new TS project or add `declare module 'bitecs/legacy'`.

## Compatibility warnings

- Node v22.22.0 / npm 10.9.4: fine. Package has no engines field, zero dependencies, no peerDependencies. Verified import of 'bitecs', 'bitecs/serialization' and 'bitecs/legacy' under Node 22 ESM.
- Vite + TypeScript: use "moduleResolution": "bundler" (or node16/nodenext) so the `exports` subpaths 'bitecs/serialization' resolve to their .d.ts; `typesVersions` is also present for legacy 'node' resolution. Core + serialization type-check clean under strict TS 5.9.3 (verified). 'bitecs/legacy' has NO .d.ts in the 0.4.0 tarball (TS7016).
- Built output uses ES2020+ syntax (Symbol.for, ??, spread, optional chaining); Vite's default build target (modern browsers) is fine. Do not set a build target below ES2020 without transpiling node_modules.
- asBuffer query results use SharedArrayBuffer when `typeof SharedArrayBuffer !== 'undefined'`; in browsers SAB is only defined on cross-origin-isolated pages (COOP/COEP headers), otherwise bitecs silently falls back to ArrayBuffer. Only matters if you plan Web Worker sharing.
- 0.4.0 is a complete rewrite of 0.3.x (RELEASE_NOTES_0.4.0.md). Any 0.3-era tutorials, blog posts, or model memory (defineComponent/Types/defineQuery/enterQuery/Changed, addComponent(world, Component, eid)) do not apply. Where my prior memory and the shipped docs/types disagreed (API shape, argument order, serialization location, default version bits), the docs and dist/*.d.ts were trusted.
- Pin exactly "bitecs": "0.4.0" (not ^0.4.0): 0.x semver means a 0.5.0 could break again, and the 0.3→0.4 gap shows the author does ship wholesale rewrites. Do not pin 0.3.40 for a new project; it only makes sense for existing 0.3 code.
