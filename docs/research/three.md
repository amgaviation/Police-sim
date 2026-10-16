# three (three.js r186) + @types/three — pinned three@0.186.1, @types/three@0.186.0

Sources:
- https://registry.npmjs.org (npm view three@0.186.1 / @types/three@0.186.0, dist-tags, tarball listings; three 0.186.1 published 2026-09-24, @types/three 0.186.0 updated 2026-09-11)
- https://raw.githubusercontent.com/mrdoob/three.js/r186/package.json (exports map)
- https://raw.githubusercontent.com/mrdoob/three.js/r186/manual/pages/installation.html (served at https://threejs.org/manual/#installation)
- https://raw.githubusercontent.com/mrdoob/three.js/r186/manual/pages/webgpurenderer.html
- https://raw.githubusercontent.com/mrdoob/three.js/r186/README.md
- https://github.com/mrdoob/three.js/wiki/Migration-Guide (r180..r186 sections)
- https://github.com/mrdoob/three.js/releases/tag/r186
- https://raw.githubusercontent.com/mrdoob/three.js/r186/src/constants.js
- https://raw.githubusercontent.com/mrdoob/three.js/r186/src/renderers/WebGLRenderer.js
- https://raw.githubusercontent.com/mrdoob/three.js/r186/src/renderers/webgl/WebGLInfo.js
- https://raw.githubusercontent.com/mrdoob/three.js/r186/src/renderers/webgl/WebGLShadowMap.js
- https://raw.githubusercontent.com/mrdoob/three.js/r186/src/renderers/webgpu/WebGPURenderer.js
- https://raw.githubusercontent.com/mrdoob/three.js/r186/src/objects/InstancedMesh.js
- https://raw.githubusercontent.com/mrdoob/three.js/r186/src/objects/LOD.js
- https://raw.githubusercontent.com/mrdoob/three.js/r186/src/objects/Mesh.js
- https://raw.githubusercontent.com/mrdoob/three.js/r186/src/core/Object3D.js
- https://raw.githubusercontent.com/mrdoob/three.js/r186/src/core/Clock.js
- https://raw.githubusercontent.com/mrdoob/three.js/r186/src/core/Timer.js
- https://raw.githubusercontent.com/mrdoob/three.js/r186/src/core/BufferGeometry.js
- https://raw.githubusercontent.com/mrdoob/three.js/r186/src/Three.Core.js and src/Three.js (export lists)
- https://raw.githubusercontent.com/mrdoob/three.js/r186/src/math/ColorManagement.js
- https://raw.githubusercontent.com/mrdoob/three.js/r186/src/lights/LightShadow.js and DirectionalLightShadow.js
- https://raw.githubusercontent.com/mrdoob/three.js/r186/src/scenes/Fog.js and FogExp2.js
- https://raw.githubusercontent.com/mrdoob/three.js/r186/src/cameras/PerspectiveCamera.js
- https://raw.githubusercontent.com/mrdoob/three.js/r186/src/materials/MeshStandardMaterial.js and Material.js
- https://raw.githubusercontent.com/mrdoob/three.js/r186/examples/jsm/controls/OrbitControls.js
- https://raw.githubusercontent.com/mrdoob/three.js/r186/examples/jsm/libs/stats.module.js
- @types/three@0.186.0 tarball: index.d.ts, package.json, src/renderers/WebGLRenderer.d.ts, webgl/WebGLInfo.d.ts, webgl/WebGLShadowMap.d.ts, src/core/Timer.d.ts, src/core/Clock.d.ts, src/objects/InstancedMesh.d.ts, src/objects/LOD.d.ts, src/objects/Mesh.d.ts, src/core/Object3D.d.ts, src/constants.d.ts, examples/jsm/controls/OrbitControls.d.ts, examples/jsm/libs/stats.module.d.ts
- https://github.com/three-types/three-ts-types (README)

## API notes

