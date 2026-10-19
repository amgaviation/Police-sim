import { describe, expect, it } from 'vitest';
import { K9_FIRST_ROOM_S, K9_ROOM_S, CaseStore, CustodyLedger } from '../../src/evidence';
import { buildCaseView, clockText, itemStatus } from '../../src/investigation/caseView';
import { K9_LEAVE_S, k9Duration, k9Route, k9Sample, scentOf } from '../../src/investigation/k9run';
import { PROP_CAPACITY, buildProps, itemPropKind } from '../../src/investigation/props';
import { layTape, tapeZone, yawOf } from '../../src/investigation/tape';
import { PROP, createPropSource } from '../../src/render/people/pose';
import { houseLayout } from './harness';

describe('item props', () => {
  it('maps people items to their prop, falls back to a bag, draws no prop for a lifted print', () => {
    expect(itemPropKind('knife')).toBe(PROP.knife);
    expect(itemPropKind('handgun')).toBe(PROP.handgun);
    expect(itemPropKind('brokenGlass')).toBe(PROP.glass);
    expect(itemPropKind('threatNote')).toBe(PROP.note);
    expect(itemPropKind('liquorBottle')).toBe(PROP.bottle);
    expect(itemPropKind('narcotics')).toBe(PROP.bag);
    expect(itemPropKind('wallet')).toBe(PROP.bag);
    expect(itemPropKind('somethingUnknown')).toBe(PROP.bag);
    expect(itemPropKind('latentPrint')).toBe(0);
  });

  it('draws markers, open items and found concealed items for a level; collected and hidden ones are not drawn', () => {
    const store = new CaseStore();
    const spec = { item: 'knife', label: 'Knife', x: 1, y: -39, z: 2, buildingId: 5, room: 0, furniture: -1, container: 'none' as const, concealed: false, ownerPersonId: 1, incriminating: true };
    store.addItem(1, spec);
    const hidden = store.addItem(1, { ...spec, item: 'handgun', concealed: true, container: 'drawer' });
    const shown = store.addItem(1, { ...spec, item: 'handgun', concealed: true, container: 'drawer' });
    shown.state = 'found';
    const gone = store.addItem(1, spec);
    gone.state = 'collected';
    store.addItem(1, { ...spec, buildingId: -1 });
    store.file(1).markers.push({ no: 1, callId: 1, x: 3, y: -40, z: 4, buildingId: 5, itemId: null, sim: 0 });
    const out = createPropSource(32);
    buildProps(out, store.files(), [], 5);
    expect(Array.from(out.kind.slice(0, out.count))).toEqual([PROP.marker, PROP.knife, PROP.handgun]);
    expect(hidden.state).toBe('inPlace');
    buildProps(out, store.files(), [{ callId: 1, points: [0, 0, 6, 0], closed: false }], -1);
    expect(out.kind[0]).toBe(PROP.knife);
    expect(Array.from(out.kind.slice(0, out.count)).filter((k) => k === PROP.tape).length).toBe(3);
  });

  it('stops quietly when the buffer is full', () => {
    const store = new CaseStore();
    const f = store.file(1);
    for (let i = 0; i < 99; i++) f.markers.push({ no: i + 1, callId: 1, x: 0, y: 0, z: 0, buildingId: -1, itemId: null, sim: 0 });
    const out = createPropSource(10);
    buildProps(out, store.files(), [{ callId: 1, points: [0, 0, 50, 0, 50, 50], closed: true }], -1);
    expect(out.count).toBe(10);
    expect(PROP_CAPACITY).toBeGreaterThanOrEqual(256);
  });
});

describe('tape geometry', () => {
  it('yaw follows forward = (-sin yaw, -cos yaw)', () => {
    const yaw = yawOf(0, -5);
    expect(-Math.sin(yaw)).toBeCloseTo(0, 6);
    expect(-Math.cos(yaw)).toBeCloseTo(-1, 6);
    const east = yawOf(5, 0);
    expect(-Math.sin(east)).toBeCloseTo(1, 6);
  });

  it('lays a post at each corner and a prop every 3 m, wrapping a closed tape', () => {
    const puts: [number, number, number][] = [];
    layTape([0, 0, 9, 0, 9, 3], true, (x, z, yaw) => {
      puts.push([x, z, yaw]);
      return true;
    });
    // 9 m side: post + props at 3 and 6 m; 3 m side: post only; closing side (9.49 m): post + props at 3 and 6 m.
    expect(puts.filter((p) => p[1] === 0).map((p) => p[0])).toEqual([0, 3, 6, 9]);
    expect(puts.some((p) => p[0] === 9 && p[1] === 3)).toBe(true);
    expect(puts.length).toBe(3 + 1 + 3);
  });

  it('an open tape ends with a dangling post in the last direction', () => {
    const puts: [number, number, number][] = [];
    layTape([0, 0, 6, 0], false, (x, z, yaw) => {
      puts.push([x, z, yaw]);
      return true;
    });
    expect(puts.at(-1)?.slice(0, 2)).toEqual([6, 0]);
    expect(puts.at(-1)?.[2]).toBeCloseTo(yawOf(6, 0), 6);
  });

  it('the zone has bounds and float points', () => {
    const z = tapeZone(3, [1, 2, 5, 2, 5, 8]);
    expect(z).toMatchObject({ id: 3, minX: 1, minZ: 2, maxX: 5, maxZ: 8 });
    expect(z.points).toBeInstanceOf(Float32Array);
  });
});

