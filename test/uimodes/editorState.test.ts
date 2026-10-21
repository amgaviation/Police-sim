import { describe, expect, it } from 'vitest';
import { SAMPLE_SCENARIOS, SCENARIO_LIMITS, defaultScenarioContext, exportScenario, parseSandboxScenario } from '../../src/training/scenario';
import { EditorState, blankScenario, cloneScenario, wrapYaw } from '../../src/ui/sandbox/state';
import { LIBRARY_KEY, LIBRARY_LIMIT, libraryList, libraryLoad, libraryRemove, librarySave } from '../../src/ui/sandbox/library';
import { importScenarioText, IMPORT_MAX_BYTES } from '../../src/ui/sandbox/editor';

const ctx = defaultScenarioContext();
const first = (s: ReadonlySet<string>): string => [...s].sort()[0] ?? '';
const profile = first(ctx.profiles);
const model = first(ctx.vehicleModels);
const item = first(ctx.items);
const weapon = first(ctx.weapons);
const callType = first(ctx.callTypeIds);

function fresh(): EditorState {
  return new EditorState(blankScenario('test-scenario', { x: 100, z: 200 }));
}

describe('EditorState place', () => {
  it('places a person, a vehicle and an evidence item and selects the new one', () => {
    const e = fresh();
    expect(e.place('npc', 110, 205, { profile, role: 'suspect', weapon, hidden: true })).toBeNull();
    expect(e.doc.npcs).toEqual([{ x: 110, z: 205, yaw: 0, profile, role: 'suspect', weapon, hidden: true }]);
    expect(e.selected).toEqual({ kind: 'npc', index: 0 });
    expect(e.place('vehicle', 90, 190, { modelId: model })).toBeNull();
    expect(e.selected).toEqual({ kind: 'vehicle', index: 0 });
    expect(e.place('evidence', 100, 200, { item, concealed: 'true' })).toBeNull();
    expect(e.doc.evidence[0]).toEqual({ item, x: 100, z: 200, concealed: true });
    expect(e.validate(ctx)).toEqual([]);
  });

  it('defaults the role, treats an empty weapon as unarmed and normalises the yaw', () => {
    const e = fresh();
    e.place('npc', 100, 200, { profile, weapon: '', yaw: '7' });
    const n = e.doc.npcs[0];
    expect(n?.role).toBe('bystander');
    expect(n?.weapon).toBeNull();
    expect(n?.hidden).toBe(false);
    expect(Math.abs(n?.yaw ?? 9)).toBeLessThanOrEqual(Math.PI);
  });

  it('refuses a missing choice, a bad role and the select tool, and adds nothing', () => {
    const e = fresh();
    expect(e.place('npc', 100, 200, {})).toMatch(/profile/i);
    expect(e.place('npc', 100, 200, { profile, role: 'not valid!' })).toMatch(/role/i);
    expect(e.place('vehicle', 100, 200, {})).toMatch(/model/i);
    expect(e.place('evidence', 100, 200, {})).toMatch(/item/i);
    expect(e.place('select', 100, 200, {})).not.toBeNull();
    expect(e.place('npc', Number.NaN, 0, { profile })).not.toBeNull();
    expect(e.doc.npcs).toHaveLength(0);
    expect(e.doc.vehicles).toHaveLength(0);
    expect(e.doc.evidence).toHaveLength(0);
    expect(e.selected).toBeNull();
  });

  it('refuses a position beyond 150 m of the anchor', () => {
    const e = fresh();
    expect(e.place('npc', 100 + SCENARIO_LIMITS.radiusM + 1, 200, { profile })).toMatch(/too far/i);
    expect(e.place('npc', 100 + SCENARIO_LIMITS.radiusM, 200, { profile })).toBeNull();
  });

  it('enforces the content limits', () => {
    const e = fresh();
    for (let i = 0; i < SCENARIO_LIMITS.vehicles; i++) expect(e.place('vehicle', 100, 200, { modelId: model })).toBeNull();
    expect(e.place('vehicle', 100, 200, { modelId: model })).toMatch(/at most/i);
    for (let i = 0; i < SCENARIO_LIMITS.npcs; i++) expect(e.place('npc', 100, 200, { profile })).toBeNull();
    expect(e.place('npc', 100, 200, { profile })).toMatch(/at most/i);
    for (let i = 0; i < SCENARIO_LIMITS.evidence; i++) expect(e.place('evidence', 100, 200, { item })).toBeNull();
    expect(e.place('evidence', 100, 200, { item })).toMatch(/at most/i);
    expect(e.validate(ctx)).toEqual([]);
  });

  it('sets the call with the call tool (position ignored)', () => {
    const e = fresh();
    expect(e.place('call', 0, 0, {})).toMatch(/call type/i);
    expect(e.place('call', 9999, 9999, { typeId: callType, priority: '2' })).toBeNull();
    expect(e.doc.call).toEqual({ typeId: callType, priority: 2 });
    expect(e.place('call', 0, 0, { typeId: callType })).toBeNull();
    expect(e.doc.call?.priority).toBe(2); // keeps the old priority when none is given
  });
});

