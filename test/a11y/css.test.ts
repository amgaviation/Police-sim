import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAX_FLASH_HZ } from '../../src/a11y/flash';
import { PALETTES, SEMANTIC_COLORS, type PaletteMode, type SemanticColor } from '../../src/a11y/palette';

/**
 * Every stylesheet under src/ui, raw text by path. Vite's `?raw` glob finds them; vitest stubs CSS modules with an
 * empty string (its `css` option is off), so an empty result is read from disk instead.
 */
const GLOBBED = import.meta.glob<string>('../../src/ui/**/*.css', { query: '?raw', import: 'default', eager: true });
const SHEETS: Record<string, string> = Object.fromEntries(
  Object.entries(GLOBBED).map(([path, text]) => [path, text !== '' ? text : readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')]),
);

interface Rule {
  readonly selector: string;
  readonly body: string;
  /** The enclosing at-rule prelude ('@media ...') or '' at top level. */
  readonly parent: string;
}

/** Flattens a stylesheet into style rules and `@keyframes` names (comments stripped). */
function parseCss(text: string): { rules: Rule[]; keyframes: string[] } {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  const keyframes: string[] = [];
  const walk = (src: string, parent: string): void => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf('{', i);
      if (open < 0) break;
      const prelude = src.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < src.length && depth > 0) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
        j++;
      }
      const body = src.slice(open + 1, j - 1);
      if (/^@keyframes\b/.test(prelude)) keyframes.push(prelude.replace(/^@keyframes\s+/, '').trim());
      else if (prelude.startsWith('@')) walk(body, prelude);
      else rules.push({ selector: prelude, body, parent });
      i = j;
    }
  };
  walk(css, '');
  return { rules, keyframes };
}

const sheets = Object.entries(SHEETS).map(([path, text]) => ({ path, ...parseCss(text) }));
const stylesPath = Object.keys(SHEETS).find((p) => p.endsWith('/ui/styles.css'));

interface Use {
  readonly path: string;
  readonly selector: string;
  readonly name: string;
  readonly seconds: number;
}

/** Parses `animation:` shorthand and `animation-name` / `-duration` declarations of every rule. */
function animationUses(): Use[] {
  const uses: Use[] = [];
  for (const sheet of sheets) {
    for (const rule of sheet.rules) {
      for (const decl of rule.body.split(';')) {
        const m = /^\s*animation\s*:\s*(.+)$/is.exec(decl);
        if (!m) continue;
        const value = (m[1] ?? '').trim();
        if (/^none\b/i.test(value)) continue;
        // Shorthand may list several animations separated by commas outside parentheses.
        for (const part of value.split(/,(?![^(]*\))/)) {
          const time = /(?<![\w.-])(\d*\.?\d+)(ms|s)\b/i.exec(part);
          const seconds = time ? (time[2]?.toLowerCase() === 'ms' ? Number(time[1]) / 1000 : Number(time[1])) : 0;
          const name = part
            .trim()
            .split(/\s+/)
            .find((tok) => /^[a-z_-][\w-]*$/i.test(tok) && !/^(infinite|alternate|alternate-reverse|reverse|normal|forwards|backwards|both|none|linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end|running|paused)$/i.test(tok));
          uses.push({ path: sheet.path, selector: rule.selector, name: name ?? '', seconds });
        }
      }
    }
  }
  return uses;
}

