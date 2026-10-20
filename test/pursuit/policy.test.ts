import { describe, expect, it } from 'vitest';
import { PURSUIT_CONFIG, parsePursuitConfig } from '../../src/pursuit/data';
import pursuitJson from '../../src/data/pursuit/pursuit.json';
import { VIOLENT_OFFENSES, pursuitDecision, pursuitRisk, type DecisionInput, type RiskInput } from '../../src/pursuit/risk';
import type { PursuitConfig } from '../../src/pursuit/types';

const R = PURSUIT_CONFIG.risk;

/** Zero risk: at the limit, no district weight, dry, day, empty roads, just started, violent offense, in sight. */
const calm: RiskInput = {
  speedMph: 30, limitMph: 30, district: 'industrial', wet: false, night: false, trafficDensity: 0, durationS: 0,
  offense: 'violent', violentOffenses: VIOLENT_OFFENSES, lostSightS: 0, airOnTarget: false,
};

describe('pursuitRisk', () => {
  it('is zero for a calm pursuit of a violent offender', () => {
    expect(pursuitRisk(calm)).toBe(0);
  });

  it('adds each component on its own', () => {
    expect(pursuitRisk({ ...calm, speedMph: 60 })).toBeCloseTo(R.overLimitPer10Mph * 3, 9);
    expect(pursuitRisk({ ...calm, speedMph: 20 })).toBe(0);
    for (const [district, w] of Object.entries(R.district)) expect(pursuitRisk({ ...calm, district })).toBeCloseTo(w, 9);
    expect(pursuitRisk({ ...calm, wet: true })).toBeCloseTo(R.wet, 9);
    expect(pursuitRisk({ ...calm, night: true })).toBeCloseTo(R.night, 9);
    expect(pursuitRisk({ ...calm, trafficDensity: 2 })).toBeCloseTo(R.density * 2, 9);
    expect(pursuitRisk({ ...calm, durationS: 120 })).toBeCloseTo(R.perMinute * 2, 9);
    expect(pursuitRisk({ ...calm, offense: 'traffic' })).toBeCloseTo(R.nonViolent, 9);
    expect(pursuitRisk({ ...calm, offense: null })).toBeCloseTo(R.nonViolent, 9);
    expect(pursuitRisk({ ...calm, offense: 'weapons' })).toBe(0);
    expect(pursuitRisk({ ...calm, lostSightS: 0.5 })).toBeCloseTo(R.lostSight, 9);
  });

  it('subtracts the air unit relief and never goes below zero', () => {
    expect(pursuitRisk({ ...calm, airOnTarget: true })).toBe(0);
    expect(pursuitRisk({ ...calm, offense: 'traffic', airOnTarget: true })).toBe(0);
    expect(pursuitRisk({ ...calm, district: 'downtown', airOnTarget: true })).toBeCloseTo(R.district.downtown! + R.airUnitRelief, 9);
  });

  it('sums the components', () => {
    const v = pursuitRisk({
      ...calm, speedMph: 50, district: 'suburbs', wet: true, night: true, trafficDensity: 1, durationS: 60, offense: 'traffic',
      lostSightS: 5, airOnTarget: true,
    });
    const expected = R.overLimitPer10Mph * 2 + R.district.suburbs! + R.wet + R.night + R.density + R.perMinute + R.nonViolent + R.lostSight + R.airUnitRelief;
    expect(v).toBeCloseTo(expected, 9);
  });

  it('clamps to 1', () => {
    expect(pursuitRisk({ ...calm, speedMph: 150, district: 'campus', wet: true, night: true, trafficDensity: 2, durationS: 3000, offense: 'traffic', lostSightS: 40 })).toBe(1);
  });
});

/** Monitored for long enough, calm, an allowed violent offense. */
const base: DecisionInput = {
  ...calm, allowedOffenses: PURSUIT_CONFIG.pit.allowedOffenses, maxDurationS: 600, supervisorMonitoring: true, monitoringS: 30, durationS: 60,
};

