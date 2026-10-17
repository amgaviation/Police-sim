import { describe, expect, it } from 'vitest';
import { CALL_CATALOG, ITEM_IDS, NPC_COMMAND_IDS, PROFILE_IDS, SERVICE_KINDS, SPOTS, type Anchor, type Spot } from '../../src/calls';
import { createRng } from '../../src/core/rng';
import { BEHAVIORS, NPC_COMMANDS } from '../../src/npc';
import { ITEMS } from '../../src/people';
import { SCENE_CONFIG, parseSceneConfig } from '../../src/scene/data';
import { verifyContentIds, scriptFor } from '../../src/scene/director';
import { createSpotPosition, edgeLaterals, spotPosition } from '../../src/scene/spots';
import { compass, fill } from '../../src/scene/text';
import { createSceneCommands } from '../../src/scene/commands';
import { cityFor } from '../world/helpers';
import { at, makeRig } from './helpers';

describe('content cross-check', () => {
  it('items, behaviour profiles, services and npc commands hold every id of the fixed lists', () => {
    expect(() => verifyContentIds()).not.toThrow();
    const items = new Set(ITEMS.map((i) => i.id));
    for (const id of ITEM_IDS) expect(items.has(id), id).toBe(true);
    const profiles = new Set(BEHAVIORS.map((b) => b.id));
    for (const id of PROFILE_IDS) expect(profiles.has(id), id).toBe(true);
    const services = new Set(CALL_CATALOG.services.map((s) => s.id));
    for (const id of SERVICE_KINDS) expect(services.has(id), id).toBe(true);
    const commands: readonly string[] = NPC_COMMANDS;
    for (const id of NPC_COMMAND_IDS) expect(commands.includes(id), id).toBe(true);
  });

  it('every family action and service of the catalog can run in the scene (ids resolve)', () => {
    for (const f of CALL_CATALOG.families) {
      for (const a of f.actions) expect(CALL_CATALOG.actions.some((x) => x.id === a), `${f.id}.${a}`).toBe(true);
    }
    for (const a of CALL_CATALOG.actions) {
      if (a.service !== null) expect(CALL_CATALOG.services.some((s) => s.id === a.service)).toBe(true);
    }
  });
});

describe('spots', () => {
  const city = cityFor(42);
  const edges = city.graph.edges.filter((e) => e.sidewalk > 0 && e.length > 120).slice(0, 25);

  it('puts door, curb, yard and distance positions on the sidewalk band, inside the edge', () => {
    expect(edges.length).toBeGreaterThan(5);
    const out = createSpotPosition();
    for (const e of edges) {
      const anchor: Anchor = { x: 0, z: 0, edge: e.id, s: e.length / 2, side: 1 };
      for (const spot of ['door', 'curb', 'yard', 'distance', 'roadside', 'inside'] as Spot[]) {
        for (let n = 0; n < 3; n++) {
          spotPosition(city.graph.edges, anchor, spot, n, createRng(1), out);
          expect(out.lateral, `${spot} lateral`).toBeGreaterThanOrEqual(e.width / 2);
          expect(out.lateral).toBeLessThanOrEqual(e.width / 2 + e.sidewalk + 1.1);
          expect(out.s).toBeGreaterThanOrEqual(0);
          expect(out.s).toBeLessThanOrEqual(e.length);
          expect(out.hidden).toBe(spot === 'inside');
        }
      }
      spotPosition(city.graph.edges, anchor, 'street', 0, createRng(1), out);
      expect(out.lateral).toBeLessThan(e.width / 2);
    }
  });

  it('is deterministic, faces the road and respects the side', () => {
    const e = edges[0]!;
    const anchor: Anchor = { x: 0, z: 0, edge: e.id, s: e.length / 2, side: 1 };
    const a = createSpotPosition();
    const b = createSpotPosition();
    for (const spot of SPOTS) {
      spotPosition(city.graph.edges, anchor, spot, 1, createRng(5).stream('x'), a);
      spotPosition(city.graph.edges, anchor, spot, 1, createRng(5).stream('x'), b);
      expect(a).toEqual(b);
    }
    // Opposite sides are on opposite sides of the centreline.
    const left = createSpotPosition();
    const right = createSpotPosition();
    spotPosition(city.graph.edges, { ...anchor, side: 1 }, 'door', 0, createRng(1), left);
    spotPosition(city.graph.edges, { ...anchor, side: -1 }, 'door', 0, createRng(1), right);
    expect(Math.hypot(left.x - right.x, left.z - right.z)).toBeGreaterThan(e.width);
    // The person faces the road: the point one metre ahead is closer to the centreline.
    const lat = edgeLaterals(e);
    expect(lat.D).toBeGreaterThan(lat.C);
    const gx = -Math.sin(left.yaw);
    const gz = -Math.cos(left.yaw);
    const proj = city.graph.projectOnEdge(e.id, left.x + gx, left.z + gz, { edge: 0, s: 0, t: 0, x: 0, z: 0, distance: 0, side: 1 });
    const here = city.graph.projectOnEdge(e.id, left.x, left.z, { edge: 0, s: 0, t: 0, x: 0, z: 0, distance: 0, side: 1 });
    expect(proj.distance).toBeLessThan(here.distance);
  });

  it('crowd and hidden spots vary with the stream but stay near the anchor', () => {
    const e = edges[1]!;
    const anchor: Anchor = { x: 0, z: 0, edge: e.id, s: e.length / 2, side: -1 };
    const out = createSpotPosition();
    const seen = new Set<string>();
    const rng = createRng(9);
    for (let n = 0; n < 20; n++) {
      spotPosition(city.graph.edges, anchor, 'crowd', n % 4, rng, out, true);
      seen.add(out.x.toFixed(2));
      expect(Math.abs(out.s - anchor.s)).toBeLessThanOrEqual(12 + 1.2 * 4);
      spotPosition(city.graph.edges, anchor, 'hidden', 0, rng, out);
      expect(Math.abs(out.s - anchor.s)).toBeGreaterThanOrEqual(19);
      expect(out.hidden).toBe(true);
    }
    expect(seen.size).toBeGreaterThan(10);
  });
});

