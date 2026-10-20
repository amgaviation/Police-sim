import { describe, expect, it } from 'vitest';
import type { CadUnit } from '../../src/cad/types';
import { basePoint } from '../../src/resources/bases';
import type { City } from '../../src/world/city';
import type { PointRoute } from '../../src/world/roadGraph';
import { UNIT_TYPES, estimateResponse, expandResourceSlots, unitType } from '../../src/units';
import { cityFor } from '../world/helpers';
import { PLAYER, at, eventsOf, location, makeCall, makeHarness, pointFromStation, run, runUntil, step, view, withCount, type Harness } from './helpers';

interface Dispatched {
  callsign: string;
  typeId: string;
  callId: number;
  etaS: number;
}

/** A city whose router answers from a table keyed by the origin x (everything else delegates to the real graph). */
function stubCity(route: (ax: number) => { time: number; length: number } | null): City {
  const real = cityFor(42);
  const graph = Object.create(real.graph, {
    routeBetweenPoints: { value: (ax: number) => route(ax) as unknown as PointRoute | null },
  }) as City['graph'];
  return Object.create(real, { graph: { value: graph } }) as City;
}

function k9Type() {
  const t = unitType('k9');
  if (!t) throw new Error('no k9');
  return t;
}

function radioTexts(h: Harness): string[] {
  return h.radio.map((r) => r.text);
}

describe('response-time selection', () => {
  it('picks a farther unit with a faster route over a nearer one with a slow route', () => {
    const real = cityFor(42);
    const call = { x: real.spawn.x + 1000, z: real.spawn.z };
    const nearX = call.x + 300;
    const farX = call.x + 1500;
    const city = stubCity((ax) => (ax === nearX ? { time: 400, length: 500 } : { time: 50, length: 900 }));
    const types = withCount('k9', 2);
    const h = makeHarness({ city, types });
    const slots = expandResourceSlots(types).filter((s) => s.typeId === 'k9');
    expect(slots.map((s) => s.callsign)).toEqual(['K9-1', 'K9-2']);
    // Both K9 units are heading home (returning): K9-1 close to the call, K9-2 far from it.
    const save = h.res.serialize();
    for (const [i, slot] of slots.entries()) {
      const u = save.units.find((e) => e.callsign === slot.callsign);
      if (!u) throw new Error('missing unit');
      u.status = 'returning';
      h.traffic.spawnFleetCar(slot.fleetIndex, i === 0 ? nearX : farX, call.z);
    }
    h.res.restore(save, at(0));
    const c = makeCall(h, 2, call.x, call.z);
    h.res.request({ kind: 'request', typeId: 'k9', callId: c.id, via: 'radio' });
    step(h);
    const d = eventsOf<Dispatched>(h, 'resource:dispatched');
    expect(d).toHaveLength(1);
    expect(d[0]?.callsign).toBe('K9-2');
    // Returning units have no turnout; the estimate is the table value for the fast route.
    const expected = estimateResponse({
      routeTimeS: 50, routeLengthM: 900, priority: 2, urgency: 'emergency', trafficDensity: 1, wetness: 0, turnoutS: [0, 0], speedFactor: k9Type().speedFactor,
    });
    expect(d[0]?.etaS).toBeCloseTo(expected.etaS, 6);
    // And the slow route would have lost even though it is nearer in a straight line.
    const slow = estimateResponse({
      routeTimeS: 400, routeLengthM: 500, priority: 2, urgency: 'emergency', trafficDensity: 1, wetness: 0, turnoutS: [0, 0], speedFactor: k9Type().speedFactor,
    });
    expect(slow.etaS).toBeGreaterThan(expected.etaS);
    expect(Math.hypot(nearX - call.x, 0)).toBeLessThan(Math.hypot(farX - call.x, 0));
    expect(h.cad.unit('K9-2')?.callId).toBe(c.id);
    expect(h.cad.unit('K9-1')?.callId).toBeNull();
    // The returning car turns around at once: no turnout, no respawn.
    expect(h.traffic.cars.get(slots[1]?.fleetIndex ?? -1)?.dx).toBeCloseTo(call.x, 3);
  });

  it('skips unreachable units and reports when none can respond', () => {
    const city = stubCity(() => null);
    const h = makeHarness({ city });
    const c = makeCall(h, 3, h.city.spawn.x + 500, h.city.spawn.z);
    h.res.request({ kind: 'request', typeId: 'k9', callId: c.id, via: 'radio' });
    step(h);
    expect(eventsOf(h, 'resource:dispatched')).toHaveLength(0);
    expect(radioTexts(h)).toContain('No K9 unit available.');
    expect(h.flashes).toContain('No K9 unit available');
  });

  it('the radio ETA text matches estimateResponse over the real route from the base', () => {
    const h = makeHarness({ density: 1.5, wetness: 0.4 });
    const to = pointFromStation(h, 1800);
    const c = makeCall(h, 3, to.x, to.z);
    h.res.request({ kind: 'request', typeId: 'k9', callId: c.id, via: 'radio' });
    step(h);
    const base = basePoint(h.city, 'station', to.x, to.z, { x: 0, z: 0 });
    const route = h.city.graph.routeBetweenPoints(base.x, base.z, to.x, to.z);
    expect(route).not.toBeNull();
    if (!route) return;
    const type = k9Type();
    const expected = estimateResponse({
      routeTimeS: route.time, routeLengthM: route.length, priority: 3, urgency: 'respond', trafficDensity: 1.5, wetness: 0.4,
      turnoutS: type.turnoutS, speedFactor: type.speedFactor,
    });
    const d = eventsOf<Dispatched>(h, 'resource:dispatched')[0];
    expect(d?.callsign).toBe('K9-1');
    expect(d?.etaS).toBeCloseTo(expected.etaS, 6);
    const minutes = Math.ceil(expected.etaS / 60);
    const ack = h.radio.find((r) => r.text.startsWith('Copy'));
    expect(ack).toBeDefined();
    expect(ack?.speaker).toBe('Dispatch');
    expect(ack?.channel).toBe('dispatch');
    expect(ack?.text).toBe(`Copy ${PLAYER}, K9-1 en route to Main Street at 1st Street, ETA ${minutes === 1 ? '1 minute' : `${minutes} minutes`}.`);
    expect(expected.etaS).toBeGreaterThan(type.turnoutS[0]);
  });

  it('a priority 1 call gets a shorter turnout than a priority 4 call', () => {
    const turnout = (priority: 1 | 2 | 3 | 4): number => {
      const h = makeHarness();
      const c = makeCall(h, priority, h.city.spawn.x + 900, h.city.spawn.z);
      h.res.request({ kind: 'request', typeId: 'k9', callId: c.id, via: 'radio' });
      step(h);
      const u = h.res.serialize().units.find((e) => e.callsign === 'K9-1');
      return (u?.turnoutUntil ?? 0) - 0;
    };
    const t = unitType('k9')?.turnoutS ?? [0, 0];
    expect(turnout(1)).toBeCloseTo(t[0], 6);
    expect(turnout(2)).toBeCloseTo(t[0] + (t[1] - t[0]) / 3, 6);
    expect(turnout(4)).toBeCloseTo(t[1], 6);
    expect(turnout(1)).toBeLessThan(turnout(4));
  });
});

