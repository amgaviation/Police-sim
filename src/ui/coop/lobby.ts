import './coop.css';
import { DEFAULT_SERVER_URL, LIMITS, NET_ROLES, hasControlChars, type NetRole } from '../../net';
import { setText } from '../panels/dom';
import { clearChildren, el, type Menu, type UIRoot } from '../ui';

/** What the lobby drives: the integrator owns the `NetClient` and the game start. */
export interface CoopLobbyHost {
  connect(url: string, room: string, name: string, role: NetRole): void;
  /** `state` is the client state ('idle' | 'connecting' | 'joined' | 'closed' | 'failed'); `text` a line for the player. */
  status(): { state: string; text: string };
  /** Starts the game once joined. */
  start(): void;
  cancel(): void;
}

export interface LobbyForm {
  url: string;
  room: string;
  name: string;
  role: NetRole;
}

export const COOP_PREFS_KEY = 'patrol-coop';
export const DEFAULT_LOBBY_FORM: Readonly<LobbyForm> = { url: DEFAULT_SERVER_URL, room: 'patrol', name: 'Officer', role: 'patrol' };
/** Shown in the lobby: multiplayer is optional and local. */
export const LOBBY_EXPLANATION = 'Optional. Run `npm run server` on this computer or your local network. Nothing is sent anywhere else.';

export const ROLE_LABELS: Readonly<Record<NetRole, string>> = {
  patrol: 'Patrol officer',
  dispatcher: 'Dispatcher',
  supervisor: 'Supervisor',
};

type PrefsStorage = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): PrefsStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function isRole(v: unknown): v is NetRole {
  return typeof v === 'string' && (NET_ROLES as readonly string[]).includes(v);
}

/** The remembered form (`localStorage['patrol-coop']`); a missing, broken or odd entry falls back field by field to the defaults. */
export function loadCoopPrefs(storage: PrefsStorage | null): LobbyForm {
  const form: LobbyForm = { ...DEFAULT_LOBBY_FORM };
  if (!storage) return form;
  try {
    const raw = storage.getItem(COOP_PREFS_KEY);
    if (raw === null) return form;
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return form;
    const o = v as Record<string, unknown>;
    if (typeof o['url'] === 'string' && o['url'].length <= 200) form.url = o['url'];
    if (typeof o['room'] === 'string' && o['room'].length <= LIMITS.room) form.room = o['room'];
    if (typeof o['name'] === 'string' && o['name'].length <= LIMITS.name) form.name = o['name'];
    if (isRole(o['role'])) form.role = o['role'];
  } catch {
    // unreadable: defaults
  }
  return form;
}

export function saveCoopPrefs(storage: PrefsStorage | null, form: Readonly<LobbyForm>): void {
  try {
    storage?.setItem(COOP_PREFS_KEY, JSON.stringify({ url: form.url, room: form.room, name: form.name, role: form.role }));
  } catch {
    // full or blocked: not remembered
  }
}

/** Problems with the form (empty = it can connect). */
export function validateLobbyForm(form: Readonly<LobbyForm>): string[] {
  const errors: string[] = [];
  const url = form.url.trim();
  if (!/^wss?:\/\/[^\s/]+(\/\S*)?$/.test(url) || url.length > 200) errors.push('Server address must look like ws://localhost:8787');
  const room = form.room.trim();
  if (room.length < 1 || room.length > LIMITS.room || hasControlChars(room)) errors.push(`Room name must be 1 to ${String(LIMITS.room)} characters`);
  const name = form.name.trim();
  if (name.length < 1 || name.length > LIMITS.name || hasControlChars(name)) errors.push(`Your name must be 1 to ${String(LIMITS.name)} characters`);
  if (!isRole(form.role)) errors.push('Pick a role');
  return errors;
}

export interface LobbyModel {
  errors: string[];
  connecting: boolean;
  joined: boolean;
  canConnect: boolean;
  canStart: boolean;
  /** 'Not connected', or the host's own text. */
  statusLine: string;
  /** 'info' | 'ok' | 'error' for styling (not colour alone: the text says it too). */
  tone: 'info' | 'ok' | 'error';
}

