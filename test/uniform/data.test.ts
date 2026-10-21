/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- tests mutate loosely typed raw JSON */
import { describe, expect, it } from 'vitest';
import uniformsJson from '../../src/data/uniform/uniforms.json';
import { parseUniformData, rankDef, UNIFORM_DATA, uniformClass } from '../../src/uniform/data';
import { RANK_IDS, UNIFORM_CLASSES } from '../../src/uniform/types';

function variant(edit: (doc: Record<string, any>) => void): unknown {
  const doc = JSON.parse(JSON.stringify(uniformsJson)) as Record<string, any>;
  edit(doc);
  return doc;
}

describe('uniform data', () => {
  it('parses the shipped file', () => {
    expect(UNIFORM_DATA.classes.map((c) => c.id).sort()).toEqual([...UNIFORM_CLASSES].sort());
    expect(UNIFORM_DATA.ranks.map((r) => r.id).sort()).toEqual([...RANK_IDS].sort());
    expect(UNIFORM_DATA.skinTones.length).toBeGreaterThanOrEqual(4);
    expect(uniformClass('classB').top).toBe(0x24375a);
    expect(uniformClass('bike').shorts).toBe(true);
    expect(uniformClass('motor').tallBoots).toBe(true);
    expect(uniformClass('detective').badgeOnBelt).toBe(true);
    expect(uniformClass('classA').badgeOnBelt).toBe(false);
    expect(rankDef('chief').insignia).toEqual(['star', 'star', 'star']);
    expect(UNIFORM_DATA.department.name).toBe('City Police');
    expect(UNIFORM_DATA.department.patch.base).toBe(0x1d3f8f);
    expect(UNIFORM_DATA.department.badge.starPoints).toBe(7);
    expect(UNIFORM_DATA.vehiclePolicy.motor).toEqual(['motor']);
  });

  const bad: [string, (d: Record<string, any>) => void, string][] = [
    ['version', (d) => (d.version = 2), 'uniforms.json: version must be 1'],
    ['class colour', (d) => (d.classes[1].top = '24375a'), 'uniforms.json: classes[1].top must be a "#rrggbb" colour'],
    ['hat id', (d) => (d.classes[2].hat = 'fez'), 'uniforms.json: classes[2].hat must be one of none, peakedCap'],
    ['carrier id', (d) => (d.classes[0].carrier = 'vest'), 'uniforms.json: classes[0].carrier must be one of'],
    ['belt kind', (d) => (d.classes[0].belt = 'rope'), 'uniforms.json: classes[0].belt must be one of dress, duty, plain'],
    ['class boolean', (d) => (d.classes[0].tie = 'yes'), 'uniforms.json: classes[0].tie must be true or false'],
    ['class id', (d) => (d.classes[0].id = 'classZ'), 'uniforms.json: classes[0].id must be one of'],
    ['duplicate class', (d) => (d.classes[1].id = 'classA'), 'uniforms.json: classes[1].id is duplicated'],
    ['missing class', (d) => d.classes.pop(), 'uniforms.json: classes is missing "detective"'],
    ['missing rank', (d) => d.ranks.shift(), 'uniforms.json: ranks is missing "officer"'],
    ['insignia kind', (d) => (d.ranks[1].insignia = ['wing']), 'uniforms.json: ranks[1].insignia[0] must be one of chevron, bar, star'],
    ['skin tones', (d) => (d.skinTones = ['#ffffff']), 'uniforms.json: skinTones must have at least 4 items'],
    ['skin tone colour', (d) => (d.skinTones[2] = 'tan'), 'uniforms.json: skinTones[2] must be a "#rrggbb" colour'],
    ['hair colour', (d) => (d.hairColors[0] = 5), 'uniforms.json: hairColors[0] must be a "#rrggbb" colour'],
    ['policy key', (d) => (d.vehiclePolicy.boat = ['swat']), 'uniforms.json: vehiclePolicy.boat must be one of patrol'],
    ['policy value', (d) => (d.vehiclePolicy.motor = ['jetpack']), 'uniforms.json: vehiclePolicy.motor[0] must be one of classA'],
    ['policy empty', (d) => (d.vehiclePolicy.motor = []), 'uniforms.json: vehiclePolicy.motor must have at least 1 items'],
    ['patch shape', (d) => (d.department.patch.shape = 'blob'), 'uniforms.json: department.patch.shape must be one of'],
    ['patch initials', (d) => (d.department.patch.initials = 'ABCDE'), 'uniforms.json: department.patch.initials must have at most 4 characters'],
    ['patch text', (d) => (d.department.patch.text = 'X'.repeat(17)), 'uniforms.json: department.patch.text must have at most 16 characters'],
    ['patch polygon points', (d) => (d.department.patch = { ...d.department.patch, shape: 'polygon' }), 'uniforms.json: department.patch.points must be an array'],
    ['badge text', (d) => (d.department.badge.text = 'X'.repeat(13)), 'uniforms.json: department.badge.text must have at most 12 characters'],
    ['badge star points', (d) => (d.department.badge.starPoints = 2), 'uniforms.json: department.badge.starPoints must be in [3, 12]'],
    ['badge colour', (d) => (d.department.badge.metal = 'gold'), 'uniforms.json: department.badge.metal must be a "#rrggbb" colour'],
    ['not an object', (d) => (d.department = []), 'uniforms.json: department must be an object'],
  ];
  it.each(bad)('rejects a bad %s', (_name, edit, message) => {
    expect(() => parseUniformData(variant(edit), 'uniforms.json')).toThrow(message);
  });

  it('names the file it was given', () => {
    expect(() => parseUniformData(variant((d) => (d.version = 0)), 'custom.json')).toThrow('custom.json: version');
    expect(() => parseUniformData(null, 'custom.json')).toThrow('custom.json: must be an object');
  });

  it('accepts a polygon patch with points', () => {
    const data = parseUniformData(
      variant((d) => {
        d.department.patch.shape = 'polygon';
        d.department.patch.points = [[0, 0], [1, 0], [0.5, 1]];
      }),
      'x.json',
    );
    expect(data.department.patch.points).toEqual([[0, 0], [1, 0], [0.5, 1]]);
  });
});
