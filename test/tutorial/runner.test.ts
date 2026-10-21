import { describe, expect, it } from 'vitest';
import { EventBus } from '../../src/core/events';
import type { EventMap } from '../../src/core/event-map';
import {
  INACTIVE_TUTORIAL_VIEW,
  TUTORIAL_SCRIPTS,
  TutorialRunner,
  isTutorialSave,
  newTutorialSave,
  parseTutorialScript,
  type TutorialSave,
} from '../../src/tutorial';
import { FIRST_SHIFT_BEATS, FakePorts, PLAYER, attach, drive, makeRig } from './rig';

const SCRIPT = TUTORIAL_SCRIPTS['firstShift'];
if (!SCRIPT) throw new Error('firstShift missing');
const IDS = SCRIPT.steps.map((s) => s.id);

/** A tiny script for focused tests. */
function mini(steps: unknown[]) {
  return parseTutorialScript({ version: 1, id: 'mini', title: 'Mini', steps }, 'mini.json');
}

describe('TutorialRunner: the whole firstShift', () => {
  it('reaches done with 14 tutorial:step events and one tutorial:done completed', () => {
    const r = makeRig();
    r.tick(); // announces the first step
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]).toEqual({ scriptId: 'firstShift', index: 0, id: 'welcome', count: 14 });
    expect(r.runner.view.active).toBe(true);
    drive(r);
    expect(r.steps.map((s) => s.id)).toEqual(IDS);
    expect(r.steps.map((s) => s.index)).toEqual(IDS.map((_, i) => i));
    expect(r.steps.every((s) => s.count === 14 && s.scriptId === 'firstShift')).toBe(true);
    expect(r.done).toEqual([{ scriptId: 'firstShift', completed: true, skipped: 0 }]);
    const v = r.runner.view;
    expect(v).toMatchObject({ active: false, done: true, completed: true, index: 14, count: 14, step: null, scriptId: 'firstShift' });
    const save = r.runner.serialize();
    expect(save).toMatchObject({ done: true, completed: true, index: 14, queue: [], pending: [], skipped: [] });
    expect(isTutorialSave(save)).toBe(true);
    r.tick(50);
    r.runner.ack();
    r.tick(2);
    expect(r.done).toHaveLength(1);
    expect(r.steps).toHaveLength(14);
  });

  it('each beat completes exactly its own step (no step is skipped by an earlier event)', () => {
    const r = makeRig();
    r.tick();
    FIRST_SHIFT_BEATS.forEach((beat, i) => {
      expect(r.runner.view.step?.id ?? 'end').toBe(beat.id);
      expect(r.runner.view.index).toBe(i);
      beat.run(r, 700);
    });
    expect(r.runner.view.done).toBe(true);
  });

  it('createCall runs on entering takeCall with the scripted arguments and binds the call', () => {
    const r = makeRig();
    drive(r, 4);
    expect(r.runner.view.step?.id).toBe('radioStatus');
    expect(r.ports.created).toEqual([]);
    FIRST_SHIFT_BEATS[4]?.run(r, 700);
    expect(r.ports.created).toEqual([{ typeId: 'abandonedVehicle', minM: 250, maxM: 600 }]);
    expect(r.runner.serialize().callId).toBe(700);
  });

  it('the skipped count of a run with skips is reported in tutorial:done', () => {
    const r = makeRig();
    r.runner.ack();
    r.tick();
    for (let i = 0; i < 12; i++) {
      r.runner.skip();
      r.tick();
    }
    expect(r.runner.view.step?.id).toBe('done');
    r.runner.ack();
    r.tick();
    expect(r.done).toEqual([{ scriptId: 'firstShift', completed: true, skipped: 12 }]);
    expect(r.runner.serialize().skipped).toEqual(IDS.slice(1, 13));
  });
});

