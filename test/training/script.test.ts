import { describe, expect, it } from 'vitest';
import {
  BUILTIN_SCRIPTS,
  ScriptRunner,
  defaultScriptContext,
  isScriptRunSave,
  parseDispatchScript,
  type DispatchScript,
  type DispatchScriptStep,
} from '../../src/training/script';

function base(): Record<string, unknown> {
  return {
    format: 'patrol-dispatch-script',
    version: 1,
    id: 'test-script',
    name: 'Test script',
    description: 'A test.',
    generator: 'off',
    durationS: 600,
    steps: [
      { atS: 10, typeId: 'noiseComplaint', priority: 3, near: { district: 'downtown' }, narrative: 'Loud.', radio: 'Units.' },
      { atS: 20, typeId: 'alarm', near: { poi: 'school' } },
      { atS: 30, typeId: 'welfareCheck', priority: null, near: { x: 100, z: -200 }, narrative: null, radio: null },
    ],
  };
}

function errorsOf(json: unknown): string[] {
  const r = parseDispatchScript(json);
  if (r.ok) throw new Error('expected errors');
  return r.errors;
}

function withStep(patch: Record<string, unknown>, i = 0): Record<string, unknown> {
  const b = base();
  const steps = (b.steps as Record<string, unknown>[]).map((s, j) => (j === i ? { ...s, ...patch } : s));
  return { ...b, steps };
}

describe('parseDispatchScript', () => {
  it('accepts a valid script and fills the optional step fields with null', () => {
    const r = parseDispatchScript(base());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.steps[0]).toEqual({ atS: 10, typeId: 'noiseComplaint', priority: 3, near: { district: 'downtown' }, narrative: 'Loud.', radio: 'Units.' });
    expect(r.value.steps[1]).toEqual({ atS: 20, typeId: 'alarm', priority: null, near: { poi: 'school' }, narrative: null, radio: null });
    expect(r.value.steps[2]?.near).toEqual({ x: 100, z: -200 });
  });

  it('names the path of an unknown call type', () => {
    expect(errorsOf(withStep({ typeId: 'barFightt' }, 0))).toContain('steps[0].typeId: unknown call type "barFightt"');
    const e = errorsOf(withStep({ typeId: 'x' }, 2));
    expect(e).toEqual(['steps[2].typeId: unknown call type "x"']);
  });

  it('checks the header fields', () => {
    expect(errorsOf({ ...base(), format: 'other' })[0]).toContain('format');
    expect(errorsOf({ ...base(), version: 2 })[0]).toContain('version');
    expect(errorsOf({ ...base(), id: 'Bad Id' })[0]).toContain('id: must match');
    expect(errorsOf({ ...base(), id: 'a' })[0]).toContain('id: must match');
    expect(errorsOf({ ...base(), name: '' })[0]).toContain('name: length must be 1..60');
    expect(errorsOf({ ...base(), name: 'x'.repeat(61) })[0]).toContain('name');
    expect(errorsOf({ ...base(), description: 'x'.repeat(401) })[0]).toContain('description');
    expect(errorsOf({ ...base(), generator: 'maybe' })[0]).toContain('generator');
    expect(errorsOf({ ...base(), durationS: 59 })[0]).toContain('durationS');
    expect(errorsOf({ ...base(), durationS: 7201 })[0]).toContain('durationS');
    expect(errorsOf({ ...base(), durationS: Number.NaN })[0]).toContain('durationS');
  });

  it('checks the step list', () => {
    expect(errorsOf({ ...base(), steps: [] })[0]).toContain('steps: must have 1..100');
    expect(errorsOf({ ...base(), steps: 'x' })[0]).toContain('steps: must be an array');
    const many = Array.from({ length: 101 }, (_, i) => ({ atS: i, typeId: 'alarm', near: { district: 'downtown' } }));
    expect(errorsOf({ ...base(), steps: many })[0]).toContain('steps: must have 1..100');
    expect(errorsOf(withStep({ atS: 601 }, 2))).toContain('steps[2].atS: must be in [0, 600], got 601');
    expect(errorsOf(withStep({ atS: -1 }, 0))[0]).toContain('steps[0].atS');
    expect(errorsOf(withStep({ atS: 5 }, 1))).toContain('steps[1].atS: steps must be sorted by atS, 5 is before 10');
    expect(errorsOf({ ...base(), steps: [3] })[0]).toContain('steps[0]: must be an object');
  });

  it('checks priority, near, narrative and radio', () => {
    expect(errorsOf(withStep({ priority: 5 }))[0]).toContain('steps[0].priority');
    expect(errorsOf(withStep({ near: { poi: 'moon' } }))[0]).toBe('steps[0].near.poi: unknown point of interest "moon"');
    expect(errorsOf(withStep({ near: { district: 'atlantis' } }))[0]).toBe('steps[0].near.district: unknown district "atlantis"');
    expect(errorsOf(withStep({ near: { x: 4000, z: 0 } }))[0]).toContain('steps[0].near.x');
    expect(errorsOf(withStep({ near: { x: 0 } }))[0]).toContain('steps[0].near.z');
    expect(errorsOf(withStep({ near: {} }))[0]).toBe('steps[0].near: must hold poi, district or x and z');
    expect(errorsOf(withStep({ near: 'downtown' }))[0]).toContain('steps[0].near: must be an object');
    expect(errorsOf(withStep({ narrative: 'x'.repeat(281) }))[0]).toContain('steps[0].narrative');
    expect(errorsOf(withStep({ radio: 'x'.repeat(161) }))[0]).toContain('steps[0].radio');
  });

  it('treats unknown keys as errors', () => {
    expect(errorsOf({ ...base(), extra: 1 })).toEqual(['extra: unknown field']);
    expect(errorsOf(withStep({ colour: 'red' }, 1))).toEqual(['steps[1].colour: unknown field']);
    expect(errorsOf(withStep({ near: { district: 'downtown', x: 1 } }, 1))).toEqual(['steps[1].near.x: unknown field']);
  });

  it('reports several errors at once', () => {
    const e = errorsOf({ ...withStep({ typeId: 'nope' }, 0), name: '', generator: 'x' });
    expect(e.length).toBe(3);
  });

  it('never throws on hostile input', () => {
    const inputs: unknown[] = [null, undefined, 5, 'x', [], {}, { steps: null }, { ...base(), steps: [null, undefined, [], 'x'] }, JSON.parse('{"__proto__": {"a": 1}}')];
    for (const input of inputs) {
      expect(() => parseDispatchScript(input)).not.toThrow();
      expect(parseDispatchScript(input).ok).toBe(false);
    }
    const cyc: Record<string, unknown> = { ...base() };
    cyc.self = cyc;
    expect(parseDispatchScript(cyc).ok).toBe(false);
    const throwing = { ...base(), get steps(): unknown { throw new Error('boom'); } };
    const r = parseDispatchScript(throwing);
    expect(r.ok).toBe(false);
  });

  it('uses a custom context', () => {
    const ctx = { callTypeIds: new Set(['only']), poiKinds: ['park'], districts: ['x'] };
    const r = parseDispatchScript({ ...base(), steps: [{ atS: 0, typeId: 'only', near: { poi: 'park' } }] }, ctx);
    expect(r.ok).toBe(true);
    expect(parseDispatchScript(base(), ctx).ok).toBe(false);
  });

  it('default context knows the game ids', () => {
    const ctx = defaultScriptContext();
    expect(ctx.callTypeIds.has('noiseComplaint')).toBe(true);
    expect(ctx.poiKinds).toContain('hospital');
    expect(ctx.districts).toContain('downtown');
  });
});

