import { describe, expect, it } from 'vitest';
import type { SceneVehicleSpec } from '../../src/calls';
import { CALL_CATALOG, COMMAND_FLAG_NAMES, SERVICE_KINDS, actionDef, familyDef, objectivesFor, serviceDef } from '../../src/calls';
import { SCENE_CONFIG, parseSceneConfig } from '../../src/scene/data';
import type { ScenePursuitEvent, SceneServiceEvent } from '../../src/scene/events';
import { isSceneRequest, isSceneSave } from '../../src/scene/save';
import type { ScenarioRuntime } from '../../src/scene/types';
import sceneJson from '../../src/data/scene/scene.json';
import { at, engage, eventsOf, makeRig, run, runUntil, spawnWhere, startScene, type SceneRig } from './helpers';

const NOT_FALSE = (rt: { scenario: { variants: readonly string[] } }): boolean =>
  !rt.scenario.variants.includes('false') && !rt.scenario.variants.includes('swatting') && !rt.scenario.variants.includes('ambush');

function json<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

function radioTexts(r: SceneRig): string[] {
  return eventsOf<{ text: string }>(r, 'scene:radio').map((e) => e.text);
}

/** An injured-victim call the player is on. */
async function injuryScene(): Promise<{ r: SceneRig; id: number; rt: ScenarioRuntime }> {
  const r = await makeRig();
  const id = spawnWhere(r, 'domesticViolenceInjury', (rt) => NOT_FALSE(rt) && rt.flags.has('injury:victim'));
  const rt = engage(r, id, 30, 2);
  return { r, id, rt };
}

