import { afterEach, describe, expect, it } from 'vitest';
import { Hud, createHudText, hudText } from '../../src/ui/hud/hud';
import {
  LEGAL_COLORS,
  TRUST_COLORS,
  camChipState,
  camChipText,
  clampTrust,
  dashChipText,
  forceChipText,
  forceEpisodeText,
  legalLineText,
  trustBand,
  trustChipText,
  type HudCam,
  type HudForce,
} from '../../src/ui/hud/law';
import { snapshot } from './fixtures';

const parent = null as unknown as HTMLElement;
const force = (over: Partial<HudForce> = {}): HudForce => ({ tool: 'CED', ammo: '2/2', attached: false, episode: null, ...over });
const cam = (over: Partial<HudCam> = {}): HudCam => ({ body: false, muted: false, dash: false, worn: true, ...over });

describe('force chip text', () => {
  it('shows the tool and ammo, probes when attached, nothing when holstered', () => {
    expect(forceChipText(force())).toBe('CED 2/2');
    expect(forceChipText(force({ attached: true }))).toBe('CED 2/2 · PROBES');
    expect(forceChipText(force({ tool: 'Sidearm', ammo: '' }))).toBe('SIDEARM');
    expect(forceChipText(force({ tool: 'none' }))).toBe('');
    expect(forceChipText(force({ tool: '' }))).toBe('');
    expect(forceChipText(null)).toBe('');
    expect(forceChipText(undefined)).toBe('');
  });

  it('shows the misconduct episode in capitals', () => {
    expect(forceEpisodeText(force({ episode: 'Partner striking a cuffed subject (H)' }))).toBe('PARTNER STRIKING A CUFFED SUBJECT (H)');
    expect(forceEpisodeText(force({ episode: null }))).toBe('');
    expect(forceEpisodeText(force({ episode: '' }))).toBe('');
    expect(forceEpisodeText(null)).toBe('');
  });
});

describe('camera chips', () => {
  it('derives REC, MUTED, CAM and none from the bits', () => {
    expect(camChipState(cam({ body: true }))).toBe('rec');
    expect(camChipText(cam({ body: true }))).toBe('● REC');
    expect(camChipState(cam({ body: true, muted: true }))).toBe('muted');
    expect(camChipText(cam({ body: true, muted: true }))).toBe('MUTED');
    expect(camChipState(cam())).toBe('off');
    expect(camChipText(cam())).toBe('CAM');
    expect(camChipState(cam({ worn: false }))).toBe('none');
    expect(camChipText(cam({ worn: false }))).toBe('');
    expect(camChipState(null)).toBe('none');
    expect(camChipText(undefined)).toBe('');
  });

  it('shows DASH independently of the bodycam', () => {
    expect(dashChipText(cam({ dash: true }))).toBe('DASH');
    expect(dashChipText(cam())).toBe('');
    expect(dashChipText(null)).toBe('');
  });
});

describe('legal line and trust chip', () => {
  it('passes the legal text through and has a colour per severity', () => {
    expect(legalLineText({ text: 'CED on active resistance: within policy (GS-8.1)', severity: 'ok' })).toBe('CED on active resistance: within policy (GS-8.1)');
    expect(legalLineText(null)).toBe('');
    expect(Object.keys(LEGAL_COLORS)).toEqual(['ok', 'warn', 'bad']);
  });

  it('formats trust as a percentage and bands it red / amber / green', () => {
    expect(trustChipText({ district: 'Suburbs', value: 0.62 })).toBe('Trust · Suburbs 62 %');
    expect(trustChipText({ district: '', value: 0.5 })).toBe('Trust · 50 %');
    expect(trustChipText({ district: 'Docks', value: 3 })).toBe('Trust · Docks 100 %');
    expect(trustChipText({ district: 'Docks', value: Number.NaN })).toBe('Trust · Docks 0 %');
    expect(trustChipText(null)).toBe('');
    expect(clampTrust(-1)).toBe(0);
    expect(trustBand(0.29)).toBe('low');
    expect(trustBand(0.3)).toBe('mid');
    expect(trustBand(0.49)).toBe('mid');
    expect(trustBand(0.5)).toBe('high');
    expect(Object.keys(TRUST_COLORS)).toEqual(['low', 'mid', 'high']);
  });
});

