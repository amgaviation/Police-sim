import { describe, expect, it } from 'vitest';
import { FadeOverlay } from '../../src/ui/hud/fade';
import { Hud, createHudText, hudText } from '../../src/ui/hud/hud';
import { MINIMAP_SIZE, Minimap, fitFloorPlan, type PlanFit } from '../../src/ui/hud/minimap';
import {
  NOISE_STEPS,
  bodycamChipText,
  locationChipText,
  noiseMeterText,
  noiseSteps,
  tacticalChipsText,
  visibilityText,
} from '../../src/ui/hud/tactical';
import type { FloorPlan, HudTactical } from '../../src/ui/hud/types';
import type { City } from '../../src/world/city';
import { snapshot } from './fixtures';

const parent = null as unknown as HTMLElement;
const tac = (over: Partial<HudTactical> = {}): HudTactical => ({
  crouched: false,
  lean: 0,
  flashlight: false,
  noise: 0,
  visibility: 0.5,
  slicing: false,
  ...over,
});

describe('tactical text helpers', () => {
  it('lists only the active stance chips', () => {
    expect(tacticalChipsText(tac())).toBe('');
    expect(tacticalChipsText(tac({ crouched: true }))).toBe('CROUCH');
    expect(tacticalChipsText(tac({ crouched: true, lean: -1, flashlight: true }))).toBe('CROUCH · LEAN L · LIGHT');
    expect(tacticalChipsText(tac({ lean: 1, slicing: true }))).toBe('LEAN R · SLICE');
    expect(tacticalChipsText(null)).toBe('');
    expect(tacticalChipsText(undefined)).toBe('');
  });

  it('turns noise into a five-step meter', () => {
    expect(NOISE_STEPS).toBe(5);
    expect(noiseSteps(0)).toBe(0);
    expect(noiseSteps(0.01)).toBe(1);
    expect(noiseSteps(0.2)).toBe(1);
    expect(noiseSteps(0.21)).toBe(2);
    expect(noiseSteps(0.6)).toBe(3);
    expect(noiseSteps(1)).toBe(5);
    expect(noiseSteps(7)).toBe(5);
    expect(noiseSteps(-1)).toBe(0);
    expect(noiseSteps(Number.NaN)).toBe(0);
    expect(noiseMeterText(0.6)).toBe('■■■□□');
    expect(noiseMeterText(0)).toBe('□□□□□');
  });

  it('formats visibility as a clamped percentage', () => {
    expect(visibilityText(tac({ visibility: 0.604 }))).toBe('VIS 60%');
    expect(visibilityText(tac({ visibility: 3 }))).toBe('VIS 100%');
    expect(visibilityText(tac({ visibility: Number.NaN }))).toBe('VIS 0%');
    expect(visibilityText(null)).toBe('');
  });

  it('shows REC while recording, CAM when worn and off', () => {
    expect(bodycamChipText({ recording: true })).toBe('● REC');
    expect(bodycamChipText({ recording: false })).toBe('CAM');
    expect(bodycamChipText(null)).toBe('');
    expect(bodycamChipText(undefined)).toBe('');
  });

  it('joins building and room', () => {
    expect(locationChipText({ building: 'House', room: 'Kitchen' })).toBe('House · Kitchen');
    expect(locationChipText({ building: 'House', room: '' })).toBe('House');
    expect(locationChipText({ building: '', room: 'Kitchen' })).toBe('Kitchen');
    expect(locationChipText({ building: '', room: '' })).toBe('');
    expect(locationChipText(null)).toBe('');
  });
});

