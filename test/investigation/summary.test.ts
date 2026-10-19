import { describe, expect, it } from 'vitest';
import { makeHarness, placeSpec, stand, type Harness } from './harness';

function foundItem(h: Harness, label: string, over: Parameters<typeof placeSpec>[1] = {}): string {
  const id = h.sys.placeItem(placeSpec(h, { x: 100.5, z: -200, label, ...over }));
  const item = h.sys.store.item(id);
  if (!item) throw new Error('missing item');
  item.state = 'found';
  return id;
}

describe('case summary', () => {
  it('is all zero for an unknown call', () => {
    const h = makeHarness();
    expect(h.sys.summary(999)).toEqual({
      items: 0, found: 0, plainView: 0, suppressed: 0, collected: 0, custodyComplete: false,
      photos: 0, markers: 0, prints: 0, canvass: 0, consents: 0, bodycam: false,
    });
  });

  it('counts items, markers, photos, consents and custody', () => {
    const h = makeHarness();
    stand(h, 100, -200, 0, 0);
    const a = foundItem(h, 'Knife');
    foundItem(h, 'Glass', { item: 'brokenGlass' });
    h.sys.placeItem(placeSpec(h, { label: 'Hidden', x: 0, z: 0, concealed: true, container: 'drawer' }));
    const sus = foundItem(h, 'Narcotics', { item: 'narcotics' });
    const susItem = h.sys.store.item(sus);
    if (susItem) susItem.suppressed = true;
    const pv = h.sys.store.item(a);
    if (pv) pv.plainView = true;
    h.sys.request({ kind: 'marker' });
    h.sys.request({ kind: 'photo', fovDeg: 60 });
    h.sys.request({ kind: 'collect', itemId: a });
    h.step();
    h.sys.recordConsent({
      callId: 42, personId: 7, kind: 'entry', granted: true, valid: true, authority: true,
      buildingId: h.layout.buildingId, room: -1, vehicleId: -1, sim: 0, revokedSim: -1,
    });
    let s = h.sys.summary(42);
    expect(s).toMatchObject({
      items: 4, found: 3, plainView: 1, suppressed: 1, collected: 1, custodyComplete: false,
      photos: 1, markers: 1, prints: 0, canvass: 0, consents: 1, bodycam: false,
    });
    for (const kind of ['bag', 'tag', 'deposit'] as const) {
      h.sys.request(kind === 'deposit' ? { kind } : { kind, itemId: a });
      h.step();
    }
    s = h.sys.summary(42);
    expect(s.custodyComplete).toBe(true);
  });

  it('custody is incomplete while any collected item is not deposited', () => {
    const h = makeHarness();
    stand(h, 100, -200, 0, 0);
    const a = foundItem(h, 'Knife');
    const b = foundItem(h, 'Glass', { item: 'brokenGlass' });
    for (const id of [a, b]) {
      h.sys.request({ kind: 'collect', itemId: id });
      h.step();
    }
    for (const kind of ['bag', 'tag'] as const) {
      h.sys.request({ kind, itemId: a });
      h.step();
    }
    h.sys.request({ kind: 'deposit' });
    h.step();
    expect(h.sys.summary(42).collected).toBe(2);
    expect(h.sys.summary(42).custodyComplete).toBe(false);
  });
});

describe('HUD case line', () => {
  it('shows incident, found/total items, markers and photos', () => {
    const h = makeHarness();
    expect(h.sys.hud()).toBe('C-00042 · items 0/0 · markers 0 · photos 0');
    stand(h, 100, -200, 0, 0);
    foundItem(h, 'Knife');
    h.sys.placeItem(placeSpec(h, { label: 'Hidden', x: 0, z: 0, concealed: true, container: 'drawer' }));
    h.sys.request({ kind: 'marker' });
    h.step();
    expect(h.sys.hud()).toBe('C-00042 · items 1/2 · markers 1 · photos 0');
  });

  it('is null without a case, and shows the field case once it has content', () => {
    const h = makeHarness();
    h.world.call = 0;
    expect(h.sys.hud()).toBeNull();
    stand(h, 100, -200, 0, 0);
    h.sys.request({ kind: 'marker' });
    h.step();
    expect(h.sys.hud()).toBe('Field case · items 0/0 · markers 1 · photos 0');
  });

  it('returns the same string until something changes', () => {
    const h = makeHarness();
    const a = h.sys.hud();
    expect(h.sys.hud()).toBe(a);
  });
});

