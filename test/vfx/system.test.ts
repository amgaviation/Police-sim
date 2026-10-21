import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { VFX_DATA } from '../../src/render/vfx/data';
import { VfxSystem } from '../../src/render/vfx/system';
import { VFX_PARTICLE_KINDS } from '../../src/render/vfx/types';

declare const process: { memoryUsage(): { heapUsed: number } };
interface NodeModules {
  v8: { setFlagsFromString(flags: string): void };
  vm: { runInNewContext(code: string): unknown };
}
async function loadGc(): Promise<() => void> {
  const names: Record<keyof NodeModules, string> = { v8: 'node:v8', vm: 'node:vm' };
  const v8 = (await import(/* @vite-ignore */ names.v8)) as NodeModules['v8'];
  const vm = (await import(/* @vite-ignore */ names.vm)) as NodeModules['vm'];
  v8.setFlagsFromString('--expose-gc');
  return vm.runInNewContext('gc') as () => void;
}

function setup(): { scene: THREE.Scene; vfx: VfxSystem; camera: THREE.PerspectiveCamera } {
  const scene = new THREE.Scene();
  const vfx = new VfxSystem(scene);
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 800);
  camera.updateMatrixWorld(true);
  return { scene, vfx, camera };
}

/** Feeds the sink like CarRenderer does: `bars` red bar glows, a pool, two head glows and a beam per car. */
function feed(vfx: VfxSystem, cars: number, bars: number): void {
  const s = vfx.glowSink;
  s.begin();
  for (let c = 0; c < cars; c++) {
    const x = c * 6;
    for (let i = 0; i < bars; i++) s.glow(x + i * 0.1, 1.5, 0, 1, 0.05, 0.05, 0);
    if (bars > 0) s.pool(x, 0, 1, 0.05, 0.05);
    s.glow(x - 0.6, 0.6, -2, 1, 1, 0.9, 1);
    s.glow(x + 0.6, 0.6, -2, 1, 1, 0.9, 1);
    s.glow(x - 0.6, 0.7, 2, 1, 0.04, 0.03, 2);
    s.beam(x, 0.6, -2, 0, 0, -1);
  }
  s.end();
}

const child = (scene: THREE.Scene, name: string): THREE.Object3D => {
  const found = scene.getObjectByName(name);
  if (!found) throw new Error(`missing ${name}`);
  return found;
};

