/**
 * Minimal CSS reader for the Phase 9 audits: walks `src/**\/*.css` and yields every declaration with its file, line
 * (1-based, the line the property starts on), the enclosing rule's selector and the raw source line. Comments are blanked
 * (newlines kept) before parsing; the raw line is kept so `/* audit-allow: ... *\/` markers can be read.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const SRC_DIR = join(REPO_ROOT, 'src');

export interface CssDecl {
  /** Path relative to the repo root, '/' separated. */
  readonly file: string;
  readonly line: number;
  /** Selector of the innermost style rule (or the at-rule prelude when a declaration sits directly in one). */
  readonly selector: string;
  readonly prop: string;
  readonly value: string;
  /** The raw source line the declaration starts on (comments intact). */
  readonly raw: string;
}

export interface CssFile {
  readonly file: string;
  readonly text: string;
  readonly decls: readonly CssDecl[];
}

/** Every `.css` file below `dir`, sorted. */
export function findCss(dir: string = SRC_DIR): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.css')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** Replaces comments by spaces, keeping newlines so line numbers stay right. */
export function blankComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/** Parses declarations out of one stylesheet's text. */
export function parseDecls(file: string, text: string): CssDecl[] {
  const css = blankComments(text);
  const rawLines = text.split('\n');
  const out: CssDecl[] = [];
  const stack: string[] = [];
  let buf = '';
  let bufLine = 0;
  let line = 1;
  const flush = (): void => {
    const body = buf.trim();
    if (body !== '') {
      const colon = body.indexOf(':');
      if (colon > 0) {
        out.push({
          file,
          line: bufLine,
          selector: stack[stack.length - 1] ?? '',
          prop: body.slice(0, colon).trim().toLowerCase(),
          value: body.slice(colon + 1).trim(),
          raw: rawLines[bufLine - 1] ?? '',
        });
      }
    }
    buf = '';
  };
  let paren = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i] as string;
    if (c === '\n') line++;
    if (c === '(') paren++;
    else if (c === ')') paren = Math.max(0, paren - 1);
    if (paren === 0 && c === '{') {
      stack.push(buf.trim().replace(/\s+/g, ' '));
      buf = '';
    } else if (paren === 0 && c === '}') {
      flush();
      stack.pop();
    } else if (paren === 0 && c === ';') {
      flush();
    } else {
      if (buf.trim() === '' && c.trim() !== '') bufLine = line;
      buf += c;
    }
  }
  return out;
}

/** All stylesheets under `src`, parsed. */
export function loadCss(): CssFile[] {
  return findCss().map((full) => {
    const text = readFileSync(full, 'utf8');
    const file = relative(REPO_ROOT, full).split(sep).join('/');
    return { file, text, decls: parseDecls(file, text) };
  });
}

/** Custom properties declared in `decls` (any rule). */
export function definedVars(decls: readonly CssDecl[]): Set<string> {
  const out = new Set<string>();
  for (const d of decls) if (d.prop.startsWith('--')) out.add(d.prop);
  return out;
}

/** Names inside `var(--x ...)` of a value. */
export function usedVars(value: string): string[] {
  return [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1] as string);
}

/** `file:line selector { prop: value }` for failure messages. */
export function describe(d: CssDecl): string {
  return `${d.file}:${String(d.line)} ${d.selector} { ${d.prop}: ${d.value} }`;
}