describe('service provider (external services)', () => {
  it('a provider that takes the request makes the service external: no scene acknowledgement, no arrival, dueSim Infinity', async () => {
    const { r, id, rt } = await injuryScene();
    const asked: [number, string][] = [];
    r.scene.setServiceProvider((callId, kind) => {
      asked.push([callId, kind]);
      return true;
    });
    expect(r.scene.serviceRequested(id, 'ems')).toBe(false);
    r.scene.request({ kind: 'action', callId: id, actionId: 'requestEms' });
    run(r, 0.5);
    expect(asked).toEqual([[id, 'ems']]);
    expect(r.scene.serviceRequested(id, 'ems')).toBe(true);
    expect(rt.flags.has('service:ems')).toBe(true);
    const s = rt.services[0];
    expect(s).toMatchObject({ kind: 'ems', external: true, dueSim: Infinity, arrived: false, ackDueSim: -1, effectDueSim: -1 });
    expect(radioTexts(r)[0]).toContain('requesting EMS');
    run(r, 400);
    expect(radioTexts(r).some((t) => t.startsWith('Copy, EMS en route'))).toBe(false);
    expect(radioTexts(r).includes('EMS on scene.')).toBe(false);
    expect(rt.flags.has('arrived:ems')).toBe(false);
    expect(eventsOf<SceneServiceEvent>(r, 'scene:service')).toEqual([{ callId: id, kind: 'ems', phase: 'requested' }]);
  });

  it('serviceArrived applies the flags and effect, emits scene:service and stays silent on the radio', async () => {
    const { r, id, rt } = await injuryScene();
    r.scene.setServiceProvider(() => true);
    r.scene.request({ kind: 'action', callId: id, actionId: 'requestEms' });
    run(r, 0.5);
    const before = radioTexts(r).length;
    r.scene.request({ kind: 'serviceArrived', callId: id, service: 'ems' });
    run(r, 0.2);
    expect(rt.flags.has('arrived:ems')).toBe(true);
    expect(rt.services[0]?.arrived).toBe(true);
    expect(rt.actions.find((a) => a.id === 'requestEms')?.state).toBe('done');
    expect(rt.flags.has('transported:victim')).toBe(true);
    expect(radioTexts(r).slice(before)).toEqual([]);
    expect(eventsOf<SceneServiceEvent>(r, 'scene:service').at(-1)).toEqual({ callId: id, kind: 'ems', phase: 'arrived' });
    // A second arrival changes nothing.
    r.scene.request({ kind: 'serviceArrived', callId: id, service: 'ems' });
    run(r, 0.1);
    expect(eventsOf<SceneServiceEvent>(r, 'scene:service').filter((e) => e.phase === 'arrived')).toHaveLength(1);
  });

  it('a provider that declines leaves the scene timers and acknowledgement in place', async () => {
    const { r, id, rt } = await injuryScene();
    r.scene.setServiceProvider(() => false);
    r.scene.request({ kind: 'action', callId: id, actionId: 'requestEms' });
    run(r, 0.5);
    expect(rt.services[0]?.external).toBeUndefined();
    expect(Number.isFinite(rt.services[0]?.dueSim)).toBe(true);
    expect(runUntil(r, () => rt.flags.has('arrived:ems'), 200)).toBe(true);
    expect(radioTexts(r).some((t) => t.startsWith('Copy, EMS en route'))).toBe(true);
    expect(radioTexts(r)).toContain('EMS on scene.');
    r.scene.setServiceProvider(null);
  });

  it('serviceArrived for a service nobody requested adds it (external) and arrives it', async () => {
    const { r, id, rt } = await injuryScene();
    r.scene.request({ kind: 'serviceArrived', callId: id, service: 'detectives' });
    run(r, 0.2);
    expect(r.scene.serviceRequested(id, 'detectives')).toBe(true);
    expect(rt.services.find((s) => s.kind === 'detectives')).toMatchObject({ external: true, arrived: true });
    expect(rt.flags.has('service:detectives')).toBe(true);
    expect(rt.flags.has('arrived:detectives')).toBe(true);
    expect(rt.flags.has('detectivesAssigned')).toBe(true);
    // The "requested" phase is not announced (the real unit announced itself).
    expect(eventsOf<SceneServiceEvent>(r, 'scene:service')).toEqual([{ callId: id, kind: 'detectives', phase: 'arrived' }]);
    expect(radioTexts(r)).toEqual([]);
  });

  it('ignores serviceArrived for an unknown service or call, and serviceRequest likewise', async () => {
    const { r, id, rt } = await injuryScene();
    r.scene.request({ kind: 'serviceArrived', callId: id, service: 'bogus' });
    r.scene.request({ kind: 'serviceArrived', callId: 9999, service: 'ems' });
    r.scene.request({ kind: 'serviceRequest', callId: id, service: 'bogus' });
    r.scene.request({ kind: 'serviceRequest', callId: 9999, service: 'ems' });
    run(r, 0.2);
    expect(rt.services).toEqual([]);
  });

  it('serviceRequest runs the request once (like pressing the action) and marks the action row requested', async () => {
    const { r, id, rt } = await injuryScene();
    const asked: string[] = [];
    r.scene.setServiceProvider((_c, kind) => {
      asked.push(kind);
      return true;
    });
    r.scene.request({ kind: 'serviceRequest', callId: id, service: 'ems' });
    run(r, 0.2);
    r.scene.request({ kind: 'serviceRequest', callId: id, service: 'ems' });
    run(r, 0.2);
    expect(asked).toEqual(['ems']);
    expect(rt.services).toHaveLength(1);
    expect(rt.actions.find((a) => a.id === 'requestEms')?.state).toBe('requested');
  });

  it('an external SWAT service does not resolve a building-bound barricade (the tactical units and the negotiation do)', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'barricadedSubject', (rt) => NOT_FALSE(rt) && rt.scenario.participants.some((p) => p.role === 'subject'));
    const rt = engage(r, id, 30, 2);
    // Bound to a building: the SWAT team has a house to work.
    rt.buildingId = 1;
    r.scene.setServiceProvider(() => true);
    r.scene.request({ kind: 'action', callId: id, actionId: 'requestSwat' });
    run(r, 0.5);
    r.scene.request({ kind: 'serviceArrived', callId: id, service: 'swat' });
    run(r, 200);
    expect(rt.flags.has('arrived:swat')).toBe(true);
    expect(rt.services[0]?.effectDueSim).toBe(-1);
    expect(rt.flags.has('custody:subject')).toBe(false);
  });

  it('an external SWAT service on an unbound barricade falls back to the scene timer (no team can enter, so it still ends)', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'barricadedSubject', (rt) => NOT_FALSE(rt) && rt.scenario.participants.some((p) => p.role === 'subject'));
    const rt = engage(r, id, 30, 2);
    expect(rt.buildingId).toBeLessThan(0);
    r.scene.setServiceProvider(() => true);
    r.scene.request({ kind: 'action', callId: id, actionId: 'requestSwat' });
    run(r, 0.5);
    r.scene.request({ kind: 'serviceArrived', callId: id, service: 'swat' });
    run(r, 400);
    expect(rt.flags.has('arrived:swat')).toBe(true);
    expect(rt.flags.has('custody:subject')).toBe(true);
  });

  it('keeps an external service through save and load without a non-finite number', async () => {
    const { r, id, rt } = await injuryScene();
    r.scene.setServiceProvider(() => true);
    r.scene.request({ kind: 'action', callId: id, actionId: 'requestEms' });
    run(r, 0.5);
    const save = json(r.scene.serialize());
    expect(isSceneSave(save)).toBe(true);
    const saved = save.scenarios[0]?.services[0];
    expect(saved).toMatchObject({ kind: 'ems', external: true, dueSim: -1 });
    r.scene.restore(save, at(r.sim));
    const back = r.scene.runtime(id)?.services[0];
    expect(back).toMatchObject({ kind: 'ems', external: true, dueSim: Infinity, arrived: false });
    expect(rt.services[0]?.external).toBe(true);
    // A normal service does not carry the field.
    r.scene.setServiceProvider(null);
    r.scene.request({ kind: 'serviceRequest', callId: id, service: 'supervisor' });
    run(r, 0.5);
    const again = json(r.scene.serialize());
    expect(again.scenarios[0]?.services[1]).not.toHaveProperty('external');
    const bad = json(again);
    (bad.scenarios[0]?.services[0] as { external?: unknown }).external = 'yes';
    expect(isSceneSave(bad)).toBe(false);
  });
});

