import { describe, expect, it } from 'vitest';
import { parseConsoleValue } from '../../src/game/commands';

describe('parseConsoleValue', () => {
  it('parses JSON scalars', () => {
    expect(parseConsoleValue('90')).toBe(90);
    expect(parseConsoleValue('true')).toBe(true);
    expect(parseConsoleValue('null')).toBeNull();
    expect(parseConsoleValue('0.5')).toBe(0.5);
  });

  it('falls back to the raw text for enum-like values', () => {
    expect(parseConsoleValue('high')).toBe('high');
    expect(parseConsoleValue('')).toBe('');
  });
});
