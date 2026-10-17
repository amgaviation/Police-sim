import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PrevTransform, Transform } from '../../src/ecs/components';
import { createGameWorld, spawn } from '../../src/ecs/world';
import { PeopleRenderer } from '../../src/render/people/peopleRenderer';
import { BODY, createHumanoidSource, FIGURE_FLAG, HELD, POSE } from '../../src/render/people/pose';

/** The Node pieces the allocation test needs (the project has no Node type definitions). */
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

type Source = ReturnType<typeof createHumanoidSource>;

function mesh(scene: THREE.Scene, name: string): THREE.InstancedMesh {
  const found = scene.getObjectByName(name);
  if (!(found instanceof THREE.InstancedMesh)) throw new Error(`missing mesh ${name}`);
  return found as THREE.InstancedMesh;
}

const scratch = new THREE.Matrix4();

/** Position of instance `i` of `m`. */
function at(m: THREE.InstancedMesh, i: number): THREE.Vector3 {
  m.getMatrixAt(i, scratch);
  return new THREE.Vector3().setFromMatrixPosition(scratch);
}

/** Lengths of the basis columns of instance `i` (three's decompose does not report a zero scale). */
function scaleOf(m: THREE.InstancedMesh, i: number): THREE.Vector3 {
  const e = m.instanceMatrix.array;
  const o = i * 16;
  const col = (c: number): number => Math.hypot(e[o + c * 4] ?? 0, e[o + c * 4 + 1] ?? 0, e[o + c * 4 + 2] ?? 0);
  return new THREE.Vector3(col(0), col(1), col(2));
}

function colorOf(m: THREE.InstancedMesh, i: number): THREE.Color {
  return new THREE.Color().fromArray(m.instanceColor?.array ?? [], i * 3);
}

function add(
  s: Source,
  x: number,
  z: number,
  extra: { pose?: number; yaw?: number; held?: number; hair?: number; flags?: number; body?: number; anchor?: number; y?: number } = {},
): number {
  const i = s.count++;
  s.x[i] = s.prevX[i] = x;
  s.y[i] = s.prevY[i] = extra.y ?? 0;
  s.z[i] = s.prevZ[i] = z;
  s.yaw[i] = s.prevYaw[i] = extra.yaw ?? 0;
  s.anchor[i] = extra.anchor ?? 0;
  s.pose[i] = extra.pose ?? POSE.stand;
  s.skin[i] = 0xc68642;
  s.hair[i] = extra.hair ?? 0x4b3621;
  s.top[i] = 0xa3262a;
  s.bottom[i] = 0x34507a;
  s.held[i] = extra.held ?? HELD.none;
  s.body[i] = extra.body ?? BODY.human;
  s.flags[i] = extra.flags ?? 0;
  s.speed[i] = 0;
  s.gait[i] = 0;
  return i;
}

function setup(capacity = 64) {
  const scene = new THREE.Scene();
  const people = new PeopleRenderer(scene, { capacity });
  return { scene, people };
}

