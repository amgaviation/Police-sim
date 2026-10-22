import { describe, expect, it } from 'vitest';
import { action, callInfo, consent, cx, drugs, fact, item, key, Rig, said } from './helpers';

const K = key(7);

/** A rig with call 7 open (materialized) and person 5 known as a suspect. */
function rigWithCall(over: Parameters<typeof callInfo>[0] = {}): Rig {
  const rig = new Rig();
  rig.world.calls.set(7, callInfo(over));
  rig.world.roles.set(5, 'suspect');
  rig.bus.emit('scene:materialized', { callId: 7 });
  rig.step();
  return rig;
}

describe('row scene:materialized', () => {
  it('appends start, exigency, warrants, then the call indicators of each suspect', () => {
    const rig = new Rig();
    rig.world.calls.set(7, callInfo({ exigency: true, warrant: true, suspects: [3], weaponReported: true, family: 'weapons', typeId: 'weaponsCall' }));
    rig.bus.emit('scene:materialized', { callId: 7 });
    expect(rig.opened).toEqual([K]);
    expect(rig.kinds(K)).toEqual(['start', 'exigency', 'warrant', 'warrant', 'person', 'indicator', 'indicator']);
    const log = rig.log(K);
    expect(log.family).toBe('weapons');
    expect(log.typeId).toBe('weaponsCall');
    expect(log.district).toBe('downtown');
    expect(rig.of(K, 'exigency')[0]?.reason).toBe('call');
    expect(rig.of(K, 'warrant').map((w) => w.scope)).toEqual(['search', 'arrest']);
    expect(rig.of(K, 'indicator').map((i) => [i.personId, i.indicator, i.source])).toEqual([[3, 'callSuspect', 'call'], [3, 'weaponCall', 'call']]);
  });

  it('is idempotent and starts a plain call with a single start event', () => {
    const rig = rigWithCall();
    expect(rig.kinds(K)).toEqual(['start']);
    rig.bus.emit('scene:materialized', { callId: 7 });
    expect(rig.kinds(K)).toEqual(['start']);
    const again = new Rig();
    again.world.calls.set(7, callInfo({ exigency: true }));
    again.bus.emit('scene:materialized', { callId: 7 });
    again.bus.emit('scene:materialized', { callId: 7 });
    expect(again.kinds(K)).toEqual(['start', 'exigency']);
  });

  it('a reported weapon without suspects applies to the whole incident', () => {
    const rig = rigWithCall({ weaponReported: true });
    expect(rig.indicators(K)).toEqual(['-1:weaponCall']);
    rig.bus.emit('scene:materialized', { callId: 7 });
    expect(rig.indicators(K)).toEqual(['-1:weaponCall']);
  });
});

describe('rows traffic:violation and cad:trafficStop', () => {
  it('a stop appends indicators for the ring and the observed kinds, then the detention', () => {
    const rig = new Rig();
    rig.world.calls.set(7, callInfo());
    rig.world.roles.set(5, 'driver');
    rig.world.stop = { personId: 5, vehicleId: 3, callId: 7 };
    rig.world.observed = { redLight: 1 };
    const v = (vehicleId: number, kind: 'speeding' | 'weaving' | 'redLight'): void =>
      rig.bus.emit('traffic:violation', { eid: 1, vehicleId, kind, x: 0, z: 0, speedMph: 50, limitMph: 30 });
    v(3, 'speeding');
    v(3, 'speeding');
    v(3, 'weaving');
    v(4, 'speeding');
    expect(rig.sys.keys()).toEqual([]);
    rig.bus.emit('cad:trafficStop', { active: true, callId: 7, vehicleId: 3 });
    expect(rig.kinds(K)).toEqual(['start', 'person', 'indicator', 'indicator', 'indicator', 'detention']);
    expect(rig.of(K, 'indicator').map((i) => [i.personId, i.indicator, i.source])).toEqual([
      [5, 'speeding', 'observation'], [5, 'weaving', 'observation'], [5, 'trafficViolation', 'observation'],
    ]);
    expect(rig.of(K, 'detention')[0]?.how).toBe('trafficStop');
    expect(rig.of(K, 'person')[0]).toMatchObject({ personId: 5, role: 'driver' });
    rig.bus.emit('cad:trafficStop', { active: true, callId: 7, vehicleId: 3 });
    expect(rig.kinds(K).length).toBe(6);
  });

  it('violations older than 300 s are not counted and the ring keeps 64', () => {
    const rig = new Rig();
    rig.world.calls.set(7, callInfo());
    rig.world.stop = { personId: 5, vehicleId: 3, callId: 7 };
    rig.bus.emit('traffic:violation', { eid: 1, vehicleId: 3, kind: 'speeding', x: 0, z: 0, speedMph: 50, limitMph: 30 });
    rig.seconds(301);
    rig.bus.emit('cad:trafficStop', { active: true, callId: 7, vehicleId: 3 });
    expect(rig.indicators(K)).toEqual([]);
    for (let i = 0; i < 100; i++) rig.bus.emit('traffic:violation', { eid: 1, vehicleId: 9, kind: 'weaving', x: 0, z: 0, speedMph: 50, limitMph: 30 });
    expect(rig.sys.serialize().violations.length).toBe(64);
  });

  it('an inactive stop appends nothing', () => {
    const rig = new Rig();
    rig.bus.emit('cad:trafficStop', { active: false, callId: 7, vehicleId: 3 });
    expect(rig.sys.keys()).toEqual([]);
  });
});

