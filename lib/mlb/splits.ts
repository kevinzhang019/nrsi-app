import { fetchPerson, fetchSplits } from "./client";
import { cacheJson } from "../cache/redis";
import { k } from "../cache/keys";
import { log } from "../log";
import type { HandCode, PitchHand } from "./types";

const STATSAPI = "https://statsapi.mlb.com";
const UA = process.env.MLB_USER_AGENT || "nrxi-app/0.1";

const SEASON = new Date().getUTCFullYear();
const FALLBACK_SEASON = SEASON - 1;

function num(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

// =========================================================================
// Legacy types (v1 model — pReach + 2-state DP). Retained for transition.
// =========================================================================

export type BatterProfile = {
  id: number;
  fullName: string;
  bats: HandCode;
  obpVs: { L: number; R: number };
};

export type PitcherProfile = {
  id: number;
  fullName: string;
  throws: PitchHand;
  whipVs: { L: number; R: number };
  obpVs: { L: number; R: number };
};

const DEFAULT_OBP = 0.32;
const DEFAULT_WHIP = 1.3;

// =========================================================================
// v2 types — per-PA outcome distribution for Log5 + Markov model.
// =========================================================================

/** Per-PA outcome rates. The 8 categories sum to 1. */
export type PaOutcomes = {
  single: number;
  double: number;
  triple: number;
  hr: number;
  bb: number;
  hbp: number;
  k: number;
  ipOut: number; // residual: in-play outs (GO/FO/SF/GIDP/SAC etc.)
};

export type BatterPaProfile = {
  id: number;
  fullName: string;
  bats: HandCode;
  paVs: { L: PaOutcomes; R: PaOutcomes };
  paCounts: { L: number; R: number };
};

export type PitcherPaProfile = {
  id: number;
  fullName: string;
  throws: PitchHand;
  paVs: { L: PaOutcomes; R: PaOutcomes };
  paCounts: { L: number; R: number };
};

/**
 * League-average per-PA outcomes by *pitcher* handedness (i.e., L = vs LHP, R = vs RHP).
 * Sums to 1 per side. Refresh annually from FanGraphs splits leaderboard.
 *
 * Anchors used (2024–2025 MLB averages, all qualified hitters):
 *   K%≈22.5%, BB%≈8.3%, HR/PA≈3.0%, HBP%≈1.2%, BABIP≈0.293.
 * Slight L/R skew: hitters do marginally better vs LHP overall (platoon split).
 *
 * Sources: FanGraphs splits leaderboards 2024–2025 season totals;
 *   https://www.fangraphs.com/leaders/splits-leaderboards
 */
export const LEAGUE_PA: { L: PaOutcomes; R: PaOutcomes } = {
  // vs LHP (hitter facing a left-handed pitcher)
  L: {
    single: 0.140,
    double: 0.046,
    triple: 0.005,
    hr: 0.030,
    bb: 0.082,
    hbp: 0.011,
    k: 0.220,
    ipOut: 0.466,
  },
  // vs RHP
  R: {
    single: 0.138,
    double: 0.045,
    triple: 0.005,
    hr: 0.029,
    bb: 0.084,
    hbp: 0.012,
    k: 0.226,
    ipOut: 0.461,
  },
};

/**
 * Empirical-Bayes prior strength in PA. Observed rates are blended with the
 * league mean as: shrunken = (n*observed + n0*league) / (n + n0).
 * n0 ≈ 200 means a player with 200 PA contributes 50/50 with the league mean.
 */
const SHRINK_N0 = 200;

/** Default last-30-day weight when blending with season splits. */
const RECENT_WEIGHT = 0.30;

const RECENT_DAYS = 30;

/**
 * Marcel-style recency multipliers on per-PA blending across current + prior
 * regular seasons. Current-year observations carry 1.5× the per-PA weight of
 * prior-year observations in the blended rate. Shrinkage strength (SHRINK_N0)
 * is applied against ACTUAL observed PA, not the weighted PA, so the existing
 * EB calibration stays grounded in real sample size.
 */
const W_CURRENT = 3;
const W_PRIOR = 2;

// Default profile when a split is entirely absent (rare; fallback path).
function defaultPa(hand: "L" | "R"): PaOutcomes {
  return { ...LEAGUE_PA[hand] };
}

function paFromStat(stat: Record<string, unknown> | null): { rates: PaOutcomes; pa: number } | null {
  if (!stat) return null;
  // Hitters: plateAppearances. Pitchers: battersFaced. Try both.
  const pa = num(stat.plateAppearances) ?? num(stat.battersFaced);
  if (!pa || pa <= 0) return null;
  const h = num(stat.hits) ?? 0;
  const d = num(stat.doubles) ?? 0;
  const t = num(stat.triples) ?? 0;
  const hr = num(stat.homeRuns) ?? 0;
  const bb = num(stat.baseOnBalls) ?? 0;
  const hbp = num(stat.hitByPitch) ?? 0;
  const k = num(stat.strikeOuts) ?? 0;
  const single = Math.max(h - d - t - hr, 0);
  const r = {
    single: single / pa,
    double: d / pa,
    triple: t / pa,
    hr: hr / pa,
    bb: bb / pa,
    hbp: hbp / pa,
    k: k / pa,
    ipOut: 0,
  };
  const sumNonOut = r.single + r.double + r.triple + r.hr + r.bb + r.hbp + r.k;
  r.ipOut = Math.max(0, 1 - sumNonOut);
  // Tiny renormalization safety in case rounding pushes the sum above 1.
  const total = r.single + r.double + r.triple + r.hr + r.bb + r.hbp + r.k + r.ipOut;
  if (total > 0 && Math.abs(total - 1) > 1e-9) {
    (Object.keys(r) as (keyof PaOutcomes)[]).forEach((key) => {
      r[key] = r[key] / total;
    });
  }
  return { rates: r, pa };
}

/** Linear blend of two distributions (both must already sum to 1). */
function blendPa(a: PaOutcomes, b: PaOutcomes, bWeight: number): PaOutcomes {
  const w = Math.max(0, Math.min(1, bWeight));
  const out = {} as PaOutcomes;
  (Object.keys(a) as (keyof PaOutcomes)[]).forEach((key) => {
    out[key] = (1 - w) * a[key] + w * b[key];
  });
  return out;
}

/**
 * Combine current + prior regular-season per-PA outcomes with the W_CURRENT /
 * W_PRIOR recency multiplier on the blended rate. Returns the actual observed
 * PA (truePa) separately, so callers can shrink against true sample size while
 * still benefiting from the recency bias in the rates.
 */
function combineSeasonsPa(
  current: { rates: PaOutcomes; pa: number } | null,
  prior: { rates: PaOutcomes; pa: number } | null,
): { rates: PaOutcomes; truePa: number } | null {
  if (!current && !prior) return null;
  if (!current) return { rates: prior!.rates, truePa: prior!.pa };
  if (!prior) return { rates: current.rates, truePa: current.pa };
  const wc = W_CURRENT * current.pa;
  const wp = W_PRIOR * prior.pa;
  const denom = wc + wp;
  if (denom === 0) return null;
  const out = {} as PaOutcomes;
  (Object.keys(current.rates) as (keyof PaOutcomes)[]).forEach((key) => {
    out[key] = (wc * current.rates[key] + wp * prior.rates[key]) / denom;
  });
  return { rates: out, truePa: current.pa + prior.pa };
}

/** Empirical-Bayes shrinkage to the league mean. Preserves sum-to-1. */
export function shrinkPa(observed: PaOutcomes, n: number, league: PaOutcomes, n0 = SHRINK_N0): PaOutcomes {
  const w = n / (n + n0);
  const out = {} as PaOutcomes;
  (Object.keys(observed) as (keyof PaOutcomes)[]).forEach((key) => {
    out[key] = w * observed[key] + (1 - w) * league[key];
  });
  return out;
}

// =========================================================================
// Raw split fetchers — shared between v1 and v2. Already cached.
// =========================================================================

export async function loadHand(playerId: number) {
  return cacheJson(k.hand(playerId), 60 * 60 * 24 * 30, async () => {
    const r = await fetchPerson(playerId);
    const p = r.people[0];
    return {
      id: p.id,
      fullName: p.fullName,
      bats: p.batSide?.code ?? ("R" as HandCode),
      throws: p.pitchHand?.code ?? ("R" as PitchHand),
    };
  });
}

async function loadHittingSplitsRaw(playerId: number, season: number) {
  return cacheJson(`bat:splitsraw:${playerId}:${season}`, 60 * 60 * 12, async () => {
    return await fetchSplits({ playerId, group: "hitting", season });
  });
}

async function loadPitchingSplitsRaw(playerId: number, season: number) {
  return cacheJson(`pit:splitsraw:${playerId}:${season}`, 60 * 60 * 12, async () => {
    return await fetchSplits({ playerId, group: "pitching", season });
  });
}

// Date-range splits (last-N-days). Best-effort: if the API does not honour
// sitCodes for byDateRange we silently fall back (caller continues with season-only).
async function fetchDateRangeSplitsRaw(
  playerId: number,
  group: "hitting" | "pitching",
  startDate: string,
  endDate: string,
): Promise<Array<{ split: { code: string }; stat: Record<string, unknown> }>> {
  const url =
    `${STATSAPI}/api/v1/people/${playerId}/stats?stats=byDateRangeSplits` +
    `&group=${group}&startDate=${startDate}&endDate=${endDate}&sitCodes=vl,vr`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!res.ok) {
    log.warn("mlb", "splits:byDateRange:non-ok", { url, status: res.status });
    return [];
  }
  const raw = (await res.json()) as { stats?: Array<{ splits?: Array<{ split: { code: string }; stat: Record<string, unknown> }> }> };
  return raw.stats?.[0]?.splits ?? [];
}