describe('PeopleRenderer instance counts', () => {
  it('draws one head, hair, torso, two arms and four leg segments per human', () => {
    const { scene, people } = setup();
    const s = createHumanoidSource(8);
    for (let i = 0; i < 3; i++) add(s, i * 2, -5);
    people.update(1, [s], 0, 0, 100);
    expect(mesh(scene, 'people-head').count).toBe(3);
    expect(mesh(scene, 'people-hair').count).toBe(3);
    expect(mesh(scene, 'people-torso').count).toBe(3);
    expect(mesh(scene, 'people-arms').count).toBe(6);
    expect(mesh(scene, 'people-legs').count).toBe(12);
    expect(mesh(scene, 'people-dogs').count).toBe(0);
    expect(mesh(scene, 'people-held').count).toBe(0);
    expect(people.stats.figures).toBe(3);
    expect(people.stats.drawCalls).toBe(5);
  });

  it('follows the sources: more, fewer and several sources together', () => {
    const { scene, people } = setup();
    const a = createHumanoidSource(8);
    const b = createHumanoidSource(8);
    for (let i = 0; i < 4; i++) add(a, i, -3);
    for (let i = 0; i < 2; i++) add(b, i, -6);
    people.update(1, [a, b], 0, 0, 100);
    expect(mesh(scene, 'people-torso').count).toBe(6);
    a.count = 1;
    people.update(1, [a, b], 0, 0, 100);
    expect(mesh(scene, 'people-torso').count).toBe(3);
    expect(mesh(scene, 'people-torso').visible).toBe(true);
    people.update(1, [], 0, 0, 100);
    expect(mesh(scene, 'people-torso').count).toBe(0);
    expect(mesh(scene, 'people-torso').visible).toBe(false);
    expect(people.stats.figures).toBe(0);
    expect(people.stats.drawCalls).toBe(0);
  });

  it('skips hidden figures and figures beyond the draw distance', () => {
    const { scene, people } = setup();
    const s = createHumanoidSource(8);
    add(s, 1, -1);
    add(s, 2, -1, { flags: FIGURE_FLAG.hidden });
    add(s, 3, -1, { flags: FIGURE_FLAG.highlight });
    add(s, 500, 0);
    people.update(1, [s], 0, 0, 150);
    expect(mesh(scene, 'people-torso').count).toBe(2);
    // The two drawn figures are 1 and 3 (the hidden one is not packed).
    expect(at(mesh(scene, 'people-torso'), 0).x).toBeCloseTo(1);
    expect(at(mesh(scene, 'people-torso'), 1).x).toBeCloseTo(3);
  });

  it('stops at the capacity', () => {
    const { scene, people } = setup(4);
    const s = createHumanoidSource(10);
    for (let i = 0; i < 10; i++) add(s, i, -2);
    people.update(1, [s], 0, 0, 100);
    expect(mesh(scene, 'people-head').count).toBe(4);
    expect(mesh(scene, 'people-legs').count).toBe(16);
  });

  it('draws dogs in their own mesh and held items only for figures holding one', () => {
    const { scene, people } = setup();
    const s = createHumanoidSource(8);
    add(s, 0, -3, { held: HELD.knife });
    add(s, 2, -3, { body: BODY.dog });
    add(s, 4, -3, { held: HELD.none });
    add(s, 6, -3, { held: HELD.phone });
    people.update(1, [s], 0, 0, 100);
    expect(mesh(scene, 'people-dogs').count).toBe(1);
    expect(mesh(scene, 'people-torso').count).toBe(3);
    expect(mesh(scene, 'people-held').count).toBe(2);
    expect(people.stats.figures).toBe(4);
    expect(people.stats.drawCalls).toBe(7);
  });

  it('uses at most 8 draw calls with every mesh in use', () => {
    const { scene, people } = setup();
    const s = createHumanoidSource(8);
    add(s, 0, -3, { held: HELD.handgun });
    add(s, 2, -3, { body: BODY.dog });
    people.update(1, [s], 0, 0, 100);
    expect(people.stats.drawCalls).toBeLessThanOrEqual(8);
    let meshes = 0;
    scene.traverse((o) => {
      if (o instanceof THREE.InstancedMesh) meshes++;
    });
    expect(meshes).toBeLessThanOrEqual(8);
  });
});

