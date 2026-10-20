import { describe, expect, it } from 'vitest';
import { verifyLedger } from '../../src/evidence';
import { TOOL_ROW } from '../../src/investigation/types';
import { PROP } from '../../src/render/people/pose';
import { BADGE, makeHarness, placeSpec, stand, type Harness } from './harness';

/** A found knife lying at (100, -200) with the officer standing next to it. */
function withFoundItem(h: Harness = makeHarness()): { h: Harness; id: string } {
  const id = h.sys.placeItem(placeSpec(h, { x: 100.5, z: -200, y: 0.05 }));
  const item = h.sys.store.item(id);
  if (!item) throw new Error('missing item');
  item.state = 'found';
  item.foundBasis = 'plainView';
  item.plainView = true;
  stand(h, 100, -200, 0);
  h.step();
  return { h, id };
}

function actions(h: Harness, id: string): string[] {
  return h.sys.ledger.itemEntries(id).map((e) => e.action);
}

describe('chain of custody', () => {
  it('collect, bag, tag, deposit verifies in the ledger and completes the item', () => {
    const { h, id } = withFoundItem();
    h.sys.request({ kind: 'collect', itemId: id });
    h.step();
    h.sys.request({ kind: 'bag', itemId: id });
    h.step();
    h.sys.request({ kind: 'tag', itemId: id });
    h.step();
    expect(h.sys.ledger.state(id)).toBe('tagged');
    h.sys.request({ kind: 'deposit' });
    h.step();
    expect(actions(h, id)).toEqual(['collect', 'bag', 'tag', 'deposit']);
    expect(h.sys.ledger.complete(id)).toBe(true);
    expect(verifyLedger(h.sys.ledger.entries()).ok).toBe(true);
    expect(h.sys.ledger.custodian(id)).toBe('evidenceRoom');
    expect(h.of('investigation:custody').map((e) => e.payload['action'])).toEqual(['collect', 'bag', 'tag', 'deposit']);
    expect(h.of('investigation:collected')).toHaveLength(1);
    expect(h.of('investigation:custodyComplete')).toHaveLength(1);
    expect(h.sys.summary(42).custodyComplete).toBe(true);
  });

  it('collecting records the officer as custodian and the call location; the prop disappears', () => {
    const { h, id } = withFoundItem();
    expect(h.sys.props.kind[0]).toBe(PROP.knife);
    h.sys.request({ kind: 'collect', itemId: id });
    h.step();
    const entry = h.sys.ledger.entries()[0];
    expect(entry?.from).toBe('scene');
    expect(entry?.to).toBe(`officer:${BADGE}`);
    expect(entry?.location).toContain('Oak St');
    expect(h.sys.store.item(id)?.state).toBe('collected');
    expect(h.sys.props.count).toBe(0);
  });

  it('the tag note names the incident, item number and label', () => {
    const { h, id } = withFoundItem();
    for (const kind of ['collect', 'bag', 'tag'] as const) {
      h.sys.request({ kind, itemId: id });
      h.step();
    }
    expect(h.sys.ledger.itemEntries(id)[2]?.note).toBe('C-00042 item 1: Knife');
  });

  it('rejects illegal orders with the ledger reason and leaves the ledger untouched', () => {
    const { h, id } = withFoundItem();
    h.sys.request({ kind: 'bag', itemId: id });
    h.step();
    expect(h.sys.ledger.entries()).toHaveLength(0);
    expect(h.flashes().some((f) => f.includes('before it is collected'))).toBe(true);
    h.sys.request({ kind: 'collect', itemId: id });
    h.step();
    h.sys.request({ kind: 'tag', itemId: id });
    h.step();
    expect(h.sys.ledger.entries()).toHaveLength(1);
    expect(h.flashes().some((f) => f.includes('cannot tag'))).toBe(true);
    h.sys.request({ kind: 'deposit' });
    h.step();
    expect(h.sys.ledger.entries()).toHaveLength(1);
    expect(h.flashes()).toContain('Nothing tagged to deposit.');
  });

  it('collecting twice or collecting something not found is refused', () => {
    const { h, id } = withFoundItem();
    const hidden = h.sys.placeItem(placeSpec(h, { x: 100.5, z: -200, label: 'Hidden', concealed: true, container: 'drawer' }));
    h.sys.request({ kind: 'collect', itemId: hidden });
    h.step();
    expect(h.sys.ledger.entries()).toHaveLength(0);
    h.sys.request({ kind: 'collect', itemId: id });
    h.step();
    h.sys.request({ kind: 'collect', itemId: id });
    h.step();
    expect(h.sys.ledger.entries()).toHaveLength(1);
    expect(h.flashes().some((f) => f.includes('already collected'))).toBe(true);
  });

  it('needs the officer within reach of the item', () => {
    const { h, id } = withFoundItem();
    h.off.x = 106;
    h.sys.request({ kind: 'collect', itemId: id });
    h.step();
    expect(h.sys.ledger.entries()).toHaveLength(0);
    expect(h.flashes().some((f) => f.startsWith('Too far to collect'))).toBe(true);
  });

  it('bagging uses an evidence bag and fails without one', () => {
    const { h, id } = withFoundItem();
    h.sys.request({ kind: 'collect', itemId: id });
    h.step();
    h.world.kit['evidenceBags'] = 0;
    h.sys.request({ kind: 'bag', itemId: id });
    h.step();
    expect(h.sys.ledger.state(id)).toBe('collected');
    expect(h.flashes()).toContain('No evidence bags.');
    h.world.kit['evidenceBags'] = 2;
    h.sys.request({ kind: 'bag', itemId: id });
    h.step();
    expect(h.sys.ledger.state(id)).toBe('bagged');
    expect(h.world.kit['evidenceBags']).toBe(1);
  });

  it('a tagged item is secured in a patrol car trunk only at that trunk, and the evidence room deposit takes it from there', () => {
    const { h, id } = withFoundItem();
    for (const kind of ['collect', 'bag', 'tag'] as const) {
      h.sys.request({ kind, itemId: id });
      h.step();
    }
    // Away from every trunk the tools panel says why, and a request is refused.
    expect(h.sys.toolsModel().options[TOOL_ROW.transfer]).toMatchObject({ enabled: false, detail: 'Stand at a patrol car trunk' });
    h.sys.request({ kind: 'transfer', itemId: id, to: 'locker:2' });
    h.step();
    expect(h.sys.ledger.custodian(id)).toBe('officer:4417');
    expect(h.flashes()).toContain('Stand at the patrol car trunk to secure evidence.');
    // At the trunk the row offers the transfer to that car's locker.
    h.world.trunk = 'locker:2';
    expect(h.sys.toolsModel().options[TOOL_ROW.transfer]?.label).toBe('Secure Knife in the patrol car');
    expect(h.sys.toolsSelect(TOOL_ROW.transfer)).toEqual({ kind: 'request', request: { kind: 'transfer', itemId: id, to: 'locker:2' } });
    h.sys.request({ kind: 'transfer', itemId: id, to: 'locker:2' });
    h.step();
    expect(h.sys.ledger.custodian(id)).toBe('locker:2');
    expect(h.sys.ledger.state(id)).toBe('tagged');
    // A transfer to the evidence room must be a deposit.
    h.sys.request({ kind: 'transfer', itemId: id, to: 'evidenceRoom' });
    h.step();
    expect(h.sys.ledger.custodian(id)).toBe('locker:2');
    // The deposit at the evidence room takes tagged items out of the trunk: collect, bag, tag, transfer, deposit.
    h.sys.request({ kind: 'deposit' });
    h.step();
    expect(h.sys.ledger.state(id)).toBe('deposited');
    expect(h.sys.ledger.itemEntries(id).map((e) => e.action)).toEqual(['collect', 'bag', 'tag', 'transfer', 'deposit']);
    expect(h.sys.ledger.complete(id)).toBe(true);
    expect(h.of('investigation:custodyComplete')).toHaveLength(1);
    expect(verifyLedger(h.sys.ledger.entries()).ok).toBe(true);
  });

  it('deposits every tagged item the officer holds', () => {
    const { h, id } = withFoundItem();
    const id2 = h.sys.placeItem(placeSpec(h, { x: 100.5, z: -200, label: 'Bottle', item: 'liquorBottle' }));
    const second = h.sys.store.item(id2);
    if (!second) throw new Error('missing item');
    second.state = 'found';
    for (const itemId of [id, id2]) {
      for (const kind of ['collect', 'bag', 'tag'] as const) {
        h.sys.request({ kind, itemId });
        h.step();
      }
    }
    h.sys.request({ kind: 'deposit' });
    h.step();
    expect(h.sys.ledger.complete(id)).toBe(true);
    expect(h.sys.ledger.complete(id2)).toBe(true);
    expect(h.of('investigation:custodyComplete')).toHaveLength(2);
    expect(h.flashes()).toContain('Deposited 2 items in the evidence room');
  });

  it('a tampered ledger is flagged in the case view verdict', () => {
    const { h, id } = withFoundItem();
    for (const kind of ['collect', 'bag'] as const) {
      h.sys.request({ kind, itemId: id });
      h.step();
    }
    expect(h.sys.caseView(42)?.verdict).toBe('Chain intact');
    const save = JSON.parse(JSON.stringify(h.sys.serialize())) as ReturnType<typeof h.sys.serialize>;
    const entry = save.ledger[0];
    if (!entry) throw new Error('no entry');
    save.ledger[0] = { ...entry, note: 'edited' };
    h.sys.restore(save);
    const view = h.sys.caseView(42);
    expect(view?.chainOk).toBe(false);
    expect(view?.verdict).toContain('Chain broken');
  });
});