describe('rows dispatch:plateResult and dispatch:personResult', () => {
  const plate = (hits: string[], callsign = 'A-12'): Parameters<Rig['bus']['emit']>[1] =>
    ({ callsign, via: 'radio', vehicleId: 3, readback: { plate: 'ABC123', found: true, description: '', owner: '', ownerPersonId: -1, hits, severity: 'alert' } }) as never;

  it('maps hit prefixes to incident-wide lookup indicators of the stop incident', () => {
    const rig = rigWithCall();
    rig.world.stop = { personId: 5, vehicleId: 3, callId: 7 };
    rig.bus.emit('dispatch:plateResult', plate(['STOLEN VEHICLE', 'REGISTRATION EXPIRED 03/26', 'NO INSURANCE ON FILE', 'RO WANTED: THEFT (CITY)', 'DESCRIPTION MISMATCH: RETURNS TO X', 'PLATES REPORTED STOLEN', 'BOLO: RED CAR']) as never);
    expect(rig.of(K, 'indicator').map((i) => [i.personId, i.indicator, i.source])).toEqual([
      [-1, 'stolenVehicle', 'lookup'], [-1, 'expiredRegistration', 'lookup'], [-1, 'ownerWarrant', 'lookup'], [-1, 'plateMismatch', 'lookup'],
      [-1, 'stolenPlate', 'lookup'], [-1, 'boloMatch', 'lookup'],
    ]);
  });

  it('ignores other callsigns and repeated runs', () => {
    const rig = rigWithCall();
    rig.world.stop = { personId: 5, vehicleId: 3, callId: 7 };
    rig.bus.emit('dispatch:plateResult', plate(['STOLEN VEHICLE'], 'B-9') as never);
    expect(rig.indicators(K)).toEqual([]);
    rig.bus.emit('dispatch:plateResult', plate(['STOLEN VEHICLE']) as never);
    rig.bus.emit('dispatch:plateResult', plate(['STOLEN VEHICLE']) as never);
    expect(rig.indicators(K)).toEqual(['-1:stolenVehicle']);
  });

  it('a run before the stop is replayed when the stop starts', () => {
    const rig = new Rig();
    rig.world.calls.set(7, callInfo());
    rig.bus.emit('dispatch:plateResult', plate(['STOLEN VEHICLE']) as never);
    expect(rig.sys.keys()).toEqual([]);
    rig.world.stop = { personId: 5, vehicleId: 3, callId: 7 };
    rig.bus.emit('cad:trafficStop', { active: true, callId: 7, vehicleId: 3 });
    expect(rig.kinds(K)).toEqual(['start', 'person', 'indicator', 'detention']);
    expect(rig.indicators(K)).toEqual(['-1:stolenVehicle']);
  });

  it('person hits go to the current incident for the readback person', () => {
    const rig = rigWithCall();
    rig.world.contact = K;
    rig.bus.emit('dispatch:personResult', {
      callsign: 'A-12', via: 'radio',
      readback: { personId: 5, name: 'DOE, J', dob: '', dl: '', dlStatus: '', hits: ['WARRANT: THEFT - CITY - BAIL $500', 'BOLO: TALL', 'NO LICENSE ON FILE', 'LICENSE EXPIRED 01/26'], severity: 'alert' },
    });
    expect(rig.of(K, 'indicator').map((i) => [i.personId, i.indicator, i.source])).toEqual([
      [5, 'warrantHit', 'lookup'], [5, 'boloMatch', 'lookup'], [5, 'licenseInvalid', 'lookup'],
    ]);
    expect(rig.kinds(K)[1]).toBe('person');
  });

  it('person hits without any incident are dropped', () => {
    const rig = new Rig();
    rig.bus.emit('dispatch:personResult', {
      callsign: 'A-12', via: 'radio',
      readback: { personId: 5, name: 'DOE, J', dob: '', dl: '', dlStatus: '', hits: ['WARRANT: X'], severity: 'alert' },
    });
    expect(rig.sys.keys()).toEqual([]);
  });
});

