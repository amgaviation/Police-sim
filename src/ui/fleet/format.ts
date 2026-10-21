/** Text helpers of the fleet UI (Phase 7 §12.3, §12.6). Pure. */

/** '$ 2 640': whole game dollars with a space between thousands (negative values keep the sign in front). */
export function formatMoney(dollars: number): string {
  const n = Math.round(Number.isFinite(dollars) ? dollars : 0);
  const digits = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${n < 0 ? '-' : ''}$ ${digits}`;
}

/** Career points with an explicit sign: '-12', '0'. */
export function formatPoints(points: number): string {
  const n = Math.round(Number.isFinite(points) ? points : 0);
  return n === 0 ? '0' : String(n);
}

/** '80 %' from a 0..1 fraction. */
export function formatPercent(fraction: number): string {
  return `${String(Math.round((Number.isFinite(fraction) ? fraction : 0) * 100))} %`;
}