describe('PeopleRenderer placement', () => {
  it('stands the figure on its feet height with the torso above the hip pivot', () => {
    const { scene, people } = setup();
    const s = createHumanoidSource(2);
    add(s, 10, 20, { y: 1.5 });
    people.update(1, [s], 10, 20, 100);
    const torso = at(mesh(scene, 'people-torso'), 0);
    expect(torso.x).toBeCloseTo(10);
    expect(torso.z).toBeCloseTo(20);
    expect(torso.y).toBeCloseTo(1.5 + 0.85);
    // Head sits above the torso, legs hang below the hip.
    expect(at(mesh(scene, 'people-head'), 0).y).toBeCloseTo(1.5 + 0.85 + 0.58);
    expect(at(mesh(scene, 'people-legs'), 0).y).toBeCloseTo(1.5 + 0.85);
    expect(at(mesh(scene, 'people-legs'), 1).y).toBeCloseTo(1.5 + 0.85 - 0.425);
  });

  it('places the left leg at -X and the right at +X for yaw 0, rotated with the yaw', () => {
    const { scene, people } = setup();
    const s = createHumanoidSource(2);
    add(s, 0, 0);
    add(s, 0, 10, { yaw: Math.PI / 2 });
    people.update(1, [s], 0, 0, 100);
    const legs = mesh(scene, 'people-legs');
    expect(at(legs, 0).x).toBeLessThan(0);
    expect(at(legs, 2).x).toBeGreaterThan(0);
    // Yaw +90 deg faces -X, so the figure's right side points to -Z... (right = +X rotated by yaw).
    const rightLeg = at(legs, 4 + 2);
    expect(rightLeg.z - 10).toBeLessThan(-0.05);
    expect(Math.abs(rightLeg.x)).toBeLessThan(1e-6);
  });

  it('interpolates position and takes the short way around in yaw', () => {
    const { scene, people } = setup();
    const s = createHumanoidSource(2);
    const i = add(s, 0, 0);
    s.x[i] = 10;
    s.z[i] = -4;
    people.update(0.5, [s], 0, 0, 100);
    const torso = at(mesh(scene, 'people-torso'), 0);
    expect(torso.x).toBeCloseTo(5);
    expect(torso.z).toBeCloseTo(-2);
    // yaw from 3.0 to -3.0 (wrapping through pi): halfway is about pi, not 0.
    s.prevYaw[i] = 3.0;
    s.yaw[i] = -3.0;
    people.update(0.5, [s], 0, 0, 100);
    const m = mesh(scene, 'people-torso');
    m.getMatrixAt(0, scratch);
    // The torso's local -Z (front) after the matrix: yaw pi faces +Z.
    const front = new THREE.Vector3(0, 0, -1).transformDirection(scratch);
    expect(front.z).toBeGreaterThan(0.99);
  });

  it('scales the figure with height and build', () => {
    const { scene, people } = setup();
    const s = createHumanoidSource(2);
    add(s, 0, -3);
    add(s, 3, -3);
    s.height[1] = 1.4;
    s.build[1] = 1.2;
    people.update(1, [s], 0, 0, 100);
    const torso = mesh(scene, 'people-torso');
    expect(scaleOf(torso, 0).y).toBeCloseTo(1);
    expect(scaleOf(torso, 1).y).toBeCloseTo(1.4 / 1.75);
    expect(scaleOf(torso, 1).x).toBeCloseTo((1.4 / 1.75) * 1.2);
    expect(at(torso, 1).y).toBeCloseTo(0.85 * (1.4 / 1.75));
  });

  it('writes skin, hair, top and bottom colours, lightening highlighted torsos', () => {
    const { scene, people } = setup();
    const s = createHumanoidSource(2);
    add(s, 0, -3);
    add(s, 3, -3, { flags: FIGURE_FLAG.highlight });
    people.update(1, [s], 0, 0, 100);
    const expected = (hex: number): THREE.Color => new THREE.Color(hex);
    expect(colorOf(mesh(scene, 'people-head'), 0).getHex()).toBe(expected(0xc68642).getHex());
    expect(colorOf(mesh(scene, 'people-hair'), 0).getHex()).toBe(expected(0x4b3621).getHex());
    expect(colorOf(mesh(scene, 'people-torso'), 0).getHex()).toBe(expected(0xa3262a).getHex());
    expect(colorOf(mesh(scene, 'people-arms'), 1).getHex()).toBe(expected(0xa3262a).getHex());
    expect(colorOf(mesh(scene, 'people-legs'), 3).getHex()).toBe(expected(0x34507a).getHex());
    const plain = colorOf(mesh(scene, 'people-torso'), 0);
    const lit = colorOf(mesh(scene, 'people-torso'), 1);
    expect(lit.r).toBeGreaterThan(plain.r);
    expect(lit.g).toBeGreaterThan(plain.g);
    expect(lit.b).toBeGreaterThan(plain.b);
  });

  it('scales the hair cap to zero for bald figures only', () => {
    const { scene, people } = setup();
    const s = createHumanoidSource(2);
    add(s, 0, -3, { hair: 0xffffffff });
    add(s, 3, -3, { hair: 0x1b1b1b });
    people.update(1, [s], 0, 0, 100);
    const hair = mesh(scene, 'people-hair');
    expect(hair.count).toBe(2);
    const bald = scaleOf(hair, 0);
    expect(bald.x).toBe(0);
    expect(bald.y).toBe(0);
    expect(bald.z).toBe(0);
    expect(scaleOf(hair, 1).y).toBeCloseTo(1);
  });
});