describe('row contact:fact', () => {
  it('a claim becomes a statement, then its indicator linked to the statement', () => {
    const rig = rigWithCall();
    said(rig, 7, 5, { custody: true });
    fact(rig, 7, 5, { topic: 'drinking', value: 'yes', source: 'claim', display: 'Says: two beers' });
    expect(rig.kinds(K)).toEqual(['start', 'person', 'question', 'statement', 'indicator']);
    const st = rig.of(K, 'statement')[0];
    expect(st).toMatchObject({ personId: 5, fact: 'drinking', value: 'yes', custody: true });
    const ind = rig.of(K, 'indicator')[0];
    expect(ind).toMatchObject({ indicator: 'admissionDrinking', source: 'statement', sourceEvent: st?.id });
  });

  it('a claim of "no" is a statement without an indicator, and an injured victim claim maps by role', () => {
    const rig = rigWithCall();
    fact(rig, 7, 5, { value: 'no' });
    expect(rig.indicators(K)).toEqual([]);
    rig.world.roles.set(6, 'victim');
    fact(rig, 7, 6, { topic: 'injured', value: 'yes', role: 'victim' });
    expect(rig.indicators(K)).toEqual(['6:victimInjury']);
    fact(rig, 7, 5, { topic: 'injured', value: 'yes', role: 'suspect' });
    expect(rig.indicators(K)).toEqual(['6:victimInjury']);
  });

  it('odor facts become observation indicators at once', () => {
    const rig = rigWithCall();
    fact(rig, 7, 5, { topic: 'drinking', value: 'yes', source: 'evidence', display: 'Odor of alcohol', detail: 'odor of alcohol' });
    fact(rig, 7, 5, { topic: 'drugs', value: 'yes', source: 'evidence', display: 'Odor of cannabis', detail: 'odor of cannabis' });
    expect(rig.of(K, 'indicator').map((i) => [i.indicator, i.source, i.sourceEvent])).toEqual([['odorAlcohol', 'observation', -1], ['odorCannabis', 'observation', -1]]);
  });

  it('a test fact waits for its test action and then points at the test event (test before indicator)', () => {
    const rig = rigWithCall();
    fact(rig, 7, 5, { topic: 'drinking', value: 'heavy', source: 'evidence', display: 'Breath test 0.110', detail: 'PBT 0.110' });
    expect(rig.indicators(K)).toEqual([]);
    action(rig, 7, 5, 'pbt', { result: 'over' });
    expect(rig.kinds(K)).toEqual(['start', 'person', 'test', 'indicator']);
    expect(rig.of(K, 'indicator')[0]).toMatchObject({ indicator: 'bacOver', source: 'test', sourceEvent: rig.of(K, 'test')[0]?.id });
  });

  it('a breath test below the limit and sobriety facts', () => {
    const rig = rigWithCall();
    fact(rig, 7, 5, { topic: 'drinking', value: 'yes', source: 'evidence', display: 'Breath test 0.050' });
    action(rig, 7, 5, 'pbt', { result: 'under' });
    expect(rig.indicators(K)).toEqual([]);
    fact(rig, 7, 5, { topic: 'drinking', value: 'yes', source: 'evidence', display: 'Failed sobriety tests' });
    action(rig, 7, 5, 'sfstResult', { result: 'fail' });
    expect(rig.of(K, 'indicator').map((i) => [i.indicator, i.sourceEvent])).toEqual([['sfstFail', rig.of(K, 'test')[1]?.id]]);
  });

  it('found-item facts wait for the frisk or search and point at it', () => {
    const rig = rigWithCall();
    fact(rig, 7, 5, { topic: 'weapons', value: 'yes', source: 'evidence', display: 'Weapon found: Folding knife', detail: 'folding knife found during a frisk' });
    fact(rig, 7, 5, { topic: 'drugs', value: 'yes', source: 'evidence', display: 'Found: Small baggie', detail: 'small baggie found during a frisk' });
    action(rig, 7, 5, 'frisk', { items: [item('i1'), drugs('i2')] });
    const frisk = rig.of(K, 'frisk')[0];
    expect(rig.kinds(K)).toEqual(['start', 'person', 'frisk', 'indicator', 'indicator']);
    expect(rig.of(K, 'indicator').map((i) => [i.indicator, i.source, i.sourceEvent])).toEqual([
      ['weaponFound', 'evidence', frisk?.id], ['contrabandFound', 'evidence', frisk?.id],
    ]);
  });

  it('a stale pending fact is linked to a matching event of the last 5 s, else to none', () => {
    const rig = rigWithCall();
    action(rig, 7, 5, 'searchVehicle', { items: [], vehicleId: 2 });
    fact(rig, 7, 5, { topic: 'drugs', value: 'yes', source: 'evidence', display: 'Found: Small baggie' });
    rig.step();
    expect(rig.of(K, 'indicator')[0]?.sourceEvent).toBe(rig.of(K, 'search')[0]?.id);
    rig.seconds(10);
    fact(rig, 7, 5, { topic: 'weapons', value: 'yes', source: 'evidence', display: 'Weapon found: knife' });
    rig.step();
    expect(rig.of(K, 'indicator')[1]?.sourceEvent).toBe(-1);
  });

  it('ignores facts without a person and booking facts', () => {
    const rig = new Rig();
    rig.bus.emit('contact:fact', { ...cx(0, -1, ''), topic: 'identity', value: '1', source: 'booking', display: 'x', detail: '', sim: 1 });
    fact(rig, 7, 5, { source: 'booking' });
    expect(rig.sys.keys()).toEqual([]);
  });
});

