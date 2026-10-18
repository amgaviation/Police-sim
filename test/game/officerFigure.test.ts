import { describe, expect, it } from 'vitest';
import { PrevTransform, Transform } from '../../src/ecs/components';
import type { GameSession } from '../../src/game/session';
import { PeoplePresenter } from '../../src/game/peoplePresenter';
import type { UIRoot } from '../../src/ui/ui';

const EID = 7;

function presenter(): PeoplePresenter {
  const ui = { hud: null } as unknown as UIRoot;
  const speech = {} as ConstructorParameters<typeof PeoplePresenter>[2];
  const host = { session: () => null, flash: () => undefined, openForm: () => undefined };
  return new PeoplePresenter(null, ui, speech, host, false);
}

function stubSession(sim: { t: number }): GameSession {
  return {
    driving: false,
    player: EID,
    controller: { yaw: 0 },
    scene: { officerWeapon: 'none', props: { count: 0 } },
    npc: { view: { count: 0 } },
    clock: { get simTime() { return sim.t; } },
  } as unknown as GameSession;
}

describe('the officer figure', () => {
  it('walks at the speed of the last fixed step, whatever the display rate', () => {
    const p = presenter();
    const sim = { t: 1 };
    const session = stubSession(sim);
    const fig = (p as unknown as { officerFigure: { speed: Float32Array; pose: Uint8Array } }).officerFigure;
    // 1.4 m/s walking: 0.0233 m per 60 Hz step.
    PrevTransform.x[EID] = 10;
    PrevTransform.z[EID] = 0;
    Transform.x[EID] = 10 + 1.4 / 60;
    Transform.z[EID] = 0;
    const speeds: number[] = [];
    // A 144 Hz display: only the first frame after a step sees new transforms, the others see none.
    for (let frame = 0; frame < 6; frame++) {
      p.render(session, 0.5, 0, 0, 0, 1 / 144);
      speeds.push(fig.speed[0] ?? -1);
    }
    for (const s of speeds) expect(s).toBeCloseTo(1.4, 3);
    // Paused: no new fixed step for a while, the officer stands.
    for (let frame = 0; frame < 30; frame++) p.render(session, 0.5, 0, 0, 0, 1 / 144);
    expect(fig.speed[0]).toBe(0);
    // Stepping again brings the speed back.
    sim.t += 1 / 60;
    p.render(session, 0.5, 0, 0, 0, 1 / 144);
    expect(fig.speed[0]).toBeCloseTo(1.4, 3);
  });
});
