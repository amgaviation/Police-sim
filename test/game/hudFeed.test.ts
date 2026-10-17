import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Transform } from '../../src/ecs/components';
import { HudFeed } from '../../src/game/hudFeed';
import { initRapier } from '../../src/physics/physics';
import type { City } from '../../src/world/city';
import { generateCity } from '../../src/world/generate';
import { JUNCTION, ROAD_CLASS, type RoadEdge } from '../../src/world/roadGraph';
import { Harness } from './harness';

const SEED = 42;
const HIGHWAY_Z = 256;
let city: City;

beforeAll(async () => {
  await initRapier();
  city = generateCity(SEED);
});

describe('HudFeed', () => {
  const live: Harness[] = [];
  afterEach(() => {
    for (const h of live.splice(0)) h.dispose();
  });

  it('keeps the highway name and limit through a junction while in the outer lane', () => {
    const g = city.graph;
    // A signalised highway crossing with a lower-class street, away from the map edge.
    const node = g.nodes.find(
      (n) =>
        n.junction === JUNCTION.signal &&
        n.z === HIGHWAY_Z &&
        Math.abs(n.x) < 3000 &&
        n.edges.some((id) => (g.edges[id] as RoadEdge).roadClass > ROAD_CLASS.collector),
    );
    if (!node) throw new Error('no highway crossing');
    const highway = g.edges[node.edges.find((id) => (g.edges[id] as RoadEdge).roadClass === ROAD_CLASS.highway) ?? 0] as RoadEdge;
    const lane = highway.median / 2 + 1.5 * highway.laneWidth; // eastbound outer lane centre

    const h = new Harness(city);
    live.push(h);
    const session = h.start(SEED);
    const feed = new HudFeed();
    const names = new Set<string>();
    const limits = new Set<number>();
    for (let dx = -40; dx <= 40; dx += 0.5) {
      Transform.x[session.player] = node.x + dx;
      Transform.z[session.player] = HIGHWAY_Z + lane;
      const s = feed.fill(session, 'chase', null);
      names.add(s.roadName.split(' · ')[0] ?? '');
      limits.add(s.speedLimitMph);
    }
    expect([...names]).toEqual([highway.name]);
    expect([...limits]).toEqual([g.effectiveSpeedLimitMph(highway.id, session.env.time)]);

    // Turning onto the cross street switches once clear of the highway.
    const cross = g.edges[node.edges.find((id) => (g.edges[id] as RoadEdge).roadClass > ROAD_CLASS.collector) ?? 0] as RoadEdge;
    const other = g.nodes[cross.from === node.id ? cross.to : cross.from];
    if (!other) throw new Error('no cross street end');
    Transform.x[session.player] = (node.x + other.x) / 2;
    Transform.z[session.player] = (node.z + other.z) / 2;
    expect(feed.fill(session, 'chase', null).roadName.startsWith(cross.name)).toBe(true);
  });
});