describe('TutorialRunner: $player and $call', () => {
  function atTakeCall() {
    const r = makeRig();
    drive(r, 5);
    r.tick(); // enter takeCall (drive() above already stepped through radioStatus)
    return r;
  }

  it('an assignment to another call does not complete takeCall; the bound call does', () => {
    const r = atTakeCall();
    expect(r.runner.view.step?.id).toBe('takeCall');
    r.send('cad:unitAssigned', { callId: 12, callsign: PLAYER, by: 'dispatch' });
    r.tick();
    expect(r.runner.view.step?.id).toBe('takeCall');
    r.send('cad:unitAssigned', { callId: 700, callsign: 'B9', by: 'dispatch' });
    r.tick();
    expect(r.runner.view.step?.id).toBe('takeCall');
    r.send('cad:unitAssigned', { callId: 700, callsign: PLAYER, by: 'self' });
    r.tick();
    expect(r.runner.view.step?.id).toBe('driveToCall');
  });

  it('another unit\'s status request does not complete radioStatus', () => {
    const r = makeRig();
    drive(r, 4);
    r.tick();
    expect(r.runner.view.step?.id).toBe('radioStatus');
    r.send('unit:request', { callsign: 'B9', request: { kind: 'status', status: 'available' }, via: 'radio' });
    r.send('unit:request', { callsign: PLAYER, request: { kind: 'status', status: 'busy' }, via: 'radio' });
    r.send('unit:request', { callsign: PLAYER, request: { kind: 'acceptCall', callId: 1 }, via: 'radio' });
    r.tick();
    expect(r.runner.view.step?.id).toBe('radioStatus');
  });

  it('a failed createCall leaves $call unbound and takeCall waits (it stays skippable)', () => {
    const ports = new FakePorts();
    ports.failCreate = true;
    const r = makeRig({ ports });
    drive(r, 5);
    r.tick();
    expect(r.runner.serialize().callId).toBe(-1);
    r.send('cad:unitAssigned', { callId: -1, callsign: PLAYER, by: 'dispatch' });
    r.tick();
    expect(r.runner.view.step?.id).toBe('takeCall');
    r.runner.skip();
    r.tick();
    expect(r.runner.view.step?.id).toBe('driveToCall');
  });

  it('driveToCall, scene and report match the player, the call and the document kind', () => {
    const r = makeRig();
    drive(r, 6);
    expect(r.runner.view.step?.id).toBe('driveToCall');
    r.send('cad:unitStatus', { callsign: PLAYER, status: 'enRoute', prev: 'available', callId: 700, via: 'auto' });
    r.send('cad:unitStatus', { callsign: 'B9', status: 'onScene', prev: 'enRoute', callId: 700, via: 'auto' });
    r.tick();
    expect(r.runner.view.step?.id).toBe('driveToCall');
    FIRST_SHIFT_BEATS[6]?.run(r, 700);
    expect(r.runner.view.step?.id).toBe('scene');
    r.send('cad:callClosed', { callId: 3, disposition: 'x' });
    r.tick();
    expect(r.runner.view.step?.id).toBe('scene');
    FIRST_SHIFT_BEATS[7]?.run(r, 700);
    r.send('cad:documentSaved', { id: 'CT-9', kind: 'citation', final: true });
    r.tick();
    expect(r.runner.view.step?.id).toBe('report');
  });
});

