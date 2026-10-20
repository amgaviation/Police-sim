import { describe, expect, it } from 'vitest';
import { isIncidentsSave, type IncidentsSave } from '../../src/incidents/save';
import type { IncidentEvent } from '../../src/legal/types';
import { action, callInfo, consent, cx, DT, fact, item, key, Rig, said } from './helpers';

const K = key(7);

function rigWithCall(): Rig {
  const rig = new Rig();
  rig.world.calls.set(7, callInfo());
  rig.world.roles.set(5, 'suspect');
  rig.bus.emit('scene:materialized', { callId: 7 });
  rig.step();
  return rig;
}

function sorted(events: readonly IncidentEvent[]): boolean {
  for (let i = 1; i < events.length; i++) {
    const a = events[i - 1] as IncidentEvent;
    const b = events[i] as IncidentEvent;
    if (b.t < a.t || (b.t === a.t && b.id <= a.id)) return false;
  }
  return true;
}

describe('camera bits', () => {
  it('every new event carries the current bits and a change appends a cam event to recently active logs only', () => {
    const rig = rigWithCall();
    said(rig, 7, 5);
    expect(rig.of(K, 'question')[0]?.cam).toBe(0);
    rig.bus.emit('investigation:bodycam', { callId: 7, on: true });
    said(rig, 7, 5);
    expect(rig.of(K, 'question')[1]?.cam).toBe(1);
    expect(rig.of(K, 'cam').map((c) => [c.body, c.muted, c.dash, c.cam])).toEqual([[true, false, false, 1]]);
    rig.sys.request({ kind: 'mute', on: true });
    rig.step();
    expect(rig.sys.cam).toMatchObject({ body: true, muted: true, bits: 3 });
    expect(rig.of(K, 'cam')[1]).toMatchObject({ muted: true, cam: 3 });
    // The log has been quiet for more than 120 s: it gets no further camera events.
    rig.seconds(130);
    rig.sys.request({ kind: 'mute', on: false });
    rig.step();
    expect(rig.sys.cam.bits).toBe(1);
    expect(rig.of(K, 'cam').length).toBe(2);
    said(rig, 7, 5);
    expect(rig.of(K, 'question')[2]?.cam).toBe(1);
  });

  it('the dash bit needs the car nearby and lights or the manual switch', () => {
    const rig = rigWithCall();
    said(rig, 7, 5);
    rig.world.dash = { lights: true, nearCar: false };
    rig.step();
    expect(rig.sys.cam.dash).toBe(false);
    rig.world.dash = { lights: true, nearCar: true };
    rig.step();
    expect(rig.sys.cam).toMatchObject({ dash: true, bits: 4 });
    expect(rig.of(K, 'cam')[0]).toMatchObject({ dash: true, cam: 4 });
    rig.world.dash = { lights: false, nearCar: true };
    rig.step();
    expect(rig.sys.cam.dash).toBe(false);
    rig.sys.request({ kind: 'dashManual', on: true });
    rig.step();
    expect(rig.sys.cam.dash).toBe(true);
    expect(rig.of(K, 'cam').map((c) => c.dash)).toEqual([true, false, true]);
  });

  it('a first detention warns once when the worn bodycam is not recording', () => {
    const rig = rigWithCall();
    rig.world.bodycamWorn = true;
    action(rig, 7, 5, 'cuff', { result: 'ok' });
    expect(rig.of(K, 'advisory').map((a) => [a.advisory, a.personId])).toEqual([['activateBodycam', -1]]);
    expect(rig.flashes).toEqual(['Bodycam is not recording (U)']);
    expect(rig.kinds(K)).toEqual(['start', 'person', 'detention', 'advisory', 'arrest']);
    action(rig, 7, 5, 'frisk', {});
    expect(rig.of(K, 'advisory').length).toBe(1);
  });

  it('no warning when the camera records or is not worn', () => {
    const on = rigWithCall();
    on.world.bodycamWorn = true;
    on.bus.emit('investigation:bodycam', { callId: 7, on: true });
    action(on, 7, 5, 'frisk', {});
    expect(on.of(K, 'advisory').length).toBe(0);
    const off = rigWithCall();
    action(off, 7, 5, 'frisk', {});
    expect(off.of(K, 'advisory').length).toBe(0);
  });
});

