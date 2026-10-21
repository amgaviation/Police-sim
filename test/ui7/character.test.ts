import { describe, expect, it } from 'vitest';
import { officerPreset, validateOfficerLoadout } from '../../src/gear';
import type { OfficerLoadout } from '../../src/gear';
import type { Canvas2DLike } from '../../src/livery';
import {
  ATTACH,
  BADGE_SHAPES,
  PATCH_SHAPES,
  PRONOUN_PRESETS,
  UNIFORM_DATA,
  applyPronouns,
  buildOutfit,
  defaultCharacter,
  figureAppearance,
  parseCharacter,
  type CharacterProfile,
} from '../../src/uniform';
import {
  BODY_RANGES,
  CharacterCreator,
  SKETCH_HEIGHT_M,
  createCreatorState,
  creatorProfile,
  creatorReducer,
  drawBadge,
  drawPatch,
  extraVestSlots,
  figureSketchRects,
  gearMessages,
  pronounSample,
  skinAt,
  skinPosition,
  withItemCount,
  withRetention,
  type CreatorAction,
  type CreatorHost,
  type CreatorState,
  type GearValidator,
} from '../../src/ui/character';

const validator: GearValidator = (l, extra) => validateOfficerLoadout(l, { extraVestSlots: extra });
const start = (): { profile: CharacterProfile; gear: OfficerLoadout } => ({ profile: defaultCharacter(), gear: officerPreset('patrolStandard') });
const fresh = (): CreatorState => createCreatorState(start(), validator);
const run = (s: CreatorState, ...actions: CreatorAction[]): CreatorState => actions.reduce((st, a) => creatorReducer(st, a, validator), s);

function fakeHost(over: Partial<CreatorHost> = {}): { host: CreatorHost; done: [CharacterProfile, OfficerLoadout][]; cancelled: number; previews: number; extras: number[] } {
  const log = { done: [] as [CharacterProfile, OfficerLoadout][], cancelled: 0, previews: 0, extras: [] as number[] };
  const host: CreatorHost = {
    mode: 'newGame',
    validateGear: (l, extra) => {
      log.extras.push(extra);
      return validateOfficerLoadout(l, { extraVestSlots: extra });
    },
    preview: () => {
      log.previews++;
    },
    done: (p, g) => log.done.push([p, g]),
    cancel: () => {
      log.cancelled++;
    },
    ...over,
  };
  return {
    host,
    get done() {
      return log.done;
    },
    get cancelled() {
      return log.cancelled;
    },
    get previews() {
      return log.previews;
    },
    extras: log.extras,
  };
}

