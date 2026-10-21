/// <reference types="node" />
import { connect } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, encode, parseServerMsg } from '../../src/net/protocol';
import type { ClientMsg, ServerMsg } from '../../src/net/protocol';
import { startServer } from '../../server/wsServer';
import type { RunningServer } from '../../server/wsServer';
import { OP_BINARY, OP_TEXT, acceptKey, encodeClientFrame } from '../../server/wsFrames';

let server: RunningServer;
const logs: string[] = [];
const sockets: WebSocket[] = [];

beforeEach(async () => {
  logs.length = 0;
  server = await startServer({ port: 0, host: '127.0.0.1', allowedOrigins: null, maxRooms: 2, log: (l) => logs.push(l) });
});
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await server.close();
});

/** Test client around the global WebSocket that queues parsed server messages. */
interface TestClient {
  ws: WebSocket;
  inbox: ServerMsg[];
  closed: Promise<{ code: number; reason: string }>;
  send(msg: ClientMsg | string): void;
  next(match: (m: ServerMsg) => boolean, label?: string): Promise<ServerMsg>;
}

function client(url = `ws://127.0.0.1:${server.port}`): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    sockets.push(ws);
    const inbox: ServerMsg[] = [];
    const waiters: { match: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }[] = [];
    const closed = new Promise<{ code: number; reason: string }>((res) => {
      ws.onclose = (ev) => res({ code: ev.code, reason: ev.reason });
    });
    ws.onmessage = (ev) => {
      const r = parseServerMsg(String(ev.data));
      if (!r.ok) throw new Error(`bad server message: ${String(ev.data)}`);
      const w = waiters.findIndex((x) => x.match(r.msg));
      if (w >= 0) waiters.splice(w, 1)[0]?.resolve(r.msg);
      else inbox.push(r.msg);
    };
    ws.onerror = () => reject(new Error('socket error'));
    ws.onopen = () =>
      resolve({
        ws,
        inbox,
        closed,
        send: (msg) => ws.send(typeof msg === 'string' ? msg : encode(msg)),
        next: (match, label = 'message') =>
          new Promise<ServerMsg>((res, rej) => {
            const i = inbox.findIndex(match);
            if (i >= 0) {
              res(inbox.splice(i, 1)[0] as ServerMsg);
              return;
            }
            const timer = setTimeout(() => rej(new Error(`timed out waiting for ${label}`)), 3000);
            waiters.push({ match, resolve: (m) => { clearTimeout(timer); res(m); } });
          }),
      });
  });
}

const hello = (role: 'patrol' | 'dispatcher' | 'supervisor', room = 'alpha', name = 'x'): ClientMsg => ({
  t: 'hello', v: PROTOCOL_VERSION, name, role, room,
});
const isT = (t: ServerMsg['t']) => (m: ServerMsg): boolean => m.t === t;
const isEv = (k: string) => (m: ServerMsg): boolean => m.t === 'event' && m.ev.k === k;

