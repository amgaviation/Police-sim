/** Effects quality levels (`graphics.effects` setting): off draws nothing, low skips cones and pools. */
export const EFFECTS_QUALITY = ['off', 'low', 'high'] as const;
export type EffectsQuality = (typeof EFFECTS_QUALITY)[number];

/** One-shot particle kinds (`VfxSystem.burst`). */
export const VFX_PARTICLE_KINDS = ['spark', 'dust', 'muzzle', 'taser', 'splash'] as const;
export type VfxParticleKind = (typeof VFX_PARTICLE_KINDS)[number];

/**
 * Receiver of lamp positions from `CarRenderer.update` (presentation only). `VfxSystem.glowSink` implements it;
 * a renderer without a sink behaves exactly as before.
 */
export interface GlowSink {
  /** Called once at the start of CarRenderer.update. */
  begin(): void;
  /** A lit lamp: world position, linear RGB (0..1+), kind 0 = light-bar segment, 1 = head lamp, 2 = tail / brake lamp. */
  glow(x: number, y: number, z: number, r: number, g: number, b: number, kind: number): void;
  /** A car with its light bar on: ground pool centre (x, z) and the mean colour of its lit segments. */
  pool(x: number, z: number, r: number, g: number, b: number): void;
  /** A car with headlights on: lamp-pair centre and unit forward direction (world). */
  beam(x: number, y: number, z: number, dx: number, dy: number, dz: number): void;
  /** Called once at the end of CarRenderer.update. */
  end(): void;
}
