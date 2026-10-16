# @dimforge/rapier3d-compat (and @dimforge/rapier3d) — pinned 0.21.0

Sources:
- npm registry via `npm view`: @dimforge/rapier3d-compat@0.21.0 and @dimforge/rapier3d@0.21.0 (latest = 0.21.0, published 2026-09-25; no dependencies / peerDependencies)
- Shipped type declarations from the 0.21.0 tarball (npm pack, unpacked to scratchpad): dist/init.d.ts, dist/pipeline/world.d.ts, dist/dynamics/rigid_body.d.ts, dist/geometry/collider.d.ts, dist/geometry/shape.d.ts, dist/geometry/ray.d.ts, dist/geometry/toi.d.ts, dist/pipeline/event_queue.d.ts, dist/pipeline/query_pipeline.d.ts, dist/control/ray_cast_vehicle_controller.d.ts, dist/control/character_controller.d.ts, dist/dynamics/integration_parameters.d.ts, dist/math.d.ts, dist/rapier.mjs (init implementation)
- https://rapier.rs/docs/user_guides/javascript/getting_started_js
- https://rapier.rs/docs/user_guides/javascript/rigid_bodies
- https://rapier.rs/docs/user_guides/javascript/colliders
- https://rapier.rs/docs/user_guides/javascript/character_controller
- https://rapier.rs/docs/user_guides/javascript/vehicle_controller
- https://rapier.rs/docs/user_guides/javascript/scene_queries
- https://rapier.rs/docs/user_guides/javascript/advanced_collision_detection_js
- https://rapier.rs/javascript3d/classes/World.html
- https://rapier.rs/javascript3d/classes/DynamicRayCastVehicleController.html
- https://rapier.rs/javascript3d/classes/KinematicCharacterController.html
- https://rapier.rs/javascript3d/enums/QueryFilterFlags.html
- https://raw.githubusercontent.com/dimforge/rapier/master/bindings/typescript/CHANGELOG.md (0.20.0 / 0.21.0 sections)
- https://raw.githubusercontent.com/dimforge/rapier/master/CHANGELOG.md (v0.35.0 / v0.36.0 sections)
- https://raw.githubusercontent.com/dimforge/rapier/master/src/control/ray_cast_vehicle_controller.rs (WheelTuning defaults, axis defaults)
- https://raw.githubusercontent.com/dimforge/rapier/master/src/control/character_controller.rs (controller defaults)
- https://raw.githubusercontent.com/dimforge/rapier/master/src/dynamics/integration_parameters.rs (dt, solver defaults)
- https://docs.rs/rapier3d/latest/rapier3d/control/struct.WheelTuning.html
- @dimforge/rapier3d-compat 0.21.0 README (from tarball)

## API notes

## Package / entry points (verified from package.json in the 0.21.0 tarball)
- `@dimforge/rapier3d-compat@0.21.0`: `exports["."]` = `{ types: ./dist/rapier.d.ts, import: ./dist/rapier.mjs, require: ./dist/rapier.cjs }`, `sideEffects: false`. The wasm is embedded as base64 inside `dist/rapier.mjs` (file is ~4.3 MB; raw wasm ~3.1 MB). No deps/peerDeps.
- `@dimforge/rapier3d@0.21.0` (non-compat): `module: rapier.js`, `types: rapier.d.ts`, no `exports` map; `rapier_wasm3d.js` does `import * as wasm from "./rapier_wasm3d_bg.wasm"` (ESM wasm import), so it needs bundler wasm support. There is NO `init()` export in the non-compat build (its `init.d.ts` is `export {}`); you just `import('@dimforge/rapier3d')`.
- Both packages export the same TS API otherwise (`export * from "./exports"; export default RAPIER;`).

## Init (compat) — dist/init.d.ts
```ts
export declare function init(): Promise<void>;   // "Has to be called and awaited before using any library methods."
export declare function version(): string;
export declare function reserveMemory(extraBytesCount: number): void;
```
```ts
import RAPIER from '@dimforge/rapier3d-compat';      // default export = namespace (also `import * as RAPIER`)
await RAPIER.init();                                  // idempotent: implementation returns cached exports on 2nd call
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
```
Official getting-started also shows `RAPIER.init().then(() => {...})`. Non-compat: `import('@dimforge/rapier3d').then(RAPIER => {...})`.

