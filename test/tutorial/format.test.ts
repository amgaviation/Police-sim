import { describe, expect, it } from 'vitest';
import { formatTutorialText, tutorialTokens } from '../../src/tutorial';

const label = (id: string): string => `[${id.toUpperCase()}]`;

describe('formatTutorialText', () => {
  it('replaces action tokens with the key label', () => {
    expect(formatTutorialText('Press {interact} to get in.', label)).toBe('Press [INTERACT] to get in.');
    expect(formatTutorialText('{vehicle.lights} and {vehicle.siren}, {radio.cursorSelect}', label)).toBe('[VEHICLE.LIGHTS] and [VEHICLE.SIREN], [RADIO.CURSORSELECT]');
  });

  it('leaves unknown tokens and other braces as written', () => {
    expect(formatTutorialText('{nope} {vehicle.nope} {} { interact } {1}', label)).toBe('{nope} {vehicle.nope} {} { interact } {1}');
    expect(formatTutorialText('a {interact', label)).toBe('a {interact');
  });

  it('leaves a token whose label is empty (an unbound action) as written', () => {
    expect(formatTutorialText('Press {interact}', () => '')).toBe('Press {interact}');
  });

  it('calls labelOf once per token and handles repeats and plain text', () => {
    const asked: string[] = [];
    expect(formatTutorialText('{interact} then {interact}', (id) => (asked.push(id), 'E'))).toBe('E then E');
    expect(asked).toEqual(['interact', 'interact']);
    expect(formatTutorialText('no tokens', label)).toBe('no tokens');
    expect(formatTutorialText('', label)).toBe('');
  });

  it('does not rescan a label that itself looks like a token', () => {
    expect(formatTutorialText('{interact}', () => '{mdt.toggle}')).toBe('{mdt.toggle}');
  });
});

describe('tutorialTokens', () => {
  it('lists the distinct token ids in order', () => {
    expect(tutorialTokens('{interact} {mdt.toggle} {interact} x')).toEqual(['interact', 'mdt.toggle']);
    expect(tutorialTokens('none')).toEqual([]);
  });
});