describe('keys, ad hoc incidents and the current incident', () => {
  it('keyOfCall uses the call number', () => {
    expect(new Rig().sys.keyOfCall(42)).toBe('C-00042');
  });

  it('events without an incident or a current one open an FI log; later ones attach to it', () => {
    const rig = new Rig();
    rig.step();
    said(rig, 0, 5, { ...cx(0, 5), incident: '' });
    expect(rig.sys.keys()).toEqual(['FI-1-1']);
    expect(rig.log('FI-1-1')).toMatchObject({ callId: 0, typeId: 'fieldIncident' });
    expect(rig.kinds('FI-1-1')[0]).toBe('start');
    expect(rig.of('FI-1-1', 'start')[0]?.field).toBe(true);
    said(rig, 0, 5, { incident: '' });
    expect(rig.sys.keys()).toEqual(['FI-1-1']);
  });

  it('current follows the contact, then the player call, then the last active log for 120 s', () => {
    const rig = rigWithCall();
    expect(rig.sys.current).toBe(K);
    rig.seconds(121);
    expect(rig.sys.current).toBe('');
    rig.bus.emit('cad:unitAssigned', { callId: 7, callsign: 'A-12', by: 'dispatch' });
    expect(rig.sys.current).toBe(K);
    rig.bus.emit('cad:unitAssigned', { callId: 9, callsign: 'B-3', by: 'dispatch' });
    expect(rig.sys.current).toBe(K);
    rig.bus.emit('cad:callClosed', { callId: 7, disposition: 'R' });
    expect(rig.sys.current).toBe('');
    rig.world.contact = 'FC-5-1';
    expect(rig.sys.current).toBe('FC-5-1');
  });
});

describe('field log district', () => {
  it('a field contact opens in the district of the officer, and a call log keeps the call district', () => {
    const rig = new Rig();
    rig.world.district = 'harbor';
    rig.world.calls.set(7, callInfo({ typeId: 'disturbance', family: 'disturbance', district: 'suburbs' }));
    said(rig, 0, 5, { ...cx(0, 5, 'suspect', 'FC-5-1') });
    rig.step();
    expect(rig.log('FC-5-1').district).toBe('harbor');
    fact(rig, 7, 6, { incident: K, callId: 7 });
    expect(rig.log(K).district).toBe('suburbs');
  });
});

describe('field contact to call merge', () => {
  it('renames a lone field contact into the call log, keeping ids', () => {
    const rig = new Rig();
    rig.world.calls.set(7, callInfo({ typeId: 'disturbance', family: 'disturbance' }));
    const fc = 'FC-5-1';
    said(rig, 0, 5, { ...cx(0, 5, 'suspect', fc), tone: 'aggressive' });
    rig.step();
    expect(rig.sys.keys()).toEqual([fc]);
    const before = rig.log(fc).events.map((e) => e.id);
    fact(rig, 7, 5, { incident: fc, callId: 7 });
    expect(rig.sys.keys()).toEqual([K]);
    const log = rig.log(K);
    expect(log).toMatchObject({ key: K, callId: 7, typeId: 'disturbance', family: 'disturbance' });
    expect(log.events.map((e) => e.id).slice(0, before.length)).toEqual(before);
    expect(rig.of(K, 'start')[0]).toMatchObject({ callId: 7, field: false, typeId: 'disturbance' });
    expect(rig.sys.serialize().aliases).toEqual([[fc, K]]);
    expect(rig.sys.aggressiveLines(K)).toBe(1);
    expect(rig.sys.log(fc)).toBe(log);
    said(rig, 0, 5, { ...cx(0, 5, 'suspect', fc) });
    expect(rig.sys.keys()).toEqual([K]);
    expect(rig.of(K, 'question').length).toBe(2);
  });

  it('merges into an existing call log sorted by time then id, without a second start or duplicate people', () => {
    const rig = new Rig();
    rig.world.calls.set(7, callInfo());
    const fc = 'FC-5-1';
    said(rig, 0, 5, { ...cx(0, 5, 'suspect', fc) });
    rig.seconds(2);
    rig.bus.emit('scene:materialized', { callId: 7 });
    said(rig, 7, 5);
    rig.seconds(2);
    said(rig, 0, 5, { ...cx(7, 5, 'suspect', fc) });
    expect(rig.sys.keys()).toEqual([K]);
    const log = rig.log(K);
    expect(sorted(log.events)).toBe(true);
    expect(log.events.filter((e) => e.kind === 'start').length).toBe(1);
    expect(log.events.filter((e) => e.kind === 'person').length).toBe(1);
    expect(log.people.length).toBe(1);
    expect(log.events.filter((e) => e.kind === 'question').length).toBe(3);
    const ids = log.events.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a pending closed field contact does not close the call log', () => {
    const rig = new Rig();
    rig.world.calls.set(7, callInfo());
    const fc = 'FC-5-1';
    said(rig, 0, 5, { ...cx(0, 5, 'suspect', fc) });
    rig.sys.request({ kind: 'close', key: fc });
    rig.step();
    rig.bus.emit('scene:materialized', { callId: 7 });
    fact(rig, 7, 5, { incident: fc, callId: 7 });
    expect(rig.log(K).closed).toBe(false);
    expect(rig.kinds(K)).not.toContain('close');
  });
});

