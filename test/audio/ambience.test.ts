import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import { AmbienceBed } from '../../src/audio/ambience';
import { AMBIENCE_DATA, AMBIENCE_LAYERS, parseAmbience } from '../../src/audio/ambienceData';
import { ambienceGains, nextChirpS, type AmbienceParams } from '../../src/audio/ambienceMath';
import { createAudioStats } from '../../src/audio/sirens';
import { DISTRICT_NAMES } from '../../src/world/ids';
import ambienceJson from '../../src/data/audio/ambience.json';
import { fakeGraph, type FakeBiquad, type FakeContext, type FakeGain, type FakeOscillator } from './fakeAudio';

function params(over: Partial<AmbienceParams> = {}): AmbienceParams {
  return { district: 'downtown', hour: 8, weather: 'clear', rain: 0, wind: 0, indoor: false, inCabin: false, ...over };
}

function gains(over: Partial<AmbienceParams> = {}): Record<string, number> {
  const out = new Float32Array(AMBIENCE_DATA.layers.length);
  ambienceGains(params(over), AMBIENCE_DATA, out);
  const rec: Record<string, number> = {};
  AMBIENCE_LAYERS.forEach((id, i) => {
    rec[id] = out[i] ?? 0;
  });
  return rec;
}

describe('ambience.json', () => {
  it('has one layer per AMBIENCE_LAYERS id, in order, with 24 hour factors', () => {
    expect(AMBIENCE_DATA.layers.map((l) => l.id)).toEqual([...AMBIENCE_LAYERS]);
    for (const l of AMBIENCE_DATA.layers) expect(l.hours).toHaveLength(24);
    expect(AMBIENCE_DATA.layers[1]?.hours.every((h) => h === 1)).toBe(true);
    expect(AMBIENCE_DATA.indoorLowpassHz).toBe(600);
    expect(AMBIENCE_DATA.cabinLowpassHz).toBe(900);
    expect(AMBIENCE_DATA.cabinFactor).toBe(0.5);
  });

  it('covers every district of the map in the traffic layer', () => {
    const traffic = AMBIENCE_DATA.layers[0];
    for (const d of DISTRICT_NAMES) expect(traffic?.district[d], d).toBeGreaterThan(0);
  });

  it('names the file and the dotted path on bad data', () => {
    const clone = (): { layers: Record<string, unknown>[] } => JSON.parse(JSON.stringify(ambienceJson)) as { layers: Record<string, unknown>[] };
    expect(() => parseAmbience({ ...ambienceJson, version: 2 })).toThrow(/ambience\.json: version/);
    const wrongOrder = clone();
    wrongOrder.layers.reverse();
    expect(() => parseAmbience(wrongOrder)).toThrow(/ambience\.json: layers\[0\]\.id/);
    const shortHours = clone();
    (shortHours.layers[0] as { hours: number[] }).hours = [1, 2, 3];
    expect(() => parseAmbience(shortHours)).toThrow(/ambience\.json: layers\[0\]\.hours/);
    const badDistrict = clone();
    (badDistrict.layers[0] as { district: Record<string, number> }).district['atlantis'] = 1;
    expect(() => parseAmbience(badDistrict)).toThrow(/ambience\.json: layers\[0\]\.district\.atlantis/);
    const badWeather = clone();
    (badWeather.layers[0] as { weather: Record<string, number> }).weather['hail'] = 1;
    expect(() => parseAmbience(badWeather)).toThrow(/layers\[0\]\.weather\.hail/);
    const noFilter = clone();
    delete (noFilter.layers[0] as { filter?: unknown }).filter;
    expect(() => parseAmbience(noFilter)).toThrow(/layers\[0\]\.filter/);
    const badDrive = clone();
    (badDrive.layers[2] as { drive: string }).drive = 'snow';
    expect(() => parseAmbience(badDrive)).toThrow(/layers\[2\]\.drive/);
    const negative = clone();
    (negative.layers[3] as { gain: number }).gain = -1;
    expect(() => parseAmbience(negative)).toThrow(/layers\[3\]\.gain/);
    expect(() => parseAmbience({ ...ambienceJson, layers: ambienceJson.layers.slice(0, 3) })).toThrow(/ambience\.json: layers/);
    expect(() => parseAmbience(42)).toThrow(/ambience\.json/);
    expect(() => parseAmbience(ambienceJson, 'mod.json')).not.toThrow();
    expect(() => parseAmbience({ ...ambienceJson, version: 9 }, 'mod.json')).toThrow(/mod\.json: version/);
  });
});

