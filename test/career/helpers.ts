import { EventBus } from '../../src/core/events';
import type { EventMap } from '../../src/core/event-map';
import { createRng } from '../../src/core/rng';
import {
  ACADEMY_MODULES, CareerState, newCareerSave, type CareerSave, type CareerStage, type EligibilityContext, type ShiftSummary,
} from '../../src/career';
import '../../src/career/events';

export const DAY = 86400;

export const GOOD_CTX: EligibilityContext = { points: 1000, credibility: 80, sustainedIaRecent: 0, avgReport: 90 };

export interface Harness {
  career: CareerState;
  bus: EventBus<EventMap>;
  flashes: string[];
  stages: { stage: string; rank: string; assignment: string }[];
  points: { delta: number; reason: string; key: string }[];
  summaries: ShiftSummary[];
}

export function harness(save?: CareerSave, names: readonly string[] = ['Avery', 'Blake', 'Casey']): Harness {
  const bus = new EventBus<EventMap>();
  const flashes: string[] = [];
  const stages: Harness['stages'] = [];
  const points: Harness['points'] = [];
  const summaries: Harness['summaries'] = [];
  bus.on('career:flash', (e) => flashes.push(e.text));
  bus.on('career:stage', (e) => stages.push({ ...e }));
  bus.on('career:points', (e) => points.push({ ...e }));
  bus.on('career:shiftSummary', (e) => summaries.push(e));
  const career = new CareerState({ bus, rng: createRng(7).stream('career'), names }, save);
  return { career, bus, flashes, stages, points, summaries };
}

/** A career save in a given stage starting at `startGame` (default: day 1, 22:00 = the night slot). */
export function saveAt(stage: CareerStage, startGame = DAY + 22 * 3600): CareerSave {
  return newCareerSave(createRng(7).stream('career').state(), { stage, startGame });
}

export function stepAt(h: Harness, game: number): void {
  h.career.step(1 / 60, { sim: game, game });
}

export function allPassed(): { module: (typeof ACADEMY_MODULES)[number]; score: number }[] {
  return ACADEMY_MODULES.map((module) => ({ module, score: 100 }));
}
