import { describe, expect, it } from 'vitest';
import { COMMAND_CONFIG, parseCommandConfig } from '../../src/command/data';
import { isCommandSave, type CommandSave } from '../../src/command/save';
import { startTriage, victimVitals } from '../../src/command/triage';
import commandJson from '../../src/data/command/command.json';
import { ACTOR_STATE } from '../../src/npc/types';
import { DOOR, Rig, at } from './helpers';

/** The tag START gives a victim of the rig's scene. */
function answer(personId: number, role: string, injured: boolean, trapped = false, hazmat = false) {
  return startTriage(victimVitals(42, personId, role, injured ? 1 : 0, { trapped, hazmat }));
}

function cfgWith(patch: Record<string, Record<string, unknown>>) {
  const raw = JSON.parse(JSON.stringify(commandJson)) as Record<string, Record<string, unknown>>;
  for (const [k, v] of Object.entries(patch)) raw[k] = { ...raw[k], ...v };
  return parseCommandConfig(raw);
}

describe('command post', () => {
  it('an MCI call establishes a post automatically with commandPost and icsTransport', () => {
    const rig = new Rig();
    rig.openCall();
    rig.victims();
    expect(rig.sys.post()).toBeNull();
    rig.run(1);
    const post = rig.sys.post();
    expect(post).not.toBeNull();
    expect(post?.callId).toBe(rig.callId);
    expect(post?.level).toBe('disaster');
    expect(post?.commander).toBe('1-A-12');
    expect(rig.flagRequests()).toEqual(expect.arrayContaining(['commandPost', 'icsTransport']));
    const events = rig.of('command:post') as { open: boolean; level: string; callId: number }[];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ open: true, level: 'disaster', callId: rig.callId });
    expect(rig.radios().some((t) => t.includes('establishing command at Main Street at 1st Street, disaster incident'))).toBe(true);
  });

  it('does not open a post away from the scene, without a scenario or when a family has no level', () => {
    const far = new Rig();
    far.openCall();
    far.ctx.x += 500;
    far.run(1);
    expect(far.sys.post()).toBeNull();

    const none = new Rig();
    none.openCall();
    none.fakes.hasScenario = false;
    none.run(1);
    expect(none.sys.post()).toBeNull();

    const quiet = new Rig({ family: 'disturbance' });
    quiet.openCall();
    quiet.run(1);
    expect(quiet.sys.post()).toBeNull();
  });

  it('can be established by request on any call, at least at incident level', () => {
    const rig = new Rig({ family: 'disturbance' });
    rig.openCall('disturbanceNoise');
    rig.sys.request({ kind: 'establish' });
    rig.run(0.1);
    expect(rig.sys.post()?.level).toBe('incident');
    expect(rig.flagRequests()).toEqual(['commandPost']);
  });

  it('places the post on the player side of the incident', () => {
    const rig = new Rig();
    rig.openCall();
    rig.run(1);
    const post = rig.sys.post();
    expect(post).not.toBeNull();
    expect(post?.x).toBeGreaterThan(rig.incident.x);
  });

  it('a lieutenant or chief on scene takes command', () => {
    const rig = new Rig();
    rig.openCall();
    rig.run(1);
    rig.fakes.onScene.set('lieutenant', ['LT-1']);
    rig.run(1);
    expect(rig.sys.post()?.commander).toBe('LT-1');
    expect(rig.radios()).toContain('LT-1 assuming command.');
    rig.fakes.onScene.set('chief', ['CHIEF-1']);
    rig.run(1);
    expect(rig.sys.post()?.commander).toBe('CHIEF-1');
  });

  it('closes when the call closes, releasing posts and blockades', () => {
    const rig = new Rig();
    rig.openCall();
    rig.run(1);
    rig.sys.request({ kind: 'tcp', on: true });
    rig.run(0.5);
    expect(rig.sys.blockades().length).toBeGreaterThan(0);
    rig.cad.closeCall(rig.callId, 'handled', at(rig.sim));
    rig.run(0.5);
    expect(rig.sys.post()).toBeNull();
    expect(rig.sys.blockades()).toEqual([]);
    const events = rig.of('command:post') as { open: boolean }[];
    expect(events.map((e) => e.open)).toEqual([true, false]);
    expect(rig.fakes.cleared).toContain(undefined);
    expect(rig.sys.hud()).toBeNull();
  });

  it('stand down closes the post and does not reopen it automatically', () => {
    const rig = new Rig();
    rig.openCall();
    rig.run(1);
    rig.sys.request({ kind: 'standDown' });
    rig.run(1);
    expect(rig.sys.post()).toBeNull();
    rig.run(2);
    expect(rig.sys.post()).toBeNull();
    rig.sys.request({ kind: 'establish' });
    rig.run(0.5);
    expect(rig.sys.post()).not.toBeNull();
  });

  it('requests need a post', () => {
    const rig = new Rig();
    rig.openCall();
    rig.ctx.x += 500; // out of auto range
    rig.sys.request({ kind: 'evacuate' });
    rig.run(0.5);
    expect(rig.flashes()[0]).toMatch(/establish command first/i);
  });
});

