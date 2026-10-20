import { describe, expect, it } from 'vitest';
import { emptyIncidentsSave, isIncidentsSave, type IncidentsSave } from '../../src/incidents/save';
import { callInfo, key, Rig, said } from './helpers';

function populated(): IncidentsSave {
  const rig = new Rig();
  rig.step();
  rig.world.calls.set(7, callInfo());
  rig.bus.emit('scene:materialized', { callId: 7 });
  said(rig, 7, 5, { tone: 'aggressive' });
  rig.sys.request({ kind: 'report', key: key(7), docId: 'R-1', assertions: ['x'] });
  rig.sys.request({ kind: 'mute', on: true });
  rig.step();
  rig.sys.request({ kind: 'close', key: key(7) });
  return JSON.parse(JSON.stringify(rig.sys.serialize())) as IncidentsSave;
}

describe('IncidentsSave', () => {
  it('the empty save is valid and defaults to the generic jurisdiction', () => {
    const s = emptyIncidentsSave();
    expect(s.jurisdiction).toBe('generic');
    expect(s.nextEventId).toBe(1);
    expect(isIncidentsSave(s)).toBe(true);
    expect(emptyIncidentsSave('strict').jurisdiction).toBe('strict');
    expect(isIncidentsSave(JSON.parse(JSON.stringify(s)))).toBe(true);
  });

  it('a populated save validates', () => {
    const s = populated();
    expect(s.logs).toHaveLength(1);
    expect(s.queue).toHaveLength(1);
    expect(s.personState.length).toBeGreaterThan(0);
    expect(isIncidentsSave(s)).toBe(true);
  });

  it('rejects malformed blocks', () => {
    const mutate = (f: (s: Record<string, unknown>) => void): unknown => {
      const s = populated() as unknown as Record<string, unknown>;
      f(s);
      return s;
    };
    const first = (s: Record<string, unknown>): Record<string, unknown> => (s.logs as Record<string, unknown>[])[0] as Record<string, unknown>;
    const event = (s: Record<string, unknown>): Record<string, unknown> => (first(s).events as Record<string, unknown>[])[1] as Record<string, unknown>;
    const bad: [string, unknown][] = [
      ['null', null],
      ['array', []],
      ['version', mutate((s) => { s.version = 2; })],
      ['jurisdiction', mutate((s) => { s.jurisdiction = 3; })],
      ['nextEventId', mutate((s) => { s.nextEventId = 0; })],
      ['nextAdhoc', mutate((s) => { s.nextAdhoc = 1.5; })],
      ['logs', mutate((s) => { s.logs = {}; })],
      ['log key', mutate((s) => { first(s).key = 4; })],
      ['log closed', mutate((s) => { first(s).closed = 'no'; })],
      ['event kind', mutate((s) => { event(s).kind = 'teleport'; })],
      ['event id', mutate((s) => { event(s).id = 'x'; })],
      ['event t', mutate((s) => { event(s).t = NaN; })],
      ['event cam', mutate((s) => { event(s).cam = 1.5; })],
      ['people', mutate((s) => { first(s).people = [{ personId: 'a' }]; })],
      ['reports', mutate((s) => { first(s).reports = [{ docId: 1 }]; })],
      ['aliases', mutate((s) => { s.aliases = [['a']]; })],
      ['cam', mutate((s) => { s.cam = { body: 1, muted: false, dashManual: false }; })],
      ['violations', mutate((s) => { s.violations = [{ vehicleId: 1 }]; })],
      ['pursuit', mutate((s) => { s.pursuit = { key: 'a' }; })],
      ['assessQueue', mutate((s) => { s.assessQueue = [1]; })],
      ['personState', mutate((s) => { s.personState = [['a', 1, 2]]; })],
      ['queue kind', mutate((s) => { s.queue = [{ kind: 'explode' }]; })],
      ['queue shape', mutate((s) => { s.queue = [{ kind: 'mute', on: 'yes' }]; })],
    ];
    for (const [name, value] of bad) expect(isIncidentsSave(value), name).toBe(false);
  });

  it('accepts every request kind and a pursuit sampler', () => {
    const s = emptyIncidentsSave();
    s.queue = [
      { kind: 'mute', on: true }, { kind: 'dashManual', on: false }, { kind: 'report', key: 'C-00001', docId: 'R-1', assertions: ['a'] },
      { kind: 'jurisdiction', id: 'strict' }, { kind: 'close', key: 'C-00001' },
    ];
    s.pursuit = { key: 'C-00001', callId: 4, nextSampleSim: 12.5, advised: false };
    s.personState = [['C-00001', 5, 2, -1]];
    s.aliases = [['FC-1-1', 'C-00001']];
    s.violations = [{ vehicleId: 3, kind: 'speeding', sim: 4 }];
    expect(isIncidentsSave(s)).toBe(true);
  });
});