describe('PeopleRenderer poses', () => {
  it('swings the legs while walking nearby and freezes them beyond 50 m', () => {
    const { scene, people } = setup();
    const s = createHumanoidSource(4);
    for (const z of [-5, -80]) {
      const i = add(s, 0, z, { pose: POSE.walk });
      s.speed[i] = 1.4;
      s.gait[i] = 0.25;
    }
    people.update(1, [s], 0, 0, 150);
    const legs = mesh(scene, 'people-legs');
    // Near figure: the thigh tips forward/back (its end is not straight below the hip).
    const hipNear = at(legs, 0);
    const shinNear = at(legs, 1);
    expect(Math.abs(shinNear.z - hipNear.z)).toBeGreaterThan(0.05);
    // Far figure: legs hang straight.
    const hipFar = at(legs, 4);
    const shinFar = at(legs, 5);
    expect(Math.abs(shinFar.z - hipFar.z)).toBeLessThan(1e-6);
  });

  it('lays a prone figure flat: head ahead of the torso at ground height', () => {
    const { scene, people } = setup();
    const s = createHumanoidSource(2);
    add(s, 0, 0, { pose: POSE.prone });
    people.update(1, [s], 0, 0, 100);
    const torso = at(mesh(scene, 'people-torso'), 0);
    const head = at(mesh(scene, 'people-head'), 0);
    expect(torso.y).toBeCloseTo(0.12);
    expect(head.y).toBeLessThan(0.3);
    // Facing -Z, lying face down: the head is in front (smaller z).
    expect(head.z).toBeLessThan(-0.5);
  });

  it('raises both hands above the head', () => {
    const { scene, people } = setup();
    const s = createHumanoidSource(2);
    add(s, 0, 0, { pose: POSE.handsUp });
    people.update(1, [s], 0, 0, 100);
    const arms = mesh(scene, 'people-arms');
    for (let a = 0; a < 2; a++) {
      arms.getMatrixAt(a, scratch);
      // The arm's far end (local -Y * 0.6) is above the shoulder.
      const tip = new THREE.Vector3(0, -0.6, 0).applyMatrix4(scratch);
      expect(tip.y).toBeGreaterThan(at(arms, a).y + 0.5);
    }
  });

  it('seats a figure lower with the thighs pointing forward', () => {
    const { scene, people } = setup();
    const s = createHumanoidSource(2);
    add(s, 0, 0, { pose: POSE.seated });
    people.update(1, [s], 0, 0, 100);
    expect(at(mesh(scene, 'people-torso'), 0).y).toBeCloseTo(0.4);
    const legs = mesh(scene, 'people-legs');
    // The knee (shin start) is in front of the hip (-Z) and the foot hangs below the knee.
    expect(at(legs, 1).z - at(legs, 0).z).toBeLessThan(-0.4);
    legs.getMatrixAt(1, scratch);
    const foot = new THREE.Vector3(0, -0.425, 0).applyMatrix4(scratch);
    expect(foot.y).toBeLessThan(at(legs, 1).y - 0.4);
  });

  it('holds a raised gun with two hands when aiming', () => {
    const { scene, people } = setup();
    const s = createHumanoidSource(2);
    add(s, 0, 0, { pose: POSE.aim, held: HELD.handgun });
    people.update(1, [s], 0, 0, 100);
    const arms = mesh(scene, 'people-arms');
    for (let a = 0; a < 2; a++) {
      arms.getMatrixAt(a, scratch);
      const tip = new THREE.Vector3(0, -0.6, 0).applyMatrix4(scratch);
      expect(tip.z - at(arms, a).z).toBeLessThan(-0.5);
    }
    // The gun sits beyond the right hand.
    expect(at(mesh(scene, 'people-held'), 0).z).toBeLessThan(at(arms, 1).z - 0.5);
  });
});

