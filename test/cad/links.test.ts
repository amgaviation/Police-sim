import { describe, expect, it } from 'vitest';
import { CadState, isCadSave, type CadSave } from '../../src/cad/cadState';
import { CALL_TYPES, DISPOSITIONS, STATUTES, TEN_CODES, dispositionLabel, findCallType, statute } from '../../src/cad/data';
import type { UnitRequest } from '../../src/cad/types';
import { at, newCall, recordingCad } from './helpers';

describe('CadState.linkCalls', () => {
  it('links two calls symmetrically with a narrative line on each and callUpdated events', () => {
    const { cad, events } = recordingCad();
    const a = cad.createCall(newCall(), at(1));
    const b = cad.createCall(newCall('alarm', 2), at(2));
    expect(a.links).toEqual([]);
    events.length = 0;
    const rev = cad.revision;
    expect(cad.linkCalls(a.id, b.id, at(5))).toBe(true);
    expect(a.links).toEqual([b.id]);
    expect(b.links).toEqual([a.id]);
    expect(a.narrative.at(-1)).toMatchObject({ source: 'CAD', text: 'Linked to C-00002', sim: 5 });
    expect(b.narrative.at(-1)).toMatchObject({ source: 'CAD', text: 'Linked to C-00001', sim: 5 });
    expect(events).toEqual([
      { topic: 'cad:callUpdated', payload: { callId: a.id, change: 'links' } },
      { topic: 'cad:callUpdated', payload: { callId: b.id, change: 'links' } },
    ]);
    expect(cad.revision).toBeGreaterThan(rev);
  });

  it('ignores duplicates, the same call and unknown ids', () => {
    const { cad, events } = recordingCad();
    const a = cad.createCall(newCall(), at(1));
    const b = cad.createCall(newCall(), at(2));
    const c = cad.createCall(newCall(), at(3));
    cad.linkCalls(a.id, b.id, at(4));
    events.length = 0;
    expect(cad.linkCalls(a.id, b.id, at(5))).toBe(false);
    expect(cad.linkCalls(b.id, a.id, at(5))).toBe(false);
    expect(cad.linkCalls(a.id, a.id, at(5))).toBe(false);
    expect(cad.linkCalls(a.id, 99, at(5))).toBe(false);
    expect(cad.linkCalls(99, a.id, at(5))).toBe(false);
    expect(events).toEqual([]);
    expect(a.links).toEqual([b.id]);
    expect(a.narrative.filter((n) => n.text.startsWith('Linked')).length).toBe(1);
    cad.linkCalls(a.id, c.id, at(6));
    expect(a.links).toEqual([b.id, c.id]);
    expect(c.links).toEqual([a.id]);
  });

  it('links closed calls too and saves the links', () => {
    const { cad } = recordingCad();
    const a = cad.createCall(newCall(), at(1));
    const b = cad.createCall(newCall(), at(2));
    cad.closeCall(b.id, 'duplicate', at(3));
    expect(cad.linkCalls(a.id, b.id, at(4))).toBe(true);
    const save = JSON.parse(JSON.stringify(cad.serialize())) as CadSave;
    expect(isCadSave(save)).toBe(true);
    expect(save.calls.map((c) => c.links)).toEqual([[b.id], [a.id]]);
    const restored = new CadState();
    restored.restore(save);
    expect(restored.call(a.id)?.links).toEqual([b.id]);
    expect(restored.serialize()).toEqual(save);
  });
});

describe('CAD save without links (before Phase 3)', () => {
  it('accepts calls without links and restores them with an empty list', () => {
    const { cad } = recordingCad();
    cad.createCall(newCall(), at(1));
    cad.createCall(newCall(), at(2));
    const old = JSON.parse(JSON.stringify(cad.serialize())) as { calls: Record<string, unknown>[] };
    for (const c of old.calls) delete c.links;
    expect(isCadSave(old)).toBe(true);
    const restored = new CadState();
    restored.restore(old as unknown as CadSave);
    expect(restored.calls().map((c) => c.links)).toEqual([[], []]);
    expect(restored.serialize().calls.every((c) => Array.isArray(c.links))).toBe(true);
    // And they can be linked afterwards.
    expect(restored.linkCalls(1, 2, at(3))).toBe(true);
  });

  it('rejects malformed links', () => {
    const { cad } = recordingCad();
    cad.createCall(newCall(), at(1));
    const bad = JSON.parse(JSON.stringify(cad.serialize())) as { calls: Record<string, unknown>[] };
    bad.calls[0]!.links = ['x'];
    expect(isCadSave(bad)).toBe(false);
    bad.calls[0]!.links = 'none';
    expect(isCadSave(bad)).toBe(false);
  });
});

