import type { PaOutcomes } from "./splits";

/**
 * Per-PA outcome aging adjustment (one year of aging).
 *
 * Published projection systems — Marcel (Tango), Steamer (Cross/Davidson/
 * Rosenbloom), ZiPS (Szymborski), THE BAT X (Carty) — all carry an explicit
 * aging step. nrXi previously had none, leaving age-blind prior-season data
 * dominate veteran rates and miss the in-season uplift of pre-peak hitters.
 *
 * Marcel's headline numbers (`https://www.baseball-reference.com/about/marcels.shtml`):
 *   +0.006 wOBA / year below age 29
 *   -0.003 wOBA / year at/above age 29
 *
 * FanGraphs aging-curve series shows plate-discipline ages differently from
 * power and contact:
 *   - HR/power peaks ~26-29, declines past 30 (~3-4% / yr above 32)
 *   - K rate rises with age (worse bat speed in late 30s)
 *   - BB rate climbs slightly with experience but flattens
 *
 * Pitchers age opposite at the team-allowed-rate level (older pitchers allow
 * more HR / fewer K) — but our `pitcher.paVs` rates already represent "rates
 * the pitcher allowed last year." So the same forward-projection mechanics
 * apply, just with the role-specific magnitudes below.
 *
 * Magnitudes are small (≤ 5%/yr in extreme age regimes) and clamped — this is
 * an unbias step, not a hot take.
 */

export type Role = "batter" | "pitcher";

/** Reference peak age — symmetric reflection point for the curve. */
const BATTER_PEAK = 27;
const PITCHER_PEAK = 28;

/**
 * Per-outcome year-over-year aging slopes (multiplicative). Each entry is the
 * fractional change applied PER YEAR away from peak. Positive sign = factor
 * increases above peak (e.g., K rate goes up past 30 for batters); negative
 * sign = factor decreases above peak (HR power fades).
 *
 * The model: factor = clamp(1 + slope × max(0, age − peak), [floor, ceil]).
 * Below peak we mirror with a smaller slope (development is gradual).
 */
type Slopes = Record<keyof PaOutcomes, { above: number; below: number }>;

const BATTER_SLOPES: Slopes = {
  // Power components fade past peak; develop slightly toward peak.
  hr: { above: -0.030, below: -0.010 },
  triple: { above: -0.020, below: -0.005 },
  double: { above: -0.015, below: -0.005 },
  // Singles and walks shift mildly — older batters draw more BB; bat speed slows.
  single: { above: -0.005, below: -0.002 },
  bb: { above: +0.005, below: -0.005 },
  hbp: { above: 0, below: 0 },
  // K rate rises with age (slower reactions in late 30s); declines through peak.
  k: { above: +0.010, below: -0.005 },
  ipOut: { above: 0, below: 0 }, // residual, recomputed after renormalize
};

const PITCHER_SLOPES: Slopes = {
  // Older pitchers allow more HR, fewer K — opposite-direction power decay.
  hr: { above: +0.030, below: +0.010 },
  triple: { above: +0.020, below: +0.005 },
  double: { above: +0.015, below: +0.005 },
  single: { above: +0.005, below: +0.002 },
  bb: { above: +0.010, below: -0.005 }, // command slips with age
  hbp: { above: 0, below: 0 },
  k: { above: -0.015, below: +0.005 }, // K rate falls past peak (velo loss)
  ipOut: { above: 0, below: 0 },
};

/** Cap on any single-outcome multiplier so a young or old player can't blow up. */
const FLOOR = 0.85;
const CEIL = 1.15;

function clamp(v: number): number {
  if (!Number.isFinite(v)) return 1;
  if (v < FLOOR) return FLOOR;
  if (v > CEIL) return CEIL;
  return v;
}

/**
 * Year-over-year aging multipliers for a given age. Apply to PRIOR-year rates
 * to project them forward to the current age. Apply with multiplicative
 * scaling + renormalize.
 *
 * @param currentAge  Player's age now (this season). The aging delta is
 *   `currentAge - (peak)` — past-peak ages get the "above" slope, pre-peak
 *   get the "below" slope.
 */
export function agingMultipliers(currentAge: number | undefined, role: Role): {
  single: number; double: number; triple: number; hr: number;
  bb: number; hbp: number; k: number;
} {
  if (currentAge === undefined || !Number.isFinite(currentAge)) {
    return identity();
  }
  const peak = role === "batter" ? BATTER_PEAK : PITCHER_PEAK;
  const delta = currentAge - peak;
  const slopes = role === "batter" ? BATTER_SLOPES : PITCHER_SLOPES;
  const factor = (key: keyof PaOutcomes): number => {
    const s = slopes[key];
    const yrs = Math.abs(delta);
    const slope = delta >= 0 ? s.above : s.below;
    // For ages below peak the slope sign convention means "factor < 1 farther
    // from peak"; mirror so |yrs| always grows the factor in the slope direction.
    const m = 1 + (delta >= 0 ? slope * yrs : -slope * yrs);
    return clamp(m);
  };
  return {
    single: factor("single"),
    double: factor("double"),
    triple: factor("triple"),
    hr: factor("hr"),
    bb: factor("bb"),
    hbp: factor("hbp"),
    k: factor("k"),
  };
}

function identity() {
  return { single: 1, double: 1, triple: 1, hr: 1, bb: 1, hbp: 1, k: 1 };
}

/**
 * Apply 1 year of aging to a per-PA outcome distribution (i.e., project
 * prior-year rates forward to current age). Multiplies and renormalizes;
 * preserves sum-to-1.
 */
export function applyAging(pa: PaOutcomes, currentAge: number | undefined, role: Role): PaOutcomes {
  if (currentAge === undefined) return pa;
  const m = agingMultipliers(currentAge, role);
  const adj: PaOutcomes = {
    single: pa.single * m.single,
    double: pa.double * m.double,
    triple: pa.triple * m.triple,
    hr: pa.hr * m.hr,
    bb: pa.bb * m.bb,
    hbp: pa.hbp * m.hbp,
    k: pa.k * m.k,
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

/** Crude birthDate → age helper for clients that have only the birthDate. */
export function ageFromBirthDate(birthDate: string | undefined, now: Date = new Date()): number | undefined {
  if (!birthDate) return undefined;
  const d = new Date(birthDate);
  if (Number.isNaN(d.getTime())) return undefined;
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age -= 1;
  return age;
}

export const __testing = { BATTER_SLOPES, PITCHER_SLOPES, BATTER_PEAK, PITCHER_PEAK };
