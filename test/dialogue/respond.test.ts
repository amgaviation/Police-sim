import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import {
  CONSENT_RETRY_RAPPORT,
  MODE_DELAY_S,
  available,
  commModes,
  commandLine,
  consentChance,
  initialMemory,
  officerLine,
  requirementMet,
  respond,
  slur,
  toneEffect,
  understanding,
  utterance,
  type DialogueContext,
  type SubjectMemory,
  type SubjectProfile,
  type Tone,
} from '../../src/dialogue';
import { ctxOf, identityOf, item, memoryOf, subjectOf } from './helpers';

const ID = 7;

function run(uid: string, subject: SubjectProfile, ctx: DialogueContext, memory: SubjectMemory, seed = 1) {
  return respond(utterance(uid), subject, ctx, memory, createRng(seed));
}

describe('tone and memory transitions', () => {
  it('applies the tone table and clamps to the bounds', () => {
    const subject = subjectOf(ID, { demeanor: 'nervous' });
    const expected: [Tone, number, number][] = [
      ['polite', 0.08, -0.03],
      ['neutral', 0, 0],
      ['commanding', -0.02, 0.05],
      ['aggressive', -0.12, 0.12],
    ];
    for (const [tone, dr, ds] of expected) {
      const m = memoryOf(subject, ctxOf(), 0, 0.5);
      toneEffect(m, tone, 'nervous', 14, 'greet');
      expect(m.rapport).toBeCloseTo(dr, 10);
      expect(m.stress).toBeCloseTo(0.5 + ds, 10);
    }
    const hostile = memoryOf(subject, ctxOf(), 0, 0.5);
    toneEffect(hostile, 'aggressive', 'hostile', 14, 'greet');
    expect(hostile.rapport).toBeCloseTo(-0.24, 10);
    expect(hostile.stress).toBeCloseTo(0.74, 10);
    const crisis = memoryOf(subject, ctxOf(), 0, 0.5);
    toneEffect(crisis, 'aggressive', 'crisis', 14, 'greet');
    expect(crisis.stress).toBeCloseTo(0.74, 10);
    const night = memoryOf(subject, ctxOf(), 0, 0.5);
    toneEffect(night, 'neutral', 'nervous', 23, 'greet');
    expect(night.stress).toBeCloseTo(0.52, 10);
    const early = memoryOf(subject, ctxOf(), 0, 0.5);
    toneEffect(early, 'neutral', 'nervous', 4, 'greet');
    expect(early.stress).toBeCloseTo(0.52, 10);
    const reassure = memoryOf(subject, ctxOf(), 0, 0.5);
    toneEffect(reassure, 'polite', 'nervous', 14, 'reassure');
    expect(reassure.stress).toBeCloseTo(0.5 - 0.03 - 0.225, 10);
  });

  it('keeps rapport in [-1, 1] and stress in [0, 1] under any tone sequence', () => {
    const subject = subjectOf(ID, { demeanor: 'hostile' });
    const rng = createRng(5);
    const tones: Tone[] = ['polite', 'neutral', 'commanding', 'aggressive'];
    let m = memoryOf(subject, ctxOf(), 0, 0.5);
    for (let i = 0; i < 300; i++) {
      const tone = rng.pick(tones);
      const r = respond(utterance('greet'), subject, ctxOf({ tone, hour: rng.nextInt(0, 23) }), m, rng);
      m = r.memory;
      expect(m.rapport).toBeGreaterThanOrEqual(-1);
      expect(m.rapport).toBeLessThanOrEqual(1);
      expect(m.stress).toBeGreaterThanOrEqual(0);
      expect(m.stress).toBeLessThanOrEqual(1);
    }
  });

  it('does not mutate the memory it is given', () => {
    const subject = subjectOf(ID);
    const m = memoryOf(subject, ctxOf());
    const before = JSON.stringify(m);
    run('askDestination', subject, ctxOf({ tone: 'aggressive' }), m);
    expect(JSON.stringify(m)).toBe(before);
  });

  it('is deterministic for a given rng', () => {
    const subject = subjectOf(ID, { guilty: true }, { honesty: 0.2 });
    const ctx = ctxOf();
    const a = run('askDestination', subject, ctx, memoryOf(subject, ctx), 99);
    const b = run('askDestination', subject, ctx, memoryOf(subject, ctx), 99);
    expect(a).toEqual(b);
  });

  it('escalates a hostile subject to flee or fight under sustained aggression', () => {
    const subject = subjectOf(ID, { demeanor: 'hostile' });
    const seen = new Set<string>();
    for (let seed = 0; seed < 60; seed++) {
      const rng = createRng(seed);
      let m = memoryOf(subject, ctxOf(), 0, 0.3);
      let escalated: string | null = null;
      for (let i = 0; i < 8 && escalated === null; i++) {
        const r = respond(utterance('requestId'), subject, ctxOf({ tone: 'aggressive' }), m, rng);
        m = r.memory;
        escalated = r.escalate;
        if (r.escalate !== null) {
          expect(r.lineKey).toBe(`escalate.${r.escalate}`);
          expect(r.statement).toBeNull();
          expect(m.stress).toBeGreaterThan(0.85);
        }
      }
      expect(escalated, `seed ${seed}`).not.toBeNull();
      seen.add(escalated ?? '');
    }
    expect([...seen].sort()).toEqual(['fight', 'flee']);
  });

  it('only lets an evasive subject flee, and never escalates a calm one', () => {
    const evasive = subjectOf(ID, { demeanor: 'evasive' });
    for (let seed = 0; seed < 20; seed++) {
      const r = run('requestId', evasive, ctxOf(), memoryOf(evasive, ctxOf(), 0, 0.95), seed);
      expect(r.escalate).toBe('flee');
    }
    const coop = subjectOf(ID, { demeanor: 'cooperative' });
    expect(run('greet', coop, ctxOf(), memoryOf(coop, ctxOf(), 0, 0.99)).escalate).toBeNull();
    const nervous = subjectOf(ID, { demeanor: 'nervous' });
    expect(run('greet', nervous, ctxOf(), memoryOf(nervous, ctxOf(), 0, 0.99)).escalate).toBeNull();
  });

  it('calms a subject in crisis once stress is low and rapport high', () => {
    const subject = subjectOf(ID, { demeanor: 'crisis' });
    let m = memoryOf(subject, ctxOf(), 0, 0.6);
    const rng = createRng(3);
    let calmedAt = -1;
    for (let i = 0; i < 12; i++) {
      const r = respond(utterance('reassure'), subject, ctxOf({ tone: 'polite' }), m, rng);
      m = r.memory;
      if (r.calmed && calmedAt < 0) calmedAt = i;
    }
    expect(calmedAt).toBeGreaterThan(0);
    expect(m.stress).toBeLessThan(0.25);
    expect(m.rapport).toBeGreaterThan(0.3);
    const tense = run('reassure', subject, ctxOf({ tone: 'polite' }), memoryOf(subject, ctxOf(), 0.9, 0.9));
    expect(tense.calmed).toBe(false);
  });

  it('builds initial memory from trust, history, presence and temperament', () => {
    const subject = subjectOf(ID, { guilty: true }, { temperament: 'calm', attitude: 0 });
    const base = initialMemory(subject, ctxOf());
    expect(base).toMatchObject({ greeted: false, reasonGiven: false, mirandized: false, identity: null, identityRefusals: 0, lies: {}, asked: {}, consent: {}, consentAskedAt: {} });
    const trusting = initialMemory(subject, ctxOf({ trust: 0.9 }));
    expect(trusting.rapport).toBeGreaterThan(base.rapport);
    const known = initialMemory(subject, ctxOf({ history: { count: 2, lastGame: 0, lastOutcome: 'warned', rapport: 0.8 } }));
    expect(known.rapport).toBeGreaterThan(base.rapport);
    const armed = initialMemory(subject, ctxOf({ presence: { lights: true, backup: 3, weapon: 'sidearm', uniform: true } }));
    expect(armed.stress).toBeGreaterThan(base.stress);
    const mufti = initialMemory(subject, ctxOf({ presence: { lights: false, backup: 0, weapon: 'none', uniform: false } }));
    expect(mufti.rapport).toBeLessThan(base.rapport);
    const timid = initialMemory(subjectOf(ID, {}, { temperament: 'timid' }), ctxOf());
    expect(timid.stress).toBeGreaterThan(initialMemory(subjectOf(ID, {}, { temperament: 'calm' }), ctxOf()).stress);
    for (const m of [base, trusting, armed, mufti]) {
      expect(m.rapport).toBeGreaterThanOrEqual(-1);
      expect(m.stress).toBeLessThanOrEqual(1);
    }
  });
});

