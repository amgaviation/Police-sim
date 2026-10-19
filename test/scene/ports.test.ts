/** Compile-time checks that the real Phase 4 objects satisfy the scene's structural ports and bus payloads. */
import { describe, expect, it } from 'vitest';
import type { InteriorSystem } from '../../src/indoors';
import type { InteriorDoorEvent } from '../../src/indoors/events';
import type { InvestigationPorts, InvestigationSystem } from '../../src/investigation';
import type {
  InvestigationCanvassEvent,
  InvestigationCollectedEvent,
  InvestigationCustodyCompleteEvent,
  InvestigationK9AlertEvent,
  InvestigationPhotoEvent,
  InvestigationPlainViewEvent,
  InvestigationTapeEvent,
} from '../../src/investigation/events';
import type { NpcAwareEvent } from '../../src/npc/events';
import type { ContactConsentEvent } from '../../src/contact/events';
import type { SceneDirector } from '../../src/scene/director';
import type { ContactConsentPayload } from '../../src/scene/events';
import type { SceneEvidencePort, SceneInteriorsPort } from '../../src/scene/types';
import type { BuildingIndex } from '../../src/world/buildings';
import type { SceneBuildingsPort } from '../../src/scene/types';

describe('structural ports', () => {
  it('InteriorSystem, BuildingIndex and InvestigationSystem are assignable to the scene deps', () => {
    const wire = (i: InteriorSystem, b: BuildingIndex, e: InvestigationSystem): { i: SceneInteriorsPort; b: SceneBuildingsPort; e: SceneEvidencePort } => ({ i, b, e });
    expect(typeof wire).toBe('function');
  });

  it('the director feeds InvestigationPorts.callContext and takes the bus payloads as they are', () => {
    const bridges = (d: SceneDirector): { [K in string]: (e: never) => void } => ({
      context: () => undefined,
      callContext: ((id: number) => d.callContext(id)) satisfies InvestigationPorts['callContext'],
      door: (e: InteriorDoorEvent) => d.onDoorEvent(e),
      aware: (e: NpcAwareEvent) => d.onNpcAware(e),
      photo: (e: InvestigationPhotoEvent) => d.onInvestigation('investigation:photo', e),
      collected: (e: InvestigationCollectedEvent) => d.onInvestigation('investigation:collected', e),
      canvass: (e: InvestigationCanvassEvent) => d.onInvestigation('investigation:canvass', e),
      tape: (e: InvestigationTapeEvent) => d.onInvestigation('investigation:tape', e),
      plainView: (e: InvestigationPlainViewEvent) => d.onInvestigation('investigation:plainView', e),
      custody: (e: InvestigationCustodyCompleteEvent) => d.onInvestigation('investigation:custodyComplete', e),
      k9: (e: InvestigationK9AlertEvent) => d.onInvestigation('investigation:k9Alert', e),
    });
    // The contact module's consent payload is a superset of what the scene reads.
    const consent = (e: ContactConsentEvent): ContactConsentPayload => e;
    expect(typeof bridges).toBe('function');
    expect(typeof consent).toBe('function');
  });
});
