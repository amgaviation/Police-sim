import { describe, expect, it } from 'vitest';
import { K9_ALERT_CHANCE, K9_TREAT_BONUS } from '../../src/evidence';
import { unitHash } from '../../src/records/hash';
import { SEED, makeHarness, stand, type Harness } from './harness';

/** Phase 7 hooks (design §11.4): the K9 treat port. */

const K9_SALT = 0x6b39;
const START = 'K9 unit arrived and started a sweep.';

/** A call id whose first target roll lands in [plain chance, boosted chance): smelled only with a treat. */
function treatOnlyCall(): number {
  const lo = K9_ALERT_CHANCE.person;
  const hi = Math.min(0.99, lo + K9_TREAT_BONUS);
  for (let c = 1; c < 5000; c++) {
    const u = unitHash(SEED, K9_SALT, c * 64);
    if (u >= lo && u < hi) return c;
  }
  throw new Error('no call id');
}

function withHiddenPerson(h: Harness): void {
  const bedroom = h.layout.rooms.find((r) => r.kind === 'bedroom');
  if (!bedroom) throw new Error('no bedroom');
  const r = bedroom.rect;
  h.world.hidden = [{ actorId: 77, x: (r.minX + r.maxX) / 2, z: (r.minZ + r.maxZ) / 2 }];
  stand(h, 100, -207.5, -1, 0, -1);
}

function counter(answer: boolean): { treat: () => boolean; calls: () => number } {
  let n = 0;
  return {
    treat: () => {
      n++;
      return answer;
    },
    calls: () => n,
  };
}

describe('K9 treats', () => {
  it('asks the treat port once per sweep start and not for a rejected second start', () => {
    const c = counter(true);
    const h = makeHarness({ k9Treat: c.treat });
    h.world.call = 42;
    h.sys.startK9(42);
    expect(c.calls()).toBe(1);
    h.sys.startK9(42);
    expect(c.calls()).toBe(1);
    h.run(60);
    expect(c.calls()).toBe(1);
  });

  it('notes "(rewarded)" in the case file only when a treat was used', () => {
    const rewarded = makeHarness({ k9Treat: () => true });
    rewarded.world.call = 42;
    rewarded.sys.startK9(42);
    expect(rewarded.sys.store.get(42)?.k9[0]?.text).toBe(`${START} (rewarded)`);

    const refused = makeHarness({ k9Treat: () => false });
    refused.world.call = 42;
    refused.sys.startK9(42);
    expect(refused.sys.store.get(42)?.k9[0]?.text).toBe(START);

    const absent = makeHarness();
    absent.world.call = 42;
    absent.sys.startK9(42);
    expect(absent.sys.store.get(42)?.k9[0]?.text).toBe(START);
  });

  it('a treat tips a borderline scent into an alert; the same call without it stays quiet', () => {
    const call = treatOnlyCall();
    const run = (treat: boolean | null): number => {
      const h = makeHarness(treat === null ? {} : { k9Treat: () => treat });
      h.world.call = call;
      withHiddenPerson(h);
      h.sys.startK9(call);
      h.run(200);
      return h.of('investigation:k9Alert').length;
    };
    expect(run(null)).toBe(0);
    expect(run(false)).toBe(0);
    expect(run(true)).toBe(1);
  });

  it('consumes one carried treat through the integrator port', () => {
    const h0 = makeHarness();
    const kit = h0.world.kit;
    kit.k9Treats = 2;
    const h = makeHarness({
      k9Treat: () => {
        if ((kit.k9Treats ?? 0) < 1) return false;
        kit.k9Treats = (kit.k9Treats ?? 0) - 1;
        return true;
      },
    });
    h.world.call = 42;
    h.sys.startK9(42);
    expect(kit.k9Treats).toBe(1);
  });

  it('the rewarded sweep survives a save round trip with its alerts', () => {
    const call = treatOnlyCall();
    const a = makeHarness({ k9Treat: () => true });
    a.world.call = call;
    withHiddenPerson(a);
    a.sys.startK9(call);
    const save = JSON.parse(JSON.stringify(a.sys.serialize())) as ReturnType<typeof a.sys.serialize>;
    expect(save.k9?.alerts.length).toBe(1);
    const b = makeHarness();
    b.world.call = call;
    withHiddenPerson(b);
    b.sys.restore(save);
    b.run(200);
    expect(b.of('investigation:k9Alert')).toHaveLength(1);
  });
});
