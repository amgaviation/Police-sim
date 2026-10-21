import { describe, expect, it } from 'vitest';
import { isArrayOf, isBool, isCadTime, isInt, isIntArray, isNullOr, isNum, isObj, isOneOf, isStr, isStrArray } from '../../src/cad/guards';

/** The structural guards every CAD save validator is built from. */

const SAMPLES: Readonly<Record<string, unknown>> = {
  object: { a: 1 }, emptyObject: {}, array: [1, 2], emptyArray: [], string: 'text', emptyString: '', zero: 0, one: 1, negative: -3, float: 1.5,
  nan: Number.NaN, infinity: Infinity, negInfinity: -Infinity, true: true, false: false, null: null, undefined, bigint: 10n, fn: () => 1, date: new Date(0),
};

function accepted(guard: (x: unknown) => boolean): string[] {
  return Object.keys(SAMPLES).filter((k) => guard(SAMPLES[k]));
}

describe('primitive guards', () => {
  it('isObj accepts plain objects (class instances included) and nothing else', () => {
    expect(accepted(isObj)).toEqual(['object', 'emptyObject', 'date']);
  });

  it('isNum accepts finite numbers only', () => {
    expect(accepted(isNum)).toEqual(['zero', 'one', 'negative', 'float']);
  });

  it('isInt accepts integers, optionally from a minimum', () => {
    expect(accepted((x) => isInt(x))).toEqual(['zero', 'one', 'negative']);
    expect(accepted((x) => isInt(x, 0))).toEqual(['zero', 'one']);
    expect(accepted((x) => isInt(x, 1))).toEqual(['one']);
    expect(isInt(-1, -1)).toBe(true);
    expect(isInt(-2, -1)).toBe(false);
    expect(isInt(2 ** 53)).toBe(true);
    expect(isInt('3')).toBe(false);
  });

  it('isStr accepts every string, the empty one included', () => {
    expect(accepted(isStr)).toEqual(['string', 'emptyString']);
  });

  it('isBool accepts true and false only', () => {
    expect(accepted(isBool)).toEqual(['true', 'false']);
  });

  it('isOneOf accepts the listed strings only', () => {
    const colours = ['red', 'green'] as const;
    expect(isOneOf('red', colours)).toBe(true);
    expect(isOneOf('green', colours)).toBe(true);
    expect(isOneOf('blue', colours)).toBe(false);
    expect(isOneOf('Red', colours)).toBe(false);
    expect(isOneOf(1, colours)).toBe(false);
    expect(isOneOf(null, colours)).toBe(false);
    expect(isOneOf('toString', colours)).toBe(false);
    expect(isOneOf('red', [])).toBe(false);
  });
});

describe('composite guards', () => {
  it('isArrayOf checks every item with the item guard', () => {
    expect(isArrayOf([], isStr)).toBe(true);
    expect(isArrayOf(['a', 'b'], isStr)).toBe(true);
    expect(isArrayOf(['a', 1], isStr)).toBe(false);
    expect(isArrayOf('ab', isStr)).toBe(false);
    expect(isArrayOf({ length: 0 }, isStr)).toBe(false);
    expect(isArrayOf([{ a: 1 }, {}], isObj)).toBe(true);
    expect(isArrayOf([[]], isObj)).toBe(false);
  });

  it('isStrArray and isIntArray are the string and integer lists', () => {
    expect(isStrArray([])).toBe(true);
    expect(isStrArray(['', 'x'])).toBe(true);
    expect(isStrArray([1])).toBe(false);
    expect(isStrArray(null)).toBe(false);
    expect(isIntArray([])).toBe(true);
    expect(isIntArray([0, -1, 7])).toBe(true);
    expect(isIntArray([1.5])).toBe(false);
    expect(isIntArray(['1'])).toBe(false);
    expect(isIntArray(undefined)).toBe(false);
  });

  it('isCadTime needs finite sim and game seconds', () => {
    expect(isCadTime({ sim: 0, game: 0 })).toBe(true);
    expect(isCadTime({ sim: 12.5, game: 50400 })).toBe(true);
    expect(isCadTime({ sim: 1 })).toBe(false);
    expect(isCadTime({ game: 1 })).toBe(false);
    expect(isCadTime({ sim: '1', game: 1 })).toBe(false);
    expect(isCadTime({ sim: Number.NaN, game: 1 })).toBe(false);
    expect(isCadTime({ sim: 1, game: Infinity })).toBe(false);
    expect(isCadTime(null)).toBe(false);
    expect(isCadTime([0, 0])).toBe(false);
  });

  it('isNullOr accepts null or whatever the guard accepts', () => {
    expect(isNullOr(null, isStr)).toBe(true);
    expect(isNullOr('x', isStr)).toBe(true);
    expect(isNullOr(undefined, isStr)).toBe(false);
    expect(isNullOr(3, isStr)).toBe(false);
    expect(isNullOr({ sim: 1, game: 2 }, isCadTime)).toBe(true);
    expect(isNullOr({ sim: 1 }, isCadTime)).toBe(false);
  });
});
