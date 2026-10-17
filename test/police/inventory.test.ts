import { describe, expect, it } from 'vitest';
import { OfficerKit } from '../../src/police/inventory';

describe('OfficerKit.consume', () => {
  it('uses up carried items and refuses more than carried', () => {
    const kit = new OfficerKit();
    expect(kit.adjust('flares', 3)).toBe(true);
    expect(kit.consume('flares')).toBe(true);
    expect(kit.carried('flares')).toBe(2);
    expect(kit.consume('flares', 2)).toBe(true);
    expect(kit.carried('flares')).toBe(0);
    expect(kit.consume('flares')).toBe(false);
    expect(kit.carried('flares')).toBe(0);
  });

  it('rejects an unknown item and a non-positive or fractional count', () => {
    const kit = new OfficerKit();
    kit.adjust('cones', 2);
    expect(kit.consume('nonsense')).toBe(false);
    expect(kit.consume('cones', 0)).toBe(false);
    expect(kit.consume('cones', -1)).toBe(false);
    expect(kit.consume('cones', 1.5)).toBe(false);
    expect(kit.carried('cones')).toBe(2);
  });
});
