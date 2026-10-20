import { describe, expect, it } from 'vitest';
import { BackupSystem } from '../../src/backup/backupSystem';
import { BACKUP_CONFIG } from '../../src/backup/data';
import { coverSpot, poorCoverSpot, positionQuality } from '../../src/backup/geometry';
import { ACTOR_STATE } from '../../src/npc/types';
import {
  DT, Rig, SEED, START_FATIGUE, START_STRESS, NO_MISTAKES, findCallsigns, prepare, predictRolls,
  type Recorded,
} from './helpers';

const cfg = BACKUP_CONFIG;
const DEG = Math.PI / 180;

interface Callout { callsign: string; kind: string; text: string; late: boolean; callId: number }
interface Mistake { callsign: string; kind: string; callId: number }
interface Custody { callId: number; personId: number; actorId: number; by: string }

const CLEAN = findCallsigns(4, SEED, START_STRESS, START_FATIGUE, NO_MISTAKES);

/** The player at the origin facing north, talking to a subject (actor 1, person 101) 3 m ahead. */
function scene(rig: Rig): void {
  rig.openCall();
  rig.ctx.x = 0;
  rig.ctx.z = 0;
  rig.ctx.yaw = 0;
  rig.ctx.contactPersonId = 101;
  rig.npc.add({ id: 1, personId: 101, role: 'subject', x: 0, z: -3, state: ACTOR_STATE.idle });
}

function angleAt(sx: number, sz: number, ax: number, az: number, bx: number, bz: number): number {
  let d = Math.abs(Math.atan2(az - sz, ax - sx) - Math.atan2(bz - sz, bx - sx));
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d / DEG;
}

function times(events: Recorded[]): number[] {
  return events.map((e) => e.sim);
}

