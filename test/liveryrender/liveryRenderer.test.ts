import type { EntityId } from 'bitecs';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { PrevTransform, Transform } from '../../src/ecs/components';
import { createGameWorld, spawn, type GameWorld } from '../../src/ecs/world';
import { defaultLivery } from '../../src/livery/defaults';
import type { Canvas2DLike } from '../../src/livery/painter';
import type { LiveryDoc } from '../../src/livery/types';
import { LiveryRenderer, type LiveryCanvas } from '../../src/render/livery/liveryRenderer';
import { vehicleRenderBasis } from '../../src/render/vehicles/carRenderer';
import { attachVehicleLook, VehicleLook } from '../../src/vehicles/components';
import { vehicleModel } from '../../src/vehicles/model';

const SEDAN = vehicleModel('patrol_sedan');
const MOTO = vehicleModel('police_motorcycle');
const DOC = defaultLivery('patrolMarked');

/** A recording 2D context: counts atlas clears (one per paint) and keeps the fill / text calls. */
class FakeContext implements Canvas2DLike {
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  font = '';
  textAlign = '';
  textBaseline = '';
  globalAlpha = 1;
  clears = 0;
  texts: string[] = [];
  fills: string[] = [];
  save(): void {}
  restore(): void {}
  translate(): void {}
  rotate(): void {}
  scale(): void {}
  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  closePath(): void {}
  rect(): void {}
  fill(): void {}
  stroke(): void {}
  clip(): void {}
  fillRect(): void {
    this.fills.push(this.fillStyle);
  }
  clearRect(): void {
    this.clears++;
  }
  fillText(text: string): void {
    this.texts.push(text);
  }
  strokeText(): void {}
}

function fakeFactory() {
  const canvases: { w: number; h: number; ctx: FakeContext }[] = [];
  const factory = (w: number, h: number): LiveryCanvas => {
    const ctx = new FakeContext();
    canvases.push({ w, h, ctx });
    return { getContext: () => ctx, width: w, height: h } as LiveryCanvas;
  };
  return { factory, canvases };
}

function setPose(eid: EntityId, x: number, y: number, z: number): void {
  Transform.x[eid] = PrevTransform.x[eid] = x;
  Transform.y[eid] = PrevTransform.y[eid] = y;
  Transform.z[eid] = PrevTransform.z[eid] = z;
  Transform.qx[eid] = PrevTransform.qx[eid] = 0;
  Transform.qy[eid] = PrevTransform.qy[eid] = 0;
  Transform.qz[eid] = PrevTransform.qz[eid] = 0;
  Transform.qw[eid] = PrevTransform.qw[eid] = 1;
}
function addCar(world: GameWorld, modelIndex: number, x: number, z: number): EntityId {
  const eid = spawn(world, Transform, PrevTransform);
  attachVehicleLook(world, eid, modelIndex, 0xffffff);
  setPose(eid, x, 0.9, z);
  return eid;
}

function setup(options: ConstructorParameters<typeof LiveryRenderer>[1] = {}) {
  const scene = new THREE.Scene();
  const world = createGameWorld();
  const fake = fakeFactory();
  const renderer = new LiveryRenderer(scene, { canvasFactory: fake.factory, ...options });
  return { scene, world, renderer, fake };
}

function shells(scene: THREE.Scene): THREE.Mesh[] {
  const group = scene.getObjectByName('livery-shells');
  return (group?.children ?? []).filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
}
const visibleShells = (scene: THREE.Scene): THREE.Mesh[] => shells(scene).filter((m) => m.visible);

