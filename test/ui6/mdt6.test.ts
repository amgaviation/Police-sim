import { describe, expect, it } from 'vitest';
import type { CommandRequest } from '../../src/command/types';
import type { ResourceUnitView } from '../../src/resources/types';
import {
  EtaBoardState,
  MDT_TAB_LABELS,
  MDT_TABS,
  MdtOverlay,
  callDetailLines,
  commandTabModel,
  etaBoardRows,
  formatEta,
  requestTargetText,
  resourceTypeRows,
  resourceUnitRows,
  tabKeyLabel,
  unitRows,
  type MdtCommandDeps,
  type MdtEtaRow,
  type MdtResourcesDeps,
} from '../../src/ui/mdt';
import { addCall, at, fixture, key, type Fixture } from '../mdt/helpers';
import { board } from './fixtures';

const TYPES = [
  { id: 'routine', label: 'Routine backup', resolves: 'One patrol unit responds.', send: 'backup2' },
  { id: 'ems', label: 'Medics', resolves: 'EMS responds.', send: 'resource' },
  { id: 'k9', label: 'K9 unit', resolves: 'Searches.', send: 'resource' },
];

function unit(over: Partial<ResourceUnitView> = {}): ResourceUnitView {
  return { callsign: 'MEDIC-1', typeId: 'ems', label: 'Medics', status: 'available', callId: 0, etaS: -1, x: 0, z: 0, ...over };
}

interface Feed {
  rev: number;
  units: ResourceUnitView[];
  requests: string[];
  deferred: { resolve(rows: readonly MdtEtaRow[]): void; reject(e: unknown): void; callId: number }[];
}

function resourcesDeps(feed: Feed, withBoard = true): MdtResourcesDeps {
  return {
    revision: () => feed.rev,
    units: () => feed.units,
    types: () => TYPES,
    request: (id) => feed.requests.push(id),
    ...(withBoard
      ? {
          etaBoard: (callId: number) =>
            new Promise<readonly MdtEtaRow[]>((resolve, reject) => {
              feed.deferred.push({ resolve, reject, callId });
            }),
        }
      : {}),
  };
}

function setup(withBoard = true): { f: Fixture; feed: Feed; mdt: MdtOverlay } {
  const f = fixture();
  const feed: Feed = { rev: 1, units: [unit(), unit({ callsign: 'K9-1', typeId: 'k9', label: 'K9 unit', status: 'enRoute', callId: 1, etaS: 95 })], requests: [], deferred: [] };
  f.deps = { ...f.deps, resources: resourcesDeps(feed, withBoard), eta: (cs) => (cs === '21' ? 130 : -1) };
  return { f, feed, mdt: new MdtOverlay(null, f.deps) };
}

describe('tabs', () => {
  it('appends Resources and Command, reachable with the arrows only', () => {
    expect(MDT_TABS.slice(-2)).toEqual(['resources', 'command']);
    expect(MDT_TAB_LABELS.resources).toBe('Resources');
    expect(MDT_TAB_LABELS.command).toBe('Command');
    expect(tabKeyLabel('resources')).toBe('');
    expect(tabKeyLabel('command')).toBe('');
    expect(tabKeyLabel('career')).toBe('0');
  });
});

describe('Units and Call ETA', () => {
  it('adds an ETA column and lists resource units after the patrol units', () => {
    const f = fixture();
    f.cad.addUnit({ callsign: 'MEDIC-1', kind: 'resource', officer: 'Medic', beat: 'station', fleetIndex: 8 }, at(0));
    f.cad.addUnit({ callsign: '25', kind: 'ai', officer: 'Officer Lee', beat: 'downtown', fleetIndex: 2 }, at(0));
    const rows = unitRows(f.cad, f.graph, 0, (cs) => (cs === '25' ? 61 : cs === 'MEDIC-1' ? 0 : -1));
    expect(rows.map((r) => r.callsign)).toEqual(['12', '21', '23', '25', 'MEDIC-1']);
    expect(rows.map((r) => r.kind)).toEqual(['player', 'ai', 'ai', 'ai', 'resource']);
    expect(rows.find((r) => r.callsign === '25')?.eta).toBe('1:01');
    expect(rows.find((r) => r.callsign === 'MEDIC-1')?.eta).toBe('0:00');
    expect(rows.find((r) => r.callsign === '21')?.eta).toBe('');
    expect(unitRows(f.cad, f.graph)[0]?.eta).toBe('');
  });

  it('formats an ETA as m:ss and leaves unknown ones blank', () => {
    expect(formatEta(190)).toBe('3:10');
    expect(formatEta(0)).toBe('0:00');
    expect(formatEta(-1)).toBe('');
    expect(formatEta(Number.NaN)).toBe('');
  });

  it('shows the ETA of assigned units on the call', () => {
    const f = fixture();
    const call = addCall(f.cad, 0, 2);
    f.cad.assign(call.id, '21', at(0), 'dispatch');
    f.cad.assign(call.id, '23', at(0), 'dispatch');
    const units = callDetailLines(f.cad.call(call.id)!, (cs) => (cs === '23' ? 190 : -1)).find((l) => l.label === 'Units');
    expect(units?.text).toContain('23 (ETA 3:10)');
    expect(units?.text).not.toContain('21 (ETA');
    expect(callDetailLines(f.cad.call(call.id)!).find((l) => l.label === 'Units')?.text).not.toContain('ETA');
  });
});

