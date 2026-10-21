/// <reference types="node" />
/**
 * Co-op WebSocket server: Node built-ins only (http + crypto), RFC 6455 text frames, one authoritative `Room` per
 * room name. Local-network tool: no TLS, no accounts.
 */
import { randomInt } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { encode, parseClientMsg } from '../src/net/protocol.ts';
import type { ClientMsg, RejectCode, ServerMsg } from '../src/net/protocol.ts';
import { RateLimiter, Room } from '../src/net/room.ts';
import { acceptKey, encodeClose, encodeFrame, OP_BINARY, OP_CLOSE, OP_CONT, OP_PING, OP_PONG, OP_TEXT, parseFrames } from './wsFrames.ts';

export interface ServerOptions {
  port: number;
  host: string;
  /** Allowed Origin header values; null = any http://localhost:* / http://127.0.0.1:* origin (or no Origin). */
  allowedOrigins: readonly string[] | null;
  maxRooms: number;
  log: (line: string) => void;
}
export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

const MAX_PAYLOAD = 65536;
const PRESENCE_MS = 200;
const MAINTENANCE_MS = 5000;
const PING_MS = 15000;
const SILENT_MS = 45000;
const HELLO_DEADLINE_MS = 10000;
const MAX_CONNECTIONS = 128;
const MAX_WRITE_BACKLOG = 1 << 20;
const MAX_STRIKES = 100;
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;
const KEY_SHAPE = /^[A-Za-z0-9+/]{22}==$/;

interface Conn {
  id: string;
  socket: Socket;
  buf: Buffer;
  room: RoomEntry | null;
  closing: boolean;
  connectedMs: number;
  lastSeenMs: number;
  lastPingMs: number;
  strikes: number;
  badInput: RateLimiter;
}
interface RoomEntry {
  name: string;
  room: Room;
  conns: Map<string, Conn>;
}

function refOf(raw: string): string {
  const m = /"t"\s*:\s*"([A-Za-z]{1,16})"/.exec(raw.length > 512 ? raw.slice(0, 512) : raw);
  return m?.[1] ?? 'unknown';
}

function originAllowed(origin: string | undefined, allowed: readonly string[] | null): boolean {
  if (allowed === null) return origin === undefined || LOCAL_ORIGIN.test(origin);
  return origin !== undefined && allowed.includes(origin);
}

