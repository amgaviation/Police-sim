import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import { SWAT_CONFIG } from '../../src/backup/data';
import { clearOrder, entryDoor, swatContactOdds } from '../../src/backup/swat';
import type { SwatPlan } from '../../src/backup/types';
import { generateInterior } from '../../src/interior/generate';
import type { InteriorLayout } from '../../src/interior/types';
import { INTERIOR_FLOOR_Y } from '../../src/interior/constants';
import { roomAt } from '../../src/interior/nav';
import { ACTOR_STATE } from '../../src/npc/types';
import { cityBuildings, indexFor, SEED as CITY_SEED } from '../interior/helpers';
import { box, door, layoutOf, room } from '../tactical/helpers';
import { Rig } from './helpers';

const cfg = SWAT_CONFIG;
const plan = (over: Partial<SwatPlan> = {}): SwatPlan => ({ entry: 'front', tempo: 'deliberate', lessLethal: false, ...over });
const calm = { armed: false, hostage: false, negotiationTrust: 0 };

describe('swatContactOdds', () => {
  it('computes the contract numbers', () => {
    expect(swatContactOdds(plan(), calm, cfg)).toEqual({ surrender: 0.55, hostageInjury: 0, subjectInjury: 0 });
    expect(swatContactOdds(plan(), { ...calm, negotiationTrust: 1 }, cfg).surrender).toBeCloseTo(0.9, 12);
    expect(swatContactOdds(plan(), { ...calm, negotiationTrust: 0.5 }, cfg).surrender).toBeCloseTo(0.725, 12);
    expect(swatContactOdds(plan({ tempo: 'dynamic' }), calm, cfg).surrender).toBeCloseTo(0.7, 12);
    expect(swatContactOdds(plan({ lessLethal: true }), calm, cfg).surrender).toBeCloseTo(0.65, 12);
    expect(swatContactOdds(plan(), { ...calm, armed: true }, cfg).surrender).toBeCloseTo(0.4, 12);
    expect(swatContactOdds(plan(), { ...calm, hostage: true }, cfg).surrender).toBeCloseTo(0.4, 12);
    expect(swatContactOdds(plan(), { armed: true, hostage: true, negotiationTrust: 0 }, cfg).surrender).toBeCloseTo(0.25, 12);
  });

  it('clamps the surrender chance to 0.05..0.95', () => {
    expect(swatContactOdds(plan({ tempo: 'dynamic', lessLethal: true }), { ...calm, negotiationTrust: 1 }, cfg).surrender).toBe(0.95);
    const low = { ...cfg, contact: { ...cfg.contact, surrenderBase: 0, negotiationTrust: 0 } };
    expect(swatContactOdds(plan(), { armed: true, hostage: true, negotiationTrust: 0 }, low).surrender).toBe(0.05);
  });

  it('computes the injury chances', () => {
    expect(swatContactOdds(plan(), { ...calm, hostage: true }, cfg).hostageInjury).toBeCloseTo(0.1, 12);
    expect(swatContactOdds(plan({ tempo: 'dynamic' }), { ...calm, hostage: true }, cfg).hostageInjury).toBeCloseTo(0.2, 12);
    expect(swatContactOdds(plan({ tempo: 'dynamic' }), calm, cfg).hostageInjury).toBe(0);
    expect(swatContactOdds(plan({ lessLethal: true }), calm, cfg).subjectInjury).toBeCloseTo(0.3, 12);
    expect(swatContactOdds(plan({ lessLethal: false }), calm, cfg).subjectInjury).toBe(0);
  });
});

const index = indexFor();
const houseInfo = cityBuildings(index, 3).find((b) => b.kind === 'house')!;
const warehouseInfo = cityBuildings(index, 3).find((b) => b.kind === 'warehouse' && generateInterior(CITY_SEED, b)!.doors.some((d) => d.kind === 'wide'))!;
const house = generateInterior(CITY_SEED, houseInfo)!;

