import { describe, expect, it } from 'vitest';
import { Hud, createHudText, hudText } from '../../src/ui/hud/hud';
import {
  WEAR_LOW_FRACTION,
  altitudeText,
  batteryText,
  fleetChipText,
  gearWarningText,
  oilLowFlag,
  tyresWornFlag,
} from '../../src/ui/hud/phase7';
import { snapshot, telemetry } from './fixtures';

const parent = null as unknown as HTMLElement;

describe('phase 7 text helpers', () => {
  it('raises the wear chips below 25 %', () => {
    expect(WEAR_LOW_FRACTION).toBe(0.25);
    expect(oilLowFlag({ oil: 0.24, tread: 1 })).toBe(true);
    expect(oilLowFlag({ oil: 0.25, tread: 1 })).toBe(false);
    expect(tyresWornFlag({ oil: 1, tread: 0.1 })).toBe(true);
    expect(tyresWornFlag({ oil: 1, tread: 0.3 })).toBe(false);
    expect(oilLowFlag(null)).toBe(false);
    expect(tyresWornFlag(undefined)).toBe(false);
    expect(oilLowFlag({ oil: Number.NaN, tread: 1 })).toBe(true);
  });

  it('formats altitude and battery', () => {
    expect(altitudeText(120)).toBe('ALT 120 m');
    expect(altitudeText(119.6)).toBe('ALT 120 m');
    expect(altitudeText(-3)).toBe('ALT 0 m');
    expect(altitudeText(0)).toBe('ALT 0 m');
    expect(altitudeText(null)).toBe('');
    expect(altitudeText(undefined)).toBe('');
    expect(altitudeText(Number.NaN)).toBe('');
    expect(batteryText(0.64)).toBe('BATT 64 %');
    expect(batteryText(1.4)).toBe('BATT 100 %');
    expect(batteryText(-1)).toBe('BATT 0 %');
    expect(batteryText(null)).toBe('');
  });

  it('passes the fleet chip and the gear warning through', () => {
    expect(fleetChipText('P-101 · damage report due')).toBe('P-101 · damage report due');
    expect(fleetChipText(null)).toBe('');
    expect(gearWarningText('Loadout: overweight 15.2 / 14 kg')).toBe('Loadout: overweight 15.2 / 14 kg');
    expect(gearWarningText(undefined)).toBe('');
  });
});

describe('hudText Phase 7 fields', () => {
  it('hides everything when the optional fields are absent', () => {
    const t = hudText(snapshot());
    expect(t.oilLow).toBe(false);
    expect(t.tyresWorn).toBe(false);
    expect([t.altitude, t.battery, t.fleet, t.gearWarning]).toEqual(['', '', '', '']);
    expect(createHudText()).toMatchObject({ oilLow: false, tyresWorn: false, altitude: '', battery: '', fleet: '', gearWarning: '' });
    expect(t.fuel).toBe('50%');
  });

  it('shows OIL LOW and TYRES WORN while driving', () => {
    const t = hudText(snapshot({ wear: { oil: 0.2, tread: 0.1 } }));
    expect(t.oilLow).toBe(true);
    expect(t.tyresWorn).toBe(true);
    const ok = hudText(snapshot({ wear: { oil: 0.9, tread: 0.8 } }));
    expect([ok.oilLow, ok.tyresWorn]).toEqual([false, false]);
    const walking = hudText(snapshot({ mode: 'onFoot', wear: { oil: 0, tread: 0 } }));
    expect([walking.oilLow, walking.tyresWorn]).toEqual([false, false]);
  });

  it('shows the altitude in the air', () => {
    expect(hudText(snapshot({ altitude: 120 })).altitude).toBe('ALT 120 m');
    expect(hudText(snapshot({ altitude: null })).altitude).toBe('');
    expect(hudText(snapshot({ mode: 'onFoot', altitude: 50 })).altitude).toBe('');
  });

  it('replaces the fuel label with the drone battery and warns when it is low', () => {
    const t = hudText(snapshot({ mode: 'remote', battery: 0.64, telemetry: telemetry({ fuelFraction: 1 }) }));
    expect(t.driving).toBe(true);
    expect(t.battery).toBe('BATT 64 %');
    expect(t.fuel).toBe('64%');
    expect(t.fuelLow).toBe(false);
    const low = hudText(snapshot({ mode: 'remote', battery: 0.1 }));
    expect(low.battery).toBe('BATT 10 %');
    expect(low.fuelLow).toBe(true);
    // Without a battery the gauge shows the fuel as before.
    const fuel = hudText(snapshot({ mode: 'remote' }));
    expect(fuel.battery).toBe('');
    expect(fuel.fuel).toBe('50%');
    // A battery on foot has no gauge to replace.
    expect(hudText(snapshot({ mode: 'onFoot', battery: 0.5 })).battery).toBe('');
  });

  it('shows the speed panel for the drone but not on foot', () => {
    expect(hudText(snapshot({ mode: 'remote' })).driving).toBe(true);
    expect(hudText(snapshot({ mode: 'onFoot' })).driving).toBe(false);
  });

  it('copies the fleet chip and gear warning whatever the mode', () => {
    const t = hudText(snapshot({ mode: 'onFoot', fleet: 'P-101 · damage report due', gearWarning: 'Loadout: overweight 15.2 / 14 kg' }));
    expect(t.fleet).toBe('P-101 · damage report due');
    expect(t.gearWarning).toBe('Loadout: overweight 15.2 / 14 kg');
  });

  it('reuses the output object', () => {
    const out = createHudText();
    out.fleet = 'stale';
    expect(hudText(snapshot(), out)).toBe(out);
    expect(out.fleet).toBe('');
  });
});

describe('Hud (headless) Phase 7', () => {
  it('writes the model at the throttled rate and keeps unchanged fields', () => {
    const hud = new Hud(parent, { updateHz: 10 });
    hud.update(snapshot({ wear: { oil: 0.1, tread: 1 }, fleet: 'P-101' }), 0);
    expect(hud.renders).toBe(1);
    expect(hud.text.oilLow).toBe(true);
    expect(hud.text.fleet).toBe('P-101');
    hud.update(snapshot({ wear: { oil: 1, tread: 1 }, fleet: 'P-102' }), 50);
    expect(hud.renders).toBe(1);
    expect(hud.text.fleet).toBe('P-101');
    hud.update(snapshot({ wear: { oil: 1, tread: 1 }, fleet: 'P-102', altitude: 80, gearWarning: 'x' }), 100);
    expect(hud.renders).toBe(2);
    expect(hud.text).toMatchObject({ oilLow: false, fleet: 'P-102', altitude: 'ALT 80 m', gearWarning: 'x' });
  });

  it('drone mode through the Hud', () => {
    const hud = new Hud(parent);
    hud.update(snapshot({ mode: 'remote', battery: 0.64 }), 0);
    expect(hud.text.battery).toBe('BATT 64 %');
  });
});
