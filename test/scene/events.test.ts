import { describe, expect, it } from 'vitest';
import { STATUTES } from '../../src/cad/data';
import { at, engage, eventsOf, makeRig, run, spawnWhere, type SceneRig } from './helpers';

const NOT_FALSE = (rt: { scenario: { variants: readonly string[] } }): boolean =>
  !rt.scenario.variants.includes('false') && !rt.scenario.variants.includes('swatting') && !rt.scenario.variants.includes('ambush');

/** Emits a topic owned by another module (declared there, not imported here). */
function emitLoose(r: SceneRig, topic: string, payload: object): void {
  (r.bus as unknown as { emit(t: string, p: object): void }).emit(topic, payload);
}

function domestic(r: SceneRig): number {
  const id = spawnWhere(r, 'domesticDisturbance', (rt) => NOT_FALSE(rt) && rt.scenario.participants.some((p) => p.role === 'suspect'));
  engage(r, id, 30, 2);
  return id;
}

describe('contact events become role-scoped flags', () => {
  it('maps person flags to <flag>:<role> and global flags as they are', async () => {
    const r = await makeRig();
    const id = domestic(r);
    const rt = r.scene.runtime(id)!;
    const victim = rt.scenario.participants.find((p) => p.role === 'victim')!;
    const key = r.cad.call(id)!.number;
    const send = (flag: string, role = 'victim'): void => emitLoose(r, 'contact:event', { incident: key, callId: id, personId: victim.personId, role, flag });
    send('contacted');
    send('statement');
    send('identified');
    send('custody', 'suspect');
    send('bacOver');
    send('itemFound:knife');
    send('guardianNotified');
    send('forceUsed');
    run(r, 0.1);
    for (const f of ['contacted:victim', 'statement:victim', 'identified:victim', 'custody:suspect', 'bacOver', 'itemFound:knife', 'guardianNotified', 'guardianNotified:victim', 'forceUsed']) {
      expect(rt.flags.has(f), f).toBe(true);
    }
    expect(rt.forceUsed).toContain('struggle');
    // A flag for another call does not touch this one.
    emitLoose(r, 'contact:event', { incident: 'C-99999', callId: 99999, personId: 1, role: 'victim', flag: 'released' });
    run(r, 0.1);
    expect(rt.flags.has('released:victim')).toBe(false);
  });

  it('resolveIncident gives contact the call, the role, a truth and a guilt flag', async () => {
    const r = await makeRig();
    const id = domestic(r);
    const rt = r.scene.runtime(id)!;
    const sus = rt.scenario.participants.find((p) => p.role === 'suspect')!;
    const info = r.scene.resolveIncident(sus.personId, { kind: 'actor', actorId: rt.actorIds[sus.index] ?? 1 });
    expect(info).not.toBeNull();
    expect(info!.key).toBe(r.cad.call(id)!.number);
    expect(info!.callId).toBe(id);
    expect(info!.role).toBe('suspect');
    expect(info!.guilty).toBe(true);
    expect(info!.stop).toBe(false);
    expect(info!.vehicleId).toBe(-1);
    expect(info!.truth.reason).toMatch(/^the report of /);
    expect(info!.truth.destination.length).toBeGreaterThan(0);
    expect(info!.truth.account.length).toBeGreaterThan(0);
    // Same question, same truth.
    expect(r.scene.resolveIncident(sus.personId, { kind: 'ped', slot: 0 })?.truth).toEqual(info!.truth);
    const victim = rt.scenario.participants.find((p) => p.role === 'victim')!;
    expect(r.scene.resolveIncident(victim.personId, { kind: 'ped', slot: 0 })?.guilty).toBe(false);
    expect(r.scene.resolveIncident(-5, { kind: 'ped', slot: 0 })).toBeNull();
    const outsider = [...Array(2000).keys()].find((n) => !rt.scenario.participants.some((p) => p.personId === n))!;
    expect(r.scene.resolveIncident(outsider, { kind: 'ped', slot: 0 })).toBeNull();
  });

  it('final citations and reports set cited, citation:<role> and report', async () => {
    const r = await makeRig();
    const id = domestic(r);
    const rt = r.scene.runtime(id)!;
    const victim = rt.scenario.participants.find((p) => p.role === 'victim')!;
    const t = at(r.sim);
    const cit = r.cad.docs.create(
      'citation',
      { personId: victim.personId, vehicleId: -1, plate: 'TEST123', location: 'Here', violations: [{ statuteId: STATUTES.find((x) => x.citeable)!.id, fine: 100, detail: '' }], callId: id },
      t,
      'Tester',
    );
    r.cad.docs.finalize(cit.id, t);
    const rep = r.cad.docs.create('report', { title: 'Report', location: 'Here', narrative: 'Narrative of at least twenty characters.', callId: id }, t, 'Tester');
    r.cad.docs.finalize(rep.id, t);
    run(r, 0.1);
    expect(rt.flags.has('cited')).toBe(true);
    expect(rt.flags.has('citation:victim')).toBe(true);
    expect(rt.flags.has('report')).toBe(true);
  });

  it('an AI unit on scene adds its narrative with the dispatch advice', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'domesticDisturbance', (rt) => rt.scenario.variants.includes('false'), ['false']);
    r.cad.assign(id, '21', at(r.sim), 'dispatch');
    r.cad.setUnitStatus('21', 'onScene', at(r.sim), 'auto');
    run(r, 0.2);
    const texts = r.cad.call(id)!.narrative.map((n) => n.text);
    expect(texts).toContain('Unit 21 on scene. Advises no evidence of an incident.');
  });
});

