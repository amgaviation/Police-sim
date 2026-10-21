import { describe, expect, it } from 'vitest';
import { DISPOSITIONS } from '../../src/cad/data';
import { UNIT_STATUSES } from '../../src/cad/types';
import {
  CALL_ORIGINS,
  LIMITS,
  NET_DISPOSITIONS,
  NET_ROLES,
  NET_UNIT_STATUSES,
  ORDER_KINDS,
  PROTOCOL_VERSION,
  REJECT_CODES,
  ROLE_LIMITS,
  encode,
  hasControlChars,
  parseClientMsg,
  parseServerMsg,
  utf8Length,
} from '../../src/net/protocol';
import type { ClientMsg, NetCall, NetUnit, RoomEvent, ServerMsg } from '../../src/net/protocol';

const hello = { t: 'hello', v: PROTOCOL_VERSION, name: 'Ann', role: 'patrol', room: 'alpha' };
const create = {
  t: 'callCreate',
  ref: 'r1',
  typeId: 'noise_complaint',
  label: 'Noise',
  priority: 3,
  x: 10,
  z: -20,
  address: '12 Main St',
  narrative: 'Loud music',
  origin: 'dispatcher',
};

/** Samples of every client message type (all valid). */
const VALID: Record<ClientMsg['t'], Record<string, unknown>> = {
  hello,
  presence: { t: 'presence', x: 1, z: 2, heading: 0.5, speed: 10, driving: true },
  unitStatus: { t: 'unitStatus', status: 'enRoute', callId: 3 },
  callCreate: create,
  callAssign: { t: 'callAssign', callId: 1, unit: 'N1' },
  callUnassign: { t: 'callUnassign', callId: 1, unit: 'N1' },
  callPriority: { t: 'callPriority', callId: 1, priority: 2 },
  callNote: { t: 'callNote', callId: 1, text: 'caller left' },
  callClose: { t: 'callClose', callId: 1, disposition: 'handled' },
  order: { t: 'order', unit: 'N1', order: 'respond', callId: 1, text: 'go' },
  partner: { t: 'partner', unit: 'N2' },
  radio: { t: 'radio', channel: 'main', text: 'copy' },
  ping: { t: 'ping', n: 7 },
};

function code(raw: string): string {
  const r = parseClientMsg(raw);
  return r.ok ? 'ok' : r.code;
}
function codeOf(obj: unknown): string {
  return code(JSON.stringify(obj));
}

describe('constants', () => {
  it('NET_UNIT_STATUSES equals the cad UNIT_STATUSES', () => {
    expect([...NET_UNIT_STATUSES]).toEqual([...UNIT_STATUSES]);
  });
  it('NET_DISPOSITIONS equals the ids of the cad dispositions', () => {
    expect([...NET_DISPOSITIONS]).toEqual(DISPOSITIONS.map((d) => d.id));
  });
  it('fixed lists match the design contract', () => {
    expect([...NET_ROLES]).toEqual(['patrol', 'dispatcher', 'supervisor']);
    expect([...ORDER_KINDS]).toEqual(['respond', 'returnToStation', 'terminatePursuit', 'code4', 'backup']);
    expect([...REJECT_CODES]).toEqual([
      'malformed', 'version', 'unknownType', 'forbidden', 'notFound', 'illegalState', 'invalidValue', 'rate', 'full',
    ]);
    expect(ROLE_LIMITS).toEqual({ patrol: 4, dispatcher: 1, supervisor: 1 });
    expect(PROTOCOL_VERSION).toBe(1);
    expect(LIMITS.messageBytes).toBe(8192);
    expect([...CALL_ORIGINS]).toEqual(['dispatcher', 'generator', 'officer']);
  });
});

describe('utf8Length', () => {
  it('matches TextEncoder', () => {
    for (const s of ['', 'abc', 'é', '€', '😀', 'a😀b€é', '\ud800', 'x\udc00y']) {
      expect(utf8Length(s)).toBe(new TextEncoder().encode(s).length);
    }
  });
});