async function loadHittingSplitsRecentRaw(playerId: number, days: number) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const startStr = fmt(start);
  const endStr = fmt(end);
  return cacheJson(
    `bat:splitsraw:recent:${playerId}:${startStr}:${endStr}`,
    60 * 60 * 6,
    async () => {
      try {
        return await fetchDateRangeSplitsRaw(playerId, "hitting", startStr, endStr);
      } catch (e) {
        log.warn("mlb", "splits:recent:fail", { playerId, err: String(e) });
        return [];
      }
    },
  );
}

async function loadPitchingSplitsRecentRaw(playerId: number, days: number) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const startStr = fmt(start);
  const endStr = fmt(end);
  return cacheJson(
    `pit:splitsraw:recent:${playerId}:${startStr}:${endStr}`,
    60 * 60 * 6,
    async () => {
      try {
        return await fetchDateRangeSplitsRaw(playerId, "pitching", startStr, endStr);
      } catch (e) {
        log.warn("mlb", "splits:recent:fail", { playerId, err: String(e) });
        return [];
      }
    },
  );
}

function pickSplit(
  splits: Array<{ split: { code: string }; stat: Record<string, unknown> }>,
  code: "vl" | "vr",
): Record<string, unknown> | null {
  return (splits.find((s) => s.split.code === code)?.stat as Record<string, unknown>) ?? null;
}