describe('player triage', () => {
  function setup() {
    const rig = new Rig({ config: cfgWith({ triage: { assessS: 6 } }) });
    rig.openCall();
    const ids = rig.victims();
    rig.run(1);
    return { rig, ids };
  }

  it('assesses the nearest untagged victim for assessS, then shows vitals but never the START answer', () => {
    const { rig, ids } = setup();
    rig.sys.request({ kind: 'assess' });
    rig.run(0.5);
    let prompt = rig.sys.triage();
    expect(prompt).not.toBeNull();
    expect(prompt?.personId).toBe(ids[0]);
    expect(prompt?.vitals).toBeNull();
    expect(prompt?.progress).toBeGreaterThan(0);
    expect(prompt?.progress).toBeLessThan(0.2);
    rig.run(6);
    prompt = rig.sys.triage();
    expect(prompt?.progress).toBe(1);
    expect(prompt?.vitals).not.toBeNull();
    expect(prompt?.vitals?.respRate).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(prompt)).not.toMatch(/expectant|immediate|delayed|minor/);
    expect(Object.keys(prompt ?? {}).sort()).toEqual(['label', 'personId', 'progress', 'tag', 'vitals']);
  });

  it('a correct tag is graded correct and flashed', () => {
    const { rig, ids } = setup();
    rig.sys.request({ kind: 'assess' });
    rig.run(7);
    const personId = ids[0] as number;
    const right = answer(personId, 'victim', true);
    rig.sys.request({ kind: 'tag', personId, tag: right });
    rig.run(0.5);
    const ev = rig.of('command:triage') as { personId: number; tag: string; correct: boolean; by: string }[];
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ personId, tag: right, correct: true, by: 'player' });
    expect(rig.flashes().some((t) => /correct/.test(t))).toBe(true);
    expect(rig.sys.triage()).toBeNull();
    const row = rig.sys.board().victims.find((v) => v.personId === personId);
    expect(row).toMatchObject({ tag: right, by: 'player', correct: true });
  });

  it('a wrong tag is graded wrong and the flash names the START answer', () => {
    const { rig, ids } = setup();
    const personId = ids[1] as number;
    const right = answer(personId, 'victim', true);
    const wrong = right === 'minor' ? 'delayed' : 'minor';
    rig.sys.request({ kind: 'tag', personId, tag: wrong });
    rig.run(0.5);
    const ev = rig.of('command:triage') as { correct: boolean }[];
    expect(ev[0]?.correct).toBe(false);
    const word = { minor: 'GREEN', delayed: 'YELLOW', immediate: 'RED', expectant: 'BLACK' }[right];
    expect(rig.flashes().some((t) => t.includes(`START says ${word}`))).toBe(true);
  });

  it('moving away interrupts the assessment', () => {
    const { rig } = setup();
    rig.sys.request({ kind: 'assess' });
    rig.run(2);
    expect(rig.sys.triage()).not.toBeNull();
    rig.ctx.x += 3;
    rig.run(0.5);
    expect(rig.sys.triage()).toBeNull();
    expect(rig.flashes().some((t) => /interrupted/i.test(t))).toBe(true);
  });

  it('needs a victim in reach and a player on foot', () => {
    const { rig } = setup();
    rig.ctx.x -= 20;
    rig.sys.request({ kind: 'assess' });
    rig.run(0.5);
    expect(rig.sys.triage()).toBeNull();
    expect(rig.flashes().some((t) => /within reach/i.test(t))).toBe(true);
    rig.ctx.x += 20;
    rig.ctx.onFoot = false;
    rig.sys.request({ kind: 'assess' });
    rig.run(0.5);
    expect(rig.sys.triage()).toBeNull();
  });

  it('tagging every victim sets the triaged flag', () => {
    const { rig, ids } = setup();
    for (const id of ids) rig.sys.request({ kind: 'tag', personId: id, tag: 'minor' });
    rig.run(1);
    expect(rig.flagRequests()).toContain('triaged');
    const counts = rig.sys.board().counts;
    expect(counts.minor).toBe(ids.length);
    expect(counts.untagged).toBe(0);
  });
});

