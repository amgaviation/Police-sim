import { describe, expect, it } from 'vitest';
import { understanding } from '../../src/dialogue';
import type { SubjectProfile } from '../../src/dialogue';
import { complianceChance, understands } from '../../src/npc/compliance';
import { behavior } from '../../src/npc/data';
import { NPC_COMMANDS, type CommandContext } from '../../src/npc/types';
import type { Intoxication, NpcIdentity } from '../../src/people/types';
import { makeRig as makePeople } from '../people/helpers';
import { ctx } from './helpers';

const SOBER: Intoxication = { bac: 0, drug: 'none', level: 0 };
const people = makePeople().pop;

function find(pred: (i: NpcIdentity) => boolean): NpcIdentity {
  for (let id = 0; id < 40000; id++) {
    const i = people.identity(id);
    if (pred(i)) return i;
  }
  throw new Error('no matching person');
}

const plain = find((i) => i.hearing === 'normal' && i.language.english === 'fluent' && !i.dementia && !i.wanted && !i.juvenile && i.attitude > 0);
const deaf = find((i) => i.hearing === 'deaf' && i.language.english === 'fluent' && !i.dementia);
const hard = find((i) => i.hearing === 'hardOfHearing' && i.language.english === 'fluent' && !i.dementia);
const none = find((i) => i.hearing === 'normal' && i.language.english === 'none' && !i.dementia);
const limited = find((i) => i.hearing === 'normal' && i.language.english === 'limited' && !i.dementia);
const demented = find((i) => i.hearing === 'normal' && i.language.english === 'fluent' && i.dementia);
const wanted = find((i) => i.wanted && i.hearing === 'normal');
const juvenile = find((i) => i.juvenile && i.hearing === 'normal');
const bad = find((i) => i.attitude < -0.2 && !i.wanted && !i.juvenile);