describe('closing and the assessment', () => {
  it('closing queues one assessment per step and emits incident:closed with the summary', () => {
    const rig = rigWithCall();
    rig.world.calls.set(8, callInfo());
    rig.bus.emit('scene:materialized', { callId: 8 });
    action(rig, 7, 5, 'frisk', {});
    rig.bus.emit('scene:outcome', { outcome: { callId: 7, disposition: 'R', outcomeId: 'o' } as never });
    rig.bus.emit('scene:outcome', { outcome: { callId: 8, disposition: 'R', outcomeId: 'o' } as never });
    expect(rig.closed).toEqual([]);
    rig.step();
    expect(rig.closed.length).toBe(1);
    expect(rig.closed[0]).toMatchObject({ key: K, callId: 7, unlawful: 1, excessiveForce: 0 });
    expect(rig.closed[0]?.score).toBe(85);
    rig.step();
    expect(rig.closed.map((c) => c.key)).toEqual([K, key(8)]);
    expect(rig.closed[1]).toMatchObject({ unlawful: 0, score: 100 });
    rig.step(5);
    expect(rig.closed.length).toBe(2);
    expect(rig.sys.keys()).toEqual([key(8), K]);
  });

  it('the assessment is cached until an event is appended and is available for open logs', () => {
    const rig = rigWithCall();
    const a1 = rig.sys.assessment(K);
    expect(a1).not.toBeNull();
    expect(rig.sys.assessment(K)).toBe(a1);
    action(rig, 7, 5, 'frisk', {});
    const a2 = rig.sys.assessment(K);
    expect(a2).not.toBe(a1);
    expect(a2?.determinations.some((d) => d.doctrine === 'frisk' && d.outcome === 'unlawful')).toBe(true);
    expect(rig.sys.assessment('C-00099')).toBeNull();
    expect(rig.sys.log('C-00099')).toBeNull();
  });

  it('late events reach a closed log and invalidate its assessment', () => {
    const rig = rigWithCall();
    rig.sys.request({ kind: 'close', key: K });
    rig.step(2);
    const a1 = rig.sys.assessment(K);
    action(rig, 7, 5, 'frisk', {});
    expect(rig.log(K).closed).toBe(true);
    expect(rig.sys.assessment(K)).not.toBe(a1);
    expect(rig.closed.length).toBe(1);
  });

  it('closing twice is a no-op; unknown keys are ignored', () => {
    const rig = rigWithCall();
    rig.sys.request({ kind: 'close', key: K });
    rig.sys.request({ kind: 'close', key: K });
    rig.sys.request({ kind: 'close', key: 'C-00099' });
    rig.step(3);
    expect(rig.of(K, 'close').length).toBe(1);
    expect(rig.closed.length).toBe(1);
  });

  it('field contacts close after 600 s without events unless they are the active contact', () => {
    const rig = new Rig();
    const fc = 'FC-5-1';
    said(rig, 0, 5, { ...cx(0, 5, 'suspect', fc) });
    rig.world.contact = fc;
    rig.seconds(650);
    expect(rig.log(fc).closed).toBe(false);
    rig.world.contact = null;
    rig.seconds(2);
    expect(rig.log(fc).closed).toBe(true);
    expect(rig.of(fc, 'close')[0]).toMatchObject({ disposition: 'ended' });
    expect(rig.closed.map((c) => c.key)).toEqual([fc]);
  });

  it('call logs are not closed by inactivity', () => {
    const rig = rigWithCall();
    rig.seconds(700);
    expect(rig.log(K).closed).toBe(false);
  });
});