describe('request handling', () => {
  it('ignores patrol types, flashes for unknown types and non-requestable types from the UI', () => {
    const h = makeHarness();
    const c = makeCall(h, 3, h.city.spawn.x + 500, h.city.spawn.z);
    for (const typeId of ['routine', 'priority', 'officerNeedsAssistance']) h.res.request({ kind: 'request', typeId, callId: c.id, via: 'radio' });
    step(h);
    expect(eventsOf(h, 'resource:dispatched')).toHaveLength(0);
    expect(h.flashes).toEqual([]);
    h.res.request({ kind: 'request', typeId: 'bogus', callId: c.id, via: 'mdt' });
    h.res.request({ kind: 'request', typeId: 'lieutenant', callId: c.id, via: 'radio' });
    step(h);
    expect(h.flashes).toEqual(['Unknown resource', 'Unknown resource']);
    // Chain-of-command types are fine for the system itself.
    h.res.request({ kind: 'request', typeId: 'lieutenant', callId: c.id, via: 'auto' });
    step(h);
    expect(eventsOf<Dispatched>(h, 'resource:dispatched').map((e) => e.callsign)).toEqual(['LT-1']);
  });

  it('opens an officer-assist call when the player has none', () => {
    const h = makeHarness();
    expect(h.cad.unit(PLAYER)?.callId).toBeNull();
    h.res.request({ kind: 'request', typeId: 'k9', callId: 0, via: 'radio' });
    step(h);
    const d = eventsOf<Dispatched>(h, 'resource:dispatched');
    expect(d).toHaveLength(1);
    const call = h.cad.call(d[0]?.callId ?? 0);
    expect(call?.typeId).toBe('officerAssist');
    expect(call?.priority).toBe(3);
    expect(call?.selfInitiated).toBe(true);
    expect(call?.narrative.some((n) => n.text.includes('K9 unit'))).toBe(true);
  });

  it('automatic requests never open a call and ignore closed calls', () => {
    const h = makeHarness();
    h.res.requestType('supervisor', 0, 'auto');
    step(h);
    expect(eventsOf(h, 'resource:dispatched')).toHaveLength(0);
    const c = makeCall(h, 3, h.city.spawn.x + 400, h.city.spawn.z);
    h.cad.closeCall(c.id, 'handled', at(0));
    h.res.requestType('supervisor', c.id, 'auto');
    step(h);
    expect(eventsOf(h, 'resource:dispatched')).toHaveLength(0);
  });

  it('does not send a second unit of the same type to the same call, and says so', () => {
    const h = makeHarness();
    const c = makeCall(h, 3, h.city.spawn.x + 900, h.city.spawn.z);
    h.res.request({ kind: 'request', typeId: 'k9', callId: c.id, via: 'radio' });
    step(h);
    h.res.request({ kind: 'request', typeId: 'k9', callId: c.id, via: 'radio' });
    step(h);
    expect(eventsOf(h, 'resource:dispatched')).toHaveLength(1);
    expect(radioTexts(h).some((t) => /^K9-1 is already assigned, ETA \d+:\d\d\.$/.test(t))).toBe(true);
    // Automatic duplicates are silent.
    const before = h.radio.length;
    h.res.requestType('k9', c.id, 'auto');
    step(h);
    expect(h.radio.length).toBe(before);
  });

  it('sends a unit of a multi-unit type again on an MDT request (command needs)', () => {
    const h = makeHarness();
    const c = makeCall(h, 1, h.city.spawn.x + 900, h.city.spawn.z);
    h.res.request({ kind: 'request', typeId: 'ems', callId: c.id, via: 'mdt' });
    step(h);
    h.res.request({ kind: 'request', typeId: 'ems', callId: c.id, via: 'mdt' });
    step(h);
    expect(eventsOf<Dispatched>(h, 'resource:dispatched').map((e) => e.callsign)).toEqual(['MEDIC-1', 'MEDIC-2']);
  });

  it('reports "No ... available" when every unit of the type is busy', () => {
    const h = makeHarness();
    const a = makeCall(h, 3, h.city.spawn.x + 900, h.city.spawn.z);
    const b = makeCall(h, 3, h.city.spawn.x - 900, h.city.spawn.z);
    h.res.request({ kind: 'request', typeId: 'k9', callId: a.id, via: 'radio' });
    h.res.request({ kind: 'request', typeId: 'k9', callId: b.id, via: 'radio' });
    step(h);
    expect(eventsOf(h, 'resource:dispatched')).toHaveLength(1);
    expect(radioTexts(h)).toContain('No K9 unit available.');
  });
});