## World — dist/pipeline/world.d.ts
```ts
constructor(gravity: Vector, rawIntegrationParameters?: RawIntegrationParameters, rawIslands?, rawBroadPhase?, rawNarrowPhase?, rawBodies?, rawColliders?, rawSoftBodies?, ...)  // only `gravity` is needed
gravity: Vector;
integrationParameters: IntegrationParameters;   // .dt get/set, .numSolverIterations, .lengthUnit, .maxCcdSubsteps, ...
get timestep(): number;  set timestep(dt: number);   // seconds; Rust default dt = 1/60
get numSolverIterations(): number; set numSolverIterations(n: number);   // default 4
get lengthUnit(): number; set lengthUnit(unitsPerMeter: number);          // default 1.0
get maxCcdSubsteps(): number; set maxCcdSubsteps(substeps: number);       // default 1; 0 disables CCD entirely
step(eventQueue?: EventQueue, hooks?: PhysicsHooks): void;
propagateModifiedBodyPositionsToColliders(): void;
createRigidBody(body: RigidBodyDesc): RigidBody;
createCollider(desc: ColliderDesc, parent?: RigidBody): Collider;
removeRigidBody(body: RigidBody): void;
removeCollider(collider: Collider, wakeUp: boolean): void;
getRigidBody(handle: RigidBodyHandle): RigidBody;      // handles are plain numbers
getCollider(handle: ColliderHandle): Collider;
createCharacterController(offset: number): KinematicCharacterController;
removeCharacterController(c: KinematicCharacterController): void;
createVehicleController(chassis: RigidBody): DynamicRayCastVehicleController;
removeVehicleController(c: DynamicRayCastVehicleController): void;
castRay(ray: Ray, maxToi: number, solid: boolean, filterFlags?: QueryFilterFlags, filterGroups?: InteractionGroups, filterExcludeCollider?: Collider, filterExcludeRigidBody?: RigidBody, filterPredicate?: (collider: Collider) => boolean): RayColliderHit | null;
castRayAndGetNormal(...same args...): RayColliderIntersection | null;
intersectionsWithRay(ray, maxToi, solid, callback: (intersect: RayColliderIntersection) => boolean, filterFlags?, filterGroups?, filterExcludeCollider?, filterExcludeRigidBody?, filterPredicate?): void;
castShape(shapePos: Vector, shapeRot: Rotation, shapeVel: Vector, shape: Shape, targetDistance: number, maxToi: number, stopAtPenetration: boolean, filterFlags?, filterGroups?, filterExcludeCollider?, filterExcludeRigidBody?, filterPredicate?): ColliderShapeCastHit | null;
contactPair(c1: Collider, c2: Collider, f: (manifold: TempContactManifold, flipped: boolean) => void): void;
contactPairsWith(c1: Collider, f: (c2: Collider) => void): void;
intersectionPairsWith(c1: Collider, f: (c2: Collider) => void): void;
forEachCollider(f: (c: Collider) => void): void;
takeSnapshot(): Uint8Array;  static restoreSnapshot(data: Uint8Array): World;
debugRender(filterFlags?, filterPredicate?): DebugRenderBuffers;
free(): void;
```
Fixed-step loop (official docs only show `world.step()` in a setTimeout(…,16) loop; the accumulator is standard practice, not from rapier docs):
```ts
world.timestep = 1/60;
let acc = 0; function frame(dt) { acc += dt; while (acc >= 1/60) { vehicle?.updateVehicle(world.timestep, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC); world.step(eventQueue); acc -= 1/60; } }
```

## Math types — dist/math.d.ts
`interface Vector { x; y; z }`, `class Vector3 implements Vector`, `interface Rotation { x; y; z; w }`, `class Quaternion implements Rotation`. Plain `{x,y,z}` / `{x,y,z,w}` object literals are accepted everywhere. Getters take an optional `target` to avoid allocation: `body.translation(target?: Vector)`.

