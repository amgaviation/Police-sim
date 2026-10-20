import type { BackupOfficerView } from '../../src/backup/types';
import type { CommandBoard, TriagePrompt, Vitals } from '../../src/command/types';
import type { PursuitMenuItem } from '../../src/pursuit/types';

export function officer(over: Partial<BackupOfficerView> = {}): BackupOfficerView {
  return { callsign: '21', name: 'Officer J. Alvarez', role: 'cover', state: 'cover', stress: 0.42, fatigue: 0.1, loyalty: 0.5, quality: 1, post: null, ...over };
}

export function board(over: Partial<CommandBoard> = {}): CommandBoard {
  return {
    post: { callId: 3, level: 'disaster', x: 0, z: 0, commander: '12' },
    victims: [],
    counts: { minor: 2, delayed: 4, immediate: 3, expectant: 1, untagged: 2 },
    tcps: { staffed: 0, total: 0 },
    evac: null,
    inner: null,
    swat: null,
    negotiation: null,
    needs: { ems: 2, fire: 1, supervisor: 0 },
    units: [],
    ...over,
  };
}

export function vitals(over: Partial<Vitals> = {}): Vitals {
  return {
    walking: false,
    breathing: true,
    breathesAfterAirway: true,
    respRate: 34,
    radialPulse: false,
    capRefillS: 3.1,
    followsCommands: true,
    trapped: false,
    contaminated: false,
    ...over,
  };
}

export function prompt(over: Partial<TriagePrompt> = {}): TriagePrompt {
  return { personId: 77, label: 'Patient 3', progress: 0.4, vitals: null, tag: null, ...over };
}

export function pursuitMenu(enabled: readonly string[] = []): PursuitMenuItem[] {
  const items: PursuitMenuItem[] = [
    { id: 'requestPit', label: 'Request PIT authorization', enabled: false, hint: 'No pursuit' },
    { id: 'spikesAhead', label: 'Spikes ahead (unit)', enabled: false, hint: 'No pursuit' },
    { id: 'deployStrip', label: 'Deploy spike strip', enabled: false, hint: 'No strip carried' },
    { id: 'boxIn', label: 'Box in the suspect', enabled: false, hint: 'No pursuit' },
    { id: 'roadblock', label: 'Roadblock ahead', enabled: false, hint: 'No pursuit' },
    { id: 'air', label: 'Request air unit', enabled: false, hint: 'No pursuit' },
    { id: 'perimeter', label: 'Set perimeter', enabled: false, hint: 'No foot bail' },
  ];
  return items.map((m) => (enabled.includes(m.id) ? { ...m, enabled: true, hint: '' } : m));
}
