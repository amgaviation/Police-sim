import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Phase6Presenter } from '../../src/game/phase6Presenter';
import type { GameSession } from '../../src/game/session';
import type { ActorInfo } from '../../src/npc';
import { initRapier } from '../../src/physics/physics';
import type { City } from '../../src/world/city';
import { generateCity } from '../../src/world/generate';
import { Harness } from './harness';

const SEED = 42;
let city: City;

beforeAll(async () => {
  await initRapier();
  city = generateCity(SEED);
});

describe('Phase 6 presenter (headless)', () => {
  const live: Harness[] = [];
  afterEach(() => {
    for (const h of live.splice(0)) h.dispose();
  });

  function setup(): { h: Harness; session: GameSession; presenter: Phase6Presenter; flashes: string[] } {
    const h = new Harness(city);
    live.push(h);
    const session = h.start(SEED);
    const flashes: string[] = [];
    const presenter = new Phase6Presenter(null, null, null, null, {
      session: () => session,
      flash: (t) => flashes.push(t),
      closePatrolPanels: () => undefined,
      baseFov: () => 60,
    });
    return { h, session, presenter, flashes };
  }

  it('the backup, pursuit and command panels open, pick through the module requests and close', () => {
    const { h, session, presenter } = setup();
    h.step(session, 60);
    presenter.openBackup();
    expect(presenter.panel.isOpen).toBe(true);
    expect(presenter.panel.model?.title).toBe('Backup');
    presenter.panel.close();
    presenter.openPursuit();
    expect(presenter.panel.model?.title).toBe('Pursuit tactics');
    expect(presenter.panel.model?.options).toHaveLength(7);
    presenter.panel.close();
    presenter.openCommand();
    expect(presenter.panel.model?.title).toBe('Incident command');
    // No command post yet: only "Establish command" is enabled.
    expect(presenter.panel.model?.options[0]?.enabled).not.toBe(false);
    expect(presenter.panel.model?.options[1]?.enabled).toBe(false);
    presenter.panel.close();
    expect(presenter.panel.isOpen).toBe(false);
  });

  it('FLIR needs an air unit; the HUD fill works without any', () => {
    const { h, session, presenter, flashes } = setup();
    h.step(session, 60);
    presenter.toggleFlir();
    expect(presenter.flirOn).toBe(false);
    expect(flashes.at(-1)).toBe('No air unit overhead');
    const hud = { mode: 'onFoot' } as unknown as Parameters<Phase6Presenter['fillHud']>[0];
    presenter.fillHud(hud, session);
    expect(hud.flir).toBe(false);
    expect(hud.backup).toEqual([]);
  });

  it('at a crash scene the command panel assesses and tags a patient (rows 2 and the triage rows)', () => {
    const { h, session, presenter } = setup();
    h.step(session, 60);
    const at = session.playerPosition({ x: 0, z: 0 });
    const id = session.scene.spawnCall('multiVehicleCrash', session.now(), at, [], -1);
    session.dispatcher.request(session.dispatcher.playerCallsign, { kind: 'selfAssign', callId: id }, 'auto');
    h.step(session, 120);
    const loc = session.cad.call(id)?.location;
    if (loc) session.teleport(loc.x, loc.z, 0);
    h.step(session, 120);
    session.phase6.command.request({ kind: 'establish' });
    h.step(session, 60);
    const first = session.phase6.command.board().victims[0];
    const info: ActorInfo = { id: 0, personId: 0, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false, following: false, hidden: false, armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0 };
    const a = first ? session.npc.actor(first.actorId, info) : null;
    if (a) session.teleport(a.x + 1.2, a.z, 0);
    h.step(session, 30);
    presenter.openCommand();
    const options = presenter.panel.model?.options ?? [];
    expect(options[0]?.enabled).toBe(false);
    expect(options[1]?.label).toBe('Assess nearest victim');
    expect(options[1]?.enabled).not.toBe(false);
    expect(presenter.panel.select(1)).toBe(true);
    h.step(session, 60 * 8);
    presenter.updatePanels(session, 10_000);
    expect(session.phase6.command.triage()).not.toBeNull();
    expect(presenter.panel.model?.title).toMatch(/^Triage/);
  }, 120_000);
});
