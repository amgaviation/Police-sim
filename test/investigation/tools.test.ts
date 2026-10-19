import { describe, expect, it } from 'vitest';
import { TOOL_ROW } from '../../src/investigation/types';
import { makeHarness, nightstands, placeSpec, stand, standAt } from './harness';

describe('tools panel', () => {
  it('lists the rows in the documented order with reasons for disabled ones', () => {
    const h = makeHarness();
    stand(h, 0, 0, -1, 0, -1);
    h.step();
    const m = h.sys.toolsModel();
    expect(m.title).toBe('Investigation');
    expect(m.options).toHaveLength(Object.keys(TOOL_ROW).length);
    const o = m.options;
    expect(o[TOOL_ROW.marker]).toMatchObject({ label: 'Place marker', detail: 'x20' });
    expect(o[TOOL_ROW.photo]?.label).toBe('Photograph (camera mode)');
    expect(o[TOOL_ROW.collect]).toMatchObject({ enabled: false, detail: 'Nothing found to collect nearby' });
    expect(o[TOOL_ROW.bag]?.enabled).toBe(false);
    expect(o[TOOL_ROW.tag]?.enabled).toBe(false);
    expect(o[TOOL_ROW.search]).toMatchObject({ enabled: false, detail: 'No container within reach' });
    expect(o[TOOL_ROW.dust]?.enabled).toBe(false);
    expect(o[TOOL_ROW.tapePost]?.enabled).not.toBe(false);
    expect(o[TOOL_ROW.canvass]?.enabled).toBe(false);
    expect(o[TOOL_ROW.k9]?.enabled).not.toBe(false);
    expect(o[TOOL_ROW.bodycam]?.label).toBe('Bodycam on');
    expect(o[TOOL_ROW.caseFile]).toMatchObject({ enabled: false, detail: 'No case file yet' });
  });

  it('says why a tool is unavailable when the kit is missing', () => {
    const h = makeHarness();
    h.world.kit = {};
    h.world.worn = false;
    h.world.call = 0;
    stand(h, 0, 0, -1, 0, -1);
    const o = h.sys.toolsModel().options;
    expect(o[TOOL_ROW.marker]).toMatchObject({ enabled: false, detail: 'No evidence markers' });
    expect(o[TOOL_ROW.photo]).toMatchObject({ enabled: false, detail: 'No camera' });
    expect(o[TOOL_ROW.tapePost]).toMatchObject({ enabled: false, detail: 'No scene tape' });
    expect(o[TOOL_ROW.k9]).toMatchObject({ enabled: false, detail: 'No active call' });
    expect(o[TOOL_ROW.bodycam]).toMatchObject({ enabled: false, detail: 'No bodycam mounted' });
  });

  it('offers collect, bag and tag for what is in front of the officer and what they hold', () => {
    const h = makeHarness();
    const id = h.sys.placeItem(placeSpec(h, { x: 100.5, z: -200 }));
    const item = h.sys.store.item(id);
    if (!item) throw new Error('missing item');
    item.state = 'found';
    stand(h, 100, -200, 0, 0);
    h.step();
    expect(h.sys.toolsModel().options[TOOL_ROW.collect]?.label).toBe('Collect Knife');
    expect(h.sys.toolsSelect(TOOL_ROW.collect)).toEqual({ kind: 'request', request: { kind: 'collect', itemId: id } });
    h.sys.request({ kind: 'collect', itemId: id });
    h.step();
    const o = h.sys.toolsModel().options;
    expect(o[TOOL_ROW.bag]?.label).toBe('Bag Knife');
    expect(h.sys.toolsSelect(TOOL_ROW.bag)).toEqual({ kind: 'request', request: { kind: 'bag', itemId: id } });
    h.sys.request({ kind: 'bag', itemId: id });
    h.step();
    expect(h.sys.toolsModel().options[TOOL_ROW.tag]?.label).toBe('Tag Knife');
    expect(h.sys.toolsSelect(TOOL_ROW.tag)).toEqual({ kind: 'request', request: { kind: 'tag', itemId: id } });
  });

  it('offers "Search <container> (consent)" with authority and "Search anyway" without', () => {
    const h = makeHarness();
    const f = nightstands(h.layout)[0];
    if (!f) throw new Error('no nightstand');
    standAt(h, f);
    h.step();
    let o = h.sys.toolsModel().options;
    expect(o[TOOL_ROW.search]?.label).toBe('Search anyway (no lawful basis)');
    expect(h.sys.toolsSelect(TOOL_ROW.search)).toEqual({
      kind: 'request',
      request: { kind: 'search', buildingId: h.layout.buildingId, furniture: f.index, force: true },
    });
    h.sys.recordConsent({
      callId: 42, personId: 7, kind: 'searchRoom', granted: true, valid: true, authority: true,
      buildingId: h.layout.buildingId, room: f.room, vehicleId: -1, sim: 0, revokedSim: -1,
    });
    o = h.sys.toolsModel().options;
    expect(o[TOOL_ROW.search]?.label).toBe('Search nightstand (consent)');
    expect(h.sys.toolsSelect(TOOL_ROW.search)).toEqual({
      kind: 'request',
      request: { kind: 'search', buildingId: h.layout.buildingId, furniture: f.index, force: false },
    });
  });

  it('offers dusting a printable surface within reach', () => {
    const h = makeHarness();
    const f = h.layout.furniture.find((x) => x.surface === 'glass');
    if (!f) throw new Error('no glass surface');
    standAt(h, f);
    h.step();
    expect(h.sys.toolsModel().options[TOOL_ROW.dust]).toMatchObject({ label: 'Dust coffee table', detail: 'glass' });
    expect(h.sys.toolsSelect(TOOL_ROW.dust)).toEqual({
      kind: 'request',
      request: { kind: 'dustStart', buildingId: h.layout.buildingId, furniture: f.index },
    });
  });

  it('maps the non-request rows and returns none for disabled rows', () => {
    const h = makeHarness();
    stand(h, 0, 0, -1, 0, -1);
    h.sys.request({ kind: 'marker' });
    h.step();
    expect(h.sys.toolsSelect(TOOL_ROW.photo)).toEqual({ kind: 'camera' });
    expect(h.sys.toolsSelect(TOOL_ROW.k9)).toEqual({ kind: 'k9' });
    expect(h.sys.toolsSelect(TOOL_ROW.caseFile)).toEqual({ kind: 'caseFile' });
    expect(h.sys.toolsSelect(TOOL_ROW.bodycam)).toEqual({ kind: 'request', request: { kind: 'bodycam', on: true } });
    expect(h.sys.toolsSelect(TOOL_ROW.collect)).toEqual({ kind: 'none' });
    expect(h.sys.toolsSelect(99)).toEqual({ kind: 'none' });
    expect(h.sys.toolsSelect(TOOL_ROW.tapePost)).toEqual({ kind: 'request', request: { kind: 'tapePost' } });
    expect(h.sys.toolsSelect(TOOL_ROW.tapeClose)).toEqual({ kind: 'none' });
  });

  it('tape is outdoors only', () => {
    const h = makeHarness();
    stand(h, 100, -200, 0, 0);
    expect(h.sys.toolsModel().options[TOOL_ROW.tapePost]).toMatchObject({ enabled: false, detail: 'Outdoors only' });
  });

  it('knock (canvass) needs the door port and a call', () => {
    const h = makeHarness();
    stand(h, 0, 0, -1, 0, -1);
    expect(h.sys.toolsModel().options[TOOL_ROW.canvass]?.enabled).toBe(false);
  });
});
