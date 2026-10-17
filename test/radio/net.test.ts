import { describe, expect, it } from 'vitest';
import type { EventMap } from '../../src/core/event-map';
import { EventBus } from '../../src/core/events';
import { RADIO_CONFIG } from '../../src/radio/data';
import { QUEUE_CAP, RadioNet, type NewTransmission } from '../../src/radio/net';
import type { Transmission } from '../../src/radio/types';
import { at } from './helpers';

function setup(logSize = RADIO_CONFIG.logSize) {
  const bus = new EventBus<EventMap>((topic, error) => {
    throw new Error(`${topic}: ${String(error)}`);
  });
  const events: { topic: string; payload: unknown }[] = [];
  for (const topic of ['radio:start', 'radio:end', 'radio:blocked'] as const) bus.on(topic, (p) => events.push({ topic, payload: p }));
  const net = new RadioNet(bus, { ...RADIO_CONFIG, logSize });
  let time = 0;
  const run = (until: number) => {
    while (time < until - 1e-9) {
      time += 1 / 60;
      net.step(at(time));
    }
  };
  return { net, events, run, now: () => time };
}

function tx(text: string, extra: Partial<NewTransmission> = {}): NewTransmission {
  return { channel: 'dispatch', speaker: 'Dispatch', speakerKind: 'dispatcher', text, kind: 'test', earliest: 0, ...extra };
}

function started(events: { topic: string; payload: unknown }[]): Transmission[] {
  return events.filter((e) => e.topic === 'radio:start').map((e) => (e.payload as { tx: Transmission }).tx);
}

