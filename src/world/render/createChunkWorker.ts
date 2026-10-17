import { WorkerClient, type RpcCoreOptions } from '../../workers/workerClient';
import type { ChunkWorkerMap } from './chunkProtocol';

/** Builds queue behind the worker's city generation, so calls get a longer timeout than the RPC default. */
const CHUNK_RPC_TIMEOUT_MS = 20000;

/**
 * Spawns the chunk meshing worker and wraps it in a typed client.
 * The `new Worker(new URL(...), { type: 'module' })` expression must stay
 * literal so Vite detects and bundles the worker entry.
 */
export function createChunkWorker(options?: RpcCoreOptions): WorkerClient<ChunkWorkerMap> {
  const worker = new Worker(new URL('./chunk.worker.ts', import.meta.url), { type: 'module' });
  return new WorkerClient<ChunkWorkerMap>(worker, { timeoutMs: CHUNK_RPC_TIMEOUT_MS, ...options });
}
