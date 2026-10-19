import { afterAll, describe, expect, it } from 'vitest';
import { NPC_CONFIG } from '../../src/npc/data';
import { AWARE_REACTIONS, ACTOR_STATE, type Listener } from '../../src/npc/types';
import { DOWNTOWN, NIGHT, StubNav, cityOf, info, makeRig, spec, spotIn, stateOf, type NpcRig } from './helpers';

const rigs: NpcRig[] = [];
const P = (() => {
  const p = spotIn(cityOf(), DOWNTOWN);
  if (!p) throw new Error('no downtown edge');
  return p;
})();
const B = 8;
const SRC = { x: P.x + 40, z: P.z + 40 };

afterAll(() => {
  for (const r of rigs) r.traffic.physics.dispose();
});

async function rig(start?: number): Promise<{ r: NpcRig; nav: StubNav }> {
  const r = await makeRig({ x: P.x, z: P.z, density: 0, ...(start === undefined ? {} : { start }) });
  rigs.push(r);
  const nav = new StubNav();
  nav.hideIndex = 1;
  nav.hidePose = { x: P.x + 26, z: P.z + 1, yaw: 1 };
  nav.exitRoute = [P.x + 30, P.z + 4];
  nav.exitPose = { x: P.x + 30, z: P.z + 5, yaw: 0 };
  r.npc.setIndoorNav(nav);
  r.run(1);
  return { r, nav };
}

function awareEvents(r: NpcRig): Record<string, unknown>[] {
  return r.events['npc:aware'] ?? [];
}

