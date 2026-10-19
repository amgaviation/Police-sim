import { describe, expect, it } from 'vitest';
import {
  CustodyLedger,
  entryHash,
  verifyLedger,
  type CustodyEntry,
  type CustodyRequest,
} from '../../src/evidence/ledger';
import { hashString } from '../../src/core/rng';

const OFFICER = 'officer:101';
const LOCKER = 'locker:2';

function req(itemId: string, action: CustodyRequest['action'], from: string, to: string, sim: number, extra: Partial<CustodyRequest> = {}): CustodyRequest {
  return { itemId, action, from, to, sim, game: sim * 2, location: '1420 Oak St · Kitchen', note: action, ...extra };
}

function mustAppend(l: CustodyLedger, r: CustodyRequest): CustodyEntry {
  const res = l.append(r);
  if (!res.ok) throw new Error(res.reason);
  return res.entry;
}

/** One item through the whole life cycle, with a transfer. */
function fullChain(item = 'E-7-1', start = 10): CustodyLedger {
  const l = new CustodyLedger();
  mustAppend(l, req(item, 'collect', 'scene', OFFICER, start));
  mustAppend(l, req(item, 'bag', OFFICER, OFFICER, start + 5));
  mustAppend(l, req(item, 'tag', OFFICER, OFFICER, start + 10));
  mustAppend(l, req(item, 'transfer', OFFICER, LOCKER, start + 20));
  mustAppend(l, req(item, 'deposit', LOCKER, 'evidenceRoom', start + 30));
  return l;
}

function reasonOf(l: CustodyLedger, r: CustodyRequest): string {
  const res = l.append(r);
  expect(res.ok).toBe(false);
  return res.ok ? '' : res.reason;
}

