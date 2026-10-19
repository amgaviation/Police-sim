import { describe, expect, it } from 'vitest';
import { makeHarness } from './harness';

describe('bodycam', () => {
  it('needs the mount chosen at the locker', () => {
    const h = makeHarness();
    h.world.worn = false;
    h.sys.request({ kind: 'bodycam', on: true });
    h.step();
    expect(h.sys.bodycamOn).toBe(false);
    expect(h.flashes()).toContain('No bodycam mounted.');
    expect(h.of('investigation:bodycam')).toHaveLength(0);
  });

  it('records a segment in the current case file and closes it when switched off', () => {
    const h = makeHarness();
    h.sys.request({ kind: 'bodycam', on: true });
    h.step();
    expect(h.sys.bodycamOn).toBe(true);
    h.run(2);
    h.sys.request({ kind: 'bodycam', on: false });
    h.step();
    const seg = h.sys.store.get(42)?.bodycam[0];
    expect(seg?.start).toBe(0);
    expect(seg?.end).toBeGreaterThan(2);
    expect(h.sys.summary(42).bodycam).toBe(true);
    expect(h.of('investigation:bodycam').map((e) => e.payload['on'])).toEqual([true, false]);
  });

  it('follows the current call: each file gets its own segment', () => {
    const h = makeHarness();
    h.sys.request({ kind: 'bodycam', on: true });
    h.run(1);
    h.world.call = 43;
    h.run(1);
    h.sys.request({ kind: 'bodycam', on: false });
    h.step();
    const a = h.sys.store.get(42)?.bodycam[0];
    const b = h.sys.store.get(43)?.bodycam[0];
    expect(a?.end).toBeGreaterThan(0);
    expect(b?.start).toBeGreaterThanOrEqual(a?.end ?? 0);
    expect(b?.end).toBeGreaterThan(b?.start ?? 0);
  });

  it('turns on by itself when a sidearm or taser is drawn, if a mount is worn', () => {
    const h = makeHarness();
    h.bus.emit('force:used', { kind: 'sidearmDrawn', personId: 7, callId: 42 });
    h.step();
    expect(h.sys.bodycamOn).toBe(true);
    const off = makeHarness();
    off.bus.emit('force:used', { kind: 'cuff', personId: 7, callId: 42 });
    off.step();
    expect(off.sys.bodycamOn).toBe(false);
    const unmounted = makeHarness();
    unmounted.world.worn = false;
    unmounted.bus.emit('force:used', { kind: 'taserDrawn', personId: 7, callId: 42 });
    unmounted.step();
    expect(unmounted.sys.bodycamOn).toBe(false);
    expect(unmounted.flashes()).toHaveLength(0);
  });

  it('stops recording when the mount is removed', () => {
    const h = makeHarness();
    h.sys.request({ kind: 'bodycam', on: true });
    h.step();
    h.world.worn = false;
    h.step();
    expect(h.sys.bodycamOn).toBe(false);
    expect(h.sys.store.get(42)?.bodycam[0]?.end).toBeGreaterThanOrEqual(0);
  });

  it('a HUD case line shows REC while recording', () => {
    const h = makeHarness();
    expect(h.sys.hud()).toContain('C-00042 · items 0/0 · markers 0 · photos 0');
    h.sys.request({ kind: 'bodycam', on: true });
    h.step();
    expect(h.sys.hud()).toMatch(/ · REC$/);
  });

  it('stops listening to force events once disposed', () => {
    const h = makeHarness();
    h.sys.dispose();
    h.bus.emit('force:used', { kind: 'sidearmDrawn', personId: 7, callId: 42 });
    h.step();
    expect(h.sys.bodycamOn).toBe(false);
  });
});