describe('CSS audit', () => {
  it('finds the stylesheets', () => {
    expect(Object.keys(SHEETS).length).toBeGreaterThanOrEqual(5);
    expect(stylesPath).toBeDefined();
  });

  it('keeps the global reduced-flash rule that disables every animation and transition', () => {
    const styles = sheets.find((s) => s.path === stylesPath);
    const rule = styles?.rules.find((r) => /\[data-reduced-flash="true"\]\s*\*/.test(r.selector));
    expect(rule, 'global :root[data-reduced-flash="true"] * rule').toBeDefined();
    expect(rule?.selector).toMatch(/\*::before/);
    expect(rule?.selector).toMatch(/\*::after/);
    expect(rule?.body).toMatch(/animation\s*:\s*none\s*!important/);
    expect(rule?.body).toMatch(/transition\s*:\s*none\s*!important/);
  });

  it('lets the global rule win: no stylesheet forces an animation with !important', () => {
    const uses = animationUses();
    expect(uses.length).toBeGreaterThan(0);
    // The global rule is `!important` on :root descendants, so no animation can escape it; the only way to is
    // an `animation: ... !important` of its own with higher specificity, which is forbidden.
    for (const sheet of sheets) {
      for (const rule of sheet.rules) {
        if (rule.selector.includes('data-reduced-flash')) continue;
        expect(/animation[^;]*!important/i.test(rule.body), `${sheet.path}: ${rule.selector}`).toBe(false);
      }
    }
  });

  it('never runs an animation faster than the flash limit', () => {
    const minSeconds = 1 / MAX_FLASH_HZ + 0.005;
    expect(minSeconds).toBeCloseTo(0.338, 3);
    for (const use of animationUses()) {
      expect(use.seconds, `${use.path}: ${use.selector} (${use.name})`).toBeGreaterThanOrEqual(0.34);
    }
  });

  it('only names keyframes that exist in the same stylesheet', () => {
    for (const sheet of sheets) {
      const names = new Set(sheet.keyframes);
      for (const use of animationUses().filter((u) => u.path === sheet.path)) {
        if (use.name !== '') expect(names.has(use.name), `${sheet.path}: ${use.selector} uses @keyframes ${use.name}`).toBe(true);
      }
    }
  });

  it('parses the animations it knows about (guards the audit against an empty parse)', () => {
    const selectors = animationUses().map((u) => u.selector);
    expect(selectors.some((s) => s.includes('.chip.capturing'))).toBe(true);
    expect(selectors.some((s) => s.includes('radio-emerg'))).toBe(true);
  });
});

describe('semantic CSS variables', () => {
  const styles = sheets.find((s) => s.path === stylesPath);
  const VAR: Record<SemanticColor, string | null> = {
    unit: '--c-unit',
    unitBusy: '--c-unit-busy',
    emergency: '--c-emergency',
    suspect: '--c-suspect',
    pursuit: '--c-pursuit',
    person: null,
    ok: '--c-ok',
    caution: '--c-caution',
    alert: '--c-alert',
    accent: null,
    accent2: '--accent-2',
    p1: '--c-p1',
    p2: '--c-p2',
    p3: '--c-p3',
    p4: '--c-p4',
  };

  /** Declared custom properties of every rule whose selector targets the given mode. */
  const declared = (mode: PaletteMode): Map<string, string> => {
    const out = new Map<string, string>();
    for (const rule of styles?.rules ?? []) {
      const sel = rule.selector;
      const applies =
        sel === ':root' || (mode !== 'none' && new RegExp(`:root\\[data-colorblind="${mode}"\\]`).test(sel));
      if (!applies) continue;
      for (const decl of rule.body.split(';')) {
        const m = /^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/s.exec(decl);
        if (m) out.set(m[1] ?? '', (m[2] ?? '').toLowerCase());
      }
    }
    return out;
  };

  it('defines every semantic variable for the default palette', () => {
    const vars = declared('none');
    for (const key of SEMANTIC_COLORS) {
      const name = VAR[key];
      if (name === null) continue;
      expect(vars.get(name), `${name} in :root`).toBe(PALETTES.none.colors[key]);
    }
  });

  it.each(['protanopia', 'deuteranopia', 'tritanopia'] as const)('matches palettes.json for %s, overriding danger and accent-2', (mode) => {
    const vars = new Map([...declared('none'), ...declared(mode)]);
    for (const key of SEMANTIC_COLORS) {
      const name = VAR[key];
      if (name === null) continue;
      expect(vars.get(name), `${name} under ${mode}`).toBe(PALETTES[mode].colors[key]);
    }
    expect(vars.get('--danger')).toBe(PALETTES[mode].colors.alert);
    expect(declared(mode).has('--danger'), 'overrides --danger').toBe(true);
    expect(declared(mode).has('--accent-2') || mode === 'tritanopia', 'overrides --accent-2').toBe(true);
  });

  it('has a selector for each colour-vision mode', () => {
    const text = SHEETS[stylesPath ?? ''] ?? '';
    for (const mode of ['protanopia', 'deuteranopia', 'tritanopia']) expect(text).toContain(`:root[data-colorblind="${mode}"]`);
  });

  it('has a swatch rule per previewed tone', () => {
    const text = SHEETS[stylesPath ?? ''] ?? '';
    for (const tone of ['unit', 'emergency', 'suspect', 'ok', 'caution', 'alert']) {
      expect(text).toContain(`.swatch[data-tone="${tone}"] { background: var(--c-${tone}); }`);
    }
  });
});