describe('EMS triage and transport', () => {
  it('EMS tags the untagged victims at aiAssessS per unit, with START tags when the error rate is zero', () => {
    const rig = new Rig({ config: cfgWith({ triage: { aiErrorRate: 0 } }) });
    rig.openCall();
    const ids = rig.victims();
    rig.addUnit('MEDIC-1');
    rig.fakes.onScene.set('ems', ['MEDIC-1']);
    rig.run(1);
    rig.run(COMMAND_CONFIG.triage.aiAssessS);
    expect(rig.of('command:triage')).toHaveLength(1);
    rig.run(COMMAND_CONFIG.triage.aiAssessS * ids.length);
    const ev = rig.of('command:triage') as { by: string; correct: boolean; personId: number }[];
    expect(ev).toHaveLength(ids.length);
    expect(ev.every((e) => e.by === 'ems' && e.correct)).toBe(true);
    expect(rig.flagRequests()).toContain('triaged');
    expect(rig.sys.board().counts.untagged).toBe(0);
  });

  it('two units triage twice as fast; an error rate of 1 gives wrong tags', () => {
    const wrong = new Rig({ config: cfgWith({ triage: { aiErrorRate: 1 } }) });
    wrong.openCall();
    wrong.victims();
    wrong.addUnit('MEDIC-1');
    wrong.addUnit('MEDIC-2');
    wrong.fakes.onScene.set('ems', ['MEDIC-1', 'MEDIC-2']);
    wrong.run(1);
    wrong.run(COMMAND_CONFIG.triage.aiAssessS + 0.5);
    const ev = wrong.of('command:triage') as { correct: boolean }[];
    expect(ev).toHaveLength(2);
    expect(ev.every((e) => !e.correct)).toBe(true);
  });

  it('transports in tag order, immediate first, one red per ambulance, and sets transportedRed', () => {
    const rig = new Rig({ config: cfgWith({ triage: { aiErrorRate: 0 } }) });
    rig.openCall();
    const ids = rig.victims(['victim', 'victim', 'unconscious', 'walkingWounded']);
    const tags = new Map<number, string>();
    ids.forEach((id, i) => {
      const role = ['victim', 'victim', 'unconscious', 'walkingWounded'][i] as string;
      tags.set(id, answer(id, role, role !== 'walkingWounded'));
    });
    // The player tags everything straight away (correctly), so the order is decided by transportOrder alone.
    rig.run(1);
    for (const id of ids) rig.sys.request({ kind: 'tag', personId: id, tag: tags.get(id) as 'minor' });
    rig.run(0.5);
    rig.addUnit('MEDIC-1');
    rig.addUnit('MEDIC-2');
    rig.addUnit('MEDIC-3');
    rig.fakes.onScene.set('ems', ['MEDIC-1', 'MEDIC-2', 'MEDIC-3']);
    rig.run(COMMAND_CONFIG.transport.loadS + 1);
    expect(rig.fakes.transported.length).toBeGreaterThan(0);
    const rank = { immediate: 0, delayed: 1, minor: 2, expectant: 3 } as Record<string, number>;
    const firsts = rig.fakes.transported.map((t) => rank[tags.get(t.personId) as string] as number);
    expect([...firsts].sort((a, b) => a - b)).toEqual(firsts);
    const reds = ids.filter((id) => tags.get(id) === 'immediate');
    expect(reds.length).toBeGreaterThan(0);
    {
      expect(rig.fakes.transported.slice(0, reds.length).map((t) => t.personId).sort()).toEqual(reds.slice().sort());
      // one red patient per unit
      expect(new Set(rig.fakes.transported.map((t) => t.callsign)).size).toBe(rig.fakes.transported.length);
    }
    rig.run(1);
    const rows = rig.sys.board().victims;
    expect(rows.filter((r) => r.transported).length).toBe(rig.fakes.transported.length + rig.fakes.removed.filter((a) => a < 50).length);
    expect(rig.flagRequests()).toContain('transportedRed');
  });

  it('a unit loads several delayed and minor patients, removing the extra actors itself', () => {
    const rig = new Rig();
    rig.openCall();
    const roles = ['walkingWounded', 'walkingWounded', 'walkingWounded'];
    const ids = rig.victims(roles);
    rig.run(1);
    for (const id of ids) rig.sys.request({ kind: 'tag', personId: id, tag: 'minor' });
    rig.run(0.5);
    rig.addUnit('MEDIC-1');
    rig.fakes.onScene.set('ems', ['MEDIC-1']);
    rig.run(COMMAND_CONFIG.transport.loadS + 1);
    expect(rig.fakes.transported).toEqual([{ callsign: 'MEDIC-1', personId: ids[0] }]);
    expect(rig.fakes.removed.sort()).toEqual([2, 3]);
    expect(rig.sys.board().victims.every((v) => v.transported)).toBe(true);
    expect(rig.radios().some((t) => /transporting 3 green patients/.test(t))).toBe(true);
  });

  it('never transports expectant, trapped or contaminated patients, and drops a failed transport', () => {
    const rig = new Rig({ flags: ['mci', 'trapped'] });
    rig.openCall();
    const ids = rig.victims(['victim', 'deceased']);
    rig.run(1);
    rig.sys.request({ kind: 'tag', personId: ids[1] as number, tag: 'expectant' });
    rig.addUnit('MEDIC-1');
    rig.fakes.onScene.set('ems', ['MEDIC-1']);
    rig.fakes.transportOk = false;
    rig.sys.request({ kind: 'tag', personId: ids[0] as number, tag: 'immediate' });
    rig.run(COMMAND_CONFIG.transport.loadS * 2 + 2);
    expect(rig.fakes.transported).toEqual([]);
    expect(rig.sys.board().victims.some((v) => v.transported)).toBe(false);
  });
});

describe('fire', () => {
  it('extricates trapped victims one per extricateS per unit and radios it', () => {
    const rig = new Rig({ flags: ['mci', 'trapped'], config: cfgWith({ fire: { extricateS: 30 } }) });
    rig.openCall('buildingCollapse');
    const roles = Array.from({ length: 12 }, () => 'victim');
    rig.victims(roles);
    rig.run(1);
    const trapped0 = rig.sys.board().victims.filter((v) => v.trapped).length;
    expect(trapped0).toBeGreaterThan(2);
    rig.addUnit('ENGINE-1');
    rig.fakes.onScene.set('fire', ['ENGINE-1']);
    rig.run(31);
    expect(rig.sys.board().victims.filter((v) => v.trapped).length).toBe(trapped0 - 1);
    expect(rig.radios().some((t) => t === 'ENGINE-1, one patient extricated.')).toBe(true);
    rig.addUnit('ENGINE-2');
    rig.fakes.onScene.set('fire', ['ENGINE-1', 'ENGINE-2']);
    rig.run(31);
    expect(rig.sys.board().victims.filter((v) => v.trapped).length).toBe(trapped0 - 3);
  });

  it('trapped victims are not triaged by EMS until freed', () => {
    const rig = new Rig({ flags: ['mci', 'trapped'], config: cfgWith({ fire: { extricateS: 30 }, triage: { aiAssessS: 5 } }) });
    rig.openCall('buildingCollapse');
    rig.victims(Array.from({ length: 6 }, () => 'victim'));
    rig.run(1);
    const trapped = rig.sys.board().victims.filter((v) => v.trapped).length;
    expect(trapped).toBeGreaterThan(0);
    rig.addUnit('MEDIC-1');
    rig.fakes.onScene.set('ems', ['MEDIC-1']);
    rig.run(60);
    const rows = rig.sys.board().victims;
    expect(rows.filter((r) => r.trapped).every((r) => r.tag === null)).toBe(true);
    expect(rows.filter((r) => !r.trapped).every((r) => r.tag !== null)).toBe(true);
    rig.addUnit('ENGINE-1');
    rig.fakes.onScene.set('fire', ['ENGINE-1']);
    rig.run(30 * trapped + 60);
    expect(rig.sys.board().victims.every((r) => !r.trapped)).toBe(true);
  });

  it('decontaminates hazmat victims before EMS can touch them', () => {
    const rig = new Rig({ flags: ['mci', 'hazmat', 'decon'], config: cfgWith({ fire: { deconS: 20 }, triage: { aiAssessS: 5 } }) });
    rig.openCall('hazmatRelease');
    rig.victims(['victim', 'victim']);
    rig.run(1);
    expect(rig.sys.board().victims.every((v) => v.contaminated)).toBe(true);
    rig.addUnit('MEDIC-1');
    rig.fakes.onScene.set('ems', ['MEDIC-1']);
    rig.run(30);
    expect(rig.of('command:triage')).toHaveLength(0);
    rig.addUnit('ENGINE-1');
    rig.fakes.onScene.set('fire', ['ENGINE-1']);
    rig.run(45);
    expect(rig.sys.board().victims.every((v) => !v.contaminated)).toBe(true);
    expect(rig.radios().some((t) => /decontaminated/.test(t))).toBe(true);
    rig.run(20);
    expect(rig.of('command:triage').length).toBeGreaterThan(0);
  });
});