describe('Resources tab models', () => {
  it('numbers the requestable types and tells patrol from unit requests', () => {
    expect(resourceTypeRows(TYPES)).toEqual([
      { id: 'routine', n: '1', label: 'Routine backup', resolves: 'One patrol unit responds.', via: 'patrol' },
      { id: 'ems', n: '2', label: 'Medics', resolves: 'EMS responds.', via: 'unit' },
      { id: 'k9', n: '3', label: 'K9 unit', resolves: 'Searches.', via: 'unit' },
    ]);
  });

  it('lists busy units first with call numbers and ETAs', () => {
    const rows = resourceUnitRows(
      [unit(), unit({ callsign: 'K9-1', label: 'K9 unit', status: 'enRoute', callId: 7, etaS: 95 })],
      (id) => (id === 7 ? 'C-00007' : null),
    );
    expect(rows.map((r) => r.callsign)).toEqual(['K9-1', 'MEDIC-1']);
    expect(rows[0]).toMatchObject({ statusLabel: 'EN ROUTE', call: 'C-00007', eta: '1:35' });
    expect(rows[1]).toMatchObject({ statusLabel: 'AVAILABLE', call: '-', eta: '' });
    expect(resourceUnitRows([unit({ callId: 9 })], () => null)[0]?.call).toBe('-');
  });

  it('says where requests go', () => {
    expect(requestTargetText({ number: 'C-00042' })).toBe('Requests go to C-00042');
    expect(requestTargetText(null)).toBe('Requests go to a new officer-assist call');
  });

  it('sorts the ETA board by time, unknown last', () => {
    const rows = etaBoardRows([
      { callsign: 'B', label: 'b', etaS: 300 },
      { callsign: 'U', label: 'u', etaS: -1 },
      { callsign: 'A', label: 'a', etaS: 60 },
    ]);
    expect(rows.map((r) => `${r.callsign} ${r.eta}`)).toEqual(['A 1:00', 'B 5:00', 'U -']);
  });
});

describe('EtaBoardState', () => {
  const rows: MdtEtaRow[] = [{ callsign: 'MEDIC-1', label: 'Medics', etaS: 200 }];

  it('shows a result that answers the latest request', async () => {
    const s = new EtaBoardState();
    s.request(5, () => Promise.resolve(rows));
    expect(s.status).toBe('loading');
    await Promise.resolve();
    expect(s.status).toBe('ready');
    expect(s.callId).toBe(5);
    expect(s.rows[0]?.eta).toBe('3:20');
  });

  it('discards a result when the selected call changed while it was in flight', async () => {
    const s = new EtaBoardState();
    let resolve!: (r: readonly MdtEtaRow[]) => void;
    s.request(5, () => new Promise((r) => (resolve = r)));
    s.select(6);
    expect(s.status).toBe('idle');
    resolve(rows);
    await Promise.resolve();
    expect(s.status).toBe('idle');
    expect(s.rows).toEqual([]);
  });

  it('discards an older result when a newer request was made', async () => {
    const s = new EtaBoardState();
    const resolvers: ((r: readonly MdtEtaRow[]) => void)[] = [];
    s.request(5, () => new Promise((r) => resolvers.push(r)));
    s.request(5, () => new Promise((r) => resolvers.push(r)));
    resolvers[0]?.([{ callsign: 'OLD', label: 'old', etaS: 1 }]);
    await Promise.resolve();
    expect(s.status).toBe('loading');
    resolvers[1]?.(rows);
    await Promise.resolve();
    expect(s.rows[0]?.callsign).toBe('MEDIC-1');
  });

  it('does not bump its revision when an idle board is told the selection', () => {
    const s = new EtaBoardState();
    const rev = s.revision;
    s.select(4);
    s.select(5);
    expect(s.revision).toBe(rev);
  });

  it('keeps the board when the same call is selected again, and handles an empty or failed worker', async () => {
    const s = new EtaBoardState();
    s.request(5, () => Promise.resolve(rows));
    await Promise.resolve();
    s.select(5);
    expect(s.status).toBe('ready');
    s.request(5, () => Promise.resolve([]));
    await Promise.resolve();
    expect(s.status).toBe('unavailable');
    s.request(5, () => Promise.reject(new Error('no worker')));
    await Promise.resolve();
    await Promise.resolve();
    expect(s.status).toBe('unavailable');
    s.request(5, () => {
      throw new Error('sync');
    });
    expect(s.status).toBe('unavailable');
  });
});

