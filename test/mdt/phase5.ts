import type { CareerView, IaCase } from '../../src/conduct/types';
import type { CourtCase } from '../../src/court/types';
import type { MdtCareerDeps, MdtCommunityDeps } from '../../src/ui/mdt';
import type { ChoiceInfo } from '../../src/ui/mdt';
import { at } from './helpers';

export function careerView(over: Partial<CareerView> = {}): CareerView {
  return {
    status: 'active',
    statusUntilGame: 0,
    statusReason: '',
    points: 12,
    credibility: 0.85,
    commendations: [],
    discipline: [],
    ia: [],
    reports: [],
    stats: { incidents: 5, arrests: 3, lawfulArrests: 2, excessiveForce: 0, convictions: 1, dismissals: 0, reportsFiled: 4, avgReport: 82.4 },
    ...over,
  };
}

export function iaCase(over: Partial<IaCase> = {}): IaCase {
  return {
    id: 'IA-0001',
    key: 'C-00007',
    openedGame: 50400,
    triggers: [{ rule: 'excessiveForce', severity: 'major', eventIds: [4] }],
    severity: 'major',
    status: 'open',
    statement: null,
    finding: null,
    untruthful: false,
    discipline: [],
    closedGame: 0,
    ...over,
  };
}

export function courtCase(over: Partial<CourtCase> = {}): CourtCase {
  return {
    id: 'CR-0001',
    docId: 'B-0001',
    docKind: 'booking',
    personId: 5,
    personLabel: 'DOE, JANE',
    key: 'C-00007',
    callId: 7,
    statutes: [],
    offenses: [],
    createdGame: 50400,
    hearingGame: 50400 + 3600,
    status: 'scheduled',
    questions: [],
    motions: [],
    verdict: null,
    reason: '',
    testimony: null,
    reminded: false,
    ...over,
  };
}

export const CHOICES: readonly ChoiceInfo[] = [
  { id: 'detention:1', group: null, text: 'I stopped the vehicle for weaving.' },
  { id: 'consent:searchVehicle:1', group: 'consent:searchVehicle:1', text: 'The driver consented to a search of the vehicle.' },
  { id: 'consent:searchVehicle:1:no', group: 'consent:searchVehicle:1', text: 'The driver refused a search of the vehicle.' },
  { id: 'miranda:1', group: null, text: 'I read the driver his rights before questioning.' },
];

export interface CareerFeed {
  career: MdtCareerDeps;
  community: MdtCommunityDeps;
  state: { rev: number; communityRev: number; view: CareerView; cases: CourtCase[]; attendable: Set<string>; game: number };
  calls: { attend: string[]; ia: string[] };
}

export function careerFeed(): CareerFeed {
  const state: CareerFeed['state'] = { rev: 1, communityRev: 1, view: careerView(), cases: [], attendable: new Set(), game: at(0).game };
  const calls: CareerFeed['calls'] = { attend: [], ia: [] };
  return {
    state,
    calls,
    career: {
      revision: () => state.rev,
      view: () => state.view,
      cases: () => state.cases,
      canAttend: (id) => state.attendable.has(id),
      attend: (id) => calls.attend.push(id),
      openIa: (id) => calls.ia.push(id),
      jurisdiction: () => ({ id: 'generic', name: 'Generic State Code' }),
      now: () => ({ sim: 0, game: state.game }),
    },
    community: {
      revision: () => state.communityRev,
      rows: () => [
        { district: 'suburbs', value: 0.62, baseline: 0.6, trend: 0.02 },
        { district: 'downtown', value: 0.25, baseline: 0.45, trend: -0.03 },
      ],
    },
  };
}
