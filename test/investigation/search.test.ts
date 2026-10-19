import { describe, expect, it } from 'vitest';
import { makeHarness, nightstands, placeSpec, standAt, type Harness } from './harness';

interface Stands {
  h: Harness;
  a: ReturnType<typeof nightstands>[number];
  b: ReturnType<typeof nightstands>[number];
  itemA: string;
  itemB: string;
}

/** A drawer item in each of two bedrooms. */
function twoDrawers(): Stands {
  const h = makeHarness();
  const stands = nightstands(h.layout);
  const a = stands[0];
  const b = stands.find((s) => s.room !== a?.room);
  if (!a || !b) throw new Error('need two bedrooms');
  const spec = (f: typeof a, label: string): ReturnType<typeof placeSpec> =>
    placeSpec(h, { item: 'narcotics', label, x: f.x, z: f.z, y: 0.45, room: f.room, furniture: f.index, container: 'drawer', concealed: true });
  const itemA = h.sys.placeItem(spec(a, 'Narcotics A'));
  const itemB = h.sys.placeItem(spec(b, 'Narcotics B'));
  return { h, a, b, itemA, itemB };
}

function consent(h: Harness, kind: 'searchRoom' | 'searchPremises' | 'entry', room: number): void {
  h.sys.recordConsent({
    callId: 42, personId: 7, kind, granted: true, valid: true, authority: true,
    buildingId: h.layout.buildingId, room, vehicleId: -1, sim: h.sim, revokedSim: -1,
  });
}

describe('container search', () => {
  it('room consent finds the drawer item in that room only', () => {
    const { h, a, b, itemA, itemB } = twoDrawers();
    consent(h, 'searchRoom', a.room);
    standAt(h, a);
    h.sys.request({ kind: 'search', buildingId: h.layout.buildingId, furniture: a.index, force: false });
    h.step();
    const found = h.sys.store.item(itemA);
    expect(found?.state).toBe('found');
    expect(found?.foundBasis).toBe('consent');
    expect(found?.suppressed).toBe(false);
    expect(found?.plainView).toBe(false);
    const ev = h.of('investigation:found');
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload).toMatchObject({ itemId: itemA, basis: 'consent', suppressed: false });

    standAt(h, b);
    h.sys.request({ kind: 'search', buildingId: h.layout.buildingId, furniture: b.index, force: false });
    h.step();
    expect(h.sys.store.item(itemB)?.state).toBe('inPlace');
    expect(h.flashes().some((f) => f.includes('does not cover') || f.includes('No legal basis'))).toBe(true);
  });

  it('premises consent covers every room of the building', () => {
    const { h, a, b, itemA, itemB } = twoDrawers();
    consent(h, 'searchPremises', -1);
    for (const [f, id] of [[a, itemA], [b, itemB]] as const) {
      standAt(h, f);
      h.sys.request({ kind: 'search', buildingId: h.layout.buildingId, furniture: f.index, force: false });
      h.step();
      expect(h.sys.store.item(id)?.state).toBe('found');
    }
  });

  it('consent to enter does not allow opening a drawer', () => {
    const { h, a, itemA } = twoDrawers();
    consent(h, 'entry', -1);
    standAt(h, a);
    h.sys.request({ kind: 'search', buildingId: h.layout.buildingId, furniture: a.index, force: false });
    h.step();
    expect(h.sys.store.item(itemA)?.state).toBe('inPlace');
    expect(h.flashes().join(' ')).toContain('Consent to enter is not consent to search');
  });

  it('a search with no basis is refused with the reason', () => {
    const { h, a, itemA } = twoDrawers();
    standAt(h, a);
    h.sys.request({ kind: 'search', buildingId: h.layout.buildingId, furniture: a.index, force: false });
    h.step();
    expect(h.sys.store.item(itemA)?.state).toBe('inPlace');
    expect(h.flashes().join(' ')).toContain('No legal basis to search this drawer');
    expect(h.of('investigation:found')).toHaveLength(0);
  });

  it('forcing it finds the item but marks the evidence suppressed', () => {
    const { h, a, itemA } = twoDrawers();
    standAt(h, a);
    h.sys.request({ kind: 'search', buildingId: h.layout.buildingId, furniture: a.index, force: true });
    h.step();
    const item = h.sys.store.item(itemA);
    expect(item?.state).toBe('found');
    expect(item?.foundBasis).toBeNull();
    expect(item?.suppressed).toBe(true);
    expect(h.of('investigation:found')[0]?.payload).toMatchObject({ itemId: itemA, basis: null, suppressed: true });
    expect(h.sys.summary(42).suppressed).toBe(1);
  });

  it('a warrant covers the premises', () => {
    const { h, a, itemA } = twoDrawers();
    h.world.calls.set(42, {
      exigency: false, warrant: true, arrests: [], buildingId: h.layout.buildingId, family: 'property',
      suspectPersonId: 7, anchorX: 100, anchorZ: -200,
    });
    standAt(h, a);
    h.sys.request({ kind: 'search', buildingId: h.layout.buildingId, furniture: a.index, force: false });
    h.step();
    expect(h.sys.store.item(itemA)?.foundBasis).toBe('warrant');
  });

  it('incident to arrest covers the arrest room, recorded through recordArrest', () => {
    const { h, a, b, itemA, itemB } = twoDrawers();
    h.sys.recordArrest(42, 7, h.layout.buildingId, a.room, 0);
    h.run(1);
    standAt(h, a);
    h.sys.request({ kind: 'search', buildingId: h.layout.buildingId, furniture: a.index, force: false });
    h.step();
    expect(h.sys.store.item(itemA)?.foundBasis).toBe('incidentToArrest');
    standAt(h, b);
    h.sys.request({ kind: 'search', buildingId: h.layout.buildingId, furniture: b.index, force: false });
    h.step();
    expect(h.sys.store.item(itemB)?.state).toBe('inPlace');
  });

  it('is refused when the officer is too far from the container', () => {
    const { h, a, itemA } = twoDrawers();
    consent(h, 'searchPremises', -1);
    standAt(h, a);
    h.off.x += 6;
    h.sys.request({ kind: 'search', buildingId: h.layout.buildingId, furniture: a.index, force: false });
    h.step();
    expect(h.sys.store.item(itemA)?.state).toBe('inPlace');
    expect(h.flashes().some((f) => f.startsWith('Too far from the'))).toBe(true);
  });

  it('finding nothing says so', () => {
    const { h, a } = twoDrawers();
    consent(h, 'searchPremises', -1);
    standAt(h, a);
    h.sys.removeCallItems(42);
    h.sys.request({ kind: 'search', buildingId: h.layout.buildingId, furniture: a.index, force: false });
    h.step();
    expect(h.flashes().some((f) => f.startsWith('Nothing in the'))).toBe(true);
  });

  it('consent without authority does nothing', () => {
    const { h, a, itemA } = twoDrawers();
    h.sys.recordConsent({
      callId: 42, personId: 7, kind: 'searchPremises', granted: true, valid: true, authority: false,
      buildingId: h.layout.buildingId, room: -1, vehicleId: -1, sim: 0, revokedSim: -1,
    });
    standAt(h, a);
    h.sys.request({ kind: 'search', buildingId: h.layout.buildingId, furniture: a.index, force: false });
    h.step();
    expect(h.sys.store.item(itemA)?.state).toBe('inPlace');
  });
});

