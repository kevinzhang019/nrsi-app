import { sleepMs, isAbortError } from "./lib/sleep";
import { withRetry } from "./lib/with-retry";
import {
  acquireWatcherLock,
  startLockRefresher,
} from "./lib/lock";
import {
  loadWatcherState,
  saveWatcherState,
  clearWatcherState,
  emptyWatcherState,
  type WatcherState,
} from "./lib/watcher-state";
import { fetchLiveDiffStep } from "./steps/fetch-live-diff";
import { loadLineupSplitsStep } from "./steps/load-lineup-splits";
import { loadParkFactorStep } from "./steps/load-park-factor";
import { loadWeatherStep } from "./steps/load-weather";
import { loadDefenseStep } from "./steps/load-defense";
import { prewarmBenchAndBullpenStep } from "./steps/prewarm-bench-bullpen";
import { computeNrXiStep } from "./steps/compute-nrXi";
import { computeLineupStatsStep } from "./steps/compute-lineup-stats";
import { publishUpdateStep } from "./steps/publish-update";
import { enrichLineupHandsStep } from "./steps/enrich-lineup-hands";
import { performGracefulExit, type GracefulExitReason } from "./lib/finalize-game";
import { buildInningCapture } from "./capture-inning";
import {
  upsertInningPrediction,
  gameStubContextFromState,
} from "../lib/db/inning-predictions";
import { readMarkovStartState } from "./start-state";
import { shouldSkipBottomNinth } from "./full-inning";
import { getUpcomingForCurrentInning, lineupHash } from "../lib/mlb/lineup";
import { extractLineups, extractLinescore, extractBatterFocus } from "../lib/mlb/extract";
import {
  isDecisionMoment,
  isDecisionMomentFullInning,
  type GameState,
  type LineupBatterStat,
} from "../lib/state/game-state";
import { classifyStatus } from "../lib/mlb/types";
import { americanBreakEven, roundOdds } from "../lib/prob/odds";
import { log } from "../lib/log";
import type { LiveFeed } from "../lib/mlb/types";

