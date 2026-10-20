import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMMAND_PANEL_STATE,
  applyCommandPick,
  commandPanelModel,
  commandPanelPick,
  vitalsLines,
  type CommandPanelState,
} from '../../src/ui/command';
import { board, prompt, vitals } from './fixtures';

const swatState: CommandPanelState = { ...DEFAULT_COMMAND_PANEL_STATE, submenu: 'swat' };

describe('command mode', () => {
  it('lists the command entries in design order', () => {
    const m = commandPanelModel(board(), null, null);
    expect(m.title).toBe('Incident command');
    expect(m.options.map((o) => o.label)).toEqual([
      'Establish command',
      'Assess nearest victim',
      'Traffic control on',
      'Evacuate the zone',
      'Contain the location',
      'Request recommended resources',
      'Negotiate',
      'SWAT ▸',
      'Stand down',
    ]);
  });

  it('shows the post, the level and the counts in the subtitle', () => {
    const m = commandPanelModel(board(), null, null);
    expect(m.subtitle).toBe('DISASTER · 12 · RED 3 YEL 4 GRN 2 BLK 1 · untagged 2');
    expect(commandPanelModel(board({ post: null }), null, null).subtitle).toBe('No command post');
  });

  it('allows establishing only without a post, and disables the rest until then', () => {
    const none = commandPanelModel(board({ post: null }), null, null);
    expect(none.options[0]?.enabled).toBeUndefined();
    for (const i of [1, 2, 3, 4, 5, 6, 8]) {
      expect(none.options[i]?.enabled, String(i)).toBe(false);
      expect(none.options[i]?.detail).toBe('Establish command first');
    }
    const open = commandPanelModel(board(), null, null);
    expect(open.options[0]?.enabled).toBe(false);
    expect(open.options[0]?.detail).toBe('Command post is open');
  });

  it('names the recommended resources on the request row and disables it when nothing is needed', () => {
    const m = commandPanelModel(board(), null, null);
    expect(m.options[5]?.detail).toBe('EMS 2, fire 1');
    const zero = commandPanelModel(board({ needs: { ems: 0, fire: 0, supervisor: 0 } }), null, null);
    expect(zero.options[5]?.enabled).toBe(false);
  });

  it('toggles traffic control by the current staffing and blocks repeated evacuation / containment', () => {
    const m = commandPanelModel(board({ tcps: { staffed: 1, total: 4 }, evac: { progress: 0.2, radiusM: 120 }, inner: { staffed: 0, total: 4 } }), null, null);
    expect(m.options[2]?.label).toBe('Traffic control off');
    expect(m.options[2]?.detail).toBe('1/4 staffed');
    expect(m.options[3]?.enabled).toBe(false);
    expect(m.options[4]?.enabled).toBe(false);
  });

  it('disables assess without untagged victims and the SWAT submenu without a team', () => {
    const m = commandPanelModel(board({ counts: { minor: 1, delayed: 0, immediate: 0, expectant: 0, untagged: 0 } }), null, null);
    expect(m.options[1]?.enabled).toBe(false);
    expect(m.options[7]?.enabled).toBe(false);
    expect(m.options[7]?.detail).toBe('No SWAT unit assigned');
    expect(commandPanelModel(board(), null, 'enRoute').options[7]?.detail).toBe('SWAT is en route');
    expect(commandPanelModel(board(), null, 'stacked').options[7]?.enabled).toBeUndefined();
  });

  it('picks the requests', () => {
    const b = board({ post: null });
    expect(commandPanelPick(0, b, null, null)).toEqual({ kind: 'establish' });
    expect(commandPanelPick(1, b, null, null)).toBeNull();
    const open = board();
    expect(commandPanelPick(1, open, null, null)).toEqual({ kind: 'assess' });
    expect(commandPanelPick(2, open, null, null)).toEqual({ kind: 'tcp', on: true });
    expect(commandPanelPick(2, board({ tcps: { staffed: 0, total: 2 } }), null, null)).toEqual({ kind: 'tcp', on: false });
    expect(commandPanelPick(3, open, null, null)).toEqual({ kind: 'evacuate' });
    expect(commandPanelPick(4, open, null, null)).toEqual({ kind: 'contain' });
    expect(commandPanelPick(5, open, null, null)).toEqual({ kind: 'requestNeeds' });
    expect(commandPanelPick(6, open, null, null)).toEqual({ kind: 'negotiationOpen' });
    expect(commandPanelPick(7, open, null, 'staging')).toEqual({ submenu: 'swat' });
    expect(commandPanelPick(8, open, null, null)).toEqual({ kind: 'standDown' });
    expect(commandPanelPick(9, open, null, null)).toBeNull();
    expect(commandPanelPick(-1, open, null, null)).toBeNull();
  });

  it('closes negotiation once it is over', () => {
    const m = commandPanelModel(board({ negotiation: { trust: 0.5, agitation: 0.2, outcome: 'surrender', stage: 'resolution' } }), null, null);
    expect(m.options[6]?.enabled).toBe(false);
  });
});