VERSIONS / PACKAGING (verified against npm registry + r186 package.json)
- `three` latest = 0.186.1 (REVISION '186'); 0.186.0 published 2026-09-08, 0.186.1 2026-09-24. `@types/three` latest = 0.186.0 (typeScriptVersion >= 5.6; dist-tags ts5.6..ts7.1 all -> 0.186.0). peerDependencies: none on either package.
- `three` ships ZERO .d.ts files (tarball grep count = 0; package.json has no "types"/"typings"). You still need `@types/three`. The Installation manual (r186) says verbatim: "Community-maintained TypeScript type definitions for three.js are available at three-types/three-ts-types" (periodically pushed to DefinitelyTyped as @types/three). @types/three/index.d.ts is just `export * from "./src/Three.js";`.
- three package.json: `"type": "module"`, `"module": "./build/three.module.js"`, `"main": "./build/three.cjs"` (CJS build DEPRECATED in r186 release notes; minified builds removed). exports map:
  ".": import ./build/three.module.js | require ./build/three.cjs
  "./webgpu": ./build/three.webgpu.js
  "./tsl": ./build/three.tsl.js
  "./addons": ./examples/jsm/Addons.js
  "./addons/*": ./examples/jsm/*
  "./examples/jsm/*": ./examples/jsm/*
  "./src/*": ./src/*
  "./examples/fonts/*": ./examples/fonts/*
  @types/three mirrors the same exports map, so `three/addons/...` resolves in TS with moduleResolution bundler/node16.

IMPORTS (Installation manual r186, verbatim)
```ts
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
const controls = new OrbitControls( camera, renderer.domElement );
```
Named imports from 'three' also fine: `import { WebGLRenderer, Scene, PerspectiveCamera, InstancedMesh, LOD, Timer, Fog, FogExp2, ColorManagement, Frustum } from 'three';` (all verified exported from src/Three.Core.js / src/Three.js). Stats (ESM default export): `import Stats from 'three/addons/libs/stats.module.js';` — file is `var Stats = function(){...}; export default Stats;` with `stats.dom`, `begin()`, `end()`, `update()`, `showPanel(id)`. @types/three types it as `import Stats = require("stats.js"); export default Stats;` (hence @types/stats.js is a dependency of @types/three — installed automatically). Manual recommends Vite: `npm install --save three` + `npm install --save-dev vite`, `npx vite`, `npx vite build` -> dist/. Vite needs no importmap. CDN importmap (only if not bundling): `{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@<version>/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@<version>/examples/jsm/"}}`.

WebGLRenderer CONSTRUCTOR (src/renderers/WebGLRenderer.js r186, verbatim destructuring defaults)
canvas = createCanvasElement(), context = null, depth = true, stencil = false, alpha = false, antialias = false, premultipliedAlpha = true, preserveDrawingBuffer = false, powerPreference = 'default' ('default'|'low-power'|'high-performance'), failIfMajorPerformanceCaveat = false, reversedDepthBuffer = false (needs EXT_clip_control; "more accurate than a logarithmic depth buffer"), outputBufferType = UnsignedByteType (HalfFloatType recommended for HDR/tonemapping/postprocessing), plus logarithmicDepthBuffer = false and precision (read via capabilities). TS: `WebGLRendererParameters extends WebGLCapabilitiesParameters` (the latter holds precision/logarithmicDepthBuffer/reversedDepthBuffer). WebGL1 is rejected ("WebGL 1 is not supported since r163").
```ts
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // setPixelRatio(value:number): "Sets the given pixel ratio and resizes the canvas if necessary."
renderer.setSize(width, height, updateStyle = true); // "Resizes the output canvas to (width, height) with device pixel ratio taken into account"
renderer.setAnimationLoop(animate); // README usage; animate(time) { renderer.render(scene, camera); }
document.body.appendChild(renderer.domElement);
```
Defaults: `renderer.outputColorSpace` = SRGBColorSpace (getter/setter; setter also sets gl.drawingBufferColorSpace/unpackColorSpace), `toneMapping` = NoToneMapping, `toneMappingExposure` = 1.0, `autoClear` = true, `shadowMap.enabled` = false, `shadowMap.type` = PCFShadowMap, `shadowMap.autoUpdate` = true, `shadowMap.needsUpdate` = false. `renderer.dispose()`: "Frees the GPU-related resources allocated by this instance." (disposes program cache, render lists/states, xr, stops animation loop).

renderer.info (src/renderers/webgl/WebGLInfo.js)
```ts
renderer.info.render.calls      // draw calls this frame
renderer.info.render.triangles  // += instanceCount * (count / 3) for gl.TRIANGLES
renderer.info.render.points, .lines, .frame
renderer.info.memory.geometries, .textures
renderer.info.programs          // null | WebGLProgram[]
renderer.info.autoReset         // default true: reset() is called after each render() (render.frame++ then reset if autoReset)
renderer.info.reset()           // zeroes calls/triangles/points/lines (not frame/memory)
```
For multi-pass frames set `renderer.info.autoReset = false` and call `renderer.info.reset()` yourself once per frame. Read the counters AFTER render() (with autoReset they are reset at the START of the next render, so reading right after render is correct).

InstancedMesh (src/objects/InstancedMesh.js)
```ts
const mesh = new THREE.InstancedMesh(geometry, material, count); // count = MAXIMUM instances; instanceMatrix = new InstancedBufferAttribute(new Float32Array(count*16), 16), all set to identity
mesh.setMatrixAt(i, matrix4);  // matrix.toArray(this.instanceMatrix.array, index*16)
mesh.getMatrixAt(i, outMatrix4);
mesh.setColorAt(i, color);     // lazily allocates instanceColor = InstancedBufferAttribute(Float32Array(count*3).fill(1), 3)
mesh.instanceMatrix.needsUpdate = true;   // REQUIRED after any setMatrixAt batch
if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true; // REQUIRED after setColorAt
mesh.count = n;                // runtime draw count, integer in [0, count]; cannot exceed constructor count (create a new InstancedMesh)
mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); // if updated every frame
mesh.computeBoundingSphere();  // engine auto-computes when needed (raycast/frustum culling) but does NOT recompute after you move instances -> call this yourself after transforms, or set mesh.frustumCulled = false
mesh.computeBoundingBox();     // never automatic
mesh.dispose();                // super.dispose() + morphTexture dispose; does NOT dispose geometry/material
```
Raycast results carry `intersect.instanceId`.

LOD (src/objects/LOD.js)
```ts
const lod = new THREE.LOD();
lod.addLevel(object: Object3D, distance = 0, hysteresis = 0): this; // "Adds a mesh that will display at a certain distance and greater." hysteresis = fraction of distance to avoid flicker
lod.autoUpdate = true;        // renderer calls lod.update(camera) per frame; set false and call lod.update(camera) yourself
lod.getCurrentLevel(): number; lod.getObjectForDistance(d): Object3D|null; lod.removeLevel(distance): boolean
lod.levels: Array<{object, distance, hysteresis}>
```
update(camera): distance = cameraWorldPos.distanceTo(lodWorldPos) / camera.zoom; level 0 is always the closest (add levels in increasing distance order).

FRUSTUM CULLING defaults: `Object3D.frustumCulled = true` (default). Renderer projectObject: `if ( ! object.frustumCulled || object.intersectsFrustum( _frustum ) )` — note r186 uses `Mesh.intersectsFrustum(frustum)` (which calls `frustum.intersectsObject(this)`), not a direct Frustum call. Culling uses geometry.boundingSphere (auto-computed if null; recompute after editing vertices via `geometry.computeBoundingSphere()`). `Frustum` and `FrustumArray` exported from 'three'.

TIME: `Clock` is DEPRECATED since r183 (constructor logs 'Clock: This module has been deprecated. Please use THREE.Timer instead.'; still uses performance.now internally). Use core `Timer` (exported from 'three', src/core/Timer.js — NOT the old addons misc/Timer path):
```ts
const timer = new THREE.Timer();
timer.connect(document); // optional: Page Visibility API avoids huge deltas after tab switch
renderer.setAnimationLoop((timestamp) => { timer.update(timestamp); const dt = timer.getDelta(); const t = timer.getElapsed(); ... });
timer.setTimescale(s); timer.reset(); timer.disconnect(); timer.dispose();
```
update(timestamp?) uses performance.now() if no timestamp. Calling getDelta()/getElapsed() repeatedly within one step returns the same value (fixes Clock's flaw). Raw performance.now() in your own loop is fine too; Timer is just a convenience.

PerspectiveCamera: `new THREE.PerspectiveCamera(fov = 50, aspect = 1, near = 0.1, far = 2000)`; "updateProjectionMatrix(): Must be called after any change of camera properties" (fov/aspect/near/far/zoom). Supports `reversedDepth` internally when renderer uses reversedDepthBuffer.

FOG: `scene.fog = new THREE.Fog(color, near = 1, far = 1000)` (linear) or `new THREE.FogExp2(color, density = 0.00025)`. Materials respond via `material.fog` (default true).

DirectionalLight shadows:
```ts
const light = new THREE.DirectionalLight(0xffffff, 3);
light.castShadow = true;
light.shadow.mapSize.set(2048, 2048);          // default Vector2(512,512)
light.shadow.camera = OrthographicCamera(-5, 5, 5, -5, 0.5, 500) by default -> enlarge: light.shadow.camera.left/right/top/bottom/near/far then light.shadow.camera.updateProjectionMatrix()
light.shadow.bias = 0; light.shadow.normalBias = 0; light.shadow.radius = 1; // radius > 1 blurs (PCF/VSM)
light.shadow.autoUpdate = true; light.shadow.needsUpdate = false; light.shadow.intensity = 1; light.shadow.blurSamples = 8 (VSM only)
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoftShadowMap REMOVED
mesh.castShadow = true; ground.receiveShadow = true;
light.shadow.dispose();
```
Static shadows: `renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = true;` once.

MeshStandardMaterial defaults: color (1,1,1), roughness 1.0, metalness 0.0, map/normalMap null, emissive (0,0,0), emissiveIntensity 1, envMapIntensity 1, flatShading false, vertexColors false, side FrontSide, transparent false, opacity 1. "for best results you should always specify an environment map". Texture color maps: `texture.colorSpace = THREE.SRGBColorSpace`. `material.needsUpdate = true` bumps version to recompile after changing defines-affecting props.

BufferGeometry: `geometry.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3))` / `new BufferAttribute(typedArray, itemSize)`; `setIndex(index)`; `getAttribute(name)` (undefined if missing); `computeVertexNormals()`; `computeBoundingBox()` (never automatic); `computeBoundingSphere()` (auto when needed, recompute after vertex edits); `setFromPoints(points)`; attribute edits need `attr.needsUpdate = true`; `attr.setUsage(DynamicDrawUsage)` for per-frame updates.

DISPOSAL pattern (all verified: Material.dispose() dispatches 'dispose'; BufferGeometry.dispose(); Texture.dispose(); LightShadow.dispose(); Object3D.dispose() is NEW in r186 and only dispatches an event — it does NOT dispose geometry/material):
```ts
obj.traverse((o) => {
  if ((o as THREE.Mesh).isMesh) {
    const m = o as THREE.Mesh; m.geometry.dispose();
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) { for (const k in mat) { const v = (mat as any)[k]; if (v && v.isTexture) v.dispose(); } mat.dispose(); }
  }
});
obj.removeFromParent(); obj.dispose?.();
```
Verify with `renderer.info.memory.geometries/textures` decreasing.

ColorManagement (src/math/ColorManagement.js): `ColorManagement.enabled = true` by default; `workingColorSpace = LinearSRGBColorSpace`; `renderer.outputColorSpace = SRGBColorSpace` default. Constants: NoColorSpace '' , SRGBColorSpace 'srgb', LinearSRGBColorSpace 'srgb-linear'. Hex colors passed to `new Color(0x...)` / material.color are treated as sRGB and converted to linear working space automatically — do nothing. Only set `texture.colorSpace = SRGBColorSpace` on color (albedo/emissive) textures; leave data textures (normal/roughness) linear. Tone mapping constants: NoToneMapping 0, ACESFilmicToneMapping 4, AgXToneMapping 6, NeutralToneMapping 7. Usage: StaticDrawUsage 35044, DynamicDrawUsage 35048. Shadow types: BasicShadowMap 0, PCFShadowMap 1, PCFSoftShadowMap 2 (@deprecated since r186), VSMShadowMap 3.

OrbitControls (examples/jsm/controls/OrbitControls.js, @three_import 'three/addons/controls/OrbitControls.js'): `new OrbitControls(object: Camera, domElement: HTMLElement | null = null)`; `update(deltaTime = null): boolean` (pass dt seconds when autoRotate); defaults enableDamping=false, dampingFactor=0.05, enableZoom=true, enablePan=true, autoRotate=false, minDistance=0, maxDistance=Infinity, target=Vector3(); `connect(element)`, `dispose()`. Call `controls.update()` every frame if enableDamping/autoRotate. Extends `Controls`.

WebGPURenderer status (r186 manual + source): "the new alternative of WebGLRenderer"; import `import * as THREE from 'three/webgpu'` (different build), falls back to WebGL2 backend automatically; async init: prefer `setAnimationLoop()` or `await renderer.init()`; options alpha=true (differs from WebGLRenderer's false), outputBufferType=HalfFloatType default, forceWebGL. Both renderers are supported in r186; WebGLRenderer is still fully maintained (r186 release notes list WebGLRenderer fixes and new SunLight/cascaded shadow maps). For a Vite+TS game with InstancedMesh/LOD/Fog, WebGLRenderer from 'three' is the stable, simpler choice; do not mix 'three' and 'three/webgpu' imports in one bundle (duplicate module instances).

## Gotchas

- three ships NO type definitions (0 .d.ts in the 0.186.1 tarball). Install @types/three@0.186.0 as a devDependency; it requires TypeScript >= 5.6. Keep major-minor in lockstep (0.186.x <-> 0.186.x).
- PCFSoftShadowMap is REMOVED in r186 (constants.js: '@deprecated since r186. Use PCFShadowMap instead.'; WebGLShadowMap logs 'PCFSoftShadowMap has been removed. Using PCFShadowMap instead.'). Memory says PCFSoftShadowMap is the 'nice' option; docs say use PCFShadowMap (it became soft in r182).
- THREE.Clock is deprecated since r183 and logs a console warning on construction. Use THREE.Timer (now in core, exported from 'three'; the old 'three/addons/misc/Timer.js' path is not what you want) and call timer.update(timestamp) once per frame before getDelta()/getElapsed().
- InstancedMesh: after setMatrixAt/setColorAt you MUST set instanceMatrix.needsUpdate = true / instanceColor.needsUpdate = true. count passed to the constructor is the maximum; mesh.count can only shrink/grow within [0, count]. instanceColor is null until the first setColorAt.
- InstancedMesh frustum culling uses a bounding sphere that is NOT recomputed when instances move; either call mesh.computeBoundingSphere() after transforms or set mesh.frustumCulled = false, otherwise instances pop out of view.
- renderer.info counters are reset automatically at the start of each render() (autoReset=true). Read info.render.calls/triangles after render(); for multi-pass rendering set info.autoReset=false and reset() manually.
- Object3D.dispose() is NEW in r186 and only dispatches a 'dispose' event; it does not free geometry/material/textures. Custom Object3D subclasses overriding dispose() must call super.dispose(). You still dispose geometry/material/texture explicitly.
- Docs site changed in r181: API docs are now JSDoc-generated (hash-routed SPA at threejs.org/docs) and English-only; the manual is language-neutral (threejs.org/manual/#installation; files live at manual/pages/<slug>.html, not manual/en/). Old URLs like docs/#manual/en/introduction/Installation no longer exist.
- WebGLRenderer is WebGL2-only (WebGL1 rejected since r163). setPixelRatio(value) resizes the drawing buffer; call it BEFORE setSize, and clamp devicePixelRatio (e.g. Math.min(dpr, 2)) for performance.
- Fog defaults are tiny (FogExp2 density 0.00025) — set explicitly for a game scale. DirectionalLightShadow default ortho frustum is only -5..5 with far 500; enlarge and call light.shadow.camera.updateProjectionMatrix().
- Stats: import default from 'three/addons/libs/stats.module.js' (ESM default export); @types/three types it via @types/stats.js (pulled in automatically). Not 'three/examples/jsm/libs/stats.module.js' in new code, though that alias still exists in exports.
- r186 release notes: CommonJS build deprecated and minified builds removed — use the ESM build (Vite does this by default; do not require('three')).
- Source was renamed TextureSource in r186; LightProbeGrid renamed LightProbeGridWebGL; RGBELoader was renamed HDRLoader in r180 (RGBMLoader removed) — relevant if loading HDR environment maps.
- r184: FileLoader.load()/ImageBitmapLoader.load() no longer return a value — use the onLoad callback. r185: Object3D.updateWorldMatrix() now honors matrixWorldNeedsUpdate; Matrix3.translate/scale/rotate deprecated.
- WebGPURenderer defaults differ from WebGLRenderer: alpha=true, outputBufferType=HalfFloatType, async init (await renderer.init() if not using setAnimationLoop). Importing both 'three' and 'three/webgpu' in one app duplicates the library.

## Compatibility warnings

- Pin exactly: "three": "0.186.1" and "@types/three": "0.186.0" (devDependency). @types/three@0.186.0 declares typeScriptVersion 5.6, so use TypeScript >= 5.6 (dist-tags cover ts5.6 through ts7.1).
- Neither three nor @types/three declares peerDependencies. @types/three pulls in runtime-typed deps (fflate ~0.8.3, meshoptimizer ~1.1.1, @types/webxr >=0.5.17, @types/stats.js, @tweenjs/tween.js ~23.1.3, @dimforge/rapier3d-compat ~0.12.0) automatically; nothing extra to install.
- Node v22.22.0 / npm 10.9.4 is fine: three has no engines field; the manual's Vite workflow (npm install --save three; npm install --save-dev vite; npx vite) is the officially recommended setup.
- tsconfig: use "moduleResolution": "bundler" (or node16/nodenext) so the 'three/addons/*' export subpath resolves for both runtime (package.json exports) and types (@types/three mirrors the same exports map). Classic 'node' resolution will not resolve three/addons/*.
- Do not use the CommonJS build (require('three')) — deprecated in r186; minified builds were removed.
- If any code or snippet uses THREE.PCFSoftShadowMap, THREE.Clock, RGBELoader, RGBMLoader, Source, or expects FileLoader.load() to return a value, it is pre-r186 and must be updated (see gotchas).