describe('ambienceGains', () => {
  it('downtown 08:00 clear outdoors: traffic is exactly its layer gain', () => {
    const g = gains();
    expect(g['traffic']).toBeCloseTo(0.45, 6);
    expect(g['hum']).toBeCloseTo(0.06, 6);
    expect(g['wind']).toBe(0);
    expect(g['rain']).toBe(0);
    expect(g['water']).toBe(0);
  });

  it('interpolates linearly between whole hours', () => {
    // traffic hours: 8 -> 1, 9 -> 0.9
    expect(gains({ hour: 8.5 })['traffic']).toBeCloseTo(0.45 * 0.95, 6);
    expect(gains({ hour: 8.25 })['traffic']).toBeCloseTo(0.45 * 0.975, 6);
    expect(gains({ hour: 9 })['traffic']).toBeCloseTo(0.45 * 0.9, 6);
  });

  it('wraps from 23 to 0 and accepts hours outside 0..24', () => {
    // hours[23] = 0.4, hours[0] = 0.35
    expect(gains({ hour: 23.5 })['traffic']).toBeCloseTo(0.45 * 0.375, 6);
    expect(gains({ hour: 24 })['traffic']).toBeCloseTo(0.45 * 0.35, 6);
    expect(gains({ hour: 32 })['traffic']).toBeCloseTo(gains({ hour: 8 })['traffic'] ?? -1, 6);
    expect(gains({ hour: -1 })['traffic']).toBeCloseTo(gains({ hour: 23 })['traffic'] ?? -1, 6);
    expect(gains({ hour: Number.NaN })['traffic']).toBeCloseTo(gains({ hour: 0 })['traffic'] ?? -1, 6);
  });

  it('applies district factors, with "*" for unlisted districts and 0 when there is no "*"', () => {
    expect(gains({ district: 'rural' })['traffic']).toBeCloseTo(0.45 * 0.15, 6);
    // hum: downtown 1, "*" 0.3
    expect(gains({ district: 'park' })['hum']).toBeCloseTo(0.06 * 0.3, 6);
    expect(gains({ district: 'atlantis' })['hum']).toBeCloseTo(0.06 * 0.3, 6);
    // traffic has no "*": unknown district -> 0
    expect(gains({ district: 'atlantis' })['traffic']).toBe(0);
    // water: only the waterfront districts
    expect(gains({ district: 'harbor' })['water']).toBeCloseTo(0.3, 6);
    expect(gains({ district: 'downtown' })['water']).toBe(0);
    expect(gains({ district: 'constructor' })['traffic']).toBe(0);
  });

  it('birds by day and crickets by night in the park', () => {
    const dawn = gains({ district: 'park', hour: 6 });
    expect(dawn['birds']).toBeGreaterThan(0);
    expect(dawn['birds']).toBeCloseTo(0.12 * 1.4, 6);
    const night = gains({ district: 'park', hour: 1 });
    expect(night['birds']).toBe(0);
    expect(night['crickets']).toBeCloseTo(0.05 * 1.4, 6);
    // 05:00: crickets at their 0.1 hour factor
    expect(gains({ district: 'park', hour: 5 })['crickets']).toBeCloseTo(0.05 * 1.4 * 0.1, 6);
    expect(gains({ district: 'park', hour: 12 })['crickets']).toBe(0);
  });

  it('weather factors: absent key = 1, storm silences the birds, rain thins them', () => {
    const park = { district: 'park', hour: 7 } as const;
    const clear = gains({ ...park })['birds'] ?? 0;
    expect(gains({ ...park, weather: 'cloudy' })['birds']).toBeCloseTo(clear, 9);
    expect(gains({ ...park, weather: 'rain' })['birds']).toBeCloseTo(clear * 0.2, 6);
    expect(gains({ ...park, weather: 'storm' })['birds']).toBe(0);
    expect(gains({ weather: 'snow' })['traffic']).toBeCloseTo(0.45 * 0.7, 6);
    expect(gains({ district: 'harbor', weather: 'storm' })['water']).toBeCloseTo(0.3 * 1.5, 6);
    expect(gains({ weather: 'tornado' })['traffic']).toBeCloseTo(0.45, 6);
  });

  it('indoors multiplies by the layer indoor factor', () => {
    const out = gains({ indoor: true });
    expect(out['traffic']).toBeCloseTo(0.45 * 0.25, 6);
    expect(out['hum']).toBeCloseTo(0.06 * 1.5, 6);
    expect(gains({ indoor: true, district: 'park', hour: 6 })['birds']).toBe(0);
  });

  it('the cabin factor halves everything', () => {
    const open = gains();
    const cabin = gains({ inCabin: true });
    for (const id of AMBIENCE_LAYERS) expect(cabin[id], id).toBeCloseTo((open[id] ?? 0) * 0.5, 7);
    // indoors and in a cabin multiply
    expect(gains({ indoor: true, inCabin: true })['traffic']).toBeCloseTo(0.45 * 0.25 * 0.5, 6);
  });

  it('the rain layer scales linearly with the rain level', () => {
    expect(gains({ rain: 0 })['rain']).toBe(0);
    expect(gains({ rain: 0.5 })['rain']).toBeCloseTo(0.25, 6);
    expect(gains({ rain: 1 })['rain']).toBeCloseTo(0.5, 6);
    expect(gains({ rain: 2 })['rain']).toBeCloseTo(0.5, 6);
    expect(gains({ rain: -1 })['rain']).toBe(0);
    expect(gains({ rain: Number.NaN })['rain']).toBe(0);
  });

  it('the wind layer follows wind / 12 and clamps at 1', () => {
    expect(gains({ wind: 6 })['wind']).toBeCloseTo(0.4 * 0.5, 6);
    expect(gains({ wind: 12 })['wind']).toBeCloseTo(0.4, 6);
    expect(gains({ wind: 24 })['wind']).toBeCloseTo(0.4, 6);
    expect(gains({ wind: -24 })['wind']).toBe(0);
  });

  it('writes only the layer slots and returns the output array', () => {
    const out = new Float32Array(10).fill(-1);
    const r = ambienceGains(params(), AMBIENCE_DATA, out);
    expect(r).toBe(out);
    expect(out[7]).toBe(-1);
    expect(out[6]).toBeGreaterThanOrEqual(0);
  });

  it('allocates nothing observable and is stable over many calls', () => {
    const out = new Float32Array(AMBIENCE_DATA.layers.length);
    const p = params();
    ambienceGains(p, AMBIENCE_DATA, out);
    const first = Array.from(out);
    for (let i = 0; i < 20000; i++) ambienceGains(p, AMBIENCE_DATA, out);
    expect(Array.from(out)).toEqual(first);
  });
});

