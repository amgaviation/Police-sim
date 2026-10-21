import { afterEach, describe, expect, it } from 'vitest';
import { PALETTES, setPaletteMode } from '../../src/a11y';
import { CadState } from '../../src/cad/cadState';
import { priorityColor, unitStatusColor } from '../../src/ui/mdt/map';
import { clampView, fitScale, MAP_MAX_SCALE, mapToWorld, pickCall, worldToMap, zoomView, panView, type MapView } from '../../src/ui/mdt';
import { WORLD_HALF_SIZE } from '../../src/world/constants';
import { addCall, addRoster, at, location } from './helpers';

function view(): MapView {
  return { cx: 120, cz: -340, scale: 0.75, width: 1600, height: 900 };
}

describe('worldToMap / mapToWorld', () => {
  it('are inverse and put north up', () => {
    const v = view();
    const p = { x: 0, y: 0 };
    const w = { x: 0, z: 0 };
    for (const [x, z] of [[0, 0], [120, -340], [-3000, 2500], [3584, -3584], [17.25, 4.5]] as const) {
      worldToMap(v, x, z, p);
      mapToWorld(v, p.x, p.y, w);
      expect(w.x).toBeCloseTo(x, 9);
      expect(w.z).toBeCloseTo(z, 9);
    }
    expect(worldToMap(v, v.cx, v.cz, p)).toEqual({ x: 800, y: 450 });
    // North (-Z) is up the screen, east (+X) to the right.
    expect(worldToMap(v, v.cx, v.cz - 100, p).y).toBeCloseTo(450 - 75);
    expect(worldToMap(v, v.cx + 100, v.cz, p).x).toBeCloseTo(800 + 75);
  });

  it('zooms around the cursor and clamps scale and centre', () => {
    const v = view();
    const before = mapToWorld(v, 300, 200, { x: 0, z: 0 });
    zoomView(v, 2, 300, 200);
    expect(v.scale).toBeCloseTo(1.5);
    const after = mapToWorld(v, 300, 200, { x: 0, z: 0 });
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.z).toBeCloseTo(before.z, 6);
    zoomView(v, 1000, 800, 450);
    expect(v.scale).toBe(MAP_MAX_SCALE);
    zoomView(v, 1e-6, 800, 450);
    expect(v.scale).toBeCloseTo(fitScale(1600, 900));
    panView(v, -1e7, 1e7);
    expect(v.cx).toBe(WORLD_HALF_SIZE);
    expect(v.cz).toBe(-WORLD_HALF_SIZE);
    const bad = clampView({ cx: Number.NaN, cz: 0, scale: Number.NaN, width: 100, height: 100 });
    expect(bad.cx).toBe(0);
    expect(bad.scale).toBeCloseTo(fitScale(100, 100));
  });
});

describe('pickCall', () => {
  it('selects the nearest open call within 12 px', () => {
    const cad = new CadState();
    addRoster(cad);
    const a = cad.createCall({ typeId: 'alarm', priority: 2, location: location('A', 0, 0), caller: { kind: 'alarm', name: '', phone: '', personId: -1 }, narrative: 'a' }, at(0));
    const b = cad.createCall({ typeId: 'alarm', priority: 2, location: location('B', 20, 0), caller: { kind: 'alarm', name: '', phone: '', personId: -1 }, narrative: 'b' }, at(0));
    const closed = addCall(cad, 0, 1);
    cad.closeCall(closed.id, 'handled', at(1));
    const v: MapView = { cx: 0, cz: 0, scale: 1, width: 200, height: 200 };
    expect(pickCall(v, cad.calls(), 100, 100)).toBe(a.id);
    expect(pickCall(v, cad.calls(), 115, 100)).toBe(b.id);
    expect(pickCall(v, cad.calls(), 100, 113)).toBeNull();
    // The closed call sits at (0, -100) and is never picked.
    expect(pickCall(v, cad.calls(), 100, 0)).toBeNull();
  });
});

describe('palette-driven marker colours', () => {
  afterEach(() => {
    setPaletteMode('none');
  });

  it('take the call priority and unit status colours from the active colour-vision palette', () => {
    expect(priorityColor(1)).toBe(PALETTES.none.colors.p1);
    expect(priorityColor(4)).toBe(PALETTES.none.colors.p4);
    expect(priorityColor(9)).toBe(PALETTES.none.colors.p4);
    expect(unitStatusColor('available')).toBe(PALETTES.none.colors.ok);
    expect(unitStatusColor('busy')).toBe(PALETTES.none.colors.unitBusy);
    expect(unitStatusColor('outOfService')).toBe('#8e8e93');
    setPaletteMode('tritanopia');
    expect(priorityColor(1)).toBe(PALETTES.tritanopia.colors.p1);
    expect(unitStatusColor('enRoute')).toBe(PALETTES.tritanopia.colors.caution);
    setPaletteMode('protanopia');
    expect(unitStatusColor('available')).toBe(PALETTES.protanopia.colors.ok);
  });
});