describe('requests', () => {
  it('a report is stored per document id, replaced on a repeat and announced', () => {
    const rig = rigWithCall();
    rig.sys.request({ kind: 'report', key: K, docId: 'R-0001', assertions: ['a', 'b'] });
    rig.sys.request({ kind: 'report', key: 'C-00099', docId: 'R-0002', assertions: [] });
    rig.step();
    expect(rig.log(K).reports.map((r) => [r.docId, r.assertions])).toEqual([['R-0001', ['a', 'b']]]);
    rig.sys.request({ kind: 'report', key: K, docId: 'R-0001', assertions: ['c'] });
    rig.step();
    expect(rig.log(K).reports.map((r) => r.assertions)).toEqual([['c']]);
    expect(rig.reports).toEqual([{ key: K, docId: 'R-0001' }, { key: K, docId: 'R-0001' }]);
  });

  it('requests are applied at the next step, not at once', () => {
    const rig = rigWithCall();
    rig.sys.request({ kind: 'jurisdiction', id: 'strict' });
    expect(rig.sys.ruleset.id).toBe('generic');
    rig.step();
    expect(rig.sys.ruleset.id).toBe('strict');
    expect(rig.sys.assessment(K)?.rulesetId).toBe('strict');
    rig.sys.request({ kind: 'jurisdiction', id: 'nowhere' });
    rig.step();
    expect(rig.sys.ruleset.id).toBe('generic');
    expect(rig.sys.assessment(K)?.rulesetId).toBe('generic');
  });
});

describe('report choices', () => {
  it('builds statements of fact from the log, deterministic in the seed and cached per version', () => {
    const make = (): Rig => {
      const rig = rigWithCall();
      rig.world.stop = { personId: 5, vehicleId: 3, callId: 7 };
      rig.bus.emit('cad:trafficStop', { active: true, callId: 7, vehicleId: 3 });
      action(rig, 7, 5, 'cuff', { result: 'ok' });
      return rig;
    };
    const a = make();
    const b = make();
    const ca = a.sys.reportChoices(K);
    expect(ca.length).toBeGreaterThan(0);
    expect(ca.some((c) => c.id === 'arrest:5' && c.truth === 'true' && c.key)).toBe(true);
    expect(b.sys.reportChoices(K)).toEqual(ca);
    expect(a.sys.reportChoices(K)).toBe(ca);
    said(a, 7, 5);
    expect(a.sys.reportChoices(K)).not.toBe(ca);
    expect(a.sys.reportChoices('C-00099')).toEqual([]);
  });
});

