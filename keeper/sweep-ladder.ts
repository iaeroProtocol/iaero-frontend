// Escalating per-token slippage ladder for the Tier-3 cleanup sweep.
//
// Each sweep pass widens the tolerance, so a token that fails at a tight bound gets
// progressively looser retries instead of the old identical-params retry (which
// could only ever fail the same way). The rung is passed to BOTH the 0x quote (so
// its embedded minOut matches) AND the contract-side step. Tops out at
// MAX_SWEEP_SLIPPAGE_BPS (10%), which is the last rung here.
//
// Kept in its own tiny module (not the vendored swap-pipeline.ts) so it can be unit
// tested without importing index.ts (which runs main() on import).
export const SWEEP_SLIPPAGE_LADDER_BPS = [100, 300, 500, 800, 1000]; // 1 / 3 / 5 / 8 / 10 %

/**
 * Slippage rung (bps) for a given 1-indexed sweep pass. Clamps to the top rung when
 * `pass` exceeds the ladder length (e.g. if MAX_SWEEPS is overridden upward via env).
 */
export function sweepSlippageForPass(pass: number): number {
  const idx = Math.min(Math.max(pass, 1) - 1, SWEEP_SLIPPAGE_LADDER_BPS.length - 1);
  return SWEEP_SLIPPAGE_LADDER_BPS[idx];
}
