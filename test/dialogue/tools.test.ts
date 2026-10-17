import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import { ITEMS } from '../../src/people';
import type { CarriedItem, DrugKind, HealthCondition } from '../../src/people';
import { SfstSession, TOOLS, frisk, isSfstSave, odorOf, pbtReading, search, visualCheck, type SfstResult } from '../../src/dialogue';
import { item } from './helpers';

const sd = (p: number, n: number): number => Math.sqrt((p * (1 - p)) / n);
const concealment = (id: string): number => ITEMS.find((i) => i.id === id)?.concealment ?? 0;

describe('PBT', () => {
  it('adds N(0, noiseSd), rounds to 0.001 and never goes negative', () => {
    const rng = createRng(1);
    const n = 4000;
    let sum = 0;
    let sq = 0;
    for (let i = 0; i < n; i++) {
      const v = pbtReading(0.1, rng);
      expect(Math.abs(Math.round(v * 1000) - v * 1000)).toBeLessThan(1e-6);
      expect(v).toBeGreaterThanOrEqual(0);
      sum += v;
      sq += (v - 0.1) ** 2;
    }
    expect(Math.abs(sum / n - 0.1)).toBeLessThan((4 * 0.004) / Math.sqrt(n) + 0.0006);
    expect(Math.sqrt(sq / n)).toBeGreaterThan(0.0035);
    expect(Math.sqrt(sq / n)).toBeLessThan(0.0046);
    for (let i = 0; i < 500; i++) expect(pbtReading(0, rng)).toBeGreaterThanOrEqual(0);
    expect(pbtReading(0.1, createRng(5))).toBe(pbtReading(0.1, createRng(5)));
  });
});

describe('odor', () => {
  it('smells alcohol from the BAC threshold and cannabis from use or carried cannabis', () => {
    const none = { bac: 0, drug: 'none' as DrugKind, level: 0 };
    expect(odorOf([], none)).toEqual([]);
    expect(odorOf([], { ...none, bac: TOOLS.odor.alcoholBac - 0.001 })).toEqual([]);
    expect(odorOf([], { ...none, bac: TOOLS.odor.alcoholBac })).toEqual(['alcohol']);
    expect(odorOf([item('cannabis')], none)).toEqual(['cannabis']);
    expect(odorOf([], { bac: 0, drug: 'cannabis', level: 0.4 })).toEqual(['cannabis']);
    expect(odorOf([item('cannabis')], { bac: 0.1, drug: 'cannabis', level: 0.5 })).toEqual(['alcohol', 'cannabis']);
    expect(odorOf([item('narcotics'), item('phone')], none)).toEqual([]);
  });
});

describe('frisk, search and visual check', () => {
  function rate(fn: (items: readonly CarriedItem[], rng: ReturnType<typeof createRng>) => CarriedItem[], it: CarriedItem, n = 4000): number {
    let found = 0;
    const rng = createRng(77);
    for (let i = 0; i < n; i++) if (fn([it], rng).length === 1) found++;
    return found / n;
  }

  it('frisk finds concealed weapons at weaponFindBase minus concealment, large items at largeItemFind, nothing else', () => {
    const t = TOOLS.frisk;
    const n = 4000;
    const pKnife = t.weaponFindBase - concealment('knife') * t.concealmentFactor;
    expect(Math.abs(rate(frisk, item('knife', 'waistband')) - pKnife)).toBeLessThan(4 * sd(pKnife, n));
    const pGun = t.weaponFindBase - concealment('handgun') * t.concealmentFactor;
    expect(Math.abs(rate(frisk, item('handgun', 'waistband')) - pGun)).toBeLessThan(4 * sd(pGun, n));
    expect(Math.abs(rate(frisk, item('backpack', 'hand')) - t.largeItemFind)).toBeLessThan(4 * sd(t.largeItemFind, n));
    expect(Math.abs(rate(frisk, item('stolenGoods', 'pocket')) - t.largeItemFind)).toBeLessThan(4 * sd(t.largeItemFind, n));
    expect(rate(frisk, item('handgun', 'hand', true))).toBe(1);
    expect(rate(frisk, item('narcotics', 'pocket'))).toBe(0);
    expect(rate(frisk, item('phone', 'pocket'))).toBe(0);
    expect(rate(frisk, item('knife', 'bag'))).toBe(0);
  });

  it('search finds every item at findBase minus concealment', () => {
    const t = TOOLS.search;
    const n = 4000;
    for (const name of ['narcotics', 'phone', 'handgun']) {
      const p = t.findBase - concealment(name) * t.concealmentFactor;
      expect(Math.abs(rate(search, item(name)) - p), name).toBeLessThan(4 * sd(p, n));
    }
    const all = [item('phone'), item('keys'), item('wallet')];
    const found = search(all, createRng(3));
    expect(found.every((f) => all.includes(f))).toBe(true);
    expect(search(all, createRng(3))).toEqual(search(all, createRng(3)));
  });

  it('visual check reveals visible items and poorly concealed cabin items only', () => {
    const items = [
      item('openContainer', 'cabin', true),
      item('liquorBottle', 'underSeat'),
      item('keys', 'cabin'),
      item('narcotics', 'glovebox'),
      item('narcotics', 'cabin'),
      item('stolenGoods', 'trunk'),
    ];
    const seen = visualCheck(items).map((i) => `${i.item}@${i.where}`);
    expect(seen).toEqual(['openContainer@cabin', 'keys@cabin']);
    expect(concealment('keys')).toBeLessThan(TOOLS.visual.revealBelowConcealment);
    expect(concealment('narcotics')).toBeGreaterThanOrEqual(TOOLS.visual.revealBelowConcealment);
    expect(visualCheck([])).toEqual([]);
  });
});