describe('VfxSystem', () => {
  it('adds a fixed set of objects and works without a scene', () => {
    const { scene, vfx } = setup();
    expect(scene.getObjectByName('vfx')).toBeTruthy();
    for (const n of ['vfx-glow', 'vfx-pools', 'vfx-cones', 'vfx-particles-add', 'vfx-particles', 'vfx-arc', 'vfx-muzzle-light']) {
      expect(scene.getObjectByName(n), n).toBeTruthy();
    }
    expect(child(scene, 'vfx-muzzle-light')).toBeInstanceOf(THREE.PointLight);
    vfx.dispose();
    expect(scene.getObjectByName('vfx')).toBeUndefined();

    const headless = new VfxSystem(null);
    const cam = new THREE.PerspectiveCamera();
    feed(headless, 2, 4);
    headless.burst('spark', 0, 1, 0, 0, 0, 0, 1);
    headless.muzzle(0, 1, 0, 1, 0);
    headless.arc({ x: 0, y: 1, z: 0 }, { x: 3, y: 1, z: 0 });
    headless.update(cam, 1 / 60, 1, 0, 0);
    expect(headless.stats.glows).toBeGreaterThan(0);
    headless.dispose();
  });

  it('counts glows, pools and cones from a fed sink at night', () => {
    const { vfx, camera, scene } = setup();
    camera.position.set(0, 2, 10);
    camera.updateMatrixWorld(true);
    feed(vfx, 3, 4);
    vfx.update(camera, 1 / 60, 1, 0, 0);
    expect(vfx.stats.glows).toBe(3 * (4 + 2 + 1));
    expect(vfx.stats.pools).toBe(3);
    expect(vfx.stats.cones).toBe(3);
    expect(vfx.stats.drawCalls).toBe(3);
    const glow = child(scene, 'vfx-glow') as THREE.InstancedMesh;
    expect(glow.count).toBe(21);
    expect(glow.visible).toBe(true);
    expect((child(scene, 'vfx-pools') as THREE.InstancedMesh).count).toBe(3);
    expect((child(scene, 'vfx-cones') as THREE.InstancedMesh).count).toBe(3);
  });

  it('writes glow colours times intensity and sizes by kind', () => {
    const { vfx, camera, scene } = setup();
    const g = VFX_DATA.glow;
    feed(vfx, 1, 1);
    // Day: only the bar glow is drawn, at dayFactor.
    vfx.update(camera, 1 / 60, 0, 0, 0);
    const mesh = child(scene, 'vfx-glow') as THREE.InstancedMesh;
    expect(mesh.count).toBe(1);
    const c = mesh.getColorAt(0, new THREE.Color());
    expect(c.r).toBeCloseTo(g.dayFactor, 6);
    expect(c.g).toBeCloseTo(0.05 * g.dayFactor, 6);
    const m = mesh.getMatrixAt(0, new THREE.Matrix4());
    expect(new THREE.Vector3().setFromMatrixPosition(m).toArray()).toEqual([0, 1.5, 0]);
    expect(new THREE.Vector3().setFromMatrixScale(m).x).toBeCloseTo(g.barSize, 6);

    // Night: bar at 1, head and tail by night with their own sizes.
    feed(vfx, 1, 1);
    vfx.update(camera, 1 / 60, 0.8, 0, 0);
    expect(mesh.count).toBe(4);
    const sizes = [0, 1, 2, 3].map((i) => new THREE.Vector3().setFromMatrixScale(mesh.getMatrixAt(i, new THREE.Matrix4())).x);
    expect(sizes[0]).toBeCloseTo(g.barSize, 6);
    expect(sizes[1]).toBeCloseTo(g.headSize, 6);
    expect(sizes[3]).toBeCloseTo(g.tailSize, 6);
    expect(mesh.getColorAt(0, new THREE.Color()).r).toBeCloseTo(0.8 + g.dayFactor * 0.2, 6);
    expect(mesh.getColorAt(1, new THREE.Color()).r).toBeCloseTo(0.8, 6);
  });

  it('shows pools only at night and cones above 0.2', () => {
    const { vfx, camera } = setup();
    feed(vfx, 2, 4);
    vfx.update(camera, 1 / 60, 0.04, 0, 0);
    expect(vfx.stats.pools).toBe(0);
    expect(vfx.stats.cones).toBe(0);
    vfx.update(camera, 1 / 60, 0.1, 0, 0);
    expect(vfx.stats.pools).toBe(2);
    expect(vfx.stats.cones).toBe(0);
    vfx.update(camera, 1 / 60, 0.5, 0, 0);
    expect(vfx.stats.cones).toBe(2);
  });

  it('picks the 32 nearest beams within range of the camera', () => {
    const { vfx, camera, scene } = setup();
    const s = vfx.glowSink;
    s.begin();
    for (let i = 0; i < 100; i++) s.beam(i * 3, 0.6, 0, 0, 0, -1);
    s.beam(1000, 0.6, 0, 0, 0, -1);
    s.end();
    vfx.update(camera, 1 / 60, 1, 0, 0);
    expect(vfx.stats.cones).toBe(VFX_DATA.cones.capacity);
    const mesh = child(scene, 'vfx-cones') as THREE.InstancedMesh;
    // The camera is at the origin: the nearest beam is x = 0 and the far one is never drawn.
    expect(new THREE.Vector3().setFromMatrixPosition(mesh.getMatrixAt(0, new THREE.Matrix4())).x).toBe(0);
    for (let i = 0; i < mesh.count; i++) {
      expect(new THREE.Vector3().setFromMatrixPosition(mesh.getMatrixAt(i, new THREE.Matrix4())).x).toBeLessThan(140);
    }
    // Beams beyond maxDistanceM are dropped entirely.
    s.begin();
    s.beam(500, 0, 0, 0, 0, -1);
    s.end();
    vfx.update(camera, 1 / 60, 1, 0, 0);
    expect(vfx.stats.cones).toBe(0);
  });

  it('boosts the cone alpha in fog and rain', () => {
    const { vfx, camera, scene } = setup();
    const mat = (child(scene, 'vfx-cones') as THREE.InstancedMesh).material as THREE.ShaderMaterial;
    feed(vfx, 1, 0);
    vfx.update(camera, 1 / 60, 1, 0, 0);
    const base = mat.uniforms['uAlpha']?.value as number;
    expect(base).toBeCloseTo(VFX_DATA.cones.intensity, 9);
    vfx.update(camera, 1 / 60, 1, 0.02, 0);
    expect(mat.uniforms['uAlpha']?.value).toBeCloseTo(base * VFX_DATA.cones.fogBoost, 9);
    vfx.update(camera, 1 / 60, 1, 0, 0.5);
    expect(mat.uniforms['uAlpha']?.value).toBeCloseTo(base * VFX_DATA.cones.rainBoost, 9);
  });

  it('draws nothing at quality off and ignores emissions', () => {
    const { vfx, camera, scene } = setup();
    feed(vfx, 3, 4);
    vfx.update(camera, 1 / 60, 1, 0, 0);
    expect(vfx.stats.drawCalls).toBeGreaterThan(0);
    vfx.setQuality('off');
    expect(vfx.stats).toEqual({ glows: 0, pools: 0, cones: 0, particles: 0, drawCalls: 0 });
    vfx.burst('spark', 0, 1, -5, 0, 0, 0, 1);
    vfx.muzzle(0, 1, -5, 0, -1);
    vfx.arc({ x: 0, y: 1, z: 0 }, { x: 3, y: 1, z: 0 });
    feed(vfx, 3, 4);
    vfx.update(camera, 1 / 60, 1, 0, 0);
    expect(vfx.stats).toEqual({ glows: 0, pools: 0, cones: 0, particles: 0, drawCalls: 0 });
    for (const n of ['vfx-glow', 'vfx-pools', 'vfx-cones', 'vfx-particles-add', 'vfx-particles', 'vfx-arc']) {
      expect(child(scene, n).visible, n).toBe(false);
    }
    expect((child(scene, 'vfx-muzzle-light') as THREE.PointLight).intensity).toBe(0);
    // Back on: nothing was queued while off.
    vfx.setQuality('high');
    vfx.update(camera, 1 / 60, 1, 0, 0);
    expect(vfx.stats.particles).toBe(0);
  });

  it('drops cones and pools at quality low, shrinks the glow and halves the particles', () => {
    const high = setup();
    const low = setup();
    low.vfx.setQuality('low');
    for (const t of [high, low]) {
      feed(t.vfx, 3, 4);
      t.vfx.burst('spark', 0, 1, -5, 0, 0, 0, 1);
      t.vfx.update(t.camera, 1 / 60, 1, 0, 0);
    }
    expect(low.vfx.stats.cones).toBe(0);
    expect(low.vfx.stats.pools).toBe(0);
    expect(low.vfx.stats.glows).toBe(high.vfx.stats.glows);
    expect(high.vfx.stats.cones).toBe(3);
    const sizeOf = (t: ReturnType<typeof setup>): number =>
      new THREE.Vector3().setFromMatrixScale(
        (child(t.scene, 'vfx-glow') as THREE.InstancedMesh).getMatrixAt(0, new THREE.Matrix4()),
      ).x;
    expect(sizeOf(low)).toBeCloseTo(sizeOf(high) * VFX_DATA.glow.lowSizeFactor, 6);
    expect(low.vfx.stats.particles).toBeGreaterThan(0);
    expect(low.vfx.stats.particles).toBeLessThan(high.vfx.stats.particles);
    expect(low.vfx.stats.particles).toBe(Math.round(high.vfx.stats.particles / 2));
  });

  it('keeps the mesh of overflowing glows to its capacity', () => {
    const { vfx, camera } = setup();
    const s = vfx.glowSink;
    s.begin();
    for (let i = 0; i < VFX_DATA.glow.capacity + 100; i++) s.glow(i, 1, 0, 1, 1, 1, 0);
    for (let i = 0; i < VFX_DATA.glow.pool.capacity + 5; i++) s.pool(i, 0, 1, 1, 1);
    s.end();
    vfx.update(camera, 1 / 60, 1, 0, 0);
    expect(vfx.stats.glows).toBe(VFX_DATA.glow.capacity);
    expect(vfx.stats.pools).toBe(VFX_DATA.glow.pool.capacity);
  });

  it('emits bursts of every kind into the two rings and they expire', () => {
    const { vfx, camera, scene } = setup();
    for (const kind of VFX_PARTICLE_KINDS) vfx.burst(kind, 1, 1, -4, 0, 0, 0, 1);
    vfx.update(camera, 1 / 60, 0, 0, 0);
    expect(vfx.stats.particles).toBeGreaterThan(20);
    expect(child(scene, 'vfx-particles-add').visible).toBe(true);
    expect(child(scene, 'vfx-particles').visible).toBe(true);
    expect(vfx.stats.drawCalls).toBe(2);
    // Longest life in vfx.json is 1.6 s (dust).
    for (let i = 0; i < 40; i++) vfx.update(camera, 0.1, 0, 0, 0);
    expect(vfx.stats.particles).toBe(0);
    expect(vfx.stats.drawCalls).toBe(0);
    expect(child(scene, 'vfx-particles').visible).toBe(false);
  });

  it('scales the particle count with intensity and ignores zero', () => {
    const a = setup();
    const b = setup();
    const c = setup();
    a.vfx.burst('dust', 0, 0, -3, 0, 0, 0, 1);
    b.vfx.burst('dust', 0, 0, -3, 0, 0, 0, 0.25);
    c.vfx.burst('dust', 0, 0, -3, 0, 0, 0, 0);
    for (const t of [a, b, c]) t.vfx.update(t.camera, 1 / 60, 0, 0, 0);
    expect(a.vfx.stats.particles).toBeGreaterThanOrEqual(6);
    expect(b.vfx.stats.particles).toBeLessThan(a.vfx.stats.particles);
    expect(b.vfx.stats.particles).toBeGreaterThanOrEqual(1);
    expect(c.vfx.stats.particles).toBe(0);
  });

  it('is deterministic: the same bursts write the same particle buffers', () => {
    const write = (): number[] => {
      const { vfx, camera, scene } = setup();
      vfx.burst('spark', 1, 2, 3, 0, 0, 0, 1);
      vfx.burst('muzzle', 0, 1, 0, 1, 0, 0, 1);
      vfx.update(camera, 1 / 60, 0, 0, 0);
      const pts = child(scene, 'vfx-particles-add') as THREE.Points;
      return Array.from(pts.geometry.getAttribute('aVel').array as Float32Array).slice(0, 90);
    };
    expect(write()).toEqual(write());
  });

  it('points a directed burst along its direction and uploads one range', () => {
    const { vfx, camera, scene } = setup();
    vfx.burst('muzzle', 0, 1, 0, 0, 0, -1, 1);
    vfx.update(camera, 1 / 60, 0, 0, 0);
    const pts = child(scene, 'vfx-particles-add') as THREE.Points;
    const vel = pts.geometry.getAttribute('aVel');
    let meanZ = 0;
    const n = pts.geometry.drawRange.count;
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) meanZ += vel.getZ(i);
    expect(meanZ / n).toBeLessThan(-0.5);
    const start = pts.geometry.getAttribute('aStart') as THREE.BufferAttribute;
    expect([start.getX(0), start.getY(0), start.getZ(0)]).toEqual([0, 1, 0]);
    expect(start.updateRanges).toEqual([{ start: 0, count: n * 3 }]);
  });

  it('wraps the ring when bursts exceed the capacity without throwing', () => {
    const { vfx, camera, scene } = setup();
    const half = VFX_DATA.particles.capacity / 2;
    for (let i = 0; i < 400; i++) vfx.burst('spark', i, 1, -3, 0, 0, 0, 1);
    expect(() => vfx.update(camera, 1 / 60, 0, 0, 0)).not.toThrow();
    const pts = child(scene, 'vfx-particles-add') as THREE.Points;
    expect(pts.geometry.drawRange.count).toBe(half);
    // One enormous flush covers the whole ring; a later small burst after a wrap is two ranges.
    const start = pts.geometry.getAttribute('aStart') as THREE.BufferAttribute;
    expect(start.updateRanges).toEqual([{ start: 0, count: half * 3 }]);
    start.clearUpdateRanges();
    // 1024 slots written, then enough bursts to cross the end again.
    for (let i = 0; i < 30; i++) vfx.burst('spark', i, 1, -3, 0, 0, 0, 1);
    vfx.update(camera, 1 / 60, 0, 0, 0);
    const total = start.updateRanges.reduce((n, r) => n + r.count, 0);
    expect(total).toBeGreaterThan(0);
    for (const r of start.updateRanges) expect(r.start + r.count).toBeLessThanOrEqual(half * 3);
  });

  it('handles a single burst larger than the ring', () => {
    const { vfx, camera } = setup();
    const tiny = { ...VFX_DATA, particles: { ...VFX_DATA.particles, capacity: 4 } };
    const small = new VfxSystem(null, tiny);
    small.burst('spark', 0, 1, 0, 0, 0, 0, 1);
    expect(() => small.update(camera, 1 / 60, 0, 0, 0)).not.toThrow();
    expect(small.stats.particles).toBeLessThanOrEqual(4);
    vfx.dispose();
  });

  it('muzzle: a burst plus the pooled light for durationS', () => {
    const { vfx, camera, scene } = setup();
    const light = child(scene, 'vfx-muzzle-light') as THREE.PointLight;
    expect(light.intensity).toBe(0);
    vfx.muzzle(2, 1.4, -3, 0, -1);
    expect(light.intensity).toBe(VFX_DATA.muzzleLight.intensity);
    expect(light.position.toArray()).toEqual([2, 1.4, -3]);
    vfx.update(camera, 0.02, 0, 0, 0);
    expect(light.intensity).toBe(VFX_DATA.muzzleLight.intensity);
    vfx.update(camera, 0.04, 0, 0, 0);
    expect(light.intensity).toBe(0);
    expect(vfx.stats.particles).toBeGreaterThan(0);
  });

  it('muzzle with reduced flash: no light and a dimmed burst', () => {
    const { vfx, camera, scene } = setup();
    vfx.setReducedFlash(true);
    vfx.muzzle(0, 1.4, 0, 1, 0);
    vfx.update(camera, 0.01, 0, 0, 0);
    expect((child(scene, 'vfx-muzzle-light') as THREE.PointLight).intensity).toBe(0);
    const pts = child(scene, 'vfx-particles-add') as THREE.Points;
    const color = pts.geometry.getAttribute('aColor');
    const base = VFX_DATA.particles.kinds.muzzle.color;
    expect(color.getX(0)).toBeCloseTo(base[0] * 0.4, 6);
    expect(color.getY(0)).toBeCloseTo(base[1] * 0.4, 6);
    // Turning it on while the light is lit switches the light off.
    vfx.setReducedFlash(false);
    vfx.muzzle(0, 1.4, 0, 1, 0);
    vfx.setReducedFlash(true);
    expect((child(scene, 'vfx-muzzle-light') as THREE.PointLight).intensity).toBe(0);
  });

  it('draws the TASER arc for the frame it is set, jittered and then static under reduced flash', () => {
    const { vfx, camera, scene } = setup();
    const line = child(scene, 'vfx-arc') as THREE.Line;
    const pos = (): number[] => Array.from(line.geometry.getAttribute('position').array as Float32Array);
    const from = { x: 0, y: 1, z: 0 };
    const to = { x: 4, y: 1, z: 0 };
    vfx.arc(from, to);
    vfx.update(camera, 1 / 60, 0, 0, 0);
    expect(line.visible).toBe(true);
    expect(vfx.stats.drawCalls).toBe(1);
    const a = pos();
    expect(a).toHaveLength((VFX_DATA.arc.segments + 1) * 3);
    expect(a.slice(0, 3)).toEqual([0, 1, 0]);
    expect(a.slice(-3)).toEqual([4, 1, 0]);
    // Interior points are jittered within jitterM of the straight line.
    for (let i = 1; i < VFX_DATA.arc.segments; i++) {
      expect(Math.abs((a[i * 3 + 1] ?? 0) - 1)).toBeLessThanOrEqual(VFX_DATA.arc.jitterM + 1e-6);
    }
    expect(a.some((v, i) => i % 3 === 1 && Math.abs(v - 1) > 1e-6)).toBe(true);
    // Not called again: hidden next frame.
    vfx.update(camera, 1 / 60, 0, 0, 0);
    expect(line.visible).toBe(false);
    // Jitter is redrawn after 1 / rateHz.
    vfx.arc(from, to);
    vfx.update(camera, 0.5, 0, 0, 0);
    expect(pos()).not.toEqual(a);
    // null hides at once.
    vfx.arc(from, to);
    vfx.arc(null);
    vfx.update(camera, 1 / 60, 0, 0, 0);
    expect(line.visible).toBe(false);

    vfx.setReducedFlash(true);
    vfx.arc(from, to);
    vfx.update(camera, 1 / 60, 0, 0, 0);
    const still = pos();
    for (let i = 0; i <= VFX_DATA.arc.segments; i++) expect(still[i * 3 + 1]).toBe(1);
    vfx.arc(from, to);
    vfx.update(camera, 0.5, 0, 0, 0);
    expect(pos()).toEqual(still);
    expect((line.material as THREE.LineBasicMaterial).opacity).toBeLessThan(0.9);
  });

  it('never needs more than 6 draw calls', () => {
    const { vfx, camera } = setup();
    feed(vfx, 8, 8);
    for (const kind of VFX_PARTICLE_KINDS) vfx.burst(kind, 0, 1, -5, 0, 0, 0, 1);
    vfx.arc({ x: 0, y: 1, z: 0 }, { x: 3, y: 1, z: 0 });
    vfx.update(camera, 1 / 60, 1, 0.05, 0.5);
    expect(vfx.stats.drawCalls).toBe(6);
    expect(vfx.stats.drawCalls).toBeLessThanOrEqual(6);
  });

  it('uses the render clock wrap: a wrap hides old particles instead of breaking', () => {
    const { vfx, camera } = setup();
    vfx.update(camera, 599.99, 0, 0, 0);
    vfx.burst('dust', 0, 0, -3, 0, 0, 0, 1);
    vfx.update(camera, 0.005, 0, 0, 0);
    expect(vfx.stats.particles).toBeGreaterThan(0);
    vfx.update(camera, 0.02, 0, 0, 0);
    expect(vfx.stats.particles).toBe(0);
    vfx.burst('dust', 0, 0, -3, 0, 0, 0, 1);
    vfx.update(camera, 0.1, 0, 0, 0);
    expect(vfx.stats.particles).toBeGreaterThan(0);
  });

  it('does not grow the heap over 1000 updates', async () => {
    const gc = await loadGc();
    const { vfx, camera } = setup();
    camera.updateMatrixWorld(true);
    const frame = (i: number): void => {
      feed(vfx, 6, 8);
      if (i % 20 === 0) vfx.burst('spark', i, 1, -5, 0, 0, 0, 1);
      if (i % 50 === 0) vfx.muzzle(0, 1.4, 0, 0, -1);
      vfx.arc({ x: 0, y: 1, z: 0 }, { x: 3, y: 1, z: 0 });
      vfx.update(camera, 1 / 60, 0.9, 0.02, 0.5);
    };
    for (let i = 0; i < 300; i++) frame(i);
    gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 1000; i++) frame(i);
    gc();
    const growth = process.memoryUsage().heapUsed - before;
    expect(growth).toBeLessThan(200_000);
  });
});

