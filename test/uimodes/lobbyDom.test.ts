import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CoopLobby, type CoopLobbyHost } from '../../src/ui/coop/lobby';
import type { UIRoot } from '../../src/ui/ui';
import { FakeElement, fakeUi, findAll, findButton, installFakeDom } from '../ui7/fakeDom';

let undo: () => void = () => undefined;
beforeAll(() => {
  undo = installFakeDom();
});
afterAll(() => undo());

describe('CoopLobby (DOM double)', () => {
  function build(initial = 'idle') {
    let status = { state: initial, text: '' };
    const calls: unknown[][] = [];
    const host: CoopLobbyHost = {
      connect: (...a) => void calls.push(['connect', ...a]),
      status: () => status,
      start: () => void calls.push(['start']),
      cancel: () => void calls.push(['cancel']),
    };
    const store = new Map<string, string>();
    const ui = fakeUi();
    const lobby = new CoopLobby(ui as unknown as UIRoot, host, { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) });
    lobby.open();
    return { lobby, calls, ui, root: lobby.element as unknown as FakeElement, setStatus: (s: { state: string; text: string }) => void (status = s), store };
  }

  it('explains that multiplayer is optional and local, and shows the default address', () => {
    const { root, ui, lobby } = build();
    expect(ui.stack).toContain(lobby);
    expect(root.textContent).toContain('Optional. Run npm run server on this computer or your local network. Nothing is sent anywhere else.');
    expect(findAll(root, (e) => e.id === 'coop-url')[0]?.value).toBe('ws://localhost:8787');
  });

  it('connects from the buttons and enables Start only when joined', () => {
    const { root, calls, setStatus, lobby, store } = build();
    const connect = findButton(root, 'Connect');
    const start = findButton(root, 'Start');
    expect(connect.disabled).toBe(false);
    expect(start.disabled).toBe(true);
    const name = findAll(root, (e) => e.id === 'coop-name')[0];
    if (name) {
      name.value = 'Casey';
      name.fire('input');
    }
    connect.click();
    expect(calls).toEqual([['connect', 'ws://localhost:8787', 'patrol', 'Casey', 'patrol']]);
    expect(store.get('patrol-coop')).toContain('Casey');
    setStatus({ state: 'connecting', text: '' });
    lobby.refresh();
    expect(connect.disabled).toBe(true);
    setStatus({ state: 'joined', text: 'Joined as N1' });
    lobby.refresh();
    expect(start.disabled).toBe(false);
    expect(findAll(root, (e) => e.className.includes('cl-status'))[0]?.textContent).toBe('Joined as N1');
    start.click();
    expect(calls.at(-1)).toEqual(['start']);
  });

  it('shows form problems and disables Connect', () => {
    const { root } = build();
    const room = findAll(root, (e) => e.id === 'coop-room')[0];
    if (room) {
      room.value = '';
      room.fire('input');
    }
    expect(findButton(root, 'Connect').disabled).toBe(true);
    expect(findAll(root, (e) => e.className.includes('cl-error'))[0]?.textContent).toMatch(/room name/i);
  });

  it('Cancel tells the host and closes the lobby', () => {
    const { root, calls, ui, lobby } = build();
    findButton(root, 'Cancel').click();
    expect(calls.at(-1)).toEqual(['cancel']);
    expect(ui.stack).not.toContain(lobby);
  });
});
