/**
 * Simulation worker entry (Phase 0 placeholder). Serves the methods declared
 * in `WorkerRequestMap`; every handler error becomes an error response so the
 * caller's promise always settles. Must stay free of DOM-dependent imports.
 */
import { createRng } from '../core/rng';
import { generateCity } from '../world/generate';
import type { City } from '../world/city';
import {
  errorToString,
  ETA_MATRIX_MAX_FROM,
  isRequestEnvelope,
  RNG_SAMPLE_MAX_COUNT,
  type RequestPayload,
  type RequestType,
  type ResponseEnvelope,
  type ResponseResult,
  type WorkerRequestMap,
} from './protocol';

/** The part of DedicatedWorkerGlobalScope this entry uses (the project compiles against lib DOM, not WebWorker). */
interface WorkerScope {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

/** Cities generated for `eta.matrix`, keyed by seed (a session uses one seed; the cache stays tiny). */
const etaCities = new Map<number, City>();
const MAX_CACHED_CITIES = 2;

function etaCity(seed: number): City {
  let city = etaCities.get(seed);
  if (!city) {
    if (etaCities.size >= MAX_CACHED_CITIES) etaCities.clear();
    city = generateCity(seed);
    etaCities.set(seed, city);
  }
  return city;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * `eta.matrix`: road routes from every origin to the target over the seed's city. Rows without a route are
 * skipped. Exported so tests can call it without the worker runtime.
 */
export function handleEtaMatrix(payload: RequestPayload<WorkerRequestMap, 'eta.matrix'>): ResponseResult<WorkerRequestMap, 'eta.matrix'> {
  const { seed, from, to } = payload;
  if (!isFiniteNumber(seed)) throw new TypeError('eta.matrix: seed must be a finite number');
  if (!Array.isArray(from) || from.length > ETA_MATRIX_MAX_FROM) {
    throw new RangeError(`eta.matrix: from must be an array of at most ${ETA_MATRIX_MAX_FROM} origins`);
  }
  if (typeof to !== 'object' || to === null || !isFiniteNumber(to.x) || !isFiniteNumber(to.z)) {
    throw new TypeError('eta.matrix: to must be { x, z } with finite numbers');
  }
  for (const f of from) {
    if (typeof f !== 'object' || f === null || typeof f.id !== 'string' || !isFiniteNumber(f.x) || !isFiniteNumber(f.z)) {
      throw new TypeError('eta.matrix: every origin must be { id, x, z } with finite numbers');
    }
  }
  const graph = etaCity(seed).graph;
  const rows: { id: string; lengthM: number; timeS: number }[] = [];
  for (const f of from) {
    const route = graph.routeBetweenPoints(f.x, f.z, to.x, to.z);
    if (route) rows.push({ id: f.id, lengthM: route.length, timeS: route.time });
  }
  return { rows };
}

type Handlers = {
  [K in RequestType<WorkerRequestMap>]: (
    payload: RequestPayload<WorkerRequestMap, K>,
  ) => ResponseResult<WorkerRequestMap, K>;
};

const handlers: Handlers = {
  ping: ({ t }) => ({ t, workerTime: performance.now() }),

  echo: ({ payload }) => ({ payload }),

  'rng.sample': ({ seed, count }) => {
    if (typeof seed !== 'number') throw new TypeError('rng.sample: seed must be a number');
    if (!Number.isInteger(count) || count < 0 || count > RNG_SAMPLE_MAX_COUNT) {
      throw new RangeError(`rng.sample: count must be an integer in [0, ${RNG_SAMPLE_MAX_COUNT}]`);
    }
    const rng = createRng(seed);
    const values = new Array<number>(count);
    for (let i = 0; i < count; i++) values[i] = rng.next();
    return { values };
  },

  'eta.matrix': handleEtaMatrix,
};

function isKnownType(type: string): type is RequestType<WorkerRequestMap> {
  return Object.prototype.hasOwnProperty.call(handlers, type);
}

/** Runs one request through its handler and returns the response to post back. */
function dispatch(message: unknown): ResponseEnvelope | null {
  if (!isRequestEnvelope(message)) return null;
  const { id, type } = message;
  if (!isKnownType(type)) return { id, ok: false, error: `unknown request type '${type}'` };
  try {
    // The envelope guard only checks structure; the handler validates its own payload.
    const handler = handlers[type] as (payload: unknown) => unknown;
    return { id, ok: true, result: handler(message.payload) };
  } catch (error) {
    return { id, ok: false, error: errorToString(error) };
  }
}

// `self` does not exist outside a worker (node tests import this file for `handleEtaMatrix`).
if (typeof self !== 'undefined') {
  const scope = self as unknown as WorkerScope;
  scope.onmessage = (event: MessageEvent) => {
    const response = dispatch(event.data);
    if (response) scope.postMessage(response);
  };
}
