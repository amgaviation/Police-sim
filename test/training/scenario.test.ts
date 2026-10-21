import { describe, expect, it } from 'vitest';
import { createRng, type Rng } from '../../src/core/rng';
import {
  SAMPLE_SCENARIOS,
  defaultScenarioContext,
  exportScenario,
  isSandboxScenario,
  parseSandboxScenario,
  planScenario,
  type SandboxScenario,
  type SpawnOp,
} from '../../src/training/scenario';

function base(): Record<string, unknown> {
  return {
    format: 'patrol-scenario',
    version: 1,
    id: 'test-scenario',
    name: 'Test scenario',
    description: 'A test.',
    anchor: { x: 10, z: -20 },
    call: { typeId: 'fightInProgress', priority: 2 },
    npcs: [{ x: 12, z: -22, yaw: 1, profile: 'suspectAgitated', role: 'suspect', weapon: 'knife', hidden: false }],
    vehicles: [{ modelId: 'sedan', x: 15, z: -20, yaw: 0 }],
    evidence: [{ item: 'wallet', x: 11, z: -19, concealed: true }],
    timeOfDay: 22,
    weather: 'rain',
  };
}

function errorsOf(json: unknown): string[] {
  const r = parseSandboxScenario(json);
  if (r.ok) throw new Error('expected errors');
  return r.errors;
}

function patch(over: Record<string, unknown>): Record<string, unknown> {
  return { ...base(), ...over };
}

function parsed(json: unknown): SandboxScenario {
  const r = parseSandboxScenario(json);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.value;
}

