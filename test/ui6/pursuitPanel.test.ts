import { describe, expect, it } from 'vitest';
import { PURSUIT_IDLE_TEXT, pursuitPanelModel, pursuitPanelPick } from '../../src/ui/pursuit';
import { pursuitMenu } from './fixtures';

describe('pursuitPanelModel', () => {
  it('uses the design wording, one row per menu item', () => {
    const m = pursuitPanelModel(pursuitMenu(), null);
    expect(m.title).toBe('Pursuit tactics');
    expect(m.options.map((o) => o.label)).toEqual([
      'Request PIT authorization',
      'Spike strip ahead (AI unit)',
      'Deploy my spike strip',
      'Box in',
      'Roadblock',
      'Request air unit',
      'Set a perimeter',
    ]);
    expect(m.subtitle).toBe(PURSUIT_IDLE_TEXT);
  });

  it('disables entries with their hint and enables the ones the pursuit module allows', () => {
    const m = pursuitPanelModel(pursuitMenu(['boxIn', 'air']), null);
    expect(m.options[0]).toEqual({ label: 'Request PIT authorization', detail: 'No pursuit', enabled: false });
    expect(m.options[2]?.detail).toBe('No strip carried');
    expect(m.options[3]).toEqual({ label: 'Box in' });
    expect(m.options[5]).toEqual({ label: 'Request air unit' });
  });

  it('falls back to a generic hint and shows the live line and the verdict', () => {
    const menu = pursuitMenu().map((i) => ({ ...i, hint: '' }));
    expect(pursuitPanelModel(menu, null).options[0]?.detail).toBe('Not available');
    const m = pursuitPanelModel(pursuitMenu(['requestPit']), { line: 'PURSUIT · 62 mph', verdict: 'PIT: within policy' });
    expect(m.subtitle).toBe('PURSUIT · 62 mph');
    expect(m.footer).toBe('PIT: within policy');
    expect(pursuitPanelModel(pursuitMenu(), { line: 'x', verdict: null }).footer).toBeUndefined();
  });
});

describe('pursuitPanelPick', () => {
  it('returns the request of an enabled entry', () => {
    const menu = pursuitMenu(['requestPit', 'deployStrip', 'perimeter']);
    expect(pursuitPanelPick(0, menu)).toEqual({ kind: 'requestPit' });
    expect(pursuitPanelPick(2, menu)).toEqual({ kind: 'deployStrip' });
    expect(pursuitPanelPick(6, menu)).toEqual({ kind: 'perimeter' });
  });

  it('returns null for disabled and unknown entries', () => {
    const menu = pursuitMenu(['requestPit']);
    expect(pursuitPanelPick(1, menu)).toBeNull();
    expect(pursuitPanelPick(7, menu)).toBeNull();
    expect(pursuitPanelPick(-1, menu)).toBeNull();
    expect(pursuitPanelPick(Number.NaN, menu)).toBeNull();
  });
});
