import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultScenarioContext, exportScenario, type SandboxScenario } from '../../src/training/scenario';
import { ScenarioEditor, type EditorHost } from '../../src/ui/sandbox/editor';
import { editorView, EDITOR_PX } from '../../src/ui/sandbox/draw';
import { libraryList } from '../../src/ui/sandbox/library';
import { blankScenario } from '../../src/ui/sandbox/state';
import type { UIRoot } from '../../src/ui/ui';
import type { RoadGraph } from '../../src/world/roadGraph';
import { FakeElement, fakeUi, findAll, findButton, installFakeDom } from '../ui7/fakeDom';

const ctx = defaultScenarioContext();
const profile = [...ctx.profiles].sort()[0] ?? '';

class FakeStorage {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

function host(log: { run: SandboxScenario[]; closed: number }): EditorHost {
  return {
    graph: { edges: [] } as unknown as RoadGraph,
    context: ctx,
    anchor: () => ({ x: 100, z: 200 }),
    run: (doc) => void log.run.push(doc),
    close: () => void log.closed++,
  };
}

describe('ScenarioEditor (headless)', () => {
  it('imports, validates, saves to the library and runs without a DOM', () => {
    const log = { run: [] as SandboxScenario[], closed: 0 };
    const st = new FakeStorage();
    const ed = new ScenarioEditor(null, host(log), st);
    ed.open();
    expect(ed.isOpen).toBe(true);
    // An empty scenario is valid (the anchor alone), so it can run.
    expect(ed.state.validate(ctx)).toEqual([]);
    const src = blankScenario('imported-one', { x: 10, z: 10 });
    src.name = 'Imported';
    const text = exportScenario(src);
    expect(ed.importText(text)).toBe(true);
    expect(ed.state.doc.id).toBe('imported-one');
    expect(ed.dirty).toBe(false);
    expect(ed.saveToLibrary()).toBeNull();
    expect(libraryList(st)).toEqual([{ id: 'imported-one', name: 'Imported' }]);
    expect(ed.removeFromLibrary('imported-one')).toBe(true);
    expect(libraryList(st)).toEqual([]);
    expect(ed.loadFromLibrary('imported-one')).toBe(false);
    expect(ed.run()).toBe(true);
    expect(log.run).toHaveLength(1);
    expect(log.run[0]?.id).toBe('imported-one');
    expect(log.run[0]).not.toBe(ed.state.doc); // a copy
  });

  it('keeps the current document and reports errors for a bad import', () => {
    const log = { run: [] as SandboxScenario[], closed: 0 };
    const ed = new ScenarioEditor(null, host(log), new FakeStorage());
    ed.open();
    const id = ed.state.doc.id;
    expect(ed.importText('{ nope')).toBe(false);
    expect(ed.statusText).toMatch(/import failed/i);
    expect(ed.state.doc.id).toBe(id);
    expect(ed.importText('{"format":"patrol-scenario"}')).toBe(false);
  });

  it('refuses to run, save or export an invalid scenario', () => {
    const log = { run: [] as SandboxScenario[], closed: 0 };
    const st = new FakeStorage();
    const ed = new ScenarioEditor(null, host(log), st);
    ed.open();
    ed.state.place('npc', 100, 200, { profile: 'no-such-profile' });
    expect(ed.run()).toBe(false);
    expect(ed.saveToLibrary()).toMatch(/cannot save/i);
    expect(ed.exportFile()).toBe(false);
    expect(log.run).toHaveLength(0);
    expect(libraryList(st)).toEqual([]);
  });

  it('Escape closes the editor and tells the host', () => {
    const log = { run: [] as SandboxScenario[], closed: 0 };
    const ed = new ScenarioEditor(null, host(log), new FakeStorage());
    ed.open();
    expect(ed.onKeyDown({ key: 'Escape', target: null } as unknown as KeyboardEvent)).toBe(true);
    expect(ed.isOpen).toBe(false);
    expect(log.closed).toBe(1);
  });

  it('Q / E rotate and Delete removes the selection; digits pick tools', () => {
    const log = { run: [] as SandboxScenario[], closed: 0 };
    const ed = new ScenarioEditor(null, host(log), new FakeStorage());
    ed.open();
    ed.state.place('npc', 100, 200, { profile });
    const key = (k: string): boolean => ed.onKeyDown({ key: k, target: null } as unknown as KeyboardEvent);
    expect(key('e')).toBe(true);
    expect(ed.state.doc.npcs[0]?.yaw).toBeCloseTo(Math.PI / 12, 9);
    expect(key('q')).toBe(true);
    expect(ed.state.doc.npcs[0]?.yaw).toBeCloseTo(0, 9);
    expect(key('3')).toBe(true);
    expect(ed.tool).toBe('vehicle');
    expect(key('1')).toBe(true);
    expect(ed.tool).toBe('select');
    expect(key('Delete')).toBe(true);
    expect(ed.state.doc.npcs).toHaveLength(0);
    expect(key('z')).toBe(false);
  });

  it('shows the whole 150 m radius in a fixed square view', () => {
    const v = editorView({ x: 100, z: 200 });
    expect(v.width).toBe(EDITOR_PX);
    expect(v.cx).toBe(100);
    expect(v.scale * 150).toBeLessThan(EDITOR_PX / 2);
  });
});

describe('ScenarioEditor (DOM double)', () => {
  let undo: () => void = () => undefined;
  beforeAll(() => {
    undo = installFakeDom();
  });
  afterAll(() => undo());

  function build() {
    const log = { run: [] as SandboxScenario[], closed: 0 };
    const st = new FakeStorage();
    const ui = fakeUi();
    const ed = new ScenarioEditor(ui as unknown as UIRoot, host(log), st);
    ed.open();
    const root = ed.element as unknown as FakeElement;
    const canvas = findAll(root, (e) => e.tagName === 'canvas')[0] as FakeElement;
    return { log, st, ui, ed, root, canvas };
  }

  it('places a person where the canvas is clicked with the Person tool', () => {
    const { ed, root, canvas, ui } = build();
    expect(ui.stack).toContain(ed);
    findButton(root, 'Person').click();
    expect(ed.tool).toBe('npc');
    // The centre pixel is the anchor.
    canvas.fire('pointerdown', { clientX: 300, clientY: 300, pointerId: 1 });
    expect(ed.state.doc.npcs).toHaveLength(1);
    const n = ed.state.doc.npcs[0];
    expect(n?.x).toBeCloseTo(100, 6);
    expect(n?.z).toBeCloseTo(200, 6);
    expect(n?.profile).toBe(profile);
    expect(ed.state.validate(ctx)).toEqual([]);
  });

  it('selects and drags an object with the Select tool', () => {
    const { ed, canvas } = build();
    ed.state.place('vehicle', 100, 200, { modelId: [...ctx.vehicleModels].sort()[0] ?? '' });
    ed.setTool('select');
    canvas.fire('pointerdown', { clientX: 300, clientY: 300, pointerId: 1 });
    expect(ed.state.selected).toEqual({ kind: 'vehicle', index: 0 });
    canvas.fire('pointermove', { clientX: 360, clientY: 300, pointerId: 1 });
    const v = ed.state.doc.vehicles[0];
    expect((v?.x ?? 0) > 100).toBe(true);
    canvas.fire('pointerup', { clientX: 360, clientY: 300, pointerId: 1 });
    canvas.fire('pointermove', { clientX: 500, clientY: 300, pointerId: 1 });
    expect(ed.state.doc.vehicles[0]?.x).toBe(v?.x); // no longer dragging
  });

  it('Run scenario calls the host with a valid scenario and shows problems for an invalid one', () => {
    const { ed, root, log } = build();
    findButton(root, 'Run scenario').click();
    expect(log.run).toHaveLength(1);
    ed.state.place('npc', 100, 200, { profile: 'no-such-profile' });
    findButton(root, 'Run scenario').click();
    expect(log.run).toHaveLength(1);
    expect(ed.statusText).toMatch(/cannot run/i);
    const problems = findAll(root, (e) => e.className.includes('sb-problem'));
    expect(problems.some((p) => p.textContent.includes('no-such-profile'))).toBe(true);
  });

  it('saves to and loads from the library with the buttons', () => {
    const { ed, root, st } = build();
    ed.state.setMeta('Alley', '');
    findButton(root, 'Save to library').click();
    expect(libraryList(st)).toEqual([{ id: ed.state.doc.id, name: 'Alley' }]);
    ed.newScenario();
    expect(ed.state.doc.name).toBe('New scenario');
    findButton(root, 'Alley').click();
    expect(ed.state.doc.name).toBe('Alley');
  });
});