describe('custody request', () => {
  it('cuffs the person: flag, custody arrested, arrest record, no scene radio line', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'domesticDisturbance', (rt) => NOT_FALSE(rt) && rt.scenario.participants.some((p) => p.role === 'suspect'));
    const rt = engage(r, id, 30, 2);
    const sus = rt.scenario.participants.find((p) => p.role === 'suspect')!;
    const before = radioTexts(r).length;
    r.scene.request({ kind: 'custody', callId: id, personId: sus.personId, by: '21' });
    run(r, 0.2);
    expect(rt.flags.has('custody:suspect')).toBe(true);
    expect(r.people.state(sus.personId).custody).toBe('arrested');
    expect(rt.arrests.map((a) => a.personId)).toEqual([sus.personId]);
    expect(radioTexts(r).slice(before)).toEqual([]);
    // Unknown person / call: nothing.
    r.scene.request({ kind: 'custody', callId: id, personId: 123456, by: '21' });
    r.scene.request({ kind: 'custody', callId: 9999, personId: sus.personId, by: '21' });
    run(r, 0.2);
    expect(rt.arrests).toHaveLength(1);
  });
});

describe('commandFlag request', () => {
  it('sets the flags listed in scene.json (the 12 command ids) and ignores anything else', async () => {
    const { r, id, rt } = await injuryScene();
    expect(SCENE_CONFIG.commandFlags).toEqual([...COMMAND_FLAG_NAMES]);
    expect(SCENE_CONFIG.commandFlags).toHaveLength(12);
    for (const flag of SCENE_CONFIG.commandFlags) r.scene.request({ kind: 'commandFlag', callId: id, flag });
    for (const flag of ['pursuitTerminated', 'custody:victim', 'arrived:swat', 'bogus']) r.scene.request({ kind: 'commandFlag', callId: id, flag });
    r.scene.request({ kind: 'commandFlag', callId: 9999, flag: 'commandPost' });
    run(r, 0.2);
    for (const flag of SCENE_CONFIG.commandFlags) expect(rt.flags.has(flag), flag).toBe(true);
    for (const flag of ['pursuitTerminated', 'custody:victim', 'arrived:swat', 'bogus']) expect(rt.flags.has(flag), flag).toBe(false);
    expect(r.scene.flagsOf(id)?.has('commandPost')).toBe(true);
  });

  it('the scene validator names the file and path of a broken commandFlags list', () => {
    const base = json(sceneJson) as Record<string, unknown>;
    expect(parseSceneConfig(base).commandFlags).toHaveLength(12);
    expect(() => parseSceneConfig({ ...base, commandFlags: undefined })).toThrow(/scene\.json: commandFlags/);
    expect(() => parseSceneConfig({ ...base, commandFlags: [] })).toThrow(/scene\.json: commandFlags/);
    expect(() => parseSceneConfig({ ...base, commandFlags: ['a', 'a'] })).toThrow(/scene\.json: commandFlags\[1\] duplicates/);
    expect(() => parseSceneConfig({ ...base, commandFlags: ['not a flag'] })).toThrow(/scene\.json: commandFlags\[0\] must be a plain flag name/);
    expect(() => parseSceneConfig({ ...base, commandFlags: [7] })).toThrow(/scene\.json: commandFlags\[0\]/);
  });
});

