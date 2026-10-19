import { describe, expect, it } from 'vitest';
import { PROP } from '../../src/render/people/pose';
import { bigRoom, clearPair, makeHarness, placeSpec, stand, yawTo } from './harness';

describe('evidence markers', () => {
  it('numbers markers 1, 2, 3 per case file and uses one tent each', () => {
    const h = makeHarness();
    stand(h, 100, -200, 0, 0);
    for (let i = 0; i < 3; i++) {
      h.sys.request({ kind: 'marker' });
      h.step();
    }
    const file = h.sys.store.get(42);
    expect(file?.markers.map((m) => m.no)).toEqual([1, 2, 3]);
    expect(h.world.kit['evidenceMarkers']).toBe(17);
    expect(h.of('investigation:marker').map((e) => e.payload['no'])).toEqual([1, 2, 3]);
  });

  it('places the tent two metres ahead of the officer at their feet height', () => {
    const h = makeHarness();
    stand(h, 100, -200, 0, 0);
    h.sys.request({ kind: 'marker' });
    h.step();
    const m = h.sys.store.get(42)?.markers[0];
    expect(m?.x).toBeCloseTo(100, 5);
    expect(m?.z).toBeCloseTo(-202, 5);
    expect(m?.y).toBe(-40);
    expect(m?.buildingId).toBe(h.layout.buildingId);
    expect(m?.itemId).toBeNull();
  });

  it('needs the evidenceMarkers kit: nothing is placed and the officer is told', () => {
    const h = makeHarness();
    h.world.kit['evidenceMarkers'] = 0;
    stand(h, 100, -200, 0, 0);
    h.sys.request({ kind: 'marker' });
    h.step();
    expect(h.sys.store.get(42)?.markers ?? []).toHaveLength(0);
    expect(h.flashes()).toContain('No evidence markers.');
  });

  it('gives the tent back when a marker is picked up, and frees nothing else', () => {
    const h = makeHarness();
    stand(h, 100, -200, 0, 0);
    h.sys.request({ kind: 'marker' });
    h.step();
    h.sys.request({ kind: 'removeMarker', no: 1 });
    h.step();
    expect(h.sys.store.get(42)?.markers).toHaveLength(0);
    expect(h.world.kit['evidenceMarkers']).toBe(20);
    h.sys.request({ kind: 'removeMarker', no: 9 });
    h.step();
    expect(h.world.kit['evidenceMarkers']).toBe(20);
  });

  it('snaps to a found, uncollected item within one metre and links it', () => {
    const h = makeHarness();
    const id = h.sys.placeItem(placeSpec(h, { x: 100.4, z: -202.2, y: 0.05 }));
    const item = h.sys.store.item(id);
    if (!item) throw new Error('missing item');
    // Not found yet: the marker does not link.
    stand(h, 100, -200, 0, 0);
    h.sys.request({ kind: 'marker' });
    h.step();
    expect(h.sys.store.get(42)?.markers[0]?.itemId).toBeNull();
    item.state = 'found';
    h.sys.request({ kind: 'marker' });
    h.step();
    const m = h.sys.store.get(42)?.markers[1];
    expect(m?.itemId).toBe(id);
    expect(item.markerNo).toBe(2);
    expect(m?.x).toBeCloseTo(100.4, 5);
  });

  it('files markers under the field case (call 0) when no call is current', () => {
    const h = makeHarness();
    h.world.call = 0;
    stand(h, 100, -200, 0, 0);
    h.sys.request({ kind: 'marker' });
    h.step();
    expect(h.sys.store.get(0)?.markers).toHaveLength(1);
    expect(h.sys.store.get(0)?.title).toBe('Field case');
  });

  it('draws markers as props only on the level the officer is on', () => {
    const h = makeHarness();
    stand(h, 100, -200, 0, 0);
    h.sys.request({ kind: 'marker' });
    h.step();
    expect(h.sys.props.count).toBe(1);
    expect(h.sys.props.kind[0]).toBe(PROP.marker);
    stand(h, 0, 0, -1, 0, -1);
    h.step();
    expect(h.sys.props.count).toBe(0);
  });
});

