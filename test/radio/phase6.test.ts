import { afterEach, describe, expect, it } from 'vitest';
import type { RadioMode } from '../../src/cad/types';
import { parseVoiceCommand } from '../../src/radio/grammar';
import { RadioMenu, type MenuContext } from '../../src/radio/menu';
import { radioRequestTypes, requestLabel, setRadioRequestTypes, type RadioRequestType } from '../../src/radio/requestTypes';
import { makeRig, PLAYER, requests, starts, type Rig } from './helpers';

const BASE: MenuContext = { mode: 'tenCode', hasTarget: false, hasStop: false, pendingOffer: false, onCall: false, emergency: false };

function resource(id: string, label: string, voice: string[], menu = label): RadioRequestType {
  return { id, menu, label, voice, request: { kind: 'resource', typeId: id } };
}

/** The shipped 18 requestable types (3 patrol + 15 resources), in menu order. */
function types(): RadioRequestType[] {
  return [
    { id: 'routine', menu: 'Backup, routine', label: 'routine backup', voice: ['routine backup', 'backup code 2', 'cover unit'], request: { kind: 'backup', code: 2 } },
    { id: 'priority', menu: 'Backup, code 3', label: 'priority backup', voice: ['priority backup', 'backup code 3', 'expedite'], request: { kind: 'backup', code: 3 } },
    { id: 'officerNeedsAssistance', menu: 'Officer needs assistance', label: 'officer needs assistance', voice: ['officer needs assistance', 'need help now'], request: { kind: 'emergency' } },
    resource('supervisor', 'a supervisor', ['supervisor', 'sergeant'], 'Supervisor'),
    resource('k9', 'a K9 unit', ['k9', 'canine', 'dog unit'], 'K9'),
    resource('ems', 'EMS', ['ems', 'ambulance', 'medics'], 'EMS'),
    resource('fire', 'the fire department', ['fire', 'fire department'], 'Fire'),
    resource('tow', 'a tow truck', ['tow', 'tow truck'], 'Tow'),
    resource('swat', 'the tactical team', ['swat', 'tactical team'], 'SWAT'),
    resource('negotiator', 'a negotiator', ['negotiator'], 'Negotiator'),
    resource('air', 'the air unit', ['air unit', 'helicopter'], 'Air unit'),
    resource('coroner', 'the coroner', ['coroner'], 'Coroner'),
    resource('detectives', 'detectives', ['detectives'], 'Detectives'),
    resource('csu', 'the crime scene unit', ['crime scene unit', 'csu'], 'Crime scene unit'),
    resource('animalControl', 'animal control', ['animal control'], 'Animal control'),
    resource('bombSquad', 'the bomb squad', ['bomb squad'], 'Bomb squad'),
    resource('statePatrol', 'state patrol', ['state patrol'], 'State patrol'),
    resource('federal', 'federal agents', ['federal agents'], 'Federal'),
  ];
}

function labels(m: RadioMenu, ctx: MenuContext = BASE): string[] {
  return m.view(ctx).options.map((o) => `${o.key} ${o.label}`);
}

afterEach(() => setRadioRequestTypes([]));

describe('radio request types registry', () => {
  it('defaults to empty, sets once and resolves labels (the id when unknown)', () => {
    expect(radioRequestTypes()).toEqual([]);
    expect(requestLabel('k9')).toBe('k9');
    setRadioRequestTypes(types());
    expect(radioRequestTypes()).toHaveLength(18);
    expect(requestLabel('k9')).toBe('a K9 unit');
    expect(requestLabel('nope')).toBe('nope');
  });
});

