/** Small canvas shapes for the scenario editor. */

/** Fills a five-pointed star (or `points`-pointed) centred at (x, y) with outer radius `r`. */
export function fillStar(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, points = 5): void {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const radius = i % 2 === 0 ? r : r * 0.45;
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    const px = x + Math.cos(a) * radius;
    const py = y + Math.sin(a) * radius;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
}

/** A dashed circle outline (hidden / concealed things). */
export function dashedOutline(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, colour: string): void {
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}
