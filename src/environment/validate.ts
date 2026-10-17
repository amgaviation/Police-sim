/**
 * Small typed readers for the environment data files. Every failure throws an
 * Error naming the file and the dotted field path, e.g.
 * `sky.json: keyframes[2].skyTop must be a "#rrggbb" colour, got "red"`.
 */

export type JsonObject = Record<string, unknown>;

export function fail(file: string, path: string, message: string): never {
  throw new Error(`${file}: ${path === '' ? '' : `${path} `}${message}`);
}

function describe(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

export function readObject(value: unknown, file: string, path: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(file, path, `must be an object, got ${describe(value)}`);
  }
  return value as JsonObject;
}

export function readNumber(value: unknown, file: string, path: string, min = -Infinity, max = Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(file, path, `must be a finite number, got ${describe(value)}`);
  if (value < min || value > max) fail(file, path, `must be in [${min}, ${max}], got ${value}`);
  return value;
}

export function readInt(value: unknown, file: string, path: string, min: number, max: number): number {
  const n = readNumber(value, file, path, min, max);
  if (!Number.isInteger(n)) fail(file, path, `must be an integer, got ${n}`);
  return n;
}

export function readString(value: unknown, file: string, path: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(file, path, `must be a non-empty string, got ${describe(value)}`);
  return value;
}

/** `"#rrggbb"` -> 0xRRGGBB. */
export function readColor(value: unknown, file: string, path: string): number {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    fail(file, path, `must be a "#rrggbb" colour, got ${describe(value)}`);
  }
  return parseInt(value.slice(1), 16);
}

/** Array of finite numbers in [min, max], of exactly `length` items when given. */
export function readNumberArray(
  value: unknown,
  file: string,
  path: string,
  length?: number,
  min = -Infinity,
  max = Infinity,
): number[] {
  if (!Array.isArray(value)) fail(file, path, `must be an array, got ${describe(value)}`);
  if (length !== undefined && value.length !== length) fail(file, path, `must have ${length} items, got ${value.length}`);
  return value.map((item, i) => readNumber(item, file, `${path}[${i}]`, min, max));
}

/** `[lo, hi]` with lo <= hi, both in [min, max]. */
export function readRange(value: unknown, file: string, path: string, min: number, max: number): [number, number] {
  const [lo = 0, hi = 0] = readNumberArray(value, file, path, 2, min, max);
  if (lo > hi) fail(file, path, `must be [min, max] with min <= max, got [${lo}, ${hi}]`);
  return [lo, hi];
}

export function readVersion(root: JsonObject, file: string): void {
  if (root.version !== 1) fail(file, 'version', `must be 1, got ${describe(root.version)}`);
}

/** Throws when `obj` has a key outside `allowed` (catches typos in names). */
export function rejectUnknownKeys(obj: JsonObject, allowed: readonly string[], file: string, path: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(file, path === '' ? key : `${path}.${key}`, `is not one of: ${allowed.join(', ')}`);
  }
}