describe('icsTransport', () => {
  it('EMS arrival leaves the patients to the command module on a call flagged icsTransport', async () => {
    const { r, id, rt } = await injuryScene();
    r.scene.request({ kind: 'commandFlag', callId: id, flag: 'icsTransport' });
    r.scene.request({ kind: 'action', callId: id, actionId: 'requestEms' });
    expect(runUntil(r, () => rt.flags.has('arrived:ems'), 200)).toBe(true);
    run(r, 1);
    expect(rt.flags.has('transported:victim')).toBe(false);
    const vi = rt.scenario.participants.findIndex((p) => p.role === 'victim');
    expect(r.people.state(rt.scenario.participants[vi]!.personId).custody).not.toBe('hospital');
    expect(rt.actorIds[vi]).toBeGreaterThan(0);
  });
});

describe('pursuit handoff', () => {
  function setFlee(r: SceneRig, flee: number): void {
    const saved = json(r.scene.serialize());
    const list = saved.scenarios[0]!.scenario.vehicles as SceneVehicleSpec[];
    list[0] = { ...list[0]!, flee };
    r.scene.restore(saved, { sim: r.sim, game: 0 });
  }

  function startPursuit(r: SceneRig): { owner: number; pursuit: number } {
    const owner = spawnWhere(r, 'impairedDriver', (rt) => rt.scenario.vehicles.length === 1 && !rt.scenario.variants.includes('false') && rt.scenario.branch === 'drunk');
    const rt = engage(r, owner, 60, 2);
    const v = rt.scenario.vehicles[0]!;
    setFlee(r, 1);
    const slot = r.traffic.slotOfVehicle(v.vehicleId);
    r.player.x = r.traffic.view.x[slot] ?? r.player.x;
    r.player.z = (r.traffic.view.z[slot] ?? r.player.z) + 15;
    r.traffic.forceStop(v.vehicleId);
    expect(runUntil(r, () => r.traffic.fleeingCount > 0, 20)).toBe(true);
    run(r, 0.5);
    return { owner, pursuit: r.cad.calls().find((c) => c.typeId === 'vehiclePursuit')!.id };
  }

  it('reason handoff ends the pursuit with endReason handoff, flag pursuitHandoff and the disengage line', async () => {
    const r = await makeRig();
    const { owner, pursuit } = startPursuit(r);
    const before = radioTexts(r).length;
    r.scene.request({ kind: 'terminatePursuit', reason: 'handoff' });
    run(r, 0.1);
    const ends = eventsOf<ScenePursuitEvent>(r, 'scene:pursuit').filter((e) => !e.active);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ kind: 'vehicle', callId: pursuit, ownerCallId: owner, endReason: 'handoff' });
    const rt = r.scene.runtime(pursuit)!;
    expect(rt.flags.has('pursuitHandoff')).toBe(true);
    expect(rt.flags.has('pursuitTerminated')).toBe(false);
    expect(rt.flags.has('pursuitEnded')).toBe(true);
    expect(rt.flags.has('escaped:driver')).toBe(true);
    expect(r.scene.runtime(owner)?.flags.has('pursuitHandoff')).toBe(true);
    expect(radioTexts(r).slice(before)).toContain(`${r.dispatcher.playerCallsign}, disengaging, state units have primary.`);
    expect(r.scene.hud().pursuit).toBeNull();
  });

  it('the default reason is still a termination, and the new requests pass the save validator', () => {
    expect(isSceneRequest({ kind: 'terminatePursuit' })).toBe(true);
    expect(isSceneRequest({ kind: 'terminatePursuit', reason: 'handoff' })).toBe(true);
    expect(isSceneRequest({ kind: 'terminatePursuit', reason: 'oops' })).toBe(false);
    expect(isSceneRequest({ kind: 'serviceRequest', callId: 3, service: 'ems' })).toBe(true);
    expect(isSceneRequest({ kind: 'serviceArrived', callId: 3, service: 'ems' })).toBe(true);
    expect(isSceneRequest({ kind: 'serviceArrived', callId: 0, service: 'ems' })).toBe(false);
    expect(isSceneRequest({ kind: 'custody', callId: 3, personId: 9, by: '21' })).toBe(true);
    expect(isSceneRequest({ kind: 'custody', callId: 3, personId: -1, by: '21' })).toBe(false);
    expect(isSceneRequest({ kind: 'commandFlag', callId: 3, flag: 'triaged' })).toBe(true);
    expect(isSceneRequest({ kind: 'commandFlag', callId: 3 })).toBe(false);
  });
});