describe('identity and refusals', () => {
  it('keeps the first identity claim and repeats it', () => {
    const subject = subjectOf(ID, {}, { honesty: 1 });
    const ctx = ctxOf();
    let found = null as ReturnType<typeof run> | null;
    for (let seed = 0; seed < 40 && found === null; seed++) {
      const r = run('requestId', subject, ctx, memoryOf(subject, ctx, 0.5), seed);
      if (r.identity !== null) found = r;
    }
    expect(found).not.toBeNull();
    const first = found as ReturnType<typeof run>;
    expect(first.memory.identity).toEqual(first.identity);
    expect(first.identity?.kind).toBe('true');
    for (let seed = 0; seed < 10; seed++) {
      const again = run('requestId', subject, ctx, first.memory, seed);
      expect(again.lineKey).toBe('identity.repeat');
      expect(again.identity).toBeNull();
      expect(again.memory.identity).toEqual(first.memory.identity);
      expect(again.memory.identityRefusals).toBe(first.memory.identityRefusals);
    }
    const name = run('askName', subject, ctx, first.memory);
    expect(name.lineKey).toBe('askName.say');
    expect(name.statement?.fact).toBe('name');
    expect(name.statement?.value).toBe(`${first.identity?.first} ${first.identity?.last}`.toUpperCase());
    const dob = run('askDob', subject, ctx, first.memory);
    expect(dob.statement?.fact).toBe('dob');
    expect(dob.statement?.value).toBe(String(first.identity?.dob));
  });

  it('counts refusals and keeps refusing after two when rapport is negative', () => {
    const subject = subjectOf(ID, { demeanor: 'hostile' });
    const ctx = ctxOf();
    let m = memoryOf(subject, ctx, -0.8, 0.2);
    m.identityRefusals = 2;
    for (let seed = 0; seed < 60; seed++) {
      const r = run('requestId', subject, ctx, m, seed);
      expect(r.lineKey).toBe('requestId.refuse');
      expect(r.memory.identityRefusals).toBe(3);
      expect(r.memory.identity).toBeNull();
    }
    m = memoryOf(subject, ctx, -0.8, 0.2);
    let refusals = 0;
    for (let seed = 0; seed < 200; seed++) {
      const r = run('requestId', subject, ctx, m, seed);
      if (r.lineKey === 'requestId.refuse') {
        refusals++;
        expect(r.memory.identityRefusals).toBe(1);
      }
    }
    expect(refusals).toBeGreaterThan(80);
    // A friendly, calm subject almost never refuses.
    const friendly = subjectOf(ID, { demeanor: 'cooperative' });
    let friendlyRefusals = 0;
    for (let seed = 0; seed < 200; seed++) if (run('requestId', friendly, ctx, memoryOf(friendly, ctx, 1), seed).lineKey === 'requestId.refuse') friendlyRefusals++;
    expect(friendlyRefusals).toBeLessThan(10);
  });

  it('answers a juvenile without a licence with the juvenile line', () => {
    const subject = subjectOf(ID, {}, { juvenile: true, honesty: 1, age: 16 });
    const ctx = ctxOf();
    const keys = new Set<string>();
    for (let seed = 0; seed < 40; seed++) keys.add(run('requestId', subject, ctx, memoryOf(subject, ctx, 0.9), seed).lineKey);
    expect(keys.has('requestId.juvenile')).toBe(true);
    expect(keys.has('requestId.noDlTrue')).toBe(false);
  });

  it('hands the licence when carried and a liar upgrades a verbal name to a fake card only when carried', () => {
    const honest = subjectOf(ID, { items: [item('driversLicense')] }, { honesty: 1 });
    const ctx = ctxOf();
    const r = run('requestId', honest, ctx, memoryOf(honest, ctx, 0.9), 4);
    expect(r.lineKey).toBe('requestId.handDl');
    expect(r.identity?.document).toBe('dl');
    expect(r.identity?.dlNumber).toBe(honest.identity.record.license.number);
    // askName first (verbal), then requestId upgrades to the licence.
    const named = run('askName', honest, ctx, memoryOf(honest, ctx, 0.9), 4);
    expect(named.memory.identity?.document).toBe('none');
    const upgraded = run('requestId', honest, ctx, named.memory, 4);
    expect(upgraded.lineKey).toBe('requestId.handDl');
    expect(upgraded.identity?.document).toBe('dl');
    expect(upgraded.identity?.first).toBe(named.memory.identity?.first);
  });
});