describe('traffic control points', () => {
  it('opens automatically for roadway scenes: blockades, staffed posts and the trafficControl flag', () => {
    const rig = new Rig();
    rig.openCall();
    rig.victims();
    rig.run(1);
    const blockades = rig.sys.blockades();
    expect(blockades.length).toBeGreaterThan(0);
    expect(blockades.length).toBeLessThanOrEqual(COMMAND_CONFIG.tcp.max);
    expect(blockades.every((b) => b.radius === COMMAND_CONFIG.tcp.blockadeRadiusM)).toBe(true);
    expect(rig.fakes.posts.filter((p) => p.spec.kind === 'tcp')).toHaveLength(blockades.length);
    expect(rig.fakes.posts[0]?.spec.id).toBe('tcp1');
    expect(rig.flagRequests()).toContain('trafficControl');
    expect(rig.sys.board().tcps).toEqual({ staffed: blockades.length, total: blockades.length });
  });

  it('is not automatic for a collapse, but can be requested and released', () => {
    const rig = new Rig({ flags: ['mci', 'trapped'] });
    rig.openCall('buildingCollapse');
    rig.run(1);
    expect(rig.sys.blockades()).toEqual([]);
    const rev = rig.sys.blockadesRevision;
    rig.sys.request({ kind: 'tcp', on: true });
    rig.run(0.5);
    expect(rig.sys.blockades().length).toBeGreaterThan(0);
    expect(rig.sys.blockadesRevision).toBeGreaterThan(rev);
    rig.sys.request({ kind: 'tcp', on: false });
    rig.run(0.5);
    expect(rig.sys.blockades()).toEqual([]);
    expect(rig.fakes.cleared).toContain('tcp');
    expect(rig.fakes.posts).toEqual([]);
  });

  it('flashes unstaffed posts and retries; the flag waits for two staffed posts', () => {
    const rig = new Rig();
    rig.fakes.capacity = 0;
    rig.openCall();
    rig.run(1);
    expect(rig.flashes().some((t) => /unstaffed/.test(t))).toBe(true);
    expect(rig.flagRequests()).not.toContain('trafficControl');
    rig.fakes.capacity = 99;
    rig.run(12);
    expect(rig.fakes.posts.length).toBeGreaterThan(0);
    expect(rig.flagRequests()).toContain('trafficControl');
  });

  it('the flag is also earned by standing at a control point', () => {
    const rig = new Rig();
    rig.fakes.capacity = 0;
    rig.openCall();
    rig.run(1);
    const p = rig.sys.blockades()[0];
    expect(p).toBeDefined();
    rig.ctx.x = p?.x ?? 0;
    rig.ctx.z = p?.z ?? 0;
    rig.run(1);
    expect(rig.flagRequests()).toContain('trafficControl');
  });
});

describe('evacuation', () => {
  it('moves bystanders away and completes after buildings x buildingS, faster with staffed posts', () => {
    const rig = new Rig({ flags: ['mci', 'hazmat'], config: cfgWith({ evac: { buildingS: 10 } }) });
    rig.fakes.buildings = 4;
    rig.openCall('hazmatRelease');
    rig.victims();
    rig.run(1);
    rig.sys.request({ kind: 'evacuate' });
    rig.run(0.5);
    const board = rig.sys.board();
    expect(board.evac?.radiusM).toBe(COMMAND_CONFIG.evac.radiusM.hazmat);
    expect(rig.sys.zones()).toHaveLength(1);
    expect(rig.sys.zones()[0]?.points.length).toBe(COMMAND_CONFIG.evac.segments * 2);
    expect(rig.fakes.posts.filter((p) => p.spec.kind === 'evac')).toHaveLength(2);
    expect(rig.fakes.forced.some((f) => f.id === 50 && f.state === 'leave')).toBe(true);
    // 2 evac officers + 1 = 3 building-seconds per second: 40 building-seconds -> ~14 s
    rig.run(5);
    const mid = rig.sys.board().evac?.progress ?? 0;
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(1);
    expect(rig.flagRequests()).not.toContain('evacuated');
    rig.run(15);
    expect(rig.sys.board().evac?.progress).toBe(1);
    expect(rig.flagRequests()).toContain('evacuated');
    expect(rig.flashes().filter((t) => /Evacuation complete/.test(t))).toHaveLength(1);
  });

  it('fire units speed it up and the radius depends on the scene', () => {
    const slow = new Rig({ flags: ['mci', 'roadway'], config: cfgWith({ evac: { buildingS: 10 } }) });
    slow.fakes.capacity = 0;
    slow.openCall();
    slow.run(1);
    slow.sys.request({ kind: 'evacuate' });
    slow.run(10);
    const fast = new Rig({ flags: ['mci', 'roadway'], config: cfgWith({ evac: { buildingS: 10 } }) });
    fast.fakes.capacity = 0;
    fast.openCall();
    fast.fakes.onScene.set('fire', ['ENGINE-1']);
    fast.run(1);
    fast.sys.request({ kind: 'evacuate' });
    fast.run(10);
    expect(slow.sys.board().evac?.radiusM).toBe(COMMAND_CONFIG.evac.radiusM.default);
    expect(fast.sys.board().evac?.progress ?? 0).toBeGreaterThan(slow.sys.board().evac?.progress ?? 1);
  });

  it('an empty zone is evacuated at once', () => {
    const rig = new Rig({ flags: ['mci'] });
    rig.fakes.buildings = 0;
    rig.openCall();
    rig.run(1);
    rig.sys.request({ kind: 'evacuate' });
    rig.run(1);
    expect(rig.flagRequests()).toContain('evacuated');
  });
});

