/** Console command of the call catalog: `catalog stats|families|type <id>`. */
import type { Command } from '../debug/console';
import { CALL_CATALOG, callTypeDef, familyForType } from './catalog';

const USAGE = 'Usage: catalog stats | families | type <id>';

function stats(): string {
  const c = CALL_CATALOG;
  const generated = c.types.filter((t) => t.generated).length;
  const outcomes = c.families.reduce((n, f) => n + f.outcomes.length, 0);
  return [
    `${c.types.length} Phase 3 call types (${generated} generated) in ${c.families.length} families`,
    `${c.actions.length} actions, ${c.services.length} services, ${outcomes} outcomes, ${Object.keys(c.legacy).length} legacy types`,
  ].join('\n');
}

function families(): string {
  return CALL_CATALOG.families
    .map((f) => {
      const n = CALL_CATALOG.types.filter((t) => t.family === f.id).length;
      const legacy = Object.entries(CALL_CATALOG.legacy).filter(([, fam]) => fam === f.id).length;
      return `${f.id.padEnd(16)} ${String(n).padStart(3)} types${legacy > 0 ? ` +${legacy} legacy` : ''}, ${f.branches.length} branches, ${f.outcomes.length} outcomes${f.derived ? ' (derived)' : ''}`;
    })
    .join('\n');
}

function typeInfo(id: string): string {
  const t = callTypeDef(id);
  const f = familyForType(id);
  if (!f) return `No scene family for "${id}".`;
  const lines = [`${id}: family ${f.id}, anchor ${f.anchor}${t ? `, ${t.generated ? 'generated' : 'manual'}, weight ${t.weight}, category ${t.category}` : ' (Phase 2 type)'}`];
  lines.push(`Roles: ${f.roles.map((r) => `${r.role}(${r.count[0]}-${r.count[1]})`).join(', ') || '-'}`);
  lines.push(`Branches: ${f.branches.map((b) => `${b.id} ${t?.branchWeights[b.id] ?? b.weight}`).join(', ')}`);
  lines.push(`Actions: ${f.actions.join(', ') || '-'}`);
  lines.push(`Outcomes: ${f.outcomes.map((o) => `${o.id}->${o.disposition}`).join(', ')}`);
  return lines.join('\n');
}

export function createCallsCommands(): Command[] {
  return [
    {
      name: 'catalog',
      description: 'Call catalog: stats, families, or one type',
      usage: 'stats | families | type <id>',
      run(args) {
        switch (args[0]) {
          case 'stats':
            return stats();
          case 'families':
            return families();
          case 'type':
            return args[1] ? typeInfo(args[1]) : USAGE;
          default:
            return USAGE;
        }
      },
    },
  ];
}