describe('consent', () => {
  it('denies and gates a re-ask behind +0.3 rapport', () => {
    const subject = subjectOf(ID, { items: [item('narcotics')] });
    const ctx = ctxOf();
    let denied: ReturnType<typeof run> | null = null;
    for (let seed = 0; seed < 100 && denied === null; seed++) {
      const r = run('consentSearchPerson', subject, ctx, memoryOf(subject, ctx, -0.2, 0.7), seed);
      if (r.consent?.granted === false) denied = r;
    }
    expect(denied).not.toBeNull();
    const d = denied as ReturnType<typeof run>;
    expect(d.lineKey).toBe('consent.deny');
    expect(d.memory.consent.searchPerson).toBe('denied');
    expect(d.memory.consentAskedAt.searchPerson).toBeCloseTo(-0.2, 10);

    const row = (m: SubjectMemory) => available(subject, ctx, m).find((a) => a.utterance.id === 'consentSearchPerson');
    expect(row(d.memory)?.enabled).toBe(false);
    expect(row(d.memory)?.reason).toMatch(/rapport/);
    const risen = { ...d.memory, rapport: -0.2 + CONSENT_RETRY_RAPPORT + 0.001 };
    expect(row(risen)?.enabled).toBe(true);
    // Asked anyway before the gate opens: still denied, memory unchanged.
    const retry = run('consentSearchPerson', subject, ctx, d.memory, 1);
    expect(retry.lineKey).toBe('consent.deny');
    expect(retry.consent).toEqual({ kind: 'searchPerson', granted: false, valid: true });
    expect(retry.memory.consentAskedAt.searchPerson).toBeCloseTo(-0.2, 10);
  });

  it('grants more often with rapport and a polite tone, and less with contraband', () => {
    const clean = subjectOf(ID);
    const dirty = subjectOf(ID, { items: [item('narcotics')] });
    const ctx = ctxOf();
    const m = memoryOf(clean, ctx, 0.5, 0.2);
    const pClean = consentChance('searchPerson', clean, ctx, m);
    expect(pClean).toBeCloseTo(0.6 + 0.15 - 0.04, 10);
    expect(consentChance('searchPerson', dirty, ctx, m)).toBeCloseTo(pClean - 0.4, 10);
    expect(consentChance('searchPerson', clean, ctxOf({ tone: 'polite' }), m)).toBeCloseTo(pClean + 0.1, 10);
    const drinker = subjectOf(ID, { intoxication: { bac: 0.05, drug: 'none', level: 0.3 } });
    expect(consentChance('pbt', drinker, ctx, m)).toBeCloseTo(pClean + 0.1, 10);
    expect(consentChance('pbt', subjectOf(ID, { intoxication: { bac: 0.1, drug: 'none', level: 0.4 } }), ctx, m)).toBeCloseTo(pClean, 10);
    expect(consentChance('searchVehicle', subjectOf(ID, { vehicleItems: [item('openContainer', 'cabin', true)] }), ctx, m)).toBeCloseTo(pClean - 0.4, 10);
    let granted = 0;
    for (let seed = 0; seed < 400; seed++) if (run('consentPbt', clean, ctx, m, seed).consent?.granted === true) granted++;
    expect(granted / 400).toBeGreaterThan(0.6);
    expect(granted / 400).toBeLessThan(0.82);
  });

  it('is invalid for dementia and for a juvenile without a guardian', () => {
    const ctx = ctxOf();
    const dementia = subjectOf(ID, {}, { dementia: true });
    // Dementia halves understanding; find a seed where it was understood.
    let r = null as ReturnType<typeof run> | null;
    for (let seed = 0; seed < 50 && (r === null || !r.understood); seed++) r = run('consentPbt', dementia, ctx, memoryOf(dementia, ctx), seed);
    expect(r?.lineKey).toBe('consent.confused');
    expect(r?.consent).toEqual({ kind: 'pbt', granted: false, valid: false });
    expect(r?.memory.consent.pbt).toBeUndefined();

    const kid = subjectOf(ID, {}, { juvenile: true, age: 16 });
    const noGuardian = run('consentSearchPerson', kid, ctx, memoryOf(kid, ctx));
    expect(noGuardian.lineKey).toBe('consent.needGuardian');
    expect(noGuardian.consent).toEqual({ kind: 'searchPerson', granted: false, valid: false });
    expect(noGuardian.memory.consent.searchPerson).toBeUndefined();
    const withGuardian = run('consentSearchPerson', kid, ctxOf({ guardianPresent: true }), memoryOf(kid, ctx), 3);
    expect(withGuardian.consent?.valid).toBe(true);
  });

  it('does not ask again once granted', () => {
    const subject = subjectOf(ID);
    const ctx = ctxOf();
    const m = memoryOf(subject, ctx, 1, 0);
    const first = run('consentPbt', subject, ctxOf({ tone: 'polite' }), m, 2);
    expect(first.consent?.granted).toBe(true);
    const row = available(subject, ctx, first.memory).find((a) => a.utterance.id === 'consentPbt');
    expect(row?.enabled).toBe(false);
    expect(run('consentPbt', subject, ctx, first.memory, 9).consent?.granted).toBe(true);
  });
});

