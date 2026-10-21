import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SERVER_URL, NetClient } from '../../src/net/client';
import type { WebSocketLike } from '../../src/net/client';
import { PROTOCOL_VERSION, encode } from '../../src/net/protocol';
import type { ClientMsg, ServerMsg } from '../../src/net/protocol';

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  closed: [number | undefined, string | undefined] | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = [code, reason];
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(msg: ServerMsg | string): void {
    this.onmessage?.({ data: typeof msg === 'string' ? msg : encode(msg) });
  }
}

const hello: Extract<ClientMsg, { t: 'hello' }> = { t: 'hello', v: PROTOCOL_VERSION, name: 'Ann', role: 'patrol', room: 'r' };
const welcome: ServerMsg = {
  t: 'welcome', v: PROTOCOL_VERSION, callsign: 'N2', role: 'patrol',
  snapshot: { room: 'r', seed: 5, rev: 3, host: 'N1', units: [], calls: [] },
};

function setup(): { client: NetClient; sock: () => FakeSocket } {
  let made: FakeSocket | null = null;
  const client = new NetClient((url) => (made = new FakeSocket(url)));
  return {
    client,
    sock: () => {
      if (!made) throw new Error('no socket yet');
      return made;
    },
  };
}

describe('NetClient', () => {
  const g = globalThis as unknown as { WebSocket?: unknown };
  const original = g.WebSocket;
  afterEach(() => {
    g.WebSocket = original;
  });

  it('exports the default server url', () => {
    expect(DEFAULT_SERVER_URL).toBe('ws://localhost:8787');
  });

  it('connects, sends hello on open and joins on welcome', () => {
    const { client, sock } = setup();
    expect(client.state).toBe('idle');
    client.connect('ws://x', hello);
    expect(client.state).toBe('connecting');
    expect(sock().url).toBe('ws://x');
    expect(sock().sent).toEqual([]);
    sock().open();
    expect(sock().sent).toEqual([encode(hello)]);
    expect(client.send({ t: 'ping', n: 1 })).toBe(false); // not joined yet
    sock().receive(welcome);
    expect(client.state).toBe('joined');
    expect(client.callsign).toBe('N2');
    expect(client.welcome).toEqual(welcome);
    expect(client.send({ t: 'ping', n: 1 })).toBe(true);
    expect(sock().sent[1]).toBe(encode({ t: 'ping', n: 1 }));
  });

  it('drains parsed messages in order, once, and counts invalid ones', () => {
    const { client, sock } = setup();
    client.connect('ws://x', hello);
    sock().open();
    sock().receive(welcome);
    sock().receive({ t: 'pong', n: 4 });
    sock().receive('garbage');
    sock().receive('{"t":"nope"}');
    sock().onmessage?.({ data: new Uint8Array(2) });
    sock().receive({ t: 'pong', n: 5 });
    const out: ServerMsg[] = [];
    expect(client.drain(out)).toBe(3);
    expect(out.map((m) => m.t)).toEqual(['welcome', 'pong', 'pong']);
    expect(client.invalidMessages).toBe(3);
    expect(client.drain(out)).toBe(0);
    expect(out).toHaveLength(3);
  });

  it('records a server error before the welcome as the reason and fails when the socket closes', () => {
    const { client, sock } = setup();
    client.connect('ws://x', hello);
    sock().open();
    sock().receive({ t: 'error', code: 'full', reason: 'no free patrol slot' });
    sock().onclose?.({ code: 1008, reason: 'full' });
    expect(client.state).toBe('failed');
    expect(client.reason).toBe('no free patrol slot');
    const out: ServerMsg[] = [];
    expect(client.drain(out)).toBe(1);
    expect(client.send({ t: 'ping', n: 1 })).toBe(false);
  });

  it('a socket error while connecting fails the client', () => {
    const { client, sock } = setup();
    client.connect('ws://x', hello);
    sock().onerror?.({});
    expect(client.state).toBe('failed');
    expect(client.reason).toBe('connection error');
    sock().onclose?.({ code: 1006, reason: '' });
    expect(client.reason).toBe('connection error');
  });

  it('a server close after joining moves to closed with the reason', () => {
    const { client, sock } = setup();
    client.connect('ws://x', hello);
    sock().open();
    sock().receive(welcome);
    sock().onclose?.({ code: 1001, reason: 'server shutting down' });
    expect(client.state).toBe('closed');
    expect(client.reason).toBe('server shutting down');
    sock().onclose?.({ code: 1006, reason: '' });
    expect(client.send({ t: 'ping', n: 1 })).toBe(false);
  });

  it('a close without reason text reports the code', () => {
    const { client, sock } = setup();
    client.connect('ws://x', hello);
    sock().onclose?.({ code: 1006, reason: '' });
    expect(client.state).toBe('failed');
    expect(client.reason).toBe('connection closed (1006)');
  });

  it('close() closes the socket and ignores late events', () => {
    const { client, sock } = setup();
    client.connect('ws://x', hello);
    sock().open();
    sock().receive(welcome);
    const s = sock();
    client.close();
    expect(s.closed).toEqual([1000, 'bye']);
    expect(client.state).toBe('closed');
    expect(s.onmessage).toBeNull();
    expect(client.send({ t: 'ping', n: 1 })).toBe(false);
  });

  it('close() on an idle client stays idle', () => {
    const client = new NetClient(null);
    client.close();
    expect(client.state).toBe('idle');
  });

  it('reconnecting resets the previous session', () => {
    const { client, sock } = setup();
    client.connect('ws://x', hello);
    sock().open();
    sock().receive(welcome);
    const first = sock();
    client.connect('ws://y', hello);
    expect(first.closed).toEqual([1000, 'bye']);
    expect(client.state).toBe('connecting');
    expect(client.callsign).toBe('');
    expect(client.welcome).toBeNull();
    first.receive({ t: 'pong', n: 1 }); // stale socket is ignored
    const out: ServerMsg[] = [];
    expect(client.drain(out)).toBe(0);
  });

  it('send returns false when the socket throws or is not open', () => {
    const { client, sock } = setup();
    client.connect('ws://x', hello);
    sock().open();
    sock().receive(welcome);
    sock().readyState = 2;
    expect(client.send({ t: 'ping', n: 1 })).toBe(false);
    sock().readyState = 1;
    sock().send = () => {
      throw new Error('boom');
    };
    expect(client.send({ t: 'ping', n: 1 })).toBe(false);
  });

  it('fails cleanly without WebSockets or when the factory throws', () => {
    const none = new NetClient(null);
    none.connect('ws://x', hello);
    expect(none.state).toBe('failed');
    expect(none.reason).toBe('WebSockets unavailable');
    expect(none.send({ t: 'ping', n: 1 })).toBe(false);

    g.WebSocket = undefined;
    const detect = new NetClient();
    detect.connect('ws://x', hello);
    expect(detect.state).toBe('failed');
    expect(detect.reason).toBe('WebSockets unavailable');

    const throwing = new NetClient(() => {
      throw new Error('bad url');
    });
    throwing.connect('nope', hello);
    expect(throwing.state).toBe('failed');
    expect(throwing.reason).toBe('bad url');
  });

  it('feature-detects globalThis.WebSocket by default', () => {
    const made: FakeSocket[] = [];
    g.WebSocket = class extends FakeSocket {
      constructor(url: string) {
        super(url);
        made.push(this);
      }
    };
    const client = new NetClient();
    client.connect('ws://detected', hello);
    expect(client.state).toBe('connecting');
    expect(made[0]?.url).toBe('ws://detected');
  });

  it('caps the inbox when nobody drains', () => {
    const { client, sock } = setup();
    client.connect('ws://x', hello);
    sock().open();
    sock().receive(welcome);
    for (let i = 0; i < 4200; i++) sock().receive({ t: 'pong', n: i });
    expect(client.droppedMessages).toBeGreaterThan(0);
    const out: ServerMsg[] = [];
    expect(client.drain(out)).toBe(4096);
  });
});