describe('Phase 3 CAD data additions', () => {
  it('has the transported and duplicate dispositions', () => {
    expect(DISPOSITIONS.map((d) => d.id)).toEqual(expect.arrayContaining(['transported', 'duplicate']));
    expect(dispositionLabel('transported')).toBe('Transported to hospital');
    expect(dispositionLabel('duplicate')).toBe('Duplicate call');
  });

  it('has every listed statute with its class, fine and flags', () => {
    const expected: [string, string, string, number, boolean, boolean][] = [
      ['TR-361', 'infraction', 'traffic', 200, true, false],
      ['TR-371', 'misdemeanor', 'traffic', 500, true, true],
      ['TR-380', 'felony', 'traffic', 0, false, true],
      ['TR-390', 'infraction', 'traffic', 60, true, false],
      ['TR-391', 'infraction', 'traffic', 150, true, false],
      ['TR-392', 'infraction', 'traffic', 350, true, false],
      ['PC-221', 'misdemeanor', 'criminal', 0, false, true],
      ['PC-231', 'misdemeanor', 'criminal', 0, false, true],
      ['PC-251', 'felony', 'criminal', 0, false, true],
      ['PC-252', 'felony', 'criminal', 0, false, true],
      ['PC-253', 'misdemeanor', 'criminal', 250, true, true],
      ['PC-254', 'misdemeanor', 'criminal', 150, true, true],
      ['PC-255', 'felony', 'criminal', 0, false, true],
      ['PC-260', 'felony', 'criminal', 0, false, true],
      ['PC-261', 'misdemeanor', 'criminal', 100, true, true],
      ['PC-262', 'felony', 'criminal', 0, false, true],
      ['PC-263', 'misdemeanor', 'criminal', 0, false, true],
      ['PC-270', 'misdemeanor', 'criminal', 0, false, true],
      ['PC-271', 'misdemeanor', 'criminal', 0, false, true],
      ['PC-272', 'misdemeanor', 'criminal', 0, false, true],
      ['PC-273', 'misdemeanor', 'criminal', 0, false, true],
      ['PC-274', 'felony', 'criminal', 0, false, true],
      ['PC-280', 'misdemeanor', 'criminal', 200, true, true],
      ['PC-281', 'misdemeanor', 'criminal', 100, true, true],
      ['PC-282', 'felony', 'criminal', 0, false, true],
      ['PC-283', 'felony', 'criminal', 0, false, true],
      ['PC-284', 'misdemeanor', 'criminal', 250, true, true],
      ['PC-290', 'infraction', 'criminal', 100, true, false],
      ['PC-291', 'misdemeanor', 'criminal', 250, true, true],
    ];
    expect(expected).toHaveLength(29);
    for (const [id, cls, category, fine, citeable, bookable] of expected) {
      expect(statute(id), id).toMatchObject({ cls, category, fine, citeable, bookable });
    }
    expect(STATUTES).toHaveLength(18 + 29);
    // Phase 2 statutes are untouched.
    expect(statute('TR-301')).toMatchObject({ speed: true, fine: 150 });
    expect(statute('PC-220').cls).toBe('warrant');
  });

  it('has the new ten-codes and keeps the old keys', () => {
    expect(TEN_CODES.codes.pursuit).toEqual({ code: '10-80', plain: 'pursuit' });
    expect(TEN_CODES.codes.shotsFired).toEqual({ code: '10-71', plain: 'shots fired' });
    expect(TEN_CODES.codes.ems).toEqual({ code: '10-52', plain: 'ambulance' });
    expect(TEN_CODES.codes.custody).toEqual({ code: '10-15', plain: 'subject in custody' });
    expect(TEN_CODES.codes.ack).toEqual({ code: '10-4', plain: 'copy' });
    expect(TEN_CODES.statusKeys.transporting).toBe('transporting');
  });

  it('exposes catalog types through the CAD tables', () => {
    expect(findCallType('domesticDisturbance')?.category).toBe('domestic');
    expect(findCallType('robbery')?.priority).toEqual([0.5, 0.5, 0, 0]);
    expect(findCallType('activeAssailant')?.priority).toEqual([1, 0, 0, 0]);
    expect(CALL_TYPES.filter((t) => t.generated)).not.toHaveLength(0);
  });

  it('keeps the stopContact request open to a claimed person id', () => {
    const plain: UnitRequest = { kind: 'stopContact', action: 'license' };
    const claimed: UnitRequest = { kind: 'stopContact', action: 'license', personId: 1234 };
    expect(plain.kind).toBe('stopContact');
    expect(claimed.kind === 'stopContact' && claimed.personId).toBe(1234);
  });
});
