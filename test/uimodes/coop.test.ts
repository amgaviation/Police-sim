import { describe, expect, it } from 'vitest';
import type { NetUnit } from '../../src/net';
import { DEFAULT_SERVER_URL, LIMITS } from '../../src/net';
import {
  COOP_PREFS_KEY,
  CoopLobby,
  DEFAULT_LOBBY_FORM,
  LOBBY_EXPLANATION,
  loadCoopPrefs,
  lobbyModel,
  saveCoopPrefs,
  validateLobbyForm,
  type CoopLobbyHost,
} from '../../src/ui/coop/lobby';
import { CoopPanel, coopPanelIntent, coopPanelModel, sortMembers, type CoopPanelState } from '../../src/ui/coop/panel';
import { LinePrompt, validateRadioLine } from '../../src/ui/coop/prompt';

class FakeStorage {
  readonly data = new Map<string, string>();
  fail = false;
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    if (this.fail) throw new Error('quota');
    this.data.set(k, v);
  }
}

describe('lobby form', () => {
  it('defaults to the local server and a patrol officer', () => {
    expect(DEFAULT_LOBBY_FORM.url).toBe(DEFAULT_SERVER_URL);
    expect(DEFAULT_LOBBY_FORM.role).toBe('patrol');
    expect(validateLobbyForm(DEFAULT_LOBBY_FORM)).toEqual([]);
    expect(loadCoopPrefs(null)).toEqual(DEFAULT_LOBBY_FORM);
  });

  it('remembers the form in localStorage "patrol-coop" and repairs odd entries field by field', () => {
    const st = new FakeStorage();
    saveCoopPrefs(st, { url: 'ws://192.168.1.20:9000', room: 'night', name: 'Casey', role: 'dispatcher' });
    expect(st.data.has(COOP_PREFS_KEY)).toBe(true);
    expect(loadCoopPrefs(st)).toEqual({ url: 'ws://192.168.1.20:9000', room: 'night', name: 'Casey', role: 'dispatcher' });
    st.data.set(COOP_PREFS_KEY, JSON.stringify({ url: 5, room: 'x'.repeat(100), name: 'Ok', role: 'admin' }));
    expect(loadCoopPrefs(st)).toEqual({ ...DEFAULT_LOBBY_FORM, name: 'Ok' });
    st.data.set(COOP_PREFS_KEY, '{ broken');
    expect(loadCoopPrefs(st)).toEqual(DEFAULT_LOBBY_FORM);
    st.fail = true;
    expect(() => saveCoopPrefs(st, DEFAULT_LOBBY_FORM)).not.toThrow();
  });

  it('validates address, room, name and role', () => {
    const ok = { ...DEFAULT_LOBBY_FORM };
    expect(validateLobbyForm({ ...ok, url: 'http://localhost:8787' })).toHaveLength(1);
    expect(validateLobbyForm({ ...ok, url: 'localhost' })).toHaveLength(1);
    expect(validateLobbyForm({ ...ok, url: 'wss://example.test/path' })).toEqual([]);
    expect(validateLobbyForm({ ...ok, room: '' })).toHaveLength(1);
    expect(validateLobbyForm({ ...ok, room: 'r'.repeat(LIMITS.room + 1) })).toHaveLength(1);
    expect(validateLobbyForm({ ...ok, name: ' ' })).toHaveLength(1);
    expect(validateLobbyForm({ ...ok, name: 'bad\u0007name' })).toHaveLength(1);
    expect(validateLobbyForm({ ...ok, role: 'admin' as never })).toHaveLength(1);
  });

  it('explains that multiplayer is optional and local', () => {
    expect(LOBBY_EXPLANATION).toBe('Optional. Run `npm run server` on this computer or your local network. Nothing is sent anywhere else.');
  });
});

describe('lobbyModel', () => {
  it('enables Connect only for a valid form that is not connecting or joined', () => {
    expect(lobbyModel(DEFAULT_LOBBY_FORM, { state: 'idle', text: '' })).toMatchObject({ canConnect: true, canStart: false, statusLine: 'Not connected', tone: 'info' });
    expect(lobbyModel({ ...DEFAULT_LOBBY_FORM, room: '' }, { state: 'idle', text: '' }).canConnect).toBe(false);
    expect(lobbyModel(DEFAULT_LOBBY_FORM, { state: 'connecting', text: '' })).toMatchObject({ canConnect: false, connecting: true, statusLine: 'Connecting…' });
  });

  it('enables Start once joined and shows the host text', () => {
    const m = lobbyModel(DEFAULT_LOBBY_FORM, { state: 'joined', text: 'Joined room patrol as N1 (2 online)' });
    expect(m).toMatchObject({ canStart: true, canConnect: false, joined: true, tone: 'ok', statusLine: 'Joined room patrol as N1 (2 online)' });
  });

  it('shows a failure reason in the error tone and allows trying again', () => {
    const m = lobbyModel(DEFAULT_LOBBY_FORM, { state: 'failed', text: 'no free patrol slot' });
    expect(m).toMatchObject({ canConnect: true, canStart: false, tone: 'error', statusLine: 'no free patrol slot' });
    expect(lobbyModel(DEFAULT_LOBBY_FORM, { state: 'closed', text: '' }).statusLine).toBe('Disconnected');
  });
});