describe('photos', () => {
  function photoScene(): ReturnType<typeof makeHarness> & { itemId: string; officerYaw: number } {
    const h = makeHarness();
    const room = bigRoom(h.layout);
    const pair = clearPair(h.layout, room);
    const officerYaw = yawTo(pair.officer.x, pair.officer.z, pair.item.x, pair.item.z);
    const itemId = h.sys.placeItem(placeSpec(h, { x: pair.item.x, z: pair.item.z, y: 0.1, room }));
    const item = h.sys.store.item(itemId);
    if (!item) throw new Error('missing item');
    item.state = 'found';
    stand(h, pair.officer.x, pair.officer.z, room, officerYaw);
    return Object.assign(h, { itemId, officerYaw });
  }

  it('needs a camera', () => {
    const h = makeHarness();
    h.world.kit['camera'] = 0;
    stand(h, 100, -200, 0, 0);
    h.sys.request({ kind: 'photo', fovDeg: 60 });
    h.step();
    expect(h.sys.store.get(42)?.photos ?? []).toHaveLength(0);
    expect(h.flashes()).toContain('No camera.');
  });

  it('records found items in view and captions the one nearest the centre', () => {
    const h = photoScene();
    h.sys.request({ kind: 'photo', fovDeg: 60 });
    h.step();
    const photo = h.sys.store.get(42)?.photos[0];
    expect(photo?.id).toBe('P-42-1');
    expect(photo?.subjects).toEqual([{ kind: 'item', ref: h.itemId }]);
    expect(photo?.caption).toMatch(/^Knife \(/);
    expect(photo?.thumb).toBeNull();
    expect(h.of('investigation:photo')).toHaveLength(1);
  });

  it('names a marker in the caption once the item has one', () => {
    const h = photoScene();
    const item = h.sys.store.item(h.itemId);
    if (!item) throw new Error('missing item');
    item.markerNo = 3;
    h.sys.request({ kind: 'photo', fovDeg: 60 });
    h.step();
    expect(h.sys.store.get(42)?.photos[0]?.caption).toMatch(/^Marker 3 — Knife \(/);
  });

  it('falls back to an overview when nothing is in the frame', () => {
    const h = photoScene();
    h.off.yaw += Math.PI;
    h.sys.request({ kind: 'photo', fovDeg: 60 });
    h.step();
    const photo = h.sys.store.get(42)?.photos[0];
    expect(photo?.subjects).toEqual([]);
    expect(photo?.caption).toMatch(/^Overview — /);
  });

  it('ignores items behind a closed door', () => {
    const h = photoScene();
    const item = h.sys.store.item(h.itemId);
    if (!item) throw new Error('missing item');
    // Move the item into another room: the wall between blocks the sight line.
    const other = h.layout.rooms.find((r) => r.index !== item.room);
    if (!other) throw new Error('no other room');
    item.x = (other.rect.minX + other.rect.maxX) / 2;
    item.z = (other.rect.minZ + other.rect.maxZ) / 2;
    item.room = other.index;
    h.off.yaw = yawTo(h.off.x, h.off.z, item.x, item.z);
    h.sys.request({ kind: 'photo', fovDeg: 100 });
    h.step();
    expect(h.sys.store.get(42)?.photos[0]?.subjects).toEqual([]);
  });

  it('keeps the shutter press pending until the thumbnail is attached', () => {
    const h = photoScene();
    expect(h.sys.pendingThumbnail()).toBeNull();
    h.sys.request({ kind: 'photo', fovDeg: 60 });
    h.step();
    const id = h.sys.pendingThumbnail();
    expect(id).toBe('P-42-1');
    const before = h.sys.revision;
    h.sys.attachThumbnail(id as string, 'data:image/jpeg;base64,AAAA');
    expect(h.sys.pendingThumbnail()).toBeNull();
    expect(h.sys.store.get(42)?.photos[0]?.thumb).toBe('data:image/jpeg;base64,AAAA');
    expect(h.sys.revision).toBeGreaterThan(before);
  });
});