describe('pursuitDecision', () => {
  it('continues a calm monitored pursuit', () => {
    expect(pursuitDecision(base)).toEqual({ action: 'continue', reason: '' });
  });

  it('rule 1: terminates for an offense that does not allow a pursuit, not for an unknown one', () => {
    expect(pursuitDecision({ ...base, offense: 'traffic' })).toEqual({ action: 'terminate', reason: 'pursuit not authorized for this offense' });
    expect(pursuitDecision({ ...base, offense: null }).action).toBe('continue');
  });

  it('rule 2: terminates past the time limit', () => {
    expect(pursuitDecision({ ...base, durationS: 600 }).action).toBe('continue');
    expect(pursuitDecision({ ...base, durationS: 601 })).toEqual({ action: 'terminate', reason: 'time limit reached' });
  });

  it('rule 3: terminates when sight was lost for the limit without the air unit', () => {
    const lost = PURSUIT_CONFIG.supervisor.lostSightS;
    expect(pursuitDecision({ ...base, lostSightS: lost - 1 }).action).toBe('continue');
    expect(pursuitDecision({ ...base, lostSightS: lost })).toEqual({ action: 'terminate', reason: 'lost visual, no air support' });
    expect(pursuitDecision({ ...base, lostSightS: lost, airOnTarget: true }).action).toBe('continue');
  });

  it('rule 4: terminates when the risk reaches riskTerminate', () => {
    // 100 mph in a 30 mph zone: 0.56, plus downtown 0.2 = 0.76.
    const risky = { ...base, speedMph: 100, district: 'downtown' };
    expect(pursuitRisk(risky)).toBeGreaterThanOrEqual(PURSUIT_CONFIG.supervisor.riskTerminate);
    expect(pursuitDecision(risky)).toEqual({ action: 'terminate', reason: 'risk to the public too high' });
    expect(pursuitDecision({ ...risky, speedMph: 90 }).action).toBe('continue');
  });

  it('rule 5: terminates a non-violent offense at the lower risk threshold', () => {
    // warrant is allowed but not violent: 60 mph in 30 (0.24) + downtown 0.2 + non-violent 0.15 = 0.59.
    const warrant = { ...base, offense: 'warrant', speedMph: 60, district: 'downtown' };
    const risk = pursuitRisk(warrant);
    expect(risk).toBeGreaterThanOrEqual(PURSUIT_CONFIG.supervisor.riskTerminateNonViolent);
    expect(risk).toBeLessThan(PURSUIT_CONFIG.supervisor.riskTerminate);
    expect(pursuitDecision(warrant)).toEqual({ action: 'terminate', reason: 'risk outweighs a non-violent offense' });
    expect(pursuitDecision({ ...warrant, offense: 'violent' }).action).toBe('continue');
  });

  it('applies nothing while no supervisor monitors', () => {
    expect(pursuitDecision({ ...base, offense: 'traffic', supervisorMonitoring: false }).action).toBe('continue');
  });

  it('applies nothing before the monitor delay has passed', () => {
    const delay = PURSUIT_CONFIG.supervisor.monitorDelayS;
    const bad = { ...base, offense: 'traffic' };
    expect(pursuitDecision({ ...bad, monitoringS: delay - 0.1 }).action).toBe('continue');
    expect(pursuitDecision({ ...bad, monitoringS: delay }).action).toBe('terminate');
  });

  it('checks the rules in order', () => {
    // Violates 1, 2, 3 and 4 at once.
    const all: DecisionInput = { ...base, offense: 'traffic', durationS: 700, lostSightS: 60, speedMph: 120, district: 'campus' };
    expect(pursuitDecision(all).reason).toBe('pursuit not authorized for this offense');
    expect(pursuitDecision({ ...all, offense: 'violent' }).reason).toBe('time limit reached');
    expect(pursuitDecision({ ...all, offense: 'violent', durationS: 60 }).reason).toBe('lost visual, no air support');
    expect(pursuitDecision({ ...all, offense: 'violent', durationS: 60, lostSightS: 0 }).reason).toBe('risk to the public too high');
    // Rule 4 before rule 5 for a non-violent allowed offense with a very high risk.
    expect(pursuitDecision({ ...all, offense: 'warrant', durationS: 60, lostSightS: 0 }).reason).toBe('risk to the public too high');
  });

  it('follows the tuning', () => {
    const cfg: PursuitConfig = { ...PURSUIT_CONFIG, supervisor: { ...PURSUIT_CONFIG.supervisor, riskTerminate: 0.1 } };
    expect(pursuitDecision({ ...base, district: 'downtown' }, cfg).action).toBe('terminate');
    expect(pursuitDecision({ ...base, district: 'downtown' }).action).toBe('continue');
  });
});

describe('pursuit.json', () => {
  it('parses the shipped file', () => {
    expect(PURSUIT_CONFIG.pit.maxMph).toBe(45);
    expect(PURSUIT_CONFIG.handoff.cityLimits.maxX).toBe(2560);
    expect(PURSUIT_CONFIG.handoff.resolveS).toEqual([60, 180]);
    expect(PURSUIT_CONFIG.risk.district.downtown).toBe(0.2);
  });

  it('names the file and the path of a bad value', () => {
    const bad = JSON.parse(JSON.stringify(pursuitJson)) as { pit: Record<string, unknown> };
    bad.pit.maxMph = 'fast';
    expect(() => parsePursuitConfig(bad, 'test.json')).toThrow(/test\.json: pit\.maxMph/);
    const unknown = JSON.parse(JSON.stringify(pursuitJson)) as Record<string, unknown>;
    unknown.extra = 1;
    expect(() => parsePursuitConfig(unknown, 'test.json')).toThrow(/test\.json: extra/);
    const model = JSON.parse(JSON.stringify(pursuitJson)) as { pit: { forbiddenModels: string[] } };
    model.pit.forbiddenModels = ['hovercraft'];
    expect(() => parsePursuitConfig(model, 'test.json')).toThrow(/forbiddenModels\[0\]/);
    const version = JSON.parse(JSON.stringify(pursuitJson)) as { version: number };
    version.version = 2;
    expect(() => parsePursuitConfig(version, 'test.json')).toThrow(/version/);
  });
});
