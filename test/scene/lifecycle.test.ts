import { describe, expect, it } from 'vitest';
import type { CallOutcome } from '../../src/scene/types';
import { at, engage, eventsOf, makeRig, run, runUntil, spawnWhere, startScene, step, type SceneRig } from './helpers';

function actorInfo(r: SceneRig, id: number, index: number): ReturnType<SceneRig['npc']['actor']> {
  const rt = r.scene.runtime(id);
  const aid = rt?.actorIds[index] ?? 0;
  return aid > 0 ? r.npc.actor(aid, blank()) : null;
}

function blank(): NonNullable<ReturnType<SceneRig['npc']['actor']>> {
  return {
    id: 0, personId: 0, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false, following: false, hidden: false,
    armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0,
  };
}

const NOT_FALSE = (rt: { scenario: { variants: readonly string[] } }): boolean =>
  !rt.scenario.variants.includes('false') && !rt.scenario.variants.includes('swatting') && !rt.scenario.variants.includes('ambush');

describe('scenario build and timeline', () => {
  it('builds a scenario for a generated call and applies the describe entry', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'barricadedSubject', (rt) => NOT_FALSE(rt) && rt.scenario.timeline.some((e) => e.kind === 'describe'));
    const rt = r.scene.runtime(id);
    expect(rt?.scenario.family).toBe('barricade');
    expect(rt?.materialized).toBe(false);
    run(r, 1);
    const texts = r.cad.call(id)?.narrative.map((n) => n.text) ?? [];
    expect(texts.some((t) => t.startsWith('RP describes the subject as a'))).toBe(true);
  });

  it('applies a wrong-address correction narrative when dispatch got the address wrong', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'loudParty', (rt) => rt.scenario.errors.wrongAddress);
    const rt = r.scene.runtime(id);
    expect(rt).not.toBeNull();
    const a = rt!.scenario;
    expect(Math.hypot(a.anchor.x - a.reported.x, a.anchor.z - a.reported.z)).toBeGreaterThan(20);
    const due = a.timeline.find((e) => e.text.startsWith('Correction: RP advises the location is'));
    expect(due).toBeDefined();
    run(r, (due?.atS ?? 0) + 1);
    const texts = r.cad.call(id)?.narrative.map((n) => n.text) ?? [];
    expect(texts.some((t) => t.startsWith('Correction: RP advises the location is'))).toBe(true);
  });

  it('creates a linked, closed duplicate call for a linkedCall entry (and never builds a scenario for it)', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'loudParty', (rt) => rt.scenario.timeline.some((e) => e.kind === 'linkedCall'), ['duplicate']);
    const before = r.cad.calls().length;
        run(r, 100);
    const orig = r.cad.call(id);
    expect(r.cad.calls().length).toBeGreaterThan(before);
    const dupId = orig?.links[0] ?? 0;
    const dup = r.cad.call(dupId);
    expect(dup?.typeId).toBe(orig?.typeId);
    expect(dup?.status).toBe('closed');
    expect(dup?.disposition).toBe('duplicate');
    expect(dup?.links).toContain(id);
    expect(r.scene.runtime(dupId)).toBeNull();
    expect(r.scene.outcomes().some((o) => o.callId === dupId)).toBe(false);
    // The duplicate callers add narrative lines with their names.
    const lines = orig?.narrative.filter((n) => n.text.startsWith('Additional caller')) ?? [];
    expect(lines.length).toBeGreaterThan(0);
  });

  it('escalation raises the priority, swaps the profile of a live actor and appends the narrative', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'domesticDisturbance', (rt) => rt.scenario.variants.includes('escalation') && rt.scenario.participants.some((p) => p.role === 'suspect'), ['escalation']);
    const rt = engage(r, id);
    const idx = rt.scenario.participants.findIndex((p) => p.role === 'suspect');
    const priority = r.cad.call(id)!.priority;
    expect(actorInfo(r, id, idx)?.profile).toBe('suspectAgitated');
    const esc = rt.scenario.timeline.find((e) => e.kind === 'escalate')!;
    run(r, esc.atS + 2);
    expect(rt.flags.has('escalated')).toBe(true);
    expect(r.cad.call(id)!.priority).toBe(esc.priority);
    expect(esc.priority).toBeLessThan(priority + 1);
    expect(actorInfo(r, id, idx)?.profile).toBe('suspectHostile');
    expect(r.cad.call(id)!.narrative.some((n) => n.text === esc.text)).toBe(true);
  });
});

