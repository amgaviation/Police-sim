import { afterEach, describe, expect, it } from 'vitest';
import { EtaBoardState, commandTabModel, renderCommandTab, renderEtaBoard } from '../../src/ui/mdt';
import { FlirOverlay, flirAltText, flirHeadingText, flirModeText } from '../../src/ui/air';
import { FakeNode, installFakeDocument } from '../courtui/fakeDom';
import { board } from './fixtures';

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

const node = (): FakeNode => new FakeNode('DIV');
const asEl = (n: FakeNode): HTMLElement => n as unknown as HTMLElement;

describe('renderCommandTab (fake DOM)', () => {
  it('shows only the post section and an Establish button without a command post', () => {
    restore = installFakeDocument();
    const c = node();
    const calls: string[] = [];
    renderCommandTab(asEl(c), commandTabModel(board({ post: null })), { establish: () => calls.push('establish'), requestNeeds: () => calls.push('needs') });
    expect(c.tag('section')).toHaveLength(1);
    const buttons = c.tag('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Establish command']);
    buttons[0]?.fire('click');
    expect(calls).toEqual(['establish']);
  });

  it('renders colour chips, the victim table, the bars and a REQUEST button', () => {
    restore = installFakeDocument();
    const c = node();
    const calls: string[] = [];
    const model = commandTabModel(
      board({
        victims: [{ personId: 1, actorId: 1, label: 'Patient 1', tag: 'immediate', by: 'player', correct: true, trapped: false, contaminated: false, transported: false }],
        evac: { progress: 0.5, radiusM: 100 },
        negotiation: { trust: 0.4, agitation: 0.6, outcome: 'ongoing', stage: 'contact' },
        units: [{ callsign: 'MEDIC-1', label: 'Medic', status: 'enRoute', etaS: 70 }],
      }),
    );
    renderCommandTab(asEl(c), model, { establish: () => calls.push('establish'), requestNeeds: () => calls.push('needs') });
    const chips = c.all('mdt-chip');
    expect(chips.map((x) => x.textContent)).toEqual(['RED 3', 'YELLOW 4', 'GREEN 2', 'BLACK 1', 'UNTAGGED 2']);
    expect(chips[0]?.style['background']).toBe('#c8322b');
    expect(c.textContent).toContain('Patient 1');
    expect(c.all('mdt-bar-fill').map((f) => f.style['width'])).toEqual(['50%', '40%', '60%']);
    expect(c.textContent).toContain('MEDIC-1');
    expect(c.textContent).toContain('1:10');
    const request = c.tag('button').find((b) => b.textContent === 'REQUEST');
    request?.fire('click');
    expect(calls).toEqual(['needs']);
    expect(c.tag('button')[0]?.textContent).toBe('Command post open');
  });

  it('disables REQUEST when nothing is recommended and replaces the previous content on a re-render', () => {
    restore = installFakeDocument();
    const c = node();
    const h = { establish: () => undefined, requestNeeds: () => undefined };
    renderCommandTab(asEl(c), commandTabModel(board({ needs: { ems: 0, fire: 0, supervisor: 0 } })), h);
    const first = c.tag('section').length;
    expect(c.tag('button').find((b) => b.textContent === 'REQUEST')).toBeDefined();
    renderCommandTab(asEl(c), commandTabModel(board({ needs: { ems: 0, fire: 0, supervisor: 0 } })), h);
    expect(c.tag('section')).toHaveLength(first);
  });
});

describe('renderEtaBoard (fake DOM)', () => {
  it('shows the message while idle and the table once ready', async () => {
    restore = installFakeDocument();
    const c = node();
    const s = new EtaBoardState();
    renderEtaBoard(asEl(c), s);
    expect(c.textContent).toContain('ETA BOARD');
    expect(c.tag('table')).toHaveLength(0);
    s.request(3, () => Promise.resolve([{ callsign: 'MEDIC-1', label: 'Medics', etaS: 125 }]));
    await Promise.resolve();
    renderEtaBoard(asEl(c), s);
    expect(c.tag('table')).toHaveLength(1);
    expect(c.tag('td').map((t) => t.textContent)).toEqual(['MEDIC-1', 'Medics', '2:05']);
  });
});