/** Rooms reachable from `start` through any interior door (independent of the module). */
function reachable(l: InteriorLayout, start: number): Set<number> {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const r = queue.shift()!;
    for (const d of l.doors) {
      if (d.b < 0) continue;
      const other = d.a === r ? d.b : d.b === r ? d.a : -1;
      if (other >= 0 && !seen.has(other)) {
        seen.add(other);
        queue.push(other);
      }
    }
  }
  return seen;
}

describe('clearOrder', () => {
  it('lists every connected room once, entry room first, each next to an earlier one', () => {
    for (const info of cityBuildings(index, 6)) {
      const l = generateInterior(CITY_SEED, info)!;
      const main = l.doors.find((d) => d.main)!;
      const order = clearOrder(l, main.a);
      expect(order[0]).toBe(main.a);
      expect(new Set(order).size).toBe(order.length);
      expect(new Set(order)).toEqual(reachable(l, main.a));
      for (let i = 1; i < order.length; i++) {
        const r = order[i]!;
        const earlier = new Set(order.slice(0, i));
        expect(l.doors.some((d) => d.b >= 0 && ((d.a === r && earlier.has(d.b)) || (d.b === r && earlier.has(d.a))))).toBe(true);
      }
    }
  });

  it('includes the rooms behind locked doors (the team breaches them)', () => {
    const locked = house.doors.filter((d) => d.b >= 0 && d.lockedAtStart);
    const main = house.doors.find((d) => d.main)!;
    const order = clearOrder(house, main.a);
    expect(order.length).toBe(house.rooms.length);
    for (const d of locked) {
      expect(order).toContain(d.a);
      expect(order).toContain(d.b);
    }
  });

  it('follows the BFS tie order (lower door index first) on a hand-made layout', () => {
    const rect = { minX: 0, minZ: 0, maxX: 10, maxZ: 10 };
    const l = layoutOf(
      rect,
      [room(0, 'hallway', { minX: 0, minZ: 0, maxX: 10, maxZ: 2 }), room(1, 'living', { minX: 0, minZ: 2, maxX: 5, maxZ: 6 }), room(2, 'kitchen', { minX: 5, minZ: 2, maxX: 10, maxZ: 6 }), room(3, 'bedroom', { minX: 0, minZ: 6, maxX: 10, maxZ: 10 })],
      [door(0, 0, 1, 2, 2, 'x'), door(1, 0, 2, 7, 2, 'x'), door(2, 1, 3, 2, 6, 'x', { lockable: true, lockedAtStart: true }), door(3, 0, -1, 5, 0, 'x', { main: true })],
      [],
    );
    expect(clearOrder(l, 0)).toEqual([0, 1, 2, 3]);
    expect(clearOrder(l, 3)).toEqual([3, 1, 0, 2]);
    expect(clearOrder(l, -1)).toEqual([]);
    expect(clearOrder(l, 9)).toEqual([]);
  });
});

