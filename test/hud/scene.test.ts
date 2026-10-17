import { afterEach, describe, expect, it } from 'vitest';
import { Hud, hudText, createHudText } from '../../src/ui/hud/hud';
import { MARKER, Minimap, createMinimapMarkers } from '../../src/ui/hud/minimap';
import { SCENE_LINES, contactChipText, createSceneText, sceneText, weaponChipText } from '../../src/ui/hud/scene';
import type { City } from '../../src/world/city';
import { snapshot } from './fixtures';

const parent = null as unknown as HTMLElement;

describe('weaponChipText', () => {
  it('names the drawn weapon and hides the chip when holstered', () => {
    expect(weaponChipText({ weapon: 'sidearm' })).toBe('SIDEARM');
    expect(weaponChipText({ weapon: 'taser' })).toBe('TASER');
    expect(weaponChipText({ weapon: 'none' })).toBe('');
    expect(weaponChipText(null)).toBe('');
    expect(weaponChipText(undefined)).toBe('');
  });
});

describe('contactChipText', () => {
  it('joins name, state and distance', () => {
    expect(contactChipText({ name: 'Jane Doe', state: 'calm', distanceM: 4.2 })).toBe('Jane Doe · calm · 4 m');
    expect(contactChipText({ name: 'Jane Doe', state: 'cuffed', distanceM: 1500 })).toBe('Jane Doe · cuffed · 1.5 km');
  });

  it('omits empty parts and an unknown distance', () => {
    expect(contactChipText({ name: 'Jane Doe', state: '', distanceM: 3 })).toBe('Jane Doe · 3 m');
    expect(contactChipText({ name: 'Jane Doe', state: 'calm', distanceM: -1 })).toBe('Jane Doe · calm');
    expect(contactChipText({ name: '', state: 'calm', distanceM: 3 })).toBe('calm · 3 m');
  });

  it('is empty without a contact', () => {
    expect(contactChipText(null)).toBe('');
    expect(contactChipText(undefined)).toBe('');
  });
});

describe('sceneText', () => {
  it('fills the title and the first four objectives with their done flags', () => {
    const t = sceneText({
      title: 'Domestic disturbance',
      objectives: [
        { text: 'Contact the reporting party', done: true },
        { text: 'Separate the parties', done: false },
        { text: 'Get a statement', done: false },
        { text: 'Request EMS', done: true },
        { text: 'A fifth one', done: false },
      ],
    });
    expect(SCENE_LINES).toBe(4);
    expect(t.title).toBe('Domestic disturbance');
    expect(t.lines).toEqual(['Contact the reporting party', 'Separate the parties', 'Get a statement', 'Request EMS']);
    expect(t.done).toEqual([true, false, false, true]);
  });

  it('blanks unused lines and resets a reused buffer', () => {
    const out = createSceneText();
    sceneText({ title: 'T', objectives: [{ text: 'a', done: true }, { text: 'b', done: true }] }, out);
    sceneText({ title: 'T2', objectives: [{ text: 'c', done: false }] }, out);
    expect(out.lines).toEqual(['c', '', '', '']);
    expect(out.done).toEqual([false, false, false, false]);
    sceneText(null, out);
    expect(out.title).toBe('');
    expect(out.lines).toEqual(['', '', '', '']);
  });
});

