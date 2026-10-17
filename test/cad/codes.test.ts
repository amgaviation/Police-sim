import { describe, expect, it } from 'vitest';
import { codeText, statusLabel, statusText } from '../../src/cad/codes';
import { TEN_CODES } from '../../src/cad/data';
import { UNIT_STATUSES, type RadioMode } from '../../src/cad/types';

const MODES: readonly RadioMode[] = ['tenCode', 'plain'];

describe('ten-codes', () => {
  it('gives the code and plain text of every key', () => {
    for (const [key, c] of Object.entries(TEN_CODES.codes)) {
      expect(codeText(key, 'tenCode')).toBe(c.code);
      expect(codeText(key, 'plain')).toBe(c.plain);
    }
    expect(codeText('available', 'tenCode')).toBe('10-8');
    expect(codeText('available', 'plain')).toBe('in service');
    expect(codeText('allOk', 'tenCode')).toBe('Code 4');
    expect(() => codeText('nope', 'plain')).toThrow(/nope/);
    expect(() => codeText('constructor', 'plain')).toThrow();
  });

  it('gives the text of every status in both modes', () => {
    for (const status of UNIT_STATUSES) {
      for (const mode of MODES) {
        const text = statusText(status, mode);
        expect(text.length).toBeGreaterThan(0);
        expect(text).toBe(codeText(TEN_CODES.statusKeys[status], mode));
      }
    }
    expect(statusText('enRoute', 'tenCode')).toBe('10-76');
    expect(statusText('onScene', 'plain')).toBe('on scene');
    expect(statusText('outOfService', 'tenCode')).toBe('10-7');
  });

  it('labels statuses for UIs', () => {
    expect(statusLabel('available')).toBe('10-8 AVAILABLE');
    expect(statusLabel('enRoute')).toBe('10-76 EN ROUTE');
    expect(statusLabel('onScene')).toBe('10-23 ON SCENE');
    expect(statusLabel('busy')).toBe('10-6 BUSY');
    expect(statusLabel('outOfService')).toBe('10-7 OUT OF SERVICE');
    expect(statusLabel('transporting')).toBe('10-15 TRANSPORTING');
    expect(statusLabel('busy')).toBe(statusLabel('busy'));
  });
});
