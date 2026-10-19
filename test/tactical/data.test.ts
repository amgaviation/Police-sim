import { describe, expect, it } from 'vitest';
import tacticsJson from '../../src/data/tactics/tactics.json';
import { TACTICS, validateTactics } from '../../src/tactical/data';
import { SOUND_KINDS } from '../../src/tactical/sound';

interface Json {
  [key: string]: Json | number | string;
}
const clone = (): Json => JSON.parse(JSON.stringify(tacticsJson)) as Json;
/** The object at `path` below `j`. */
const at = (j: Json, ...path: string[]): Json => path.reduce<Json>((o, k) => o[k] as Json, j);

describe('tactics.json', () => {
  it('loads the design numbers', () => {
    expect(TACTICS.sound.wallDb).toBe(35);
    expect(TACTICS.sound.exteriorWallDb).toBe(40);
    expect(TACTICS.sound.hearing).toEqual({ normal: 20, hardOfHearing: 40, asleepBonus: 20 });
    expect(TACTICS.sound.footstepDb['carpet']).toBe(28);
    expect(TACTICS.sound.sources.kick).toBe(95);
    expect(TACTICS.sound.sources.radioEarpiece).toBe(22);
    expect(TACTICS.stance.standEye).toBe(1.65);
    expect(TACTICS.slice.maxAngle).toBe(1.4);
    expect(TACTICS.notice.periodS).toBe(0.25);
    expect(TACTICS.partner.followM).toBe(1.6);
  });

  it('has a source level for every non-footstep sound kind', () => {
    for (const k of SOUND_KINDS) if (k !== 'footstep') expect(TACTICS.sound.sources[k]).toBeGreaterThan(0);
  });

  it('accepts the shipped file', () => {
    expect(validateTactics(clone())).toEqual(TACTICS);
  });

  it('rejects problems with an error naming the file and the path', () => {
    const cases: [string, (j: Json) => void, RegExp][] = [
      ['version', (j) => { j['version'] = 2; }, /tactics\.json: version must be 1/],
      ['missing section', (j) => { delete j['slice']; }, /tactics\.json: slice must be an object/],
      ['unknown top-level key', (j) => { j['extra'] = 1; }, /tactics\.json: extra is not a known field/],
      ['unknown nested key', (j) => { at(j, 'stance')['crouchSpeedd'] = 1; }, /stance\.crouchSpeedd is not a known field/],
      ['missing number', (j) => { delete at(j, 'sound')['wallDb']; }, /sound\.wallDb must be a finite number/],
      ['string number', (j) => { at(j, 'sound')['wallDb'] = '35'; }, /sound\.wallDb must be a finite number/],
      ['negative level', (j) => { at(j, 'sound', 'sources')['kick'] = -1; }, /sound\.sources\.kick must be in/],
      ['missing sound kind', (j) => { delete at(j, 'sound', 'sources')['announce']; }, /sound\.sources\.announce/],
      ['unknown sound kind', (j) => { at(j, 'sound', 'sources')['gunshot'] = 120; }, /sound\.sources\.gunshot is not a known field/],
      ['missing surface', (j) => { delete at(j, 'sound', 'footstepDb')['sand']; }, /sound\.footstepDb\.sand/],
      ['door order', (j) => { at(j, 'sound')['doorOpenDb'] = 30; }, /sound\.doorOpenDb must not exceed doorClosedDb/],
      ['eye order', (j) => { at(j, 'stance')['crouchEye'] = 2; }, /stance\.crouchEye must be below standEye/],
      ['slice angle', (j) => { at(j, 'slice')['maxAngle'] = 1.6; }, /slice\.maxAngle must be in/],
      ['slice radius', (j) => { at(j, 'slice')['radiusMax'] = 1; }, /slice\.radiusMax must be at least radiusMin/],
      ['cos range', (j) => { at(j, 'notice')['fovCos'] = 2; }, /notice\.fovCos must be in/],
      ['colour', (j) => { at(j, 'partner', 'colors')['top'] = 'red'; }, /partner\.colors\.top must be a finite number/],
      ['not an object', () => undefined, /tactics\.json: must be an object/],
    ];
    for (const [name, mutate, message] of cases) {
      const j = clone();
      mutate(j);
      expect(() => validateTactics(name === 'not an object' ? 5 : j), name).toThrow(message);
    }
  });
});
