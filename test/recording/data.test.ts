import { describe, expect, it } from 'vitest';
import { RECORDING, parseRecordingConfig, retentionOf } from '../../src/recording';
import json from '../../src/data/recording/recording.json';

describe('recording.json', () => {
  it('ships the design values', () => {
    expect(RECORDING).toEqual({
      width: 160, height: 90, quality: 0.5, intervalS: 3, perIncidentMax: 200, maxCount: 3000, maxBytes: 16777216, dashRangeM: 30,
    });
    expect(retentionOf()).toEqual({ maxCount: 3000, maxBytes: 16777216, perIncidentMax: 200 });
  });

  it('is 16:9', () => {
    expect(RECORDING.width * 9).toBe(RECORDING.height * 16);
  });

  it('rejects bad input naming the file and the field', () => {
    const bad = (patch: Record<string, unknown>): unknown => ({ ...json, ...patch });
    expect(() => parseRecordingConfig(bad({ version: 2 }), 'x.json')).toThrow(/x\.json: version/);
    expect(() => parseRecordingConfig(bad({ quality: 0 }))).toThrow(/quality/);
    expect(() => parseRecordingConfig(bad({ quality: 1.5 }))).toThrow(/quality/);
    expect(() => parseRecordingConfig(bad({ intervalS: 0 }))).toThrow(/intervalS/);
    expect(() => parseRecordingConfig(bad({ width: 160.5 }))).toThrow(/width/);
    expect(() => parseRecordingConfig(bad({ maxCount: 'many' }))).toThrow(/maxCount/);
    expect(() => parseRecordingConfig(null)).toThrow(/object/);
    const { dashRangeM: _dash, ...missing } = json;
    expect(() => parseRecordingConfig(missing)).toThrow(/dashRangeM/);
  });
});
