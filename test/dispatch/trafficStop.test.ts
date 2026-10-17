import { describe, expect, it } from 'vitest';
import type { DispatchAckEvent, DispatchArrestEvent, DispatchPersonResultEvent } from '../../src/cad/events';
import { hasGeneratedWarrant } from '../../src/records/person';
import { driverOf, mountedPlate } from '../../src/records/vehicle';
import { isFleetVehicleId, type StopState } from '../../src/traffic/trafficSystem';
import { at, eventsOf, makeHarness, quietConfig, run, runUntil, step, type Harness } from './helpers';

function stopState(): StopState {
  return { vehicleId: -1, eid: 0, phase: 'pulling', x: 0, z: 0, yaw: 0 };
}

/** Makes the nearest ambient car pull over (the player follows it) and returns its registry id. */
async function stopped(): Promise<{ h: Harness; vehicleId: number }> {
  const h = await makeHarness({ config: quietConfig(), density: 1 });
  run(h, 1);
  const v = h.traffic.view;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < v.count; i++) {
    const id = v.vehicleId[i] ?? 0;
    if (isFleetVehicleId(id)) continue;
    const d = Math.hypot((v.x[i] ?? 0) - h.player.x, (v.z[i] ?? 0) - h.player.z);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  if (best < 0 || !h.traffic.forceStop(best)) throw new Error('no car to stop');
  const s = stopState();
  const ok = runUntil(
    h,
    () => {
      if (h.traffic.stopState(s)) {
        h.player.x = s.x - 8;
        h.player.z = s.z;
      }
      return h.cad.trafficStop?.outcome === 'active';
    },
    60,
  );
  if (!ok) throw new Error('car did not pull over');
  return { h, vehicleId: best };
}