describe('CoopLobby (headless)', () => {
  function setup(state = 'idle') {
    const calls: unknown[][] = [];
    let status = { state, text: '' };
    const host: CoopLobbyHost = {
      connect: (...a) => void calls.push(['connect', ...a]),
      status: () => status,
      start: () => void calls.push(['start']),
      cancel: () => void calls.push(['cancel']),
    };
    const st = new FakeStorage();
    const lobby = new CoopLobby(null, host, st);
    return { lobby, calls, st, setStatus: (s: { state: string; text: string }) => void (status = s) };
  }

  it('connects with the trimmed form and remembers it', () => {
    const { lobby, calls, st } = setup();
    lobby.setForm({ url: ' ws://localhost:9999 ', room: ' night ', name: ' Casey ', role: 'supervisor' });
    expect(lobby.connect()).toBe(true);
    expect(calls).toEqual([['connect', 'ws://localhost:9999', 'night', 'Casey', 'supervisor']]);
    expect(JSON.parse(st.data.get(COOP_PREFS_KEY) ?? '{}')).toMatchObject({ room: ' night ', role: 'supervisor' });
  });

  it('does not connect with an invalid form', () => {
    const { lobby, calls } = setup();
    lobby.setForm({ room: '' });
    expect(lobby.connect()).toBe(false);
    expect(lobby.model.canConnect).toBe(false);
    expect(calls).toEqual([]);
  });

  it('starts only when joined, then closes; cancel tells the host', () => {
    const { lobby, calls, setStatus } = setup();
    lobby.open();
    expect(lobby.start()).toBe(false);
    setStatus({ state: 'joined', text: 'ok' });
    lobby.refresh();
    expect(lobby.model.canStart).toBe(true);
    expect(lobby.start()).toBe(true);
    expect(calls).toEqual([['start']]);
    expect(lobby.isOpen).toBe(false);
    lobby.open();
    expect(lobby.onKeyDown({ key: 'Escape' } as KeyboardEvent)).toBe(true);
    expect(calls.at(-1)).toEqual(['cancel']);
    expect(lobby.isOpen).toBe(false);
  });

  it('starts from the remembered form', () => {
    const st = new FakeStorage();
    saveCoopPrefs(st, { url: 'ws://10.0.0.2:8787', room: 'x', name: 'Y', role: 'dispatcher' });
    const lobby = new CoopLobby(null, { connect: () => undefined, status: () => ({ state: 'idle', text: '' }), start: () => undefined, cancel: () => undefined }, st);
    expect(lobby.form.role).toBe('dispatcher');
    expect(lobby.form.url).toBe('ws://10.0.0.2:8787');
  });
});

function member(callsign: string, role: NetUnit['role'], over: Partial<NetUnit> = {}): NetUnit {
  return { callsign, role, name: `${callsign} name`, status: 'available', callId: null, x: 0, z: 0, heading: 0, speed: 0, driving: false, partner: null, ...over };
}

