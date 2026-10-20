import { describe, expect, it } from 'vitest';
import forceJson from '../../src/data/force/force.json';
import { FORCE_CONFIG, parseForceConfig } from '../../src/force/data';
import { FORCE_LEVELS, FORCE_TOOLS } from '../../src/force/types';

interface Mutable {
  version: number;
  tools: Record<string, unknown>[];
  taser: Record<string, unknown>;
  firearm: Record<string, unknown>;
}

function clone(): Mutable {
  return JSON.parse(JSON.stringify(forceJson)) as Mutable;
}

describe('force.json', () => {
  it('parses and defines every tool except none', () => {
    const ids = FORCE_CONFIG.tools.map((t) => t.id).sort();
    expect(ids).toEqual(FORCE_TOOLS.filter((t) => t !== 'none').sort());
    for (const t of FORCE_CONFIG.tools) expect(FORCE_LEVELS).toContain(t.level);
  });

  it('holds the design values', () => {
    expect(FORCE_CONFIG.taser).toMatchObject({ cartridges: 2, cycleS: 5, attachMaxS: 30, reattachRangeM: 8.5 });
    expect(FORCE_CONFIG.firearm.zoneWeights).toEqual({ torso: 0.7, limb: 0.25, head: 0.05 });
    expect(FORCE_CONFIG.fellow).toMatchObject({ chance: 0.25, repeatS: 2, maxStrikes: 3, interveneRadiusM: 15 });
    expect(FORCE_CONFIG.tools.find((t) => t.id === 'firearm')?.rounds).toBe(15);
    expect(FORCE_CONFIG.tools.find((t) => t.id === 'ocSpray')?.uses).toBe(10);
    expect(FORCE_CONFIG.risk.elevatedRoomKinds).toContain('stairwell');
  });
});

describe('parseForceConfig', () => {
  it('names the file and the dotted path', () => {
    const bad = clone();
    bad.taser.nmiSuccess = 1.5;
    expect(() => parseForceConfig(bad, 'x.json')).toThrow(/x\.json: taser\.nmiSuccess/);
  });

  it('rejects a missing tool, a duplicate tool and a bad level', () => {
    const missing = clone();
    missing.tools = missing.tools.filter((t) => t.id !== 'k9');
    expect(() => parseForceConfig(missing)).toThrow(/missing the required tool "k9"/);
    const dup = clone();
    dup.tools.push(dup.tools[0]!);
    expect(() => parseForceConfig(dup)).toThrow(/tools\[7\]\.id/);
    const level = clone();
    level.tools[1]!.level = 'nuke';
    expect(() => parseForceConfig(level)).toThrow(/tools\[1\]\.level/);
  });

  it('requires ammo fields and valid ranges', () => {
    const noRounds = clone();
    delete noRounds.tools[5]!.rounds;
    expect(() => parseForceConfig(noRounds)).toThrow(/tools\[5\]\.rounds/);
    const range = clone();
    range.tools[0]!.rangeM = [3, 1];
    expect(() => parseForceConfig(range)).toThrow(/tools\[0\]\.rangeM/);
  });

  it('rejects unknown fields, a bad version and non-objects', () => {
    const extra = clone();
    extra.taser.typo = 1;
    expect(() => parseForceConfig(extra)).toThrow(/taser\.typo is not a known field/);
    const ver = clone();
    ver.version = 2;
    expect(() => parseForceConfig(ver)).toThrow(/version/);
    expect(() => parseForceConfig(null)).toThrow(/must be an object/);
  });

  it('rejects all-zero zone weights', () => {
    const bad = clone();
    bad.firearm.zoneWeights = { torso: 0, limb: 0, head: 0 };
    expect(() => parseForceConfig(bad)).toThrow(/firearm\.zoneWeights/);
  });
});
