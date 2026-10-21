import { describe, expect, it } from 'vitest';
import { DEFAULT_LIVERIES, defaultLivery } from '../../src/livery/defaults';
import { SHELL_ATLAS, paintLivery, resolveText, type Canvas2DLike, type PaintOptions } from '../../src/livery/painter';
import type { LiveryDoc, LiveryLayer } from '../../src/livery/types';

/** Records every call and property assignment of the painter. */
class RecordingCtx implements Canvas2DLike {
  log: string[] = [];
  private props: Record<string, string | number> = {
    fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic', globalAlpha: 1,
  };
  private set(name: string, v: string | number): void {
    this.props[name] = v;
    this.log.push(`${name}=${v}`);
  }
  get fillStyle(): string { return String(this.props.fillStyle); }
  set fillStyle(v: string) { this.set('fillStyle', v); }
  get strokeStyle(): string { return String(this.props.strokeStyle); }
  set strokeStyle(v: string) { this.set('strokeStyle', v); }
  get lineWidth(): number { return Number(this.props.lineWidth); }
  set lineWidth(v: number) { this.set('lineWidth', v); }
  get font(): string { return String(this.props.font); }
  set font(v: string) { this.set('font', v); }
  get textAlign(): string { return String(this.props.textAlign); }
  set textAlign(v: string) { this.set('textAlign', v); }
  get textBaseline(): string { return String(this.props.textBaseline); }
  set textBaseline(v: string) { this.set('textBaseline', v); }
  get globalAlpha(): number { return Number(this.props.globalAlpha); }
  set globalAlpha(v: number) { this.set('globalAlpha', v); }
  private call(name: string, ...a: (number | string | undefined)[]): void {
    this.log.push(`${name}(${a.filter((x) => x !== undefined).join(',')})`);
  }
  save(): void { this.call('save'); }
  restore(): void { this.call('restore'); }
  translate(x: number, y: number): void { this.call('translate', x, y); }
  rotate(a: number): void { this.call('rotate', a); }
  scale(x: number, y: number): void { this.call('scale', x, y); }
  beginPath(): void { this.call('beginPath'); }
  moveTo(x: number, y: number): void { this.call('moveTo', x, y); }
  lineTo(x: number, y: number): void { this.call('lineTo', x, y); }
  closePath(): void { this.call('closePath'); }
  rect(x: number, y: number, w: number, h: number): void { this.call('rect', x, y, w, h); }
  fill(): void { this.call('fill'); }
  stroke(): void { this.call('stroke'); }
  clip(): void { this.call('clip'); }
  fillRect(x: number, y: number, w: number, h: number): void { this.call('fillRect', x, y, w, h); }
  clearRect(x: number, y: number, w: number, h: number): void { this.call('clearRect', x, y, w, h); }
  fillText(t: string, x: number, y: number, m?: number): void { this.call('fillText', JSON.stringify(t), x, y, m); }
  strokeText(t: string, x: number, y: number, m?: number): void { this.call('strokeText', JSON.stringify(t), x, y, m); }
}

const OPTS: PaintOptions = { unit: '12-A3', dept: 'City Police', reflectiveOnly: false };

function paint(doc: LiveryDoc, opts: Partial<PaintOptions> = {}): string[] {
  const ctx = new RecordingCtx();
  paintLivery(ctx, doc, { ...OPTS, ...opts });
  return ctx.log;
}

function withLayers(layers: LiveryLayer[], over: Partial<LiveryDoc> = {}): LiveryDoc {
  return { ...defaultLivery('patrolMarked'), layers, wrap: null, ...over };
}

const textLayer = (over: Partial<Extract<LiveryLayer, { type: 'text' }>> = {}): LiveryLayer => ({
  type: 'text', face: 'sides', text: 'ABC', u: 0.25, v: 0.5, size: 0.3, color: '#102030', outline: null, font: 'sans', weight: 'bold', italic: false, reflective: false, ...over,
});

const texts = (log: string[], fn = 'fillText'): { text: string; x: number; y: number; max: number }[] =>
  log
    .filter((l) => l.startsWith(`${fn}(`))
    .map((l) => {
      const m = /^\w+\((".*"),([-\d.e]+),([-\d.e]+),([-\d.e]+)\)$/.exec(l);
      if (!m) throw new Error(l);
      return { text: JSON.parse(m[1] ?? '""') as string, x: Number(m[2]), y: Number(m[3]), max: Number(m[4]) };
    });

