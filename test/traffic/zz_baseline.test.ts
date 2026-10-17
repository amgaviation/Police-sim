import { it } from 'vitest';
import { generateCity } from '../../src/world/generate';
import { DT, makeHarness } from './helpers';

it('baseline bench', async () => {
  const city = generateCity(99);
  const h = await makeHarness(city.graph, 99, city);
  h.focus.x = 256; h.focus.z = -512;
  h.sys.densityScale = 3;
  const rush = { hour: 8, isWeekday: true };
  h.sys.populate(h.focus, rush);
  let t = 0;
  for (let i = 0; i < 300; i++) { t += DT; h.sys.step(DT, t, rush, h.focus); h.physics.step(); }
  for (let rep = 0; rep < 3; rep++) {
    let total = 0;
    for (let i = 0; i < 1200; i++) { t += DT; const s = performance.now(); h.sys.step(DT, t, rush, h.focus); total += performance.now() - s; h.physics.step(); }
    console.log('cars', h.sys.activeCount, 'avg ms', (total / 1200).toFixed(4));
  }
}, 60000);