describe('spawning', () => {
  it('an AI unit on scene gets out at the driver door and takes cover at the right spot', () => {
    const rig = new Rig();
    scene(rig);
    const cs = CLEAN[0] as string;
    rig.unitOnScene(cs, 12, 6, 0);
    expect(rig.sys.onFoot(cs)).toBe(false);
    rig.step();
    expect(rig.sys.onFoot(cs)).toBe(true);
    const o0 = rig.sys.serialize().officers[0]!;
    expect(o0.fsm.state).toBe('exiting');
    expect(o0.fsm.role).toBe('cover');
    // 1.2 m to the left of a car heading north
    expect(o0.x).toBeCloseTo(12 - 1.2, 6);
    expect(o0.z).toBeCloseTo(6, 6);
    expect(rig.sys.view.count).toBe(1);
    expect(rig.of('backup:flash').length).toBe(1);

    expect(rig.until(() => rig.sys.officers()[0]?.state === 'cover', 20)).toBe(true);
    const v = rig.sys.officers()[0]!;
    expect(v.callsign).toBe(cs);
    expect(v.role).toBe('cover');
    expect(v.name).toBe(rig.roster.profile(cs)!.name);
    expect(v.quality).toBeGreaterThan(0.99);
    const o = rig.sys.serialize().officers[0]!;
    const d = Math.hypot(o.x - 0, o.z - -3);
    expect(d).toBeGreaterThanOrEqual(cfg.cover.distanceM[0] - 0.01);
    expect(d).toBeLessThanOrEqual(cfg.cover.distanceM[1] + 0.01);
    const angle = angleAt(0, -3, 0, 0, o.x, o.z);
    expect(angle).toBeGreaterThanOrEqual(cfg.cover.angleDeg[0] - 0.01);
    expect(angle).toBeLessThanOrEqual(cfg.cover.angleDeg[1] + 0.01);
    expect(positionQuality(0, 0, 0, -3, o.x, o.z, cfg)).toBeGreaterThan(0.99);
    // the figure is in the view where the renderer expects it
    expect(rig.sys.view.x[0]).toBeCloseTo(o.x, 3);
    expect(rig.sys.view.z[0]).toBeCloseTo(o.z, 3);
    expect(rig.sys.view.flags[0]).toBe(0);
  });

  it('calls out that it has cover exactly once, on the current channel', () => {
    const rig = new Rig();
    scene(rig);
    const cs = CLEAN[0] as string;
    rig.unitOnScene(cs, 12, 6, 0);
    rig.step(60 * 40);
    const covering = rig.of<Callout>('backup:callout').filter((c) => c.kind === 'covering');
    expect(covering.length).toBe(1);
    expect(covering[0]).toMatchObject({ callsign: cs, late: false, callId: rig.callId });
    expect(cfg.callouts.covering).toContain(covering[0]!.text);
    const radio = rig.of<{ channel: string; speaker: string; text: string }>('backup:radio');
    expect(radio.filter((r) => r.text === covering[0]!.text).length).toBe(1);
    expect(radio[0]).toMatchObject({ channel: 'current', speaker: cs });
  });

  it('ignores units that are not on scene, too far away, have no car, or are not foot units', () => {
    const rig = new Rig();
    scene(rig);
    // en route only
    rig.cad.addUnit({ callsign: 'EN', kind: 'ai', officer: 'x', beat: 'b', fleetIndex: 5 }, { sim: 0, game: 0 });
    rig.cars.set('EN', { x: 5, z: 5, yaw: 0 });
    rig.cad.assign(rig.callId, 'EN', { sim: 0, game: 0 }, 'dispatch');
    // far away
    rig.unitOnScene('FAR', 500, 0, 0);
    // on scene without a car pose
    rig.cad.addUnit({ callsign: 'NOCAR', kind: 'ai', officer: 'x', beat: 'b', fleetIndex: 6 }, { sim: 0, game: 0 });
    rig.cad.assign(rig.callId, 'NOCAR', { sim: 0, game: 0 }, 'dispatch');
    rig.cad.setUnitStatus('NOCAR', 'onScene', { sim: 0, game: 0 }, 'auto');
    // resource units that do not get out
    rig.unitOnScene('K9-1', 4, 4, 0, 'resource');
    rig.unitOnScene('MEDIC-1', 6, 4, 0, 'resource');
    rig.step(120);
    expect(rig.sys.officers().length).toBe(0);
    expect(rig.sys.view.count).toBe(0);
  });

  it('puts at most maxOfficers on foot and a supervisor always on standby', () => {
    const rig = new Rig();
    scene(rig);
    for (let i = 0; i < 10; i++) rig.unitOnScene(`P${i}`, 10 + i, 8, 0);
    rig.step(10);
    expect(rig.sys.officers().length).toBe(cfg.spawn.maxOfficers);
    expect(rig.sys.view.count).toBe(cfg.spawn.maxOfficers);
    const roles = rig.sys.officers().map((o) => o.role);
    expect(roles.filter((r) => r === 'cover').length).toBe(1);
    expect(roles.filter((r) => r === 'secondary').length).toBe(1);
    expect(roles.filter((r) => r === 'standby').length).toBe(6);

    const r2 = new Rig();
    scene(r2);
    r2.unitOnScene('SGT-1', 12, 6, 0, 'resource');
    r2.step(5);
    const sgt = r2.sys.officers()[0]!;
    expect(sgt.role).toBe('standby');
    expect(sgt.name.startsWith('Sgt. ')).toBe(true);
  });

  it('cover goes to the first officer, secondary to the second, then standby, whatever the callsigns', () => {
    const rig = new Rig();
    scene(rig);
    CLEAN.slice(0, 3).forEach((cs, i) => rig.unitOnScene(cs, 12 + i, 8, 0));
    rig.step(5);
    expect(rig.sys.officers().map((o) => o.role)).toEqual(['cover', 'secondary', 'standby']);
  });
});

describe('cover without a contact actor', () => {
  it('covers against the stopped car given in the context, ignoring bystanders', () => {
    const rig = new Rig();
    rig.openCall();
    rig.ctx.contactPersonId = 500;
    rig.ctx.subject = { x: 0, z: -4 };
    rig.npc.add({ id: 4, personId: 104, role: 'bystander', x: 30, z: 0 });
    rig.unitOnScene(CLEAN[0] as string, 12, 6, 0);
    expect(rig.until(() => rig.sys.officers()[0]?.state === 'cover', 30)).toBe(true);
    const o = rig.sys.serialize().officers[0]!;
    expect(positionQuality(0, 0, 0, -4, o.x, o.z, cfg)).toBeGreaterThan(0.99);
    expect(rig.sys.officers()[0]!.quality).toBeGreaterThan(0.99);
  });
});