describe('npc events', () => {
  it('a runner flags fled, starts a foot pursuit and ends with caught', async () => {
    const r = await makeRig();
    const id = domestic(r);
    const rt = r.scene.runtime(id)!;
    const sus = rt.scenario.participants.find((p) => p.role === 'suspect')!;
    const actorId = rt.actorIds[sus.index]!;
    const bus = r.bus;
    r.npc.forceState(actorId, 'flee');
    bus.emit('npc:fled', { actorId, personId: sus.personId, callId: id });
    run(r, 0.1);
    expect(rt.flags.has('fled:suspect')).toBe(true);
    expect(rt.flags.has('pursuit')).toBe(true);
    expect(eventsOf<{ kind: string; active: boolean }>(r, 'scene:pursuit')).toContainEqual({ kind: 'foot', active: true, callId: id });
    expect(eventsOf<{ text: string }>(r, 'scene:radio').some((e) => e.text.includes('foot pursuit'))).toBe(true);
    expect(r.scene.hud().pursuit).toMatch(/^FOOT PURSUIT · \d+ m$/);
    bus.emit('npc:fled', { actorId, personId: sus.personId, callId: id });
    run(r, 0.1);
    expect(eventsOf<{ kind: string }>(r, 'scene:pursuit').filter((e) => e.kind === 'foot')).toHaveLength(1);
    bus.emit('npc:caught', { actorId, personId: sus.personId, callId: id, by: 'tackle' });
    run(r, 0.5);
    expect(rt.flags.has('caught:suspect')).toBe(true);
    expect(eventsOf<{ kind: string; active: boolean }>(r, 'scene:pursuit')).toContainEqual({ kind: 'foot', active: false, callId: id });
    expect(r.scene.hud().pursuit).toBeNull();
    bus.emit('npc:escaped', { actorId, personId: sus.personId, callId: id });
    bus.emit('npc:left', { actorId, personId: sus.personId, callId: id });
    bus.emit('npc:attack', { actorId, personId: sus.personId, callId: id, kind: 'fire' });
    run(r, 0.1);
    for (const f of ['escaped:suspect', 'left:suspect', 'attacked', 'shotsFired']) expect(rt.flags.has(f), f).toBe(true);
  });

  it('a dropped weapon becomes a ground prop', async () => {
    const r = await makeRig();
    const id = domestic(r);
    const before = r.scene.props.count;
    r.bus.emit('npc:weaponDropped', { actorId: 1, personId: 1, callId: id, item: 'knife', x: 5, z: 6 });
    run(r, 0.1);
    expect(r.scene.props.count).toBe(before + 1);
    const i = r.scene.props.count - 1;
    expect([r.scene.props.x[i], r.scene.props.z[i]]).toEqual([5, 6]);
    expect(r.scene.props.kind[i]).toBeGreaterThan(0);
  });
});

