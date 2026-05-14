import { fetchPerson, fetchSplits } from "./client";
import { cacheJson } from "../cache/redis";
import { k } from "../cache/keys";
import { log } from "../log";
import type { HandCode, PitchHand, PitchHandRaw } from "./types";
import { ageFromBirthDate, applyAging, type Role } from "./aging";
import { hrRateMultiplier, loadExpectedStatsTable } from "../env/expected-stats";
import { applyWorkload, loadRecentPitchCount, workloadKFactor } from "../env/workload";
import { applyStuff, loadStuffPlusTable, stuffFactors } from "../env/stuff";

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
  /**
   * P(in-play out is a GIDP | runner on 1st AND outs < 2) for this batter.
   * EB-shrunk per-batter rate, clamped to [0.03, 0.20]. League mean ≈ 0.10.
   * High-GB hitters drift up (~0.14-0.18); high-FB/fast hitters drift down
   * (~0.05-0.07). Threads into the Markov chain via
   * `pAtLeastOneRun(start, lineup, { gidpRates })`.
   */
  gidpRate: number;
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

const RECENT_DAYS = 30;

/**
 * Per-role blend configuration. Five knobs:
 *   wCurrent / wPrior — Marcel-style cross-season recency multipliers on per-PA
 *     blending. Decay = wPrior / wCurrent (so 3:2 = 0.67, 2:1 = 0.5).
 *   n0 — empirical-Bayes prior strength in PA against the league mean. n0 PA
 *     means a player with that many PA contributes 50/50 with league.
 *   recentWeight — share of the final blended rate carried by the L30 sample
 *     (the rest is the season blend). Applied only when L30 PA ≥ recentMinPa.
 *   recentMinPa — materiality gate for the L30 blend. Below this threshold,
 *     L30 is dropped entirely.
 *
 * Hitter values: literature-aligned (Marcel hitters 5/4/3 → decay ≈ 0.75; our
 *   2-year 3:2 = 0.67 sits in the published 0.6-0.8 band). n0 = 200 matches
 *   composite-stat stabilization (~200-460 PA at split-half r ≈ 0.7).
 *
 * Pitcher values: Marcel splits hitters and pitchers (5/4/3 vs 4/3/2) because
 *   pitcher rates are noisier year-to-year — collapsed to two seasons that's
 *   roughly 2:1 (decay 0.5). Pitcher n0 is larger because batted-ball-driven
 *   components (BABIP ~2000 BIP, HR ~1320 BF) need much more PA to stabilize
 *   on the pitcher side; n0 = 500 is a single-knob compromise across the
 *   per-PA outcome bundle (K%/BB% would prefer smaller, BABIP/HR much larger).
 *
 * L30 blend (shared): The Book + empirical replications find L7-L30 carries
 *   ~5 wOBA points / 0.0-0.2% improvement — small but non-zero. Threshold 80
 *   PA ≈ a month of starts; 0.10 weight keeps it from drowning the season
 *   signal. No major published projection system uses an L30 component.
 */
type BlendConfig = {
  wCurrent: number;
  wPrior: number;
  n0: number;
  recentWeight: number;
  recentMinPa: number;
};

const BATTER_BLEND: BlendConfig = {
  wCurrent: 3,
  wPrior: 2,
  n0: 200,
  recentWeight: 0.10,
  recentMinPa: 80,
};

const PITCHER_BLEND: BlendConfig = {
  wCurrent: 2,
  wPrior: 1,
  n0: 500,
  recentWeight: 0.10,
  recentMinPa: 80,
};

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
 * Combine current + prior regular-season per-PA outcomes with role-specific
 * recency multipliers (wCurrent / wPrior) on the blended rate. Returns the
 * actual observed PA (truePa) separately, so callers can shrink against true
 * sample size while still benefiting from the recency bias in the rates.
 *
 * Aging: when `age`/`role` are provided, the prior-year rates are projected
 * forward 1 year before blending. Marcel-style adjustment — see `lib/mlb/aging.ts`.
 * Falls through to the legacy (age-blind) behavior when age is unknown so
 * unit tests and missing-birthDate callers stay correct.
 */
