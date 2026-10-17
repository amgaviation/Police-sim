import { describe, expect, it } from 'vitest';
import {
  compassLabel,
  formatFuel,
  formatGear,
  formatSpeedMph,
  limitSignText,
  roadClassLabel,
  worldToMap,
} from '../../src/ui/hud/format';
import { ROAD_CLASS } from '../../src/world/ids';

describe('HUD formatters', () => {
  it('formats speed as whole mph magnitude', () => {
    expect(formatSpeedMph(44.6)).toBe('45');
    expect(formatSpeedMph(-7.2)).toBe('7');
    expect(formatSpeedMph(0)).toBe('0');
    expect(formatSpeedMph(Number.NaN)).toBe('0');
  });

  it('formats gears', () => {
    expect(formatGear(-1)).toBe('R');
    expect(formatGear(0)).toBe('N');
    expect(formatGear(1)).toBe('1');
    expect(formatGear(6)).toBe('6');
  });

  it('formats fuel as a clamped percentage', () => {
    expect(formatFuel(0.574)).toBe('57%');
    expect(formatFuel(1.2)).toBe('100%');
    expect(formatFuel(-0.1)).toBe('0%');
    expect(formatFuel(Number.NaN)).toBe('0%');
  });

  it('labels road classes', () => {
    expect(roadClassLabel(ROAD_CLASS.highway)).toBe('Highway');
    expect(roadClassLabel(ROAD_CLASS.local)).toBe('Local street');
    expect(roadClassLabel(ROAD_CLASS.service)).toBe('Service road');
    expect(roadClassLabel(42)).toBe('Road');
  });

  it('shows the limit number or a placeholder', () => {
    expect(limitSignText(35)).toBe('35');
    expect(limitSignText(24.6)).toBe('25');
    expect(limitSignText(0)).toBe('--');
    expect(limitSignText(Number.POSITIVE_INFINITY)).toBe('--');
  });
});

describe('compassLabel', () => {
  const q = Math.PI / 4;

  it('maps yaw 0 to north and positive yaw counter-clockwise', () => {
    expect(compassLabel(0)).toBe('N');
    expect(compassLabel(Math.PI / 2)).toBe('W');
    expect(compassLabel(-Math.PI / 2)).toBe('E');
    expect(compassLabel(Math.PI)).toBe('S');
    expect(compassLabel(-Math.PI)).toBe('S');
    expect(compassLabel(-q)).toBe('NE');
    expect(compassLabel(q)).toBe('NW');
    expect(compassLabel(-3 * q)).toBe('SE');
    expect(compassLabel(3 * q)).toBe('SW');
  });

  it('wraps multiple turns and rounds to the nearest point', () => {
    expect(compassLabel(4 * Math.PI)).toBe('N');
    expect(compassLabel(-2 * Math.PI - Math.PI / 2)).toBe('E');
    expect(compassLabel(-0.3)).toBe('N');
    expect(compassLabel(-0.5)).toBe('NE');
  });
});

describe('worldToMap', () => {
  const out = { x: 0, y: 0 };

  it('puts the heading up and east right when facing north', () => {
    worldToMap(100, 50, 0, 100, 40, 1, out);
    expect(out.x).toBeCloseTo(0);
    expect(out.y).toBeCloseTo(-10);
    worldToMap(100, 50, 0, 110, 50, 1, out);
    expect(out.x).toBeCloseTo(10);
    expect(out.y).toBeCloseTo(0);
  });

  it('rotates with the heading (facing west, north is to the right)', () => {
    const west = Math.PI / 2;
    worldToMap(0, 0, west, -10, 0, 1, out);
    expect(out.x).toBeCloseTo(0);
    expect(out.y).toBeCloseTo(-10);
    worldToMap(0, 0, west, 0, -10, 1, out);
    expect(out.x).toBeCloseTo(10);
    expect(out.y).toBeCloseTo(0);
    // Facing east: north is to the left, south to the right.
    worldToMap(0, 0, -west, 0, 10, 1, out);
    expect(out.x).toBeCloseTo(10);
    expect(out.y).toBeCloseTo(0);
  });

  it('scales by metres per pixel and preserves distance', () => {
    worldToMap(5, 5, 0.7, 35, 45, 2.5, out);
    expect(Math.hypot(out.x, out.y)).toBeCloseTo(50 / 2.5);
    worldToMap(0, 0, Math.PI, 0, 20, 4, out);
    expect(out.x).toBeCloseTo(0);
    expect(out.y).toBeCloseTo(-5);
  });

  it('returns the out object', () => {
    expect(worldToMap(0, 0, 0, 1, 1, 1, out)).toBe(out);
  });
});
