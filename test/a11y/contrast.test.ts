import { describe, expect, it } from 'vitest';
import { contrastRatio, parseHex, relativeLuminance } from '../../src/a11y/contrast';

describe('relativeLuminance', () => {
  it('is 0 for black and 1 for white', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 10);
  });

  it('accepts #rgb shorthand and any case', () => {
    expect(relativeLuminance('#FFF')).toBeCloseTo(1, 10);
    expect(relativeLuminance('#abc')).toBeCloseTo(relativeLuminance('#aabbcc'), 12);
    expect(relativeLuminance('#AABBCC')).toBeCloseTo(relativeLuminance('#aabbcc'), 12);
  });

  it('weights green most and blue least (WCAG coefficients)', () => {
    expect(relativeLuminance('#ff0000')).toBeCloseTo(0.2126, 4);
    expect(relativeLuminance('#00ff00')).toBeCloseTo(0.7152, 4);
    expect(relativeLuminance('#0000ff')).toBeCloseTo(0.0722, 4);
  });

  it('uses the linear segment below the 0.03928 threshold', () => {
    // 10 / 255 = 0.0392 -> linear segment: 10 / 255 / 12.92
    expect(relativeLuminance('#0a0a0a')).toBeCloseTo(10 / 255 / 12.92, 6);
  });

  it('rejects anything that is not a hex colour', () => {
    for (const bad of ['red', '#12', '#12345', '#ggg', 'rgb(0,0,0)', '', '#1234567']) expect(() => relativeLuminance(bad), bad).toThrow(/colour/);
  });
});

describe('contrastRatio', () => {
  it('is 21 for black on white and 1 for equal colours', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 10);
    expect(contrastRatio('#336699', '#336699')).toBeCloseTo(1, 10);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#ff0000', '#00ff00')).toBeCloseTo(contrastRatio('#00ff00', '#ff0000'), 12);
  });

  it('matches the well-known #777 on white value of about 4.48', () => {
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    expect(contrastRatio('#777', '#fff')).toBeCloseTo(4.48, 2);
    // #767676 is the lightest grey that reaches 4.5:1 on white
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#787878', '#ffffff')).toBeLessThan(4.5);
  });

  it('is always between 1 and 21', () => {
    const samples = ['#000', '#123456', '#ff3b3b', '#5fd35f', '#ffcc66', '#dfe7ee', '#fff'];
    for (const a of samples) for (const b of samples) expect(contrastRatio(a, b)).toBeGreaterThanOrEqual(1);
    for (const a of samples) for (const b of samples) expect(contrastRatio(a, b)).toBeLessThanOrEqual(21 + 1e-9);
  });
});

describe('parseHex', () => {
  it('returns the 8-bit components', () => {
    expect(parseHex('#ff8000')).toEqual([255, 128, 0]);
    expect(parseHex('#f80')).toEqual([255, 136, 0]);
  });
});