function refuse(socket: Duplex, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** http.createServer (GET / -> 200 'Patrol co-op server'), 'upgrade': checks GET, Upgrade: websocket, Sec-WebSocket-Version
 *  13, Sec-WebSocket-Key and Origin, then answers 101. Per socket: buffered frames, text only (binary / fragmented ->
 *  close 1003), UTF-8 fatal decode (1007), the first message must be hello (else error + close 1008), then every message
 *  goes through `Room`; events are broadcast to the room, rejects go to the sender. Presence is broadcast every 200 ms,
 *  pings every 15 s, sockets silent for 45 s are destroyed, empty rooms are deleted, at most `maxRooms` rooms. */
export function startServer(opts: ServerOptions): Promise<RunningServer> {
  const rooms = new Map<string, RoomEntry>();
  const conns = new Map<string, Conn>();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let nextConn = 1;

  function write(conn: Conn, data: Buffer): void {
    const s = conn.socket;
    if (s.destroyed || !s.writable) return;
    if (s.writableLength > MAX_WRITE_BACKLOG) {
      s.destroy();
      return;
    }
    s.write(data);
  }
  function send(conn: Conn, msg: ServerMsg): void {
    write(conn, encodeFrame(OP_TEXT, Buffer.from(encode(msg), 'utf8')));
  }
  function broadcast(entry: RoomEntry, msgs: readonly ServerMsg[], except: Conn | null = null): void {
    for (const msg of msgs) {
      const frame = encodeFrame(OP_TEXT, Buffer.from(encode(msg), 'utf8'));
      for (const c of entry.conns.values()) if (c !== except) write(c, frame);
    }
  }
  function closeWith(conn: Conn, code: number, reason: string): void {
    if (conn.closing) return;
    conn.closing = true;
    write(conn, encodeClose(code, reason));
    conn.socket.end();
    setTimeout(() => conn.socket.destroy(), 2000).unref();
  }
  function sendError(conn: Conn, code: RejectCode, reason: string): void {
    send(conn, { t: 'error', code, reason });
  }
  function dropConn(conn: Conn): void {
    conns.delete(conn.id);
    const entry = conn.room;
    if (!entry) return;
    conn.room = null;
    entry.conns.delete(conn.id);
    const cs = entry.room.callsignOf(conn.id);
    const events = entry.room.leave(conn.id);
    if (events.length > 0) broadcast(entry, entry.room.stamp(events));
    if (cs) opts.log(`${entry.name}: ${cs} left`);
    if (entry.room.size === 0 && rooms.get(entry.name) === entry) rooms.delete(entry.name);
  }

  function onHello(conn: Conn, raw: string): void {
    const parsed = parseClientMsg(raw);
    if (!parsed.ok) {
      sendError(conn, parsed.code, parsed.reason);
      closeWith(conn, 1008, 'hello required');
      return;
    }
    if (parsed.msg.t !== 'hello') {
      sendError(conn, 'illegalState', 'the first message must be hello');
      closeWith(conn, 1008, 'hello required');
      return;
    }
    const hello = parsed.msg;
    let entry = rooms.get(hello.room);
    const created = entry === undefined;
    if (!entry) {
      if (rooms.size >= opts.maxRooms) {
        sendError(conn, 'full', 'the server has no free room');
        closeWith(conn, 1008, 'server full');
        return;
      }
      entry = { name: hello.room, room: new Room({ name: hello.room, seed: randomInt(0, 2 ** 32) }), conns: new Map() };
      rooms.set(hello.room, entry);
    }
    const res = entry.room.join(conn.id, hello, Date.now());
    if (res.reject) {
      sendError(conn, res.reject.code, res.reject.reason);
      opts.log(`${hello.room}: join rejected (${res.reject.code}) ${res.reject.reason}`);
      if (created) rooms.delete(hello.room);
      closeWith(conn, 1008, res.reject.code);
      return;
    }
    conn.room = entry;
    entry.conns.set(conn.id, conn);
    for (const m of res.direct) send(conn, m);
    broadcast(entry, entry.room.stamp(res.events), conn);
    opts.log(`${hello.room}: ${res.callsign ?? '?'} (${hello.name}) joined`);
  }

  function onMessage(conn: Conn, raw: string): void {
    const entry = conn.room;
    if (!entry) {
      onHello(conn, raw);
      return;
    }
    const parsed = parseClientMsg(raw);
    if (!parsed.ok) {
      send(conn, { t: 'reject', ref: refOf(raw), code: parsed.code, reason: parsed.reason });
      if (!conn.badInput.take(Date.now())) closeWith(conn, 1008, 'too many invalid messages');
      return;
    }
    const msg: ClientMsg = parsed.msg;
    const res = entry.room.handle(conn.id, msg, Date.now());
    if (res.reject) {
      send(conn, { t: 'reject', ref: msg.t, code: res.reject.code, reason: res.reject.reason });
      opts.log(`${entry.name}: ${entry.room.callsignOf(conn.id) ?? '?'} ${msg.t} rejected (${res.reject.code}) ${res.reject.reason}`);
      if (res.reject.code === 'rate' && ++conn.strikes >= MAX_STRIKES) closeWith(conn, 1008, 'flooding');
      return;
    }
    for (const m of res.direct) send(conn, m);
    if (res.events.length > 0) broadcast(entry, entry.room.stamp(res.events));
  }

  function onData(conn: Conn, chunk: Buffer): void {
    if (conn.closing) return;
    conn.lastSeenMs = Date.now();
    conn.buf = conn.buf.length === 0 ? chunk : Buffer.concat([conn.buf, chunk]);
    const parsed = parseFrames(conn.buf, MAX_PAYLOAD);
    if ('error' in parsed) {
      closeWith(conn, parsed.error, parsed.error === 1009 ? 'message too big' : 'protocol error');
      return;
    }
    conn.buf = conn.buf.subarray(parsed.consumed);
    for (const f of parsed.frames) {
      if (conn.closing) return;
      switch (f.opcode) {
        case OP_TEXT: {
          if (!f.fin) {
            closeWith(conn, 1003, 'fragmented messages are not supported');
            return;
          }
          let text: string;
          try {
            text = decoder.decode(f.payload);
          } catch {
            closeWith(conn, 1007, 'invalid UTF-8');
            return;
          }
          onMessage(conn, text);
          break;
        }
        case OP_BINARY:
        case OP_CONT:
          closeWith(conn, 1003, 'text frames only');
          return;
        case OP_PING:
          write(conn, encodeFrame(OP_PONG, f.payload));
          break;
        case OP_PONG:
          break;
        case OP_CLOSE: {
          conn.closing = true;
          let code = 1000;
          if (f.payload.length === 1) code = 1002;
          else if (f.payload.length >= 2) {
            const c = f.payload.readUInt16BE(0);
            code = (c >= 1000 && c <= 1003) || (c >= 1007 && c <= 1011) || (c >= 3000 && c <= 4999) ? c : 1002;
          }
          write(conn, encodeClose(code, ''));
          conn.socket.end();
          return;
        }
        default:
          closeWith(conn, 1002, 'protocol error');
          return;
      }
    }
  }

  function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => socket.destroy());
    const key = req.headers['sec-websocket-key'];
    const upgrade = (req.headers.upgrade ?? '').toLowerCase();
    const connection = (req.headers.connection ?? '').toLowerCase();
    if (
      req.method !== 'GET' ||
      upgrade !== 'websocket' ||
      !connection.split(',').some((t) => t.trim() === 'upgrade') ||
      req.headers['sec-websocket-version'] !== '13' ||
      typeof key !== 'string' ||
      !KEY_SHAPE.test(key)
    ) {
      refuse(socket, '400 Bad Request');
      return;
    }
    if (!originAllowed(req.headers.origin, opts.allowedOrigins)) {
      refuse(socket, '403 Forbidden');
      return;
    }
    if (conns.size >= MAX_CONNECTIONS) {
      refuse(socket, '503 Service Unavailable');
      return;
    }
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    const now = Date.now();
    const conn: Conn = {
      id: `c${nextConn++}`,
      socket: socket as Socket,
      buf: Buffer.alloc(0),
      room: null,
      closing: false,
      connectedMs: now,
      lastSeenMs: now,
      lastPingMs: now,
      strikes: 0,
      badInput: new RateLimiter(40, 20),
    };
    conns.set(conn.id, conn);
    socket.on('data', (chunk: Buffer) => onData(conn, chunk));
    socket.on('end', () => socket.end());
    socket.on('close', () => dropConn(conn));
    if (head.length > 0) onData(conn, head);
  }

  const http: Server = createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Patrol co-op server');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });
  http.on('upgrade', onUpgrade);

  const presenceTimer = setInterval(() => {
    for (const entry of rooms.values()) {
      const msg = entry.room.presence();
      if (msg.t === 'presence' && msg.units.length > 0) broadcast(entry, [msg]);
    }
  }, PRESENCE_MS);
  let tick = 0;
  const maintenanceTimer = setInterval(() => {
    const now = Date.now();
    tick++;
    for (const c of Array.from(conns.values())) {
      if (tick % 6 === 0 && c.strikes > 0) c.strikes--;
      if (now - c.lastSeenMs > SILENT_MS || (c.room === null && now - c.connectedMs > HELLO_DEADLINE_MS)) {
        c.socket.destroy();
        continue;
      }
      if (!c.closing && now - c.lastPingMs >= PING_MS) {
        c.lastPingMs = now;
        write(c, encodeFrame(OP_PING, Buffer.alloc(0)));
      }
    }
  }, MAINTENANCE_MS);
  presenceTimer.unref();
  maintenanceTimer.unref();

  return new Promise<RunningServer>((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port, opts.host, () => {
      http.off('error', reject);
      http.on('error', (e) => opts.log(`server error: ${e.message}`));
      const addr = http.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : opts.port;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(presenceTimer);
            clearInterval(maintenanceTimer);
            for (const c of Array.from(conns.values())) {
              if (!c.closing) closeWith(c, 1001, 'server shutting down');
            }
            http.close(() => done());
            http.closeAllConnections();
          }),
      });
    });
  });
}