describe('creator reducer: identity and pronouns', () => {
  it('starts valid with the default character', () => {
    const s = fresh();
    expect(s.errors).toEqual([]);
    expect(s.tab).toBe('identity');
    expect(s.gearCheck?.ok).toBe(true);
  });

  it('applies each pronoun preset exactly', () => {
    for (const preset of ['she', 'he', 'they'] as const) {
      const s = run(fresh(), { kind: 'setPronounPreset', preset });
      expect(s.profile.pronouns).toEqual(PRONOUN_PRESETS[preset]);
      expect(s.errors).toEqual([]);
    }
  });

  it('turns a preset into a custom set when a word or the plural flag is edited', () => {
    let s = run(fresh(), { kind: 'setPronounPreset', preset: 'she' }, { kind: 'setPronounWord', word: 'subject', value: 'xe' });
    expect(s.profile.pronouns).toMatchObject({ id: 'custom', subject: 'xe', object: 'her' });
    expect(s.errors).toEqual([]);
    s = run(fresh(), { kind: 'setPronounPreset', preset: 'he' }, { kind: 'setPlural', plural: true });
    expect(s.profile.pronouns).toMatchObject({ id: 'custom', plural: true });
    expect(s.errors).toEqual([]);
    s = run(fresh(), { kind: 'setPronounsCustom' });
    expect(s.profile.pronouns.id).toBe('custom');
    expect(s.errors).toEqual([]);
  });

  it('validates custom pronoun words (1 to 12 letters) and reports the path', () => {
    for (const value of ['', 'x1', 'a'.repeat(13), 'a b']) {
      const s = run(fresh(), { kind: 'setPronounWord', word: 'reflexive', value });
      expect(s.errors.some((e) => e.startsWith('pronouns.reflexive')), value).toBe(true);
    }
    const ok = run(fresh(), { kind: 'setPronounWord', word: 'reflexive', value: 'emself' });
    expect(ok.errors).toEqual([]);
  });

  it('renders the sample sentence with the character pronouns', () => {
    const she = run(fresh(), { kind: 'setPronounPreset', preset: 'she' }).profile;
    const they = fresh().profile;
    expect(pronounSample(she)).toContain('she is down');
    expect(pronounSample(they)).toContain('they are down');
    expect(applyPronouns('{They} {have} {their} badge', she.pronouns, {})).toBe('She has her badge');
  });

  it('keeps a half-typed name in the state and reports it, then trims on the way out', () => {
    let s = run(fresh(), { kind: 'setText', field: 'firstName', value: '' });
    expect(s.errors.some((e) => e.startsWith('firstName'))).toBe(true);
    expect(creatorProfile(s)).toBeNull();
    s = run(s, { kind: 'setText', field: 'firstName', value: '  Mary Ann ' }, { kind: 'setText', field: 'lastName', value: "O'Neil-Smith" });
    expect(s.errors).toEqual([]);
    expect(creatorProfile(s)?.firstName).toBe('Mary Ann');
    expect(run(s, { kind: 'setText', field: 'badge', value: '12' }).errors.some((e) => e.includes('badge'))).toBe(true);
    expect(run(s, { kind: 'setText', field: 'badge', value: '123456' }).errors).toEqual([]);
    expect(run(s, { kind: 'setText', field: 'lastName', value: 'R2D2' }).errors.length).toBeGreaterThan(0);
  });
});

