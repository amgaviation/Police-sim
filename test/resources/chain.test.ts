import { describe, expect, it } from 'vitest';
import { CHAIN, chainResponse } from '../../src/resources/chain';

describe('chainResponse', () => {
  it('sends a sergeant to every listed force level and nobody for the rest', () => {
    for (const level of CHAIN.sergeantForceLevels) expect(chainResponse({ kind: 'force', level, callId: 1 })).toEqual(['supervisor']);
    for (const level of ['presence', 'verbal', 'softHands', 'unknown']) expect(chainResponse({ kind: 'force', level, callId: 1 })).toEqual([]);
  });

  it('sends a sergeant to an excessive verdict only', () => {
    expect(chainResponse({ kind: 'verdict', verdict: 'excessive', callId: 3 })).toEqual(['supervisor']);
    expect(chainResponse({ kind: 'verdict', verdict: 'questionable', callId: 3 })).toEqual([]);
    expect(chainResponse({ kind: 'verdict', verdict: 'justified', callId: 3 })).toEqual([]);
  });

  it('sends a sergeant to a vehicle pursuit', () => {
    expect(chainResponse({ kind: 'pursuit', callId: 9 })).toEqual(['supervisor']);
  });

  it('sends a lieutenant to a major post and a lieutenant and the chief to a disaster', () => {
    expect(chainResponse({ kind: 'post', level: 'none', callId: 1 })).toEqual([]);
    expect(chainResponse({ kind: 'post', level: 'incident', callId: 1 })).toEqual([]);
    expect(chainResponse({ kind: 'post', level: 'major', callId: 1 })).toEqual(['lieutenant']);
    expect(chainResponse({ kind: 'post', level: 'disaster', callId: 1 })).toEqual(['lieutenant', 'chief']);
  });
});