describe('entryHash', () => {
  it('is FNV-1a of the canonical string, 8 lowercase hex chars', () => {
    const body = {
      seq: 3, itemId: 'E-1-1', action: 'tag' as const, from: 'a', to: 'a', sim: 1.5, game: 2, location: 'loc', note: 'n', prevHash: '00000000',
    };
    const expected = hashString('3|E-1-1|tag|a|a|1.500|2.000|loc|n|00000000').toString(16).padStart(8, '0');
    expect(entryHash(body)).toBe(expected);
    expect(entryHash(body)).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('CustodyLedger', () => {
  it('builds a chain that verifies', () => {
    const l = fullChain();
    const entries = l.entries();
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(entries[0]?.prevHash).toBe('00000000');
    for (let i = 1; i < entries.length; i++) expect(entries[i]?.prevHash).toBe(entries[i - 1]?.hash);
    expect(verifyLedger(entries)).toEqual({ ok: true, issues: [] });
    expect(verifyLedger([])).toEqual({ ok: true, issues: [] });
  });

  it('tracks state and custodian per item', () => {
    const l = new CustodyLedger();
    expect(l.state('E-7-1')).toBe('none');
    expect(l.custodian('E-7-1')).toBe('');
    mustAppend(l, req('E-7-1', 'collect', 'scene', OFFICER, 1));
    expect(l.state('E-7-1')).toBe('collected');
    expect(l.custodian('E-7-1')).toBe(OFFICER);
    mustAppend(l, req('E-7-1', 'bag', OFFICER, OFFICER, 2));
    expect(l.state('E-7-1')).toBe('bagged');
    mustAppend(l, req('E-7-1', 'tag', OFFICER, OFFICER, 3));
    expect(l.state('E-7-1')).toBe('tagged');
    mustAppend(l, req('E-7-1', 'transfer', OFFICER, LOCKER, 4));
    expect(l.state('E-7-1')).toBe('tagged');
    expect(l.custodian('E-7-1')).toBe(LOCKER);
    mustAppend(l, req('E-7-1', 'transfer', LOCKER, 'officer:202', 5));
    expect(l.custodian('E-7-1')).toBe('officer:202');
    mustAppend(l, req('E-7-1', 'deposit', 'officer:202', 'evidenceRoom', 6));
    expect(l.state('E-7-1')).toBe('deposited');
    expect(l.custodian('E-7-1')).toBe('evidenceRoom');
  });

  it('rejects illegal appends with a reason and leaves the ledger unchanged', () => {
    const l = new CustodyLedger();
    expect(reasonOf(l, req('E-7-1', 'bag', OFFICER, OFFICER, 1))).toMatch(/before it is collected/);
    expect(reasonOf(l, req('E-7-1', 'collect', OFFICER, OFFICER, 1))).toMatch(/from the scene/);
    mustAppend(l, req('E-7-1', 'collect', 'scene', OFFICER, 1));
    expect(reasonOf(l, req('E-7-1', 'collect', 'scene', OFFICER, 2))).toMatch(/already collected/);
    expect(reasonOf(l, req('E-7-1', 'tag', OFFICER, OFFICER, 2))).toMatch(/needs bagged/);
    mustAppend(l, req('E-7-1', 'bag', OFFICER, OFFICER, 2));
    expect(reasonOf(l, req('E-7-1', 'bag', OFFICER, OFFICER, 3))).toMatch(/bagged/);
    expect(reasonOf(l, req('E-7-1', 'deposit', OFFICER, 'evidenceRoom', 3))).toMatch(/needs tagged/);
    mustAppend(l, req('E-7-1', 'tag', OFFICER, OFFICER, 3));
    expect(reasonOf(l, req('E-7-1', 'transfer', 'officer:999', LOCKER, 4))).toMatch(/holds it/);
    expect(reasonOf(l, req('E-7-1', 'transfer', OFFICER, OFFICER, 4))).toMatch(/different custodian/);
    expect(reasonOf(l, req('E-7-1', 'transfer', OFFICER, 'evidenceRoom', 4))).toMatch(/deposited/);
    expect(reasonOf(l, req('E-7-1', 'deposit', OFFICER, LOCKER, 4))).toMatch(/evidenceRoom/);
    expect(l.entries()).toHaveLength(3);
    mustAppend(l, req('E-7-1', 'deposit', OFFICER, 'evidenceRoom', 4));
    expect(reasonOf(l, req('E-7-1', 'deposit', 'evidenceRoom', 'evidenceRoom', 5))).toMatch(/already deposited/);
    expect(reasonOf(l, req('E-7-1', 'transfer', 'evidenceRoom', OFFICER, 5))).toMatch(/already deposited/);
    expect(l.entries()).toHaveLength(4);
  });

  it('rejects bag/tag that change custodian, and time going backwards', () => {
    const l = new CustodyLedger();
    mustAppend(l, req('E-7-1', 'collect', 'scene', OFFICER, 10));
    expect(reasonOf(l, req('E-7-1', 'bag', OFFICER, LOCKER, 11))).toMatch(/must stay with/);
    expect(reasonOf(l, req('E-7-1', 'bag', OFFICER, OFFICER, 9))).toMatch(/backwards/);
    expect(reasonOf(l, req('E-7-2', 'collect', 'scene', OFFICER, 9.999))).toMatch(/backwards/);
    expect(l.append(req('E-7-2', 'collect', 'scene', OFFICER, 10)).ok).toBe(true);
  });

  it('completes only after deposit', () => {
    const l = new CustodyLedger();
    expect(l.complete('E-7-1')).toBe(false);
    mustAppend(l, req('E-7-1', 'collect', 'scene', OFFICER, 1));
    mustAppend(l, req('E-7-1', 'bag', OFFICER, OFFICER, 2));
    mustAppend(l, req('E-7-1', 'tag', OFFICER, OFFICER, 3));
    mustAppend(l, req('E-7-1', 'transfer', OFFICER, LOCKER, 4));
    expect(l.complete('E-7-1')).toBe(false);
    mustAppend(l, req('E-7-1', 'deposit', LOCKER, 'evidenceRoom', 5));
    expect(l.complete('E-7-1')).toBe(true);
  });

  it('keeps interleaved items independent', () => {
    const l = new CustodyLedger();
    mustAppend(l, req('E-7-1', 'collect', 'scene', OFFICER, 1));
    mustAppend(l, req('E-7-2', 'collect', 'scene', 'officer:202', 2));
    mustAppend(l, req('E-7-1', 'bag', OFFICER, OFFICER, 3));
    mustAppend(l, req('E-7-2', 'bag', 'officer:202', 'officer:202', 4));
    mustAppend(l, req('E-7-2', 'tag', 'officer:202', 'officer:202', 5));
    expect(l.state('E-7-1')).toBe('bagged');
    expect(l.state('E-7-2')).toBe('tagged');
    expect(l.custodian('E-7-1')).toBe(OFFICER);
    expect(l.custodian('E-7-2')).toBe('officer:202');
    expect(l.itemEntries('E-7-1').map((e) => e.seq)).toEqual([1, 3]);
    expect(l.itemEntries('E-7-2').map((e) => e.seq)).toEqual([2, 4, 5]);
    expect(l.itemEntries('E-7-9')).toEqual([]);
    expect(verifyLedger(l.entries()).ok).toBe(true);
  });

  it('round-trips through serialize', () => {
    const l = fullChain();
    mustAppend(l, req('E-7-2', 'collect', 'scene', OFFICER, 50));
    const copy = JSON.parse(JSON.stringify(l.serialize())) as CustodyEntry[];
    const l2 = new CustodyLedger(copy);
    expect(verifyLedger(l2.serialize()).ok).toBe(true);
    expect(l2.state('E-7-1')).toBe('deposited');
    expect(l2.state('E-7-2')).toBe('collected');
    expect(l2.complete('E-7-1')).toBe(true);
    // The restored ledger keeps chaining correctly.
    mustAppend(l2, req('E-7-2', 'bag', OFFICER, OFFICER, 60));
    expect(verifyLedger(l2.entries()).ok).toBe(true);
    expect(l2.entries()[l2.entries().length - 1]?.prevHash).toBe(l.entries()[l.entries().length - 1]?.hash);
  });

  it('strips the field delimiter from free text', () => {
    const l = new CustodyLedger();
    const e = mustAppend(l, req('E-7-1', 'collect', 'scene', OFFICER, 1, { location: 'a|b', note: 'x|y' }));
    expect(e.location).toBe('a/b');
    expect(e.note).toBe('x/y');
    expect(l.append(req('E-7|1', 'collect', 'scene', OFFICER, 2)).ok).toBe(false);
  });
});

describe('verifyLedger', () => {
  it.each([
    ['game', (e: CustodyEntry): CustodyEntry => ({ ...e, game: e.game + 1 })],
    ['location', (e: CustodyEntry): CustodyEntry => ({ ...e, location: 'somewhere else' })],
    ['note', (e: CustodyEntry): CustodyEntry => ({ ...e, note: 'edited' })],
    ['sim', (e: CustodyEntry): CustodyEntry => ({ ...e, sim: e.sim + 0.5 })],
  ])('reports exactly one hash issue at an edited middle entry (%s)', (_name, edit) => {
    const entries = fullChain().serialize();
    entries[2] = edit(entries[2] as CustodyEntry);
    const res = verifyLedger(entries);
    expect(res.ok).toBe(false);
    expect(res.issues).toHaveLength(1);
    expect(res.issues[0]).toMatchObject({ seq: 3, kind: 'hash' });
  });

  it('reports a hash issue when identity fields of a middle entry are edited', () => {
    for (const edit of [
      (e: CustodyEntry): CustodyEntry => ({ ...e, itemId: 'E-7-9' }),
      (e: CustodyEntry): CustodyEntry => ({ ...e, action: 'bag' }),
      (e: CustodyEntry): CustodyEntry => ({ ...e, from: 'officer:555' }),
      (e: CustodyEntry): CustodyEntry => ({ ...e, to: 'officer:555' }),
      (e: CustodyEntry): CustodyEntry => ({ ...e, seq: 9 }),
      (e: CustodyEntry): CustodyEntry => ({ ...e, prevHash: 'deadbeef' }),
    ]) {
      const entries = fullChain().serialize();
      entries[2] = edit(entries[2] as CustodyEntry);
      const res = verifyLedger(entries);
      expect(res.ok).toBe(false);
      expect(res.issues.some((i) => i.kind === 'hash' && i.seq === entries[2]?.seq)).toBe(true);
    }
  });

  it('flags a forged stored hash on the last entry as a single hash issue', () => {
    const entries = fullChain().serialize();
    const last = entries[4] as CustodyEntry;
    entries[4] = { ...last, hash: '12345678' };
    const res = verifyLedger(entries);
    expect(res.issues).toEqual([expect.objectContaining({ seq: 5, kind: 'hash' })]);
  });

  it('reports gap and chain when an entry is deleted', () => {
    const entries = fullChain().serialize();
    entries.splice(2, 1);
    const res = verifyLedger(entries);
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.kind === 'gap' && i.seq === 4)).toBe(true);
    expect(res.issues.some((i) => i.kind === 'chain' && i.seq === 4)).toBe(true);
    const head = fullChain().serialize().slice(1);
    const headRes = verifyLedger(head);
    expect(headRes.issues.map((i) => i.kind)).toEqual(expect.arrayContaining(['gap', 'chain']));
  });

  it('detects swapped entries', () => {
    const entries = fullChain().serialize();
    const a = entries[2] as CustodyEntry;
    const b = entries[3] as CustodyEntry;
    entries[2] = b;
    entries[3] = a;
    const res = verifyLedger(entries);
    expect(res.ok).toBe(false);
    const kinds = new Set(res.issues.map((i) => i.kind));
    expect(kinds.has('gap')).toBe(true);
    expect(kinds.has('chain')).toBe(true);
    expect(kinds.has('order') || kinds.has('custodian')).toBe(true);
  });

  it('detects a duplicate collect, a bag before collect, time travel and a wrong custodian in forged chains', () => {
    // Forge a self-consistent chain (valid hashes) with illegal content: only the rules catch it.
    function forge(steps: Omit<CustodyEntry, 'seq' | 'prevHash' | 'hash'>[]): CustodyEntry[] {
      const out: CustodyEntry[] = [];
      let prev = '00000000';
      steps.forEach((s, i) => {
        const body = { ...s, seq: i + 1, prevHash: prev };
        const e = { ...body, hash: entryHash(body) };
        out.push(e);
        prev = e.hash;
      });
      return out;
    }
    const base = { location: 'x', note: 'n', game: 0 };
    const dup = verifyLedger(forge([
      { ...base, itemId: 'E-1-1', action: 'collect', from: 'scene', to: OFFICER, sim: 1 },
      { ...base, itemId: 'E-1-1', action: 'collect', from: 'scene', to: OFFICER, sim: 2 },
    ]));
    expect(dup.issues.map((i) => i.kind)).toEqual(['duplicate']);

    const early = verifyLedger(forge([{ ...base, itemId: 'E-1-1', action: 'bag', from: OFFICER, to: OFFICER, sim: 1 }]));
    expect(early.issues.map((i) => i.kind)).toEqual(['order']);

    const time = verifyLedger(forge([
      { ...base, itemId: 'E-1-1', action: 'collect', from: 'scene', to: OFFICER, sim: 5 },
      { ...base, itemId: 'E-1-1', action: 'bag', from: OFFICER, to: OFFICER, sim: 4 },
    ]));
    expect(time.issues.map((i) => i.kind)).toEqual(['time']);

    const who = verifyLedger(forge([
      { ...base, itemId: 'E-1-1', action: 'collect', from: 'scene', to: OFFICER, sim: 1 },
      { ...base, itemId: 'E-1-1', action: 'bag', from: LOCKER, to: LOCKER, sim: 2 },
    ]));
    expect(who.issues.map((i) => i.kind)).toEqual(['custodian']);

    const after = verifyLedger(forge([
      { ...base, itemId: 'E-1-1', action: 'collect', from: 'scene', to: OFFICER, sim: 1 },
      { ...base, itemId: 'E-1-1', action: 'bag', from: OFFICER, to: OFFICER, sim: 2 },
      { ...base, itemId: 'E-1-1', action: 'tag', from: OFFICER, to: OFFICER, sim: 3 },
      { ...base, itemId: 'E-1-1', action: 'deposit', from: OFFICER, to: 'evidenceRoom', sim: 4 },
      { ...base, itemId: 'E-1-1', action: 'transfer', from: 'evidenceRoom', to: OFFICER, sim: 5 },
    ]));
    expect(after.issues.map((i) => i.kind)).toEqual(['order']);
  });
});
