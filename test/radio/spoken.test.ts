import { describe, expect, it } from 'vitest';
import { numberWords, toSpoken, wordCount } from '../../src/radio/spoken';

describe('toSpoken', () => {
  it.each([
    ['10-8', 'ten eight'],
    ['12, show me 10-8.', 'twelve, show me ten eight.'],
    ['10-20?', 'ten twenty?'],
    ['10-76', 'ten seventy six'],
    ['10-15 and 10-33', 'ten fifteen and ten thirty three'],
    ['Code 4', 'code four'],
    ['respond Code 3', 'respond code three'],
    ['P2', 'priority two'],
    ['Traffic hazard, P1.', 'Traffic hazard, priority one.'],
    ['ABC 1234', 'Adam, Boy, Charles, one two three four'],
    ['run XYZ 0907 now', 'run X-ray, Young, Zebra, zero nine zero seven now'],
    ['21 and 23', 'twenty one and twenty three'],
    ['Engine 4 responding', 'Engine four responding'],
  ])('%s -> %s', (text, spoken) => {
    expect(toSpoken(text)).toBe(spoken);
  });

  it('leaves addresses, dates, times and ordinals unchanged', () => {
    expect(toSpoken('1240 N Oak Street at 5th Street')).toBe('1240 N Oak Street at 5th Street');
    expect(toSpoken('DOB 06/01/1990, 14:05')).toBe('DOB 06/01/1990, 14:05');
    expect(toSpoken('Patrol')).toBe('Patrol');
  });

  it('display codes stay in the source text', () => {
    const text = '12, 10-28 on ABC 1234.';
    toSpoken(text);
    expect(text).toBe('12, 10-28 on ABC 1234.');
  });
});

describe('numberWords / wordCount', () => {
  it('spells numbers', () => {
    expect(numberWords(0)).toBe('zero');
    expect(numberWords(13)).toBe('thirteen');
    expect(numberWords(40)).toBe('forty');
    expect(numberWords(99)).toBe('ninety nine');
    expect(numberWords(108)).toBe('one oh eight');
    expect(numberWords(250)).toBe('two fifty');
  });

  it('counts words', () => {
    expect(wordCount('')).toBe(0);
    expect(wordCount('  twelve,  show me ten eight. ')).toBe(5);
  });
});
