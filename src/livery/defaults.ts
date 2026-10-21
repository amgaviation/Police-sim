/** The 17 shipped liveries (`src/data/livery/<id>.json`, one document per file; Phase 7 §6.3). */
import { parseLivery } from './schema';
import type { LiveryDoc } from './types';

function loadDefaults(): readonly LiveryDoc[] {
  const files = import.meta.glob<unknown>('../data/livery/*.json', { eager: true, import: 'default' });
  const docs: LiveryDoc[] = [];
  for (const path of Object.keys(files).sort()) {
    const file = path.slice(path.lastIndexOf('/') + 1);
    const result = parseLivery(files[path]);
    if (!result.ok) throw new Error(`${file}: ${result.errors.join('; ')}`);
    const stem = file.replace(/\.json$/, '');
    if (result.livery.id !== stem) throw new Error(`${file}: id: must equal the file name "${stem}", got "${result.livery.id}"`);
    docs.push(result.livery);
  }
  return docs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Every default livery, sorted by id. */
export const DEFAULT_LIVERIES: readonly LiveryDoc[] = loadDefaults();

/** The default livery `id`; throws on an unknown id. */
export function defaultLivery(id: string): LiveryDoc {
  const found = DEFAULT_LIVERIES.find((l) => l.id === id);
  if (!found) throw new Error(`livery: unknown default livery "${id}"`);
  return found;
}