describe('Resources tab (headless overlay)', () => {
  it('builds the type and unit lists from the feed', () => {
    const { mdt } = setup();
    mdt.open('resources');
    mdt.update(1000);
    expect(mdt.resourceTypeRows.map((r) => r.id)).toEqual(['routine', 'ems', 'k9']);
    expect(mdt.resourceUnitRows.map((r) => r.callsign)).toEqual(['K9-1', 'MEDIC-1']);
  });

  it('rebuilds only when the feed revision changes', () => {
    const { mdt, feed } = setup();
    mdt.open('resources');
    mdt.update(1000);
    const first = mdt.resourceUnitRows;
    feed.units = [unit({ callsign: 'ENGINE-1', typeId: 'fire', label: 'Fire engine' })];
    mdt.update(2000);
    expect(mdt.resourceUnitRows).toBe(first);
    feed.rev++;
    mdt.update(3000);
    expect(mdt.resourceUnitRows.map((r) => r.callsign)).toEqual(['ENGINE-1']);
  });

  it('requests a type through the feed', () => {
    const { mdt, feed } = setup();
    mdt.open('resources');
    mdt.update(1000);
    expect(mdt.requestResource('ems')).toBe(true);
    expect(feed.requests).toEqual(['ems']);
    expect(mdt.message).toBe('Requested: Medics');
    expect(mdt.requestResource('nope')).toBe(false);
    expect(feed.requests).toEqual(['ems']);
  });

  it('fetches the ETA board for the selected call and discards it when the selection changes', async () => {
    const { f, feed, mdt } = setup();
    const a = addCall(f.cad, 0, 3);
    const b = addCall(f.cad, 1, 3);
    mdt.open('resources');
    mdt.selectCall(a.id);
    mdt.update(1000);
    expect(mdt.fetchEtaBoard()).toBe(true);
    expect(feed.deferred.map((d) => d.callId)).toEqual([a.id]);
    mdt.selectCall(b.id);
    mdt.update(2000);
    feed.deferred[0]?.resolve([{ callsign: 'MEDIC-1', label: 'Medics', etaS: 100 }]);
    await Promise.resolve();
    mdt.update(3000);
    expect(mdt.etaBoard.status).toBe('idle');
    expect(mdt.etaBoard.rows).toEqual([]);
    expect(mdt.fetchEtaBoard()).toBe(true);
    feed.deferred[1]?.resolve([{ callsign: 'MEDIC-1', label: 'Medics', etaS: 100 }]);
    await Promise.resolve();
    mdt.update(4000);
    expect(mdt.etaBoard.status).toBe('ready');
    expect(mdt.etaBoard.callId).toBe(b.id);
  });

  it('settles: repeated updates with nothing changed do not refresh again', () => {
    const { f, mdt } = setup();
    const call = addCall(f.cad, 0, 3);
    mdt.open('resources');
    mdt.selectCall(call.id);
    mdt.update(1000);
    mdt.update(2000);
    const n = mdt.refreshes;
    mdt.update(3000);
    mdt.update(4000);
    expect(mdt.refreshes).toBe(n);
  });

  it('has no ETA board without the worker feed or a call', () => {
    const { mdt } = setup(false);
    mdt.open('resources');
    mdt.update(1000);
    expect(mdt.fetchEtaBoard()).toBe(false);
    const w = setup(true);
    w.mdt.open('resources');
    w.mdt.update(1000);
    expect(w.mdt.fetchEtaBoard()).toBe(false); // no call selected, none for the player
  });

  it('works without a resources feed', () => {
    const f = fixture();
    const mdt = new MdtOverlay(null, f.deps);
    mdt.open('resources');
    mdt.update(1000);
    expect(mdt.resourceTypeRows).toEqual([]);
    expect(mdt.requestResource('ems')).toBe(false);
    expect(mdt.fetchEtaBoard()).toBe(false);
  });

  it('moves between the Phase 6 tabs with the arrows', () => {
    const { mdt } = setup();
    mdt.open('community');
    expect(mdt.onKeyDown(key('ArrowRight'))).toBe(true);
    expect(mdt.tab).toBe('resources');
    expect(mdt.onKeyDown(key('ArrowRight'))).toBe(true);
    expect(mdt.tab).toBe('command');
  });
});