describe('coopPanelModel', () => {
  const state: CoopPanelState = {
    members: [member('S1', 'supervisor'), member('N2', 'patrol', { status: 'enRoute', callId: 7 }), member('DISPATCH', 'dispatcher'), member('N1', 'patrol'), member('N3', 'patrol')],
    self: 'N1',
    partner: 'N3',
    orders: ['N1: respond to 25-0004', 'N1: code 4'],
  };

  it('sorts patrol officers first, then the dispatcher and the supervisor', () => {
    expect(sortMembers(state.members).map((m) => m.callsign)).toEqual(['N1', 'N2', 'N3', 'DISPATCH', 'S1']);
    expect(sortMembers([member('N10', 'patrol'), member('N2', 'patrol')]).map((m) => m.callsign)).toEqual(['N2', 'N10']);
  });

  it('lists members with status, then the actions, then the recent orders newest first', () => {
    const m = coopPanelModel(state);
    expect(m.title).toBe('Co-op');
    expect(m.subtitle).toBe('5 online · you are N1 · partner N3');
    const labels = m.options.map((o) => o.label);
    expect(labels.slice(0, 5)).toEqual(['N1 N1 name (you)', 'N2 N2 name', 'N3 N3 name (partner)', 'DISPATCH DISPATCH name', 'S1 S1 name']);
    expect(m.options[1]?.detail).toBe('patrol · en route · call 7');
    expect(labels.slice(5)).toEqual(['Send radio line…', 'Disconnect', 'Order: N1: code 4', 'Order: N1: respond to 25-0004']);
  });

  it('lets a patrol officer ask only other patrol officers who are not the partner', () => {
    const m = coopPanelModel(state);
    expect(m.options.map((o) => o.enabled !== false)).toEqual([false, true, false, false, false, true, true, false, false]);
  });

  it('does not offer partnering to the dispatcher', () => {
    const m = coopPanelModel({ ...state, self: 'DISPATCH', partner: null });
    expect(m.options.slice(0, 5).every((o) => o.enabled === false)).toBe(true);
  });

  it('says so when there are no orders', () => {
    const m = coopPanelModel({ ...state, orders: [] });
    expect(m.options.at(-1)).toEqual({ label: 'No orders yet', enabled: false });
  });

  it('maps rows back to intents', () => {
    expect(coopPanelIntent(state, 1)).toEqual({ kind: 'partner', unit: 'N2' });
    expect(coopPanelIntent(state, 0)).toBeNull();
    expect(coopPanelIntent(state, 2)).toBeNull();
    expect(coopPanelIntent(state, 5)).toEqual({ kind: 'radio' });
    expect(coopPanelIntent(state, 6)).toEqual({ kind: 'disconnect' });
    expect(coopPanelIntent(state, 7)).toBeNull();
    expect(coopPanelIntent(state, 99)).toBeNull();
  });
});

describe('CoopPanel and LinePrompt (headless)', () => {
  it('requests a partner, sends a radio line through the prompt and disconnects', () => {
    const state: CoopPanelState = { members: [member('N1', 'patrol'), member('N2', 'patrol')], self: 'N1', partner: null, orders: [] };
    const log: string[] = [];
    const panel = new CoopPanel(null, {
      state: () => state,
      requestPartner: (u) => void log.push(`partner ${u}`),
      sendRadio: (t) => void log.push(`radio ${t}`),
      disconnect: () => void log.push('disconnect'),
    });
    panel.open();
    expect(panel.isOpen).toBe(true);
    expect(panel.model?.options[1]?.label).toContain('N2');
    panel.pick(1);
    expect(log).toEqual(['partner N2']);
    expect(panel.isOpen).toBe(true);
    panel.pick(0); // yourself: nothing
    panel.pick(2); // radio: opens the prompt
    expect(log).toEqual(['partner N2']);
    expect(panel.isOpen).toBe(true); // the prompt is open
    panel.pick(3);
    expect(log).toEqual(['partner N2', 'disconnect']);
  });

  it('refreshes the rows only when the state changed', () => {
    let state: CoopPanelState = { members: [member('N1', 'patrol')], self: 'N1', partner: null, orders: [] };
    const panel = new CoopPanel(null, { state: () => state, requestPartner: () => undefined, sendRadio: () => undefined, disconnect: () => undefined });
    panel.open();
    const first = panel.model;
    panel.update();
    expect(panel.model).toBe(first);
    state = { ...state, members: [...state.members, member('N2', 'patrol')] };
    panel.update();
    expect(panel.model).not.toBe(first);
    expect(panel.model?.options[1]?.label).toContain('N2');
  });

  it('validates radio lines and the prompt submits or keeps the reason', () => {
    expect(validateRadioLine('Copy that, en route')).toBeNull();
    expect(validateRadioLine('   ')).toMatch(/type/i);
    expect(validateRadioLine('x'.repeat(LIMITS.radio + 1))).toMatch(/at most/i);
    expect(validateRadioLine('bad\nline')).toMatch(/plain text/i);
    const prompt = new LinePrompt(null);
    const sent: string[] = [];
    let cancelled = 0;
    prompt.open((t) => void sent.push(t), () => void cancelled++);
    expect(prompt.submit('')).toBe(false);
    expect(prompt.isOpen).toBe(true);
    expect(prompt.submit('  10-4  ')).toBe(true);
    expect(sent).toEqual(['10-4']);
    expect(prompt.isOpen).toBe(false);
    prompt.open(() => undefined, () => void cancelled++);
    expect(prompt.onKeyDown({ key: 'Escape' } as KeyboardEvent)).toBe(true);
    expect(cancelled).toBe(1);
  });
});
