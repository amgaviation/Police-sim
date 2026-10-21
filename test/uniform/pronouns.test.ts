import { describe, expect, it } from 'vitest';
import linesJson from '../../src/data/uniform/lines.json';
import { applyPronouns, CHARACTER_LINES, isPronounSet, parseCharacterLines, PRONOUN_PRESETS, pronounLabel } from '../../src/uniform/pronouns';
import type { PronounSet } from '../../src/uniform/types';

const she = PRONOUN_PRESETS.she;
const he = PRONOUN_PRESETS.he;
const they = PRONOUN_PRESETS.they;
const xe: PronounSet = { id: 'custom', subject: 'xe', object: 'xem', possessive: 'xyr', possessivePronoun: 'xyrs', reflexive: 'xemself', plural: false };

describe('presets', () => {
  it('has the documented words', () => {
    expect(she).toEqual({ id: 'she', subject: 'she', object: 'her', possessive: 'her', possessivePronoun: 'hers', reflexive: 'herself', plural: false });
    expect(he).toEqual({ id: 'he', subject: 'he', object: 'him', possessive: 'his', possessivePronoun: 'his', reflexive: 'himself', plural: false });
    expect(they).toEqual({ id: 'they', subject: 'they', object: 'them', possessive: 'their', possessivePronoun: 'theirs', reflexive: 'themself', plural: true });
  });

  it('labels them', () => {
    expect(pronounLabel(she)).toBe('she/her');
    expect(pronounLabel(he)).toBe('he/him');
    expect(pronounLabel(they)).toBe('they/them');
    expect(pronounLabel(xe)).toBe('xe/xem');
  });
});

describe('isPronounSet', () => {
  it('accepts presets and custom sets', () => {
    for (const p of [she, he, they, xe]) expect(isPronounSet(p)).toBe(true);
  });

  it('rejects malformed sets', () => {
    expect(isPronounSet(null)).toBe(false);
    expect(isPronounSet('she')).toBe(false);
    expect(isPronounSet({ ...xe, id: 'zed' })).toBe(false);
    expect(isPronounSet({ ...xe, subject: '' })).toBe(false);
    expect(isPronounSet({ ...xe, object: 'x'.repeat(13) })).toBe(false);
    expect(isPronounSet({ ...xe, reflexive: 'xe1' })).toBe(false);
    expect(isPronounSet({ ...xe, possessive: 'x y' })).toBe(false);
    expect(isPronounSet({ ...xe, plural: 'no' })).toBe(false);
    expect(isPronounSet({ ...she, object: 'him' })).toBe(false);
    expect(isPronounSet({ ...they, plural: false })).toBe(false);
    expect(isPronounSet({ ...xe, subject: 'x'.repeat(12) })).toBe(true);
  });
});

describe('applyPronouns', () => {
  it('handles each verb token for each preset', () => {
    expect(applyPronouns('{they} {are}', she, {})).toBe('she is');
    expect(applyPronouns('{they} {are}', they, {})).toBe('they are');
    expect(applyPronouns('{they} {are}', he, {})).toBe('he is');
    expect(applyPronouns('{they} {were}', she, {})).toBe('she was');
    expect(applyPronouns('{they} {were}', they, {})).toBe('they were');
    expect(applyPronouns('{they} {have}', he, {})).toBe('he has');
    expect(applyPronouns('{they} {have}', they, {})).toBe('they have');
    expect(applyPronouns('{they} report{s}', she, {})).toBe('she reports');
    expect(applyPronouns('{they} report{s}', they, {})).toBe('they report');
  });

  it('fills every pronoun form', () => {
    const t = '{they}/{them}/{their}/{theirs}/{themself}';
    expect(applyPronouns(t, she, {})).toBe('she/her/her/hers/herself');
    expect(applyPronouns(t, he, {})).toBe('he/him/his/his/himself');
    expect(applyPronouns(t, they, {})).toBe('they/them/their/theirs/themself');
    expect(applyPronouns(t, xe, {})).toBe('xe/xem/xyr/xyrs/xemself');
  });

  it('capitalises the first letter of capitalised tokens', () => {
    expect(applyPronouns('{They} {have} filed. {Their} car. {Them}. {Theirs}. {Themself}.', she, {})).toBe(
      'She has filed. Her car. Her. Hers. Herself.',
    );
    expect(applyPronouns('{They} {Are} {Were} {Have}', they, {})).toBe('They Are Were Have');
    expect(applyPronouns('{They} {are}', xe, {})).toBe('Xe is');
  });

  it('substitutes vars, including name', () => {
    expect(applyPronouns('{callsign}, {name} is at {near}.', he, { callsign: 'A-12', name: 'Officer Doe', near: 'Elm St' })).toBe(
      'A-12, Officer Doe is at Elm St.',
    );
    expect(applyPronouns('{They} said {x}{x}', she, { x: '{they}' })).toBe('She said {they}{they}');
  });

  it('leaves unknown tokens and non-token braces as written', () => {
    expect(applyPronouns('{unknown} {name} {S} {} {1} {they', she, {})).toBe('{unknown} {name} {S} {} {1} {they');
    expect(applyPronouns('{constructor} {toString} {hasOwnProperty}', she, {})).toBe('{constructor} {toString} {hasOwnProperty}');
  });

  it('works on the shipped lines', () => {
    const down = applyPronouns(CHARACTER_LINES.officerDown ?? '', they, { callsign: 'A-12', name: 'Officer Jordan Doe', near: 'Oak Ave' });
    expect(down).toBe('A-12, shots fired! Officer Jordan Doe is hit, they are down at Oak Ave!');
    const report = applyPronouns(CHARACTER_LINES.damageReport ?? '', she, {
      name: 'Officer Ann Lee',
      pronouns: 'she/her',
      unit: 'P-7',
      zone: 'front',
      speed: '32',
      context: '',
    });
    expect(report).toBe('Officer Ann Lee (she/her) reported that she was operating unit P-7 when it sustained front damage at 32 km/h. She has filed this report.');
  });
});

describe('CHARACTER_LINES', () => {
  it('holds the five documented lines', () => {
    expect(Object.keys(CHARACTER_LINES).sort()).toEqual(['damageReport', 'inspection', 'officerDown', 'reportHeader', 'vestStopped']);
    expect(CHARACTER_LINES.vestStopped).toBe("{callsign}, I'm hit but the vest stopped it. I'm OK.");
    expect(CHARACTER_LINES.reportHeader).toBe('Reporting officer: {name} ({pronouns}), badge {badge}.');
    expect(CHARACTER_LINES.inspection).toBe('{name} inspected unit {unit}: {result}.');
  });

  it('validates the document', () => {
    expect(parseCharacterLines(linesJson, 'lines.json')).toEqual(CHARACTER_LINES);
    expect(() => parseCharacterLines({ version: 2, lines: {} }, 'lines.json')).toThrow('lines.json: version must be 1');
    expect(() => parseCharacterLines({ version: 1, lines: { officerDown: 'x' } }, 'lines.json')).toThrow('lines.json: lines.vestStopped is missing');
    expect(() => parseCharacterLines({ version: 1, lines: { ...CHARACTER_LINES, inspection: '' } }, 'lines.json')).toThrow(
      'lines.json: lines.inspection must be a non-empty string',
    );
  });
});
