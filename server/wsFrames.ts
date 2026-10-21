/// <reference types="node" />
/**
 * Minimal RFC 6455 frame codec for the co-op server: pure functions over Buffers, no sockets.
 */
import { createHash } from 'node:crypto';

export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OP_CONT = 0x0;
export const OP_TEXT = 0x1;
export const OP_BINARY = 0x2;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;

/** Sec-WebSocket-Accept value: base64(sha1(key + GUID)). */
export function acceptKey(secWebSocketKey: string): string {
  return createHash('sha1')
    .update(secWebSocketKey + WS_GUID)
    .digest('base64');
}

export interface Frame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

/** Parses as many complete frames as `buf` holds: byte0 FIN 0x80 | opcode; byte1 MASK 0x80 | len7; 126 -> 16-bit BE,
 *  127 -> 64-bit BE (> maxPayload -> error 1009); 4-byte mask key when MASK; unmask XOR mask[i % 4]. Returns the
 *  frames and the number of bytes consumed (a trailing partial frame stays unconsumed), or { error: closeCode } for
 *  protocol errors (unmasked client frame 1002, reserved bits or opcode 1002, oversized 1009). */
export function parseFrames(buf: Buffer, maxPayload: number): { frames: Frame[]; consumed: number } | { error: number } {
  const frames: Frame[] = [];
  let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    const b0 = buf[off] as number;
    const b1 = buf[off + 1] as number;
    if ((b0 & 0x70) !== 0) return { error: 1002 };
    const opcode = b0 & 0x0f;
    if (!(opcode <= 2 || (opcode >= 8 && opcode <= 10))) return { error: 1002 };
    if ((b1 & 0x80) === 0) return { error: 1002 };
    const fin = (b0 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let head = 2;
    if (len === 126) {
      if (buf.length - off < 4) break;
      len = buf.readUInt16BE(off + 2);
      head = 4;
    } else if (len === 127) {
      if (buf.length - off < 10) break;
      const hi = buf.readUInt32BE(off + 2);
      if (hi !== 0) return { error: 1009 };
      len = buf.readUInt32BE(off + 6);
      head = 10;
    }
    if (opcode >= 8 && (!fin || len > 125)) return { error: 1002 };
    if (len > maxPayload) return { error: 1009 };
    if (buf.length - off < head + 4 + len) break;
    const mask = off + head;
    const start = mask + 4;
    const payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) {
      payload[i] = (buf[start + i] as number) ^ (buf[mask + (i & 3)] as number);
    }
    frames.push({ fin, opcode, payload });
    off = start + len;
  }
  return { frames, consumed: off };
}

/** Server -> client frame: FIN set, unmasked. */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let head: Buffer;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len <= 0xffff) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeUInt32BE(0, 2);
    head.writeUInt32BE(len, 6);
  }
  head[0] = 0x80 | (opcode & 0x0f);
  return Buffer.concat([head, payload]);
}

/** Close frame with a status code and a (truncated to 123 bytes) UTF-8 reason. */
export function encodeClose(code: number, reason: string): Buffer {
  const text = Buffer.from(reason, 'utf8').subarray(0, 123);
  const payload = Buffer.alloc(2 + text.length);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);
  return encodeFrame(OP_CLOSE, payload);
}

/** Client -> server frame (FIN set, masked with a 4-byte key). Used by tests and tools. */
export function encodeClientFrame(opcode: number, payload: Buffer, maskKey: Buffer, fin = true): Buffer {
  const plain = encodeFrame(opcode, payload);
  const headLen = plain.length - payload.length;
  const out = Buffer.alloc(plain.length + 4);
  plain.copy(out, 0, 0, headLen);
  out[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);
  out[1] = (out[1] as number) | 0x80;
  maskKey.copy(out, headLen, 0, 4);
  for (let i = 0; i < payload.length; i++) {
    out[headLen + 4 + i] = (payload[i] as number) ^ (maskKey[i & 3] as number);
  }
  return out;
}