describe('creator reducer: body, hair and uniform', () => {
  it('clamps the sliders to the profile ranges and ignores NaN', () => {
    let s = run(fresh(), { kind: 'setBody', field: 'heightM', value: 3 });
    expect(s.profile.body.heightM).toBe(BODY_RANGES.heightM.max);
    s = run(s, { kind: 'setBody', field: 'heightM', value: 1 });
    expect(s.profile.body.heightM).toBe(1.5);
    s = run(s, { kind: 'setBody', field: 'build', value: -5 }, { kind: 'setBody', field: 'shoulders', value: 9 }, { kind: 'setBody', field: 'hips', value: 0 });
    expect(s.profile.body).toMatchObject({ build: 0.8, shoulders: 1.2, hips: 0.85 });
    const same = creatorReducer(s, { kind: 'setBody', field: 'hips', value: Number.NaN });
    expect(same).toBe(s);
    expect(s.errors).toEqual([]);
  });

  it('keeps the outfit hair equal to the profile hair', () => {
    const s = run(fresh(), { kind: 'setHairStyle', style: 'ponytail' }, { kind: 'setHairColor', color: 0x7a2e1e });
    expect(s.profile.hairStyle).toBe('ponytail');
    expect(s.profile.outfit.hairStyle).toBe('ponytail');
    expect(s.profile.hairColor).toBe(0x7a2e1e);
    expect(s.profile.outfit.hairColor).toBe(0x7a2e1e);
  });

  it('lerps between neighbouring skin tones', () => {
    const tones = UNIFORM_DATA.skinTones;
    expect(skinAt(0)).toBe(tones[0]);
    expect(skinAt(1)).toBe(tones.at(-1));
    const mid = skinAt(0.5 / (tones.length - 1));
    const a = tones[0] ?? 0;
    const b = tones[1] ?? 0;
    expect((mid >> 16) & 255).toBe(Math.round((((a >> 16) & 255) + ((b >> 16) & 255)) / 2));
    expect(skinAt(Number.NaN)).toBe(tones[0]);
    for (const tone of tones) expect(skinAt(skinPosition(tone))).toBe(tone);
    const s = run(fresh(), { kind: 'setSkin', color: mid });
    expect(s.profile.skin).toBe(mid);
    expect(s.errors).toEqual([]);
  });

  it('changes the uniform, hat, carrier, cold layer, name plate and colours', () => {
    let s = run(fresh(), { kind: 'setUniform', uniform: 'swat' }, { kind: 'setHat', hat: 'beanie' }, { kind: 'setCarrier', carrier: 'external' }, { kind: 'setCold', cold: 'parka' }, { kind: 'setNamePlate', on: false });
    expect(s.profile.outfit).toMatchObject({ uniform: 'swat', hat: 'beanie', carrier: 'external', cold: 'parka', namePlate: false });
    s = run(s, { kind: 'setColors', colors: { top: 0x112233, bottom: 0x445566 } });
    expect(s.profile.outfit.colors).toEqual({ top: 0x112233, bottom: 0x445566 });
    s = run(s, { kind: 'setColors', colors: null }, { kind: 'setRank', rank: 'captain' });
    expect(s.profile.outfit.colors).toBeNull();
    expect(s.profile.rank).toBe('captain');
    expect(s.errors).toEqual([]);
    expect(() => buildOutfit(s.profile.outfit, { lastName: s.profile.lastName, rank: s.profile.rank })).not.toThrow();
  });

  it('keeps badge and patch valid when the shape changes', () => {
    let s = fresh();
    for (const shape of BADGE_SHAPES) {
      s = run(s, { kind: 'setBadge', patch: { shape } });
      expect(s.errors, `badge ${shape}`).toEqual([]);
      expect(s.profile.outfit.badge.points !== undefined).toBe(shape === 'polygon');
      expect(s.profile.outfit.badge.starPoints !== undefined).toBe(shape === 'star');
    }
    for (const shape of PATCH_SHAPES) {
      s = run(s, { kind: 'setPatch', patch: { shape } });
      expect(s.errors, `patch ${shape}`).toEqual([]);
      expect(s.profile.outfit.patch.points !== undefined).toBe(shape === 'polygon');
    }
    s = run(s, { kind: 'setBadge', patch: { shape: 'polygon', points: [[0, -1], [1, 1], [-1, 1]] } });
    expect(s.profile.outfit.badge.points).toHaveLength(3);
    expect(run(s, { kind: 'setBadge', patch: { text: 'x'.repeat(13) } }).errors.length).toBeGreaterThan(0);
    expect(run(s, { kind: 'setPatch', patch: { initials: 'ABCDE' } }).errors.length).toBeGreaterThan(0);
  });

  it('every reduced profile passes parseCharacter and the state is not mutated', () => {
    const s0 = fresh();
    const frozen = JSON.stringify(s0);
    const s = run(
      s0,
      { kind: 'setPronounPreset', preset: 'she' },
      { kind: 'setBody', field: 'heightM', value: 1.9 },
      { kind: 'setUniform', uniform: 'detective' },
      { kind: 'setBadge', patch: { shape: 'ellipse' } },
    );
    expect(parseCharacter(s.profile).ok).toBe(true);
    expect(JSON.stringify(s0)).toBe(frozen);
    expect(creatorReducer(s, { kind: 'tab', tab: 'gear' }).tab).toBe('gear');
    expect(creatorReducer(s, { kind: 'tab', tab: s.tab })).toBe(s);
  });
});