describe('pursuit sampling', () => {
  function pursuitRig(speed = 60): Rig {
    const rig = rigWithCall();
    rig.world.stop = { personId: 5, vehicleId: 3, callId: 7 };
    rig.world.pursuit = { speedMph: speed, limitMph: 35, district: 'downtown', wet: false, night: false, lights: true, siren: true };
    rig.bus.emit('dispatch:plateResult', {
      callsign: 'A-12', via: 'radio', vehicleId: 3,
      readback: { plate: 'X', found: true, description: '', owner: '', ownerPersonId: -1, hits: ['STOLEN VEHICLE'], severity: 'alert' },
    });
    rig.bus.emit('scene:pursuit', { kind: 'vehicle', active: true, callId: 20, ownerCallId: 7, personId: 5 });
    return rig;
  }

  it('starts in the log of the owner call and samples once per second while the probe says driving', () => {
    const rig = pursuitRig();
    const start = rig.of(K, 'pursuitStart')[0];
    expect(start).toMatchObject({ personId: 5, pursuit: 'vehicle', pursuitCallId: 20 });
    rig.seconds(5.5);
    const s = rig.of(K, 'pursuitSample');
    expect(s.length).toBe(5);
    for (let i = 1; i < s.length; i++) {
      const dt = (s[i]?.t ?? 0) - (s[i - 1]?.t ?? 0);
      expect(dt).toBeGreaterThanOrEqual(1 - 1e-9);
      expect(dt).toBeLessThan(1 + 2 * DT);
    }
    expect(s[0]).toMatchObject({ personId: 5, speedMph: 60, limitMph: 35, district: 'downtown', lights: true, siren: true });
    rig.world.pursuit = null;
    rig.seconds(3);
    expect(rig.of(K, 'pursuitSample').length).toBe(5);
    expect(rig.advisories).toEqual([]);
  });

  it('advises termination once when the speed policy is broken, with an advisory event', () => {
    const rig = pursuitRig(80);
    rig.seconds(40);
    expect(rig.advisories.length).toBe(1);
    expect(rig.advisories[0]?.advisory).toBe('terminatePursuit');
    expect(rig.advisories[0]?.text).toMatch(/^Supervisor to A-12: terminate the pursuit — Speed stayed above the allowed margin for \d+ s \(limit 20 s\)\.$/);
    expect(rig.of(K, 'advisory').filter((a) => a.advisory === 'terminatePursuit').length).toBe(1);
    const at = rig.of(K, 'advisory').find((a) => a.advisory === 'terminatePursuit');
    expect(at?.personId).toBe(5);
    const firstOver = rig.of(K, 'pursuitSample').findIndex((x) => x.t >= (at?.t ?? 0));
    expect(firstOver).toBeGreaterThanOrEqual(20);
    rig.bus.emit('scene:pursuit', { kind: 'vehicle', active: false, callId: 20, ownerCallId: 7, personId: 5, endReason: 'escaped' });
    const n = rig.of(K, 'pursuitSample').length;
    rig.seconds(3);
    expect(rig.of(K, 'pursuitSample').length).toBe(n);
    expect(rig.of(K, 'pursuitEnd')[0]).toMatchObject({ reason: 'escaped', personId: 5 });
    const ruling = rig.sys.assessment(K)?.pursuits[0];
    expect(ruling?.outcome).toBe('unlawful');
    expect(ruling?.advisoryIgnoredS).toBeGreaterThan(0);
  });

  it('a pursuit for an offense the policy does not allow is advised at the first sample', () => {
    const rig = rigWithCall();
    rig.world.pursuit = { speedMph: 40, limitMph: 35, district: 'downtown', wet: false, night: false, lights: true, siren: true };
    rig.bus.emit('scene:pursuit', { kind: 'vehicle', active: true, callId: 20, ownerCallId: 7, personId: 5 });
    rig.seconds(1.5);
    expect(rig.advisories.length).toBe(1);
    expect(rig.advisories[0]?.text).toContain('Pursuit initiated for Traffic offense');
    rig.seconds(10);
    expect(rig.advisories.length).toBe(1);
  });

  it('a foot pursuit is logged but never sampled; the owner call falls back to the pursuit call', () => {
    const rig = new Rig();
    rig.bus.emit('scene:pursuit', { kind: 'foot', active: true, callId: 8, personId: 5 });
    rig.world.pursuit = { speedMph: 80, limitMph: 35, district: 'downtown', wet: false, night: false, lights: true, siren: true };
    rig.seconds(5);
    const k = key(8);
    expect(rig.kinds(k)).toEqual(['start', 'person', 'pursuitStart']);
    rig.bus.emit('scene:pursuit', { kind: 'foot', active: false, callId: 8, personId: 5, endReason: 'caught' });
    expect(rig.of(k, 'pursuitEnd')[0]?.reason).toBe('caught');
  });

  it('thins samples beyond 240 and never exceeds the event cap', () => {
    const rig = pursuitRig(30);
    rig.seconds(500);
    const n = rig.of(K, 'pursuitSample').length;
    expect(n).toBeGreaterThan(240);
    expect(n).toBeLessThan(500);
    rig.seconds(900);
    expect(rig.log(K).events.length).toBeLessThanOrEqual(600);
  });
});