describe('nextChirpS', () => {
  it('is deterministic for a seed', () => {
    const a = createRng('audio:test');
    const b = createRng('audio:test');
    for (let i = 0; i < 20; i++) expect(nextChirpS(a, 0.6, 1)).toBe(nextChirpS(b, 0.6, 1));
  });

  it('is Infinity at rate 0 (rate or level) and does not draw', () => {
    const rng = createRng('audio:test');
    const before = rng.state();
    expect(nextChirpS(rng, 0, 1)).toBe(Infinity);
    expect(nextChirpS(rng, 0.6, 0)).toBe(Infinity);
    expect(nextChirpS(rng, -1, 1)).toBe(Infinity);
    expect(rng.state()).toEqual(before);
  });

  it('is exponential with mean 1 / (rate * level)', () => {
    const rng = createRng('audio:mean');
    let sum = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) {
      const v = nextChirpS(rng, 0.6, 0.5);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(v)).toBe(true);
      sum += v;
    }
    expect(sum / n).toBeGreaterThan((1 / 0.3) * 0.95);
    expect(sum / n).toBeLessThan((1 / 0.3) * 1.05);
  });

  it('a higher level gives shorter waits for the same draw', () => {
    const a = createRng('audio:same');
    const b = createRng('audio:same');
    expect(nextChirpS(a, 0.6, 1)).toBeLessThan(nextChirpS(b, 0.6, 0.25));
  });
});

