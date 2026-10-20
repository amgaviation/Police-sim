import { iaStatementOptions } from '../conduct';
import type { Command } from '../debug/console';
import { FORCE_TOOLS, type ForceToolId } from '../force';
import { citation, getRuleset, rulesetIds } from '../legal';
import type { MediaStore } from '../recording';
import { retentionOf } from '../recording';
import { formatStamp } from '../records/calendar';
import { DISTRICT_NAMES } from '../world/ids';
import type { GameSession } from './session';

/**
 * Phase 5 console commands (design 20.4): `law` (ruleset / explain / list), `jurisdiction`, `incident` (list / show / close), `force`
 * (test / tool / fellow / stats), `trust`, `career`, `ia` (list / show / statement / review), `court` (list / next / advance /
 * attend), `cam` (mute / dash) and `media` (stats / clear / prune).
 */
export interface Phase5CommandDeps {
  session(): GameSession | null;
  flash(text: string): void;
  /** Opens the evidence review of an IA case. */
  openIa(caseId: string): void;
  /** Opens the read-only evidence review of an incident. */
  openReview(key: string): void;
  media(): MediaStore;
  mediaTag(): string;
}

function need(session: GameSession | null): GameSession {
  if (session === null) throw new Error('No game running');
  return session;
}

/** The incident key named by `arg`, else the current incident, else the newest one. */
function keyOf(session: GameSession, arg: string | undefined): string {
  if (arg !== undefined && arg !== '') return arg;
  const inc = session.incidents;
  return inc.current !== '' ? inc.current : (inc.keys()[0] ?? '');
}

function pct(v: number): string {
  return `${String(Math.round(v * 100))}%`;
}

/** Determinations, evidence, force and pursuit rulings of one incident with their rule citations. */
export function explainIncident(session: GameSession, key: string): string {
  const log = session.incidents.log(key);
  const a = session.incidents.assessment(key);
  if (!log || !a) return `No incident '${key}' (try: incident list)`;
  const rs = getRuleset(a.rulesetId);
  const cite = (ids: readonly string[]): string => ids.map((id) => { try { return citation(rs, id); } catch { return id; } }).join('; ');
  const lines = [
    `${log.key}  ${log.typeId}  ${log.closed ? 'closed' : 'open'}  ${String(log.events.length)} events  jurisdiction ${rs.name} (${rs.id})`,
    `Score ${String(a.summary.score)}: ${String(a.summary.unlawful)} unlawful, ${String(a.summary.questionable)} questionable, ${String(a.summary.suppressed)} suppressed, force ${String(a.summary.excessiveForce)} excessive / ${String(a.summary.questionableForce)} questionable`,
  ];
  for (const d of a.determinations) lines.push(`  ${d.id} [${d.outcome}] ${d.doctrine} #${String(d.eventId)}: ${d.reason}  (${cite(d.ruleIds)})`);
  for (const e of a.evidence) lines.push(`  evidence ${e.label} (${e.kind}): ${e.admissible ? 'admissible' : 'SUPPRESSED'} - ${e.reason}  (${cite(e.ruleIds)})`);
  for (const f of a.force) lines.push(`  force #${String(f.eventId)} ${f.tool} vs ${f.resistance}: ${f.verdict}${f.other ? ' (other officer)' : ''}, max allowed ${f.maxAllowed}  (${cite(f.ruleIds)})`);
  for (const p of a.pursuits) lines.push(`  pursuit #${String(p.startEventId)} [${p.outcome}] ${p.reasons.join('; ')}  (${cite(p.ruleIds)})`);
  if (a.determinations.length + a.evidence.length + a.force.length + a.pursuits.length === 0) lines.push('  nothing to judge yet');
  return lines.join('\n');
}