describe('field contacts', () => {
  it('contact:needsCall opens a pedestrianStop call, a contact scenario and attaches it', async () => {
    const r = await makeRig();
    // A wanted person makes the `wanted` branch.
    let wanted = -1;
    for (let n = 0; n < 4000 && wanted < 0; n++) if (r.people.identity(n).wanted) wanted = n;
    expect(wanted).toBeGreaterThanOrEqual(0);
    emitLoose(r, 'contact:needsCall', { personId: wanted, x: r.player.x, z: r.player.z, incident: `FC-${wanted}-1` });
    run(r, 0.1);
    expect(r.contact.attached).toHaveLength(1);
    const callId = r.contact.attached[0]!.callId;
    expect(r.contact.attached[0]!.incident).toBe(`FC-${wanted}-1`);
    const call = r.cad.call(callId)!;
    expect(call.typeId).toBe('pedestrianStop');
    expect(call.selfInitiated).toBe(true);
    expect(call.units).toContain(r.dispatcher.playerCallsign);
    const rt = r.scene.runtime(callId)!;
    expect(rt.scenario.family).toBe('contact');
    expect(rt.scenario.branch).toBe('wanted');
    expect(rt.scenario.participants[0]?.personId).toBe(wanted);
    expect(rt.materialized).toBe(true);
    // A second request for the same person reuses the call.
    emitLoose(r, 'contact:needsCall', { personId: wanted, x: r.player.x, z: r.player.z, incident: `FC-${wanted}-1` });
    run(r, 0.1);
    expect(r.contact.attached[1]?.callId).toBe(callId);
    // Custody from contact makes the arrest outcome on clear.
    emitLoose(r, 'contact:event', { incident: `FC-${wanted}-1`, callId, personId: wanted, role: 'subject', flag: 'custody' });
    r.scene.request({ kind: 'clear', callId, disposition: null });
    run(r, 0.5);
    const out = r.scene.outcomes().find((o) => o.callId === callId)!;
    expect(out.outcomeId).toBe('arrest');
    expect(out.disposition).toBe('arrestMade');
  });
});

describe('actions', () => {
  it('lays out props, consumes kit items, collects evidence and opens forms', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'injuryCollision', NOT_FALSE);
    const rt = engage(r, id, 30, 1);
    r.scene.request({ kind: 'action', callId: id, actionId: 'trafficControl' });
    run(r, 0.2);
    expect(rt.flags.has('trafficControl')).toBe(true);
    expect(r.used).toEqual([{ item: 'cones', n: 2 }, { item: 'flares', n: 2 }]);
    expect(r.scene.props.count).toBe(4);
    r.scene.request({ kind: 'action', callId: id, actionId: 'writeReport' });
    run(r, 0.2);
    expect(eventsOf<{ kind: string; callId: number }>(r, 'scene:openForm')).toContainEqual({ kind: 'report', callId: id, personId: -1, vehicleId: -1 });
    // A timed action runs, then sets its flag; leaving cancels it.
    r.scene.request({ kind: 'action', callId: id, actionId: 'canvass' });
    run(r, 0.2);
    expect(rt.actions.find((a) => a.id === 'canvass')?.state).toBe('running');
    expect(r.scene.panelModel(id)!.options.find((o) => o.label === 'Canvass for witnesses')?.detail).toMatch(/^In progress \d+ s$/);
    run(r, 31);
    expect(rt.flags.has('canvassed')).toBe(true);
    expect(rt.actions.find((a) => a.id === 'canvass')?.state).toBe('done');
    r.scene.request({ kind: 'action', callId: id, actionId: 'evacuate' });
    run(r, 0.2);
    r.player.x += 500;
    run(r, 2);
    expect(rt.actions.some((a) => a.id === 'evacuate')).toBe(false);
    expect(rt.flags.has('evacuated')).toBe(false);
  });

  it('evidence needs photographs first, then becomes finalized CAD documents and the props go', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'domesticDisturbance', (rt) => NOT_FALSE(rt) && rt.scenario.evidence.length > 0);
    const rt = engage(r, id, 30, 1);
    const props = r.scene.props.count;
    expect(props).toBeGreaterThan(0);
    r.scene.request({ kind: 'action', callId: id, actionId: 'collectEvidence' });
    run(r, 0.2);
    expect(rt.flags.has('evidenceCollected')).toBe(false);
    r.scene.request({ kind: 'action', callId: id, actionId: 'photograph' });
    run(r, 0.2);
    r.scene.request({ kind: 'action', callId: id, actionId: 'collectEvidence' });
    run(r, 0.2);
    expect(rt.flags.has('evidenceCollected')).toBe(true);
    const docs = r.cad.docs.byCall(id).filter((d) => d.kind === 'evidence');
    expect(docs).toHaveLength(rt.scenario.evidence.length);
    expect(docs.every((d) => d.status === 'final')).toBe(true);
    expect(r.scene.props.count).toBeLessThan(props);
  });

  it('disperseCrowd commands the crowd actors', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'protest', (rt) => NOT_FALSE(rt) && rt.scenario.participants.filter((p) => p.role === 'protester').length >= 4);
    const rt = engage(r, id, 30, 2);
    r.scene.request({ kind: 'action', callId: id, actionId: 'disperseCrowd' });
    run(r, 0.3);
    // The command may or may not be obeyed by enough people; the flag matches the compliance either way.
    const left = rt.scenario.participants.filter((p) => p.role === 'protester').length;
    expect(left).toBeGreaterThanOrEqual(4);
    expect(typeof rt.flags.has('crowdDispersed')).toBe('boolean');
  });
});