describe('radio menu: Request submenu', () => {
  it('keeps the Phase 2 two options with an empty list (root option 4 is Request)', () => {
    const m = new RadioMenu();
    m.open();
    expect(m.view(BASE).options[3]).toMatchObject({ key: 4, label: 'Request ▸', enabled: true });
    m.press(4, BASE);
    expect(m.view(BASE).title).toBe('Backup');
    expect(labels(m)).toEqual(['1 Code 2', '2 Code 3']);
    expect(m.press(2, BASE)).toEqual({ kind: 'backup', code: 3 });
  });

  it('pages the types 8 per page with More / First page on key 9 and a Request n/m title', () => {
    setRadioRequestTypes(types());
    const m = new RadioMenu();
    m.open();
    m.press(4, BASE);
    expect(m.level).toBe('backup');
    expect(m.view(BASE).title).toBe('Request 1/3');
    expect(labels(m)).toEqual([
      '1 Backup, routine', '2 Backup, code 3', '3 Officer needs assistance', '4 Supervisor', '5 K9', '6 EMS', '7 Fire', '8 Tow', '9 More ▸',
    ]);
    expect(m.press(9, BASE)).toBeNull();
    expect(m.isOpen).toBe(true);
    expect(m.page).toBe(1);
    expect(m.view(BASE).title).toBe('Request 2/3');
    expect(labels(m)).toEqual([
      '1 SWAT', '2 Negotiator', '3 Air unit', '4 Coroner', '5 Detectives', '6 Crime scene unit', '7 Animal control', '8 Bomb squad', '9 More ▸',
    ]);
    m.press(9, BASE);
    expect(m.view(BASE).title).toBe('Request 3/3');
    expect(labels(m)).toEqual(['1 State patrol', '2 Federal', '9 First page ▸']);
    // Key 9 wraps to the first page.
    m.press(9, BASE);
    expect(m.page).toBe(0);
    expect(m.view(BASE).title).toBe('Request 1/3');
  });

  it('returns the chosen type request (page 2 key 3 is the air unit) and closes', () => {
    setRadioRequestTypes(types());
    const m = new RadioMenu();
    m.open();
    m.press(4, BASE);
    m.press(9, BASE);
    expect(m.press(3, BASE)).toEqual({ kind: 'resource', typeId: 'air' });
    expect(m.isOpen).toBe(false);
    expect(m.page).toBe(0);
    m.open();
    m.press(4, BASE);
    expect(m.press(1, BASE)).toEqual({ kind: 'backup', code: 2 });
    m.open();
    m.press(4, BASE);
    expect(m.press(3, BASE)).toEqual({ kind: 'emergency' });
    m.open();
    m.press(4, BASE);
    expect(m.press(5, BASE)).toEqual({ kind: 'resource', typeId: 'k9' });
  });

  it('ignores keys beyond the last page entries and key 9 on a single page', () => {
    setRadioRequestTypes(types());
    const m = new RadioMenu();
    m.open();
    m.press(4, BASE);
    m.press(9, BASE);
    m.press(9, BASE);
    expect(m.press(5, BASE)).toBeNull();
    expect(m.isOpen).toBe(true);
    setRadioRequestTypes(types().slice(0, 5));
    expect(m.page).toBe(0);
    expect(labels(m)).toEqual(['1 Backup, routine', '2 Backup, code 3', '3 Officer needs assistance', '4 Supervisor', '5 K9']);
    expect(m.view(BASE).title).toBe('Request 1/1');
    expect(m.press(9, BASE)).toBeNull();
  });

  it('resets the page on open, back and close; back from page > 0 goes to the root', () => {
    setRadioRequestTypes(types());
    const m = new RadioMenu();
    m.open();
    m.press(4, BASE);
    m.press(9, BASE);
    expect(m.page).toBe(1);
    m.back();
    expect(m.level).toBe('root');
    expect(m.page).toBe(0);
    expect(m.isOpen).toBe(true);
    m.press(4, BASE);
    expect(m.page).toBe(0);
    m.press(9, BASE);
    m.close();
    expect(m.page).toBe(0);
    m.open();
    m.press(4, BASE);
    expect(m.view(BASE).title).toBe('Request 1/3');
  });

  it('caches the view per page (the same object while nothing changes)', () => {
    setRadioRequestTypes(types());
    const m = new RadioMenu();
    m.open();
    m.press(4, BASE);
    const a = m.view(BASE);
    expect(m.view(BASE)).toBe(a);
    m.press(9, BASE);
    const b = m.view(BASE);
    expect(b).not.toBe(a);
    expect(m.view(BASE)).toBe(b);
    m.press(9, BASE);
    m.press(9, BASE);
    expect(m.view(BASE)).toBe(a);
  });
});

