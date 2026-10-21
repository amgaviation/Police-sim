/**
 * Phase 9 CSS audit (design §7.2): reads every `src/**\/*.css` and reports `file:line selector { declaration }` for each
 * violation of
 *  1. no `px` in a font size (`font-size`, and the size part of the `font` shorthand);
 *  2. no colour literal (#hex, rgb(a), hsl(a), named colour) outside the `:root` / `:root[data-colorblind=...]` blocks of
 *     `src/ui/styles.css`: everything else uses `var(--token)`;
 *  3. no `outline: none` / `0` unless the selector carries `:not(:focus-visible)`;
 *  4. `styles.css` has a `:focus-visible` rule whose outline is `var(--focus)`;
 *  5. no `width` / `min-width` / `max-width` with a `px` length >= 120 unless the line says
 *     `/* audit-allow: px-width <reason> *\/` (canvases and fixed-size thumbnails);
 *  6. every `var(--x)` is defined in `styles.css` (or in the same rule).
 * The audit also guards itself: its parser and each rule are exercised on small bad inputs.
 */
import { describe as suite, expect, it } from 'vitest';
import { definedVars, describe, loadCss, parseDecls, usedVars, type CssDecl } from './cssParse';

const NAMED_COLORS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue ' +
    'chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey ' +
    'darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray ' +
    'darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen ' +
    'fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender ' +
    'lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey ' +
    'lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen ' +
    'magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen ' +
    'mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange ' +
    'orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple ' +
    'rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue ' +
    'slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'
  ).split(' '),
);

/** Properties whose values are never colours (names that could collide with a colour keyword). */
const NON_COLOR_PROPS = /^(font|font-family|font-style|font-weight|animation|animation-name|transition|transition-property|will-change|content|grid-template-areas|grid-area|list-style|list-style-type|counter-reset|counter-increment|quotes|cursor|display|position|overflow|text-align|text-transform|white-space|appearance|resize|object-fit|pointer-events|user-select|box-sizing)$/;

const HEX = /#[0-9a-fA-F]{3,8}\b/;
const COLOR_FN = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i;

/** The value with `var(...)` references, strings and `url(...)` removed (so only literal colours remain). */
function stripNonLiteral(value: string): string {
  let out = value.replace(/"[^"]*"|'[^']*'/g, '').replace(/url\([^)]*\)/g, '');
  for (let guard = 0; guard < 8 && out.includes('var('); guard++) out = out.replace(/var\([^()]*\)/g, '');
  return out;
}

/** Colour literals found in a declaration value (hex, colour functions, named colours); [] when it has none. */
export function colorLiterals(prop: string, value: string): string[] {
  const v = stripNonLiteral(value);
  const found: string[] = [];
  const hex = HEX.exec(v);
  if (hex) found.push(hex[0]);
  const fn = COLOR_FN.exec(v);
  if (fn) found.push(fn[0]);
  if (!NON_COLOR_PROPS.test(prop)) {
    for (const word of v.toLowerCase().match(/[a-z][a-z-]*/g) ?? []) {
      if (NAMED_COLORS.has(word)) found.push(word);
    }
  }
  return found;
}