describe('event cap', () => {
  it('evicts old commands, samples and camera events for new ones and always accepts the close', () => {
    const rig = rigWithCall();
    for (let i = 0; i < 650; i++) rig.bus.emit('scene:command', { callId: 7, personId: 5, actorId: 1, command: 'stop', outcome: 'refuse', sim: rig.sim });
    expect(rig.log(K).events.length).toBe(600);
    rig.bus.emit('force:used', { kind: 'tackle', personId: 5, callId: 7 });
    expect(rig.log(K).events.length).toBe(600);
    expect(rig.of(K, 'force').length).toBe(1);
    for (let i = 0; i < 700; i++) consent(rig, 7, 5, 'pbt');
    expect(rig.log(K).events.length).toBeLessThanOrEqual(600);
    rig.sys.request({ kind: 'close', key: K });
    rig.step();
    expect(rig.log(K).events.at(-1)?.kind).toBe('close');
    expect(sorted(rig.log(K).events)).toBe(true);
  });
});

describe('retention', () => {
  function manyClosed(rig: Rig, n: number): void {
    for (let c = 1; c <= n; c++) {
      rig.world.calls.set(c, callInfo());
      rig.bus.emit('scene:materialized', { callId: c });
      rig.bus.emit('scene:outcome', { outcome: { callId: c, disposition: 'R', outcomeId: 'o' } as never });
      rig.step();
      rig.step();
    }
  }

  it('drops the oldest unreferenced closed logs beyond 24 and respects the keep set', () => {
    const rig = new Rig();
    manyClosed(rig, 30);
    expect(rig.closed.length).toBe(30);
    expect(rig.sys.keys().length).toBe(30);
    rig.sys.retain(new Set([key(1), key(2)]), rig.game);
    const keys = rig.sys.keys();
    expect(keys.length).toBe(24);
    expect(keys).toContain(key(1));
    expect(keys).toContain(key(2));
    expect(keys).not.toContain(key(3));
    expect(keys[0]).toBe(key(30));
    expect(rig.sys.log(key(3))).toBeNull();
  });

  it('drops closed logs older than one game day unless kept, and never open logs', () => {
    const rig = new Rig();
    manyClosed(rig, 3);
    rig.world.calls.set(9, callInfo());
    rig.bus.emit('scene:materialized', { callId: 9 });
    rig.sys.retain(new Set([key(2)]), rig.game + 86400 + 10);
    expect(rig.sys.keys().sort()).toEqual([key(2), key(9)].sort());
  });

  it('keeps queued assessments and cleans the person state of dropped logs', () => {
    const rig = new Rig();
    rig.world.calls.set(1, callInfo());
    rig.bus.emit('scene:materialized', { callId: 1 });
    said(rig, 1, 5, { tone: 'aggressive' });
    rig.bus.emit('scene:outcome', { outcome: { callId: 1, disposition: 'R', outcomeId: 'o' } as never });
    rig.sys.retain(new Set(), rig.game + 3 * 86400);
    expect(rig.sys.keys()).toEqual([key(1)]);
    rig.step();
    rig.sys.retain(new Set(), rig.game + 3 * 86400);
    expect(rig.sys.keys()).toEqual([]);
    expect(rig.sys.serialize().personState).toEqual([]);
  });
});

