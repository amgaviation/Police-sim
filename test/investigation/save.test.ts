import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import { InvestigationSystem } from '../../src/investigation/investigationSystem';
import {
  emptyInvestigationSave,
  isInvestigationSave,
  type InvestigationSave,
} from '../../src/investigation/save';
import { unitHash } from '../../src/records/hash';
import { SEED, makeHarness, nightstands, placeSpec, stand, standAt, type Harness } from './harness';

/** Builds a busy session: items, markers, photos, custody, an open tape, dusting and a K9 sweep under way. */
function busy(h: Harness): void {
  const f = nightstands(h.layout)[0];
  const surface = h.layout.furniture.find((x) => x.surface === 'glass' || x.surface === 'metal');
  if (!f || !surface) throw new Error('layout');
  h.sys.recordConsent({
    callId: 42, personId: 7, kind: 'searchPremises', granted: true, valid: true, authority: true,
    buildingId: h.layout.buildingId, room: -1, vehicleId: -1, sim: 0, revokedSim: -1,
  });
  h.sys.recordStatement(42, { personId: 7, role: 'witness', text: 'I heard a crash.', sim: 1 });
  h.sys.recordArrest(42, 7, h.layout.buildingId, f.room, 2);
  const id = h.sys.placeItem(placeSpec(h, { item: 'narcotics', label: 'Narcotics', x: f.x, z: f.z, y: 0.45, room: f.room, furniture: f.index, container: 'drawer', concealed: true }));
  h.sys.placeItem(placeSpec(h, { item: 'handgun', label: 'Handgun', x: f.x + 0.2, z: f.z, y: 0.45, room: f.room, furniture: f.index, container: 'drawer', concealed: true }));
  standAt(h, f);
  h.sys.request({ kind: 'search', buildingId: h.layout.buildingId, furniture: f.index, force: false });
  h.sys.request({ kind: 'marker' });
  h.step();
  h.sys.request({ kind: 'photo', fovDeg: 70 });
  h.sys.request({ kind: 'collect', itemId: id });
  h.sys.request({ kind: 'bag', itemId: id });
  h.step();
  h.sys.request({ kind: 'bodycam', on: true });
  h.step();
  // An open tape outdoors, then back to the dusting.
  stand(h, 0, 0, -1, 0, -1);
  h.sys.request({ kind: 'tapePost' });
  h.step();
  stand(h, 8, 0, -1, 0, -1);
  h.sys.request({ kind: 'tapePost' });
  h.step();
  standAt(h, surface);
  h.sys.request({ kind: 'dustStart', buildingId: h.layout.buildingId, furniture: surface.index });
  h.step();
  h.sys.request({ kind: 'dustBrush', seconds: 0.2 });
  h.sys.request({ kind: 'dustMove', dir: 'right' });
  h.step();
  h.world.hidden = [{ actorId: 77, x: f.x, z: f.z }];
  let call = 1;
  while (unitHash(SEED, 0x6b39, call * 64) >= 0.9) call++;
  h.world.call = call;
  h.sys.startK9(call);
  h.run(6);
  h.sys.request({ kind: 'marker' });
  h.sys.request({ kind: 'tapePost' });
}

function twin(from: Harness): Harness {
  const h = makeHarness();
  h.world.kit = { ...from.world.kit };
  h.world.call = from.world.call;
  h.world.hidden = from.world.hidden.map((x) => ({ ...x }));
  Object.assign(h.off, from.off);
  h.sim = from.sim;
  h.game = from.game;
  return h;
}