describe('materialization', () => {
  it('materializes only when the player is assigned and near', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'noiseComplaint', NOT_FALSE);
    const rt = r.scene.runtime(id)!;
    // Not assigned: even standing at the anchor changes nothing.
    r.player.x = rt.scenario.anchor.x;
    r.player.z = rt.scenario.anchor.z;
    run(r, 2);
    expect(rt.materialized).toBe(false);
    // Assigned but far away.
    r.dispatcher.request(r.dispatcher.playerCallsign, { kind: 'selfAssign', callId: id }, 'key');
    r.player.x = rt.scenario.anchor.x - 600;
    run(r, 2);
    expect(rt.materialized).toBe(false);
    expect(eventsOf(r, 'scene:materialized')).toHaveLength(0);
    // Assigned and within 220 m.
    r.player.x = rt.scenario.anchor.x - 200;
    run(r, 2);
    expect(rt.materialized).toBe(true);
    expect(eventsOf(r, 'scene:materialized')).toEqual([{ callId: id }]);
    expect(rt.flags.has('arrived')).toBe(false);
    // Arrival within 50 m sets the flag and moves the CAD status to on scene.
    r.player.x = rt.scenario.anchor.x - 20;
    run(r, 2);
    expect(rt.flags.has('arrived')).toBe(true);
    expect(r.cad.playerUnit()?.status).toBe('onScene');
  });

  it('puts actors on their spots and keeps hidden ones out of reach until knock reveals them', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'domesticDisturbance', (rt) => NOT_FALSE(rt) && rt.scenario.participants.some((p) => p.role === 'suspect'));
    const rt = engage(r, id, 30, 0.05);
    expect(rt.materialized).toBe(true);
    const sc = rt.scenario;
    const edge = r.city.graph.edges[sc.anchor.edge]!;
    for (let i = 0; i < sc.participants.length; i++) {
      const info = actorInfo(r, id, i);
      expect(info).not.toBeNull();
      const p = sc.participants[i]!;
      // On the sidewalk band beside the road (not inside the road), near the anchor.
      const dx = info!.x - sc.anchor.x;
      const dz = info!.z - sc.anchor.z;
      expect(Math.hypot(dx, dz)).toBeLessThan(60);
      if (p.spot === 'door' || p.spot === 'curb' || p.spot === 'yard' || p.spot === 'inside') {
        // On the sidewalk band beside the road, not in the carriageway.
        const hit = r.city.graph.projectOnEdge(edge.id, info!.x, info!.z, { edge: 0, s: 0, t: 0, x: 0, z: 0, distance: 0, side: 1 });
        expect(hit.distance).toBeGreaterThanOrEqual(edge.width / 2 - 0.3);
        expect(hit.distance).toBeLessThanOrEqual(edge.width / 2 + Math.max(edge.sidewalk, 3) + 0.5);
      }
      expect(info!.hidden).toBe(p.spot === 'inside' || p.spot === 'hidden');
    }
    const si = sc.participants.findIndex((p) => p.role === 'suspect');
    expect(actorInfo(r, id, si)?.hidden).toBe(true);
    expect(edge.length).toBeGreaterThan(0);
    // Hidden people cannot be picked.
    const pick = { kind: 'actor' as const, id: 0, seat: -1, personId: -1, distance: 0 };
    const sus = actorInfo(r, id, si)!;
    const found = r.npc.nearestPerson(sus.x, sus.z, 0, 0.5, -1, pick);
    expect(found === null || found.personId !== sc.participants[si]!.personId).toBe(true);
    // Knock reveals the inside participants.
    r.scene.request({ kind: 'action', callId: id, actionId: 'knock' });
    run(r, 0.5);
    expect(rt.flags.has('knocked')).toBe(true);
    expect(rt.flags.has('revealed:suspect')).toBe(true);
    expect(actorInfo(r, id, si)?.hidden).toBe(false);
    // The action is once-only.
    const flashes = eventsOf(r, 'scene:flash').length;
    r.scene.request({ kind: 'action', callId: id, actionId: 'knock' });
    run(r, 0.2);
    expect(eventsOf(r, 'scene:flash').length).toBe(flashes + 1);
  });

  it('refuses an action when the kit item is missing or the officer is too far', async () => {
    const r = await makeRig({ missing: ['cones'] });
    const id = spawnWhere(r, 'injuryCollision', NOT_FALSE);
    const rt = engage(r, id, 30, 1);
    r.scene.request({ kind: 'action', callId: id, actionId: 'trafficControl' });
    run(r, 0.3);
    expect(rt.flags.has('trafficControl')).toBe(false);
    expect(eventsOf<{ text: string }>(r, 'scene:flash').some((f) => f.text.includes('cones'))).toBe(true);
    r.scene.request({ kind: 'action', callId: id, actionId: 'photograph' });
    run(r, 0.3);
    expect(rt.flags.has('photographed')).toBe(true);
    r.player.x = rt.scenario.anchor.x - 200;
    r.scene.request({ kind: 'action', callId: id, actionId: 'canvass' });
    run(r, 0.3);
    expect(rt.actions.some((a) => a.id === 'canvass')).toBe(false);
  });
});

