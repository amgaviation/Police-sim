import { describe, expect, it } from 'vitest';
import { WORLD_CONFIG, isWorldStateSave, type WorldRequest } from '../../src/worldstate';
import { DAY, T0, customWorld, rig, run } from './helpers';

const H = 3600;

const arrest = (personId: number, game: number): WorldRequest => ({
  kind: 'arrest', personId, district: 'downtown', callNumber: 'C-0001', x: 5, z: 6, game, offenseClass: 'misdemeanor',
  juvenile: false, priors: 0,
});

function evolveAt(r: ReturnType<typeof rig>, fromGame: number, toGame: number, arrestsByDistrict: Record<string, number> = {}) {
  return r.world.evolve({ fromGame, toGame, trust: { downtown: 0.45 }, arrestsByDistrict, addressAt: () => 'X' });
}

describe('evolve carries the fractional day', () => {
  it('five 16 h gaps evolve three whole days in total', () => {
    const r = rig();
    let t = T0;
    let total = 0;
    for (let i = 0; i < 5; i++) {
      // Each rollover's from is the end of the shift, 16 h before the next shift start.
      total += evolveAt(r, t, t + 16 * H).days;
      t += 16 * H;
    }
    expect(total).toBe(3);
  });

  it('a 5-on 2-off rotation evolves about every elapsed day', () => {
    const r = rig();
    let t = T0;
    let elapsed = 0;
    let total = 0;
    for (let i = 0; i < 60; i++) {
      const gap = i % 5 === 4 ? 64 * H : 16 * H;
      total += evolveAt(r, t, t + gap).days;
      t += gap;
      elapsed += gap;
    }
    expect(total).toBe(Math.floor(elapsed / DAY));
  });

  it('starts counting from the first rollover and survives a save round trip', () => {
    const r = rig();
    evolveAt(r, T0, T0 + 20 * H);
    const copy = rig(7, r.world.serialize());
    expect(evolveAt(copy, T0 + 20 * H, T0 + 30 * H).days).toBe(1);
    expect(evolveAt(r, T0 + 20 * H, T0 + 30 * H).days).toBe(1);
  });
});

describe('steady policing does not saturate crime', () => {
  it('one arrest per shift keeps downtown well under the cap over 300 shifts', () => {
    const r = rig();
    const base = WORLD_CONFIG.neighborhoods.baseCrime.downtown ?? 0;
    let t = T0;
    let peak = 0;
    for (let i = 0; i < 300; i++) {
      run(r, arrest(1000 + i, t));
      const gap = i % 5 === 4 ? 64 * H : 16 * H;
      evolveAt(r, t, t + gap, { downtown: 1 });
      t += gap;
      peak = Math.max(peak, r.world.neighborhood('downtown').crime);
    }
    expect(peak).toBeLessThan(WORLD_CONFIG.neighborhoods.max);
    expect(r.world.neighborhood('downtown').crime).toBeLessThan(base + WORLD_CONFIG.neighborhoods.offenderMax);
  });

  it('released offenders fade out of the at-large term', () => {
    const quiet = rig();
    const noisy = rig();
    run(noisy, arrest(1, T0));
    evolveAt(noisy, T0, T0 + 2 * DAY);
    evolveAt(quiet, T0, T0 + 2 * DAY);
    // Long after the release the world looks like the one without the offender.
    for (let i = 0; i < 12; i++) {
      evolveAt(noisy, T0 + (2 + i * 10) * DAY, T0 + (12 + i * 10) * DAY);
      evolveAt(quiet, T0 + (2 + i * 10) * DAY, T0 + (12 + i * 10) * DAY);
    }
    expect(Math.abs(noisy.world.neighborhood('downtown').crime - quiet.world.neighborhood('downtown').crime)).toBeLessThan(0.02);
  });
});

describe('a district table mod with a large crimeFactor', () => {
  it('keeps the base level in range so the world state is still a valid save', () => {
    const w = customWorld({ baseCrime: { downtown: 0.6 * 2, suburbs: 0.35 * 3 } });
    const save = w.serialize();
    expect(isWorldStateSave(save)).toBe(true);
    expect(save.neighborhoods['downtown']?.crime).toBeLessThanOrEqual(WORLD_CONFIG.neighborhoods.max);
    expect(save.neighborhoods['suburbs']?.crime).toBeCloseTo(1.05 > WORLD_CONFIG.neighborhoods.max ? WORLD_CONFIG.neighborhoods.max : 1.05);
    // The crime factor stays usable: crime / base within the factor range.
    expect(w.crimeFactor('downtown')).toBeLessThanOrEqual(WORLD_CONFIG.neighborhoods.factorRange[1]);
  });
});
