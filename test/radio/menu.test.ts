import { describe, expect, it } from 'vitest';
import { RadioMenu, type MenuContext } from '../../src/radio/menu';

const BASE: MenuContext = { mode: 'tenCode', hasTarget: false, hasStop: false, pendingOffer: false, onCall: false, emergency: false };

function labels(menu: RadioMenu, ctx: MenuContext): string[] {
  return menu.view(ctx).options.map((o) => `${o.key} ${o.label}${o.enabled ? '' : ' (off)'}`);
}

describe('RadioMenu', () => {
  it('main menu labels in ten-code mode', () => {
    const m = new RadioMenu();
    m.open();
    expect(m.view(BASE).title).toBe('Radio');
    expect(labels(m, BASE)).toEqual([
      '1 Status ▸',
      '2 Run plate (10-28) (off)',
      '3 Location (10-20)',
      '4 Backup ▸',
      '5 Code 4',
      '6 Traffic stop (10-38) (off)',
      '7 Accept offered call (off)',
      '8 Decline offered call (off)',
      '9 Say again (10-9)',
    ]);
  });

  it('main menu labels in plain mode', () => {
    const m = new RadioMenu();
    m.open();
    const ctx: MenuContext = { ...BASE, mode: 'plain', hasTarget: true, hasStop: true, pendingOffer: true };
    expect(labels(m, ctx)).toEqual([
      '1 Status ▸',
      '2 Run plate',
      '3 Location',
      '4 Backup ▸',
      '5 All OK',
      '6 Traffic stop',
      '7 Accept offered call',
      '8 Decline offered call',
      '9 Say again',
    ]);
  });

  it('status submenu with disabled options off a call', () => {
    const m = new RadioMenu();
    m.open();
    expect(m.press(1, BASE)).toBeNull();
    expect(m.level).toBe('status');
    expect(m.view(BASE).title).toBe('Status');
    expect(labels(m, BASE)).toEqual([
      '1 In service (10-8)',
      '2 En route (10-76) (off)',
      '3 On scene (10-23) (off)',
      '4 Busy (10-6)',
      '5 Out of service (10-7)',
      '6 Transporting (10-15) (off)',
    ]);
    const onCall = { ...BASE, mode: 'plain' as const, onCall: true };
    expect(labels(m, onCall)).toEqual(['1 In service', '2 En route', '3 On scene', '4 Busy', '5 Out of service (off)', '6 Transporting']);
  });

  it('status press returns the request and closes', () => {
    const m = new RadioMenu();
    m.open();
    m.press(1, BASE);
    expect(m.press(3, BASE)).toBeNull(); // on scene disabled off a call
    expect(m.isOpen).toBe(true);
    expect(m.press(1, BASE)).toEqual({ kind: 'status', status: 'available' });
    expect(m.isOpen).toBe(false);
    m.open();
    m.press(1, BASE);
    expect(m.press(3, { ...BASE, onCall: true })).toEqual({ kind: 'status', status: 'onScene' });
  });

  it('backup submenu', () => {
    const m = new RadioMenu();
    m.open();
    m.press(4, BASE);
    expect(m.view(BASE).title).toBe('Backup');
    expect(labels(m, BASE)).toEqual(['1 Code 2', '2 Code 3']);
    expect(labels(m, { ...BASE, mode: 'plain' })).toEqual(['1 Non-emergency', '2 Emergency']);
    expect(m.press(2, BASE)).toEqual({ kind: 'backup', code: 3 });
    expect(m.isOpen).toBe(false);
    m.open();
    m.press(4, BASE);
    expect(m.press(1, BASE)).toEqual({ kind: 'backup', code: 2 });
  });

  it('main menu requests', () => {
    const m = new RadioMenu();
    const ctx: MenuContext = { ...BASE, hasTarget: true, hasStop: true, pendingOffer: true, offerCallId: 7 };
    const press = (k: number, c: MenuContext = ctx) => {
      m.open();
      return m.press(k, c);
    };
    expect(press(2)).toEqual({ kind: 'runPlate', plate: '', vehicleId: -1 });
    expect(press(3)).toEqual({ kind: 'location' });
    expect(press(5)).toEqual({ kind: 'code4' });
    expect(press(6)).toEqual({ kind: 'trafficStop' });
    expect(press(7)).toEqual({ kind: 'acceptCall', callId: 7 });
    expect(press(8)).toEqual({ kind: 'declineCall', callId: 7 });
    expect(press(9)).toEqual({ kind: 'repeat' });
    expect(press(7, { ...ctx, offerCallId: undefined })).toEqual({ kind: 'status', status: 'enRoute' });
    // disabled
    expect(press(2, BASE)).toBeNull();
    expect(press(6, BASE)).toBeNull();
    expect(press(7, BASE)).toBeNull();
  });

  it('back, close and presses while closed', () => {
    const m = new RadioMenu();
    expect(m.press(3, BASE)).toBeNull();
    m.open();
    m.press(1, BASE);
    m.back();
    expect(m.level).toBe('root');
    expect(m.isOpen).toBe(true);
    m.back();
    expect(m.isOpen).toBe(false);
    m.open();
    m.press(4, BASE);
    m.close();
    m.open();
    expect(m.level).toBe('root');
  });

  it('caches views (no allocation when reading every frame)', () => {
    const m = new RadioMenu();
    m.open();
    expect(m.view(BASE)).toBe(m.view({ ...BASE }));
    expect(m.view(BASE)).not.toBe(m.view({ ...BASE, hasTarget: true }));
  });
});
