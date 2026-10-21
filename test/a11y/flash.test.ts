import { describe, expect, it } from 'vitest';
import { PHASE8_ACTIONS } from '../../src/a11y/audit';
import { MAX_FLASH_HZ, isReducedFlash, pulse } from '../../src/a11y/flash';
import * as a11y from '../../src/a11y/index';
import { SWATCH_TONES, layoutHint } from '../../src/ui/settingsMenu';

describe('pulse', () => {
  it('is a constant 1 when flashing is reduced', () => {
    for (const t of [0, 123, 250, 500, 750, 99999]) expect(pulse(t, true)).toBe(1);
  });

  it('is a 0..1 sine of 1 Hz otherwise', () => {
    expect(pulse(0, false)).toBeCloseTo(0.5, 6);
    expect(pulse(250, false)).toBeCloseTo(1, 6);
    expect(pulse(750, false)).toBeCloseTo(0, 6);
    expect(pulse(1000, false)).toBeCloseTo(pulse(0, false), 6);
    for (let t = 0; t < 3000; t += 37) {
      const v = pulse(t, false);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('never swings faster than the flash limit', () => {
    expect(MAX_FLASH_HZ).toBe(3);
    // Count direction changes over 10 s sampled at 1 ms: one full cycle per second -> 2 changes per second.
    let changes = 0;
    let prev = pulse(0, false);
    let dir = 0;
    for (let t = 1; t <= 10000; t++) {
      const v = pulse(t, false);
      const d = Math.sign(v - prev);
      if (d !== 0 && dir !== 0 && d !== dir) changes++;
      if (d !== 0) dir = d;
      prev = v;
    }
    expect(changes / 10 / 2).toBeLessThanOrEqual(MAX_FLASH_HZ);
  });
});

describe('isReducedFlash', () => {
  it('is false without a document (headless)', () => {
    expect(typeof document).toBe('undefined');
    expect(isReducedFlash()).toBe(false);
  });
});

describe('index and menu helpers', () => {
  it('re-exports the module API', () => {
    for (const name of ['setPaletteMode', 'paletteMode', 'semanticColor', 'lightbarRgb', 'revision', 'layoutBindings', 'ONE_HANDED_LAYOUTS', 'LEFT_KEYS', 'RIGHT_KEYS', 'pulse', 'isReducedFlash', 'MAX_FLASH_HZ', 'PHASE8_ACTIONS', 'SEMANTIC_COLORS']) {
      expect(name in a11y, name).toBe(true);
    }
    expect(a11y.PHASE8_ACTIONS).toBe(PHASE8_ACTIONS);
  });

  it('previews six swatches in the settings menu and words the layout hint as designed', () => {
    expect(SWATCH_TONES).toEqual(['unit', 'emergency', 'suspect', 'ok', 'caution', 'alert']);
    expect(layoutHint('left-hand')).toBe('Key bindings replaced by the left-hand layout (rebind any key below)');
  });
});