describe('SWAT submenu', () => {
  it('lists the six commands, the three plan rows and Back', () => {
    const m = commandPanelModel(board(), null, 'staging', swatState);
    expect(m.title).toBe('SWAT');
    expect(m.subtitle).toBe('Team: staging');
    expect(m.options.map((o) => o.label)).toEqual([
      'Stage',
      'Stack on the door',
      'Breach',
      'Clear the building',
      'Hold',
      'Withdraw',
      'Plan: entry front',
      'Plan: tempo deliberate',
      'Plan: less-lethal off',
      'Back ▸',
    ]);
  });

  it('disables the commands while the team is not there but keeps the plan and Back', () => {
    const m = commandPanelModel(board(), null, 'enRoute', swatState);
    expect(m.options.slice(0, 6).every((o) => o.enabled === false)).toBe(true);
    expect(m.options[0]?.detail).toBe('SWAT is en route');
    expect(m.options.slice(6).every((o) => o.enabled !== false)).toBe(true);
  });

  it('sends every command with the full plan and changes the plan locally', () => {
    expect(commandPanelPick(2, board(), null, 'stacked', swatState)).toEqual({
      kind: 'swat',
      command: 'breach',
      plan: { entry: 'front', tempo: 'deliberate', lessLethal: false },
    });
    expect(commandPanelPick(6, board(), null, 'stacked', swatState)).toEqual({ plan: { entry: 'rear' } });
    expect(commandPanelPick(7, board(), null, 'stacked', swatState)).toEqual({ plan: { tempo: 'dynamic' } });
    expect(commandPanelPick(8, board(), null, 'stacked', swatState)).toEqual({ plan: { lessLethal: true } });
    expect(commandPanelPick(9, board(), null, 'stacked', swatState)).toEqual({ submenu: 'root' });
  });

  it('keeps the plan in the panel state and sends the changed plan afterwards', () => {
    let state = swatState;
    state = applyCommandPick(state, commandPanelPick(6, board(), null, 'stacked', state));
    state = applyCommandPick(state, commandPanelPick(8, board(), null, 'stacked', state));
    expect(state.plan).toEqual({ entry: 'rear', tempo: 'deliberate', lessLethal: true });
    const m = commandPanelModel(board(), null, 'stacked', state);
    expect(m.options[6]?.label).toBe('Plan: entry rear');
    expect(m.options[8]?.label).toBe('Plan: less-lethal on');
    expect(commandPanelPick(4, board(), null, 'stacked', state)).toEqual({
      kind: 'swat',
      command: 'hold',
      plan: { entry: 'rear', tempo: 'deliberate', lessLethal: true },
    });
    expect(applyCommandPick(state, { submenu: 'root' }).submenu).toBe('root');
    expect(applyCommandPick(state, { kind: 'assess' })).toBe(state);
    expect(applyCommandPick(state, null)).toBe(state);
  });
});

