import { describe, expect, it } from 'vitest';
import { PULLOVER } from '../../src/traffic/data';
import type { Blockade } from '../../src/traffic/trafficSystem';
import { vehicleModel } from '../../src/vehicles/model';
import { generateCity } from '../../src/world/generate';
import { DT, makeHarness } from './helpers';

/**
 * Steps 192 ambient cars + 6 fleet cars (2 code 3, light bar and siren focus) and returns the best mean step time (ms).
 * With `blockades`, 16 blockades sit on the roads (on cars of the initial population: the cars queue up behind them).
 */
async function measure(blockades: boolean): Promise<{ best: number; active: number }> {
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
  if (blockades) {
    const list: Blockade[] = [];
    for (let i = 0; i < PULLOVER.blockade.max; i++) list.push({ x: h.sys.view.x[i * 6] ?? 0, z: h.sys.view.z[i * 6] ?? 0, radius: 6 });
    h.sys.setBlockades(list);
    expect(h.sys.blockadeCount).toBe(16);
  }
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
  const active = h.sys.activeCount;
  h.physics.dispose();
  return { best, active };
}

describe('performance with fleet cars', () => {
  it('steps 192 ambient cars + 6 fleet cars (2 code 3, light bar and siren focus) within budget', async () => {
    const { best, active } = await measure(false);
    console.log(`traffic step: ${String(active)} cars (6 fleet), ${best.toFixed(4)} ms/step`);
    expect(active).toBe(198);
    expect(best).toBeLessThan(3);
  }, 60000);

  it('stays within the same budget with 16 blockades set', async () => {
    const { best, active } = await measure(true);
    console.log(`traffic step with 16 blockades: ${String(active)} cars (6 fleet), ${best.toFixed(4)} ms/step`);
    // Cars that waited behind a blockade turn around and the density refills the ring: the count stays near the target.
    expect(active).toBeGreaterThan(150);
    expect(best).toBeLessThan(3);
  }, 60000);
});
