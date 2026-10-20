import { describe, expect, it } from 'vitest';
import { clearOrder } from '../../src/backup/swat';
import { generateInterior } from '../../src/interior/generate';
import { ACTOR_STATE } from '../../src/npc/types';
import { cityBuildings, indexFor, SEED as CITY_SEED } from '../interior/helpers';
import { DT, Rig } from './helpers';

/** Eight officers on foot plus a SWAT team clearing a house, with a handful of scene actors. */
function crowded(): Rig {
  const info = cityBuildings(indexFor(), 3).find((b) => b.kind === 'house')!;
  const layout = generateInterior(CITY_SEED, info)!;
  const rig = new Rig();
  const callId = rig.openCall();
  rig.buildings.set(info.id, { minX: info.minX, minZ: info.minZ, maxX: info.maxX, maxZ: info.maxZ, door: info.door });
  rig.interiors.layouts.set(info.id, layout);
  rig.callBuildingId = info.id;
  rig.swatCount = 1;
  rig.ctx.x = info.door.x;
  rig.ctx.z = info.door.z;
  rig.ctx.contactPersonId = 101;
  rig.npc.add({ id: 1, personId: 101, role: 'subject', x: info.door.x, z: info.door.z - 3 });
  rig.npc.add({ id: 2, personId: 102, role: 'passenger', x: info.door.x + 5, z: info.door.z - 1, state: ACTOR_STATE.hold });
  for (let i = 3; i < 10; i++) rig.npc.add({ id: i, personId: 100 + i, role: 'bystander', x: info.door.x + i * 2, z: info.door.z + 4 });
  for (let i = 0; i < 8; i++) rig.unitOnScene(`P${i}`, info.door.x + 10 + i, info.door.z + 8, 0);
  rig.unitOnScene('TAC-1', info.door.x + 3, info.door.z + 20, 0, 'resource');
  const main = layout.doors.find((d) => d.main)!;
  const order = clearOrder(layout, main.a);
  const r = layout.rooms[order[order.length - 1]!]!.rect;
  // a subject that never surrenders keeps the team clearing for the whole measurement
  rig.npc.add({ id: 7, personId: 555, role: 'subject', building: info.id, callId, x: (r.minX + r.maxX) / 2, z: (r.minZ + r.maxZ) / 2, state: ACTOR_STATE.hold });
  rig.sys.request({ kind: 'swat', callId, command: 'stack', plan: { tempo: 'deliberate' } });
  rig.step(60 * 30);
  rig.sys.request({ kind: 'swat', callId, command: 'clear' });
  rig.step(60 * 10);
  return rig;
}

describe('performance', () => {
  it('8 officers + 4 operators: step <= 0.05 ms on average', () => {
    const rig = crowded();
    expect(rig.sys.officers().length).toBe(8);
    expect(rig.sys.swatPhase(rig.callId)).toBe('clearing');
    // warm up the JIT, then time many steps
    rig.step(600);
    const n = 6000;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      rig.sim += DT;
      rig.sys.step(DT, { sim: rig.sim, game: 50400 + rig.sim * 30 }, rig.ctx);
    }
    const avg = (performance.now() - t0) / n;
    expect(rig.sys.swatPhase(rig.callId)).not.toBe('done');
    expect(avg).toBeLessThanOrEqual(0.05);
  });
});