describe('stimulation thresholds', () => {
  it('config carries the design thresholds', () => {
    expect(NPC_CONFIG.actors.awareDecayPerS).toBe(0.05);
    expect(NPC_CONFIG.actors.alertAt).toBe(0.3);
    expect(NPC_CONFIG.actors.awareAt).toBe(0.7);
  });

  it('raises npc:aware once per level crossing and only rolls the reaction once', async () => {
    const { r } = await rig();
    const id = r.npc.spawnActor(spec(3000, P.x + 30, P.z, { building: B, profile: 'callerHelpful', callId: 4 }));
    r.npc.stimulate(id, 'sound', 0.2, SRC.x, SRC.z);
    expect(awareEvents(r)).toHaveLength(0);
    r.npc.stimulate(id, 'sound', 0.15, SRC.x, SRC.z);
    expect(awareEvents(r)).toEqual([{ actorId: id, personId: 3000, callId: 4, level: 'alert', reaction: 'none', cause: 'sound' }]);
    // Still between the thresholds: nothing new.
    r.npc.stimulate(id, 'sound', 0.1, SRC.x, SRC.z);
    expect(awareEvents(r)).toHaveLength(1);
    r.npc.stimulate(id, 'sight', 0.5, SRC.x, SRC.z);
    expect(awareEvents(r)).toHaveLength(2);
    expect(awareEvents(r)[1]).toEqual({ actorId: id, personId: 3000, callId: 4, level: 'aware', reaction: 'none', cause: 'sight' });
    r.npc.stimulate(id, 'sound', 0.5, SRC.x, SRC.z);
    expect(awareEvents(r)).toHaveLength(2);
    const out = info();
    r.npc.actor(id, out);
    expect(out.aware).toBe(1);
  });

  it('crossing both thresholds at once raises alert and then aware', async () => {
    const { r } = await rig();
    const id = r.npc.spawnActor(spec(3001, P.x + 30, P.z, { building: B, profile: 'callerHelpful' }));
    r.npc.stimulate(id, 'sound', 0.9, SRC.x, SRC.z);
    expect(awareEvents(r).map((e) => e.level)).toEqual(['alert', 'aware']);
  });

  it('light counts one and a half times, ignores non-positive amounts and unknown actors', async () => {
    const { r } = await rig();
    const id = r.npc.spawnActor(spec(3002, P.x + 30, P.z, { building: B, profile: 'callerHelpful' }));
    r.npc.stimulate(id, 'light', 0.2, SRC.x, SRC.z);
    const out = info();
    r.npc.actor(id, out);
    expect(out.aware).toBeCloseTo(0.3, 6);
    expect(awareEvents(r)[0]?.cause).toBe('light');
    r.npc.stimulate(id, 'sound', -1, SRC.x, SRC.z);
    r.npc.stimulate(id, 'sound', Number.NaN, SRC.x, SRC.z);
    r.npc.stimulate(9999, 'sound', 1, SRC.x, SRC.z);
    r.npc.actor(id, out);
    expect(out.aware).toBeCloseTo(0.3, 6);
  });

  it('an alert actor turns to face the source', async () => {
    const { r } = await rig();
    const id = r.npc.spawnActor(spec(3003, P.x + 30, P.z, { building: B, profile: 'callerHelpful' }));
    r.npc.stimulate(id, 'sound', 0.4, P.x + 30, P.z + 10);
    const out = info();
    r.npc.actor(id, out);
    // Facing +z is yaw pi (yaw 0 faces -z).
    expect(Math.abs(Math.abs(out.yaw) - Math.PI)).toBeLessThan(1e-6);
  });

  it('hidden actors ignore sight but hear sound and notice light', async () => {
    const { r } = await rig();
    const id = r.npc.spawnActor(spec(3004, P.x + 30, P.z, { building: B, hidden: true, profile: 'callerHelpful' }));
    r.npc.stimulate(id, 'sight', 1, SRC.x, SRC.z);
    const out = info();
    r.npc.actor(id, out);
    expect(out.aware).toBe(0);
    r.npc.stimulate(id, 'light', 0.25, SRC.x, SRC.z);
    r.npc.actor(id, out);
    expect(out.aware).toBeGreaterThan(0.3);
  });

  it('the unconscious and the dead are not stimulated', async () => {
    const { r } = await rig();
    const id = r.npc.spawnActor(spec(3005, P.x + 30, P.z, { building: B, profile: 'subjectDeceased' }));
    r.npc.stimulate(id, 'sound', 1, SRC.x, SRC.z);
    expect(awareEvents(r)).toHaveLength(0);
  });

  it('awareness decays and a new crossing raises alert again but does not re-roll the reaction', async () => {
    const { r } = await rig();
    const id = r.npc.spawnActor(spec(3006, P.x + 30, P.z, { building: B, profile: 'callerHelpful' }));
    r.npc.stimulate(id, 'sound', 0.8, SRC.x, SRC.z);
    expect(awareEvents(r)).toHaveLength(2);
    const out = info();
    r.run(60 * 10);
    r.npc.actor(id, out);
    // 0.8 - 10 s x 0.05 = 0.3, give or take the LOD rate.
    expect(out.aware).toBeGreaterThan(0.25);
    expect(out.aware).toBeLessThan(0.35);
    r.run(60 * 20);
    r.npc.actor(id, out);
    expect(out.aware).toBe(0);
    r.npc.stimulate(id, 'sound', 0.4, SRC.x, SRC.z);
    r.npc.stimulate(id, 'sound', 0.4, SRC.x, SRC.z);
    expect(awareEvents(r).map((e) => e.level)).toEqual(['alert', 'aware', 'alert']);
  });
});