describe('serialize and restore', () => {
  /** The same world on a fresh bus. */
  function twin(from: Rig): Rig {
    const rig = new Rig();
    rig.world.calls = new Map(from.world.calls);
    rig.world.roles = new Map(from.world.roles);
    rig.world.stop = from.world.stop;
    rig.world.pursuit = from.world.pursuit;
    rig.world.items = new Map(from.world.items);
    rig.sim = from.sim;
    rig.game = from.game;
    return rig;
  }

  function script1(rig: Rig): void {
    rig.world.stop = { personId: 5, vehicleId: 3, callId: 7 };
    rig.bus.emit('investigation:bodycam', { callId: 7, on: true });
    rig.bus.emit('traffic:violation', { eid: 1, vehicleId: 3, kind: 'speeding', x: 0, z: 0, speedMph: 60, limitMph: 30 });
    rig.bus.emit('cad:trafficStop', { active: true, callId: 7, vehicleId: 3 });
    said(rig, 7, 5, { tone: 'aggressive', custody: true });
    fact(rig, 7, 5, { topic: 'drinking', value: 'yes', source: 'evidence', display: 'Odor of alcohol', detail: 'odor of alcohol' });
    fact(rig, 7, 5, { topic: 'drugs', value: 'yes', source: 'evidence', display: 'Found: Small baggie' });
    rig.world.pursuit = { speedMph: 80, limitMph: 35, district: 'downtown', wet: false, night: false, lights: true, siren: true };
    rig.bus.emit('scene:pursuit', { kind: 'vehicle', active: true, callId: 20, ownerCallId: 7, personId: 5 });
    rig.bus.emit('force:applied', {
      seq: 1, tool: 'hands', level: 'hardHands', personId: 5, actorId: 1, callId: 7, resistance: 'assaultive', hit: true, injury: 0, fatal: false,
      cycle: 0, riskFactors: [], distance: 1, restrained: false, sim: rig.sim,
    });
    rig.sys.request({ kind: 'mute', on: true });
    rig.seconds(7.3);
    said(rig, 0, 5, { ...cx(0, 5, 'suspect', 'FC-5-1') });
    rig.sys.request({ kind: 'close', key: 'FC-5-1' });
    rig.sys.request({ kind: 'dashManual', on: true });
  }

  function script2(rig: Rig): void {
    rig.step();
    action(rig, 7, 5, 'frisk', { items: [item('i1')] });
    rig.seconds(30);
    rig.bus.emit('force:used', { kind: 'tackle', personId: 5, callId: 7 });
    rig.world.dash = { lights: true, nearCar: true };
    rig.seconds(25);
    rig.bus.emit('scene:pursuit', { kind: 'vehicle', active: false, callId: 20, ownerCallId: 7, personId: 5, endReason: 'stopped' });
    said(rig, 0, 6, { ...cx(0, 6, 'suspect', 'FC-6-1') });
    rig.bus.emit('scene:outcome', { outcome: { callId: 7, disposition: 'R', outcomeId: 'o' } as never });
    rig.seconds(1);
  }

  it('is valid JSON-clean data accepted by the validator', () => {
    const rig = rigWithCall();
    script1(rig);
    const save = rig.sys.serialize();
    expect(isIncidentsSave(save)).toBe(true);
    const copy = JSON.parse(JSON.stringify(save)) as unknown;
    expect(isIncidentsSave(copy)).toBe(true);
    expect(copy).toEqual(save);
  });

  it('a restored system emits the same events as the original and ends in the same state', () => {
    const a = rigWithCall();
    script1(a);
    const b = twin(a);
    b.sys.restore(JSON.parse(JSON.stringify(a.sys.serialize())) as IncidentsSave);
    expect(b.sys.serialize()).toEqual(a.sys.serialize());
    expect(b.sys.keys()).toEqual(a.sys.keys());
    expect(b.sys.cam).toEqual(a.sys.cam);
    script2(a);
    script2(b);
    expect(b.sys.serialize()).toEqual(a.sys.serialize());
    expect(b.advisories).toEqual(a.advisories.slice(a.advisories.length - b.advisories.length));
    expect(b.closed.map((c) => c.key)).toEqual(a.closed.map((c) => c.key).slice(a.closed.length - b.closed.length));
    expect(b.sys.assessment(K)).toEqual(a.sys.assessment(K));
    expect(b.sys.reportChoices(K)).toEqual(a.sys.reportChoices(K));
    expect(a.of(K, 'pursuitSample').length).toBeGreaterThan(10);
  });

  it('restoring an empty save clears everything; the jurisdiction survives a round trip', () => {
    const rig = rigWithCall();
    rig.sys.request({ kind: 'jurisdiction', id: 'strict' });
    rig.step();
    const save = rig.sys.serialize();
    expect(save.jurisdiction).toBe('strict');
    const other = new Rig();
    other.sys.restore(save);
    expect(other.sys.ruleset.id).toBe('strict');
    expect(other.sys.keys()).toEqual([K]);
    other.sys.restore();
    expect(other.sys.keys()).toEqual([]);
    expect(other.sys.ruleset.id).toBe('generic');
  });

  it('keeps event ids unique and increasing across a restore', () => {
    const a = rigWithCall();
    script1(a);
    const b = twin(a);
    b.sys.restore(a.sys.serialize());
    said(b, 7, 5);
    const ids = b.log(K).events.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Math.max(...ids)).toBe(ids.at(-1));
    const before = Math.max(...a.log(K).events.map((e) => e.id));
    expect(ids.at(-1)).toBeGreaterThan(before);
  });
});

