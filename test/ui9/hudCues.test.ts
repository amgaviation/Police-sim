/**
 * Phase 9 HUD readability (design §7.7): HUD elements use the CSS tokens and rem sizes (no colour literals, no px font
 * sizes), every wide line wraps (`overflow-wrap:anywhere`) and is capped in vw / rem so it never leaves the screen at
 * text scale 1.6, and severity is never carried by colour alone.
 *
 * Chips and lines changed in Phase 9 (shape / text cue in front of the colour):
 *   - unit chips: '! EMERGENCY' (was 'EMERGENCY'), '? STATUS CHECK' (was 'STATUS CHECK'), '! ENGINE', '! TYRE';
 *   - misconduct episode chip: '! <EPISODE>';
 *   - legal line: LEGAL_MARKS  ok '✓ ', warn '▲ ', bad '! ';
 *   - plate-run result line: SEVERITY_MARKS  clear '✓ ', caution '▲ ', alert '! ';
 *   - trust chip: TRUST_MARKS  low '▼ ', mid '◆ ', high '▲ ';
 *   - wellbeing chip: CHIP_MARKS  caution '▲ ', alert '! '.
 * Unchanged (already carry their meaning as text): 'FUEL LOW', 'OIL LOW', 'TYRES WORN', 'BRAKES HOT', '● REC' / 'MUTED' / 'CAM',
 * 'DASH', 'FLIR', 'ALT n m', the call strip ('P1'..'P4' in the title), the scene objectives (✓ / •), the duty and pursuit lines.
 * DOM writes stay change-driven (see test/hud/phase5.test.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Hud } from '../../src/ui/hud/hud';
import { LEGAL_COLORS, LEGAL_MARKS, TRUST_COLORS, TRUST_MARKS } from '../../src/ui/hud/law';
import { CHIP_MARKS } from '../../src/ui/hud/phase8';
import { PRIORITY_COLORS, SEVERITY_COLORS, SEVERITY_MARKS, priorityColor } from '../../src/ui/hud/police';
import { snapshot } from '../hud/fixtures';

class El {
  static all: El[] = [];
  text = '';
  styleAttr = '';
  readonly style: Record<string, string> = {};
  readonly children: El[] = [];
  id = '';
  constructor() {
    El.all.push(this);
  }
  get textContent(): string {
    return this.text;
  }
  set textContent(v: string) {
    this.text = v;
  }
  setAttribute(name: string, value: string): void {
    if (name === 'style') this.styleAttr = value;
  }
  appendChild(c: El): El {
    this.children.push(c);
    return c;
  }
  remove(): void {
    /* nothing to detach */
  }
}

const g = globalThis as unknown as { document?: unknown };
const before = g.document;
afterEach(() => {
  if (before === undefined) delete g.document;
  else g.document = before;
  El.all = [];
});

function build(): Hud {
  g.document = { createElement: (): El => new El() };
  return new Hud(new El() as unknown as HTMLElement);
}

const TOKEN = /^var\(--[\w-]+\)$/;

describe('HUD marks and colours', () => {
  it('colours come from the stylesheet tokens (so the colour-vision palettes reach the HUD)', () => {
    for (const c of [...Object.values(LEGAL_COLORS), ...Object.values(TRUST_COLORS), ...PRIORITY_COLORS]) expect(c).toMatch(TOKEN);
    for (const [sev, c] of Object.entries(SEVERITY_COLORS)) if (sev !== 'none') expect(c).toMatch(TOKEN);
    expect(priorityColor(1)).toBe('var(--c-p1)');
    expect(priorityColor(9)).toBe('var(--c-p4)');
  });

  it('every severity has its own shape cue (none for the neutral state only)', () => {
    expect(Object.values(LEGAL_MARKS).every((m) => m.trim() !== '')).toBe(true);
    expect(new Set(Object.values(LEGAL_MARKS)).size).toBe(3);
    expect(new Set(Object.values(TRUST_MARKS)).size).toBe(3);
    expect(SEVERITY_MARKS.none).toBe('');
    expect(new Set([SEVERITY_MARKS.clear, SEVERITY_MARKS.caution, SEVERITY_MARKS.alert]).size).toBe(3);
    expect(CHIP_MARKS.clear).toBe('');
    expect(CHIP_MARKS.caution).not.toBe(CHIP_MARKS.alert);
    expect(CHIP_MARKS.alert).toBe('! ');
    expect(LEGAL_MARKS.bad).toBe('! ');
  });
});

