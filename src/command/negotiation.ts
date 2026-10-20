/** Negotiation minigame rules (Phase 6 design §11.2). Pure: the only randomness is the injected stream. */
import type { Rng } from '../core/rng';
import { COMMAND_CONFIG, NEGOTIATION_DATA } from './data';
import {
  NEGOTIATION_STAGES,
  type CommandConfig,
  type NegSubject,
  type NegState,
  type NegStage,
  type NegTone,
  type NegotiationData,
  type NegotiationMenuCategory,
  type NegotiationOption,
} from './types';

export type { NegState, NegStage, NegSubject } from './types';

/** Longest transcript kept (lines, officer and subject alternating). */
export const HISTORY_MAX = 60;

/**
 * Weight of the subject bias (temperament + hostage + intoxicated + crisis terms) in the per-turn agitation change. Small
 * enough that the best in-stage option of every stage (plan: -0.05) outweighs the worst bias (volatile, hostage,
 * intoxicated: 0.28), so a hard subject takes longer to talk down but can always be won.
 */
export const BIAS_WEIGHT = 0.1;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** The highest stage whose trust threshold `trust` reaches. */
export function stageOf(trust: number, data: NegotiationData = NEGOTIATION_DATA): NegStage {
  let stage: NegStage = 'contact';
  for (const s of NEGOTIATION_STAGES) if (trust >= data.stageTrust[s]) stage = s;
  return stage;
}

/** A fresh negotiation at the configured starting trust and agitation. */
export function newNegotiation(cfg: CommandConfig = COMMAND_CONFIG, data: NegotiationData = NEGOTIATION_DATA): NegState {
  return {
    trust: cfg.negotiation.startTrust,
    agitation: cfg.negotiation.startAgitation,
    turns: 0,
    goodTurns: 0,
    stage: stageOf(cfg.negotiation.startTrust, data),
    outcome: 'ongoing',
    lastReply: '',
    history: [],
  };
}

function appropriate(o: NegotiationOption, s: NegState): boolean {
  return o.stages.includes(s.stage) && (o.minTrust === undefined || s.trust >= o.minTrust);
}

function hintFor(o: NegotiationOption, s: NegState): string {
  if (!o.stages.includes(s.stage)) return 'Not the right moment for this';
  if (o.minTrust !== undefined && s.trust < o.minTrust) return 'They do not trust you enough yet';
  return '';
}

/** Options per category; `enabled` when the option fits the state's stage and trust, else `hint` says why not. */
export function negotiationOptions(s: NegState, data: NegotiationData = NEGOTIATION_DATA): NegotiationMenuCategory[] {
  return data.categories.map((c) => ({
    category: c.id,
    label: c.label,
    options: c.options.map((o) => ({ id: o.id, text: o.text, enabled: appropriate(o, s), hint: hintFor(o, s) })),
  }));
}

/** Finds an option by id. */
export function findOption(optionId: string, data: NegotiationData = NEGOTIATION_DATA): NegotiationOption | null {
  for (const c of data.categories) for (const o of c.options) if (o.id === optionId) return o;
  return null;
}

/**
 * One turn (mutates and returns `s`; an unknown option or a finished negotiation changes nothing and draws nothing).
 * An option that does not fit the stage (or trust) counts half and adds +0.05 agitation.
 * trust += d_t * toneFactor[tone] * (negotiatorOnScene ? 1 + negotiatorBonus : 1) + noise;
 * agitation += d_a + subject bias (temperament + hostage + intoxicated + crisis terms) * BIAS_WEIGHT + noise;
 * noise = (rng.next() - 0.5) * 2 * noiseSd (two draws: trust then agitation); both clamp to 0..1; then turns++,
 * stage = highest stage reached, goodTurns counts consecutive turns at surrender trust and agitation; the outcome is
 * surrender (goodTurns >= surrenderTurns), breakdown (agitation >= breakdownAgitation) or stalled (turns >= stallTurns).
 * The reply (one more draw) is `replies[outcome]` when finished, else agitated (> 0.7), calm (trust > 0.5) or neutral.
 */
export function negotiationTurn(
  s: NegState,
  optionId: string,
  tone: NegTone,
  subject: NegSubject,
  negotiatorOnScene: boolean,
  rng: Rng,
  cfg: CommandConfig = COMMAND_CONFIG,
  data: NegotiationData = NEGOTIATION_DATA,
): NegState {
  const option = findOption(optionId, data);
  if (!option || s.outcome !== 'ongoing') return s;
  const n = cfg.negotiation;

  let dt = option.trust;
  let da = option.agitation;
  if (!appropriate(option, s)) {
    dt *= 0.5;
    da = da * 0.5 + 0.05;
  }
  const sd = data.subject;
  const bias =
    sd.temperament[subject.temperament] + (subject.hostage ? sd.hostage : 0) + (subject.intoxicated ? sd.intoxicated : 0) + (subject.crisis ? sd.crisis : 0);
  const noiseT = (rng.next() - 0.5) * 2 * n.noiseSd;
  const noiseA = (rng.next() - 0.5) * 2 * n.noiseSd;

  s.trust = clamp01(s.trust + dt * data.toneFactor[tone] * (negotiatorOnScene ? 1 + n.negotiatorBonus : 1) + noiseT);
  s.agitation = clamp01(s.agitation + da + bias * BIAS_WEIGHT + noiseA);
  s.turns += 1;
  s.stage = stageOf(s.trust, data);
  s.goodTurns = s.trust >= n.surrenderTrust && s.agitation <= n.surrenderAgitation ? s.goodTurns + 1 : 0;

  if (s.goodTurns >= n.surrenderTurns) s.outcome = 'surrender';
  else if (s.agitation >= n.breakdownAgitation) s.outcome = 'breakdown';
  else if (s.turns >= n.stallTurns) s.outcome = 'stalled';

  // A stall has no reply list of its own: the subject answers in the plain mood.
  const mood = s.agitation > 0.7 ? 'agitated' : s.trust > 0.5 ? 'calm' : 'neutral';
  const key = s.outcome === 'surrender' || s.outcome === 'breakdown' ? s.outcome : mood;
  s.lastReply = rng.pick(data.replies[key]);
  s.history.push(option.text, s.lastReply);
  if (s.history.length > HISTORY_MAX) s.history.splice(0, s.history.length - HISTORY_MAX);
  return s;
}