describe('scene data and helpers', () => {
  it('validates the tuning file and names the field of an error', () => {
    expect(SCENE_CONFIG.distances.materializeM).toBeGreaterThan(SCENE_CONFIG.distances.arriveM);
    const bad = JSON.parse(JSON.stringify({ version: 1, ...SCENE_CONFIG })) as Record<string, Record<string, unknown>>;
    (bad.ambientFlee as Record<string, unknown>).base = 2;
    expect(() => parseSceneConfig(bad)).toThrow(/scene\.json: ambientFlee\.base/);
    const bad2 = JSON.parse(JSON.stringify({ version: 1, ...SCENE_CONFIG })) as Record<string, Record<string, unknown>>;
    (bad2.distances as Record<string, unknown>).arriveM = 1000;
    expect(() => parseSceneConfig(bad2)).toThrow(/arriveM/);
    expect(() => parseSceneConfig({ version: 2 })).toThrow(/version/);
  });

  it('fills placeholders and names compass directions', () => {
    expect(fill('{unit}, to {near} {zzz}', { unit: '12', near: 'Oak St' })).toBe('12, to Oak St {zzz}');
    expect(compass(0)).toBe('northbound');
    expect(compass(Math.PI)).toBe('southbound');
    expect(compass(-Math.PI / 2)).toBe('eastbound');
    expect(compass(Math.PI / 2)).toBe('westbound');
  });

  it('scripts the variant draws so pickVariants returns the forced kinds', () => {
    const [a, b, c] = scriptFor(['false', 'duplicate'], { escalation: 1, deescalation: 1, false: 1, duplicate: 1, swatting: 1, ambush: 1 });
    expect(a).toBeLessThan(CALL_CATALOG.variants.rates.false);
    expect(b).toBe(0);
    expect(c).toBeGreaterThan(0.99);
  });

  it('console commands: scene info / spawn / flags / outcomes and weapon', async () => {
    const r = await makeRig();
    const cmds = createSceneCommands({ scene: () => r.scene, now: () => at(r.sim), playerPosition: () => ({ x: r.player.x, z: r.player.z }) });
    const scene = cmds.find((c) => c.name === 'scene')!;
    const weapon = cmds.find((c) => c.name === 'weapon')!;
    const ctx = {} as never;
    const text0 = async (c: { run(a: string[], x: never): unknown }, a: string[]): Promise<string> => {
      const v = await c.run(a, ctx);
      return typeof v === 'string' ? v : '';
    };
    expect(await text0(scene, ['info'])).toContain('scenarios 0');
    const text = (await text0(scene, ['spawn', 'domesticDisturbance', 'here', 'duplicate']));
    expect(text).toMatch(/^Call \d+ \(domesticDisturbance\) at the player: branch \w+, variants /);
    const id = Number(/Call (\d+)/.exec(text)![1]);
    expect((await text0(scene, ['flags', String(id)]))).toContain('role:');
    expect((await text0(scene, ['flags', '999']))).toContain('No scenario');
    expect((await text0(scene, ['outcomes']))).toBe('No outcomes yet');
    expect((await text0(scene, ['spawn', 'nope']))).toContain('Usage');
    expect((await text0(scene, ['spawn', 'loudParty', 'dance']))).toContain('Unknown variant');
    expect((await text0(weapon, []))).toContain('requested');
    expect(() => createSceneCommands({ scene: () => null, now: () => null, playerPosition: () => null })[0]!.run(['info'], ctx)).toThrow(/not available/);
  });
});