describe('FlirOverlay', () => {
  it('is a no-op without a document but keeps its state', () => {
    const o = new FlirOverlay(null, null);
    expect(o.on).toBe(false);
    o.update({ sx: 10, sy: 10, visible: true }, 150, 0);
    expect(o.writes).toBe(0);
    o.show(true);
    expect(o.on).toBe(true);
    o.update({ sx: 10.4, sy: 20, visible: true }, 149.6, 0);
    expect(o.readouts).toEqual({ alt: 'ALT 150 m', heading: 'HDG 000° N' });
    expect(o.targetShown).toBe(true);
    o.setBlackHot(true);
    expect(o.blackHot).toBe(true);
    o.show(false);
    expect(o.on).toBe(false);
    expect(o.targetShown).toBe(false);
    o.update({ sx: 1, sy: 1, visible: true }, 10, 0);
    expect(o.readouts.alt).toBe('');
    o.dispose();
  });

  it('formats the readouts', () => {
    expect(flirAltText(150.4)).toBe('ALT 150 m');
    expect(flirAltText(-5)).toBe('ALT 0 m');
    expect(flirAltText(Number.NaN)).toBe('ALT 0 m');
    expect(flirHeadingText(0)).toBe('HDG 000° N');
    expect(flirHeadingText(Math.PI / 2)).toBe('HDG 270° W');
    expect(flirHeadingText(-Math.PI / 4)).toBe('HDG 045° NE');
    expect(flirModeText(false)).toBe('IR WHT');
    expect(flirModeText(true)).toBe('IR BHOT');
  });

  it('toggles the canvas classes and writes the overlay only when a rounded value changed', () => {
    restore = installFakeDocument();
    const classes = new Set<string>();
    const canvas = { classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) } } as unknown as HTMLElement;
    const parent = node();
    const o = new FlirOverlay(canvas, asEl(parent));
    const root = parent.all('air-flir')[0];
    expect(root?.hidden).toBe(true);
    o.show(true);
    expect([...classes]).toEqual(['flir-on']);
    expect(root?.hidden).toBe(false);
    expect(parent.all('air-mode')[0]?.textContent).toBe('IR WHT');
    o.setBlackHot(true);
    expect([...classes].sort()).toEqual(['flir-black-hot', 'flir-on']);
    expect(parent.all('air-mode')[0]?.textContent).toBe('IR BHOT');
    o.update({ sx: 300.2, sy: 200.4, visible: true }, 150, Math.PI / 2);
    const target = parent.all('air-target')[0];
    expect(target?.hidden).toBe(false);
    expect(target?.style['left']).toBe('300px');
    expect(target?.style['top']).toBe('200px');
    expect(parent.all('air-alt')[0]?.textContent).toBe('ALT 150 m');
    expect(parent.all('air-compass')[0]?.textContent).toBe('HDG 270° W');
    const writes = o.writes;
    o.update({ sx: 300.4, sy: 200.1, visible: true }, 150.2, Math.PI / 2);
    expect(o.writes).toBe(writes);
    o.update({ sx: 301, sy: 200, visible: true }, 150, Math.PI / 2);
    expect(o.writes).toBe(writes + 1);
    o.update({ sx: 0, sy: 0, visible: false }, 150, Math.PI / 2);
    expect(target?.hidden).toBe(true);
    o.update(null, 150, Math.PI / 2);
    expect(o.targetShown).toBe(false);
    o.show(false);
    expect(classes.size).toBe(0);
    expect(root?.hidden).toBe(true);
    o.dispose();
    expect(parent.all('air-flir')).toHaveLength(0);
  });
});
