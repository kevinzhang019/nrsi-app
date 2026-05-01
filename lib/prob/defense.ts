import type { PaOutcomes } from "../mlb/splits";

/**
 * Reweight the in-play block of the per-PA multinomial using a defensive
 * multiplier from the seven non-battery fielders' OAA.
 *
 * Mass conservation:
 *   in-play total = (1B + 2B + 3B + ipOut)  ← preserved exactly
 *   hits          = (1B + 2B + 3B)
 *   newHits       = hits × factor          (better defense → smaller factor → fewer hits)
 *   newIpOut      = ipOut + (hits − newHits)  (mass moves from hits to ipOut)
 *
 * Hits are reapportioned among 1B/2B/3B in proportion to their original
 * weights, so doubles and triples don't disappear when factor < 1 — they
 * shrink proportionally.
 *
 * K, BB, HBP, HR are battery outcomes and are not affected by fielding.
 *
 * Identity: factor = 1 → output equals input exactly.
 */
export function applyDefense(pa: PaOutcomes, factor: number): PaOutcomes {
  if (factor === 1) return { ...pa };
  const hits = pa.single + pa.double + pa.triple;
  if (hits <= 0) return { ...pa };

  const newHits = hits * factor;
  const delta = hits - newHits; // positive when factor < 1 (good defense)

  const ratio = newHits / hits;
  const out: PaOutcomes = {
    single: pa.single * ratio,
    double: pa.double * ratio,
    triple: pa.triple * ratio,
    hr: pa.hr,
    bb: pa.bb,
    hbp: pa.hbp,
    k: pa.k,
    ipOut: pa.ipOut + delta,
  };
  // Safety renormalize in case of floating-point drift; should already sum to 1.
  const total =
    out.single + out.double + out.triple + out.hr + out.bb + out.hbp + out.k + out.ipOut;
  if (total > 0 && Math.abs(total - 1) > 1e-9) {
    (Object.keys(out) as (keyof PaOutcomes)[]).forEach((key) => {
      out[key] = out[key] / total;
    });
  }
  return out;
}