describe('co-op server', () => {
  it('serves a plain http page', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('Patrol co-op server');
    expect((await fetch(`http://127.0.0.1:${server.port}/nope`)).status).toBe(404);
  });

  it('plays a dispatch round between a patrol host and a dispatcher', async () => {
    const patrol = await client();
    patrol.send(hello('patrol', 'alpha', 'Pat'));
    const w1 = await patrol.next(isT('welcome'), 'patrol welcome');
    expect(w1).toMatchObject({ t: 'welcome', callsign: 'N1', role: 'patrol' });
    if (w1.t === 'welcome') expect(w1.snapshot.host).toBe('N1');

    const disp = await client();
    disp.send(hello('dispatcher', 'alpha', 'Dee'));
    const w2 = await disp.next(isT('welcome'), 'dispatcher welcome');
    expect(w2).toMatchObject({ t: 'welcome', callsign: 'DISPATCH' });
    if (w2.t === 'welcome') expect(w2.snapshot.units.map((u) => u.callsign)).toEqual(['N1', 'DISPATCH']);

    // the patrol client hears about the dispatcher joining
    const joined = await patrol.next(isEv('joined'), 'joined event');
    expect(joined).toMatchObject({ t: 'event', ev: { k: 'joined', unit: { callsign: 'DISPATCH' } } });

    disp.send({
      t: 'callCreate', ref: 'c1', typeId: 'noise_complaint', label: 'Noise', priority: 3, x: 10, z: 10,
      address: '1 Main St', narrative: 'loud music', origin: 'dispatcher',
    });
    const created = await patrol.next(isEv('callCreated'), 'callCreated');
    const callId = created.t === 'event' && created.ev.k === 'callCreated' ? created.ev.call.id : -1;
    expect(callId).toBeGreaterThan(0);
    await disp.next(isEv('callCreated'), 'dispatcher callCreated echo');

    disp.send({ t: 'callAssign', callId, unit: 'N1' });
    const assigned = await patrol.next(isEv('callAssigned'), 'callAssigned');
    expect(assigned).toMatchObject({ t: 'event', ev: { k: 'callAssigned', callId, callsign: 'N1', primary: 'N1' } });
    if (assigned.t === 'event' && created.t === 'event') expect(assigned.rev).toBe(created.rev + 1);

    patrol.send({ t: 'unitStatus', status: 'enRoute', callId });
    const st = await disp.next(isEv('unitStatus'), 'unitStatus');
    expect(st).toMatchObject({ t: 'event', ev: { k: 'unitStatus', callsign: 'N1', status: 'enRoute', callId } });

    patrol.send({ t: 'ping', n: 5 });
    expect(await patrol.next(isT('pong'), 'pong')).toEqual({ t: 'pong', n: 5 });

    // a patrol unit may not change priority
    patrol.send({ t: 'callPriority', callId, priority: 1 });
    expect(await patrol.next(isT('reject'), 'forbidden reject')).toMatchObject({
      t: 'reject', ref: 'callPriority', code: 'forbidden',
    });

    // malformed text gets a malformed reject and the connection stays usable
    patrol.send('this is not json');
    expect(await patrol.next(isT('reject'), 'malformed reject')).toMatchObject({ t: 'reject', code: 'malformed' });
    patrol.send('{"t":"zzz"}');
    expect(await patrol.next(isT('reject'), 'unknownType reject')).toMatchObject({
      t: 'reject', ref: 'zzz', code: 'unknownType',
    });
    patrol.send({ t: 'ping', n: 6 });
    expect(await patrol.next(isT('pong'), 'pong after rejects')).toEqual({ t: 'pong', n: 6 });

    // presence is batched to the room
    patrol.send({ t: 'presence', x: 5, z: 6, heading: 0, speed: 3, driving: true });
    const pres = await disp.next((m) => m.t === 'presence' && m.units.length > 0, 'presence');
    expect(pres).toMatchObject({ t: 'presence', units: [{ callsign: 'N1', x: 5, z: 6 }] });

    // closing the patrol socket tells the room
    patrol.ws.close(1000, 'bye');
    const left = await disp.next(isEv('left'), 'left event');
    expect(left).toMatchObject({ t: 'event', ev: { k: 'left', callsign: 'N1' } });
    // the leaving unit was assigned: its callUnassigned came first
    expect(await disp.next(isEv('callUnassigned'), 'unassign on leave')).toMatchObject({
      ev: { k: 'callUnassigned', callId, callsign: 'N1' },
    });
    await patrol.closed;
  });

  it('closes a client whose first message is not hello', async () => {
    const c = await client();
    c.send({ t: 'ping', n: 1 });
    expect(await c.next(isT('error'))).toMatchObject({ t: 'error', code: 'illegalState' });
    expect((await c.closed).code).toBe(1008);
  });

  it('closes on a bad hello and on a protocol version mismatch', async () => {
    const a = await client();
    a.send('nonsense');
    expect(await a.next(isT('error'))).toMatchObject({ t: 'error', code: 'malformed' });
    expect((await a.closed).code).toBe(1008);
    const b = await client();
    b.send({ ...hello('patrol'), v: 99 } as ClientMsg);
    expect(await b.next(isT('error'))).toMatchObject({ t: 'error', code: 'version' });
    expect((await b.closed).code).toBe(1008);
  });

  it('rejects joins past the role limit and past maxRooms with an error', async () => {
    const d1 = await client();
    d1.send(hello('dispatcher', 'beta'));
    await d1.next(isT('welcome'));
    const d2 = await client();
    d2.send(hello('dispatcher', 'beta'));
    expect(await d2.next(isT('error'))).toMatchObject({ t: 'error', code: 'full' });
    expect((await d2.closed).code).toBe(1008);

    const other = await client();
    other.send(hello('patrol', 'gamma'));
    await other.next(isT('welcome'));
    const third = await client();
    third.send(hello('patrol', 'delta')); // maxRooms is 2: beta and gamma exist
    expect(await third.next(isT('error'))).toMatchObject({ t: 'error', code: 'full' });
    expect((await third.closed).code).toBe(1008);
  });

  it('deletes empty rooms so their names and slots free up', async () => {
    const a = await client();
    a.send(hello('patrol', 'one'));
    await a.next(isT('welcome'));
    const b = await client();
    b.send(hello('patrol', 'two'));
    await b.next(isT('welcome'));
    a.ws.close();
    await a.closed;
    // the server notices the close asynchronously; retry until the slot frees
    let welcome: ServerMsg | null = null;
    for (let i = 0; i < 20 && !welcome; i++) {
      const c = await client();
      c.send(hello('patrol', 'three'));
      const r = await Promise.race([c.next((m) => m.t === 'welcome' || m.t === 'error'), c.closed.then(() => null)]);
      if (r?.t === 'welcome') welcome = r;
      else await new Promise((res) => setTimeout(res, 25));
    }
    expect(welcome).toMatchObject({ t: 'welcome', callsign: 'N1' });
  });

  it('cleans up the room when a client disconnects (callsign is reusable)', async () => {
    const a = await client();
    a.send(hello('patrol', 'rejoin'));
    const wa = await a.next(isT('welcome'));
    expect(wa).toMatchObject({ callsign: 'N1' });
    const keep = await client();
    keep.send(hello('supervisor', 'rejoin'));
    await keep.next(isT('welcome'));
    a.ws.close();
    await keep.next(isEv('left'));
    const again = await client();
    again.send(hello('patrol', 'rejoin'));
    expect(await again.next(isT('welcome'))).toMatchObject({ callsign: 'N1' });
  });

  it('drops binary frames with close 1003', async () => {
    const c = await client();
    c.send(hello('patrol'));
    await c.next(isT('welcome'));
    c.ws.send(new Uint8Array([1, 2, 3]));
    expect((await c.closed).code).toBe(1003);
  });

  it('refuses a disallowed origin and a plain GET upgrade', async () => {
    const raw = (headers: string[]): Promise<string> =>
      new Promise((resolve) => {
        const s = connect(server.port, '127.0.0.1', () => {
          s.write(['GET / HTTP/1.1', 'Host: x', ...headers, '', ''].join('\r\n'));
        });
        let data = '';
        s.on('data', (d: Buffer) => (data += d.toString('latin1')));
        s.on('close', () => resolve(data));
        s.on('error', () => resolve(data));
      });
    const base = ['Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=='];
    expect(await raw([...base, 'Origin: http://evil.example'])).toMatch(/^HTTP\/1\.1 403/);
    expect(await raw(base.filter((h) => !h.startsWith('Sec-WebSocket-Key')))).toMatch(/^HTTP\/1\.1 400/);
    expect(await raw(base.map((h) => (h.includes('Version') ? 'Sec-WebSocket-Version: 8' : h)))).toMatch(/^HTTP\/1\.1 400/);
  });

  it('answers the handshake with the exact 101 response and speaks raw frames', async () => {
    const received = await new Promise<Buffer>((resolve) => {
      const s = connect(server.port, '127.0.0.1', () => {
        s.write(
          [
            'GET /play HTTP/1.1', 'Host: 127.0.0.1', 'Upgrade: websocket', 'Connection: Upgrade',
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', 'Origin: http://localhost:5173', '', '',
          ].join('\r\n'),
        );
      });
      let buf = Buffer.alloc(0);
      let sent = false;
      s.on('data', (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        if (!sent) {
          sent = true;
          // send hello as a masked text frame
          s.write(encodeClientFrame(OP_TEXT, Buffer.from(encode(hello('patrol', 'raw')), 'utf8'), Buffer.from([9, 8, 7, 6])));
        }
        const body = buf.subarray(end + 4);
        const r = parseUnmasked(body);
        if (r) {
          s.destroy();
          resolve(Buffer.concat([buf.subarray(0, end + 4), r]));
        }
      });
    });
    const head = received.subarray(0, received.indexOf('\r\n\r\n') + 4).toString('latin1');
    expect(head).toBe(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey('dGhlIHNhbXBsZSBub25jZQ==')}\r\n\r\n`,
    );
    const text = received.subarray(head.length).toString('utf8');
    expect(JSON.parse(text)).toMatchObject({ t: 'welcome', callsign: 'N1' });
  });

  it('closes on invalid UTF-8 with 1007 and on a fragmented message with 1003', async () => {
    const closeCodeFor = (frame: Buffer): Promise<number> =>
      new Promise((resolve) => {
        const s = connect(server.port, '127.0.0.1', () => {
          s.write(
            [
              'GET / HTTP/1.1', 'Host: x', 'Upgrade: websocket', 'Connection: Upgrade',
              'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', '', '',
            ].join('\r\n'),
          );
        });
        let buf = Buffer.alloc(0);
        let sent = false;
        s.on('data', (d: Buffer) => {
          buf = Buffer.concat([buf, d]);
          const end = buf.indexOf('\r\n\r\n');
          if (end < 0) return;
          if (!sent) {
            sent = true;
            s.write(frame);
          }
          const body = buf.subarray(end + 4);
          if (body.length >= 4 && ((body[0] as number) & 0x0f) === 8) {
            resolve(body.readUInt16BE(2));
            s.destroy();
          }
        });
      });
    const mask = Buffer.from([1, 2, 3, 4]);
    expect(await closeCodeFor(encodeClientFrame(OP_TEXT, Buffer.from([0xc3, 0x28, 0xff]), mask))).toBe(1007);
    expect(await closeCodeFor(encodeClientFrame(OP_TEXT, Buffer.from('{"t":'), mask, false))).toBe(1003);
    expect(await closeCodeFor(encodeClientFrame(OP_BINARY, Buffer.from('x'), mask))).toBe(1003);
    expect(await closeCodeFor(Buffer.from([0x81, 0x02, 0x41, 0x42]))).toBe(1002); // unmasked
  });

  it('logs joins and rejects when asked', async () => {
    const c = await client();
    c.send(hello('patrol', 'logroom', 'Zed'));
    await c.next(isT('welcome'));
    c.send({ t: 'callPriority', callId: 1, priority: 1 });
    await c.next(isT('reject'));
    expect(logs.some((l) => l.includes('N1') && l.includes('Zed') && l.includes('joined'))).toBe(true);
    expect(logs.some((l) => l.includes('callPriority') && l.includes('forbidden'))).toBe(true);
  });
});

/** Extract the first unmasked server text frame payload from a buffer, or null while incomplete. */
function parseUnmasked(buf: Buffer): Buffer | null {
  if (buf.length < 2) return null;
  let len = (buf[1] as number) & 0x7f;
  let head = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    head = 4;
  } else if (len === 127) {
    return null;
  }
  if (buf.length < head + len) return null;
  return buf.subarray(head, head + len);
}