describe('built-in scripts', () => {
  it('ships quiet-weekday, friday-night and multi-alarm with the specified shape', () => {
    expect(BUILTIN_SCRIPTS.map((s) => s.id)).toEqual(['friday-night', 'multi-alarm', 'quiet-weekday']);
    const by = (id: string): DispatchScript => BUILTIN_SCRIPTS.find((s) => s.id === id)!;
    expect(by('quiet-weekday')).toMatchObject({ generator: 'on', durationS: 1200 });
    expect(by('quiet-weekday').steps).toHaveLength(8);
    expect(by('friday-night')).toMatchObject({ generator: 'off', durationS: 1800 });
    expect(by('friday-night').steps).toHaveLength(22);
    expect(by('friday-night').steps.filter((s) => s.priority === 1)).toHaveLength(2);
    expect(by('multi-alarm')).toMatchObject({ generator: 'off', durationS: 600 });
    expect(by('multi-alarm').steps).toHaveLength(12);
    const districts = new Set(by('multi-alarm').steps.map((s) => ('district' in s.near ? s.near.district : '')));
    expect(districts.size).toBeGreaterThanOrEqual(3);
  });

  it('every built-in script validates again and round-trips through JSON', () => {
    for (const s of BUILTIN_SCRIPTS) {
      const r = parseDispatchScript(JSON.parse(JSON.stringify(s)));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toEqual(s);
    }
  });
});

describe('ScriptRunner', () => {
  function script(): DispatchScript {
    const r = parseDispatchScript(base());
    if (!r.ok) throw new Error('fixture');
    return r.value;
  }

  it('emits steps in order as time passes, across due calls', () => {
    const runner = new ScriptRunner(script());
    const out: DispatchScriptStep[] = [];
    expect(runner.due(1000, out)).toBe(0);
    expect(runner.finished).toBe(false);
    runner.start(100);
    expect(runner.due(105, out)).toBe(0);
    expect(runner.due(110, out)).toBe(1);
    expect(out.map((s) => s.atS)).toEqual([10]);
    expect(runner.due(112, out)).toBe(0);
    expect(runner.due(500, out)).toBe(2);
    expect(out.map((s) => s.atS)).toEqual([10, 20, 30]);
    expect(runner.finished).toBe(true);
    expect(runner.due(900, out)).toBe(0);
  });

  it('continues after a restore', () => {
    const a = new ScriptRunner(script());
    a.start(0);
    const out: DispatchScriptStep[] = [];
    a.due(15, out);
    const save = JSON.parse(JSON.stringify(a.serialize())) as ReturnType<ScriptRunner['serialize']>;
    expect(isScriptRunSave(save)).toBe(true);
    const b = new ScriptRunner(script(), save);
    const rest: DispatchScriptStep[] = [];
    expect(b.due(100, rest)).toBe(2);
    expect(rest.map((s) => s.atS)).toEqual([20, 30]);
    expect(b.finished).toBe(true);
    expect(b.serialize()).toEqual({ scriptId: 'test-script', startSim: 0, next: 3 });
  });

  it('ignores a save of another script and rejects malformed saves', () => {
    const r = new ScriptRunner(script(), { scriptId: 'other', startSim: 5, next: 2 });
    expect(r.serialize()).toEqual({ scriptId: 'test-script', startSim: -1, next: 0 });
    expect(isScriptRunSave({ scriptId: 'a', startSim: 'x', next: 0 })).toBe(false);
    expect(isScriptRunSave({ scriptId: 'a', startSim: 0, next: -1 })).toBe(false);
    expect(isScriptRunSave(null)).toBe(false);
  });

  it('due allocates nothing when nothing is due', () => {
    const runner = new ScriptRunner(script());
    runner.start(0);
    const out: DispatchScriptStep[] = [];
    for (let i = 0; i < 1000; i++) runner.due(5, out);
    expect(out).toHaveLength(0);
  });
});
