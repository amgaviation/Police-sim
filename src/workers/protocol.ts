/**
 * Typed request/response protocol shared by the main-thread client and the
 * worker entry. Every request carries a correlation `id`; the worker answers
 * with exactly one response envelope per request.
 */

/** One RPC method: what the caller sends and what the worker returns. */
export interface Rpc<Req, Res> {
  request: Req;
  response: Res;
}

/** Shape every protocol map must have (a type alias so it carries an implicit index signature). */
export type ProtocolMap = Record<string, Rpc<unknown, unknown>>;

/** Methods served by `sim.worker.ts`. */
export type WorkerRequestMap = {
  /** Round-trip probe; `workerTime` is the worker's `performance.now()` at handling time. */
  ping: Rpc<{ t: number }, { t: number; workerTime: number }>;
  /** Structured-clone round trip of an arbitrary payload. */
  echo: Rpc<{ payload: unknown }, { payload: unknown }>;
  /** Draws `count` values from a fresh seeded RNG inside the worker; proves determinism across threads. */
  'rng.sample': Rpc<{ seed: number; count: number }, { values: number[] }>;
  /** Presentation-only ETA board: routes from each unit position to the target over the seed's city (generated once per seed in the worker). */
  'eta.matrix': Rpc<
    { seed: number; from: { id: string; x: number; z: number }[]; to: { x: number; z: number } },
    { rows: { id: string; lengthM: number; timeS: number }[] }
  >;
};

export type RequestType<M extends ProtocolMap> = keyof M & string;
export type RequestPayload<M extends ProtocolMap, K extends RequestType<M>> = M[K]['request'];
export type ResponseResult<M extends ProtocolMap, K extends RequestType<M>> = M[K]['response'];

/** Message sent main -> worker. */
export interface RequestEnvelope<M extends ProtocolMap, K extends RequestType<M> = RequestType<M>> {
  id: number;
  type: K;
  payload: RequestPayload<M, K>;
}

/** Message sent worker -> main. */
export type ResponseEnvelope<R = unknown> =
  | { id: number; ok: true; result: R }
  | { id: number; ok: false; error: string };

/** Most origins one `eta.matrix` request may carry. */
export const ETA_MATRIX_MAX_FROM = 64;

/** Largest `count` accepted by `rng.sample` (keeps a bad request from allocating unbounded memory). */
export const RNG_SAMPLE_MAX_COUNT = 1_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Structural check for an inbound request (payload is left to the handler to validate). */
export function isRequestEnvelope(value: unknown): value is RequestEnvelope<ProtocolMap> {
  return isRecord(value) && typeof value['id'] === 'number' && typeof value['type'] === 'string' && 'payload' in value;
}

/** Structural check for an inbound response. */
export function isResponseEnvelope(value: unknown): value is ResponseEnvelope {
  if (!isRecord(value) || typeof value['id'] !== 'number') return false;
  if (value['ok'] === true) return 'result' in value;
  if (value['ok'] === false) return typeof value['error'] === 'string';
  return false;
}

/** Normalizes a thrown value into the `error` string of a failure response. */
export function errorToString(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}