describe('secondary officer', () => {
  function two(): Rig {
    const rig = new Rig();
    scene(rig);
    rig.npc.add({ id: 2, personId: 102, role: 'passenger', x: 5, z: -1, state: ACTOR_STATE.idle });
    rig.unitOnScene(CLEAN[0] as string, 12, 6, 0);
    rig.unitOnScene(CLEAN[1] as string, 14, 6, 0);
    return rig;
  }

  it('commands a passenger: show hands, then stop, every commandEveryS', () => {
    const rig = two();
    rig.npc.outcome = 'refuse';
    rig.step(60 * 30);
    const sent = rig.npc.evaluated.filter((e) => e.id === 2);
    expect(sent.map((e) => e.cmd).slice(0, 3)).toEqual(['showHands', 'stop', 'showHands']);
    expect(sent[0]!.ctx).toMatchObject({ tone: 'commanding', rapport: 0, commMode: 'verbal', weapon: 'sidearm', lights: false, backup: 2 });
    expect(rig.npc.commands.length).toBe(sent.length);
    // the contact subject is the cover officer's, never the secondary's
    expect(rig.npc.evaluated.filter((e) => e.id === 1).length).toBe(0);
    // one second-subject callout for the passenger
    const second = rig.of<Callout>('backup:callout').filter((c) => c.kind === 'secondSubject');
    expect(second.length).toBe(1);
    // the secondary officer stands the standoff distance from the passenger
    const sec = rig.sys.serialize().officers.find((o) => o.fsm.role === 'secondary')!;
    expect(Math.abs(Math.hypot(sec.x - 5, sec.z - -1) - cfg.secondary.standoffM)).toBeLessThan(cfg.move.arriveM);
    expect(sec.fsm.state).toBe('secondary');
  });

  it('a compliant passenger is cuffed and reported without a chase', () => {
    const rig = two();
    rig.npc.outcome = 'comply';
    expect(rig.until(() => rig.of('backup:custody').length > 0, 40)).toBe(true);
    const c = rig.of<Custody>('backup:custody')[0]!;
    expect(c).toMatchObject({ callId: rig.callId, personId: 102, actorId: 2, by: CLEAN[1] });
    expect(rig.npc.actors.get(2)!.cuffed).toBe(true);
    expect(rig.npc.tackles.length).toBe(0);
  });

  it('a passenger who flees is chased, tackled, cuffed and reported in custody', () => {
    const rig = two();
    rig.npc.outcome = 'flee';
    const states = new Set<string>();
    const runner = rig.npc.actors.get(2)!;
    let ok = false;
    for (let i = 0; i < 60 * 60 && !ok; i++) {
      if (runner.state === ACTOR_STATE.flee) runner.x += 3 * DT;
      rig.step();
      const sec = rig.sys.officers().find((o) => o.callsign === CLEAN[1]);
      if (sec) states.add(sec.state);
      ok = rig.of('backup:custody').length > 0;
    }
    expect(ok).toBe(true);
    rig.step(60 * 3);
    expect([...states]).toEqual(expect.arrayContaining(['secondary', 'chase', 'detain']));
    expect(rig.npc.tackles.length).toBeGreaterThan(0);
    expect(rig.npc.actors.get(2)!.cuffed).toBe(true);
    const callouts = rig.of<Callout>('backup:callout').map((c) => c.kind);
    expect(callouts).toEqual(expect.arrayContaining(['runner', 'inCustody']));
    const runnerLine = rig.of<Callout>('backup:callout').find((c) => c.kind === 'runner')!;
    expect(runnerLine.text).toMatch(/bound|running/);
    const radio = rig.of<{ priority?: boolean; text: string }>('backup:radio').find((r) => r.text === runnerLine.text)!;
    expect(radio.priority).toBe(true);
    // afterwards the officer settles back into the secondary role
    rig.step(60 * 10);
    expect(rig.sys.officers().find((o) => o.callsign === CLEAN[1])!.state).toBe('secondary');
  });

  it('gives up a chase when the runner gets too far away', () => {
    const rig = two();
    rig.npc.outcome = 'flee';
    const runner = rig.npc.actors.get(2)!;
    // a runner far faster than any officer
    for (let i = 0; i < 60 * 80; i++) {
      if (runner.state === ACTOR_STATE.flee) runner.x += 12 * DT;
      rig.step();
    }
    const sec = rig.sys.officers().find((o) => o.callsign === CLEAN[1])!;
    expect(sec.state).not.toBe('chase');
    expect(rig.of('backup:custody').length).toBe(0);
  });

  it('the detain command with a target person walks to them and cuffs a kneeling subject', () => {
    const rig = new Rig();
    scene(rig);
    rig.npc.add({ id: 2, personId: 102, role: 'bystander', x: 8, z: 2, state: ACTOR_STATE.kneel });
    rig.unitOnScene(CLEAN[0] as string, 12, 6, 0);
    rig.step(60 * 4);
    rig.sys.request({ kind: 'command', callsign: CLEAN[0] as string, command: 'detain', targetPersonId: 102 });
    expect(rig.until(() => rig.of('backup:custody').length > 0, 30)).toBe(true);
    expect(rig.of<Custody>('backup:custody')[0]).toMatchObject({ personId: 102, actorId: 2, by: CLEAN[0] });
  });
});

