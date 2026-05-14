/**
 * Calibration shim for nrXi predictions, stratified by inning state.
 *
 * The Log5 + Markov chain produces a structurally-correct probability, but
 * any model that takes inputs noisier than the true world will be miscalibrated
 * at the margins. This shim applies a monotone post-hoc transform so the
 * model's probability estimates match observed frequencies in production.
 *
 * Stratification: the run-distribution per inning differs systematically —
 * inning 1 is lineup-position-dependent (top of order), 7-9 is reliever-mix-
 * dependent, 10+ is Manfred-runner-dependent. A single global isotonic fit
 * under-calibrates the tails. We bin into:
 *   - "1"      — inning 1 (lineup-leadoff distribution)
 *   - "2-6"    — innings 2 through 6 (starter-dominant, standard run-expectancy)
 *   - "7-9"    — innings 7 through 9 (reliever-dominant, leverage-heavy)
 *   - "10+"    — extras with Manfred runner on 2nd
 * Each bin × half ("Top" / "Bottom") can carry its own calibrator. When a bin
 * is missing from the loaded table, falls through to "global", then identity.
 *
 * V1 ships all bins as identity — there is no production data yet. Once ≥1k
 * (predicted, actual) pairs exist per bin (Supabase `inning_predictions`
 * archive), fit isotonic regression per bin and load the resulting JSON map
 * via `loadCalibrator(map)`.
 *
 * To fit: run `pnpm tsx scripts/calibrate.ts` (creates the stratified table) and
 * commit the resulting JSON. The function below reads from CALIBRATORS if set;
 * falls through to identity otherwise.
 *
 * Reference: Niculescu-Mizil & Caruana, "Predicting Good Probabilities with
 * Supervised Learning" (ICML 2005). Isotonic > Platt for tree-shaped errors.
 * Beta calibration (Kull et al. 2017) is a small-sample fallback we may swap
 * in if any per-bin table is below 1k samples at deploy time.
 */

export type CalibratorTable = {
  // Sorted ascending by `pred`. Apply piecewise-linear interpolation between
  // consecutive points; clamp at the endpoints.
  points: Array<{ pred: number; actual: number }>;
};

export type InningBucket = "1" | "2-6" | "7-9" | "10+";
export type HalfBucket = "Top" | "Bottom";

export type CalibrationContext = {
  inning?: number;
  half?: HalfBucket | string | null;
};

/** Per-(inning_bucket, half) calibration tables. Keyed `"${bucket}-${half}"`. */
export type CalibrationMap = Record<string, CalibratorTable>;

let CALIBRATORS: CalibrationMap | null = null;

/** Bucket an inning into one of the four strata. Defaults to "2-6". */
export function inningBucket(inning: number | undefined): InningBucket {
  if (inning === undefined || !Number.isFinite(inning)) return "2-6";
  if (inning <= 1) return "1";
  if (inning >= 10) return "10+";
  if (inning >= 7) return "7-9";
  return "2-6";
}

function normalizeHalf(half: string | null | undefined): HalfBucket | null {
  if (half === "Top" || half === "Bottom") return half;
  if (typeof half === "string") {
    const lo = half.toLowerCase();
    if (lo === "top") return "Top";
    if (lo === "bottom") return "Bottom";
  }
  return null;
}

function keyForCtx(ctx: CalibrationContext | undefined): string | null {
  if (!ctx) return null;
  const half = normalizeHalf(ctx.half);
  if (!half) return null;
  const bucket = inningBucket(ctx.inning);
  return `${bucket}-${half}`;
}

function lookup(ctx: CalibrationContext | undefined): CalibratorTable | null {
  if (!CALIBRATORS) return null;
  const k = keyForCtx(ctx);
  if (k && CALIBRATORS[k]) return CALIBRATORS[k];
  // Fallbacks: bucket-only, then "global", then null (identity).
  const bucket = inningBucket(ctx?.inning);
  if (CALIBRATORS[bucket]) return CALIBRATORS[bucket];
  if (CALIBRATORS.global) return CALIBRATORS.global;
  return null;
}

/** Apply a monotone calibration. Returns p unchanged if no relevant table is loaded. */
export function calibrate(p: number, ctx?: CalibrationContext): number {
  const table = lookup(ctx);
  if (!table || table.points.length < 2) return clamp01(p);
  const pts = table.points;
  if (p <= pts[0].pred) return clamp01(pts[0].actual);
  if (p >= pts[pts.length - 1].pred) return clamp01(pts[pts.length - 1].actual);
  // Binary search for surrounding points.
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].pred <= p) lo = mid;
    else hi = mid;
  }
  const a = pts[lo];
  const b = pts[hi];
  const t = (p - a.pred) / (b.pred - a.pred);
  return clamp01(a.actual + t * (b.actual - a.actual));
}

/**
 * Inject a fitted table at app boot. Accepts:
 *   - `null` to clear all calibrators (identity everywhere)
 *   - A single `CalibratorTable` — treated as the global default, applied to
 *     all (inning, half) combinations that don't have a specific override
 *   - A `CalibrationMap` keyed by `"${bucket}-${half}"` or just bucket / "global"
 *
 * Test code may also call this to swap in fixtures.
 */
export function loadCalibrator(table: CalibratorTable | CalibrationMap | null): void {
  if (table === null) {
    CALIBRATORS = null;
    return;
  }
  if ("points" in table && Array.isArray((table as CalibratorTable).points)) {
    const sorted = [...(table as CalibratorTable).points].sort((x, y) => x.pred - y.pred);
    CALIBRATORS = { global: { points: sorted } };
    return;
  }
  const map = table as CalibrationMap;
  const out: CalibrationMap = {};
  for (const [k, v] of Object.entries(map)) {
    if (!v || !Array.isArray(v.points)) continue;
    out[k] = { points: [...v.points].sort((x, y) => x.pred - y.pred) };
  }
  CALIBRATORS = Object.keys(out).length > 0 ? out : null;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

export const __testing = { lookup, keyForCtx };