describe('barricade containment', () => {
  function barricade(extra: { capacity?: number } = {}) {
    const rig = new Rig({ family: 'barricade', flags: [] });
    rig.fakes.buildingId = 7;
    rig.fakes.building = { minX: rig.incident.x - 10, minZ: rig.incident.z - 8, maxX: rig.incident.x + 10, maxZ: rig.incident.z + 8, door: DOOR };
    rig.fakes.capacity = extra.capacity ?? 99;
    rig.openCall('barricadedSubject');
    rig.fakes.participants.push({ role: 'subject', personId: 300, actorId: 60, injured: false, deceased: false });
    rig.fakes.actors.set(60, { ...rig.fakes.actors.get(1), id: 60, personId: 300, role: 'subject', x: rig.incident.x, z: rig.incident.z } as never);
    return rig;
  }

  it('contains automatically when the post opens: inner posts, outer perimeter, flags', () => {
    const rig = barricade();
    rig.run(1);
    expect(rig.sys.post()?.level).toBe('major');
    const inner = rig.fakes.posts.filter((p) => p.spec.kind === 'inner');
    expect(inner).toHaveLength(4);
    expect(rig.fakes.posts.filter((p) => p.spec.kind === 'tcp').length).toBeGreaterThan(0);
    expect(rig.flagRequests()).toEqual(expect.arrayContaining(['commandPost', 'contained', 'perimeter']));
    expect(rig.sys.board().inner).toEqual({ staffed: 4, total: 4 });
    // the inner posts surround the building
    expect(inner.some((p) => p.spec.x < rig.incident.x - 10)).toBe(true);
    expect(inner.some((p) => p.spec.x > rig.incident.x + 10)).toBe(true);
  });

  it('with too few officers it is not contained until two posts are staffed', () => {
    const rig = barricade({ capacity: 1 });
    rig.run(1);
    expect(rig.flagRequests()).not.toContain('contained');
    rig.fakes.capacity = 99;
    rig.run(12);
    expect(rig.flagRequests()).toContain('contained');
  });

  it('the evacuation radius of a barricade is the barricade radius', () => {
    const rig = barricade();
    rig.run(1);
    rig.sys.request({ kind: 'evacuate' });
    rig.run(0.5);
    expect(rig.sys.board().evac?.radiusM).toBe(COMMAND_CONFIG.evac.radiusM.barricade);
  });
});