describe('services', () => {
  it('EMS arrives, transports the injured and sets the flags', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'domesticViolenceInjury', (rt) => NOT_FALSE(rt) && rt.flags.has('injury:victim'));
    const rt = engage(r, id, 30, 2);
    r.scene.request({ kind: 'action', callId: id, actionId: 'requestEms' });
    run(r, 0.5);
    expect(rt.flags.has('service:ems')).toBe(true);
    const radio = eventsOf<{ text: string }>(r, 'scene:radio');
    expect(radio[0]?.text).toContain('requesting EMS');
    expect(runUntil(r, () => rt.flags.has('arrived:ems'), 200)).toBe(true);
    expect(rt.flags.has('transported:victim')).toBe(true);
    const vi = rt.scenario.participants.findIndex((p) => p.role === 'victim');
    expect(r.people.state(rt.scenario.participants[vi]!.personId).custody).toBe('hospital');
    expect(r.npc.actor(rt.actorIds[vi] ?? 0, blank())).toBeNull();
    expect(eventsOf<{ text: string }>(r, 'scene:radio').some((e) => e.text === 'EMS on scene.')).toBe(true);
  });

  it('SWAT resolves a barricade: the subject surrenders cuffed', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'barricadedSubject', (rt) => NOT_FALSE(rt) && rt.scenario.participants.some((p) => p.role === 'subject'));
    const rt = engage(r, id, 30, 2);
    r.scene.request({ kind: 'action', callId: id, actionId: 'requestSwat' });
    expect(runUntil(r, () => rt.flags.has('custody:subject'), 460)).toBe(true);
    expect(rt.flags.has('arrived:swat')).toBe(true);
    const si = rt.scenario.participants.findIndex((p) => p.role === 'subject');
    expect(actorInfo(r, id, si)?.cuffed).toBe(true);
    expect(r.people.state(rt.scenario.participants[si]!.personId).custody).toBe('arrested');
  });

  it('K9 reveals hidden suspects', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'burglaryInProgress', (rt) => NOT_FALSE(rt) && rt.scenario.participants.some((p) => p.spot === 'hidden'));
    const rt = engage(r, id, 30, 2);
    const hi = rt.scenario.participants.findIndex((p) => p.spot === 'hidden');
    expect(actorInfo(r, id, hi)?.hidden).toBe(true);
    r.scene.request({ kind: 'action', callId: id, actionId: 'requestK9' });
    expect(runUntil(r, () => rt.flags.has('arrived:k9'), 200)).toBe(true);
    expect(actorInfo(r, id, hi)?.hidden).toBe(false);
    expect(rt.flags.has(`revealed:${rt.scenario.participants[hi]!.role}`)).toBe(true);
  });
});

describe('outcome', () => {
  it('records the expected outcome for scripted flags when the call is cleared', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'domesticDisturbance', (rt) => NOT_FALSE(rt) && rt.scenario.participants.some((p) => p.role === 'suspect'));
    const rt = engage(r, id, 30, 2);
    rt.flags.add('custody:suspect');
    r.scene.request({ kind: 'clear', callId: id, disposition: null });
    run(r, 1);
    expect(r.cad.call(id)?.status).toBe('closed');
    const out = r.scene.outcomes().find((o) => o.callId === id) as CallOutcome;
    expect(out.outcomeId).toBe('arrestSuspect');
    expect(out.suggested).toBe('arrestMade');
    expect(out.disposition).toBe('arrestMade');
    expect(out.grade).toBe('good');
    expect(out.resolvedBy).toBe('player');
    expect(out.materialized).toBe(true);
    expect(out.flags).toContain('custody:suspect');
    expect(eventsOf<{ outcome: CallOutcome }>(r, 'scene:outcome')[0]?.outcome.callId).toBe(id);
    // The runtime is gone and loose actors leave.
    expect(r.scene.runtime(id)).toBeNull();
  });

  it('a call cleared with a chosen disposition keeps both the suggestion and the record', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'noiseComplaint', NOT_FALSE);
    engage(r, id, 30, 1);
    r.scene.request({ kind: 'clear', callId: id, disposition: 'reportTaken' });
    run(r, 1);
    const out = r.scene.outcomes().find((o) => o.callId === id)!;
    expect(out.disposition).toBe('reportTaken');
    expect(out.suggested).not.toBe('');
  });

  it('the panel model lists the family actions and the clear options', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'domesticDisturbance', NOT_FALSE);
    engage(r, id, 30, 1);
    const model = r.scene.panelModel(id)!;
    expect(model.title).toMatch(/^C-\d{5} P\d /);
    const labels = model.options.map((o) => o.label);
    expect(labels).toContain('Knock and announce');
    expect(labels[labels.length - 2]).toMatch(/^Clear call - .* \(suggested\)$/);
    expect(labels[labels.length - 1]).toMatch(/choose disposition in MDT/);
    const knock = labels.indexOf('Knock and announce');
    r.scene.panelSelect(id, knock);
    run(r, 0.3);
    expect(r.scene.runtime(id)?.flags.has('knocked')).toBe(true);
    expect(r.scene.hud().scene?.title).toBe(model.title);
    expect(r.scene.sceneAt(r.player.x, r.player.z)).toBe(id);
    expect(r.scene.sceneAt(r.player.x + 5000, r.player.z)).toBe(-1);
  });
});

it('keeps the idle path quiet (no scenario, nothing queued)', async () => {
  const r = await makeRig();
  const t = at(0);
  for (let i = 0; i < 120; i++) r.scene.step(1 / 60, t, r.officer);
  expect(r.scene.stats.scenarios).toBe(0);
  step(r);
});

void startScene;