describe('figureSketchRects', () => {
  const sketch = (over: (p: CharacterProfile) => void): ReturnType<typeof figureSketchRects> => {
    const p = defaultCharacter();
    over(p);
    const outfit = buildOutfit(p.outfit, { lastName: p.lastName, rank: p.rank });
    return figureSketchRects(figureAppearance(p, outfit), outfit);
  };

  it('draws the body parts with the figure colours, inside the sketch frame', () => {
    const p = defaultCharacter();
    const outfit = buildOutfit(p.outfit, { lastName: p.lastName, rank: p.rank });
    const app = figureAppearance(p, outfit);
    const rects = figureSketchRects(app, outfit);
    const body = rects.filter((r) => r.attach === null);
    expect(body.length).toBeGreaterThanOrEqual(8);
    expect(body.some((r) => r.color === app.skin)).toBe(true);
    expect(body.some((r) => r.color === app.top)).toBe(true);
    for (const r of rects) {
      expect(r.y).toBeGreaterThanOrEqual(-0.001);
      expect(r.y + r.h).toBeLessThan(SKETCH_HEIGHT_M);
      expect(Math.abs(r.x) + r.w).toBeLessThan(1.2);
    }
    const head = body.find((r) => r.color === app.skin);
    expect(head && head.y + head.h).toBeCloseTo(1.45 + 0.24 * 1, 1);
  });

  it('puts a helmet above the head', () => {
    const bare = sketch((p) => {
      p.outfit.hat = 'none';
    });
    const helmet = sketch((p) => {
      p.outfit.hat = 'tacticalHelmet';
    });
    const headTop = (rects: typeof bare): number => {
      const skin = defaultCharacter().skin;
      const head = rects.find((r) => r.attach === null && r.color === skin);
      return head ? head.y + head.h : 0;
    };
    const top = headTop(helmet);
    const hats = helmet.filter((r) => r.attach === ATTACH.head);
    expect(hats.length).toBeGreaterThan(bare.filter((r) => r.attach === ATTACH.head).length);
    expect(Math.max(...hats.map((r) => r.y + r.h))).toBeGreaterThan(top);
    // The helmet is centred on the head.
    const shell = hats.reduce((a, b) => (b.w > a.w ? b : a));
    expect(shell.x + shell.w / 2).toBeCloseTo(0, 6);
  });

  it('adds three chevron rectangles per arm for a sergeant', () => {
    const officer = sketch((p) => {
      p.rank = 'officer';
    });
    const sergeant = sketch((p) => {
      p.rank = 'sergeant';
    });
    for (const arm of [ATTACH.leftArm, ATTACH.rightArm]) {
      const before = officer.filter((r) => r.attach === arm).length;
      const after = sergeant.filter((r) => r.attach === arm).length;
      expect(after - before).toBe(3);
    }
    // Left and right arms sit on opposite sides of the centre line.
    const left = sergeant.filter((r) => r.attach === ATTACH.leftArm);
    const right = sergeant.filter((r) => r.attach === ATTACH.rightArm);
    expect(Math.min(...left.map((r) => r.x))).toBeGreaterThan(0);
    expect(Math.max(...right.map((r) => r.x + r.w))).toBeLessThan(0);
  });

  it('scales with height and body sliders', () => {
    const tall = sketch((p) => {
      p.body = { heightM: 2.05, build: 1.3, shoulders: 1.2, hips: 1.2 };
    });
    const small = sketch((p) => {
      p.body = { heightM: 1.5, build: 0.8, shoulders: 0.85, hips: 0.85 };
    });
    const top = (r: typeof tall): number => Math.max(...r.map((q) => q.y + q.h));
    const width = (r: typeof tall): number => Math.max(...r.filter((q) => q.attach === null).map((q) => q.x + q.w)) - Math.min(...r.filter((q) => q.attach === null).map((q) => q.x));
    expect(top(tall)).toBeGreaterThan(top(small));
    expect(width(tall)).toBeGreaterThan(width(small));
    expect(top(tall)).toBeLessThan(SKETCH_HEIGHT_M);
  });

  it('is deterministic', () => {
    expect(sketch(() => undefined)).toEqual(sketch(() => undefined));
  });
});