describe('Command tab', () => {
  function commandSetup(): { mdt: MdtOverlay; requests: CommandRequest[]; state: { rev: number; board: ReturnType<typeof board> } } {
    const f = fixture();
    const requests: CommandRequest[] = [];
    const state = { rev: 1, board: board() };
    const command: MdtCommandDeps = { revision: () => state.rev, board: () => state.board, request: (r) => requests.push(r) };
    f.deps = { ...f.deps, command };
    return { mdt: new MdtOverlay(null, f.deps), requests, state };
  }

  it('builds chips with the tag colours, the victim list and the staffing lines', () => {
    const m = commandTabModel(
      board({
        victims: [
          { personId: 1, actorId: 1, label: 'Patient 1', tag: 'immediate', by: 'player', correct: true, trapped: true, contaminated: false, transported: false },
          { personId: 2, actorId: 2, label: 'Patient 2', tag: 'minor', by: 'ems', correct: false, trapped: false, contaminated: true, transported: true },
          { personId: 3, actorId: 3, label: 'Patient 3', tag: null, by: null, correct: null, trapped: false, contaminated: false, transported: false },
        ],
        tcps: { staffed: 2, total: 4 },
        inner: { staffed: 3, total: 4 },
        evac: { progress: 0.6, radiusM: 150 },
        swat: 'stacked',
        negotiation: { trust: 0.55, agitation: 0.3, outcome: 'ongoing', stage: 'rapport' },
      }),
    );
    expect(m.post).toBe('DISASTER · commander 12');
    expect(m.chips.map((c) => `${c.label} ${c.count}`)).toEqual(['RED 3', 'YELLOW 4', 'GREEN 2', 'BLACK 1', 'UNTAGGED 2']);
    expect(m.chips[0]?.color).toBe('#c8322b');
    expect(m.chips[2]?.color).toBe('#3a9d4a');
    expect(m.victims.map((v) => `${v.tag}|${v.by}|${v.mark}|${v.flags}`)).toEqual(['RED|you|✓|trapped', 'GREEN|EMS|✗|contaminated, transported', '-|||']);
    expect(m.staffing).toEqual(['Traffic control 2/4 staffed', 'Inner perimeter 3/4 staffed']);
    expect(m.evac).toEqual({ label: 'Evacuation', pct: 60, text: '60 % · 150 m' });
    expect(m.swat).toBe('stacked');
    expect(m.trust?.pct).toBe(55);
    expect(m.agitation?.pct).toBe(30);
    expect(m.negotiation).toBe('ongoing · rapport stage');
    expect(m.needs).toBe('EMS 2, fire 1');
  });

  it('shows no post and nothing else without a command post', () => {
    const m = commandTabModel(board({ post: null }));
    expect(m.hasPost).toBe(false);
    expect(m.post).toBe('No command post');
  });

  it('rebuilds on a revision change only and forwards the buttons', () => {
    const { mdt, requests, state } = commandSetup();
    mdt.open('command');
    mdt.update(1000);
    const first = mdt.commandModel;
    expect(first?.hasPost).toBe(true);
    state.board = board({ post: null });
    mdt.update(2000);
    expect(mdt.commandModel).toBe(first);
    state.rev++;
    mdt.update(3000);
    expect(mdt.commandModel?.hasPost).toBe(false);
    expect(mdt.establishCommand()).toBe(true);
    expect(mdt.requestCommandNeeds()).toBe(true);
    expect(requests).toEqual([{ kind: 'establish' }, { kind: 'requestNeeds' }]);
  });

  it('works without a command feed', () => {
    const f = fixture();
    const mdt = new MdtOverlay(null, f.deps);
    mdt.open('command');
    mdt.update(1000);
    expect(mdt.commandModel).toBeNull();
    expect(mdt.establishCommand()).toBe(false);
    expect(mdt.requestCommandNeeds()).toBe(false);
  });
});
