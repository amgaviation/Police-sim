import { safeDisconnect } from './nodes';
import { createAudioStats, type AudioStats } from './sirens';
import { UI_SOUNDS, UI_SOUND_KINDS, type UiSoundData, type UiSoundName } from './uiData';

export { UI_SOUND_KINDS, type UiSoundName };

/**
 * Short synthesized UI sounds on the `ui` bus (phase 9 design §5.7): each kind is 1..3 enveloped oscillator tones from
 * `ui.json`. Event-driven (single-use sources, cleaned up on `onended`); never per frame. Without an unlocked context
 * `play` is a no-op and nothing here ever throws.
 */

/** Lead time before the first tone (s). */
const LEAD_S = 0.005;
/** Envelope attack (s, capped at a quarter of the tone). */
const ATTACK_S = 0.004;
/** Silence floor for the exponential decay. */
const FLOOR = 0.0001;

export class UiSounds {
  private readonly data: UiSoundData;
  private readonly stats: AudioStats;
  private ctx: BaseAudioContext | null = null;
  private out: AudioNode | null = null;
  /** Context time each kind last played (index = `UI_SOUND_KINDS` order). */
  private readonly last = new Float64Array(UI_SOUND_KINDS.length).fill(-Infinity);

  constructor(stats: AudioStats = createAudioStats(), data: UiSoundData = UI_SOUNDS) {
    this.stats = stats;
    this.data = data;
  }

  /** @internal Attaches the ui bus (engine unlock). */
  attach(ctx: BaseAudioContext, out: AudioNode): void {
    this.ctx = ctx;
    this.out = out;
    this.last.fill(-Infinity);
  }

  /** @internal */
  detach(): void {
    this.ctx = null;
    this.out = null;
    this.stats.uiPlaying = 0;
  }

  /**
   * Schedules the tones of `kind` (ui.json) on the ui bus; the same kind within `rateLimitMs` (context time) is
   * dropped; an unknown kind is ignored; never throws; no-op before unlock.
   */
  play(kind: string): void {
    const ctx = this.ctx;
    const out = this.out;
    if (!ctx || !out) return;
    const index = (UI_SOUND_KINDS as readonly string[]).indexOf(kind);
    if (index < 0) return;
    try {
      const tones = this.data.sounds[kind as UiSoundName];
      const now = ctx.currentTime;
      if ((now - (this.last[index] ?? -Infinity)) * 1000 < this.data.rateLimitMs) return;
      this.last[index] = now;
      let t = now + LEAD_S;
      for (const tone of tones) {
        const osc = ctx.createOscillator();
        osc.type = tone.wave;
        osc.frequency.setValueAtTime(tone.hz, t);
        osc.frequency.exponentialRampToValueAtTime(tone.toHz, t + tone.durS);
        const env = ctx.createGain();
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(tone.gain, t + Math.min(ATTACK_S, tone.durS / 4));
        env.gain.exponentialRampToValueAtTime(FLOOR, t + tone.durS);
        osc.connect(env);
        env.connect(out);
        this.stats.uiPlaying++;
        osc.onended = () => {
          safeDisconnect(osc);
          safeDisconnect(env);
          if (this.stats.uiPlaying > 0) this.stats.uiPlaying--;
        };
        osc.start(t);
        osc.stop(t + tone.durS + 0.01);
        t += tone.durS;
      }
    } catch {
      // never throw from audio
    }
  }
}
