import { describe, expect, it } from 'vitest';
import forceJson from '../../src/data/force/force.json';
import { createRng } from '../../src/core/rng';
import { FORCE_CONFIG, parseForceConfig } from '../../src/force/data';
import { defaultForceSave, isForceSave } from '../../src/force/save';
import { DT, OFFICER, Rig, makeActor, scriptedRng } from './helpers';

/** Phase 7 hooks (design §11.3): holster retention, draw delay and weapon-grab resistance. */

const DRAW_S = [0.25, 0.45, 0.7] as const;
const GRAB = [0.15, 0.06, 0.02] as const;

function clone(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(forceJson)) as Record<string, unknown>;
}

/** A rig with one subject `dist` metres from the officer (north), no effects. */
function rigWith(dist: number, level = 1, rng = createRng(11).stream('force')): Rig {
  const r = new Rig(rng);
  r.level = level;
  r.add(makeActor(1, { z: -dist }), 'active');
  return r;
}

const drawingFlashes = (r: Rig): number => r.flashes.filter((f) => f === 'Drawing…').length;

describe('retention data', () => {
  it('ships the design values', () => {
    expect(FORCE_CONFIG.retention).toEqual({ drawS: [0.25, 0.45, 0.7], grabChance: [0.15, 0.06, 0.02], grabRangeM: 1.5 });
  });

  it('is validated with file and path', () => {
    const mut = (f: (ret: Record<string, unknown>) => void): Record<string, unknown> => {
      const c = clone();
      f(c.retention as Record<string, unknown>);
      return c;
    };
    expect(() => parseForceConfig(mut((x) => { x.drawS = [0.25, 0.45]; }), 'x.json')).toThrow(/x\.json: retention\.drawS/);
    expect(() => parseForceConfig(mut((x) => { x.grabChance = [0.15, 0.06, 1.2]; }), 'x.json')).toThrow(/x\.json: retention\.grabChance\[2\]/);
    expect(() => parseForceConfig(mut((x) => { x.grabRangeM = -1; }), 'x.json')).toThrow(/x\.json: retention\.grabRangeM/);
    expect(() => parseForceConfig(mut((x) => { x.extra = 1; }), 'x.json')).toThrow(/x\.json: retention\.extra/);
    const noSection = clone();
    delete noSection.retention;
    expect(() => parseForceConfig(noSection, 'x.json')).toThrow(/x\.json: retention/);
    expect(parseForceConfig(clone(), 'x.json').retention.drawS).toEqual([0.25, 0.45, 0.7]);
  });
});

