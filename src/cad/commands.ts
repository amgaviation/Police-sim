/** CAD console commands: `calls`, `call <id>`, `units`, `docs [kind]`. */
import type { Command } from '../debug/console';
import type { CadState } from './cadState';
import { statusLabel } from './codes';
import { dispositionLabel } from './data';
import { DOC_KINDS, type CadDocument, type DocKind } from './documents';
import type { CadCall } from './types';

export interface CadCommandDeps {
  cad(): CadState | null;
}

const NO_CAD = 'No CAD (start a shift first).';

/** Game seconds -> "HH:MM" (time of day). */
export function clockOf(gameSeconds: number): string {
  const day = ((Math.floor(gameSeconds) % 86400) + 86400) % 86400;
  const h = Math.floor(day / 3600);
  const m = Math.floor((day % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** "C-00042" or "42" -> 42; null when not a call id. */
export function parseCallId(text: string): number | null {
  const m = /^(?:C-?)?0*(\d+)$/i.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function callLine(c: CadCall): string {
  const units = c.units.length > 0 ? c.units.join(',') : '-';
  return `${c.number} P${c.priority} ${c.nature.padEnd(24)} ${c.status.padEnd(7)} ${c.location.text} | units ${units}`;
}

export function callDetail(c: CadCall): string[] {
  const lines = [
    `${c.number} P${c.priority} ${c.nature} (${c.typeId})${c.selfInitiated ? ' self-initiated' : ''}`,
    `Status: ${c.status}${c.disposition !== null ? ` - ${dispositionLabel(c.disposition)}` : ''}`,
    `Location: ${c.location.text} (${c.location.near}), ${c.location.district}`,
    `Caller: ${c.caller.name || '-'} [${c.caller.kind}] ${c.caller.phone}`,
    `Units: ${c.units.length > 0 ? c.units.join(', ') : '-'}${c.primary !== null ? ` (primary ${c.primary})` : ''}` +
      (c.offeredTo !== null ? ` offered to ${c.offeredTo}` : ''),
    `Created ${clockOf(c.created.game)}` +
      (c.dispatched ? `, dispatched ${clockOf(c.dispatched.game)}` : '') +
      (c.firstOnScene ? `, on scene ${clockOf(c.firstOnScene.game)}` : '') +
      (c.closed ? `, closed ${clockOf(c.closed.game)}` : ''),
  ];
  for (const n of c.narrative) lines.push(`  ${clockOf(n.game)} ${n.source}: ${n.text}`);
  if (c.documents.length > 0) lines.push(`Documents: ${c.documents.join(', ')}`);
  return lines;
}

function docSummary(d: CadDocument): string {
  switch (d.kind) {
    case 'report':
      return d.title;
    case 'citation':
      return `${d.violations.map((v) => v.statuteId).join(', ')} $${d.totalFine}`;
    case 'booking':
      return `person ${d.personId}: ${d.charges.join(', ')}`;
    case 'evidence':
      return `${d.category}: ${d.description} (${d.custody.length} custody)`;
    case 'supplement':
      return `to ${d.parentId}`;
  }
}

function isDocKind(text: string): text is DocKind {
  return (DOC_KINDS as readonly string[]).includes(text);
}

export function createCadCommands(deps: CadCommandDeps): Command[] {
  return [
    {
      name: 'calls',
      description: 'List open CAD calls (P1 first, then oldest)',
      run() {
        const cad = deps.cad();
        if (!cad) return NO_CAD;
        const open = cad.openCalls();
        if (open.length === 0) return 'No open calls.';
        return open.map(callLine).join('\n');
      },
    },
    {
      name: 'call',
      description: 'Show a CAD call with its narrative',
      usage: '<id | C-00001>',
      run(args) {
        const cad = deps.cad();
        if (!cad) return NO_CAD;
        const id = parseCallId(args[0] ?? '');
        if (id === null) return 'Usage: call <id | C-00001>';
        const c = cad.call(id);
        return c ? callDetail(c).join('\n') : `No call ${args[0] ?? ''}.`;
      },
    },
    {
      name: 'units',
      description: 'List CAD units with status, call and AVL position',
      run() {
        const cad = deps.cad();
        if (!cad) return NO_CAD;
        const units = cad.units();
        if (units.length === 0) return 'No units.';
        return units
          .map((u) => {
            const call = u.callId !== null ? (cad.call(u.callId)?.number ?? `#${u.callId}`) : '-';
            const emergency = u.emergency ? ' EMERGENCY' : '';
            return `${u.callsign.padEnd(4)} ${statusLabel(u.status).padEnd(22)} ${call.padEnd(8)} ${u.officer} ` +
              `(${u.kind}, ${u.beat}) @ ${u.x.toFixed(0)}, ${u.z.toFixed(0)}${emergency}`;
          })
          .join('\n');
      },
    },
    {
      name: 'docs',
      description: 'List CAD documents',
      usage: `[${DOC_KINDS.join('|')}]`,
      run(args) {
        const cad = deps.cad();
        if (!cad) return NO_CAD;
        const kind = args[0];
        if (kind !== undefined && !isDocKind(kind)) return `Unknown kind "${kind}" (${DOC_KINDS.join(', ')}).`;
        const docs = cad.docs.list(kind);
        if (docs.length === 0) return 'No documents.';
        return docs
          .map((d) => `${d.id.padEnd(10)} ${d.kind.padEnd(10)} ${d.status.padEnd(5)} ` +
            `${d.callId !== null ? `call ${d.callId}` : '-'} ${docSummary(d)}`)
          .join('\n');
      },
    },
  ];
}