export function createPhase5Commands(deps: Phase5CommandDeps): Command[] {
  const session = (): GameSession => need(deps.session());
  return [
    {
      name: 'law',
      description: 'Legal engine: the jurisdiction ruleset and the explanation of an incident',
      usage: 'ruleset [id] | explain [incident] | list',
      run: (args) => {
        const s = session();
        const sub = args[0] ?? 'ruleset';
        if (sub === 'ruleset' || sub === 'jurisdiction') {
          const id = args[1];
          if (id === undefined) {
            const rs = s.incidents.ruleset;
            return `Jurisdiction ${rs.name} (${rs.id}): ${rs.description}\nAvailable: ${rulesetIds().join(', ')}`;
          }
          if (!rulesetIds().includes(id)) return `Unknown ruleset '${id}' (available: ${rulesetIds().join(', ')})`;
          s.phase5.setJurisdiction(id);
          return `Jurisdiction set to ${id} (applies at the next step; open incidents are re-judged)`;
        }
        if (sub === 'explain') return explainIncident(s, keyOf(s, args[1]));
        if (sub === 'list') {
          const rs = s.incidents.ruleset;
          return rs.rules.map((r) => `${r.id}  ${r.title}  (${r.cite})`).join('\n');
        }
        return 'law ruleset [id] | explain [incident] | list';
      },
    },
    {
      name: 'jurisdiction',
      description: 'Shows or sets the ruleset (jurisdiction) the officer is judged under',
      usage: '[id]',
      run: (args) => {
        const s = session();
        if (args[0] === undefined) return `${s.incidents.ruleset.name} (${s.incidents.ruleset.id}); available: ${rulesetIds().join(', ')}`;
        if (!rulesetIds().includes(args[0])) return `Unknown ruleset '${args[0]}'`;
        s.phase5.setJurisdiction(args[0]);
        return `Jurisdiction set to ${args[0]}`;
      },
    },
    {
      name: 'legal',
      description: 'Alias of "law explain": determinations of an incident with citations',
      usage: '[incident]',
      run: (args) => explainIncident(session(), keyOf(session(), args[0])),
    },
    {
      name: 'incident',
      description: 'Incident logs: list, show, review the footage or close',
      usage: 'list | show [key] | review [key] | close <key>',
      run: (args) => {
        const s = session();
        const inc = s.incidents;
        const sub = args[0] ?? 'list';
        if (sub === 'list') {
          const keys = inc.keys();
          if (keys.length === 0) return 'No incidents yet';
          return keys
            .map((k) => {
              const l = inc.log(k);
              return l ? `${k}${k === inc.current ? ' *' : ''}  ${l.typeId}  ${l.closed ? 'closed' : 'open'}  ${String(l.events.length)} events  cam bits ${String(l.events[l.events.length - 1]?.cam ?? 0)}` : k;
            })
            .join('\n');
        }
        if (sub === 'show') {
          const key = keyOf(s, args[1]);
          const l = inc.log(key);
          if (!l) return `No incident '${key}'`;
          const lines = [`${l.key} ${l.typeId} (${l.family}) district ${l.district}; people: ${l.people.map((p) => `${String(p.personId)}=${p.role}`).join(', ') || '-'}`];
          for (const e of l.events.slice(-30)) lines.push(`  #${String(e.id)} t=${e.t.toFixed(1)} ${e.kind} person ${String(e.personId)} cam ${String(e.cam)}`);
          return lines.join('\n');
        }
        if (sub === 'review') {
          const key = keyOf(s, args[1]);
          if (!inc.log(key)) return `No incident '${key}'`;
          deps.openReview(key);
          return `Opening the evidence review for ${key}`;
        }
        if (sub === 'close') {
          const key = args[1];
          if (key === undefined) return 'incident close <key>';
          inc.request({ kind: 'close', key });
          return `Closing ${key} at the next step`;
        }
        return 'incident list | show [key] | review [key] | close <key>';
      },
    },
    {
      name: 'force',
      description: 'Use of force: test the fellow-officer episode, select a tool, show the state',
      usage: 'test | tool <id> | fellow | stats',
      run: (args) => {
        const s = session();
        const sub = args[0] ?? 'stats';
        if (sub === 'test' || sub === 'fellow') {
          s.force.request({ kind: 'fellowTest' });
          return 'Fellow-officer misconduct episode requested for the nearest restrained subject (press H to intervene)';
        }
        if (sub === 'tool') {
          const id = args[1];
          if (id === undefined || !(FORCE_TOOLS as readonly string[]).includes(id)) return `force tool <${FORCE_TOOLS.join('|')}>`;
          s.force.request({ kind: 'selectTool', tool: id as ForceToolId });
          return `Tool ${id} requested`;
        }
        const h = s.force.hud;
        return `Tool ${h.tool} (${h.label}) ${h.ammo}${h.attached ? ' probes attached' : ''}; TASER cycles ${String(h.cycle)}${h.episode ? `; ${h.episode}` : ''}`;
      },
    },
    {
      name: 'trust',
      description: 'Community trust per district (or one district); with a delta it adjusts it',
      usage: '[district [delta]]',
      run: (args) => {
        const c = session().conduct;
        const district = args[0];
        if (district !== undefined && args[1] !== undefined) {
          const delta = Number(args[1]);
          if (!Number.isFinite(delta)) return 'trust <district> <delta>';
          c.request({ kind: 'trust', district, delta, reason: 'console' });
          return `Trust in ${district} adjusted by ${delta.toFixed(3)} at the next step`;
        }
        if (district !== undefined && !(DISTRICT_NAMES as readonly string[]).includes(district)) return `Unknown district '${district}' (${DISTRICT_NAMES.join(', ')})`;
        const rows = c.trustRows().filter((r) => district === undefined || r.district === district);
        const fx = (d: string) => c.effects(d);
        return rows
          .map((r) => `${r.district.padEnd(10)} ${pct(r.value).padStart(4)}  baseline ${pct(r.baseline)}  trend ${r.trend >= 0 ? '+' : ''}${(r.trend * 100).toFixed(1)}  errors x${fx(r.district).errorScale.toFixed(2)} crime x${fx(r.district).crimeFactor.toFixed(2)}`)
          .join('\n');
      },
    },
    {
      name: 'career',
      description: 'Duty status, points, credibility, commendations, discipline and report grades',
      usage: '[reinstate]',
      run: (args) => {
        const s = session();
        if (args[0] === 'reinstate') {
          s.conduct.request({ kind: 'reinstate' });
          return 'Reinstatement requested';
        }
        const v = s.conduct.career;
        const lines = [
          `Status ${v.status}${v.statusUntilGame > 0 ? ` until ${formatStamp(v.statusUntilGame)}` : ''}${v.statusReason ? ` (${v.statusReason})` : ''}; points ${String(v.points)}; credibility ${pct(v.credibility)}`,
          `Incidents ${String(v.stats.incidents)}, arrests ${String(v.stats.arrests)} (${String(v.stats.lawfulArrests)} lawful), excessive force ${String(v.stats.excessiveForce)}, convictions ${String(v.stats.convictions)}, dismissals ${String(v.stats.dismissals)}, reports ${String(v.stats.reportsFiled)} (avg ${v.stats.avgReport.toFixed(0)})`,
          `Commendations: ${v.commendations.map((c) => c.label).join(', ') || 'none'}`,
          `Discipline: ${v.discipline.map((d) => d.action).join(', ') || 'none'}`,
        ];
        return lines.join('\n');
      },
    },
    {
      name: 'ia',
      description: 'Internal affairs: list cases, show one, review its footage, give a statement',
      usage: 'list | show <id> | review <id> | statement <id> <n>',
      run: (args) => {
        const s = session();
        const sub = args[0] ?? 'list';
        const cases = s.conduct.career.ia;
        if (sub === 'list') {
          if (cases.length === 0) return 'No internal affairs cases';
          return cases.map((c) => `${c.id}  ${c.key}  ${c.severity}  ${c.status}${c.finding ? ` -> ${c.finding}` : ''}  ${c.triggers.map((t) => t.rule).join(', ')}`).join('\n');
        }
        const c = args[1] === undefined ? null : s.conduct.iaCase(args[1]);
        if (!c) return `No case '${args[1] ?? ''}' (ia list)`;
        if (sub === 'show') return `${c.id} ${c.key} ${c.severity} ${c.status}; triggers ${c.triggers.map((t) => `${t.rule}@${t.eventIds.join('/')}`).join(', ')}; finding ${c.finding ?? 'pending'}; discipline ${c.discipline.map((d) => d.action).join(', ') || 'none'}`;
        if (sub === 'review') {
          deps.openIa(c.id);
          return `Opening the evidence review for ${c.id}`;
        }
        if (sub === 'statement') {
          const log = s.incidents.log(c.key);
          if (!log) return 'The incident record is no longer available';
          const options = iaStatementOptions(c, log);
          const n = Number(args[2]);
          if (!Number.isInteger(n)) return options.map((o, i) => `${String(i + 1)}. ${o.text}`).join('\n') || 'No statement options';
          const o = options[n - 1];
          if (!o) return `Pick 1-${String(options.length)}`;
          s.conduct.request({ kind: 'iaStatement', caseId: c.id, statement: o.statement });
          return `Statement given: ${o.text}`;
        }
        return 'ia list | show <id> | review <id> | statement <id> <n>';
      },
    },
    {
      name: 'court',
      description: 'Court: cases, the next hearing, advance a case to its hearing, attend',
      usage: 'list | next | advance <id> | attend <id>',
      run: (args) => {
        const s = session();
        const sub = args[0] ?? 'next';
        const game = s.env.time.totalSeconds;
        if (sub === 'next') {
          const c = s.court.next(game);
          return c ? `${c.id} ${c.personLabel}: ${formatStamp(c.hearingGame)} (${c.status})${s.court.canAttend(c.id, game) ? ' - you may attend now' : ''}` : 'No scheduled hearing';
        }
        if (sub === 'list') {
          const list = s.court.cases();
          if (list.length === 0) return 'No court cases';
          return list.map((c) => `${c.id}  ${c.docId}  ${c.personLabel}  ${c.status}${c.verdict ? ` -> ${c.verdict} (${c.reason})` : ` ${formatStamp(c.hearingGame)}`}`).join('\n');
        }
        const id = args[1];
        if (id === undefined) return `court ${sub} <caseId>`;
        if (sub === 'advance') {
          s.court.request({ kind: 'advance', caseId: id });
          return `Hearing of ${id} moved to now`;
        }
        if (sub === 'attend') {
          s.court.request({ kind: 'attend', caseId: id });
          return `Attending ${id} at the next step`;
        }
        return 'court list | next | advance <id> | attend <id>';
      },
    },
    {
      name: 'cam',
      description: 'Body and dash camera: mute / unmute the bodycam, dashcam manual record',
      usage: 'mute [on|off] | dash [on|off] | status',
      run: (args) => {
        const s = session();
        const cam = s.incidents.cam;
        const sub = args[0] ?? 'status';
        const on = args[1] === undefined ? undefined : args[1] === 'on';
        if (sub === 'mute') {
          s.incidents.request({ kind: 'mute', on: on ?? !cam.muted });
          return 'Bodycam mute toggled at the next step';
        }
        if (sub === 'dash') {
          s.incidents.request({ kind: 'dashManual', on: on ?? !cam.dash });
          return 'Dashcam manual record toggled at the next step';
        }
        return `Bodycam ${cam.body ? (cam.muted ? 'MUTED' : 'recording') : 'off'}, dashcam ${cam.dash ? 'recording' : 'off'}, current incident ${s.incidents.current || '-'}`;
      },
    },
    {
      name: 'media',
      description: 'Snapshot media store (IndexedDB patrol-media): stats, clear, prune',
      usage: 'stats | clear | prune',
      run: async (args) => {
        const s = session();
        const media = deps.media();
        const sub = args[0] ?? 'stats';
        if (sub === 'clear') {
          await media.clear();
          return 'Media store cleared';
        }
        if (sub === 'prune') {
          const n = await media.prune(retentionOf(), deps.mediaTag(), new Set(s.incidents.keys()));
          return `Pruned ${String(n)} snapshots`;
        }
        const st = await media.stats();
        return `${String(st.count)} snapshots, ${(st.bytes / 1024).toFixed(1)} KiB (tag ${deps.mediaTag()})`;
      },
    },
  ];
}
