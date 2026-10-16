/**
 * Simulation worker entry (Phase 0 placeholder). Serves the methods declared
 * in `WorkerRequestMap`; every handler error becomes an error response so the
 * caller's promise always settles. Must stay free of DOM-dependent imports.
 */
import { createRng } from '../core/rng';
import {
  errorToString,
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

const scope = self as unknown as WorkerScope;

scope.onmessage = (event: MessageEvent) => {
  const response = dispatch(event.data);
  if (response) scope.postMessage(response);
};