describe('scene routing', () => {
  it('asks the scene first, then dispatches when the scene calls provide', () => {
    const h = makeHarness({ scenario: true });
    const c = makeCall(h, 3, h.city.spawn.x + 900, h.city.spawn.z);
    h.res.request({ kind: 'request', typeId: 'k9', callId: c.id, via: 'radio' });
    step(h);
    expect(h.sceneRequests).toEqual([{ kind: 'serviceRequest', callId: c.id, service: 'k9' }]);
    expect(eventsOf(h, 'resource:dispatched')).toHaveLength(0);
    // The scene's requestService calls the provider.
    expect(h.res.provide(c.id, 'k9')).toBe(true);
    step(h);
    expect(eventsOf<Dispatched>(h, 'resource:dispatched').map((e) => e.callsign)).toEqual(['K9-1']);
    // A service nothing covers is refused (the scene keeps its own timers).
    expect(h.res.provide(c.id, 'interpreter')).toBe(false);
    expect(h.res.provide(c.id, 'hazmat')).toBe(true);
    expect(h.res.provide(c.id, 'airUnit')).toBe(true);
  });

  it('a second service of the same unit (hazmat after fire) is satisfied by its arrival', () => {
    const h = makeHarness({ scenario: true });
    const to = pointFromStation(h, 700);
    const c = makeCall(h, 2, to.x, to.z);
    h.requested.add(`${c.id}:fire`);
    h.res.request({ kind: 'request', typeId: 'fire', callId: c.id, via: 'radio' });
    step(h);
    expect(eventsOf<Dispatched>(h, 'resource:dispatched').map((e) => e.callsign)).toEqual(['ENGINE-1']);
    h.requested.add(`${c.id}:hazmat`);
    expect(h.res.provide(c.id, 'hazmat')).toBe(true);
    step(h);
    // Still one engine: the scene request for hazmat is deduped, not a second dispatch.
    expect(eventsOf(h, 'resource:dispatched')).toHaveLength(1);
    expect(runUntil(h, () => view(h, 'ENGINE-1').status === 'onScene', 600)).toBe(true);
    const services = h.sceneRequests.filter((r) => r.kind === 'serviceArrived').map((r) => (r.kind === 'serviceArrived' ? r.service : ''));
    expect(services.sort()).toEqual(['fire', 'hazmat']);
  });

  it('arrival of an already-on-scene unit answers a late service request', () => {
    const h = makeHarness({ scenario: true });
    const to = pointFromStation(h, 700);
    const c = makeCall(h, 2, to.x, to.z);
    h.requested.add(`${c.id}:fire`);
    h.res.request({ kind: 'request', typeId: 'fire', callId: c.id, via: 'radio' });
    expect(runUntil(h, () => view(h, 'ENGINE-1').status === 'onScene', 600)).toBe(true);
    h.sceneRequests.length = 0;
    h.requested.add(`${c.id}:hazmat`);
    h.res.provide(c.id, 'hazmat');
    step(h);
    expect(h.sceneRequests).toContainEqual({ kind: 'serviceArrived', callId: c.id, service: 'hazmat' });
  });
});

