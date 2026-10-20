import { describe, expect, it } from 'vitest';
import type { EventBus } from '../../src/core/events';
import type { EventMap } from '../../src/core/event-map';
import { at, eventsOf, makeCall, makeHarness, pointFromStation, run, runUntil, step, view, type Harness } from './helpers';

interface Dispatched {
  callsign: string;
  typeId: string;
  callId: number;
  etaS: number;
}

/** `command:post` belongs to the command module (same wave): emitted through a loose view of the bus. */
function emitPost(bus: EventBus<EventMap>, payload: unknown): void {
  (bus as unknown as { emit(topic: string, payload: unknown): void }).emit('command:post', payload);
}

function force(h: Harness, level: string, callId: number): void {
  h.bus.emit('force:applied', {
    seq: 1, tool: level, level, personId: 1, actorId: 1, callId, resistance: 'active', hit: true, injury: 0, fatal: false, cycle: 1,
    riskFactors: [], distance: 2, restrained: false, sim: h.sim,
  });
}

describe('chain of command wiring', () => {
  it('a taser use sends a sergeant to the call, who announces himself', () => {
    const h = makeHarness();
    const to = pointFromStation(h, 900);
    const c = makeCall(h, 3, to.x, to.z);
    force(h, 'taser', c.id);
    expect(eventsOf(h, 'resource:dispatched')).toHaveLength(0);
    step(h);
    const d = eventsOf<Dispatched>(h, 'resource:dispatched');
    expect(d.map((e) => [e.callsign, e.typeId, e.callId])).toEqual([['SGT-1', 'supervisor', c.id]]);
    expect(h.radio.some((r) => r.speaker === 'SGT-1' && r.text === 'SGT-1, show me responding to Main Street at 1st Street.')).toBe(true);
    expect(h.res.supervisorFor(c.id)).toBe('SGT-1');
    expect(h.res.supervisorFor(c.id + 1)).toBeNull();
    // More force on the same call does not send a second sergeant.
    force(h, 'baton', c.id);
    step(h);
    expect(eventsOf(h, 'resource:dispatched')).toHaveLength(1);
    // A non-listed level is ignored.
    force(h, 'verbal', c.id);
    step(h);
    expect(eventsOf(h, 'resource:dispatched')).toHaveLength(1);
  });

  it('the sergeant stays until the call closes, then goes home and counts the call as handled', () => {
    const h = makeHarness();
    const to = pointFromStation(h, 600);
    const c = makeCall(h, 2, to.x, to.z);
    force(h, 'firearm', c.id);
    expect(runUntil(h, () => view(h, 'SGT-1').status === 'onScene', 400)).toBe(true);
    expect(h.res.supervisorFor(c.id)).toBe('SGT-1');
    expect(h.roster.profile('SGT-1')?.name).toMatch(/^Sgt\. /);
    expect(h.cad.unit('SGT-1')?.officer).toBe(h.roster.profile('SGT-1')?.name);
    run(h, 900);
    expect(view(h, 'SGT-1').status).toBe('onScene');
    const calls0 = h.roster.dynamic('SGT-1')?.calls ?? 0;
    h.cad.closeCall(c.id, 'handled', at(h.sim));
    step(h);
    expect(view(h, 'SGT-1').status).toBe('returning');
    expect(h.roster.dynamic('SGT-1')?.calls).toBe(calls0 + 1);
    expect(h.res.supervisorFor(c.id)).toBeNull();
    expect(runUntil(h, () => view(h, 'SGT-1').status === 'available', 600)).toBe(true);
  });

  it('an excessive verdict sends a sergeant to the call named by the incident key; other verdicts do nothing', () => {
    const h = makeHarness();
    const a = makeCall(h, 3, h.city.spawn.x + 800, h.city.spawn.z);
    const b = makeCall(h, 3, h.city.spawn.x - 800, h.city.spawn.z);
    expect(b.id).toBe(a.id + 1);
    h.bus.emit('incident:forceVerdict', { key: `C-${String(b.id).padStart(5, '0')}`, eventId: 1, verdict: 'questionable', text: 'x' });
    h.bus.emit('incident:forceVerdict', { key: `C-${String(b.id).padStart(5, '0')}`, eventId: 2, verdict: 'justified', text: 'x' });
    step(h);
    expect(eventsOf(h, 'resource:dispatched')).toHaveLength(0);
    h.bus.emit('incident:forceVerdict', { key: `C-${String(b.id).padStart(5, '0')}`, eventId: 3, verdict: 'excessive', text: 'x' });
    step(h);
    expect(eventsOf<Dispatched>(h, 'resource:dispatched').map((e) => [e.callsign, e.callId])).toEqual([['SGT-1', b.id]]);
    // An unknown key falls back to the player's call.
    const h2 = makeHarness();
    const c = makeCall(h2, 3, h2.city.spawn.x + 800, h2.city.spawn.z);
    h2.bus.emit('incident:forceVerdict', { key: 'bogus', eventId: 1, verdict: 'excessive', text: 'x' });
    step(h2);
    expect(eventsOf<Dispatched>(h2, 'resource:dispatched').map((e) => e.callId)).toEqual([c.id]);
  });

  it('a vehicle pursuit sends a sergeant; a foot pursuit and an ended pursuit do not', () => {
    const h = makeHarness();
    const c = makeCall(h, 1, h.city.spawn.x + 800, h.city.spawn.z, 'vehiclePursuit');
    h.bus.emit('scene:pursuit', { kind: 'foot', active: true, callId: c.id });
    h.bus.emit('scene:pursuit', { kind: 'vehicle', active: false, callId: c.id });
    step(h);
    expect(eventsOf(h, 'resource:dispatched')).toHaveLength(0);
    h.bus.emit('scene:pursuit', { kind: 'vehicle', active: true, callId: c.id });
    step(h);
    expect(eventsOf<Dispatched>(h, 'resource:dispatched').map((e) => [e.callsign, e.callId])).toEqual([['SGT-1', c.id]]);
  });

  it('a disaster command post sends a lieutenant and the chief; a major one only the lieutenant', () => {
    const h = makeHarness();
    const to = pointFromStation(h, 700);
    const c = makeCall(h, 1, to.x, to.z);
    emitPost(h.bus, { callId: c.id, level: 'incident', x: to.x, z: to.z, open: true });
    step(h);
    expect(eventsOf(h, 'resource:dispatched')).toHaveLength(0);
    emitPost(h.bus, { callId: c.id, level: 'disaster', x: to.x, z: to.z, open: true });
    step(h);
    expect(eventsOf<Dispatched>(h, 'resource:dispatched').map((e) => e.callsign)).toEqual(['LT-1', 'CHIEF-1']);
    // Lieutenant outranks no sergeant here; with only these two assigned the lieutenant is the supervisor.
    expect(h.res.supervisorFor(c.id)).toBe('LT-1');

    const m = makeHarness();
    const c2 = makeCall(m, 2, to.x, to.z);
    emitPost(m.bus, { callId: c2.id, level: 'major', x: to.x, z: to.z, open: true });
    step(m);
    expect(eventsOf<Dispatched>(m, 'resource:dispatched').map((e) => e.callsign)).toEqual(['LT-1']);
    // A closing post and malformed payloads are ignored.
    emitPost(m.bus, { callId: c2.id, level: 'disaster', open: false });
    emitPost(m.bus, { callId: 'x', level: 'disaster', open: true });
    emitPost(m.bus, null);
    emitPost(m.bus, { callId: c2.id, level: 'nonsense', open: true });
    step(m);
    expect(eventsOf(m, 'resource:dispatched')).toHaveLength(1);
  });

  it('prefers the sergeant over the lieutenant and the chief in supervisorFor', () => {
    const h = makeHarness();
    const to = pointFromStation(h, 700);
    const c = makeCall(h, 1, to.x, to.z);
    emitPost(h.bus, { callId: c.id, level: 'disaster', x: to.x, z: to.z, open: true });
    force(h, 'taser', c.id);
    step(h);
    expect(h.res.supervisorFor(c.id)).toBe('SGT-1');
  });

  it('ranked units wait out a command post and the post crew stands at the post', () => {
    const h = makeHarness();
    const to = pointFromStation(h, 600);
    const c = makeCall(h, 1, to.x, to.z);
    emitPost(h.bus, { callId: c.id, level: 'major', x: to.x + 20, z: to.z + 20, open: true });
    // Non-ranked units hold too while a post is open.
    h.res.request({ kind: 'request', typeId: 'tow', callId: c.id, via: 'radio' });
    expect(runUntil(h, () => view(h, 'LT-1').status === 'onScene' && view(h, 'TOW-1').status === 'onScene', 900)).toBe(true);
    run(h, 400);
    expect(view(h, 'TOW-1').status).toBe('onScene');
    // The lieutenant's crew figure is at the post.
    expect(h.res.crews.count).toBeGreaterThan(0);
    const posts = h.res.serialize().posts;
    expect(posts).toEqual([[c.id, to.x + 20, to.z + 20, 2]]);
    emitPost(h.bus, { callId: c.id, level: 'major', open: false });
    step(h);
    expect(h.res.serialize().posts).toEqual([]);
    // With the post closed the tow truck's time is up.
    step(h);
    expect(view(h, 'TOW-1').status).toBe('returning');
    expect(view(h, 'LT-1').status).toBe('onScene');
  });
});