describe('parseClientMsg: accepts', () => {
  it('every message type round-trips through encode', () => {
    for (const [t, msg] of Object.entries(VALID)) {
      const r = parseClientMsg(JSON.stringify(msg));
      expect(r.ok, t).toBe(true);
      if (r.ok) expect(parseClientMsg(encode(r.msg)).ok).toBe(true);
    }
  });
  it('accepts null callId, an optional seed and an empty order text', () => {
    expect(codeOf({ ...VALID.unitStatus, status: 'available', callId: null })).toBe('ok');
    expect(codeOf({ ...hello, seed: 1234 })).toBe('ok');
    expect(codeOf({ ...VALID.order, order: 'code4', callId: null, text: '' })).toBe('ok');
  });
  it('accepts text at exactly the limit', () => {
    expect(codeOf({ ...create, label: 'x'.repeat(LIMITS.label), narrative: 'n'.repeat(LIMITS.narrative) })).toBe('ok');
    expect(codeOf({ ...VALID.radio, text: 'r'.repeat(LIMITS.radio) })).toBe('ok');
  });
});

describe('parseClientMsg: malformed', () => {
  it('rejects invalid JSON and non-objects', () => {
    for (const raw of ['', '{', 'not json', '[1,2]', 'null', '42', '"hello"', '{"t":']) {
      expect(code(raw), raw).toBe('malformed');
    }
  });
  it('rejects non-string input without throwing', () => {
    expect(parseClientMsg(undefined as unknown as string)).toMatchObject({ ok: false, code: 'malformed' });
    expect(parseClientMsg(5 as unknown as string)).toMatchObject({ ok: false, code: 'malformed' });
  });
  it('rejects oversized messages by UTF-8 byte length', () => {
    const big = JSON.stringify({ ...VALID.callNote, text: 'x'.repeat(9000) });
    expect(code(big)).toBe('malformed');
    // 2800 emoji = 11200 bytes but only 5600 UTF-16 units: the byte count is what matters
    expect(code(JSON.stringify({ t: 'ping', n: 1, pad: '😀'.repeat(2100) }))).toBe('malformed');
    const pad = ' '.repeat(LIMITS.messageBytes - JSON.stringify(VALID.ping).length);
    expect(code(JSON.stringify(VALID.ping) + pad)).toBe('ok');
    expect(code(JSON.stringify(VALID.ping) + pad + ' ')).toBe('malformed');
  });
  it('rejects missing fields for every type', () => {
    for (const [t, msg] of Object.entries(VALID)) {
      for (const key of Object.keys(msg)) {
        if (key === 't' || (t === 'hello' && (key === 'v' || key === 'seed'))) continue;
        const copy = { ...msg };
        delete copy[key];
        expect(codeOf(copy), `${t} without ${key}`).toBe('malformed');
      }
    }
  });
  it('rejects unknown extra fields for every type', () => {
    for (const [t, msg] of Object.entries(VALID)) {
      expect(codeOf({ ...msg, extra: 1 }), t).toBe('malformed');
    }
    expect(code('{"t":"ping","n":1,"__proto__":{"x":1}}')).toBe('malformed');
  });
  it('rejects wrong-typed fields', () => {
    expect(codeOf({ ...VALID.presence, x: '1' })).toBe('malformed');
    expect(codeOf({ ...VALID.presence, driving: 1 })).toBe('malformed');
    expect(codeOf({ ...VALID.presence, speed: null })).toBe('malformed');
    expect(codeOf({ ...VALID.unitStatus, callId: '3' })).toBe('malformed');
    expect(codeOf({ ...VALID.unitStatus, status: 3 })).toBe('malformed');
    expect(codeOf({ ...VALID.callNote, text: 12 })).toBe('malformed');
    expect(codeOf({ ...VALID.callNote, callId: [1] })).toBe('malformed');
    expect(codeOf({ ...create, priority: '2' })).toBe('malformed');
    expect(codeOf({ ...hello, name: null })).toBe('malformed');
    expect(codeOf({ ...hello, seed: 'abc' })).toBe('malformed');
    expect(codeOf({ ...VALID.ping, n: true })).toBe('malformed');
  });
});

describe('parseClientMsg: unknownType and version', () => {
  it('unknownType for a missing, non-string or unknown t', () => {
    expect(codeOf({})).toBe('unknownType');
    expect(codeOf({ t: 5 })).toBe('unknownType');
    expect(codeOf({ t: 'launchMissiles' })).toBe('unknownType');
    expect(codeOf({ t: 'toString' })).toBe('unknownType');
    expect(codeOf({ t: '__proto__' })).toBe('unknownType');
  });
  it('version mismatch is checked before the other hello fields', () => {
    expect(codeOf({ ...hello, v: 2 })).toBe('version');
    expect(codeOf({ ...hello, v: 0 })).toBe('version');
    expect(codeOf({ t: 'hello', v: 99 })).toBe('version');
    expect(codeOf({ t: 'hello', name: 'x' })).toBe('malformed');
    expect(codeOf({ ...hello, v: '1' })).toBe('malformed');
  });
});