describe('onAware reactions', () => {
  /** Makes `n` actors of `profile` in building B, stimulates each to 1 and returns the reactions in order. */
  function roll(r: NpcRig, profile: string, n: number, over: Partial<Parameters<typeof spec>[3]> = {}): { ids: number[]; reactions: string[] } {
    const ids: number[] = [];
    for (let i = 0; i < n; i++) ids.push(r.npc.spawnActor(spec(3100 + i * 53, P.x + 30, P.z + i * 0.2, { building: B, profile, role: 'suspect', ...over })));
    for (const id of ids) r.npc.stimulate(id, 'sound', 1, SRC.x, SRC.z);
    const reactions = awareEvents(r)
      .filter((e) => e.level === 'aware')
      .map((e) => String(e.reaction));
    return { ids, reactions };
  }

  it('suspectNervous: hide, flee and surrender all happen and each does what it says', async () => {
    const { r, nav } = await rig();
    const { ids, reactions } = roll(r, 'suspectNervous', 48);
    const seen = new Set(reactions);
    expect(seen).toEqual(new Set(['hide', 'flee', 'surrender']));
    const out = info();
    ids.forEach((id, i) => {
      r.npc.actor(id, out);
      const reaction = reactions[i];
      if (reaction === 'hide') {
        expect(out.hidden).toBe(true);
        expect(out.state).toBe(ACTOR_STATE.hide);
        expect(out.x).toBe(P.x + 26);
        expect(out.z).toBe(P.z + 1);
      } else if (reaction === 'flee') {
        expect(out.state).toBe(ACTOR_STATE.flee);
      } else {
        expect(out.state).toBe(ACTOR_STATE.handsUp);
      }
    });
    expect(nav.hides.length).toBeGreaterThan(0);
    expect(r.events['npc:surrendered']?.length).toBe(reactions.filter((x) => x === 'surrender').length);
    expect(r.events['npc:fled']?.length).toBe(reactions.filter((x) => x === 'flee').length);
  });

  it('the roll is deterministic for a seed and uses the actors stream', async () => {
    const a = await rig();
    const b = await rig();
    const ra = roll(a.r, 'suspectNervous', 24).reactions;
    const rb = roll(b.r, 'suspectNervous', 24).reactions;
    expect(ra).toEqual(rb);
    expect(ra).toHaveLength(24);
  });

  it('outdoors hide does nothing and the others keep their meaning', async () => {
    const { r } = await rig();
    const ids: number[] = [];
    for (let i = 0; i < 40; i++) ids.push(r.npc.spawnActor(spec(3400 + i * 41, P.x + 30, P.z + i, { profile: 'suspectEvasive' })));
    for (const id of ids) r.npc.stimulate(id, 'sound', 1, SRC.x, SRC.z);
    const reactions = awareEvents(r)
      .filter((e) => e.level === 'aware')
      .map((e) => e.reaction);
    expect(new Set(reactions)).toEqual(new Set(['none', 'flee']));
    for (const id of ids) {
      const out = info();
      r.npc.actor(id, out);
      expect(out.hidden).toBe(false);
    }
    expect(ids.filter((id) => stateOf(r.npc, id) === ACTOR_STATE.flee)).toHaveLength(reactions.filter((x) => x === 'flee').length);
  });

  it('ambusher arms: draws the carried weapon and holds', async () => {
    const { r } = await rig();
    const id = r.npc.spawnActor(spec(3500, P.x + 30, P.z, { building: B, profile: 'ambusher', weapon: 'handgun' }));
    r.npc.stimulate(id, 'sound', 1, SRC.x, SRC.z);
    const out = info();
    r.npc.actor(id, out);
    expect(awareEvents(r).find((e) => e.level === 'aware')?.reaction).toBe('arm');
    expect(out.weaponDrawn).toBe(true);
    expect(out.state).toBe(ACTOR_STATE.hold);
    // Without a weapon there is nothing to draw.
    const unarmed = r.npc.spawnActor(spec(3501, P.x + 31, P.z, { building: B, profile: 'ambusher' }));
    r.npc.stimulate(unarmed, 'sound', 1, SRC.x, SRC.z);
    expect(awareEvents(r).filter((e) => e.level === 'aware')[1]?.reaction).toBe('none');
  });

  it('confront: armed actors brandish, unarmed ones fight when the officer is close and otherwise hold', async () => {
    const { r } = await rig();
    r.focus.building = B;
    r.focus.x = P.x + 30;
    r.focus.z = P.z + 2;
    r.run(1);
    const groups = [
      { weapon: 'knife', dz: 0, state: ACTOR_STATE.armed, ids: [] as number[] },
      { weapon: null, dz: 1, state: ACTOR_STATE.fight, ids: [] as number[] },
      { weapon: null, dz: -20, state: ACTOR_STATE.hold, ids: [] as number[] },
    ];
    let n = 0;
    for (const g of groups) {
      for (let i = 0; i < 16; i++) g.ids.push(r.npc.spawnActor(spec(3600 + 61 * n++, P.x + 30, P.z + g.dz, { building: B, profile: 'suspectHostile', weapon: g.weapon })));
    }
    for (const g of groups) for (const id of g.ids) r.npc.stimulate(id, 'sound', 1, SRC.x, SRC.z);
    const rolled = new Map<number, string>();
    for (const e of awareEvents(r)) if (e.level === 'aware') rolled.set(e.actorId as number, String(e.reaction));
    for (const g of groups) {
      const confronted = g.ids.filter((id) => rolled.get(id) === 'confront');
      expect(confronted.length).toBeGreaterThan(0);
      for (const id of confronted) expect(stateOf(r.npc, id)).toBe(g.state);
      // suspectHostile is confront .8 / hide .2, and the others hide in the stub's spot.
      for (const id of g.ids.filter((x) => rolled.get(x) === 'hide')) expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.hide);
    }
  });

  it('a cuffed actor cannot flee or hide', async () => {
    const { r } = await rig();
    const id = r.npc.spawnActor(spec(3700, P.x + 1.5, P.z, { profile: 'suspectFleeRisk' }));
    r.npc.forceState(id, 'handsUp');
    r.npc.cuff(id);
    r.npc.stimulate(id, 'sound', 1, SRC.x, SRC.z);
    expect(awareEvents(r).find((e) => e.level === 'aware')?.reaction).toBe('none');
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.cuffed);
  });

  it('a hidden actor is revealed when the reaction is surrender or flee', async () => {
    const { r } = await rig();
    const ids: number[] = [];
    for (let i = 0; i < 30; i++) ids.push(r.npc.spawnActor(spec(3800 + i * 29, P.x + 30, P.z, { building: B, hidden: true, profile: 'suspectFleeRisk' })));
    for (const id of ids) r.npc.stimulate(id, 'sound', 1, SRC.x, SRC.z);
    const reactions = awareEvents(r)
      .filter((e) => e.level === 'aware')
      .map((e) => e.reaction);
    expect(reactions).toContain('flee');
    const fled = ids.filter((_id, i) => reactions[i] === 'flee');
    for (const id of fled) {
      const out = info();
      r.npc.actor(id, out);
      expect(out.hidden).toBe(false);
      expect(out.state).toBe(ACTOR_STATE.flee);
    }
    expect(r.events['npc:revealed']?.length).toBe(fled.length);
  });

  it('every reaction id of the contract exists', () => {
    expect([...AWARE_REACTIONS]).toEqual(['none', 'hide', 'flee', 'confront', 'surrender', 'arm']);
  });
});

