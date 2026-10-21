import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PeopleRenderer } from '../../src/render/people/peopleRenderer';
import { BODY, createHumanoidSource, FIGURE_FLAG, HELD, POSE } from '../../src/render/people/pose';
import { buildOutfit, defaultOutfitSpec } from '../../src/uniform/outfit';
import { ATTACH, SKIN_SHINS, type AccessoryBox, type OutfitDef } from '../../src/uniform/types';

type Source = ReturnType<typeof createHumanoidSource>;

const SKIN = 0xc68642;
const BOTTOM = 0x34507a;

function mesh(scene: THREE.Scene, name: string): THREE.InstancedMesh {
  const found = scene.getObjectByName(name);
  if (!(found instanceof THREE.InstancedMesh)) throw new Error(`missing mesh ${name}`);
  return found as THREE.InstancedMesh;
}
const matrix = (m: THREE.InstancedMesh, i: number): THREE.Matrix4 => m.getMatrixAt(i, new THREE.Matrix4());
const at = (m: THREE.InstancedMesh, i: number): THREE.Vector3 => new THREE.Vector3().setFromMatrixPosition(matrix(m, i));
const colorOf = (m: THREE.InstancedMesh, i: number): THREE.Color => new THREE.Color().fromArray(m.instanceColor?.array ?? [], i * 3);
const linear = (hex: number): THREE.Color => new THREE.Color().setHex(hex);
function scaleOf(m: THREE.InstancedMesh, i: number): THREE.Vector3 {
  const e = m.instanceMatrix.array;
  const o = i * 16;
  const col = (c: number): number => Math.hypot(e[o + c * 4] ?? 0, e[o + c * 4 + 1] ?? 0, e[o + c * 4 + 2] ?? 0);
  return new THREE.Vector3(col(0), col(1), col(2));
}

function box(attach: (typeof ATTACH)[keyof typeof ATTACH], x: number, y: number, z: number, sx = 0.1, sy = 0.1, sz = 0.1, color = 0xff8800): AccessoryBox {
  return { attach, x, y, z, sx, sy, sz, color };
}
function outfit(boxes: AccessoryBox[], extra: Partial<OutfitDef> = {}): OutfitDef {
  return { id: 'test', top: 0x112233, bottom: BOTTOM, shins: null, boxes, hideHair: false, ...extra };
}
/** One box on each of the nine part frames. */
const EVERY_PART = outfit(Object.values(ATTACH).map((a, i) => box(a, 0.01 * i, 0.02, -0.03)));

function add(s: Source, x: number, z: number, extra: { pose?: number; yaw?: number; outfit?: number; y?: number } = {}): number {
  const i = s.count++;
  s.x[i] = s.prevX[i] = x;
  s.y[i] = s.prevY[i] = extra.y ?? 0;
  s.z[i] = s.prevZ[i] = z;
  s.yaw[i] = s.prevYaw[i] = extra.yaw ?? 0;
  s.pose[i] = extra.pose ?? POSE.stand;
  s.skin[i] = SKIN;
  s.hair[i] = 0x4b3621;
  s.top[i] = 0xa3262a;
  s.bottom[i] = BOTTOM;
  s.body[i] = BODY.human;
  s.outfit[i] = extra.outfit ?? 0;
  return i;
}

function setup(options: { capacity?: number; gearCapacity?: number } = {}) {
  const scene = new THREE.Scene();
  const people = new PeopleRenderer(scene, { capacity: options.capacity ?? 16, ...(options.gearCapacity !== undefined ? { gearCapacity: options.gearCapacity } : {}) });
  return { scene, people };
}