## RigidBodyDesc — dist/dynamics/rigid_body.d.ts
```ts
static dynamic(): RigidBodyDesc; static fixed(): RigidBodyDesc;
static kinematicPositionBased(): RigidBodyDesc; static kinematicVelocityBased(): RigidBodyDesc;
// legacy aliases still present: newDynamic(), newStatic(), newKinematicPositionBased(), newKinematicVelocityBased()
setTranslation(x: number, y: number, z: number): RigidBodyDesc;   // NOTE: 3 numbers, not a Vector
setRotation(rot: Rotation): RigidBodyDesc;                          // {x,y,z,w}
setLinvel(x: number, y: number, z: number): RigidBodyDesc;          // 3 numbers
setAngvel(vel: Vector): RigidBodyDesc;                              // Vector
setGravityScale(scale): setAdditionalMass(mass): setAdditionalMassProperties(mass, centerOfMass, principalAngularInertia, angularInertiaLocalFrame):
lockTranslations(): lockRotations(): enabledTranslations(x,y,z): enabledRotations(x,y,z): restrictTranslations/restrictRotations(x,y,z):
setLinearDamping(d): setAngularDamping(d): setCanSleep(bool): setSleeping(bool): setCcdEnabled(bool): setSoftCcdPrediction(distance):
setDominanceGroup(g): setAdditionalSolverIterations(n): setAdditionalPgsIterations(n): setEnabled(bool): setUserData(data?: unknown)
```
```ts
const chassis = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 2, 0).setCanSleep(false).setLinearDamping(0.1).setAngularDamping(0.5));
```

## RigidBody (instance)
```ts
translation(target?: Vector): Vector;  rotation(target?: Rotation): Rotation;
linvel(target?): Vector; angvel(target?): Vector; velocityAtPoint(point, target?): Vector;
setTranslation(tra: Vector, wakeUp: boolean): void;  setRotation(rot: Rotation, wakeUp: boolean): void;   // teleport
setLinvel(vel: Vector, wakeUp: boolean): void;  setAngvel(vel: Vector, wakeUp: boolean): void;
setNextKinematicTranslation(t: Vector): void;  setNextKinematicRotation(rot: Rotation): void;   // kinematicPositionBased only; applied on next step
applyImpulse(impulse: Vector, wakeUp: boolean): void; applyImpulseAtPoint(impulse, point, wakeUp): void; applyTorqueImpulse(t, wakeUp): void;
addForce(force: Vector, wakeUp: boolean): void; addForceAtPoint(force, point, wakeUp): void; addTorque(t, wakeUp): void; resetForces(wakeUp): resetTorques(wakeUp):
mass(): number; invMass(): number; worldCom(target?): Vector; localCom(target?): Vector;
lockRotations(locked: boolean, wakeUp: boolean): void; lockTranslations(locked, wakeUp): void; setEnabledRotations(x,y,z,wakeUp): setEnabledTranslations(x,y,z,wakeUp):
setLinearDamping(f): setAngularDamping(f): setGravityScale(f, wakeUp): enableCcd(bool): setSoftCcdPrediction(d):
sleep(): wakeUp(): isSleeping(): isMoving(): isFixed(): isKinematic(): isDynamic(): bodyType(): RigidBodyType; setBodyType(type, wakeUp):
numColliders(): number; collider(i): Collider; handle: RigidBodyHandle; userData?: unknown; setEnabled(bool): isEnabled():
```
`enum RigidBodyType { Dynamic = 0, Fixed = 1, KinematicPositionBased = 2, KinematicVelocityBased = 3, SoftFrame (new in 0.21) }`.

