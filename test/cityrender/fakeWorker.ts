import type { RequestEnvelope } from '../../src/workers/protocol';
import { WorkerClient, type WorkerLike } from '../../src/workers/workerClient';
import { ChunkWorkerHost } from '../../src/world/render/chunkWorkerHost';
import type { ChunkWorkerMap } from '../../src/world/render/chunkProtocol';

/**
 * WorkerLike that records requests and only answers when the test says so,
 * using a real `ChunkWorkerHost` (so replies carry real meshes).
 */
export function fakeChunkWorker() {
  const listeners = new Map<string, ((event: MessageEvent | ErrorEvent) => void)[]>();
  const pending: RequestEnvelope<ChunkWorkerMap>[] = [];
  const sent: RequestEnvelope<ChunkWorkerMap>[] = [];
  const host = new ChunkWorkerHost();
  const emit = (type: string, event: MessageEvent | ErrorEvent): void => {
    for (const l of listeners.get(type) ?? []) l(event);
  };
  const worker: WorkerLike = {
    postMessage(message: unknown) {
      const req = message as RequestEnvelope<ChunkWorkerMap>;
      sent.push(req);
      pending.push(req);
    },
    addEventListener(type: string, listener: (event: never) => void) {
      const list = listeners.get(type) ?? [];
      list.push(listener as (event: MessageEvent | ErrorEvent) => void);
      listeners.set(type, list);
    },
    terminate() {},
  };
  const client = new WorkerClient<ChunkWorkerMap>(worker);
  /** Answers the oldest `count` unanswered requests through the host. */
  const answer = (count = Infinity): void => {
    for (let i = 0; i < count && pending.length > 0; i++) {
      const req = pending.shift() as RequestEnvelope<ChunkWorkerMap>;
      for (const reply of host.handle(req)) emit('message', { data: reply.response } as MessageEvent);
    }
  };
  /** Answers the oldest unanswered request with an error. */
  const fail = (): void => {
    const req = pending.shift();
    if (req) emit('message', { data: { id: req.id, ok: false, error: 'boom' } } as MessageEvent);
  };
  const builds = (): { cx: number; cz: number; lod: 0 | 1 }[] =>
    sent.filter((r) => r.type === 'build').map((r) => r.payload as { cx: number; cz: number; lod: 0 | 1 });
  return { client, sent, pending, answer, fail, builds };
}

/** Lets promise callbacks (worker replies) run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}