describe('hudText Phase 4 fields', () => {
  it('is empty without the optional fields (a Phase 3 feed)', () => {
    const t = hudText(snapshot());
    expect(t.tactical).toBe('');
    expect(t.noise).toBe(0);
    expect(t.noiseMeter).toBe('');
    expect(t.visibility).toBe('');
    expect(t.bodycam).toBe('');
    expect(t.bodycamRecording).toBe(false);
    expect(t.shift).toBe('');
    expect(t.location).toBe('');
    expect(t.caseLine).toBe('');
  });

  it('covers tactical, bodycam, shift, location and case line', () => {
    const t = hudText(
      snapshot({
        mode: 'onFoot',
        telemetry: null,
        tactical: tac({ crouched: true, flashlight: true, noise: 0.45, visibility: 0.8 }),
        bodycam: { recording: true },
        shift: 'Shift: attend roll call (E at the podium)',
        location: { building: 'House', room: 'Kitchen' },
        caseLine: 'Case C-00042 · 3 items',
      }),
    );
    expect(t.tactical).toBe('CROUCH · LIGHT');
    expect(t.noise).toBe(3);
    expect(t.noiseMeter).toBe('■■■□□');
    expect(t.visibility).toBe('VIS 80%');
    expect(t.bodycam).toBe('● REC');
    expect(t.bodycamRecording).toBe(true);
    expect(t.shift).toBe('Shift: attend roll call (E at the podium)');
    expect(t.location).toBe('House · Kitchen');
    expect(t.caseLine).toBe('Case C-00042 · 3 items');
  });

  it('shows the fields while driving too (bodycam works in a car)', () => {
    const t = hudText(snapshot({ bodycam: { recording: false }, shift: 'Shift: take a patrol car from the garage' }));
    expect(t.driving).toBe(true);
    expect(t.bodycam).toBe('CAM');
    expect(t.shift).toContain('garage');
  });

  it('resets a reused buffer when the fields go away', () => {
    const out = createHudText();
    hudText(snapshot({ tactical: tac({ lean: 1, noise: 1 }), bodycam: { recording: true }, shift: 'x', location: { building: 'B', room: 'R' }, caseLine: 'c' }), out);
    expect(out.tactical).toBe('LEAN R');
    hudText(snapshot({ tactical: null, bodycam: null, shift: null, location: null, caseLine: null }), out);
    expect(out.tactical).toBe('');
    expect(out.noise).toBe(0);
    expect(out.noiseMeter).toBe('');
    expect(out.bodycam).toBe('');
    expect(out.bodycamRecording).toBe(false);
    expect(out.shift).toBe('');
    expect(out.location).toBe('');
    expect(out.caseLine).toBe('');
  });

  it('keeps every existing field working next to the new ones', () => {
    const t = hudText(snapshot({ tactical: tac(), pursuit: 'PURSUIT' }));
    expect(t.speed).toBe('45');
    expect(t.pursuit).toBe('PURSUIT');
    expect(t.road).toBe('Maple Avenue');
  });

  it('Hud picks the new fields up headless at the throttled rate', () => {
    const hud = new Hud(parent);
    const s = snapshot({ shift: 'Shift: choose your gear at the locker (E)', bodycam: { recording: true } });
    hud.update(s, 0);
    expect(hud.text.shift).toBe('Shift: choose your gear at the locker (E)');
    expect(hud.text.bodycam).toBe('● REC');
    s.shift = null;
    hud.update(s, 50);
    expect(hud.text.shift).not.toBe('');
    hud.update(s, 100);
    expect(hud.text.shift).toBe('');
  });
});

describe('Minimap floor plan (headless)', () => {
  const city = { pois: [], graph: null } as unknown as City;
  const plan: FloorPlan = {
    rooms: new Float32Array([0, 0, 6, 4, 6, 0, 10, 4]),
    doors: new Float32Array([6, 2, 1, 5, 0, 0]),
    rect: { minX: 0, minZ: 0, maxX: 10, maxZ: 4 },
  };

  it('fits the plan rectangle into the circle', () => {
    const fit: PlanFit = { scale: 0, centerX: 0, centerZ: 0 };
    fitFloorPlan(plan, fit);
    expect(fit.centerX).toBe(5);
    expect(fit.centerZ).toBe(2);
    // The diagonal fills 84% of the diameter.
    expect(fit.scale * Math.hypot(10, 4)).toBeCloseTo(MINIMAP_SIZE * 0.84, 5);
    fitFloorPlan({ ...plan, rect: { minX: 1, minZ: 1, maxX: 1, maxZ: 1 } }, fit);
    expect(fit.scale).toBe(1);
  });

  it('keeps and clears the plan, and still throttles redraws', () => {
    const map = new Minimap(parent, city);
    expect(map.floorPlan).toBeNull();
    map.setFloorPlan(plan, 3, 2);
    expect(map.floorPlan).toBe(plan);
    map.update(3, 2, 0.5, null, null, 0);
    expect(map.redraws).toBe(1);
    map.update(3, 2, 0.5, null, null, 50);
    expect(map.redraws).toBe(1);
    // Setting a plan forces a redraw on the next update, updating only the position does not.
    map.setFloorPlan(null, 0, 0);
    expect(map.floorPlan).toBeNull();
    map.update(3, 2, 0.5, null, null, 60);
    expect(map.redraws).toBe(2);
    map.setFloorPlan(plan, 1, 1);
    map.update(1, 1, 0, null, null, 70);
    expect(map.redraws).toBe(3);
    map.setFloorPlan(plan, 2, 1);
    map.update(2, 1, 0, null, null, 80);
    expect(map.redraws).toBe(3);
    map.update(2, 1, 0, null, null, 200);
    expect(map.redraws).toBe(4);
  });

  it('does not touch the city while a plan is set (graph is null here)', () => {
    const map = new Minimap(parent, city);
    map.setFloorPlan(plan, 0, 0);
    expect(() => map.update(0, 0, 0, null, null, 0)).not.toThrow();
  });
});

describe('FadeOverlay (headless)', () => {
  it('keeps the clamped level without a DOM', () => {
    const f = new FadeOverlay(null);
    expect(f.level).toBe(0);
    f.set(0.5);
    expect(f.level).toBe(0.5);
    f.set(2);
    expect(f.level).toBe(1);
    f.set(-1);
    expect(f.level).toBe(0);
    f.set(Number.NaN);
    expect(f.level).toBe(0);
    expect(() => {
      f.dispose();
    }).not.toThrow();
  });

  it('is a no-op with a parent but no document', () => {
    const f = new FadeOverlay(parent);
    f.set(0.25);
    expect(f.level).toBe(0.25);
  });
});
