import { describe, expect, it } from 'vitest';
import { formatDistance } from '../../src/ui/hud/format';
import { Hud, hudText } from '../../src/ui/hud/hud';
import {
  MARKER,
  MARKER_RIM,
  MINIMAP_SIZE,
  Minimap,
  createMinimapMarkers,
  markerProjection,
  type MarkerPoint,
} from '../../src/ui/hud/minimap';
import {
  callStripText,
  clampPriority,
  policeStatusText,
  priorityColor,
  PRIORITY_COLORS,
  targetText,
  unitChipText,
  type HudCall,
  type HudPolice,
} from '../../src/ui/hud/police';
import type { City } from '../../src/world/city';
import { snapshot } from './fixtures';

const parent = null as unknown as HTMLElement;

const police = (o: Partial<HudPolice> = {}): HudPolice => ({ lights: false, pattern: 'alt', siren: '', horn: false, spot: false, ...o });
const call = (o: Partial<HudCall> = {}): HudCall => ({
  number: 'C-00042',
  priority: 2,
  nature: 'Noise complaint',
  address: '1200 Maple Avenue, Downtown',
  status: 'En route',
  distanceM: 1234,
  ...o,
});

describe('policeStatusText', () => {
  it('lists the parts that are on, pattern upper-case', () => {
    expect(policeStatusText(police({ lights: true, siren: 'wail', horn: true, spot: true }))).toBe('LIGHTS ALT · SIREN WAIL · HORN · SPOT');
    expect(policeStatusText(police({ lights: true }))).toBe('LIGHTS ALT');
    expect(policeStatusText(police({ siren: 'YELP' }))).toBe('SIREN YELP');
    expect(policeStatusText(police({ spot: true }))).toBe('SPOT');
    expect(policeStatusText(police({ lights: true, pattern: '' }))).toBe('LIGHTS');
  });

  it('is empty when nothing is on or there is no police car', () => {
    expect(policeStatusText(police())).toBe('');
    expect(policeStatusText(null)).toBe('');
    expect(policeStatusText(undefined)).toBe('');
  });
});

describe('unitChipText', () => {
  it('joins callsign and upper-cased status', () => {
    expect(unitChipText({ callsign: '12', status: '10-8 Available', emergency: false, statusCheck: false })).toBe('12 · 10-8 AVAILABLE');
    expect(unitChipText({ callsign: '12', status: '', emergency: false, statusCheck: false })).toBe('12');
    expect(unitChipText(null)).toBe('');
  });
});

describe('formatDistance', () => {
  it('uses metres below 1 km and one decimal km above', () => {
    expect(formatDistance(0)).toBe('0 m');
    expect(formatDistance(850.4)).toBe('850 m');
    expect(formatDistance(999.4)).toBe('999 m');
    expect(formatDistance(999.6)).toBe('1.0 km');
    expect(formatDistance(1234)).toBe('1.2 km');
    expect(formatDistance(-1)).toBe('');
    expect(formatDistance(Number.NaN)).toBe('');
  });
});

describe('callStripText', () => {
  it('builds the three strip lines', () => {
    const t = callStripText(call());
    expect(t.title).toBe('C-00042  P2  Noise complaint');
    expect(t.address).toBe('1200 Maple Avenue, Downtown');
    expect(t.status).toBe('EN ROUTE · 1.2 km');
  });

  it('uses metres below 1 km and drops a missing distance or status', () => {
    expect(callStripText(call({ distanceM: 640 })).status).toBe('EN ROUTE · 640 m');
    expect(callStripText(call({ distanceM: -1 })).status).toBe('EN ROUTE');
    expect(callStripText(call({ status: '', distanceM: 20 })).status).toBe('20 m');
  });

  it('clamps the priority and clears without a call', () => {
    expect(callStripText(call({ priority: 9 })).title).toBe('C-00042  P4  Noise complaint');
    expect(clampPriority(0)).toBe(1);
    expect(clampPriority(Number.NaN)).toBe(4);
    expect(priorityColor(1)).toBe(PRIORITY_COLORS[0]);
    expect(priorityColor(4)).toBe(PRIORITY_COLORS[3]);
    const out = callStripText(call());
    callStripText(null, out);
    expect(out).toEqual({ title: '', address: '', status: '' });
  });
});

