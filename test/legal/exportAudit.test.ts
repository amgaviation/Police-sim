import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Export audit (Phase 9 §10): every value export (`export function|const|class`) of `src/legal/*.ts` is used, as a whole
 * word, by at least one other test file of `test/legal`. A new export without a test fails here.
 */

const SRC_DIR = fileURLToPath(new URL('../../src/legal/', import.meta.url));
const TEST_DIR = fileURLToPath(new URL('./', import.meta.url));
const SELF = 'exportAudit.test.ts';
const SKIP_SOURCES = new Set(['index.ts', 'events.ts']);
const EXPORT_RE = /^export\s+(?:function|const|class)\s+([A-Za-z_$][\w$]*)/gm;

function exportsOf(source: string): string[] {
  return [...source.matchAll(EXPORT_RE)].map((m) => m[1] ?? '');
}

const sources = readdirSync(SRC_DIR).filter((f) => f.endsWith('.ts') && !SKIP_SOURCES.has(f)).sort();
const tests = readdirSync(TEST_DIR)
  .filter((f) => f.endsWith('.test.ts') && f !== SELF)
  .sort()
  .map((f) => readFileSync(TEST_DIR + f, 'utf8'));

function usedInTests(name: string): boolean {
  const word = new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`);
  return tests.some((text) => word.test(text));
}

describe('export audit (src/legal)', () => {
  it('finds the source files and their exports', () => {
    expect(sources).toEqual(expect.arrayContaining(['evaluate.ts', 'force.ts', 'pursuit.ts', 'report.ts', 'ruleset.ts', 'scores.ts', 'types.ts']));
    expect(sources).not.toContain('index.ts');
    expect(exportsOf('export function a() {}\nexport const B = 1;\nexport class C {}\nexport type D = 1;\n  export const E = 2;')).toEqual(['a', 'B', 'C']);
  });

  for (const file of sources) {
    const names = exportsOf(readFileSync(SRC_DIR + file, 'utf8'));
    it(`${file}: every export is covered by a test`, () => {
      expect(names.length).toBeGreaterThan(0);
      const unused = names.filter((n) => !usedInTests(n));
      expect(unused, `exports of src/legal/${file} that no other test file mentions`).toEqual([]);
    });
  }
});