/** Button enablement and the status line from the form and the host's status. */
export function lobbyModel(form: Readonly<LobbyForm>, status: Readonly<{ state: string; text: string }>): LobbyModel {
  const errors = validateLobbyForm(form);
  const connecting = status.state === 'connecting';
  const joined = status.state === 'joined';
  const failed = status.state === 'failed';
  const fallback = connecting ? 'Connecting…' : joined ? 'Connected' : failed ? 'Could not connect' : status.state === 'closed' ? 'Disconnected' : 'Not connected';
  return {
    errors,
    connecting,
    joined,
    canConnect: errors.length === 0 && !connecting && !joined,
    canStart: joined,
    statusLine: status.text !== '' ? status.text : fallback,
    tone: failed ? 'error' : joined ? 'ok' : 'info',
  };
}

const HEADLESS_ELEMENT = {} as HTMLElement;
const POLL_MS = 500;

/**
 * Co-op lobby (design 12.4): a pausing `Menu` on the title screen. URL (remembered in `patrol-coop`), room, name and role,
 * Connect, Start (once joined) and Cancel, with the status line from the host (polled twice a second while shown).
 * Headless it keeps the form and the actions but builds no DOM.
 */
export class CoopLobby implements Menu {
  readonly id = 'coop-lobby';
  readonly element: HTMLElement;

  private readonly ui: UIRoot | null;
  private readonly host: CoopLobbyHost;
  private readonly storage: PrefsStorage | null;
  private readonly formValue: LobbyForm;
  private readonly statusEl: HTMLElement | null;
  private readonly errorsEl: HTMLElement | null;
  private readonly connectBtn: HTMLButtonElement | null;
  private readonly startBtn: HTMLButtonElement | null;
  private readonly inputs: { url: HTMLInputElement; room: HTMLInputElement; name: HTMLInputElement; role: HTMLSelectElement } | null;
  private openFlag = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastModel: LobbyModel;

  constructor(ui: UIRoot | null, host: CoopLobbyHost, storage: PrefsStorage | null = browserStorage()) {
    this.ui = ui;
    this.host = host;
    this.storage = storage;
    this.formValue = loadCoopPrefs(storage);
    this.lastModel = lobbyModel(this.formValue, host.status());
    if (ui === null || typeof document === 'undefined') {
      this.statusEl = null;
      this.errorsEl = null;
      this.connectBtn = null;
      this.startBtn = null;
      this.inputs = null;
      this.element = HEADLESS_ELEMENT;
      return;
    }
    const f = this.formValue;
    const url = el('input', { type: 'text', id: 'coop-url', value: f.url, maxlength: 200, autocomplete: 'off', spellcheck: 'false', oninput: () => this.readForm() });
    const room = el('input', { type: 'text', id: 'coop-room', value: f.room, maxlength: LIMITS.room, autocomplete: 'off', oninput: () => this.readForm() });
    const name = el('input', { type: 'text', id: 'coop-name', value: f.name, maxlength: LIMITS.name, autocomplete: 'off', oninput: () => this.readForm() });
    const role = el('select', { id: 'coop-role', onchange: () => this.readForm() }, ...NET_ROLES.map((r) => el('option', { value: r }, ROLE_LABELS[r])));
    role.value = f.role;
    this.inputs = { url, room, name, role };
    this.statusEl = el('p', { class: 'cl-status', role: 'status', 'aria-live': 'polite' });
    this.errorsEl = el('div', { class: 'cl-errors' });
    this.connectBtn = el('button', { type: 'button', class: 'primary', onclick: () => this.connect() }, 'Connect');
    this.startBtn = el('button', { type: 'button', class: 'primary', onclick: () => this.start() }, 'Start');
    this.element = el(
      'div',
      { class: 'panel coop-lobby', role: 'dialog', 'aria-label': 'Multiplayer lobby' },
      el('h1', null, 'Multiplayer'),
      el('p', { class: 'hint' }, 'Optional. Run ', el('code', null, 'npm run server'), ' on this computer or your local network. Nothing is sent anywhere else.'),
      el('div', { class: 'cl-form' },
        el('label', { for: 'coop-url' }, 'Server'), url,
        el('label', { for: 'coop-room' }, 'Room'), room,
        el('label', { for: 'coop-name' }, 'Your name'), name,
        el('label', { for: 'coop-role' }, 'Role'), role,
      ),
      this.errorsEl,
      this.statusEl,
      el('div', { class: 'row end' }, el('button', { type: 'button', onclick: () => this.cancel() }, 'Cancel'), this.connectBtn, this.startBtn),
    );
    this.refresh();
  }