describe('hudText Phase 5 fields', () => {
  it('is empty without the optional fields (a Phase 4 feed)', () => {
    const t = hudText(snapshot());
    expect(t.force).toBe('');
    expect(t.episode).toBe('');
    expect(t.dash).toBe('');
    expect(t.legal).toBe('');
    expect(t.legalSeverity).toBe('ok');
    expect(t.duty).toBe('');
    expect(t.court).toBe('');
    expect(t.trust).toBe('');
    expect(t.bodycamMuted).toBe(false);
  });

  it('keeps the Phase 3 weapon chip and the Phase 4 bodycam chip without the new feeds', () => {
    const t = hudText(snapshot({ officer: { weapon: 'taser' }, bodycam: { recording: true } }));
    expect(t.weapon).toBe('CED');
    expect(t.bodycam).toBe('● REC');
    expect(t.bodycamRecording).toBe(true);
    expect(t.bodycamMuted).toBe(false);
  });

  it('the force chip replaces the weapon chip and the camera chips replace the bodycam chip', () => {
    const t = hudText(
      snapshot({
        officer: { weapon: 'taser' },
        bodycam: { recording: false },
        force: force({ attached: true }),
        cam: cam({ body: true, muted: true, dash: true }),
      }),
    );
    expect(t.weapon).toBe('');
    expect(t.force).toBe('CED 2/2 · PROBES');
    expect(t.bodycam).toBe('MUTED');
    expect(t.bodycamRecording).toBe(false);
    expect(t.bodycamMuted).toBe(true);
    expect(t.dash).toBe('DASH');
    const rec = hudText(snapshot({ bodycam: { recording: false }, cam: cam({ body: true }) }));
    expect(rec.bodycam).toBe('● REC');
    expect(rec.bodycamRecording).toBe(true);
    const off = hudText(snapshot({ bodycam: { recording: true }, cam: cam() }));
    expect(off.bodycam).toBe('CAM');
    expect(off.bodycamRecording).toBe(false);
  });

  it('covers legal, duty, court and trust', () => {
    const t = hudText(
      snapshot({
        force: force({ episode: 'Partner using force' }),
        legal: { text: 'Baton on passive resistance: excessive (GS-8.2)', severity: 'bad' },
        duty: 'SUSPENDED until Tue 06:00',
        court: 'COURT 14:00 · CR-0003 · in 1 h 20 min',
        trust: { district: 'Suburbs', value: 0.25 },
      }),
    );
    expect(t.episode).toBe('PARTNER USING FORCE');
    expect(t.legal).toBe('Baton on passive resistance: excessive (GS-8.2)');
    expect(t.legalSeverity).toBe('bad');
    expect(t.duty).toBe('SUSPENDED until Tue 06:00');
    expect(t.court).toBe('COURT 14:00 · CR-0003 · in 1 h 20 min');
    expect(t.trust).toBe('Trust · Suburbs 25 %');
    expect(t.trustBand).toBe('low');
  });

  it('refills a reused text object, clearing fields that went away', () => {
    const out = createHudText();
    hudText(snapshot({ force: force(), legal: { text: 'x', severity: 'warn' }, trust: { district: 'A', value: 0.9 } }), out);
    expect(out.force).not.toBe('');
    hudText(snapshot(), out);
    expect(out.force).toBe('');
    expect(out.legal).toBe('');
    expect(out.legalSeverity).toBe('ok');
    expect(out.trust).toBe('');
  });

  it('Hud picks the new fields up headless at the throttled rate', () => {
    const hud = new Hud(parent);
    const s = snapshot({ legal: { text: 'within policy', severity: 'ok' }, duty: 'TERMINATED' });
    hud.update(s, 0);
    expect(hud.text.legal).toBe('within policy');
    expect(hud.text.duty).toBe('TERMINATED');
    s.legal = null;
    hud.update(s, 50);
    expect(hud.text.legal).toBe('within policy');
    hud.update(s, 100);
    expect(hud.text.legal).toBe('');
  });
});

// A counting stand-in for the DOM: how often each element's text was written.
class CountEl {
  static all: CountEl[] = [];
  writes = 0;
  private text = '';
  readonly style: Record<string, string> = {};
  readonly children: CountEl[] = [];
  id = '';
  constructor() {
    CountEl.all.push(this);
  }
  get textContent(): string {
    return this.text;
  }
  set textContent(v: string) {
    this.text = v;
    this.writes++;
  }
  setAttribute(): void {
    /* style strings are not inspected */
  }
  appendChild(c: CountEl): CountEl {
    this.children.push(c);
    return c;
  }
  remove(): void {
    /* nothing to detach */
  }
}

describe('Hud DOM writes (fake document)', () => {
  const g = globalThis as unknown as { document?: unknown };
  const before = g.document;
  afterEach(() => {
    if (before === undefined) delete g.document;
    else g.document = before;
    CountEl.all = [];
  });

  it('writes the Phase 5 chips only when their text changes', () => {
    g.document = { createElement: (): CountEl => new CountEl() };
    const hud = new Hud(new CountEl() as unknown as HTMLElement);
    const s = snapshot({
      force: force(),
      cam: cam({ body: true, dash: true }),
      legal: { text: 'within policy', severity: 'ok' },
      duty: 'SUSPENDED',
      court: 'COURT 14:00',
      trust: { district: 'Suburbs', value: 0.62 },
    });
    hud.update(s, 0);
    const find = (text: string): CountEl => {
      const e = CountEl.all.find((c) => c.textContent === text);
      if (!e) throw new Error(`no element with text ${text}`);
      return e;
    };
    // Phase 9: the severity-coded legal line and the trust chip carry a shape cue in front (never colour alone).
    const chips = ['CED 2/2', '● REC', 'DASH', '\u2713 within policy', 'SUSPENDED', 'COURT 14:00', '\u25B2 Trust · Suburbs 62 %'].map(find);
    const written = chips.map((c) => c.writes);
    expect(written.every((w) => w === 1)).toBe(true);

    // Identical snapshots at later ticks: no further writes.
    hud.update(s, 200);
    hud.update(s, 400);
    expect(chips.map((c) => c.writes)).toEqual(written);

    // Only the changed chip is written.
    s.force = force({ ammo: '1/2' });
    hud.update(s, 600);
    const taser = find('CED 1/2');
    expect(taser).toBe(chips[0]);
    expect(taser.writes).toBe(2);
    expect(chips.slice(1).map((c) => c.writes)).toEqual(written.slice(1));

    // A chip that goes away is blanked once and hidden.
    s.legal = null;
    hud.update(s, 800);
    const legal = chips[3] as CountEl;
    expect(legal.textContent).toBe('');
    expect(legal.writes).toBe(2);
    expect(legal.style['display']).toBe('none');
    hud.update(s, 1000);
    expect(legal.writes).toBe(2);
  });
});
