/**
 * docs/ASSETS.md: no real product names or trademarks in anything the player can read. Internal ids (`taser`, `TaserArc`,
 * config keys) are not display text and stay; this scans the data files' values and the string literals of the UI,
 * incident, legal, force and command sources for a small deny-list.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../../src');
// Case matters: lower-case `taser` / `flir` are internal ids and config keys, the display forms are upper or capitalised.
const MARKS = ['taser', 'glock', 'kevlar', 'flir', 'sig sauer', 'smith & wesson', 'beretta', 'remington', 'mossberg', 'motorola', 'axon', 'maglite', 'streamlight', 'pepperball', 'crown victoria'];
const forms = MARKS.flatMap((m) => [m.toUpperCase(), m.replace(/(^|\s)(\w)/g, (_, a: string, b: string) => a + b.toUpperCase())]);
const DENY = new RegExp(`\\b(${forms.join('|')})\\b`);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Every string value of a JSON document (keys are ids and may stay). */
function jsonValues(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) jsonValues(x, out);
  else if (typeof v === 'object' && v !== null) for (const x of Object.values(v)) jsonValues(x, out);
  return out;
}

/** String literals of a source file; comments and identifiers are not player-visible. */
function literals(text: string): string[] {
  return [...text.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
}

describe('trademark deny-list', () => {
  it('has no listed mark in a data file value', () => {
    const bad: string[] = [];
    for (const f of walk(path.join(SRC, 'data')).filter((p) => p.endsWith('.json'))) {
      for (const s of jsonValues(JSON.parse(readFileSync(f, 'utf8')) as unknown)) if (DENY.test(s)) bad.push(`${path.relative(SRC, f)}: ${s}`);
    }
    expect(bad).toEqual([]);
  });

  it('has no listed mark in a string literal of the sources', () => {
    const bad: string[] = [];
    for (const f of walk(SRC).filter((p) => p.endsWith('.ts'))) {
      for (const s of literals(readFileSync(f, 'utf8'))) if (DENY.test(s)) bad.push(`${path.relative(SRC, f)}: ${s.slice(0, 80)}`);
    }
    expect(bad).toEqual([]);
  });

  it('the pattern catches the marks', () => {
    for (const s of ['TASER 2/2', 'a Glock 17', 'Kevlar vest', 'FLIR BHOT']) expect(DENY.test(s), s).toBe(true);
    expect(DENY.test('CED 2/2')).toBe(false);
    expect(DENY.test('Ford')).toBe(false);
  });
});
