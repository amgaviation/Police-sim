import { describe, expect, it } from 'vitest';
import { engage, eventsOf, makeRig, run, spawnWhere, type SceneRig } from './helpers';

const NOT_FALSE = (rt: { scenario: { variants: readonly string[] } }): boolean =>
  !rt.scenario.variants.includes('false') && !rt.scenario.variants.includes('swatting') && !rt.scenario.variants.includes('ambush');

function blank(): NonNullable<ReturnType<SceneRig['npc']['actor']>> {
  return {
    id: 0, personId: 0, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false, following: false, hidden: false,
    armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0,
  };
}

/** A materialized disturbance with a visible subject at the curb; returns the call id and the subject's actor id. */
function subjectScene(r: SceneRig): { id: number; actor: number; role: string } {
  const id = spawnWhere(r, 'intoxicatedPerson', (rt) => NOT_FALSE(rt) && rt.scenario.branch !== 'gone' && rt.scenario.participants.some((p) => p.role === 'subject'));
  const rt = engage(r, id, 30, 2);
  const i = rt.scenario.participants.findIndex((p) => p.role === 'subject');
  return { id, actor: rt.actorIds[i] ?? 0, role: 'subject' };
}

/** Places the officer `d` metres from the actor, facing it, then runs one step so the position is applied. */
function face(r: SceneRig, actor: number, d: number): void {
  const a = r.npc.actor(actor, blank())!;
  r.player.x = a.x - d;
  r.player.z = a.z;
  r.officer.yaw = -Math.PI / 2;
  run(r, 0.02);
}

describe('officer weapon', () => {
  it('cycles none -> sidearm -> taser -> none and reports a draw near a scene actor', async () => {
    const r = await makeRig();
    const { id } = subjectScene(r);
    expect(r.scene.officerWeapon).toBe('none');
    r.scene.request({ kind: 'weapon' });
    run(r, 0.1);
    expect(r.scene.officerWeapon).toBe('sidearm');
    const first = eventsOf<{ kind: string; callId: number }>(r, 'force:used');
    expect(first.map((e) => e.kind)).toEqual(['sidearmDrawn']);
    expect(first[0]?.callId).toBe(id);
    r.scene.request({ kind: 'weapon' });
    run(r, 0.1);
    expect(r.scene.officerWeapon).toBe('taser');
    expect(eventsOf<{ kind: string }>(r, 'force:used').map((e) => e.kind)).toEqual(['sidearmDrawn', 'taserDrawn']);
    r.scene.request({ kind: 'weapon' });
    run(r, 0.1);
    expect(r.scene.officerWeapon).toBe('none');
    expect(r.scene.presence.weapon).toBe('none');
  });

  it('a weapon cannot be drawn from a vehicle', async () => {
    const r = await makeRig();
    r.officer.onFoot = false;
    r.scene.request({ kind: 'weapon' });
    // The rig copies the position only, so keep the flag across the step.
    r.scene.step(1 / 60, { sim: 0, game: 0 }, { ...r.officer, onFoot: false });
    expect(r.scene.officerWeapon).toBe('none');
  });

  it('the sidearm never fires: a flash and a hook event', async () => {
    const r = await makeRig();
    r.scene.request({ kind: 'weapon' });
    run(r, 0.1);
    r.scene.request({ kind: 'fire', dirX: 1, dirZ: 0 });
    run(r, 0.1);
    expect(eventsOf<{ text: string }>(r, 'scene:flash').some((f) => f.text.includes('Phase 5'))).toBe(true);
    expect(eventsOf<{ kind: string }>(r, 'force:used').some((e) => e.kind === 'sidearmFire')).toBe(true);
  });
});

describe('TASER, tackle and shout', () => {
  it('the TASER marks force used on the target and fires the hook', async () => {
    const r = await makeRig();
    const { id, actor } = subjectScene(r);
    expect(actor).toBeGreaterThan(0);
    r.scene.request({ kind: 'weapon' });
    r.scene.request({ kind: 'weapon' });
    run(r, 0.1);
    face(r, actor, 4);
    r.scene.request({ kind: 'fire', dirX: 1, dirZ: 0 });
    run(r, 0.1);
    const rt = r.scene.runtime(id)!;
    expect(eventsOf<{ kind: string }>(r, 'force:used').some((e) => e.kind === 'taser')).toBe(true);
    expect(rt.flags.has('forceUsed')).toBe(true);
    expect(rt.forceUsed).toContain('taser');
  });

  it('a tackle within reach flags caught and force used', async () => {
    const r = await makeRig();
    const { id, actor } = subjectScene(r);
    face(r, actor, 0.9);
    r.scene.request({ kind: 'tackle' });
    run(r, 0.1);
    const rt = r.scene.runtime(id)!;
    expect(rt.flags.has('caught:subject')).toBe(true);
    expect(rt.flags.has('forceUsed')).toBe(true);
    expect(rt.forceUsed).toContain('tackle');
    expect(eventsOf<{ kind: string }>(r, 'force:used').some((e) => e.kind === 'tackle')).toBe(true);
  });

  it('a tackle with nobody in reach does nothing', async () => {
    const r = await makeRig();
    const { id, actor } = subjectScene(r);
    face(r, actor, 15);
    r.scene.request({ kind: 'tackle' });
    run(r, 0.1);
    expect(r.scene.runtime(id)?.flags.has('caught:subject')).toBe(false);
  });

  it('a shout commands the nearest actor in front and emits officer and subject lines', async () => {
    const r = await makeRig();
    const { actor } = subjectScene(r);
    face(r, actor, 8);
    r.scene.request({ kind: 'shout' });
    run(r, 0.1);
    const lines = eventsOf<{ personId: number; speaker: string; text: string; language: string }>(r, 'scene:line');
    expect(lines[0]?.personId).toBe(-1);
    expect(lines[0]?.text).toMatch(/^Police! /);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[1]?.personId).toBeGreaterThanOrEqual(0);
    expect(lines[1]?.text.length).toBeGreaterThan(0);
  });
});

describe('ambush', () => {
  it('fires when the officer comes within range of an armed ambush', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'domesticDisturbance', (rt) => rt.scenario.variants.includes('ambush'), ['ambush']);
    const rt = r.scene.runtime(id)!;
    expect(rt.scenario.participants.some((p) => p.role === 'ambusher')).toBe(true);
    engage(r, id, 12, 1);
    expect(rt.materialized).toBe(true);
    run(r, 20);
    expect(rt.ambushArmed).toBe(true);
    expect(rt.flags.has('attacked')).toBe(true);
    expect(rt.flags.has('shotsFired')).toBe(true);
    const radio = eventsOf<{ text: string; priority: boolean }>(r, 'scene:radio');
    expect(radio.some((e) => e.text.startsWith('Shots fired!') && e.priority)).toBe(true);
    expect(r.cad.call(id)?.narrative.some((n) => n.text === 'Officer reports being fired upon')).toBe(true);
  });
});
