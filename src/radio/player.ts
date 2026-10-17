/**
 * RadioPlayer (design §9.6): presentation only. Plays audible transmissions as radio FX + TTS; never
 * feeds back into the simulation. Without TTS everything still shows in the log / captions.
 */
import type { AlertToneKind } from '../audio/radioFx';
import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import type { VoiceProfile } from '../speech/profile';
import { voiceProfileFor } from '../speech/profile';
import { RADIO_CONFIG } from './data';
import './events';
import type { ChannelId, Transmission } from './types';

/** The parts of `RadioFx` the player uses. */
export interface RadioFxLike {
  /** Level multiplier (0..1) for the effects scheduled next. */
  level: number;
  keyUp(): void;
  squelchTail(): void;
  heterodyne(durationS: number): void;
  priorityTone(): void;
  alertTone(kind: AlertToneKind): void;
}

/** The parts of `SpeechOut` the player uses. */
export interface SpeechOutLike {
  volume: number;
  speak(text: string, profile: VoiceProfile, options?: { dispatcher?: boolean; onEnd?: () => void }): boolean;
  cancel(): void;
  pause(): void;
  resume(): void;
}

export interface RadioPlayerDeps {
  readonly bus: EventBus<EventMap>;
  /** An `AudioEngine` (only `.radio` is used). */
  readonly audio: { readonly radio: RadioFxLike };
  readonly speech: SpeechOutLike;
  /** Volume factor for scanned (not selected) channels; default channels.json scanVolume. */
  readonly scanVolume?: number;
  /** The radio's selected channel; default: tracked from radio:channel events. */
  readonly selected?: () => ChannelId;
  /** Presentation timer (default setTimeout); returns a cancel function. */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
}

/** Priority warble length (6 x 125 ms) and the longest alert beep sequence (s): speech starts after them. */
const PRIORITY_TONE_S = 0.75;
const ALERT_TONE_S = 0.45;
/**
 * An utterance whose transmission ended this long ago (s) no longer blocks the next one: the speech
 * engine may never report its end (lost end/error events), which would otherwise mute the radio.
 */
const STALE_SPEECH_S = 3;

function defaultSchedule(fn: () => void, ms: number): () => void {
  const h = setTimeout(fn, ms);
  return () => clearTimeout(h);
}

function alertFor(kind: string): AlertToneKind | null {
  if (kind === 'plateHit') return 'hit';
  if (kind === 'offer') return 'offer';
  if (kind.startsWith('statusCheck') || kind === 'statusEscalate') return 'statusCheck';
  return null;
}

export class RadioPlayer {
  private readonly deps: RadioPlayerDeps;
  private readonly scanVolume: number;
  private readonly offs: (() => void)[] = [];
  /** Audible transmissions on the air, by id. */
  private readonly playing = new Map<number, Transmission>();
  private trackedSelected: ChannelId = RADIO_CONFIG.defaultSelected;
  /** The transmission being spoken (-1 none) and whether it is from a scanned channel. */
  private speakingId = -1;
  private speakingScanned = false;
  /** Sim time the spoken transmission ends (start + duration). */
  private speakingEnd = Infinity;
  private paused = false;
  /** Cancels the speech waiting for its tone (null when none). */
  private cancelPending: (() => void) | null = null;

  constructor(deps: RadioPlayerDeps) {
    this.deps = deps;
    this.scanVolume = deps.scanVolume ?? RADIO_CONFIG.scanVolume;
    const bus = deps.bus;
    this.offs.push(
      bus.on('radio:start', (e) => this.onStart(e.tx)),
      bus.on('radio:end', (e) => this.onEnd(e.id)),
      bus.on('radio:blocked', (e) => this.onBlocked(e.ids)),
      bus.on('radio:channel', (e) => {
        this.trackedSelected = e.selected;
      }),
    );
  }

