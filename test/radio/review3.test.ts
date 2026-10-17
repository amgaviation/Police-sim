import { describe, expect, it } from 'vitest';
import { EventBus } from '../../src/core/events';
import type { EventMap } from '../../src/core/event-map';
import { parseVoiceCommand } from '../../src/radio/grammar';
import { RadioPlayer, type RadioFxLike, type SpeechOutLike } from '../../src/radio/player';
import { makeRig, PLAYER, starts, type Rig } from './helpers';

class FakeFx implements RadioFxLike {
  readonly calls: string[] = [];
  level = 1;
  keyUp(): void {
    this.calls.push('keyUp');
  }
  squelchTail(): void {
    this.calls.push('squelch');
  }
  heterodyne(): void {
    this.calls.push('heterodyne');
  }
  priorityTone(): void {
    this.calls.push('priority');
  }
  alertTone(): void {
    this.calls.push('alert');
  }
}

/** A speech engine that never reports the end of an utterance (lost end/error events). */
class SilentEndSpeech implements SpeechOutLike {
  volume = 1;
  readonly spoken: string[] = [];
  cancels = 0;
  speak(text: string): boolean {
    this.spoken.push(text);
    return true;
  }
  cancel(): void {
    this.cancels++;
  }
  pause(): void {}
  resume(): void {}
}

function fakeDispatch(rig: Rig): void {
  rig.bus.on('unit:request', (e) => {
    if (e.request.kind === 'emergency') rig.bus.emit('dispatch:emergency', { callsign: PLAYER, active: true, units: ['21'], location: 'Oak Street at 5th Street' });
  });
}

describe('radio review round 3', () => {
  it('the emergency button pre-empts the channel even with an own routine request still queued', () => {
    const rig = makeRig();
    fakeDispatch(rig);
    rig.radio.say('dispatch', 'a long dispatcher message that is still going on when the unit asks for a status and then hits the emergency button');
    rig.run(0.5);
    rig.radio.playerRequest({ kind: 'status', status: 'onScene' }, 'radio');
    rig.run(0.2);
    const pressed = rig.time;
    rig.radio.emergencyButton();
    rig.run(40);
    const list = starts(rig);
    const emergency = list.find((t) => t.kind === 'playerEmergency');
    const alert = list.find((t) => t.kind === 'emergencyAlert');
    const routine = list.find((t) => t.speakerKind === 'player' && t.kind !== 'playerEmergency');
    expect(emergency).toBeDefined();
    expect((emergency?.start ?? Infinity) - pressed).toBeLessThan(0.5);
    expect(emergency?.start ?? Infinity).toBeLessThan(alert?.start ?? -Infinity);
    // The queued routine request still goes out, after the emergency.
    expect(routine?.start ?? -Infinity).toBeGreaterThan(emergency?.start ?? Infinity);
  });

  it('reads a plate whose digits start with "ten" as digits, not a ten-code', () => {
    const ctx = { fallbackPlate: 'XYZ 9999', fallbackVehicleId: 7 };
    expect(parseVoiceCommand('run plate adam boy charles ten forty five', ctx)).toEqual({ kind: 'runPlate', plate: 'ABC 1045', vehicleId: -1 });
    expect(parseVoiceCommand('run plate ABC 10 45', ctx)).toEqual({ kind: 'runPlate', plate: 'ABC 1045', vehicleId: -1 });
    expect(parseVoiceCommand('run plate a b c ten oh five', ctx)).toEqual({ kind: 'runPlate', plate: 'ABC 1005', vehicleId: -1 });
    expect(parseVoiceCommand('ten twenty eight adam boy charles one two three four', ctx)).toEqual({ kind: 'runPlate', plate: 'ABC 1234', vehicleId: -1 });
    expect(parseVoiceCommand('run plate adam boy charles one zero four five', ctx)).toEqual({ kind: 'runPlate', plate: 'ABC 1045', vehicleId: -1 });
  });

  it('a lost speech end event does not silence the radio for good', () => {
    const rig = makeRig();
    const speech = new SilentEndSpeech();
    new RadioPlayer({ bus: rig.bus, audio: { radio: new FakeFx() }, speech });
    rig.radio.say('dispatch', '12, 10-4.');
    rig.run(10);
    rig.radio.say('dispatch', '21, 10-4.');
    rig.run(10);
    rig.radio.say('dispatch', '23, 10-4.');
    rig.run(10);
    expect(speech.spoken).toHaveLength(3);
  });

  it('reset forgets the old session: no stray squelch for a reused transmission id', () => {
    const bus = new EventBus<EventMap>();
    const fx = new FakeFx();
    const speech = new SilentEndSpeech();
    const player = new RadioPlayer({ bus, audio: { radio: fx }, speech });
    const a = makeRig({ bus });
    a.radio.say('dispatch', 'a long dispatcher message that is still on the air when the session ends');
    a.run(0.5);
    a.radio.dispose();
    player.reset();
    expect(speech.cancels).toBeGreaterThan(0);
    const b = makeRig({ bus });
    fx.calls.length = 0;
    b.radio.say('county', 'County 14, 10-8.');
    b.run(10);
    expect(fx.calls).toEqual([]);
  });
});
