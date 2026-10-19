/**
 * Phase 4 design §4.2: the defining data and code of every fixed id list contain every id the document lists
 * (the scenes module owns the cross-check; every referencing module re-declares its tuple).
 */
import { describe, expect, it } from 'vitest';
import behaviorsJson from '../../src/data/npc/behaviors.json';
import itemsJson from '../../src/data/police/items.json';
import equipmentJson from '../../src/data/police/equipment.json';
import { CONSENT_KINDS } from '../../src/dialogue/types';
import { CUSTODY_ACTIONS } from '../../src/evidence/ledger';
import { SEARCH_BASES } from '../../src/evidence/searchRules';
import { DOOR_STATE } from '../../src/indoors/types';
import { generateInterior } from '../../src/interior/generate';
import { BUILDING_KINDS } from '../../src/interior/kinds';
import { INTERIOR_TEMPLATES } from '../../src/interior/templates';
import { CONTAINERS, HIDE_KINDS, POINT_KINDS, PRINT_SURFACES, ROOM_KINDS, SURFACE_KINDS } from '../../src/interior/types';
import { AWARE_REACTIONS } from '../../src/npc/types';
import { INDOOR } from '../../src/scene/indoor';
import { ARMORY_ITEMS, SHIFT_STEPS } from '../../src/station';
import { SOUND_KINDS } from '../../src/tactical/sound';
import { BuildingIndex } from '../../src/world/buildings';
import { cityFor } from '../world/helpers';
import { handBuilding, SEED } from '../interior/helpers';

function same(actual: readonly string[], expected: readonly string[]): void {
  expect([...actual].sort()).toEqual([...expected].sort());
}

describe('design §4.2 id lists', () => {
  it('BUILDING_KINDS (12) and the kinds with a template', () => {
    same(BUILDING_KINDS, ['house', 'apartment', 'convenienceStore', 'bank', 'bar', 'hospital', 'school', 'warehouse', 'office', 'parkingStructure', 'jail', 'policeStation']);
    same(Object.keys(INTERIOR_TEMPLATES.templates), BUILDING_KINDS);
  });

  it('ROOM_KINDS (55) hold every room kind indoor.json names', () => {
    expect(ROOM_KINDS).toHaveLength(55);
    const used = new Set<string>();
    for (const f of Object.values(INDOOR.families)) {
      for (const rooms of Object.values(f.rooms)) for (const k of rooms) used.add(k);
      for (const e of f.evidence) for (const k of e.rooms) used.add(k);
    }
    expect(used.size).toBeGreaterThan(10);
    for (const k of used) expect(ROOM_KINDS as readonly string[], k).toContain(k);
    // The table of the document.
    for (const k of ['living', 'kitchen', 'dining', 'bedroom', 'bathroom', 'laundry', 'hallway', 'corridor', 'lobby', 'unitLiving', 'unitBedroom', 'unitBath', 'mailroom', 'salesFloor', 'storage', 'office', 'restroom', 'tellerArea', 'vault', 'breakRoom', 'barRoom', 'waiting', 'exam', 'patientRoom', 'nurseStation', 'supply', 'classroom', 'library', 'floor', 'loading', 'conference', 'deck', 'stairwell', 'sallyPort', 'booking', 'cell', 'control', 'visiting', 'garage', 'lockerRoom', 'rollCall', 'reportRoom', 'armory', 'evidenceRoom', 'interview', 'backOffice', 'cooler', 'security', 'closet', 'utility', 'gym', 'cafeteria', 'pharmacy', 'dock', 'lounge']) {
      expect(ROOM_KINDS as readonly string[], k).toContain(k);
    }
  });

  it('POINT_KINDS (10): the police station template defines every point but booking', () => {
    same(POINT_KINDS, ['locker', 'briefing', 'armory', 'evidence', 'reportDesk', 'interview', 'cell', 'frontDesk', 'garage', 'booking']);
    const layout = generateInterior(SEED, handBuilding('policeStation', 60, 28));
    expect(layout).not.toBeNull();
    const kinds = new Set(layout!.points.map((p) => p.kind));
    for (const k of POINT_KINDS) if (k !== 'booking') expect(kinds.has(k), k).toBe(true);
    const jail = new BuildingIndex(cityFor(SEED)).jail();
    const jailLayout = jail ? generateInterior(SEED, jail) : null;
    expect(jailLayout?.points.some((p) => p.kind === 'booking')).toBe(true);
  });

  it('surfaces, print surfaces, containers, hiding kinds, door and sound ids', () => {
    same(SURFACE_KINDS, ['carpet', 'wood', 'tile', 'concrete', 'linoleum']);
    same(PRINT_SURFACES, ['glass', 'metal', 'wood', 'stone', 'fabric']);
    same(CONTAINERS, ['none', 'drawer', 'cabinet', 'closet', 'safe']);
    same(HIDE_KINDS, ['closet', 'underBed', 'behindCounter', 'shower', 'cabinet']);
    expect(DOOR_STATE).toEqual({ closed: 0, open: 1, locked: 2, broken: 3 });
    same(SOUND_KINDS, ['footstep', 'doorOpen', 'doorClose', 'knock', 'kick', 'ram', 'radioChirp', 'voiceTalk', 'voiceShout', 'announce', 'taser', 'flashlightClick']);
  });

  it('CONSENT_KINDS gain entry, searchPremises and searchRoom; SEARCH_BASES (7); CUSTODY_ACTIONS (5)', () => {
    for (const k of ['searchPerson', 'searchVehicle', 'pbt', 'sfst', 'entry', 'searchPremises', 'searchRoom']) expect(CONSENT_KINDS as readonly string[], k).toContain(k);
    same(SEARCH_BASES, ['plainView', 'consent', 'warrant', 'incidentToArrest', 'exigency', 'protectiveSweep', 'publicArea']);
    same(CUSTODY_ACTIONS, ['collect', 'bag', 'tag', 'transfer', 'deposit']);
  });

  it('SHIFT_STEPS (5) and ARMORY_ITEMS (6)', () => {
    same(SHIFT_STEPS, ['locker', 'briefing', 'armory', 'garage', 'onPatrol']);
    same(ARMORY_ITEMS.map((i) => i.id), ['sidearm', 'taser', 'ocSpray', 'baton', 'beanbag', 'rifle']);
  });

  it('the six new trunk items are in items.json and in the patrol loadout', () => {
    const ids = itemsJson.items.map((i) => i.id);
    const patrol = (equipmentJson as unknown as { trunkLoadouts: { patrol: Record<string, number> } }).trunkLoadouts.patrol;
    for (const id of ['ram', 'sceneTape', 'evidenceMarkers', 'evidenceBags', 'fingerprintKit', 'camera']) {
      expect(ids, id).toContain(id);
      expect(patrol[id], id).toBeGreaterThan(0);
    }
  });

  it('AWARE_REACTIONS (6): behaviors.json onAware names only them and the behaviours use every reaction but none', () => {
    same(AWARE_REACTIONS, ['none', 'hide', 'flee', 'confront', 'surrender', 'arm']);
    const used = new Set<string>();
    for (const p of behaviorsJson.profiles as unknown as { onAware?: Record<string, number> }[]) {
      for (const k of Object.keys(p.onAware ?? {})) used.add(k);
    }
    for (const k of used) expect(AWARE_REACTIONS as readonly string[], k).toContain(k);
    for (const k of AWARE_REACTIONS) if (k !== 'none') expect(used.has(k), k).toBe(true);
  });
});