describe('complianceChance', () => {
  const p = behavior('suspectEvasive');
  const base = (over: Partial<CommandContext> = {}, stress = 0, who: NpcIdentity | null = plain, intox: Intoxication = SOBER): number =>
    complianceChance(p, who, intox, stress, ctx(over), 'stop');

  it('starts at the profile compliance and stays inside [0.02, 0.98]', () => {
    expect(base()).toBeCloseTo(p.compliance, 5);
    for (const prof of ['suspectHostile', 'callerHelpful', 'subjectUnconscious', 'driverCooperative']) {
      for (const stress of [0, 0.5, 1]) {
        for (const weapon of ['none', 'sidearm', 'taser'] as const) {
          const v = complianceChance(behavior(prof), plain, SOBER, stress, ctx({ weapon, backup: 9, lights: true, rapport: 1, tone: 'commanding' }), 'stop');
          expect(v).toBeGreaterThanOrEqual(0.02);
          expect(v).toBeLessThanOrEqual(0.98);
        }
      }
    }
    expect(complianceChance(behavior('subjectUnconscious'), plain, { bac: 0.3, drug: 'opioid', level: 1 }, 1, ctx(), 'stop')).toBe(0.02);
  });

  it('a drawn weapon, backup, lights, rapport and a commanding tone raise it', () => {
    expect(base({ weapon: 'sidearm' })).toBeGreaterThan(base());
    expect(base({ weapon: 'taser' })).toBeGreaterThan(base());
    expect(base({ weapon: 'sidearm' })).toBeGreaterThan(base({ weapon: 'taser' }));
    expect(base({ backup: 1 })).toBeGreaterThan(base());
    expect(base({ backup: 3 })).toBeGreaterThan(base({ backup: 1 }));
    expect(base({ backup: 7 })).toBeCloseTo(base({ backup: 3 }), 10);
    expect(base({ lights: true })).toBeGreaterThan(base());
    expect(base({ rapport: 0.5 })).toBeGreaterThan(base());
    expect(base({ rapport: -0.5 })).toBeLessThan(base());
    expect(base({ tone: 'commanding' })).toBeGreaterThan(base({ tone: 'neutral' }));
    expect(base({ tone: 'shout' })).toBeGreaterThan(base({ tone: 'aggressive' }));
    expect(base({ tone: 'aggressive' })).toBeGreaterThan(base({ tone: 'polite' }));
    // Hostile demeanors weigh the weapon x1.5.
    const h = behavior('suspectHostile');
    const gain = (prof: typeof h): number => complianceChance(prof, plain, SOBER, 0, ctx({ weapon: 'sidearm' }), 'stop') - complianceChance(prof, plain, SOBER, 0, ctx(), 'stop');
    expect(gain(h)).toBeCloseTo(0.3, 10);
    expect(gain(p)).toBeCloseTo(0.2, 10);
  });

  it('stress, intoxication, a warrant and a bad attitude lower it', () => {
    expect(base({}, 0.5)).toBeLessThan(base({}, 0));
    expect(base({}, 1)).toBeLessThan(base({}, 0.5));
    expect(base({}, 0, plain, { bac: 0.1, drug: 'none', level: 0.5 })).toBeLessThan(base());
    expect(base({}, 0, plain, { bac: 0.2, drug: 'none', level: 1 })).toBeLessThan(base({}, 0, plain, { bac: 0.1, drug: 'none', level: 0.5 }));
    expect(base({}, 0, wanted)).toBeCloseTo(base({}, 0, { ...wanted, wanted: false }) - 0.15, 10);
    expect(base({}, 0, bad)).toBeLessThan(base({}, 0, { ...bad, attitude: 0.5 }));
    expect(base({}, 0, { ...plain, juvenile: true })).toBeCloseTo(base() + 0.05, 10);
    expect(juvenile.juvenile).toBe(true);
    // Animals (no identity) skip the identity terms.
    expect(base({}, 0, null)).toBeCloseTo(p.compliance, 10);
  });

  it('is monotonic in every term over a grid', () => {
    let last = -1;
    for (let backup = 0; backup <= 4; backup++) {
      const v = base({ backup });
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
    last = 2;
    for (let s = 0; s <= 1.0001; s += 0.1) {
      const v = base({}, s);
      expect(v).toBeLessThanOrEqual(last);
      last = v;
    }
  });

  it('release and returnToVehicle are always 0.98', () => {
    expect(complianceChance(behavior('suspectHostile'), plain, SOBER, 1, ctx(), 'release')).toBe(0.98);
    expect(complianceChance(behavior('suspectHostile'), plain, SOBER, 1, ctx(), 'returnToVehicle')).toBe(0.98);
  });
});

describe('understands', () => {
  it('is 1 for fluent hearing people and animals', () => {
    for (const c of NPC_COMMANDS) {
      expect(understands(plain, 'verbal', c)).toBe(1);
      expect(understands(null, 'verbal', c)).toBe(1);
    }
  });

  it('deaf people understand only written text and gestures (simple commands)', () => {
    expect(understands(deaf, 'verbal', 'stop')).toBe(0);
    expect(understands(deaf, 'interpreter', 'stop')).toBe(1);
    expect(understands(deaf, 'translationApp', 'handsUp')).toBe(1);
    expect(understands(deaf, 'gesture', 'stop')).toBe(0.9);
    for (const c of ['handsUp', 'getDown', 'comeHere', 'stayBack', 'showHands', 'dropWeapon'] as const) expect(understands(deaf, 'gesture', c)).toBe(0.9);
    for (const c of ['followMe', 'sitDown', 'stepOut', 'turnAround', 'walkBackward', 'turnOffEngine'] as const) expect(understands(deaf, 'gesture', c)).toBe(0);
    expect(understands(deaf, 'written', 'followMe')).toBe(1);
  });

  it('commands and questions agree on the aided modes (hearing x mode)', () => {
    const subjectOf = (identity: NpcIdentity): SubjectProfile => ({ identity }) as unknown as SubjectProfile;
    for (const who of [plain, deaf, hard]) {
      for (const mode of ['verbal', 'written', 'interpreter', 'translationApp'] as const) {
        expect(understands(who, mode, 'stop'), `${who.hearing} ${mode}`).toBeCloseTo(understanding(subjectOf(who), mode, 'greet').p, 10);
      }
    }
  });

  it('hard of hearing people understand 60 % of verbal commands but all written ones', () => {
    expect(understands(hard, 'verbal', 'stop')).toBeCloseTo(0.6, 10);
    expect(understands(hard, 'written', 'stop')).toBe(1);
    expect(understands(hard, 'gesture', 'stop')).toBe(1);
  });

  it('non-English speakers: none 0.6 / 0.1, limited 0.8 / 0.5, helped by an interpreter or app and by gestures', () => {
    expect(understands(none, 'verbal', 'stop')).toBeCloseTo(0.6, 10);
    expect(understands(none, 'verbal', 'followMe')).toBeCloseTo(0.1, 10);
    expect(understands(none, 'gesture', 'stop')).toBe(1);
    expect(understands(none, 'gesture', 'followMe')).toBeCloseTo(0.1, 10);
    expect(understands(none, 'interpreter', 'followMe')).toBe(1);
    expect(understands(none, 'translationApp', 'followMe')).toBe(1);
    expect(understands(limited, 'verbal', 'stop')).toBeCloseTo(0.8, 10);
    expect(understands(limited, 'verbal', 'sitDown')).toBeCloseTo(0.5, 10);
    expect(understands(limited, 'interpreter', 'sitDown')).toBe(1);
    expect(understands(none, 'verbal', 'stop')).toBeLessThan(understands(limited, 'verbal', 'stop'));
    expect(understands(none, 'verbal', 'stop')).toBeLessThan(understands(plain, 'verbal', 'stop'));
  });

  it('dementia halves it, and combines multiplicatively', () => {
    expect(understands(demented, 'verbal', 'stop')).toBeCloseTo(0.5, 10);
    expect(understands({ ...hard, dementia: true }, 'verbal', 'stop')).toBeCloseTo(0.3, 10);
    expect(understands({ ...none, hearing: 'hardOfHearing' }, 'verbal', 'stop')).toBeCloseTo(0.36, 10);
  });

  it('release and returnToVehicle are always understood', () => {
    expect(understands(deaf, 'verbal', 'release')).toBe(1);
    expect(understands(none, 'verbal', 'returnToVehicle')).toBe(1);
  });
});
