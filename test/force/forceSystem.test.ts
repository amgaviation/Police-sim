import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import { isPregnant } from '../../src/force/models';
import { FORCE_CONFIG } from '../../src/force/data';
import { ACTOR_STATE } from '../../src/npc/types';
import { DT, OFFICER, Rig, makeActor, scriptedRng } from './helpers';

/** Scripted draws: z ~ 0.14 sigma, no clothing failure, neuromuscular incapacitation succeeds, then the injury draw. */
const TASER_NMI = [0.99, 0, 0.5, 0.5, 0.1, 0.5];
/** gauss(2) near zero, probes hit but the nmi roll fails (0.95 >= 0.85), then injury and pain-comply draws. */
const TASER_PAIN = [0.99, 0, 0.5, 0.5, 0.95, 0.5, 0.1];

describe('tool cycling', () => {
  it('walks the full order and maps the scene weapon', () => {
    const rig = new Rig();
    rig.k9 = true;
    const seen: string[] = [];
    for (let i = 0; i < 9; i++) {
      rig.sys.request({ kind: 'cycleTool' });
      rig.run(1);
      seen.push(rig.sys.tool);
    }
    expect(seen).toEqual(['hands', 'ocSpray', 'baton', 'taser', 'lessLethal', 'firearm', 'k9', 'none', 'hands']);
    expect(rig.weapons).toEqual(['none', 'none', 'none', 'taser', 'taser', 'sidearm', 'none', 'none', 'none']);
    expect(rig.tools).toEqual(seen);
  });

  it('skips tools that are not signed out, empty or without a K9 unit', () => {
    const rig = new Rig();
    rig.held.clear();
    rig.held.add('taser');
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      rig.sys.request({ kind: 'cycleTool' });
      rig.run(1);
      seen.push(rig.sys.tool);
    }
    expect(seen).toEqual(['hands', 'taser', 'none', 'hands', 'taser']);
    expect(rig.weapons).toEqual(['none', 'taser', 'none', 'none', 'taser']);
  });

  it('refuses to draw in a vehicle and holsters when leaving foot', () => {
    const rig = new Rig();
    const inCar = { ...OFFICER, onFoot: false };
    rig.sys.request({ kind: 'cycleTool' });
    rig.run(1, inCar);
    expect(rig.sys.tool).toBe('none');
    expect(rig.flashes.at(-1)).toMatch(/Exit the vehicle/);
    rig.select('baton');
    expect(rig.sys.tool).toBe('baton');
    rig.run(1, inCar);
    expect(rig.sys.tool).toBe('none');
    expect(rig.weapons.at(-1)).toBe('none');
  });

  it('selectTool respects availability and holsters when the armory item is returned', () => {
    const rig = new Rig();
    rig.held.delete('baton');
    rig.select('baton');
    expect(rig.sys.tool).toBe('none');
    expect(rig.flashes.at(-1)).toMatch(/unavailable/);
    rig.select('taser');
    expect(rig.sys.tool).toBe('taser');
    rig.held.delete('taser');
    rig.run(1);
    expect(rig.sys.tool).toBe('none');
    expect(rig.weapons.at(-1)).toBe('none');
    expect(rig.flashes.at(-1)).toMatch(/returned to the armory/);
  });

  it('K9 needs the unit on scene', () => {
    const rig = new Rig();
    rig.select('k9');
    expect(rig.sys.tool).toBe('none');
    rig.k9 = true;
    rig.select('k9');
    expect(rig.sys.tool).toBe('k9');
    rig.k9 = false;
    rig.run(1);
    expect(rig.sys.tool).toBe('none');
  });

  it('updates the HUD object in place and bumps the revision', () => {
    const rig = new Rig();
    const hud = rig.sys.hud;
    const r0 = rig.sys.revision;
    rig.select('taser');
    expect(rig.sys.hud).toBe(hud);
    expect(hud).toMatchObject({ tool: 'taser', label: 'TASER', ammo: '2/2', attached: false, cycle: 0, episode: null });
    expect(rig.sys.revision).toBeGreaterThan(r0);
    const r1 = rig.sys.revision;
    rig.run(10);
    expect(rig.sys.revision).toBe(r1);
  });
});