describe('row contact:said', () => {
  it('an ask becomes a question', () => {
    const rig = rigWithCall();
    said(rig, 7, 5, { fact: 'weapons', utteranceId: 'askWeapons', custody: true, gunpoint: true });
    expect(rig.of(K, 'question')[0]).toMatchObject({ personId: 5, fact: 'weapons', utterance: 'askWeapons', custody: true, gunpoint: true });
  });

  it('a complied detaining command becomes a command and a detention, once', () => {
    const rig = rigWithCall();
    said(rig, 7, 5, { intent: 'command', command: 'stepOut', outcome: 'comply', fact: null });
    said(rig, 7, 5, { intent: 'command', command: 'handsUp', outcome: 'comply', fact: null });
    expect(rig.kinds(K)).toEqual(['start', 'person', 'command', 'detention', 'command']);
    expect(rig.of(K, 'detention')[0]?.how).toBe('command');
    expect(rig.of(K, 'command').map((c) => [c.command, c.outcome])).toEqual([['stepOut', 'comply'], ['handsUp', 'comply']]);
  });

  it('refused, non-detaining and other intents do not detain', () => {
    const rig = rigWithCall();
    said(rig, 7, 5, { intent: 'command', command: 'stop', outcome: 'refuse', fact: null });
    said(rig, 7, 5, { intent: 'command', command: 'dropWeapon', outcome: 'comply', fact: null });
    said(rig, 7, 5, { intent: 'greet', fact: null });
    expect(rig.kinds(K)).toEqual(['start', 'person', 'command', 'command']);
  });

  it('aggressive lines are counted per person and carried by the consent event', () => {
    const rig = rigWithCall();
    said(rig, 7, 5, { tone: 'aggressive' });
    said(rig, 7, 5, { tone: 'aggressive' });
    said(rig, 7, 5, { tone: 'polite' });
    expect(rig.sys.aggressiveLines(K)).toBe(2);
    consent(rig, 7, 5, 'searchVehicle');
    expect(rig.of(K, 'consent')[0]?.aggressiveLines).toBe(2);
  });
});

describe('row contact:consent', () => {
  it('appends a consent with the weapon state of the officer', () => {
    const rig = rigWithCall();
    consent(rig, 7, 5, 'pbt');
    rig.world.weapon = 'sidearm';
    consent(rig, 7, 5, 'searchPerson', { granted: false, valid: false, buildingId: 4 });
    const [a, b] = rig.of(K, 'consent');
    expect(a).toMatchObject({ consent: 'pbt', granted: true, valid: true, weaponDrawn: false, buildingId: -1 });
    expect(b).toMatchObject({ consent: 'searchPerson', granted: false, valid: false, weaponDrawn: true, buildingId: 4 });
  });
});

describe('row contact:action', () => {
  it('frisk and the two searches', () => {
    const rig = rigWithCall();
    action(rig, 7, 5, 'frisk', { items: [item('i1')] });
    action(rig, 7, 5, 'searchPerson', { items: [drugs('i2')] });
    action(rig, 7, 5, 'searchVehicle', { items: [], vehicleId: 4 });
    expect(rig.of(K, 'frisk')[0]?.found.map((f) => f.ref)).toEqual(['i1']);
    expect(rig.of(K, 'search').map((s) => [s.target, s.claimedBasis, s.vehicleId, s.buildingId, s.found.length])).toEqual([
      ['person', null, -1, -1, 1], ['vehicle', null, 4, -1, 0],
    ]);
  });

  it('a failed action appends nothing', () => {
    const rig = rigWithCall();
    action(rig, 7, 5, 'frisk', { ok: false });
    action(rig, 7, 5, 'cuff', { ok: false, result: 'resist' });
    expect(rig.kinds(K)).toEqual(['start']);
  });

  it('visualCheck turns incriminating items into plain-view indicators (weapons weaponSeen)', () => {
    const rig = rigWithCall();
    fact(rig, 7, 5, { topic: 'weapons', value: 'yes', source: 'evidence', display: 'Weapon found: Folding knife' });
    action(rig, 7, 5, 'visualCheck', {
      items: [item('i1'), drugs('i2'), { ref: 'i3', item: 'cup', label: 'Cup', category: 'misc', weapon: false, incriminating: false }],
    });
    expect(rig.of(K, 'indicator').map((i) => [i.indicator, i.source, i.detail])).toEqual([
      ['weaponSeen', 'observation', 'Folding knife (i1)'], ['contrabandPlainView', 'observation', 'Small baggie (i2)'],
    ]);
    rig.step();
    expect(rig.of(K, 'indicator').length).toBe(2);
  });

  it('pbt and sfstResult become tests', () => {
    const rig = rigWithCall();
    action(rig, 7, 5, 'pbt', { result: 'over' });
    action(rig, 7, 5, 'sfstResult', { result: 'pass' });
    action(rig, 7, 5, 'pbt', { result: null });
    expect(rig.of(K, 'test').map((t) => [t.test, t.result])).toEqual([['pbt', 'over'], ['sfst', 'pass']]);
  });

  it('cuff ok detains (cuffed) when needed and then arrests; a second cuff does not arrest twice', () => {
    const rig = rigWithCall();
    action(rig, 7, 5, 'cuff', { result: 'ok' });
    action(rig, 7, 5, 'cuff', { result: 'ok' });
    expect(rig.kinds(K)).toEqual(['start', 'person', 'detention', 'arrest']);
    expect(rig.of(K, 'detention')[0]?.how).toBe('cuffed');
    expect(rig.of(K, 'arrest')[0]?.how).toBe('cuff');
    said(rig, 7, 6, { intent: 'command', command: 'stop', outcome: 'comply', fact: null });
    action(rig, 7, 6, 'cuff', { result: 'ok' });
    expect(rig.of(K, 'detention').map((d) => d.how)).toEqual(['cuffed', 'command']);
  });

  it('uncuff, release, warn and citation become releases (an uncuffed person can be arrested again)', () => {
    const rig = rigWithCall();
    action(rig, 7, 5, 'cuff', { result: 'ok' });
    for (const a of ['uncuff', 'release', 'warnRelease', 'writeCitation']) action(rig, 7, 5, a);
    expect(rig.of(K, 'release').map((r) => r.how)).toEqual(['uncuff', 'release', 'warn', 'citation']);
    action(rig, 7, 5, 'cuff', { result: 'ok' });
    expect(rig.of(K, 'arrest').length).toBe(2);
  });

  it('seize becomes seizures that point at the event that found the item', () => {
    const rig = rigWithCall();
    action(rig, 7, 5, 'frisk', { items: [item('i1')] });
    action(rig, 7, 5, 'seize', { items: [item('i1'), item('i9')] });
    const frisk = rig.of(K, 'frisk')[0];
    expect(rig.of(K, 'seizure').map((s) => [s.item.ref, s.fromEvent])).toEqual([['i1', frisk?.id], ['i9', -1]]);
  });

  it('other actions append nothing', () => {
    const rig = rigWithCall();
    for (const a of ['checkId', 'runName', 'runPlate', 'escort']) action(rig, 7, 5, a);
    expect(rig.kinds(K)).toEqual(['start']);
  });
});