describe('parseSandboxScenario', () => {
  it('validates the shipped samples', () => {
    expect(SAMPLE_SCENARIOS.map((s) => s.id).sort()).toEqual(['abandoned-car', 'parking-lot-fight']);
    for (const s of SAMPLE_SCENARIOS) expect(parseSandboxScenario(JSON.parse(JSON.stringify(s))).ok).toBe(true);
  });

  it('accepts a full scenario and a minimal one with no call, time or weather', () => {
    expect(parseSandboxScenario(base()).ok).toBe(true);
    const min = parsed(patch({ call: null, npcs: [], vehicles: [], evidence: [], timeOfDay: null, weather: null }));
    expect(min.call).toBeNull();
    expect(planScenario(min, 1, () => 0)).toEqual([]);
  });

  it('checks the header fields', () => {
    expect(errorsOf(patch({ format: 'x' }))[0]).toContain('format');
    expect(errorsOf(patch({ version: 2 }))[0]).toContain('version');
    expect(errorsOf(patch({ id: 'Bad' }))[0]).toContain('id: must match');
    expect(errorsOf(patch({ name: '' }))[0]).toContain('name');
    expect(errorsOf(patch({ description: 'x'.repeat(401) }))[0]).toContain('description');
    expect(errorsOf(patch({ anchor: { x: 4000, z: 0 } }))[0]).toContain('anchor.x');
    expect(errorsOf(patch({ anchor: 5 }))[0]).toContain('anchor: must be an object');
    expect(errorsOf(patch({ extra: true }))).toEqual(['extra: unknown field']);
  });

  it('checks the call', () => {
    expect(errorsOf(patch({ call: { typeId: 'nope', priority: 2 } }))).toEqual(['call.typeId: unknown call type "nope"']);
    expect(errorsOf(patch({ call: { typeId: 'alarm', priority: 5 } }))[0]).toContain('call.priority');
    expect(errorsOf(patch({ call: { typeId: 'alarm', priority: 2, x: 1 } }))).toEqual(['call.x: unknown field']);
    expect(errorsOf(patch({ call: 'alarm' }))[0]).toContain('call: must be an object or null');
  });

  it('checks npcs: profile, role, weapon, position within 150 m, hidden, unknown keys, cap 24', () => {
    const npc = (over: Record<string, unknown>): Record<string, unknown> => patch({ npcs: [{ ...(base().npcs as Record<string, unknown>[])[0], ...over }] });
    expect(errorsOf(npc({ profile: 'x' }))).toEqual(['npcs[0].profile: unknown profile "x"']);
    expect(errorsOf(npc({ role: 'sus pect' }))[0]).toContain('npcs[0].role');
    expect(errorsOf(npc({ role: '' }))[0]).toContain('npcs[0].role');
    expect(errorsOf(npc({ role: 'a'.repeat(25) }))[0]).toContain('npcs[0].role');
    expect(errorsOf(npc({ weapon: 'wallet' }))).toEqual(['npcs[0].weapon: unknown weapon "wallet"']);
    expect(errorsOf(npc({ x: 10 + 151, z: -20 }))[0]).toContain('npcs[0]: must be within 150 m of the anchor');
    expect(parseSandboxScenario(npc({ x: 10 + 149, z: -20 })).ok).toBe(true);
    expect(errorsOf(npc({ hidden: 'no' }))[0]).toContain('npcs[0].hidden');
    expect(errorsOf(npc({ yaw: Number.POSITIVE_INFINITY }))[0]).toContain('npcs[0].yaw');
    expect(errorsOf(npc({ shout: 1 }))).toEqual(['npcs[0].shout: unknown field']);
    const one = (base().npcs as Record<string, unknown>[])[0]!;
    expect(parseSandboxScenario(patch({ npcs: Array.from({ length: 24 }, () => one) })).ok).toBe(true);
    expect(errorsOf(patch({ npcs: Array.from({ length: 25 }, () => one) }))).toEqual(['npcs: at most 24 items, got 25']);
    expect(errorsOf(patch({ npcs: 'x' }))[0]).toContain('npcs: must be an array');
  });

  it('checks vehicles and evidence', () => {
    expect(errorsOf(patch({ vehicles: [{ modelId: 'hovercraft', x: 10, z: -20, yaw: 0 }] }))).toEqual(['vehicles[0].modelId: unknown vehicle model "hovercraft"']);
    const v = { modelId: 'sedan', x: 10, z: -20, yaw: 0 };
    expect(errorsOf(patch({ vehicles: Array.from({ length: 9 }, () => v) }))).toEqual(['vehicles: at most 8 items, got 9']);
    expect(errorsOf(patch({ vehicles: [{ ...v, z: 300 }] }))[0]).toContain('vehicles[0]: must be within 150 m');
    expect(errorsOf(patch({ evidence: [{ item: 'unicorn', x: 10, z: -20, concealed: false }] }))).toEqual(['evidence[0].item: unknown item "unicorn"']);
    const e = { item: 'wallet', x: 10, z: -20, concealed: false };
    expect(errorsOf(patch({ evidence: Array.from({ length: 25 }, () => e) }))).toEqual(['evidence: at most 24 items, got 25']);
    expect(errorsOf(patch({ evidence: [{ ...e, concealed: 1 }] }))[0]).toContain('evidence[0].concealed');
  });

  it('checks time of day and weather', () => {
    expect(errorsOf(patch({ timeOfDay: 24 }))[0]).toContain('timeOfDay');
    expect(errorsOf(patch({ timeOfDay: -1 }))[0]).toContain('timeOfDay');
    expect(errorsOf(patch({ weather: 'meteors' }))).toEqual(['weather: unknown weather "meteors"']);
  });

  it('never throws on hostile input', () => {
    for (const input of [null, undefined, 3, 'x', [], {}, { npcs: [null] }, patch({ npcs: [null, 3, [], 'x'] }), patch({ evidence: [undefined] })]) {
      expect(() => parseSandboxScenario(input)).not.toThrow();
      expect(parseSandboxScenario(input).ok).toBe(false);
    }
    const throwing = { ...base(), get npcs(): unknown { throw new Error('boom'); } };
    expect(parseSandboxScenario(throwing).ok).toBe(false);
  });

  it('isSandboxScenario mirrors the parser', () => {
    expect(isSandboxScenario(base())).toBe(true);
    expect(isSandboxScenario(patch({ id: 'X' }))).toBe(false);
  });

  it('default context knows the game ids', () => {
    const c = defaultScenarioContext();
    expect(c.callTypeIds.has('fightInProgress')).toBe(true);
    expect(c.profiles.has('suspectAgitated')).toBe(true);
    expect(c.vehicleModels.has('sedan')).toBe(true);
    expect(c.items.has('wallet')).toBe(true);
    expect(c.weapons.has('knife')).toBe(true);
    expect(c.weapons.has('wallet')).toBe(false);
    expect(c.weatherKinds).toContain('rain');
  });
});

