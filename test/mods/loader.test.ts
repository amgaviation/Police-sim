import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readModFiles } from '../../src/mods/loader';
import { validateCombination } from '../../src/mods/combine';
import { validateModBundle } from '../../src/mods/schema';
import { MOD_MAX_BYTES, type ModBundle } from '../../src/mods/types';
import { EXAMPLES, fileLike, folderFiles, nightShiftPack, realContext } from './helpers';

const MIB = 1024 * 1024;

describe('readModFiles: single file', () => {
  it('returns the parsed document and its size', async () => {
    const text = JSON.stringify(nightShiftPack());
    const r = await readModFiles([fileLike('night-shift-pack.json', text)]);
    expect(r).toEqual({ ok: true, json: nightShiftPack(), size: text.length });
  });

  it('reports invalid JSON with the file name', async () => {
    const r = await readModFiles([fileLike('broken.json', '{ "format": ')]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/^broken\.json: not valid JSON \(.+\)$/);
  });

  it('rejects a single file that is not .json and an empty selection', async () => {
    expect(await readModFiles([fileLike('mod.zip', 'x')])).toEqual({ ok: false, errors: ['mod.zip: a mod must be a .json file or a folder with mod.json'] });
    expect(await readModFiles([])).toEqual({ ok: false, errors: ['No file selected'] });
  });

  it('rejects a mod over the size limit before reading it', async () => {
    let read = false;
    const big = { name: 'big.json', size: Math.round(3.1 * MIB), text: () => ((read = true), Promise.resolve('{}')) };
    expect(await readModFiles([big])).toEqual({ ok: false, errors: ['Mod is 3.1 MiB; the limit is 2.0 MiB'] });
    expect(read).toBe(false);
    expect(MOD_MAX_BYTES).toBe(2 * MIB);
    const exact = { name: 'edge.json', size: MOD_MAX_BYTES, text: () => Promise.resolve('{}') };
    expect((await readModFiles([exact])).ok).toBe(true);
  });

  it('counts all files of a folder against the limit', async () => {
    const files = [fileLike('mod.json', '{}'), { name: 'a.json', size: Math.round(2.5 * MIB), text: () => Promise.resolve('{}') }];
    expect(await readModFiles(files)).toEqual({ ok: false, errors: ['Mod is 2.5 MiB; the limit is 2.0 MiB'] });
  });

  it('reports a file that cannot be read', async () => {
    const f = { name: 'a.json', size: 2, text: () => Promise.reject(new Error('denied')) };
    expect(await readModFiles([f])).toEqual({ ok: false, errors: ['a.json: could not be read (denied)'] });
  });
});

