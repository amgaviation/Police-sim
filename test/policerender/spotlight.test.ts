import { describe, expect, it } from 'vitest';
import { spotlightMount, spotlightPose, type SpotlightPose } from '../../src/render/police/spotlight';
import { cabinBox, spotlightHousing } from '../../src/render/vehicles/carParts';
import { vehicleModel } from '../../src/vehicles/model';

const SEDAN = vehicleModel('patrol_sedan');
const fresh = (): SpotlightPose => ({ x: NaN, y: NaN, z: NaN, dx: NaN, dy: NaN, dz: NaN });

describe('spotlightPose', () => {
  it('starts at the front of the A-pillar housing', () => {
    const mount = spotlightMount(SEDAN);
    const h = spotlightHousing(SEDAN);
    expect(mount).toEqual({ x: h.x, y: h.y, z: h.z - h.sz / 2 });
    expect(mount.x).toBeLessThan(0);
    expect(mount.y).toBeGreaterThan(cabinBox(SEDAN).lowerTop);
    const pose = spotlightPose(mount, 0, 0, fresh());
    expect([pose.x, pose.y, pose.z]).toEqual([mount.x, mount.y, mount.z]);
  });

  it('points ahead at zero yaw/pitch, left for positive yaw and up for positive pitch', () => {
    const m = { x: 0, y: 0, z: 0 };
    const ahead = spotlightPose(m, 0, 0, fresh());
    expect(ahead.dx).toBeCloseTo(0, 12);
    expect(ahead.dy).toBeCloseTo(0, 12);
    expect(ahead.dz).toBeCloseTo(-1, 12);
    const left = spotlightPose(m, Math.PI / 2, 0, fresh());
    expect(left.dx).toBeCloseTo(-1, 12);
    expect(left.dz).toBeCloseTo(0, 12);
    const right = spotlightPose(m, -0.5, 0, fresh());
    expect(right.dx).toBeGreaterThan(0);
    const up = spotlightPose(m, 0.3, 0.2, fresh());
    expect(up.dy).toBeCloseTo(Math.sin(0.2), 12);
    expect(Math.hypot(up.dx, up.dy, up.dz)).toBeCloseTo(1, 12);
    const down = spotlightPose(m, 0, -0.4, fresh());
    expect(down.dy).toBeLessThan(0);
  });
});
