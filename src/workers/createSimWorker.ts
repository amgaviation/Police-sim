import type { WorkerRequestMap } from './protocol';
import { WorkerClient, type RpcCoreOptions } from './workerClient';

/**
 * Spawns the simulation worker and wraps it in a typed client.
 * The `new Worker(new URL(...), { type: 'module' })` expression must stay
 * literal so Vite detects and bundles the worker entry.
 */
export function createSimWorker(options?: RpcCoreOptions): WorkerClient<WorkerRequestMap> {
  const worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
  return new WorkerClient<WorkerRequestMap>(worker, options);
}
