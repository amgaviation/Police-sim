import { describe, expect, it } from 'vitest';
import { VOICE_INDEX_COUNT, voiceProfileFor, type VoiceKind } from '../../src/speech/profile';

const KEYS = Array.from({ length: 40 }, (_, i) => String(11 + i * 2));

describe('voiceProfileFor', () => {
  it('is deterministic', () => {
    for (const kind of ['dispatcher', 'officer', 'agency', 'player'] as const) {
      for (const key of ['12', '21', 'Dispatch', 'County 4', '']) {
        expect(voiceProfileFor(key, kind)).toEqual(voiceProfileFor(key, kind));
      }
    }
  });

  it('keeps every kind within its pitch and rate ranges', () => {
    const ranges: Record<VoiceKind, { pitch: [number, number]; rate: [number, number] }> = {
      dispatcher: { pitch: [0.95, 1.1], rate: [1.05, 1.05] },
      officer: { pitch: [0.8, 1.2], rate: [0.95, 1.15] },
      player: { pitch: [0.8, 1.2], rate: [0.95, 1.15] },
      agency: { pitch: [0.9, 1.1], rate: [0.95, 1.1] },
    };
    for (const [kind, r] of Object.entries(ranges) as [VoiceKind, (typeof ranges)[VoiceKind]][]) {
      for (const key of [...KEYS, 'County', 'State', 'Fire 3', 'Medic 7']) {
        const p = voiceProfileFor(key, kind);
        expect(p.pitch, `${kind} ${key}`).toBeGreaterThanOrEqual(r.pitch[0]);
        expect(p.pitch, `${kind} ${key}`).toBeLessThanOrEqual(r.pitch[1]);
        expect(p.rate, `${kind} ${key}`).toBeGreaterThanOrEqual(r.rate[0]);
        expect(p.rate, `${kind} ${key}`).toBeLessThanOrEqual(r.rate[1]);
        expect(Number.isInteger(p.voiceIndex)).toBe(true);
        expect(p.voiceIndex).toBeGreaterThanOrEqual(0);
        expect(p.voiceIndex).toBeLessThan(VOICE_INDEX_COUNT);
      }
    }
  });

  it('gives different officers distinct voices', () => {
    const profiles = KEYS.map((k) => voiceProfileFor(k, 'officer'));
    const pitches = new Set(profiles.map((p) => p.pitch));
    const indices = new Set(profiles.map((p) => p.voiceIndex));
    const combos = new Set(profiles.map((p) => `${p.pitch}/${p.rate}/${p.voiceIndex}`));
    expect(pitches.size).toBeGreaterThan(30);
    expect(indices.size).toBeGreaterThan(20);
    expect(combos.size).toBe(KEYS.length);
    // Spread over the pitch range, not clustered.
    const sorted = [...pitches].sort((a, b) => a - b);
    expect((sorted.at(-1) ?? 0) - (sorted[0] ?? 0)).toBeGreaterThan(0.25);
  });

  it('depends on the kind as well as the key', () => {
    expect(voiceProfileFor('12', 'officer')).not.toEqual(voiceProfileFor('12', 'player'));
  });
});