describe('targeting', () => {
  it('picks the nearest actor in the cone and ignores hidden, dog, other-building and out-of-range actors', () => {
    const rig = new Rig(scriptedRng([0.1, 0.9, 0.5]));
    rig.add(makeActor(1, { x: 0, z: -1.2 }));
    rig.add(makeActor(2, { x: 0.05, z: -0.9 }));
    rig.add(makeActor(3, { x: 0, z: -0.5, hidden: true }));
    rig.add(makeActor(4, { x: 0, z: -0.4, body: 1 }));
    rig.add(makeActor(5, { x: 0, z: -0.3, building: 3 }));
    rig.add(makeActor(6, { x: 1.0, z: 0 }));
    rig.select('hands');
    rig.apply(0, -1);
    expect(rig.applied).toHaveLength(1);
    expect(rig.applied[0]).toMatchObject({ actorId: 2, tool: 'hands', level: 'hardHands', personId: 20, hit: true });
    expect(rig.applied[0]?.distance).toBeCloseTo(Math.hypot(0.05, 0.9));
  });

  it('respects the cone direction and range', () => {
    const rig = new Rig(scriptedRng([0.1, 0.9, 0.5]));
    rig.add(makeActor(1, { x: 1.0, z: 0 }));
    rig.select('hands');
    rig.apply(0, -1);
    expect(rig.applied).toHaveLength(0);
    expect(rig.flashes.at(-1)).toBe('No target in range');
    rig.apply(1, 0);
    expect(rig.applied).toHaveLength(1);
    rig.actors.get(1)!.x = 2.5;
    rig.apply(1, 0);
    expect(rig.applied).toHaveLength(1);
    expect(rig.flashes.at(-1)).toBe('No target in range');
  });

  it('skips targets closer than the tool minimum range', () => {
    const rig = new Rig();
    rig.add(makeActor(1, { x: 0, z: -1 }));
    rig.add(makeActor(2, { x: 0, z: -5 }));
    rig.select('lessLethal');
    rig.apply(0, -1);
    expect(rig.applied[0]?.actorId).toBe(2);
  });

  it('a spent shot without a target uses ammo and emits no applied event', () => {
    const rig = new Rig();
    rig.select('taser');
    rig.apply(0, -1);
    expect(rig.applied).toHaveLength(0);
    expect(rig.flashes.at(-1)).toBe('Missed');
    expect(rig.sys.hud.ammo).toBe('1/2');
    rig.select('firearm');
    rig.apply(0, -1);
    expect(rig.sys.hud.ammo).toBe('14/15');
    rig.select('hands');
    rig.apply(0, -1);
    expect(rig.flashes.at(-1)).toBe('No target in range');
  });

  it('does nothing without a tool or in a vehicle', () => {
    const rig = new Rig();
    rig.add(makeActor(1));
    rig.apply(0, -1);
    expect(rig.applied).toHaveLength(0);
    rig.select('hands');
    rig.apply(0, -1, { ...OFFICER, onFoot: false });
    expect(rig.applied).toHaveLength(0);
  });
});