describe('observations and callouts', () => {
  it('a drawn weapon is called out quickly and raises stress once', () => {
    const rig = new Rig();
    scene(rig);
    const cs = CLEAN[0] as string;
    rig.unitOnScene(cs, 12, 6, 0);
    rig.step(60 * 6);
    const before = rig.roster.dynamic(cs)!.stress;
    const t0 = rig.sim;
    rig.npc.actors.get(1)!.weaponDrawn = true;
    rig.step(60 * 6);
    const lines = rig.events.filter((e) => e.topic === 'backup:callout' && (e.payload as Callout).kind === 'weapon');
    expect(lines.length).toBe(1);
    const delay = lines[0]!.sim - t0;
    expect(delay).toBeGreaterThanOrEqual(cfg.callout.delayS[0]);
    expect(delay).toBeLessThanOrEqual(cfg.callout.delayS[1] + 0.25 + 0.05);
    expect((lines[0]!.payload as Callout).late).toBe(false);
    expect(rig.roster.dynamic(cs)!.stress - before).toBeCloseTo(0.25, 9);
    expect(rig.of('backup:mistake').length).toBe(0);
    // the weapon callout repeats only after the cooldown
    rig.step(60 * 10);
    expect(rig.of<Callout>('backup:callout').filter((c) => c.kind === 'weapon').length).toBe(2);
    // armed contact: the cover officer draws
    expect(rig.sys.view.held[0]).toBe(6);
    expect(rig.sys.view.pose[0]).toBe(8);
  });

  it('with the lateCallout mistake the weapon callout comes lateDelayS after it and the mistake shows', () => {
    const [cs] = findCallsigns(1, SEED, 0.9, 0.9, (r) => r.lateCallout && !r.poorPosition && !r.excessiveForce) as [string];
    const rig = new Rig();
    scene(rig);
    prepare(rig, cs, 0.9, 0.9);
    rig.unitOnScene(cs, 12, 6, 0);
    rig.step(60 * 8);
    const t0 = rig.sim;
    rig.npc.actors.get(1)!.weaponDrawn = true;
    rig.step(60 * 14);
    const line = rig.events.find((e) => e.topic === 'backup:callout' && (e.payload as Callout).kind === 'weapon')!;
    expect(line).toBeDefined();
    expect((line.payload as Callout).late).toBe(true);
    const delay = line.sim - t0;
    expect(delay).toBeGreaterThanOrEqual(cfg.callout.lateDelayS[0]);
    expect(delay).toBeLessThanOrEqual(cfg.callout.lateDelayS[1] + 0.25 + 0.05);
    const mistakes = rig.events.filter((e) => e.topic === 'backup:mistake');
    expect(mistakes.length).toBe(1);
    expect(mistakes[0]!.payload as Mistake).toMatchObject({ callsign: cs, kind: 'lateCallout', callId: rig.callId });
    expect(mistakes[0]!.sim).toBeCloseTo(line.sim, 6);
    expect(rig.roster.dynamic(cs)!.mistakes).toBe(1);
    // the routine "covering" call was not delayed
    const covering = rig.of<Callout>('backup:callout').find((c) => c.kind === 'covering')!;
    expect(covering.late).toBe(false);
  });

  it('the poorPosition mistake puts the officer in the crossfire and shows on reaching cover', () => {
    const [cs] = findCallsigns(1, SEED, 0.9, 0.9, (r) => r.poorPosition && !r.lateCallout && !r.excessiveForce) as [string];
    const rig = new Rig();
    scene(rig);
    prepare(rig, cs, 0.9, 0.9);
    rig.unitOnScene(cs, 12, 6, 0);
    expect(rig.until(() => rig.sys.officers()[0]?.state === 'cover', 30)).toBe(true);
    const o = rig.sys.serialize().officers[0]!;
    const spot = { x: 0, z: 0, yaw: 0 };
    poorCoverSpot(0, 0, 0, -3, cfg, spot);
    expect(Math.hypot(o.x - spot.x, o.z - spot.z)).toBeLessThan(0.5);
    expect(rig.sys.officers()[0]!.quality).toBeLessThan(0.05);
    const m = rig.of<Mistake>('backup:mistake');
    expect(m.length).toBe(1);
    expect(m[0]).toMatchObject({ callsign: cs, kind: 'poorPosition' });
    expect(rig.roster.dynamic(cs)!.mistakes).toBe(1);
    // a good officer would have stood at coverSpot instead
    coverSpot(0, 0, 0, -3, 52 * DEG, 5.5, 1, spot);
    expect(Math.hypot(o.x - spot.x, o.z - spot.z)).toBeGreaterThan(1);
  });

  it('calls out fights, raises stress and loyalty once, and hands clear for the cover target', () => {
    const rig = new Rig();
    scene(rig);
    const cs = CLEAN[0] as string;
    rig.unitOnScene(cs, 12, 6, 0);
    rig.step(60 * 6);
    const dyn = rig.roster.dynamic(cs)!;
    const stress0 = dyn.stress;
    const loyalty0 = dyn.loyalty;
    rig.npc.actors.get(1)!.state = ACTOR_STATE.fight;
    rig.step(60 * 5);
    expect(rig.of<Callout>('backup:callout').some((c) => c.kind === 'fight')).toBe(true);
    expect(dyn.stress - stress0).toBeCloseTo(0.2, 9);
    expect(dyn.loyalty - loyalty0).toBeCloseTo(0.04, 9);
    rig.npc.actors.get(1)!.state = ACTOR_STATE.handsUp;
    rig.step(60 * 3);
    expect(rig.of<Callout>('backup:callout').filter((c) => c.kind === 'handsClear').length).toBe(1);
  });

  it('shots fired and force used nearby stress the officers', () => {
    const rig = new Rig();
    scene(rig);
    const cs = CLEAN[0] as string;
    rig.unitOnScene(cs, 12, 6, 0);
    rig.step(60 * 4);
    const dyn = rig.roster.dynamic(cs)!;
    const s0 = dyn.stress;
    rig.bus.emit('npc:attack', { actorId: 1, personId: 101, callId: rig.callId, kind: 'fire' });
    rig.step(60);
    expect(dyn.stress - s0).toBeCloseTo(0.45, 9);
    const s1 = dyn.stress;
    rig.bus.emit('force:applied', { seq: 1, tool: 'taser', level: 'taser', personId: 101, actorId: 1, callId: rig.callId, resistance: 'active', hit: true, injury: 0, fatal: false, cycle: 1, riskFactors: [], distance: 5, restrained: false, sim: rig.sim });
    rig.step(60);
    expect(dyn.stress - s1).toBeCloseTo(0.1, 9);
    // a shot far away does not
    rig.npc.add({ id: 9, personId: 109, role: 'subject', x: 500, z: 500, callId: 99 });
    const s2 = dyn.stress;
    rig.bus.emit('npc:attack', { actorId: 9, personId: 109, callId: 99, kind: 'fire' });
    rig.step(60);
    expect(dyn.stress).toBe(s2);
  });

  it('a vehicle pursuit stresses the officers on foot once per pursuit', () => {
    const rig = new Rig();
    scene(rig);
    const cs = CLEAN[0] as string;
    rig.unitOnScene(cs, 12, 6, 0);
    rig.step(60 * 4);
    const dyn = rig.roster.dynamic(cs)!;
    const s0 = dyn.stress;
    const ev = { kind: 'vehicle', active: true, callId: 5, ownerCallId: rig.callId, personId: 101 } as const;
    rig.bus.emit('scene:pursuit', ev);
    rig.bus.emit('scene:pursuit', ev);
    rig.step(60);
    expect(dyn.stress - s0).toBeCloseTo(0.06, 9);
    rig.bus.emit('scene:pursuit', { ...ev, kind: 'foot', callId: 6 });
    rig.bus.emit('scene:pursuit', { ...ev, active: false });
    rig.step(60);
    expect(dyn.stress - s0).toBeCloseTo(0.06, 9);
  });

  it('the player leaving the scene for a minute counts as abandoning the officers, once', () => {
    const rig = new Rig();
    scene(rig);
    const cs = CLEAN[0] as string;
    rig.unitOnScene(cs, 12, 6, 0);
    rig.step(60 * 6);
    const l0 = rig.roster.dynamic(cs)!.loyalty;
    rig.ctx.x = 400;
    rig.step(60 * 50);
    expect(rig.roster.dynamic(cs)!.loyalty).toBe(l0);
    rig.step(60 * 30);
    expect(rig.roster.dynamic(cs)!.loyalty).toBeCloseTo(l0 - 0.04, 9);
    rig.step(60 * 80);
    expect(rig.roster.dynamic(cs)!.loyalty).toBeCloseTo(l0 - 0.04, 9);
  });
});

