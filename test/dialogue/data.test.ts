import { describe, expect, it } from 'vitest';
import responsesJson from '../../src/data/dialogue/responses.json';
import rulesJson from '../../src/data/dialogue/rules.json';
import toolsJson from '../../src/data/dialogue/tools.json';
import trustJson from '../../src/data/dialogue/trust.json';
import utterancesJson from '../../src/data/dialogue/utterances.json';
import {
  CONSENT_KINDS,
  FACT_TOPICS,
  LINE_KEYS,
  NPC_COMMANDS,
  RESPONSES,
  RULES,
  TONES,
  TOPICS,
  UTTERANCES,
  parseResponses,
  parseRules,
  parseTools,
  parseTrust,
  parseUtterances,
  utterance,
} from '../../src/dialogue';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe('dialogue data', () => {
  it('has the nine topics and unique utterance ids', () => {
    expect(TOPICS.map((t) => t.id)).toEqual(['greeting', 'reason', 'id', 'questions', 'consent', 'commands', 'support', 'miranda', 'closing']);
    expect(new Set(UTTERANCES.map((u) => u.id)).size).toBe(UTTERANCES.length);
    expect(() => utterance('nope')).toThrow(/Unknown utterance/);
  });

  it('gives every utterance all four tones and valid requirements', () => {
    for (const u of UTTERANCES) {
      for (const tone of TONES) expect(u.text[tone].length, `${u.id}.${tone}`).toBeGreaterThan(2);
      expect(new Set(Object.values(u.text)).size, `${u.id} tones differ`).toBeGreaterThanOrEqual(2);
    }
  });

  it('covers every intent, fact, consent and NPC command', () => {
    const intents = new Set(UTTERANCES.map((u) => u.intent));
    for (const i of ['greet', 'explainReason', 'requestId', 'askName', 'askDob', 'ask', 'consent', 'command', 'reassure', 'miranda', 'release', 'warn', 'thank']) {
      expect(intents.has(i as never), i).toBe(true);
    }
    const asked = new Set(UTTERANCES.filter((u) => u.intent === 'ask').map((u) => u.fact));
    for (const f of ['destination', 'origin', 'account', 'drinking', 'drugs', 'weapons', 'vehicleContents', 'vehicleOwner', 'address', 'injured', 'suspectWhereabouts']) {
      expect(asked.has(f as never), f).toBe(true);
    }
    const consents = new Set(UTTERANCES.filter((u) => u.intent === 'consent').map((u) => u.consent));
    for (const c of CONSENT_KINDS) expect(consents.has(c), c).toBe(true);
    const commands = new Set(UTTERANCES.filter((u) => u.intent === 'command').map((u) => u.command));
    expect(NPC_COMMANDS).toHaveLength(17);
    for (const c of NPC_COMMANDS) expect(commands.has(c), c).toBe(true);
    expect(FACT_TOPICS).toHaveLength(16);
  });

  it('has 2-4 lines for every LINE_KEY and no unknown keys', () => {
    expect(new Set(LINE_KEYS).size).toBe(LINE_KEYS.length);
    for (const key of LINE_KEYS) {
      const lines = RESPONSES.lines.get(key);
      expect(lines, key).toBeDefined();
      expect(lines?.length, key).toBeGreaterThanOrEqual(2);
      expect(lines?.length, key).toBeLessThanOrEqual(4);
    }
    for (const key of RESPONSES.lines.keys()) expect(LINE_KEYS, key).toContain(key);
  });

  it('keeps ask.truth and ask.lie indistinguishable', () => {
    expect(RESPONSES.lines.get('ask.truth')).toEqual(RESPONSES.lines.get('ask.lie'));
  });

  it('ships every required inconsistency rule', () => {
    expect(RULES.map((r) => r.id)).toEqual([
      'nameVsId', 'dobVsId', 'nameNotOnFile', 'dobVsRecord', 'idNotOnFile', 'appearanceVsRecord', 'addressVsRecord', 'storyDestination',
      'storyOrigin', 'storyAccount', 'storyDrinking', 'storyDrugs', 'storyWeapons', 'storyContents', 'storyOwner', 'drinkingDenial', 'drugsDenial', 'weaponsDenial', 'contentsDenial', 'ownerVsRecord', 'identityVsBooking',
    ]);
  });

  it('loads trust for the eleven districts', () => {
    expect(parseTrust(trustJson).size).toBe(11);
  });

  it('names the file and path of a bad value', () => {
    const u = clone(utterancesJson) as { utterances: { text: Record<string, string>; topic: string; fact?: string }[] };
    delete u.utterances[0]?.text.polite;
    expect(() => parseUtterances(u)).toThrow(/utterances\.json: utterances\[0\]\.text\.polite/);
    const u2 = clone(utterancesJson) as { utterances: { text: Record<string, string> }[] };
    (u2.utterances[1] as { text: Record<string, string> }).text.neutral = 'Hello {nobody}';
    expect(() => parseUtterances(u2)).toThrow(/unknown placeholder \{nobody\}/);
    const u3 = clone(utterancesJson) as { utterances: { topic: string }[] };
    (u3.utterances[2] as { topic: string }).topic = 'nowhere';
    expect(() => parseUtterances(u3)).toThrow(/utterances\.json: utterances\[2\]\.topic/);
    const u4 = clone(utterancesJson) as { utterances: { id: string; intent: string; fact?: string }[] };
    const ask = u4.utterances.find((x) => x.intent === 'ask');
    if (ask) delete ask.fact;
    expect(() => parseUtterances(u4)).toThrow(/\.fact is required for intent "ask"/);

    const r = clone(responsesJson) as { lines: Record<string, string[]> };
    delete r.lines['consent.grant'];
    expect(() => parseResponses(r)).toThrow(/responses\.json: lines\.consent\.grant is missing/);
    const r2 = clone(responsesJson) as { lines: Record<string, string[]> };
    r2.lines['consent.grant'] = ['only one'];
    expect(() => parseResponses(r2)).toThrow(/must have 2\.\.4 variants/);
    const r3 = clone(responsesJson) as { values: Record<string, string[]> };
    r3.values.destination = ['x'];
    expect(() => parseResponses(r3)).toThrow(/responses\.json: values\.destination/);

    const rules = clone(rulesJson) as { rules: { id: string; severity: string }[] };
    rules.rules = rules.rules.filter((x) => x.id !== 'nameNotOnFile');
    expect(() => parseRules(rules)).toThrow(/missing the required rule "nameNotOnFile"/);
    const rules2 = clone(rulesJson) as { rules: { id: string; severity: string }[] };
    (rules2.rules[0] as { severity: string }).severity = 'caution';
    expect(() => parseRules(rules2)).toThrow(/rules\.json: rules\(nameVsId\)\.severity/);

    const tools = clone(toolsJson) as { sfst: { tests: { id: string }[] }; pbt: { noiseSd: number } };
    tools.sfst.tests.reverse();
    expect(() => parseTools(tools)).toThrow(/tools\.json: sfst\.tests\[0\]\.id/);
    const tools2 = clone(toolsJson) as { pbt: { noiseSd: number } };
    tools2.pbt.noiseSd = -1;
    expect(() => parseTools(tools2)).toThrow(/tools\.json: pbt\.noiseSd/);
    expect(() => parseTrust({ version: 1, districts: { downtown: 2 } })).toThrow(/trust\.json: districts\.downtown/);
    expect(() => parseTools(null)).toThrow(/tools\.json/);
  });
});