## ColliderDesc — dist/geometry/collider.d.ts
```ts
static cuboid(hx: number, hy: number, hz: number): ColliderDesc;           // HALF-extents
static ball(radius: number): ColliderDesc;
static capsule(halfHeight: number, radius: number): ColliderDesc;          // principal axis = local Y
static cylinder(halfHeight: number, radius: number): ColliderDesc;
static roundCuboid(hx, hy, hz, borderRadius): ColliderDesc;
static trimesh(vertices: Float32Array, indices: Uint32Array, flags?: TriMeshFlags): ColliderDesc;
static heightfield(nrows: number, ncols: number, heights: Float32Array, scale: Vector, flags?: HeightFieldFlags): ColliderDesc;
   // heights: "matrix stored in column-major order", nrows = subdivisions along local Z, ncols = along local X;
   // scale = "dimensions of the heightfield's local x,z plane" (scale.y multiplies heights). heights.length must be nrows*ncols.
static convexHull(points: Float32Array): ColliderDesc | null;              // NOTE nullable
static convexMesh(vertices: Float32Array, indices?: Uint32Array | null): ColliderDesc | null;
static voxels(voxels: Float32Array | Int32Array, voxelSize: Vector): ColliderDesc;
// builder (all return ColliderDesc):
setTranslation(x: number, y: number, z: number)  setRotation(rot: Rotation)
setFriction(friction: number)  setRestitution(restitution: number)  setFrictionCombineRule(rule: CoefficientCombineRule)  setRestitutionCombineRule(rule)
setDensity(density: number)  setMass(mass: number)  setMassProperties(mass, centerOfMass, principalAngularInertia, angularInertiaLocalFrame)
setSensor(sensor: boolean)  setEnabled(bool)  setContactSkin(thickness)
setCollisionGroups(groups: InteractionGroups /* number: (memberships << 16) | filter */)  setSolverGroups(groups)
setActiveEvents(activeEvents: ActiveEvents)  setActiveHooks(h)  setActiveCollisionTypes(t)  setContactForceEventThreshold(threshold: number)
```
```ts
const ground = world.createCollider(RAPIER.ColliderDesc.cuboid(100, 0.1, 100).setFriction(1.0));          // no parent => fixed
const body = world.createCollider(RAPIER.ColliderDesc.cuboid(1.0, 0.5, 2.2).setMass(1200).setFriction(0.8).setRestitution(0.1), chassis);
const hf = world.createCollider(RAPIER.ColliderDesc.heightfield(nrows, ncols, heights, { x: 500, y: 1, z: 500 }, RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES));
const tm = world.createCollider(RAPIER.ColliderDesc.trimesh(verts, idx, RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES));
```
Collider instance: `handle: ColliderHandle`, `parent(): RigidBody | null`, `translation(target?)`, `rotation(target?)`, `setTranslation(tra: Vector)`, `setTranslationWrtParent(tra)`, `setRotation(rot)`, `setRotationWrtParent(rot)`, `setFriction(f)`, `setRestitution(r)`, `friction()`, `restitution()`, `setSensor(bool)`, `isSensor()`, `setDensity(d)`, `setMass(m)`, `setCollisionGroups(g)`, `setActiveEvents(e)`, `setContactForceEventThreshold(t)`, `halfExtents(target?)`, `radius()`, `containsPoint(p)`, `castRay(ray, maxToi, solid): number`, `setEnabled(bool)`.

Flag enums (verbatim values): `ActiveEvents { NONE = 0, COLLISION_EVENTS = 1, CONTACT_FORCE_EVENTS = 2 }`; `HeightFieldFlags { FIX_INTERNAL_EDGES = 1 }`; `TriMeshFlags { ..., DELETE_BAD_TOPOLOGY_TRIANGLES = 4, ORIENTED = 8, MERGE_DUPLICATE_VERTICES = 16, DELETE_DEGENERATE_TRIANGLES = 32, DELETE_DUPLICATE_TRIANGLES = 64, FIX_INTERNAL_EDGES = 144, DEFORMABLE = 256, FIX_INTERNAL_EDGES_TWO_SIDED = 656 }`.

## Raycasting — dist/geometry/ray.d.ts, dist/pipeline/query_pipeline.d.ts
```ts
class Ray { constructor(origin: Vector, dir: Vector); origin; dir; pointAt(t: number): Vector; }
class RayColliderHit { collider: Collider; timeOfImpact: number; }                                    // from world.castRay
class RayColliderIntersection { collider: Collider; timeOfImpact: number; normal: Vector; featureType; featureId }  // from castRayAndGetNormal
class ColliderShapeCastHit { collider: Collider; time_of_impact: number; witness1; witness2; normal1; normal2 }      // NOTE snake_case here
enum QueryFilterFlags { EXCLUDE_FIXED = 1, EXCLUDE_KINEMATIC = 2, EXCLUDE_DYNAMIC = 4, EXCLUDE_SENSORS = 8, EXCLUDE_SOLIDS = 16, ONLY_DYNAMIC = 3, ONLY_KINEMATIC = 5, ONLY_FIXED = 6 }
```
```ts
const ray = new RAPIER.Ray({ x: 0, y: 10, z: 0 }, { x: 0, y: -1, z: 0 });   // dir need not be unit; toi is in units of dir
const hit = world.castRay(ray, 100, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC, undefined, undefined, chassis /* exclude body */);
if (hit) { const p = ray.pointAt(hit.timeOfImpact); const body = hit.collider.parent(); }
const hitN = world.castRayAndGetNormal(ray, 100, true); // hitN.normal
```
`filterGroups` is an `InteractionGroups` number; `filterPredicate` returns false to exclude.