describe('PeopleRenderer anchored figures', () => {
  it('follow the interpolated vehicle transform', () => {
    const world = createGameWorld();
    const eid = spawn(world, Transform, PrevTransform);
    const yawPrev = 0;
    const yawCur = Math.PI / 2;
    const qa = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawPrev);
    const qb = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawCur);
    PrevTransform.x[eid] = 100;
    PrevTransform.y[eid] = 0.5;
    PrevTransform.z[eid] = 40;
    PrevTransform.qx[eid] = qa.x;
    PrevTransform.qy[eid] = qa.y;
    PrevTransform.qz[eid] = qa.z;
    PrevTransform.qw[eid] = qa.w;
    Transform.x[eid] = 110;
    Transform.y[eid] = 0.5;
    Transform.z[eid] = 40;
    Transform.qx[eid] = qb.x;
    Transform.qy[eid] = qb.y;
    Transform.qz[eid] = qb.z;
    Transform.qw[eid] = qb.w;

    const { scene, people } = setup();
    const s = createHumanoidSource(2);
    add(s, 0.4, -0.6, { pose: POSE.seated, anchor: eid, y: 0.3 });
    people.update(0.5, [s], 105, 40, 100);

    const q = new THREE.Quaternion().slerpQuaternions(qa, qb, 0.5);
    // Seated drops the hip pivot from 0.85 to 0.4 above the local origin.
    const expected = new THREE.Vector3(0.4, 0.3 + 0.4, -0.6).applyQuaternion(q).add(new THREE.Vector3(105, 0.5, 40));
    const torso = at(mesh(scene, 'people-torso'), 0);
    expect(torso.x).toBeCloseTo(expected.x, 4);
    expect(torso.y).toBeCloseTo(expected.y, 4);
    expect(torso.z).toBeCloseTo(expected.z, 4);
  });

  it('turn with the vehicle and move when it moves', () => {
    const world = createGameWorld();
    const eid = spawn(world, Transform, PrevTransform);
    const set = (x: number, yaw: number): void => {
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      for (const t of [Transform, PrevTransform]) {
        t.x[eid] = x;
        t.y[eid] = 0;
        t.z[eid] = 0;
        t.qx[eid] = q.x;
        t.qy[eid] = q.y;
        t.qz[eid] = q.z;
        t.qw[eid] = q.w;
      }
    };
    const { scene, people } = setup();
    const s = createHumanoidSource(2);
    add(s, 0.4, 0, { anchor: eid });
    set(0, 0);
    people.update(1, [s], 0, 0, 100);
    const before = at(mesh(scene, 'people-torso'), 0);
    set(20, Math.PI);
    people.update(1, [s], 20, 0, 100);
    const after = at(mesh(scene, 'people-torso'), 0);
    expect(before.x).toBeCloseTo(0.4);
    // Yawed 180 degrees, the +0.4 seat offset is now at -0.4 relative to the vehicle.
    expect(after.x).toBeCloseTo(20 - 0.4, 4);
    mesh(scene, 'people-torso').getMatrixAt(0, scratch);
    expect(new THREE.Vector3(0, 0, -1).transformDirection(scratch).z).toBeGreaterThan(0.99);
  });

  it('survive a vehicle without a transform (identity frame)', () => {
    const { scene, people } = setup();
    const s = createHumanoidSource(2);
    add(s, 1, 2, { anchor: 3999 });
    people.update(1, [s], 0, 0, 100);
    const torso = at(mesh(scene, 'people-torso'), 0);
    expect(Number.isFinite(torso.x + torso.y + torso.z)).toBe(true);
  });
});