describe('drive from the base', () => {
  it('spawns at the base after the turnout, drives, arrives and tells CAD and the scene', () => {
    const h = makeHarness({ scenario: true });
    const to = pointFromStation(h, 1500);
    const c = makeCall(h, 3, to.x, to.z);
    const base = basePoint(h.city, 'station', to.x, to.z, { x: 0, z: 0 });
    h.res.request({ kind: 'request', typeId: 'k9', callId: c.id, via: 'radio' });
    step(h);
    expect(h.res.provide(c.id, 'k9')).toBe(true);
    step(h);
    const unit = view(h, 'K9-1');
    expect(unit.status).toBe('turnout');
    expect(h.cad.unit('K9-1')?.status).toBe('enRoute');
    expect(h.cad.unit('K9-1')?.callId).toBe(c.id);
    // During the turnout nothing is spawned and the unit sits at its base.
    run(h, 30);
    expect(h.traffic.spawns).toHaveLength(0);
    expect(Math.hypot(unit.x - base.x, unit.z - base.z)).toBeLessThan(1);
    expect(Math.hypot(h.cad.unit('K9-1')?.x ?? 0, (h.cad.unit('K9-1')?.z ?? 0) - base.z)).toBeGreaterThan(0);

    // The car appears at the base, far from the call.
    expect(runUntil(h, () => h.traffic.spawns.length > 0, 200)).toBe(true);
    const spawn = h.traffic.spawns[0];
    expect(spawn).toBeDefined();
    expect(Math.hypot((spawn?.x ?? 0) - base.x, (spawn?.z ?? 0) - base.z)).toBeLessThan(1);
    expect(Math.hypot((spawn?.x ?? 0) - to.x, (spawn?.z ?? 0) - to.z)).toBeGreaterThan(1000);
    step(h);
    expect(view(h, 'K9-1').status).toBe('enRoute');

    // It drives: the position changes, the ETA shrinks, and the distance to the call falls.
    const idx = h.traffic.spawns[0]?.index ?? -1;
    const p0 = { x: h.traffic.cars.get(idx)?.x ?? 0, z: h.traffic.cars.get(idx)?.z ?? 0 };
    const eta0 = h.res.eta('K9-1');
    expect(eta0).toBeGreaterThan(0);
    run(h, 10);
    const p1 = { x: h.traffic.cars.get(idx)?.x ?? 0, z: h.traffic.cars.get(idx)?.z ?? 0 };
    expect(Math.hypot(p1.x - p0.x, p1.z - p0.z)).toBeGreaterThan(50);
    const eta1 = h.res.eta('K9-1');
    expect(eta1).toBeGreaterThan(0);
    expect(eta1).toBeLessThan(eta0 - 5);
    run(h, 10);
    expect(h.res.eta('K9-1')).toBeLessThan(eta1 - 5);
    expect(Math.hypot((h.cad.unit('K9-1')?.x ?? 0) - to.x, (h.cad.unit('K9-1')?.z ?? 0) - to.z)).toBeLessThan(Math.hypot(base.x - to.x, base.z - to.z));
    expect(h.res.hud().next).toMatch(/^K9-1 ETA \d+:\d\d$/);

    // Arrival.
    expect(runUntil(h, () => view(h, 'K9-1').status === 'onScene', 300)).toBe(true);
    const cu: CadUnit | null = h.cad.unit('K9-1');
    expect(cu?.status).toBe('onScene');
    expect(h.sceneRequests).toContainEqual({ kind: 'serviceArrived', callId: c.id, service: 'k9' });
    const arrived = eventsOf<Dispatched>(h, 'resource:arrived');
    expect(arrived).toEqual([{ callsign: 'K9-1', typeId: 'k9', callId: c.id }]);
    expect(h.res.onScene(c.id, 'k9')).toBe(1);
    expect(h.res.onSceneUnits(c.id, 'k9', [])).toEqual(['K9-1']);
    expect(h.res.eta('K9-1')).toBe(-1);
    expect(h.res.hud().onScene).toBe(1);
    expect(h.res.hud().next).toBeNull();
  });

  it('does not tell the scene about a service nobody requested, and never when there is no scenario', () => {
    const h = makeHarness({ scenario: false });
    const to = pointFromStation(h, 800);
    const c = makeCall(h, 2, to.x, to.z);
    h.res.request({ kind: 'request', typeId: 'k9', callId: c.id, via: 'radio' });
    expect(runUntil(h, () => view(h, 'K9-1').status === 'onScene', 600)).toBe(true);
    expect(h.sceneRequests).toEqual([]);
  });

  it('a unit leaves when its time is up and drives back to its base', () => {
    const h = makeHarness();
    const to = pointFromStation(h, 800);
    const c = makeCall(h, 2, to.x, to.z);
    h.res.request({ kind: 'request', typeId: 'k9', callId: c.id, via: 'radio' });
    expect(runUntil(h, () => view(h, 'K9-1').status === 'onScene', 600)).toBe(true);
    expect(h.traffic.cars.size).toBe(1);
    expect(runUntil(h, () => view(h, 'K9-1').status === 'returning', 700)).toBe(true);
    expect(h.cad.unit('K9-1')?.status).toBe('available');
    expect(h.cad.unit('K9-1')?.callId).toBeNull();
    expect(eventsOf(h, 'resource:cleared')).toHaveLength(1);
    expect(runUntil(h, () => view(h, 'K9-1').status === 'available', 600)).toBe(true);
    expect(h.traffic.cars.size).toBe(0);
    const base = basePoint(h.city, 'station', 0, 0, { x: 0, z: 0 });
    expect(Math.hypot((h.cad.unit('K9-1')?.x ?? 0) - base.x, (h.cad.unit('K9-1')?.z ?? 0) - base.z)).toBeLessThan(1);
    // It can be requested again.
    h.res.request({ kind: 'request', typeId: 'k9', callId: c.id, via: 'radio' });
    step(h);
    expect(eventsOf(h, 'resource:dispatched')).toHaveLength(2);
  });

  it('closing the call sends units home and a cancel before the turnout ends frees the unit at once', () => {
    const h = makeHarness();
    const to = pointFromStation(h, 1200);
    const c = makeCall(h, 3, to.x, to.z);
    h.res.request({ kind: 'request', typeId: 'k9', callId: c.id, via: 'radio' });
    h.res.request({ kind: 'request', typeId: 'ems', callId: c.id, via: 'radio' });
    step(h);
    run(h, 1);
    h.res.request({ kind: 'cancel', callsign: 'K9-1' });
    step(h);
    expect(view(h, 'K9-1').status).toBe('available');
    expect(h.cad.unit('K9-1')?.status).toBe('available');
    expect(h.traffic.spawns.filter((s) => s.index === UNIT_TYPES.fleetIndexBase)).toHaveLength(0);
    // The ambulance drives; closing the call turns it around.
    expect(runUntil(h, () => view(h, 'MEDIC-1').status === 'enRoute', 300)).toBe(true);
    h.cad.closeCall(c.id, 'handled', at(h.sim));
    step(h);
    expect(view(h, 'MEDIC-1').status).toBe('returning');
    expect(runUntil(h, () => view(h, 'MEDIC-1').status === 'available', 900)).toBe(true);
  });

  it('retries a failed spawn every 5 s and drives once a spot is found', () => {
    const h = makeHarness();
    h.traffic.failSpawn = true;
    const to = pointFromStation(h, 800);
    const c = makeCall(h, 1, to.x, to.z);
    h.res.request({ kind: 'request', typeId: 'supervisor', callId: c.id, via: 'radio' });
    run(h, 90);
    expect(view(h, 'SGT-1').status).toBe('turnout');
    h.traffic.failSpawn = false;
    expect(runUntil(h, () => view(h, 'SGT-1').status === 'enRoute', 20)).toBe(true);
  });

  it('release sends an on-scene unit home', () => {
    const h = makeHarness();
    const to = pointFromStation(h, 500);
    const c = makeCall(h, 1, to.x, to.z);
    h.res.request({ kind: 'request', typeId: 'ems', callId: c.id, via: 'radio' });
    expect(runUntil(h, () => view(h, 'MEDIC-1').status === 'onScene', 600)).toBe(true);
    h.res.request({ kind: 'release', callsign: 'MEDIC-1' });
    step(h);
    expect(view(h, 'MEDIC-1').status).toBe('returning');
    h.res.request({ kind: 'release', callsign: 'NOPE-9' });
    step(h);
  });
});