describe('K9 route', () => {
  it('scents: drugs, firearms and everything else', () => {
    expect(scentOf('narcotics')).toBe('narcotics');
    expect(scentOf('pills')).toBe('narcotics');
    expect(scentOf('cannabis')).toBe('narcotics');
    expect(scentOf('handgun')).toBe('firearm');
    expect(scentOf('shellCasing')).toBe('firearm');
    expect(scentOf('knife')).toBe('other');
  });

  it('duration is 4 s + 12 s per room + leaving', () => {
    expect(k9Duration(3)).toBe(K9_FIRST_ROOM_S + 3 * K9_ROOM_S + K9_LEAVE_S);
  });

  it('the dog is at the room centre when the room is visited and moves continuously', () => {
    const layout = houseLayout();
    const order = [0, 1, 2];
    const route = k9Route(layout, order, 100, -208);
    const out = new Float64Array(3);
    const centre = (i: number): [number, number] => {
      const r = (layout.rooms[i] as (typeof layout.rooms)[number]).rect;
      return [(r.minX + r.maxX) / 2, (r.minZ + r.maxZ) / 2];
    };
    for (let slot = 0; slot < order.length; slot++) {
      k9Sample(route, K9_FIRST_ROOM_S + K9_ROOM_S * slot, out);
      const c = centre(order[slot] as number);
      expect(out[0]).toBeCloseTo(c[0], 5);
      expect(out[2]).toBeCloseTo(c[1], 5);
      expect(out[1]).toBe(layout.floorY);
    }
    let prev = [100, -208];
    let maxStep = 0;
    const dt = 0.05;
    for (let t = 0; t < k9Duration(order.length); t += dt) {
      k9Sample(route, t, out);
      maxStep = Math.max(maxStep, Math.hypot((out[0] as number) - (prev[0] as number), (out[2] as number) - (prev[1] as number)));
      prev = [out[0] as number, out[2] as number];
    }
    // No teleporting: the dog covers at most a few metres per second.
    expect(maxStep / dt).toBeLessThan(6);
  });

  it('outdoors the dog circles the search centre at 6 m', () => {
    const route = k9Route(null, [-1], 10, 20);
    const out = new Float64Array(3);
    for (const t of [0, 3, 9]) {
      k9Sample(route, t, out);
      expect(Math.hypot((out[0] as number) - 10, (out[2] as number) - 20)).toBeCloseTo(6, 6);
      expect(out[1]).toBe(0);
    }
  });
});

describe('case view helpers', () => {
  it('formats the game clock', () => {
    expect(clockText(10 * 3600 + 5 * 60)).toBe('10:05');
    expect(clockText(86400 + 30)).toBe('00:00');
  });

  it('describes the custody status of found and collected items', () => {
    const store = new CaseStore();
    const item = store.addItem(1, { item: 'knife', label: 'Knife', x: 0, y: 0, z: 0, buildingId: -1, room: -1, furniture: -1, container: 'none', concealed: false, ownerPersonId: 1, incriminating: true });
    item.state = 'found';
    item.foundBasis = 'consent';
    expect(itemStatus(item, 'none', '')).toEqual({ text: 'Found (consent)', next: 'collect' });
    item.state = 'collected';
    expect(itemStatus(item, 'collected', 'officer:1')).toEqual({ text: 'Collected', next: 'bag' });
    expect(itemStatus(item, 'bagged', 'officer:1')).toEqual({ text: 'Bagged', next: 'tag' });
    expect(itemStatus(item, 'tagged', 'locker:2')).toEqual({ text: 'Tagged (locker:2)', next: 'deposit' });
    expect(itemStatus(item, 'deposited', 'evidenceRoom')).toEqual({ text: 'Deposited', next: null });
    item.suppressed = true;
    expect(itemStatus(item, 'deposited', 'evidenceRoom').text).toBe('Deposited · SUPPRESSED');
  });

  it('builds an empty view for an empty file', () => {
    const store = new CaseStore();
    const view = buildCaseView(store.file(9, 'C-00009', 'Burglary'), new CustodyLedger(), () => 'someone');
    expect(view.chainOk).toBe(true);
    expect(view.verdict).toBe('Chain intact');
    expect(Object.values(view.tabs).every((rows) => rows.length === 0)).toBe(true);
    expect(view).toMatchObject({ callId: 9, incident: 'C-00009', title: 'Burglary' });
  });
});
