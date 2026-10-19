import { describe, expect, it } from 'vitest';
import { unitHash } from '../../src/records/hash';
import { SEED, makeHarness, standAt, type Harness } from './harness';

const PRINT_SALT = 0x9f31;

/** A glass or metal surface (good prints) and a call id for which it surely carries a print (hash below 0.15). */
function printScene(wantPrint: boolean): { h: Harness; furn: number; callId: number } {
  const h = makeHarness();
  const f = h.layout.furniture.find((x) => x.surface === 'glass' || x.surface === 'metal');
  if (!f) throw new Error('no glass or metal surface');
  let callId = -1;
  for (let c = 1; c < 400 && callId < 0; c++) {
    const u = unitHash(SEED, PRINT_SALT, c * 4099 + h.layout.buildingId * 64 + f.index);
    // Neither suspect rooms (0.6) nor others (0.15) apply across the band [0.15, 0.6): pick clear cases.
    if (wantPrint ? u < 0.15 : u > 0.6) callId = c;
  }
  if (callId < 0) throw new Error('no call id');
  h.world.call = callId;
  standAt(h, f);
  return { h, furn: f.index, callId };
}

/** Brushes every cell to exactly full coverage (two 0.25 s strokes) in a serpentine walk. */
function brushAll(h: Harness): void {
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      h.sys.request({ kind: 'dustBrush', seconds: 0.25 });
      h.sys.request({ kind: 'dustBrush', seconds: 0.25 });
      if (col < 3) h.sys.request({ kind: 'dustMove', dir: row % 2 === 0 ? 'right' : 'left' });
    }
    if (row < 3) h.sys.request({ kind: 'dustMove', dir: 'down' });
  }
  h.step();
}