describe('negotiation', () => {
  function barricade() {
    const rig = new Rig({ family: 'barricade', flags: [], config: cfgWith({ negotiation: { noiseSd: 0 } }) });
    rig.fakes.buildingId = 7;
    rig.fakes.building = { minX: rig.incident.x - 10, minZ: rig.incident.z - 8, maxX: rig.incident.x + 10, maxZ: rig.incident.z + 8, door: DOOR };
    rig.openCall('barricadedSubject');
    rig.fakes.participants.push({ role: 'subject', personId: 300, actorId: 60, injured: false, deceased: false });
    const a = rig.fakes.actors;
    a.set(60, { id: 60, personId: 300, role: 'subject', callId: 1, state: ACTOR_STATE.idle, x: DOOR.x - 20, z: DOOR.z, yaw: 0, stress: 0, cuffed: false, following: false, hidden: false, armed: true, weaponDrawn: false, vehicleId: -1, seat: -1, profile: 'barricaded', body: 0, building: 7 });
    rig.run(1);
    return rig;
  }

  const script = ['minimal', 'openQuestion', 'label', 'paraphrase', 'label', 'iMessage', 'paraphrase', 'offer', 'offer', 'plan', 'plan', 'plan', 'plan', 'plan', 'plan'];

  it('needs the post and an open line; only barricades can be negotiated', () => {
    const rig = barricade();
    rig.sys.request({ kind: 'negotiate', optionId: 'minimal', tone: 'polite' });
    rig.run(0.2);
    expect(rig.flashes().some((t) => /Open the negotiation line/.test(t))).toBe(true);
    expect(rig.sys.negotiationView()).toBeNull();
    const other = new Rig({ family: 'massCasualty' });
    other.openCall();
    other.run(1);
    other.sys.request({ kind: 'negotiationOpen' });
    other.run(0.2);
    expect(other.sys.negotiationView()).toBeNull();
    expect(other.flashes().some((t) => /no barricaded subject/i.test(t))).toBe(true);
  });

  it('builds the dialogue view from the state, only on revision change', () => {
    const rig = barricade();
    rig.sys.request({ kind: 'negotiationOpen' });
    rig.run(0.2);
    const view = rig.sys.negotiationView();
    expect(view).not.toBeNull();
    expect(view?.contactId).toBe(300);
    expect(view?.title).toBe('Negotiation');
    expect(view?.topics.map((t) => t.id)).toEqual(['listen', 'problem', 'pressure']);
    expect(rig.sys.negotiationView()).toBe(view);
    rig.sys.request({ kind: 'negotiate', optionId: 'minimal', tone: 'polite' });
    rig.run(0.2);
    const next = rig.sys.negotiationView();
    expect(next).not.toBe(view);
    expect(next?.transcript.map((l) => l.speaker)).toEqual(['system', 'officer', 'subject']);
    expect(next?.facts.some((f) => /^Trust/.test(f.text))).toBe(true);
    expect(rig.sys.negotiationTrust(rig.callId)).toBeGreaterThan(0.15);
    expect(rig.sys.negotiationTrust(rig.callId + 1)).toBe(0);
    const events = rig.of('command:negotiation') as { outcome: string }[];
    expect(events.length).toBe(2);
    rig.sys.request({ kind: 'negotiationClose' });
    rig.run(0.2);
    expect(rig.sys.negotiationView()).toBeNull();
  });

  it('a patient run reaches a surrender: the subject walks to the door and raises their hands', () => {
    const rig = barricade();
    rig.sys.request({ kind: 'negotiationOpen' });
    rig.run(0.2);
    rig.fakes.onScene.set('negotiator', ['NEG-1']);
    for (const id of script) {
      if (rig.sys.board().negotiation?.outcome !== 'ongoing') break;
      rig.sys.request({ kind: 'negotiate', optionId: id, tone: 'polite' });
      rig.run(0.3);
    }
    expect(rig.sys.board().negotiation?.outcome).toBe('surrender');
    expect(rig.flagRequests()).toContain('negotiated');
    expect(rig.fakes.walks).toEqual([{ id: 60, x: DOOR.x, z: DOOR.z }]);
    expect(rig.fakes.forced.some((f) => f.state === 'handsUp')).toBe(false);
    // the subject arrives
    const subject = rig.fakes.actors.get(60);
    if (subject) subject.x = DOOR.x - 1;
    rig.run(1);
    expect(rig.fakes.forced).toContainEqual({ id: 60, state: 'handsUp' });
    expect(rig.sys.negotiationView()?.topics.every((t) => t.options.every((o) => !o.enabled))).toBe(true);
    // finished: more turns change nothing
    const trust = rig.sys.negotiationTrust(rig.callId);
    rig.sys.request({ kind: 'negotiate', optionId: 'threat', tone: 'polite' });
    rig.run(0.3);
    expect(rig.sys.negotiationTrust(rig.callId)).toBe(trust);
  });

  it('pressure drives it to a breakdown, which stacks the SWAT team when it is on scene', () => {
    const rig = barricade();
    rig.fakes.onScene.set('swat', ['TAC-1']);
    rig.sys.request({ kind: 'negotiationOpen' });
    rig.run(0.2);
    for (let i = 0; i < 6 && rig.sys.board().negotiation?.outcome === 'ongoing'; i++) {
      rig.sys.request({ kind: 'negotiate', optionId: 'threat', tone: 'neutral' });
      rig.run(0.3);
    }
    expect(rig.sys.board().negotiation?.outcome).toBe('breakdown');
    expect(rig.fakes.swatLog).toEqual([{ callId: rig.callId, command: 'stack' }]);
    expect(rig.radios().some((t) => /negotiations have broken down/.test(t))).toBe(true);
  });

  it('a breakdown without SWAT on scene flashes a reminder', () => {
    const rig = barricade();
    rig.sys.request({ kind: 'negotiationOpen' });
    rig.run(0.2);
    for (let i = 0; i < 6 && rig.sys.board().negotiation?.outcome === 'ongoing'; i++) {
      rig.sys.request({ kind: 'negotiate', optionId: 'threat', tone: 'neutral' });
      rig.run(0.3);
    }
    expect(rig.fakes.swatLog).toEqual([]);
    expect(rig.flashes().some((t) => /Request SWAT/.test(t))).toBe(true);
  });

  it('the subject temperament shifts the outcome', () => {
    const calm = barricade();
    const wild = barricade();
    wild.fakes.temperament = 'volatile';
    wild.fakes.bac = 0.2;
    for (const rig of [calm, wild]) {
      rig.sys.request({ kind: 'negotiationOpen' });
      rig.run(0.2);
      for (let i = 0; i < 4; i++) {
        rig.sys.request({ kind: 'negotiate', optionId: 'minimal', tone: 'polite' });
        rig.run(0.3);
      }
    }
    expect(wild.sys.board().negotiation?.agitation ?? 0).toBeGreaterThan(calm.sys.board().negotiation?.agitation ?? 1);
  });
});

describe('SWAT forwarding', () => {
  it('forwards commands and plans to the backup module and flashes the reply', () => {
    const rig = new Rig({ family: 'barricade', flags: [] });
    rig.openCall('barricadedSubject');
    rig.run(1);
    rig.sys.request({ kind: 'swat', command: 'stack', plan: { entry: 'rear' } });
    rig.run(0.2);
    expect(rig.fakes.swatLog).toEqual([{ callId: rig.callId, command: 'stack' }]);
    expect(rig.flashes()).toContain('SWAT: stack');
    expect(rig.sys.board().swat).toBeNull();
    rig.fakes.swatPhase = 'stacked';
    rig.run(0.5);
    expect(rig.sys.board().swat).toBe('stacked');
  });

  it('sets swatResolved when the subject is in custody after SWAT arrived', () => {
    const rig = new Rig({ family: 'barricade', flags: [] });
    rig.openCall('barricadedSubject');
    rig.run(1);
    rig.fakes.flags.add('custody:subject');
    rig.run(0.5);
    expect(rig.flagRequests()).not.toContain('swatResolved');
    rig.fakes.swatPhase = 'clearing';
    rig.run(0.5);
    expect(rig.flagRequests()).toContain('swatResolved');
  });
});

