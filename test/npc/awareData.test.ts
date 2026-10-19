import { describe, expect, it } from 'vitest';
import behaviorsJson from '../../src/data/npc/behaviors.json';
import npcJson from '../../src/data/npc/npc.json';
import { BEHAVIORS, behavior, parseBehaviors, parseNpcConfig } from '../../src/npc/data';
import { AWARE_REACTIONS } from '../../src/npc/types';

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

describe('onAware data', () => {
  const listed: Record<string, Record<string, number>> = {
    suspectEvasive: { hide: 0.6, flee: 0.4 },
    suspectFleeRisk: { flee: 0.8, hide: 0.2 },
    suspectNervous: { surrender: 0.3, flee: 0.3, hide: 0.4 },
    suspectAgitated: { confront: 0.5, flee: 0.2, none: 0.3 },
    suspectHostile: { confront: 0.8, hide: 0.2 },
    suspectArmedHostile: { arm: 0.5, confront: 0.3, hide: 0.2 },
    barricaded: { hide: 0.7, arm: 0.3 },
    ambusher: { arm: 1 },
  };

  it('has exactly the weights of the design on the listed profiles', () => {
    for (const [id, weights] of Object.entries(listed)) {
      const got = behavior(id).onAware;
      for (const r of AWARE_REACTIONS) expect(got[r]).toBeCloseTo(weights[r] ?? 0, 9);
    }
  });

  it('every other profile only turns towards the sound', () => {
    for (const p of BEHAVIORS) {
      if (p.id in listed) continue;
      expect(p.onAware).toEqual({ none: 1, hide: 0, flee: 0, confront: 0, surrender: 0, arm: 0 });
    }
  });

  it('rejects unknown reactions, bad weights and all-zero tables naming the path', () => {
    const doc = clone(behaviorsJson) as { profiles: Record<string, unknown>[] };
    (doc.profiles[0] as Record<string, unknown>).onAware = { dance: 1 };
    expect(() => parseBehaviors(doc, 'behaviors.json')).toThrow(/behaviors\.json.*profiles\[0\]\.onAware\.dance/);
    (doc.profiles[0] as Record<string, unknown>).onAware = { flee: 2 };
    expect(() => parseBehaviors(doc, 'behaviors.json')).toThrow(/profiles\[0\]\.onAware\.flee/);
    (doc.profiles[0] as Record<string, unknown>).onAware = { flee: 0 };
    expect(() => parseBehaviors(doc, 'behaviors.json')).toThrow(/profiles\[0\]\.onAware/);
    (doc.profiles[0] as Record<string, unknown>).onAware = {};
    expect(() => parseBehaviors(doc, 'behaviors.json')).toThrow(/profiles\[0\]\.onAware/);
  });

  it('npc.json needs the awareness numbers, in order', () => {
    const doc = clone(npcJson) as { actors: Record<string, unknown> };
    expect(parseNpcConfig(doc, 'npc.json').actors.awareAt).toBe(0.7);
    doc.actors.alertAt = 0.8;
    expect(() => parseNpcConfig(doc, 'npc.json')).toThrow(/npc\.json.*actors\.awareAt/);
    doc.actors.alertAt = 0.3;
    delete doc.actors.awareDecayPerS;
    expect(() => parseNpcConfig(doc, 'npc.json')).toThrow(/actors\.awareDecayPerS/);
  });
});