describe('TASER', () => {
  it('a hit uses a cartridge, attaches probes and cycles', () => {
    const rig = new Rig(scriptedRng(TASER_NMI));
    rig.add(makeActor(1, { x: 0, z: -3 }), 'active');
    rig.select('taser');
    rig.apply(0, -1);
    expect(rig.sys.hud).toMatchObject({ ammo: '1/2', attached: true, cycle: 1 });
    expect(rig.calls).toContain('incapacitate:1:8:taser');
    expect(rig.applied).toHaveLength(1);
    expect(rig.applied[0]).toMatchObject({ tool: 'taser', level: 'taser', hit: true, cycle: 1, resistance: 'active', fatal: false });
    expect(rig.applied[0]?.injury).toBeGreaterThan(0);
    expect(rig.flashes.at(-1)).toBe('TASER: probes hit (2/2), cycle 1');
  });

  it('re-cycling the attached target does not use a cartridge and counts cycles', () => {
    const rig = new Rig(scriptedRng(TASER_NMI));
    rig.add(makeActor(1, { x: 0, z: -3 }), 'active');
    rig.select('taser');
    rig.apply(0, -1);
    rig.apply(0, -1);
    rig.apply(0, -1);
    expect(rig.sys.hud.ammo).toBe('1/2');
    expect(rig.applied.map((e) => e.cycle)).toEqual([1, 2, 3]);
    expect(rig.calls.filter((c) => c.startsWith('taserCycle'))).toEqual(['taserCycle:1:5', 'taserCycle:1:5']);
    expect(rig.flashes.at(-1)).toBe('TASER: cycle 3');
  });

  it('re-cycles from beyond the dart range up to the reattach range, not further', () => {
    const rig = new Rig(scriptedRng(TASER_NMI));
    const a = rig.add(makeActor(1, { x: 0, z: -3 }), 'active');
    rig.select('taser');
    rig.apply(0, -1);
    a.z = -8.2;
    rig.apply(0, -1);
    expect(rig.applied.map((e) => e.cycle)).toEqual([1, 2]);
    expect(rig.sys.hud.ammo).toBe('1/2');
    a.z = -9;
    rig.apply(0, -1);
    expect(rig.applied).toHaveLength(2);
    expect(rig.sys.hud.ammo).toBe('0/2');
  });

  it('probes detach after attachMaxS and a new cartridge restarts the cycle count after 120 s', () => {
    const rig = new Rig(scriptedRng([...TASER_NMI, ...TASER_NMI]));
    rig.add(makeActor(1, { x: 0, z: -3 }), 'active');
    rig.select('taser');
    rig.apply(0, -1);
    rig.runFor(FORCE_CONFIG.taser.attachMaxS + 1);
    expect(rig.sys.hud.attached).toBe(false);
    rig.runFor(100);
    rig.apply(0, -1);
    expect(rig.applied.map((e) => e.cycle)).toEqual([1, 1]);
    expect(rig.sys.hud.ammo).toBe('0/2');
  });

  it('a cartridge fired within 120 s of the last cycle continues the count', () => {
    const rig = new Rig(scriptedRng([...TASER_NMI, ...TASER_NMI]));
    rig.add(makeActor(1, { x: 0, z: -3 }), 'active');
    rig.select('taser');
    rig.apply(0, -1);
    rig.runFor(FORCE_CONFIG.taser.attachMaxS + 1);
    rig.apply(0, -1);
    expect(rig.applied.map((e) => e.cycle)).toEqual([1, 2]);
  });

  it('refuses without cartridges and can be re-cycled with none left while attached', () => {
    const rig = new Rig(scriptedRng([...TASER_NMI, ...TASER_NMI, ...TASER_NMI]));
    const a = rig.add(makeActor(1, { x: 0, z: -3 }), 'active');
    rig.select('taser');
    rig.apply(0, -1);
    rig.apply(0, -1);
    expect(rig.applied).toHaveLength(2);
    // Second target: fire the last cartridge.
    a.x = 0;
    rig.runFor(31);
    rig.apply(0, -1);
    expect(rig.sys.hud.ammo).toBe('0/2');
    rig.runFor(31);
    rig.apply(0, -1);
    expect(rig.flashes.at(-1)).toBe('TASER: no cartridges');
    expect(rig.applied).toHaveLength(3);
  });

  it('pain only: one probe-like outcome incapacitates only with painComply and does not attach', () => {
    const rig = new Rig(scriptedRng(TASER_PAIN));
    // Cold clothing failure on the bottom probe (u 0.5 >= 0.2 passes, so force it with a low draw instead).
    rig.temp = -10;
    rig.add(makeActor(1, { x: 0, z: -3 }), 'passive');
    rig.select('taser');
    rig.apply(0, -1);
    expect(rig.sys.hud.attached).toBe(false);
    expect(rig.applied[0]).toMatchObject({ hit: true, cycle: 1 });
    expect(rig.calls.some((c) => c.startsWith('incapacitate:1:5:taser'))).toBe(true);
    expect(rig.flashes.at(-1)).toMatch(/pain only/);
  });

  it('a clean miss still spends the cartridge but records the event with hit false', () => {
    // Large gauss deviation: u1 tiny, u2 = 0 -> z about 7.4 sigma.
    const rig = new Rig(scriptedRng([1e-9, 0, 0.5, 0.5, 0.5]));
    rig.add(makeActor(1, { x: 0, z: -3 }), 'active');
    rig.select('taser');
    rig.apply(0, -1);
    expect(rig.applied[0]).toMatchObject({ hit: false, cycle: 0, injury: 0 });
    expect(rig.sys.hud.ammo).toBe('1/2');
    expect(rig.calls.some((c) => c.startsWith('incapacitate'))).toBe(false);
    expect(rig.flashes.at(-1)).toBe('TASER: missed');
  });

  it('cold weather is passed to the model', () => {
    const run = (temp: number): number => {
      let probes2 = 0;
      for (let seed = 1; seed <= 200; seed++) {
        const rig = new Rig(createRng(seed).stream('force'));
        rig.temp = temp;
        rig.add(makeActor(1, { x: 0, z: -3 }), 'active');
        rig.select('taser');
        rig.apply(0, -1);
        if (rig.sys.hud.attached) probes2++;
      }
      return probes2;
    };
    expect(run(-20)).toBeLessThan(run(20));
  });
});