describe('hudText Phase 3 fields', () => {
  it('hides every new element when the fields are absent or null (Phase 2 snapshot)', () => {
    for (const s of [snapshot(), snapshot({ officer: null, contact: null, scene: null, pursuit: null })]) {
      const t = hudText(s);
      expect([t.weapon, t.contact, t.sceneTitle, t.pursuit]).toEqual(['', '', '', '']);
      expect(t.sceneLines).toEqual(['', '', '', '']);
      expect(t.sceneDone).toEqual([false, false, false, false]);
    }
  });

  it('fills the chips, the objective box and the pursuit line', () => {
    const t = hudText(
      snapshot({
        mode: 'onFoot',
        telemetry: null,
        officer: { weapon: 'taser' },
        contact: { name: 'Jane Doe', state: 'hands up', distanceM: 6 },
        scene: { title: 'Wanted person', objectives: [{ text: 'Locate the subject', done: true }, { text: 'Make the arrest', done: false }] },
        pursuit: 'PURSUIT  Foot  suspect fleeing north',
      }),
    );
    expect(t.weapon).toBe('TASER');
    expect(t.contact).toBe('Jane Doe · hands up · 6 m');
    expect(t.sceneTitle).toBe('Wanted person');
    expect(t.sceneLines).toEqual(['Locate the subject', 'Make the arrest', '', '']);
    expect(t.sceneDone).toEqual([true, false, false, false]);
    expect(t.pursuit).toBe('PURSUIT  Foot  suspect fleeing north');
  });

  it('shows the new elements while driving too (a car pursuit, a scene on the way)', () => {
    const t = hudText(snapshot({ pursuit: 'PURSUIT  Vehicle', scene: { title: 'Scene', objectives: [] } }));
    expect(t.pursuit).toBe('PURSUIT  Vehicle');
    expect(t.sceneTitle).toBe('Scene');
  });

  it('keeps the text buffer reusable: a later snapshot without scene clears the lines', () => {
    const out = createHudText();
    hudText(snapshot({ scene: { title: 'S', objectives: [{ text: 'x', done: true }] } }), out);
    expect(out.sceneLines[0]).toBe('x');
    hudText(snapshot(), out);
    expect(out.sceneTitle).toBe('');
    expect(out.sceneLines).toEqual(['', '', '', '']);
    expect(out.sceneDone[0]).toBe(false);
    expect(out.sceneLines).toHaveLength(SCENE_LINES);
  });

  it('Hud picks the new fields up headless at the throttled rate', () => {
    const hud = new Hud(parent);
    const s = snapshot({ officer: { weapon: 'sidearm' }, pursuit: 'PURSUIT' });
    hud.update(s, 0);
    expect(hud.text.weapon).toBe('SIDEARM');
    expect(hud.text.pursuit).toBe('PURSUIT');
    s.officer = { weapon: 'none' };
    hud.update(s, 50);
    expect(hud.text.weapon).toBe('SIDEARM');
    hud.update(s, 100);
    expect(hud.text.weapon).toBe('');
  });
});

describe('Phase 3 minimap markers (headless)', () => {
  const city = { pois: [], graph: null } as unknown as City;

  it('numbers the new markers after the Phase 2 ones', () => {
    expect(MARKER.suspect).toBe(9);
    expect(MARKER.person).toBe(10);
    expect(MARKER.pursuit).toBe(11);
    expect(Object.values(MARKER)).toHaveLength(11);
    expect(new Set(Object.values(MARKER)).size).toBe(11);
  });

  it('accepts them and keeps the throttle', () => {
    const map = new Minimap(parent, city);
    const m = createMinimapMarkers(4);
    const kinds = [MARKER.suspect, MARKER.person, MARKER.pursuit, MARKER.callP2];
    kinds.forEach((k, i) => {
      m.x[i] = i * 40;
      m.z[i] = -i * 30;
      m.kind[i] = k;
    });
    m.count = kinds.length;
    for (let ms = 0; ms < 1000; ms += 10) map.update(0, 0, 0, null, null, ms, m);
    expect(map.redraws).toBe(10);
  });
});

/** A canvas 2D context that records the fill colours and arcs it is given. */
class FakeCtx {
  readonly arcs: { x: number; y: number; r: number; fill: string }[] = [];
  readonly rects: string[] = [];
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  lineCap = '';
  lineJoin = '';
  font = '';
  textAlign = '';
  textBaseline = '';
  private pending: { x: number; y: number; r: number } | null = null;
  save(): void {}
  restore(): void {}
  scale(): void {}
  clearRect(): void {}
  beginPath(): void {}
  closePath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  clip(): void {}
  stroke(): void {}
  strokeRect(): void {}
  fillText(): void {}
  fillRect(): void {
    this.rects.push(this.fillStyle);
  }
  arc(x: number, y: number, r: number): void {
    this.pending = { x, y, r };
  }
  fill(): void {
    if (this.pending) this.arcs.push({ ...this.pending, fill: this.fillStyle });
    this.pending = null;
  }
}