describe('gear tab', () => {
  it('surfaces the gear errors of the host validator as messages and keeps Done enabled', () => {
    const vest = withItemCount(officerPreset('patrolStandard'), 'ballisticVest', 0);
    expect(vest.items.some((i) => i.id === 'ballisticVest')).toBe(false);
    const s = run(fresh(), { kind: 'setGear', gear: vest });
    expect(s.gearCheck?.ok).toBe(false);
    const msgs = gearMessages(s.gearCheck);
    expect(msgs.errors.length).toBeGreaterThan(0);
    expect(msgs.errors.join(' ').toLowerCase()).toContain('vest');
    expect(s.errors).toEqual([]);
  });

  it('flags a holster below the assignment retention and an overweight loadout', () => {
    let s = run(fresh(), { kind: 'setRetention', id: 'holster', level: 1 });
    expect(gearMessages(s.gearCheck).errors.length).toBeGreaterThan(0);
    s = run(s, { kind: 'setRetention', id: 'holster', level: 2 });
    expect(s.gearCheck?.ok).toBe(true);
    s = run(s, { kind: 'setItem', id: 'ram', count: 1 }, { kind: 'setItem', id: 'rifle', count: 1 }, { kind: 'setItem', id: 'shotgun', count: 1 });
    expect(s.gearCheck?.ok).toBe(false);
    expect(s.gearCheck?.weightKg).toBeGreaterThan(s.gearCheck?.capacityKg ?? 0);
  });

  it('clamps counts, starts a holster at retention 2 and ignores unknown items', () => {
    const base = officerPreset('patrolStandard');
    expect(withItemCount(base, 'cuffs', 9).items.find((i) => i.id === 'cuffs')?.count).toBe(2);
    expect(withItemCount(base, 'cuffs', -3).items.some((i) => i.id === 'cuffs')).toBe(false);
    expect(withItemCount(base, 'nope', 1)).toBe(base);
    const noHolster = withItemCount(base, 'holster', 0);
    expect(withItemCount(noHolster, 'holster', 1).items.find((i) => i.id === 'holster')?.retention).toBe(2);
    expect(withRetention(base, 'holster', 3).items.find((i) => i.id === 'holster')?.retention).toBe(3);
    expect(withRetention(base, 'radio', 3).items.find((i) => i.id === 'radio')?.retention).toBeUndefined();
    expect(base).toEqual(officerPreset('patrolStandard'));
  });

  it('applies presets and assignments; unknown ones are ignored', () => {
    const s = run(fresh(), { kind: 'applyPreset', preset: 'swatOperator' });
    expect(s.gear.assignment).toBe('swat');
    expect(run(s, { kind: 'applyPreset', preset: 'nope' })).toBe(s);
    const t = run(s, { kind: 'setAssignment', assignment: 'motor' });
    expect(t.gear.assignment).toBe('motor');
    expect(t.gearCheck?.ok).toBe(false);
  });

  it('passes the external-carrier bonus to the validator', () => {
    const seen: number[] = [];
    const spy: GearValidator = (l, extra) => {
      seen.push(extra);
      return validateOfficerLoadout(l, { extraVestSlots: extra });
    };
    const s = createCreatorState(start(), spy);
    expect(extraVestSlots(s.profile)).toBe(0);
    const t = creatorReducer(s, { kind: 'setCarrier', carrier: 'external' }, spy);
    expect(extraVestSlots(t.profile)).toBe(2);
    expect(seen.at(-1)).toBe(2);
    const swat = creatorReducer(t, { kind: 'setCarrier', carrier: 'default' }, spy);
    expect(seen.at(-1)).toBe(0);
    expect(extraVestSlots(creatorReducer(swat, { kind: 'setUniform', uniform: 'tactical' }, spy).profile)).toBe(2);
  });

  it('has no gear check without a validator', () => {
    const s = createCreatorState(start());
    expect(s.gearCheck).toBeNull();
    expect(gearMessages(null)).toEqual({ errors: [], warnings: [] });
  });
});

