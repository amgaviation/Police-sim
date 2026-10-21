import v8 from 'node:v8';
import vm from 'node:vm';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PrevTransform, Transform } from '../../src/ecs/components';
import { createGameWorld, spawn } from '../../src/ecs/world';
import { MeshRegistry } from '../../src/render/meshSync';

declare const process: { memoryUsage(): { heapUsed: number } };

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;

function setPose(eid: number, prev: [number, number, number], cur: [number, number, number]): void {
  [PrevTransform.x[eid], PrevTransform.y[eid], PrevTransform.z[eid]] = prev;
  [Transform.x[eid], Transform.y[eid], Transform.z[eid]] = cur;
  for (const store of [PrevTransform, Transform]) {
    store.qx[eid] = 0;
    store.qy[eid] = 0;
    store.qz[eid] = 0;
    store.qw[eid] = 1;
  }
}

describe('MeshRegistry.syncFromEcs', () => {
  it('interpolates per-entity objects and box instances between the previous and current transform', () => {
    const world = createGameWorld();
    const reg = new MeshRegistry(new THREE.Scene(), { world, shadows: false, boxPoolSize: 8 });
    const a = spawn(world);
    const b = spawn(world);
    const objectA = new THREE.Object3D();
    reg.add(a, objectA);
    reg.addBox(b, { size: { x: 2, y: 2, z: 2 } });
    setPose(a, [0, 0, 0], [10, 4, -2]);
    setPose(b, [0, 0, 0], [8, 0, 0]);

    reg.syncFromEcs(0.25);
    expect(objectA.position.toArray()).toEqual([2.5, 1, -0.5]);
    const m = new THREE.Matrix4();
    reg.boxes.getMatrixAt(0, m);
    expect(new THREE.Vector3().setFromMatrixPosition(m).x).toBeCloseTo(2, 6);

    reg.syncFromEcs(1);
    expect(objectA.position.toArray()).toEqual([10, 4, -2]);
    reg.syncFromEcs(-3); // clamped
    expect(objectA.position.toArray()).toEqual([0, 0, 0]);
    reg.dispose();
  });

  it('retains no memory over 20 000 syncs of a mixed registry', () => {
    const world = createGameWorld();
    const reg = new MeshRegistry(new THREE.Scene(), { world, shadows: false, boxPoolSize: 64 });
    for (let i = 0; i < 24; i++) {
      const eid = spawn(world);
      setPose(eid, [i, 0, 0], [i + 1, 0, 1]);
      if (i % 2 === 0) reg.add(eid, new THREE.Object3D());
      else reg.addBox(eid);
    }
    for (let i = 0; i < 2000; i++) reg.syncFromEcs((i % 10) / 10);
    gc();
    gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 20_000; i++) reg.syncFromEcs((i % 10) / 10);
    gc();
    gc();
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(256 * 1024);
    reg.dispose();
  });
});