## Collision events — dist/pipeline/event_queue.d.ts
```ts
class EventQueue { constructor(autoDrain: boolean, raw?); drainCollisionEvents(f: (handle1: ColliderHandle, handle2: ColliderHandle, started: boolean) => void): void; drainContactForceEvents(f: (event: TempContactForceEvent) => void): void; drainSoftBodyTearEvents(f): void /* new 0.21 */; clear(): void; free(): void; }
class TempContactForceEvent { collider1(): ColliderHandle; collider2(): ColliderHandle; totalForce(); totalForceMagnitude(); maxForceDirection(); maxForceMagnitude(); free(); }
```
```ts
const eventQueue = new RAPIER.EventQueue(true);   // autoDrain=true "strongly recommended"
// at least one collider of the pair must have COLLISION_EVENTS:
RAPIER.ColliderDesc.cuboid(...).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS | RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(500)
world.step(eventQueue);
eventQueue.drainCollisionEvents((h1, h2, started) => { const c1 = world.getCollider(h1), c2 = world.getCollider(h2); /* c1.parent() */ });
eventQueue.drainContactForceEvents(ev => { ev.collider1(); ev.totalForceMagnitude(); });
```
Also available without events: `world.contactPair(c1, c2, (manifold, flipped) => ...)`, `world.contactPairsWith(c, other => ...)`, `world.intersectionPairsWith(c, other => ...)` (sensors).

## DynamicRayCastVehicleController — dist/control/ray_cast_vehicle_controller.d.ts
```ts
// create via world (do NOT use the raw constructor: constructor(chassis, broadPhase, narrowPhase, bodies, colliders))
const vehicle = world.createVehicleController(chassis);
addWheel(chassisConnectionCs: Vector, directionCs: Vector, axleCs: Vector, suspensionRestLength: number, radius: number): void;
   // chassisConnectionCs: wheel position relative to chassis; directionCs: suspension direction (ray-cast direction, e.g. {0,-1,0}); axleCs: axle axis (e.g. {-1,0,0} or {0,0,1} per the docs example)
numWheels(): number;
updateVehicle(dt: number, filterFlags?: QueryFilterFlags, filterGroups?: InteractionGroups, filterPredicate?: (collider: Collider) => boolean): void;  // call BEFORE world.step() each step
setWheelSteering(i: number, value: number): void;   wheelSteering(i): number | null;      // radians
setWheelEngineForce(i: number, value: number): void; wheelEngineForce(i): number | null;
setWheelBrake(i: number, value: number): void;       wheelBrake(i): number | null;
setWheelSuspensionStiffness(i, value)  setWheelSuspensionCompression(i, value)  setWheelSuspensionRelaxation(i, value)
setWheelMaxSuspensionTravel(i, value)  setWheelMaxSuspensionForce(i, value)  setWheelSuspensionRestLength(i, value)  setWheelRadius(i, value)
setWheelFrictionSlip(i, value)  setWheelSideFrictionStiffness(i, value)  setWheelChassisConnectionPointCs(i, v: Vector)  setWheelDirectionCs(i, v)  setWheelAxleCs(i, v)
// read-back (all `| null` for bad index):
wheelSuspensionLength(i): number | null;  wheelRotation(i): number | null /* radians on axle */;  wheelIsInContact(i): boolean;
wheelContactPoint(i, target?): Vector | null;  wheelContactNormal(i, target?): Vector | null;  wheelGroundObject(i): Collider | null;
wheelChassisConnectionPointCs(i, target?): Vector | null;  wheelHardPoint(i, target?): Vector | null;
wheelForwardImpulse(i): number | null;  wheelSideImpulse(i): number | null;  wheelSuspensionForce(i): number | null;
currentVehicleSpeed(): number;  chassis(): RigidBody;
get indexUpAxis(): number; set indexUpAxis(axis: number);           // 0=x,1=y,2=z; Rust default 1 (Y up)
get indexForwardAxis(): number; set setIndexForwardAxis(axis: number); // NOTE the setter is literally named `setIndexForwardAxis` (used as property: vehicle.setIndexForwardAxis = 2); Rust default 0 (X forward)
free(): void;
```
Rust `WheelTuning` defaults (apply to every added wheel): suspension_stiffness 5.88, suspension_compression 0.83, suspension_damping(relaxation) 0.88, max_suspension_travel 5.0, side_friction_stiffness 1.0, friction_slip 10.5, max_suspension_force 6000.0.
Official JS usage: `vehicle.addWheel(position, {x:0,y:-1,z:0}, {x:0,y:0,z:1}, hh, hh/4.0); vehicle.setWheelSuspensionStiffness(i, 100.0); vehicle.setWheelEngineForce(0, 30.0); vehicle.setWheelSteering(0, 0.2); vehicle.updateVehicle(world.integrationParameters.dt, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC); vehicle.currentVehicleSpeed();`
Wheel world pose for rendering: chassis pose * (wheelChassisConnectionPointCs + directionCs * wheelSuspensionLength), rotate by wheelSteering about up and wheelRotation about axle.

