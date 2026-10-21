import { ACADEMY_MODULES, CAREER_RANKS, SPECIALTY_IDS, type AcademyModule, type CareerRank, type SpecialtyId } from '../career';
import type { Command } from '../debug/console';
import { activeModRefs } from '../mods/registry';
import type { BootResult } from '../mods/boot';
import { NetClient, PROTOCOL_VERSION, type NetRole } from '../net';
import { COURSES, SAMPLE_SCENARIOS, type GameMode, type SandboxScenario } from '../training';
import { libraryList, libraryLoad } from '../ui/sandbox';
import { availableScripts } from './phase8';
import type { Phase8Presenter } from './phase8Presenter';
import type { GameSession } from './session';
import { runScenario } from './modes';

/**
 * Phase 8 console commands (design §20.6): `career`, `world`, `course`, `dispatchmode`, `script`, `sandbox`, `scenario`,
 * `mods` and `coop` (alias `mp`).
 */
export interface Phase8CommandDeps {
  session(): GameSession | null;
  presenter(): Phase8Presenter;
  flash(text: string): void;
  reportForDuty(): { ok: boolean; reason: string } | undefined;
  boot(): BootResult;
  startMode(mode: GameMode, option?: string): unknown;
}

function need(session: GameSession | null): GameSession {
  if (session === null) throw new Error('No game running');
  return session;
}

const pct = (v: number): string => `${String(Math.round(v * 100))}%`;

function num(text: string | undefined, name: string, lo: number, hi: number): number {
  const v = Number(text);
  if (text === undefined || !Number.isFinite(v) || v < lo || v > hi) throw new Error(`${name} must be a number from ${String(lo)} to ${String(hi)}`);
  return v;
}

function oneOf<T extends string>(text: string | undefined, list: readonly T[], what: string): T {
  const hit = list.find((x) => x === text);
  if (hit === undefined) throw new Error(`Unknown ${what} '${text ?? ''}' (${list.join(', ')})`);
  return hit;
}

function scenarioById(id: string): SandboxScenario | null {
  const sample = SAMPLE_SCENARIOS.find((s) => s.id === id);
  if (sample) return sample;
  try {
    if (typeof localStorage === 'undefined') return null;
    const entry = libraryList(localStorage).find((e) => e.id === id);
    return entry ? libraryLoad(localStorage, id) : null;
  } catch {
    return null;
  }
}