describe('TutorialRunner: matching', () => {
  const nested = mini([
    {
      id: 'a',
      title: 'A',
      text: 'a',
      until: { any: [{ topic: 'unit:request', where: { 'request.kind': 'status', 'request.deep.level': 3, flag: true } }] },
    },
    { id: 'b', title: 'B', text: 'b', until: { any: [{ topic: 'traffic:pulledOver' }, { topic: 'traffic:released', where: { reason: 'fled' } }] } },
    { id: 'c', title: 'C', text: 'c', until: { ack: true } },
  ]);

  it('where keys are dotted paths; every key must match with ===', () => {
    const r = makeRig({ script: nested, save: newTutorialSave('mini') });
    const ok = { callsign: 'x', flag: true, request: { kind: 'status', deep: { level: 3 } } };
    r.send('unit:request', { ...ok, flag: false });
    r.send('unit:request', { ...ok, request: { kind: 'status', deep: { level: '3' } } }); // string is not the number
    r.send('unit:request', { ...ok, request: { kind: 'status' } }); // missing path
    r.send('unit:request', { ...ok, request: 'status' }); // not an object on the way
    r.send('unit:request', { flag: true });
    r.tick();
    expect(r.runner.view.step?.id).toBe('a');
    r.send('unit:request', ok);
    r.tick();
    expect(r.runner.view.step?.id).toBe('b');
  });

  it('an any list matches the first of several alternatives; a match without where needs only the topic', () => {
    const r = makeRig({ script: nested, save: newTutorialSave('mini') });
    r.send('unit:request', { flag: true, request: { kind: 'status', deep: { level: 3 } } });
    r.tick();
    r.send('traffic:released', { eid: 1, vehicleId: 2, reason: 'released' });
    r.tick();
    expect(r.runner.view.step?.id).toBe('b');
    r.send('traffic:released', { eid: 1, vehicleId: 2, reason: 'fled' });
    r.tick();
    expect(r.runner.view.step?.id).toBe('c');
  });

  it('a topic-only match works with a non-object payload and events of other topics are ignored', () => {
    const r = makeRig({ script: nested, save: newTutorialSave('mini') });
    r.send('unit:request', { flag: true, request: { kind: 'status', deep: { level: 3 } } });
    r.tick();
    r.send('cad:callClosed', { callId: 1 });
    r.send('player:mode', { mode: 'driving' });
    r.tick();
    expect(r.runner.view.step?.id).toBe('b');
    r.send('traffic:pulledOver', null);
    r.tick();
    expect(r.runner.view.step?.id).toBe('c');
  });

  it('events of one tick are matched in order: a completion lets the rest match the next step', () => {
    const r = makeRig({ script: nested, save: newTutorialSave('mini') });
    r.send('unit:request', { flag: true, request: { kind: 'status', deep: { level: 3 } } });
    r.send('traffic:pulledOver', {});
    r.tick();
    expect(r.runner.view.step?.id).toBe('c');
    expect(r.steps.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    // The reverse order only completes the first step: the pulled-over event came too early for step b.
    const r2 = makeRig({ script: nested, save: newTutorialSave('mini') });
    r2.send('traffic:pulledOver', {});
    r2.send('unit:request', { flag: true, request: { kind: 'status', deep: { level: 3 } } });
    r2.tick();
    expect(r2.runner.view.step?.id).toBe('b');
  });

  it('events that arrive during an ack or probe step are discarded, not kept for later', () => {
    const r = makeRig();
    r.send('player:mode', { mode: 'driving', vehicle: 1 }); // during welcome (ack)
    r.tick();
    expect(r.runner.serialize().queue).toEqual([]);
    r.runner.ack();
    r.tick();
    expect(r.runner.view.step?.id).toBe('enterCar'); // the early event did not complete it
  });

  it('onEvent copies only JSON-safe fields and does not alias the payload', () => {
    const r = makeRig();
    const payload = { s: 'x', n: 1, b: false, inf: Infinity, nan: NaN, nil: null, undef: undefined, arr: [1, 2], fn: () => 1, nest: { k: 'v', list: [{ a: 1 }], deep: { z: 2 } } };
    r.send('player:mode', payload);
    const q = r.runner.serialize().queue;
    expect(q).toEqual([{ topic: 'player:mode', payload: { s: 'x', n: 1, b: false, nest: { k: 'v', deep: { z: 2 } } } }]);
    payload.nest.k = 'changed';
    expect(r.runner.serialize().queue[0]?.payload).toMatchObject({ nest: { k: 'v' } });
    expect(JSON.parse(JSON.stringify(q))).toEqual(q);
    r.send('player:mode', 'nope');
    r.send('player:mode', [1]);
    expect(r.runner.serialize().queue.slice(1)).toEqual([
      { topic: 'player:mode', payload: {} },
      { topic: 'player:mode', payload: {} },
    ]);
  });

  it('queue cap: events beyond 64 are dropped', () => {
    const r = makeRig();
    for (let i = 0; i < 100; i++) r.send('player:mode', { i });
    const q = r.runner.serialize().queue;
    expect(q).toHaveLength(64);
    expect((q[63]?.payload as { i: number }).i).toBe(63);
    r.tick();
    expect(r.runner.serialize().queue).toEqual([]);
    r.send('player:mode', { i: 1 });
    expect(r.runner.serialize().queue).toHaveLength(1);
  });

  it('pending cap: only the first 8 commands are kept', () => {
    const r = makeRig();
    for (let i = 0; i < 20; i++) r.runner.skip();
    expect(r.runner.serialize().pending).toHaveLength(8);
  });
});

describe('TutorialRunner: probes', () => {
  it('a probe step is checked only every 15 fixed steps', () => {
    const r = makeRig();
    drive(r, 2); // at "drive": gte 30 km/h
    const before = r.ports.probeCalls;
    r.ports.probes.speedKmh = 99; // already satisfied
    // the beat above stepped once after entering; count the steps since the last check
    const tickAtStart = r.runner.serialize().probeTick;
    const untilCheck = 15 - tickAtStart;
    r.tick(untilCheck - 1);
    expect(r.ports.probeCalls).toBe(before);
    expect(r.runner.view.step?.id).toBe('drive');
    r.tick(1);
    expect(r.ports.probeCalls).toBe(before + 1);
    expect(r.runner.view.step?.id).toBe('lights');
    expect(r.runner.serialize().probeTick).toBe(0);
  });

  it('probe calls over N steps = floor(N / 15) and nothing is asked on non-probe steps', () => {
    const r = makeRig();
    r.tick(150); // welcome (ack)
    expect(r.ports.probeCalls).toBe(0);
    r.runner.ack();
    r.tick();
    r.send('player:mode', { mode: 'driving', vehicle: 1 });
    r.tick();
    expect(r.runner.view.step?.id).toBe('drive');
    const save = r.runner.serialize();
    const ticks = 15 * 6 + 2;
    r.tick(ticks);
    expect(r.ports.probeCalls).toBe(Math.floor((save.probeTick + ticks) / 15));
  });

  it('gte, lte and both bounds', () => {
    const script = mini([
      { id: 'hi', title: 'H', text: 'h', until: { probe: 'speedKmh', gte: 30 } },
      { id: 'lo', title: 'L', text: 'l', until: { probe: 'distanceToCallM', lte: 25 } },
      { id: 'band', title: 'B', text: 'b', until: { probe: 'speedKmh', gte: 10, lte: 20 } },
      { id: 'end', title: 'E', text: 'e', until: { ack: true } },
    ]);
    const r = makeRig({ script, save: newTutorialSave('mini') });
    r.ports.probes.speedKmh = 29.9;
    r.tick(45);
    expect(r.runner.view.step?.id).toBe('hi');
    r.ports.probes.speedKmh = 30;
    r.tick(15);
    expect(r.runner.view.step?.id).toBe('lo');
    r.tick(30); // distance is Infinity (unbound)
    expect(r.runner.view.step?.id).toBe('lo');
    r.ports.probes.distanceToCallM = 25;
    r.tick(15);
    expect(r.runner.view.step?.id).toBe('band');
    r.ports.probes.speedKmh = 25;
    r.tick(15);
    expect(r.runner.view.step?.id).toBe('band');
    r.ports.probes.speedKmh = 15;
    r.tick(15);
    expect(r.runner.view.step?.id).toBe('end');
  });

  it('a probe is asked with the bound call id', () => {
    const ports = new FakePorts();
    const script = mini([
      { id: 'a', title: 'A', text: 'a', enter: [{ do: 'createCall', typeId: 't', minM: 1, maxM: 2 }], until: { probe: 'distanceToCallM', lte: 5 } },
    ]);
    const r = makeRig({ script, save: newTutorialSave('mini'), ports });
    r.tick(15);
    expect(ports.probeCallIds).toEqual([700]);
  });
});

describe('TutorialRunner: enter actions', () => {
  it('createCall runs exactly once per step, also across serialize -> new runner -> step', () => {
    const ports = new FakePorts();
    const r = makeRig({ ports });
    drive(r, 5);
    r.tick(3);
    expect(ports.created).toHaveLength(1);
    const saved = JSON.parse(JSON.stringify(r.runner.serialize())) as TutorialSave;
    expect(saved.entered).toBe(true);
    const r2 = makeRig({ ports, save: saved });
    r2.tick(5);
    expect(ports.created).toHaveLength(1);
    expect(r2.steps).toEqual([]); // the loaded runner does not announce the step again
    expect(r2.runner.serialize().callId).toBe(700);
  });

  it('a save taken before the step was entered runs the actions on the first step of the new runner', () => {
    const ports = new FakePorts();
    const save = newTutorialSave('firstShift');
    save.index = 5;
    const r = makeRig({ ports, save });
    r.tick();
    r.tick();
    expect(ports.created).toHaveLength(1);
    expect(r.steps.map((s) => s.id)).toEqual(['takeCall']);
  });

  it('the next step enters (and creates its call) before the following events are matched', () => {
    const script = mini([
      { id: 'a', title: 'A', text: 'a', until: { any: [{ topic: 'player:mode' }] } },
      {
        id: 'b',
        title: 'B',
        text: 'b',
        enter: [{ do: 'createCall', typeId: 't', minM: 1, maxM: 2 }, { do: 'flash', text: 'Look at the map' }],
        until: { any: [{ topic: 'cad:unitAssigned', where: { callId: '$call' } }] },
      },
      { id: 'c', title: 'C', text: 'c', until: { ack: true } },
    ]);
    const r = makeRig({ script, save: newTutorialSave('mini') });
    r.send('player:mode', {});
    r.send('cad:unitAssigned', { callId: 700, callsign: PLAYER, by: 'dispatch' }); // the id the step's createCall returns
    r.tick();
    expect(r.runner.view.step?.id).toBe('c');
    expect(r.flashes).toEqual(['Look at the map']);
    expect(r.steps.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('TutorialRunner: commands', () => {
  it('skip on a non-skippable step is ignored', () => {
    const r = makeRig();
    r.runner.skip();
    r.tick();
    expect(r.runner.view.step?.id).toBe('welcome');
    expect(r.runner.serialize().skipped).toEqual([]);
    // ... also on the last step
    drive(r, 13);
    expect(r.runner.view.step?.id).toBe('done');
    r.runner.skip();
    r.tick();
    expect(r.runner.view.step?.id).toBe('done');
    expect(r.runner.view.active).toBe(true);
  });

  it('skip on a skippable step records its id and moves on; ack on a non-ack step is ignored', () => {
    const r = makeRig();
    r.runner.ack();
    r.tick();
    r.runner.ack();
    r.tick();
    expect(r.runner.view.step?.id).toBe('enterCar');
    r.runner.skip();
    r.tick();
    expect(r.runner.view.step?.id).toBe('drive');
    expect(r.runner.serialize().skipped).toEqual(['enterCar']);
  });

  it('pending commands apply in order within one step', () => {
    const r = makeRig();
    r.runner.ack(); // welcome -> enterCar
    r.runner.skip(); // enterCar -> drive
    r.runner.ack(); // ignored: drive is not an ack step
    r.runner.skip(); // drive -> lights
    r.tick();
    expect(r.runner.view.step?.id).toBe('lights');
    expect(r.runner.serialize().skipped).toEqual(['enterCar', 'drive']);
    expect(r.runner.serialize().pending).toEqual([]);
  });

  it('end finishes with completed false, emits tutorial:done once and ignores later input', () => {
    const r = makeRig();
    drive(r, 3);
    r.runner.skip();
    r.runner.end();
    r.runner.ack();
    r.tick();
    expect(r.done).toEqual([{ scriptId: 'firstShift', completed: false, skipped: 1 }]);
    expect(r.runner.view).toMatchObject({ active: false, done: true, completed: false, step: null });
    r.runner.end();
    r.send('player:mode', {});
    r.tick(20);
    expect(r.done).toHaveLength(1);
    expect(r.runner.serialize()).toMatchObject({ done: true, completed: false, queue: [], pending: [] });
    expect(isTutorialSave(r.runner.serialize())).toBe(true);
  });

  it('end on the very first step (before anything was announced)', () => {
    const r = makeRig();
    r.runner.end();
    r.tick();
    expect(r.done).toEqual([{ scriptId: 'firstShift', completed: false, skipped: 0 }]);
    expect(r.steps).toEqual([]);
  });
});

describe('TutorialRunner: view and revision', () => {
  it('no events -> no revision change and the very same view object', () => {
    const r = makeRig();
    r.tick();
    const v = r.runner.view;
    r.tick(500);
    r.send('player:mode', {}); // queued, discarded by an ack step
    r.tick(20);
    expect(r.runner.view).toBe(v);
    expect(r.runner.view.revision).toBe(v.revision);
  });

  it('the revision rises on every step change and on done, and the step text comes from the script', () => {
    const r = makeRig();
    r.tick();
    const seen: number[] = [r.runner.view.revision];
    for (const beat of FIRST_SHIFT_BEATS) {
      beat.run(r, 700);
      seen.push(r.runner.view.revision);
    }
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1] as number);
    const r2 = makeRig();
    const v0 = r2.runner.view;
    expect(v0.step).toEqual({
      id: 'welcome',
      title: SCRIPT.steps[0]?.title,
      text: SCRIPT.steps[0]?.text,
      hint: '',
      ack: true,
      skippable: false,
    });
    expect(v0).toMatchObject({ active: true, done: false, completed: false, index: 0, count: 14, title: 'Guided first shift' });
    r2.runner.ack();
    r2.tick();
    expect(r2.runner.view.step).toMatchObject({ id: 'enterCar', ack: false, skippable: true });
    expect(r2.runner.view.step?.hint).toBe(SCRIPT.steps[1]?.hint);
    expect(r2.runner.view.revision).toBeGreaterThan(v0.revision);
  });

  it('ending bumps the revision too, and the inactive view is revision -1', () => {
    const r = makeRig();
    const before = r.runner.view.revision;
    r.runner.end();
    r.tick();
    expect(r.runner.view.revision).toBeGreaterThan(before);
    expect(INACTIVE_TUTORIAL_VIEW).toMatchObject({ active: false, step: null, revision: -1 });
  });
});

describe('TutorialRunner: save and determinism', () => {
  function inputs(r: ReturnType<typeof makeRig>): void {
    // a script of mixed inputs, includes noise events and a skip
    r.tick(3);
    r.runner.ack();
    r.tick();
    r.send('player:mode', { mode: 'onFoot', vehicle: 0 });
    r.send('player:mode', { mode: 'driving', vehicle: 9 });
    r.tick();
    r.ports.probes.speedKmh = 31;
    r.tick(16);
    r.runner.skip();
    r.tick(2);
  }

  it('two runners fed the same inputs give deep-equal saves, views and events', () => {
    const a = makeRig();
    const b = makeRig();
    inputs(a);
    inputs(b);
    expect(a.runner.serialize()).toEqual(b.runner.serialize());
    expect(a.runner.view).toEqual(b.runner.view);
    expect(a.steps).toEqual(b.steps);
    drive(a);
    drive(b);
    expect(a.runner.serialize()).toEqual(b.runner.serialize());
  });

  it('serialize is a deep copy', () => {
    const r = makeRig();
    r.send('player:mode', { mode: 'driving' });
    const s = r.runner.serialize();
    s.index = 9;
    s.queue.length = 0;
    s.skipped.push('x');
    expect(r.runner.serialize().index).toBe(0);
    expect(r.runner.serialize().queue).toHaveLength(1);
    // and the constructor copies the save it is given
    const save = newTutorialSave('firstShift');
    const r2 = makeRig({ save });
    r2.runner.ack();
    r2.tick();
    expect(save.index).toBe(0);
    expect(save.pending).toEqual([]);
  });

  it('a mid-script JSON round trip continues identically (events, views, saves)', () => {
    for (const cut of [1, 2, 3, 4, 5, 6, 8, 11, 13]) {
      const first = makeRig();
      first.tick();
      drive(first, cut);
      // something queued and pending at the moment of the cut
      first.send('player:mode', { mode: 'driving', vehicle: 1 });
      first.runner.skip();
      const saved = JSON.parse(JSON.stringify(first.runner.serialize())) as unknown;
      expect(isTutorialSave(saved)).toBe(true);

      const ports = new FakePorts();
      ports.probes = { ...first.ports.probes };
      ports.nextCallId = first.ports.nextCallId;
      const resumed = makeRig({ save: saved as TutorialSave, ports });
      // the rest of the run on both
      const rest = (r: ReturnType<typeof makeRig>): void => {
        r.tick(2);
        for (const beat of FIRST_SHIFT_BEATS.slice(r.runner.view.index)) beat.run(r, 700);
        r.tick(5);
      };
      rest(first);
      rest(resumed);
      expect(resumed.runner.serialize()).toEqual(first.runner.serialize());
      expect(resumed.runner.view).toEqual(first.runner.view);
      expect(resumed.done).toEqual(first.done);
      // events after the load equal the tail of the uninterrupted run
      const tailIds = first.steps.slice(first.steps.length - resumed.steps.length).map((s) => s.id);
      expect(resumed.steps.map((s) => s.id)).toEqual(tailIds);
      expect(resumed.runner.view.done).toBe(true);
    }
  });

  it('a runner built from a done save stays quiet', () => {
    const r = makeRig();
    r.runner.end();
    r.tick();
    const r2 = makeRig({ save: r.runner.serialize() });
    r2.tick(10);
    expect(r2.steps).toEqual([]);
    expect(r2.done).toEqual([]);
    expect(r2.runner.view).toMatchObject({ active: false, completed: false });
  });

  it('rejects an unknown script and a script / save id mismatch', () => {
    const bus = new EventBus<EventMap>();
    const ports = new FakePorts();
    expect(() => new TutorialRunner(bus, ports, newTutorialSave('nope'))).toThrow(/unknown script "nope"/);
    const other = mini([{ id: 'a', title: 'A', text: 'a', until: { ack: true } }]);
    expect(() => new TutorialRunner(bus, ports, newTutorialSave('firstShift'), other)).toThrow(/mini/);
  });

  it('a save whose index is past the end finishes on the first step', () => {
    const save = newTutorialSave('firstShift');
    save.index = 14;
    const r = makeRig({ save });
    r.tick();
    expect(r.done).toEqual([{ scriptId: 'firstShift', completed: true, skipped: 0 }]);
  });

  it('shares nothing between two buses: attach() only sees its own bus', () => {
    const busA = new EventBus<EventMap>();
    const logA = attach(busA);
    const r = makeRig();
    r.tick();
    expect(logA.steps).toEqual([]);
  });
});

describe('TutorialRunner: cost', () => {
  it('an idle step is cheap (<= 0.005 ms) and a step with an event stays <= 0.05 ms', () => {
    const r = makeRig();
    r.runner.ack();
    r.tick(2); // enterCar (an event step)
    for (let i = 0; i < 2000; i++) r.tick(); // warm up
    const n = 200_000;
    let t0 = performance.now();
    for (let i = 0; i < n; i++) r.runner.step();
    const idle = (performance.now() - t0) / n;
    expect(idle).toBeLessThanOrEqual(0.005);
    const m = 20_000;
    t0 = performance.now();
    for (let i = 0; i < m; i++) {
      r.runner.onEvent('cad:callClosed', { callId: i, disposition: 'x', nested: { a: 1 } });
      r.runner.step();
    }
    const withEvent = (performance.now() - t0) / m;
    expect(withEvent).toBeLessThanOrEqual(0.05);
    expect(r.runner.view.step?.id).toBe('enterCar');
  });
});
