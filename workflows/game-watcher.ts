import { sleep } from "workflow";
import { acquireWatcherLockStep, refreshWatcherLockStep } from "./steps/lock";
import { fetchLiveDiffStep } from "./steps/fetch-live-diff";
import { loadLineupSplitsStep } from "./steps/load-lineup-splits";
import { loadParkFactorStep } from "./steps/load-park-factor";
import { loadWeatherStep } from "./steps/load-weather";
import { loadDefenseStep } from "./steps/load-defense";
import { computeNrXiStep } from "./steps/compute-nrXi";
import { computeLineupStatsStep } from "./steps/compute-lineup-stats";
import { publishUpdateStep } from "./steps/publish-update";
import { enrichLineupHandsStep } from "./steps/enrich-lineup-hands";
import { getUpcomingForCurrentInning, lineupHash } from "@/lib/mlb/lineup";
import { extractLineups, extractLinescore, extractBatterFocus } from "@/lib/mlb/extract";
import { isDecisionMoment, isDecisionMomentFullInning, type GameState, type LineupBatterStat } from "@/lib/state/game-state";
import { classifyStatus } from "@/lib/mlb/types";
import { americanBreakEven, roundOdds } from "@/lib/prob/odds";
import type { LiveFeed } from "@/lib/mlb/types";
import type { Bases, GameState as MarkovState } from "@/lib/prob/markov";

// Read this pitcher's cumulative in-game pitch count from the boxscore. Refreshed
// every tick (NOT cached in workflow scope) because pitch count changes on every
// pitch — far more often than the structural reload fires.
function readPitcherPitchCount(feed: LiveFeed, pitcherId: number): number | null {
  const teams = feed.liveData.boxscore?.teams;
  if (!teams) return null;
  const key = `ID${pitcherId}`;
  const p = teams.home.players?.[key] ?? teams.away.players?.[key];
  const n = p?.stats?.pitching?.numberOfPitches;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

// Read live (outs, bases) from the MLB feed. Bases use the canonical 3-bit
// encoding shared with the Markov chain (bit0=1st, bit1=2nd, bit2=3rd).
//
// Half-boundary short-circuit: when the feed indicates the half-inning is
// over (inningState is "middle"/"end" OR outs >= 3), force {0, 0}. This
// mirrors the isMiddleOrEnd predicate in lib/mlb/lineup.ts:26 — that predicate
// already flips `upcoming` to the next half-inning, so the Markov startState
// must agree (no phantom stranded runners from `ls.offense` polluting the
// next-half compute).
// Read the live base occupancy as a 3-bit bitmask straight from the feed
// (bit0=1B, bit1=2B, bit2=3B). Unlike `readMarkovStartState`, this is for the
// header diamond display — we want the actual current bases even when outs
// have flickered to 3 mid-tick before the half flips. Returns null when the
// game isn't live so the UI hides the diamond.
function readDisplayBases(feed: LiveFeed, status: string): number | null {
  if (status !== "Live") return null;
  const off = feed.liveData.linescore.offense ?? {};
  const b1 = off.first?.id ? 1 : 0;
  const b2 = off.second?.id ? 2 : 0;
  const b3 = off.third?.id ? 4 : 0;
  return b1 | b2 | b3;
}

function readMarkovStartState(feed: LiveFeed): MarkovState {
  const ls = feed.liveData.linescore;
  const o = ls.outs ?? 0;
  const inningState = (ls.inningState || "").toLowerCase();
  const isHalfOver = inningState === "middle" || inningState === "end" || o >= 3;
  if (isHalfOver) return { outs: 0, bases: 0 };
  const outs = o as 0 | 1 | 2;
  const off = ls.offense ?? {};
  const b1 = off.first?.id ? 1 : 0;
  const b2 = off.second?.id ? 2 : 0;
  const b3 = off.third?.id ? 4 : 0;
  return { outs, bases: ((b1 | b2 | b3) as Bases) };
}

// Read this pitcher's cumulative batters-faced from the boxscore for TTOP.
function readPaInGameForPitcher(feed: LiveFeed, pitcherId: number): number {
  const teams = feed.liveData.boxscore?.teams;
  if (!teams) return 0;
  const key = `ID${pitcherId}`;
  const fromHome = teams.home.players?.[key]?.stats?.pitching?.battersFaced;
  const fromAway = teams.away.players?.[key]?.stats?.pitching?.battersFaced;
  return fromHome ?? fromAway ?? 0;
}

// Pull current-season ERA / WHIP from the boxscore so the card header can
// surface them next to the pitcher's name. MLB returns these as strings.
function readPitcherSeasonStats(
  feed: LiveFeed,
  pitcherId: number,
): { era: number | null; whip: number | null } {
  const teams = feed.liveData.boxscore?.teams;
  if (!teams) return { era: null, whip: null };
  const key = `ID${pitcherId}`;
  const p = teams.home.players?.[key] ?? teams.away.players?.[key];
  const s = p?.seasonStats?.pitching;
  const num = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };
  return { era: num(s?.era), whip: num(s?.whip) };
}