describe('rows contact:miranda and contact:event', () => {
  it('a Miranda answer becomes a miranda event', () => {
    const rig = rigWithCall();
    rig.bus.emit('contact:miranda', { ...cx(7, 5), result: 'invoked', custody: true, sim: rig.sim });
    expect(rig.of(K, 'miranda')[0]).toMatchObject({ personId: 5, result: 'invoked', custody: true });
  });

  it('only the falseIdentity flag matters', () => {
    const rig = rigWithCall();
    rig.bus.emit('contact:event', { ...cx(7, 5), flag: 'weaponFound' });
    rig.bus.emit('contact:event', { ...cx(7, 5), flag: 'falseIdentity' });
    rig.bus.emit('contact:event', { ...cx(7, 5), flag: 'falseIdentity' });
    expect(rig.of(K, 'indicator').map((i) => [i.indicator, i.source])).toEqual([['falseIdentity', 'evidence']]);
  });
});

describe('rows npc:fled and npc:attack', () => {
  it('flight and attacks become observation indicators', () => {
    const rig = rigWithCall();
    rig.bus.emit('npc:fled', { actorId: 1, personId: 5, callId: 7 });
    rig.bus.emit('npc:attack', { actorId: 1, personId: 5, callId: 7, kind: 'fight' });
    rig.bus.emit('npc:attack', { actorId: 1, personId: 5, callId: 7, kind: 'fire' });
    rig.bus.emit('npc:attack', { actorId: 2, personId: 6, callId: 7, kind: 'brandish' });
    expect(rig.of(K, 'indicator').map((i) => [i.personId, i.indicator, i.source])).toEqual([
      [5, 'flight', 'observation'], [5, 'assaultOnOfficer', 'observation'], [6, 'weaponSeen', 'observation'],
    ]);
  });

  it('animals and ambient events without any incident are ignored', () => {
    const rig = new Rig();
    rig.bus.emit('npc:fled', { actorId: 1, personId: -1, callId: 7 });
    rig.bus.emit('npc:attack', { actorId: 1, personId: 5, callId: 0, kind: 'fight' });
    expect(rig.sys.keys()).toEqual([]);
  });
});

describe('row scene:command', () => {
  it('maps like a contact command', () => {
    const rig = rigWithCall();
    rig.bus.emit('scene:command', { callId: 7, personId: 5, actorId: 1, command: 'handsUp', outcome: 'comply', sim: rig.sim });
    rig.bus.emit('scene:command', { callId: 7, personId: 5, actorId: 1, command: 'stop', outcome: 'flee', sim: rig.sim });
    expect(rig.kinds(K)).toEqual(['start', 'person', 'command', 'detention', 'command']);
  });
});

