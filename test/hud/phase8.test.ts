import { afterEach, describe, expect, it } from 'vitest';
import { setPaletteMode } from '../../src/a11y';
import type { City } from '../../src/world/city';
import { Hud, createHudText } from '../../src/ui/hud/hud';
import { MAX_REMOTE_UNITS, Minimap } from '../../src/ui/hud/minimap';
import {
  WELLBEING_ALERT_FROM, WELLBEING_CHIP_FROM, coopChip, courseLine, shiftLine, vignetteOpacity, wellbeingChip,
} from '../../src/ui/hud/phase8';
import { snapshot } from './fixtures';

const parent = null as unknown as HTMLElement;
const H = 3600;

describe('wellbeingChip', () => {
  it('is null below 0.6 for both values', () => {
    expect(WELLBEING_CHIP_FROM).toBe(0.6);
    expect(wellbeingChip(0.59, 0.59)).toBeNull();
    expect(wellbeingChip(0, 0)).toBeNull();
    expect(wellbeingChip(Number.NaN, -1)).toBeNull();
  });

  it('names the values at or above 0.6', () => {
    expect(wellbeingChip(0.6, 0.1)).toEqual({ text: 'FATIGUE 60 %', severity: 'caution' });
    expect(wellbeingChip(0.1, 0.644)).toEqual({ text: 'STRESS 64 %', severity: 'caution' });
    expect(wellbeingChip(0.72, 0.64)).toEqual({ text: 'FATIGUE 72 % · STRESS 64 %', severity: 'caution' });
  });

  it('is an alert from 0.85', () => {
    expect(WELLBEING_ALERT_FROM).toBe(0.85);
    expect(wellbeingChip(0.85, 0.2)?.severity).toBe('alert');
    expect(wellbeingChip(0.3, 0.97)).toEqual({ text: 'STRESS 97 %', severity: 'alert' });
    expect(wellbeingChip(2, 0)).toEqual({ text: 'FATIGUE 100 %', severity: 'alert' });
  });
});

describe('shiftLine', () => {
  it('shows the shift window during the shift', () => {
    expect(shiftLine(7 * H, 6 * H, 14 * H)).toBe('Shift 06:00-14:00');
    expect(shiftLine(14 * H, 6 * H, 14 * H)).toBe('Shift 06:00-14:00');
    expect(shiftLine(5 * H, 6 * H, 14 * H)).toBe('Shift 06:00-14:00');
  });

  it('wraps the clock across midnight and days', () => {
    expect(shiftLine(23 * H, 22 * H + 5 * 86400, 30 * H + 5 * 86400)).toBe('Shift 22:00-06:00');
  });

  it('counts overtime in whole minutes from the end', () => {
    expect(shiftLine(14 * H + 35 * 60, 6 * H, 14 * H)).toBe('OT +0:35');
    expect(shiftLine(14 * H + 35 * 60 + 59, 6 * H, 14 * H)).toBe('OT +0:35');
    expect(shiftLine(14 * H + 60, 6 * H, 14 * H)).toBe('OT +0:01');
    expect(shiftLine(16 * H + 5 * 60, 6 * H, 14 * H)).toBe('OT +2:05');
  });
});

describe('courseLine', () => {
  it('formats gate, cones and the run time', () => {
    expect(courseLine({ gate: 4, gates: 8, cones: 1, timeS: 42.3 })).toBe('Gate 4/8 · cones 1 · 0:42.3');
    expect(courseLine({ gate: 0, gates: 8, cones: 0, timeS: 0 })).toBe('Gate 0/8 · cones 0 · 0:00.0');
    expect(courseLine({ gate: 8, gates: 8, cones: 3, timeS: 75.96 })).toBe('Gate 8/8 · cones 3 · 1:15.9');
    expect(courseLine({ gate: 1, gates: 2, cones: 0, timeS: 600 })).toBe('Gate 1/2 · cones 0 · 10:00.0');
    expect(courseLine({ gate: 1, gates: 2, cones: 0, timeS: Number.NaN })).toBe('Gate 1/2 · cones 0 · 0:00.0');
  });

  it('is empty without a run', () => {
    expect(courseLine(null)).toBe('');
  });
});

describe('coopChip', () => {
  it('shows the unit and the number online, or offline', () => {
    expect(coopChip({ connected: true, unit: 'N1', members: 3 })).toBe('CO-OP N1 · 3 online');
    expect(coopChip({ connected: false, unit: 'N1', members: 0 })).toBe('CO-OP offline');
    expect(coopChip(null)).toBe('');
  });
});

