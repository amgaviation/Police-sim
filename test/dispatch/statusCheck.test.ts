import { describe, expect, it } from 'vitest';
import type { DispatchLocationEvent, DispatchStatusCheckEvent } from '../../src/cad/events';
import { DISPATCH_CONFIG } from '../../src/dispatch/data';
import { eventsOf, makeHarness, quietConfig, run, step, type Harness } from './helpers';

const SC = DISPATCH_CONFIG.statusCheck;

async function onScene(): Promise<Harness> {
  const h = await makeHarness({ config: quietConfig() });
  h.dispatcher.request('12', { kind: 'status', status: 'onScene' }, 'radio');
  step(h);
  return h;
}

function checks(h: Harness): DispatchStatusCheckEvent[] {
  return eventsOf<DispatchStatusCheckEvent>(h, 'dispatch:statusCheck');
}

describe('status checks', () => {
  it('asks after afterS on scene, again with a 10-20 request, then escalates to a welfare call', async () => {
    const h = await onScene();
    run(h, SC.afterS - 2);
    expect(checks(h)).toEqual([]);
    run(h, 3);
    expect(checks(h)).toHaveLength(1);
    expect(checks(h)[0]).toMatchObject({ callsign: '12', attempt: 1, escalated: false });
    expect(checks(h)[0]?.location.length).toBeGreaterThan(0);

    run(h, SC.responseS + 0.5);
    expect(checks(h)).toHaveLength(2);
    expect(checks(h)[1]).toMatchObject({ attempt: 2, escalated: false });
    expect(eventsOf<DispatchLocationEvent>(h, 'dispatch:location')).toEqual([{ callsign: '12', text: '', asked: true }]);

    run(h, SC.responseS + 0.5);
    expect(checks(h)).toHaveLength(3);
    expect(checks(h)[2]).toMatchObject({ escalated: true });
    const welfare = h.cad.calls().find((c) => c.typeId === 'officerWelfare');
    expect(welfare?.priority).toBe(1);
    expect(welfare?.units).toHaveLength(SC.escalateUnits);
    const pu = h.cad.playerUnit();
    expect(Math.hypot((welfare?.location.x ?? 0) - (pu?.x ?? 0), (welfare?.location.z ?? 0) - (pu?.z ?? 0))).toBeLessThan(1);
    // No further checks while escalated.
    run(h, SC.responseS * 2);
    expect(checks(h)).toHaveLength(3);

    // The 10-20 answers: the welfare units stand down after releaseS and the call closes.
    h.dispatcher.request('12', { kind: 'location' }, 'radio');
    step(h);
    expect(eventsOf<DispatchLocationEvent>(h, 'dispatch:location').at(-1)?.asked).toBe(false);
    run(h, DISPATCH_CONFIG.backup.releaseS + 1);
    expect(welfare?.status).toBe('closed');
    expect(welfare?.disposition).toBe('handled');
  });

  it('any request answers a check and restarts the timer', async () => {
    const h = await onScene();
    run(h, SC.afterS + 1);
    expect(checks(h)).toHaveLength(1);
    h.dispatcher.request('12', { kind: 'code4' }, 'radio');
    step(h);
    run(h, SC.responseS * 3);
    expect(checks(h)).toHaveLength(1);
    run(h, SC.afterS - SC.responseS * 3 + 1);
    expect(checks(h)).toHaveLength(2);
    expect(checks(h)[1]?.attempt).toBe(1);
  });

  it('never checks an available or en-route unit', async () => {
    const h = await makeHarness({ config: quietConfig() });
    run(h, SC.afterS + SC.responseS * 3);
    expect(checks(h)).toEqual([]);
  });
});
