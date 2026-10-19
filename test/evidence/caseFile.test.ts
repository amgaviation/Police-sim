import { describe, expect, it } from 'vitest';
import { CaseStore, isCaseFile, type CaseFile, type PhotoRecord } from '../../src/evidence/caseFile';

function spec(label = 'knife'): Parameters<CaseStore['addItem']>[1] {
  return {
    item: 'knife', label, x: 1, y: -39, z: 2, buildingId: 3, room: 1, furniture: 4, container: 'drawer',
    concealed: true, ownerPersonId: 12, incriminating: true,
  };
}

function photo(id: string, sim: number, thumb: string | null = 'data:x'): PhotoRecord {
  return {
    id, callId: 1, sim, game: sim, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, buildingId: 1, room: 0, subjects: [], caption: '', thumb,
  };
}

describe('CaseStore', () => {
  it('creates files on demand and fills incident and title once', () => {
    const s = new CaseStore();
    expect(s.get(5)).toBeNull();
    const f = s.file(5, 'burglary', '12 Oak St');
    expect(f).toMatchObject({ callId: 5, incident: 'burglary', title: '12 Oak St', nextItem: 1, nextMarker: 1, nextPhoto: 1, closed: false });
    expect(s.file(5, 'other', 'other')).toBe(f);
    expect(f.incident).toBe('burglary');
    expect(s.get(5)).toBe(f);
    expect(s.files()).toHaveLength(1);
  });

  it('adds items with sequential ids and defaults', () => {
    const s = new CaseStore();
    const a = s.addItem(9, spec('a'));
    const b = s.addItem(9, spec('b'));
    const c = s.addItem(10, spec('c'));
    expect([a.id, b.id, c.id]).toEqual(['E-9-1', 'E-9-2', 'E-10-1']);
    expect(a).toMatchObject({
      callId: 9, state: 'inPlace', plainView: false, foundBasis: null, suppressed: false, markerNo: 0, k9Alert: false,
      container: 'drawer', concealed: true, incriminating: true,
    });
    expect(s.file(9).nextItem).toBe(3);
    expect(s.item('E-9-2')).toBe(b);
    expect(s.item('E-10-1')).toBe(c);
    expect(s.item('E-9-3')).toBeNull();
    expect(s.item('nonsense')).toBeNull();
  });

  it('caps items at 40, dropping the oldest uncollected one, ids never reused', () => {
    const s = new CaseStore();
    const first = s.addItem(1, spec());
    first.state = 'collected';
    for (let i = 0; i < 45; i++) s.addItem(1, spec(`i${i}`));
    const f = s.file(1);
    expect(f.items).toHaveLength(40);
    expect(f.items[0]?.id).toBe('E-1-1'); // collected evidence is kept
    expect(f.items[39]?.id).toBe('E-1-46');
    expect(new Set(f.items.map((i) => i.id)).size).toBe(40);
  });

  it('caps files at 64: oldest closed first, then oldest', () => {
    const s = new CaseStore();
    for (let i = 1; i <= 64; i++) s.file(i);
    s.file(10).closed = true;
    s.file(20).closed = true;
    s.file(100);
    expect(s.files()).toHaveLength(64);
    expect(s.get(10)).toBeNull();
    expect(s.get(20)).not.toBeNull();
    expect(s.get(1)).not.toBeNull();
    s.file(101);
    expect(s.get(20)).toBeNull();
    s.file(102);
    expect(s.get(1)).toBeNull();
    expect(s.get(2)).not.toBeNull();
    expect(s.files()).toHaveLength(64);
  });

  it('trims markers to 99 and photos to 48 per file', () => {
    const s = new CaseStore();
    const f = s.file(1);
    for (let i = 1; i <= 120; i++) f.markers.push({ no: i, callId: 1, x: 0, y: 0, z: 0, buildingId: 1, itemId: null, sim: i });
    for (let i = 1; i <= 60; i++) f.photos.push(photo(`P${i}`, i, null));
    s.trim();
    expect(f.markers).toHaveLength(99);
    expect(f.markers[0]?.no).toBe(22);
    expect(f.photos).toHaveLength(48);
    expect(f.photos[0]?.id).toBe('P13');
  });

  it('keeps thumbnails only for the 32 newest photos overall', () => {
    const s = new CaseStore();
    for (let c = 1; c <= 3; c++) {
      const f = s.file(c);
      for (let i = 0; i < 20; i++) f.photos.push(photo(`C${c}-${i}`, c * 1000 + i));
    }
    const out = s.serialize();
    const photos = out.flatMap((f) => f.photos);
    expect(photos).toHaveLength(60);
    const withThumb = photos.filter((p) => p.thumb !== null);
    expect(withThumb).toHaveLength(32);
    // Newest 32 by sim: all 20 of call 3 and the newest 12 of call 2.
    expect(withThumb.every((p) => p.sim >= 2008)).toBe(true);
    expect(photos.find((p) => p.id === 'C1-19')?.thumb).toBeNull();
  });

  it('round-trips through serialize / restore as an independent copy', () => {
    const s = new CaseStore();
    s.file(1, 'domestic', 'Unit 4');
    const item = s.addItem(1, spec());
    item.state = 'found';
    item.foundBasis = 'consent';
    s.file(1).photos.push(photo('P1', 5));
    s.file(1).consents.push({
      id: 1, personId: 2, kind: 'entry', granted: true, valid: true, authority: true, buildingId: 1, room: 0, vehicleId: -1, sim: 3, revokedSim: -1,
    });
    s.file(2).closed = true;
    const json = JSON.parse(JSON.stringify(s.serialize())) as CaseFile[];
    expect(json.every(isCaseFile)).toBe(true);
    const r = CaseStore.restore(json);
    expect(r.serialize()).toEqual(s.serialize());
    expect(r.item('E-1-1')?.foundBasis).toBe('consent');
    expect(r.addItem(1, spec()).id).toBe('E-1-2');
    // Independence.
    item.label = 'changed';
    expect(r.item('E-1-1')?.label).toBe('knife');
  });
});

describe('isCaseFile', () => {
  const good = new CaseStore().file(1, 'a', 'b');
  it('accepts a real file', () => {
    expect(isCaseFile(good)).toBe(true);
  });
  it('rejects malformed values', () => {
    expect(isCaseFile(null)).toBe(false);
    expect(isCaseFile('x')).toBe(false);
    expect(isCaseFile({})).toBe(false);
    expect(isCaseFile({ ...good, items: 'no' })).toBe(false);
    expect(isCaseFile({ ...good, callId: 'x' })).toBe(false);
    expect(isCaseFile({ ...good, closed: 0 })).toBe(false);
    expect(isCaseFile({ ...good, photos: [{}] })).toBe(false);
    expect(isCaseFile({ ...good, k9: [null] })).toBe(false);
  });
});