describe('fellows and the force mistake', () => {
  it('lists the on-foot officers with the excessive-force chance raised only for the rolled officer', () => {
    const [bad] = findCallsigns(1, SEED, 1, 1, (r) => r.excessiveForce) as [string];
    const rig = new Rig();
    scene(rig);
    prepare(rig, bad, 1, 1);
    rig.unitOnScene(bad, 12, 6, 0);
    rig.unitOnScene(CLEAN[0] as string, 14, 6, 0);
    rig.step(10);
    // still getting out: not yet a fellow
    expect(rig.sys.fellows().length).toBe(0);
    rig.step(60 * 3);
    const f = rig.sys.fellows();
    expect(f.length).toBe(2);
    const fb = f.find((x) => x.callsign === bad)!;
    expect(fb.misconductChance).toBe(1);
    expect(fb.name).toBe(rig.roster.profile(bad)!.name);
    expect(fb.building).toBe(-1);
    const o = rig.sys.serialize().officers.find((x) => x.callsign === bad)!;
    expect(fb.x).toBeCloseTo(o.x, 9);
    expect(fb.z).toBeCloseTo(o.z, 9);
    expect(f.find((x) => x.callsign === CLEAN[0])!.misconductChance).toBe(0);
    // the array is reused
    expect(rig.sys.fellows()).toBe(f);
  });

  it('shows the excessiveForce mistake when the force module reports this officer, and only then', () => {
    const [bad] = findCallsigns(1, SEED, 1, 1, (r) => r.excessiveForce) as [string];
    const rig = new Rig();
    scene(rig);
    prepare(rig, bad, 1, 1);
    rig.unitOnScene(bad, 12, 6, 0);
    rig.unitOnScene(CLEAN[0] as string, 14, 6, 0);
    rig.step(60 * 4);
    expect(rig.of('backup:mistake').filter((m) => (m as Mistake).kind === 'excessiveForce').length).toBe(0);
    const name = rig.roster.profile(bad)!.name;
    const other = (seq: number, officer: string): void =>
      rig.bus.emit('force:other', { seq, officer, level: 'hardHands', personId: 101, actorId: 1, callId: rig.callId, resistance: 'compliant', restrained: true, distanceToOfficer: 3, injury: 0.1, sim: rig.sim });
    other(1, rig.roster.profile(CLEAN[0] as string)!.name);
    rig.step(2);
    expect(rig.of('backup:mistake').length).toBe(0);
    other(2, name);
    rig.step(2);
    other(3, name);
    rig.step(2);
    const m = rig.of<Mistake>('backup:mistake');
    expect(m).toEqual([{ callsign: bad, kind: 'excessiveForce', callId: rig.callId }]);
    expect(rig.roster.dynamic(bad)!.mistakes).toBe(1);
  });

  it('stopping an officer costs loyalty', () => {
    const rig = new Rig();
    scene(rig);
    const cs = CLEAN[0] as string;
    rig.unitOnScene(cs, 12, 6, 0);
    rig.step(60 * 4);
    const l0 = rig.roster.dynamic(cs)!.loyalty;
    const name = rig.roster.profile(cs)!.name;
    rig.bus.emit('force:other', { seq: 7, officer: name, level: 'hardHands', personId: 101, actorId: 1, callId: rig.callId, resistance: 'compliant', restrained: true, distanceToOfficer: 3, injury: 0.1, sim: rig.sim });
    rig.bus.emit('force:intervened', { otherSeq: 7, personId: 101, callId: rig.callId, sim: rig.sim });
    rig.step(2);
    expect(rig.roster.dynamic(cs)!.loyalty).toBeCloseTo(l0 - 0.08, 9);
  });
});