  /** Game paused: speech pauses (radio FX are suspended with the audio engine by the caller). */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) this.deps.speech.pause();
    else this.deps.speech.resume();
  }

  /** Id of the transmission currently spoken (-1 none). */
  get speaking(): number {
    return this.speakingId;
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.reset();
  }

  /**
   * Session ended: forgets the transmissions on the air (a new session reuses their ids), drops a
   * speech waiting for its tone and stops the current utterance.
   */
  reset(): void {
    this.playing.clear();
    this.clearPending();
    this.deps.speech.cancel();
    this.speakingId = -1;
    this.speakingEnd = Infinity;
  }

  private clearPending(): void {
    this.cancelPending?.();
    this.cancelPending = null;
  }

  /** Stops the current utterance (spoken or still waiting for its tone). */
  private stopSpeaking(): void {
    this.clearPending();
    this.deps.speech.cancel();
    this.speakingId = -1;
  }

  private selected(): ChannelId {
    return this.deps.selected ? this.deps.selected() : this.trackedSelected;
  }

  private onStart(tx: Readonly<Transmission>): void {
    if (!tx.audible) return;
    this.playing.set(tx.id, tx);
    const fx = this.deps.audio.radio;
    const scanned = tx.channel !== this.selected();
    // Scanned channels play at the scan volume, effects included.
    fx.level = scanned ? this.scanVolume : 1;
    let toneS = 0;
    const alert = alertFor(tx.kind);
    if (alert !== null) {
      fx.alertTone(alert);
      toneS = ALERT_TONE_S;
    } else if (tx.priority) {
      fx.priorityTone();
      toneS = PRIORITY_TONE_S;
    }
    fx.keyUp();
    fx.level = 1;
    if (tx.blocked) return;
    if (this.speakingId >= 0) {
      // One utterance at a time: the selected channel pre-empts a scanned one; otherwise captions only.
      // An utterance this transmission just stepped on (the emergency button pre-empts the channel;
      // radio:blocked follows radio:start) gives way to it.
      const cur = this.playing.get(this.speakingId);
      const stale = cur === undefined && tx.start > this.speakingEnd + STALE_SPEECH_S;
      if (!stale && !(cur?.blocked ?? false) && (!this.speakingScanned || scanned)) return;
      this.stopSpeaking();
    }
    if (toneS === 0) {
      this.speak(tx, scanned);
      return;
    }
    // The tone comes first, then the voice.
    this.speakingId = tx.id;
    this.speakingScanned = scanned;
    this.speakingEnd = tx.start + tx.duration;
    this.cancelPending = (this.deps.schedule ?? defaultSchedule)(() => {
      this.cancelPending = null;
      if (this.speakingId === tx.id) this.speak(tx, scanned);
    }, toneS * 1000);
  }

  private speak(tx: Readonly<Transmission>, scanned: boolean): void {
    const speech = this.deps.speech;
    const base = speech.volume;
    if (scanned) speech.volume = base * this.scanVolume;
    const id = tx.id;
    this.speakingId = id;
    this.speakingScanned = scanned;
    this.speakingEnd = tx.start + tx.duration;
    const kind = tx.speakerKind;
    const started = speech.speak(tx.spoken, voiceProfileFor(tx.speaker, kind), {
      dispatcher: kind === 'dispatcher',
      onEnd: () => {
        if (this.speakingId === id) this.speakingId = -1;
      },
    });
    if (scanned) speech.volume = base;
    if (!started && this.speakingId === id) this.speakingId = -1;
  }

  private onEnd(id: number): void {
    const tx = this.playing.get(id);
    if (!tx || !this.playing.delete(id)) return;
    const fx = this.deps.audio.radio;
    fx.level = tx.channel !== this.selected() ? this.scanVolume : 1;
    fx.squelchTail();
    fx.level = 1;
  }

  private onBlocked(ids: readonly number[]): void {
    let latestStart = -Infinity;
    let any = false;
    let selected = false;
    for (const id of ids) {
      const tx = this.playing.get(id);
      if (!tx) continue;
      any = true;
      if (tx.channel === this.selected()) selected = true;
      if (tx.start > latestStart) latestStart = tx.start;
    }
    if (!any) return;
    // The overlap runs from the newest start until the first of them ends (estimated).
    let firstEnd = Infinity;
    for (const id of ids) {
      const tx = this.playing.get(id);
      if (tx) firstEnd = Math.min(firstEnd, tx.start + tx.duration);
    }
    if (ids.includes(this.speakingId)) this.stopSpeaking();
    const fx = this.deps.audio.radio;
    fx.level = selected ? 1 : this.scanVolume;
    fx.heterodyne(Math.max(0.2, firstEnd - latestStart));
    fx.level = 1;
  }
}
