import { describe, expect, it } from 'vitest';
import { canvassResult } from '../../src/evidence';
import { SEED, makeHarness, stand, type Harness } from './harness';

/** The call id with the wanted canvass outcome at the neighbour building. */
function callWith(h: Harness, want: (r: ReturnType<typeof canvassResult>) => boolean, hour = 10): number {
  for (let c = 1; c < 500; c++) {
    if (want(canvassResult(SEED, c, h.neighbor.buildingId, hour, 0.3))) return c;
  }
  throw new Error('no call id');
}

function atNeighborDoor(h: Harness): void {
  const door = h.neighbor.doors.find((d) => d.main);
  if (!door) throw new Error('no door');
  stand(h, door.x, door.z + 0.9, -1, 0, -1);
}

describe('canvass', () => {
  it('records the rolled result with its text and spawns the resident at the door', () => {
    const h = makeHarness();
    const callId = callWith(h, (r) => r.result === 'sawSomething');
    h.world.call = callId;
    atNeighborDoor(h);
    h.sys.request({ kind: 'canvass', buildingId: h.neighbor.buildingId });
    h.step();
    const rec = h.sys.store.get(callId)?.canvass[0];
    expect(rec?.result).toBe('sawSomething');
    expect(rec?.buildingId).toBe(h.neighbor.buildingId);
    expect(rec?.text).toContain('saw a tall man in a red jacket heading north on Elm St');
    expect(rec?.text).toContain('Oak St');
    const expected = canvassResult(SEED, callId, h.neighbor.buildingId, 10, 0.3);
    expect(rec?.personId).toBe(1000 + (h.neighbor.buildingId % 100) * 10 + expected.residentIndex);
    expect(h.world.spawned).toEqual([
      { buildingId: h.neighbor.buildingId, personId: rec?.personId, callId, role: 'witness' },
    ]);
    expect(h.of('investigation:canvass')[0]?.payload).toMatchObject({ callId, result: 'sawSomething' });
  });

  it('a resident who saw nothing is spawned as a plain resident; no answer spawns nobody', () => {
    const h = makeHarness();
    const nothing = callWith(h, (r) => r.result === 'nothingSeen');
    h.world.call = nothing;
    atNeighborDoor(h);
    h.sys.request({ kind: 'canvass', buildingId: h.neighbor.buildingId });
    h.step();
    expect(h.world.spawned[0]?.role).toBe('resident');
    const none = callWith(h, (r) => r.result === 'noAnswer');
    h.world.call = none;
    h.sys.request({ kind: 'canvass', buildingId: h.neighbor.buildingId });
    h.step();
    expect(h.world.spawned).toHaveLength(1);
    const rec = h.sys.store.get(none)?.canvass[0];
    expect(rec?.result).toBe('noAnswer');
    expect(rec?.personId).toBe(-1);
  });

  it('is deterministic: two sessions with the same seed and call agree', () => {
    const results = [0, 1].map(() => {
      const h = makeHarness();
      const callId = callWith(h, (r) => r.answered);
      h.world.call = callId;
      atNeighborDoor(h);
      h.sys.request({ kind: 'canvass', buildingId: h.neighbor.buildingId });
      h.step();
      return h.sys.store.get(callId)?.canvass[0];
    });
    expect(results[0]).toEqual(results[1]);
  });

  it('knocks only once per building and call', () => {
    const h = makeHarness();
    const callId = callWith(h, (r) => r.answered);
    h.world.call = callId;
    atNeighborDoor(h);
    h.sys.request({ kind: 'canvass', buildingId: h.neighbor.buildingId });
    h.step();
    h.sys.request({ kind: 'canvass', buildingId: h.neighbor.buildingId });
    h.step();
    expect(h.sys.store.get(callId)?.canvass).toHaveLength(1);
    expect(h.flashes()).toContain('Already canvassed');
    expect(h.world.spawned.length).toBeLessThanOrEqual(1);
  });

  it('the night lowers the answer rate', () => {
    const day = callWith(makeHarness(), (r) => r.answered, 10);
    const h = makeHarness();
    let night = 0;
    let dayN = 0;
    for (let c = 1; c < 300; c++) {
      if (canvassResult(SEED, c, h.neighbor.buildingId, 2, 0.3).answered) night++;
      if (canvassResult(SEED, c, h.neighbor.buildingId, 10, 0.3).answered) dayN++;
    }
    expect(night).toBeLessThan(dayN);
    expect(day).toBeGreaterThan(0);
  });

  it('needs an active call within 150 m, the door within reach and a different building', () => {
    const h = makeHarness();
    atNeighborDoor(h);
    h.world.call = 0;
    h.sys.request({ kind: 'canvass', buildingId: h.neighbor.buildingId });
    h.step();
    expect(h.flashes()).toContain('There is no active call to canvass for.');
    h.world.call = 5;
    h.off.x += 3;
    h.sys.request({ kind: 'canvass', buildingId: h.neighbor.buildingId });
    h.step();
    expect(h.flashes()).toContain('Stand at the door to knock.');
    h.off.x -= 3;
    h.sys.request({ kind: 'canvass', buildingId: h.layout.buildingId });
    h.step();
    expect(h.flashes()).toContain('Talk to the people inside this building instead.');
    h.world.calls.set(5, {
      exigency: false, warrant: false, arrests: [], buildingId: h.layout.buildingId, family: 'property',
      suspectPersonId: 7, anchorX: 1000, anchorZ: 1000,
    });
    h.sys.request({ kind: 'canvass', buildingId: h.neighbor.buildingId });
    h.step();
    expect(h.flashes()).toContain('Too far from the scene to canvass.');
    expect(h.sys.store.get(5)?.canvass ?? []).toHaveLength(0);
  });

  it('uses the family saw-chance from the evidence data', () => {
    const h = makeHarness();
    h.world.call = 9;
    h.world.calls.set(9, {
      exigency: false, warrant: false, arrests: [], buildingId: h.layout.buildingId, family: 'domestic',
      suspectPersonId: -1, anchorX: 100, anchorZ: -200,
    });
    atNeighborDoor(h);
    h.sys.request({ kind: 'canvass', buildingId: h.neighbor.buildingId });
    h.step();
    const expected = canvassResult(SEED, 9, h.neighbor.buildingId, 10, 0.4);
    expect(h.sys.store.get(9)?.canvass[0]?.result).toBe(expected.result);
  });
});
