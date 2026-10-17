import { describe, expect, it } from 'vitest';
import { RULES, compareFacts, findInconsistencies } from '../../src/dialogue';
import type { FactSource, PersonFact } from '../../src/people';

let counter = 0;
function fact(topic: string, source: FactSource, value: string, over: Partial<PersonFact> = {}): PersonFact {
  counter++;
  return { id: counter, incident: 'C-00001', topic, value, source, display: value, detail: '', game: counter, ...over };
}
const withIds = (...fs: PersonFact[]): PersonFact[] => fs.map((f, i) => ({ ...f, id: i + 1 }));
const ruleIds = (facts: PersonFact[]): string[] => findInconsistencies(facts).map((i) => i.ruleId);

describe('inconsistency engine: each rule fires on a minimal fixture and stays silent when consistent', () => {
  const cases: { rule: string; bad: PersonFact[]; good: PersonFact[] }[] = [
    {
      rule: 'nameVsId',
      bad: [fact('name', 'claim', 'JOHN SMITH'), fact('name', 'document', 'JOHN SMYTH')],
      good: [fact('name', 'claim', 'John Smith '), fact('name', 'document', 'JOHN SMITH')],
    },
    { rule: 'dobVsId', bad: [fact('dob', 'claim', '12000'), fact('dob', 'document', '12400')], good: [fact('dob', 'claim', '12000'), fact('dob', 'document', '12000')] },
    { rule: 'nameNotOnFile', bad: [fact('name', 'claim', 'AL ROE'), fact('name', 'record', 'NOTONFILE')], good: [fact('name', 'claim', 'AL ROE'), fact('name', 'record', 'AL ROE')] },
    { rule: 'dobVsRecord', bad: [fact('dob', 'claim', '12000'), fact('dob', 'record', '12999')], good: [fact('dob', 'claim', '12000'), fact('dob', 'record', '12000')] },
    {
      rule: 'idNotOnFile',
      bad: [fact('name', 'document', 'AL ROE'), fact('idCard', 'document', 'D1234567'), fact('idCard', 'record', 'onFile:BO LEE')],
      good: [fact('name', 'document', 'AL ROE'), fact('idCard', 'document', 'D1234567'), fact('idCard', 'record', 'onFile:AL ROE')],
    },
    {
      rule: 'appearanceVsRecord',
      bad: [fact('appearance', 'observation', 'M|35|180|brown'), fact('appearance', 'record', 'F|35|180|brown')],
      good: [fact('appearance', 'observation', 'M|35|180|brown'), fact('appearance', 'record', 'M|40|185|brown')],
    },
    {
      rule: 'addressVsRecord',
      bad: [fact('address', 'claim', '12 MAPLE STREET'), fact('address', 'record', '99 OAK AVENUE')],
      good: [fact('address', 'claim', '12 maple street'), fact('address', 'record', '12 MAPLE STREET')],
    },
    {
      rule: 'storyDestination',
      bad: [fact('destination', 'claim', 'home'), fact('destination', 'claim', 'work')],
      good: [fact('destination', 'claim', 'home'), fact('destination', 'claim', 'HOME')],
    },
    { rule: 'storyOrigin', bad: [fact('origin', 'claim', 'gym'), fact('origin', 'claim', 'dinner')], good: [fact('origin', 'claim', 'gym'), fact('origin', 'claim', 'gym')] },
    {
      rule: 'storyAccount',
      bad: [fact('account', 'claim', 'it got loud'), fact('account', 'claim', 'nothing happened')],
      good: [fact('account', 'claim', 'it got loud'), fact('account', 'claim', 'it got loud')],
    },
    { rule: 'storyDrinking', bad: [fact('drinking', 'claim', 'no'), fact('drinking', 'claim', 'some')], good: [fact('drinking', 'claim', 'no'), fact('drinking', 'claim', 'NO')] },
    { rule: 'storyDrugs', bad: [fact('drugs', 'claim', 'no'), fact('drugs', 'claim', 'some')], good: [fact('drugs', 'claim', 'no'), fact('drugs', 'claim', 'no')] },
    { rule: 'storyWeapons', bad: [fact('weapons', 'claim', 'no'), fact('weapons', 'claim', 'yes')], good: [fact('weapons', 'claim', 'no'), fact('weapons', 'claim', 'no')] },
    {
      rule: 'storyContents',
      bad: [fact('vehicleContents', 'claim', 'nothing'), fact('vehicleContents', 'claim', 'some tools')],
      good: [fact('vehicleContents', 'claim', 'nothing'), fact('vehicleContents', 'claim', 'nothing')],
    },
    { rule: 'storyOwner', bad: [fact('vehicleOwner', 'claim', 'owner:5'), fact('vehicleOwner', 'claim', 'owner:9')], good: [fact('vehicleOwner', 'claim', 'owner:5'), fact('vehicleOwner', 'claim', 'owner:5')] },
    {
      rule: 'drinkingDenial',
      bad: [fact('drinking', 'claim', 'no'), fact('drinking', 'evidence', 'yes', { detail: 'the PBT read 0.09' })],
      good: [fact('drinking', 'claim', 'yes'), fact('drinking', 'evidence', 'yes')],
    },
    {
      rule: 'drugsDenial',
      bad: [fact('drugs', 'claim', 'no'), fact('drugs', 'evidence', 'yes')],
      good: [fact('drugs', 'claim', 'no')],
    },
    {
      rule: 'weaponsDenial',
      bad: [fact('weapons', 'claim', 'no'), fact('weapons', 'evidence', 'yes')],
      good: [fact('weapons', 'claim', 'yes'), fact('weapons', 'evidence', 'yes')],
    },
    {
      rule: 'contentsDenial',
      bad: [fact('vehicleContents', 'claim', 'nothing'), fact('vehicleContents', 'evidence', 'item:openContainer')],
      good: [fact('vehicleContents', 'claim', 'item:openContainer'), fact('vehicleContents', 'evidence', 'item:openContainer')],
    },
    {
      rule: 'ownerVsRecord',
      bad: [fact('vehicleOwner', 'claim', 'owner:5'), fact('vehicleOwner', 'record', 'owner:9')],
      good: [fact('vehicleOwner', 'claim', 'owner:9'), fact('vehicleOwner', 'record', 'owner:9')],
    },
    {
      rule: 'identityVsBooking',
      bad: [fact('identity', 'claim', '-1'), fact('identity', 'booking', '4242')],
      good: [fact('identity', 'claim', '4242'), fact('identity', 'booking', '4242')],
    },
  ];

  for (const c of cases) {
    it(c.rule, () => {
      const bad = ruleIds(withIds(...c.bad));
      expect(bad).toEqual([c.rule]);
      expect(ruleIds(withIds(...c.good))).toEqual([]);
    });
  }

  it('covers every shipped rule', () => {
    expect(new Set(cases.map((c) => c.rule))).toEqual(new Set(RULES.map((r) => r.id)));
  });
});