function combineSeasonsPa(
  current: { rates: PaOutcomes; pa: number } | null,
  prior: { rates: PaOutcomes; pa: number } | null,
  wCurrent: number,
  wPrior: number,
  age?: number | null,
  role?: Role,
): { rates: PaOutcomes; truePa: number } | null {
  if (!current && !prior) return null;
  // Project prior-year rates forward to current age before any combine.
  const priorAged =
    prior && age != null && role
      ? { rates: applyAging(prior.rates, age, role), pa: prior.pa }
      : prior;
  if (!current) return { rates: priorAged!.rates, truePa: priorAged!.pa };
  if (!priorAged) return { rates: current.rates, truePa: current.pa };
  const wc = wCurrent * current.pa;
  const wp = wPrior * priorAged.pa;
  const denom = wc + wp;
  if (denom === 0) return null;
  const out = {} as PaOutcomes;
  (Object.keys(current.rates) as (keyof PaOutcomes)[]).forEach((key) => {
    out[key] = (wc * current.rates[key] + wp * priorAged.rates[key]) / denom;
  });
  return { rates: out, truePa: current.pa + priorAged.pa };
}

/** Empirical-Bayes shrinkage to the league mean. Preserves sum-to-1. */
export function shrinkPa(observed: PaOutcomes, n: number, league: PaOutcomes, n0 = BATTER_BLEND.n0): PaOutcomes {
  const w = n / (n + n0);
  const out = {} as PaOutcomes;
  (Object.keys(observed) as (keyof PaOutcomes)[]).forEach((key) => {
    out[key] = w * observed[key] + (1 - w) * league[key];
  });
  return out;
}

/**
 * Multiply the HR cell of a per-PA distribution by `mult` and renormalize so
 * the result still sums to 1. Used by the hitter Barrel/xwOBA denoiser
 * (`lib/env/expected-stats.ts`). Identity when mult === 1.
 */
function scaleHrInPa(pa: PaOutcomes, mult: number): PaOutcomes {
  if (mult === 1 || !Number.isFinite(mult) || mult <= 0) return pa;
  const adj: PaOutcomes = { ...pa, hr: pa.hr * mult };
  const total =
    adj.single + adj.double + adj.triple + adj.hr + adj.bb + adj.hbp + adj.k + adj.ipOut;
  if (total <= 0) return pa;
  (Object.keys(adj) as (keyof PaOutcomes)[]).forEach((key) => {
    adj[key] = adj[key] / total;
  });
  return adj;
}

// =========================================================================
// GIDP rate per batter — feeds Markov's transIpOut (P(GIDP | runner on 1st,
// outs < 2) per Tier 3 #10 in the probability-model review). League-mean
// values calibrated against Retrosheet aggregates (≈ 10% of eligible ipOuts).
// =========================================================================

/** League mean P(GIDP | eligible) — runner on 1st, outs < 2, in-play out. */
export const LEAGUE_GIDP_RATE = 0.10;
/** League mean GIDP per PA — used to translate per-PA rate → per-eligible rate. */
const LEAGUE_GIDP_PER_PA = 0.015;
/** Multiplicative bridge from GIDP/PA → GIDP/eligible-ipOut (≈ 6.67). */
const GIDP_PER_PA_TO_RATE = LEAGUE_GIDP_RATE / LEAGUE_GIDP_PER_PA;
/** EB shrinkage prior (PA). Small — GIDP/PA stabilizes faster than HR/PA. */
const GIDP_SHRINK_N0 = 250;

/**
 * Aggregate GIDP / PA across the season-split rows we already fetch for splits
 * blending (vL + vR). Returns total GIDP and total PA so the caller can shrink
 * and convert in one step.
 */
function sumGidpAndPa(
  stats: Array<Record<string, unknown> | null>,
): { gidp: number; pa: number } {
  let gidp = 0;
  let pa = 0;
  for (const s of stats) {
    if (!s) continue;
    const g = num(s.groundIntoDoublePlay);
    const p = num(s.plateAppearances) ?? num(s.battersFaced);
    if (g != null) gidp += g;
    if (p != null && p > 0) pa += p;
  }
  return { gidp, pa };
}

/**
 * Per-batter `P(GIDP | runner on 1st AND outs < 2 AND in-play out)`, derived
 * from raw GIDP counts and PA totals via EB shrinkage and the league-wide
 * per-PA → per-eligible bridge. Always returns a value in [0.03, 0.20].
 */