describe('patrol helpers', () => {
  it('rankPatrol is estimateResponse over a real route from the CAD unit position', () => {
    const h = makeHarness();
    const start = h.city.spawn;
    h.cad.addUnit({ callsign: '21', kind: 'ai', officer: 'Officer', beat: 'downtown', fleetIndex: 0 }, at(0));
    h.cad.setUnitPosition('21', start.x, start.z);
    const to = pointFromStation(h, 1200);
    const got = h.res.rankPatrol('21', to.x, to.z, 'emergency');
    const route = h.city.graph.routeBetweenPoints(start.x, start.z, to.x, to.z);
    expect(route).not.toBeNull();
    if (!route) return;
    const want = estimateResponse({ routeTimeS: route.time, routeLengthM: route.length, priority: 1, urgency: 'emergency', trafficDensity: 1, wetness: 0, turnoutS: [0, 0], speedFactor: 1 });
    expect(got).toBeCloseTo(want.etaS, 6);
    expect(h.res.rankPatrol('21', to.x, to.z, 'respond')).toBeGreaterThan(got);
    expect(h.res.rankPatrol('nobody', to.x, to.z, 'respond')).toBe(Infinity);
    const unreachable = makeHarness({ city: stubCity(() => null) });
    unreachable.cad.addUnit({ callsign: '21', kind: 'ai', officer: 'Officer', beat: 'downtown', fleetIndex: 0 }, at(0));
    expect(unreachable.res.rankPatrol('21', to.x, to.z, 'respond')).toBe(Infinity);
  });

  it('eta() of a patrol unit comes from its fleet car route', () => {
    const h = makeHarness();
    const to = pointFromStation(h, 1200);
    const c = makeCall(h, 2, to.x, to.z);
    h.cad.addUnit({ callsign: '21', kind: 'ai', officer: 'Officer', beat: 'downtown', fleetIndex: 0 }, at(0));
    h.cad.assign(c.id, '21', at(0), 'dispatch');
    expect(h.res.eta('21')).toBe(-1);
    h.traffic.spawnFleetCar(0, h.city.spawn.x, h.city.spawn.z);
    h.traffic.setFleetDestination(0, to.x, to.z, 'emergency');
    const a = h.res.eta('21');
    expect(a).toBeGreaterThan(10);
    run(h, 5);
    expect(h.res.eta('21')).toBeLessThan(a);
    expect(h.res.eta('unknown')).toBe(-1);
    expect(h.res.eta('K9-1')).toBe(-1);
  });

  it('lists every slot and exposes the same objects between steps', () => {
    const h = makeHarness();
    const u = h.res.units();
    expect(u).toHaveLength(23);
    expect(u.map((x) => x.callsign)).toContain('AIR-1');
    expect(u.every((x) => x.status === 'available' && x.etaS === -1)).toBe(true);
    expect(h.res.units()).toBe(u);
    expect(location(1, 2).x).toBe(1);
  });
});
