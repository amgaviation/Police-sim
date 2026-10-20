/**
 * Recording tuning (design phase 5 §8.1): snapshot size, JPEG quality, capture interval and retention caps,
 * validated at import. Every validation error names the file and the dotted field.
 */
import recordingJson from '../data/recording/recording.json';
import { fail, readNumber, readObject, readVersion } from '../vehicles/json';
import type { RetentionPolicy } from './mediaStore';

const SOURCE = 'recording.json';

export interface RecordingConfig {
  /** Snapshot size in pixels (16:9). */
  readonly width: number;
  readonly height: number;
  /** JPEG quality in (0, 1]. */
  readonly quality: number;
  /** Sim seconds between snapshots while recording. */
  readonly intervalS: number;
  readonly perIncidentMax: number;
  readonly maxCount: number;
  readonly maxBytes: number;
  /** The dashcam records while the officer is within this many metres of the patrol car (read by the incident recorder). */
  readonly dashRangeM: number;
}

/** Validates the parsed JSON of `recording.json`; throws an `Error` naming the file and the field. */
export function parseRecordingConfig(raw: unknown, source: string = SOURCE): RecordingConfig {
  const root = readObject(raw, source, '');
  readVersion(root, source);
  const int = (key: string, min: number, max: number): number => {
    const n = readNumber(root[key], source, key, min, max);
    if (!Number.isInteger(n)) fail(source, key, `must be an integer, got ${String(n)}`);
    return n;
  };
  const quality = readNumber(root['quality'], source, 'quality', 0, 1);
  if (quality === 0) fail(source, 'quality', 'must be above 0');
  const intervalS = readNumber(root['intervalS'], source, 'intervalS', 0, 3600);
  if (intervalS === 0) fail(source, 'intervalS', 'must be above 0');
  return {
    width: int('width', 16, 1920),
    height: int('height', 9, 1080),
    quality,
    intervalS,
    perIncidentMax: int('perIncidentMax', 1, 100000),
    maxCount: int('maxCount', 1, 1000000),
    maxBytes: int('maxBytes', 1024, 2 ** 40),
    dashRangeM: readNumber(root['dashRangeM'], source, 'dashRangeM', 0, 1000),
  };
}

/** The shipped recording configuration. */
export const RECORDING: RecordingConfig = parseRecordingConfig(recordingJson);

/** The retention caps of a configuration. */
export function retentionOf(cfg: RecordingConfig = RECORDING): RetentionPolicy {
  return { maxCount: cfg.maxCount, maxBytes: cfg.maxBytes, perIncidentMax: cfg.perIncidentMax };
}