export function gidpRateFromCounts(gidpCount: number, pa: number): number {
  if (pa <= 0) return LEAGUE_GIDP_RATE;
  const shrunkGidpPerPa =
    (gidpCount + GIDP_SHRINK_N0 * LEAGUE_GIDP_PER_PA) / (pa + GIDP_SHRINK_N0);
  const rate = shrunkGidpPerPa * GIDP_PER_PA_TO_RATE;
  if (rate < 0.03) return 0.03;
  if (rate > 0.20) return 0.20;
  return rate;
}

// =========================================================================
// Raw split fetchers — shared between v1 and v2. Already cached.
// =========================================================================

export async function loadHand(playerId: number) {
  return cacheJson(k.hand(playerId), 60 * 60 * 24 * 30, async () => {
    const r = await fetchPerson(playerId);
    const p = r.people[0];
    const throws = await resolveThrowsHand(p.id, p.pitchHand?.code);
    const age = p.currentAge ?? ageFromBirthDate(p.birthDate);
    return {
      id: p.id,
      fullName: p.fullName,
      bats: p.batSide?.code ?? ("R" as HandCode),
      throws,
      age: age ?? null,
    };
  });
}

// Collapses MLB's raw pitchHand to the L|R our model assumes. Most players
// already come back as "L" or "R" and we pass through. Switch-throwers (rare;
// almost always position players doing mop-up duty) return "S" — for those we
// pick whichever side has the lower WHIP from their season pitching splits,
// fall back to whichever side has stats, and default to "R" if neither does.
async function resolveThrowsHand(
  playerId: number,
  raw: PitchHandRaw | undefined,
): Promise<PitchHand> {
  if (raw === "L" || raw === "R") return raw;
  try {
    let r = await loadPitchingSplitsRaw(playerId, SEASON);
    let splits = r.stats[0]?.splits ?? [];
    if (splits.length === 0) {
      r = await loadPitchingSplitsRaw(playerId, FALLBACK_SEASON);
      splits = r.stats[0]?.splits ?? [];
    }
    const whipL = num(pickSplit(splits, "vl")?.whip);
    const whipR = num(pickSplit(splits, "vr")?.whip);
    if (whipL != null && whipR != null) return whipL <= whipR ? "L" : "R";
    if (whipL != null) return "L";
    if (whipR != null) return "R";
  } catch (err) {
    log.warn("mlb", "resolveThrowsHand:fail", { playerId, err: String(err) });
  }
  return "R";
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
  config: BlendConfig,
  age?: number | null,
  role?: Role,
): SideResult {
  const baselineRaw = combineSeasonsPa(
    paFromStat(currentSeasonStat),
    paFromStat(priorSeasonStat),
    config.wCurrent,
    config.wPrior,
    age,
    role,
  );
  const recentRaw = paFromStat(recentStat);

  if (!baselineRaw && !recentRaw) {
    return { rates: defaultPa(hand), pa: 0 };
  }

  // Shrink the recency-weighted blend against the *actual* observed PA so the
  // EB calibration stays grounded in real sample size.
  const baselineShrunk = baselineRaw
    ? shrinkPa(baselineRaw.rates, baselineRaw.truePa, league, config.n0)
    : league;
  const recentShrunk = recentRaw
    ? shrinkPa(recentRaw.rates, recentRaw.pa, league, config.n0)
    : null;

  const hasMaterialRecent = recentRaw && recentRaw.pa >= config.recentMinPa && recentShrunk;
  const blended = hasMaterialRecent
    ? blendPa(baselineShrunk, recentShrunk, config.recentWeight)
    : baselineShrunk;

  return { rates: blended, pa: baselineRaw?.truePa ?? 0 };
}