describe('resource needs', () => {
  it('requests the computed counts through the resources port', () => {
    const rig = new Rig({ config: cfgWith({ triage: { aiErrorRate: 0 } }) });
    rig.openCall();
    const ids = rig.victims(['victim', 'victim', 'victim', 'victim']);
    rig.run(1);
    // two red, one yellow, one untagged (counts as delayed): ceil(2 + 1 * 0.5) = 3 EMS
    rig.sys.request({ kind: 'tag', personId: ids[0] as number, tag: 'immediate' });
    rig.sys.request({ kind: 'tag', personId: ids[1] as number, tag: 'immediate' });
    rig.sys.request({ kind: 'tag', personId: ids[2] as number, tag: 'delayed' });
    rig.run(0.5);
    expect(rig.sys.board().needs).toEqual({ ems: 3, fire: 0, supervisor: 1 });
    rig.sys.request({ kind: 'requestNeeds' });
    rig.run(0.2);
    expect(rig.fakes.requested.filter((r) => r.typeId === 'ems')).toHaveLength(3);
    expect(rig.fakes.requested.filter((r) => r.typeId === 'supervisor')).toHaveLength(1);
    expect(rig.fakes.requested.filter((r) => r.typeId === 'fire')).toHaveLength(0);
    expect(rig.fakes.requested.every((r) => r.callId === rig.callId && r.via === 'mdt')).toBe(true);
  });

  it('subtracts units already on scene and says when nothing is needed', () => {
    const rig = new Rig();
    rig.openCall();
    rig.victims(['victim', 'victim']);
    rig.fakes.onScene.set('ems', ['MEDIC-1', 'MEDIC-2', 'MEDIC-3']);
    rig.fakes.supervisor = 'SGT-1';
    rig.run(1);
    rig.sys.request({ kind: 'requestNeeds' });
    rig.run(0.2);
    expect(rig.fakes.requested).toEqual([]);
    expect(rig.flashes().some((t) => /No additional resources/.test(t))).toBe(true);
  });

  it('hazmat calls ask for a fire unit', () => {
    const rig = new Rig({ flags: ['mci', 'hazmat'] });
    rig.openCall('hazmatRelease');
    rig.run(1);
    rig.sys.request({ kind: 'requestNeeds' });
    rig.run(0.2);
    expect(rig.fakes.requested.filter((r) => r.typeId === 'fire')).toHaveLength(1);
  });
});

describe('board and HUD', () => {
  it('summarizes tags, units and the HUD line, rebuilt only on revision change', () => {
    const rig = new Rig({ config: cfgWith({ triage: { aiErrorRate: 0 } }) });
    rig.openCall();
    const ids = rig.victims();
    rig.addUnit('MEDIC-1', 'enRoute');
    rig.run(1);
    const board = rig.sys.board();
    expect(rig.sys.board()).toBe(board);
    expect(board.post?.level).toBe('disaster');
    expect(board.victims).toHaveLength(ids.length);
    expect(board.counts.untagged).toBe(ids.length);
    expect(board.units.map((u) => u.callsign)).toEqual(expect.arrayContaining(['1-A-12', 'MEDIC-1']));
    expect(rig.sys.hud()).toBe(`ICS · DISASTER · RED 0 YEL 0 GRN 0 BLK 0 · EMS 1 en route`);
    rig.sys.request({ kind: 'tag', personId: ids[0] as number, tag: 'immediate' });
    rig.sys.request({ kind: 'tag', personId: ids[1] as number, tag: 'delayed' });
    rig.sys.request({ kind: 'tag', personId: ids[2] as number, tag: 'minor' });
    rig.sys.request({ kind: 'tag', personId: ids[5] as number, tag: 'expectant' });
    rig.run(0.5);
    expect(rig.sys.board()).not.toBe(board);
    expect(rig.sys.hud()).toBe('ICS · DISASTER · RED 1 YEL 1 GRN 1 BLK 1 · EMS 1 en route');
    rig.sys.request({ kind: 'evacuate' });
    rig.run(0.5);
    expect(rig.sys.hud()).toMatch(/EVAC \d+%$/);
  });

  it('victims are named Patient n and never labelled by role', () => {
    const rig = new Rig();
    rig.openCall();
    rig.victims();
    rig.run(1);
    expect(rig.sys.board().victims.map((v) => v.label)).toEqual(['Patient 1', 'Patient 2', 'Patient 3', 'Patient 4', 'Patient 5', 'Patient 6']);
  });
});