describe('inconsistency engine: comparators', () => {
  const rule = (id: string): (typeof RULES)[number] => {
    const found = RULES.find((r) => r.id === id);
    if (!found) throw new Error(`no rule ${id}`);
    return found;
  };

  it('compares denial: no/nothing against present evidence, some against heavy', () => {
    const r = rule('drinkingDenial');
    expect(compareFacts(r, fact('drinking', 'claim', 'some'), fact('drinking', 'evidence', 'yes'))).toBe(false);
    expect(compareFacts(r, fact('drinking', 'claim', 'some'), fact('drinking', 'evidence', 'heavy'))).toBe(true);
    expect(compareFacts(r, fact('drinking', 'claim', 'yes'), fact('drinking', 'evidence', 'heavy'))).toBe(false);
    expect(compareFacts(r, fact('drinking', 'claim', 'no'), fact('drinking', 'evidence', 'heavy'))).toBe(true);
    expect(compareFacts(r, fact('drinking', 'claim', 'no'), fact('drinking', 'evidence', 'no'))).toBe(false);
  });

  it('compares appearance: sex, age > 10, height > 12 cm, hair unless gray or bald at 45+', () => {
    const r = rule('appearanceVsRecord');
    const cmp = (a: string, b: string) => compareFacts(r, fact('appearance', 'observation', a), fact('appearance', 'record', b));
    expect(cmp('M|35|180|brown', 'M|35|180|brown')).toBe(false);
    expect(cmp('M|35|180|brown', 'F|35|180|brown')).toBe(true);
    expect(cmp('M|35|180|brown', 'M|45|180|brown')).toBe(false);
    expect(cmp('M|35|180|brown', 'M|46|180|brown')).toBe(true);
    expect(cmp('M|35|180|brown', 'M|35|192|brown')).toBe(false);
    expect(cmp('M|35|180|brown', 'M|35|193|brown')).toBe(true);
    expect(cmp('M|35|180|brown', 'M|35|180|black')).toBe(true);
    expect(cmp('M|50|180|brown', 'M|55|180|gray')).toBe(false);
    expect(cmp('M|35|180|brown', 'M|35|180|gray')).toBe(true);
    expect(cmp('M|50|180|bald', 'M|50|180|brown')).toBe(false);
    expect(cmp('garbage', 'M|35|180|brown')).toBe(false);
  });

  it('never compares a claim of "other" and ignores onFile names without a document name', () => {
    const r = rule('ownerVsRecord');
    expect(compareFacts(r, fact('vehicleOwner', 'claim', 'other'), fact('vehicleOwner', 'record', 'owner:3'))).toBe(false);
    const id = rule('idNotOnFile');
    expect(compareFacts(id, fact('idCard', 'document', 'D1'), fact('idCard', 'record', 'onFile:AL ROE'))).toBe(false);
    expect(compareFacts(id, fact('idCard', 'document', 'D1'), fact('idCard', 'record', 'notOnFile'))).toBe(true);
    const nf = rule('nameNotOnFile');
    expect(compareFacts(nf, fact('name', 'claim', 'X'), fact('name', 'record', 'notonfile'))).toBe(true);
  });
});

