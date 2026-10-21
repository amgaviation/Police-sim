import palettesJson from '../data/a11y/palettes.json';
import { SEGMENT_COLOR } from '../police/lightbar';
import { fail, readArray, readNumber, readObject, readVersion } from '../vehicles/json';

/**
 * Colour-vision palettes (design §9.1). Presentation only: nothing here feeds the simulation. The mode is a
 * module-level value set by the integrator from `accessibility.colorblind`; lookups never allocate.
 */

/** Same union as the settings `ColorblindMode`. */
export const PALETTE_MODES = ['none', 'protanopia', 'deuteranopia', 'tritanopia'] as const;
export type PaletteMode = (typeof PALETTE_MODES)[number];

/** Semantic colour keys every mode defines (hex strings). */
export const SEMANTIC_COLORS = [
  'unit',
  'unitBusy',
  'emergency',
  'suspect',
  'pursuit',
  'person',
  'ok',
  'caution',
  'alert',
  'accent',
  'accent2',
  'p1',
  'p2',
  'p3',
  'p4',
] as const;
export type SemanticColor = (typeof SEMANTIC_COLORS)[number];

/** Light-bar lens colour names in a palette file. */
export const LIGHTBAR_COLORS = ['red', 'blue', 'white', 'amber'] as const;
export type LightbarColorName = (typeof LIGHTBAR_COLORS)[number];

/** One parsed mode: hex per semantic key plus the light-bar RGB table. */
export interface Palette {
  readonly colors: Readonly<Record<SemanticColor, string>>;
  /** Linear RGB by `SEGMENT_COLOR` index, 3 floats each (index 0, off, is black). */
  readonly lightbar: Float32Array;
}

const FILE = 'palettes.json';
const HEX = /^#[0-9a-fA-F]{6}$/;

/** Validates `palettes.json`; throws an Error naming the file and the dotted path. */
export function parsePalettes(json: unknown, file: string = FILE): Readonly<Record<PaletteMode, Palette>> {
  const root = readObject(json, file, '');
  readVersion(root, file);
  const modes = readObject(root.modes, file, 'modes');
  const out = {} as Record<PaletteMode, Palette>;
  for (const mode of PALETTE_MODES) {
    const path = `modes.${mode}`;
    const m = readObject(modes[mode], file, path);
    const colors = {} as Record<SemanticColor, string>;
    for (const key of SEMANTIC_COLORS) {
      const value = m[key];
      if (typeof value !== 'string' || !HEX.test(value)) fail(file, `${path}.${key}`, `must be a "#rrggbb" colour, got ${JSON.stringify(value)}`);
      colors[key] = value.toLowerCase();
    }
    const bar = readObject(m.lightbar, file, `${path}.lightbar`);
    const lightbar = new Float32Array((SEGMENT_COLOR.amber + 1) * 3);
    for (const name of LIGHTBAR_COLORS) {
      const rgb = readArray(bar[name], file, `${path}.lightbar.${name}`, 3);
      if (rgb.length !== 3) fail(file, `${path}.lightbar.${name}`, `must have 3 components, got ${rgb.length}`);
      const index = SEGMENT_COLOR[name];
      for (let c = 0; c < 3; c++) lightbar[index * 3 + c] = readNumber(rgb[c], file, `${path}.lightbar.${name}[${c}]`, 0, 1);
    }
    out[mode] = { colors, lightbar };
  }
  return out;
}

/** Parsed `palettes.json`. */
export const PALETTES: Readonly<Record<PaletteMode, Palette>> = parsePalettes(palettesJson);

let current: PaletteMode = 'none';
let currentPalette: Palette = PALETTES.none;
let rev = 0;

/** Selects the palette every lookup uses; bumps `revision()` when the mode changes. */
export function setPaletteMode(mode: PaletteMode): void {
  if (mode === current) return;
  current = mode;
  currentPalette = PALETTES[mode];
  rev++;
}

export function paletteMode(): PaletteMode {
  return current;
}

/** `'#rrggbb'` of a semantic colour in the active mode. */
export function semanticColor(key: SemanticColor): string {
  return currentPalette.colors[key];
}

/**
 * Writes the linear light-bar RGB of a `SEGMENT_COLOR` index (0, off, and unknown indices give 0, 0, 0) at
 * `out[offset..offset + 2]` and returns `out`. Allocation-free.
 */
export function lightbarRgb(segment: number, out: Float32Array | number[], offset = 0): Float32Array | number[] {
  const table = currentPalette.lightbar;
  const base = Number.isInteger(segment) && segment > 0 && segment <= SEGMENT_COLOR.amber ? segment * 3 : -1;
  out[offset] = base < 0 ? 0 : (table[base] ?? 0);
  out[offset + 1] = base < 0 ? 0 : (table[base + 1] ?? 0);
  out[offset + 2] = base < 0 ? 0 : (table[base + 2] ?? 0);
  return out;
}

/** Bumps whenever the mode changes: canvas painters repaint when it differs from the value they last drew with. */
export function revision(): number {
  return rev;
}
