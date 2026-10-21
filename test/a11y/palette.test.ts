import { afterEach, describe, expect, it } from 'vitest';
import {
  LIGHTBAR_COLORS,
  PALETTES,
  PALETTE_MODES,
  SEMANTIC_COLORS,
  lightbarRgb,
  paletteMode,
  parsePalettes,
  revision,
  semanticColor,
  setPaletteMode,
  type PaletteMode,
} from '../../src/a11y/palette';
import palettesJson from '../../src/data/a11y/palettes.json';
import { SEGMENT_COLOR } from '../../src/police/lightbar';

afterEach(() => setPaletteMode('none'));

describe('palettes.json', () => {
  it('defines every semantic key as a valid hex colour in every mode', () => {
    expect(PALETTE_MODES).toEqual(['none', 'protanopia', 'deuteranopia', 'tritanopia']);
    expect(SEMANTIC_COLORS).toEqual(['unit', 'unitBusy', 'emergency', 'suspect', 'pursuit', 'person', 'ok', 'caution', 'alert', 'accent', 'accent2', 'p1', 'p2', 'p3', 'p4']);
    for (const mode of PALETTE_MODES) {
      for (const key of SEMANTIC_COLORS) expect(PALETTES[mode].colors[key], `${mode}.${key}`).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('matches the design table for the none and protanopia modes', () => {
    const none = PALETTES.none.colors;
    expect([none.unit, none.unitBusy, none.emergency, none.suspect, none.pursuit]).toEqual(['#4f8cff', '#3d68b8', '#ff3b3b', '#ff3b3b', '#ff7a1a']);
    expect([none.person, none.ok, none.caution, none.alert, none.accent, none.accent2]).toEqual(['#ffffff', '#5fd35f', '#ffcc66', '#ff5a5a', '#3b9eff', '#ff3b5c']);
    expect([none.p1, none.p2, none.p3, none.p4]).toEqual(['#ff5a5a', '#ff9f40', '#ffcc66', '#8fa3b5']);
    const pro = PALETTES.protanopia.colors;
    expect([pro.unit, pro.unitBusy, pro.emergency, pro.suspect, pro.pursuit]).toEqual(['#0072b2', '#5b7fa6', '#ffb000', '#e69f00', '#f0e442']);
    expect([pro.ok, pro.caution, pro.alert, pro.accent2]).toEqual(['#56b4e9', '#f0e442', '#ffb000', '#ffb000']);
    expect([pro.p1, pro.p2, pro.p3, pro.p4]).toEqual(['#ffb000', '#f0e442', '#56b4e9', '#8fa3b5']);
  });

  it('matches the design table for tritanopia and repeats protanopia for deuteranopia', () => {
    const tri = PALETTES.tritanopia.colors;
    expect([tri.suspect, tri.ok, tri.caution, tri.alert]).toEqual(['#ff3b8a', '#00c2a0', '#ffd0e0', '#ff2e2e']);
    expect([tri.p1, tri.p2, tri.p3, tri.p4]).toEqual(['#ff2e2e', '#ff8fb0', '#00c2a0', '#8fa3b5']);
    expect(PALETTES.deuteranopia).toEqual(PALETTES.protanopia);
  });

  it('keeps the light-bar colours of the design per mode', () => {
    const table = (mode: PaletteMode): number[][] =>
      LIGHTBAR_COLORS.map((name) => {
        setPaletteMode(mode);
        return Array.from(lightbarRgb(SEGMENT_COLOR[name], new Float32Array(3)));
      });
    const expectRows = (mode: PaletteMode, rows: number[][]): void => {
      const got = table(mode);
      got.forEach((row, i) => row.forEach((v, c) => expect(v, `${mode} ${LIGHTBAR_COLORS[i] ?? ''}[${String(c)}]`).toBeCloseTo(rows[i]?.[c] ?? NaN, 5)));
    };
    // order: red, blue, white, amber
    expectRows('none', [[1, 0.05, 0.05], [0.05, 0.15, 1], [1, 1, 1], [1, 0.55, 0.05]]);
    expectRows('protanopia', [[1, 0.6, 0], [0.05, 0.3, 1], [1, 1, 1], [1, 0.55, 0.05]]);
    expectRows('deuteranopia', [[1, 0.6, 0], [0.05, 0.3, 1], [1, 1, 1], [1, 0.55, 0.05]]);
    expectRows('tritanopia', [[1, 0.05, 0.05], [0.2, 1, 1], [1, 1, 1], [1, 0.55, 0.05]]);
  });
});

describe('mode and lookups', () => {
  it('defaults to none and switches the semantic colours', () => {
    expect(paletteMode()).toBe('none');
    expect(semanticColor('emergency')).toBe('#ff3b3b');
    setPaletteMode('protanopia');
    expect(paletteMode()).toBe('protanopia');
    expect(semanticColor('emergency')).toBe('#ffb000');
    setPaletteMode('tritanopia');
    expect(semanticColor('ok')).toBe('#00c2a0');
  });

  it('bumps the revision only when the mode actually changes', () => {
    const r0 = revision();
    setPaletteMode('none');
    expect(revision()).toBe(r0);
    setPaletteMode('deuteranopia');
    expect(revision()).toBe(r0 + 1);
    setPaletteMode('deuteranopia');
    expect(revision()).toBe(r0 + 1);
    setPaletteMode('none');
    expect(revision()).toBe(r0 + 2);
  });

  it('writes light-bar rgb at an offset into a typed array or a plain array and returns it', () => {
    const buf = new Float32Array(9).fill(-1);
    expect(lightbarRgb(SEGMENT_COLOR.blue, buf, 3)).toBe(buf);
    expect(buf[0]).toBe(-1);
    expect(buf[3]).toBeCloseTo(0.05);
    expect(buf[4]).toBeCloseTo(0.15);
    expect(buf[5]).toBeCloseTo(1);
    expect(buf[6]).toBe(-1);
    const arr: number[] = [];
    expect(lightbarRgb(SEGMENT_COLOR.white, arr)).toBe(arr);
    expect(arr).toEqual([1, 1, 1]);
  });

  it('turns off and unknown segments black', () => {
    for (const segment of [SEGMENT_COLOR.off, 5, -1, 1.5, Number.NaN, 99]) {
      expect(Array.from(lightbarRgb(segment, new Float32Array([7, 7, 7]))), String(segment)).toEqual([0, 0, 0]);
    }
  });

  it('keeps every lit light-bar colour bright enough to read in every mode', () => {
    for (const mode of PALETTE_MODES) {
      setPaletteMode(mode);
      for (const segment of [SEGMENT_COLOR.red, SEGMENT_COLOR.blue, SEGMENT_COLOR.white, SEGMENT_COLOR.amber]) {
        const rgb = lightbarRgb(segment, new Float32Array(3));
        expect(Math.max(...Array.from(rgb)), `${mode} ${String(segment)}`).toBe(1);
      }
    }
  });

  it('keeps red and blue distinguishable for red-green colour blindness (red turns amber)', () => {
    setPaletteMode('protanopia');
    const red = lightbarRgb(SEGMENT_COLOR.red, new Float32Array(3));
    const blue = lightbarRgb(SEGMENT_COLOR.blue, new Float32Array(3));
    expect(red[1] ?? 0).toBeGreaterThan(0.5);
    expect(blue[2] ?? 0).toBeGreaterThan(red[2] ?? 1);
  });
});

describe('parsePalettes', () => {
  const clone = (): { version: number; modes: Record<string, Record<string, unknown>> } =>
    JSON.parse(JSON.stringify(palettesJson)) as { version: number; modes: Record<string, Record<string, unknown>> };

  it('accepts the shipped file', () => {
    expect(() => parsePalettes(palettesJson)).not.toThrow();
  });

  it('names the file and path of a bad colour, a missing key, a missing mode and a bad light-bar value', () => {
    const bad = clone();
    bad.modes['tritanopia']!['ok'] = 'green';
    expect(() => parsePalettes(bad)).toThrow(/palettes\.json: modes\.tritanopia\.ok must be a "#rrggbb" colour/);
    const missing = clone();
    delete missing.modes['none']!['alert'];
    expect(() => parsePalettes(missing)).toThrow(/modes\.none\.alert/);
    const noMode = clone();
    delete noMode.modes['protanopia'];
    expect(() => parsePalettes(noMode)).toThrow(/modes\.protanopia must be an object/);
    const bar = clone();
    (bar.modes['none']!['lightbar'] as Record<string, unknown>)['red'] = [1, 2, 0];
    expect(() => parsePalettes(bar)).toThrow(/modes\.none\.lightbar\.red\[1\] must be in \[0, 1\]/);
    const short = clone();
    (short.modes['none']!['lightbar'] as Record<string, unknown>)['blue'] = [1, 0];
    expect(() => parsePalettes(short)).toThrow(/lightbar\.blue/);
  });

  it('rejects another version', () => {
    const bad = clone();
    bad.version = 2;
    expect(() => parsePalettes(bad)).toThrow(/palettes\.json: version must be 1/);
  });
});