describe('release', () => {
  it('an officer whose unit leaves the call runs back to the car and is gone; the car waits until then', () => {
    const rig = new Rig();
    scene(rig);
    const cs = CLEAN[0] as string;
    rig.unitOnScene(cs, 12, 6, 0);
    rig.step(60 * 6);
    expect(rig.sys.officers()[0]!.state).toBe('cover');
    rig.release(cs);
    rig.step(2);
    expect(rig.sys.officers()[0]!.state).toBe('returning');
    expect(rig.sys.onFoot(cs)).toBe(true);
    const run = rig.sys.view.pose[0];
    expect(run).toBe(2);
    expect(rig.until(() => !rig.sys.onFoot(cs), 20)).toBe(true);
    expect(rig.sys.officers().length).toBe(0);
    expect(rig.sys.view.flags[0]).toBe(2);
    expect(rig.sys.view.count).toBe(0);
    // it ran to the car's driver door
    const car = rig.cars.get(cs)!;
    expect(rig.sys.serialize().officers.length).toBe(0);
    expect(car.x).toBe(12);
  });

  it('the release command does the same without respawning while the unit stays on scene', () => {
    const rig = new Rig();
    scene(rig);
    const cs = CLEAN[0] as string;
    rig.unitOnScene(cs, 12, 6, 0);
    rig.step(60 * 6);
    rig.sys.request({ kind: 'command', callsign: cs, command: 'release' });
    expect(rig.until(() => !rig.sys.onFoot(cs), 20)).toBe(true);
    rig.step(60 * 30);
    expect(rig.sys.onFoot(cs)).toBe(false);
    expect(rig.sys.officers().length).toBe(0);
    // finished officers are remembered (not respawned) in the save until the unit leaves
    expect(rig.sys.serialize().officers.map((o) => o.fsm.state)).toEqual(['gone']);
    rig.release(cs);
    rig.step(2);
    expect(rig.sys.serialize().officers.length).toBe(0);
    // a later arrival on a new call rolls again (seq 2)
    rig.openCall();
    rig.cad.assign(rig.callId, cs, { sim: rig.sim, game: 0 }, 'dispatch');
    rig.cad.setUnitStatus(cs, 'onScene', { sim: rig.sim, game: 0 }, 'auto');
    rig.step(2);
    expect(rig.sys.serialize().officers[0]!.seq).toBe(2);
  });

  it('closing the player call (no call in the context) sends everyone back', () => {
    const rig = new Rig();
    scene(rig);
    for (let i = 0; i < 3; i++) rig.unitOnScene(CLEAN[i] as string, 12 + i, 6, 0);
    rig.step(60 * 6);
    expect(rig.sys.officers().length).toBe(3);
    rig.ctx.callId = 0;
    rig.step(2);
    expect(rig.sys.officers().every((o) => o.state === 'returning')).toBe(true);
    rig.step(60 * 20);
    expect(rig.sys.officers().length).toBe(0);
  });

  it('commands: cover/secondary/standby re-role, regroup, "all", and unknown callsigns are ignored', () => {
    const rig = new Rig();
    scene(rig);
    for (let i = 0; i < 3; i++) rig.unitOnScene(CLEAN[i] as string, 12 + i, 6, 0);
    rig.step(60 * 6);
    rig.sys.request({ kind: 'command', callsign: CLEAN[2] as string, command: 'cover' });
    rig.sys.request({ kind: 'command', callsign: 'nobody', command: 'release' });
    rig.step(2);
    const byCs = (cs: string) => rig.sys.officers().find((o) => o.callsign === cs)!;
    expect(byCs(CLEAN[2] as string).role).toBe('cover');
    expect(rig.sys.officers().length).toBe(3);
    rig.sys.request({ kind: 'command', callsign: 'all', command: 'standby' });
    rig.step(2);
    expect(rig.sys.officers().every((o) => o.role === 'standby')).toBe(true);
    rig.sys.request({ kind: 'command', callsign: 'all', command: 'regroup' });
    rig.step(60 * 10);
    expect(rig.sys.officers().every((o) => o.state === 'standby')).toBe(true);
    // standby officers stand behind the player (south, +z), within a few metres
    for (const o of rig.sys.serialize().officers) {
      expect(o.z).toBeGreaterThan(1);
      expect(Math.hypot(o.x, o.z)).toBeLessThan(8);
    }
    rig.sys.request({ kind: 'command', callsign: 'all', command: 'release' });
    rig.step(60 * 20);
    expect(rig.sys.officers().length).toBe(0);
  });
});

