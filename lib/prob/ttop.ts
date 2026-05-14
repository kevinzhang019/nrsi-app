import type { PaOutcomes } from "../mlb/splits";

/**
 * Times-Through-the-Order Penalty (TTOP) — smooth pitch-/PA-count spec.
 *
 * Two-literature problem:
 *
 *   - Tango/Lichtman/Dolphin (The Book, Ch 9) and Carleton (Baseball Prospectus)
 *     document a progressive degradation each time a starter cycles through —
 *     more contact, harder contact, slightly more walks, slightly fewer Ks.
 *     Approximate published deltas relative to the 1st pass:
 *       end of 2nd pass:  K -1.0pp, BB +0.3pp, HR +0.4pp
 *       end of 3rd pass:  K -2.0pp, BB +0.5pp, HR +0.7pp
 *       4th+ pass:        K -2.5pp, BB +0.8pp, HR +1.0pp
 *     vs league means K%≈22.5%, BB%≈8.3%, HR/PA≈3.0%.
 *
 *   - Brill, Deshpande & Wyner ("Bayesian analysis of the times through the
 *     order penalty", JQAS 2023) controlled for batter/pitcher quality and
 *     home-field and found the apparent *discontinuous* jump between the 2nd
 *     and 3rd time through largely disappears. What remains is a smooth
 *     within-game decline that Carleton's later work attributes to pitch count.
 *
 * Resolution: we keep the magnitudes from the consensus literature but ditch
 * the step function. The multiplicative factor on each rate is a linear
 * function of `paInGameForPitcher`, fit to land on Lichtman's values at the
 * midpoints of the old buckets (PA 13 / 22 / 31). Clamped so a pitcher who
 * keeps getting trotted out into the 5th time through doesn't run away.
 *
 * Slopes:
 *   K:  -0.0040 / PA   → at PA 22 (mid-3rd-pass) factor ≈ 0.912 (matches old 0.911)
 *   BB: +0.0030 / PA   → at PA 22 factor ≈ 1.066 (matches old 1.060)
 *   HR: +0.0110 / PA   → at PA 22 factor ≈ 1.242 (matches old 1.233)
 *
 * Clamps: K ∈ [0.85, 1.0], BB ∈ [1.0, 1.15], HR ∈ [1.0, 1.45].
 */

const K_SLOPE = -0.0040;
const BB_SLOPE = 0.0030;
const HR_SLOPE = 0.0110;

const K_FLOOR = 0.85;
const BB_CEIL = 1.15;
const HR_CEIL = 1.45;

/**
 * Coarse 1/2/3/4 bucket label, retained for display and back-compat callers
 * (e.g. log lines and the legacy ttop.test.ts). The probability model itself
 * no longer steps off these bucket boundaries — see `ttopFactors`.
 */
export function ttoIndex(paInGameForPitcher: number): 1 | 2 | 3 | 4 {
  if (paInGameForPitcher < 9) return 1;
  if (paInGameForPitcher < 18) return 2;
  if (paInGameForPitcher < 27) return 3;
  return 4;
}

export function ttopFactors(paInGameForPitcher: number): {
  k: number;
  bb: number;
  hr: number;
} {
  const pa = Math.max(0, paInGameForPitcher);
  const k = Math.max(K_FLOOR, 1 + K_SLOPE * pa);
  const bb = Math.min(BB_CEIL, 1 + BB_SLOPE * pa);
  const hr = Math.min(HR_CEIL, 1 + HR_SLOPE * pa);
  return { k, bb, hr };
}

/**
 * Apply TTOP factors to a per-PA multinomial. Renormalize so the result still
 * sums to 1. K shrinks (mass goes to ipOut/contact), BB and HR grow (mass
 * comes from ipOut). 1B/2B/3B/HBP unchanged at the multiplier level.
 */
export function applyTtop(pa: PaOutcomes, paInGameForPitcher: number): PaOutcomes {
  const f = ttopFactors(paInGameForPitcher);
  const adj: PaOutcomes = {
    single: pa.single,
    double: pa.double,
    triple: pa.triple,
    hr: pa.hr * f.hr,
    bb: pa.bb * f.bb,
    hbp: pa.hbp,
    k: pa.k * f.k,
    ipOut: pa.ipOut,
  };
  const total =
    adj.single + adj.double + adj.triple + adj.hr + adj.bb + adj.hbp + adj.k + adj.ipOut;
  if (total <= 0) return pa;
  (Object.keys(adj) as (keyof PaOutcomes)[]).forEach((key) => {
    adj[key] = adj[key] / total;
  });
  return adj;
}

export const __testing = { K_SLOPE, BB_SLOPE, HR_SLOPE, K_FLOOR, BB_CEIL, HR_CEIL };