describe('dispose', () => {
  it('unsubscribes from the bus', () => {
    const rig = new Rig();
    expect(rig.bus.listenerCount()).toBeGreaterThan(20);
    const base = rig.bus.listenerCount('incident:closed');
    rig.sys.dispose();
    expect(rig.bus.listenerCount('contact:said')).toBe(0);
    expect(rig.bus.listenerCount('scene:materialized')).toBe(0);
    expect(rig.bus.listenerCount('incident:closed')).toBe(base);
    said(rig, 7, 5);
    expect(rig.sys.keys()).toEqual([]);
  });
});

describe('roles', () => {
  it('the stop driver is the driver whatever the scene role says; other people keep the scene role', () => {
    const rig = new Rig();
    rig.world.calls.set(7, callInfo());
    rig.world.roles.set(5, 'suspect');
    rig.world.roles.set(6, 'passenger');
    rig.world.stop = { personId: 5, vehicleId: 3, callId: 7 };
    said(rig, 7, 6);
    rig.bus.emit('cad:trafficStop', { active: true, callId: 7, vehicleId: 3 });
    expect(rig.log(K).people.map((p) => [p.personId, p.role])).toEqual([[6, 'passenger'], [5, 'driver']]);
    expect(rig.of(K, 'person').map((p) => p.role)).toEqual(['passenger', 'driver']);
  });

  it('an unknown role is filled in by a later payload and never overwritten by it', () => {
    const rig = new Rig();
    rig.world.calls.set(7, callInfo());
    rig.bus.emit('scene:materialized', { callId: 7 });
    said(rig, 7, 5, { role: '' });
    expect(rig.log(K).people[0]?.role).toBe('');
    said(rig, 7, 5, { role: 'witness' });
    expect(rig.log(K).people[0]?.role).toBe('witness');
    expect(rig.of(K, 'person')[0]?.role).toBe('witness');
    said(rig, 7, 5, { role: 'suspect' });
    expect(rig.log(K).people[0]?.role).toBe('witness');
  });

  it('a restored recorder keeps the dash bit of the latest camera event until the probe is read', () => {
    const rig = rigWithCall();
    said(rig, 7, 5);
    rig.world.dash = { lights: true, nearCar: true };
    rig.step();
    expect(rig.sys.cam.dash).toBe(true);
    const other = new Rig();
    other.world.dash = { lights: true, nearCar: true };
    other.sys.restore(rig.sys.serialize());
    expect(other.sys.cam.dash).toBe(true);
    const before = other.log(K).events.length;
    other.step();
    expect(other.log(K).events.length).toBe(before);
  });
});