describe('effects', () => {
  it('records the resistance before the effect changes it', () => {
    const rig = new Rig(scriptedRng(TASER_NMI));
    rig.add(makeActor(1, { x: 0, z: -3 }), 'assaultive');
    rig.select('taser');
    rig.apply(0, -1);
    expect(rig.applied[0]?.resistance).toBe('assaultive');
    expect(rig.resist.get(1)).toBe('compliant');
    const iResistance = rig.calls.indexOf('resistance:1');
    const iEffect = rig.calls.findIndex((c) => c.startsWith('incapacitate'));
    expect(iResistance).toBeGreaterThanOrEqual(0);
    expect(iResistance).toBeLessThan(iEffect);
  });

  it('firearm hit wounds the actor and injures the person; a fatal hit sets deceased', () => {
    // gauss ~ 0, zone 0.1 -> torso, injury 0.5, fatal 0.0 < 0.25.
    const rig = new Rig(scriptedRng([0.99, 0, 0.1, 0.5, 0.0]));
    rig.add(makeActor(1, { x: 0, z: -8 }), 'lethal');
    rig.persons.set(10, { elderly: false, juvenile: false, age: 30, sex: 'M', bac: 0 });
    rig.select('firearm');
    rig.applied.length = 0;
    rig.apply(0, -1);
    const e = rig.applied[0];
    expect(e).toMatchObject({ tool: 'firearm', level: 'firearm', hit: true, fatal: true, resistance: 'lethal' });
    expect(e?.injury).toBeCloseTo(0.7);
    expect(rig.calls).toContain('wound:1:0.700:true');
    expect(rig.injured.get(10)).toBeCloseTo(0.7);
    expect(rig.deceased.has(10)).toBe(true);
    expect(rig.sys.hud.ammo).toBe('14/15');
  });

  it('firearm miss wounds nobody', () => {
    const rig = new Rig(scriptedRng([1e-9, 0, 0.1, 0.5, 0.0]));
    rig.add(makeActor(1, { x: 0, z: -8 }), 'lethal');
    rig.select('firearm');
    rig.applied.length = 0;
    rig.apply(0, -1);
    expect(rig.applied[0]).toMatchObject({ hit: false, injury: 0, fatal: false });
    expect(rig.calls.some((c) => c.startsWith('wound'))).toBe(false);
    expect(rig.injured.size).toBe(0);
    expect(rig.deceased.size).toBe(0);
  });

  it('never lowers an existing injury', () => {
    const rig = new Rig(scriptedRng([0.1, 0.9, 0.0]));
    rig.add(makeActor(1, { x: 0, z: -1 }));
    rig.injured.set(10, 0.9);
    rig.select('hands');
    rig.apply(0, -1);
    expect(rig.injured.get(10)).toBe(0.9);
  });

  it('less-lethal incapacitates with beanbag and injures', () => {
    // gauss ~ 0, zone torso, injury 0.5, fatal 0.5, incapacitate roll 0.1 < 0.8.
    const rig = new Rig(scriptedRng([0.99, 0, 0.1, 0.5, 0.5, 0.1]));
    rig.add(makeActor(1, { x: 0, z: -10 }), 'active');
    rig.select('lessLethal');
    rig.applied.length = 0;
    rig.apply(0, -1);
    expect(rig.applied[0]).toMatchObject({ tool: 'lessLethal', level: 'lessLethal', hit: true, fatal: false });
    expect(rig.calls).toContain('incapacitate:1:6:beanbag');
    expect(rig.injured.get(10)).toBeCloseTo(0.2);
    expect(rig.sys.hud.ammo).toBe('4/5');
  });

  it('melee tools incapacitate with the matching cause', () => {
    const cases: [Parameters<Rig['select']>[0], string][] = [['hands', 'strike'], ['baton', 'baton'], ['ocSpray', 'oc'], ['k9', 'k9']];
    for (const [tool, by] of cases) {
      const rig = new Rig(scriptedRng([0.1, 0.0, 0.5]));
      rig.k9 = true;
      rig.add(makeActor(1, { x: 0, z: -1 }), 'active');
      rig.select(tool);
      rig.apply(0, -1);
      expect(rig.calls.some((c) => c.startsWith('incapacitate:1:') && c.endsWith(`:${by}`))).toBe(true);
      expect(rig.applied[0]).toMatchObject({ tool, hit: true });
    }
  });

  it('OC spray uses ammo and is weaker on an impaired target', () => {
    const rig = new Rig(scriptedRng([0.1, 0.7, 0.5]));
    // 0.7 < 0.85 would incapacitate a sober target; impaired chance is 0.85 x 0.7 = 0.595.
    rig.add(makeActor(1, { x: 0, z: -1 }), 'active');
    rig.persons.set(10, { elderly: false, juvenile: false, age: 30, sex: 'M', bac: 0.8 });
    rig.select('ocSpray');
    rig.apply(0, -1);
    expect(rig.calls.some((c) => c.startsWith('incapacitate'))).toBe(false);
    expect(rig.sys.hud.ammo).toBe('9/10');
    const sober = new Rig(scriptedRng([0.1, 0.7, 0.5]));
    sober.add(makeActor(1, { x: 0, z: -1 }), 'active');
    sober.select('ocSpray');
    sober.apply(0, -1);
    expect(sober.calls.some((c) => c.startsWith('incapacitate'))).toBe(true);
  });

  it('a melee miss records hit false and no effect', () => {
    const rig = new Rig(scriptedRng([0.99, 0.0, 0.5]));
    rig.add(makeActor(1, { x: 0, z: -1 }), 'active');
    rig.select('hands');
    rig.apply(0, -1);
    expect(rig.applied[0]).toMatchObject({ hit: false, injury: 0 });
    expect(rig.calls.some((c) => c.startsWith('incapacitate'))).toBe(false);
  });

  it('empty firearm and less-lethal refuse to fire', () => {
    const rig = new Rig(scriptedRng([], 0.99));
    rig.add(makeActor(1, { x: 0, z: -3 }), 'active');
    rig.select('firearm');
    rig.applied.length = 0;
    for (let i = 0; i < 15; i++) rig.apply(0, -1);
    expect(rig.sys.hud.ammo).toBe('0/15');
    const n = rig.applied.length;
    rig.apply(0, -1);
    expect(rig.applied).toHaveLength(n);
    expect(rig.flashes.at(-1)).toBe('Sidearm: empty');
  });
});