describe('entryDoor', () => {
  it('front is the main door; rear the exterior door farthest from it', () => {
    const rect = { minX: 0, minZ: 0, maxX: 10, maxZ: 10 };
    const l = layoutOf(
      rect,
      [room(0, 'living', { minX: 0, minZ: 0, maxX: 5, maxZ: 10 }), room(1, 'kitchen', { minX: 5, minZ: 0, maxX: 10, maxZ: 10 })],
      [door(0, 0, 1, 5, 5, 'z'), door(1, 0, -1, 2.5, 0, 'x', { main: true }), door(2, 1, -1, 7.5, 10, 'x'), door(3, 1, -1, 10, 5, 'z')],
      [],
      [box(0, 0, 1, 1, 2, 2, 1)],
    );
    expect(entryDoor(l, 'front', 2.5, -0.6)).toBe(1);
    expect(entryDoor(l, 'rear', 2.5, -0.6)).toBe(2);
  });

  it('falls back to the nearest exterior door without a main door, and to the front when there is only one', () => {
    const rect = { minX: 0, minZ: 0, maxX: 10, maxZ: 10 };
    const l = layoutOf(
      rect,
      [room(0, 'living', { minX: 0, minZ: 0, maxX: 5, maxZ: 10 }), room(1, 'kitchen', { minX: 5, minZ: 0, maxX: 10, maxZ: 10 })],
      [door(0, 0, 1, 5, 5, 'z'), door(1, 0, -1, 2.5, 0, 'x'), door(2, 1, -1, 7.5, 10, 'x')],
      [],
    );
    expect(entryDoor(l, 'front', 9, 12)).toBe(2);
    expect(entryDoor(l, 'front', 0, -1)).toBe(1);
    const single = layoutOf(rect, [room(0, 'living', rect)], [door(0, 0, -1, 5, 0, 'x', { main: true })], []);
    expect(entryDoor(single, 'front', 5, -1)).toBe(0);
    expect(entryDoor(single, 'rear', 5, -1)).toBe(0);
    const none = layoutOf(rect, [room(0, 'living', { minX: 0, minZ: 0, maxX: 5, maxZ: 10 }), room(1, 'bedroom', { minX: 5, minZ: 0, maxX: 10, maxZ: 10 })], [door(0, 0, 1, 5, 5, 'z')], []);
    expect(entryDoor(none, 'front', 0, 0)).toBe(-1);
    expect(entryDoor(none, 'rear', 0, 0)).toBe(-1);
  });

  it('on generated buildings: front is the main door; a loading dock is the rear', () => {
    const main = house.doors.find((d) => d.main)!;
    expect(entryDoor(house, 'front', houseInfo.door.x, houseInfo.door.z)).toBe(main.index);
    expect(entryDoor(house, 'rear', houseInfo.door.x, houseInfo.door.z)).toBe(main.index);
    const w = generateInterior(CITY_SEED, warehouseInfo)!;
    const front = entryDoor(w, 'front', warehouseInfo.door.x, warehouseInfo.door.z);
    const rear = entryDoor(w, 'rear', warehouseInfo.door.x, warehouseInfo.door.z);
    expect(w.doors[front]!.main).toBe(true);
    expect(rear).not.toBe(front);
    expect(w.doors[rear]!.b).toBe(-1);
  });
});

// --- Runtime ---------------------------------------------------------------------------------------------------

/** First seed whose first two backup-stream draws satisfy the predicates. */
function seedWith(first: (u: number) => boolean, second: (u: number) => boolean = () => true): number {
  for (let s = 1; s < 5000; s++) {
    const r = createRng(s).stream('backup');
    if (first(r.next()) && second(r.next())) return s;
  }
  throw new Error('no seed');
}

interface SwatRig {
  rig: Rig;
  callId: number;
  order: number[];
  entry: number;
  subjectRoom: number;
}

function swatRig(seed: number, opts: { hostage?: boolean; subject?: boolean } = {}): SwatRig {
  const rig = new Rig({ seed });
  const callId = rig.openCall();
  const info = houseInfo;
  rig.buildings.set(info.id, { minX: info.minX, minZ: info.minZ, maxX: info.maxX, maxZ: info.maxZ, door: info.door });
  rig.interiors.layouts.set(info.id, house);
  rig.callBuildingId = info.id;
  rig.swatCount = 1;
  rig.ctx.x = info.door.x;
  rig.ctx.z = info.door.z;
  rig.ctx.yaw = info.door.yaw;
  const out = { x: -Math.sin(info.door.yaw), z: -Math.cos(info.door.yaw) };
  rig.unitOnScene('TAC-1', info.door.x + out.x * 22, info.door.z + out.z * 22, info.door.yaw, 'resource');
  const main = house.doors.find((d) => d.main)!;
  const order = clearOrder(house, main.a);
  const subjectRoom = order[order.length - 1]!;
  const r = house.rooms[subjectRoom]!.rect;
  if (opts.subject !== false) {
    rig.npc.add({ id: 7, personId: 555, role: 'subject', building: info.id, callId, x: (r.minX + r.maxX) / 2, z: (r.minZ + r.maxZ) / 2, state: ACTOR_STATE.armed, weaponDrawn: true });
  }
  if (opts.hostage) {
    const hr = house.rooms[order[1]!]!.rect;
    rig.npc.add({ id: 8, personId: 556, role: 'hostage', building: info.id, callId, x: (hr.minX + hr.maxX) / 2, z: (hr.minZ + hr.maxZ) / 2, state: ACTOR_STATE.hold });
  }
  return { rig, callId, order, entry: main.index, subjectRoom };
}