describe('parseClientMsg: invalidValue', () => {
  it('ranges', () => {
    expect(codeOf({ ...VALID.presence, x: 3701 })).toBe('invalidValue');
    expect(codeOf({ ...VALID.presence, z: -3701 })).toBe('invalidValue');
    expect(codeOf({ ...VALID.presence, x: 3700, z: -3700 })).toBe('ok');
    expect(codeOf({ ...VALID.presence, speed: 121 })).toBe('invalidValue');
    expect(codeOf({ ...VALID.presence, speed: -1 })).toBe('invalidValue');
    expect(code('{"t":"presence","x":1e999,"z":0,"heading":0,"speed":0,"driving":false}')).toBe('invalidValue');
    expect(codeOf({ ...create, priority: 0 })).toBe('invalidValue');
    expect(codeOf({ ...create, priority: 5 })).toBe('invalidValue');
    expect(codeOf({ ...create, priority: 2.5 })).toBe('invalidValue');
    expect(codeOf({ ...VALID.callAssign, callId: 0 })).toBe('invalidValue');
    expect(codeOf({ ...VALID.callAssign, callId: 1.5 })).toBe('invalidValue');
    expect(codeOf({ ...VALID.ping, n: -1 })).toBe('invalidValue');
    expect(codeOf({ ...hello, seed: -1 })).toBe('invalidValue');
    expect(codeOf({ ...hello, seed: 4294967296 })).toBe('invalidValue');
  });
  it('lengths', () => {
    expect(codeOf({ ...hello, name: '' })).toBe('invalidValue');
    expect(codeOf({ ...hello, name: 'n'.repeat(LIMITS.name + 1) })).toBe('invalidValue');
    expect(codeOf({ ...hello, room: 'r'.repeat(LIMITS.room + 1) })).toBe('invalidValue');
    expect(codeOf({ ...create, label: '' })).toBe('invalidValue');
    expect(codeOf({ ...create, label: 'x'.repeat(LIMITS.label + 1) })).toBe('invalidValue');
    expect(codeOf({ ...create, address: 'a'.repeat(LIMITS.address + 1) })).toBe('invalidValue');
    expect(codeOf({ ...create, narrative: 'n'.repeat(LIMITS.narrative + 1) })).toBe('invalidValue');
    expect(codeOf({ ...create, ref: 'r'.repeat(LIMITS.ref + 1) })).toBe('invalidValue');
    expect(codeOf({ ...VALID.callNote, text: '' })).toBe('invalidValue');
    expect(codeOf({ ...VALID.callNote, text: 'n'.repeat(LIMITS.note + 1) })).toBe('invalidValue');
    expect(codeOf({ ...VALID.radio, text: 'r'.repeat(LIMITS.radio + 1) })).toBe('invalidValue');
    expect(codeOf({ ...VALID.order, text: 'o'.repeat(LIMITS.note + 1) })).toBe('invalidValue');
    expect(codeOf({ ...VALID.partner, unit: '' })).toBe('invalidValue');
  });
  it('enums and patterns', () => {
    expect(codeOf({ ...hello, role: 'admin' })).toBe('invalidValue');
    expect(codeOf({ ...VALID.unitStatus, status: 'asleep' })).toBe('invalidValue');
    expect(codeOf({ ...VALID.callClose, disposition: 'vanished' })).toBe('invalidValue');
    expect(codeOf({ ...VALID.order, order: 'launch' })).toBe('invalidValue');
    expect(codeOf({ ...VALID.radio, channel: 'private' })).toBe('invalidValue');
    expect(codeOf({ ...create, origin: 'ghost' })).toBe('invalidValue');
    expect(codeOf({ ...create, typeId: 'has space' })).toBe('invalidValue');
    expect(codeOf({ ...create, typeId: 'a-b' })).toBe('invalidValue');
    expect(codeOf({ ...create, typeId: 'x'.repeat(LIMITS.typeId + 1) })).toBe('invalidValue');
  });
  it('control characters in any text field (never rewritten)', () => {
    for (const bad of ['a\nb', 'a\tb', 'a\u0000b', 'a\u001fb', 'a\u007fb', '\r']) {
      expect(codeOf({ ...hello, name: bad }), JSON.stringify(bad)).toBe('invalidValue');
      expect(codeOf({ ...VALID.callNote, text: bad })).toBe('invalidValue');
      expect(codeOf({ ...VALID.radio, text: bad })).toBe('invalidValue');
      expect(codeOf({ ...create, narrative: bad })).toBe('invalidValue');
      expect(codeOf({ ...create, address: bad })).toBe('invalidValue');
      expect(codeOf({ ...VALID.partner, unit: bad })).toBe('invalidValue');
    }
    expect(hasControlChars('plain text é 😀')).toBe(false);
    expect(hasControlChars('x\u007f')).toBe(true);
  });
  it('shape errors win over value errors', () => {
    expect(codeOf({ ...VALID.presence, x: 99999, extra: true })).toBe('malformed');
  });
});