interface BedRig {
  ctx: FakeContext;
  bed: AmbienceBed;
  stats: ReturnType<typeof createAudioStats>;
  post: FakeBiquad;
  /** Layer gain nodes (the ones feeding the post low-pass) in AMBIENCE_LAYERS order. */
  layers: FakeGain[];
}

function bedRig(): BedRig {
  const { ctx, ac, out, noise } = fakeGraph();
  const stats = createAudioStats();
  const bed = new AmbienceBed(stats);
  bed.build(ac, out as unknown as AudioNode, noise);
  const post = ctx.nodesOf<FakeBiquad>('biquad')[0] as FakeBiquad;
  const layers = ctx.nodesOf<FakeGain>('gain').filter((g) => g.connections.includes(post));
  return { ctx, bed, stats, post, layers };
}

describe('AmbienceBed', () => {
  it('builds one chain per layer into a shared low-pass', () => {
    const r = bedRig();
    expect(r.layers).toHaveLength(AMBIENCE_LAYERS.length);
    expect(r.post.connections).toHaveLength(1);
    expect(r.post.frequency.value).toBeGreaterThanOrEqual(20000);
    expect(r.layers.every((g) => g.gain.value === 0)).toBe(true);
    // idempotent
    const total = r.ctx.totalCreated;
    const { ac, out, noise } = fakeGraph();
    r.bed.build(ac, out as unknown as AudioNode, noise);
    expect(r.ctx.totalCreated).toBe(total);
  });

  it('is a no-op before build and after detach', () => {
    const bed = new AmbienceBed();
    expect(() => bed.update(params(), 0.016)).not.toThrow();
    const r = bedRig();
    r.bed.detach();
    const writes = r.ctx.paramWrites;
    r.bed.update(params(), 0.016);
    expect(r.ctx.paramWrites).toBe(writes);
    expect(r.stats.ambienceLayers).toBe(0);
  });

  it('glides every layer gain toward its target (tau 0.5 s) and counts the audible layers', () => {
    const r = bedRig();
    r.bed.update(params({ district: 'harbor', hour: 12, rain: 1, wind: 12 }), 0.016);
    const expected = gains({ district: 'harbor', hour: 12, rain: 1, wind: 12 });
    AMBIENCE_LAYERS.forEach((id, i) => {
      expect(r.layers[i]?.gain.target, id).toBeCloseTo(expected[id] ?? 0, 6);
    });
    expect(r.layers[0]?.gain.events.some((e) => e.kind === 'setTargetAtTime')).toBe(true);
    expect(r.stats.ambienceLayers).toBe(AMBIENCE_LAYERS.filter((id) => (expected[id] ?? 0) > 0.001).length);
    // weather change: rain stops
    r.bed.update(params({ district: 'harbor', hour: 12, rain: 0, wind: 0 }), 0.016);
    expect(r.layers[3]?.gain.target).toBe(0);
    expect(r.layers[2]?.gain.target).toBe(0);
  });

  it('does not rewrite unchanged gains', () => {
    const r = bedRig();
    r.bed.update(params(), 0.016);
    const writes = r.ctx.paramWrites;
    r.bed.update(params(), 0.016);
    // only chirp / filter bookkeeping could write; with nothing changed no param is touched
    expect(r.ctx.paramWrites).toBe(writes);
  });

  it('muffles the shared low-pass indoors (600 Hz) and in a cabin (900 Hz)', () => {
    const r = bedRig();
    r.bed.update(params(), 0.016);
    expect(r.post.frequency.target).toBeGreaterThanOrEqual(20000);
    r.bed.update(params({ indoor: true }), 0.016);
    expect(r.post.frequency.target).toBe(600);
    r.bed.update(params({ inCabin: true }), 0.016);
    expect(r.post.frequency.target).toBe(900);
    r.bed.update(params({ indoor: true, inCabin: true }), 0.016);
    expect(r.post.frequency.target).toBe(600);
    r.bed.update(params(), 0.016);
    expect(r.post.frequency.target).toBeGreaterThanOrEqual(20000);
  });

  it('keeps the node count fixed over 1000 updates except for at most 3 live chirps', () => {
    const r = bedRig();
    const base = r.ctx.totalCreated;
    const baseOsc = r.ctx.created['oscillator'] ?? 0;
    for (let f = 0; f < 1000; f++) {
      r.ctx.currentTime = 0; // chirps never finish: the live cap binds
      r.bed.update(params({ district: 'park', hour: 6.5, weather: f % 300 < 150 ? 'clear' : 'cloudy', rain: (f % 100) / 100, wind: f % 20 }), 1 / 60);
    }
    const chirps = (r.ctx.created['oscillator'] ?? 0) - baseOsc;
    expect(chirps).toBeGreaterThan(0);
    expect(chirps).toBeLessThanOrEqual(3);
    // each chirp is one oscillator and one envelope gain
    expect(r.ctx.totalCreated - base).toBe(chirps * 2);
  });

  it('keeps spawning chirps as earlier ones end, never more than 3 at once, and cleans them up', () => {
    const r = bedRig();
    let live = 0;
    let max = 0;
    let spawned = 0;
    const seen = new Set<FakeOscillator>();
    const baseOsc = r.ctx.nodesOf<FakeOscillator>('oscillator').length;
    for (let f = 0; f < 6000; f++) {
      r.ctx.currentTime = f / 60;
      r.bed.update(params({ district: 'park', hour: 6.5 }), 1 / 60);
      for (const o of r.ctx.nodesOf<FakeOscillator>('oscillator').slice(baseOsc)) {
        if (!seen.has(o)) {
          seen.add(o);
          spawned++;
          live++;
        }
        // simulate the browser: onended fires when the scheduled stop time has passed
        if (o.stoppedAt !== null && r.ctx.currentTime >= o.stoppedAt && o.onended) {
          const fn = o.onended;
          o.onended = null;
          fn();
          live--;
        }
      }
      max = Math.max(max, live);
    }
    // ~100 s at 0.6 x 1.4 x 1 chirps per second
    expect(spawned).toBeGreaterThan(20);
    expect(max).toBeLessThanOrEqual(3);
    const finished = [...seen].filter((o) => o.disconnected > 0);
    expect(finished.length).toBeGreaterThan(0);
  });

  it('schedules chirps as 2-4 sweeps from 2.5 to 4.5 kHz of 80 ms (seeded, deterministic)', () => {
    const run = (): { start: number; ramp: number; time: number }[] => {
      const r = bedRig();
      const baseOsc = r.ctx.nodesOf<FakeOscillator>('oscillator').length;
      for (let f = 0; f < 1200; f++) {
        r.ctx.currentTime = f / 60;
        r.bed.update(params({ district: 'park', hour: 6.5 }), 1 / 60);
        if (r.ctx.nodesOf<FakeOscillator>('oscillator').length > baseOsc) break;
      }
      const osc = r.ctx.nodesOf<FakeOscillator>('oscillator')[baseOsc];
      expect(osc?.type).toBe('sine');
      const ev = osc?.frequency.events ?? [];
      const sets = ev.filter((e) => e.kind === 'setValueAtTime');
      const ramps = ev.filter((e) => e.kind === 'exponentialRamp');
      expect(sets.length).toBeGreaterThanOrEqual(2);
      expect(sets.length).toBeLessThanOrEqual(4);
      expect(ramps).toHaveLength(sets.length);
      sets.forEach((s, i) => {
        expect(s.value).toBeGreaterThan(2250);
        expect(s.value).toBeLessThan(2750);
        const ramp = ramps[i];
        expect(ramp?.value).toBeGreaterThan(4050);
        expect((ramp?.time ?? 0) - s.time).toBeCloseTo(0.08, 9);
      });
      expect(osc?.started).not.toBeNull();
      expect(osc?.stoppedAt).toBeGreaterThan(osc?.started?.when ?? Infinity);
      return ev.map((e) => ({ start: e.value, ramp: e.time - (osc?.started?.when ?? 0), time: e.time }));
    };
    expect(run()).toEqual(run());
  });

  it('chirps nothing where the bird level is 0 (night, downtown) and in a storm', () => {
    for (const p of [params({ district: 'park', hour: 2 }), params({ district: 'park', hour: 7, weather: 'storm' })]) {
      const r = bedRig();
      const base = r.ctx.totalCreated;
      for (let f = 0; f < 2000; f++) {
        r.ctx.currentTime = f / 60;
        r.bed.update(p, 1 / 60);
      }
      expect(r.ctx.totalCreated).toBe(base);
    }
  });
});