describe('SHELL_ATLAS', () => {
  it('has the documented size and regions inside the atlas without overlap', () => {
    expect(SHELL_ATLAS.width).toBe(1024);
    expect(SHELL_ATLAS.height).toBe(512);
    expect(SHELL_ATLAS.regions.left).toEqual([0, 0, 1024, 192]);
    expect(SHELL_ATLAS.regions.rear).toEqual([896, 384, 128, 128]);
    const rs = Object.values(SHELL_ATLAS.regions);
    for (const [x, y, w, h] of rs) {
      expect(x + w).toBeLessThanOrEqual(1024);
      expect(y + h).toBeLessThanOrEqual(512);
    }
    for (let i = 0; i < rs.length; i++) {
      for (let j = i + 1; j < rs.length; j++) {
        const [ax, ay, aw, ah] = rs[i] ?? [0, 0, 0, 0];
        const [bx, by, bw, bh] = rs[j] ?? [0, 0, 0, 0];
        expect(ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah).toBe(false);
      }
    }
  });
});

describe('resolveText', () => {
  it('replaces {unit} and {dept} everywhere, once', () => {
    expect(resolveText('{unit} of {dept} / {unit}', '7', 'CP')).toBe('7 of CP / 7');
    expect(resolveText('plain', '7', 'CP')).toBe('plain');
    expect(resolveText('{unit}', '{dept}', 'CP')).toBe('{dept}');
    expect(resolveText('{other}', '7', 'CP')).toBe('{other}');
  });
});

