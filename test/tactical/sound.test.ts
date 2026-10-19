import { describe, expect, it } from 'vitest';
import { generateInterior } from '../../src/interior/generate';
import type { InteriorLayout } from '../../src/interior/types';
import { TACTICS } from '../../src/tactical/data';
import {
  SOUND_KINDS,
  buildSoundGraph,
  doorAttenuation,
  footstepLevel,
  hearingThreshold,
  receivedLevel,
  sourceLevel,
  stimulus,
  type SoundGraph,
} from '../../src/tactical/sound';
import type { DoorStateName } from '../../src/tactical/types';
import { handBuilding } from '../interior/helpers';
import { threeRooms, twoRooms } from './helpers';

const cfg = TACTICS;
const all = (s: DoorStateName) => (): DoorStateName => s;
const att = (g: SoundGraph, a: number, b: number): number => g.att[a * g.n + b] as number;

function houseLayout(): InteriorLayout {
  const l = generateInterior(42, handBuilding('house', 14, 12, 0, 900_100));
  if (l === null) throw new Error('no house');
  return l;
}
function apartmentLayout(): InteriorLayout {
  const l = generateInterior(42, handBuilding('apartment', 30, 22, 0, 900_101));
  if (l === null) throw new Error('no apartment');
  return l;
}

describe('data', () => {
  it('has a source level for every sound kind', () => {
    for (const k of SOUND_KINDS) expect(sourceLevel(k, cfg)).toBeGreaterThan(0);
    expect(sourceLevel('kick', cfg)).toBe(95);
  });
});

describe('doorAttenuation', () => {
  it('open, broken and wide cost 2 dB; closed and locked 18; closed cells 6', () => {
    expect(doorAttenuation('open', 'interior', cfg)).toBe(2);
    expect(doorAttenuation('broken', 'interior', cfg)).toBe(2);
    expect(doorAttenuation('closed', 'wide', cfg)).toBe(2);
    expect(doorAttenuation('closed', 'interior', cfg)).toBe(18);
    expect(doorAttenuation('locked', 'exterior', cfg)).toBe(18);
    expect(doorAttenuation('closed', 'cell', cfg)).toBe(6);
    expect(doorAttenuation('locked', 'cell', cfg)).toBe(6);
    expect(doorAttenuation('open', 'cell', cfg)).toBe(2);
  });
});

describe('inverse-square spreading', () => {
  it('loses 6 dB per doubling of distance inside one room and nothing within 1 m', () => {
    const g = buildSoundGraph(twoRooms(), all('closed'), cfg, 0);
    const at = (d: number): number => receivedLevel(70, 0, 1, 1, 0, 1 + d, 1, g);
    expect(at(1) - at(2)).toBeCloseTo(6.0206, 3);
    expect(at(2) - at(4)).toBeCloseTo(6.0206, 3);
    expect(at(0.5)).toBeCloseTo(70, 6);
    expect(at(0)).toBeCloseTo(70, 6);
    expect(at(10)).toBeCloseTo(50, 6);
  });

  it('is monotonic in distance (same room and through a door)', () => {
    const g = buildSoundGraph(twoRooms(), all('open'), cfg, 0);
    let prevSame = Infinity;
    let prevNext = Infinity;
    for (let d = 0.5; d <= 4.5; d += 0.5) {
      const same = receivedLevel(80, 0, 0.2, 2.5, 0, 0.2 + d, 2.5, g);
      const next = receivedLevel(80, 0, 0.2, 2.5, 1, 5 + d, 2.5, g);
      expect(same).toBeLessThanOrEqual(prevSame);
      expect(next).toBeLessThanOrEqual(prevNext);
      prevSame = same;
      prevNext = next;
    }
  });

  it('outdoors (no graph) is pure distance', () => {
    expect(receivedLevel(60, -1, 0, 0, -1, 10, 0, null)).toBeCloseTo(40, 6);
  });
});