describe('row force:used', () => {
  const used = (rig: Rig, kind: string, personId = 5): void =>
    rig.bus.emit('force:used', { kind: kind as never, personId, callId: 7 });

  it('maps tackle, struggle, cuff and sidearmDrawn and ignores the rest', () => {
    const rig = rigWithCall();
    for (const k of ['tackle', 'struggle', 'cuff', 'sidearmDrawn', 'taser', 'sidearmFire', 'taserDrawn']) used(rig, k);
    expect(rig.of(K, 'force').map((f) => [f.level, f.tool, f.resistance, f.forceId])).toEqual([
      ['hardHands', 'tackle', 'active', -1], ['softHands', 'struggle', 'active', -1], ['softHands', 'cuffResisted', 'active', -1],
      ['presence', 'firearmDisplay', 'active', -1],
    ]);
  });

  it('a tackle uses the last known resistance of the person from force:applied', () => {
    const rig = rigWithCall();
    rig.bus.emit('force:applied', {
      seq: 1, tool: 'hands', level: 'hardHands', personId: 5, actorId: 1, callId: 7, resistance: 'assaultive', hit: true, injury: 0, fatal: false,
      cycle: 0, riskFactors: [], distance: 1, restrained: false, sim: rig.sim,
    });
    used(rig, 'tackle');
    used(rig, 'struggle');
    expect(rig.of(K, 'force').map((f) => f.resistance)).toEqual(['assaultive', 'assaultive', 'active']);
  });
});

describe('row force:used tackle resistance', () => {
  it('uses the resistance sampled before the takedown and grades it live', () => {
    const rig = rigWithCall();
    rig.bus.emit('force:used', { kind: 'tackle', personId: 5, callId: 7, resistance: 'compliant' });
    const f = rig.of(K, 'force')[0];
    expect(f).toMatchObject({ level: 'hardHands', tool: 'tackle', resistance: 'compliant' });
    expect(rig.verdicts).toHaveLength(1);
    expect(rig.verdicts[0]?.verdict).not.toBe('justified');
  });

  it('an active subject is a justified tackle and later events see the rank', () => {
    const rig = rigWithCall();
    rig.bus.emit('force:used', { kind: 'tackle', personId: 5, callId: 7, resistance: 'active' });
    expect(rig.verdicts[0]?.verdict).toBe('justified');
  });
});

describe('row force:applied', () => {
  const applied = (rig: Rig, over: Partial<Parameters<Rig['bus']['emit']>[1]> = {}): void =>
    rig.bus.emit('force:applied', {
      seq: 3, tool: 'taser', level: 'taser', personId: 5, actorId: 1, callId: 7, resistance: 'active', hit: true, injury: 0.1, fatal: false,
      cycle: 1, riskFactors: ['elderly'], distance: 4.5, restrained: false, sim: rig.sim, ...over,
    } as never);

  it('appends a force event with every field and a live verdict', () => {
    const rig = rigWithCall();
    applied(rig, { riskFactors: [] });
    const f = rig.of(K, 'force')[0];
    expect(f).toMatchObject({ forceId: 3, tool: 'taser', level: 'taser', resistance: 'active', hit: true, injury: 0.1, cycle: 1, distance: 4.5, restrained: false });
    expect(rig.verdicts).toEqual([{ key: K, eventId: f?.id, verdict: 'justified', text: 'CED on active resistance: within policy (GS-8.1)' }]);
  });

  it('judges risk factors, restrained subjects and displays under the active ruleset', () => {
    const rig = rigWithCall();
    applied(rig);
    expect(rig.verdicts[0]?.verdict).not.toBe('justified');
    expect(rig.verdicts[0]?.text).toBe('CED on active resistance: excessive (GS-8.4)');
    applied(rig, { tool: 'baton', level: 'baton', riskFactors: [], restrained: true });
    expect(rig.verdicts[1]?.text).toBe('Baton on active resistance: excessive (GS-8.2)');
    applied(rig, { tool: 'firearmDisplay', level: 'presence', resistance: 'compliant', riskFactors: [] });
    expect(rig.verdicts[2]?.text).toBe('Firearm display on compliant resistance: within policy (GS-8.1)');
    rig.sys.request({ kind: 'jurisdiction', id: 'strict' });
    rig.step();
    applied(rig, { tool: 'firearmDisplay', level: 'presence', resistance: 'compliant', riskFactors: [] });
    expect(rig.verdicts[3]?.verdict).toBe('questionable');
    expect(rig.verdicts[3]?.text).toContain('(SS-8.6)');
  });

  it('merges a scene sidearmDrawn and the force display event into one event', () => {
    const rig = rigWithCall();
    rig.bus.emit('force:used', { kind: 'sidearmDrawn', personId: 5, callId: 7 });
    applied(rig, { tool: 'firearmDisplay', level: 'presence', resistance: 'passive', riskFactors: [], seq: 8 });
    const forces = rig.of(K, 'force');
    expect(forces.length).toBe(1);
    expect(forces[0]).toMatchObject({ forceId: 8, resistance: 'passive', tool: 'firearmDisplay' });
    expect(rig.verdicts[0]?.eventId).toBe(forces[0]?.id);
    applied(rig, { tool: 'firearmDisplay', level: 'presence', resistance: 'passive', riskFactors: [], seq: 9 });
    expect(rig.of(K, 'force').length).toBe(2);
  });
});