describe('HUD DOM', () => {
  it('has the emergency chip with a leading "!" and a status-check chip with "?"', () => {
    build();
    const texts = El.all.map((e) => e.text);
    expect(texts).toContain('! EMERGENCY');
    expect(texts).toContain('? STATUS CHECK');
    expect(texts).toContain('! ENGINE');
  });

  it('writes the severity cue with the legal, trust and plate-result lines', () => {
    const hud = build();
    hud.update(
      snapshot({
        legal: { text: 'outside policy', severity: 'bad' },
        trust: { district: 'Docks', value: 0.1 },
        target: { label: 'KDX 4410', result: 'Stolen vehicle', severity: 'alert' } as never,
      }),
      0,
    );
    const texts = El.all.map((e) => e.text);
    expect(texts).toContain('! outside policy');
    expect(texts).toContain('▼ Trust · Docks 10 %');
    expect(texts.some((t) => t.startsWith('! ') && t.includes('Stolen vehicle'))).toBe(true);
  });

  it('uses no colour literal and no px font size in any inline style', () => {
    build();
    const styles = El.all.map((e) => e.styleAttr).filter((s) => s !== '');
    expect(styles.length).toBeGreaterThan(40);
    for (const s of styles) {
      expect(s, s).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(s, s).not.toMatch(/rgba?\(|hsla?\(/);
      for (const m of s.matchAll(/font(?:-size)?:([^;]*)/g)) expect(m[1], s).not.toMatch(/\dpx/);
    }
  });

  it('wraps every centred line and caps it in vw so text scale 1.6 stays on screen', () => {
    build();
    const centred = El.all.map((e) => e.styleAttr).filter((s) => s.includes('left:50%') && s.includes('translateX(-50%)'));
    expect(centred.length).toBeGreaterThanOrEqual(8);
    for (const s of centred) {
      if (s.includes('display:flex')) continue; // the road panel: capped in vw below
      expect(s, s).toMatch(/max-width:min\(\d+vw/);
      expect(s, s).toContain('overflow-wrap:anywhere');
      expect(s, s).not.toContain('white-space:nowrap');
    }
  });

  it('keeps the corner stacks inside the screen (max-width in vw) and the root wraps text', () => {
    build();
    const styles = El.all.map((e) => e.styleAttr);
    const root = styles.find((s) => s.includes('z-index:900'));
    expect(root).toContain('overflow-wrap:anywhere');
    expect(root).toContain('var(--fg-strong)');
    for (const marker of ['right:', 'left:']) {
      const stacks = styles.filter((s) => s.includes('flex-direction:column') && s.includes(`${marker}`) && s.includes('position:absolute'));
      expect(stacks.length, marker).toBeGreaterThan(0);
      for (const s of stacks) expect(s, s).toMatch(/max-width:min\(\d+vw/);
    }
    expect(styles.some((s) => s.includes('white-space:nowrap'))).toBe(false);
  });

  it('sizes are rem of the scaled root font (no calc with the text-scale variable)', () => {
    build();
    const sizes = El.all.map((e) => e.styleAttr).filter((s) => /font-size:|font:/.test(s));
    expect(sizes.length).toBeGreaterThan(30);
    for (const s of sizes) expect(s, s).toMatch(/\d(?:\.\d+)?rem/);
    expect(El.all.some((e) => e.styleAttr.includes('--text-scale'))).toBe(false);
  });
});