describe('communication modes, understanding and delays', () => {
  it('offers modes per subject', () => {
    const normal = subjectOf(ID);
    expect(commModes(normal, ctxOf())).toEqual(['verbal']);
    expect(commModes(subjectOf(ID, {}, { hearing: 'deaf' }), ctxOf())).toEqual(['verbal', 'written', 'gesture']);
    expect(commModes(subjectOf(ID, {}, { hearing: 'hardOfHearing' }), ctxOf())).toContain('gesture');
    const foreign = subjectOf(ID, {}, { language: { id: 'spanish', label: 'Spanish', english: 'none' } });
    expect(commModes(foreign, ctxOf())).toEqual(['verbal', 'translationApp']);
    expect(commModes(foreign, ctxOf({ interpreterAvailable: true }))).toEqual(['verbal', 'translationApp', 'interpreter']);
    expect(commModes(normal, ctxOf({ interpreterAvailable: true }))).toEqual(['verbal', 'interpreter']);
    expect(commModes(subjectOf(ID, {}, { language: { id: 'spanish', label: 'Spanish', english: 'limited' } }), ctxOf())).toContain('translationApp');
  });

  it('gates a deaf subject by mode and applies the delays', () => {
    const deaf = subjectOf(ID, {}, { hearing: 'deaf' });
    const verbal = run('askDestination', deaf, ctxOf(), memoryOf(deaf, ctxOf()));
    expect(verbal.understood).toBe(false);
    expect(verbal.lineKey).toBe('deaf.noResponse');
    expect(verbal.statement).toBeNull();
    const written = run('greet', deaf, ctxOf({ commMode: 'written' }), memoryOf(deaf, ctxOf()));
    expect(written.understood).toBe(true);
    expect(written.delayS).toBe(4);
    expect(written.lineKey).toMatch(/^greet\./);
    // Gestures carry simple intents only.
    expect(understanding(deaf, 'gesture', 'greet').p).toBe(0.9);
    expect(understanding(deaf, 'gesture', 'ask').p).toBe(0);
    expect(understanding(deaf, 'interpreter', 'ask').p).toBe(1);
    expect(MODE_DELAY_S).toEqual({ verbal: 0, written: 4, gesture: 0, translationApp: 6, interpreter: 2 });
  });

  it('applies the hard-of-hearing, limited and none rates', () => {
    const hoh = subjectOf(ID, {}, { hearing: 'hardOfHearing' });
    expect(understanding(hoh, 'verbal', 'ask')).toEqual({ p: 0.6, cause: 'hoh' });
    expect(understanding(hoh, 'written', 'ask').p).toBe(1);
    const limited = subjectOf(ID, {}, { language: { id: 'spanish', label: 'Spanish', english: 'limited' } });
    expect(understanding(limited, 'verbal', 'greet')).toEqual({ p: 0.8, cause: 'limited' });
    expect(understanding(limited, 'verbal', 'ask')).toEqual({ p: 0.5, cause: 'limited' });
    const none = subjectOf(ID, {}, { language: { id: 'spanish', label: 'Spanish', english: 'none' } });
    expect(understanding(none, 'verbal', 'greet')).toEqual({ p: 0.6, cause: 'foreign' });
    expect(understanding(none, 'verbal', 'ask')).toEqual({ p: 0.1, cause: 'foreign' });
    expect(understanding(none, 'translationApp', 'ask').p).toBe(1);
    expect(understanding(none, 'interpreter', 'ask').p).toBe(1);
    const dementia = subjectOf(ID, {}, { dementia: true });
    expect(understanding(dementia, 'verbal', 'ask')).toEqual({ p: 0.5, cause: 'dementia' });
    expect(understanding(subjectOf(ID), 'verbal', 'ask')).toEqual({ p: 1, cause: 'none' });

    let heard = 0;
    for (let seed = 0; seed < 400; seed++) if (run('askDestination', hoh, ctxOf(), memoryOf(hoh, ctxOf()), seed).understood) heard++;
    expect(heard / 400).toBeGreaterThan(0.5);
    expect(heard / 400).toBeLessThan(0.7);
    const lost = run('askDestination', none, ctxOf(), memoryOf(none, ctxOf()), 1);
    if (!lost.understood) {
      expect(lost.lineKey).toBe('foreign.untranslated');
      expect(lost.text).toContain('Spanish');
    }
  });

  it('delays a translation app by 6 s and garbles about one in ten', () => {
    const foreign = subjectOf(ID, {}, { language: { id: 'spanish', label: 'Spanish', english: 'none' } });
    const ctx = ctxOf({ commMode: 'translationApp' });
    let garbled = 0;
    const n = 1000;
    for (let seed = 0; seed < n; seed++) {
      const r = run('askDestination', foreign, ctx, memoryOf(foreign, ctx), seed);
      expect(r.delayS).toBe(6);
      if (r.lineKey === 'foreign.misunderstood') {
        garbled++;
        expect(r.understood).toBe(false);
        expect(r.statement).toBeNull();
      }
    }
    const p = 0.1;
    expect(Math.abs(garbled / n - p)).toBeLessThan(4 * Math.sqrt((p * (1 - p)) / n));
    const interp = run('askDestination', foreign, ctxOf({ commMode: 'interpreter', interpreterAvailable: true }), memoryOf(foreign, ctx));
    expect(interp.delayS).toBe(2);
    expect(interp.understood).toBe(true);
  });

  it('lets a subject who does not understand keep the tone effect but no statement', () => {
    const deaf = subjectOf(ID, {}, { hearing: 'deaf' });
    const m = memoryOf(deaf, ctxOf(), 0, 0.2);
    const r = run('askDestination', deaf, ctxOf({ tone: 'aggressive' }), m);
    expect(r.memory.stress).toBeCloseTo(0.32, 10);
    expect(r.memory.asked).toEqual({});
  });
});

