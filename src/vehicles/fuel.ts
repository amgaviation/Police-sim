import type { FuelSpec } from './model';

/** Litres burnt in `dt` seconds with the engine running and delivering `engineKw`. */
export function fuelBurnLiters(engineKw: number, dt: number, fuel: FuelSpec): number {
  return ((fuel.idleLph + fuel.litersPerKWh * (engineKw > 0 ? engineKw : 0)) * dt) / 3600;
}
