import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  errorToString,
  isRequestEnvelope,
  isResponseEnvelope,
  type RequestEnvelope,
  type ResponseEnvelope,
  type Rpc,
} from '../../src/workers/protocol';
import { createRpcCore, RpcError, WorkerClient, type WorkerLike } from '../../src/workers/workerClient';

type TestMap = {
  add: Rpc<{ a: number; b: number }, { sum: number }>;
  fail: Rpc<{ reason: string }, never>;
  slow: Rpc<Record<string, never>, { done: true }>;
};

/** Loopback transport: records requests and lets the test answer them explicitly. */
function loopback() {
  const sent: RequestEnvelope<TestMap>[] = [];
  const core = createRpcCore<TestMap>((message) => {
    sent.push(message);
  });
  const reply = (response: ResponseEnvelope) => core.handleMessage(response);
  return { core, sent, reply };
}

describe('createRpcCore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('assigns increasing correlation ids and posts the envelope', () => {
    const { core, sent } = loopback();
    void core.call('add', { a: 1, b: 2 });
    void core.call('fail', { reason: 'x' });
    expect(sent).toEqual([
      { id: 1, type: 'add', payload: { a: 1, b: 2 } },
      { id: 2, type: 'fail', payload: { reason: 'x' } },
    ]);
    expect(core.pendingCount).toBe(2);
  });

  it('resolves a call when its response arrives', async () => {
    const { core, sent, reply } = loopback();
    const promise = core.call('add', { a: 2, b: 3 });
    reply({ id: sent[0]!.id, ok: true, result: { sum: 5 } });
    await expect(promise).resolves.toEqual({ sum: 5 });
    expect(core.pendingCount).toBe(0);
  });

  it('rejects a call with an RpcError when the response is an error', async () => {
    const { core, sent, reply } = loopback();
    const promise = core.call('fail', { reason: 'boom' });
    reply({ id: sent[0]!.id, ok: false, error: 'boom' });
    await expect(promise).rejects.toMatchObject({ name: 'RpcError', message: 'boom', type: 'fail', id: 1 });
    expect(core.pendingCount).toBe(0);
  });

  it('times out an unanswered call and ignores a late response', async () => {
    const sent: RequestEnvelope<TestMap>[] = [];
    const core = createRpcCore<TestMap>((m) => sent.push(m), { timeoutMs: 100 });
    const promise = core.call('slow', {});
    const rejection = expect(promise).rejects.toThrow(/timed out after 100ms/);
    vi.advanceTimersByTime(99);
    expect(core.pendingCount).toBe(1);
    vi.advanceTimersByTime(1);
    await rejection;
    expect(core.pendingCount).toBe(0);
    expect(() => core.handleMessage({ id: sent[0]!.id, ok: true, result: { done: true } })).not.toThrow();
  });

  it('uses the 5000ms default timeout', async () => {
    const core = createRpcCore<TestMap>(() => undefined);
    expect(core.timeoutMs).toBe(5000);
    const promise = core.call('slow', {});
    vi.advanceTimersByTime(5000);
    await expect(promise).rejects.toBeInstanceOf(RpcError);
  });

  it('rejects an invalid timeout', () => {
    expect(() => createRpcCore<TestMap>(() => undefined, { timeoutMs: 0 })).toThrow(RangeError);
    expect(() => createRpcCore<TestMap>(() => undefined, { timeoutMs: Number.NaN })).toThrow(RangeError);
  });

  it('ignores responses with unknown ids and malformed messages', async () => {
    const { core, sent, reply } = loopback();
    const promise = core.call('add', { a: 1, b: 1 });
    reply({ id: 999, ok: true, result: { sum: 0 } });
    core.handleMessage(null);
    core.handleMessage('nope');
    core.handleMessage({ id: 1 });
    core.handleMessage({ id: 1, ok: 'yes', result: {} });
    expect(core.pendingCount).toBe(1);
    reply({ id: sent[0]!.id, ok: true, result: { sum: 2 } });
    await expect(promise).resolves.toEqual({ sum: 2 });
  });

  it('matches responses to the right call regardless of order', async () => {
    const { core, reply } = loopback();
    const first = core.call('add', { a: 1, b: 1 });
    const second = core.call('add', { a: 2, b: 2 });
    reply({ id: 2, ok: true, result: { sum: 4 } });
    reply({ id: 1, ok: true, result: { sum: 2 } });
    await expect(first).resolves.toEqual({ sum: 2 });
    await expect(second).resolves.toEqual({ sum: 4 });
  });

  it('rejects immediately when posting throws', async () => {
    const core = createRpcCore<TestMap>(() => {
      throw new Error('transport down');
    });
    await expect(core.call('add', { a: 1, b: 1 })).rejects.toThrow('transport down');
    expect(core.pendingCount).toBe(0);
  });

  it('rejectAll fails every pending call', async () => {
    const { core } = loopback();
    const a = core.call('add', { a: 1, b: 1 });
    const b = core.call('slow', {});
    core.rejectAll('shutting down');
    await expect(a).rejects.toThrow('shutting down');
    await expect(b).rejects.toThrow('shutting down');
    expect(core.pendingCount).toBe(0);
  });

  it('records lastRoundTripMs using the injected clock', async () => {
    let t = 1000;
    const core = createRpcCore<TestMap>(() => undefined, { now: () => t });
    expect(core.lastRoundTripMs).toBe(0);
    const promise = core.call('add', { a: 1, b: 1 });
    t = 1012.5;
    core.handleMessage({ id: 1, ok: true, result: { sum: 2 } });
    await promise;
    expect(core.lastRoundTripMs).toBe(12.5);
  });
});

