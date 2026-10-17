/**
 * Chunk meshing worker entry: serves `ChunkWorkerMap` (init + build) through
 * `ChunkWorkerHost`. Must stay free of DOM- and THREE-dependent imports.
 */
import { ChunkWorkerHost } from './chunkWorkerHost';

/** The part of DedicatedWorkerGlobalScope this entry uses (the project compiles against lib DOM, not WebWorker). */
interface WorkerScope {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const host = new ChunkWorkerHost();
const scope = self as unknown as WorkerScope;

scope.onmessage = (event: MessageEvent) => {
  for (const reply of host.handle(event.data)) scope.postMessage(reply.response, reply.transfer);
};