describe('exportScenario', () => {
  it('writes canonical JSON that parses back to the same scenario', () => {
    for (const s of [...SAMPLE_SCENARIOS, parsed(base())]) {
      const text = exportScenario(s);
      expect(parseSandboxScenario(JSON.parse(text))).toEqual({ ok: true, value: s });
      expect(exportScenario(parsed(JSON.parse(text)))).toBe(text);
    }
  });

  it('orders keys in declaration order with 2-space indent', () => {
    const text = exportScenario(parsed(base()));
    expect(Object.keys(JSON.parse(text) as object)).toEqual(['format', 'version', 'id', 'name', 'description', 'anchor', 'call', 'npcs', 'vehicles', 'evidence', 'timeOfDay', 'weather']);
    expect(text.startsWith('{\n  "format": "patrol-scenario",')).toBe(true);
    // Shuffled input keys still export canonically.
    const shuffled = Object.fromEntries(Object.entries(base()).reverse());
    expect(exportScenario(parsed(shuffled))).toBe(text);
  });
});

describe('planScenario', () => {
  const scenario = (): SandboxScenario => parsed({ ...base(), npcs: [...(base().npcs as object[]), { x: 14, z: -18, yaw: 0, profile: 'bystander', role: 'witness', weapon: null, hidden: true }] });

  it('plans the environment first, then the call, vehicles, actors and evidence', () => {
    const ops = planScenario(scenario(), 7, (rng) => rng.nextInt(0, 99999));
    expect(ops.map((o) => o.op)).toEqual(['environment', 'call', 'vehicle', 'actor', 'actor', 'evidence']);
    expect(ops[0]).toEqual({ op: 'environment', hour: 22, weather: 'rain' });
    expect(ops[1]).toEqual({ op: 'call', typeId: 'fightInProgress', priority: 2, x: 10, z: -20 });
    const actors = ops.filter((o): o is Extract<SpawnOp, { op: 'actor' }> => o.op === 'actor');
    expect(actors.map((a) => a.index)).toEqual([0, 1]);
    expect(actors[0]).toMatchObject({ x: 12, z: -22, profile: 'suspectAgitated', role: 'suspect', weapon: 'knife', hidden: false });
    expect(actors[1]).toMatchObject({ profile: 'bystander', hidden: true, weapon: null });
  });

  it('is deterministic per seed, draws one person per actor from the sandbox stream', () => {
    const pick = (rng: Rng): number => rng.nextInt(0, 99999);
    const a = planScenario(scenario(), 7, pick);
    const b = planScenario(scenario(), 7, pick);
    const c = planScenario(scenario(), 8, pick);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    let calls = 0;
    const rng = createRng(7).stream('sandbox:test-scenario');
    const expected = [rng.nextInt(0, 99999), rng.nextInt(0, 99999)];
    const ops = planScenario(scenario(), 7, (r) => {
      calls++;
      return pick(r);
    });
    expect(calls).toBe(2);
    expect(ops.filter((o) => o.op === 'actor').map((o) => (o as { personId: number }).personId)).toEqual(expected);
  });

  it('the stream depends on the scenario id', () => {
    const pick = (rng: Rng): number => rng.nextInt(0, 99999);
    const other = parsed({ ...base(), id: 'other-scenario' });
    const first = planScenario(parsed(base()), 3, pick).find((o) => o.op === 'actor') as { personId: number };
    const second = planScenario(other, 3, pick).find((o) => o.op === 'actor') as { personId: number };
    expect(first.personId).not.toBe(second.personId);
  });
});