describe('CharacterCreator (headless)', () => {
  it('constructs without a DOM and exposes the start state', () => {
    const rig = fakeHost();
    const c = new CharacterCreator(null, rig.host, start());
    expect(c.id).toBe('character-creator');
    expect(c.pausesGame).toBe(true);
    expect(c.canDone).toBe(true);
    expect(c.state.profile.firstName).toBe('Jordan');
    expect(c.gearIssues.errors).toEqual([]);
  });

  it('Done is refused while the identity is invalid, then hands a trimmed copy to the host', () => {
    const rig = fakeHost();
    const c = new CharacterCreator(null, rig.host, start());
    c.dispatch({ kind: 'setText', field: 'lastName', value: '' });
    expect(c.canDone).toBe(false);
    expect(c.done()).toBe(false);
    expect(rig.done).toHaveLength(0);
    c.dispatch({ kind: 'setText', field: 'lastName', value: ' Rivera ' });
    expect(c.done()).toBe(true);
    expect(rig.done).toHaveLength(1);
    expect(rig.done[0]?.[0].lastName).toBe('Rivera');
    expect(rig.done[0]?.[1].assignment).toBe('patrol');
  });

  it('gear errors only warn: Done still works', () => {
    const rig = fakeHost();
    const c = new CharacterCreator(null, rig.host, start());
    c.dispatch({ kind: 'setItem', id: 'ballisticVest', count: 0 });
    expect(c.gearIssues.errors.length).toBeGreaterThan(0);
    expect(c.canDone).toBe(true);
    expect(c.done()).toBe(true);
  });

  it('previews only valid profiles and cancels on Escape', () => {
    const rig = fakeHost();
    const c = new CharacterCreator(null, rig.host, start());
    c.dispatch({ kind: 'setText', field: 'firstName', value: '' });
    expect(rig.previews).toBe(0);
    c.dispatch({ kind: 'setText', field: 'firstName', value: 'Sam' });
    expect(rig.previews).toBe(1);
    expect(c.onKeyDown({ key: 'Escape' } as KeyboardEvent)).toBe(false);
    c.open();
    expect(c.onKeyDown({ key: 'Escape' } as KeyboardEvent)).toBe(true);
    expect(rig.cancelled).toBe(1);
  });

  it('works without a preview hook (new game mode)', () => {
    const rig = fakeHost({ mode: 'newGame', preview: undefined });
    const c = new CharacterCreator(null, rig.host, start());
    c.dispatch({ kind: 'setBody', field: 'build', value: 1.2 });
    expect(c.state.profile.body.build).toBe(1.2);
  });
});

describe('badge and patch drawings', () => {
  function recorder(): { ctx: Canvas2DLike; calls: string[] } {
    const calls: string[] = [];
    const noop = (name: string) => () => {
      calls.push(name);
    };
    const ctx: Canvas2DLike = {
      fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '', globalAlpha: 1,
      save: noop('save'), restore: noop('restore'), translate: noop('translate'), rotate: noop('rotate'), scale: noop('scale'),
      beginPath: noop('beginPath'), moveTo: noop('moveTo'), lineTo: noop('lineTo'), closePath: noop('closePath'), rect: noop('rect'),
      fill: noop('fill'), stroke: noop('stroke'), clip: noop('clip'), fillRect: noop('fillRect'), clearRect: noop('clearRect'),
      fillText: (t: string) => {
        calls.push(`text:${t}`);
      },
      strokeText: noop('strokeText'),
    };
    return { ctx, calls };
  }

  it('draws every badge shape with its text and colours', () => {
    const base = UNIFORM_DATA.department.badge;
    for (const shape of BADGE_SHAPES) {
      const { ctx, calls } = recorder();
      const badge = { ...base, shape, ...(shape === 'polygon' ? { points: [[0, -1], [1, 1], [-1, 1]] as [number, number][] } : {}) };
      drawBadge(ctx, badge, 96);
      expect(calls.filter((c) => c === 'lineTo').length, shape).toBeGreaterThanOrEqual(2);
      expect(calls).toContain('fill');
      expect(calls).toContain('stroke');
      expect(calls).toContain(`text:${base.text}`);
      expect(ctx.fillStyle).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('draws every patch shape with initials and text', () => {
    const base = UNIFORM_DATA.department.patch;
    for (const shape of PATCH_SHAPES) {
      const { ctx, calls } = recorder();
      const patch = { ...base, shape, ...(shape === 'polygon' ? { points: [[0, -1], [1, 1], [-1, 1]] as [number, number][] } : {}) };
      drawPatch(ctx, patch, 96);
      expect(calls, shape).toContain(`text:${base.initials}`);
      expect(calls).toContain(`text:${base.text}`);
    }
  });

  it('skips empty text', () => {
    const { ctx, calls } = recorder();
    drawBadge(ctx, { ...UNIFORM_DATA.department.badge, text: '' }, 64);
    expect(calls.some((c) => c.startsWith('text:'))).toBe(false);
  });
});