describe('listeners', () => {
  it('lists the actors within the radius on any level, reusing the objects', async () => {
    const { r } = await rig();
    const out1 = r.npc.spawnActor(spec(3900, P.x + 3, P.z, { profile: 'callerHelpful' }));
    const in1 = r.npc.spawnActor(spec(3901, P.x - 4, P.z, { profile: 'callerHelpful', building: B }));
    r.npc.spawnActor(spec(3902, P.x + 90, P.z, { profile: 'callerHelpful' }));
    const buf: Listener[] = [];
    expect(r.npc.listeners(P.x, P.z, 10, buf)).toBe(2);
    const first = buf[0];
    const ids = buf.slice(0, 2).map((l) => l.actorId).sort();
    expect(ids).toEqual([out1, in1].sort());
    const indoor = buf.find((l) => l.actorId === in1);
    expect(indoor?.building).toBe(B);
    expect(indoor?.personId).toBe(3901);
    expect(indoor?.x).toBe(P.x - 4);
    expect(indoor?.eyeY).toBe(1.6);
    expect(indoor?.asleep).toBe(false);
    // A second call writes into the same objects.
    expect(r.npc.listeners(P.x, P.z, 10, buf)).toBe(2);
    expect(buf[0]).toBe(first);
    expect(buf).toHaveLength(2);
    expect(r.npc.listeners(P.x, P.z, 1000, buf)).toBe(3);
    expect(r.npc.listeners(P.x + 500, P.z, 10, buf)).toBe(0);
  });

  it('maps the identity hearing and makes the deceased and unconscious deaf', async () => {
    const { r } = await rig();
    let hoh = -1;
    let deaf = -1;
    for (let id = 0; id < 20000 && (hoh < 0 || deaf < 0); id++) {
      const h = r.people.identity(id).hearing;
      if (h === 'hardOfHearing' && hoh < 0) hoh = id;
      if (h === 'deaf' && deaf < 0) deaf = id;
    }
    expect(hoh).toBeGreaterThanOrEqual(0);
    expect(deaf).toBeGreaterThanOrEqual(0);
    let normal = 0;
    while (r.people.identity(normal).hearing !== 'normal') normal++;
    r.npc.spawnActor(spec(normal, P.x + 1, P.z, { profile: 'callerHelpful' }));
    r.npc.spawnActor(spec(hoh, P.x + 2, P.z, { profile: 'callerHelpful' }));
    r.npc.spawnActor(spec(deaf, P.x + 3, P.z, { profile: 'callerHelpful' }));
    // A dog and a body (the body would be deaf whatever its identity says).
    r.npc.spawnActor(spec(-1, P.x + 4, P.z, { profile: 'animalDog', body: 'dog', role: 'dog' }));
    r.npc.spawnActor(spec(normal + 1000, P.x + 5, P.z, { profile: 'subjectDeceased' }));
    r.npc.spawnActor(spec(normal + 2000, P.x + 6, P.z, { profile: 'subjectUnconscious' }));
    const buf: Listener[] = [];
    expect(r.npc.listeners(P.x, P.z, 20, buf)).toBe(6);
    const by = new Map(buf.map((l) => [l.personId, l]));
    expect(by.get(normal)?.hearing).toBe('normal');
    expect(by.get(hoh)?.hearing).toBe('hardOfHearing');
    expect(by.get(deaf)?.hearing).toBe('deaf');
    expect(by.get(-1)?.hearing).toBe('normal');
    expect(by.get(normal + 1000)?.hearing).toBe('deaf');
    expect(by.get(normal + 2000)?.hearing).toBe('deaf');
  });

  it('asleep means lying between 00:00 and 06:00; eye height follows the pose', async () => {
    const { r } = await rig(NIGHT);
    const sleeper = r.npc.spawnActor(spec(3910, P.x + 1, P.z, { profile: 'callerHelpful', pose: 'lying' }));
    const sitter = r.npc.spawnActor(spec(3911, P.x + 2, P.z, { profile: 'callerHelpful', pose: 'sit' }));
    const body = r.npc.spawnActor(spec(3912, P.x + 3, P.z, { profile: 'subjectDeceased' }));
    const buf: Listener[] = [];
    expect(r.npc.listeners(P.x, P.z, 10, buf)).toBe(3);
    const by = new Map(buf.map((l) => [l.actorId, l]));
    expect(by.get(sleeper)?.asleep).toBe(true);
    expect(by.get(sleeper)?.eyeY).toBe(0.3);
    expect(by.get(sitter)?.asleep).toBe(false);
    expect(by.get(sitter)?.eyeY).toBe(1.1);
    expect(by.get(body)?.asleep).toBe(false);
    // In the afternoon the same person is simply lying there.
    r.clock.t = 15 * 3600;
    r.npc.listeners(P.x, P.z, 10, buf);
    expect(buf.find((l) => l.actorId === sleeper)?.asleep).toBe(false);
  });
});