describe('cone and glow geometry', () => {
  it('builds the cone with its apex at the origin widening along -Z', () => {
    const { scene } = setup();
    const g = (child(scene, 'vfx-cones') as THREE.InstancedMesh).geometry;
    g.computeBoundingBox();
    const c = VFX_DATA.cones;
    expect(g.boundingBox?.max.z).toBeCloseTo(0, 6);
    expect(g.boundingBox?.min.z).toBeCloseTo(-c.lengthM, 6);
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const r = Math.hypot(p.getX(i), p.getY(i));
      expect(r).toBeCloseTo(Math.abs(p.getZ(i)) < 1e-6 ? 0.15 : c.radiusM, 5);
    }
  });

  it('uses the additive, non-depth-writing materials of the design', () => {
    const { scene } = setup();
    for (const name of ['vfx-glow', 'vfx-pools', 'vfx-cones']) {
      const m = (child(scene, name) as THREE.InstancedMesh).material as THREE.ShaderMaterial;
      expect(m.blending, name).toBe(THREE.AdditiveBlending);
      expect(m.depthWrite, name).toBe(false);
      expect(m.depthTest, name).toBe(true);
      expect(m.fog, name).toBe(false);
      expect(m.toneMapped, name).toBe(false);
    }
    const cone = (child(scene, 'vfx-cones') as THREE.InstancedMesh).material as THREE.ShaderMaterial;
    expect(cone.side).toBe(THREE.DoubleSide);
    const glow = child(scene, 'vfx-glow') as THREE.InstancedMesh;
    expect((glow.material as THREE.ShaderMaterial).fragmentShader).toContain('pow(1.0 - r, 2.0)');
    expect(glow.instanceMatrix.count).toBe(VFX_DATA.glow.capacity);
  });

  it('lays pools flat at y = 0.03 with the pool radius', () => {
    const { vfx, camera, scene } = setup();
    vfx.glowSink.begin();
    vfx.glowSink.pool(5, -7, 1, 0.5, 0.25);
    vfx.glowSink.end();
    vfx.update(camera, 1 / 60, 1, 0, 0);
    const mesh = child(scene, 'vfx-pools') as THREE.InstancedMesh;
    const m = mesh.getMatrixAt(0, new THREE.Matrix4());
    const at = new THREE.Vector3().setFromMatrixPosition(m);
    expect([at.x, at.z]).toEqual([5, -7]);
    expect(at.y).toBeCloseTo(0.03, 6);
    expect(new THREE.Vector3().setFromMatrixScale(m).x).toBeCloseTo(VFX_DATA.glow.pool.radiusM, 6);
    const c = mesh.getColorAt(0, new THREE.Color());
    expect(c.r).toBeCloseTo(VFX_DATA.glow.pool.intensity, 6);
    expect(c.g).toBeCloseTo(VFX_DATA.glow.pool.intensity * 0.5, 6);
    // Flat: every vertex of the disc sits at y = 0.
    const geo = mesh.geometry.getAttribute('position');
    for (let i = 0; i < geo.count; i++) expect(geo.getY(i)).toBeCloseTo(0, 9);
  });
});
