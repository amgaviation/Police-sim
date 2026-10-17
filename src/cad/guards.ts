/** Structural type guards shared by the CAD save validators. */
import type { CadTime } from './types';

export type Obj = Record<string, unknown>;

export function isObj(x: unknown): x is Obj {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export function isNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

export function isInt(x: unknown, min = -Infinity): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= min;
}

export function isStr(x: unknown): x is string {
  return typeof x === 'string';
}

export function isBool(x: unknown): x is boolean {
  return typeof x === 'boolean';
}

export function isOneOf<T extends string>(x: unknown, options: readonly T[]): x is T {
  return typeof x === 'string' && (options as readonly string[]).includes(x);
}

export function isArrayOf<T>(x: unknown, item: (v: unknown) => v is T): x is T[] {
  return Array.isArray(x) && x.every((v) => item(v));
}

export function isStrArray(x: unknown): x is string[] {
  return isArrayOf(x, isStr);
}

export function isIntArray(x: unknown): x is number[] {
  return Array.isArray(x) && x.every((v) => isInt(v));
}

export function isCadTime(x: unknown): x is CadTime {
  return isObj(x) && isNum(x.sim) && isNum(x.game);
}

export function isNullOr<T>(x: unknown, guard: (v: unknown) => v is T): x is T | null {
  return x === null || guard(x);
}
