import { describe, expect, it } from 'vitest';
import { action, callInfo, cx, DT, key, Rig, said } from './helpers';

function workload(rig: Rig): number {
  const t: { sim: number; game: number } = { sim: rig.sim, game: rig.game };
  const step = (): void => {
    t.sim += DT;
    t.game += DT;
    rig.sys.step(DT, t);
  };
  const start = performance.now();
  for (let c = 1; c <= 10; c++) {
    for (let i = 0; i < 25; i++) {
      said(rig, c, 5, { fact: 'drinking', sim: t.sim });
      action(rig, c, 5, 'frisk', { sim: t.sim, items: [] });
      rig.bus.emit('contact:miranda', { ...cx(c, 5), result: 'waived', custody: true, sim: t.sim });
      rig.bus.emit('npc:attack', { actorId: 1, personId: 5 + i, callId: c, kind: 'fight' });
      step();
    }
  }
  for (let i = 0; i < 500; i++) step();
  return performance.now() - start;
}

describe('performance', () => {
  it('1000 appended events and 1000 steps cost under 5 ms', () => {
    const make = (): Rig => {
      const rig = new Rig();
      rig.step();
      for (let c = 1; c <= 10; c++) rig.world.calls.set(c, callInfo());
      return rig;
    };
    workload(make());
    let best = Infinity;
    let events = 0;
    for (let run = 0; run < 3; run++) {
      const rig = make();
      best = Math.min(best, workload(rig));
      events = 0;
      for (const k of rig.sys.keys()) events += rig.log(k).events.length;
    }
    expect(events).toBeGreaterThanOrEqual(1000);
    expect(best).toBeLessThan(5);
  });

  it('idle steps are cheap', () => {
    const rig = new Rig();
    rig.world.calls.set(7, callInfo());
    rig.bus.emit('scene:materialized', { callId: 7 });
    rig.step(600);
    const start = performance.now();
    rig.step(10000);
    expect(performance.now() - start).toBeLessThan(40);
    expect(rig.log(key(7)).events.length).toBe(1);
  });
});