// Read the live defensive alignment for v2.1 (catcher framing + fielder OAA).
// Returns null catcher / empty fielders if the feed hasn't populated yet —
// computeNrXiStep degrades gracefully to v2 behavior in that case.
function readDefenseAlignment(feed: LiveFeed): {
  catcherId: number | null;
  fielderIds: number[];
} {
  const d = feed.liveData.linescore.defense;
  if (!d) return { catcherId: null, fielderIds: [] };
  const catcherId = d.catcher?.id ?? null;
  const fielderIds: number[] = [];
  for (const k of ["first", "second", "third", "shortstop", "left", "center", "right"] as const) {
    const id = d[k]?.id;
    if (id) fielderIds.push(id);
  }
  return { catcherId, fielderIds };
}

function defenseAlignmentKey(catcherId: number | null, fielderIds: number[]): string {
  return `${catcherId ?? "_"}-${fielderIds.join(",")}`;
}

// The "current pitcher" for each side. While their team is fielding, this is
// the pitcher actually on the mound (last entry of pitchers[]). Otherwise it's
// the most-recently-listed pitcher (starter pre-game; latest reliever if they
// already pitched). Returns null when the boxscore array is empty (very early
// pre-game with no probable starter posted yet).
function readBothPitchers(feed: LiveFeed): {
  awayPitcherId: number | null;
  homePitcherId: number | null;
} {
  const teams = feed.liveData.boxscore?.teams;
  const ap = teams?.away.pitchers ?? [];
  const hp = teams?.home.pitchers ?? [];
  return {
    awayPitcherId: ap[ap.length - 1] ?? null,
    homePitcherId: hp[hp.length - 1] ?? null,
  };
}

// Pull the 9 starter ids out of an enriched lineup. Returns null when the
// lineup hasn't posted yet (length < 9). Only starters; in-game subs are
// already handled by the at-bat-side compute path.
function starterIdsOf(lineup: { starter: { id: number } }[] | null): number[] | null {
  if (!lineup || lineup.length < 9) return null;
  return lineup.slice(0, 9).map((s) => s.starter.id);
}

export type WatcherInput = {
  gamePk: number;
  ownerId: string;
  awayTeamName: string;
  homeTeamName: string;
};

const SEASON = new Date().getUTCFullYear();
const MAX_LOOPS = 1500;

