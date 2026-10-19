import { describe, expect, it } from 'vitest';
import { PROP } from '../../src/render/people/pose';
import { makeHarness, stand, type Harness } from './harness';

function post(h: Harness, x: number, z: number): void {
  stand(h, x, z, -1, 0, -1);
  h.sys.request({ kind: 'tapePost' });
  h.step();
}

describe('scene tape', () => {
  it('closing a tape of three posts makes a no-go zone and draws tape props', () => {
    const h = makeHarness();
    post(h, 0, 0);
    post(h, 12, 0);
    post(h, 12, 9);
    expect(h.world.zones).toHaveLength(0);
    h.sys.request({ kind: 'tapeClose' });
    h.step();
    expect(h.world.zones).toHaveLength(1);
    const zone = h.world.zones[0];
    expect([zone?.minX, zone?.minZ, zone?.maxX, zone?.maxZ]).toEqual([0, 0, 12, 9]);
    expect(Array.from(zone?.points ?? [])).toEqual([0, 0, 12, 0, 12, 9]);
    const ev = h.of('investigation:tape');
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload).toMatchObject({ callId: 42, closed: true, points: [0, 0, 12, 0, 12, 9] });
    let tape = 0;
    for (let i = 0; i < h.sys.props.count; i++) if (h.sys.props.kind[i] === PROP.tape) tape++;
    // 3 posts + one prop every 3 m along 12 m, 9 m and the 15 m closing side.
    expect(tape).toBe(3 + 3 + 2 + 4);
  });

  it('needs the scene tape kit and is used outdoors only', () => {
    const h = makeHarness();
    h.world.kit['sceneTape'] = 0;
    post(h, 0, 0);
    expect(h.flashes()).toContain('No scene tape.');
    h.world.kit['sceneTape'] = 1;
    stand(h, 100, -200, 0, 0);
    h.sys.request({ kind: 'tapePost' });
    h.step();
    expect(h.flashes()).toContain('Scene tape goes up outdoors.');
    expect(h.sys.serialize().tapes).toHaveLength(0);
  });

  it('refuses to close with fewer than three posts and caps the post count', () => {
    const h = makeHarness();
    post(h, 0, 0);
    post(h, 5, 0);
    h.sys.request({ kind: 'tapeClose' });
    h.step();
    expect(h.world.zones).toHaveLength(0);
    expect(h.flashes().some((f) => f.startsWith('Set at least 3 posts'))).toBe(true);
    for (let i = 2; i < 20; i++) post(h, i * 5, 0);
    expect(h.sys.serialize().tapes[0]?.points).toHaveLength(32);
    expect(h.flashes().some((f) => f.startsWith('Scene tape is full'))).toBe(true);
  });

  it('ignores a post set right next to the last one', () => {
    const h = makeHarness();
    post(h, 0, 0);
    post(h, 0.3, 0);
    expect(h.sys.serialize().tapes[0]?.points).toHaveLength(2);
  });

  it('clearing removes the tape and its zone', () => {
    const h = makeHarness();
    post(h, 0, 0);
    post(h, 12, 0);
    post(h, 12, 9);
    h.sys.request({ kind: 'tapeClose' });
    h.step();
    h.sys.request({ kind: 'tapeClear' });
    h.step();
    expect(h.world.zones).toHaveLength(0);
    expect(h.sys.serialize().tapes).toHaveLength(0);
    expect(h.sys.props.count).toBe(0);
    // A second tape can be laid afterwards.
    post(h, 1, 1);
    expect(h.sys.serialize().activeTape).toBe(0);
  });

  it('keeps several closed tapes as separate zones', () => {
    const h = makeHarness();
    for (const dx of [0, 100]) {
      post(h, dx, 0);
      post(h, dx + 10, 0);
      post(h, dx + 10, 10);
      h.sys.request({ kind: 'tapeClose' });
      h.step();
    }
    expect(h.world.zones.map((z) => z.id)).toEqual([1, 2]);
  });
});