describe('availability and requirements', () => {
  it('gates utterances by situation', () => {
    const ctx = ctxOf();
    const onFoot = subjectOf(ID);
    const rows = (s: SubjectProfile, c: DialogueContext = ctx) => new Map(available(s, c, memoryOf(s, c)).map((a) => [a.utterance.id, a]));
    const foot = rows(onFoot);
    expect(foot.get('cmdStepOut')?.enabled).toBe(false);
    expect(foot.get('cmdStepOut')?.reason).not.toBe('');
    expect(foot.get('cmdGetDown')?.enabled).toBe(true);
    expect(foot.get('askVehicleContents')?.enabled).toBe(false);
    expect(foot.get('cmdDropWeapon')?.enabled).toBe(false);
    expect(foot.get('askAccount')?.enabled).toBe(true);
    const driver = rows(subjectOf(ID, { inVehicle: true, vehicleOwnerId: ID }));
    expect(driver.get('cmdStepOut')?.enabled).toBe(true);
    expect(driver.get('cmdGetDown')?.enabled).toBe(false);
    expect(driver.get('askVehicleContents')?.enabled).toBe(true);
    expect(driver.get('consentSearchVehicle')?.enabled).toBe(true);
    const armed = rows(subjectOf(ID, { items: [item('handgun', 'hand', true)] }));
    expect(armed.get('cmdDropWeapon')?.enabled).toBe(true);
    // A concealed weapon does not unlock the command (it would leak the hidden truth).
    expect(rows(subjectOf(ID, { items: [item('handgun', 'waistband', false)] })).get('cmdDropWeapon')?.enabled).toBe(false);
    expect(rows(subjectOf(ID, { restrained: true })).get('cmdHandsUp')?.enabled).toBe(false);
    expect(rows(onFoot, ctxOf({ truth: { ...ctx.truth, reason: '' } })).get('askAccount')?.enabled).toBe(false);
    const silent = rows(subjectOf(ID, { demeanor: 'unresponsive' }));
    expect([...silent.values()].every((a) => !a.enabled)).toBe(true);
    expect(foot.size).toBeGreaterThan(40);
  });

  it('evaluates each requirement', () => {
    const ctx = ctxOf();
    const s = subjectOf(ID);
    const m = memoryOf(s, ctx);
    expect(requirementMet('identityGiven', s, ctx, m)).toBe(false);
    expect(requirementMet('identityGiven', s, ctx, { ...m, identity: { kind: 'true', personId: ID, first: 'A', middle: '', last: 'B', dob: 1, address: '', document: 'none', dlNumber: '' } })).toBe(true);
    expect(requirementMet('juvenile', subjectOf(ID, {}, { juvenile: true }), ctx, m)).toBe(true);
    expect(requirementMet('notJuvenile', s, ctx, m)).toBe(true);
    expect(requirementMet('restrained', subjectOf(ID, { restrained: true }), ctx, m)).toBe(true);
    expect(requirementMet('notRestrainedOrAny', subjectOf(ID, { restrained: true }), ctx, m)).toBe(true);
    expect(requirementMet('hasVehicle', subjectOf(ID, { vehicleOwnerId: 5 }), ctx, m)).toBe(true);
    expect(requirementMet('inVehicle', s, ctx, m)).toBe(false);
    expect(requirementMet('notInVehicle', s, ctx, m)).toBe(true);
  });
});