describe('HumanoidSource outfit arrays', () => {
  it('createHumanoidSource allocates outfit 0, shoulders 1, hips 1, shins 0', () => {
    const s = createHumanoidSource(5);
    expect(s.outfit).toBeInstanceOf(Uint16Array);
    expect(s.shins).toBeInstanceOf(Uint32Array);
    expect(s.shoulders).toBeInstanceOf(Float32Array);
    expect(s.hips).toBeInstanceOf(Float32Array);
    expect([s.outfit.length, s.shoulders.length, s.hips.length, s.shins.length]).toEqual([5, 5, 5, 5]);
    expect(Array.from(s.outfit)).toEqual([0, 0, 0, 0, 0]);
    expect(Array.from(s.shoulders)).toEqual([1, 1, 1, 1, 1]);
    expect(Array.from(s.hips)).toEqual([1, 1, 1, 1, 1]);
    expect(Array.from(s.shins)).toEqual([0, 0, 0, 0, 0]);
  });

  it('draws sources without the optional arrays like plain figures', () => {
    const { scene, people } = setup();
    const full = createHumanoidSource(2);
    add(full, 0, -3);
    const { outfit: _o, shoulders: _s, hips: _h, shins: _n, ...plain } = full;
    people.setOutfits([null, EVERY_PART]);
    people.update(1, [plain], 0, 0, 100);
    expect(mesh(scene, 'people-torso').count).toBe(1);
    expect(mesh(scene, 'people-gear').count).toBe(0);
    expect(people.stats.gearBoxes).toBe(0);
  });
});

