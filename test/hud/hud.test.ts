import { describe, expect, it } from 'vitest';
import { Hud, hudText } from '../../src/ui/hud/hud';
import { Minimap, MINIMAP_RADII } from '../../src/ui/hud/minimap';
import type { City } from '../../src/world/city';
import { snapshot, telemetry } from './fixtures';

// Headless: the test environment has no `document`.
const parent = null as unknown as HTMLElement;

describe('hudText', () => {
  it('shows speed, gear, fuel, clock, weather and road while driving', () => {
    const t = hudText(snapshot());
    expect(t.driving).toBe(true);
    expect(t.speed).toBe('45');
    expect(t.gear).toBe('3');
    expect(t.fuel).toBe('50%');
    expect(t.clock).toBe('Mon 07:42');
    expect(t.weather).toBe('Rain  12°C');
    expect(t.road).toBe('Maple Avenue');
    expect(t.showLimit).toBe(true);
    expect(t.limit).toBe('35');
    expect(t.status).toBe('CHASE');
    expect(t.prompt).toBe('');
    expect([t.abs, t.engineWarn, t.tyreWarn, t.brakesWarn, t.fuelLow]).toEqual([false, false, false, false, false]);
  });

  it('hides the vehicle panel on foot', () => {
    const t = hudText(snapshot({ mode: 'onFoot', prompt: 'E  Enter vehicle' }));
    expect(t.driving).toBe(false);
    expect(t.speed).toBe('');
    expect(t.prompt).toBe('E  Enter vehicle');
    expect(t.clock).toBe('Mon 07:42');
  });

  it('raises warnings from telemetry', () => {
    const t = hudText(
      snapshot({
        headlights: true,
        telemetry: telemetry({
          absActive: true,
          engineHealth: 0.2,
          tireFlat: [false, false, true, false],
          brakeTempC: 420,
          fuelFraction: 0.1,
          gear: -1,
        }),
      }),
    );
    expect([t.abs, t.engineWarn, t.tyreWarn, t.brakesWarn, t.fuelLow]).toEqual([true, true, true, true, true]);
    expect(t.gear).toBe('R');
    expect(t.status).toBe('CHASE  LIGHTS');
    expect(hudText(snapshot({ telemetry: telemetry({ engineRunning: false }) })).engineWarn).toBe(true);
    expect(hudText(snapshot({ telemetry: telemetry({ brakeEfficiency: 0.8 }) })).brakesWarn).toBe(true);
  });

  it('shows the worst body damage once it is noticeable', () => {
    expect(hudText(snapshot()).damage).toBe('');
    expect(hudText(snapshot({ telemetry: telemetry({ damage: [0.04, 0, 0.01, 0] }) })).damage).toBe('');
    expect(hudText(snapshot({ telemetry: telemetry({ damage: [0.1, 0.354, 0, 0.2] }) })).damage).toBe('DAMAGE 35%');
    expect(hudText(snapshot({ mode: 'onFoot', telemetry: telemetry({ damage: [1, 1, 1, 1] }) })).damage).toBe('');
  });

  it('flags school and construction zones and hides the sign off-road', () => {
    const t = hudText(snapshot({ schoolZoneActive: true, construction: true, speedLimitMph: 20 }));
    expect(t.schoolZone).toBe(true);
    expect(t.construction).toBe(true);
    expect(t.limit).toBe('20');
    expect(hudText(snapshot({ roadName: '', speedLimitMph: 0 })).showLimit).toBe(false);
  });
});

describe('Hud (headless)', () => {
  it('constructs, updates and disposes without a DOM', () => {
    const hud = new Hud(parent);
    hud.update(snapshot(), 0);
    expect(hud.text.speed).toBe('45');
    hud.setVisible(false);
    hud.setVisible(true);
    hud.dispose();
  });

  it('renders at most updateHz times per second', () => {
    const hud = new Hud(parent, { updateHz: 10 });
    const s = snapshot();
    for (let ms = 0; ms < 1000; ms += 1000 / 144) hud.update(s, ms);
    expect(hud.renders).toBe(10);
    const slow = new Hud(parent, { updateHz: 2 });
    for (let ms = 0; ms < 1000; ms += 16) slow.update(s, ms);
    expect(slow.renders).toBe(2);
  });

  it('picks up snapshot changes on the next throttled render only', () => {
    const hud = new Hud(parent);
    const s = snapshot();
    hud.update(s, 0);
    (s.telemetry as { speedMph: number }).speedMph = 60;
    hud.update(s, 50);
    expect(hud.text.speed).toBe('45');
    hud.update(s, 100);
    expect(hud.text.speed).toBe('60');
  });

  it('skips rendering while hidden and renders immediately when shown', () => {
    const hud = new Hud(parent);
    hud.setVisible(false);
    hud.update(snapshot(), 0);
    expect(hud.renders).toBe(0);
    hud.setVisible(true);
    hud.update(snapshot(), 1);
    expect(hud.renders).toBe(1);
  });
});

describe('Minimap (headless)', () => {
  const city = { pois: [], graph: null } as unknown as City;

  it('throttles redraws to 10 Hz and is a no-op without a DOM', () => {
    const map = new Minimap(parent, city);
    const traffic = { count: 0, x: new Float32Array(0), z: new Float32Array(0) };
    for (let ms = 0; ms < 1000; ms += 10) map.update(0, 0, 0, traffic, null, ms);
    expect(map.redraws).toBe(10);
    map.dispose();
  });

  it('cycles the zoom radius and redraws on the next update', () => {
    const map = new Minimap(parent, city);
    expect(map.radius).toBe(MINIMAP_RADII[0]);
    map.update(0, 0, 0, null, null, 0);
    map.toggleZoom();
    expect(map.radius).toBe(500);
    map.update(0, 0, 0, null, null, 1);
    expect(map.redraws).toBe(2);
    map.toggleZoom();
    expect(map.radius).toBe(1000);
    map.toggleZoom();
    expect(map.radius).toBe(250);
  });
});
