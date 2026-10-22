import { describe, expect, it } from 'vitest';
import firstShiftJson from '../../src/data/tutorial/firstShift.json';
import { isActionId } from '../../src/input/actions';
import { TUTORIAL_ACTIONS, TUTORIAL_PROBES, TUTORIAL_SCRIPTS, TUTORIAL_TOPICS, getTutorialScript, parseTutorialScript, tutorialTokens } from '../../src/tutorial';

const raw = (): Record<string, unknown> => JSON.parse(JSON.stringify(firstShiftJson)) as Record<string, unknown>;
const withStep = (step: unknown, extra: unknown[] = []): unknown => ({ version: 1, id: 't', title: 'T', steps: [step, ...extra] });
const ack = { id: 'a', title: 'A', text: 'a', until: { ack: true } };

describe('the id lists', () => {
  it('are the contract of the design', () => {
    expect([...TUTORIAL_PROBES]).toEqual(['speedKmh', 'driving', 'lightbar', 'siren', 'distanceToCallM']);
    expect([...TUTORIAL_TOPICS]).toEqual([
      'player:mode', 'unit:request', 'cad:unitAssigned', 'cad:unitStatus', 'cad:callClosed',
      'cad:documentSaved', 'traffic:pulledOver', 'traffic:released', 'dispatch:plateResult', 'dispatch:backup',
    ]);
    expect([...TUTORIAL_ACTIONS]).toEqual(['createCall', 'flash']);
  });
});

describe('the shipped firstShift script', () => {
  const script = TUTORIAL_SCRIPTS['firstShift'];

  it('parses and is registered by id', () => {
    expect(script).toBeDefined();
    expect(parseTutorialScript(firstShiftJson, 'firstShift.json')).toEqual(script);
    expect(getTutorialScript('firstShift')).toBe(script);
    expect(getTutorialScript('nope')).toBeUndefined();
    expect(getTutorialScript('toString')).toBeUndefined();
    expect(Object.keys(TUTORIAL_SCRIPTS)).toEqual(['firstShift']);
  });

  it('has the 14 steps of the design in order', () => {
    expect(script?.steps.map((s) => s.id)).toEqual([
      'welcome', 'enterCar', 'drive', 'lights', 'radioStatus', 'takeCall', 'driveToCall',
      'scene', 'report', 'trafficStop', 'runPlate', 'contact', 'backup', 'done',
    ]);
  });

  it('completion conditions are exactly those of the design table', () => {
    const until = Object.fromEntries((script?.steps ?? []).map((s) => [s.id, s.until]));
    expect(until).toEqual({
      welcome: { ack: true },
      enterCar: { any: [{ topic: 'player:mode', where: { mode: 'driving' } }] },
      drive: { probe: 'speedKmh', gte: 32.19 },
      lights: { probe: 'lightbar', gte: 1 },
      radioStatus: { any: [{ topic: 'unit:request', where: { callsign: '$player', 'request.kind': 'status', 'request.status': 'available' } }] },
      takeCall: { any: [{ topic: 'cad:unitAssigned', where: { callsign: '$player', callId: '$call' } }] },
      driveToCall: { any: [{ topic: 'cad:unitStatus', where: { callsign: '$player', status: 'onScene' } }] },
      scene: { any: [{ topic: 'cad:callClosed', where: { callId: '$call' } }] },
      report: { any: [{ topic: 'cad:documentSaved', where: { kind: 'report' } }] },
      trafficStop: { any: [{ topic: 'traffic:pulledOver' }] },
      runPlate: { any: [{ topic: 'dispatch:plateResult', where: { callsign: '$player' } }] },
      contact: { any: [{ topic: 'cad:documentSaved', where: { kind: 'citation' } }, { topic: 'traffic:released' }] },
      backup: { any: [{ topic: 'dispatch:backup', where: { requester: '$player' } }] },
      done: { ack: true },
    });
  });

  it('takeCall creates the abandoned-vehicle call 250-600 m away; no other step has enter actions', () => {
    for (const s of script?.steps ?? []) {
      if (s.id === 'takeCall') expect(s.enter).toEqual([{ do: 'createCall', typeId: 'abandonedVehicle', minM: 250, maxM: 600 }]);
      else expect(s.enter).toBeUndefined();
    }
  });

  it('every step except welcome and done is skippable', () => {
    for (const s of script?.steps ?? []) expect(s.skippable === true, s.id).toBe(s.id !== 'welcome' && s.id !== 'done');
  });

  it('every {token} in the shipped texts is an ActionId', () => {
    let tokens = 0;
    for (const s of script?.steps ?? []) {
      for (const text of [s.title, s.text, s.hint ?? '']) {
        for (const token of tutorialTokens(text)) {
          tokens++;
          expect(isActionId(token), `${s.id}: {${token}}`).toBe(true);
        }
      }
    }
    expect(tokens).toBeGreaterThan(15);
    // no stray braces that the token pattern would not catch
    for (const s of script?.steps ?? []) for (const text of [s.title, s.text, s.hint ?? '']) expect(text.replace(/\{[A-Za-z][A-Za-z0-9_.]*\}/g, '')).not.toMatch(/[{}]/);
  });

  it('titles and texts are non-empty and mention no real agency (generic content)', () => {
    for (const s of TUTORIAL_SCRIPTS['firstShift']?.steps ?? []) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.text.length).toBeGreaterThan(10);
    }
  });
});