describe('risk factors', () => {
  it('are recorded in the event', () => {
    let pregnantId = -1;
    for (let id = 0; id < 5000 && pregnantId < 0; id++) if (isPregnant(4242, id, 'F', 30, FORCE_CONFIG.risk)) pregnantId = id;
    expect(pregnantId).toBeGreaterThanOrEqual(0);
    const rig = new Rig(scriptedRng([0.1, 0.9, 0.5]));
    rig.add(makeActor(1, { personId: pregnantId, x: 0, z: -1, state: ACTOR_STATE.flee, cuffed: true }), 'active');
    rig.persons.set(pregnantId, { elderly: false, juvenile: true, age: 30, sex: 'F', bac: 0 });
    rig.elevated = true;
    rig.select('hands');
    rig.apply(0, -1);
    expect(rig.applied[0]?.riskFactors).toEqual(['juvenile', 'pregnant', 'elevated', 'running', 'restrained']);
    expect(rig.applied[0]?.restrained).toBe(true);
  });

  it('are empty for an ordinary subject and elderly is reported', () => {
    const rig = new Rig(scriptedRng([0.1, 0.9, 0.5, 0.1, 0.9, 0.5]));
    rig.add(makeActor(1, { x: 0, z: -1 }));
    rig.select('hands');
    rig.apply(0, -1);
    expect(rig.applied[0]?.riskFactors).toEqual([]);
    rig.persons.set(10, { elderly: true, juvenile: false, age: 80, sex: 'M', bac: 0 });
    rig.apply(0, -1);
    expect(rig.applied[1]?.riskFactors).toEqual(['elderly']);
  });
});

describe('firearm display', () => {
  it('is emitted once per draw when an actor is within 15 m', () => {
    const rig = new Rig();
    rig.add(makeActor(1, { x: 3, z: 4 }), 'assaultive');
    rig.select('firearm');
    expect(rig.applied).toHaveLength(1);
    expect(rig.applied[0]).toMatchObject({ tool: 'firearmDisplay', level: 'presence', actorId: 1, hit: false, injury: 0, resistance: 'assaultive', distance: 5 });
    rig.run(60);
    expect(rig.applied).toHaveLength(1);
    rig.select('hands');
    rig.select('firearm');
    expect(rig.applied).toHaveLength(2);
  });

  it('is not emitted without a target within 15 m', () => {
    const rig = new Rig();
    rig.add(makeActor(1, { x: 0, z: -20 }));
    rig.select('firearm');
    expect(rig.applied).toHaveLength(0);
    rig.select('none');
    rig.actors.get(1)!.z = -14.9;
    rig.select('firearm');
    expect(rig.applied).toHaveLength(1);
  });

  it('is not emitted for other tools', () => {
    const rig = new Rig();
    rig.add(makeActor(1, { x: 0, z: -2 }));
    rig.select('taser');
    rig.select('baton');
    expect(rig.applied).toHaveLength(0);
  });
});

