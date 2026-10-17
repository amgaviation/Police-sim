/**
 * Request handling of the chunk worker, kept free of the worker global so it
 * can be tested directly. DOM-free: imports only the pure world modules.
 */
import { errorToString, isRequestEnvelope, type ResponseEnvelope } from '../../workers/protocol';
import { chunkLayout } from '../chunkLayout';
import type { City } from '../city';
import { generateCity } from '../generate';
import { buildChunkMesh, chunkMeshTransferables } from './chunkMesher';
import { validateBuildRequest, validateInitRequest } from './chunkProtocol';

/** One message to post back, with the buffers to transfer. */
export interface ChunkWorkerReply {
  response: ResponseEnvelope;
  transfer: ArrayBuffer[];
}

/**
 * Serves `init` and `build`. Builds that arrive before the first `init` are
 * queued and answered (in arrival order) right after the city is generated.
 */
export class ChunkWorkerHost {
  private city: City | null = null;
  private readonly queue: { id: number; payload: unknown }[] = [];

  /** Handles one inbound message; returns the replies to post (none for non-requests). */
  handle(message: unknown): ChunkWorkerReply[] {
    if (!isRequestEnvelope(message)) return [];
    const { id, type, payload } = message;
    if (type === 'init') {
      const replies: ChunkWorkerReply[] = [];
      try {
        const { seed } = validateInitRequest(payload);
        if (this.city?.seed !== seed) this.city = generateCity(seed);
        replies.push({ response: { id, ok: true, result: { ok: true } }, transfer: [] });
      } catch (error) {
        return [{ response: { id, ok: false, error: errorToString(error) }, transfer: [] }];
      }
      for (const queued of this.queue.splice(0)) replies.push(this.build(queued.id, queued.payload));
      return replies;
    }
    if (type === 'build') {
      if (!this.city) {
        this.queue.push({ id, payload });
        return [];
      }
      return [this.build(id, payload)];
    }
    return [{ response: { id, ok: false, error: `unknown request type '${type}'` }, transfer: [] }];
  }

  /** Builds still waiting for `init`. */
  get queued(): number {
    return this.queue.length;
  }

  private build(id: number, payload: unknown): ChunkWorkerReply {
    try {
      const { cx, cz, lod } = validateBuildRequest(payload);
      const city = this.city as City;
      const data = buildChunkMesh(city, chunkLayout(city, cx, cz), lod);
      return { response: { id, ok: true, result: data }, transfer: chunkMeshTransferables(data) };
    } catch (error) {
      return { response: { id, ok: false, error: errorToString(error) }, transfer: [] };
    }
  }
}
