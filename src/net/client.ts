/**
 * Browser-side co-op client (Phase 8 §8.4). Wraps a WebSocket through a structural interface (no DOM types), drains
 * parsed server messages into the caller's array once per frame and never throws.
 */
import { encode, parseServerMsg } from './protocol.ts';
import type { ClientMsg, ServerMsg } from './protocol.ts';

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type NetClientState = 'idle' | 'connecting' | 'joined' | 'closed' | 'failed';

export const DEFAULT_SERVER_URL = 'ws://localhost:8787';

const WS_OPEN = 1;
const INBOX_CAP = 4096;

function detectFactory(): ((url: string) => WebSocketLike) | null {
  const ctor = (globalThis as unknown as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  return typeof ctor === 'function' ? (url) => new ctor(url) : null;
}

export class NetClient {
  private readonly factory: ((url: string) => WebSocketLike) | null | undefined;
  private ws: WebSocketLike | null = null;
  private stateValue: NetClientState = 'idle';
  private reasonValue = '';
  private callsignValue = '';
  private welcomeMsg: Extract<ServerMsg, { t: 'welcome' }> | null = null;
  private readonly inbox: ServerMsg[] = [];
  private errorCount = 0;
  private droppedCount = 0;

  /** factory default (undefined): `globalThis.WebSocket` when present, else connect() fails with 'WebSockets
   *  unavailable'. Pass null to force that failure. */
  constructor(factory?: ((url: string) => WebSocketLike) | null) {
    this.factory = factory;
  }

  get state(): NetClientState {
    return this.stateValue;
  }
  get reason(): string {
    return this.reasonValue;
  }
  get callsign(): string {
    return this.callsignValue;
  }
  /** The welcome message once joined (it is also delivered through `drain` as the first message). */
  get welcome(): Extract<ServerMsg, { t: 'welcome' }> | null {
    return this.welcomeMsg;
  }
  /** Messages dropped because they failed to parse. */
  get invalidMessages(): number {
    return this.errorCount;
  }
  /** Messages dropped because the inbox was full (the game stopped draining). */
  get droppedMessages(): number {
    return this.droppedCount;
  }

  /** Open the socket; `hello` is sent as soon as it opens. State: connecting -> joined (on welcome) | failed. */
  connect(url: string, hello: Extract<ClientMsg, { t: 'hello' }>): void {
    this.closeSocket();
    this.inbox.length = 0;
    this.reasonValue = '';
    this.callsignValue = '';
    this.welcomeMsg = null;
    const make = this.factory === undefined ? detectFactory() : this.factory;
    if (!make) {
      this.fail('WebSockets unavailable');
      return;
    }
    let ws: WebSocketLike;
    try {
      ws = make(url);
    } catch (e) {
      this.fail(e instanceof Error ? e.message : 'could not open the connection');
      return;
    }
    this.ws = ws;
    this.stateValue = 'connecting';
    ws.onopen = () => {
      if (this.ws !== ws) return;
      try {
        ws.send(encode(hello));
      } catch {
        this.fail('could not send hello');
      }
    };
    ws.onmessage = (ev) => {
      if (this.ws === ws) this.receive(ev.data);
    };
    ws.onerror = () => {
      if (this.ws !== ws) return;
      if (this.reasonValue === '') this.reasonValue = 'connection error';
      if (this.stateValue === 'connecting') this.stateValue = 'failed';
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.reasonValue === '') this.reasonValue = ev.reason !== '' ? ev.reason : `connection closed (${ev.code})`;
      this.stateValue = this.stateValue === 'joined' ? 'closed' : 'failed';
    };
  }

  /** Send a message; false (nothing sent) unless joined. Presence is dropped silently like any other message. */
  send(msg: ClientMsg): boolean {
    const ws = this.ws;
    if (this.stateValue !== 'joined' || !ws || ws.readyState !== WS_OPEN) return false;
    try {
      ws.send(encode(msg));
      return true;
    } catch {
      return false;
    }
  }

  /** Append every message received since the last drain to `out` (in order) and return how many. */
  drain(out: ServerMsg[]): number {
    const n = this.inbox.length;
    for (let i = 0; i < n; i++) out.push(this.inbox[i] as ServerMsg);
    this.inbox.length = 0;
    return n;
  }

  /** Close the connection (state 'closed' unless it never started). */
  close(): void {
    this.closeSocket();
    if (this.stateValue !== 'idle' && this.stateValue !== 'failed') this.stateValue = 'closed';
  }

  private closeSocket(): void {
    const ws = this.detach();
    if (!ws) return;
    try {
      ws.close(1000, 'bye');
    } catch {
      /* already closed */
    }
  }

  private detach(): WebSocketLike | null {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
    }
    return ws;
  }

  private fail(reason: string): void {
    this.reasonValue = reason;
    this.stateValue = 'failed';
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') {
      this.errorCount++;
      return;
    }
    const r = parseServerMsg(data);
    if (!r.ok) {
      this.errorCount++;
      return;
    }
    const msg = r.msg;
    if (msg.t === 'welcome') {
      this.welcomeMsg = msg;
      this.callsignValue = msg.callsign;
      this.stateValue = 'joined';
    } else if (msg.t === 'error' && this.stateValue === 'connecting') {
      this.reasonValue = msg.reason;
    }
    if (this.inbox.length >= INBOX_CAP) {
      this.droppedCount++;
      return;
    }
    this.inbox.push(msg);
  }
}