describe('LiveryRenderer painting', () => {
  it('paints a 1024x512 colour canvas and a reflective-only canvas once per vehicle', () => {
    const { world, renderer, fake } = setup();
    const eid = addCar(world, SEDAN.index, 0, 0);
    renderer.set(eid, SEDAN, DOC, '12', 'City Police');
    expect(fake.canvases.length).toBe(2);
    expect(fake.canvases.every((c) => c.w === 1024 && c.h === 512)).toBe(true);
    const [color, glow] = fake.canvases;
    expect(color?.ctx.clears).toBe(1);
    expect(glow?.ctx.clears).toBe(1);
    // The unit number is substituted in the colour map (roof and rear text); the emissive map only has reflective layers.
    expect(color?.ctx.texts).toContain('12');
    expect(color?.ctx.texts.some((t) => t.includes('{'))).toBe(false);
    expect(color?.ctx.texts.length ?? 0).toBeGreaterThan(glow?.ctx.texts.length ?? 0);
    expect(renderer.stats.repaints).toBe(1);
    renderer.dispose();
  });

  it('repaints only when the document, unit or department change', () => {
    const { world, renderer, fake } = setup();
    const eid = addCar(world, SEDAN.index, 0, 0);
    renderer.set(eid, SEDAN, DOC, '12', 'City Police');
    renderer.set(eid, SEDAN, DOC, '12', 'City Police');
    renderer.update(1, 0, 0, 0);
    renderer.set(eid, SEDAN, DOC, '12', 'City Police');
    expect(renderer.stats.repaints).toBe(1);
    expect(fake.canvases.length).toBe(2); // canvases are reused

    // An identical document that is a different object (re-parsed): no repaint.
    renderer.set(eid, SEDAN, structuredClone(DOC), '12', 'City Police');
    expect(renderer.stats.repaints).toBe(1);

    renderer.set(eid, SEDAN, DOC, '13', 'City Police');
    expect(renderer.stats.repaints).toBe(2);
    expect(fake.canvases[0]?.ctx.clears).toBe(2);
    expect(fake.canvases[1]?.ctx.clears).toBe(2);
    expect(fake.canvases[0]?.ctx.texts).toContain('13');

    renderer.set(eid, SEDAN, DOC, '13', 'Metro Police');
    expect(renderer.stats.repaints).toBe(3);

    const edited: LiveryDoc = { ...structuredClone(DOC), name: 'Edited' };
    edited.base = { color: '#ff0000', finish: 'matte' };
    renderer.set(eid, SEDAN, edited, '13', 'Metro Police');
    expect(renderer.stats.repaints).toBe(4);
    renderer.dispose();
  });

  it('keeps one canvas pair per liveried vehicle and sets material and texture parameters', () => {
    const { scene, world, renderer, fake } = setup();
    const a = addCar(world, SEDAN.index, 0, 0);
    const b = addCar(world, SEDAN.index, 5, 0);
    renderer.set(a, SEDAN, DOC, '1', 'City Police');
    renderer.set(b, SEDAN, defaultLivery('unmarkedGrey'), '2', 'City Police');
    expect(fake.canvases.length).toBe(4);
    renderer.update(1, 0, 0, 1);
    const [first, second] = visibleShells(scene);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const m = first?.material as THREE.MeshStandardMaterial;
    expect(m).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(m.map).toBeInstanceOf(THREE.CanvasTexture);
    expect(m.emissiveMap).toBeInstanceOf(THREE.CanvasTexture);
    expect(m.map).not.toBe(m.emissiveMap);
    expect(m.map?.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(m.emissive.getHex()).toBe(0xffffff);
    expect(m.transparent).toBe(true);
    expect(m.alphaTest).toBeCloseTo(0.04, 9);
    expect(m.depthWrite).toBe(false);
    expect(m.polygonOffset).toBe(true);
    expect(m.polygonOffsetFactor).toBe(-2);
    expect(DOC.base.finish).toBe('gloss');
    expect(m.roughness).toBeCloseTo(0.35, 9);
    expect(first?.material).not.toBe(second?.material);
    renderer.dispose();
  });

  it('maps finishes to roughness / metalness', () => {
    const { scene, world, renderer } = setup();
    const eid = addCar(world, SEDAN.index, 0, 0);
    const expected = { gloss: [0.35, 0], matte: [0.85, 0], metallic: [0.3, 0.6] } as const;
    for (const finish of ['gloss', 'matte', 'metallic'] as const) {
      const doc: LiveryDoc = { ...structuredClone(DOC), base: { color: '#112233', finish } };
      renderer.set(eid, SEDAN, doc, '1', 'City Police');
      renderer.update(1, 0, 0, 0);
      const m = visibleShells(scene)[0]?.material as THREE.MeshStandardMaterial;
      expect([m.roughness, m.metalness], finish).toEqual(expected[finish]);
    }
    renderer.dispose();
  });

  it('flags both textures for upload on a repaint', () => {
    const { scene, world, renderer } = setup();
    const eid = addCar(world, SEDAN.index, 0, 0);
    renderer.set(eid, SEDAN, DOC, '1', 'City Police');
    renderer.update(1, 0, 0, 0);
    const m = visibleShells(scene)[0]?.material as THREE.MeshStandardMaterial;
    const versionBefore = [m.map?.version ?? 0, m.emissiveMap?.version ?? 0];
    renderer.set(eid, SEDAN, DOC, '2', 'City Police');
    expect(m.map?.version).toBeGreaterThan(versionBefore[0] ?? 0);
    expect(m.emissiveMap?.version).toBeGreaterThan(versionBefore[1] ?? 0);
    renderer.dispose();
  });
});

describe('LiveryRenderer placement', () => {
  it('puts the shell at the interpolated vehicle transform and drives the glow with night', () => {
    const { scene, world, renderer } = setup();
    const eid = addCar(world, SEDAN.index, 3, -4);
    renderer.set(eid, SEDAN, DOC, '1', 'City Police');
    renderer.update(1, 0, 0, 0);
    const mesh = visibleShells(scene)[0] as THREE.Mesh;
    expect(mesh.position.x).toBeCloseTo(3, 6);
    expect(mesh.position.z).toBeCloseTo(-4, 6);
    expect((mesh.material as THREE.MeshStandardMaterial).emissiveIntensity).toBe(0);
    renderer.update(1, 0, 0, 1);
    expect((mesh.material as THREE.MeshStandardMaterial).emissiveIntensity).toBeCloseTo(0.9, 9);
    renderer.update(1, 0, 0, 0.5);
    expect((mesh.material as THREE.MeshStandardMaterial).emissiveIntensity).toBeCloseTo(0.45, 9);
    renderer.update(1, 0, 0, 7);
    expect((mesh.material as THREE.MeshStandardMaterial).emissiveIntensity).toBeCloseTo(0.9, 9);
    renderer.dispose();
  });

  it('follows the leaned transform of a two-wheeler through vehicleRenderBasis', () => {
    const { scene, world, renderer } = setup();
    const eid = addCar(world, MOTO.index, 3, -4);
    VehicleLook.lean[eid] = 0.35;
    renderer.set(eid, MOTO, defaultLivery('motorMarked'), '7', 'City Police');
    renderer.update(1, 0, 0, 0);
    const mesh = visibleShells(scene)[0] as THREE.Mesh;
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    vehicleRenderBasis(eid, 1, pos, quat);
    expect(mesh.position.distanceTo(pos)).toBe(0);
    expect(mesh.quaternion.angleTo(quat)).toBeLessThan(1e-9);
    expect(mesh.quaternion.angleTo(new THREE.Quaternion())).toBeCloseTo(0.35, 6);
    renderer.dispose();
  });

  it('shows only the nearest maxVisible shells within maxDistance', () => {
    const { scene, world, renderer } = setup({ maxVisible: 3, maxDistance: 100 });
    const eids: EntityId[] = [];
    const xs = [60, 10, 90, 30, 50, 20, 70, 150];
    for (const x of xs) {
      const eid = addCar(world, SEDAN.index, x, 0);
      eids.push(eid);
      renderer.set(eid, SEDAN, DOC, String(x), 'City Police');
    }
    renderer.update(1, 0, 0, 0);
    expect(renderer.stats.shells).toBe(3);
    expect(renderer.stats.drawCalls).toBe(3);
    const shown = visibleShells(scene).map((m) => m.position.x).sort((a, b) => a - b);
    expect(shown).toEqual([10, 20, 30]);
    expect(shells(scene).length).toBe(3); // the pool does not grow past maxVisible

    // Move the camera: the selection follows it, and a farther vehicle pops in.
    renderer.update(1, 85, 0, 0);
    expect(visibleShells(scene).map((m) => m.position.x).sort((a, b) => a - b)).toEqual([60, 70, 90]);
    // Everything out of range: nothing is drawn.
    renderer.update(1, 1000, 0, 0);
    expect(renderer.stats).toMatchObject({ shells: 0, drawCalls: 0 });
    expect(visibleShells(scene).length).toBe(0);
    // Fewer candidates than the pool: the extra shells hide.
    renderer.update(1, 150, 0, 0);
    expect(renderer.stats.shells).toBe(3);
    renderer.remove(eids[7] as EntityId);
    renderer.remove(eids[2] as EntityId);
    renderer.remove(eids[6] as EntityId);
    renderer.update(1, 150, 0, 0);
    expect(renderer.stats.shells).toBe(2);
    expect(visibleShells(scene).length).toBe(2);
    renderer.dispose();
  });

  it('swaps the shell geometry with the model of the vehicle it is assigned to', () => {
    const { scene, world, renderer } = setup({ maxVisible: 1 });
    const car = addCar(world, SEDAN.index, 5, 0);
    const bike = addCar(world, MOTO.index, 50, 0);
    renderer.set(car, SEDAN, DOC, '1', 'City Police');
    renderer.set(bike, MOTO, defaultLivery('motorMarked'), '2', 'City Police');
    renderer.update(1, 0, 0, 0);
    const mesh = visibleShells(scene)[0] as THREE.Mesh;
    expect(mesh.geometry.name).toBe('livery-shell:patrol_sedan');
    renderer.update(1, 60, 0, 0);
    expect(mesh.geometry.name).toBe('livery-shell:police_motorcycle');
    expect(mesh.geometry.getAttribute('position').count).toBe(24);
    expect(mesh.geometry.getAttribute('uv').count).toBe(24);
    expect(mesh.geometry.index?.count).toBe(36);
    renderer.dispose();
  });

  it('creates no objects per frame once the pool is warm', () => {
    const { scene, world, renderer } = setup({ maxVisible: 4 });
    for (let i = 0; i < 6; i++) {
      const eid = addCar(world, i % 2 === 0 ? SEDAN.index : MOTO.index, i * 5, 0);
      renderer.set(eid, i % 2 === 0 ? SEDAN : MOTO, DOC, String(i), 'City Police');
    }
    renderer.update(0, 0, 0, 0.5);
    const group = scene.getObjectByName('livery-shells') as THREE.Object3D;
    let before = 0;
    group.traverse(() => before++);
    for (let f = 0; f < 20; f++) renderer.update(f / 20, f, 0, 0.5);
    let after = 0;
    group.traverse(() => after++);
    expect(after).toBe(before);
    renderer.dispose();
  });
});

describe('LiveryRenderer lifecycle', () => {
  it('set(null) and remove free the textures and material of the vehicle', () => {
    const { scene, world, renderer } = setup();
    const eid = addCar(world, SEDAN.index, 0, 0);
    renderer.set(eid, SEDAN, DOC, '1', 'City Police');
    renderer.update(1, 0, 0, 0);
    const m = visibleShells(scene)[0]?.material as THREE.MeshStandardMaterial;
    const mapDisposed = vi.fn();
    const glowDisposed = vi.fn();
    const materialDisposed = vi.fn();
    m.map?.addEventListener('dispose', mapDisposed);
    m.emissiveMap?.addEventListener('dispose', glowDisposed);
    m.addEventListener('dispose', materialDisposed);
    expect(renderer.size).toBe(1);
    renderer.set(eid, SEDAN, null, '1', 'City Police');
    expect(renderer.size).toBe(0);
    expect(mapDisposed).toHaveBeenCalledTimes(1);
    expect(glowDisposed).toHaveBeenCalledTimes(1);
    expect(materialDisposed).toHaveBeenCalledTimes(1);
    renderer.update(1, 0, 0, 0);
    expect(visibleShells(scene).length).toBe(0);
    expect(renderer.stats.shells).toBe(0);
    // Removing an unknown id is harmless.
    renderer.remove(eid);
    renderer.remove(9999);
    renderer.dispose();
  });

  it('dispose removes the group and frees geometry, material and textures', () => {
    const { scene, world, renderer } = setup();
    const eid = addCar(world, SEDAN.index, 0, 0);
    renderer.set(eid, SEDAN, DOC, '1', 'City Police');
    renderer.update(1, 0, 0, 0);
    const mesh = visibleShells(scene)[0] as THREE.Mesh;
    const geometryDisposed = vi.fn();
    const textureDisposed = vi.fn();
    mesh.geometry.addEventListener('dispose', geometryDisposed);
    (mesh.material as THREE.MeshStandardMaterial).map?.addEventListener('dispose', textureDisposed);
    renderer.dispose();
    expect(scene.getObjectByName('livery-shells')).toBeUndefined();
    expect(scene.children.length).toBe(0);
    expect(geometryDisposed).toHaveBeenCalled();
    expect(textureDisposed).toHaveBeenCalled();
    expect(renderer.size).toBe(0);
    renderer.dispose(); // idempotent
  });

  it('survives a canvas without a 2D context: the document is recorded, nothing is drawn', () => {
    const scene = new THREE.Scene();
    const world = createGameWorld();
    const renderer = new LiveryRenderer(scene, { canvasFactory: () => ({ getContext: () => null }) });
    const eid = addCar(world, SEDAN.index, 0, 0);
    renderer.set(eid, SEDAN, DOC, '1', 'City Police');
    renderer.update(1, 0, 0, 0);
    expect(renderer.size).toBe(1);
    expect(renderer.stats.repaints).toBe(0);
    expect(visibleShells(scene).length).toBe(0);
    renderer.dispose();
  });
});

describe('LiveryRenderer headless', () => {
  it('has no canvas without a document: set records, update only counts, nothing is drawn', () => {
    expect(typeof document).toBe('undefined');
    const scene = new THREE.Scene();
    const world = createGameWorld();
    const renderer = new LiveryRenderer(scene);
    const a = addCar(world, SEDAN.index, 5, 0);
    const b = addCar(world, MOTO.index, 500, 0);
    renderer.set(a, SEDAN, DOC, '1', 'City Police');
    renderer.set(b, MOTO, defaultLivery('motorMarked'), '2', 'City Police');
    renderer.update(1, 0, 0, 1);
    expect(renderer.size).toBe(2);
    expect(renderer.stats).toEqual({ shells: 1, drawCalls: 0, repaints: 0 });
    expect(visibleShells(scene).length).toBe(0);
    renderer.remove(a);
    renderer.update(1, 0, 0, 1);
    expect(renderer.stats.shells).toBe(0);
    renderer.dispose();
  });
});