describe('scene hooks', () => {
  it('placeItem returns ids E-<call>-<n> and treats small y as floor-relative on a level', () => {
    const h = makeHarness();
    const id1 = h.sys.placeItem(placeSpec(h, { y: 0.9 }));
    const id2 = h.sys.placeItem(placeSpec(h, { y: -39.1 }));
    expect(id1).toBe('E-42-1');
    expect(id2).toBe('E-42-2');
    expect(h.sys.store.item(id1)?.y).toBeCloseTo(-39.1, 6);
    expect(h.sys.store.item(id2)?.y).toBeCloseTo(-39.1, 6);
    const out = h.sys.placeItem(placeSpec(h, { buildingId: -1, y: 0.1 }));
    expect(h.sys.store.item(out)?.y).toBeCloseTo(0.1, 6);
  });

  it('removeCallItems drops in-place items only', () => {
    const h = makeHarness();
    const kept = h.sys.placeItem(placeSpec(h));
    const dropped = h.sys.placeItem(placeSpec(h, { label: 'Other' }));
    const item = h.sys.store.item(kept);
    if (!item) throw new Error('missing');
    item.state = 'found';
    h.sys.removeCallItems(42);
    expect(h.sys.store.item(kept)).not.toBeNull();
    expect(h.sys.store.item(dropped)).toBeNull();
  });

  it('records statements and consents in the case file', () => {
    const h = makeHarness();
    h.sys.recordStatement(42, { personId: 7, role: 'witness', text: 'I heard glass break.', sim: 5 });
    consent(h, 'entry', -1);
    const file = h.sys.store.get(42);
    expect(file?.statements).toHaveLength(1);
    expect(file?.consents).toHaveLength(1);
    expect(file?.consents[0]?.id).toBe(1);
    expect(h.sys.summary(42).consents).toBe(1);
  });
});