describe('armory ammo', () => {
  it('refills when the item goes from returned to signed out', () => {
    const rig = new Rig(scriptedRng([], 0.5));
    rig.add(makeActor(1, { x: 0, z: -3 }));
    rig.select('firearm');
    rig.apply(0, -1);
    rig.apply(0, -1);
    expect(rig.sys.hud.ammo).toBe('13/15');
    rig.held.delete('sidearm');
    rig.run(1);
    expect(rig.sys.tool).toBe('none');
    rig.held.add('sidearm');
    rig.run(1);
    rig.select('firearm');
    expect(rig.sys.hud.ammo).toBe('15/15');
  });

  it('does not refill while the item stays signed out', () => {
    const rig = new Rig();
    rig.select('taser');
    rig.apply(0, -1);
    expect(rig.sys.hud.ammo).toBe('1/2');
    rig.run(300);
    expect(rig.sys.hud.ammo).toBe('1/2');
  });

  it('refills the TASER and drops the attachment', () => {
    const rig = new Rig(scriptedRng(TASER_NMI));
    rig.add(makeActor(1, { x: 0, z: -3 }), 'active');
    rig.select('taser');
    rig.apply(0, -1);
    expect(rig.sys.hud.attached).toBe(true);
    rig.held.delete('taser');
    rig.run(1);
    rig.held.add('taser');
    rig.run(1);
    rig.select('taser');
    expect(rig.sys.hud).toMatchObject({ ammo: '2/2', attached: false });
  });
});

