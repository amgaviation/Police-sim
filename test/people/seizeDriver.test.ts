import { describe, expect, it } from 'vitest';
import { driverOf } from '../../src/records/vehicle';
import { SEED, makeRig } from './helpers';

describe('seize validates against the driver the items were listed for', () => {
  it('removes scenario-driver items that the registry driver does not carry', () => {
    const rig = makeRig(SEED, 12 * 3600);
    let checked = 0;
    for (let v = 0; v < 300 && checked < 5; v++) {
      const regDriver = driverOf(SEED, v);
      const base = new Set(rig.pop.vehicleItems(v, regDriver).map((i) => i.instance));
      for (let other = 1; other < 2000 && checked < 5; other += 37) {
        const listed = rig.pop.vehicleItems(v, other);
        const extra = listed.find((i) => !base.has(i.instance));
        if (!extra) continue;
        expect(rig.pop.seize({ kind: 'vehicle', id: v }, extra.instance, other)).toBe(true);
        expect(rig.pop.vehicleItems(v, other).some((i) => i.instance === extra.instance)).toBe(false);
        // Without an explicit driver the last listed driver is used.
        const again = rig.pop.vehicleItems(v, other + 1).find((i) => !base.has(i.instance) && i.instance !== extra.instance);
        if (again) expect(rig.pop.seize({ kind: 'vehicle', id: v }, again.instance)).toBe(true);
        checked++;
        break;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
