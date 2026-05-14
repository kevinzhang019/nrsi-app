import { cacheJson } from "../cache/redis";
import { k } from "../cache/keys";
import { log } from "../log";

/**
 * Statcast expected statistics (xwOBA, xBA, xSLG, xHR, Barrel%) loaded from
 * Baseball Savant. Used to denoise the HR component of per-PA outcome rates
 * for HITTERS only — per the BP "Siren Song of Statcast Expected Metrics"
 * (https://www.baseballprospectus.com/news/article/40026/), pitcher xstats
 * barely correlate year-over-year and we deliberately ignore them.
 *
 * For hitters the signal is real: Barrel%/BBE reaches r ≈ 0.70 reliability at
 * ~50 BBE (FanGraphs, "An Overdue Barrel Rate Refresher"), and xwOBA modestly
 * outperforms wOBA on next-year prediction. The most useful field for nrXi —
 * which cares disproportionately about HR (the only inning-killer that doesn't
 * depend on subsequent PAs) — is `xhr / pa`. We use it as an EB-style denoiser
 * over observed HR rate, gated by BBE.
 *
 * Source: https://baseballsavant.mlb.com/leaderboard/expected_statistics
 */

const SAVANT_XSTATS_URL =
  "https://baseballsavant.mlb.com/leaderboard/expected_statistics";

const UA = process.env.MLB_USER_AGENT || "nrxi-app/0.1";

export type ExpectedRow = {
  playerId: number;
  pa: number;
  bbe: number;
  hr: number;
  /** Expected HR — Savant's xhr aggregate. */
  xHr: number;
  /** Expected wOBA. Plumbed through for future calibration / display. */
  xwOba: number | null;
  /** Barrel rate per BBE (0..1). */
  barrelRate: number | null;
};

export type ExpectedStatsTable = Map<number, ExpectedRow>;

function num(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

export function parseExpectedStatsHtml(html: string): ExpectedStatsTable {
  const m =
    html.match(/<script[^>]*id="[^"]*data[^"]*"[^>]*>([\s\S]*?)<\/script>/i) ||
    html.match(/var\s+data\s*=\s*(\[\{[\s\S]*?\}\])\s*;/);
  if (!m) return new Map();
  let data: unknown;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return new Map();
  }
  if (!Array.isArray(data)) return new Map();
  const out: ExpectedStatsTable = new Map();
  for (const row of data) {
    const r = row as Record<string, unknown>;
    const playerId = num(r.entity_id ?? r.player_id ?? r.id ?? r.batter_id);
    const pa = num(r.pa ?? r.plate_appearances) ?? 0;
    const bbe = num(r.bbe ?? r.batted_ball_events ?? r.attempts) ?? 0;
    const hr = num(r.hr ?? r.home_runs) ?? 0;
    const xHr = num(r.xhr ?? r.x_hr ?? r.expected_home_runs);
    if (playerId === null || xHr === null || pa <= 0) continue;
    out.set(playerId, {
      playerId,
      pa,
      bbe,
      hr,
      xHr,
      xwOba: num(r.xwoba ?? r.x_woba ?? r.est_woba),
      // Some fields surface barrel rate as a percentage; normalize to ratio.
      barrelRate: normalizeRate(num(r.brl_percent ?? r.barrel_rate ?? r.brl_pct ?? r.barrels_per_bbe)),
    });
  }
  return out;
}

function normalizeRate(v: number | null): number | null {
  if (v === null) return null;
  return v > 1 ? v / 100 : v;
}

async function scrapeExpectedStats(season: number): Promise<ExpectedStatsTable> {
  // `type=batter` selects hitter leaderboard. `min=q` = qualified PA only; we
  // also pull `min=10` lower bound to catch part-time bats.
  const url = `${SAVANT_XSTATS_URL}?type=batter&year=${season}&min=10`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
  if (!res.ok) throw new Error(`Savant expected stats HTTP ${res.status}`);
  return parseExpectedStatsHtml(await res.text());
}

export async function loadExpectedStatsTable(season: number): Promise<ExpectedStatsTable> {
  const arr = await cacheJson<Array<[number, ExpectedRow]>>(
    k.expectedStats(season),
    60 * 60 * 24,
    async () => {
      try {
        const t = await scrapeExpectedStats(season);
        return Array.from(t.entries());
      } catch (e) {
        log.warn("xstats", "scrape:failed", { season, err: String(e) });
        return [];
      }
    },
  );
  return new Map(arr);
}

// =========================================================================
// HR-rate denoiser
// =========================================================================

/**
 * Multiplier on a hitter's observed HR rate, derived from xHR/PA. Returns 1.0
 * (identity) when expected-stats are missing or too thin to trust.
 *
 * Mechanics:
 *   1. Compute `expectedHrPerPa = row.xHr / row.pa` and `observedHrPerPa = row.hr / row.pa`.
 *   2. Ratio = `expectedHrPerPa / observedHrPerPa` (when both > 0).
 *   3. EB-shrink the ratio toward 1.0 with `n0 = 50` BBE (FanGraphs barrel
 *      stabilization threshold). Effective weight grows with the player's BBE.
 *   4. Clamp to [BBE_HR_FLOOR, BBE_HR_CEIL] so a single outlier season can't
 *      double or zero out the HR component.
 *
 * Applied multiplicatively to BOTH L and R sides' HR rate inside
 * `loadBatterPaProfile`, then renormalized — Savant doesn't publish
 * handedness-split expected stats and the denoising signal is overall.
 */
const BBE_SHRINK_N0 = 50;
const HR_RATIO_FLOOR = 0.7;
const HR_RATIO_CEIL = 1.3;

export function hrRateMultiplier(row: ExpectedRow | undefined): number {
  if (!row) return 1;
  if (row.pa <= 0 || row.bbe <= 0 || row.hr <= 0 || row.xHr <= 0) return 1;
  const observed = row.hr / row.pa;
  const expected = row.xHr / row.pa;
  if (observed <= 0 || expected <= 0) return 1;
  const rawRatio = expected / observed;
  const n = row.bbe;
  const shrunk = (n * rawRatio + BBE_SHRINK_N0 * 1.0) / (n + BBE_SHRINK_N0);
  if (shrunk < HR_RATIO_FLOOR) return HR_RATIO_FLOOR;
  if (shrunk > HR_RATIO_CEIL) return HR_RATIO_CEIL;
  return shrunk;
}

export const __testing = { BBE_SHRINK_N0, HR_RATIO_FLOOR, HR_RATIO_CEIL };