## KinematicCharacterController — dist/control/character_controller.d.ts
```ts
const cc = world.createCharacterController(0.01);   // offset = gap kept from obstacles (Rust default Relative(0.01))
setUp(vector: Vector): void; up(): Vector;                      // default {0,1,0}
setOffset(v): offset(): setSlideEnabled(bool): slideEnabled():  // slide default true
setMaxSlopeClimbAngle(angle: number): void;  setMinSlopeSlideAngle(angle: number): void;   // radians; defaults both PI/4
enableAutostep(maxHeight: number, minWidth: number, includeDynamicBodies: boolean): void; disableAutostep(): void;   // default off
enableSnapToGround(distance: number): void; disableSnapToGround(): void;   // Rust default ON at Relative(0.2)
setApplyImpulsesToDynamicBodies(enabled: boolean): void;  setCharacterMass(mass: number | null): void;  setNormalNudgeFactor(v): void;
computeColliderMovement(collider: Collider, desiredTranslationDelta: Vector, filterFlags?: QueryFilterFlags, filterGroups?: InteractionGroups, filterPredicate?: (collider: Collider) => boolean): void;
computedMovement(target?: Vector): Vector;  computedGrounded(): boolean;
numComputedCollisions(): number;  computedCollision(i: number, out?: CharacterCollision): CharacterCollision | null;
   // CharacterCollision { collider: Collider | null; translationDeltaApplied; translationDeltaRemaining; toi: number; witness1; witness2; normal1; normal2 }
free(): void;
```
```ts
// per step, with a kinematicPositionBased body + its collider:
cc.computeColliderMovement(charCollider, desired, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS);
const m = cc.computedMovement(); const t = charBody.translation();
charBody.setNextKinematicTranslation({ x: t.x + m.x, y: t.y + m.y, z: t.z + m.z });
```

## Web Worker
Not covered by official rapier docs (no page mentions workers). Verified from the shipped `dist/rapier.mjs`: compat `init()` decodes the embedded base64 with `base64-js.toByteArray(...)` and passes `{ module_or_path: <Uint8Array> }` to the wasm-bindgen loader, which then calls `WebAssembly.instantiate(bytes, imports)` — no `fetch`, no `document`, and the only `window` reference is a `typeof window` guard. It therefore runs in a module Web Worker (and in Node, which is how `npm view`/tests exercise it). Pattern: `const w = new Worker(new URL('./physics.worker.ts', import.meta.url), { type: 'module' })`; inside the worker `import RAPIER from '@dimforge/rapier3d-compat'; await RAPIER.init();` then post transforms back (Float32Array via transfer). The non-compat package in a Worker still needs the bundler to handle the ESM `.wasm` import.