describe('rows force:other and force:intervened', () => {
  it('maps a fellow officer strike and the intervention that refers to it', () => {
    const rig = rigWithCall();
    const other = (seq: number): void =>
      rig.bus.emit('force:other', {
        seq, officer: 'Officer Hale', level: 'hardHands', personId: 5, actorId: 1, callId: 7, resistance: 'compliant', restrained: true,
        distanceToOfficer: 6, injury: 0.1, sim: rig.sim,
      });
    other(10);
    other(12);
    rig.bus.emit('force:intervened', { otherSeq: 12, personId: 5, callId: 7, sim: rig.sim });
    const [a, b] = rig.of(K, 'otherForce');
    expect(a).toMatchObject({ officer: 'Officer Hale', level: 'hardHands', seq: 10, restrained: true, distanceToOfficer: 6 });
    expect(rig.of(K, 'intervene')[0]?.otherEvent).toBe(b?.id);
    rig.bus.emit('force:intervened', { otherSeq: 99, personId: 5, callId: 7, sim: rig.sim });
    expect(rig.of(K, 'intervene')[1]?.otherEvent).toBe(b?.id);
  });
});

describe('rows investigation:*', () => {
  it('found becomes a container search with the basis and building', () => {
    const rig = rigWithCall();
    rig.world.items.set('it1', { ...item('it1'), ownerPersonId: 6, buildingId: 4 });
    rig.bus.emit('investigation:found', { callId: 7, itemId: 'it1', basis: 'consent', suppressed: false });
    rig.bus.emit('investigation:found', { callId: 7, itemId: 'nope', basis: null, suppressed: false });
    const s = rig.of(K, 'search');
    expect(s.length).toBe(1);
    expect(s[0]).toMatchObject({ personId: 6, target: 'container', claimedBasis: 'consent', buildingId: 4, vehicleId: -1 });
    expect(s[0]?.found[0]?.ref).toBe('it1');
  });

  it('plain view points at the building entry of the log and a collected item at the event that found it', () => {
    const rig = rigWithCall();
    rig.world.items.set('it2', { ...drugs('it2'), ownerPersonId: -1, buildingId: 4 });
    rig.world.items.set('it3', { ...item('it3'), ownerPersonId: 6, buildingId: -1 });
    rig.world.buildingCalls.set(4, 7);
    rig.bus.emit('interior:transition', { buildingId: 4, entering: true, phase: 'done' });
    const entry = rig.of(K, 'entry')[0];
    rig.bus.emit('investigation:plainView', { callId: 7, itemId: 'it2', label: 'Small baggie' });
    rig.bus.emit('investigation:plainView', { callId: 7, itemId: 'it3', label: 'Folding knife' });
    expect(rig.of(K, 'indicator').map((i) => [i.personId, i.indicator, i.sourceEvent, i.detail])).toEqual([
      [-1, 'contrabandPlainView', entry?.id, 'Small baggie (it2)'], [6, 'weaponSeen', -1, 'Folding knife (it3)'],
    ]);
    rig.bus.emit('investigation:collected', { callId: 7, itemId: 'it2', label: 'Small baggie' });
    rig.bus.emit('investigation:collected', { callId: 7, itemId: 'ghost', label: 'Ghost' });
    const [s1, s2] = rig.of(K, 'seizure');
    expect(s1?.fromEvent).toBe(rig.of(K, 'indicator')[0]?.id);
    expect(s1?.item.ref).toBe('it2');
    expect(s2).toMatchObject({ fromEvent: -1, personId: -1 });
    expect(s2?.item.label).toBe('Ghost');
  });

  it('bodycam on and off set the camera bits', () => {
    const rig = rigWithCall();
    expect(rig.sys.cam.bits).toBe(0);
    rig.bus.emit('investigation:bodycam', { callId: 7, on: true });
    expect(rig.sys.cam).toMatchObject({ body: true, bits: 1 });
    rig.bus.emit('investigation:bodycam', { callId: 7, on: false });
    expect(rig.sys.cam.bits).toBe(0);
  });
});

describe('rows interior:transition and scene:service', () => {
  it('an entry is logged once per building for a bound call, with the public-place flag', () => {
    const rig = rigWithCall();
    rig.world.buildingCalls.set(4, 7);
    rig.world.publicBuildings.add(4);
    rig.bus.emit('interior:transition', { buildingId: 4, entering: true, phase: 'in' });
    rig.bus.emit('interior:transition', { buildingId: 4, entering: false, phase: 'done' });
    rig.bus.emit('interior:transition', { buildingId: 9, entering: true, phase: 'done' });
    expect(rig.of(K, 'entry').length).toBe(0);
    rig.bus.emit('interior:transition', { buildingId: 4, entering: true, phase: 'done' });
    rig.bus.emit('interior:transition', { buildingId: 4, entering: true, phase: 'done' });
    expect(rig.of(K, 'entry').map((e) => [e.buildingId, e.publicPlace, e.personId])).toEqual([[4, true, -1]]);
  });

  it('an exigency that starts mid-call is logged before the entry, and again only after the refresh interval', () => {
    const rig = rigWithCall();
    rig.world.buildingCalls.set(4, 7);
    rig.world.calls.set(7, callInfo({ exigency: true }));
    rig.bus.emit('interior:transition', { buildingId: 4, entering: true, phase: 'done' });
    expect(rig.kinds(K)).toEqual(['start', 'exigency', 'entry']);
    expect(rig.of(K, 'exigency')[0]).toMatchObject({ reason: 'emergency in progress', buildingId: 4 });
    rig.world.items.set('it1', { ...item('it1'), ownerPersonId: 6, buildingId: 4 });
    rig.bus.emit('investigation:found', { callId: 7, itemId: 'it1', basis: 'exigency', suppressed: false });
    expect(rig.of(K, 'exigency').length).toBe(1);
  });

  it('no exigency is logged while the call has none', () => {
    const rig = rigWithCall();
    rig.world.buildingCalls.set(4, 7);
    rig.bus.emit('interior:transition', { buildingId: 4, entering: true, phase: 'done' });
    expect(rig.kinds(K)).toEqual(['start', 'entry']);
  });

  it('services are logged', () => {
    const rig = rigWithCall();
    rig.bus.emit('scene:service', { callId: 7, kind: 'ems', phase: 'requested' });
    rig.bus.emit('scene:service', { callId: 7, kind: 'ems', phase: 'arrived' });
    expect(rig.of(K, 'service').map((s) => [s.service, s.phase])).toEqual([['ems', 'requested'], ['ems', 'arrived']]);
  });
});

