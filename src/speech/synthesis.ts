import voicesJson from '../data/audio/voices.json';
import { readArray, readObject, readString, readVersion } from '../vehicles/json';
import type { VoiceProfile } from './profile';

/** Parses `voices.json`: names (lower case) of novelty voices kept out of the speaker pool (singing, whispering...). */
export function parseExcludedVoices(json: unknown, file = 'voices.json'): ReadonlySet<string> {
  const root = readObject(json, file, '');
  readVersion(root, file);
  const list = readArray(root.excludeVoices, file, 'excludeVoices').map((v, i) => readString(v, file, `excludeVoices[${i}]`).trim().toLowerCase());
  return new Set(list);
}

const EXCLUDED_VOICES = parseExcludedVoices(voicesJson);

/** True when `name` is a novelty voice of the denylist ("Bubbles", "Bubbles (English (US))"). */
export function isExcludedVoice(name: string, excluded: ReadonlySet<string> = EXCLUDED_VOICES): boolean {
  return excluded.has(name.replace(/\s*\(.*\)\s*$/, '').trim().toLowerCase());
}

/**
 * Text-to-speech wrapper over `speechSynthesis` (design §10.4). Feature-detected: without
 * the API, or when disabled, `speak` returns false and calls `onEnd` at once so callers fall
 * back to subtitles. Nothing here ever throws.
 */

/** Structural view of `SpeechSynthesisVoice`. */
export interface VoiceLike {
  readonly name: string;
  readonly lang: string;
  readonly localService: boolean;
}