describe('targetText', () => {
  it('shows plate and description with the result by severity', () => {
    const t = targetText({ plate: 'ABC 1234', description: '2019 black Sedan', result: 'STOLEN VEHICLE', severity: 'alert' });
    expect(t).toEqual({ show: true, label: 'ABC 1234 · 2019 black Sedan', result: 'STOLEN VEHICLE', severity: 'alert' });
    expect(targetText({ plate: 'ABC 1234', description: '', result: 'NO WANTS', severity: 'clear' }).label).toBe('ABC 1234');
    expect(targetText({ plate: 'X', description: 'd', result: 'EXPIRED REG', severity: 'caution' }).severity).toBe('caution');
  });

  it('hides the result for severity none or an empty result, and everything without a target', () => {
    const none = targetText({ plate: 'ABC 1234', description: 'd', result: 'ignored', severity: 'none' });
    expect([none.show, none.result, none.severity]).toEqual([true, '', 'none']);
    const pending = targetText({ plate: 'ABC 1234', description: 'd', result: '', severity: 'alert' });
    expect([pending.result, pending.severity]).toEqual(['', 'none']);
    expect(targetText(null)).toEqual({ show: false, label: '', result: '', severity: 'none' });
  });
});

describe('hudText Phase 2 fields', () => {
  it('hides every new element when the fields are absent (Phase 1 snapshot)', () => {
    const t = hudText(snapshot());
    expect([t.police, t.unit, t.callTitle, t.callAddress, t.callStatus, t.offer, t.targetLabel, t.targetResult, t.carried]).toEqual([
      '', '', '', '', '', '', '', '', '',
    ]);
    expect([t.targetShow, t.unitEmergency, t.unitStatusCheck]).toEqual([false, false, false]);
    expect(t.targetSeverity).toBe('none');
    expect(t.status).toBe('CHASE');
  });

  it('treats null like absent', () => {
    const t = hudText(snapshot({ police: null, target: null, call: null, unit: null, offer: null }));
    expect([t.police, t.unit, t.callTitle, t.offer, t.targetShow]).toEqual(['', '', '', '', false]);
  });

  it('fills the derived strings and flags', () => {
    const t = hudText(
      snapshot({
        police: police({ lights: true, siren: 'WAIL' }),
        unit: { callsign: '12', status: '10-76 En route', emergency: true, statusCheck: true },
        call: call({ priority: 1 }),
        offer: 'OFFER C-00043 P3 Alarm',
        target: { plate: 'ABC 1234', description: '2019 black Sedan', result: 'NO WANTS', severity: 'clear' },
        carried: 'Flashlight · Cuffs',
      }),
    );
    expect(t.police).toBe('LIGHTS ALT · SIREN WAIL');
    expect(t.unit).toBe('12 · 10-76 EN ROUTE');
    expect([t.unitEmergency, t.unitStatusCheck]).toEqual([true, true]);
    expect(t.callTitle).toBe('C-00042  P1  Noise complaint');
    expect(t.callStatus).toBe('EN ROUTE · 1.2 km');
    expect(t.callPriority).toBe(1);
    expect(t.offer).toBe('OFFER C-00043 P3 Alarm');
    expect([t.targetShow, t.targetLabel, t.targetResult, t.targetSeverity]).toEqual([true, 'ABC 1234 · 2019 black Sedan', 'NO WANTS', 'clear']);
    expect(t.carried).toBe('Flashlight · Cuffs');
  });

  it('shows the police line only while driving; unit, call and target also on foot', () => {
    const t = hudText(
      snapshot({
        mode: 'onFoot',
        police: police({ lights: true }),
        unit: { callsign: '12', status: 'On scene', emergency: false, statusCheck: false },
        call: call(),
        target: { plate: 'ABC 1234', description: '', result: '', severity: 'none' },
      }),
    );
    expect(t.police).toBe('');
    expect(t.unit).toBe('12 · ON SCENE');
    expect(t.callTitle).not.toBe('');
    expect(t.targetShow).toBe(true);
  });

  it('Hud picks the new fields up headless at the throttled rate', () => {
    const hud = new Hud(parent);
    const s = snapshot({ offer: 'OFFER' });
    hud.update(s, 0);
    expect(hud.text.offer).toBe('OFFER');
    s.offer = null;
    hud.update(s, 50);
    expect(hud.text.offer).toBe('OFFER');
    hud.update(s, 100);
    expect(hud.text.offer).toBe('');
  });

  it('stays well inside the 0.3 ms HUD budget', () => {
    const s = snapshot({
      police: police({ lights: true, siren: 'WAIL', horn: true, spot: true }),
      unit: { callsign: '12', status: '10-8 Available', emergency: false, statusCheck: false },
      call: call(),
      offer: 'OFFER',
      target: { plate: 'ABC 1234', description: '2019 black Sedan', result: 'NO WANTS', severity: 'clear' },
      carried: 'Flashlight',
    });
    const hud = new Hud(parent);
    const n = 2000;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) hud.update(s, i * 100);
    const per = (performance.now() - t0) / n;
    expect(hud.renders).toBe(n);
    expect(per).toBeLessThan(0.3);
  });
});