describe('Phase 3 minimap markers (canvas)', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'document');
  });

  it('draws suspects red, persons white and the pursuit orange, the pursuit pinned to the rim when far', () => {
    const ctx = new FakeCtx();
    const canvas = { id: '', width: 0, height: 0, setAttribute: () => undefined, getContext: () => ctx, remove: () => undefined };
    Reflect.set(globalThis, 'document', { createElement: () => canvas });
    const city = {
      pois: [],
      graph: { edgesNear: (_x: number, _z: number, _r: number, out: number[]) => (out.length = 0), edges: [] },
    } as unknown as City;
    const map = new Minimap({ appendChild: () => undefined } as unknown as HTMLElement, city);
    const m = createMinimapMarkers(4);
    // Heading north (yaw 0): world -Z is up. Suspect and person close, pursuit 5 km away.
    const rows: [number, number, number][] = [
      [10, -20, MARKER.suspect],
      [-10, -20, MARKER.person],
      [0, -5000, MARKER.pursuit],
      [900, 900, MARKER.person],
    ];
    rows.forEach(([x, z, k], i) => {
      m.x[i] = x;
      m.z[i] = z;
      m.kind[i] = k;
    });
    m.count = 3;
    map.update(0, 0, 0, null, null, 0, m);
    const byFill = (fill: string) => ctx.arcs.filter((a) => a.fill === fill);
    expect(byFill('#ff3b3b')).toHaveLength(1);
    expect(byFill('#ffffff')).toHaveLength(1);
    const pursuit = byFill('#ff7a1a');
    expect(pursuit).toHaveLength(1);
    // Clamped to the rim: the centre is 100 px away (200 px map), so the marker sits at most MARKER_RIM from it.
    expect(Math.hypot((pursuit[0]?.x ?? 0) - 100, (pursuit[0]?.y ?? 0) - 100)).toBeLessThanOrEqual(94);
    expect(Math.hypot((pursuit[0]?.x ?? 0) - 100, (pursuit[0]?.y ?? 0) - 100)).toBeGreaterThan(80);
    // Off-map persons are not drawn at all (only the rim-pinned pursuit and calls are).
    m.count = 4;
    ctx.arcs.length = 0;
    map.update(0, 0, 0, null, null, 1000, m);
    expect(ctx.arcs.filter((a) => a.fill === '#ffffff')).toHaveLength(1);
  });
});

/** Just enough of an element for the HUD's builder and writers. */
class FakeNode {
  id = '';
  textContent = '';
  style: Record<string, string> = {};
  children: FakeNode[] = [];
  appendChild(c: FakeNode): FakeNode {
    this.children.push(c);
    return c;
  }
  setAttribute(): void {}
  remove(): void {}
  descendants(): FakeNode[] {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }
}

describe('Hud DOM Phase 3 elements', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'document');
  });

  function mount(): { hud: Hud; texts: () => string[]; shown: (text: string) => boolean | null; root: FakeNode } {
    Reflect.set(globalThis, 'document', { createElement: () => new FakeNode() });
    const root = new FakeNode();
    const hud = new Hud(root as unknown as HTMLElement);
    const all = (): FakeNode[] => root.descendants();
    return {
      hud,
      root,
      texts: () => all().map((n) => n.textContent).filter((t) => t !== ''),
      shown: (text) => {
        const n = all().find((e) => e.textContent === text);
        return n ? n.style['display'] !== 'none' : null;
      },
    };
  }

  it('shows and strikes through objectives, hides the box and chips when cleared', () => {
    const { hud, shown, root } = mount();
    hud.update(
      snapshot({
        officer: { weapon: 'sidearm' },
        contact: { name: 'Jane Doe', state: 'calm', distanceM: 4 },
        scene: { title: 'Welfare check', objectives: [{ text: 'Knock', done: true }, { text: 'Talk to RP', done: false }] },
        pursuit: 'PURSUIT  Foot',
      }),
      0,
    );
    expect(shown('SIDEARM')).toBe(true);
    expect(shown('Jane Doe · calm · 4 m')).toBe(true);
    expect(shown('Welfare check')).toBe(true);
    expect(shown('PURSUIT  Foot')).toBe(true);
    const lines = root.descendants();
    const knock = lines.find((n) => n.textContent === 'Knock');
    const talk = lines.find((n) => n.textContent === 'Talk to RP');
    expect(knock?.style['textDecoration']).toBe('line-through');
    expect(talk?.style['textDecoration']).toBe('none');
    const rowOf = (text: string): FakeNode | undefined => lines.find((n) => n.children.some((c) => c.textContent === text));
    expect(rowOf('Knock')?.style['display']).toBe('flex');
    expect(rowOf('Talk to RP')?.style['display']).toBe('flex');
    // The marker beside each text: a tick for done, a bullet otherwise.
    expect(rowOf('Knock')?.children[0]?.textContent).toBe('\u2713');
    expect(rowOf('Talk to RP')?.children[0]?.textContent).toBe('\u2022');
    // Rows past the objectives stay hidden.
    expect(lines.filter((n) => n.children.length === 2 && n.children[1]?.textContent === '' && n.style['display'] === 'none').length).toBeGreaterThanOrEqual(2);

    hud.update(snapshot(), 100);
    // The objective texts are cleared and the chips and pursuit line hidden.
    expect(rowOf('Knock')).toBeUndefined();
    expect(rowOf('Talk to RP')).toBeUndefined();
    expect(shown('SIDEARM')).toBeNull();
    expect(shown('Jane Doe · calm · 4 m')).toBeNull();
    expect(shown('PURSUIT  Foot')).toBeNull();
  });
});
