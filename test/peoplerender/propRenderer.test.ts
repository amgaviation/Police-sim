import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PropRenderer } from '../../src/render/people/propRenderer';
import { createPropSource, PROP, PROP_BY_NAME } from '../../src/render/people/pose';

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

function mesh(scene: THREE.Scene, kind: string): THREE.InstancedMesh {
  const found = scene.getObjectByName(`prop-${kind}`);
  if (!(found instanceof THREE.InstancedMesh)) throw new Error(`missing prop mesh ${kind}`);
  return found as THREE.InstancedMesh;
}

function put(s: ReturnType<typeof createPropSource>, kind: number, x: number, z: number, yaw = 0, y = 0): void {
  const i = s.count++;
  s.kind[i] = kind;
  s.x[i] = x;
  s.y[i] = y;
  s.z[i] = z;
  s.yaw[i] = yaw;
}

const m = new THREE.Matrix4();

describe('PropRenderer', () => {
  it('has one instanced mesh per prop kind, all hidden until used', () => {
    const scene = new THREE.Scene();
    new PropRenderer(scene);
    for (const name of Object.keys(PROP)) {
      const mm = mesh(scene, name);
      expect(mm.count).toBe(0);
      expect(mm.visible).toBe(false);
    }
  });

  it('counts instances per kind and draws only the kinds in use', () => {
    const scene = new THREE.Scene();
    const props = new PropRenderer(scene);
    const s = createPropSource(8);
    put(s, PROP.cone, 1, 2);
    put(s, PROP.cone, 3, 2);
    put(s, PROP.cone, 5, 2);
    put(s, PROP.flare, 0, 0);
    put(s, PROP_BY_NAME['tape'] ?? 0, 10, 10, 1);
    props.update(s, 0);
    expect(mesh(scene, 'cone').count).toBe(3);
    expect(mesh(scene, 'flare').count).toBe(1);
    expect(mesh(scene, 'tape').count).toBe(1);
    expect(mesh(scene, 'marker').count).toBe(0);
    expect(mesh(scene, 'cone').visible).toBe(true);
    expect(mesh(scene, 'marker').visible).toBe(false);
    expect(props.stats.props).toBe(5);
    expect(props.stats.drawCalls).toBe(3);
    s.count = 1;
    props.update(s, 0);
    expect(mesh(scene, 'cone').count).toBe(1);
    expect(mesh(scene, 'flare').count).toBe(0);
    expect(props.stats.drawCalls).toBe(1);
    props.update(null, 0);
    expect(props.stats.props).toBe(0);
    expect(props.stats.drawCalls).toBe(0);
    expect(mesh(scene, 'cone').count).toBe(0);
  });

  it('never needs more than 12 draw calls', () => {
    const scene = new THREE.Scene();
    const props = new PropRenderer(scene);
    const s = createPropSource(16);
    for (const kind of Object.values(PROP)) put(s, kind, kind, 0);
    props.update(s, 1);
    expect(props.stats.drawCalls).toBe(12);
  });

  it('places props at their position, rotated by yaw', () => {
    const scene = new THREE.Scene();
    const props = new PropRenderer(scene);
    const s = createPropSource(4);
    put(s, PROP.tape, 4, 6, Math.PI / 2, 0.2);
    props.update(s, 0);
    mesh(scene, 'tape').getMatrixAt(0, m);
    const p = new THREE.Vector3().setFromMatrixPosition(m);
    expect([p.x, p.y, p.z]).toEqual([4, expect.closeTo(0.2, 5), 6]);
    // The bar runs along local -Z; yaw +90 deg turns it toward -X.
    const dir = new THREE.Vector3(0, 0, -1).transformDirection(m);
    expect(dir.x).toBeCloseTo(-1);
    expect(dir.z).toBeCloseTo(0);
  });

  it('skips unknown kinds and stops at the capacity', () => {
    const scene = new THREE.Scene();
    const props = new PropRenderer(scene, 3);
    const s = createPropSource(8);
    for (let i = 0; i < 6; i++) put(s, PROP.cone, i, 0);
    put(s, 0, 0, 0);
    put(s, 99, 0, 0);
    props.update(s, 0);
    expect(mesh(scene, 'cone').count).toBe(3);
    expect(props.stats.props).toBe(3);
  });

  it('brightens the flare glow with the night factor and clamps it', () => {
    const scene = new THREE.Scene();
    const props = new PropRenderer(scene);
    const s = createPropSource(2);
    put(s, PROP.flare, 0, 0);
    const glow = (night: number): number => {
      props.update(s, night);
      return (mesh(scene, 'flare').material as THREE.MeshLambertMaterial).emissiveIntensity;
    };
    const day = glow(0);
    const dusk = glow(0.5);
    const night = glow(1);
    expect(day).toBeGreaterThan(0);
    expect(dusk).toBeGreaterThan(day);
    expect(night).toBeGreaterThan(dusk);
    expect(glow(5)).toBe(night);
    expect(glow(-3)).toBe(day);
    // Other props do not glow.
    expect((mesh(scene, 'cone').material as THREE.MeshLambertMaterial).emissiveIntensity).toBe(1);
    expect((mesh(scene, 'cone').material as THREE.MeshLambertMaterial).emissive.getHex()).toBe(0);
  });

  it('removes its meshes on dispose', () => {
    const scene = new THREE.Scene();
    const props = new PropRenderer(scene);
    expect(scene.getObjectByName('props')).toBeDefined();
    props.dispose();
    expect(scene.getObjectByName('props')).toBeUndefined();
  });

  it('does not allocate per prop in update and stays inside its frame budget', async () => {
    const gc = await loadGc();
    const garbage = (n: number): number => {
      const props = new PropRenderer(new THREE.Scene());
      const s = createPropSource(256);
      for (let i = 0; i < n; i++) put(s, 1 + (i % 12), i, -i, i * 0.1);
      for (let i = 0; i < 300; i++) props.update(s, 0.4);
      let worst = 0;
      for (let k = 0; k < 8; k++) {
        gc();
        const before = process.memoryUsage().heapUsed;
        for (let i = 0; i < 100; i++) props.update(s, 0.4);
        worst = Math.max(worst, process.memoryUsage().heapUsed - before);
      }
      return worst;
    };
    const few = garbage(12);
    const many = garbage(250);
    expect(many / Math.max(few, 1)).toBeLessThan(1.3);

    const props = new PropRenderer(new THREE.Scene());
    const s = createPropSource(256);
    for (let i = 0; i < 256; i++) put(s, 1 + (i % 12), i, -i, i * 0.1);
    for (let i = 0; i < 100; i++) props.update(s, 0.4);
    const start = performance.now();
    for (let i = 0; i < 300; i++) props.update(s, 0.4);
    expect((performance.now() - start) / 300).toBeLessThan(0.5);
  });
});
