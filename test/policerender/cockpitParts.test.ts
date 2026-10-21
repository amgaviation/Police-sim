import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { RACK_ITEMS, SIREN_TONES } from '../../src/police/equipment';
import {
  COCKPIT_LED,
  cockpitParts,
  driverEye,
  LED_COUNT,
  LED_RGB,
  LED_TONE_COUNT,
  ledColors,
  radioDisplayText,
  type CockpitPart,
} from '../../src/render/police/cockpitParts';
import { cabinBox } from '../../src/render/vehicles/carParts';
import { VEHICLE_MODELS, vehicleModel } from '../../src/vehicles/model';
import { cockpitState } from './helpers';

const EPS = 1e-9;
/** The cockpit is drawn for the car styles; the fleet's other equipped models (bikes, boat, helicopter, vans, trucks) have none. */
const CAR_STYLES: readonly string[] = ['sedan', 'hatchback', 'suv'];
const PATROL = VEHICLE_MODELS.filter((m) => m.equipment?.partition === true && m.equipment.rack && m.equipment.mdt && CAR_STYLES.includes(m.body.style));

/** World-axis bounds of a rotated part (YXZ Euler). */
function bounds(p: CockpitPart): THREE.Box3 {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(p.x, p.y, p.z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(p.rx, p.ry, 0, 'YXZ')),
    new THREE.Vector3(1, 1, 1),
  );
  const box = new THREE.Box3();
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    box.expandByPoint(new THREE.Vector3((sx * p.sx) / 2, (sy * p.sy) / 2, (sz * p.sz) / 2).applyMatrix4(m));
  }
  return box;
}

function normal(p: CockpitPart): THREE.Vector3 {
  return new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(p.rx, p.ry, 0, 'YXZ'));
}

describe('cockpitParts', () => {
  it('ships patrol models with equipment', () => {
    expect(PATROL.map((m) => m.id).sort()).toEqual(['k9_suv', 'patrol_sedan', 'patrol_suv', 'traffic_sedan', 'unmarked_sedan']);
  });

  it('keeps every part inside the body box', () => {
    for (const model of PATROL) {
      const { width: w, height: h, length: l } = model.body;
      for (const p of cockpitParts(model)) {
        const b = bounds(p);
        const label = `${model.id} ${p.kind}`;
        expect(p.sx, label).toBeGreaterThan(0);
        expect(p.sy, label).toBeGreaterThan(0);
        if (p.group !== 'screen' && p.group !== 'radio') expect(p.sz, label).toBeGreaterThan(0);
        expect(b.min.x, label).toBeGreaterThanOrEqual(-w / 2 - EPS);
        expect(b.max.x, label).toBeLessThanOrEqual(w / 2 + EPS);
        expect(b.min.y, label).toBeGreaterThanOrEqual(-h / 2 - EPS);
        expect(b.max.y, label).toBeLessThanOrEqual(h / 2 + EPS);
        expect(b.min.z, label).toBeGreaterThanOrEqual(-l / 2 - EPS);
        expect(b.max.z, label).toBeLessThanOrEqual(l / 2 + EPS);
      }
    }
  });

  it('uses the cockpit camera eye and puts the dash ahead, the laptop right and the partition behind', () => {
    for (const model of PATROL) {
      const eye = driverEye(model);
      expect(eye.x).toBeCloseTo(-model.body.width * 0.22, 9);
      expect(eye.y).toBeCloseTo(model.body.height * 0.2, 9);
      expect(eye.z).toBeCloseTo(-model.body.length * 0.05, 9);
      const parts = cockpitParts(model);
      const find = (kind: string) => parts.filter((p) => p.kind === kind);

      const dash = find('dash')[0] as CockpitPart;
      expect(eye.z - (dash.z + dash.sz / 2)).toBeCloseTo(0.55, 6);
      expect(dash.y + dash.sy / 2).toBeLessThan(eye.y); // the driver looks over it

      const wheel = find('wheel')[0] as CockpitPart;
      expect(wheel.x).toBeCloseTo(eye.x, 9);
      expect(wheel.z).toBeLessThan(eye.z);

      for (const kind of ['laptopBase', 'laptopLid', 'screen']) {
        const p = find(kind)[0] as CockpitPart;
        expect(p.x, kind).toBeGreaterThan(eye.x + 0.3);
        expect(p.z, kind).toBeLessThan(eye.z);
      }
      // The screen faces the driver.
      const screen = find('screen')[0] as CockpitPart;
      const toEye = new THREE.Vector3(eye.x - screen.x, eye.y - screen.y, eye.z - screen.z).normalize();
      expect(normal(screen).dot(toEye)).toBeGreaterThan(0.5);

      const partition = find('partition')[0] as CockpitPart;
      expect(partition.z).toBeGreaterThan(eye.z + 0.5);
      expect(partition.z).toBeCloseTo(0.15 * model.body.length + 0.015, 6);
      for (const bar of find('cageBar')) expect(bar.z).toBeGreaterThan(eye.z + 0.5);
      expect(find('cageBar').length).toBeGreaterThan(5);
      // Seats sit between the eye and the partition.
      for (const seat of find('seat')) expect(seat.z + seat.sz / 2).toBeLessThan(partition.z - partition.sz / 2);

      // Rack between the seats against the partition, one gun per rack item.
      const guns = find('gun');
      expect(guns.map((g) => g.index)).toEqual(RACK_ITEMS.map((_, i) => i));
      for (const g of guns) {
        expect(Math.abs(g.x)).toBeLessThan(0.2);
        expect(g.z).toBeLessThan(partition.z);
        expect(g.z).toBeGreaterThan(partition.z - 0.2);
      }
      // Radio and siren controller in the centre stack.
      for (const kind of ['radioHead', 'radioDisplay', 'sirenController']) {
        const p = find(kind)[0] as CockpitPart;
        expect(Math.abs(p.x), kind).toBeLessThan(0.05);
      }
      const leds = find('led');
      expect(leds.map((p) => p.index)).toEqual(Array.from({ length: LED_COUNT }, (_, i) => i));
    }
  });

  it('builds at most six groups and only the equipped extras', () => {
    const sedan = vehicleModel('patrol_sedan');
    const groups = new Set(cockpitParts(sedan).map((p) => p.group));
    expect(groups.size).toBeLessThanOrEqual(6);
    expect([...groups].sort()).toEqual(['cage', 'interior', 'led', 'radio', 'screen', 'trim']);

    const plain = vehicleModel('sedan');
    expect(plain.equipment).toBeNull();
    const kinds = new Set(cockpitParts(plain).map((p) => p.kind));
    for (const k of ['screen', 'laptopBase', 'partition', 'cageBar', 'gun', 'rackFrame']) expect(kinds.has(k as never)).toBe(false);
    expect(kinds.has('dash')).toBe(true);

    const noCage = { ...sedan, equipment: { ...(sedan.equipment ?? ({} as never)), partition: false, rack: false, mdt: false } };
    const k2 = new Set(cockpitParts(noCage).map((p) => p.kind));
    expect(k2.has('cageBar')).toBe(false);
    expect(k2.has('gun')).toBe(false);
    expect(k2.has('screen')).toBe(false);
  });

  it('lies within the cabin footprint lengthwise for the dash-to-partition span', () => {
    for (const model of PATROL) {
      const c = cabinBox(model);
      const partition = cockpitParts(model).find((p) => p.kind === 'partition') as CockpitPart;
      expect(partition.z).toBeLessThan(c.z1);
      expect(partition.z).toBeGreaterThan(c.z0);
    }
  });
});

