import type { Command } from '../debug/console';
import { formatDate } from '../records/calendar';
import { displayName } from '../records/person';
import { itemDef } from './items';
import type { Population } from './population';
import { DRUG_KINDS, type DrugKind } from './types';

/** Debug console commands of the people module: `who`, `intox`. */

function need(p: Population | null): Population {
  if (p === null) throw new Error('No game running');
  return p;
}

function parseId(text: string | undefined, usage: string): number {
  if (text === undefined || !/^\d+$/.test(text)) throw new Error(`Usage: ${usage}`);
  return Number(text);
}

export function createPeopleCommands(deps: { people(): Population | null }): Command[] {
  return [
    {
      name: 'who',
      description: 'Show the in-world identity, state and carried items of a person',
      usage: '<id>',
      run(args) {
        const pop = need(deps.people());
        const id = parseId(args[0], 'who <id>');
        const i = pop.identity(id);
        const s = pop.state(id);
        const r = i.record;
        const lines = [
          `${displayName(r)}  #${id}  ${r.sex}  age ${i.age}${i.juvenile ? ' (juvenile)' : ''}  DOB ${formatDate(r.dob)}  ${r.heightCm} cm  hair ${r.hair}`,
          `  employer ${i.employer}   vehicle ${i.vehicleId < 0 ? 'none' : `#${i.vehicleId}`}   address ${r.address}`,
          `  temperament ${i.temperament}   honesty ${i.honesty.toFixed(2)}   attitude ${i.attitude.toFixed(2)}   risk ${i.risk.toFixed(2)}`,
          `  language ${i.language.label} (english ${i.language.english})   hearing ${i.hearing}   dementia ${i.dementia ? 'yes' : 'no'}   mental ${i.mental}`,
          `  health ${i.health.join(', ') || 'none'}   drinker ${i.drinker.toFixed(2)}   drug use ${i.drugUse}   wanted ${i.wanted ? 'yes' : 'no'}`,
          `  wearing ${i.appearance.topName} top, ${i.appearance.bottomName}`,
          `  family ${i.family.map((f) => `${f.relation} #${f.personId}`).join(', ') || 'none'}${i.guardianId >= 0 ? `   guardian #${i.guardianId}` : ''}`,
          `  state  bac ${s.intoxication.bac.toFixed(3)} drug ${s.intoxication.drug} level ${s.intoxication.level.toFixed(2)}  mood ${s.mood.toFixed(2)}  custody ${s.custody}  injured ${s.injured.toFixed(2)}${s.deceased ? '  DECEASED' : ''}${s.missing ? '  MISSING' : ''}`,
        ];
        const h = pop.officerHistory(id);
        if (h.count > 0) lines.push(`  contacts ${h.count}  last "${h.lastOutcome}"  rapport ${h.rapport.toFixed(2)}`);
        const items = pop.itemsOn(id);
        lines.push(
          items.length === 0
            ? '  items  none'
            : `  items  ${items.map((it) => `${itemDef(it.item).label} [${it.where}${it.visible ? ', visible' : ''}]`).join('; ')}`,
        );
        const st = pop.statements(id).length;
        const fc = pop.facts(id).length;
        if (st + fc > 0) lines.push(`  statements ${st}  facts ${fc}`);
        return lines.join('\n');
      },
    },
    {
      name: 'intox',
      description: 'Set the blood alcohol (and optionally drug influence) of a person',
      usage: '<id> <bac> [drug]',
      run(args) {
        const pop = need(deps.people());
        const usage = `intox <id> <bac> [${DRUG_KINDS.join('|')}]`;
        const id = parseId(args[0], usage);
        const bac = Number(args[1]);
        if (args[1] === undefined || !Number.isFinite(bac) || bac < 0 || bac > 0.6) throw new Error(`Usage: ${usage}  (bac 0 to 0.6)`);
        const drug = (args[2] ?? 'none') as DrugKind;
        if (!DRUG_KINDS.includes(drug)) throw new Error(`Usage: ${usage}`);
        pop.setIntoxication(id, bac, drug);
        const s = pop.intoxication(id);
        return `#${id}: bac ${s.bac.toFixed(3)} drug ${s.drug} level ${s.level.toFixed(2)}`;
      },
    },
  ];
}
