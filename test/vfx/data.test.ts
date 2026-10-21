import { describe, expect, it } from 'vitest';
import vfxJson from '../../src/data/vfx/vfx.json';
import { parseVfxData, VFX_DATA } from '../../src/render/vfx/data';
import { EFFECTS_QUALITY, VFX_PARTICLE_KINDS } from '../../src/render/vfx/types';

function clone(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(vfxJson)) as Record<string, unknown>;
}

describe('vfx data', () => {
  it('exports the contract lists', () => {
    expect(EFFECTS_QUALITY).toEqual(['off', 'low', 'high']);
    expect(VFX_PARTICLE_KINDS).toEqual(['spark', 'dust', 'muzzle', 'taser', 'splash']);
  });

  it('parses vfx.json with the design values', () => {
    expect(VFX_DATA.glow.capacity).toBe(512);
    expect(VFX_DATA.glow.pool.capacity).toBe(16);
    expect(VFX_DATA.cones.capacity).toBe(32);
    expect(VFX_DATA.particles.capacity).toBe(2048);
    expect(Object.keys(VFX_DATA.particles.kinds)).toEqual([...VFX_PARTICLE_KINDS]);
    expect(VFX_DATA.splashes.count).toBe(1500);
    expect(VFX_DATA.arc.segments).toBe(8);
    expect(VFX_DATA.muzzleLight.durationS).toBe(0.05);
  });

  it('names the file and the path of a bad value', () => {
    const j = clone();
    (j['glow'] as Record<string, unknown>)['capacity'] = 0;
    expect(() => parseVfxData(j, 'test.json')).toThrow(/test\.json: glow\.capacity/);
  });

  it('rejects a wrong version, a missing section, a bad range and an unknown kind', () => {
    const a = clone();
    a['version'] = 2;
    expect(() => parseVfxData(a)).toThrow(/vfx\.json: version/);

    const b = clone();
    delete b['tape'];
    expect(() => parseVfxData(b)).toThrow(/vfx\.json: tape/);

    const c = clone();
    ((c['particles'] as { kinds: Record<string, { count: number[] }> }).kinds['spark'] as { count: number[] }).count = [5, 2];
    expect(() => parseVfxData(c)).toThrow(/particles\.kinds\.spark\.count must be ascending/);

    const d = clone();
    (d['particles'] as { kinds: Record<string, unknown> }).kinds['smoke'] = {};
    expect(() => parseVfxData(d)).toThrow(/particles\.kinds\.smoke/);

    const e = clone();
    delete (e['particles'] as { kinds: Record<string, unknown> }).kinds['dust'];
    expect(() => parseVfxData(e)).toThrow(/particles\.kinds\.dust/);

    const f = clone();
    (f['particles'] as Record<string, unknown>)['capacity'] = 2049;
    expect(() => parseVfxData(f)).toThrow(/particles\.capacity must be even/);

    expect(() => parseVfxData(null)).toThrow(/vfx\.json/);
  });
});
