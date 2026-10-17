import { describe, expect, it } from 'vitest';
import { chunkLayout } from '../../src/world/chunkLayout';
import { generateCity } from '../../src/world/generate';
import { buildChunkMesh, type ChunkMeshData } from '../../src/world/render/chunkMesher';
import { validateBuildRequest, validateInitRequest } from '../../src/world/render/chunkProtocol';
import { ChunkWorkerHost } from '../../src/world/render/chunkWorkerHost';

const SEED = 12345;
const city = generateCity(SEED);

describe('chunk worker protocol validation', () => {
  it('accepts valid requests', () => {
    expect(validateInitRequest({ seed: 7 })).toEqual({ seed: 7 });
    expect(validateBuildRequest({ cx: -14, cz: 13, lod: 1 })).toEqual({ cx: -14, cz: 13, lod: 1 });
  });

  it('rejects malformed payloads with the field name', () => {
    expect(() => validateInitRequest({ seed: Number.NaN })).toThrow(/seed/);
    expect(() => validateInitRequest(null)).toThrow(/seed/);
    expect(() => validateBuildRequest(null)).toThrow(/payload/);
    expect(() => validateBuildRequest({ cx: 14, cz: 0, lod: 0 })).toThrow(/cx/);
    expect(() => validateBuildRequest({ cx: 0.5, cz: 0, lod: 0 })).toThrow(/cx/);
    expect(() => validateBuildRequest({ cx: 0, cz: '1', lod: 0 })).toThrow(/cz/);
    expect(() => validateBuildRequest({ cx: 0, cz: 0, lod: 2 })).toThrow(/lod/);
  });
});

describe('ChunkWorkerHost', () => {
  it('queues builds until init, then answers them in order with transferables', () => {
    const host = new ChunkWorkerHost();
    expect(host.handle({ id: 1, type: 'build', payload: { cx: 0, cz: 0, lod: 0 } })).toEqual([]);
    expect(host.handle({ id: 2, type: 'build', payload: { cx: 1, cz: 0, lod: 1 } })).toEqual([]);
    expect(host.queued).toBe(2);
    const replies = host.handle({ id: 3, type: 'init', payload: { seed: SEED } });
    expect(replies.map((r) => r.response.id)).toEqual([3, 1, 2]);
    expect(replies[0]?.response).toEqual({ id: 3, ok: true, result: { ok: true } });
    const first = replies[1];
    if (!first?.response.ok) throw new Error('build failed');
    const data = first.response.result as ChunkMeshData;
    expect(data).toEqual(buildChunkMesh(city, chunkLayout(city, 0, 0), 0));
    const buffers = data.groups.flatMap((g) => [g.positions.buffer, g.normals.buffer, g.colors.buffer, g.indices.buffer, ...(g.uvs ? [g.uvs.buffer] : [])]);
    expect(first.transfer).toEqual(buffers);
    expect(host.queued).toBe(0);
    // Later builds are answered at once; a repeated init with the same seed keeps the city.
    expect(host.handle({ id: 4, type: 'build', payload: { cx: 0, cz: 0, lod: 1 } })[0]?.response.ok).toBe(true);
    expect(host.handle({ id: 5, type: 'init', payload: { seed: SEED } })).toHaveLength(1);
  });

  it('answers invalid requests with errors instead of throwing', () => {
    const host = new ChunkWorkerHost();
    expect(host.handle({ id: 1, type: 'init', payload: { seed: 'x' } })[0]?.response).toMatchObject({ id: 1, ok: false, error: expect.stringMatching(/seed/) as unknown });
    host.handle({ id: 2, type: 'init', payload: { seed: SEED } });
    expect(host.handle({ id: 3, type: 'build', payload: { cx: 99, cz: 0, lod: 0 } })[0]?.response).toMatchObject({ id: 3, ok: false, error: expect.stringMatching(/cx/) as unknown });
    expect(host.handle({ id: 4, type: 'build', payload: { cx: 0, cz: 0, lod: 3 } })[0]?.response).toMatchObject({ ok: false });
    expect(host.handle({ id: 5, type: 'nope', payload: {} })[0]?.response).toMatchObject({ id: 5, ok: false, error: expect.stringMatching(/unknown/) as unknown });
    expect(host.handle('garbage')).toEqual([]);
    expect(host.handle({ id: 6 })).toEqual([]);
  });
});
