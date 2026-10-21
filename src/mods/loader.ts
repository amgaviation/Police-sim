/**
 * Reads a mod from picked files (design §10.4): one `.json` bundle, or a folder with `mod.json` (the manifest plus a
 * `files` map of content kind -> relative paths) that is assembled into the same bundle document. Only reads and
 * assembles; `validateModBundle` checks the result.
 */
import { MOD_CONTENT_KINDS, MOD_MAX_BYTES } from './types';

/** Structural view of a browser `File` (test seam). */
export interface FileLike {
  readonly name: string;
  readonly webkitRelativePath?: string;
  readonly size: number;
  text(): Promise<string>;
}

export type ReadResult = { ok: true; json: unknown; size: number } | { ok: false; errors: string[] };

const KINDS: readonly string[] = MOD_CONTENT_KINDS;
/** Kinds whose file holds a single patch object instead of one document per file. */
const OBJECT_KINDS: readonly string[] = ['uniforms', 'districts'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function pathOf(f: FileLike): string {
  const p = f.webkitRelativePath;
  return p !== undefined && p !== '' ? p : f.name;
}

/** Path with the picked folder's own name removed ("pack/calls/a.json" -> "calls/a.json"), "." and ".." resolved. */
function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

async function parseJson(f: FileLike, name: string, errors: string[]): Promise<unknown> {
  let text: string;
  try {
    text = await f.text();
  } catch (e) {
    errors.push(`${name}: could not be read (${e instanceof Error ? e.message : String(e)})`);
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    errors.push(`${name}: not valid JSON (${e instanceof Error ? e.message : String(e)})`);
    return undefined;
  }
}

/**
 * One `.json` file is the bundle itself. Several files must contain a `mod.json` (its folder is the mod root); every
 * path of its `files` map must be among the picked files. Errors read like "No mod.json in the selected folder",
 * "calls/x.json: not valid JSON (Unexpected token ...)" or "Mod is 3.1 MiB; the limit is 2 MiB".
 */
export async function readModFiles(files: readonly FileLike[]): Promise<ReadResult> {
  if (files.length === 0) return { ok: false, errors: ['No file selected'] };
  const size = files.reduce((n, f) => n + f.size, 0);
  if (size > MOD_MAX_BYTES) return { ok: false, errors: [`Mod is ${mib(size)}; the limit is ${mib(MOD_MAX_BYTES)}`] };
  const errors: string[] = [];

  const manifestFile = files.find((f) => f.name === 'mod.json');
  if (manifestFile === undefined) {
    const only = files.length === 1 ? files[0] : undefined;
    if (only === undefined) return { ok: false, errors: ['No mod.json in the selected folder'] };
    if (!/\.json$/i.test(only.name)) return { ok: false, errors: [`${only.name}: a mod must be a .json file or a folder with mod.json`] };
    const json = await parseJson(only, only.name, errors);
    return errors.length > 0 ? { ok: false, errors } : { ok: true, json, size };
  }

  const manifestPath = normalize(pathOf(manifestFile));
  const slash = manifestPath.lastIndexOf('/');
  const root = slash < 0 ? '' : manifestPath.slice(0, slash + 1);
  const byPath = new Map<string, FileLike>();
  for (const f of files) {
    const p = normalize(pathOf(f));
    byPath.set(p.startsWith(root) ? p.slice(root.length) : p, f);
  }

  const manifest = await parseJson(manifestFile, 'mod.json', errors);
  if (errors.length > 0) return { ok: false, errors };
  if (!isRecord(manifest)) return { ok: false, errors: ['mod.json: must be a JSON object'] };
  const { files: map, ...rest } = manifest;
  if (map !== undefined && !isRecord(map)) return { ok: false, errors: ['mod.json: files must be an object of kind -> list of paths'] };
  const content: Record<string, unknown> = isRecord(rest.content) ? { ...rest.content } : {};

  for (const [kind, paths] of Object.entries(map ?? {})) {
    if (!KINDS.includes(kind)) {
      errors.push(`mod.json: files.${kind}: unknown content kind (expected one of ${MOD_CONTENT_KINDS.join(', ')})`);
      continue;
    }
    if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string')) {
      errors.push(`mod.json: files.${kind}: must be an array of relative paths`);
      continue;
    }
    const docs: unknown[] = [];
    for (const rel of paths as string[]) {
      const name = normalize(rel);
      const f = byPath.get(name);
      if (f === undefined) {
        errors.push(`mod.json: files.${kind}: ${rel} was not among the selected files`);
        continue;
      }
      const doc = await parseJson(f, name, errors);
      if (doc === undefined) continue;
      if (kind === 'rulesets' && isRecord(doc) && typeof doc.id === 'string') {
        const stem = name.slice(name.lastIndexOf('/') + 1).replace(/\.json$/i, '');
        if (stem !== doc.id) errors.push(`${name}: ruleset id ${JSON.stringify(doc.id)} must equal the file name "${stem}"`);
      }
      docs.push(doc);
    }
    if (OBJECT_KINDS.includes(kind)) {
      // Patch files are merged in order (later files win per key).
      const merged: Record<string, unknown> = {};
      docs.forEach((d, i) => {
        if (isRecord(d)) Object.assign(merged, d);
        else errors.push(`mod.json: files.${kind}[${i}]: ${String(paths[i])} must contain a JSON object`);
      });
      content[kind] = merged;
    } else if (kind === 'statutes') {
      content[kind] = docs.flatMap((d) => (Array.isArray(d) ? (d as unknown[]) : [d]));
    } else if (kind === 'callTypes') {
      // Files copied from src/data/calls/types carry "version"; the bundle format has none.
      content[kind] = docs.map((d) => {
        if (!isRecord(d) || d.version === undefined) return d;
        const { version: _version, ...doc } = d;
        return doc;
      });
    } else {
      content[kind] = docs;
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, json: { ...rest, content }, size };
}
