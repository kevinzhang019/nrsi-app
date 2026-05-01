import type { PaOutcomes } from "../mlb/splits";

/**
 * Reweight the K and BB cells of the per-PA multinomial using catcher framing
 * factors. Top framers steal called strikes (K up, BB down); bad framers do
 * the opposite. 1B/2B/3B/HR/HBP are not affected at the multiplier level.
 *
 * Multipliers are applied before renormalization so the multinomial still
 * sums to 1 — mass that flows out of (K, BB) is absorbed proportionally
 * across the remaining cells, primarily in `ipOut`.
 *
 * Identity: factor.k === 1 && factor.bb === 1 → output equals input exactly.
 */
export function applyFraming(
  pa: PaOutcomes,
  factor: { k: number; bb: number },
): PaOutcomes {
  if (factor.k === 1 && factor.bb === 1) return { ...pa };
  const adj: PaOutcomes = {
    single: pa.single,
    double: pa.double,
    triple: pa.triple,
    hr: pa.hr,
    bb: pa.bb * factor.bb,
    hbp: pa.hbp,
    k: pa.k * factor.k,
    ipOut: pa.ipOut,
  };
  const total =
    adj.single + adj.double + adj.triple + adj.hr + adj.bb + adj.hbp + adj.k + adj.ipOut;
  if (total <= 0) return { ...pa };
  (Object.keys(adj) as (keyof PaOutcomes)[]).forEach((key) => {
    adj[key] = adj[key] / total;
  });
  return adj;
}
