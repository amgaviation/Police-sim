import type { Rpc } from '../../workers/protocol';
import { MAX_CHUNK, MIN_CHUNK } from '../constants';
import type { ChunkMeshData } from './chunkMesher';

/** Methods served by `chunk.worker.ts`. */
export type ChunkWorkerMap = {
  /** Generates the city for `seed` inside the worker; builds sent earlier wait for it. */
  init: Rpc<{ seed: number }, { ok: true }>;
  /** Meshes one chunk at one LOD; buffers come back as transferables. */
  build: Rpc<{ cx: number; cz: number; lod: 0 | 1 }, ChunkMeshData>;
};

export type InitRequest = ChunkWorkerMap['init']['request'];
export type BuildRequest = ChunkWorkerMap['build']['request'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isChunkCoord(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_CHUNK && value <= MAX_CHUNK;
}

/** Throws a TypeError naming the bad field unless `payload` is a valid init request. */
export function validateInitRequest(payload: unknown): InitRequest {
  if (!isRecord(payload) || typeof payload['seed'] !== 'number' || !Number.isFinite(payload['seed'])) {
    throw new TypeError('init: seed must be a finite number');
  }
  return { seed: payload['seed'] };
}

/** Throws a TypeError/RangeError naming the bad field unless `payload` is a valid build request. */
export function validateBuildRequest(payload: unknown): BuildRequest {
  if (!isRecord(payload)) throw new TypeError('build: payload must be an object');
  const { cx, cz, lod } = payload;
  if (!isChunkCoord(cx)) throw new RangeError(`build: cx must be an integer in [${MIN_CHUNK}, ${MAX_CHUNK}]`);
  if (!isChunkCoord(cz)) throw new RangeError(`build: cz must be an integer in [${MIN_CHUNK}, ${MAX_CHUNK}]`);
  if (lod !== 0 && lod !== 1) throw new RangeError('build: lod must be 0 or 1');
  return { cx, cz, lod };
}