describe('doors and walls', () => {
  it('a closed door costs 16 dB more than an open one between adjacent rooms', () => {
    const closed = buildSoundGraph(twoRooms(), all('closed'), cfg, 0);
    const open = buildSoundGraph(twoRooms(), all('open'), cfg, 0);
    expect(att(open, 0, 1)).toBe(2);
    expect(att(closed, 0, 1)).toBe(18);
    const a = receivedLevel(70, 0, 4, 2.5, 1, 6, 2.5, closed);
    const b = receivedLevel(70, 0, 4, 2.5, 1, 6, 2.5, open);
    expect(b - a).toBeCloseTo(16, 6);
  });

  it('holds for every door of generated houses and apartments (all closed vs all open)', () => {
    for (const layout of [houseLayout(), apartmentLayout()]) {
      const closed = buildSoundGraph(layout, all('closed'), cfg, 0);
      const open = buildSoundGraph(layout, all('open'), cfg, 0);
      let checked = 0;
      for (const d of layout.doors) {
        if (d.b < 0 || d.kind === 'wide') continue;
        expect(att(open, d.a, d.b)).toBe(2);
        expect(att(closed, d.a, d.b) - att(open, d.a, d.b)).toBe(16);
        checked++;
      }
      expect(checked).toBeGreaterThan(2);
    }
  });

  it('a chain of rooms through open doors beats a direct wall', () => {
    const open = buildSoundGraph(threeRooms(), all('open'), cfg, 0);
    // A and C share a wall (35 dB) but A-B-C through two open doors costs 4.
    expect(att(open, 0, 2)).toBe(4);
    const closed = buildSoundGraph(threeRooms(), all('closed'), cfg, 0);
    // Two closed doors (36) lose to the bare wall (35).
    expect(att(closed, 0, 2)).toBe(35);
    // One door closed, one open: 18 + 2.
    const mixed = buildSoundGraph(threeRooms(), (d) => (d === 0 ? 'closed' : 'open'), cfg, 0);
    expect(att(mixed, 0, 2)).toBe(20);
  });

  it('rooms without a door are still coupled through the wall', () => {
    const g = buildSoundGraph(threeRooms(), all('locked'), cfg, 0);
    expect(att(g, 0, 1)).toBe(18);
    expect(att(g, 0, 2)).toBe(35);
  });

  it('is symmetric, zero on the diagonal and finite everywhere in generated layouts', () => {
    for (const layout of [twoRooms(), threeRooms(), houseLayout(), apartmentLayout()]) {
      const g = buildSoundGraph(layout, (d) => (d % 2 === 0 ? 'open' : 'closed'), cfg, 0);
      expect(g.n).toBe(layout.rooms.length + 1);
      for (let a = 0; a < g.n; a++) {
        expect(att(g, a, a)).toBe(0);
        for (let b = 0; b < g.n; b++) {
          expect(att(g, a, b)).toBe(att(g, b, a));
          expect(Number.isFinite(att(g, a, b))).toBe(true);
        }
      }
    }
  });

  it('satisfies the triangle inequality', () => {
    const layout = houseLayout();
    const g = buildSoundGraph(layout, (d) => (d % 3 === 0 ? 'open' : 'closed'), cfg, 0);
    for (let a = 0; a < g.n; a++) for (let b = 0; b < g.n; b++) for (let c = 0; c < g.n; c++) expect(att(g, a, c)).toBeLessThanOrEqual(att(g, a, b) + att(g, b, c) + 1e-4);
  });
});

describe('outside node', () => {
  it('reaches a room through its exterior door when that beats the exterior wall', () => {
    const layout = twoRooms();
    const outside = layout.rooms.length;
    const closed = buildSoundGraph(layout, all('closed'), cfg, 0);
    const open = buildSoundGraph(layout, all('open'), cfg, 0);
    // Room A has the exterior door: closed 18 < exterior wall 40; open 2.
    expect(att(closed, 0, outside)).toBe(18);
    expect(att(open, 0, outside)).toBe(2);
    // Room B has only exterior walls: through the wall 40, or via A's door and the interior door (18 + 18 = 36 closed, 4 open).
    expect(att(closed, 1, outside)).toBe(36);
    expect(att(open, 1, outside)).toBe(4);
  });

  it('falls back to the exterior wall when there is no usable door', () => {
    const layout = threeRooms(); // no exterior door
    const g = buildSoundGraph(layout, all('open'), cfg, 0);
    for (let r = 0; r < 3; r++) expect(att(g, r, 3)).toBe(40);
  });

  it('an outdoor source reaches an indoor listener through the door, quieter through the walls', () => {
    const layout = twoRooms();
    const outside = layout.rooms.length;
    const closed = buildSoundGraph(layout, all('closed'), cfg, 0);
    const doorLevel = receivedLevel(80, -1, 2.5, -4, 0, 2.5, 2, closed);
    const wallLevel = receivedLevel(80, -1, 2.5, -4, 1, 7.5, 2, closed);
    expect(doorLevel).toBeGreaterThan(wallLevel);
    // The outside node index and -1 mean the same.
    expect(receivedLevel(80, outside, 2.5, -4, 0, 2.5, 2, closed)).toBe(doorLevel);
    // An indoor source heard outdoors is symmetric in attenuation.
    expect(receivedLevel(80, 0, 2.5, 2, -1, 2.5, -4, closed)).toBeCloseTo(doorLevel, 4);
  });
});