## Renames / breaking check for 0.20 -> 0.21 (verbatim changelog)
0.21.0 (24 Sep 2026): Breaking only for raw-pipeline users (`PhysicsPipeline.step`, `RigidBodySet.remove`, `ColliderSet.remove`, World constructor now take a `SoftBodySet` after the collider set) and new `RigidBodyType.SoftFrame`. Added soft bodies, `EventQueue.drainSoftBodyTearEvents`, `TriMeshFlags.DEFORMABLE`/`FIX_INTERNAL_EDGES_TWO_SIDED`, `RigidBody(Desc).setAdditionalPgsIterations`. Fixed: `EventQueue.clear()` now also discards pending contact-force events. Modified: Rapier 0.36 / parry 0.31; bindings moved to `bindings/typescript`.
0.20.0 (08 Aug 2026): Breaking: compat files moved into `dist/` (package-entry imports unaffected); `IntegrationParameters.minIslandSize` removed; `NarrowPhase.contactPair` takes `RigidBodySet` 3rd (World.contactPair unchanged); `TempContactManifold.solverContactFriction/Restitution` -> `friction()`/`restitution()`. Fixed: compat passes wasm to `init()` as an object. Modified: Rapier 0.35 (rewritten sleeping, sweep CCD on by default vs fixed colliders, changed defaults).
NONE of: init, World ctor/timestep/step, RigidBodyDesc.*, ColliderDesc.cuboid/ball/trimesh/heightfield, setFriction/setRestitution, translation()/rotation()/setNextKinematicTranslation, DynamicRayCastVehicleController.*, KinematicCharacterController.*, castRay/QueryFilterFlags, EventQueue.drainCollisionEvents were renamed in 0.20 or 0.21. The `toi` -> `timeOfImpact` rename on ray hits dates from 0.13.

## Gotchas

- RigidBodyDesc.setTranslation / setLinvel take three numbers (x, y, z), but RigidBody.setTranslation / setLinvel / setNextKinematicTranslation take a Vector object and most RigidBody setters require an explicit `wakeUp: boolean` second argument.
- ColliderDesc.cuboid(hx, hy, hz) takes HALF-extents; capsule/cylinder take (halfHeight, radius) with the principal axis on local Y.
- Ray hit field is `hit.timeOfImpact` (RayColliderHit / RayColliderIntersection), but shape-cast hits use `hit.time_of_impact` (snake_case) in ColliderShapeCastHit — verified in dist/geometry/toi.d.ts. Docs prose still says 'toi'; the code field is timeOfImpact.
- world.castRay returns `RayColliderHit | null` and `hit.collider` is a Collider object (call `.parent()` for the RigidBody, `.handle` for the number); drainCollisionEvents gives numeric handles — resolve with world.getCollider(handle).
- QueryFilterFlags are bit flags: EXCLUDE_FIXED=1, EXCLUDE_KINEMATIC=2, EXCLUDE_DYNAMIC=4, EXCLUDE_SENSORS=8, EXCLUDE_SOLIDS=16; ONLY_DYNAMIC=3, ONLY_KINEMATIC=5, ONLY_FIXED=6 are composites. Ray `dir` need not be normalized; timeOfImpact is in multiples of dir.
- DynamicRayCastVehicleController.updateVehicle(dt, ...) must be called every step BEFORE world.step(), with dt = world.timestep (or world.integrationParameters.dt). Pass QueryFilterFlags.EXCLUDE_DYNAMIC (official example) or a filterPredicate that excludes the chassis colliders, otherwise suspension rays can hit the chassis itself (the JS binding does not auto-exclude the chassis; only the Python binding does per the 0.35 changelog).
- The forward-axis setter on the vehicle controller is an accessor literally named `setIndexForwardAxis` (use `vehicle.setIndexForwardAxis = 2`), while the up-axis setter is `vehicle.indexUpAxis = 1`. Defaults: up = 1 (Y), forward = 0 (X); set forward to 2 if your chassis faces -Z/+Z.
- Vehicle wheel defaults (Rust WheelTuning): stiffness 5.88, compression 0.83, relaxation 0.88, maxSuspensionTravel 5.0, sideFrictionStiffness 1.0, frictionSlip 10.5, maxSuspensionForce 6000. Since Rapier 0.35 (JS 0.20), braking strength is bounded by frictionSlip and wheelRotation accumulates from the actual rolling direction; a car tuned on 0.19 may need re-tuning.
- ColliderDesc.heightfield(nrows, ncols, heights, scale, flags?): heights is a Float32Array in COLUMN-MAJOR order of size nrows*ncols; nrows = subdivisions along local Z, ncols = along local X; scale.x/scale.z are the full X/Z dimensions and scale.y multiplies heights. Pass RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES (and TriMeshFlags.FIX_INTERNAL_EDGES for trimeshes) to avoid bumps at triangle edges. (From memory, not verified here: the heightfield is centered on the collider origin.)
- ColliderDesc.convexHull / convexMesh return `ColliderDesc | null` — check for null before createCollider.
- Collision events need `setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)` on at least one collider of the pair; construct `new RAPIER.EventQueue(true)` (autoDrain) and pass it to world.step(eventQueue). EventQueue, World, character/vehicle controllers wrap WASM memory and must be `.free()`d (or removed via world.remove*) to avoid leaks.
- Kinematic position-based bodies: use setNextKinematicTranslation/Rotation each step (applied during the next world.step) rather than setTranslation, so Rapier computes a velocity for contacts with dynamic bodies.
- KinematicCharacterController.computeColliderMovement has no built-in gravity; add the vertical component to desiredTranslationDelta yourself and use computedGrounded(). Rust defaults: snap-to-ground is ON (Relative 0.2), slide on, autostep off, max climb / min slide angles both 45 degrees. Since 0.35, snap-to-ground triggers on any non-upward movement (lateral movement no longer flickers `grounded`).
- Rapier 0.35 (JS 0.20) changed physics defaults: sleep thresholds (linear 0.05, time_until_sleep 0.5 s), CCD now always runs for fast dynamic bodies against fixed colliders (set world.maxCcdSubsteps = 0 to disable), linear speed capped at 400 units/s per substep, prediction distance 0.02 and allowed linear error 0.005. If the car feels different from older tutorials, this is why.
- World.timestep is in seconds (Rust default 1/60); keep it fixed and use an accumulator rather than passing variable frame dt — the d.ts warns that a timestep with large variations may cause instabilities.
- Compat bundle is large: dist/rapier.mjs is ~4.3 MB (base64-inlined ~3.1 MB wasm). Load it in a worker or behind a dynamic import if first paint matters; it gzips reasonably but cannot be streamed-compiled like a separate .wasm.
- Deep imports into the compat package changed in 0.20: files live under dist/ (dist/rapier.mjs, dist/rapier.cjs, dist/rapier.d.ts). Normal `import ... from '@dimforge/rapier3d-compat'` is unaffected.
- Getters such as body.translation(), rotation(), linvel() allocate a new object each call unless you pass a `target` to be filled — do this in the per-frame sync loop.
- Official rapier.rs JS docs do not mention Vite or Web Workers at all; worker safety of the compat build was verified by reading the shipped init code (base64 decode + WebAssembly.instantiate, no fetch/DOM).