describe('EditorState edit', () => {
  function loaded(): EditorState {
    const e = fresh();
    e.place('npc', 100, 200, { profile });
    e.place('vehicle', 120, 200, { modelId: model });
    e.place('evidence', 100, 230, { item });
    e.setCall(callType, 2);
    return e;
  }

  it('moves the selected object and pulls a far target back onto the 150 m circle', () => {
    const e = loaded();
    e.selectIndex('vehicle', 0);
    e.move(130, 210);
    expect(e.doc.vehicles[0]).toMatchObject({ x: 130, z: 210 });
    e.move(100 + 1000, 200);
    const v = e.doc.vehicles[0];
    expect(Math.hypot((v?.x ?? 0) - 100, (v?.z ?? 0) - 200)).toBeCloseTo(SCENARIO_LIMITS.radiusM, 6);
    expect(e.validate(ctx)).toEqual([]);
    e.move(Number.NaN, 0);
    expect(Number.isFinite(e.doc.vehicles[0]?.x)).toBe(true);
  });

  it('does not move the call or move with nothing selected', () => {
    const e = loaded();
    const before = exportScenario(e.doc);
    e.select(0, 0, 0.001);
    e.move(50, 50);
    expect(exportScenario(e.doc)).toBe(before);
    e.selectIndex('call', 0);
    e.move(50, 50);
    expect(exportScenario(e.doc)).toBe(before);
    expect(e.doc.anchor).toEqual({ x: 100, z: 200 });
  });

  it('rotates people and vehicles and wraps the angle', () => {
    const e = loaded();
    e.selectIndex('npc', 0);
    e.rotate(Math.PI / 2);
    expect(e.doc.npcs[0]?.yaw).toBeCloseTo(Math.PI / 2, 9);
    e.rotate(Math.PI);
    expect(e.doc.npcs[0]?.yaw).toBeCloseTo(-Math.PI / 2, 9);
    e.selectIndex('evidence', 0);
    e.rotate(1);
    expect(e.doc.evidence[0]).not.toHaveProperty('yaw');
    expect(wrapYaw(3 * Math.PI)).toBeCloseTo(Math.PI, 9);
    expect(wrapYaw(Number.NaN)).toBe(0);
  });

  it('selects the nearest object within the radius and clears the selection on a miss', () => {
    const e = loaded();
    e.select(101, 201, 5);
    expect(e.selected).toEqual({ kind: 'npc', index: 0 });
    e.select(121, 200, 5);
    expect(e.selected).toEqual({ kind: 'vehicle', index: 0 });
    e.select(100, 231, 3);
    expect(e.selected).toEqual({ kind: 'evidence', index: 0 });
    e.select(-500, -500, 5);
    expect(e.selected).toBeNull();
  });

  it('selects the call at the anchor when nothing else is closer, and a person wins an exact tie', () => {
    const e = fresh();
    e.setCall(callType, 3);
    e.select(100, 200, 4);
    expect(e.selected).toEqual({ kind: 'call', index: 0 });
    e.place('npc', 100, 200, { profile });
    e.select(100, 200, 4);
    expect(e.selected).toEqual({ kind: 'npc', index: 0 });
  });

  it('removes the selected object; removing the call clears it', () => {
    const e = loaded();
    e.selectIndex('npc', 0);
    e.remove();
    expect(e.doc.npcs).toHaveLength(0);
    expect(e.selected).toBeNull();
    e.selectIndex('call', 0);
    e.remove();
    expect(e.doc.call).toBeNull();
    e.remove(); // nothing selected: no-op
    expect(e.doc.vehicles).toHaveLength(1);
  });

  it('edits the properties of the selected object', () => {
    const e = loaded();
    e.selectIndex('npc', 0);
    expect(e.setProps({ role: 'victim', hidden: true, weapon })).toBeNull();
    expect(e.doc.npcs[0]).toMatchObject({ role: 'victim', hidden: true, weapon });
    expect(e.setProps({ role: '1 2' })).toMatch(/role/i);
    expect(e.setProps({ weapon: '' })).toBeNull();
    expect(e.doc.npcs[0]?.weapon).toBeNull();
    e.selectIndex('vehicle', 0);
    expect(e.setProps({ modelId: '' })).toMatch(/model/i);
    e.selectIndex('evidence', 0);
    expect(e.setProps({ concealed: true })).toBeNull();
    expect(e.doc.evidence[0]?.concealed).toBe(true);
    e.select(-999, -999, 1);
    expect(e.setProps({ role: 'x' })).toMatch(/nothing selected/i);
  });

  it('sets name, description, id, call and environment', () => {
    const e = fresh();
    e.setMeta('x'.repeat(100), 'y'.repeat(500));
    expect(e.doc.name).toHaveLength(60);
    expect(e.doc.description).toHaveLength(400);
    expect(e.setId('Bad Id')).not.toBeNull();
    expect(e.doc.id).toBe('test-scenario');
    expect(e.setId('my-scenario')).toBeNull();
    expect(e.doc.id).toBe('my-scenario');
    e.setEnvironment(26.7, 'rain');
    expect(e.doc.timeOfDay).toBe(23);
    expect(e.doc.weather).toBe('rain');
    e.setEnvironment(null, '');
    expect(e.doc.timeOfDay).toBeNull();
    expect(e.doc.weather).toBeNull();
    e.setCall(callType, 4);
    expect(e.doc.call).toEqual({ typeId: callType, priority: 4 });
    e.setCall(null, 4);
    expect(e.doc.call).toBeNull();
  });

  it('bumps the revision on every change', () => {
    const e = fresh();
    const r0 = e.revision;
    e.place('npc', 100, 200, { profile });
    const r1 = e.revision;
    expect(r1).toBeGreaterThan(r0);
    e.move(101, 201);
    expect(e.revision).toBeGreaterThan(r1);
    const r2 = e.revision;
    e.place('npc', 100, 200, {}); // refused: unchanged
    expect(e.revision).toBe(r2);
  });

  it('copies the document it is given', () => {
    const doc = blankScenario('copy-test', { x: 0, z: 0 });
    const e = new EditorState(doc);
    e.place('npc', 1, 1, { profile });
    expect(doc.npcs).toHaveLength(0);
  });
});