describe('inconsistency engine: pairing, ordering and stability', () => {
  it('gives two story changes for three different claims and none for an unchanged repeat', () => {
    const facts = withIds(fact('destination', 'claim', 'home'), fact('destination', 'claim', 'work'), fact('destination', 'claim', 'the gym'));
    const found = findInconsistencies(facts);
    expect(found.map((f) => [f.factA, f.factB])).toEqual([
      [1, 2],
      [2, 3],
    ]);
    expect(found.every((f) => f.ruleId === 'storyDestination' && f.severity === 'caution')).toBe(true);
    expect(found[0]?.key).toBe('storyDestination:1:2');
    expect(findInconsistencies(withIds(fact('destination', 'claim', 'home'), fact('destination', 'claim', 'home'), fact('destination', 'claim', 'home')))).toEqual([]);
    // A -> B -> A is still two changes.
    expect(findInconsistencies(withIds(fact('origin', 'claim', 'a'), fact('origin', 'claim', 'b'), fact('origin', 'claim', 'a')))).toHaveLength(2);
  });

  it('ignores facts from another incident and pairs only within one', () => {
    const facts = withIds(
      fact('name', 'claim', 'AL ROE', { incident: 'C-00001' }),
      fact('name', 'document', 'BO LEE', { incident: 'C-00002' }),
    );
    expect(findInconsistencies(facts)).toEqual([]);
    const same = withIds(fact('name', 'claim', 'AL ROE', { incident: 'C-00002' }), fact('name', 'document', 'BO LEE', { incident: 'C-00002' }));
    expect(findInconsistencies(same)).toHaveLength(1);
    const stories = withIds(fact('destination', 'claim', 'home', { incident: 'C-1' }), fact('destination', 'claim', 'work', { incident: 'FC-9-1' }));
    expect(findInconsistencies(stories)).toEqual([]);
  });

  it('formats the rule text with display values and details', () => {
    const facts = withIds(
      fact('drinking', 'claim', 'no', { display: 'No, I have not been drinking' }),
      fact('drinking', 'evidence', 'yes', { detail: 'odor of alcohol' }),
    );
    expect(findInconsistencies(facts)[0]?.text).toBe('Said "No, I have not been drinking" about drinking, but odor of alcohol.');
    const names = withIds(fact('name', 'claim', 'A', { display: 'Al Roe' }), fact('name', 'document', 'B', { display: 'Bo Lee' }));
    expect(findInconsistencies(names)[0]?.text).toBe('Gave the name Al Roe, but the ID card reads Bo Lee.');
  });

  it('sorts by the later fact id and returns the same keys on repeat calls', () => {
    const facts = withIds(
      fact('name', 'claim', 'AL ROE'),
      fact('destination', 'claim', 'home'),
      fact('name', 'document', 'BO LEE'),
      fact('destination', 'claim', 'work'),
      fact('dob', 'claim', '1'),
      fact('dob', 'record', '2'),
    );
    const a = findInconsistencies(facts);
    const b = findInconsistencies([...facts].reverse());
    expect(a.map((x) => x.key)).toEqual(['nameVsId:1:3', 'storyDestination:2:4', 'dobVsRecord:5:6']);
    expect(b.map((x) => x.key)).toEqual(a.map((x) => x.key));
    const later = Math.max(...a.map((x) => Math.max(x.factA, x.factB)));
    expect(later).toBe(6);
  });

  it('pairs a changed claim with the document it contradicts', () => {
    // First claim wrong, second right: only the first conflicts with the document.
    const facts = withIds(fact('name', 'claim', 'AL ROE'), fact('name', 'claim', 'BO LEE'), fact('name', 'document', 'BO LEE'));
    expect(findInconsistencies(facts).map((x) => x.key)).toEqual(['nameVsId:1:3']);
  });

  it('only accepts discovered facts: no hidden truth can be supplied', () => {
    // The signature takes PersonFact[] and rules only; the lie memory has no path in.
    expect(findInconsistencies.length).toBeLessThanOrEqual(2);
    expect(findInconsistencies([])).toEqual([]);
    // A claim alone (a lie nobody has checked) produces nothing.
    expect(findInconsistencies(withIds(fact('drinking', 'claim', 'no'), fact('name', 'claim', 'MADE UP')))).toEqual([]);
  });

  it('accepts a custom rule list', () => {
    const only = RULES.filter((r) => r.id === 'dobVsId');
    const facts = withIds(fact('name', 'claim', 'A'), fact('name', 'document', 'B'), fact('dob', 'claim', '1'), fact('dob', 'document', '2'));
    expect(findInconsistencies(facts, only).map((x) => x.ruleId)).toEqual(['dobVsId']);
  });
});
