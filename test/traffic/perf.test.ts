import { describe, expect, it } from 'vitest';
import { vehicleModel } from '../../src/vehicles/model';
import { generateCity } from '../../src/world/generate';
import { DT, makeHarness } from './helpers';

describe('performance with fleet cars', () => {
  it('steps 192 ambient cars + 6 fleet cars (2 code 3, light bar and siren focus) within budget', async () => {
    const city = generateCity(99);
    const h = await makeHarness(city.graph, 99, city);
    h.focus.x = 256;
    h.focus.z = -512;
    h.sys.densityScale = 3;
    const rush = { hour: 8, isWeekday: true };
    h.sys.populate(h.focus, rush);
    const look = { modelIndex: vehicleModel('patrol_sedan').index, color: 0xffffff };
    for (let i = 0; i < 6; i++) expect(h.sys.spawnFleetCar(i, 256 + 120 * Math.cos(i), -512 + 120 * Math.sin(i), look)).toBeGreaterThan(0);
    expect(h.sys.setFleetDestination(0, 900, -900, 'emergency')).toBe(true);
    expect(h.sys.setFleetDestination(1, -400, 0, 'emergency')).toBe(true);
    expect(h.sys.setFleetDestination(2, 0, -1200, 'respond')).toBe(true);
    // The player car has lights and siren on (stop detection and a yield source every step).
    Object.assign(h.focus, { obstacle: true, ox: 256, oz: -512, heading: 0, lights: true, siren: true });
    let t = 0;
    for (let i = 0; i < 300; i++) {
      t += DT;
      h.sys.step(DT, t, rush, h.focus);
      h.physics.step();
    }
    const steps = 1200;
    let best = Infinity;
    for (let rep = 0; rep < 3; rep++) {
      let total = 0;
      for (let i = 0; i < steps; i++) {
        t += DT;
        const start = performance.now();
        h.sys.step(DT, t, rush, h.focus);
        total += performance.now() - start;
        h.physics.step();
      }
      best = Math.min(best, total / steps);
    }
    console.log(`traffic step: ${String(h.sys.activeCount)} cars (6 fleet), ${best.toFixed(4)} ms/step`);
    expect(h.sys.activeCount).toBe(198);
    expect(best).toBeLessThan(3);
    h.physics.dispose();
  }, 60000);
});