// =========================================================================
// Legacy loaders (v1) — unchanged.
// =========================================================================

export async function loadBatterProfile(playerId: number): Promise<BatterProfile> {
  const hand = await loadHand(playerId);
  let raw = await loadHittingSplitsRaw(playerId, SEASON);
  let splits = raw.stats[0]?.splits ?? [];
  if (splits.length === 0) {
    raw = await loadHittingSplitsRaw(playerId, FALLBACK_SEASON);
    splits = raw.stats[0]?.splits ?? [];
  }
  const vL = pickSplit(splits, "vl");
  const vR = pickSplit(splits, "vr");
  return {
    id: hand.id,
    fullName: hand.fullName,
    bats: hand.bats,
    obpVs: {
      L: num(vL?.obp) ?? DEFAULT_OBP,
      R: num(vR?.obp) ?? DEFAULT_OBP,
    },
  };
}

export async function loadPitcherProfile(playerId: number): Promise<PitcherProfile> {
  const hand = await loadHand(playerId);
  let raw = await loadPitchingSplitsRaw(playerId, SEASON);
  let splits = raw.stats[0]?.splits ?? [];
  if (splits.length === 0) {
    raw = await loadPitchingSplitsRaw(playerId, FALLBACK_SEASON);
    splits = raw.stats[0]?.splits ?? [];
  }
  const vL = pickSplit(splits, "vl");
  const vR = pickSplit(splits, "vr");
  return {
    id: hand.id,
    fullName: hand.fullName,
    throws: hand.throws as PitchHand,
    whipVs: {
      L: num(vL?.whip) ?? DEFAULT_WHIP,
      R: num(vR?.whip) ?? DEFAULT_WHIP,
    },
    obpVs: {
      L: num(vL?.obp) ?? DEFAULT_OBP,
      R: num(vR?.obp) ?? DEFAULT_OBP,
    },
  };
}

// =========================================================================
// v2 loaders — per-PA outcome profiles with shrinkage + recent-form blend.
// =========================================================================