describe('simple intents, lines and text', () => {
  it('maps greet by demeanor and explainReason by attitude and stress', () => {
    const ctx = ctxOf();
    for (const d of ['cooperative', 'nervous', 'evasive', 'hostile', 'distraught', 'confused', 'crisis']) {
      const s = subjectOf(ID, { demeanor: d });
      const r = run('greet', s, ctx, memoryOf(s, ctx, 0, 0.1));
      expect(r.lineKey).toBe(`greet.${d}`);
      expect(r.memory.greeted).toBe(true);
    }
    const calm = subjectOf(ID, {}, { attitude: 0.5 });
    expect(run('explainReason', calm, ctx, memoryOf(calm, ctx, 0, 0.1)).lineKey).toBe('reason.accept');
    expect(run('explainReason', calm, ctx, memoryOf(calm, ctx, 0, 0.7)).lineKey).toBe('reason.argue');
    const sour = subjectOf(ID, {}, { attitude: -0.5 });
    const argued = run('explainReason', sour, ctx, memoryOf(sour, ctx, 0, 0.1));
    expect(argued.lineKey).toBe('reason.argue');
    expect(argued.memory.reasonGiven).toBe(true);
    expect(run('miranda', calm, ctx, memoryOf(calm, ctx)).memory.mirandized).toBe(true);
    expect(run('release', calm, ctx, memoryOf(calm, ctx)).lineKey).toBe('release.ok');
    expect(run('warn', calm, ctx, memoryOf(calm, ctx)).lineKey).toBe('warn.ok');
    expect(run('thank', calm, ctx, memoryOf(calm, ctx)).lineKey).toBe('thank.ok');
    expect(run('reassure', calm, ctx, memoryOf(calm, ctx)).lineKey).toBe('reassure.ok');
  });

  it('does not answer commands and goes silent for unresponsive subjects and animals', () => {
    const s = subjectOf(ID);
    const r = run('cmdStop', s, ctxOf({ tone: 'commanding' }), memoryOf(s, ctxOf(), 0, 0.2));
    expect(r.lineKey).toBe('');
    expect(r.memory.stress).toBeCloseTo(0.25, 10);
    for (const d of ['unresponsive', 'animal']) {
      const q = subjectOf(ID, { demeanor: d });
      const a = run('greet', q, ctxOf(), memoryOf(q, ctxOf()));
      expect(a.lineKey).toBe('silent.none');
      expect(a.understood).toBe(false);
      expect(commandLine('comply', q, ctxOf(), createRng(1)).lineKey).toBe('silent.none');
    }
  });

  it('picks command lines and explains confusion by cause', () => {
    const ctx = ctxOf();
    const s = subjectOf(ID);
    for (const o of ['comply', 'refuse', 'flee', 'fight', 'confused'] as const) {
      const l = commandLine(o, s, ctx, createRng(2));
      expect(l.lineKey).toBe(`command.${o}`);
      expect(l.text.length).toBeGreaterThan(0);
    }
    expect(commandLine('confused', subjectOf(ID, {}, { hearing: 'deaf' }), ctx, createRng(2)).lineKey).toBe('deaf.noResponse');
    expect(commandLine('confused', subjectOf(ID, {}, { hearing: 'hardOfHearing' }), ctx, createRng(2)).lineKey).toBe('hoh.repeat');
    expect(commandLine('confused', subjectOf(ID, {}, { language: { id: 'tagalog', label: 'Tagalog', english: 'none' } }), ctx, createRng(2)).text).toContain('Tagalog');
    expect(commandLine('confused', subjectOf(ID, {}, { language: { id: 'tagalog', label: 'Tagalog', english: 'limited' } }), ctx, createRng(2)).lineKey).toBe('limited.confused');
    expect(commandLine('confused', subjectOf(ID, {}, { language: { id: 'tagalog', label: 'Tagalog', english: 'none' } }), ctxOf({ commMode: 'translationApp' }), createRng(2)).lineKey).toBe('command.confused');
  });

  it('fills officer lines and slurs a drunk subject', () => {
    expect(officerLine(utterance('greet'), 'polite', { officerName: 'Hart', reason: 'x' })).toContain('Hart');
    expect(officerLine(utterance('explainReason'), 'neutral', { officerName: 'Hart', reason: 'a noise complaint' })).toContain('a noise complaint');
    for (const tone of ['polite', 'neutral', 'commanding', 'aggressive'] as const) {
      expect(officerLine(utterance('cmdStepOut'), tone, { officerName: 'Hart', reason: '' })).not.toMatch(/\{/);
    }
    expect(slur('Yes, just listen')).toBe('Yes, jusht lishten');
    expect(slur('Stop sassy')).toBe('Shtop shashsy');
    expect(slur('as is')).toBe('as is');
    const drunk = subjectOf(ID, { intoxication: { bac: 0.2, drug: 'none', level: 0.8 } });
    const plain = subjectOf(ID, { intoxication: { bac: 0, drug: 'none', level: 0 } });
    const texts = new Set<string>();
    for (let seed = 0; seed < 30; seed++) {
      const a = run('thank', drunk, ctxOf(), memoryOf(drunk, ctxOf()), seed);
      const b = run('thank', plain, ctxOf(), memoryOf(plain, ctxOf()), seed);
      texts.add(a.text);
      expect(slur(b.text)).toBe(a.text);
    }
    expect(texts.size).toBeGreaterThan(0);
    expect(identityOf(ID).id).toBe(ID);
  });
});