describe('PeopleRenderer accessories', () => {
  it('draws one gear instance per accessory box of the figures wearing an outfit', () => {
    const { scene, people } = setup();
    const three = outfit([box(ATTACH.torso, 0, 0.3, -0.15), box(ATTACH.head, 0, 0.27, 0), box(ATTACH.leftArm, 0, -0.3, 0)]);
    people.setOutfits([null, three, EVERY_PART]);
    const s = createHumanoidSource(8);
    add(s, 0, -4, { outfit: 1 });
    add(s, 2, -4, { outfit: 2 });
    add(s, 4, -4); // no outfit
    add(s, 6, -4, { outfit: 1 });
    people.update(1, [s], 0, 0, 100);
    const gear = mesh(scene, 'people-gear');
    expect(gear.count).toBe(3 + 9 + 3);
    expect(gear.visible).toBe(true);
    expect(people.stats.gearBoxes).toBe(15);
    expect(people.stats.figures).toBe(4);
    expect(gear.frustumCulled).toBe(false);
    // 5 meshes of the figures plus the gear mesh.
    expect(people.stats.drawCalls).toBe(6);
  });

  it('draws no gear for figures without an outfit, with outfit 0, or before setOutfits', () => {
    const { scene, people } = setup();
    const s = createHumanoidSource(4);
    add(s, 0, -3);
    add(s, 2, -3, { outfit: 1 }); // no table yet
    people.update(1, [s], 0, 0, 100);
    expect(mesh(scene, 'people-gear').count).toBe(0);
    expect(mesh(scene, 'people-gear').visible).toBe(false);
    expect(people.stats.drawCalls).toBe(5);

    people.setOutfits([null, EVERY_PART]);
    s.outfit[1] = 0;
    people.update(1, [s], 0, 0, 100);
    expect(mesh(scene, 'people-gear').count).toBe(0);
    // An index past the table is also nothing.
    s.outfit[1] = 7;
    people.update(1, [s], 0, 0, 100);
    expect(mesh(scene, 'people-gear').count).toBe(0);
    // Hidden figures and figures out of range draw no gear either.
    s.outfit[1] = 1;
    s.flags[1] = FIGURE_FLAG.hidden;
    people.update(1, [s], 0, 0, 100);
    expect(mesh(scene, 'people-gear').count).toBe(0);
    s.flags[1] = 0;
    s.x[1] = s.prevX[1] = 500;
    people.update(1, [s], 0, 0, 100);
    expect(mesh(scene, 'people-gear').count).toBe(0);
  });

  it('clears the gear when an outfit table is replaced', () => {
    const { scene, people } = setup();
    const s = createHumanoidSource(2);
    add(s, 0, -3, { outfit: 1 });
    people.setOutfits([null, EVERY_PART]);
    people.update(1, [s], 0, 0, 100);
    expect(mesh(scene, 'people-gear').count).toBe(9);
    people.setOutfits([null, outfit([box(ATTACH.head, 0, 0.27, 0)])]);
    people.update(1, [s], 0, 0, 100);
    expect(mesh(scene, 'people-gear').count).toBe(1);
    people.setOutfits([]);
    people.update(1, [s], 0, 0, 100);
    expect(mesh(scene, 'people-gear').count).toBe(0);
  });

  it('stops cleanly at the gear capacity: a figure whose outfit no longer fits is drawn without it', () => {
    const { scene, people } = setup({ gearCapacity: 7 });
    people.setOutfits([null, outfit([box(ATTACH.torso, 0, 0.3, 0), box(ATTACH.head, 0, 0.2, 0), box(ATTACH.pelvis, 0, 0, 0)]), EVERY_PART]);
    const s = createHumanoidSource(8);
    for (let i = 0; i < 4; i++) add(s, i * 2, -3, { outfit: 1 });
    people.update(1, [s], 0, 0, 100);
    const gear = mesh(scene, 'people-gear');
    expect(gear.count).toBe(6); // two figures of 3; the third would need 9 > 7
    expect(people.stats.figures).toBe(4);
    expect(mesh(scene, 'people-torso').count).toBe(4);
    for (let k = 0; k < gear.count * 16; k++) expect(Number.isFinite(gear.instanceMatrix.array[k] ?? NaN)).toBe(true);
    // An outfit larger than the whole capacity is never drawn, and nothing throws.
    s.outfit.fill(2);
    expect(() => people.update(1, [s], 0, 0, 100)).not.toThrow();
    expect(gear.count).toBe(0);
    expect(people.stats.gearBoxes).toBe(0);
  });

  it('defaults to a 2048 box capacity', () => {
    const { scene } = setup();
    expect(mesh(scene, 'people-gear').instanceMatrix.count).toBe(2048);
  });

  it('puts a head accessory in the head frame so it follows the head pitch', () => {
    const { scene, people } = setup();
    const hat = box(ATTACH.head, 0, 0.27, 0.01, 0.24, 0.07, 0.25, 0x223344);
    people.setOutfits([null, outfit([hat])]);
    const s = createHumanoidSource(4);
    add(s, 0, -4, { outfit: 1, pose: POSE.stand });
    add(s, 5, -4, { outfit: 1, pose: POSE.prone });
    people.update(1, [s], 0, 0, 100);
    const head = mesh(scene, 'people-head');
    const torso = mesh(scene, 'people-torso');
    const gear = mesh(scene, 'people-gear');
    for (let f = 0; f < 2; f++) {
      // The hat centre is the head matrix applied to the box centre: neck + R_head (x w, y s, z w).
      const expected = new THREE.Vector3(hat.x, hat.y, hat.z).applyMatrix4(matrix(head, f));
      expect(at(gear, f).distanceTo(expected), `figure ${f}`).toBeLessThan(1e-5);
    }
    // Standing: the hat is straight above the neck. Prone: the head pitches by 0.6 rad relative to the torso.
    const neck = (f: number): THREE.Vector3 => at(head, f);
    const up = (m: THREE.InstancedMesh, f: number): THREE.Vector3 => new THREE.Vector3(0, 1, 0).transformDirection(matrix(m, f));
    expect(up(head, 0).angleTo(up(torso, 0))).toBeCloseTo(0, 5);
    expect(up(head, 1).angleTo(up(torso, 1))).toBeCloseTo(0.6, 5);
    // The hat's offset from the neck is mostly along the head's up axis (the 0.01 m back offset tilts it a little).
    const off = at(gear, 1).sub(neck(1));
    expect(off.angleTo(up(head, 1))).toBeLessThan(0.05);
    expect(off.angleTo(up(torso, 1))).toBeGreaterThan(0.5);
    // The hat is scaled by the head box size at the figure scale.
    const sc = scaleOf(gear, 0);
    expect([sc.x, sc.y, sc.z].map((v) => Number(v.toFixed(5)))).toEqual([0.24, 0.07, 0.25]);
  });

  it('attaches boxes to the torso, arms and legs frames of their parts', () => {
    const { scene, people } = setup();
    const defs = outfit([
      box(ATTACH.torso, 0.05, 0.3, -0.15),
      box(ATTACH.leftArm, 0, -0.28, 0),
      box(ATTACH.rightArm, 0, -0.28, 0),
      box(ATTACH.leftThigh, 0, -0.2, 0),
      box(ATTACH.rightThigh, 0, -0.2, 0),
      box(ATTACH.leftShin, 0, -0.2, 0),
      box(ATTACH.rightShin, 0, -0.2, 0),
    ]);
    people.setOutfits([null, defs]);
    const s = createHumanoidSource(2);
    const f = add(s, 3, -4, { outfit: 1, pose: POSE.walk, yaw: 0.7 });
    s.speed[f] = 1.5;
    s.gait[f] = 0.3;
    s.height[f] = 1.9;
    s.build[f] = 1.1;
    people.update(1, [s], 3, -4, 100);
    const gear = mesh(scene, 'people-gear');
    expect(gear.count).toBe(7);
    // Emission order inside a figure: torso, then (head), arms, then legs (thigh, shin per side).
    const frames: [THREE.InstancedMesh, number, AccessoryBox][] = [
      [mesh(scene, 'people-torso'), 0, defs.boxes[0] as AccessoryBox],
      [mesh(scene, 'people-arms'), 0, defs.boxes[1] as AccessoryBox],
      [mesh(scene, 'people-arms'), 1, defs.boxes[2] as AccessoryBox],
      [mesh(scene, 'people-legs'), 0, defs.boxes[3] as AccessoryBox],
      [mesh(scene, 'people-legs'), 1, defs.boxes[5] as AccessoryBox],
      [mesh(scene, 'people-legs'), 2, defs.boxes[4] as AccessoryBox],
      [mesh(scene, 'people-legs'), 3, defs.boxes[6] as AccessoryBox],
    ];
    const expected = frames.map(([m, i, b]) => new THREE.Vector3(b.x, b.y, b.z).applyMatrix4(matrix(m, i)));
    const actual = Array.from({ length: 7 }, (_, i) => at(gear, i));
    const key = (v: THREE.Vector3): string => v.toArray().map((n) => n.toFixed(4)).join(',');
    expect(actual.map(key).sort()).toEqual(expected.map(key).sort());
  });

  it('keeps the pelvis frame upright while the torso bends', () => {
    const { scene, people } = setup();
    const belt = box(ATTACH.pelvis, 0, 0.02, 0, 0.44, 0.07, 0.26, 0x15161a);
    people.setOutfits([null, outfit([belt])]);
    const s = createHumanoidSource(2);
    add(s, 0, -4, { outfit: 1 });
    people.update(1, [s], 0, 0, 100);
    const gear = mesh(scene, 'people-gear');
    expect(at(gear, 0).y).toBeCloseTo(0.85 + 0.02, 5); // height 1.75: scale 1
    expect(at(gear, 0).x).toBeCloseTo(0, 5);
    const size = scaleOf(gear, 0);
    expect(size.x).toBeCloseTo(0.44, 5);
    expect(size.z).toBeCloseTo(0.26, 5);
  });

  it('scales box sizes and offsets by the figure height and build', () => {
    const { scene, people } = setup();
    const b = box(ATTACH.torso, 0.1, 0.2, -0.12, 0.08, 0.1, 0.04);
    people.setOutfits([null, outfit([b])]);
    const s = createHumanoidSource(2);
    const f = add(s, 0, -4, { outfit: 1 });
    s.height[f] = 1.4; // scale 0.8
    s.build[f] = 1.25; // width 1.0
    people.update(1, [s], 0, 0, 100);
    const gear = mesh(scene, 'people-gear');
    const sc = scaleOf(gear, 0);
    expect(sc.x).toBeCloseTo(0.08 * 1.0, 5);
    expect(sc.y).toBeCloseTo(0.1 * 0.8, 5);
    expect(sc.z).toBeCloseTo(0.04 * 1.0, 5);
    const p = at(gear, 0);
    const torso = at(mesh(scene, 'people-torso'), 0);
    expect(p.x - torso.x).toBeCloseTo(0.1 * 1.0, 5);
    expect(p.y - torso.y).toBeCloseTo(0.2 * 0.8, 5);
    expect(p.z - torso.z).toBeCloseTo(-0.12 * 1.0, 5);
  });

  it('colours each box and lightens the gear of highlighted figures like the body', () => {
    const { scene, people } = setup();
    people.setOutfits([null, outfit([box(ATTACH.torso, 0, 0.3, 0, 0.1, 0.1, 0.1, 0x336699), box(ATTACH.head, 0, 0.2, 0, 0.1, 0.1, 0.1, 0xcc2200)])]);
    const s = createHumanoidSource(3);
    add(s, 0, -4, { outfit: 1 });
    add(s, 3, -4, { outfit: 1 });
    s.flags[1] = FIGURE_FLAG.highlight;
    people.update(1, [s], 0, 0, 100);
    const gear = mesh(scene, 'people-gear');
    // Per figure: torso box first, then the head box.
    expect(colorOf(gear, 0).getHex()).toBe(0x336699);
    expect(colorOf(gear, 1).getHex()).toBe(0xcc2200);
    expect(colorOf(gear, 2).g).toBeGreaterThan(linear(0x336699).g);
    expect(colorOf(gear, 2).r).toBeGreaterThan(linear(0x336699).r);
  });

  it('works with the uniform module outfits (all 24 boxes of a full kit)', () => {
    const { scene, people } = setup();
    const kit = buildOutfit(defaultOutfitSpec('classA'), { lastName: 'Rivera', rank: 'sergeant' });
    expect(kit.boxes.length).toBeGreaterThan(5);
    people.setOutfits([null, kit]);
    const s = createHumanoidSource(2);
    add(s, 0, -3, { outfit: 1 });
    people.update(1, [s], 0, 0, 100);
    expect(mesh(scene, 'people-gear').count).toBe(kit.boxes.length);
    const gear = mesh(scene, 'people-gear');
    for (let k = 0; k < gear.count * 16; k++) expect(Number.isFinite(gear.instanceMatrix.array[k] ?? NaN)).toBe(true);
  });
});