describe('save and determinism', () => {
  function scenario(): Rig {
    const rig = new Rig();
    rig.openCall();
    rig.victims(['victim', 'victim', 'victim', 'unconscious', 'walkingWounded', 'deceased']);
    rig.addUnit('MEDIC-1');
    rig.fakes.onScene.set('ems', ['MEDIC-1']);
    rig.run(1);
    rig.sys.request({ kind: 'evacuate' });
    rig.sys.request({ kind: 'assess' });
    rig.run(25);
    return rig;
  }

  it('is deterministic for a seed', () => {
    const a = scenario();
    const b = scenario();
    a.run(60);
    b.run(60);
    expect(JSON.stringify(a.sys.serialize())).toBe(JSON.stringify(b.sys.serialize()));
    expect(a.events.map((e) => JSON.stringify(e))).toEqual(b.events.map((e) => JSON.stringify(e)));
  });

  it('round-trips through serialize and restore, and the save validates and survives JSON', () => {
    const rig = scenario();
    rig.sys.request({ kind: 'tcp', on: false });
    const saved = rig.sys.serialize();
    expect(isCommandSave(saved)).toBe(true);
    expect(saved.post?.callId).toBe(rig.callId);
    expect(saved.victims).toHaveLength(6);
    expect(saved.requests).toEqual([{ kind: 'tcp', on: false }]);
    const json = JSON.parse(JSON.stringify(saved)) as CommandSave;
    expect(isCommandSave(json)).toBe(true);

    const fresh = new Rig();
    fresh.openCall();
    fresh.fakes.participants = rig.fakes.participants;
    fresh.sys.restore(json);
    expect(JSON.stringify(fresh.sys.serialize())).toBe(JSON.stringify(saved));
    expect(fresh.events).toEqual([]);
    expect(fresh.sys.post()).toEqual(rig.sys.post());
    expect(fresh.sys.board().counts).toEqual(rig.sys.board().counts);
    expect(fresh.sys.zones()).toHaveLength(rig.sys.zones().length);
    expect(fresh.sys.blockades()).toEqual(rig.sys.blockades());
    expect(fresh.sys.hud()).toBe(rig.sys.hud());
  });

  it('vitals come back from the seed: an assessed patient shows the same vitals after a restore', () => {
    const rig = new Rig();
    rig.openCall();
    rig.victims();
    rig.run(1);
    rig.sys.request({ kind: 'assess' });
    rig.run(7);
    const before = rig.sys.triage();
    expect(before?.vitals).not.toBeNull();
    const fresh = new Rig();
    fresh.sys.restore(rig.sys.serialize());
    const after = fresh.sys.triage();
    expect(after?.vitals).toEqual(before?.vitals);
    expect(after?.personId).toBe(before?.personId);
  });

  it('a restored system continues the negotiation and the evacuation', () => {
    const rig = new Rig({ family: 'barricade', flags: [] });
    rig.fakes.buildingId = 7;
    rig.fakes.building = { minX: rig.incident.x - 10, minZ: rig.incident.z - 8, maxX: rig.incident.x + 10, maxZ: rig.incident.z + 8, door: DOOR };
    rig.openCall('barricadedSubject');
    rig.fakes.participants.push({ role: 'subject', personId: 300, actorId: 60, injured: false, deceased: false });
    rig.run(1);
    rig.sys.request({ kind: 'negotiationOpen' });
    rig.sys.request({ kind: 'negotiate', optionId: 'minimal', tone: 'polite' });
    rig.sys.request({ kind: 'evacuate' });
    rig.run(3);
    const saved = JSON.parse(JSON.stringify(rig.sys.serialize())) as CommandSave;
    const fresh = new Rig({ family: 'barricade', flags: [] });
    fresh.fakes.buildingId = 7;
    fresh.fakes.building = rig.fakes.building;
    fresh.openCall('barricadedSubject');
    fresh.fakes.participants = rig.fakes.participants;
    fresh.sys.restore(saved);
    expect(fresh.sys.negotiationView()?.transcript.length).toBe(rig.sys.negotiationView()?.transcript.length);
    expect(fresh.sys.negotiationTrust(rig.callId)).toBe(rig.sys.negotiationTrust(rig.callId));
    expect(fresh.sys.board().evac?.radiusM).toBe(rig.sys.board().evac?.radiusM);
    // the same next draw and the same next turn
    for (const r of [rig, fresh]) {
      r.sys.request({ kind: 'negotiate', optionId: 'label', tone: 'polite' });
      r.sys.step(1 / 60, at(r.sim), r.ctx);
    }
    expect(JSON.stringify(fresh.sys.serialize().negotiation)).toBe(JSON.stringify(rig.sys.serialize().negotiation));
    expect(fresh.sys.serialize().rng).toEqual(rig.sys.serialize().rng);
  });

  it('isCommandSave rejects malformed saves', () => {
    const good = scenario().sys.serialize();
    expect(isCommandSave(good)).toBe(true);
    expect(isCommandSave(null)).toBe(false);
    expect(isCommandSave({ ...good, version: 2 })).toBe(false);
    expect(isCommandSave({ ...good, requests: [{ kind: 'nope' }] })).toBe(false);
    expect(isCommandSave({ ...good, tcp: { on: true, points: [[1, 2]] } })).toBe(false);
    expect(isCommandSave({ ...good, victims: [{ personId: 1 }] })).toBe(false);
    expect(isCommandSave({ ...good, rng: { seed: 1, s: [1, 2, 3] } })).toBe(false);
  });
});

describe('performance', () => {
  it('a step with 15 victims averages at most 0.02 ms', () => {
    const rig = new Rig();
    rig.openCall();
    rig.victims(Array.from({ length: 15 }, (_, i) => (i % 3 === 0 ? 'victim' : i % 3 === 1 ? 'walkingWounded' : 'unconscious')));
    rig.addUnit('MEDIC-1');
    rig.addUnit('MEDIC-2');
    rig.fakes.onScene.set('ems', ['MEDIC-1', 'MEDIC-2']);
    rig.fakes.onScene.set('fire', ['ENGINE-1']);
    rig.run(2);
    rig.sys.request({ kind: 'evacuate' });
    rig.run(1);
    const N = 6000;
    const start = performance.now();
    for (let i = 0; i < N; i++) {
      rig.sim += 1 / 60;
      rig.sys.step(1 / 60, at(rig.sim), rig.ctx);
    }
    const perStep = (performance.now() - start) / N;
    expect(perStep).toBeLessThan(0.02);
  });
});