/** Structural view of `SpeechSynthesisUtterance` (test seam). */
export interface UtteranceLike {
  text: string;
  voice: VoiceLike | null;
  lang: string;
  pitch: number;
  rate: number;
  volume: number;
  onend: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

/** Structural view of `window.speechSynthesis` (test seam). */
export interface SpeechSynthesisLike {
  speak(utterance: UtteranceLike): void;
  cancel(): void;
  pause(): void;
  resume(): void;
  getVoices(): readonly VoiceLike[];
  addEventListener?(type: 'voiceschanged', listener: () => void): void;
  removeEventListener?(type: 'voiceschanged', listener: () => void): void;
}

export interface SpeechOutOptions {
  /** Synth seam; null disables TTS. Default `globalThis.speechSynthesis`. */
  synth?: SpeechSynthesisLike | null;
  /** Utterance seam. Default `new SpeechSynthesisUtterance(text)`. */
  utteranceFactory?: (text: string) => UtteranceLike;
}

export interface SpeakOptions {
  /** The dispatcher prefers `preferredVoice` (settings `audio.ttsVoice`) when it names an available voice. */
  dispatcher?: boolean;
  /** Called once when the utterance ends or fails, or at once when nothing is spoken. */
  onEnd?: () => void;
}

export interface VoiceInfo {
  readonly name: string;
  readonly lang: string;
  readonly local: boolean;
}

function browserSynth(): SpeechSynthesisLike | null {
  const g = globalThis as { speechSynthesis?: unknown };
  return g.speechSynthesis ? (g.speechSynthesis as SpeechSynthesisLike) : null;
}

function browserUtteranceFactory(): ((text: string) => UtteranceLike) | null {
  const g = globalThis as { SpeechSynthesisUtterance?: new (text: string) => unknown };
  const Ctor = g.SpeechSynthesisUtterance;
  return Ctor ? (text) => new Ctor(text) as UtteranceLike : null;
}

function byLocalThenName(a: VoiceLike, b: VoiceLike): number {
  if (a.localService !== b.localService) return a.localService ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export class SpeechOut {
  /** False disables speaking (settings `audio.tts`). */
  enabled = true;
  /** Exact voice name for the dispatcher (settings `audio.ttsVoice`), or null. */
  preferredVoice: string | null = null;
  /** Utterance volume 0..1. */
  volume = 1;
  private readonly synth: SpeechSynthesisLike | null;
  private readonly makeUtterance: ((text: string) => UtteranceLike) | null;
  private voices: readonly VoiceLike[] = [];
  private pool: readonly VoiceLike[] = [];
  /** Keeps pending utterances reachable (some engines drop `end` for collected ones). */
  private readonly pending = new Set<UtteranceLike>();
  private readonly onVoicesChanged = (): void => this.refreshVoices();

  constructor(options: SpeechOutOptions = {}) {
    const synth = options.synth !== undefined ? options.synth : browserSynth();
    const factory = options.utteranceFactory ?? browserUtteranceFactory();
    this.synth = synth && factory ? synth : null;
    this.makeUtterance = factory;
    if (this.synth) {
      try {
        this.synth.addEventListener?.('voiceschanged', this.onVoicesChanged);
      } catch {
        // ignore
      }
      this.refreshVoices();
    }
  }

  get available(): boolean {
    return this.synth !== null;
  }

  /**
   * Speaks `text` with the profile's voice, pitch and rate. Returns false (after calling
   * `onEnd`) when unavailable, disabled or the engine refused the utterance.
   */
  speak(text: string, profile: VoiceProfile, options: SpeakOptions = {}): boolean {
    let ended = false;
    const done = (): void => {
      if (ended) return;
      ended = true;
      try {
        options.onEnd?.();
      } catch {
        // a throwing callback must not break speech
      }
    };
    const synth = this.synth;
    const factory = this.makeUtterance;
    if (!synth || !factory || !this.enabled || text.trim() === '') {
      done();
      return false;
    }
    let utterance: UtteranceLike | null = null;
    try {
      const u = factory(text);
      utterance = u;
      const voice = this.pickVoice(profile, options.dispatcher === true);
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      } else {
        u.lang = 'en-US';
      }
      u.pitch = profile.pitch;
      u.rate = profile.rate;
      u.volume = Math.min(1, Math.max(0, Number.isFinite(this.volume) ? this.volume : 0));
      const finish = (): void => {
        this.pending.delete(u);
        done();
      };
      u.onend = finish;
      u.onerror = finish;
      this.pending.add(u);
      synth.speak(u);
      return true;
    } catch {
      if (utterance) this.pending.delete(utterance);
      done();
      return false;
    }
  }

  cancel(): void {
    this.call((s) => s.cancel());
  }

  pause(): void {
    this.call((s) => s.pause());
  }

  resume(): void {
    this.call((s) => s.resume());
  }

  /** Names of all voices the browser offers (unsorted, as reported). */
  voiceNames(): readonly string[] {
    return this.voices.map((v) => v.name);
  }

  /** All voices with their language and local/remote flag (console `voices`). */
  voiceInfo(): readonly VoiceInfo[] {
    return this.voices.map((v) => ({ name: v.name, lang: v.lang, local: v.localService }));
  }

  /** Voices used for non-dispatcher speakers: English, no novelty voices (voices.json), local first, then by name. */
  voicePool(): readonly string[] {
    return this.pool.map((v) => v.name);
  }

  dispose(): void {
    const synth = this.synth;
    if (!synth) return;
    try {
      synth.removeEventListener?.('voiceschanged', this.onVoicesChanged);
      synth.cancel();
    } catch {
      // ignore
    }
    this.pending.clear();
  }

  private pickVoice(profile: VoiceProfile, dispatcher: boolean): VoiceLike | null {
    if (dispatcher && this.preferredVoice !== null) {
      const name = this.preferredVoice;
      const preferred = this.voices.find((v) => v.name === name);
      if (preferred) return preferred;
    }
    const pool = this.pool;
    if (pool.length === 0) return null;
    return pool[profile.voiceIndex % pool.length] ?? null;
  }

  private refreshVoices(): void {
    const synth = this.synth;
    if (!synth) return;
    try {
      this.voices = [...synth.getVoices()];
    } catch {
      this.voices = [];
    }
    const english = this.voices.filter((v) => v.lang.toLowerCase().startsWith('en'));
    const base = english.length > 0 ? english : this.voices;
    // Novelty voices stay selectable as the dispatcher voice (`voiceNames`), never assigned to speakers.
    const usable = base.filter((v) => !isExcludedVoice(v.name));
    this.pool = [...(usable.length > 0 ? usable : base)].sort(byLocalThenName);
  }

  private call(fn: (s: SpeechSynthesisLike) => void): void {
    if (!this.synth) return;
    try {
      fn(this.synth);
    } catch {
      // ignore
    }
  }
}