export async function loadBatterPaProfile(playerId: number): Promise<BatterPaProfile> {
  const [hand, currentRaw, priorRaw, recent, xstats] = await Promise.all([
    loadHand(playerId),
    loadHittingSplitsRaw(playerId, SEASON),
    loadHittingSplitsRaw(playerId, SEASON - 1),
    loadHittingSplitsRecentRaw(playerId, RECENT_DAYS),
    loadExpectedStatsTable(SEASON),
  ]);

  const currentSplits = currentRaw.stats[0]?.splits ?? [];
  const priorSplits = priorRaw.stats[0]?.splits ?? [];

  const currentVL = pickSplit(currentSplits, "vl");
  const currentVR = pickSplit(currentSplits, "vr");
  const priorVL = pickSplit(priorSplits, "vl");
  const priorVR = pickSplit(priorSplits, "vr");
  const recentVL = pickSplit(recent, "vl");
  const recentVR = pickSplit(recent, "vr");

  const sideL = buildSide(currentVL, priorVL, recentVL, LEAGUE_PA.L, "L", BATTER_BLEND, hand.age, "batter");
  const sideR = buildSide(currentVR, priorVR, recentVR, LEAGUE_PA.R, "R", BATTER_BLEND, hand.age, "batter");

  // GIDP rate folds current + prior season splits unweighted — GIDP is a
  // slow-changing batted-ball tendency, recency multipliers add little signal.
  const gidp = sumGidpAndPa([currentVL, currentVR, priorVL, priorVR]);
  const gidpRate = gidpRateFromCounts(gidp.gidp, gidp.pa);

  // Apply Savant xHR denoiser to BOTH sides' HR rate. Savant doesn't publish
  // handedness-split expected stats, so the same multiplier is applied to L/R.
  // Identity (mult === 1) when the row is missing or below BBE threshold.
  const hrMult = hrRateMultiplier(xstats.get(playerId));
  const ratesL = scaleHrInPa(sideL.rates, hrMult);
  const ratesR = scaleHrInPa(sideR.rates, hrMult);

  return {
    id: hand.id,
    fullName: hand.fullName,
    bats: hand.bats,
    paVs: { L: ratesL, R: ratesR },
    paCounts: { L: sideL.pa, R: sideR.pa },
    gidpRate,
  };
}

export async function loadPitcherPaProfile(playerId: number): Promise<PitcherPaProfile> {
  const [hand, currentRaw, priorRaw, recent, recentPitches, stuff] = await Promise.all([
    loadHand(playerId),
    loadPitchingSplitsRaw(playerId, SEASON),
    loadPitchingSplitsRaw(playerId, SEASON - 1),
    loadPitchingSplitsRecentRaw(playerId, RECENT_DAYS),
    loadRecentPitchCount(playerId, 7),
    loadStuffPlusTable(SEASON),
  ]);

  const currentSplits = currentRaw.stats[0]?.splits ?? [];
  const priorSplits = priorRaw.stats[0]?.splits ?? [];

  const currentVL = pickSplit(currentSplits, "vl");
  const currentVR = pickSplit(currentSplits, "vr");
  const priorVL = pickSplit(priorSplits, "vl");
  const priorVR = pickSplit(priorSplits, "vr");
  const recentVL = pickSplit(recent, "vl");
  const recentVR = pickSplit(recent, "vr");

  const sideL = buildSide(currentVL, priorVL, recentVL, LEAGUE_PA.L, "L", PITCHER_BLEND, hand.age, "pitcher");
  const sideR = buildSide(currentVR, priorVR, recentVR, LEAGUE_PA.R, "R", PITCHER_BLEND, hand.age, "pitcher");

  // Reliever workload drag — high acute load (last 7 days) shaves up to 3%
  // off K rate. Identity (factor === 1) below 120 pitches.
  const wK = workloadKFactor(recentPitches);
  // Stuff+/Pitching+ pitcher-quality bias — small K↑/HR↓ for high-Pitching+
  // pitchers, inverse for low. Identity when the row isn't joined to this
  // pitcher (no MLBAMID exposed by FanGraphs or the scrape fell back).
  const sFactors = stuffFactors(stuff.get(playerId));
  const ratesL = applyStuff(applyWorkload(sideL.rates, wK), sFactors);
  const ratesR = applyStuff(applyWorkload(sideR.rates, wK), sFactors);

  return {
    id: hand.id,
    fullName: hand.fullName,
    throws: hand.throws as PitchHand,
    paVs: { L: ratesL, R: ratesR },
    paCounts: { L: sideL.pa, R: sideR.pa },
  };
}

// Internal helpers exported for tests.
export const __testing = {
  paFromStat,
  blendPa,
  combineSeasonsPa,
  defaultPa,
  buildSide,
  BATTER_BLEND,
  PITCHER_BLEND,
};