describe('PeopleRenderer dogs and lifecycle', () => {
  it('scales dogs by shoulder height and rolls a lying dog onto its side', () => {
    const { scene, people } = setup();
    const s = createHumanoidSource(3);
    add(s, 0, -3, { body: BODY.dog });
    add(s, 3, -3, { body: BODY.dog });
    add(s, 6, -3, { body: BODY.dog, pose: POSE.lying });
    s.height[0] = 0.6;
    s.height[1] = 0.9;
    s.height[2] = 0.6;
    people.update(1, [s], 0, 0, 100);
    const dogs = mesh(scene, 'people-dogs');
    expect(dogs.count).toBe(3);
    expect(scaleOf(dogs, 0).y).toBeCloseTo(1);
    expect(scaleOf(dogs, 1).y).toBeCloseTo(1.5);
    dogs.getMatrixAt(2, scratch);
    expect(new THREE.Vector3(0, 1, 0).transformDirection(scratch).y).toBeLessThan(0.01);
  });

  it('removes its meshes from the scene on dispose', () => {
    const { scene, people } = setup();
    expect(scene.getObjectByName('people')).toBeDefined();
    people.dispose();
    expect(scene.getObjectByName('people')).toBeUndefined();
  });

  it('never writes NaN with degenerate sources', () => {
    const { scene, people } = setup();
    const s = createHumanoidSource(3);
    add(s, 0, -3);
    s.height[0] = 0;
    s.build[0] = Number.NaN;
    people.update(1.7, [s], 0, 0, 100);
    for (const name of ['people-head', 'people-torso', 'people-arms', 'people-legs']) {
      const m = mesh(scene, name);
      for (let k = 0; k < m.count * 16; k++) expect(Number.isFinite(m.instanceMatrix.array[k] ?? NaN), name).toBe(true);
    }
  });
});

describe('PeopleRenderer performance', () => {
  function crowd(n: number): Source {
    const s = createHumanoidSource(n);
    for (let i = 0; i < n; i++) {
      const j = add(s, (i % 20) * 3 - 30, -Math.floor(i / 20) * 3 - 5, {
        pose: i % 5 === 0 ? POSE.walk : i % 7 === 0 ? POSE.run : POSE.stand,
        held: i % 9 === 0 ? HELD.phone : HELD.none,
        hair: i % 6 === 0 ? 0xffffffff : 0x4b3621,
      });
      s.speed[j] = 1.4;
      s.gait[j] = (i % 10) / 10;
    }
    return s;
  }

  it('does not allocate per figure in update', async () => {
    // Each update has a small fixed garbage cost (three's upload ranges), so the garbage of 300 figures is
    // compared with that of 20: a per-figure allocation (even one boxed number) would multiply it.
    const gc = await loadGc();
    const garbage = (n: number): number => {
      const { people } = setup(320);
      const sources = [crowd(n)];
      for (let i = 0; i < 300; i++) people.update(0.5, sources, 0, 0, 150);
      // A scavenge inside a window only lowers its delta: the largest of several short windows is the estimate.
      let worst = 0;
      for (let k = 0; k < 8; k++) {
        gc();
        const before = process.memoryUsage().heapUsed;
        for (let i = 0; i < 100; i++) people.update((i % 10) / 10, sources, 0, 0, 150);
        worst = Math.max(worst, process.memoryUsage().heapUsed - before);
      }
      return worst;
    };
    const few = garbage(20);
    const many = garbage(300);
    expect(few).toBeGreaterThan(0);
    expect(many / few).toBeLessThan(1.3);
    expect(many).toBeLessThan(600_000);
  });

  it('updates 300 figures well inside the frame budget', () => {
    const { people } = setup(320);
    const s = crowd(300);
    const sources = [s];
    for (let i = 0; i < 100; i++) people.update(0.5, sources, 0, 0, 150);
    const start = performance.now();
    const frames = 300;
    for (let i = 0; i < frames; i++) people.update((i % 10) / 10, sources, 0, 0, 150);
    const perFrame = (performance.now() - start) / frames;
    // Budget 0.6 ms; allow slack for a loaded CI machine.
    expect(perFrame).toBeLessThan(2);
  });
});
