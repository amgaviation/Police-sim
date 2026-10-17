/**
 * Ambient chatter (design §9.3): per channel a Poisson process (`ambientPerMin`), suppressed while the
 * channel is held. Lines come from ambient.json with random units, registry plates and addresses. Uses
 * the radio stream only.
 */
import { addressOnEdge } from '../cad/address';
import type { RadioMode } from '../cad/types';
import type { Rng } from '../core/rng';
import { plateOf, REGISTRY_POPULATION } from '../traffic/registry';
import type { RoadGraph } from '../world/roadGraph';
import { AMBIENT, type ChannelDef } from './data';
import { fillTemplate } from './template';
import type { SpeakerKind } from './types';

/** Exponential inter-arrival time (s) for `perMin` events per minute. */
export function ambientInterval(rng: Rng, perMin: number): number {
  return (-Math.log(1 - rng.next()) * 60) / perMin;
}

export interface AmbientLine {
  readonly speaker: string;
  readonly speakerKind: SpeakerKind;
  readonly text: string;
  /** The ten-code wording (air time never depends on the radio language). */
  readonly durationText: string;
}

export interface AmbientContext {
  readonly rng: Rng;
  readonly seed: number;
  readonly graph: RoadGraph;
  readonly mode: RadioMode;
  readonly clock: string;
}

function randomAddress(ctx: AmbientContext): string {
  const edges = ctx.graph.edges;
  if (edges.length === 0) return 'the area';
  const e = edges[ctx.rng.nextInt(0, edges.length - 1)];
  if (!e) return 'the area';
  return addressOnEdge(ctx.graph, e.id, ctx.rng.next() * e.length).text;
}

/** One ambient line for `channel`. */
export function composeAmbient(channel: ChannelDef, ctx: AmbientContext): AmbientLine {
  const amb = AMBIENT[channel.id];
  const rng = ctx.rng;
  const dispatcherLines = channel.dispatcher === null ? 0 : amb.dispatcherTemplates.length;
  const pick = rng.nextInt(0, amb.templates.length + dispatcherLines - 1);
  const byDispatcher = pick >= amb.templates.length;
  const template = (byDispatcher ? amb.dispatcherTemplates[pick - amb.templates.length] : amb.templates[pick]) as string;
  const unitIdx = rng.nextInt(0, amb.units.length - 1);
  const unit = amb.units[unitIdx] as string;
  let other = '';
  if (template.includes('{other}') && amb.units.length > 1) {
    let j = rng.nextInt(0, amb.units.length - 2);
    if (j >= unitIdx) j++;
    other = amb.units[j] as string;
  }
  const values = {
    unit,
    other,
    time: ctx.clock,
    randomPlate: template.includes('{randomPlate}') ? plateOf(ctx.seed, rng.nextInt(0, REGISTRY_POPULATION - 1)) : '',
    randomAddress: template.includes('{randomAddress}') ? randomAddress(ctx) : '',
  };
  const text = fillTemplate(template, values, ctx.mode);
  const durationText = ctx.mode === 'tenCode' ? text : fillTemplate(template, values, 'tenCode');
  return byDispatcher
    ? { speaker: channel.dispatcher as string, speakerKind: 'dispatcher', text, durationText }
    : { speaker: unit, speakerKind: amb.speakerKind, text, durationText };
}