/** Presses the right key as soon as a prompt shows, 0.1 s ticks, until all tests finish. */
function playPerfect(s: SfstSession, hitEvery = 1): SfstResult {
  let i = 0;
  for (let guard = 0; guard < 20000 && s.result() === null; guard++) {
    s.step(0.1);
    const p = s.prompt;
    if (p) {
      i++;
      if (i % hitEvery === 0 || hitEvery === 1) s.press(p.key);
      else s.press('x');
    }
  }
  const r = s.result();
  if (r === null) throw new Error('session did not finish');
  return r;
}

function meanClues(bac: number, drug: DrugKind = 'none', health: HealthCondition[] = [], n = 500): Record<'hgn' | 'walkTurn' | 'oneLeg', number> {
  const sum = { hgn: 0, walkTurn: 0, oneLeg: 0 };
  for (let i = 0; i < n; i++) {
    const r = playPerfect(new SfstSession(bac, drug, health, createRng(i * 7 + 1)));
    sum.hgn += r.clues.hgn;
    sum.walkTurn += r.clues.walkTurn;
    sum.oneLeg += r.clues.oneLeg;
  }
  return { hgn: sum.hgn / n, walkTurn: sum.walkTurn / n, oneLeg: sum.oneLeg / n };
}

describe('SFST session', () => {
  it('runs hgn, walk and turn, one-leg stand in order with prompts and progress', () => {
    const s = new SfstSession(0.1, 'none', [], createRng(1));
    expect(s.test).toBe('hgn');
    expect(s.title).toBe('Horizontal gaze nystagmus');
    expect(s.instruction).toBe('Follow the pen with your eyes only.');
    expect(s.prompt).toBeNull();
    expect(s.result()).toBeNull();
    expect(s.progress).toBe(0);
    s.step(TOOLS.sfst.promptGapS - 0.01);
    expect(s.prompt).toBeNull();
    s.step(0.02);
    const p = s.prompt;
    expect(p).not.toBeNull();
    expect(['a', 'd']).toContain(p?.key);
    expect(p?.remainingS).toBeLessThanOrEqual(TOOLS.sfst.promptWindowS);
    s.step(1);
    expect(s.prompt?.remainingS).toBeCloseTo((p?.remainingS ?? 0) - 1, 6);
    s.press(p?.key ?? '');
    expect(s.prompt).toBeNull();
    expect(s.progress).toBeCloseTo(1 / 6, 10);
    const seen: string[] = [s.test];
    for (let i = 0; i < 20000 && s.test !== 'done'; i++) {
      s.step(0.1);
      if (s.prompt) s.press(s.prompt.key);
      if (seen[seen.length - 1] !== s.test) seen.push(s.test);
    }
    expect(seen).toEqual(['hgn', 'walkTurn', 'oneLeg', 'done']);
    expect(s.progress).toBe(1);
    expect(s.title).toMatch(/complete/i);
    expect(s.instruction).toBe('');
    expect(s.prompt).toBeNull();
    s.step(10);
    s.press('space');
    expect(s.result()).not.toBeNull();
  });

  it('draws prompt keys from the test key list', () => {
    const s = new SfstSession(0.1, 'none', [], createRng(2));
    const keys = new Map<string, Set<string>>();
    for (let i = 0; i < 20000 && s.test !== 'done'; i++) {
      s.step(0.1);
      const p = s.prompt;
      const name: string = s.test;
      if (p && name !== 'done') {
        const set = keys.get(name) ?? new Set<string>();
        set.add(p.key);
        keys.set(name, set);
        s.press(p.key);
      }
    }
    expect([...(keys.get('hgn') ?? [])].every((k) => ['a', 'd'].includes(k))).toBe(true);
    expect([...(keys.get('walkTurn') ?? [])].every((k) => ['w', 'space'].includes(k))).toBe(true);
    expect([...(keys.get('oneLeg') ?? [])]).toEqual(['space']);
  });

  it('rolls more clues as the BAC rises (mean over 500 sessions, monotone)', () => {
    const levels = [0, 0.04, 0.07, 0.1, 0.15, 0.25].map((b) => meanClues(b));
    for (const test of ['hgn', 'walkTurn', 'oneLeg'] as const) {
      for (let i = 1; i < levels.length; i++) {
        expect((levels[i] as Record<string, number>)[test] as number, `${test} #${i}`).toBeGreaterThanOrEqual((levels[i - 1] as Record<string, number>)[test] as number);
      }
    }
    const top = levels[levels.length - 1] as Record<string, number>;
    expect(top.hgn).toBeGreaterThan(5.5);
    expect(top.walkTurn).toBeGreaterThan(7);
    expect(top.oneLeg).toBeGreaterThan(3.5);
    expect(top.hgn).toBeLessThanOrEqual(6);
  });

  it('shows mostly 0-1 clues for sober subjects and does not indicate impairment', () => {
    let low = 0;
    let total = 0;
    let indicates = 0;
    for (let i = 0; i < 500; i++) {
      const r = playPerfect(new SfstSession(0, 'none', [], createRng(i + 9000)));
      for (const t of ['hgn', 'walkTurn', 'oneLeg'] as const) {
        total++;
        if (r.clues[t] <= 1) low++;
      }
      if (r.indicates) indicates++;
      expect(r.administered).toEqual({ hgn: true, walkTurn: true, oneLeg: true });
    }
    expect(low / total).toBeGreaterThan(0.9);
    expect(indicates / 500).toBeLessThan(0.05);
  });

  it('indicates impairment for a drunk subject', () => {
    let indicates = 0;
    for (let i = 0; i < 200; i++) if (playPerfect(new SfstSession(0.15, 'none', [], createRng(i))).indicates) indicates++;
    expect(indicates).toBe(200);
  });

  it('adds drug and diabetic clues', () => {
    const sober = meanClues(0, 'none', [], 400);
    const opioid = meanClues(0, 'opioid', [], 400);
    expect(opioid.hgn).toBeGreaterThan(sober.hgn + 0.5);
    expect(opioid.walkTurn).toBeGreaterThan(sober.walkTurn + 1.2);
    expect(meanClues(0, 'cannabis', [], 400).oneLeg).toBeGreaterThan(sober.oneLeg + 0.5);
    const diabetic = meanClues(0, 'none', ['diabetic'], 600);
    expect(diabetic.walkTurn).toBeGreaterThan(sober.walkTurn + 0.2);
    expect(diabetic.walkTurn).toBeLessThan(sober.walkTurn + 1.2);
  });

  it('does not count a test when too many prompts are missed or never answered', () => {
    const idle = new SfstSession(0.2, 'none', [], createRng(4));
    for (let i = 0; i < 2000; i++) idle.step(0.5);
    const r = idle.result();
    expect(r).not.toBeNull();
    expect(r?.administered).toEqual({ hgn: false, walkTurn: false, oneLeg: false });
    expect(r?.clues).toEqual({ hgn: 0, walkTurn: 0, oneLeg: 0 });
    expect(r?.indicates).toBe(false);
    expect(r?.summary).toEqual(['HGN: not administered correctly', 'Walk and turn: not administered correctly', 'One-leg stand: not administered correctly']);

    // Wrong keys are misses.
    const wrong = new SfstSession(0.2, 'none', [], createRng(4));
    for (let i = 0; i < 2000 && wrong.test !== 'done'; i++) {
      wrong.step(0.1);
      if (wrong.prompt) wrong.press('q');
    }
    expect(wrong.result()?.administered).toEqual({ hgn: false, walkTurn: false, oneLeg: false });

    // 3 of 4 one-leg prompts is exactly the 0.75 share; 2 of 4 is not enough.
    const tally = (hitsInOneLeg: number): SfstResult => {
      const s = new SfstSession(0.2, 'none', [], createRng(11));
      let oneLegPrompts = 0;
      for (let i = 0; i < 5000 && s.test !== 'done'; i++) {
        s.step(0.1);
        const p = s.prompt;
        if (!p) continue;
        if (s.test !== 'oneLeg') s.press(p.key);
        else {
          oneLegPrompts++;
          s.press(oneLegPrompts <= hitsInOneLeg ? p.key : 'q');
        }
      }
      return s.result() as SfstResult;
    };
    expect(tally(3).administered.oneLeg).toBe(true);
    expect(tally(2).administered.oneLeg).toBe(false);
    expect(tally(2).administered.hgn).toBe(true);
    const ok = tally(4);
    expect(ok.summary[2]).toMatch(/^One-leg stand: \d\/4 clues$/);
  });

  it('is deterministic for a given rng and consumes one draw from the caller', () => {
    const a = playPerfect(new SfstSession(0.09, 'stimulant', ['diabetic'], createRng(321)));
    const b = playPerfect(new SfstSession(0.09, 'stimulant', ['diabetic'], createRng(321)));
    expect(a).toEqual(b);
    const rng = createRng(5);
    const probe = createRng(5);
    probe.nextInt(0, 0xffffffff);
    void new SfstSession(0.1, 'none', [], rng);
    expect(rng.next()).toBe(probe.next());
  });

  it('saves and restores mid-test and continues identically', () => {
    for (const stopAfter of [0.5, 5, 30, 55]) {
      const make = (): SfstSession => new SfstSession(0.1, 'opioid', ['diabetic'], createRng(2024));
      const control = make();
      const live = make();
      const advance = (s: SfstSession, secs: number): void => {
        for (let t = 0; t < secs; t += 0.1) {
          s.step(0.1);
          if (s.prompt && Math.floor(t * 10) % 2 === 0) s.press(s.prompt.key);
        }
      };
      advance(control, stopAfter);
      advance(live, stopAfter);
      const saved = JSON.parse(JSON.stringify(live.serialize())) as unknown;
      expect(isSfstSave(saved)).toBe(true);
      const restored = SfstSession.restore(saved as ReturnType<SfstSession['serialize']>);
      expect(restored.serialize()).toEqual(control.serialize());
      expect(restored.test).toBe(control.test);
      expect(restored.progress).toBe(control.progress);
      expect(restored.prompt).toEqual(control.prompt);
      const finish = (s: SfstSession): SfstResult => {
        for (let i = 0; i < 20000 && s.result() === null; i++) {
          s.step(0.1);
          if (s.prompt) s.press(s.prompt.key);
        }
        return s.result() as SfstResult;
      };
      expect(finish(restored)).toEqual(finish(control));
    }
  });

  it('rejects malformed saves', () => {
    const good = new SfstSession(0.1, 'none', [], createRng(1)).serialize();
    expect(isSfstSave(good)).toBe(true);
    expect(isSfstSave(null)).toBe(false);
    expect(isSfstSave({ ...good, version: 2 })).toBe(false);
    expect(isSfstSave({ ...good, testIndex: 9 })).toBe(false);
    expect(isSfstSave({ ...good, phase: 'x' })).toBe(false);
    expect(isSfstSave({ ...good, rng: { seed: 1, s: [1] } })).toBe(false);
  });
});