describe('hearing', () => {
  it('thresholds: 20 normal, 40 hard of hearing, deaf never, asleep +20', () => {
    expect(hearingThreshold('normal', false, cfg)).toBe(20);
    expect(hearingThreshold('hardOfHearing', false, cfg)).toBe(40);
    expect(hearingThreshold('normal', true, cfg)).toBe(40);
    expect(hearingThreshold('hardOfHearing', true, cfg)).toBe(60);
    expect(hearingThreshold('deaf', false, cfg)).toBe(Infinity);
    expect(hearingThreshold('deaf', true, cfg)).toBe(Infinity);
  });

  it('stimulus is 0 below the threshold and rises to 1 over the range', () => {
    expect(stimulus(19, 20, cfg)).toBe(0);
    expect(stimulus(20, 20, cfg)).toBe(0);
    expect(stimulus(35, 20, cfg)).toBeCloseTo(0.5, 9);
    expect(stimulus(50, 20, cfg)).toBe(1);
    expect(stimulus(500, 20, cfg)).toBe(1);
    expect(stimulus(-Infinity, 20, cfg)).toBe(0);
  });

  it('a deaf listener is never stimulated, however loud', () => {
    expect(stimulus(200, hearingThreshold('deaf', false, cfg), cfg)).toBe(0);
  });

  it('a sleeper needs 20 dB more', () => {
    const awake = stimulus(45, hearingThreshold('normal', false, cfg), cfg);
    const asleep = stimulus(45, hearingThreshold('normal', true, cfg), cfg);
    expect(awake).toBeGreaterThan(0);
    expect(asleep).toBeCloseTo((45 - 40) / 30, 9);
    expect(stimulus(35, hearingThreshold('normal', true, cfg), cfg)).toBe(0);
  });
});

describe('footstepLevel', () => {
  it('depends on the surface, speed and stance', () => {
    expect(footstepLevel('carpet', 3, false, cfg)).toBe(28);
    expect(footstepLevel('tile', 3, false, cfg)).toBe(42);
    expect(footstepLevel('carpet', 3, false, cfg)).toBeLessThan(footstepLevel('tile', 3, false, cfg));
    expect(footstepLevel('gravel', 3, false, cfg)).toBeGreaterThan(footstepLevel('grass', 3, false, cfg));
    expect(footstepLevel('tile', 3, true, cfg)).toBe(footstepLevel('tile', 3, false, cfg) - 10);
    expect(footstepLevel('tile', 6, false, cfg)).toBe(50);
    expect(footstepLevel('tile', 1, false, cfg)).toBe(36);
    expect(footstepLevel('tile', 1, true, cfg)).toBe(26);
  });

  it('standing still makes no sound', () => {
    expect(footstepLevel('tile', 0, false, cfg)).toBe(-Infinity);
    expect(footstepLevel('tile', 0.29, true, cfg)).toBe(-Infinity);
    expect(footstepLevel('tile', 0.3, false, cfg)).toBeGreaterThan(0);
  });

  it('falls back to concrete for an unknown surface', () => {
    expect(footstepLevel('lava', 3, false, cfg)).toBe(footstepLevel('concrete', 3, false, cfg));
  });
});

describe('graph reuse', () => {
  it('returns the same object, untouched, while the revision matches', () => {
    const layout = twoRooms();
    const g1 = buildSoundGraph(layout, all('closed'), cfg, 5);
    const snapshot = Array.from(g1.att);
    // A different state function would change the result if it were recomputed.
    const g2 = buildSoundGraph(layout, all('open'), cfg, 5, g1);
    expect(g2).toBe(g1);
    expect(Array.from(g2.att)).toEqual(snapshot);
    expect(g2.revision).toBe(5);
  });

  it('rewrites the same buffers in place when the revision changes', () => {
    const layout = twoRooms();
    const g1 = buildSoundGraph(layout, all('closed'), cfg, 5);
    const buffer = g1.att;
    const g3 = buildSoundGraph(layout, all('open'), cfg, 6, g1);
    expect(g3.att).toBe(buffer);
    expect(g3.revision).toBe(6);
    expect(att(g3, 0, 1)).toBe(2);
  });

  it('allocates a new graph only when the old one is too small', () => {
    const small = buildSoundGraph(twoRooms(), all('closed'), cfg, 1);
    const big = buildSoundGraph(houseLayout(), all('closed'), cfg, 1, small);
    expect(big).not.toBe(small);
    expect(big.att.length).toBeGreaterThanOrEqual(big.n * big.n);
    // A graph for a smaller layout reuses a bigger buffer.
    const again = buildSoundGraph(twoRooms(), all('open'), cfg, 2, big);
    expect(again).toBe(big);
    expect(again.n).toBe(3);
    expect(att(again, 0, 1)).toBe(2);
  });
});