export function createPhase8Commands(deps: Phase8CommandDeps): Command[] {
  const session = (): GameSession => need(deps.session());
  const drain = (s: GameSession): void => s.phase8.career.step(0, s.now());

  const careerShow = (s: GameSession): string => {
    const v = s.phase8.career.view;
    const w = v.wellbeing;
    const lines = [
      `Stage ${v.stage}, rank ${v.rank}, assignment ${v.assignment}, seniority ${String(v.seniorityShifts)} shifts, money $${String(Math.round(v.money))}`,
      `Shift ${String(v.shift.shiftNo)} ${v.shift.onDuty ? 'on duty' : 'off duty'} (${v.slot.slot} / ${v.slot.beat}), probation shifts left ${String(v.probationShiftsLeft)}`,
      `Fatigue ${pct(w.fatigue)}, stress ${pct(w.stress)}, health ${pct(w.health)}, fitness ${pct(w.fitness)}, family ${pct(w.family)}, sleep debt ${w.sleepDebtH.toFixed(1)} h`,
      `Performance: aim x${v.performance.aimSpread.toFixed(2)}, steering lag ${v.performance.steerLagS.toFixed(2)} s, vignette ${pct(v.performance.vignette)}`,
      `Academy: ${ACADEMY_MODULES.map((m) => `${m} ${v.academy[m].best < 0 ? '--' : String(v.academy[m].best)}${v.academy[m].passed ? '*' : ''}`).join(', ')}`,
    ];
    if (v.offDuty) lines.push(`Off duty: ${v.offDuty.hoursLeft.toFixed(1)} h left before the next shift`);
    return lines.join('\n');
  };

  const setWellbeing = (s: GameSession, key: 'stress' | 'fatigue', v: number): void => {
    const career = s.phase8.career;
    const save = career.serialize();
    save.wellbeing[key] = v;
    career.restore(save);
  };

  const career: Command = {
    name: 'career',
    description: 'Career: show, set <rank>, stress <0..1>, fatigue <0..1>, shift end, offduty, academy <module|*> <score>, graduate, promote <rank> <score>, assign <unit|patrol|fto>',
    usage: '[show|set|stress|fatigue|shift|offduty|academy|graduate|promote|assign] ...',
    run: (args) => {
      const s = session();
      const p8 = s.phase8;
      const sub = args[0] ?? 'show';
      switch (sub) {
        case 'show':
          return careerShow(s);
        case 'set': {
          const rank = oneOf<CareerRank>(args[1], CAREER_RANKS, 'rank');
          const save = p8.career.serialize();
          save.rank = rank;
          if (save.stage === 'academy') save.stage = 'patrol';
          p8.career.restore(save);
          s.bus.emit('career:stage', { stage: save.stage, rank, assignment: save.assignment });
          return `Rank set to ${rank}`;
        }
        case 'stress':
        case 'fatigue':
          setWellbeing(s, sub, num(args[1], sub, 0, 1));
          return `${sub} set to ${args[1] ?? ''}`;
        case 'shift': {
          if (args[1] !== 'end') throw new Error('Usage: career shift end');
          s.fleet.request({ kind: 'endShift' });
          return 'Ending the shift (the summary opens)';
        }
        case 'offduty': {
          if (p8.career.view.offDuty === null) return 'Not off duty (career shift end first)';
          deps.presenter().openApartment();
          return 'Apartment open';
        }
        case 'academy': {
          const score = num(args[2], 'score', 0, 100);
          const modules = args[1] === '*' ? ACADEMY_MODULES : [oneOf<AcademyModule>(args[1], ACADEMY_MODULES, 'module')];
          for (const m of modules) p8.career.request({ kind: 'academyScore', module: m, score });
          drain(s);
          return `Academy score ${String(score)} recorded for ${modules.join(', ')}`;
        }
        case 'graduate':
          p8.career.request({ kind: 'graduate' });
          drain(s);
          return careerShow(s);
        case 'promote': {
          const rank = oneOf<CareerRank>(args[1], CAREER_RANKS, 'rank');
          p8.career.request({ kind: 'promotion', rank, examScore: num(args[2], 'score', 0, 100), ctx: p8.eligibility() });
          drain(s);
          return careerShow(s);
        }
        case 'assign': {
          const target = args[1];
          if (target === 'patrol') p8.career.request({ kind: 'returnToPatrol' });
          else if (target === 'fto') p8.career.request({ kind: 'applyFto', ctx: p8.eligibility() });
          else p8.career.request({ kind: 'applySpecialty', unit: oneOf<SpecialtyId>(target, SPECIALTY_IDS, 'unit'), ctx: p8.eligibility() });
          drain(s);
          return careerShow(s);
        }
        case 'report': {
          const r = deps.reportForDuty();
          return r ? `Cannot report for duty: ${r.reason}` : 'Reporting for duty...';
        }
        default:
          throw new Error(`Unknown career command '${sub}'`);
      }
    },
  };

  const world: Command = {
    name: 'world',
    description: 'Persistent world: premise [address], cases, offenders, evolve <days>, news',
    usage: '[premise|cases|offenders|evolve|news]',
    run: (args) => {
      const s = session();
      const w = s.phase8.world;
      const sub = args[0] ?? 'news';
      if (sub === 'premise') {
        const text = args.slice(1).join(' ') || s.cad.call(s.cad.playerUnit()?.callId ?? -1)?.location.text || '';
        if (text === '') return 'Name an address, or take a call first';
        const h = w.premiseHistory(text);
        if (h.length === 0) return `No history at ${text}`;
        return [`${text}: ${w.premiseFlags(text).join(', ') || 'no flags'}`, ...h.map((e) => `${e.callNumber} ${e.nature} - ${e.disposition}${e.flags.length > 0 ? ` [${e.flags.join(',')}]` : ''}`)].join('\n');
      }
      if (sub === 'cases') {
        const rows = w.cases();
        return rows.length === 0 ? 'No cases' : rows.map((c) => `${c.id} ${c.status.padEnd(8)} ${c.nature} at ${c.locationText} (${String(c.suspects.length)} suspects, ${String(c.shiftsOpen)} shifts)`).join('\n');
      }
      if (sub === 'offenders') {
        const rows = w.serialize().offenders;
        return rows.length === 0 ? 'No offenders on record' : rows.map((o) => `#${String(o.personId)} ${o.custody.padEnd(8)} arrests ${String(o.arrests)} risk ${o.risk.toFixed(2)} ${o.district}`).join('\n');
      }
      if (sub === 'evolve') {
        const days = num(args[1], 'days', 0, 60);
        const now = s.now().game;
        const trust: Record<string, number> = {};
        for (const row of s.conduct.trustRows()) trust[row.district] = row.value;
        const r = w.evolve({ fromGame: now, toGame: now + days * 86400, trust, arrestsByDistrict: s.phase8.arrestsByDistrict, addressAt: (u) => s.randomAddress(u) });
        for (const id of r.released) s.people.setCustody(id, 'released');
        for (const m of r.moves) if (m.address !== null) s.records.setAddress(m.personId, m.address);
        return `Evolved ${String(days)} day(s): ${String(r.released.length)} released, ${String(r.moves.length)} moved, ${String(r.followUps.length)} follow-ups\n${r.news.join('\n')}`;
      }
      if (sub === 'news') {
        const news = w.news();
        return news.length === 0 ? 'No news' : news.map((n) => n.text).join('\n');
      }
      throw new Error(`Unknown world command '${sub}'`);
    },
  };

  const course: Command = {
    name: 'course',
    description: 'Driving course: list, start <id>, stop',
    usage: '[list|start <id>|stop]',
    run: (args) => {
      const sub = args[0] ?? 'list';
      if (sub === 'list') return COURSES.map((c) => `${c.id.padEnd(10)} ${c.label} (par ${String(c.parTimeS)} s, ${String(c.gates.length)} gates, ${String(c.cones.length)} cones)`).join('\n');
      const s = session();
      if (sub === 'start') {
        const reason = deps.presenter().beginCourse(args[1] ?? 'basic');
        return reason ?? `Course ${args[1] ?? 'basic'} started: drive through the gates`;
      }
      if (sub === 'stop') {
        s.phase8.stopCourse();
        deps.presenter().cones?.clear();
        return 'Course stopped';
      }
      throw new Error(`Unknown course command '${sub}'`);
    },
  };

  const dispatchmode: Command = {
    name: 'dispatchmode',
    description: 'Dispatch-only mode in this session: on (manual dispatch, console) or off',
    usage: '[on|off]',
    run: (args) => {
      const s = session();
      const on = args[0] !== 'off';
      if (args[0] === undefined) return `Mode ${s.phase8.modeId}`;
      s.phase8.setMode(on ? 'dispatchOnly' : 'freePatrol');
      if (on) deps.presenter().openConsole();
      else deps.presenter().closeConsole();
      return on ? 'Dispatch-only on: manual dispatch, the console is open (Home)' : 'Dispatch-only off';
    },
  };

  const script: Command = {
    name: 'script',
    description: 'Dispatch scripts: list, run <id>, stop',
    usage: '[list|run <id>|stop]',
    run: (args) => {
      const sub = args[0] ?? 'list';
      if (sub === 'list') return availableScripts().map((sc) => `${sc.id.padEnd(16)} ${sc.name} (${String(sc.steps.length)} calls, ${String(sc.durationS)} s, generator ${sc.generator})`).join('\n');
      const s = session();
      if (sub === 'run') {
        if (s.phase8.modeId !== 'dispatchOnly') s.phase8.setMode('dispatchOnly');
        const reason = s.phase8.startScript(args[1] ?? '');
        if (reason === null) deps.presenter().openConsole();
        return reason ?? `Script ${args[1] ?? ''} running`;
      }
      if (sub === 'stop') {
        s.phase8.stopScript();
        return 'Script stopped';
      }
      throw new Error(`Unknown script command '${sub}'`);
    },
  };

  const runById = (id: string): string => {
    const s = session();
    const sc = scenarioById(id);
    if (!sc) throw new Error(`No scenario '${id}' (samples: ${SAMPLE_SCENARIOS.map((x) => x.id).join(', ')})`);
    const err = runScenario(s, sc);
    return err ?? `Scenario ${sc.name} running`;
  };

  const sandbox: Command = {
    name: 'sandbox',
    description: 'Scenario editor: open, run <id>',
    usage: '[open|run <id>]',
    run: (args) => {
      const sub = args[0] ?? 'open';
      session();
      if (sub === 'open') {
        deps.presenter().openEditor();
        return 'Scenario editor open';
      }
      if (sub === 'run') return runById(args[1] ?? '');
      throw new Error(`Unknown sandbox command '${sub}'`);
    },
  };

  const scenario: Command = {
    name: 'scenario',
    description: 'Scenarios: list, load <file> (a sample or saved scenario id) runs it in the world',
    usage: '[list|load <file>]',
    run: (args) => {
      const sub = args[0] ?? 'list';
      if (sub === 'list') return SAMPLE_SCENARIOS.map((x) => `${x.id.padEnd(18)} ${x.name}`).join('\n');
      if (sub === 'load') return runById(args[1] ?? '');
      throw new Error(`Unknown scenario command '${sub}'`);
    },
  };

  const mods: Command = {
    name: 'mods',
    description: 'Mods: list the mods applied at this page load',
    usage: '[list]',
    run: () => {
      const boot = deps.boot();
      const refs = activeModRefs();
      const lines = refs.length === 0 ? ['No mods active'] : refs.map((r) => `${r.id} ${r.modVersion} (${r.hash})`);
      for (const e of boot.errors) lines.push(`error: ${e}`);
      if (boot.safeMode) lines.push('Safe mode: mods were disabled after a failed start');
      return lines.join('\n');
    },
  };

  const coopRun: Command['run'] = (args) => {
    const sub = args[0] ?? 'status';
    const presenter = deps.presenter();
    if (sub === 'status') {
      const c = presenter.coop;
      if (!c) return 'Not in a co-op session';
      const others = c.others().map((u) => `${u.callsign}(${u.role}, ${u.status})`).join(', ');
      return `${c.connected ? 'Connected' : 'Offline'} as ${c.self} (${c.role}), host ${c.host}, ${String(c.units.size)} online, ${String(c.calls.size)} calls, rev ${String(c.revision)}${others === '' ? '' : `\nOthers: ${others}`}`;
    }
    if (sub === 'disconnect') {
      presenter.coop?.disconnect();
      return 'Disconnected';
    }
    if (sub === 'connect') {
      const [, url, room, role] = args;
      if (!url || !room) throw new Error('Usage: coop connect <ws://host:port> <room> [patrol|dispatcher|supervisor]');
      const r: NetRole = role === 'dispatcher' || role === 'supervisor' ? role : 'patrol';
      const client = new NetClient();
      client.connect(url, { t: 'hello', v: PROTOCOL_VERSION, name: 'Console', role: r, room });
      presenter.lobbyClient = client;
      presenter.lobby.open();
      return `Connecting to ${url} as ${r}...`;
    }
    throw new Error(`Unknown coop command '${sub}'`);
  };

  return [
    career,
    world,
    course,
    dispatchmode,
    script,
    sandbox,
    scenario,
    mods,
    { name: 'coop', description: 'Co-op: status, connect <url> <room> [role], disconnect', usage: '[status|connect|disconnect]', run: coopRun },
    { name: 'mp', description: 'Alias of coop: mp status', usage: '[status|connect|disconnect]', run: coopRun },
  ];
}