describe('RadioNet', () => {
  it('estimates duration from the spoken words', () => {
    const { net } = setup();
    // "twelve, show me ten eight." = 5 words
    const e = net.enqueue(tx('12, show me 10-8.'));
    expect(e.spoken).toBe('twelve, show me ten eight.');
    expect(e.duration).toBeCloseTo(0.35 + 5 / 2.6 + 0.3, 10);
    expect(net.estimateDuration('')).toBeCloseTo(0.65, 10);
  });

  it('starts at the earliest time and ends after the duration', () => {
    const { net, events, run } = setup();
    const e = net.enqueue(tx('one two three four five six', { earliest: 1 }));
    run(0.95);
    expect(started(events)).toHaveLength(0);
    run(1.02);
    const [first] = started(events);
    expect(first?.id).toBe(e.id);
    expect(first?.start).toBeGreaterThanOrEqual(1);
    expect(first?.clock).toBe('14:00');
    run(1 + e.duration - 0.05);
    expect(events.some((x) => x.topic === 'radio:end')).toBe(false);
    run(1 + e.duration + 0.05);
    expect(events.filter((x) => x.topic === 'radio:end').map((x) => x.payload)).toEqual([{ id: e.id, blocked: false }]);
  });

  it('waitClear transmissions go one after the other in queue order', () => {
    const { net, events, run } = setup();
    const a = net.enqueue(tx('first message here'));
    const b = net.enqueue(tx('second message', { speaker: '21', speakerKind: 'officer' }));
    const c = net.enqueue(tx('third'));
    run(10);
    const s = started(events);
    expect(s.map((t) => t.id)).toEqual([a.id, b.id, c.id]);
    expect(s[1]?.start).toBeGreaterThanOrEqual((s[0]?.start ?? 0) + a.duration - 1e-9);
    expect(s[2]?.start).toBeGreaterThanOrEqual((s[1]?.start ?? 0) + b.duration - 1e-9);
    expect(s.every((t) => !t.blocked)).toBe(true);
  });

  it('keying up on a busy channel blocks both and emits radio:blocked', () => {
    const { net, events, run } = setup();
    const a = net.enqueue(tx('a long message that keeps the channel busy for a while'));
    run(0.5);
    const b = net.enqueue(tx('12, show me 10-8', { speaker: '12', speakerKind: 'player', waitClear: false }));
    run(0.6);
    const blocked = events.filter((e) => e.topic === 'radio:blocked').map((e) => e.payload);
    expect(blocked).toEqual([{ ids: [a.id, b.id], channel: 'dispatch' }]);
    expect(net.log.map((t) => t.blocked)).toEqual([true, true]);
    run(20);
    const ends = events.filter((e) => e.topic === 'radio:end').map((e) => e.payload);
    expect(ends).toContainEqual({ id: a.id, blocked: true });
    expect(ends).toContainEqual({ id: b.id, blocked: true });
  });

  it('transmissions on different channels do not block each other', () => {
    const { net, events, run } = setup();
    net.enqueue(tx('dispatch line'));
    net.enqueue(tx('fire line', { channel: 'fireEms', speaker: 'Fire Dispatch' }));
    run(0.1);
    expect(started(events)).toHaveLength(2);
    expect(events.some((e) => e.topic === 'radio:blocked')).toBe(false);
  });

  it('a held channel only passes priority transmissions', () => {
    const { net, events, run } = setup();
    net.hold('dispatch');
    const normal = net.enqueue(tx('normal traffic'));
    const ambientFire = net.enqueue(tx('fire is not held', { channel: 'fireEms' }));
    const prio = net.enqueue(tx('emergency traffic', { priority: true }));
    run(5);
    expect(started(events).map((t) => t.id)).toEqual([prio.id, ambientFire.id]);
    expect(net.isHeld('dispatch')).toBe(true);
    net.release('dispatch');
    run(6);
    expect(started(events).map((t) => t.id)).toContain(normal.id);
  });

  it('priority transmissions start before earlier queued ones', () => {
    const { net, events, run } = setup();
    const n = net.enqueue(tx('normal'));
    const p = net.enqueue(tx('priority', { priority: true }));
    run(0.1);
    expect(started(events).map((t) => t.id)).toEqual([p.id]);
    run(10);
    expect(started(events).map((t) => t.id)).toEqual([p.id, n.id]);
  });

  it('audibility: selected, or scanning and in the scan list', () => {
    const { net, run } = setup();
    net.selected = 'county';
    net.enqueue(tx('a', { channel: 'county' }));
    net.enqueue(tx('b', { channel: 'tac' }));
    net.enqueue(tx('c', { channel: 'state' }));
    run(0.1);
    expect(net.log.map((t) => [t.channel, t.audible])).toEqual([['county', true], ['tac', false], ['state', false]]);
    net.scanning = true;
    net.enqueue(tx('d', { channel: 'tac' }));
    net.enqueue(tx('e', { channel: 'state' }));
    run(10);
    expect(net.log.slice(3).map((t) => [t.channel, t.audible])).toEqual([['tac', true], ['state', false]]);
  });

  it('keeps the last logSize transmissions', () => {
    const { net, run } = setup(5);
    for (let i = 0; i < 8; i++) net.enqueue(tx(`message ${i}`, { channel: i % 2 === 0 ? 'dispatch' : 'county' }));
    run(60);
    expect(net.log).toHaveLength(5);
    expect(net.log.map((t) => t.text).sort()).toEqual(['message 3', 'message 4', 'message 5', 'message 6', 'message 7']);
  });

  it('caps the queue by dropping the oldest ambient entry', () => {
    const { net } = setup();
    const first = net.enqueue(tx('ambient 0', { ambient: true, earliest: 100 }));
    for (let i = 1; i < QUEUE_CAP; i++) net.enqueue(tx(`line ${i}`, { earliest: 100 }));
    expect(net.pending).toHaveLength(QUEUE_CAP);
    net.enqueue(tx('one more', { earliest: 100 }));
    expect(net.pending).toHaveLength(QUEUE_CAP);
    expect(net.pending.some((e) => e.id === first.id)).toBe(false);
  });

  it('a reply chained with follows starts gap seconds after its parent ends', () => {
    const { net, events, run } = setup();
    const a = net.enqueue(tx('dispatch assigns twenty one'));
    const b = net.enqueue(tx('twenty one copies', { speaker: '21', speakerKind: 'officer', follows: a.id, gap: 2 }));
    run(15);
    const s = started(events);
    expect(s.map((t) => t.id)).toEqual([a.id, b.id]);
    expect(s[1]?.start).toBeGreaterThanOrEqual((s[0]?.start ?? 0) + a.duration + 2 - 1e-9);
    expect(s[1]?.start).toBeLessThan((s[0]?.start ?? 0) + a.duration + 2 + 0.05);
  });

  it('cancel removes chained replies too', () => {
    const { net } = setup();
    const a = net.enqueue(tx('a', { earliest: 5 }));
    net.enqueue(tx('b', { follows: a.id }));
    net.enqueue(tx('c'));
    expect(net.cancel((e) => e.id === a.id)).toBe(2);
    expect(net.pending.map((e) => e.text)).toEqual(['c']);
  });

  it('steps without transmissions are cheap', () => {
    const { net } = setup();
    const n = 20000;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) net.step({ sim: i / 60, game: i / 2 });
    const perStep = (performance.now() - t0) / n;
    expect(perStep).toBeLessThan(0.02);
  });
});
