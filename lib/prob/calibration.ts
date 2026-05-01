/**
 * Calibration shim for NRSI predictions.
 *
 * The Log5 + Markov chain produces a structurally-correct probability, but
 * any model that takes inputs noisier than the true world will be miscalibrated
 * at the margins. This shim applies a monotone post-hoc transform so the
 * model's probability estimates match observed frequencies in production.
 *
 * V1 ships an identity calibrator (no-op) — there is no production data yet
 * to fit against. After ~1 week of live games we should have ≥ 1k inning
 * outcomes; at that point fit isotonic regression on (predicted, actual)
 * pairs and replace IDENTITY_CALIBRATOR with the fitted lookup.
 *
 * To fit: run `pnpm tsx scripts/calibrate.ts` (creates the table) and commit
 * the resulting JSON. The function below reads from CALIBRATOR if set; falls
 * through to identity otherwise.
 *
 * Reference: Niculescu-Mizil & Caruana, "Predicting Good Probabilities with
 * Supervised Learning" (ICML 2005). Isotonic > Platt for tree-shaped errors.
 */

type CalibratorTable = {
  // Sorted ascending by `pred`. Apply piecewise-linear interpolation between
  // consecutive points; clamp at the endpoints.
  points: Array<{ pred: number; actual: number }>;
};

let CALIBRATOR: CalibratorTable | null = null;

/** Apply a monotone calibration. Returns p unchanged if no table is loaded. */
export function calibrate(p: number): number {
  if (!CALIBRATOR || CALIBRATOR.points.length < 2) return clamp01(p);
  const pts = CALIBRATOR.points;
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

/** Inject a fitted table at app boot. Test code may also call this. */
export function loadCalibrator(table: CalibratorTable | null): void {
  if (table) {
    const sorted = [...table.points].sort((x, y) => x.pred - y.pred);
    CALIBRATOR = { points: sorted };
  } else {
    CALIBRATOR = null;
  }
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