type SideResult = { rates: PaOutcomes; pa: number };

/** Build a shrunken, recency-blended PaOutcomes for one handedness side. */
function buildSide(
  currentSeasonStat: Record<string, unknown> | null,
  priorSeasonStat: Record<string, unknown> | null,
  recentStat: Record<string, unknown> | null,
  league: PaOutcomes,
  hand: "L" | "R",
): SideResult {
  const baselineRaw = combineSeasonsPa(
    paFromStat(currentSeasonStat),
    paFromStat(priorSeasonStat),
  );
  const recentRaw = paFromStat(recentStat);

  if (!baselineRaw && !recentRaw) {
    return { rates: defaultPa(hand), pa: 0 };
  }

  // Shrink the recency-weighted blend against the *actual* observed PA so the
  // existing SHRINK_N0 calibration stays grounded in real sample size.
  const baselineShrunk = baselineRaw
    ? shrinkPa(baselineRaw.rates, baselineRaw.truePa, league)
    : league;
  const recentShrunk = recentRaw
    ? shrinkPa(recentRaw.rates, recentRaw.pa, league)
    : null;

  // Only blend in recent form if we actually have last-30 data with material PA.
  const hasMaterialRecent = recentRaw && recentRaw.pa >= 20 && recentShrunk;
  const blended = hasMaterialRecent
    ? blendPa(baselineShrunk, recentShrunk, RECENT_WEIGHT)
    : baselineShrunk;

  return { rates: blended, pa: baselineRaw?.truePa ?? 0 };
}

export async function loadBatterPaProfile(playerId: number): Promise<BatterPaProfile> {
  const [hand, currentRaw, priorRaw, recent] = await Promise.all([
    loadHand(playerId),
    loadHittingSplitsRaw(playerId, SEASON),
    loadHittingSplitsRaw(playerId, SEASON - 1),
    loadHittingSplitsRecentRaw(playerId, RECENT_DAYS),
  ]);

  const currentSplits = currentRaw.stats[0]?.splits ?? [];
  const priorSplits = priorRaw.stats[0]?.splits ?? [];

  const currentVL = pickSplit(currentSplits, "vl");
  const currentVR = pickSplit(currentSplits, "vr");
  const priorVL = pickSplit(priorSplits, "vl");
  const priorVR = pickSplit(priorSplits, "vr");
  const recentVL = pickSplit(recent, "vl");
  const recentVR = pickSplit(recent, "vr");

  const sideL = buildSide(currentVL, priorVL, recentVL, LEAGUE_PA.L, "L");
  const sideR = buildSide(currentVR, priorVR, recentVR, LEAGUE_PA.R, "R");

  return {
    id: hand.id,
    fullName: hand.fullName,
    bats: hand.bats,
    paVs: { L: sideL.rates, R: sideR.rates },
    paCounts: { L: sideL.pa, R: sideR.pa },
  };
}

export async function loadPitcherPaProfile(playerId: number): Promise<PitcherPaProfile> {
  const [hand, currentRaw, priorRaw, recent] = await Promise.all([
    loadHand(playerId),
    loadPitchingSplitsRaw(playerId, SEASON),
    loadPitchingSplitsRaw(playerId, SEASON - 1),
    loadPitchingSplitsRecentRaw(playerId, RECENT_DAYS),
  ]);

  const currentSplits = currentRaw.stats[0]?.splits ?? [];
  const priorSplits = priorRaw.stats[0]?.splits ?? [];

  const currentVL = pickSplit(currentSplits, "vl");
  const currentVR = pickSplit(currentSplits, "vr");
  const priorVL = pickSplit(priorSplits, "vl");
  const priorVR = pickSplit(priorSplits, "vr");
  const recentVL = pickSplit(recent, "vl");
  const recentVR = pickSplit(recent, "vr");

  const sideL = buildSide(currentVL, priorVL, recentVL, LEAGUE_PA.L, "L");
  const sideR = buildSide(currentVR, priorVR, recentVR, LEAGUE_PA.R, "R");

  return {
    id: hand.id,
    fullName: hand.fullName,
    throws: hand.throws as PitchHand,
    paVs: { L: sideL.rates, R: sideR.rates },
    paCounts: { L: sideL.pa, R: sideR.pa },
  };
}

// Internal helpers exported for tests.
export const __testing = { paFromStat, blendPa, combineSeasonsPa, defaultPa, buildSide };
