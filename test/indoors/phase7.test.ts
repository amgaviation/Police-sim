import { afterEach, describe, expect, it } from 'vitest';
import type { Rng } from '../../src/core/rng';
import type { InteriorDoor, InteriorLayout } from '../../src/interior/types';
import type { BuildingInfo } from '../../src/world/buildings';
import { SEED, findBuilding, layoutOf, makeRig, type Rig } from './helpers';

/** Phase 7 hooks (design §11.2): the Halligan bar joins the ram, with its own odds. */

let rig: Rig | null = null;
afterEach(() => {
  rig?.dispose();
  rig = null;
});

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** An rng whose `chance` records the probability it was asked about and answers `answer`. */
function stubRng(answer: boolean): { rng: Rng; asked: number[] } {
  const asked: number[] = [];
  const rng: Rng = {
    seed: 1,
    next: () => 0.5,
    nextInt: () => 0,
    nextFloat: (a: number) => a,
    chance: (p: number) => {
      asked.push(p);
      return answer;
    },
    pick: <T>(arr: readonly T[]): T => arr[0] as T,
    shuffle: <T>(arr: T[]): T[] => arr,
    gaussian: () => 0,
    stream: () => rng,
    state: () => ({ seed: 1, s: [1, 2, 3, 4] }),
    restore: () => undefined,
  };
  return { rng, asked };
}

function standBy(r: Rig, b: BuildingInfo, layout: InteriorLayout, d: InteriorDoor): void {
  const room = d.a;
  const rect = (layout.rooms[room] as InteriorLayout['rooms'][number]).rect;
  const dist = 0.6;
  const p = d.axis === 'x'
    ? { x: d.x, z: d.z + ((rect.minZ + rect.maxZ) / 2 < d.z ? -dist : dist) }
    : { x: d.x + ((rect.minX + rect.maxX) / 2 < d.x ? -dist : dist), z: d.z };
  r.sys.placeOfficerInside(b.id, { x: p.x, z: p.z, yaw: 0 });
  r.officer.x = p.x;
  r.officer.z = p.z;
  r.steps(2);
  r.events.length = 0;
}

function attempt(r: Rig, b: BuildingInfo, d: InteriorDoor, action: 'kick' | 'ram'): void {
  r.sys.setDoorState(b.id, d.index, 'closed');
  r.sys.request({ kind: 'door', buildingId: b.id, door: d.index, action });
  r.sys.step(1.1, r.officer);
}

const flashes = (r: Rig): string[] => r.events.filter((e) => e.topic === 'interior:flash').map((e) => (e.payload as { text: string }).text);

async function setup(answer: boolean): Promise<{ r: Rig; b: BuildingInfo; layout: InteriorLayout; asked: number[]; doors: InteriorDoor[] }> {
  const { rng, asked } = stubRng(answer);
  const r = await makeRig(SEED, { rng });
  rig = r;
  const b = findBuilding('house');
  const layout = layoutOf(b);
  const main = layout.doors.find((x) => x.main) as InteriorDoor;
  const inner = layout.doors.find((x) => x.b >= 0 && x.kind === 'interior' && x.lockable) as InteriorDoor;
  return { r, b, layout, asked, doors: [main, inner] };
}

describe('breach tools', () => {
  it('a ram attempt without a ram or a Halligan flashes "No forced-entry tool" and rolls nothing', async () => {
    const { r, b, layout, asked, doors } = await setup(true);
    const d = doors[0] as InteriorDoor;
    standBy(r, b, layout, d);
    attempt(r, b, d, 'ram');
    expect(flashes(r)).toEqual(['No forced-entry tool']);
    expect(asked).toEqual([]);
    expect(r.sys.doorState(b.id, d.index)).toBe('closed');
    // The failed attempt does not start the breach cooldown: a kick right after still rolls.
    r.sys.request({ kind: 'door', buildingId: b.id, door: d.index, action: 'kick' });
    r.sys.step(1 / 60, r.officer);
    expect(asked).toHaveLength(1);
  });

  it.each([0, 1])('success odds with door %i: ram only, Halligan only, both, kick', async (which) => {
    const { r, b, layout, asked, doors } = await setup(false);
    const d = doors[which] as InteriorDoor;
    const s = d.strength;
    standBy(r, b, layout, d);

    r.carried.ram = 1;
    attempt(r, b, d, 'ram');
    r.carried.ram = 0;
    r.carried.halligan = 1;
    attempt(r, b, d, 'ram');
    r.carried.ram = 1;
    attempt(r, b, d, 'ram');
    r.carried.ram = 0;
    r.carried.halligan = 0;
    attempt(r, b, d, 'kick');

    expect(asked).toHaveLength(4);
    expect(asked[0]).toBeCloseTo(clamp(1.1 - 0.8 * s, 0, 0.95), 10);
    expect(asked[1]).toBeCloseTo(clamp(1.0 - 0.7 * s, 0, 0.9), 10);
    expect(asked[2]).toBeCloseTo(clamp(1.25 - 0.8 * s, 0, 0.98), 10);
    expect(asked[3]).toBeCloseTo(clamp(0.7 - 0.6 * s, 0, 0.7), 10);
  });

  it('the three odds are the documented numbers on a known door', async () => {
    const { r, b, layout, asked, doors } = await setup(false);
    const d = doors[1] as InteriorDoor;
    expect(d.strength).toBeCloseTo(0.3, 5);
    standBy(r, b, layout, d);
    r.carried.ram = 1;
    attempt(r, b, d, 'ram');
    r.carried.ram = 0;
    r.carried.halligan = 1;
    attempt(r, b, d, 'ram');
    r.carried.ram = 1;
    attempt(r, b, d, 'ram');
    expect(asked[0]).toBeCloseTo(0.86, 10);
    expect(asked[1]).toBeCloseTo(0.79, 10);
    expect(asked[2]).toBeCloseTo(0.98, 10); // 1.01 clamped
  });

  it('a Halligan alone is a forced-entry tool: a successful roll breaks the door', async () => {
    const { r, b, layout, doors } = await setup(true);
    const d = doors[1] as InteriorDoor;
    standBy(r, b, layout, d);
    r.carried.halligan = 1;
    attempt(r, b, d, 'ram');
    expect(r.sys.doorState(b.id, d.index)).toBe('broken');
    const ev = r.events.filter((e) => e.topic === 'interior:door').map((e) => e.payload as { action: string; success: boolean });
    expect(ev.find((e) => e.action === 'ram')).toMatchObject({ success: true });
    expect(flashes(r)).toEqual([]);
  });

  it('never rolls for an unbreachable door, even with both tools', async () => {
    const { rng, asked } = stubRng(true);
    const r = await makeRig(SEED, { rng });
    rig = r;
    const b = findBuilding('bank');
    const layout = layoutOf(b);
    const vault = layout.doors.find((x) => x.strength >= 0.95) as InteriorDoor;
    standBy(r, b, layout, vault);
    r.carried.ram = 1;
    r.carried.halligan = 1;
    attempt(r, b, vault, 'ram');
    expect(asked).toEqual([]);
    expect(r.sys.doorState(b.id, vault.index)).not.toBe('broken');
  });
});
