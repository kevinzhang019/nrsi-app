import { cacheJson } from "../cache/redis";
import { k } from "../cache/keys";
import { log } from "../log";
import type { PaOutcomes } from "../mlb/splits";

/**
 * FanGraphs Stuff+ / Pitching+ pitcher-quality prior.
 *
 * The Sarris/Bay Stuff+/Location+/Pitching+ family operationalizes pitch-level
 * stuff into a rate-stat predictor of pitch run-value, stabilizing within
 * ~50-100 pitches at the model level
 * (https://library.fangraphs.com/pitching/stuff-location-and-pitching-primer/).
 * That's far faster than our per-PA splits even after EB shrinkage, which makes
 * it valuable as a *bias adjustment* — especially early in the season and for
 * callups / first-MLB-look pitchers where the per-PA prior is mostly league mean.
 *
 * Scale: 100 = league average. >100 = better. We translate `Pitching+` (the
 * blended composite) into a small multiplicative K-rate bias around 1.0, clamped
 * to a tight band so a 130 Pitching+ ace doesn't unilaterally double his K rate.
 *
 * Scrape: FanGraphs publishes Stuff+ on their pitcher leaderboard, accessible
 * via the public CSV/JSON `api/leaders/major-league/data` endpoint. Best-effort —
 * if the endpoint changes (FG URLs are less stable than Savant's), we degrade
 * to identity. Cached 24h.
 */

const FG_LEADERBOARD_URL = "https://www.fangraphs.com/api/leaders/major-league/data";
const UA = process.env.MLB_USER_AGENT || "nrxi-app/0.1";

export type StuffRow = {
  /** FanGraphs player ID — DIFFERENT from MLB Stats API. We'd need a join. */
  fgId?: number;
  /** MLB Stats API id (when FG exposes it; sometimes called `xmlbamid`). */
  playerId: number | null;
  /** `Pitching+` composite. 100 = league average. */
  pitchingPlus: number | null;
  /** `Stuff+`. */
  stuffPlus: number | null;
  /** `Location+`. */
  locationPlus: number | null;
};

export type StuffTable = Map<number, StuffRow>;

function num(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

async function fetchStuffPlusRaw(season: number): Promise<StuffRow[]> {
  // `type=36` is FG's Stuff+/Pitching+ leaderboard "stat group." May drift —
  // when it does, log + return empty so we degrade to identity.
  const params = new URLSearchParams({
    age: "",
    pos: "all",
    stats: "pit",
    lg: "all",
    qual: "0",
    season: String(season),
    season1: String(season),
    ind: "0",
    team: "0",
    rost: "0",
    players: "",
    type: "36",
  });
  const url = `${FG_LEADERBOARD_URL}?${params.toString()}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`FanGraphs stuff+ HTTP ${res.status}`);
  const raw = (await res.json()) as { data?: unknown[] } | unknown[];
  const rows = Array.isArray(raw) ? raw : Array.isArray((raw as { data?: unknown[] }).data) ? (raw as { data: unknown[] }).data : [];
  return rows.map((row): StuffRow => {
    const r = row as Record<string, unknown>;
    return {
      fgId: num(r.playerid ?? r.player_id ?? r.fgId) ?? undefined,
      // FG sometimes exposes `xmlbamid` (MLB Stats API id). When absent the
      // row is useless to us — there's no public free FG → MLB id table.
      playerId: num(r.xmlbamid ?? r.xMLBAMID ?? r.mlbam_id ?? r.MLBAMID),
      pitchingPlus: num(r["Pitching+"] ?? r.pitching_plus ?? r["Pit+"]),
      stuffPlus: num(r["Stuff+"] ?? r.stuff_plus ?? r["Stf+"]),
      locationPlus: num(r["Location+"] ?? r.location_plus ?? r["Loc+"]),
    };
  });
}

export async function loadStuffPlusTable(season: number): Promise<StuffTable> {
  const arr = await cacheJson<Array<[number, StuffRow]>>(
    k.stuff(season),
    60 * 60 * 24,
    async () => {
      try {
        const rows = await fetchStuffPlusRaw(season);
        const t = new Map<number, StuffRow>();
        for (const r of rows) {
          if (r.playerId != null) t.set(r.playerId, r);
        }
        return Array.from(t.entries());
      } catch (e) {
        log.warn("stuff", "scrape:failed", { season, err: String(e) });
        return [];
      }
    },
  );
  return new Map(arr);
}

// =========================================================================
// Factor construction & application
// =========================================================================

/** Slope on K rate: each 10 pts of Pitching+ above league shifts K by ~1.5%. */
const PITCHING_PLUS_K_SLOPE = 0.0015;
/** Slope on HR rate (allowed). Good Pitching+ → fewer HR; bad → more. */
const PITCHING_PLUS_HR_SLOPE = -0.002;
/** Clamp both K and HR multipliers tight — Stuff+ is a small denoiser. */
const FACTOR_CLAMP_LO = 0.95;
const FACTOR_CLAMP_HI = 1.05;

function clamp(v: number): number {
  if (!Number.isFinite(v)) return 1;
  if (v < FACTOR_CLAMP_LO) return FACTOR_CLAMP_LO;
  if (v > FACTOR_CLAMP_HI) return FACTOR_CLAMP_HI;
  return v;
}

export type StuffFactors = { k: number; hr: number };

export function stuffFactors(row: StuffRow | undefined): StuffFactors {
  if (!row || row.pitchingPlus == null) return { k: 1, hr: 1 };
  const delta = row.pitchingPlus - 100;
  return {
    k: clamp(1 + delta * PITCHING_PLUS_K_SLOPE),
    hr: clamp(1 + delta * PITCHING_PLUS_HR_SLOPE),
  };
}

/**
 * Apply Stuff+ K/HR multipliers and renormalize. Same pattern as `applyTtop` /
 * `applyFraming` — preserves sum-to-1.
 */
export function applyStuff(pa: PaOutcomes, factors: StuffFactors): PaOutcomes {
  if (factors.k === 1 && factors.hr === 1) return pa;
  const adj: PaOutcomes = {
    single: pa.single,
    double: pa.double,
    triple: pa.triple,
    hr: pa.hr * factors.hr,
    bb: pa.bb,
    hbp: pa.hbp,
    k: pa.k * factors.k,
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

export const __testing = {
  PITCHING_PLUS_K_SLOPE,
  PITCHING_PLUS_HR_SLOPE,
  FACTOR_CLAMP_LO,
  FACTOR_CLAMP_HI,
};
