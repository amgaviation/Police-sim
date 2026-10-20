import { describe, expect, it } from 'vitest';
import { FORCE_CONFIG } from '../../src/force/data';
import { makeActor, Rig, scriptedRng } from './helpers';

/** A cuffed, previously assaultive subject on call 5 with one fellow officer 1 m away. */
function setup(rngValues: number[], fellow: { name?: string; misconductChance?: number; callsign?: string; x?: number } = {}): Rig {
  const rig = new Rig(scriptedRng(rngValues, 0.5));
  rig.add(makeActor(1, { personId: 7, x: 0, z: -1, cuffed: true, callId: 5 }), 'assaultive');
  rig.effectsCalm = false;
  rig.fellowList = [{ name: fellow.name ?? 'Officer Park', x: fellow.x ?? 1, z: -1, building: -1, ...(fellow.misconductChance !== undefined ? { misconductChance: fellow.misconductChance } : {}), ...(fellow.callsign !== undefined ? { callsign: fellow.callsign } : {}) }];
  rig.select('hands');
  return rig;
}

// Hands apply draws 3 values (hit, no incapacitation, injury); the fellow roll is the fourth.
const ROLL_HIGH = [0.1, 0.9, 0.5, 0.97];
const ROLL_LOW = [0.1, 0.9, 0.5, 0.0];

describe('per-fellow misconduct chance (Phase 6)', () => {
  it('a fellow with chance 1 always starts an episode, even on a high roll', () => {
    const rig = setup(ROLL_HIGH, { misconductChance: 1, callsign: '23' });
    rig.apply(0, -1);
    rig.runFor(20);
    expect(rig.other).toHaveLength(FORCE_CONFIG.fellow.maxStrikes);
    expect(rig.other[0]).toMatchObject({ officer: 'Officer Park', personId: 7, actorId: 1, callId: 5, restrained: true });
  });

  it('a fellow with chance 0 never does, even on a zero roll', () => {
    const rig = setup(ROLL_LOW, { misconductChance: 0, callsign: '23' });
    rig.apply(0, -1);
    rig.runFor(30);
    expect(rig.other).toHaveLength(0);
    expect(rig.sys.hud.episode).toBeNull();
  });

  it('without a misconductChance the configured fellow.chance applies (the Phase 5 partner)', () => {
    const configured = FORCE_CONFIG.fellow.chance;
    expect(configured).toBeGreaterThan(0);
    expect(configured).toBeLessThan(0.97);
    const low = setup(ROLL_LOW);
    low.apply(0, -1);
    low.runFor(20);
    expect(low.other.length).toBeGreaterThan(0);
    const high = setup(ROLL_HIGH);
    high.apply(0, -1);
    high.runFor(20);
    expect(high.other).toHaveLength(0);
  });

  it('uses the chance of the nearest fellow', () => {
    const rig = setup(ROLL_HIGH);
    rig.fellowList = [
      { name: 'Far Officer', x: 4, z: -1, building: -1, misconductChance: 0 },
      { name: 'Near Officer', x: 0.5, z: -1, building: -1, misconductChance: 1 },
    ];
    rig.apply(0, -1);
    rig.runFor(20);
    expect(rig.other.length).toBeGreaterThan(0);
    expect(rig.other[0]?.officer).toBe('Near Officer');
    const swapped = setup(ROLL_LOW);
    swapped.fellowList = [
      { name: 'Far Officer', x: 4, z: -1, building: -1, misconductChance: 1 },
      { name: 'Near Officer', x: 0.5, z: -1, building: -1, misconductChance: 0 },
    ];
    swapped.apply(0, -1);
    swapped.runFor(20);
    expect(swapped.other).toHaveLength(0);
  });

  it('the force:other officer is the fellow name and the player can still intervene', () => {
    const rig = setup(ROLL_LOW, { misconductChance: 1, name: 'Sgt. M. Chen', callsign: '21' });
    rig.apply(0, -1);
    rig.runFor(2.5);
    expect(rig.other).toHaveLength(1);
    expect(rig.other[0]?.officer).toBe('Sgt. M. Chen');
    expect(rig.sys.hud.episode).toBe('Sgt. M. Chen');
    rig.sys.request({ kind: 'intervene' });
    rig.run(1);
    expect(rig.intervened).toHaveLength(1);
    expect(rig.intervened[0]).toMatchObject({ otherSeq: rig.other[0]!.seq, personId: 7, callId: 5 });
    rig.runFor(20);
    expect(rig.other).toHaveLength(1);
  });

  it('a chance of 1 is deterministic: the same script gives the same strike times', () => {
    const times = (): number[] => {
      const rig = setup(ROLL_HIGH, { misconductChance: 1 });
      rig.apply(0, -1);
      rig.runFor(20);
      return rig.other.map((e) => e.sim);
    };
    expect(times()).toEqual(times());
    expect(times().length).toBe(FORCE_CONFIG.fellow.maxStrikes);
  });
});
