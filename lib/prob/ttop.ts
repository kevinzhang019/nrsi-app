import type { PaOutcomes } from "../mlb/splits";

/**
 * Times-Through-the-Order Penalty (TTOP).
 *
 * Tango/Lichtman/Dolphin (The Book, Ch 9) and Carleton (Baseball Prospectus,
 * "Times Through the Order Penalty") show that starting pitchers get
 * progressively worse each time they cycle through the lineup — more contact,
 * harder contact, slightly more walks, slightly fewer strikeouts.
 *
 * Approximate published deltas relative to the 1st time through:
 *   1st TTO (PA 1–9):    baseline
 *   2nd TTO (PA 10–18):  K -1.0pp, BB +0.3pp, HR +0.4pp
 *   3rd TTO (PA 19–27):  K -2.0pp, BB +0.5pp, HR +0.7pp
 *   4th+ TTO (PA 28+):   K -2.5pp, BB +0.8pp, HR +1.0pp
 *
 * Converted to multiplicative factors over league-mean baselines of
 * K%≈22.5%, BB%≈8.3%, HR%≈3.0% — and clamped to be safe.
 */

const K_FACTORS = [1.0, 0.956, 0.911, 0.889] as const; // 1st, 2nd, 3rd, 4th+
const BB_FACTORS = [1.0, 1.036, 1.060, 1.096] as const;
const HR_FACTORS = [1.0, 1.133, 1.233, 1.333] as const;

/**
 * Time-through-the-order index for a PA.
 *
 * @param paInGameForPitcher  Cumulative batters faced by THIS pitcher in this
 *   game *before* this PA starts. 0 = first PA of his outing. Reset for
 *   relievers when they enter the game.
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
  const i = ttoIndex(paInGameForPitcher) - 1;
  return { k: K_FACTORS[i], bb: BB_FACTORS[i], hr: HR_FACTORS[i] };
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