function readPitcherPitchCount(feed: LiveFeed, pitcherId: number): number | null {
  const teams = feed.liveData.boxscore?.teams;
  if (!teams) return null;
  const key = `ID${pitcherId}`;
  const p = teams.home.players?.[key] ?? teams.away.players?.[key];
  const n = p?.stats?.pitching?.numberOfPitches;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function readDisplayBases(feed: LiveFeed, status: string): number | null {
  if (status !== "Live") return null;
  const off = feed.liveData.linescore.offense ?? {};
  const b1 = off.first?.id ? 1 : 0;
  const b2 = off.second?.id ? 2 : 0;
  const b3 = off.third?.id ? 4 : 0;
  return b1 | b2 | b3;
}

function readPaInGameForPitcher(feed: LiveFeed, pitcherId: number): number {
  const teams = feed.liveData.boxscore?.teams;
  if (!teams) return 0;
  const key = `ID${pitcherId}`;
  const fromHome = teams.home.players?.[key]?.stats?.pitching?.battersFaced;
  const fromAway = teams.away.players?.[key]?.stats?.pitching?.battersFaced;
  return fromHome ?? fromAway ?? 0;
}

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

export type WatcherResult = {
  reason: "lock-held" | "final" | "max-loops" | "max-runtime" | "aborted" | "error";
};

const SEASON = new Date().getUTCFullYear();
// Loop ceiling sized to comfortably outlast a normal MLB game at the active
// 5s PA-polling cadence: 5000 × 5s ≈ 7h. Pre-game ticks at 1800s/tick add
// at most ~24 iterations across an entire 12h pre-game window, so this cap
// is dominated by the live phase. Historically MAX_LOOPS was 1500 (≈2h)
// and watchers hit it during the late innings, exiting silently and leaving
// the dashboard's snapshot stuck on a "Live" 9th — see `services/lib/
// finalize-game.ts` for the graceful-exit cleanup that the budget exits
// now run.
const MAX_LOOPS = 5000;
// Hard wall-clock cap. Sized to comfortably outlast the supervisor's own
// lifetime (waking at 12:00 UTC, idle-exit deadline at 06:00 UTC next day
// = 18h). With `PRE_GAME_LEAD_MS = 24h` in the supervisor, watchers spawn
// at supervisor wake and need to stay alive through pre-game + game-end.
// Anything past 20h is the supervisor parent process exiting, not this
// cap; this cap exists only as a defense against a runaway watcher that
// outlives its parent. The previous 6h cap was sized for the legacy 90s
// pre-game lead and fires immediately under the new lead, flipping every
// scheduled game to a synthetic Final via gracefulExit before games even
// start — the regression that motivates this bump.
const MAX_RUNTIME_MS = 20 * 60 * 60 * 1000;

// Run a single game's watcher loop to completion (Final or abort). Designed
// to live inside a long-running Node process (Railway, Fly.io, or local dev
// via bin/run-watcher-once.ts). Acquires a Redis lock keyed by gamePk, runs
// the same two-phase recompute trigger as the WDK workflow, and persists
// hoisted state to Redis once per loop iteration so a process restart can
// resume without losing capturedInnings.
export async function runWatcher(
  input: WatcherInput,
  signal?: AbortSignal,
): Promise<WatcherResult> {
  log.info("watcher", "start", { gamePk: input.gamePk });

  const owned = await withRetry(
    () => acquireWatcherLock({ gamePk: input.gamePk, ownerId: input.ownerId }),
    { signal, label: "acquireWatcherLock" },
  );
  if (!owned) {
    log.warn("watcher", "lock-held-by-other", { gamePk: input.gamePk });
    return { reason: "lock-held" };
  }

  // Background lock refresher — runs every 10s, stops when this watcher exits
  // or the parent process aborts. Decoupled from the loop cadence so long
  // pre-game / delayed sleeps don't risk lock expiration.
  const lockController = new AbortController();
  const stopChain: (() => void)[] = [];
  if (signal) {
    const fwd = () => lockController.abort();
    signal.addEventListener("abort", fwd, { once: true });
    stopChain.push(() => signal.removeEventListener("abort", fwd));
  }
  const stopRefresher = startLockRefresher({
    gamePk: input.gamePk,
    ownerId: input.ownerId,
    signal: lockController.signal,
  });
  stopChain.push(stopRefresher);
  const cleanup = () => {
    lockController.abort();
    for (const fn of stopChain) {
      try { fn(); } catch { /* ignore */ }
    }
  };

  try {
    // Hydrate hoisted state from Redis. On first start this returns
    // emptyWatcherState(); on a process restart we recover capturedInnings
    // and the last-published view. We deliberately skip lastTimecode/prevDoc
    // and the structural/playState trigger keys — the first tick refetches
    // the full feed and unconditionally fires Phase 1, which rebuilds caches.
    const restored: WatcherState = await loadWatcherState(input.gamePk);

    let lastTimecode: string | null = null;
    let prevDoc: LiveFeed | null = null;
    let lastEnrichedHash = restored.lastEnrichedHash;
    let lastLineups: Awaited<ReturnType<typeof enrichLineupHandsStep>> | null = restored.lastLineups;
    let lastStructuralKey = "";
    let lastPlayStateKey = "";
    let splitsCache: Awaited<ReturnType<typeof loadLineupSplitsStep>> | null = null;
    let parkCache: Awaited<ReturnType<typeof loadParkFactorStep>> | null = null;
    let weatherCache: Awaited<ReturnType<typeof loadWeatherStep>> | null = null;
    let defenseCache: Awaited<ReturnType<typeof loadDefenseStep>> | null = null;
    let oppHalfCleanCache: { pHitEvent: number; pNoHitEvent: number } | null = null;
    let lastNrXi: Awaited<ReturnType<typeof computeNrXiStep>> | null = restored.lastNrXi;
    let lastEnv = restored.lastEnv;
    let lastPitcherId = restored.lastPitcherId;
    let lastPitcherName = restored.lastPitcherName;
    let lastPitcherThrows: "L" | "R" = restored.lastPitcherThrows;
    let lastPitcherEra = restored.lastPitcherEra;
    let lastPitcherWhip = restored.lastPitcherWhip;
    let lastAwayPitcher = restored.lastAwayPitcher;
    let lastHomePitcher = restored.lastHomePitcher;
    // Per-team most-recent batter id. Updated only on live-play ticks so the
    // value freezes at the half-inning break and lets extractBatterFocus
    // resolve the next-half leadoff as order[(idx + 1) % 9] for the OTHER
    // team instead of always returning order[0].
    let lastAwayBatterId = restored.lastAwayBatterId;
    let lastHomeBatterId = restored.lastHomeBatterId;
    let lastFullInning = restored.lastFullInning;
    let lastLineupStats: GameState["lineupStats"] = restored.lastLineupStats;
    let capturedInnings = restored.capturedInnings;
    // Tracked so the graceful-exit path (MAX_LOOPS / MAX_RUNTIME_MS) can flip
    // status to "Final" on the most recent state we successfully published,
    // instead of leaving the snapshot stuck in "Live" forever.
    let lastPublishedState: GameState | null = null;

    const startedAt = Date.now();

    // Best-effort cleanup invoked from every non-Final exit path: the budget
    // caps (max-loops / max-runtime), supervisor abort (SIGTERM), and any
    // uncaught error in a step. Just publishes a synthetic-Final to the
    // dashboard snapshot and clears the watcher-state Redis key. The
    // supervisor sweep handles all DB persistence (`finalizeGame`) once MLB
    // flips the game to Final per a fresh fetchLiveFull.
    const gracefulExit = async (reason: GracefulExitReason): Promise<void> => {
      try {
        await performGracefulExit(
          {
            gamePk: input.gamePk,
            reason,
            lastPublishedState,
          },
          {
            publishUpdate: publishUpdateStep,
            clearWatcherState,
          },
        );
      } catch (err) {
        // performGracefulExit catches its own errors, but defend against an
        // unexpected throw — this path must never escalate the original
        // budget-exit reason into a watcher crash.
        log.warn("watcher", "graceful-exit:unexpected", {
          gamePk: input.gamePk,
          reason,
          err: String(err),
        });
      }
    };

    for (let loop = 0; loop < MAX_LOOPS; loop++) {
      if (signal?.aborted) {
        await gracefulExit("abort");
        return { reason: "aborted" };
      }
      if (Date.now() - startedAt > MAX_RUNTIME_MS) {
        log.warn("watcher", "max-runtime", { gamePk: input.gamePk, loop });
        await gracefulExit("max-runtime");
        return { reason: "max-runtime" };
      }

      try {

        const tick = await withRetry(
          () => fetchLiveDiffStep({ gamePk: input.gamePk, startTimecode: lastTimecode, prevDoc }),
          { signal, label: "fetchLiveDiff" },
        );
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

        // Track the most-recent batter per team during live play. Skipping
        // middle/end/3-out ticks freezes the value across the inning break, so
        // when the half flips we still know exactly where each team left off
        // and can hand a real leadoff (= next spot in the order) to the UI.
        const inningStateLower = inningState.toLowerCase();
        const isLivePa =
          status === "Live" &&
          outs !== null &&
          outs < 3 &&
          inningStateLower !== "middle" &&
          inningStateLower !== "end";
        if (isLivePa) {
          const currentBatterIdRaw = ls.offense?.batter?.id ?? null;
          if (currentBatterIdRaw !== null) {
            if (ls.isTopInning === true) lastAwayBatterId = currentBatterIdRaw;
            else if (ls.isTopInning === false) lastHomeBatterId = currentBatterIdRaw;
          }
        }

        const lh = lineupHash(
          tick.feed.liveData.boxscore?.teams.home.battingOrder,
          tick.feed.liveData.boxscore?.teams.away.battingOrder,
        );
        const alignment = readDefenseAlignment(tick.feed);
        const dk = defenseAlignmentKey(alignment.catcherId, alignment.fielderIds);
        const upcoming = getUpcomingForCurrentInning(tick.feed);
        const bothPitchers = readBothPitchers(tick.feed);
        const op = `${bothPitchers.awayPitcherId ?? "_"}-${bothPitchers.homePitcherId ?? "_"}`;

        const homeRuns = ls.teams?.home.runs ?? 0;
        const awayRuns = ls.teams?.away.runs ?? 0;
        const bottomNinthSkipped = shouldSkipBottomNinth({
          inning: upcoming?.inning ?? null,
          half: upcoming?.half ?? null,
          homeRuns,
          awayRuns,
        });

        const atBat = upcoming?.upcomingBatterIds[0] ?? "_";
        const structuralKey = `${upcoming?.half ?? "_"}|${upcoming?.inning ?? "_"}|${lh}|${dk}|${op}|${atBat}|${bottomNinthSkipped ? "skip9" : "play9"}`;
        const atBatIndex = tick.feed.liveData.plays?.currentPlay?.about?.atBatIndex ?? -1;
        const startStatePeek = readMarkovStartState(tick.feed, upcoming?.inning ?? null);
        const playStateKey = `${startStatePeek.outs}-${startStatePeek.bases}-${atBatIndex}`;

        const isLive =
          status === "Live" && upcoming !== null && upcoming.pitcherId !== null;
        // Pre-game compute path: lineups are posted (upcoming non-null) and
        // probable pitchers are known, so the same Phase 1 / Phase 2 pipeline
        // that the live watcher runs can produce a half-inning prediction now.
        // Persistence is still gated on `status === "Live"` further down — the
        // pre-game preview updates `lastNrXi` (so the dashboard sees it) but
        // never writes to Supabase. The first live tick re-runs Phase 1 with
        // current inputs and the capture fires from there.
        const isPregameReady =
          status === "Pre" && upcoming !== null && upcoming.pitcherId !== null;
        const canCompute = isLive || isPregameReady;
        const shouldReloadStructure = canCompute && structuralKey !== lastStructuralKey;
        const shouldRecomputePlay =
          canCompute && (shouldReloadStructure || playStateKey !== lastPlayStateKey);

        log.info("watcher", "tick", {
          gamePk: input.gamePk,
          loop,
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
        });

        if (lh !== lastEnrichedHash) {
          const rawLineups = extractLineups(tick.feed);
          lastLineups = await withRetry(
            () => enrichLineupHandsStep({ gamePk: input.gamePk, lineups: rawLineups }),
            { signal, label: "enrichLineupHands" },
          );
          lastEnrichedHash = lh;
        }

        // ---- Phase 1: structural reload ----
        if (shouldReloadStructure && upcoming) {
          const [splits, park, weather, defense] = await Promise.all([
            withRetry(
              () =>
                loadLineupSplitsStep({
                  gamePk: input.gamePk,
                  pitcherId: upcoming.pitcherId!,
                  batterIds: upcoming.upcomingBatterIds,
                }),
              { signal, label: "loadLineupSplits" },
            ),
            withRetry(
              () =>
                loadParkFactorStep({
                  gamePk: input.gamePk,
                  homeTeamName: input.homeTeamName,
                  season: SEASON,
                }),
              { signal, label: "loadParkFactor" },
            ),
            withRetry(
              () =>
                loadWeatherStep({
                  gamePk: input.gamePk,
                  awayTeam: input.awayTeamName,
                  homeTeam: input.homeTeamName,
                }),
              { signal, label: "loadWeather" },
            ),
            withRetry(
              () => loadDefenseStep({ gamePk: input.gamePk, season: SEASON }),
              { signal, label: "loadDefense" },
            ),
          ]);
          splitsCache = splits;
          parkCache = park;
          weatherCache = weather;
          defenseCache = defense;

          // Fire-and-forget cache warmup for everyone on the bench / in the
          // bullpen so a pinch-hit or relief change later in the game is a pure
          // Redis hit instead of a critical-path MLB Stats API round-trip.
          void prewarmBenchAndBullpenStep({
            gamePk: input.gamePk,
            feed: tick.feed,
          }).catch((err) =>
            log.warn("watcher", "prewarmBenchBullpen:err", {
              gamePk: input.gamePk,
              err: String(err),
            }),
          );

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

          const awayStarterIds = starterIdsOf(lastLineups?.away ?? null);
          const homeStarterIds = starterIdsOf(lastLineups?.home ?? null);
          const [awayBundle, homeBundle] = await Promise.all([
            bothPitchers.homePitcherId !== null && awayStarterIds
              ? withRetry(
                  () =>
                    loadLineupSplitsStep({
                      gamePk: input.gamePk,
                      pitcherId: bothPitchers.homePitcherId!,
                      batterIds: awayStarterIds,
                    }),
                  { signal, label: "loadLineupSplits:awayBundle" },
                )
              : Promise.resolve(null),
            bothPitchers.awayPitcherId !== null && homeStarterIds
              ? withRetry(
                  () =>
                    loadLineupSplitsStep({
                      gamePk: input.gamePk,
                      pitcherId: bothPitchers.awayPitcherId!,
                      batterIds: homeStarterIds,
                    }),
                  { signal, label: "loadLineupSplits:homeBundle" },
                )
              : Promise.resolve(null),
          ]);

          const awayStats: Record<string, LineupBatterStat> = awayBundle
            ? await withRetry(
                () =>
                  computeLineupStatsStep({
                    gamePk: input.gamePk,
                    pitcher: awayBundle.pitcher,
                    batters: awayBundle.batters,
                    park: park.components,
                    weather: weather.components,
                    oaaTable: upcoming.half === "Top" ? defense.oaaTable : undefined,
                    framingTable: upcoming.half === "Top" ? defense.framingTable : undefined,
                    catcherId: upcoming.half === "Top" ? alignment.catcherId : null,
                    fielderIds: upcoming.half === "Top" ? alignment.fielderIds : [],
                  }),
                { signal, label: "computeLineupStats:away" },
              )
            : {};
          const homeStats: Record<string, LineupBatterStat> = homeBundle
            ? await withRetry(
                () =>
                  computeLineupStatsStep({
                    gamePk: input.gamePk,
                    pitcher: homeBundle.pitcher,
                    batters: homeBundle.batters,
                    park: park.components,
                    weather: weather.components,
                    oaaTable: upcoming.half === "Bottom" ? defense.oaaTable : undefined,
                    framingTable: upcoming.half === "Bottom" ? defense.framingTable : undefined,
                    catcherId: upcoming.half === "Bottom" ? alignment.catcherId : null,
                    fielderIds: upcoming.half === "Bottom" ? alignment.fielderIds : [],
                  }),
                { signal, label: "computeLineupStats:home" },
              )
            : {};
          lastLineupStats = { away: awayStats, home: homeStats };

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

          if (upcoming.half === "Top" && !bottomNinthSkipped && homeBundle) {
            const oppHalf = await withRetry(
              () =>
                computeNrXiStep({
                  gamePk: input.gamePk,
                  pitcher: homeBundle.pitcher,
                  batters: homeBundle.batters,
                  park: park.components,
                  weather: weather.components,
                  startState: { outs: 0, bases: upcoming.inning >= 10 ? 2 : 0 },
                  paInGameForPitcher: 0,
                  oaaTable: defense.oaaTable,
                  framingTable: defense.framingTable,
                  catcherId: null,
                  fielderIds: [],
                  inning: upcoming.inning,
                  half: "Bottom",
                }),
              { signal, label: "computeNrXi:oppHalf" },
            );
            oppHalfCleanCache = {
              pHitEvent: oppHalf.pHitEvent,
              pNoHitEvent: oppHalf.pNoHitEvent,
            };
          } else {
            oppHalfCleanCache = null;
          }

          lastStructuralKey = structuralKey;
        }

        // ---- Phase 2: play-state recompute ----
        if (
          shouldRecomputePlay &&
          upcoming &&
          splitsCache &&
          parkCache &&
          weatherCache &&
          defenseCache
        ) {
          const startState = readMarkovStartState(tick.feed, upcoming.inning);
          const paInGameForPitcher = readPaInGameForPitcher(tick.feed, upcoming.pitcherId!);
          lastNrXi = await withRetry(
            () =>
              computeNrXiStep({
                gamePk: input.gamePk,
                pitcher: splitsCache!.pitcher,
                batters: splitsCache!.batters,
                park: parkCache!.components,
                weather: weatherCache!.components,
                startState,
                paInGameForPitcher,
                oaaTable: defenseCache!.oaaTable,
                framingTable: defenseCache!.framingTable,
                catcherId: alignment.catcherId,
                fielderIds: alignment.fielderIds,
                inning: upcoming.inning,
                half: upcoming.half,
              }),
            { signal, label: "computeNrXi:play" },
          );

          if (bottomNinthSkipped) {
            lastFullInning = {
              pHit: lastNrXi.pHitEvent,
              pNo: lastNrXi.pNoHitEvent,
              breakEven: lastNrXi.breakEvenAmerican,
            };
          } else if (upcoming.half === "Top" && oppHalfCleanCache) {
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
        const decisionFull = isDecisionMomentFullInning({
          status,
          inning,
          half,
          outs,
          inningState,
          upcomingHalf: upcoming?.half ?? null,
        });

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
          ...extractBatterFocus(tick.feed, { away: lastAwayBatterId, home: lastHomeBatterId }),
          updatedAt: new Date().toISOString(),
          // Carry venue-local game day + UTC start time straight off the live
          // feed. The seeded snapshot set these at Pre-game from the schedule,
          // but the watcher's published state would otherwise drop them on the
          // first live tick. History persistence (lib/db/games.ts:gameDateOf)
          // reads officialDate to bucket the row under the correct local day
          // instead of UTC.
          startTime: tick.feed.gameData.datetime?.dateTime,
          officialDate: tick.feed.gameData.datetime?.officialDate,
        };

        // Persist only once status flips to Live. Pre-game ticks still run
        // Phase 1 / Phase 2 to surface a preview prediction on the dashboard,
        // but Supabase rows must hold the prediction at the moment the inning
        // actually begins — not whatever we computed hours earlier. The first
        // live tick recomputes (atBatIndex flips, structuralKey changes) and
        // the capture fires from that recompute.
        if (status === "Live") {
          const captureCandidate = buildInningCapture({
            inning,
            half,
            nrXi: lastNrXi,
            pitcher: state.pitcher,
            awayPitcher: state.awayPitcher,
            homePitcher: state.homePitcher,
            env: state.env,
            lineupStats: state.lineupStats,
            defenseKey: dk,
          });
          if (captureCandidate && !capturedInnings[captureCandidate.key]) {
            capturedInnings[captureCandidate.key] = captureCandidate.capture;
            // Fire-and-forget per-boundary write to Supabase. Failures are
            // logged but never block the watcher tick — the supervisor sweep
            // backstops any rows that don't make it. The in-memory map stays
            // as a thin retry/dedup buffer; predictions are durable from the
            // moment they're computed, no longer hostage to the watcher
            // reaching Final.
            const captureKey = captureCandidate.key;
            const captureToWrite = captureCandidate.capture;
            void upsertInningPrediction({
              context: gameStubContextFromState(state),
              capture: captureToWrite,
            }).catch((err) =>
              log.warn("watcher", "upsertInningPrediction:fail", {
                gamePk: input.gamePk,
                key: captureKey,
                err: String(err),
              }),
            );
          }
        }

        await withRetry(() => publishUpdateStep(state), { signal, label: "publishUpdate" });
        // Remember the most recent state we published so that, if the watcher
        // exits via MAX_LOOPS / MAX_RUNTIME_MS instead of the normal Final
        // branch, gracefulExit can flip its status to "Final" and clear the
        // zombie from the dashboard.
        lastPublishedState = state;

        // Persist hoisted state once per tick. The trigger keys are deliberately
        // skipped (see watcher-state.ts) so a restart fires one Phase 1 reload.
        // `capturedInnings` is intentionally NOT serialized — predictions are
        // durable in Supabase from the moment they're computed (see the
        // upsertInningPrediction call above). The map stays in-process as a
        // thin retry/dedup buffer only.
        try {
          await saveWatcherState(input.gamePk, {
            ...emptyWatcherState(),
            lastEnrichedHash,
            lastLineups: lastLineups ?? null,
            lastNrXi,
            lastEnv,
            lastFullInning,
            lastLineupStats,
            lastPitcherId,
            lastPitcherName,
            lastPitcherThrows,
            lastPitcherEra,
            lastPitcherWhip,
            lastAwayPitcher,
            lastHomePitcher,
            lastAwayBatterId,
            lastHomeBatterId,
          });
        } catch (err) {
          log.error("watcher", "saveWatcherState:fail", {
            gamePk: input.gamePk,
            err: String(err),
          });
        }

        if (status === "Final") {
          // No DB writes here — the supervisor's sweep-finalize handles
          // games / plays / actual_runs from a fresh fetchLiveFull. The
          // last publishUpdateStep above already pushed the real Final
          // state to the dashboard snapshot; we just clear watcher state
          // and exit.
          log.info("watcher", "final", {
            gamePk: input.gamePk,
            innings: Object.keys(capturedInnings).length,
          });
          try {
            await clearWatcherState(input.gamePk);
          } catch (err) {
            log.warn("watcher", "clearWatcherState:fail", {
              gamePk: input.gamePk,
              err: String(err),
            });
          }
          return { reason: "final" };
        }

        let waitSec = 30;
        if (status === "Live") waitSec = tick.recommendedWaitSeconds;
        else if (status === "Pre") waitSec = 1800;
        else if (status === "Delayed" || status === "Suspended") waitSec = 300;

        // sleepMs throws AbortError on abort — caught by the outer try/catch
        // below, which routes to gracefulExit("abort"). Other errors here
        // would route to gracefulExit("error"), which is the right behavior.
        await sleepMs(waitSec * 1000, signal);
      } catch (err) {
        if (isAbortError(err)) {
          await gracefulExit("abort");
          return { reason: "aborted" };
        }
        // Any other thrown step in the loop body — log, clean up, exit. The
        // alternative (continuing the loop) would mean the same step throws
        // again next tick, just spamming errors. Exiting forces a fresh
        // supervisor run to spawn a new watcher with clean state.
        log.error("watcher", "loop:error", {
          gamePk: input.gamePk,
          loop,
          err: String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        await gracefulExit("error");
        return { reason: "error" };
      }
    }

    log.warn("watcher", "max-loops", { gamePk: input.gamePk });
    await gracefulExit("max-loops");
    return { reason: "max-loops" };
  } finally {
    cleanup();
  }
}