describe('call inspection hooks', () => {
  it('participants, familyOf, flagsOf, hasScenario and buildingOfCall', async () => {
    const { r, id, rt } = await injuryScene();
    expect(r.scene.hasScenario(id)).toBe(true);
    expect(r.scene.hasScenario(9999)).toBe(false);
    expect(r.scene.familyOf(id)).toBe(rt.scenario.family);
    expect(r.scene.familyOf(9999)).toBeNull();
    expect(r.scene.flagsOf(id)).toBe(rt.flags);
    expect(r.scene.flagsOf(9999)).toBeNull();
    expect(r.scene.buildingOfCall(id)).toBe(r.scene.buildingOf(id));
    expect(r.scene.buildingOfCall(9999)).toBe(-1);
    const list = r.scene.participants(id);
    expect(list).toHaveLength(rt.scenario.participants.length);
    const victim = list.find((p) => p.role === 'victim')!;
    expect(victim).toMatchObject({ injured: true, deceased: false });
    expect(victim.personId).toBeGreaterThanOrEqual(0);
    expect(victim.actorId).toBe(rt.actorIds[rt.scenario.participants.findIndex((p) => p.role === 'victim')]);
    expect(r.scene.participants(9999)).toEqual([]);
  });
});

describe('Phase 6 content', () => {
  it('has the six new services (no effect) with the flags of the design', () => {
    expect(SERVICE_KINDS.slice(-6)).toEqual(['detectives', 'csu', 'negotiator', 'statePatrol', 'federal', 'airUnit']);
    const sets: Record<string, string[]> = {
      detectives: ['detectivesAssigned'], csu: ['csuProcessed'], negotiator: ['negotiatorOnScene'],
      statePatrol: ['statePatrolOnScene'], federal: ['federalNotified'], airUnit: ['airSupport'],
    };
    for (const [kind, flags] of Object.entries(sets)) {
      const def = serviceDef(kind as (typeof SERVICE_KINDS)[number]);
      expect(def.effect, kind).toBe('none');
      expect([...def.sets], kind).toEqual(flags);
      expect(def.radio).toContain('{unit}');
      const action = actionDef(`request${kind.charAt(0).toUpperCase()}${kind.slice(1)}`);
      expect(action.service).toBe(kind);
      expect(action.once).toBe(true);
    }
  });

  it('has establishCommand and adds the new request actions to the families', () => {
    const ec = actionDef('establishCommand');
    expect(ec).toMatchObject({ label: 'Establish a command post', requires: 'arrived', once: true });
    expect([...ec.sets]).toEqual(['commandPost']);
    expect(familyDef('barricade')?.actions).toContain('requestNegotiator');
    expect(familyDef('activeAssailant')?.actions).toContain('requestAirUnit');
    expect(familyDef('pursuit')?.actions).toContain('requestAirUnit');
  });

  it('has the massCasualty family of the design', () => {
    const f = familyDef('massCasualty')!;
    expect(f).toBeDefined();
    expect(f.roles.map((x) => [x.role, ...x.count])).toEqual([
      ['victim', 4, 8], ['walkingWounded', 2, 4], ['unconscious', 1, 2], ['deceased', 0, 2], ['bystander', 2, 5],
    ]);
    expect(f.roles.find((x) => x.role === 'victim')).toMatchObject({ profile: 'victimInjured', injured: 0.8 });
    expect(f.roles.find((x) => x.role === 'walkingWounded')).toMatchObject({ profile: 'victimDistraught', injured: 0.3 });
    expect(f.roles.find((x) => x.role === 'unconscious')).toMatchObject({ profile: 'subjectUnconscious', injured: 1 });
    expect(f.roles.find((x) => x.role === 'deceased')).toMatchObject({ profile: 'subjectDeceased', deceased: true });
    expect(f.roles.find((x) => x.role === 'bystander')).toMatchObject({ profile: 'bystander', spot: 'crowd' });
    expect(f.vehicles.map((v) => [v.role, v.mode, ...v.count])).toEqual([
      ['vehicleA', 'crashed', 1, 1], ['vehicleB', 'crashed', 1, 1], ['vehicleC', 'crashed', 1, 1], ['vehicleD', 'crashed', 1, 1],
    ]);
    expect(f.branches.map((b) => [b.id, ...b.flags])).toEqual([
      ['crash', 'mci', 'roadway'], ['collapse', 'mci', 'trapped'], ['hazmat', 'mci', 'hazmat', 'decon'],
    ]);
    expect(f.branches.find((b) => b.id === 'collapse')?.remove).toEqual(['vehicleA', 'vehicleB', 'vehicleC', 'vehicleD']);
    expect(f.branches.find((b) => b.id === 'hazmat')?.remove).toEqual(['vehicleA', 'vehicleB', 'vehicleC', 'vehicleD']);
    expect([...f.actions]).toEqual([
      'establishCommand', 'trafficControl', 'perimeter', 'evacuate', 'requestEms', 'requestFire', 'requestHazmat', 'requestTow',
      'requestSupervisor', 'requestCoroner', 'requestAirUnit', 'photograph', 'writeReport',
    ]);
    expect(f.objectives.map((o) => o.text)).toEqual([
      'Establish command', 'Triage the victims', 'Control traffic', 'Evacuate the zone', 'Transport the critical patients first',
    ]);
    expect(f.objectives.map((o) => o.done)).toEqual(['commandPost', 'triaged', 'trafficControl', 'evacuated', 'transportedRed']);
    expect(f.objectives[2]?.show).toBe('roadway');
    expect(f.objectives[3]?.show).toBe('hazmat');
    expect(f.outcomes.map((o) => [o.id, o.disposition, o.grade])).toEqual([
      ['wellRun', 'handled', 'good'], ['noCommand', 'reportTaken', 'bad'], ['default', 'reportTaken', 'ok'],
    ]);
    expect(f.variants).toEqual({ escalation: 0.3, deescalation: 0, false: 0.1, duplicate: 3, swatting: 0, ambush: 0 });
    expect(f.escalation?.roleOverrides.victim?.count).toEqual([6, 10]);
  });

  it('has the three mass-casualty types, each using its own branch', () => {
    const types = CALL_CATALOG.types.filter((t) => t.family === 'massCasualty');
    expect(types.map((t) => [t.id, t.weight])).toEqual([['multiVehicleCrash', 0.01], ['buildingCollapse', 0.005], ['hazmatRelease', 0.008]]);
    expect(types.find((t) => t.id === 'multiVehicleCrash')?.branchWeights).toMatchObject({ crash: 1, collapse: 0, hazmat: 0 });
    expect(types.find((t) => t.id === 'buildingCollapse')?.branchWeights).toMatchObject({ crash: 0, collapse: 1, hazmat: 0 });
    expect(types.find((t) => t.id === 'hazmatRelease')?.branchWeights).toMatchObject({ crash: 0, collapse: 0, hazmat: 1 });
  });
});