describe('traffic stops', () => {
  it("creates a self-initiated stop call on 'traffic:pulledOver' with the player on scene", async () => {
    const { h, vehicleId } = await stopped();
    const info = h.cad.trafficStop;
    expect(info).toMatchObject({
      vehicleId,
      plate: mountedPlate(h.seed, vehicleId).plate,
      trueDriverId: driverOf(h.seed, vehicleId),
      driverId: -1,
      plateRun: false,
      vinChecked: false,
      citations: [],
      outcome: 'active',
    });
    const call = h.cad.call(info?.callId ?? -1);
    expect(call).toMatchObject({ typeId: 'trafficStop', priority: 4, selfInitiated: true, units: ['12'], status: 'active' });
    expect(call?.vehicles).toEqual([vehicleId]);
    expect(call?.caller).toMatchObject({ kind: 'officer', name: 'Unit 12' });
    expect(call?.narrative[0]?.text).not.toMatch(/[{}]/);
    expect(h.cad.playerUnit()?.status).toBe('onScene');
    expect(eventsOf(h, 'cad:trafficStop')).toEqual([{ active: true, callId: call?.id, vehicleId }]);

    h.dispatcher.request('12', { kind: 'trafficStop' }, 'radio');
    step(h);
    expect(eventsOf<DispatchAckEvent>(h, 'dispatch:ack').at(-1)).toMatchObject({ kind: 'trafficStop', ok: true });
    expect(eventsOf<DispatchAckEvent>(h, 'dispatch:ack').at(-1)?.text).toContain(info?.plate ?? '???');
  });

  it('license, plate, VIN and warning contacts; citation recorded; release closes with citationIssued', async () => {
    const { h, vehicleId } = await stopped();
    const info = h.cad.trafficStop;
    if (!info) throw new Error('no stop');
    const call = h.cad.call(info.callId);
    h.dispatcher.request('12', { kind: 'stopContact', action: 'license' }, 'mdt');
    h.dispatcher.request('12', { kind: 'runPlate', plate: info.plate, vehicleId }, 'key');
    h.dispatcher.request('12', { kind: 'stopContact', action: 'vin' }, 'mdt');
    h.dispatcher.request('12', { kind: 'stopContact', action: 'warn' }, 'mdt');
    step(h);
    const stop = h.cad.trafficStop;
    expect(stop?.driverId).toBe(info.trueDriverId);
    expect(call?.persons).toContain(info.trueDriverId);
    const person = eventsOf<DispatchPersonResultEvent>(h, 'dispatch:personResult');
    expect(person).toEqual([{ callsign: '12', via: 'auto', readback: h.records.personSummary(info.trueDriverId) }]);
    expect(stop?.plateRun).toBe(true);
    expect(stop?.vinChecked).toBe(true);
    expect(stop?.vinResult).toMatch(/^VIN \S+: /);
    expect(h.records.person(info.trueDriverId).priors[0]).toMatchObject({ kind: 'warning', ref: call?.number });
    expect(call?.narrative.length).toBeGreaterThanOrEqual(4);

    const doc = h.cad.docs.create(
      'citation',
      { callId: info.callId, personId: info.trueDriverId, vehicleId, plate: info.plate, location: call?.location.text ?? 'x', violations: [{ statuteId: 'TR-301', fine: 150, detail: '45 in a 30' }] },
      at(h.sim),
      'Officer Doe #4071',
    );
    h.cad.docs.finalize(doc.id, at(h.sim));
    step(h);
    expect(h.cad.trafficStop?.citations).toEqual([doc.id]);
    const priors = h.records.person(info.trueDriverId).priors;
    expect(priors.filter((p) => p.ref === doc.id)).toHaveLength(1);
    expect(priors[0]).toMatchObject({ kind: 'citation', ref: doc.id });
    // A second save event for the same document does not duplicate the contact.
    h.bus.emit('cad:documentSaved', { id: doc.id, kind: 'citation', final: true });
    step(h);
    expect(h.records.person(info.trueDriverId).priors.filter((p) => p.ref === doc.id)).toHaveLength(1);

    h.dispatcher.request('12', { kind: 'stopContact', action: 'release' }, 'mdt');
    step(h);
    expect(h.cad.trafficStop?.outcome).toBe('released');
    expect(h.traffic.stopVehicleId).toBe(-1);
    expect(call?.status).toBe('closed');
    expect(call?.disposition).toBe('citationIssued');
    expect(h.cad.playerUnit()?.status).toBe('available');
    expect(eventsOf(h, 'cad:trafficStop').at(-1)).toEqual({ active: false, callId: info.callId, vehicleId });
    step(h);
    h.dispatcher.request('12', { kind: 'stopContact', action: 'vin' }, 'mdt');
    step(h);
    expect(eventsOf<DispatchAckEvent>(h, 'dispatch:ack').at(-1)).toMatchObject({ kind: 'stopContact', ok: false, text: 'No traffic stop' });
  });

  it('warning only -> warningIssued; nothing -> handled', async () => {
    const a = await stopped();
    a.h.dispatcher.request('12', { kind: 'stopContact', action: 'warn' }, 'mdt');
    a.h.dispatcher.request('12', { kind: 'stopContact', action: 'release' }, 'mdt');
    step(a.h);
    expect(a.h.cad.calls().find((c) => c.typeId === 'trafficStop')?.disposition).toBe('warningIssued');
    const b = await stopped();
    b.h.dispatcher.request('12', { kind: 'clearCall', callId: b.h.cad.trafficStop?.callId ?? -1, disposition: 'handled' }, 'mdt');
    step(b.h);
    expect(b.h.cad.trafficStop?.outcome).toBe('released');
    expect(b.h.traffic.stopVehicleId).toBe(-1);
  });

  it('arrest abandons the car, emits dispatch:arrest and keeps the call open; booking serves warrants', async () => {
    const { h } = await stopped();
    const info = h.cad.trafficStop;
    if (!info) throw new Error('no stop');
    h.dispatcher.request('12', { kind: 'stopContact', action: 'arrest' }, 'mdt');
    step(h);
    expect(eventsOf<DispatchArrestEvent>(h, 'dispatch:arrest')).toEqual([{ personId: info.trueDriverId, callId: info.callId }]);
    expect(h.cad.trafficStop?.outcome).toBe('arrest');
    expect(h.traffic.stopVehicleId).toBe(-1);
    const call = h.cad.call(info.callId);
    expect(call?.status).toBe('active');
    step(h);
    // The 'abandoned' release event does not change the outcome.
    expect(h.cad.trafficStop?.outcome).toBe('arrest');

    let wanted = 0;
    while (!hasGeneratedWarrant(h.seed, wanted)) wanted++;
    expect(h.records.person(wanted).warrants.length).toBeGreaterThan(0);
    const booking = h.cad.docs.create('booking', { callId: info.callId, personId: wanted, charges: ['PC-220'], arrestLocation: 'x' }, at(h.sim), 'Officer Doe #4071');
    h.cad.docs.finalize(booking.id, at(h.sim));
    step(h);
    const p = h.records.person(wanted);
    expect(p.warrants).toEqual([]);
    expect(p.priors[0]).toMatchObject({ kind: 'arrest', ref: booking.id });

    h.dispatcher.request('12', { kind: 'clearCall', callId: info.callId, disposition: 'arrestMade' }, 'mdt');
    step(h);
    expect(call?.status).toBe('closed');
    expect(call?.disposition).toBe('arrestMade');
  });

  it("'traffic:released' with reason lost ends the stop", async () => {
    const { h, vehicleId } = await stopped();
    const info = h.cad.trafficStop;
    h.bus.emit('traffic:released', { eid: 0, vehicleId, reason: 'lost' });
    expect(h.cad.trafficStop?.outcome).toBe('active');
    step(h);
    expect(h.cad.trafficStop?.outcome).toBe('lost');
    expect(h.cad.call(info?.callId ?? -1)?.status).toBe('closed');
  });
});