describe('fingerprint dusting', () => {
  it('needs the fingerprint kit and a printable surface in reach', () => {
    const { h, furn } = printScene(true);
    h.world.kit['fingerprintKit'] = 0;
    h.sys.request({ kind: 'dustStart', buildingId: h.layout.buildingId, furniture: furn });
    h.step();
    expect(h.sys.dust).toBeNull();
    expect(h.flashes()).toContain('No fingerprint kit.');
    h.world.kit['fingerprintKit'] = 1;
    h.off.x += 8;
    h.sys.request({ kind: 'dustStart', buildingId: h.layout.buildingId, furniture: furn });
    h.step();
    expect(h.sys.dust).toBeNull();
    const bare = h.layout.furniture.find((f) => f.surface === null);
    if (!bare) throw new Error('no bare furniture');
    standAt(h, bare);
    h.sys.request({ kind: 'dustStart', buildingId: h.layout.buildingId, furniture: bare.index });
    h.step();
    expect(h.sys.dust).toBeNull();
    expect(h.flashes()).toContain('Nothing to dust there.');
  });

  it('a full, clean lift of a surface with a print creates a latent print item', () => {
    const { h, furn, callId } = printScene(true);
    h.world.calls.set(callId, {
      exigency: true, warrant: false, arrests: [], buildingId: h.layout.buildingId, family: 'property',
      suspectPersonId: 7, anchorX: 100, anchorZ: -200,
    });
    h.sys.request({ kind: 'dustStart', buildingId: h.layout.buildingId, furniture: furn });
    h.step();
    const view = h.sys.dust;
    expect(view).not.toBeNull();
    expect(view?.quality).toBe(0);
    brushAll(h);
    expect(h.sys.dust?.quality).toBeGreaterThan(0.35);
    expect(h.sys.dust?.overbrush).toBe(0);
    h.sys.request({ kind: 'dustLift' });
    h.step();
    expect(h.sys.dust).toBeNull();
    const file = h.sys.store.get(callId);
    const print = file?.prints[0];
    expect(print?.personId).toBe(7);
    expect(print?.quality).toBeGreaterThanOrEqual(0.35);
    const item = file?.items.find((i) => i.item === 'latentPrint');
    expect(item?.label).toBe('Latent print');
    expect(item?.state).toBe('found');
    expect(item?.foundBasis).toBe('exigency');
    expect(item?.suppressed).toBe(false);
    expect(print?.itemId).toBe(item?.id);
    const ev = h.of('investigation:print');
    expect(ev[0]?.payload).toMatchObject({ usable: true, itemId: item?.id });
  });

  it('a lift where the officer has no lawful presence is found without a basis (suppressed)', () => {
    const { h, furn, callId } = printScene(true);
    h.sys.request({ kind: 'dustStart', buildingId: h.layout.buildingId, furniture: furn });
    h.step();
    brushAll(h);
    h.sys.request({ kind: 'dustLift' });
    h.step();
    const item = h.sys.store.get(callId)?.items.find((i) => i.item === 'latentPrint');
    expect(item?.foundBasis).toBeNull();
    expect(item?.suppressed).toBe(true);
  });

  it('an unbrushed lift gives nothing usable', () => {
    const { h, furn, callId } = printScene(true);
    h.sys.request({ kind: 'dustStart', buildingId: h.layout.buildingId, furniture: furn });
    h.step();
    h.sys.request({ kind: 'dustLift' });
    h.step();
    expect(h.sys.store.get(callId)?.prints ?? []).toHaveLength(0);
    expect(h.sys.store.get(callId)?.items.some((i) => i.item === 'latentPrint')).toBe(false);
    expect(h.flashes().some((f) => f.startsWith('No usable print lifted'))).toBe(true);
    expect(h.of('investigation:print')[0]?.payload).toMatchObject({ usable: false, itemId: null });
  });

  it('a surface without a print never lifts one, however well it is dusted', () => {
    const { h, furn, callId } = printScene(false);
    h.world.calls.set(callId, {
      exigency: false, warrant: false, arrests: [], buildingId: -1, family: 'property',
      suspectPersonId: 7, anchorX: 100, anchorZ: -200,
    });
    h.sys.request({ kind: 'dustStart', buildingId: h.layout.buildingId, furniture: furn });
    h.step();
    brushAll(h);
    h.sys.request({ kind: 'dustLift' });
    h.step();
    expect(h.sys.store.get(callId)?.prints ?? []).toHaveLength(0);
  });

  it('over-brushing lowers the quality shown', () => {
    const { h, furn } = printScene(true);
    h.sys.request({ kind: 'dustStart', buildingId: h.layout.buildingId, furniture: furn });
    h.step();
    for (let i = 0; i < 6; i++) h.sys.request({ kind: 'dustBrush', seconds: 0.25 });
    h.step();
    expect(h.sys.dust?.overbrush).toBeGreaterThan(0);
    expect(h.sys.dust?.coverage[0]).toBeCloseTo(1.5, 6);
  });

  it('cancel and stepping away end the session without a print', () => {
    const { h, furn } = printScene(true);
    h.sys.request({ kind: 'dustStart', buildingId: h.layout.buildingId, furniture: furn });
    h.step();
    expect(h.sys.dust).not.toBeNull();
    h.sys.request({ kind: 'dustCancel' });
    h.step();
    expect(h.sys.dust).toBeNull();
    h.sys.request({ kind: 'dustStart', buildingId: h.layout.buildingId, furniture: furn });
    h.step();
    h.off.x += 9;
    h.step();
    expect(h.sys.dust).toBeNull();
    expect(h.flashes()).toContain('Stopped dusting: you stepped away.');
  });

  it('refuses to dust a surface again once its print was lifted', () => {
    const { h, furn, callId } = printScene(true);
    h.sys.request({ kind: 'dustStart', buildingId: h.layout.buildingId, furniture: furn });
    h.step();
    brushAll(h);
    h.sys.request({ kind: 'dustLift' });
    h.step();
    expect(h.sys.store.get(callId)?.prints).toHaveLength(1);
    h.sys.request({ kind: 'dustStart', buildingId: h.layout.buildingId, furniture: furn });
    h.step();
    expect(h.sys.dust).toBeNull();
    expect(h.flashes()).toContain('A print was already lifted here.');
  });

  it('the print draw is deterministic per call and surface', () => {
    const a = printScene(true);
    const b = printScene(true);
    for (const s of [a, b]) {
      s.h.sys.request({ kind: 'dustStart', buildingId: s.h.layout.buildingId, furniture: s.furn });
      s.h.step();
      brushAll(s.h);
    }
    expect(a.h.sys.dust?.quality).toBe(b.h.sys.dust?.quality);
  });
});
