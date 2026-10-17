import { afterAll, describe, expect, it } from 'vitest';
import { makeRig, type NpcRig } from './helpers';

const rigs: NpcRig[] = [];
afterAll(() => {
  for (const r of rigs) r.traffic.physics.dispose();
});

describe('scenario occupant overrides', () => {
  it('are forgotten once the car is out of traffic and the grace period has passed', async () => {
    const r = await makeRig({ density: 0 });
    rigs.push(r);
    r.people.setCustody(11, 'jailed');
    r.people.setDeceased(12);
    r.npc.setOccupants(5, [11, 12]);
    expect(r.npc.occupantsOf(5)).toEqual([11, 12]);
    r.run(1200);
    expect(r.npc.occupantsOf(5)).not.toEqual([11, 12]);
    expect(r.npc.serialize().occupants.some(([vid]) => vid === 5)).toBe(false);
  });

  it('are capped in the save, oldest first', async () => {
    const r = await makeRig({ density: 0 });
    rigs.push(r);
    for (let i = 0; i < 500; i++) r.npc.setOccupants(i, [100 + i]);
    const save = r.npc.serialize();
    expect(save.occupants.length).toBeLessThanOrEqual(64);
    expect(save.occupants.at(-1)?.[0]).toBe(499);
  });

  it('generated occupants skip people who are jailed, dead or missing', async () => {
    const r = await makeRig({ density: 0 });
    rigs.push(r);
    const vid = 100;
    const before = [...r.npc.occupantsOf(vid)];
    expect(before.length).toBeGreaterThan(0);
    const driver = before[0] as number;
    r.people.setCustody(driver, 'jailed');
    expect(r.npc.occupantsOf(vid)).not.toContain(driver);
    expect(r.npc.occupantsOf(vid).length).toBe(before.length - 1);
  });
});
