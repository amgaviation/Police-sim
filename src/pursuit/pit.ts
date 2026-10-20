/**
 * PIT contact geometry and policy (design §10.2). Pure functions; yaw convention: 0 = facing -Z, forward =
 * (-sin yaw, -cos yaw), right = (cos yaw, -sin yaw).
 */
import { MPH } from '../world/constants';
import { PURSUIT_CONFIG } from './data';
import type { CarPose, ContactResult, PursuitConfig } from './types';

export type { CarPose, ContactResult } from './types';

const DEG = Math.PI / 180;
/** A contact point farther than this (plus the police half width) from the suspect's body is no contact (m). */
const NO_CONTACT_MARGIN_M = 1;

function wrapPi(a: number): number {
  const twoPi = Math.PI * 2;
  let r = (a + Math.PI) % twoPi;
  if (r < 0) r += twoPi;
  return r - Math.PI;
}

/**
 * Classifies a contact between the police car `p` and the suspect `s`. Contact point = p's front centre
 * (`p + forward * halfLength`). In s's local frame `along = dot(c - s, fwdS)` and `lateral = dot(c - s, rightS)`.
 * PIT when the contact is in the rear `rearZoneFrac` of the body (`along <= -halfLengthS * (1 - 2 * rearZoneFrac)`),
 * `|lateral| >= halfWidthS * lateralMinFrac`, the headings differ by at most `maxHeadingDeg`, the closing speed along
 * the suspect's heading (`|vP - vS|` for aligned cars, mph) is at most `maxRelMph` and the suspect drives between
 * `minMph` and `maxMph`. `dir` is `lateral > 0 ? 1 : -1`. Otherwise `ram` when the relative speed (`relMph`, the
 * magnitude of the whole velocity difference) reaches `ramMph`, else `bump`;
 * `none` when the contact point is nowhere near the suspect's body. `reasons` lists the failed checks.
 */
export function classifyContact(p: CarPose, s: CarPose, cfg: PursuitConfig = PURSUIT_CONFIG): ContactResult {
  const c = cfg.pit;
  const fpx = -Math.sin(p.yaw), fpz = -Math.cos(p.yaw);
  const fsx = -Math.sin(s.yaw), fsz = -Math.cos(s.yaw);
  const rsx = Math.cos(s.yaw), rsz = -Math.sin(s.yaw);
  const cx = p.x + fpx * p.halfLength - s.x;
  const cz = p.z + fpz * p.halfLength - s.z;
  const along = cx * fsx + cz * fsz;
  const lateral = cx * rsx + cz * rsz;
  const dir: 1 | -1 = lateral > 0 ? 1 : -1;
  const relMph = Math.hypot(p.speed * fpx - s.speed * fsx, p.speed * fpz - s.speed * fsz) / MPH;
  // Closing speed along the suspect's heading (|vP - vS| when the headings agree).
  const alongMph = Math.abs(p.speed * (fpx * fsx + fpz * fsz) - s.speed) / MPH;

  const outA = Math.max(0, Math.abs(along) - s.halfLength);
  const outL = Math.max(0, Math.abs(lateral) - s.halfWidth);
  if (Math.hypot(outA, outL) > p.halfWidth + NO_CONTACT_MARGIN_M) return { kind: 'none', dir, relMph, reasons: ['No contact'] };

  const reasons: string[] = [];
  if (along > -s.halfLength * (1 - 2 * c.rearZoneFrac)) reasons.push('Contact not at the rear quarter');
  if (Math.abs(lateral) < s.halfWidth * c.lateralMinFrac) reasons.push('Contact too close to the centreline');
  if (Math.abs(wrapPi(p.yaw - s.yaw)) > c.maxHeadingDeg * DEG) reasons.push('Headings not aligned');
  if (alongMph > c.maxRelMph) reasons.push('Closing speed too high');
  const sMph = s.speed / MPH;
  if (sMph < c.minMph) reasons.push(`Suspect below ${c.minMph} mph`);
  if (sMph > c.maxMph) reasons.push(`Suspect above ${c.maxMph} mph`);
  if (reasons.length === 0) return { kind: 'pit', dir, relMph, reasons };
  return { kind: relMph >= c.ramMph ? 'ram' : 'bump', dir, relMph, reasons };
}

/** Inputs of the PIT policy check. */
export interface PitPolicyInput {
  speedMph: number;
  offense: string | null;
  authorized: boolean;
  modelId: string;
  district: string;
  wet: boolean;
}

/** Districts where a PIT on a wet road is outside policy. */
const WET_BANNED_DISTRICTS: readonly string[] = ['downtown', 'campus'];

/**
 * Policy: speed at most `maxMph`, offense in `allowedOffenses`, authorized when `requiresAuthorization`, model not
 * forbidden, and not on a wet road in a downtown or campus district. `reasons` lists every violated condition.
 */
export function pitPolicy(i: PitPolicyInput, cfg: PursuitConfig = PURSUIT_CONFIG): { verdict: 'withinPolicy' | 'outsidePolicy'; reasons: string[] } {
  const c = cfg.pit;
  const reasons: string[] = [];
  if (i.speedMph > c.maxMph) reasons.push(`speed above ${c.maxMph} mph`);
  if (i.offense === null || !c.allowedOffenses.includes(i.offense)) reasons.push('offense does not allow a PIT');
  if (c.requiresAuthorization && !i.authorized) reasons.push('no supervisor authorization');
  if (c.forbiddenModels.includes(i.modelId)) reasons.push('vehicle type not allowed');
  if (i.wet && WET_BANNED_DISTRICTS.includes(i.district)) reasons.push('wet road in a congested district');
  return { verdict: reasons.length === 0 ? 'withinPolicy' : 'outsidePolicy', reasons };
}