describe('PeopleRenderer outfit effects on the figure', () => {
  it('hides the hair mesh instance when the outfit hides hair (helmets) and keeps it otherwise', () => {
    const { scene, people } = setup();
    people.setOutfits([null, outfit([box(ATTACH.head, 0, 0.2, 0, 0.28, 0.22, 0.29)], { hideHair: true }), outfit([box(ATTACH.head, 0, 0.265, 0)])]);
    const s = createHumanoidSource(4);
    add(s, 0, -4, { outfit: 1 });
    add(s, 3, -4, { outfit: 2 });
    add(s, 6, -4);
    people.update(1, [s], 0, 0, 100);
    const hair = mesh(scene, 'people-hair');
    expect(hair.count).toBe(3);
    expect(scaleOf(hair, 0).length()).toBe(0);
    expect(scaleOf(hair, 1).y).toBeGreaterThan(0.5);
    expect(scaleOf(hair, 2).y).toBeGreaterThan(0.5);
    // The hidden hair keeps the head position so it can come back.
    expect(at(hair, 0).distanceTo(at(mesh(scene, 'people-head'), 0))).toBeLessThan(1e-5);
  });

  it('colours the shins from the outfit when it has one, and from the source override', () => {
    const { scene, people } = setup();
    people.setOutfits([null, outfit([]), outfit([], { shins: SKIN_SHINS }), outfit([], { shins: 0x1c1f24 })]);
    const s = createHumanoidSource(6);
    add(s, 0, -4); // plain: shins = bottom
    add(s, 2, -4, { outfit: 1 }); // outfit, shins null = bottom
    add(s, 4, -4, { outfit: 2 }); // bare shins = skin
    add(s, 6, -4, { outfit: 3 }); // boots
    const over = add(s, 8, -4, { outfit: 1 });
    s.shins[over] = 0xaa00aa; // override
    const ignored = add(s, 10, -4);
    s.shins[ignored] = 0x00ff00; // no outfit: ignored
    people.update(1, [s], 0, 0, 100);
    const legs = mesh(scene, 'people-legs');
    const shin = (fig: number, side: number): THREE.Color => colorOf(legs, fig * 4 + side * 2 + 1);
    const thigh = (fig: number): THREE.Color => colorOf(legs, fig * 4);
    for (const side of [0, 1]) {
      expect(shin(0, side).getHex()).toBe(BOTTOM);
      expect(shin(1, side).getHex()).toBe(BOTTOM);
      expect(shin(2, side).getHex()).toBe(SKIN);
      expect(shin(3, side).getHex()).toBe(0x1c1f24);
      expect(shin(4, side).getHex()).toBe(0xaa00aa);
      expect(shin(5, side).getHex()).toBe(BOTTOM);
    }
    // Thighs always keep the trouser colour.
    for (let f = 0; f < 6; f++) expect(thigh(f).getHex()).toBe(BOTTOM);
  });

  it('widens the arm offset and the torso with the shoulders slider, and the legs with the hips slider', () => {
    const { scene, people } = setup();
    const s = createHumanoidSource(4);
    add(s, 0, -4);
    add(s, 3, -4);
    s.shoulders[1] = 1.3;
    s.hips[1] = 1.4;
    add(s, 6, -4);
    s.shoulders[2] = 0; // not positive: reads as 1
    s.hips[2] = -2;
    people.update(1, [s], 0, 0, 100);
    const arms = mesh(scene, 'people-arms');
    const legs = mesh(scene, 'people-legs');
    const torso = mesh(scene, 'people-torso');
    const armSpan = (f: number): number => at(arms, f * 2 + 1).x - at(arms, f * 2).x;
    const legSpan = (f: number): number => at(legs, f * 4 + 2).x - at(legs, f * 4).x;
    expect(armSpan(0)).toBeCloseTo(2 * 0.265, 5);
    expect(armSpan(1)).toBeCloseTo(2 * 0.265 * 1.3, 5);
    expect(legSpan(0)).toBeCloseTo(2 * 0.09, 5);
    expect(legSpan(1)).toBeCloseTo(2 * 0.09 * 1.4, 5);
    expect(armSpan(2)).toBeCloseTo(armSpan(0), 6);
    expect(legSpan(2)).toBeCloseTo(legSpan(0), 6);
    // Body parts widen in x only.
    expect(scaleOf(torso, 1).x / scaleOf(torso, 0).x).toBeCloseTo(1.3, 5);
    expect(scaleOf(torso, 1).z).toBeCloseTo(scaleOf(torso, 0).z, 6);
    expect(scaleOf(arms, 2).x / scaleOf(arms, 0).x).toBeCloseTo(1.3, 5);
    expect(scaleOf(legs, 4).x / scaleOf(legs, 0).x).toBeCloseTo(1.4, 5);
    expect(scaleOf(legs, 5).x / scaleOf(legs, 1).x).toBeCloseTo(1.4, 5);
    expect(scaleOf(legs, 4).z).toBeCloseTo(scaleOf(legs, 0).z, 6);
    // The head does not change.
    expect(scaleOf(mesh(scene, 'people-head'), 1).x).toBeCloseTo(scaleOf(mesh(scene, 'people-head'), 0).x, 6);
  });

  it('moves torso and arm accessories out with the shoulders slider and pelvis and leg ones with the hips slider', () => {
    const { scene, people } = setup();
    people.setOutfits([null, outfit([box(ATTACH.torso, 0.1, 0.3, 0), box(ATTACH.pelvis, 0.2, 0, 0), box(ATTACH.leftArm, 0.01, -0.3, 0)])]);
    const s = createHumanoidSource(2);
    add(s, 0, -4, { outfit: 1 });
    add(s, 0, -8, { outfit: 1 });
    s.shoulders[1] = 1.4;
    s.hips[1] = 1.4;
    people.update(1, [s], 0, 0, 100);
    const gear = mesh(scene, 'people-gear');
    // Per figure: torso, pelvis, left arm.
    expect(at(gear, 3).x / at(gear, 0).x).toBeCloseTo(1.4, 5);
    expect(at(gear, 4).x / at(gear, 1).x).toBeCloseTo(1.4, 5);
    expect(scaleOf(gear, 3).x / scaleOf(gear, 0).x).toBeCloseTo(1.4, 5);
  });

  it('uses at most 8 draw calls with every mesh in use, gear included', () => {
    const { scene, people } = setup();
    people.setOutfits([null, EVERY_PART]);
    const s = createHumanoidSource(4);
    add(s, 0, -3, { outfit: 1 });
    s.held[0] = HELD.handgun;
    add(s, 2, -3);
    s.body[1] = BODY.dog;
    people.update(1, [s], 0, 0, 100);
    expect(people.stats.drawCalls).toBe(8);
    let meshes = 0;
    scene.traverse((o) => {
      if (o instanceof THREE.InstancedMesh) meshes++;
    });
    expect(meshes).toBe(8);
  });

  it('draws anchored figures (vehicle occupants) without NaN with an outfit', () => {
    const { scene, people } = setup();
    people.setOutfits([null, EVERY_PART]);
    const s = createHumanoidSource(2);
    add(s, 0.4, 0.2, { outfit: 1, pose: POSE.seated });
    people.update(1, [s], 0, 0, 100);
    const gear = mesh(scene, 'people-gear');
    expect(gear.count).toBe(9);
    for (let k = 0; k < gear.count * 16; k++) expect(Number.isFinite(gear.instanceMatrix.array[k] ?? NaN)).toBe(true);
  });
});