describe('readModFiles: folder', () => {
  const dir = join(EXAMPLES, 'example-folder');

  it('assembles the example folder into a bundle that validates', async () => {
    const r = await readModFiles(folderFiles(dir));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const doc = r.json as Record<string, unknown>;
    expect(doc.files).toBeUndefined();
    expect(Object.keys(doc.content as object).sort()).toEqual(['callTypes', 'dispatchScripts', 'districts', 'rulesets', 'uniforms', 'voicePacks']);
    const v = validateModBundle(r.json, realContext());
    expect(v.ok, JSON.stringify(v)).toBe(true);
  });

  it('works without the folder name in the relative paths', async () => {
    const files = folderFiles(dir).map((f) => ({ ...f, webkitRelativePath: (f.webkitRelativePath ?? '').replace(/^example-folder\//, '') }));
    const r = await readModFiles(files);
    expect(r.ok).toBe(true);
  });

  it('merges object kinds in order and strips "version" from call type files', async () => {
    const files = [
      fileLike('mod.json', JSON.stringify({ format: 'patrol-mod', version: 1, id: 'm-one', name: 'm', author: '', description: '', modVersion: '1.0.0',
        files: { districts: ['d1.json', 'd2.json'], callTypes: ['t.json'], statutes: ['s.json'] } })),
      fileLike('d1.json', '{"harbor":{"label":"One"},"park":{"label":"P"}}'),
      fileLike('d2.json', '{"harbor":{"label":"Two"}}'),
      fileLike('t.json', '{"version":1,"family":"parking","types":[]}'),
      fileLike('s.json', '[{"id":"TR-1"},{"id":"TR-2"}]'),
    ];
    const r = await readModFiles(files);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const content = (r.json as { content: Record<string, unknown> }).content;
    expect(content.districts).toEqual({ harbor: { label: 'Two' }, park: { label: 'P' } });
    expect(content.callTypes).toEqual([{ family: 'parking', types: [] }]);
    expect(content.statutes).toEqual([{ id: 'TR-1' }, { id: 'TR-2' }]);
  });

  it('reports a missing mod.json', async () => {
    const r = await readModFiles([fileLike('a.json', '{}'), fileLike('b.json', '{}')]);
    expect(r).toEqual({ ok: false, errors: ['No mod.json in the selected folder'] });
  });

  it('reports invalid JSON in a content file with its path', async () => {
    const files = folderFiles(dir).map((f) => (f.name === 'noise.json' ? fileLike('noise.json', '{ nope', f.webkitRelativePath) : f));
    const r = await readModFiles(files);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual([expect.stringMatching(/^calls\/noise\.json: not valid JSON \(/)]);
  });

  it('reports invalid JSON in mod.json', async () => {
    const r = await readModFiles([fileLike('mod.json', 'not json'), fileLike('x.json', '{}')]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/^mod\.json: not valid JSON/);
  });

  it('reports files that are listed but were not selected, and unknown kinds', async () => {
    const files = [
      fileLike('mod.json', JSON.stringify({ format: 'patrol-mod', files: { vehicles: ['cars/a.json'], maps: ['m.json'], statutes: 'x' } })),
      fileLike('other.json', '{}'),
    ];
    const r = await readModFiles(files);
    expect(r).toEqual({
      ok: false,
      errors: [
        'mod.json: files.vehicles: cars/a.json was not among the selected files',
        'mod.json: files.maps: unknown content kind (expected one of callTypes, statutes, rulesets, vehicles, uniforms, districts, voicePacks, dispatchScripts)',
        'mod.json: files.statutes: must be an array of relative paths',
      ],
    });
  });

  it('reports a ruleset whose id differs from its file name', async () => {
    const files = [
      fileLike('mod.json', JSON.stringify({ format: 'patrol-mod', files: { rulesets: ['laws/renamed.json'] } }), 'pack/mod.json'),
      fileLike('renamed.json', JSON.stringify({ id: 'example-city' }), 'pack/laws/renamed.json'),
    ];
    expect(await readModFiles(files)).toEqual({ ok: false, errors: ['laws/renamed.json: ruleset id "example-city" must equal the file name "renamed"'] });
  });

  it('rejects a mod.json that is not an object and a bad files map', async () => {
    expect(await readModFiles([fileLike('mod.json', '[]'), fileLike('a.json', '{}')])).toEqual({ ok: false, errors: ['mod.json: must be a JSON object'] });
    expect(await readModFiles([fileLike('mod.json', '{"files":[]}'), fileLike('a.json', '{}')])).toEqual({
      ok: false,
      errors: ['mod.json: files must be an object of kind -> list of paths'],
    });
  });
});

describe('the two example mods', () => {
  it('validate and combine without conflicts', async () => {
    const folder = await readModFiles(folderFiles(join(EXAMPLES, 'example-folder')));
    if (!folder.ok) throw new Error(folder.errors.join('; '));
    const a = validateModBundle(nightShiftPack(), realContext());
    const b = validateModBundle(folder.json, realContext());
    if (!a.ok || !b.ok) throw new Error('example invalid');
    const active: ModBundle[] = [b.mod, a.mod];
    expect(validateCombination(active, realContext())).toEqual([]);
  });
});
