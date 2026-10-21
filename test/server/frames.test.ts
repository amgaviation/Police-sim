/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import {
  OP_CLOSE,
  OP_PING,
  OP_TEXT,
  WS_GUID,
  acceptKey,
  encodeClientFrame,
  encodeClose,
  encodeFrame,
  parseFrames,
} from '../../server/wsFrames';

const MASK = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);

describe('acceptKey', () => {
  it('matches the RFC 6455 example', () => {
    expect(WS_GUID).toBe('258EAFA5-E914-47DA-95CA-C5AB0DC85B11');
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });
});

describe('parseFrames', () => {
  it('decodes the RFC masked "Hello" frame', () => {
    const buf = Buffer.from([0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58]);
    const r = parseFrames(buf, 1024);
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.consumed).toBe(buf.length);
    expect(r.frames).toHaveLength(1);
    expect(r.frames[0]?.fin).toBe(true);
    expect(r.frames[0]?.opcode).toBe(OP_TEXT);
    expect(r.frames[0]?.payload.toString('utf8')).toBe('Hello');
  });

  it('decodes 16-bit and 64-bit extended lengths', () => {
    for (const size of [126, 300, 65535, 65536, 70000]) {
      const payload = Buffer.alloc(size, 0x61);
      const buf = encodeClientFrame(OP_TEXT, payload, MASK);
      const r = parseFrames(buf, 100000);
      if ('error' in r) throw new Error(`error ${r.error} for ${size}`);
      expect(r.frames[0]?.payload.length).toBe(size);
      expect(r.frames[0]?.payload.equals(payload)).toBe(true);
      expect(r.consumed).toBe(buf.length);
    }
    // header sizes: 16-bit uses 2+2+4, 64-bit uses 2+8+4
    expect(encodeClientFrame(OP_TEXT, Buffer.alloc(300), MASK)[1]).toBe(0x80 | 126);
    expect(encodeClientFrame(OP_TEXT, Buffer.alloc(70000), MASK)[1]).toBe(0x80 | 127);
  });

  it('handles split buffers byte by byte', () => {
    const msg = Buffer.from('{"t":"ping","n":1}', 'utf8');
    const buf = encodeClientFrame(OP_TEXT, msg, MASK);
    let pending = Buffer.alloc(0);
    let got = 0;
    for (let i = 0; i < buf.length; i++) {
      pending = Buffer.concat([pending, buf.subarray(i, i + 1)]);
      const r = parseFrames(pending, 1024);
      if ('error' in r) throw new Error('unexpected error');
      if (r.frames.length > 0) {
        got++;
        expect(i).toBe(buf.length - 1);
        expect(r.frames[0]?.payload.equals(msg)).toBe(true);
        pending = pending.subarray(r.consumed);
      } else {
        expect(r.consumed).toBe(0);
      }
    }
    expect(got).toBe(1);
    expect(pending.length).toBe(0);
  });

  it('handles coalesced frames and leaves a trailing partial frame unconsumed', () => {
    const a = encodeClientFrame(OP_TEXT, Buffer.from('one'), MASK);
    const b = encodeClientFrame(OP_PING, Buffer.from('p'), Buffer.from([1, 2, 3, 4]));
    const c = encodeClientFrame(OP_TEXT, Buffer.from('three'), MASK);
    const partial = c.subarray(0, c.length - 2);
    const buf = Buffer.concat([a, b, partial]);
    const r = parseFrames(buf, 1024);
    if ('error' in r) throw new Error('unexpected error');
    expect(r.frames.map((f) => f.payload.toString())).toEqual(['one', 'p']);
    expect(r.frames.map((f) => f.opcode)).toEqual([OP_TEXT, OP_PING]);
    expect(r.consumed).toBe(a.length + b.length);
    const rest = Buffer.concat([buf.subarray(r.consumed), c.subarray(c.length - 2)]);
    const r2 = parseFrames(rest, 1024);
    if ('error' in r2) throw new Error('unexpected error');
    expect(r2.frames.map((f) => f.payload.toString())).toEqual(['three']);
  });

  it('returns nothing for an empty or one-byte buffer', () => {
    expect(parseFrames(Buffer.alloc(0), 10)).toEqual({ frames: [], consumed: 0 });
    expect(parseFrames(Buffer.from([0x81]), 10)).toEqual({ frames: [], consumed: 0 });
  });

  it('reports FIN = 0 for fragments', () => {
    const buf = encodeClientFrame(OP_TEXT, Buffer.from('part'), MASK, false);
    const r = parseFrames(buf, 1024);
    if ('error' in r) throw new Error('unexpected error');
    expect(r.frames[0]?.fin).toBe(false);
  });

  it('rejects an unmasked client frame with 1002', () => {
    expect(parseFrames(encodeFrame(OP_TEXT, Buffer.from('hi')), 1024)).toEqual({ error: 1002 });
  });

  it('rejects reserved bits and reserved opcodes with 1002', () => {
    const good = encodeClientFrame(OP_TEXT, Buffer.from('hi'), MASK);
    for (const bit of [0x40, 0x20, 0x10]) {
      const bad = Buffer.from(good);
      bad[0] = (bad[0] as number) | bit;
      expect(parseFrames(bad, 1024)).toEqual({ error: 1002 });
    }
    for (const op of [3, 7, 11, 15]) {
      const bad = Buffer.from(good);
      bad[0] = 0x80 | op;
      expect(parseFrames(bad, 1024)).toEqual({ error: 1002 });
    }
  });

  it('rejects fragmented or oversized control frames with 1002', () => {
    expect(parseFrames(encodeClientFrame(OP_PING, Buffer.from('x'), MASK, false), 1024)).toEqual({ error: 1002 });
    expect(parseFrames(encodeClientFrame(OP_PING, Buffer.alloc(126), MASK), 1024)).toEqual({ error: 1002 });
  });

  it('rejects oversized payloads with 1009 before the payload arrives', () => {
    const big = encodeClientFrame(OP_TEXT, Buffer.alloc(2000), MASK);
    expect(parseFrames(big, 1999)).toEqual({ error: 1009 });
    expect('error' in parseFrames(big, 2000)).toBe(false);
    expect(parseFrames(big.subarray(0, 8), 1000)).toEqual({ error: 1009 }); // header only
    // 64-bit length with a high word set
    const huge = Buffer.from([0x81, 0xff, 0, 0, 0, 1, 0, 0, 0, 0, 1, 2, 3, 4]);
    expect(parseFrames(huge, 65536)).toEqual({ error: 1009 });
  });
});