describe('voice grammar: request types', () => {
  it('matches "request <alias>", "send <alias>" and "<alias> to my location"', () => {
    setRadioRequestTypes(types());
    const k9 = { kind: 'resource', typeId: 'k9' };
    expect(parseVoiceCommand('request a k9')).toEqual(k9);
    expect(parseVoiceCommand('Request K9!')).toEqual(k9);
    expect(parseVoiceCommand('send the canine')).toEqual(k9);
    expect(parseVoiceCommand('send dog unit')).toEqual(k9);
    expect(parseVoiceCommand('canine to my location')).toEqual(k9);
    expect(parseVoiceCommand('request an ambulance')).toEqual({ kind: 'resource', typeId: 'ems' });
    expect(parseVoiceCommand('request the crime scene unit')).toEqual({ kind: 'resource', typeId: 'csu' });
    expect(parseVoiceCommand('dispatch send some medics')).toEqual({ kind: 'resource', typeId: 'ems' });
    expect(parseVoiceCommand('need help now to my location')).toEqual({ kind: 'emergency' });
  });

  it('does not match a bare alias or an unknown one', () => {
    setRadioRequestTypes(types());
    expect(parseVoiceCommand('k9')).toBeNull();
    expect(parseVoiceCommand('request a unicorn')).toBeNull();
  });

  it('the longest alias wins', () => {
    setRadioRequestTypes([resource('a', 'A', ['air']), resource('b', 'B', ['air unit'])]);
    expect(parseVoiceCommand('send air unit')).toEqual({ kind: 'resource', typeId: 'b' });
    expect(parseVoiceCommand('send air')).toEqual({ kind: 'resource', typeId: 'a' });
  });

  it('keeps the Phase 2 commands ("backup" alone stays code 2) and prefers a longer request alias', () => {
    setRadioRequestTypes(types());
    expect(parseVoiceCommand('backup')).toEqual({ kind: 'backup', code: 2 });
    expect(parseVoiceCommand('send backup')).toEqual({ kind: 'backup', code: 2 });
    expect(parseVoiceCommand('requesting backup code 3')).toEqual({ kind: 'backup', code: 3 });
    expect(parseVoiceCommand('request priority backup')).toEqual({ kind: 'backup', code: 3 });
    expect(parseVoiceCommand('run plate ABC 1234')).toEqual({ kind: 'runPlate', plate: 'ABC 1234', vehicleId: -1 });
    expect(parseVoiceCommand('code 4')).toEqual({ kind: 'code4' });
  });

  it('is the Phase 2 grammar with an empty list', () => {
    expect(parseVoiceCommand('request a k9')).toBeNull();
    expect(parseVoiceCommand('request backup')).toEqual({ kind: 'backup', code: 2 });
  });

  it('rebuilds its table when the list changes', () => {
    setRadioRequestTypes(types());
    expect(parseVoiceCommand('request a k9')).toEqual({ kind: 'resource', typeId: 'k9' });
    setRadioRequestTypes([resource('k9', 'a K9 unit', ['unit dog'])]);
    expect(parseVoiceCommand('request a k9')).toBeNull();
    expect(parseVoiceCommand('request unit dog')).toEqual({ kind: 'resource', typeId: 'k9' });
  });
});

describe('composer: resource request line', () => {
  function line(mode: RadioMode): { rig: Rig; text: string } {
    setRadioRequestTypes(types());
    const rig = makeRig({ mode });
    rig.radio.playerRequest({ kind: 'resource', typeId: 'k9' }, 'radio');
    for (let i = 0; i < 80 && requests(rig).length === 0; i++) rig.run(0.25);
    const tx = starts(rig)[0];
    if (!tx) throw new Error('no transmission');
    return { rig, text: tx.text };
  }

  it('says "{unit}, requesting {label} to {near}." in plain and ten-code mode alike', () => {
    const plain = line('plain');
    const ten = line('tenCode');
    expect(plain.text).toMatch(new RegExp(`^${PLAYER}, requesting a K9 unit to .+\\.$`));
    expect(ten.text).toBe(plain.text);
    expect(starts(plain.rig)[0]?.speaker).toBe(PLAYER);
    expect(requests(plain.rig)).toEqual([{ callsign: PLAYER, request: { kind: 'resource', typeId: 'k9' }, via: 'radio' }]);
  });

  it('falls back to the type id when the list does not know it', () => {
    const rig = makeRig({ mode: 'plain' });
    rig.radio.playerRequest({ kind: 'resource', typeId: 'bombSquad' }, 'radio');
    for (let i = 0; i < 40 && starts(rig).length === 0; i++) rig.run(0.25);
    expect(starts(rig)[0]?.text).toMatch(/^12, requesting bombSquad to /);
  });
});