  get isOpen(): boolean {
    return this.openFlag;
  }

  /** The current form values. */
  get form(): Readonly<LobbyForm> {
    return this.formValue;
  }

  get model(): LobbyModel {
    return this.lastModel;
  }

  /** Sets the form (tests, or the app restoring a choice); the inputs follow. */
  setForm(patch: Partial<LobbyForm>): void {
    Object.assign(this.formValue, patch);
    const i = this.inputs;
    if (i) {
      i.url.value = this.formValue.url;
      i.room.value = this.formValue.room;
      i.name.value = this.formValue.name;
      i.role.value = this.formValue.role;
    }
    this.refresh();
  }

  open(): void {
    this.openFlag = true;
    this.refresh();
    if (this.ui && !this.ui.isOpen(this)) this.ui.push(this);
  }

  close(): void {
    if (!this.openFlag) return;
    this.openFlag = false;
    this.stopPolling();
    if (this.ui?.isOpen(this)) this.ui.pop(this);
  }

  onShow(): void {
    if (this.timer === null && typeof setInterval === 'function') this.timer = setInterval(() => this.refresh(), POLL_MS);
  }

  onHide(): void {
    this.stopPolling();
    if (this.openFlag && this.ui && !this.ui.isOpen(this)) this.openFlag = false;
  }

  onKeyDown(event: KeyboardEvent): boolean {
    if (!this.openFlag || event.key !== 'Escape') return false;
    this.cancel();
    return true;
  }

  /** Re-reads the host status and updates the buttons and the status line. */
  refresh(): void {
    const m = lobbyModel(this.formValue, this.host.status());
    this.lastModel = m;
    if (this.statusEl) {
      setText(this.statusEl, m.statusLine);
      this.statusEl.className = `cl-status cl-${m.tone}`;
    }
    if (this.errorsEl) {
      clearChildren(this.errorsEl);
      for (const e of m.errors) this.errorsEl.appendChild(el('div', { class: 'cl-error' }, e));
    }
    if (this.connectBtn) this.connectBtn.disabled = !m.canConnect;
    if (this.startBtn) this.startBtn.disabled = !m.canStart;
  }

  /** Remembers the form and asks the host to connect (no-op when the form is invalid). */
  connect(): boolean {
    this.readForm();
    const f = this.formValue;
    if (validateLobbyForm(f).length > 0) return false;
    saveCoopPrefs(this.storage, f);
    this.host.connect(f.url.trim(), f.room.trim(), f.name.trim(), f.role);
    this.refresh();
    return true;
  }

  start(): boolean {
    if (this.host.status().state !== 'joined') return false;
    this.host.start();
    this.close();
    return true;
  }

  /** Cancels a connection attempt (or disconnects) and closes the lobby. */
  cancel(): void {
    this.host.cancel();
    this.close();
  }

  private readForm(): void {
    const i = this.inputs;
    if (i) {
      this.formValue.url = i.url.value;
      this.formValue.room = i.room.value;
      this.formValue.name = i.name.value;
      if (isRole(i.role.value)) this.formValue.role = i.role.value;
    }
    this.refresh();
  }

  private stopPolling(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
