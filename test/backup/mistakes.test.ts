import { describe, expect, it } from 'vitest';
import { ACTOR_STATE } from '../../src/npc/types';
import { mistakeChances, rollMistakes } from '../../src/units/personality';
import { ROSTER_CONFIG } from '../../src/units/data';
import type { OfficerTraits } from '../../src/units/types';
import { Rig, prepare, predictRolls, SEED } from './helpers';

const CALLSIGNS = ['21', '23', '25', '27', '31', '33', '35', '37', '41', '43'];

/** One officer with high stress and fatigue arrives; the contact draws a weapon after 8 s. Returns what is observable. */
function run(seed: number, callsign: string): { mistakes: boolean[]; x: number; z: number; callouts: [number, string, boolean][]; mistakeEvents: string[] } {
  const rig = new Rig({ seed });
  rig.openCall();
  rig.ctx.contactPersonId = 101;
  rig.npc.add({ id: 1, personId: 101, role: 'subject', x: 0, z: -3 });
  prepare(rig, callsign, 0.9, 0.9);
  rig.unitOnScene(callsign, 12, 6, 0);
  rig.step(60 * 8);
  rig.npc.actors.get(1)!.weaponDrawn = true;
  rig.npc.actors.get(1)!.state = ACTOR_STATE.armed;
  rig.step(60 * 14);
  const o = rig.sys.serialize().officers[0]!;
  return {
    mistakes: o.mistakes,
    x: o.x,
    z: o.z,
    callouts: rig.events.filter((e) => e.topic === 'backup:callout').map((e) => [e.sim, (e.payload as { kind: string }).kind, (e.payload as { late: boolean }).late] as [number, string, boolean]),
    mistakeEvents: rig.of<{ kind: string }>('backup:mistake').map((m) => m.kind),
  };
}

describe('mistakes are deterministic per seed', () => {
  it('the same seed gives the same mistakes, positions and callout delays', () => {
    for (const cs of CALLSIGNS) {
      const a = run(SEED, cs);
      const b = run(SEED, cs);
      expect(b).toEqual(a);
    }
  });

  it('matches the pure roll of the units module for the arrival', () => {
    for (const cs of CALLSIGNS) {
      const r = predictRolls(SEED, cs, 0.9, 0.9);
      expect(run(SEED, cs).mistakes).toEqual([r.lateCallout, r.poorPosition, r.excessiveForce]);
    }
  });

  it('another seed differs for at least one of ten officers', () => {
    const a = CALLSIGNS.map((cs) => run(SEED, cs));
    const b = CALLSIGNS.map((cs) => run(2, cs));
    expect(b.some((r, i) => JSON.stringify(r.mistakes) !== JSON.stringify(a[i]!.mistakes))).toBe(true);
    expect(b.some((r, i) => r.x !== a[i]!.x || r.z !== a[i]!.z)).toBe(true);
  });

  it('shows the mistakes that were rolled and no others', () => {
    let late = 0;
    let poor = 0;
    for (const cs of CALLSIGNS) {
      const r = run(SEED, cs);
      expect(r.mistakeEvents.includes('lateCallout')).toBe(r.mistakes[0]);
      expect(r.mistakeEvents.includes('poorPosition')).toBe(r.mistakes[1]);
      expect(r.mistakeEvents.includes('excessiveForce')).toBe(false);
      for (const c of r.callouts) expect(c[2]).toBe(c[1] !== 'covering' && c[1] !== 'inCustody' && r.mistakes[0] && c === r.callouts.find((x) => x[1] !== 'covering' && x[1] !== 'inCustody'));
      if (r.mistakes[0]) late++;
      if (r.mistakes[1]) poor++;
    }
    // stress and fatigue make the mistakes common enough to see within ten officers
    expect(late).toBeGreaterThan(0);
    expect(poor).toBeGreaterThan(0);
  });

  it('a second arrival of the same officer rolls with the next seq', () => {
    const rig = new Rig();
    rig.openCall();
    rig.npc.add({ id: 1, personId: 101, role: 'subject', x: 0, z: -3 });
    prepare(rig, '21', 0.9, 0.9);
    rig.unitOnScene('21', 12, 6, 0);
    rig.step(5);
    const first = rig.sys.serialize().officers[0]!;
    expect(first.seq).toBe(1);
    rig.release('21');
    rig.step(60 * 20);
    expect(rig.sys.serialize().officers.length).toBe(0);
    rig.openCall();
    rig.cad.assign(rig.callId, '21', { sim: rig.sim, game: 0 }, 'dispatch');
    rig.cad.setUnitStatus('21', 'onScene', { sim: rig.sim, game: 0 }, 'auto');
    const chances = mistakeChances(rig.roster.profile('21')!.traits, rig.roster.dynamic('21')!, ROSTER_CONFIG);
    rig.step(5);
    const second = rig.sys.serialize().officers[0]!;
    expect(second.seq).toBe(2);
    const r = rollMistakes(SEED, '21', 2, chances);
    expect(second.mistakes).toEqual([r.lateCallout, r.poorPosition, r.excessiveForce]);
  });
});

describe('a calm, experienced officer', () => {
  const traits: OfficerTraits = { aggression: 0.1, discipline: 0.95, experience: 0.95, composure: 0.95, communication: 0.9 };

  it('makes at most two mistakes in 50 arrivals at the shipped weights', () => {
    const chances = mistakeChances(traits, { stress: 0, fatigue: 0, loyalty: 0.7, calls: 0, mistakes: 0, arrivals: 0 }, ROSTER_CONFIG);
    expect(chances.lateCallout).toBeLessThan(0.02);
    expect(chances.poorPosition).toBeLessThan(0.02);
    expect(chances.excessiveForce).toBeLessThan(0.02);
    let hits = 0;
    for (let seq = 1; seq <= 50; seq++) {
      const r = rollMistakes(SEED, 'CALM', seq, chances);
      if (r.lateCallout || r.poorPosition || r.excessiveForce) hits++;
    }
    expect(hits).toBeLessThanOrEqual(2);
  });

  it('a stressed, tired officer makes many more', () => {
    const calm = mistakeChances(traits, { stress: 0, fatigue: 0, loyalty: 0.7, calls: 0, mistakes: 0, arrivals: 0 }, ROSTER_CONFIG);
    const bad = mistakeChances({ ...traits, experience: 0.1, discipline: 0.3, composure: 0.2 }, { stress: 1, fatigue: 1, loyalty: 0.4, calls: 0, mistakes: 0, arrivals: 0 }, ROSTER_CONFIG);
    let calmHits = 0;
    let badHits = 0;
    for (let seq = 1; seq <= 200; seq++) {
      const c = rollMistakes(SEED, 'X', seq, calm);
      const b = rollMistakes(SEED, 'X', seq, bad);
      if (c.lateCallout || c.poorPosition || c.excessiveForce) calmHits++;
      if (b.lateCallout || b.poorPosition || b.excessiveForce) badHits++;
    }
    expect(badHits).toBeGreaterThan(calmHits + 40);
  });
});