describe('investigation save', () => {
  it('an empty save validates and a fresh system serializes to a valid save', () => {
    const rng = createRng(SEED).stream('investigation');
    expect(isInvestigationSave(emptyInvestigationSave(rng.state()))).toBe(true);
    const h = makeHarness();
    const s = h.sys.serialize();
    expect(isInvestigationSave(s)).toBe(true);
    expect(s.files).toEqual([]);
    expect(s.ledger).toEqual([]);
    expect(s.k9).toBeNull();
    expect(s.dust).toBeNull();
  });

  it('a busy session serializes to JSON and validates', () => {
    const h = makeHarness();
    busy(h);
    const s = JSON.parse(JSON.stringify(h.sys.serialize())) as unknown;
    expect(isInvestigationSave(s)).toBe(true);
    const save = s as InvestigationSave;
    expect(save.files.length).toBeGreaterThan(0);
    expect(save.ledger.length).toBeGreaterThan(0);
    expect(save.dust).not.toBeNull();
    expect(save.k9).not.toBeNull();
    expect(save.tapes[0]?.closed).toBe(false);
    expect(save.queue.length).toBe(2);
    expect(save.bodycam).toBe(true);
  });

  it('save then restore continues identically', () => {
    const a = makeHarness();
    busy(a);
    const saved = JSON.parse(JSON.stringify(a.sys.serialize())) as InvestigationSave;
    const b = twin(a);
    b.sys.restore(saved);
    expect(b.sys.serialize()).toEqual(a.sys.serialize());
    expect(b.sys.revision).toBeGreaterThan(0);
    expect(b.sys.dust?.cursor).toBe(a.sys.dust?.cursor);
    expect(b.sys.bodycamOn).toBe(true);
    expect(b.sys.dog.count).toBe(2);
    for (const h of [a, b]) {
      h.run(3);
      h.sys.request({ kind: 'dustBrush', seconds: 0.1 });
      h.sys.request({ kind: 'dustLift' });
      h.run(20);
      h.sys.request({ kind: 'bodycam', on: false });
      h.sys.request({ kind: 'tapePost' });
      h.run(20);
    }
    expect(b.sys.serialize()).toEqual(a.sys.serialize());
    expect(b.events.map((e) => e.topic)).toEqual(a.events.slice(a.events.length - b.events.length).map((e) => e.topic));
    expect(b.sys.dog.x[0]).toBeCloseTo(a.sys.dog.x[0] ?? 0, 5);
  });

  it('the rng stream continues where it stopped (dust draws match after a restore)', () => {
    const a = makeHarness();
    const f = a.layout.furniture.find((x) => x.surface === 'glass');
    if (!f) throw new Error('no glass');
    standAt(a, f);
    const b = twin(a);
    b.sys.restore(JSON.parse(JSON.stringify(a.sys.serialize())) as InvestigationSave);
    for (const h of [a, b]) {
      h.sys.request({ kind: 'dustStart', buildingId: h.layout.buildingId, furniture: f.index });
      h.step();
    }
    expect(b.sys.serialize().dust).toEqual(a.sys.serialize().dust);
    expect(a.sys.serialize().dust?.base).toBeGreaterThan(0);
  });

  it('restore replaces earlier state and re-sends the closed tapes to the npc module', () => {
    const a = makeHarness();
    for (const [x, z] of [[0, 0], [10, 0], [10, 10]] as const) {
      stand(a, x, z, -1, 0, -1);
      a.sys.request({ kind: 'tapePost' });
      a.step();
    }
    a.sys.request({ kind: 'tapeClose' });
    a.step();
    const saved = JSON.parse(JSON.stringify(a.sys.serialize())) as InvestigationSave;
    const b = makeHarness();
    b.sys.recordStatement(5, { personId: 1, role: 'x', text: 'old', sim: 0 });
    b.sys.restore(saved);
    expect(b.sys.store.get(5)).toBeNull();
    expect(b.world.zones).toHaveLength(1);
    expect(b.world.zones[0]?.maxX).toBe(10);
    stand(b, 0, 0, -1, 0, -1);
    b.step();
    expect(b.sys.props.count).toBeGreaterThan(3);
  });

  it('rejects malformed saves', () => {
    const base = emptyInvestigationSave(createRng(SEED).stream('investigation').state());
    const bad: unknown[] = [
      null,
      42,
      { ...base, version: 2 },
      { ...base, rng: { seed: 1, s: [1, 2, 3] } },
      { ...base, files: [{}] },
      { ...base, ledger: [{ seq: 1 }] },
      { ...base, tapes: [{ callId: 1, points: [1], closed: false }] },
      { ...base, activeTape: 3 },
      { ...base, bodycam: 'yes' },
      { ...base, held: [1] },
      { ...base, dust: { surface: 'glass' } },
      { ...base, k9: { callId: 1, startedSim: 0, alerts: [], fired: 2, order: [] } },
      { ...base, scanTimer: Number.NaN },
      { ...base, arrests: [[1, 2, 3]] },
      { ...base, queue: [{ kind: 'nonsense' }] },
      { ...base, queue: [{ kind: 'dustMove', dir: 'sideways' }] },
    ];
    for (const s of bad) expect(isInvestigationSave(s)).toBe(false);
  });

  it('accepts every request kind in the queue', () => {
    const base = emptyInvestigationSave(createRng(SEED).stream('investigation').state());
    const queue = [
      { kind: 'marker' }, { kind: 'removeMarker', no: 1 }, { kind: 'photo', fovDeg: 60 }, { kind: 'collect', itemId: 'E-1-1' },
      { kind: 'bag', itemId: 'E-1-1' }, { kind: 'tag', itemId: 'E-1-1' }, { kind: 'transfer', itemId: 'E-1-1', to: 'locker:1' },
      { kind: 'deposit' }, { kind: 'search', buildingId: 1, furniture: 2, force: true }, { kind: 'dustStart', buildingId: 1, furniture: 2 },
      { kind: 'dustMove', dir: 'up' }, { kind: 'dustBrush', seconds: 0.1 }, { kind: 'dustLift' }, { kind: 'dustCancel' },
      { kind: 'tapePost' }, { kind: 'tapeClose' }, { kind: 'tapeClear' }, { kind: 'bodycam', on: true }, { kind: 'canvass', buildingId: 3 },
    ];
    expect(isInvestigationSave({ ...base, queue })).toBe(true);
  });

  it('restores queued requests and applies them on the next step', () => {
    const a = makeHarness();
    stand(a, 100, -200, 0, 0);
    a.sys.request({ kind: 'marker' });
    const saved = JSON.parse(JSON.stringify(a.sys.serialize())) as InvestigationSave;
    const b = twin(a);
    b.sys.restore(saved);
    b.step();
    expect(b.sys.store.get(42)?.markers).toHaveLength(1);
  });

  it('a new system built over a restored save reports no pending thumbnails', () => {
    const a = makeHarness();
    stand(a, 100, -200, 0, 0);
    a.sys.request({ kind: 'photo', fovDeg: 60 });
    a.step();
    expect(a.sys.pendingThumbnail()).not.toBeNull();
    const b = twin(a);
    b.sys.restore(JSON.parse(JSON.stringify(a.sys.serialize())) as InvestigationSave);
    expect(b.sys.pendingThumbnail()).toBeNull();
    expect(b.sys instanceof InvestigationSystem).toBe(true);
  });
});