describe('markerProjection', () => {
  const out: MarkerPoint = { x: 0, y: 0, clamped: false };

  it('matches worldToMap inside the rim', () => {
    // Facing north (yaw 0): a point 50 m north is straight up.
    markerProjection(0, 0, 0, 0, -50, 1, MARKER_RIM, out);
    expect(out.x).toBeCloseTo(0);
    expect(out.y).toBeCloseTo(-50);
    expect(out.clamped).toBe(false);
  });

  it('clamps off-map points to the rim, keeping the direction', () => {
    markerProjection(0, 0, 0, 3000, -4000, 1, MARKER_RIM, out);
    expect(out.clamped).toBe(true);
    expect(Math.hypot(out.x, out.y)).toBeCloseTo(MARKER_RIM);
    expect(out.x / out.y).toBeCloseTo(3 / -4);
    expect(MARKER_RIM).toBeLessThan(MINIMAP_SIZE / 2);
  });

  it('respects yaw and never clamps with an infinite rim', () => {
    // Facing west (yaw +pi/2): a point 2 km west is straight up.
    markerProjection(100, 100, Math.PI / 2, -1900, 100, 5, Number.POSITIVE_INFINITY, out);
    expect(out.clamped).toBe(false);
    expect(out.x).toBeCloseTo(0);
    expect(out.y).toBeCloseTo(-400);
  });

  it('handles the player position itself', () => {
    markerProjection(10, 10, 1, 10, 10, 2, MARKER_RIM, out);
    expect([out.x, out.y, out.clamped]).toEqual([0, 0, false]);
  });
});

describe('Minimap markers (headless)', () => {
  const city = { pois: [], graph: null } as unknown as City;

  it('accepts markers and keeps the 10 Hz throttle', () => {
    const map = new Minimap(parent, city);
    const m = createMinimapMarkers(8);
    const kinds = [MARKER.callP1, MARKER.callP4, MARKER.unitAvailable, MARKER.unitBusy, MARKER.unitEmergency, MARKER.stop];
    kinds.forEach((k, i) => {
      m.x[i] = i * 100;
      m.z[i] = -i * 50;
      m.kind[i] = k;
    });
    m.count = kinds.length;
    for (let ms = 0; ms < 1000; ms += 10) map.update(0, 0, 0, null, null, ms, m);
    expect(map.redraws).toBe(10);
    map.update(0, 0, 0, null, null, 2000, null);
    expect(map.redraws).toBe(11);
  });

  it('creates zeroed marker arrays of the requested capacity', () => {
    const m = createMinimapMarkers(5);
    expect([m.count, m.x.length, m.z.length, m.kind.length]).toEqual([0, 5, 5, 5]);
    expect(MARKER).toEqual({ callP1: 1, callP2: 2, callP3: 3, callP4: 4, unitAvailable: 5, unitBusy: 6, unitEmergency: 7, stop: 8 });
  });
});