describe('ledColors', () => {
  const out = new Float32Array(LED_COUNT * 3);
  const led = (i: number): number[] => Array.from(out.subarray(i * 3, i * 3 + 3));
  const near = (a: readonly number[], b: readonly number[]): boolean => a.every((v, i) => Math.abs(v - (b[i] ?? NaN)) < 1e-6);

  it('has one LED per siren tone plus lights, horn, spot, rack and cage', () => {
    expect(LED_TONE_COUNT).toBe(SIREN_TONES.length);
    expect(LED_COUNT).toBe(SIREN_TONES.length + 5);
    expect(Object.values(COCKPIT_LED).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4].map((i) => LED_TONE_COUNT + i));
  });

  it('is all dim except the locked rack in the default state', () => {
    expect(ledColors(cockpitState(), out)).toBe(out);
    for (let i = 0; i < LED_COUNT; i++) {
      expect(near(led(i), i === COCKPIT_LED.rack ? LED_RGB.locked : LED_RGB.dim), `led ${i}`).toBe(true);
    }
  });

  it('lights the active tone only while the siren is on', () => {
    ledColors(cockpitState({ sirenOn: true, tone: 2 }), out);
    for (let i = 0; i < LED_TONE_COUNT; i++) expect(near(led(i), i === 2 ? LED_RGB.tone : LED_RGB.dim)).toBe(true);
    ledColors(cockpitState({ sirenOn: false, tone: 2 }), out);
    expect(near(led(2), LED_RGB.dim)).toBe(true);
  });

  it('shows lights, horn, spot, rack unlock and cage state', () => {
    ledColors(cockpitState({ lightsOn: true, horn: true, spotOn: true, rackLocked: false, caged: true }), out);
    expect(near(led(COCKPIT_LED.lights), LED_RGB.lights)).toBe(true);
    expect(near(led(COCKPIT_LED.horn), LED_RGB.horn)).toBe(true);
    expect(near(led(COCKPIT_LED.spot), LED_RGB.spot)).toBe(true);
    expect(near(led(COCKPIT_LED.rack), LED_RGB.unlocked)).toBe(true);
    expect(near(led(COCKPIT_LED.cage), LED_RGB.caged)).toBe(true);
  });
});

describe('radioDisplayText', () => {
  it('shows the channel and the active flags', () => {
    expect(radioDisplayText('Dispatch 1', false, false, false, false)).toBe('DISPATCH 1\n');
    expect(radioDisplayText('ops', true, true, true, true)).toBe('OPS\nTX RX SCAN EMERG');
    expect(radioDisplayText('Tactical channel two', false, true, false, false)).toBe('TACTICAL CHA\nRX');
  });
});
