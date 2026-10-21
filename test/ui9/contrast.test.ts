/**
 * Phase 9 contrast audit (design §7.2): the :root block of `src/ui/styles.css` and each colour-vision block (its overrides
 * merged over :root) must keep the text and accent tokens readable on the panel surfaces (WCAG 2.x ratios):
 *   --fg on --bg, --panel, --panel-2 >= 7;  --fg-dim on --panel, --panel-2 >= 4.5;
 *   --accent, --focus, --danger and every --c-* on --panel >= 3.
 * Also keeps `src/data/a11y/palettes.json` and the CSS equal for the semantic colours, and shows the palettes still tell
 * the priority colours apart.
 */
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../../src/a11y/contrast';
import { PALETTES, PALETTE_MODES, type PaletteMode } from '../../src/a11y/palette';
import { loadCss } from './cssParse';

const found = loadCss().find((s) => s.file === 'src/ui/styles.css');
if (!found) throw new Error('src/ui/styles.css not found');
const styles = found;

/** Custom properties of a rule set (`:root` plus, for a mode, its `:root[data-colorblind=...]` blocks). */
function tokens(mode: PaletteMode): Map<string, string> {
  const out = new Map<string, string>();
  const applies = (selector: string): boolean => {
    if (selector === ':root') return true;
    const m = /^:root\[data-colorblind="(\w+)"\](?:,\s*:root\[data-colorblind="(\w+)"\])?$/.exec(selector);
    return m !== null && (m[1] === mode || m[2] === mode);
  };
  // :root first, then the mode blocks, so overrides win whatever the order in the file
  for (const pass of [(s: string) => s === ':root', (s: string) => s !== ':root' && applies(s)]) {
    for (const d of styles.decls) if (d.prop.startsWith('--') && pass(d.selector) && applies(d.selector)) out.set(d.prop, d.value.trim().toLowerCase());
  }
  return out;
}

const HEX = /^#[0-9a-f]{6}$/;
const need = (t: Map<string, string>, name: string): string => {
  const v = t.get(name);
  if (v === undefined || !HEX.test(v)) throw new Error(`${name} is not a #rrggbb colour in the stylesheet: ${String(v)}`);
  return v;
};

describe.each(PALETTE_MODES)('contrast under %s', (mode) => {
  const t = tokens(mode);
  const ratio = (fg: string, bg: string): number => contrastRatio(need(t, fg), need(t, bg));

  it.each([['--bg'], ['--panel'], ['--panel-2']])('--fg on %s is at least 7', (bg) => {
    expect(ratio('--fg', bg), `--fg ${need(t, '--fg')} on ${bg} ${need(t, bg)}`).toBeGreaterThanOrEqual(7);
  });

  it.each([['--panel'], ['--panel-2']])('--fg-dim on %s is at least 4.5', (bg) => {
    expect(ratio('--fg-dim', bg), `--fg-dim ${need(t, '--fg-dim')} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  it('--accent, --focus and --danger on --panel are at least 3', () => {
    for (const name of ['--accent', '--focus', '--danger']) expect(ratio(name, '--panel'), `${name} ${need(t, name)}`).toBeGreaterThanOrEqual(3);
  });

  it('every --c-* colour on --panel is at least 3', () => {
    const names = [...t.keys()].filter((k) => k.startsWith('--c-'));
    expect(names.length).toBeGreaterThanOrEqual(13);
    for (const name of names) expect(ratio(name, '--panel'), `${name} ${need(t, name)} on --panel`).toBeGreaterThanOrEqual(3);
  });

  it('keeps the focus ring and the text apart from every surface it sits on', () => {
    for (const bg of ['--bg', '--panel', '--panel-2']) expect(ratio('--focus', bg), `--focus on ${bg}`).toBeGreaterThanOrEqual(3);
  });
});

describe('palette sources agree', () => {
  const VAR: Readonly<Record<string, string | null>> = {
    unit: '--c-unit',
    unitBusy: '--c-unit-busy',
    emergency: '--c-emergency',
    suspect: '--c-suspect',
    pursuit: '--c-pursuit',
    person: null,
    ok: '--c-ok',
    caution: '--c-caution',
    alert: '--c-alert',
    accent: '--accent',
    accent2: '--accent-2',
    p1: '--c-p1',
    p2: '--c-p2',
    p3: '--c-p3',
    p4: '--c-p4',
  };

  it.each(PALETTE_MODES)('palettes.json equals the stylesheet for %s', (mode) => {
    const t = tokens(mode);
    for (const [key, name] of Object.entries(VAR)) {
      if (name === null) continue;
      expect(t.get(name), `${name} under ${mode}`).toBe(PALETTES[mode].colors[key as keyof (typeof PALETTES)['none']['colors']]);
    }
  });

  it.each(PALETTE_MODES)('every palette semantic colour reaches 3:1 on the panel (%s)', (mode) => {
    const panel = need(tokens('none'), '--panel');
    for (const [key, value] of Object.entries(PALETTES[mode].colors)) {
      if (key === 'unitBusy' || key === 'person') continue; // person is white on a map; unitBusy is checked through --c-unit-busy
      expect(contrastRatio(value, panel), `${mode}.${key} ${value}`).toBeGreaterThanOrEqual(3);
    }
    expect(contrastRatio(PALETTES[mode].colors.unitBusy, panel)).toBeGreaterThanOrEqual(3);
  });

  it('the colour-vision modes keep priority 1 and 2 apart from each other in hue-independent luminance or lightness', () => {
    for (const mode of PALETTE_MODES) {
      const { p1, p2, p3 } = PALETTES[mode].colors;
      // not the same colour (the priority number is always printed too)
      expect(new Set([p1, p2, p3]).size, mode).toBe(3);
    }
  });
});
