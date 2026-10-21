import { describe, expect, it } from 'vitest';
import { SaveModsError, describeModMismatch } from '../../src/save/mods';

const ref = (id: string, version = '1.0.0', hash = '0123abcd') => ({ id, modVersion: version, hash });

describe('describeModMismatch', () => {
  it('is null for the same set of mods in any order', () => {
    expect(describeModMismatch([], [])).toBeNull();
    expect(describeModMismatch([ref('a'), ref('b')], [ref('b'), ref('a')])).toBeNull();
  });

  it('names a mod the save was made with that is not active', () => {
    const text = describeModMismatch([ref('night-shift-pack', '1.2.0')], []);
    expect(text).toContain('This save was made with mods: night-shift-pack 1.2.0');
    expect(text).toContain('missing: night-shift-pack 1.2.0');
  });

  it('names a changed mod (another hash or version) and an extra active mod', () => {
    expect(describeModMismatch([ref('a', '1.0.0', 'aaaaaaaa')], [ref('a', '1.0.0', 'bbbbbbbb')])).toContain('changed: a 1.0.0');
    expect(describeModMismatch([ref('a', '1.0.0')], [ref('a', '1.1.0')])).toContain('changed: a 1.0.0');
    expect(describeModMismatch([], [ref('extra')])).toContain('not in the save: extra 1.0.0');
  });

  it('treats unvalidated data that is not a list of refs as no mods', () => {
    expect(describeModMismatch(undefined, [])).toBeNull();
    expect(describeModMismatch({ id: 'a' }, [])).toBeNull();
    expect(describeModMismatch([42, null, { id: 'x' }], [ref('b')])).toContain('made with mods: no mods');
  });

  it('SaveModsError carries the message', () => {
    const e = new SaveModsError('This save was made with mods: x 1.0.0', ['x']);
    expect(e.name).toBe('SaveModsError');
    expect(e.missing).toEqual(['x']);
  });
});