describe('posts', () => {
  it('staffs, reports and clears posts, never taking the cover officer', () => {
    const rig = new Rig();
    scene(rig);
    for (let i = 0; i < 3; i++) rig.unitOnScene(CLEAN[i] as string, 12 + i, 6, 0);
    // nobody is on foot yet
    expect(rig.sys.staffPost({ id: 'p0', x: 20, z: 20, yaw: 0, kind: 'inner' })).toBeNull();
    rig.step(60 * 6);
    const roles = Object.fromEntries(rig.sys.officers().map((o) => [o.callsign, o.role]));
    const standby = CLEAN[2] as string;
    expect(roles[standby]).toBe('standby');

    expect(rig.sys.staffed('inner')).toBe(0);
    expect(rig.sys.staffPost({ id: 'in1', x: 20, z: 20, yaw: 1, kind: 'inner' })).toBe(standby);
    // the same post id moves instead of taking another officer
    expect(rig.sys.staffPost({ id: 'in1', x: 20, z: 21, yaw: 1, kind: 'inner' })).toBe(standby);
    expect(rig.until(() => rig.sys.staffed('inner') === 1, 30)).toBe(true);
    const o = rig.sys.serialize().officers.find((x) => x.callsign === standby)!;
    expect(o.fsm).toMatchObject({ state: 'post', role: 'post' });
    expect(Math.hypot(o.x - 20, o.z - 21)).toBeLessThan(cfg.post.staffedM);
    expect(rig.sys.officers().find((x) => x.callsign === standby)!.post).toBe('in1');

    // the secondary officer is next; the cover officer is never taken
    expect(rig.sys.staffPost({ id: 'tcp1', x: -20, z: 20, yaw: 0, kind: 'tcp' })).toBe(CLEAN[1]);
    expect(rig.sys.staffPost({ id: 'tcp2', x: -25, z: 20, yaw: 0, kind: 'tcp' })).toBeNull();
    expect(rig.until(() => rig.sys.staffed('tcp') === 1, 30)).toBe(true);
    expect(rig.sys.staffed('inner')).toBe(1);
    expect(rig.sys.staffed('evac')).toBe(0);

    rig.sys.clearPosts('inner');
    rig.step(2);
    expect(rig.sys.staffed('inner')).toBe(0);
    expect(rig.sys.officers().find((x) => x.callsign === standby)!.role).toBe('standby');
    expect(rig.sys.staffed('tcp')).toBe(1);
    rig.sys.clearPosts();
    rig.step(2);
    expect(rig.sys.staffed('tcp')).toBe(0);
  });

  it('queued post and clearPosts requests work like the port methods', () => {
    const rig = new Rig();
    scene(rig);
    for (let i = 0; i < 3; i++) rig.unitOnScene(CLEAN[i] as string, 12 + i, 6, 0);
    rig.step(60 * 6);
    rig.sys.request({ kind: 'post', id: 'e1', x: 15, z: 15, yaw: 0, postKind: 'evac' });
    rig.step(2);
    expect(rig.sys.officers().filter((o) => o.post === 'e1').length).toBe(1);
    expect(rig.until(() => rig.sys.staffed('evac') === 1, 30)).toBe(true);
    rig.sys.request({ kind: 'clearPosts', postKind: 'evac' });
    rig.step(2);
    expect(rig.sys.staffed('evac')).toBe(0);
  });

  it('an officer sent back to the car drops its post', () => {
    const rig = new Rig();
    scene(rig);
    for (let i = 0; i < 3; i++) rig.unitOnScene(CLEAN[i] as string, 12 + i, 6, 0);
    rig.step(60 * 6);
    const cs = rig.sys.staffPost({ id: 'x', x: 20, z: 20, yaw: 0, kind: 'inner' })!;
    rig.step(2);
    rig.sys.request({ kind: 'command', callsign: cs, command: 'release' });
    rig.step(2);
    expect(rig.sys.officers().find((o) => o.callsign === cs)!.post).toBeNull();
    expect(rig.sys.staffed('inner')).toBe(0);
  });
});