describe('case view', () => {
  it('lists found items with their custody status and the ledger entries', () => {
    const h = makeHarness();
    stand(h, 100, -200, 0, 0);
    const a = foundItem(h, 'Knife');
    const pv = h.sys.store.item(a);
    if (pv) {
      pv.plainView = true;
      pv.foundBasis = 'plainView';
    }
    h.sys.placeItem(placeSpec(h, { label: 'Hidden', x: 0, z: 0, concealed: true, container: 'drawer' }));
    let view = h.sys.caseView(42);
    expect(view?.tabs.items).toHaveLength(1);
    expect(view?.tabs.items[0]).toMatchObject({ itemId: a, detail: 'Found (plain view)', next: 'collect' });
    const steps: [string, string, string | null][] = [
      ['collect', 'Collected', 'bag'],
      ['bag', 'Bagged', 'tag'],
      ['tag', 'Tagged', 'deposit'],
    ];
    for (const [kind, status, next] of steps) {
      h.sys.request({ kind, itemId: a } as never);
      h.step();
      view = h.sys.caseView(42);
      expect(view?.tabs.items[0]).toMatchObject({ detail: expect.stringContaining(status) as string, next });
    }
    h.sys.request({ kind: 'deposit' });
    h.step();
    view = h.sys.caseView(42);
    expect(view?.tabs.items[0]).toMatchObject({ detail: 'Deposited', next: null });
    expect(view?.tabs.custody).toHaveLength(4);
    expect(view?.tabs.custody[0]?.text).toBe(`#1 COLLECT ${a}`);
    expect(view?.verdict).toBe('Chain intact');
  });

  it('marks suppressed evidence and photographs, consents and statements', () => {
    const h = makeHarness();
    stand(h, 100, -200, 0, 0);
    const a = foundItem(h, 'Narcotics', { item: 'narcotics' });
    const item = h.sys.store.item(a);
    if (item) item.suppressed = true;
    h.sys.request({ kind: 'photo', fovDeg: 60 });
    h.step();
    h.sys.recordStatement(42, { personId: 7, role: 'witness', text: 'I saw a man run.', sim: 3 });
    h.sys.recordConsent({
      callId: 42, personId: 7, kind: 'searchRoom', granted: true, valid: true, authority: false,
      buildingId: h.layout.buildingId, room: 2, vehicleId: -1, sim: 0, revokedSim: -1,
    });
    const view = h.sys.caseView(42);
    expect(view?.tabs.items[0]?.detail).toBe('Found (no lawful basis) · SUPPRESSED');
    expect(view?.tabs.photos).toHaveLength(1);
    expect(view?.tabs.photos[0]?.thumb).toBeNull();
    expect(view?.tabs.statements[0]?.text).toBe('witness: I saw a man run.');
    expect(view?.tabs.consents[0]?.text).toBe('searchRoom · granted, no authority');
    expect(h.sys.caseView(777)).toBeNull();
  });

  it('is cached until the revision changes', () => {
    const h = makeHarness();
    h.sys.recordStatement(42, { personId: 7, role: 'witness', text: 'x', sim: 0 });
    const a = h.sys.caseView(42);
    expect(h.sys.caseView(42)).toBe(a);
    h.sys.recordStatement(42, { personId: 7, role: 'witness', text: 'y', sim: 0 });
    expect(h.sys.caseView(42)).not.toBe(a);
  });
});

describe('nearest queries', () => {
  it('nearestItem prefers found items, ignores concealed ones and collected ones', () => {
    const h = makeHarness();
    const open = h.sys.placeItem(placeSpec(h, { label: 'Open', x: 100.2, z: -200 }));
    expect(h.sys.nearestItem(100, -200, h.layout.buildingId, 2)?.id).toBe(open);
    const found = foundItem(h, 'Found', { x: 101.2 });
    expect(h.sys.nearestItem(100, -200, h.layout.buildingId, 2)?.id).toBe(found);
    h.sys.placeItem(placeSpec(h, { label: 'Hidden', x: 100, z: -200, concealed: true, container: 'drawer' }));
    expect(h.sys.nearestItem(100, -200, h.layout.buildingId, 0.5)?.id).toBe(open);
    expect(h.sys.nearestItem(100, -200, -1, 5)).toBeNull();
    expect(h.sys.nearestItem(150, -200, h.layout.buildingId, 2)).toBeNull();
  });

  it('nearestFurniture finds a container or surface within 1.5 m ahead only', () => {
    const h = makeHarness();
    const f = h.layout.furniture.find((x) => x.container === 'drawer');
    if (!f) throw new Error('no drawer');
    const b = h.layout.buildingId;
    // Standing 1 m in front of its centre, facing it.
    const fx = f.x;
    const fz = f.z + 1 + f.d / 2;
    expect(h.sys.nearestFurniture(fx, fz, 0, b, 'container')).toBeGreaterThanOrEqual(0);
    // Facing away from it: not "ahead".
    const behind = h.sys.nearestFurniture(fx, fz, Math.PI, b, 'container');
    expect(behind === f.index).toBe(false);
    expect(h.sys.nearestFurniture(fx, fz, 0, -1, 'container')).toBe(-1);
    expect(h.sys.nearestFurniture(1000, 1000, 0, b, 'container')).toBe(-1);
  });
});
