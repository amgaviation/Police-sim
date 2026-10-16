import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus, bus } from '../../src/core/events';
import { log } from '../../src/core/log';

interface TestMap {
  ping: { n: number };
  empty: Record<string, never>;
}

describe('EventBus', () => {
  beforeEach(() => {
    log.clear();
    log.setConsoleMirror(false);
  });

  it('runs handlers synchronously in subscription order', () => {
    const b = new EventBus<TestMap>();
    const order: string[] = [];
    b.on('ping', (p) => order.push(`a${p.n}`));
    b.on('ping', (p) => order.push(`b${p.n}`));
    b.emit('ping', { n: 1 });
    expect(order).toEqual(['a1', 'b1']);
  });

  it('returns an unsubscribe function from on()', () => {
    const b = new EventBus<TestMap>();
    const handler = vi.fn();
    const off = b.on('ping', handler);
    b.emit('ping', { n: 1 });
    off();
    b.emit('ping', { n: 2 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(b.listenerCount('ping')).toBe(0);
  });

  it('supports off() with the original handler', () => {
    const b = new EventBus<TestMap>();
    const handler = vi.fn();
    b.on('ping', handler);
    b.off('ping', handler);
    b.off('ping', handler); // no-op when absent
    b.emit('ping', { n: 1 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('once() fires a single time and is removed before invocation', () => {
    const b = new EventBus<TestMap>();
    const handler = vi.fn(() => {
      expect(b.listenerCount('ping')).toBe(0);
    });
    b.once('ping', handler);
    b.emit('ping', { n: 1 });
    b.emit('ping', { n: 2 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('isolates a throwing handler and logs the error', () => {
    const b = new EventBus<TestMap>();
    const after = vi.fn();
    b.on('ping', () => {
      throw new Error('boom');
    });
    b.on('ping', after);
    expect(() => b.emit('ping', { n: 1 })).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    const entries = log.entries();
    expect(entries.length).toBe(1);
    expect(entries[0]?.level).toBe('error');
    expect(entries[0]?.message).toContain("'ping'");
    expect(entries[0]?.message).toContain('boom');
  });

  it('uses a custom error handler when supplied', () => {
    const onError = vi.fn();
    const b = new EventBus<TestMap>(onError);
    b.on('ping', () => {
      throw new Error('custom');
    });
    b.emit('ping', { n: 1 });
    expect(onError).toHaveBeenCalledWith('ping', expect.any(Error));
    expect(log.entries()).toHaveLength(0);
  });

  it('tolerates unsubscribing other handlers during emit', () => {
    const b = new EventBus<TestMap>();
    const second = vi.fn();
    const offSecond = b.on('ping', second);
    b.on('ping', () => offSecond());
    // `second` was subscribed first, so it still runs this emit; not after.
    b.emit('ping', { n: 1 });
    b.emit('ping', { n: 2 });
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('clear() removes one topic or all topics', () => {
    const b = new EventBus<TestMap>();
    b.on('ping', vi.fn());
    b.on('empty', vi.fn());
    b.clear('ping');
    expect(b.listenerCount('ping')).toBe(0);
    expect(b.listenerCount()).toBe(1);
    b.clear();
    expect(b.listenerCount()).toBe(0);
  });

  it('exports a shared bus typed with EventMap', () => {
    const seen = vi.fn();
    const off = bus.on('app:pause', seen);
    bus.emit('app:pause', { paused: true });
    off();
    expect(seen).toHaveBeenCalledWith({ paused: true });
  });

  it('publishes log entries on the shared bus without recursing', () => {
    const seen = vi.fn(() => {
      throw new Error('log handler failed');
    });
    const off = bus.on('console:log', seen);
    try {
      log.info('hello');
    } finally {
      off();
    }
    // One for the info, none for the nested error (re-entrancy guard).
    expect(seen).toHaveBeenCalledTimes(1);
    const levels = log.entries().map((e) => e.level);
    expect(levels).toEqual(['info', 'error']);
  });
});
