import { describe, expect, it } from 'vitest';
import { bigRoom, clearPair, makeHarness, placeSpec, stand, yawTo, type Harness } from './harness';

/** A busy but idle session: 30 items in view range (most not yet found), markers, a closed tape and a case file. */
function loaded(): Harness {
  const h = makeHarness();
  const room = bigRoom(h.layout);
  const pair = clearPair(h.layout, room);
  stand(h, pair.officer.x, pair.officer.z, room, yawTo(pair.officer.x, pair.officer.z, pair.item.x, pair.item.z));
  h.world.calls.set(42, {
    exigency: false, warrant: false, arrests: [], buildingId: h.layout.buildingId, family: 'property',
    suspectPersonId: 7, anchorX: 100, anchorZ: -200,
  });
  for (let i = 0; i < 30; i++) {
    h.sys.placeItem(placeSpec(h, { x: pair.item.x + (i % 5) * 0.1, z: pair.item.z, y: 0.1, room, concealed: i % 3 === 0, container: i % 3 === 0 ? 'drawer' : 'none' }));
  }
  for (let i = 0; i < 5; i++) {
    h.sys.request({ kind: 'marker' });
    h.step();
  }
  h.run(1);
  return h;
}

/** Mean milliseconds of one `step` over `n` steps; best of three runs to shrug off scheduler noise. */
function meanStepMs(h: Harness, n: number): number {
  let best = Infinity;
  for (let run = 0; run < 3; run++) {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) h.step();
    best = Math.min(best, (performance.now() - t0) / n);
  }
  return best;
}

describe('performance', () => {
  it('an idle step costs at most 0.02 ms, the plain-view passes included', () => {
    const h = loaded();
    h.run(2);
    expect(meanStepMs(h, 3000)).toBeLessThanOrEqual(0.02);
  });

  it('a plain-view pass over 30 candidate items costs at most 0.1 ms', () => {
    const h = loaded();
    // The scan runs every 30 steps; time the steps individually and look at the slowest 3 % (the scan steps).
    const times: number[] = [];
    for (let i = 0; i < 1800; i++) {
      const t0 = performance.now();
      h.step();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const scans = times.slice(Math.floor(times.length * 0.97));
    const median = scans[Math.floor(scans.length / 2)] ?? 0;
    expect(median).toBeLessThanOrEqual(0.1);
  });

  it('does not rebuild props or live lists on idle steps', () => {
    const h = loaded();
    const rev = h.sys.revision;
    h.run(5);
    expect(h.sys.revision).toBe(rev);
  });
});
