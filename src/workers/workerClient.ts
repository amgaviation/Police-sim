import {
  isResponseEnvelope,
  type ProtocolMap,
  type RequestEnvelope,
  type RequestPayload,
  type RequestType,
  type ResponseResult,
} from './protocol';

/** Default time a call may stay unanswered before it rejects. */
export const DEFAULT_RPC_TIMEOUT_MS = 5000;

/** Thrown (as the rejection reason) when a call times out or the client is terminated. */
export class RpcError extends Error {
  readonly type: string;
  readonly id: number;

  constructor(message: string, type: string, id: number) {
    super(message);
    this.name = 'RpcError';
    this.type = type;
    this.id = id;
  }
}

export interface RpcCoreOptions {
  /** Per-call timeout in milliseconds; must be > 0 (default 5000). */
  timeoutMs?: number;
  /** Clock used for `lastRoundTripMs` (default `performance.now`). */
  now?: () => number;
}

/** Function the core uses to deliver a request to the other side. */
export type PostFn<M extends ProtocolMap> = (message: RequestEnvelope<M>, transfer?: Transferable[]) => void;

/**
 * Transport-agnostic request/response correlation: assigns ids, tracks pending
 * promises, times them out and matches inbound responses by id.
 */
export interface RpcCore<M extends ProtocolMap> {
  call<K extends RequestType<M>>(
    type: K,
    payload: RequestPayload<M, K>,
    transfer?: Transferable[],
  ): Promise<ResponseResult<M, K>>;
  /** Feed an inbound message; non-responses and unknown ids are ignored. */
  handleMessage(message: unknown): void;
  /** Rejects every pending call with `reason` (used on terminate / worker error). */
  rejectAll(reason: string): void;
  readonly pendingCount: number;
  /** Duration of the most recently completed call in ms (0 before the first). */
  readonly lastRoundTripMs: number;
  readonly timeoutMs: number;
}

interface Pending {
  type: string;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export function createRpcCore<M extends ProtocolMap>(post: PostFn<M>, options: RpcCoreOptions = {}): RpcCore<M> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  if (!(timeoutMs > 0) || !Number.isFinite(timeoutMs)) {
    throw new RangeError(`createRpcCore: timeoutMs must be a positive finite number, got ${String(timeoutMs)}`);
  }
  const now = options.now ?? (() => performance.now());
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let lastRoundTripMs = 0;

  function settle(id: number): Pending | undefined {
    const entry = pending.get(id);
    if (!entry) return undefined;
    pending.delete(id);
    clearTimeout(entry.timer);
    lastRoundTripMs = now() - entry.startedAt;
    return entry;
  }

  return {
    get pendingCount() {
      return pending.size;
    },
    get lastRoundTripMs() {
      return lastRoundTripMs;
    },
    timeoutMs,

    call<K extends RequestType<M>>(type: K, payload: RequestPayload<M, K>, transfer?: Transferable[]) {
      const id = nextId++;
      return new Promise<ResponseResult<M, K>>((resolve, reject) => {
        const timer = setTimeout(() => {
          const entry = settle(id);
          entry?.reject(new RpcError(`rpc '${type}' (#${id}) timed out after ${timeoutMs}ms`, type, id));
        }, timeoutMs);
        pending.set(id, {
          type,
          startedAt: now(),
          timer,
          resolve,
          reject,
        });
        try {
          post({ id, type, payload }, transfer);
        } catch (error) {
          settle(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },

    handleMessage(message: unknown) {
      if (!isResponseEnvelope(message)) return;
      const entry = settle(message.id);
      if (!entry) return;
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new RpcError(message.error, entry.type, message.id));
    },

    rejectAll(reason: string) {
      for (const id of [...pending.keys()]) {
        const entry = settle(id);
        entry?.reject(new RpcError(reason, entry.type, id));
      }
    },
  };
}

/** Minimal surface of a `Worker` the client relies on (keeps tests free of a real Worker). */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  addEventListener(type: 'messageerror', listener: (event: MessageEvent) => void): void;
  terminate(): void;
}

/** Promise-based RPC over a dedicated Web Worker. */
export class WorkerClient<M extends ProtocolMap> {
  private readonly core: RpcCore<M>;
  private readonly worker: WorkerLike;
  private terminated = false;

  constructor(worker: WorkerLike, options: RpcCoreOptions = {}) {
    this.worker = worker;
    this.core = createRpcCore<M>((message, transfer) => {
      if (this.terminated) throw new RpcError('worker client is terminated', message.type, message.id);
      if (transfer && transfer.length > 0) worker.postMessage(message, transfer);
      else worker.postMessage(message);
    }, options);
    worker.addEventListener('message', (event: MessageEvent) => {
      this.core.handleMessage(event.data);
    });
    worker.addEventListener('error', (event: ErrorEvent) => {
      this.core.rejectAll(`worker error: ${event.message || 'unknown'}`);
    });
    worker.addEventListener('messageerror', () => {
      this.core.rejectAll('worker message could not be deserialized');
    });
  }

  call<K extends RequestType<M>>(
    type: K,
    payload: RequestPayload<M, K>,
    transfer?: Transferable[],
  ): Promise<ResponseResult<M, K>> {
    return this.core.call(type, payload, transfer);
  }

  /** Duration of the most recently completed call in ms. */
  get lastRoundTripMs(): number {
    return this.core.lastRoundTripMs;
  }

  get pendingCount(): number {
    return this.core.pendingCount;
  }

  get isTerminated(): boolean {
    return this.terminated;
  }

  /** Stops the worker and rejects every pending call; idempotent. */
  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.core.rejectAll('worker client terminated');
    this.worker.terminate();
  }
}