interface Swat { phase: string; text: string; callId: number }
const texts = (rig: Rig): string[] => rig.of<Swat>('backup:swat').map((e) => e.text);
const send = (s: SwatRig, command: 'stage' | 'stack' | 'breach' | 'clear' | 'hold' | 'withdraw', p?: Partial<SwatPlan>): void =>
  s.rig.sys.request(p === undefined ? { kind: 'swat', callId: s.callId, command } : { kind: 'swat', callId: s.callId, command, plan: p });
const phase = (s: SwatRig): string | null => s.rig.sys.swatPhase(s.callId);

describe('SWAT team runtime', () => {
  it('arrives staged 30 m from the door on the truck side, four operators in the view', () => {
    const s = swatRig(1);
    expect(phase(s)).toBe('enRoute');
    s.rig.step(1);
    expect(phase(s)).toBe('staging');
    expect(s.rig.sys.view.count).toBe(8 + 4);
    s.rig.step(60 * 20);
    const base = 8;
    const door = houseInfo.door;
    for (let i = 0; i < 4; i++) {
      const d = Math.hypot(s.rig.sys.view.x[base + i]! - door.x, s.rig.sys.view.z[base + i]! - door.z);
      expect(d).toBeGreaterThan(28);
      expect(d).toBeLessThan(32);
      expect(s.rig.sys.view.flags[base + i]).toBe(0);
      expect(s.rig.sys.view.top[base + i]).toBe(cfg.colors.top);
      expect(s.rig.sys.view.held[base + i]).toBe(2);
    }
    // staging side = the truck's side of the door
    const truck = s.rig.cars.get('TAC-1')!;
    const cx = (s.rig.sys.view.x[base]! + s.rig.sys.view.x[base + 3]!) / 2 - door.x;
    const cz = (s.rig.sys.view.z[base]! + s.rig.sys.view.z[base + 3]!) / 2 - door.z;
    expect(cx * (truck.x - door.x) + cz * (truck.z - door.z)).toBeGreaterThan(0);
  });

  it('refuses commands that make no sense and answers on the tactical channel as TAC-1', () => {
    const s = swatRig(1);
    s.rig.step(1);
    send(s, 'breach');
    send(s, 'clear');
    send(s, 'hold');
    s.rig.step(2);
    const t = texts(s.rig);
    expect(t[0]).toBe('Not stacked on a door yet.');
    expect(t[1]).toBe('Not stacked on a door yet.');
    expect(t[2]).toBe('Holding position.');
    const radio = s.rig.of<{ channel: string; speaker: string; text: string }>('backup:radio');
    expect(radio.length).toBe(t.length);
    expect(radio.every((r) => r.channel === 'tac' && r.speaker === 'TAC-1')).toBe(true);
    // wrong call
    s.rig.sys.request({ kind: 'swat', callId: 999, command: 'stack' });
    s.rig.step(2);
    expect(texts(s.rig).at(-1)).toBe('No SWAT team on scene.');
    // the port: queued only with a team
    expect(s.rig.sys.swat(s.callId, 'stack')).toMatch(/acknowledged/);
    expect(s.rig.sys.swat(12345, 'stack')).toBe('No SWAT team on this call.');
  });

  it('stacks beside the door, breaches (door request seen), clears every room and reports a surrendering subject in custody', () => {
    const seed = seedWith((u) => u < 0.5);
    const s = swatRig(seed);
    const { rig } = s;
    rig.step(1);
    send(s, 'stack', { tempo: 'dynamic' });
    expect(rig.until(() => phase(s) === 'stacked', 80)).toBe(true);
    expect(texts(rig)).toContain('Team is stacked on the door.');
    // operators stand in a line along the wall, next to the door, outside
    const d = house.doors[s.entry]!;
    const base = 8;
    rig.step(60 * 3);
    for (let i = 0; i < 4; i++) {
      expect(rig.sys.view.y[base + i]).toBe(0);
      // outside the footprint, within a couple of metres of the door frame
      const dd = Math.hypot(rig.sys.view.x[base + i]! - d.x, rig.sys.view.z[base + i]! - d.z);
      expect(dd).toBeGreaterThan(d.width / 2 + cfg.stackOffsetM * (i + 1) - 0.1);
      expect(dd).toBeLessThan(d.width / 2 + cfg.stackOffsetM * (i + 1) + 3);
    }
    for (let i = 1; i < 4; i++) {
      const gap = Math.hypot(rig.sys.view.x[base + i]! - rig.sys.view.x[base + i - 1]!, rig.sys.view.z[base + i]! - rig.sys.view.z[base + i - 1]!);
      expect(gap).toBeCloseTo(cfg.stackOffsetM, 1);
    }

    expect(rig.doorRequests.length).toBe(0);
    send(s, 'breach');
    rig.step(2);
    expect(phase(s)).toBe('breaching');
    expect(rig.doorRequests).toEqual([{ building: houseInfo.id, door: s.entry, action: 'open' }]);
    expect(rig.until(() => phase(s) === 'clearing', cfg.breachS + 1)).toBe(true);
    // inside, on the interior level
    for (let i = 0; i < 4; i++) expect(rig.sys.view.y[base + i]).toBe(INTERIOR_FLOOR_Y);
    expect(rig.sys.view.pose[base]).toBe(8);

    expect(rig.until(() => phase(s) === 'done', 200)).toBe(true);
    const t = texts(rig);
    for (let n = 1; n <= s.order.length; n++) expect(t).toContain(`Room ${n} clear.`);
    expect(t).toContain('Contact!');
    expect(t).toContain('Suspect is surrendering.');
    expect(t).toContain('Suspect in custody.');
    expect(t.at(-1)).toBe('Building clear.');
    expect(rig.npc.forced).toEqual([{ id: 7, state: 'handsUp' }]);
    expect(rig.npc.incapacitated.length).toBe(0);
    expect(rig.npc.actors.get(7)!.cuffed).toBe(true);
    expect(rig.of('backup:custody')).toEqual([{ callId: s.callId, personId: 555, actorId: 7, by: 'TAC-1' }]);
    // the contact comes in the subject's room, before the later "Room n clear" lines
    expect(t.indexOf('Contact!')).toBeLessThan(t.indexOf(`Room ${s.order.length} clear.`));
    // then the operators walk back out to staging
    rig.step(60 * 40);
    for (let i = 0; i < 4; i++) {
      expect(rig.sys.view.y[base + i]).toBe(0);
      const dist = Math.hypot(rig.sys.view.x[base + i]! - houseInfo.door.x, rig.sys.view.z[base + i]! - houseInfo.door.z);
      expect(dist).toBeGreaterThan(25);
    }
    expect(phase(s)).toBe('done');
  });

  it('clear from stacked breaches and clears in one command; a locked inner door is rammed', () => {
    const seed = seedWith((u) => u < 0.5);
    const s = swatRig(seed);
    const { rig } = s;
    // lock the door the BFS reaches the second room through, and the entry door
    const second = s.order[1]!;
    const inner = house.doors.find((d) => d.b >= 0 && ((d.a === second && d.b === s.order[0]) || (d.b === second && d.a === s.order[0])))!;
    rig.interiors.setDoor(houseInfo.id, inner.index, 'locked');
    rig.interiors.setDoor(houseInfo.id, s.entry, 'locked');
    rig.step(1);
    send(s, 'stack', { tempo: 'dynamic' });
    expect(rig.until(() => phase(s) === 'stacked', 80)).toBe(true);
    send(s, 'clear');
    expect(rig.until(() => phase(s) === 'done', 300)).toBe(true);
    expect(rig.doorRequests[0]).toEqual({ building: houseInfo.id, door: s.entry, action: 'ram' });
    expect(rig.doorRequests.filter((r) => r.door === inner.index)).toEqual([{ building: houseInfo.id, door: inner.index, action: 'ram' }]);
    expect(texts(rig)).toContain('Building clear.');
    expect(rig.npc.actors.get(7)!.cuffed).toBe(true);
  });

  it('a subject who does not surrender is subdued (less-lethal: beanbag), cuffed and reported in custody', () => {
    const seed = seedWith((u) => u > 0.75);
    const s = swatRig(seed);
    const { rig } = s;
    rig.step(1);
    send(s, 'stack', { tempo: 'dynamic', lessLethal: true });
    expect(rig.until(() => phase(s) === 'stacked', 80)).toBe(true);
    send(s, 'clear');
    expect(rig.until(() => phase(s) === 'done', 300)).toBe(true);
    expect(rig.npc.incapacitated).toEqual([{ id: 7, seconds: 8, by: 'beanbag' }]);
    expect(rig.npc.forced.length).toBe(0);
    expect(texts(rig)).toContain('Suspect subdued.');
    const injured = createRng(seed).stream('backup');
    injured.next();
    expect(texts(rig).includes('Suspect injured.')).toBe(injured.next() < 0.3);
    expect(rig.of<{ by: string }>('backup:custody')[0]!.by).toBe('TAC-1');
  });

  it('a hostage may be hurt by a dynamic entry (the roll comes from the backup stream); negotiation trust helps surrender', () => {
    const hurt = seedWith((u) => u > 0.7, (u) => u < 0.1);
    const s = swatRig(hurt, { hostage: true });
    s.rig.step(1);
    send(s, 'stack');
    expect(s.rig.until(() => phase(s) === 'stacked', 80)).toBe(true);
    send(s, 'clear', { tempo: 'dynamic' });
    expect(s.rig.until(() => phase(s) === 'done', 300)).toBe(true);
    expect(texts(s.rig)).toContain('Hostage injured.');
    expect(s.rig.npc.incapacitated.length).toBe(1);

    const safe = seedWith((u) => u > 0.7, (u) => u > 0.5);
    const s2 = swatRig(safe, { hostage: true });
    s2.rig.step(1);
    send(s2, 'stack', { tempo: 'dynamic' });
    expect(s2.rig.until(() => phase(s2) === 'stacked', 80)).toBe(true);
    send(s2, 'clear');
    expect(s2.rig.until(() => phase(s2) === 'done', 300)).toBe(true);
    expect(texts(s2.rig)).not.toContain('Hostage injured.');

    // trust 1 lifts the surrender chance enough for a 0.6 draw (0.55 + 0.35 = 0.9; hostage -0.15 = 0.75)
    const trust = seedWith((u) => u > 0.55 && u < 0.7);
    const s3 = swatRig(trust);
    s3.rig.trust = 1;
    s3.rig.step(1);
    send(s3, 'stack', { tempo: 'dynamic' });
    expect(s3.rig.until(() => phase(s3) === 'stacked', 80)).toBe(true);
    send(s3, 'clear');
    expect(s3.rig.until(() => phase(s3) === 'done', 300)).toBe(true);
    expect(s3.rig.npc.forced).toEqual([{ id: 7, state: 'handsUp' }]);
  });

  it('hold stops the team inside; clear continues; withdraw takes everyone out to staging', () => {
    const s = swatRig(1, { subject: false });
    const { rig } = s;
    rig.step(1);
    send(s, 'stack', { tempo: 'deliberate' });
    expect(rig.until(() => phase(s) === 'stacked', 80)).toBe(true);
    send(s, 'clear');
    expect(rig.until(() => phase(s) === 'clearing', 10)).toBe(true);
    rig.step(60 * 8);
    send(s, 'hold');
    rig.step(2);
    expect(phase(s)).toBe('holding');
    const p0 = [rig.sys.view.x[8], rig.sys.view.z[8]];
    rig.step(60 * 6);
    expect([rig.sys.view.x[8], rig.sys.view.z[8]]).toEqual(p0);
    expect(phase(s)).toBe('holding');
    send(s, 'stack');
    rig.step(2);
    expect(texts(rig).at(-1)).toBe('We are already inside.');
    send(s, 'clear');
    rig.step(2);
    expect(phase(s)).toBe('clearing');
    send(s, 'withdraw');
    rig.step(2);
    expect(phase(s)).toBe('withdrawn');
    expect(rig.sys.view.y[8]).toBe(0);
    expect(rig.until(() => {
      const d = Math.hypot(rig.sys.view.x[8]! - houseInfo.door.x, rig.sys.view.z[8]! - houseInfo.door.z);
      return d > 29;
    }, 60)).toBe(true);
    // from staging a second attempt is possible
    send(s, 'stack');
    expect(rig.until(() => phase(s) === 'stacked', 80)).toBe(true);
  });

  it('stage sends a stacked team back; the plan changes with any command', () => {
    const s = swatRig(1, { subject: false });
    const { rig } = s;
    rig.step(1);
    send(s, 'stack', { entry: 'rear', lessLethal: true });
    expect(rig.until(() => phase(s) === 'stacked', 80)).toBe(true);
    send(s, 'stage');
    rig.step(2);
    expect(phase(s)).toBe('staging');
    expect(rig.until(() => Math.hypot(rig.sys.view.x[8]! - houseInfo.door.x, rig.sys.view.z[8]! - houseInfo.door.z) > 29, 60)).toBe(true);
    const saved = rig.sys.serialize().swat!;
    expect(saved.plan).toEqual({ entry: 'rear', tempo: 'deliberate', lessLethal: true });
    expect(saved.door).toBe(-1);
  });

  it('is removed when the SWAT unit leaves, with the figures hidden', () => {
    const s = swatRig(1);
    s.rig.step(2);
    expect(s.rig.sys.view.count).toBe(12);
    s.rig.swatCount = 0;
    s.rig.step(2);
    expect(s.rig.sys.serialize().swat).toBeNull();
    for (let i = 8; i < 12; i++) expect(s.rig.sys.view.flags[i]).toBe(2);
    expect(s.rig.sys.view.count).toBe(0);
  });

  it('swatPhase: null without a SWAT unit, enRoute while it drives, then the team phase', () => {
    const rig = new Rig();
    const callId = rig.openCall();
    expect(rig.sys.swatPhase(callId)).toBeNull();
    rig.cad.addUnit({ callsign: 'TAC-1', kind: 'resource', officer: 'x', beat: 'b', fleetIndex: 9 }, { sim: 0, game: 0 });
    rig.cad.assign(callId, 'TAC-1', { sim: 0, game: 0 }, 'dispatch');
    expect(rig.sys.swatPhase(callId)).toBe('enRoute');
    expect(rig.sys.swat(callId, 'stack')).toBe('The SWAT team has not arrived yet.');
  });

  it('swatPhase: a SWAT unit on scene of a call with no building reads arrived, and the command says there is nothing to enter', () => {
    const rig = new Rig();
    const callId = rig.openCall();
    rig.unitOnScene('TAC-1', 5, 5, 0, 'resource');
    rig.callBuildingId = -1;
    rig.swatCount = 1;
    rig.step(2);
    expect(rig.sys.swatPhase(callId)).toBe('arrived');
    expect(rig.sys.swat(callId, 'stack')).toBe('No building to enter here.');
  });

  it('roomAt sanity: the subject fixture stands in the last room to clear', () => {
    const s = swatRig(1);
    const a = s.rig.npc.actors.get(7)!;
    expect(roomAt(house, a.x, a.z)).toBe(s.subjectRoom);
  });
});