describe('protocol guards', () => {
  it('isRequestEnvelope checks id/type/payload presence', () => {
    expect(isRequestEnvelope({ id: 1, type: 'ping', payload: { t: 0 } })).toBe(true);
    expect(isRequestEnvelope({ id: 1, type: 'ping', payload: undefined })).toBe(true);
    expect(isRequestEnvelope({ id: '1', type: 'ping', payload: {} })).toBe(false);
    expect(isRequestEnvelope({ id: 1, payload: {} })).toBe(false);
    expect(isRequestEnvelope({ id: 1, type: 'ping' })).toBe(false);
    expect(isRequestEnvelope(null)).toBe(false);
  });

  it('isResponseEnvelope accepts both success and error shapes only', () => {
    expect(isResponseEnvelope({ id: 1, ok: true, result: null })).toBe(true);
    expect(isResponseEnvelope({ id: 1, ok: false, error: 'x' })).toBe(true);
    expect(isResponseEnvelope({ id: 1, ok: true })).toBe(false);
    expect(isResponseEnvelope({ id: 1, ok: false, error: 5 })).toBe(false);
    expect(isResponseEnvelope({ ok: true, result: 1 })).toBe(false);
    expect(isResponseEnvelope(42)).toBe(false);
  });

  it('errorToString handles errors, strings and other values', () => {
    expect(errorToString(new RangeError('bad'))).toBe('bad');
    expect(errorToString('plain')).toBe('plain');
    expect(errorToString({ code: 7 })).toBe('{"code":7}');
    expect(errorToString(undefined)).toBe('undefined');
  });
});

describe('WorkerClient', () => {
  /** In-process stand-in for a Worker: answers 'add' synchronously via a message event. */
  function fakeWorker() {
    const listeners = new Map<string, ((event: MessageEvent | ErrorEvent) => void)[]>();
    const posted: { message: unknown; transfer: Transferable[] | undefined }[] = [];
    let terminated = 0;
    const emit = (type: string, event: MessageEvent | ErrorEvent) => {
      for (const l of listeners.get(type) ?? []) l(event);
    };
    const worker: WorkerLike = {
      postMessage(message: unknown, transfer?: Transferable[]) {
        posted.push({ message, transfer });
        const req = message as RequestEnvelope<TestMap>;
        if (req.type === 'add') {
          const { a, b } = req.payload as { a: number; b: number };
          emit('message', { data: { id: req.id, ok: true, result: { sum: a + b } } } as MessageEvent);
        }
      },
      addEventListener(type: string, listener: (event: never) => void) {
        const list = listeners.get(type) ?? [];
        list.push(listener as (event: MessageEvent | ErrorEvent) => void);
        listeners.set(type, list);
      },
      terminate() {
        terminated++;
      },
    };
    return { worker, posted, emit, terminatedCount: () => terminated };
  }

  it('round-trips a call through the worker and records timing', async () => {
    const { worker, posted } = fakeWorker();
    const client = new WorkerClient<TestMap>(worker);
    await expect(client.call('add', { a: 4, b: 5 })).resolves.toEqual({ sum: 9 });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.transfer).toBeUndefined();
    expect(client.lastRoundTripMs).toBeGreaterThanOrEqual(0);
  });

  it('passes a transfer list through to postMessage', async () => {
    const { worker, posted } = fakeWorker();
    const client = new WorkerClient<TestMap>(worker);
    const buffer = new ArrayBuffer(8);
    const pending = client.call('slow', {}, [buffer]);
    expect(posted[0]!.transfer).toEqual([buffer]);
    client.terminate();
    await expect(pending).rejects.toBeInstanceOf(RpcError);
  });

  it('terminate rejects pending calls, stops the worker and refuses new calls', async () => {
    const { worker, terminatedCount } = fakeWorker();
    const client = new WorkerClient<TestMap>(worker);
    const pending = client.call('slow', {});
    client.terminate();
    client.terminate();
    expect(terminatedCount()).toBe(1);
    expect(client.isTerminated).toBe(true);
    await expect(pending).rejects.toThrow('worker client terminated');
    await expect(client.call('add', { a: 1, b: 1 })).rejects.toThrow('terminated');
    expect(client.pendingCount).toBe(0);
  });

  it('rejects pending calls when the worker reports an error', async () => {
    const { worker, emit } = fakeWorker();
    const client = new WorkerClient<TestMap>(worker);
    const pending = client.call('slow', {});
    emit('error', { message: 'script crashed' } as ErrorEvent);
    await expect(pending).rejects.toThrow('worker error: script crashed');
  });
});