describe('row cad:documentSaved and scene:outcome', () => {
  it('a final booking appends an arrest (if none) and the charges in the log of the booking call', () => {
    const rig = rigWithCall();
    rig.world.bookings.set('B-0001', { personId: 5, callId: 7, charges: ['TR-360', 'PC-281'] });
    rig.bus.emit('cad:documentSaved', { id: 'B-0001', kind: 'booking', final: false });
    rig.bus.emit('cad:documentSaved', { id: 'R-0001', kind: 'report', final: true });
    rig.bus.emit('cad:documentSaved', { id: 'B-0002', kind: 'booking', final: true });
    expect(rig.kinds(K)).toEqual(['start']);
    rig.bus.emit('cad:documentSaved', { id: 'B-0001', kind: 'booking', final: true });
    expect(rig.kinds(K)).toEqual(['start', 'person', 'arrest', 'charges']);
    expect(rig.of(K, 'arrest')[0]?.how).toBe('booking');
    expect(rig.of(K, 'charges')[0]).toMatchObject({ personId: 5, statutes: ['TR-360', 'PC-281'], docId: 'B-0001' });
  });

  it('a booking after a cuff arrest adds only the charges, also to a closed log', () => {
    const rig = rigWithCall();
    action(rig, 7, 5, 'cuff', { result: 'ok' });
    rig.sys.request({ kind: 'close', key: K });
    rig.step();
    rig.world.bookings.set('B-0001', { personId: 5, callId: 7, charges: ['PC-260'] });
    rig.bus.emit('cad:documentSaved', { id: 'B-0001', kind: 'booking', final: true });
    expect(rig.kinds(K).slice(-2)).toEqual(['close', 'charges']);
    expect(rig.of(K, 'arrest').length).toBe(1);
  });

  it('keyOfDoc finds the log of a booking or a citation, also for a field contact without a call', () => {
    const rig = new Rig();
    const fc = 'FC-5-1';
    rig.world.contact = fc;
    said(rig, 0, 5, { ...cx(0, 5, 'suspect', fc) });
    rig.step();
    rig.world.bookings.set('B-0001', { personId: 5, callId: 0, charges: ['PC-260'] });
    rig.world.citations.set('CT-0001', { personId: 5, callId: 0, statutes: ['TR-300'] });
    rig.bus.emit('cad:documentSaved', { id: 'B-0001', kind: 'booking', final: true });
    rig.bus.emit('cad:documentSaved', { id: 'CT-0001', kind: 'citation', final: true });
    expect(rig.sys.keyOfDoc('B-0001')).toBe(fc);
    expect(rig.sys.keyOfDoc('CT-0001')).toBe(fc);
    expect(rig.sys.keyOfDoc('B-9999')).toBeNull();
    expect(rig.of(fc, 'charges').map((c) => c.statutes)).toEqual([['PC-260'], ['TR-300']]);
  });

  it('a booking for an unknown log is dropped', () => {
    const rig = new Rig();
    rig.world.bookings.set('B-0001', { personId: 5, callId: 9, charges: ['PC-260'] });
    rig.bus.emit('cad:documentSaved', { id: 'B-0001', kind: 'booking', final: true });
    expect(rig.sys.keys()).toEqual([]);
  });

  it('the outcome appends a close event and closes the log', () => {
    const rig = rigWithCall();
    rig.bus.emit('scene:outcome', { outcome: { callId: 7, disposition: 'R', outcomeId: 'arrest' } as never });
    const log = rig.log(K);
    expect(log.closed).toBe(true);
    expect(log.closedSim).toBeGreaterThan(0);
    expect(rig.of(K, 'close')[0]).toMatchObject({ disposition: 'R', outcomeId: 'arrest' });
    rig.bus.emit('scene:outcome', { outcome: { callId: 99, disposition: 'R', outcomeId: 'x' } as never });
    expect(rig.sys.keys()).toEqual([K]);
  });
});