describe('paintLivery', () => {
  it('clears the atlas first, then fills the base colour', () => {
    const log = paint(withLayers([]));
    expect(log).toContain('clearRect(0,0,1024,512)');
    expect(log.indexOf('clearRect(0,0,1024,512)')).toBeLessThan(log.indexOf('fillRect(0,0,1024,512)'));
    expect(log).toContain('fillStyle=#f2f2f2');
  });

  it('draws a sides text twice, on the left and right regions at mirrored x', () => {
    const t = texts(paint(withLayers([textLayer({ u: 0.25 })])));
    expect(t).toHaveLength(2);
    const [left, right] = t;
    expect(left).toMatchObject({ text: 'ABC', x: 0.25 * 1024, y: 0.5 * 192 });
    expect(right).toMatchObject({ text: 'ABC', x: (1 - 0.25) * 1024, y: 192 + 0.5 * 192 });
    expect(left?.max).toBeCloseTo(0.96 * 1024, 9);
  });

  it('sets the font, centre / middle alignment and bold italic style', () => {
    const log = paint(withLayers([textLayer({ size: 0.5, italic: true, font: 'stencil' })]));
    expect(log).toContain("font=italic bold 96px 'Arial Black', sans-serif");
    expect(log).toContain('textAlign=center');
    expect(log).toContain('textBaseline=middle');
    const mono = paint(withLayers([textLayer({ font: 'mono', weight: 'normal' })]));
    expect(mono).toContain('font=normal 57.6px monospace');
    expect(paint(withLayers([textLayer({ font: 'serif' })]))).toContain('font=bold 57.6px serif');
  });

  it('strokes the outline before the fill', () => {
    const log = paint(withLayers([textLayer({ outline: '#ffffff', size: 0.5 })]));
    expect(log.indexOf('strokeText("ABC",256,96,983.04)')).toBeGreaterThan(-1);
    expect(log.indexOf('strokeText("ABC",256,96,983.04)')).toBeLessThan(log.indexOf('fillText("ABC",256,96,983.04)'));
    expect(log).toContain('lineWidth=7.68'); // max(2, 0.5 * 192 * 0.08)
    expect(texts(log, 'strokeText')).toHaveLength(2);
  });

  it('negates angles for the right side while keeping glyphs unmirrored (no scale(-1))', () => {
    const shape: LiveryLayer = { type: 'shape', face: 'sides', shape: 'rect', u: 0.2, v: 0.5, w: 0.1, h: 0.5, rotationDeg: 30, color: '#112233', outline: null, reflective: false };
    const log = paint(withLayers([shape, textLayer()]));
    const rot = log.filter((l) => l.startsWith('rotate('));
    expect(rot).toHaveLength(2);
    expect(Number(rot[0]?.slice(7, -1))).toBeCloseTo((30 * Math.PI) / 180, 9);
    expect(Number(rot[1]?.slice(7, -1))).toBeCloseTo((-30 * Math.PI) / 180, 9);
    expect(log.some((l) => l.startsWith('scale('))).toBe(false);
    expect(log).toContain('translate(204.8,96)');
    expect(log).toContain(`translate(${0.8 * 1024},${192 + 96})`);
  });

  it('shears stripes by angleDeg, negated and position-mirrored on the right', () => {
    const stripe: LiveryLayer = { type: 'stripe', face: 'sides', u0: 0.1, u1: 0.4, v: 0.5, height: 0.5, angleDeg: 45, color: '#445566', reflective: false };
    const log = paint(withLayers([stripe]));
    const moves = log.filter((l) => l.startsWith('moveTo('));
    expect(moves[0]).toBe('moveTo(' + (0.1 * 1024 + 48) + ',48)');
    expect(moves[1]).toBe('moveTo(' + ((1 - 0.4) * 1024 - 48) + ',' + (192 + 48) + ')');
    expect(log).toContain('fillStyle=#445566');
  });

  it('paints single-face layers on their own region only', () => {
    const log = paint(withLayers([textLayer({ face: 'roof', u: 0.5, v: 0.5 })]));
    const t = texts(log);
    expect(t).toEqual([{ text: 'ABC', x: 512 + 128, y: 384 + 64, max: 0.96 * 256 }]);
    const right = texts(paint(withLayers([textLayer({ face: 'right', u: 0.25 })])));
    expect(right).toHaveLength(1);
    expect(right[0]).toMatchObject({ x: 256, y: 192 + 96 });
  });

  it('clips every layer to its region', () => {
    const log = paint(withLayers([textLayer({ face: 'rear' })]));
    expect(log).toContain('rect(896,384,128,128)');
    expect(log).toContain('clip()');
  });

  it('replaces {unit} and {dept} in text', () => {
    const t = texts(paint(withLayers([textLayer({ text: '{unit}/{dept}', face: 'rear' })])));
    expect(t.map((x) => x.text)).toEqual(['12-A3/City Police']);
    expect(texts(paint(withLayers([textLayer({ text: '{unit}', face: 'rear' })]), { unit: '99' }))[0]?.text).toBe('99');
  });

  it('reflectiveOnly skips non-reflective layers, skips base and wrap, and paints white', () => {
    const layers: LiveryLayer[] = [
      textLayer({ text: 'DULL', color: '#ff0000', reflective: false }),
      textLayer({ text: 'GLOW', color: '#ff0000', reflective: true, outline: '#00ff00' }),
      { type: 'stripe', face: 'hood', u0: 0, u1: 1, v: 0.5, height: 0.2, angleDeg: 0, color: '#ff0000', reflective: true },
      { type: 'checker', face: 'sides', v: 0.5, height: 0.2, cells: 4, rows: 2, colors: ['#ff0000', '#00ff00'], reflective: true },
    ];
    const doc = withLayers(layers, { wrap: { kind: 'solid', colors: ['#123456'], split: 0.5 } });
    const log = paint(doc, { reflectiveOnly: true });
    const t = texts(log);
    expect(t.map((x) => x.text)).toEqual(['GLOW', 'GLOW']);
    expect(log.join('\n')).not.toMatch(/DULL/);
    expect(log).not.toContain('fillRect(0,0,1024,512)');
    expect(log).toContain('clearRect(0,0,1024,512)');
    const styles = log.filter((l) => l.startsWith('fillStyle=') || l.startsWith('strokeStyle='));
    expect(styles.length).toBeGreaterThan(0);
    for (const s of styles) expect(s.endsWith('=#ffffff'), s).toBe(true);
  });

  it('reflectiveOnly of a doc with no reflective layers only clears', () => {
    const log = paint(withLayers([textLayer()]), { reflectiveOnly: true });
    expect(log.some((l) => l.startsWith('fillText') || l.startsWith('fillRect'))).toBe(false);
    expect(log).toContain('clearRect(0,0,1024,512)');
  });

  it('paints wraps: solid, twoTone, fade (8 bands) and pinstripe', () => {
    const wrapped = (kind: 'solid' | 'twoTone' | 'fade' | 'pinstripe'): string[] =>
      paint(withLayers([], { wrap: { kind, colors: ['#000000', '#ffffff'], split: 0.5 } }));
    const solid = wrapped('solid');
    expect(solid.filter((l) => l === 'fillStyle=#000000')).toHaveLength(6);
    const two = wrapped('twoTone');
    expect(two).toContain('fillRect(0,0,1024,96)');
    expect(two).toContain('fillRect(0,96,1024,96)');
    expect(two).toContain('fillRect(0,288,1024,96)');
    const fade = wrapped('fade');
    expect(fade.filter((l) => l.startsWith('fillRect(0,') && l.includes(',1024,25'))).toHaveLength(14); // 7 overlapped (24 + 1 px) bands on each side; the last band is exactly 24
    expect(fade).toContain('fillStyle=#000000');
    expect(fade).toContain('fillStyle=#ffffff');
    expect(fade.filter((l) => l.startsWith('fillStyle=#')).length).toBeGreaterThanOrEqual(8 * 2 + 4);
    const pin = wrapped('pinstripe');
    expect(pin).toContain('fillRect(0,94.5,1024,3)');
    expect(pin).toContain('fillRect(0,286.5,1024,3)');
  });

  it('a one-colour two-tone wrap falls back to that colour', () => {
    expect(() => paint(withLayers([], { wrap: { kind: 'fade', colors: ['#336699'], split: 0.5 } }))).not.toThrow();
  });

  it('paints checkers with alternating colours and a mirrored right side', () => {
    const checker: LiveryLayer = { type: 'checker', face: 'sides', v: 0.5, height: 0.5, cells: 4, rows: 2, colors: ['#111111', '#eeeeee'], reflective: false };
    const log = paint(withLayers([checker]));
    const cells = log.filter((l) => /^fillRect\(\d+,/.test(l) && !l.startsWith('fillRect(0,0,1024,512)'));
    expect(cells).toHaveLength(16);
    const firstRow = log.slice(log.indexOf('fillRect(0,48,256,48)') - 1, log.indexOf('fillRect(0,48,256,48)') + 1);
    expect(firstRow[0]).toBe('fillStyle=#111111');
    expect(log).toContain('fillRect(0,48,256,48)');
    expect(log).toContain('fillRect(0,96,256,48)');
    // Right region (starts at y = 192), cell 0 is mirrored to column 3 (odd -> second colour).
    const i = log.indexOf('fillRect(0,240,256,48)');
    expect(log[i - 1]).toBe('fillStyle=#eeeeee');
  });

  it('paints every shape kind with a closed path', () => {
    const kinds = ['rect', 'roundedRect', 'circle', 'ellipse', 'star', 'shield', 'chevron', 'triangle', 'arch', 'polygon'] as const;
    for (const shape of kinds) {
      const layer: LiveryLayer = {
        type: 'shape', face: 'hood', shape, u: 0.5, v: 0.5, w: 0.5, h: 0.5, rotationDeg: 10, color: '#aa0000', outline: '#ffffff', reflective: false,
        ...(shape === 'polygon' ? { points: [[-1, -1], [1, -1], [0, 1]] as [number, number][] } : {}),
      };
      const log = paint(withLayers([layer]));
      expect(log, shape).toContain('closePath()');
      expect(log, shape).toContain('fill()');
      expect(log, shape).toContain('stroke()');
    }
  });

  it('scales shape polygons by w and h of the face region', () => {
    const layer: LiveryLayer = { type: 'shape', face: 'hood', shape: 'rect', u: 0.5, v: 0.5, w: 0.5, h: 0.25, rotationDeg: 0, color: '#aa0000', outline: null, reflective: false };
    const log = paint(withLayers([layer]));
    expect(log).toContain('translate(256,448)');
    expect(log).toContain('moveTo(-128,-16)');
    expect(log).toContain('lineTo(128,-16)');
    expect(log).toContain('lineTo(128,16)');
  });

  it('is deterministic: repeated paints give identical call logs', () => {
    for (const doc of DEFAULT_LIVERIES) {
      expect(paint(doc)).toEqual(paint(doc));
      expect(paint(doc, { reflectiveOnly: true })).toEqual(paint(doc, { reflectiveOnly: true }));
    }
    const ctx = new RecordingCtx();
    const doc = defaultLivery('trafficMarked');
    paintLivery(ctx, doc, OPTS);
    const first = ctx.log.slice();
    ctx.log.length = 0;
    paintLivery(ctx, doc, OPTS);
    expect(ctx.log).toEqual(first);
  });

  it('balances save / restore for every default', () => {
    for (const doc of DEFAULT_LIVERIES) {
      for (const reflectiveOnly of [false, true]) {
        const log = paint(doc, { reflectiveOnly });
        expect(log.filter((l) => l === 'save()').length, doc.id).toBe(log.filter((l) => l === 'restore()').length);
      }
    }
  });

  it('every default paints without throwing and draws its text', () => {
    for (const doc of DEFAULT_LIVERIES) {
      const log = paint(doc);
      expect(log.length, doc.id).toBeGreaterThan(5);
      const wanted = doc.layers.filter((l) => l.type === 'text').length;
      expect(texts(log).length, doc.id).toBeGreaterThanOrEqual(wanted);
      expect(log.join('\n'), doc.id).not.toContain('{unit}');
      expect(log.join('\n'), doc.id).not.toContain('NaN');
    }
  });
});
