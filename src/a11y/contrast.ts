/**
 * WCAG 2.x contrast helpers (design §7.2). Pure presentation math: the CSS audit and the palette tests use them to keep
 * every colour-vision palette readable; nothing here feeds the simulation.
 */

/** Linearised sRGB channel (0..1) of an 8-bit value. */
function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Parses `#rgb` or `#rrggbb` into 8-bit components; throws on anything else. */
export function parseHex(hex: string): readonly [number, number, number] {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`Not a #rgb / #rrggbb colour: ${JSON.stringify(hex)}`);
  const h = m[1] as string;
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

/** WCAG relative luminance (0 black .. 1 white) of a `#rgb` / `#rrggbb` colour. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio (1..21) of two colours; symmetric. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}