describe('fellow officer episodes', () => {
  /** A cuffed, previously assaultive subject on call 5 with a partner 1 m away. */
  function setup(rngValues: number[]): Rig {
    const rig = new Rig(scriptedRng(rngValues, 0.5));
    rig.add(makeActor(1, { personId: 7, x: 0, z: -1, cuffed: true, callId: 5 }), 'assaultive');
    rig.effectsCalm = false;
    rig.fellowList = [{ name: 'Partner Reyes', x: 1, z: -1, building: -1 }];
    rig.select('hands');
    // Hands apply draws 3 (hit, no incapacitation, injury); the fellow roll draw follows.
    return rig;
  }

  it('strikes after the delay, every repeatS, up to maxStrikes, then ends', () => {
    const f = FORCE_CONFIG.fellow;
    const rig = setup([0.1, 0.9, 0.5, 0.0]);
    rig.apply(0, -1);
    const t0 = rig.t;
    rig.runFor(1);
    expect(rig.other).toHaveLength(0);
    rig.runFor(20);
    expect(rig.other).toHaveLength(f.maxStrikes);
    const times = rig.other.map((e) => e.sim);
    expect(times[0]! - t0).toBeGreaterThanOrEqual(f.delayS[0] - 0.3);
    expect(times[0]! - t0).toBeLessThanOrEqual(f.delayS[0] + 0.5);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeCloseTo(f.repeatS, 1);
    expect(rig.other[0]).toMatchObject({ officer: 'Partner Reyes', level: 'hardHands', personId: 7, actorId: 1, callId: 5, restrained: true, resistance: 'assaultive' });
    expect(rig.other[0]?.distanceToOfficer).toBeCloseTo(1);
    expect(rig.other.map((e) => e.seq)).toEqual([rig.other[0]!.seq, rig.other[0]!.seq + 1, rig.other[0]!.seq + 2]);
    expect(rig.injured.get(7)).toBeCloseTo(0.075 + f.injury * 3);
    expect(rig.flashes.filter((x) => /press H to intervene/.test(x))).toHaveLength(3);
    expect(rig.sys.hud.episode).toBeNull();
    rig.runFor(30);
    expect(rig.other).toHaveLength(f.maxStrikes);
  });

  it('rolls once per person and only for violent, restrained subjects near a fellow', () => {
    const rig = setup([0.1, 0.9, 0.5, 0.99]);
    rig.apply(0, -1);
    rig.runFor(30);
    expect(rig.other).toHaveLength(0);
    // No second roll: a later draw below the chance would have started one.
    rig.rng.next();
    rig.runFor(30);
    expect(rig.other).toHaveLength(0);

    // Not violent: the force applied was against a compliant subject.
    const calm = new Rig(scriptedRng([0.1, 0.9, 0.5, 0.0]));
    calm.add(makeActor(1, { personId: 7, x: 0, z: -1, cuffed: true }), 'compliant');
    calm.fellowList = [{ name: 'P', x: 1, z: -1, building: -1 }];
    calm.select('hands');
    calm.apply(0, -1);
    calm.runFor(30);
    expect(calm.other).toHaveLength(0);

    // Fellow too far away.
    const far = setup([0.1, 0.9, 0.5, 0.0]);
    far.fellowList = [{ name: 'P', x: 10, z: -1, building: -1 }];
    far.apply(0, -1);
    far.runFor(30);
    expect(far.other).toHaveLength(0);

    // Subject of another call.
    const other = setup([0.1, 0.9, 0.5, 0.0]);
    other.actors.get(1)!.callId = 9;
    other.apply(0, -1);
    other.runFor(30);
    expect(other.other).toHaveLength(0);
  });

  it('intervening within the radius ends the episode and emits force:intervened', () => {
    const rig = setup([0.1, 0.9, 0.5, 0.0]);
    rig.apply(0, -1);
    rig.runFor(2.5);
    expect(rig.other).toHaveLength(1);
    expect(rig.sys.hud.episode).toBe('Partner Reyes');
    rig.sys.request({ kind: 'intervene' });
    rig.run(1);
    expect(rig.intervened).toHaveLength(1);
    expect(rig.intervened[0]).toMatchObject({ otherSeq: rig.other[0]!.seq, personId: 7, callId: 5 });
    expect(rig.flashes.at(-1)).toBe('You intervened');
    rig.runFor(20);
    expect(rig.other).toHaveLength(1);
    expect(rig.sys.hud.episode).toBeNull();
  });

  it('intervening later reports the latest strike', () => {
    const rig = setup([0.1, 0.9, 0.5, 0.0]);
    rig.apply(0, -1);
    rig.runFor(5);
    expect(rig.other).toHaveLength(2);
    rig.sys.request({ kind: 'intervene' });
    rig.run(1);
    expect(rig.intervened[0]?.otherSeq).toBe(rig.other[1]!.seq);
  });

  it('refuses from outside the radius and the episode continues', () => {
    const rig = setup([0.1, 0.9, 0.5, 0.0]);
    rig.apply(0, -1);
    rig.runFor(2.5);
    const away = { ...OFFICER, x: 0, z: 40 };
    rig.sys.request({ kind: 'intervene' });
    rig.run(1, away);
    expect(rig.intervened).toHaveLength(0);
    expect(rig.flashes.at(-1)).toBe('Too far to intervene');
    rig.runFor(10);
    expect(rig.other).toHaveLength(FORCE_CONFIG.fellow.maxStrikes);
  });

  it('says there is nothing to intervene in without an episode', () => {
    const rig = new Rig();
    rig.sys.request({ kind: 'intervene' });
    rig.run(1);
    expect(rig.intervened).toHaveLength(0);
    expect(rig.flashes.at(-1)).toBe('Nothing to intervene in');
  });

  it('the episode ends quietly when the subject is no longer restrained', () => {
    const rig = setup([0.1, 0.9, 0.5, 0.0]);
    rig.apply(0, -1);
    rig.runFor(2.5);
    rig.actors.get(1)!.cuffed = false;
    rig.runFor(10);
    expect(rig.other).toHaveLength(1);
    expect(rig.sys.hud.episode).toBeNull();
  });

  it('fellowTest starts striking the nearest restrained actor at once', () => {
    const rig = new Rig();
    rig.add(makeActor(1, { personId: 7, x: 0, z: -6, cuffed: true }));
    rig.add(makeActor(2, { personId: 8, x: 0, z: -3, cuffed: true }));
    rig.add(makeActor(3, { personId: 9, x: 0, z: -1 }));
    rig.fellowList = [{ name: 'Partner Reyes', x: 5, z: 5, building: -1 }];
    rig.sys.request({ kind: 'fellowTest' });
    rig.run(1);
    expect(rig.other).toHaveLength(1);
    expect(rig.other[0]).toMatchObject({ actorId: 2, personId: 8, officer: 'Partner Reyes' });
  });

  it('fellowTest with nobody restrained within reach flashes', () => {
    const rig = new Rig();
    rig.add(makeActor(1, { personId: 7, x: 0, z: -30, cuffed: true }));
    rig.sys.request({ kind: 'fellowTest' });
    rig.run(1);
    expect(rig.other).toHaveLength(0);
    expect(rig.flashes.at(-1)).toBe('No restrained subject nearby');
  });
});