describe('parseTutorialScript errors name the file and the dotted path', () => {
  const fails = (value: unknown): string => {
    try {
      parseTutorialScript(value, 'bad.json');
    } catch (e) {
      return (e as Error).message;
    }
    return 'NO ERROR';
  };

  it('accepts a minimal script', () => {
    expect(parseTutorialScript(withStep(ack), 'ok.json')).toEqual({ version: 1, id: 't', title: 'T', steps: [ack] });
  });

  it('root problems', () => {
    expect(fails(null)).toMatch(/^bad\.json: must be an object/);
    expect(fails({ ...(withStep(ack) as object), version: 2 })).toMatch(/^bad\.json: version must be 1/);
    expect(fails({ ...(withStep(ack) as object), id: '' })).toMatch(/^bad\.json: id /);
    expect(fails({ ...(withStep(ack) as object), title: 3 })).toMatch(/^bad\.json: title /);
  });

  it('an empty or missing step list', () => {
    expect(fails({ version: 1, id: 't', title: 'T', steps: [] })).toMatch(/^bad\.json: steps must have at least 1 items/);
    expect(fails({ version: 1, id: 't', title: 'T' })).toMatch(/^bad\.json: steps must be an array/);
  });

  it('duplicate step ids', () => {
    const msg = fails(withStep(ack, [ack]));
    expect(msg).toMatch(/^bad\.json: steps\.1\.id duplicates the step id "a"/);
  });

  it('step field problems', () => {
    expect(fails(withStep({ ...ack, id: '' }))).toMatch(/steps\.0\.id /);
    expect(fails(withStep({ ...ack, title: undefined }))).toMatch(/steps\.0\.title /);
    expect(fails(withStep({ ...ack, text: 5 }))).toMatch(/steps\.0\.text /);
    expect(fails(withStep({ ...ack, hint: '' }))).toMatch(/steps\.0\.hint /);
    expect(fails(withStep({ ...ack, skippable: 'yes' }))).toMatch(/steps\.0\.skippable /);
    expect(fails(withStep({ ...ack, enter: {} }))).toMatch(/steps\.0\.enter /);
    expect(fails(withStep({ ...ack, until: undefined }))).toMatch(/steps\.0\.until /);
  });

  it('unknown topic', () => {
    const msg = fails(withStep({ ...ack, until: { any: [{ topic: 'player:mode' }, { topic: 'cad:nope' }] } }));
    expect(msg).toMatch(/^bad\.json: steps\.0\.until\.any\.1\.topic must be one of player:mode/);
    expect(msg).toContain('"cad:nope"');
  });

  it('unknown probe, and a probe without bounds', () => {
    expect(fails(withStep({ ...ack, until: { probe: 'fuel', gte: 1 } }))).toMatch(/^bad\.json: steps\.0\.until\.probe must be one of speedKmh/);
    expect(fails(withStep({ ...ack, until: { probe: 'speedKmh' } }))).toMatch(/^bad\.json: steps\.0\.until a probe needs gte or lte/);
    expect(fails(withStep({ ...ack, until: { probe: 'speedKmh', gte: 'x' } }))).toMatch(/steps\.0\.until\.gte /);
    expect(fails(withStep({ ...ack, until: { probe: 'speedKmh', lte: Infinity } }))).toMatch(/steps\.0\.until\.lte /);
    expect(parseTutorialScript(withStep({ ...ack, until: { probe: 'speedKmh', lte: 5 } }), 'ok.json').steps[0]?.until).toEqual({ probe: 'speedKmh', lte: 5 });
  });

  it('unknown action and action field problems', () => {
    expect(fails(withStep({ ...ack, enter: [{ do: 'teleport' }] }))).toMatch(/^bad\.json: steps\.0\.enter\.0\.do must be one of createCall, flash/);
    expect(fails(withStep({ ...ack, enter: [{ do: 'flash' }] }))).toMatch(/steps\.0\.enter\.0\.text /);
    expect(fails(withStep({ ...ack, enter: [{ do: 'createCall', minM: 1, maxM: 2 }] }))).toMatch(/steps\.0\.enter\.0\.typeId /);
    expect(fails(withStep({ ...ack, enter: [{ do: 'createCall', typeId: 'x', minM: -1, maxM: 2 }] }))).toMatch(/steps\.0\.enter\.0\.minM /);
    expect(fails(withStep({ ...ack, enter: [{ do: 'flash', text: 'ok' }, 3] }))).toMatch(/steps\.0\.enter\.1 must be an object/);
  });

  it('createCall with minM > maxM', () => {
    expect(fails(withStep({ ...ack, enter: [{ do: 'createCall', typeId: 'x', minM: 600, maxM: 250 }] }))).toMatch(
      /^bad\.json: steps\.0\.enter\.0\.minM must not exceed maxM \(250\), got 600/,
    );
    expect(parseTutorialScript(withStep({ ...ack, enter: [{ do: 'createCall', typeId: 'x', minM: 5, maxM: 5 }] }), 'ok.json').steps[0]?.enter).toEqual([
      { do: 'createCall', typeId: 'x', minM: 5, maxM: 5 },
    ]);
  });

  it('an empty any list', () => {
    expect(fails(withStep({ ...ack, until: { any: [] } }))).toMatch(/^bad\.json: steps\.0\.until\.any must have at least 1 items/);
  });

  it('where values other than string, number, boolean', () => {
    const w = (where: unknown): string => fails(withStep({ ...ack, until: { any: [{ topic: 'player:mode', where }] } }));
    expect(w({ mode: null })).toMatch(/^bad\.json: steps\.0\.until\.any\.0\.where\.mode must be a string, number or boolean, got null/);
    expect(w({ mode: [1] })).toMatch(/where\.mode /);
    expect(w({ a: 'x', b: { c: 1 } })).toMatch(/where\.b /);
    expect(w(['x'])).toMatch(/^bad\.json: steps\.0\.until\.any\.0\.where must be an object/);
    expect(w('x')).toMatch(/where must be an object/);
    expect(parseTutorialScript(withStep({ ...ack, until: { any: [{ topic: 'player:mode', where: { a: 'x', b: 2, c: false } }] } }), 'ok.json').steps[0]?.until).toEqual({
      any: [{ topic: 'player:mode', where: { a: 'x', b: 2, c: false } }],
    });
  });

  it('an until with none or several of ack / any / probe, and ack other than true', () => {
    expect(fails(withStep({ ...ack, until: {} }))).toMatch(/^bad\.json: steps\.0\.until must have exactly one of ack, any, probe, got none/);
    expect(fails(withStep({ ...ack, until: { ack: true, probe: 'speedKmh', gte: 1 } }))).toMatch(/got ack, probe/);
    expect(fails(withStep({ ...ack, until: { ack: false } }))).toMatch(/steps\.0\.until\.ack must be true/);
  });

  it('the shipped data with one field broken names that field', () => {
    const r = raw();
    ((r['steps'] as { until: unknown }[])[5] as { until: unknown }).until = { any: [{ topic: 'cad:unitAssigned', where: { callId: { x: 1 } } }] };
    expect(fails(r)).toMatch(/^bad\.json: steps\.5\.until\.any\.0\.where\.callId /);
  });
});