describe('draw delay', () => {
  it.each([1, 2, 3])('level %i refuses to fire until drawS has passed', (level) => {
    const drawS = DRAW_S[level - 1] as number;
    const r = rigWith(5, level);
    r.sys.request({ kind: 'selectTool', tool: 'firearm' });
    r.run(1);
    expect(r.sys.tool).toBe('firearm');
    r.apply();
    expect(r.flashes).toEqual(['Drawing…']);
    expect(r.applied.filter((e) => e.tool === 'firearm')).toHaveLength(0);
    r.runFor(drawS - 0.1);
    r.apply();
    expect(drawingFlashes(r)).toBe(2);
    expect(r.applied.filter((e) => e.tool === 'firearm')).toHaveLength(0);
    r.runFor(0.15);
    r.apply();
    expect(drawingFlashes(r)).toBe(2);
    expect(r.applied.filter((e) => e.tool === 'firearm')).toHaveLength(1);
  });

  it('a refused apply spends no ammo and draws nothing from the rng', () => {
    const r = rigWith(5, 3);
    r.sys.request({ kind: 'selectTool', tool: 'firearm' });
    r.run(1);
    const before = JSON.stringify(r.rng.state());
    const rounds = r.sys.serialize().rounds.firearm;
    r.apply();
    expect(JSON.stringify(r.rng.state())).toBe(before);
    expect(r.sys.serialize().rounds.firearm).toBe(rounds);
  });

  it('only the firearm is delayed, and an absent holsterLevel means level 1', () => {
    const r = new Rig(createRng(2).stream('force'), false);
    r.add(makeActor(1, { z: -1 }), 'active');
    r.sys.request({ kind: 'selectTool', tool: 'baton' });
    r.run(1);
    r.apply();
    expect(drawingFlashes(r)).toBe(0);
    expect(r.applied.filter((e) => e.tool === 'baton')).toHaveLength(1);
    r.sys.request({ kind: 'selectTool', tool: 'firearm' });
    r.run(1);
    r.runFor(0.2);
    r.apply();
    expect(drawingFlashes(r)).toBe(1);
    r.runFor(0.1);
    r.apply();
    expect(r.applied.filter((e) => e.tool === 'firearm')).toHaveLength(1);
  });

  it('out-of-range levels clamp to 1..3', () => {
    for (const [level, drawS] of [[0, 0.25], [9, 0.7], [2.4, 0.45]] as const) {
      const r = rigWith(5, level);
      r.sys.request({ kind: 'selectTool', tool: 'firearm' });
      r.run(1);
      r.runFor(drawS - 0.05);
      r.apply();
      expect(drawingFlashes(r)).toBe(1);
      r.runFor(0.1);
      r.apply();
      expect(drawingFlashes(r)).toBe(1);
    }
  });

  it('changing tool or leaving the foot cancels the draw', () => {
    const r = rigWith(5, 3);
    r.sys.request({ kind: 'selectTool', tool: 'firearm' });
    r.run(1);
    r.sys.request({ kind: 'selectTool', tool: 'hands' });
    r.run(1);
    r.sys.request({ kind: 'selectTool', tool: 'firearm' });
    r.run(1);
    expect(r.sys.serialize().drawingS).toBeGreaterThan(0.6);
    r.run(1, { ...OFFICER, onFoot: false });
    expect(r.sys.tool).toBe('none');
    expect(r.sys.serialize().drawingS).toBeUndefined();
  });
});

describe('weapon grab', () => {
  it.each([1, 2, 3])('level %i: grabs succeed at grabChance within 0.03 over 2000 seeded rolls', (level) => {
    const r = rigWith(1, level, createRng(100 + level).stream('force'));
    let grabs = 0;
    for (let i = 0; i < 2000; i++) {
      if (r.sys.tool !== 'firearm') r.select('firearm');
      r.attack(1);
      r.run(1);
      if (r.sys.tool !== 'firearm') grabs++;
    }
    expect(Math.abs(grabs / 2000 - (GRAB[level - 1] as number))).toBeLessThan(0.03);
    expect(grabs).toBeGreaterThan(0);
  });

  it('the roll is strict: below grabChance keeps the sidearm away, at it the officer keeps it', () => {
    const win = rigWith(1, 1, scriptedRng([0.1499]));
    win.select('firearm');
    win.attack(1);
    win.run(1);
    expect(win.sys.tool).toBe('hands');
    expect(win.tools).toEqual(['firearm', 'hands']);
    expect(win.weapons.at(-1)).toBe('none');
    expect(win.flashes).toContain('Weapon retention: the subject grabbed for your sidearm, you kept it holstered');
    expect(win.sys.hud.tool).toBe('hands');
    const lose = rigWith(1, 1, scriptedRng([0.15]));
    lose.select('firearm');
    lose.attack(1);
    lose.run(1);
    expect(lose.sys.tool).toBe('firearm');
    expect(lose.flashes.some((f) => f.startsWith('Weapon retention'))).toBe(false);
  });

  it('uses the level of the holster', () => {
    const roll = 0.1;
    const l1 = rigWith(1, 1, scriptedRng([roll]));
    const l3 = rigWith(1, 3, scriptedRng([roll]));
    for (const r of [l1, l3]) {
      r.select('firearm');
      r.attack(1);
      r.run(1);
    }
    expect(l1.sys.tool).toBe('hands');
    expect(l3.sys.tool).toBe('firearm');
  });

  it('draws nothing beyond grabRangeM, with another tool, or for other attack kinds', () => {
    const far = rigWith(1.6, 1);
    far.select('firearm');
    const before = JSON.stringify(far.rng.state());
    far.attack(1);
    far.run(5);
    expect(JSON.stringify(far.rng.state())).toBe(before);
    expect(far.sys.tool).toBe('firearm');

    const kinds = rigWith(1, 1);
    kinds.select('firearm');
    const k0 = JSON.stringify(kinds.rng.state());
    kinds.attack(1, 'fire');
    kinds.attack(1, 'brandish');
    kinds.run(5);
    expect(JSON.stringify(kinds.rng.state())).toBe(k0);

    const other = rigWith(1, 1);
    other.select('taser');
    const o0 = JSON.stringify(other.rng.state());
    other.attack(1);
    other.run(5);
    expect(JSON.stringify(other.rng.state())).toBe(o0);

    const unknown = rigWith(1, 1);
    unknown.select('firearm');
    const u0 = JSON.stringify(unknown.rng.state());
    unknown.attack(99);
    unknown.run(5);
    expect(JSON.stringify(unknown.rng.state())).toBe(u0);

    const near = rigWith(1.4, 1, scriptedRng([0]));
    near.select('firearm');
    near.attack(1);
    near.run(1);
    expect(near.sys.tool).toBe('hands');
  });

  it('a stale attack from before the draw is forgotten after one step; fights in another building are ignored', () => {
    const r = rigWith(1, 1, scriptedRng([0]));
    r.attack(1);
    r.run(1);
    r.select('firearm');
    r.run(3);
    expect(r.sys.tool).toBe('firearm');
    const b = new Rig(scriptedRng([0]));
    b.add(makeActor(1, { z: -1, building: 4 }), 'active');
    b.select('firearm');
    b.attack(1);
    b.run(1);
    expect(b.sys.tool).toBe('firearm');
  });

  it('dispose unsubscribes from npc:attack', () => {
    const r = rigWith(1);
    expect(r.bus.listenerCount('npc:attack')).toBe(1);
    r.sys.dispose();
    expect(r.bus.listenerCount('npc:attack')).toBe(0);
  });
});

