import type { CockpitState } from '../../src/render/police/cockpitParts';

export interface FakeCtx {
  texts: string[];
  fills: number;
  fillStyle: string;
  font: string;
  textAlign: string;
  textBaseline: string;
  fillRect(): void;
  fillText(text: string): void;
}

/** A canvas stand-in for node: `getContext('2d')` returns a recorder of the calls the painters make. */
export function fakeCanvas(width: number, height: number): { canvas: HTMLCanvasElement; ctx: FakeCtx } {
  const ctx: FakeCtx = {
    texts: [],
    fills: 0,
    fillStyle: '',
    font: '',
    textAlign: '',
    textBaseline: '',
    fillRect() {
      this.fills++;
    },
    fillText(text: string) {
      this.texts.push(text);
    },
  };
  const canvas = { width, height, getContext: () => ctx } as unknown as HTMLCanvasElement;
  return { canvas, ctx };
}

export function cockpitState(over: Partial<CockpitState> = {}): CockpitState {
  return {
    sirenOn: false,
    tone: 0,
    horn: false,
    lightsOn: false,
    pattern: 0,
    spotOn: false,
    rackLocked: true,
    racked: [true, true],
    caged: false,
    radioChannel: 'Dispatch 1',
    radioTx: false,
    radioRx: false,
    scanning: false,
    emergency: false,
    ...over,
  };
}