describe('massCasualty scenes', () => {
  it('call spawn multiVehicleCrash materializes at least 7 people and the crash branch flags', async () => {
    const r = await makeRig();
    const id = startScene(r, 'multiVehicleCrash', [], 3);
    const rt = r.scene.runtime(id)!;
    expect(rt.scenario.family).toBe('massCasualty');
    expect(rt.scenario.branch).toBe('crash');
    expect(rt.flags.has('mci')).toBe(true);
    expect(rt.flags.has('roadway')).toBe(true);
    expect(rt.scenario.vehicles).toHaveLength(4);
    expect(rt.scenario.participants.length).toBeGreaterThanOrEqual(9);
    const spawned = rt.actorIds.filter((a) => a > 0).length;
    expect(spawned).toBeGreaterThanOrEqual(7);
    expect(r.scene.participants(id).filter((p) => p.injured).length).toBeGreaterThanOrEqual(3);
    expect(r.cad.call(id)?.priority).toBe(1);
  });

  it('buildingCollapse and hazmatRelease have no vehicles and their own flags', async () => {
    const r = await makeRig();
    const a = r.scene.spawnCall('buildingCollapse', at(r.sim), { x: r.player.x, z: r.player.z });
    const b = r.scene.spawnCall('hazmatRelease', at(r.sim), { x: r.player.x, z: r.player.z });
    const rta = r.scene.runtime(a)!;
    const rtb = r.scene.runtime(b)!;
    expect(rta.scenario.branch).toBe('collapse');
    expect(rta.scenario.vehicles).toHaveLength(0);
    expect(rta.flags.has('trapped')).toBe(true);
    expect(rtb.scenario.branch).toBe('hazmat');
    expect(rtb.scenario.vehicles).toHaveLength(0);
    for (const f of ['mci', 'hazmat', 'decon']) expect(rtb.flags.has(f)).toBe(true);
  });

  it('shows the objectives of the branch and grades a well-run scene good, an unled one bad', async () => {
    const r = await makeRig();
    const id = startScene(r, 'multiVehicleCrash', [], 3);
    const rt = r.scene.runtime(id)!;
    const family = familyDef('massCasualty')!;
    const shown = objectivesFor(family, rt.flags).map((o) => o.text);
    expect(shown).toContain('Control traffic');
    expect(shown).not.toContain('Evacuate the zone');
    for (const flag of ['commandPost', 'triaged', 'transportedRed']) r.scene.request({ kind: 'commandFlag', callId: id, flag });
    run(r, 0.2);
    r.scene.request({ kind: 'clear', callId: id, disposition: null });
    run(r, 1);
    const out = r.scene.outcomes().find((o) => o.callId === id)!;
    expect(out).toMatchObject({ outcomeId: 'wellRun', disposition: 'handled', grade: 'good', family: 'massCasualty' });

    const id2 = startScene(r, 'multiVehicleCrash', [], 3);
    r.scene.request({ kind: 'clear', callId: id2, disposition: null });
    run(r, 1);
    expect(r.scene.outcomes().find((o) => o.callId === id2)).toMatchObject({ outcomeId: 'noCommand', grade: 'bad' });
  });
});
