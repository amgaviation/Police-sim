import { describe, expect, it } from 'vitest';
import { canBeOnRoad } from '../../src/records/vehicle';
import { migrateV3ToV4 } from '../../src/save/migrations';
import { isSaveGameV4, type SaveGameV4 } from '../../src/save/schema';
import { laneRef } from '../../src/world/roadGraph';
import { gridGraph, makeHarness } from '../traffic/helpers';
import { makeSaveGameV3, makeTrafficSnapshot } from './fixtures';

describe('v3 traffic restored into a v4 save', () => {
  it('drops cars that may not be on the road (their own plates reported stolen)', async () => {
    const seed = 42;
    let banned = 0;
    while (canBeOnRoad(seed, banned)) banned++;
    let allowed = banned + 1;
    while (!canBeOnRoad(seed, allowed)) allowed++;
    const base = makeTrafficSnapshot();
    const car = base.cars[0];
    if (!car) throw new Error('fixture has no car');
    const lane = laneRef(0, 0, 0);
    const traffic = { ...base, cars: [{ ...car, vehicleId: banned, lane, s: 30 }, { ...car, vehicleId: allowed, lane, s: 80 }] };
    const migrated = migrateV3ToV4(makeSaveGameV3({ seed, traffic }));
    expect(isSaveGameV4(migrated)).toBe(true);
    const save = migrated as SaveGameV4;
    expect(save.traffic?.cars.map((c) => c.vehicleId)).toEqual([banned, allowed]);

    const h = await makeHarness(gridGraph(), seed);
    h.sys.densityScale = 0;
    if (!save.traffic) throw new Error('no traffic');
    h.sys.restore(save.traffic);
    const ids = h.sys.snapshot().cars.map((c) => c.vehicleId);
    expect(ids).toEqual([allowed]);
  });
});