describe('triage mode', () => {
  it('shows a progress line while assessing and no vitals or tag choices', () => {
    const m = commandPanelModel(board(), prompt({ progress: 0.4 }), null);
    expect(m.title).toBe('Triage — Patient 3');
    expect(m.options[0]).toEqual({ label: 'Assessing… 40%', detail: 'Stay with the patient', enabled: false });
    expect(m.options.every((o) => o.enabled === false)).toBe(true);
    expect(m.options.map((o) => o.label).join('|')).not.toMatch(/Walking|Breathing|pulse|refill/);
    for (let i = 0; i < m.options.length; i++) expect(commandPanelPick(i, board(), prompt({ progress: 0.4 }), null)).toBeNull();
  });

  it('shows the vitals as disabled readings and four tag options once assessed', () => {
    const t = prompt({ progress: 1, vitals: vitals() });
    const m = commandPanelModel(board(), t, null);
    expect(m.options.slice(0, 5).map((o) => o.label)).toEqual([
      'Walking: no',
      'Breathing: yes, 34 / min',
      'Radial pulse: absent',
      'Capillary refill: 3.1 s',
      'Follows commands: yes',
    ]);
    expect(m.options.slice(0, 5).every((o) => o.enabled === false)).toBe(true);
    expect(m.options.slice(5).map((o) => o.label)).toEqual(['Tag GREEN minor', 'Tag YELLOW delayed', 'Tag RED immediate', 'Tag BLACK expectant']);
    expect(m.options.slice(5).every((o) => o.enabled !== false)).toBe(true);
  });

  it('picks a tag for the assessed patient and never hints at the right one', () => {
    const t = prompt({ progress: 1, vitals: vitals() });
    expect(commandPanelPick(5, board(), t, null)).toEqual({ kind: 'tag', personId: 77, tag: 'minor' });
    expect(commandPanelPick(7, board(), t, null)).toEqual({ kind: 'tag', personId: 77, tag: 'immediate' });
    expect(commandPanelPick(8, board(), t, null)).toEqual({ kind: 'tag', personId: 77, tag: 'expectant' });
    expect(commandPanelPick(0, board(), t, null)).toBeNull();
    const text = JSON.stringify(commandPanelModel(board(), t, null));
    expect(text).not.toMatch(/\bSTART\b|recommend|correct|should|\bbest\b/);
    // Every vitals variant: the model carries no tag-dependent text other than the four fixed labels.
    for (const v of [vitals({ walking: true }), vitals({ breathing: false, breathesAfterAirway: false }), vitals({ breathing: false })]) {
      const s = JSON.stringify(commandPanelModel(board(), prompt({ progress: 1, vitals: v }), null));
      expect(s).not.toMatch(/\bSTART\b|recommend|correct|should|\bbest\b/);
    }
  });

  it('marks the current tag and notes the scene facts', () => {
    const t = prompt({ progress: 1, vitals: vitals({ trapped: true, contaminated: true }), tag: 'delayed' });
    const m = commandPanelModel(board(), t, null);
    expect(m.subtitle).toBe('trapped · contaminated · tagged YELLOW delayed');
    expect(m.options[6]?.detail).toBe('● current tag');
    expect(m.options[5]?.detail).toBeUndefined();
  });

  it('describes the breathing reading without interpreting it', () => {
    expect(vitalsLines(vitals({ breathing: false, breathesAfterAirway: true, respRate: 12 }))[1]).toBe('Breathing: no, starts after the airway is opened (12 / min)');
    expect(vitalsLines(vitals({ breathing: false, breathesAfterAirway: false }))[1]).toBe('Breathing: no, even after the airway is opened');
    expect(vitalsLines(vitals({ walking: true, radialPulse: true, followsCommands: false, capRefillS: 1.25 }))).toEqual([
      'Walking: yes',
      'Breathing: yes, 34 / min',
      'Radial pulse: present',
      'Capillary refill: 1.3 s',
      'Follows commands: no',
    ]);
  });
});