## Compatibility warnings

- Node v22.22.0 / npm 10.9.4: @dimforge/rapier3d-compat@0.21.0 has no engines field, no dependencies and no peerDependencies, so there are no peer-range conflicts to resolve. It runs under Node (CJS via dist/rapier.cjs, ESM via dist/rapier.mjs) for unit tests without any wasm loader.
- @dimforge/rapier3d@0.21.0 (non-compat) relies on an ESM `import * as wasm from './rapier_wasm3d_bg.wasm'`; Vite does not handle that natively (requires vite-plugin-wasm + vite-plugin-top-level-await, which is not documented by rapier and was not verified here). For a Vite project, prefer the -compat package unless you are willing to configure wasm plugins.
- The rapier.js GitHub repo's CHANGELOG stops at 0.19.3; the authoritative changelog for 0.20/0.21 is https://github.com/dimforge/rapier/blob/master/bindings/typescript/CHANGELOG.md (bindings moved into the main rapier monorepo in 0.21).
- 0.21.0 added `rawSoftBodies` to the World constructor (8th positional raw argument) — only affects code that constructs World from raw pipeline parts or calls PhysicsPipeline.step / RigidBodySet.remove / ColliderSet.remove directly; `new RAPIER.World(gravity)` is unchanged.
- rapier3d-compat 0.21.0 snapshots (world.takeSnapshot) are not loadable by 0.20.x or earlier and vice versa (Rapier 0.36 changed the serialization format).
- TypeScript: the compat package resolves types through `exports['.'].types`; with `moduleResolution: 'node'` (legacy) the top-level `types: dist/rapier.d.ts` field still works. `import RAPIER from '@dimforge/rapier3d-compat'` requires `esModuleInterop`/`allowSyntheticDefaultImports` only under CJS resolution; under Vite/ESM the real default export exists.
- RigidBodyDesc.newDynamic/newStatic/newKinematic* still exist in 0.21.0 as legacy aliases but are superseded by dynamic()/fixed()/kinematicPositionBased()/kinematicVelocityBased(); use the new names.