/** The Node pieces the allocation test needs (the project has no Node type definitions). */
declare const process: { memoryUsage(): { heapUsed: number } };
async function loadGc(): Promise<() => void> {
  const names = { v8: 'node:v8', vm: 'node:vm' };
  const v8 = (await import(/* @vite-ignore */ names.v8)) as { setFlagsFromString(flags: string): void };
  const vm = (await import(/* @vite-ignore */ names.vm)) as { runInNewContext(code: string): unknown };
  v8.setFlagsFromString('--expose-gc');
  return vm.runInNewContext('gc') as () => void;
}

describe('PeopleRenderer outfit performance', () => {
  it('does not allocate per dressed figure in update', async () => {
    const gc = await loadGc();
    const kit = buildOutfit(defaultOutfitSpec('classA'), { lastName: 'Rivera', rank: 'sergeant' });
    const garbage = (n: number): number => {
      const { people } = setup({ capacity: 320, gearCapacity: 8000 });
      people.setOutfits([null, kit]);
      const s = createHumanoidSource(n);
      for (let i = 0; i < n; i++) {
        const f = add(s, (i % 20) * 3 - 30, -Math.floor(i / 20) * 3 - 5, { outfit: 1, pose: i % 5 === 0 ? POSE.walk : POSE.stand });
        s.speed[f] = 1.4;
        s.gait[f] = (i % 10) / 10;
        s.shoulders[f] = 1.1;
        s.hips[f] = 0.9;
      }
      for (let i = 0; i < 300; i++) people.update(0.5, [s], 0, 0, 150);
      let worst = 0;
      for (let k = 0; k < 8; k++) {
        gc();
        const before = process.memoryUsage().heapUsed;
        for (let i = 0; i < 100; i++) people.update((i % 10) / 10, [s], 0, 0, 150);
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

  it('updates 300 dressed figures inside the frame budget', () => {
    const { people } = setup({ capacity: 320, gearCapacity: 8000 });
    const kit = buildOutfit(defaultOutfitSpec('classA'), { lastName: 'Rivera', rank: 'sergeant' });
    people.setOutfits([null, kit]);
    const s = createHumanoidSource(300);
    for (let i = 0; i < 300; i++) {
      const f = add(s, (i % 20) * 3 - 30, -Math.floor(i / 20) * 3 - 5, { outfit: 1, pose: i % 5 === 0 ? POSE.walk : POSE.stand });
      s.speed[f] = 1.4;
      s.gait[f] = (i % 10) / 10;
    }
    for (let i = 0; i < 100; i++) people.update(0.5, [s], 0, 0, 150);
    const start = performance.now();
    for (let i = 0; i < 200; i++) people.update((i % 10) / 10, [s], 0, 0, 150);
    expect((performance.now() - start) / 200).toBeLessThan(4);
    expect(people.stats.gearBoxes).toBe(300 * kit.boxes.length);
  });
});