describe('EditorState validate', () => {
  it('reports unknown references with the parser messages', () => {
    const e = fresh();
    e.place('npc', 100, 200, { profile: 'no-such-profile' });
    e.place('vehicle', 100, 200, { modelId: 'no-such-model' });
    e.setCall('no-such-call', 3);
    e.setEnvironment(5, 'no-such-weather');
    const errors = e.validate(ctx);
    expect(errors.join('\n')).toContain('npcs[0].profile: unknown profile "no-such-profile"');
    expect(errors.join('\n')).toContain('vehicles[0].modelId');
    expect(errors.join('\n')).toContain('call.typeId');
    expect(errors.join('\n')).toContain('weather');
  });

  it('reports a bad id and an empty name', () => {
    const e = fresh();
    e.doc.id = 'X';
    e.setMeta('', '');
    const errors = e.validate(ctx);
    expect(errors.some((l) => l.startsWith('id:'))).toBe(true);
    expect(errors.some((l) => l.startsWith('name:'))).toBe(true);
  });

  it('accepts every shipped sample scenario', () => {
    for (const s of SAMPLE_SCENARIOS) expect(new EditorState(s).validate(ctx)).toEqual([]);
  });
});

describe('export and import', () => {
  it('round-trips through exportScenario and parseSandboxScenario', () => {
    const e = fresh();
    e.place('npc', 105, 210, { profile, role: 'suspect', weapon, hidden: true, yaw: '1' });
    e.place('vehicle', 95, 190, { modelId: model, yaw: '-2' });
    e.place('evidence', 100, 200, { item, concealed: true });
    e.setCall(callType, 1);
    e.setEnvironment(22, ctx.weatherKinds[0] ?? null);
    e.setMeta('Alley stop', 'A short test');
    const text = e.exportJson();
    const r = parseSandboxScenario(JSON.parse(text), ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(exportScenario(r.value)).toBe(text);
    const back = importScenarioText(text, text.length, ctx);
    expect(back.ok).toBe(true);
    if (back.ok) expect(new EditorState(back.value).doc).toEqual(e.doc);
  });

  it('shows errors for bad files and never throws', () => {
    const bad = importScenarioText('{ not json', 10, ctx);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0]).toMatch(/not valid json/i);
    const wrong = importScenarioText('{"format":"nope"}', 17, ctx);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.errors.length).toBeGreaterThan(0);
    const big = importScenarioText('{}', IMPORT_MAX_BYTES + 1, ctx);
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.errors[0]).toMatch(/limit/i);
    for (const junk of ['null', '[]', '12', '"x"']) expect(importScenarioText(junk, junk.length, ctx).ok).toBe(false);
  });

  it('clones a scenario without sharing arrays', () => {
    const s = SAMPLE_SCENARIOS[0];
    if (!s) throw new Error('no sample');
    const c = cloneScenario(s);
    expect(c).toEqual(s);
    c.npcs.push(c.npcs[0] ?? { x: 0, z: 0, yaw: 0, profile, role: 'x', weapon: null, hidden: false });
    expect(s.npcs.length).toBeLessThan(c.npcs.length);
  });
});

