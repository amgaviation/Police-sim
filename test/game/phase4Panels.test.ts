import { beforeAll, describe, expect, it } from 'vitest';
import type { CommandContext } from '../../src/debug/console';
import { Transform } from '../../src/ecs/components';
import { createPhase4Commands } from '../../src/game/phase4Commands';
import { PLAYER_SIZE, type GameSession } from '../../src/game/session';
import { DOOR_ACTIONS, doorPanelModel, doorPanelRequest, partnerPanelModel } from '../../src/game/stationPanels';
import { initRapier } from '../../src/physics/physics';
import type { BuildingInfo } from '../../src/world/buildings';
import { Harness } from './harness';

const SEED = 4242;

beforeAll(async () => {
  await initRapier();
});

function house(session: GameSession): BuildingInfo {
  const at = session.playerPosition({ x: 0, z: 0 });
  const out: BuildingInfo[] = [];
  session.buildings.near(at.x, at.z, 700, out);
  const h = out.find((b) => b.kind === 'house' && session.interiors.layout(b.id) !== null);
  if (!h) throw new Error('no house');
  return h;
}

function placeOutside(session: GameSession, h: BuildingInfo): { door: number } {
  const main = session.interiors.layout(h.id)?.doors.find((d) => d.main);
  if (!main?.exit) throw new Error('no front door');
  session.teleport(main.exit.x, main.exit.z, main.exit.yaw + Math.PI);
  return { door: main.index };
}

describe('Phase 4 panels and console commands', () => {
  it('the door panel acts on the door the officer is at (knock, enter) and the hint follows the door', () => {
    const h = new Harness(undefined, undefined, true);
    const session = h.start(SEED, false);
    h.step(session, 60);
    const home = house(session);
    const { door } = placeOutside(session, home);
    h.step(session, 90);
    // A locked front door offers its options; unlocked it offers Enter.
    session.interiors.setDoorState(home.id, door, 'locked');
    expect(session.interactHint()).toBe('locked');
    session.interiors.setDoorState(home.id, door, 'closed');
    expect(session.interactHint()).toBe('enterBuilding');
    const t = session.doorTarget();
    expect(t).not.toBeNull();
    if (!t) return;
    expect(t.outdoors).toBe(true);
    expect(t.buildingId).toBe(home.id);
    const model = doorPanelModel(session, t);
    expect(model.options.length).toBe(DOOR_ACTIONS.length);
    expect(model.options[7]?.enabled).toBe(!t.locked);
    // Knock (row 0): the system emits a door event by the officer.
    const knocks: string[] = [];
    const off = session.bus.on('interior:door', (e) => knocks.push(`${e.by}:${e.action}`));
    expect(doorPanelRequest(session, t, 0)).toBeNull();
    h.step(session, 3);
    expect(knocks).toContain('officer:knock');
    // Enter (row 7) unlocks nothing: a locked door refuses, an unlocked one fades in.
    session.interiors.setDoorState(home.id, t.door, 'closed');
    doorPanelRequest(session, t, 7);
    h.step(session, 90);
    expect(session.officerBuilding).toBe(home.id);
    off();
    h.dispose();
  }, 60_000);

  it('the partner panel offers Summon while the partner is away and commands once it is on scene', () => {
    const h = new Harness(undefined, undefined, true);
    const session = h.start(SEED, true);
    h.step(session, 30);
    const away = partnerPanelModel(session);
    expect(away.options.map((o) => o.enabled !== false)).toEqual([false, false, false, false, true]);
    expect(away.options[4]?.label).toBe('Summon');
    session.tactical.request({ kind: 'partner', command: 'summon' });
    h.step(session, 10);
    const on = partnerPanelModel(session);
    expect(on.options[4]?.label).toBe('Dismiss');
    expect(on.options.every((o) => o.enabled !== false)).toBe(true);
    h.dispose();
  }, 30_000);

  it('the console commands run from the station and a house', async () => {
    const h = new Harness(undefined, undefined, true);
    const session = h.start(SEED, true);
    h.step(session, 30);
    const flashes: string[] = [];
    const commands = createPhase4Commands({ session: () => session, flash: (t) => flashes.push(t) });
    const ctx = { console: null, print: () => undefined } as unknown as CommandContext;
    const run = async (name: string, ...args: string[]): Promise<string> => {
      const c = commands.find((x) => x.name === name);
      if (!c) throw new Error(`no command ${name}`);
      return String((await c.run(args, ctx)) ?? '');
    };
    expect(await run('building', 'here')).toContain('policeStation');
    expect(await run('interior', 'info')).toContain('rooms');
    expect(await run('interior', 'gen', 'house', '7')).toContain('deterministic: yes');
    expect(await run('interior', 'gen', 'bank', '3')).toContain('deterministic: yes');
    expect(await run('interior', 'doors')).toContain('main');
    expect(await run('shift')).toContain('Step: locker');
    expect(await run('shift', 'briefing')).toContain('Step:');
    expect(await run('armory', 'out', 'sidearm')).toContain('Signed out');
    expect(await run('loadout')).toContain('uniform');
    expect(await run('case')).toContain('Case 0');
    expect(await run('evidence', 'list')).toContain('No evidence');
    expect(await run('ledger', 'verify')).toContain('intact');
    expect(await run('sound', 'debug')).toContain('noise');
    expect(await run('partner', 'summon')).toContain('summon');
    expect(await run('aware')).toBeTypeOf('string');
    h.step(session, 10);
    // Entering a building by kind puts the officer inside; exit puts them back outdoors.
    expect(await run('interior', 'enter', 'house')).toContain('Inside house');
    h.step(session, 10);
    expect(session.officerBuilding).toBeGreaterThanOrEqual(0);
    expect(session.interiors.layout(session.officerBuilding)?.kind).toBe('house');
    expect(await run('interior', 'exit')).toBe('Outside');
    h.step(session, 10);
    expect(session.officerBuilding).toBe(-1);
    // Transform y follows the level back outdoors.
    expect(Transform.y[session.player]).toBeCloseTo(PLAYER_SIZE.y / 2, 1);
    h.dispose();
  }, 60_000);
});