function isPaletteBlock(d: CssDecl): boolean {
  return d.file.endsWith('src/ui/styles.css') && (d.selector === ':root' || /^:root\[data-colorblind=/.test(d.selector));
}

/** `px` lengths in a font size declaration (the size of `font` shorthand is the token before a `/` or the first length). */
export function fontSizePx(d: Pick<CssDecl, 'prop' | 'value'>): string[] {
  if (d.prop === 'font-size') return d.value.match(/-?\d*\.?\d+px/g) ?? [];
  if (d.prop === 'font') {
    const beforeSlash = d.value.split('/')[0] ?? '';
    return beforeSlash.match(/-?\d*\.?\d+px/g) ?? [];
  }
  return [];
}

export function outlineRemoved(d: Pick<CssDecl, 'prop' | 'value' | 'selector'>): boolean {
  if (d.selector.includes(':not(:focus-visible)')) return false;
  const v = d.value.replace(/!important/i, '').trim().toLowerCase();
  if (d.prop === 'outline') return /^(none|0)(\s|$)/.test(v) || v === '0px';
  if (d.prop === 'outline-style') return v === 'none';
  if (d.prop === 'outline-width') return /^0(px)?$/.test(v);
  return false;
}

/** `px` lengths >= 120 in width / min-width / max-width values (also inside min(), clamp(), calc()). */
export function widePx(d: Pick<CssDecl, 'prop' | 'value'>): number[] {
  if (!/^(width|min-width|max-width)$/.test(d.prop)) return [];
  return [...d.value.matchAll(/(\d*\.?\d+)px/g)].map((m) => Number(m[1])).filter((n) => n >= 120);
}

const ALLOW_PX_WIDTH = /\/\*\s*audit-allow:\s*px-width\s+\S[\s\S]*?\*\//;

const sheets = loadCss();
const all = sheets.flatMap((s) => s.decls);
const styles = sheets.find((s) => s.file === 'src/ui/styles.css');

suite('CSS audit: the audit itself', () => {
  it('finds the stylesheets and parses their declarations', () => {
    expect(sheets.length).toBeGreaterThanOrEqual(16);
    expect(styles).toBeDefined();
    expect(all.length).toBeGreaterThan(500);
    const fileNames = sheets.map((s) => s.file);
    for (const f of ['mdt/mdt.css', 'panels/panels.css', 'dialogue/dialogue.css', 'career/career.css', 'dispatch/dispatch.css', 'coop/coop.css']) {
      expect(fileNames, f).toContain(`src/ui/${f}`);
    }
  });

  it('reports the line a declaration starts on and keeps the raw line', () => {
    const d = parseDecls('x.css', '/* c\n c */\n.a {\n  color: red;\n  width: 3px; }\n@media (max-width: 40em) {\n .b { font-size: 12px }\n}\n');
    expect(d.map((x) => [x.line, x.selector, x.prop, x.value])).toEqual([
      [4, '.a', 'color', 'red'],
      [5, '.a', 'width', '3px'],
      [7, '.b', 'font-size', '12px'],
    ]);
    expect(d[0]?.raw).toBe('  color: red;');
  });

  it('flags px font sizes, colour literals, removed outlines and wide px widths in small bad inputs', () => {
    const bad = parseDecls(
      'bad.css',
      [
        '.a { font-size: 13px; }',
        '.b { color: #fff; background: rgba(0, 0, 0, 0.5); border: 1px solid red; }',
        '.c { outline: none; }',
        '.d { width: min(100%, 480px); }',
        '.e { color: var(--fg); background: transparent; font-family: "Segoe UI", sans-serif; border: 1px solid currentColor; }',
        '.f { font: 700 0.9em/1.5 var(--font-mono); width: 20em; }',
        '.g:focus:not(:focus-visible) { outline: none; }',
      ].join('\n'),
    );
    const by = (sel: string): CssDecl[] => bad.filter((x) => x.selector === sel);
    expect(by('.a').flatMap(fontSizePx)).toEqual(['13px']);
    expect(by('.b').flatMap((x) => colorLiterals(x.prop, x.value)).sort()).toEqual(['#fff', 'red', 'rgba('].sort());
    expect(by('.c').some(outlineRemoved)).toBe(true);
    expect(by('.d').flatMap(widePx)).toEqual([480]);
    expect(by('.e').flatMap((x) => colorLiterals(x.prop, x.value))).toEqual([]);
    expect(by('.f').flatMap(fontSizePx)).toEqual([]);
    expect(by('.f').flatMap(widePx)).toEqual([]);
    expect(by('.g').some(outlineRemoved)).toBe(false);
    expect(usedVars('1px solid var(--a, var(--b))')).toEqual(['--a', '--b']);
    expect(ALLOW_PX_WIDTH.test('.p { width: 200px; } /* audit-allow: px-width canvas */')).toBe(true);
    expect(ALLOW_PX_WIDTH.test('.p { width: 200px; } /* audit-allow: px-width */')).toBe(false);
  });
});

suite('CSS audit', () => {
  it('1. has no px in a font size', () => {
    const bad = all.filter((d) => fontSizePx(d).length > 0).map(describe);
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('2. has no colour literal outside the :root and colour-vision palette blocks of styles.css', () => {
    const bad = all.filter((d) => !isPaletteBlock(d) && colorLiterals(d.prop, d.value).length > 0).map((d) => `${describe(d)}  <- ${colorLiterals(d.prop, d.value).join(', ')}`);
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('2b. keeps its colour literals in styles.css (the palette blocks exist and hold them)', () => {
    const inPalette = all.filter(isPaletteBlock).filter((d) => colorLiterals(d.prop, d.value).length > 0);
    expect(inPalette.length).toBeGreaterThan(40);
    expect(styles?.decls.some((d) => d.selector === ':root' && d.prop === '--c-ok')).toBe(true);
    expect(styles?.decls.some((d) => /^:root\[data-colorblind="tritanopia"\]$/.test(d.selector) && d.prop === '--c-ok')).toBe(true);
  });

  it('3. never removes an outline (except :not(:focus-visible))', () => {
    const bad = all.filter(outlineRemoved).map(describe);
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('4. gives every focused control the --focus ring through a :focus-visible rule in styles.css', () => {
    const rule = styles?.decls.filter((d) => /(^|,\s*):focus-visible$/.test(d.selector) && d.prop === 'outline');
    expect(rule?.length, ':focus-visible { outline } in styles.css').toBeGreaterThanOrEqual(1);
    expect(rule?.some((d) => d.value.includes('var(--focus)'))).toBe(true);
  });

  it('5. has no px width / min-width / max-width >= 120 without an audit-allow marker', () => {
    const bad = all.filter((d) => widePx(d).length > 0 && !ALLOW_PX_WIDTH.test(d.raw)).map(describe);
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('5b. every audit-allow marker names a reason and sits on a line with a wide px width', () => {
    const marked = all.filter((d) => /audit-allow/.test(d.raw));
    expect(marked.length).toBeGreaterThan(0);
    for (const d of marked) {
      expect(ALLOW_PX_WIDTH.test(d.raw), describe(d)).toBe(true);
      const line = all.filter((o) => o.file === d.file && o.line === d.line);
      expect(line.some((o) => widePx(o).length > 0), `${describe(d)}: marker without a wide px width on its line`).toBe(true);
    }
  });

  it('6. defines every var(--x) in styles.css or in the same rule', () => {
    const global = definedVars(styles?.decls ?? []);
    const bad: string[] = [];
    for (const sheet of sheets) {
      for (const d of sheet.decls) {
        for (const name of usedVars(d.value)) {
          if (global.has(name)) continue;
          const local = sheet.decls.some((o) => o.selector === d.selector && o.prop === name);
          if (!local) bad.push(`${describe(d)}  <- ${name}`);
        }
      }
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('keeps the spec tokens in :root', () => {
    const root = new Map((styles?.decls ?? []).filter((d) => d.selector === ':root').map((d) => [d.prop, d.value]));
    const expected: Record<string, string> = {
      '--focus': '#ffd24a',
      '--panel-2': '#182330',
      '--border-strong': '#3d5266',
      '--scrim': 'rgba(4, 8, 12, 0.6)',
      '--scrim-live': 'rgba(4, 8, 12, 0.25)',
      '--shadow': '0 0.75em 2.5em rgba(0, 0, 0, 0.6)',
      '--sp-1': '0.25em',
      '--sp-2': '0.5em',
      '--sp-3': '0.75em',
      '--sp-4': '1em',
      '--sp-6': '1.5em',
      '--fs-xs': '0.75em',
      '--fs-sm': '0.875em',
      '--fs-md': '1em',
      '--fs-lg': '1.25em',
      '--fs-xl': '1.6em',
      '--line': '1.4',
    };
    for (const [name, value] of Object.entries(expected)) expect(root.get(name), name).toBe(value);
    for (const keep of ['--text-scale', '--bg', '--panel', '--panel-border', '--fg', '--fg-dim', '--accent', '--accent-2', '--danger', '--font-ui', '--font-mono', '--radius']) {
      expect(root.has(keep), keep).toBe(true);
    }
  });

  it('declares the shared global rules of the design', () => {
    const decls = styles?.decls ?? [];
    const find = (sel: string, prop: string): string | undefined => decls.find((d) => d.selector === sel && d.prop === prop)?.value;
    expect(find(':focus-visible', 'outline')).toBe('0.15em solid var(--focus)');
    expect(find(':focus-visible', 'outline-offset')).toBe('0.1em');
    expect(find('[aria-selected="true"], .is-selected', 'box-shadow')).toBe('inset 0.2em 0 0 var(--accent)');
    expect(find('.panel', 'width')).toBe('min(92vw, 46em)');
    expect(find('.panel', 'max-height')).toBe('92vh');
    expect(find('.panel', 'overflow')).toBe('auto');
    expect(find('button, .btn', 'background')).toBe('var(--panel-2)');
    expect(find('button, .btn', 'border')).toBe('1px solid var(--border-strong)');
    expect(find('button, .btn', 'padding')).toBe('var(--sp-2) var(--sp-3)');
    expect(find('button, .btn', 'font')).toBe('inherit');
  });
});