describe('force save with drawingS', () => {
  it('round-trips the remaining draw time', () => {
    const a = rigWith(5, 3);
    a.sys.request({ kind: 'selectTool', tool: 'firearm' });
    a.run(1);
    a.runFor(0.3);
    const save = JSON.parse(JSON.stringify(a.sys.serialize())) as ReturnType<Rig['sys']['serialize']>;
    expect(isForceSave(save)).toBe(true);
    expect(save.drawingS).toBeGreaterThan(0.3);
    expect(save.drawingS).toBeLessThan(0.45);
    const b = rigWith(5, 3);
    b.sys.restore(save);
    expect(b.sys.tool).toBe('firearm');
    expect(b.sys.serialize().drawingS).toBeCloseTo(save.drawingS as number, 10);
    b.apply();
    expect(drawingFlashes(b)).toBe(1);
    b.runFor((save.drawingS as number) + 2 * DT);
    b.apply();
    expect(drawingFlashes(b)).toBe(1);
    expect(b.applied.filter((e) => e.tool === 'firearm')).toHaveLength(1);
  });

  it('old saves without drawingS restore as not drawing; bad values are rejected', () => {
    const fresh = defaultForceSave(createRng(1).stream('force').state());
    expect(isForceSave(fresh)).toBe(true);
    expect('drawingS' in fresh).toBe(false);
    expect(isForceSave({ ...fresh, drawingS: 0.2 })).toBe(true);
    expect(isForceSave({ ...fresh, drawingS: -1 })).toBe(false);
    expect(isForceSave({ ...fresh, drawingS: 'x' })).toBe(false);
    const r = rigWith(5, 3);
    r.sys.restore({ ...fresh, tool: 'firearm' });
    r.apply();
    expect(drawingFlashes(r)).toBe(0);
    // A tool other than the firearm never keeps a draw timer.
    r.sys.restore({ ...fresh, tool: 'baton', drawingS: 0.4 });
    expect(r.sys.serialize().drawingS).toBeUndefined();
  });
});