describe('view', () => {
  it('writes the officers in place into stable slots', () => {
    const rig = new Rig();
    scene(rig);
    for (let i = 0; i < 3; i++) rig.unitOnScene(CLEAN[i] as string, 12 + i * 2, 6, 0);
    const arrays = [rig.sys.view.x, rig.sys.view.z, rig.sys.view.pose, rig.sys.view.flags];
    rig.step(60 * 6);
    expect([rig.sys.view.x, rig.sys.view.z, rig.sys.view.pose, rig.sys.view.flags]).toEqual(arrays);
    expect(rig.sys.view.count).toBe(3);
    // the first officer leaves; the others keep their slots
    const x1 = rig.sys.view.x[1];
    rig.sys.request({ kind: 'command', callsign: CLEAN[0] as string, command: 'release' });
    rig.step(60 * 15);
    expect(rig.sys.view.flags[0]).toBe(2);
    expect(rig.sys.view.x[1]).toBe(x1);
    expect(rig.sys.view.count).toBe(3);
    expect(rig.sys.revision).toBeGreaterThan(0);
  });

  it('is a BackupSystem with the port methods', () => {
    const rig = new Rig();
    expect(rig.sys).toBeInstanceOf(BackupSystem);
    expect(typeof rig.sys.staffPost).toBe('function');
    expect(rig.sys.swatPhase(99)).toBeNull();
    expect(predictRolls(SEED, 'U1', 0.1, 0.05)).toBeDefined();
    expect(times([])).toEqual([]);
  });
});