describe('parseServerMsg', () => {
  const unit: NetUnit = {
    callsign: 'N1', role: 'patrol', name: 'Ann', status: 'available', callId: null,
    x: 0, z: 0, heading: 0, speed: 0, driving: false, partner: null,
  };
  const call: NetCall = {
    id: 1, ref: 'r', typeId: 't', label: 'l', priority: 2, x: 0, z: 0, address: '', narrative: '', status: 'pending',
    units: [], primary: null, notes: [{ by: 'N1', text: 'hi', atMs: 5 }], createdBy: 'DISPATCH', origin: 'dispatcher',
    createdAtMs: 1, disposition: null,
  };
  const events: RoomEvent[] = [
    { k: 'joined', unit }, { k: 'left', callsign: 'N1' }, { k: 'host', callsign: 'N1' },
    { k: 'unitStatus', callsign: 'N1', status: 'busy', callId: null }, { k: 'callCreated', call },
    { k: 'callAssigned', callId: 1, callsign: 'N1', primary: 'N1' }, { k: 'callUnassigned', callId: 1, callsign: 'N1' },
    { k: 'callPriority', callId: 1, priority: 1 }, { k: 'callNote', callId: 1, note: { by: 'N1', text: 'x', atMs: 1 } },
    { k: 'callClosed', callId: 1, disposition: 'handled' },
    { k: 'order', to: 'N1', from: 'S1', order: 'code4', callId: null, text: '' },
    { k: 'partnered', a: 'N1', b: 'N2' }, { k: 'radio', from: 'N1', channel: 'tac', text: 'hi' },
  ];
  it('accepts every server message and event shape', () => {
    const msgs: ServerMsg[] = [
      { t: 'welcome', v: 1, callsign: 'N1', role: 'patrol', snapshot: { room: 'a', seed: 3, rev: 1, host: 'N1', units: [unit], calls: [call] } },
      { t: 'presence', units: [{ callsign: 'N1', x: 1, z: 2, heading: 0, speed: 0, driving: false }] },
      { t: 'reject', ref: 'ping', code: 'rate', reason: 'slow down' },
      { t: 'pong', n: 3 },
      { t: 'error', code: 'full', reason: 'no' },
      ...events.map((ev, i): ServerMsg => ({ t: 'event', rev: i + 1, ev })),
    ];
    for (const m of msgs) {
      const r = parseServerMsg(encode(m));
      expect(r.ok, m.t).toBe(true);
      if (r.ok) expect(r.msg).toEqual(m);
    }
  });
  it('is lenient about unknown extra fields', () => {
    const r = parseServerMsg('{"t":"pong","n":1,"future":true}');
    expect(r).toEqual({ ok: true, msg: { t: 'pong', n: 1, future: true } });
  });
  it('rejects garbage without throwing', () => {
    for (const raw of ['', 'x', '[]', '{"t":"nope"}', '{"t":"pong"}', '{"t":"event","rev":1,"ev":{"k":"left"}}',
      '{"t":"event","rev":1,"ev":{"k":"zzz"}}', '{"t":"presence","units":[{"callsign":1}]}', '{"t":"reject","ref":"a","code":"bad","reason":"r"}']) {
      expect(parseServerMsg(raw).ok, raw).toBe(false);
    }
    expect(parseServerMsg(undefined as unknown as string).ok).toBe(false);
  });
});