class FakeStorage {
  readonly data = new Map<string, string>();
  fail = false;
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.fail) throw new Error('quota');
    this.data.set(key, value);
  }
}

describe('scenario library', () => {
  function doc(id: string, name = id) {
    const e = new EditorState(blankScenario(id, { x: 0, z: 0 }));
    e.setMeta(name, '');
    e.place('npc', 5, 5, { profile });
    return e.doc;
  }

  it('round-trips a scenario through a fake Storage', () => {
    const st = new FakeStorage();
    expect(libraryList(st)).toEqual([]);
    expect(librarySave(st, doc('first-one', 'First'))).toBeNull();
    expect(librarySave(st, doc('second-one', 'Second'))).toBeNull();
    expect(libraryList(st)).toEqual([
      { id: 'first-one', name: 'First' },
      { id: 'second-one', name: 'Second' },
    ]);
    const loaded = libraryLoad(st, 'second-one', ctx);
    expect(loaded).toEqual(doc('second-one', 'Second'));
    expect(libraryLoad(st, 'missing', ctx)).toBeNull();
    expect(st.data.has(LIBRARY_KEY)).toBe(true);
  });

  it('replaces a scenario with the same id instead of adding one', () => {
    const st = new FakeStorage();
    librarySave(st, doc('same-id', 'Old'));
    librarySave(st, doc('same-id', 'New'));
    expect(libraryList(st)).toEqual([{ id: 'same-id', name: 'New' }]);
  });

  it('keeps at most 32 scenarios and says so', () => {
    const st = new FakeStorage();
    for (let i = 0; i < LIBRARY_LIMIT; i++) expect(librarySave(st, doc(`scenario-${String(i).padStart(2, '0')}`))).toBeNull();
    expect(librarySave(st, doc('one-too-many'))).toMatch(/full/i);
    expect(libraryList(st)).toHaveLength(LIBRARY_LIMIT);
    // Replacing an existing one still works when full.
    expect(librarySave(st, doc('scenario-00', 'Renamed'))).toBeNull();
    expect(libraryRemove(st, 'scenario-01')).toBe(true);
    expect(librarySave(st, doc('one-too-many'))).toBeNull();
  });

  it('survives missing, broken and refusing storage', () => {
    expect(libraryList(null)).toEqual([]);
    expect(librarySave(null, doc('no-storage'))).toMatch(/not available/i);
    expect(libraryLoad(null, 'x', ctx)).toBeNull();
    expect(libraryRemove(null, 'x')).toBe(false);
    const st = new FakeStorage();
    st.data.set(LIBRARY_KEY, '{ broken');
    expect(libraryList(st)).toEqual([]);
    st.data.set(LIBRARY_KEY, JSON.stringify([1, 'x', null, { id: 'ok-one', name: 'Ok' }, { id: 5 }]));
    expect(libraryList(st)).toEqual([{ id: 'ok-one', name: 'Ok' }]);
    expect(libraryLoad(st, 'ok-one', ctx)).toBeNull(); // listed but no longer a valid scenario
    const full = new FakeStorage();
    full.fail = true;
    expect(librarySave(full, doc('refused'))).toMatch(/could not write/i);
  });
});
