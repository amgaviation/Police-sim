/**
 * Small typed readers for the vehicle data files. Every failure throws an Error naming the
 * source file and the dotted field path, e.g. `patrol_sedan.json: brakes.frontBias must be in [0, 1], got 1.4`.
 */

export type JsonObject = Record<string, unknown>;

export function fail(source: string, path: string, message: string): never {
  throw new Error(`${source}: ${path === '' ? '' : `${path} `}${message}`);
}

function show(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

export function readObject(value: unknown, source: string, path: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(source, path, `must be an object, got ${show(value)}`);
  }
  return value as JsonObject;
}

export function readNumber(value: unknown, source: string, path: string, min = -Infinity, max = Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(source, path, `must be a finite number, got ${show(value)}`);
  if (value < min || value > max) fail(source, path, `must be in [${min}, ${max}], got ${value}`);
  return value;
}

export function readBoolean(value: unknown, source: string, path: string): boolean {
  if (typeof value !== 'boolean') fail(source, path, `must be true or false, got ${show(value)}`);
  return value;
}

export function readString(value: unknown, source: string, path: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(source, path, `must be a non-empty string, got ${show(value)}`);
  return value;
}

export function readOneOf<T extends string>(value: unknown, options: readonly T[], source: string, path: string): T {
  if (typeof value !== 'string' || !(options as readonly string[]).includes(value)) {
    fail(source, path, `must be one of ${options.join(', ')}, got ${show(value)}`);
  }
  return value as T;
}

export function readArray(value: unknown, source: string, path: string, minLength = 0): unknown[] {
  if (!Array.isArray(value)) fail(source, path, `must be an array, got ${show(value)}`);
  if (value.length < minLength) fail(source, path, `must have at least ${minLength} items, got ${value.length}`);
  return value;
}

/** `"#rrggbb"` -> 0xRRGGBB. */
export function readColor(value: unknown, source: string, path: string): number {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    fail(source, path, `must be a "#rrggbb" colour, got ${show(value)}`);
  }
  return parseInt(value.slice(1), 16);
}

export function readVersion(root: JsonObject, source: string): void {
  if (root.version !== 1) fail(source, 'version', `must be 1, got ${show(root.version)}`);
}