describe('serialize and restore', () => {
  function world(): Rig {
    const rig = new Rig(createRng(2024).stream('force'));
    rig.add(makeActor(1, { personId: 7, x: 0, z: -3, cuffed: false }), 'assaultive');
    rig.add(makeActor(2, { personId: 8, x: 0.5, z: -1, cuffed: true, callId: 5 }), 'assaultive');
    rig.fellowList = [{ name: 'Partner Reyes', x: 1.5, z: -1, building: -1 }];
    rig.effectsCalm = false;
    return rig;
  }

  it('continues identically from a JSON round trip', () => {
    const a = world();
    a.select('taser');
    a.apply(0, -1);
    a.runFor(1);
    a.apply(0, -1);
    a.select('hands');
    a.sys.request({ kind: 'apply', dirX: 0.45, dirZ: -1 });
    a.sys.request({ kind: 'fellowTest' });
    const save = JSON.parse(JSON.stringify(a.sys.serialize())) as ReturnType<typeof a.sys.serialize>;
    expect(save.queue).toHaveLength(2);
    const b = world();
    b.t = a.t;
    b.sys.restore(save);
    expect(b.sys.tool).toBe(a.sys.tool);
    expect(b.sys.hud).toEqual(a.sys.hud);
    const na = a.applied.length;
    const no = a.other.length;
    const tail = (rig: Rig): void => {
      rig.run(1);
      for (let i = 0; i < 8; i++) {
        rig.apply(0.45, -1);
        rig.runFor(1.1);
      }
      rig.runFor(10);
    };
    tail(a);
    tail(b);
    const ta = a.applied.slice(na);
    expect(ta.length).toBeGreaterThanOrEqual(8);
    expect(b.applied).toEqual(ta);
    expect(a.other.length).toBeGreaterThan(no);
    expect(b.other).toEqual(a.other.slice(no));
    expect(b.sys.serialize()).toEqual(a.sys.serialize());
    expect(b.flashes).toEqual(a.flashes.slice(a.flashes.length - b.flashes.length));
  });

  it('round trips an active episode and the rolled / violent sets', () => {
    const a = world();
    a.select('hands');
    a.apply(0.45, -1);
    a.sys.request({ kind: 'fellowTest' });
    a.run(1);
    a.runFor(2.5);
    const s = a.sys.serialize();
    expect(s.violent).toEqual([8]);
    expect(s.rolled).toEqual([8]);
    expect(s.episode).toMatchObject({ personId: 8, actorId: 2, officer: 'Partner Reyes' });
    expect(s.episode?.strikes).toBeGreaterThan(0);
    const again = world();
    again.sys.restore(JSON.parse(JSON.stringify(s)) as typeof s);
    expect(again.sys.serialize()).toEqual(s);
    again.t = a.t;
    a.runFor(10);
    again.runFor(10);
    expect(again.other).toEqual(a.other.slice(a.other.length - again.other.length));
    expect(again.other.length).toBeGreaterThan(0);
  });

  it('default save is valid and restores to a fresh state', async () => {
    const { defaultForceSave, isForceSave } = await import('../../src/force/save');
    const d = defaultForceSave(createRng(1).state());
    expect(isForceSave(d)).toBe(true);
    expect(d).toMatchObject({ tool: 'none', cartridges: 2, rounds: { firearm: 15, lessLethal: 5, ocSpray: 10 }, attached: null, episode: null });
    const rig = new Rig();
    rig.select('taser');
    rig.apply(0, -1);
    rig.sys.restore(d);
    expect(rig.sys.tool).toBe('none');
    expect(rig.sys.hud.ammo).toBe('');
  });

  it('isForceSave rejects malformed data', async () => {
    const { defaultForceSave, isForceSave } = await import('../../src/force/save');
    const d = defaultForceSave(createRng(1).state());
    expect(isForceSave(null)).toBe(false);
    expect(isForceSave({ ...d, version: 2 })).toBe(false);
    expect(isForceSave({ ...d, rng: { seed: 1, s: [1, 2, 3] } })).toBe(false);
    expect(isForceSave({ ...d, queue: [{ kind: 'bogus' }] })).toBe(false);
    expect(isForceSave({ ...d, queue: [{ kind: 'selectTool', tool: 'laser' }] })).toBe(false);
    expect(isForceSave({ ...d, cycles: [[1, 2]] })).toBe(false);
    expect(isForceSave({ ...d, episode: { personId: 1 } })).toBe(false);
    expect(isForceSave({ ...d, queue: [{ kind: 'apply', dirX: 0, dirZ: -1 }, { kind: 'intervene' }] })).toBe(true);
  });

  it('falls back to no tool for an unknown tool id', () => {
    const rig = new Rig();
    const s = rig.sys.serialize();
    rig.sys.restore({ ...s, tool: 'laser' });
    expect(rig.sys.tool).toBe('none');
  });
});

describe('performance', () => {
  it('10 000 idle steps take under 20 ms and emit nothing', () => {
    const rig = new Rig();
    rig.add(makeActor(1, { x: 0, z: -3 }));
    rig.fellowList = [{ name: 'P', x: 1, z: 1, building: -1 }];
    rig.select('taser');
    const events = rig.flashes.length + rig.applied.length;
    const t = { sim: 0, game: 0 };
    // Warm up.
    for (let i = 0; i < 2000; i++) rig.sys.step(DT, t, OFFICER);
    const t0 = performance.now();
    for (let i = 0; i < 10_000; i++) {
      t.sim += DT;
      rig.sys.step(DT, t, OFFICER);
    }
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(20);
    expect(rig.flashes.length + rig.applied.length).toBe(events);
  });
});