describe('encodeFrame / encodeClose', () => {
  it('encodes short, 16-bit and 64-bit lengths unmasked with FIN', () => {
    const short = encodeFrame(OP_TEXT, Buffer.from('hi'));
    expect([...short]).toEqual([0x81, 2, 0x68, 0x69]);
    const mid = encodeFrame(OP_TEXT, Buffer.alloc(300));
    expect([...mid.subarray(0, 4)]).toEqual([0x81, 126, 1, 44]);
    expect(mid.length).toBe(304);
    const long = encodeFrame(OP_TEXT, Buffer.alloc(70000));
    expect([...long.subarray(0, 10)]).toEqual([0x81, 127, 0, 0, 0, 0, 0, 1, 17, 112]);
    expect(long.length).toBe(70010);
  });

  it('round trips through a masked client frame', () => {
    for (const size of [0, 1, 125, 126, 65535, 65536]) {
      const payload = Buffer.alloc(size);
      for (let i = 0; i < size; i++) payload[i] = (i * 7) & 0xff;
      const server = encodeFrame(OP_TEXT, payload);
      expect(server[1]).toBeLessThan(0x80);
      const r = parseFrames(encodeClientFrame(OP_TEXT, payload, MASK), 70000);
      if ('error' in r) throw new Error('unexpected error');
      expect(r.frames[0]?.payload.equals(payload)).toBe(true);
      expect(server.subarray(server.length - size).equals(payload)).toBe(true);
    }
  });

  it('encodes a close frame with code and truncated reason', () => {
    const f = encodeClose(1008, 'policy');
    expect(f[0]).toBe(0x80 | OP_CLOSE);
    expect(f.readUInt16BE(2)).toBe(1008);
    expect(f.subarray(4).toString()).toBe('policy');
    const long = encodeClose(1000, 'x'.repeat(500));
    expect(long[1]).toBe(125);
    expect(encodeClose(1000, '').length).toBe(4);
  });
});
