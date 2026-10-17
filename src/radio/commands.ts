/** Radio console command: `radio say <channel> <text>`, `radio channel <id>`, `radio scan`, `radio log [n]`. */
import type { Command } from '../debug/console';
import { isChannelId, RADIO_CONFIG } from './data';
import type { RadioSystem } from './radioSystem';
import type { Transmission } from './types';

export interface RadioCommandDeps {
  radio(): RadioSystem | null;
}

const USAGE = 'say <channel> <text> | channel <id> | scan | log [n]';
const CHANNELS = RADIO_CONFIG.channels.map((c) => c.id).join(', ');

export function formatTransmission(tx: Transmission): string {
  const flags = `${tx.blocked ? ' [BLOCKED]' : ''}${tx.priority ? ' [PRIORITY]' : ''}${tx.audible ? '' : ' (not heard)'}`;
  return `${tx.clock} ${tx.channel.padEnd(8)} ${tx.speaker}: ${tx.text}${flags}`;
}

export function createRadioCommands(deps: RadioCommandDeps): Command[] {
  return [
    {
      name: 'radio',
      description: 'Radio: queue a line, select a channel, toggle scan, show the log',
      usage: USAGE,
      run(args) {
        const radio = deps.radio();
        if (!radio) throw new Error('No game running');
        const verb = args[0];
        switch (verb) {
          case 'say': {
            const ch = args[1];
            const text = args.slice(2).join(' ').trim();
            if (!isChannelId(ch) || text === '') throw new Error(`Usage: radio say <channel> <text> (channels: ${CHANNELS})`);
            radio.say(ch, text);
            return `Queued on ${ch}`;
          }
          case 'channel': {
            const ch = args[1];
            if (ch === undefined) return `Selected ${radio.selected}${radio.scanning ? ` (scanning ${radio.scanList.join(', ')})` : ''}`;
            if (!isChannelId(ch)) throw new Error(`Unknown channel "${ch}" (channels: ${CHANNELS})`);
            radio.selectChannel(ch);
            return `Selected ${ch}`;
          }
          case 'scan':
            radio.toggleScan();
            return `Scan ${radio.scanning ? 'on' : 'off'} (${radio.scanList.join(', ')})`;
          case 'log': {
            const n = args[1] === undefined ? 10 : Number(args[1]);
            if (!Number.isInteger(n) || n < 1) throw new Error('Usage: radio log [n]');
            const lines = radio.log.slice(-n).map(formatTransmission);
            return lines.length > 0 ? lines.join('\n') : 'Radio log is empty';
          }
          default:
            throw new Error(`Usage: radio ${USAGE}`);
        }
      },
    },
  ];
}