export async function gameWatcherWorkflow(input: WatcherInput) {
  "use workflow";
  console.log("[watcher] start", input.gamePk);

  const owned = await acquireWatcherLockStep({
    gamePk: input.gamePk,
    ownerId: input.ownerId,
    ttlSeconds: 90,
  });
  if (!owned) {
    console.log("[watcher] lock held by other; exiting", input.gamePk);
    return { reason: "lock-held" };
  }

  let lastTimecode: string | null = null;
  let prevDoc: LiveFeed | null = null;
  // Cached enriched lineups + the lineup hash they were enriched from. We
  // hydrate batter handedness from /people/{id} (via loadHand, 30d Redis TTL)
  // because the live-feed boxscore omits batSide for most players. Recomputed
  // only when the boxscore battingOrder changes (sub or starter swap).
  let lastEnrichedHash = "";
  let lastLineups: Awaited<ReturnType<typeof enrichLineupHandsStep>> | null = null;
  // Two-phase trigger state. structuralKey covers things that change at half-
  // inning / lineup / defense / opposing-pitcher boundaries — heavy reload
  // (network + lineupStats compute). playStateKey covers per-PA changes
  // (outs/bases/atBatIndex) — fast Markov recompute only. Splitting them lets
  // the prediction refresh on every plate-appearance outcome without re-
  // fetching cached splits/park/weather/defense or recomputing display-only
  // xOBP/xSLG that don't depend on game state.
  let lastStructuralKey = "";
  let lastPlayStateKey = "";
  let splitsCache: Awaited<ReturnType<typeof loadLineupSplitsStep>> | null = null;
  let parkCache: Awaited<ReturnType<typeof loadParkFactorStep>> | null = null;
  let weatherCache: Awaited<ReturnType<typeof loadWeatherStep>> | null = null;
  let defenseCache: Awaited<ReturnType<typeof loadDefenseStep>> | null = null;
  // Pre-computed P(no run) for the opposite half-inning starting clean. Only
  // populated when upcoming.half === "Top" (used to compose full-inning).
  let oppHalfCleanCache: { pHitEvent: number; pNoHitEvent: number } | null = null;
  let lastNrXi: Awaited<ReturnType<typeof computeNrXiStep>> | null = null;
  let lastEnv: { parkRunFactor: number; weatherRunFactor: number; weather?: Record<string, unknown> } | null = null;
  let lastPitcherId: number | null = null;
  let lastPitcherName = "";
  let lastPitcherThrows: "L" | "R" = "R";
  let lastPitcherEra: number | null = null;
  let lastPitcherWhip: number | null = null;
  // Both teams' most recent pitchers (id/name/throws/era/whip — pitch count is
  // refreshed every tick from the boxscore, not hoisted). Hoisted to workflow
  // scope per the bug #5/#7 pattern so they survive non-recompute ticks.
  type PitcherCore = { id: number; name: string; throws: "L" | "R"; era: number | null; whip: number | null };
  let lastAwayPitcher: PitcherCore | null = null;
  let lastHomePitcher: PitcherCore | null = null;
  // Full-inning probability — composed of (rest-of-current-half) × (clean
  // opposite half). Null when half=Top and the opposing pitcher is unknown,
  // so the UI shows "—" instead of silently falling through.
  let lastFullInning: { pHit: number; pNo: number; breakEven: number } | null = null;
  // Display-only xOBP/xSLG for both teams' starters keyed by player id. Drives
  // the "one team at a time" view that surfaces stats for all 9 batters of
  // either team. Hoisted to workflow scope (bug #5/#7 pattern) so it persists
  // across non-recompute ticks.
  let lastLineupStats: GameState["lineupStats"] = null;

  for (let loop = 0; loop < MAX_LOOPS; loop++) {
    const tick = await fetchLiveDiffStep({
      gamePk: input.gamePk,
      startTimecode: lastTimecode,
      prevDoc,
    });
    lastTimecode = tick.newTimecode;
    prevDoc = tick.feed;

    const status = classifyStatus(
      tick.feed.gameData.status.detailedState,
      tick.feed.gameData.status.abstractGameState,
    );
    const ls = tick.feed.liveData.linescore;
    const inning = ls.currentInning ?? null;
    const half: "Top" | "Bottom" | null =
      ls.isTopInning === true ? "Top" : ls.isTopInning === false ? "Bottom" : null;
    const outs = ls.outs ?? null;
    const inningState = ls.inningState ?? "";

    const lh = lineupHash(
      tick.feed.liveData.boxscore?.teams.home.battingOrder,
      tick.feed.liveData.boxscore?.teams.away.battingOrder,
    );
    const alignment = readDefenseAlignment(tick.feed);
    const dk = defenseAlignmentKey(alignment.catcherId, alignment.fielderIds);
    const upcoming = getUpcomingForCurrentInning(tick.feed);
    const bothPitchers = readBothPitchers(tick.feed);
    const op = `${bothPitchers.awayPitcherId ?? "_"}-${bothPitchers.homePitcherId ?? "_"}`;

    // Structural key — half-inning / lineup / defense / opposing-pitcher
    // boundaries, plus the current at-bat batter id. Uses upcoming.half (NOT
    // raw `half` from ls.isTopInning) so half-end transitions cleanly
    // invalidate the cache: lineup.ts already flips upcoming to the next half
    // when isMiddleOrEnd, which means raw `half` lags upcoming.half by one
    // tick at end-of-half.
    //
    // The at-bat batter id is included because upcoming.upcomingBatterIds
    // rotates by one position per PA (batter at front moves to back), and the
    // Markov chain models the chain starting from upcomingBatterIds[0]. Without
    // refreshing splitsCache.batters on rotation, the chain models the wrong
    // batter sequence after each PA. Reload is cheap: per-batter PA profiles
    // hit the 12h Redis cache, and the (input-keyed) workflow step result
    // cache dedupes computeLineupStatsStep / oppHalfClean across rotations
    // within the same half.
    const atBat = upcoming?.upcomingBatterIds[0] ?? "_";
    const structuralKey = `${upcoming?.half ?? "_"}|${upcoming?.inning ?? "_"}|${lh}|${dk}|${op}|${atBat}`;
    // Play-state key — outs, bases, and atBatIndex. atBatIndex captures
    // PA-boundary changes that don't move outs/bases (e.g., a solo HR with
    // empty bases rotates the next batter without changing the Markov state).
    const atBatIndex = tick.feed.liveData.plays?.currentPlay?.about?.atBatIndex ?? -1;
    const startStatePeek = readMarkovStartState(tick.feed);
    const playStateKey = `${startStatePeek.outs}-${startStatePeek.bases}-${atBatIndex}`;

    const isLive =
      status === "Live" && upcoming !== null && upcoming.pitcherId !== null;
    const shouldReloadStructure = isLive && structuralKey !== lastStructuralKey;
    const shouldRecomputePlay =
      isLive && (shouldReloadStructure || playStateKey !== lastPlayStateKey);

    console.log(
      "[watcher] tick",
      JSON.stringify({
        gamePk: input.gamePk,
        status,
        inning,
        half,
        outs,
        inningState,
        upcoming: upcoming
          ? { pitcherId: upcoming.pitcherId, batters: upcoming.upcomingBatterIds.length }
          : null,
        shouldReloadStructure,
        shouldRecomputePlay,
      }),
    );

    // Hydrate lineup batter handedness from /people/{id} when the boxscore
    // battingOrder changes. Done BEFORE the recompute block so lastLineups is
    // available for starter id lookup. Independent of shouldRecompute so
    // Pre-game lineups (status !== "Live") still get hydrated as soon as they
    // post.
    if (lh !== lastEnrichedHash) {
      const rawLineups = extractLineups(tick.feed);
      lastLineups = await enrichLineupHandsStep({
        gamePk: input.gamePk,
        lineups: rawLineups,
      });
      lastEnrichedHash = lh;
    }

    // ---- Phase 1: structural reload (heavy) ----
    // Fires only when the half-inning, lineup, defense alignment, or opposing
    // pitcher changes. Reloads splits/park/weather/defense, recomputes the
    // display-only xOBP/xSLG for both teams, and pre-computes the clean
    // opposite-half P(no run) used to compose full-inning. None of this
    // depends on outs/bases — those drive Phase 2 instead.
    if (shouldReloadStructure && upcoming) {
      const [splits, park, weather, defense] = await Promise.all([
        loadLineupSplitsStep({
          gamePk: input.gamePk,
          pitcherId: upcoming.pitcherId!,
          batterIds: upcoming.upcomingBatterIds,
        }),
        loadParkFactorStep({
          gamePk: input.gamePk,
          homeTeamName: input.homeTeamName,
          season: SEASON,
        }),
        loadWeatherStep({
          gamePk: input.gamePk,
          awayTeam: input.awayTeamName,
          homeTeam: input.homeTeamName,
        }),
        loadDefenseStep({ gamePk: input.gamePk, season: SEASON }),
      ]);
      splitsCache = splits;
      parkCache = park;
      weatherCache = weather;
      defenseCache = defense;

      lastEnv = {
        parkRunFactor: park.runFactor,
        weatherRunFactor: weather.factor,
        weather: weather.info as unknown as Record<string, unknown>,
      };
      lastPitcherId = splits.pitcher.id;
      lastPitcherName = splits.pitcher.fullName;
      lastPitcherThrows = splits.pitcher.throws;
      const seasonStats = readPitcherSeasonStats(tick.feed, splits.pitcher.id);
      lastPitcherEra = seasonStats.era;
      lastPitcherWhip = seasonStats.whip;

      // Full-lineup display stats (xOBP/xSLG) for both teams' starters and
      // the opposite-half no-run probability used to derive full-inning. We
      // compute these on the structural trigger so they share the same
      // park/weather/defense snapshot, and reuse the (12h Redis) splits cache
      // for any batter who's already been loaded today.
      const awayStarterIds = starterIdsOf(lastLineups?.away ?? null);
      const homeStarterIds = starterIdsOf(lastLineups?.home ?? null);
      const [awayBundle, homeBundle] = await Promise.all([
        bothPitchers.homePitcherId !== null && awayStarterIds
          ? loadLineupSplitsStep({
              gamePk: input.gamePk,
              pitcherId: bothPitchers.homePitcherId,
              batterIds: awayStarterIds,
            })
          : Promise.resolve(null),
        bothPitchers.awayPitcherId !== null && homeStarterIds
          ? loadLineupSplitsStep({
              gamePk: input.gamePk,
              pitcherId: bothPitchers.awayPitcherId,
              batterIds: homeStarterIds,
            })
          : Promise.resolve(null),
      ]);

      const awayStats: Record<string, LineupBatterStat> = awayBundle
        ? await computeLineupStatsStep({
            gamePk: input.gamePk,
            pitcher: awayBundle.pitcher,
            batters: awayBundle.batters,
            park: park.components,
            weather: weather.components,
            // Pass the live alignment only when away is currently batting —
            // otherwise the catcher/fielder ids reflect the wrong defense.
            oaaTable: upcoming.half === "Top" ? defense.oaaTable : undefined,
            framingTable: upcoming.half === "Top" ? defense.framingTable : undefined,
            catcherId: upcoming.half === "Top" ? alignment.catcherId : null,
            fielderIds: upcoming.half === "Top" ? alignment.fielderIds : [],
          })
        : {};
      const homeStats: Record<string, LineupBatterStat> = homeBundle
        ? await computeLineupStatsStep({
            gamePk: input.gamePk,
            pitcher: homeBundle.pitcher,
            batters: homeBundle.batters,
            park: park.components,
            weather: weather.components,
            oaaTable: upcoming.half === "Bottom" ? defense.oaaTable : undefined,
            framingTable: upcoming.half === "Bottom" ? defense.framingTable : undefined,
            catcherId: upcoming.half === "Bottom" ? alignment.catcherId : null,
            fielderIds: upcoming.half === "Bottom" ? alignment.fielderIds : [],
          })
        : {};
      lastLineupStats = { away: awayStats, home: homeStats };

      // Both teams' pitcher cores. awayBundle was loaded with HOME's pitcherId
      // (it pitches to away batters), so awayBundle.pitcher describes HOME's
      // pitcher; homeBundle.pitcher mirrors that for AWAY. ERA/WHIP come from
      // the boxscore, mirroring the existing readPitcherSeasonStats path.
      if (awayBundle && bothPitchers.homePitcherId !== null) {
        const s = readPitcherSeasonStats(tick.feed, bothPitchers.homePitcherId);
        lastHomePitcher = {
          id: awayBundle.pitcher.id,
          name: awayBundle.pitcher.fullName,
          throws: awayBundle.pitcher.throws,
          era: s.era,
          whip: s.whip,
        };
      }
      if (homeBundle && bothPitchers.awayPitcherId !== null) {
        const s = readPitcherSeasonStats(tick.feed, bothPitchers.awayPitcherId);
        lastAwayPitcher = {
          id: homeBundle.pitcher.id,
          name: homeBundle.pitcher.fullName,
          throws: homeBundle.pitcher.throws,
          era: s.era,
          whip: s.whip,
        };
      }

      // Pre-compute the clean opposite-half P(no run). Only meaningful when
      // upcoming.half === "Top" (= we're in or starting a top half, so the
      // opposite half is the bottom we'll need to compose into the full
      // inning). At end of bottom this also fires for the next inning's top
      // half via upcoming.inning advancing — homeBundle remains the right
      // bundle (home batters vs away pitcher) regardless of inning number.
      if (upcoming.half === "Top" && homeBundle) {
        const oppHalf = await computeNrXiStep({
          gamePk: input.gamePk,
          pitcher: homeBundle.pitcher,
          batters: homeBundle.batters,
          park: park.components,
          weather: weather.components,
          startState: { outs: 0, bases: 0 },
          paInGameForPitcher: 0,
          oaaTable: defense.oaaTable,
          framingTable: defense.framingTable,
          // Opposite half's defense isn't on the field; degrade gracefully.
          catcherId: null,
          fielderIds: [],
        });
        oppHalfCleanCache = {
          pHitEvent: oppHalf.pHitEvent,
          pNoHitEvent: oppHalf.pNoHitEvent,
        };
      } else {
        oppHalfCleanCache = null;
      }

      lastStructuralKey = structuralKey;
    }

    // ---- Phase 2: play-state recompute (per PA outcome) ----
    // Fires every tick when the play-state key advances OR after a structural
    // reload. Reuses cached splits/park/weather/defense and only re-runs the
    // Markov chain against the current outs/bases. This is what makes
    // pNoHitEvent refresh on every plate-appearance outcome (out, walk, hit,
    // HBP, error, FC, SB, HR, etc.).
    if (
      shouldRecomputePlay &&
      upcoming &&
      splitsCache &&
      parkCache &&
      weatherCache &&
      defenseCache
    ) {
      const startState = readMarkovStartState(tick.feed);
      const paInGameForPitcher = readPaInGameForPitcher(tick.feed, upcoming.pitcherId!);
      lastNrXi = await computeNrXiStep({
        gamePk: input.gamePk,
        pitcher: splitsCache.pitcher,
        batters: splitsCache.batters,
        park: parkCache.components,
        weather: weatherCache.components,
        startState,
        paInGameForPitcher,
        oaaTable: defenseCache.oaaTable,
        framingTable: defenseCache.framingTable,
        catcherId: alignment.catcherId,
        fielderIds: alignment.fielderIds,
      });

      // Full-inning composition keyed off upcoming.half (NOT raw `half`).
      // Mid-top: full = (rest of top) × (clean bottom). End of top:
      // upcoming.half flips to "Bottom" → full = lastNrXi (= bottom clean).
      // Mid-bottom: full = (rest of bottom). End of bottom: upcoming.half
      // flips to "Top" of next inning → full = lastNrXi × oppHalfClean of the
      // next full inning. Reverting to raw `half` reintroduces a squared bug
      // at end-of-top and a missing-bottom bug at end-of-bottom.
      if (upcoming.half === "Top" && oppHalfCleanCache) {
        const pNoFull = lastNrXi.pNoHitEvent * oppHalfCleanCache.pNoHitEvent;
        const pHitFull = 1 - pNoFull;
        lastFullInning = {
          pHit: pHitFull,
          pNo: pNoFull,
          breakEven: roundOdds(americanBreakEven(pNoFull)),
        };
      } else if (upcoming.half === "Bottom") {
        lastFullInning = {
          pHit: lastNrXi.pHitEvent,
          pNo: lastNrXi.pNoHitEvent,
          breakEven: lastNrXi.breakEvenAmerican,
        };
      } else {
        lastFullInning = null;
      }

      lastPlayStateKey = playStateKey;
    }

    const nrXi = lastNrXi;
    const env = lastEnv;

    const decision = isDecisionMoment({ status, inning, half, outs, inningState });
    const decisionFull = isDecisionMomentFullInning({ status, inning, half, outs, inningState });

    const state: GameState = {
      gamePk: input.gamePk,
      status,
      detailedState: tick.feed.gameData.status.detailedState ?? "",
      inning,
      half,
      outs,
      bases: readDisplayBases(tick.feed, status),
      isDecisionMoment: decision,
      isDecisionMomentFullInning: decisionFull,
      away: {
        id: tick.feed.gameData.teams.away.id,
        name: tick.feed.gameData.teams.away.name,
        runs: ls.teams?.away.runs ?? 0,
      },
      home: {
        id: tick.feed.gameData.teams.home.id,
        name: tick.feed.gameData.teams.home.name,
        runs: ls.teams?.home.runs ?? 0,
      },
      venue: tick.feed.gameData.venue
        ? { id: tick.feed.gameData.venue.id, name: tick.feed.gameData.venue.name }
        : null,
      pitcher:
        lastPitcherId !== null
          ? {
              id: lastPitcherId,
              name: lastPitcherName,
              throws: lastPitcherThrows,
              era: lastPitcherEra,
              whip: lastPitcherWhip,
              pitchCount: readPitcherPitchCount(tick.feed, lastPitcherId),
            }
          : null,
      awayPitcher: lastAwayPitcher
        ? { ...lastAwayPitcher, pitchCount: readPitcherPitchCount(tick.feed, lastAwayPitcher.id) }
        : null,
      homePitcher: lastHomePitcher
        ? { ...lastHomePitcher, pitchCount: readPitcherPitchCount(tick.feed, lastHomePitcher.id) }
        : null,
      upcomingBatters: nrXi?.perBatter ?? [],
      pHitEvent: nrXi?.pHitEvent ?? null,
      pNoHitEvent: nrXi?.pNoHitEvent ?? null,
      breakEvenAmerican: nrXi?.breakEvenAmerican ?? null,
      pHitEventFullInning: lastFullInning?.pHit ?? null,
      pNoHitEventFullInning: lastFullInning?.pNo ?? null,
      breakEvenAmericanFullInning: lastFullInning?.breakEven ?? null,
      env,
      lineups: lastLineups ?? extractLineups(tick.feed),
      lineupStats: lastLineupStats,
      linescore: extractLinescore(tick.feed),
      ...extractBatterFocus(tick.feed),
      updatedAt: new Date().toISOString(),
    };

    await publishUpdateStep(state);

    if (status === "Final") {
      console.log("[watcher] final, exit", input.gamePk);
      return { reason: "final" };
    }

    let waitSec = 30;
    if (status === "Live") waitSec = tick.recommendedWaitSeconds;
    else if (status === "Pre") waitSec = 30;
    else if (status === "Delayed" || status === "Suspended") waitSec = 300;

    await refreshWatcherLockStep({
      gamePk: input.gamePk,
      ownerId: input.ownerId,
      ttlSeconds: 90,
    });
    await sleep(`${waitSec}s`);
  }

  console.log("[watcher] max loops reached", input.gamePk);
  return { reason: "max-loops" };
}
