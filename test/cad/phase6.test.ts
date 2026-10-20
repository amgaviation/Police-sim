import { describe, expect, it } from 'vitest';
import { CadState, isCadSave } from '../../src/cad/cadState';
import type { UnitKind, UnitRequest } from '../../src/cad/types';
import { at, addRoster, newCall, recordingCad } from './helpers';

function json<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

describe('resource units (Phase 6)', () => {
  it('adds a resource unit with its own kind and fleet index', () => {
    const { cad } = recordingCad();
    addRoster(cad);
    const kind: UnitKind = 'resource';
    const added = cad.addUnit({ callsign: 'K9-1', kind, officer: 'Officer Rex', beat: 'downtown', fleetIndex: 8 }, at(0));
    expect(added.kind).toBe('resource');
    const u = cad.unit('K9-1');
    expect(u?.kind).toBe('resource');
    expect(u?.status).toBe('available');
  });

  it('round-trips a resource unit (on a call, with a position) through serialize / restore and the validator', () => {
    const { cad } = recordingCad();
    addRoster(cad);
    cad.addUnit({ callsign: 'MEDIC-1', kind: 'resource', officer: 'Paramedic Lee', beat: 'hospital', fleetIndex: 9 }, at(0));
    const call = cad.createCall(newCall('overdose', 2), at(1));
    expect(cad.assign(call.id, 'MEDIC-1', at(2), 'dispatch')).toBe(true);
    cad.setUnitStatus('MEDIC-1', 'enRoute', at(3), 'auto');
    cad.setUnitPosition('MEDIC-1', 120.5, -40.25);
    const save = cad.serialize();
    expect(isCadSave(save)).toBe(true);
    const copy = json(save);
    expect(isCadSave(copy)).toBe(true);
    const restored = new CadState();
    restored.restore(copy);
    const u = restored.unit('MEDIC-1');
    expect(u).toMatchObject({ kind: 'resource', status: 'enRoute', callId: call.id, x: 120.5, z: -40.25, fleetIndex: 9 });
    expect(restored.serialize()).toEqual(save);
  });

  it('still rejects an unknown unit kind', () => {
    const { cad } = recordingCad();
    addRoster(cad);
    const copy = json(cad.serialize());
    (copy.units[1] as { kind: string }).kind = 'robot';
    expect(isCadSave(copy)).toBe(false);
  });

  it('knows the resource unit request shape', () => {
    const r: UnitRequest = { kind: 'resource', typeId: 'k9' };
    expect(r.kind).toBe('resource');
  });
});
