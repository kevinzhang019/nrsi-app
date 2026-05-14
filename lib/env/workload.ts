import { cacheJson } from "../cache/redis";
import { k } from "../cache/keys";
import { log } from "../log";
import type { PaOutcomes } from "../mlb/splits";

/**
 * Reliever workload drag — rolling pitch count over the last 7 days as a
 * fatigue proxy. Driveline's PULSE workload work (Anthony Brady,
 * https://www.drivelinebaseball.com/2020/10/motus-workload-blog-pro-relief-pitcher/)
 * and FanGraphs' B2B research find total pitches in the prior 7 days predicts
 * performance degradation better than "pitched yesterday." Effect size is
 * modest — K-rate down ~1–3% above the high-acute-load threshold; we cap
 * accordingly.
 *
 * Source: MLB Stats API `/people/{id}/stats?stats=byDateRange&group=pitching`,
 * which exposes aggregated `numberOfPitches` over a window. Cached 6h.
 */

const STATSAPI = "https://statsapi.mlb.com";
const UA = process.env.MLB_USER_AGENT || "nrxi-app/0.1";

/** Pitches at which the K-rate multiplier hits its floor (no further drag). */
const HIGH_LOAD_CAP = 200;
/** Below this pitch count, no drag is applied. */
const LOW_LOAD_THRESHOLD = 120;
/** Multiplier band: [K_FLOOR, 1.0]. Inverse multiplier on contact components. */
const K_FLOOR = 0.97;

function num(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

async function fetchRecentPitchCountRaw(playerId: number, days: number): Promise<number> {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const url =
    `${STATSAPI}/api/v1/people/${playerId}/stats?stats=byDateRange&group=pitching` +
    `&startDate=${fmt(start)}&endDate=${fmt(end)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!res.ok) {
    log.warn("workload", "fetch:non-ok", { playerId, status: res.status });
    return 0;
  }
  const raw = (await res.json()) as {
    stats?: Array<{ splits?: Array<{ stat?: Record<string, unknown> }> }>;
  };
  let total = 0;
  for (const split of raw.stats?.[0]?.splits ?? []) {
    const np = num(split.stat?.numberOfPitches);
    if (np && np > 0) total += np;
  }
  return total;
}

/**
 * Total pitches thrown by this pitcher in the last `days` days. Best-effort —
 * returns 0 on any fetch / parse failure. Cached 6h so the watcher can call
 * once per pitcher per game without rate-limit pressure.
 */
export async function loadRecentPitchCount(playerId: number, days = 7): Promise<number> {
  return cacheJson(k.workload(playerId), 60 * 60 * 6, async () => {
    try {
      return await fetchRecentPitchCountRaw(playerId, days);
    } catch (e) {
      log.warn("workload", "fail", { playerId, err: String(e) });
      return 0;
    }
  });
}

/**
 * Compute a K-rate multiplier from a rolling pitch count. Smooth linear ramp
 * between LOW_LOAD_THRESHOLD and HIGH_LOAD_CAP, clamped to [K_FLOOR, 1.0].
 *
 * Examples (7-day window):
 *   0   pitches  → 1.00  (fully rested)
 *   120 pitches  → 1.00  (under threshold)
 *   160 pitches  → 0.985 (mid-load)
 *   200+ pitches → 0.97  (high acute load)
 */
export function workloadKFactor(recentPitches: number): number {
  if (!Number.isFinite(recentPitches) || recentPitches <= LOW_LOAD_THRESHOLD) return 1;
  if (recentPitches >= HIGH_LOAD_CAP) return K_FLOOR;
  const t = (recentPitches - LOW_LOAD_THRESHOLD) / (HIGH_LOAD_CAP - LOW_LOAD_THRESHOLD);
  return 1 + t * (K_FLOOR - 1);
}

/**
 * Apply the K-rate multiplier to a per-PA outcome distribution and renormalize.
 * Mirrors `applyTtop` / `applyFraming` — K shrinks; mass redistributes
 * proportionally to the other outcomes (mostly ipOut + walks).
 */
export function applyWorkload(pa: PaOutcomes, kFactor: number): PaOutcomes {
  if (kFactor === 1 || !Number.isFinite(kFactor) || kFactor <= 0) return pa;
  const adj: PaOutcomes = { ...pa, k: pa.k * kFactor };
  const total =
    adj.single + adj.double + adj.triple + adj.hr + adj.bb + adj.hbp + adj.k + adj.ipOut;
  if (total <= 0) return pa;
  (Object.keys(adj) as (keyof PaOutcomes)[]).forEach((key) => {
    adj[key] = adj[key] / total;
  });
  return adj;
}

export const __testing = { HIGH_LOAD_CAP, LOW_LOAD_THRESHOLD, K_FLOOR };
