import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import { POST_LEVELS, emptyResourceSave, isResourceRequest, isResourceSave } from '../../src/resources/save';
import { at, makeCall, makeHarness, run } from './helpers';

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

describe('resource save', () => {
  it('an empty save is valid and carries the stream state', () => {
    const rng = createRng(1).stream('resources').state();
    const s = emptyResourceSave(rng);
    expect(isResourceSave(s)).toBe(true);
    expect(s.rng).toEqual(rng);
    expect(s.units).toEqual([]);
  });

  it('a live save validates and survives JSON', () => {
    const h = makeHarness();
    const call = makeCall(h, 2, h.city.spawn.x + 400, h.city.spawn.z);
    h.res.request({ kind: 'request', typeId: 'k9', callId: call.id, via: 'radio' });
    h.res.request({ kind: 'request', typeId: 'air', callId: call.id, via: 'mdt' });
    run(h, 0.5);
    h.bus.emit('force:applied', { seq: 1, tool: 'taser', level: 'taser', personId: 1, actorId: 1, callId: call.id, resistance: 'active', hit: true, injury: 0, fatal: false, cycle: 1, riskFactors: [], distance: 3, restrained: false, sim: 0 });
    const s = h.res.serialize();
    expect(isResourceSave(s)).toBe(true);
    expect(isResourceSave(clone(s))).toBe(true);
    expect(s.requests.length).toBe(1);
    expect(s.units.length).toBe(22 + 1);
  });

  it('rejects malformed blocks', () => {
    const h = makeHarness();
    const good = h.res.serialize();
    expect(isResourceSave(null)).toBe(false);
    expect(isResourceSave({ ...good, version: 2 })).toBe(false);
    expect(isResourceSave({ ...good, rng: { seed: 1, s: [1, 2, 3] } })).toBe(false);
    expect(isResourceSave({ ...good, units: [{ callsign: 'K9-1' }] })).toBe(false);
    const u0 = good.units[0];
    expect(u0).toBeDefined();
    if (!u0) return;
    expect(isResourceSave({ ...good, units: [u0, u0] })).toBe(false);
    expect(isResourceSave({ ...good, units: [{ ...u0, status: 'flying' }] })).toBe(false);
    expect(isResourceSave({ ...good, units: [{ ...u0, destX: Number.NaN }] })).toBe(false);
    expect(isResourceSave({ ...good, air: { x: 1 } })).toBe(false);
    expect(isResourceSave({ ...good, posts: [[1, 2, 3, POST_LEVELS.length]] })).toBe(false);
    expect(isResourceSave({ ...good, posts: [[1, 2, 3]] })).toBe(false);
    expect(isResourceSave({ ...good, requests: [{ kind: 'request', typeId: 'k9', callId: 1, via: 'carrier' }] })).toBe(false);
    expect(isResourceSave({ ...good, requests: [{ kind: 'cancel', callsign: '' }] })).toBe(false);
  });

  it('validates requests', () => {
    expect(isResourceRequest({ kind: 'request', typeId: 'k9', callId: 1, via: 'scene' })).toBe(true);
    expect(isResourceRequest({ kind: 'release', callsign: 'K9-1' })).toBe(true);
    expect(isResourceRequest({ kind: 'nope' })).toBe(false);
    expect(at(0).sim).toBe(0);
  });
});
