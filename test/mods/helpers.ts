import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { FileLike } from '../../src/mods/loader';
import type { ModValidationContext } from '../../src/mods/combine';
import { defaultModContext } from '../../src/mods/schema';
import type { ModBundle } from '../../src/mods/types';

export const ROOT = join(__dirname, '..', '..');
export const EXAMPLES = join(ROOT, 'examples', 'mods');

/** Parsed JSON of a file below the repository root. */
export function readJson(...parts: string[]): unknown {
  return JSON.parse(readFileSync(join(ROOT, ...parts), 'utf8')) as unknown;
}

/** A fresh deep copy of the example bundle (tests mutate it). */
export function nightShiftPack(): Record<string, unknown> {
  return readJson('examples', 'mods', 'night-shift-pack.json') as Record<string, unknown>;
}

/** FileLike objects for every file below `dir`, with `webkitRelativePath` starting at the folder name. */
export function folderFiles(dir: string): FileLike[] {
  const out: FileLike[] = [];
  const base = join(dir, '..');
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const text = readFileSync(full, 'utf8');
        out.push({ name, webkitRelativePath: relative(base, full).replace(/\\/g, '/'), size: text.length, text: () => Promise.resolve(text) });
      }
    }
  };
  walk(dir);
  return out;
}

export function fileLike(name: string, text: string, webkitRelativePath?: string): FileLike {
  return { name, size: text.length, text: () => Promise.resolve(text), ...(webkitRelativePath === undefined ? {} : { webkitRelativePath }) };
}

/** The real context (cached: building it is cheap but the checks parse the whole call catalog). */
let cached: ModValidationContext | null = null;
export function realContext(): ModValidationContext {
  cached ??= defaultModContext();
  return cached;
}

/** A context that accepts everything; individual checks can be overridden. */
export function fakeContext(over: Partial<ModValidationContext> = {}): ModValidationContext {
  return {
    baseCallTypeIds: new Set(['barFight']),
    familyIds: new Set(['parking', 'disturbance']),
    baseVehicleIds: new Set(['patrol_sedan']),
    baseRulesetIds: new Set(['generic']),
    baseStatuteIds: new Set(['TR-301']),
    baseScriptIds: ['friday-night'],
    districts: ['downtown', 'harbor'],
    uniformClassIds: ['classA', 'classB'],
    phraseKinds: ['assign', 'accept'],
    checkCallTypes: () => [],
    checkVehicle: () => [],
    checkRuleset: () => [],
    checkStatutes: () => [],
    checkUniforms: () => [],
    checkPhrases: () => [],
    checkScript: () => [],
    ...over,
  };
}

/** A minimal valid bundle around `content`. */
export function bundle(id: string, content: ModBundle['content']): ModBundle {
  return { format: 'patrol-mod', version: 1, id, name: id, author: '', description: '', modVersion: '1.0.0', content };
}
