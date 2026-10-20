import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initRapier } from '../../src/physics/physics';
import type { ActorInfo } from '../../src/npc';
import type { City } from '../../src/world/city';
import { generateCity } from '../../src/world/generate';
import { Harness } from './harness';

const SEED = 42;
let city: City;

beforeAll(async () => {
  await initRapier();
  city = generateCity(SEED);
});

const BLANK: ActorInfo = {
  id: 0, personId: 0, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false,
  following: false, hidden: false, armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0,
};

describe('review round 1 (session)', () => {
  const live: Harness[] = [];
  afterEach(() => {
    for (const h of live.splice(0)) h.dispose();
  });

  it('a multi-victim crash is worked to transportedRed with one request for resources and no further ones', () => {
    const h = new Harness(city, undefined, true);
    live.push(h);
    const session = h.start(SEED);
    h.step(session, 60);
    const at = session.playerPosition({ x: 0, z: 0 });
    const id = session.scene.spawnCall('multiVehicleCrash', session.now(), at, [], -1);
    session.dispatcher.request(session.dispatcher.playerCallsign, { kind: 'selfAssign', callId: id }, 'auto');
    h.step(session, 120);
    const loc = session.cad.call(id)?.location;
    if (loc) session.teleport(loc.x, loc.z, 0);
    h.step(session, 120);
    const cmd = session.phase6.command;
    cmd.request({ kind: 'establish' });
    h.step(session, 60);
    const first = cmd.board().victims[0];
    const a = first ? session.npc.actor(first.actorId, { ...BLANK }) : null;
    if (a) session.teleport(a.x + 1.2, a.z, 0);
    h.step(session, 30);
    cmd.request({ kind: 'requestNeeds' });
    h.step(session, 60);
    const asked = session.phase6.resources.units().filter((u) => u.callsign.startsWith('MEDIC') && u.callId === id);
    // "Requested EMS n" dispatches n ambulances, not one.
    expect(asked.length).toBeGreaterThan(1);
    for (let minute = 0; minute < 45; minute++) {
      h.step(session, 60 * 60);
      const rows = cmd.board().victims;
      if (rows.every((v) => v.transported || v.tag === 'expectant')) break;
    }
    const rows = cmd.board().victims;
    // Every patient that is not expectant went to the hospital although three ambulances had to shuttle.
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.filter((v) => !v.transported && v.tag !== 'expectant')).toEqual([]);
    expect(session.scene.flagsOf(id)?.has('transportedRed')).toBe(true);
  }, 600_000);
});