describe('vignetteOpacity', () => {
  it('rounds to hundredths and clamps', () => {
    expect(vignetteOpacity(0.456)).toBe(0.46);
    expect(vignetteOpacity(-1)).toBe(0);
    expect(vignetteOpacity(7)).toBe(1);
    expect(vignetteOpacity(Number.NaN)).toBe(0);
  });
});

describe('Hud Phase 8 setters (headless text model)', () => {
  it('hides everything by default', () => {
    const hud = new Hud(parent);
    hud.update(snapshot(), 0);
    expect(hud.text).toMatchObject({ careerChip: '', careerShift: '', vignette: 0, courseLine: '', coopChip: '', orderLine: '' });
    expect(createHudText()).toMatchObject({ careerChip: '', careerSeverity: 'clear', vignette: 0 });
  });

  it('shows the wellbeing chip, shift line and vignette from setCareer', () => {
    const hud = new Hud(parent);
    hud.setCareer({ fatigue: 0.9, stress: 0.7, shiftLine: 'OT +0:35', vignette: 0.234 });
    hud.update(snapshot(), 0);
    expect(hud.text.careerChip).toBe('FATIGUE 90 % · STRESS 70 %');
    expect(hud.text.careerSeverity).toBe('alert');
    expect(hud.text.careerShift).toBe('OT +0:35');
    expect(hud.text.vignette).toBe(0.23);
    hud.setCareer({ fatigue: 0.1, stress: 0.1, shiftLine: 'Shift 06:00-14:00', vignette: 0 });
    hud.update(snapshot(), 1000);
    expect(hud.text.careerChip).toBe('');
    expect(hud.text.careerShift).toBe('Shift 06:00-14:00');
    expect(hud.text.vignette).toBe(0);
    hud.setCareer(null);
    hud.update(snapshot(), 2000);
    expect(hud.text.careerShift).toBe('');
  });

  it('shows the course line, co-op chip and order line', () => {
    const hud = new Hud(parent);
    hud.setCourseLine(courseLine({ gate: 2, gates: 8, cones: 0, timeS: 10 }));
    hud.setCoopChip(coopChip({ connected: true, unit: 'N2', members: 2 }));
    hud.setOrderLine('DISPATCH: respond to C-00042');
    hud.update(snapshot(), 0);
    expect(hud.text).toMatchObject({ courseLine: 'Gate 2/8 · cones 0 · 0:10.0', coopChip: 'CO-OP N2 · 2 online', orderLine: 'DISPATCH: respond to C-00042' });
    hud.setCourseLine('');
    hud.update(snapshot(), 1000);
    expect(hud.text.courseLine).toBe('');
  });

  it('applies the setters only at the throttled update rate', () => {
    const hud = new Hud(parent, { updateHz: 10 });
    hud.update(snapshot(), 0);
    hud.setCourseLine('Gate 1/8 · cones 0 · 0:01.0');
    hud.update(snapshot(), 50);
    expect(hud.text.courseLine).toBe('');
    hud.update(snapshot(), 100);
    expect(hud.text.courseLine).toBe('Gate 1/8 · cones 0 · 0:01.0');
    expect(hud.renders).toBe(2);
  });
});

describe('Minimap palette and remote units (headless)', () => {
  afterEach(() => {
    setPaletteMode('none');
  });

  it('repaints at once when the colour-vision palette changes, otherwise stays throttled', () => {
    const map = new Minimap(parent, {} as City);
    map.update(0, 0, 0, null, null, 0);
    expect(map.redraws).toBe(1);
    map.update(0, 0, 0, null, null, 10);
    expect(map.redraws).toBe(1);
    setPaletteMode('deuteranopia');
    map.update(0, 0, 0, null, null, 20);
    expect(map.redraws).toBe(2);
    map.update(0, 0, 0, null, null, 30);
    expect(map.redraws).toBe(2);
    setPaletteMode('deuteranopia'); // same mode: no revision change
    map.update(0, 0, 0, null, null, 40);
    expect(map.redraws).toBe(2);
  });

  it('accepts remote co-op units (capped) and redraws on the next update', () => {
    const map = new Minimap(parent, {} as City);
    map.update(0, 0, 0, null, null, 0);
    const units = Array.from({ length: 12 }, (_, i) => ({ callsign: `N${String(i)}`, x: i, z: -i }));
    map.setRemoteUnits(units);
    expect(MAX_REMOTE_UNITS).toBe(8);
    map.update(0, 0, 0, null, null, 10);
    expect(map.redraws).toBe(2);
    map.setRemoteUnits(null);
    map.update(0, 0, 0, null, null, 20);
    expect(map.redraws).toBe(3);
  });
});
