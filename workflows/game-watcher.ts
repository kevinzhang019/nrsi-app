import { sleep } from "workflow";
import { acquireWatcherLockStep, refreshWatcherLockStep } from "./steps/lock";
import { fetchLiveDiffStep } from "./steps/fetch-live-diff";
import { loadLineupSplitsStep } from "./steps/load-lineup-splits";
import { loadParkFactorStep } from "./steps/load-park-factor";
import { loadWeatherStep } from "./steps/load-weather";
import { computeNrsiStep } from "./steps/compute-nrsi";
import { publishUpdateStep } from "./steps/publish-update";
import { getUpcomingForCurrentInning, lineupHash } from "@/lib/mlb/lineup";
import { isDecisionMoment, type GameState } from "@/lib/state/game-state";
import { classifyStatus } from "@/lib/mlb/types";
import type { LiveFeed } from "@/lib/mlb/types";
import type { Bases, GameState as MarkovState } from "@/lib/prob/markov";

// Read live (outs, bases) from the MLB feed. Bases use the canonical 3-bit
// encoding shared with the Markov chain (bit0=1st, bit1=2nd, bit2=3rd).
function readMarkovStartState(feed: LiveFeed): MarkovState {
  const ls = feed.liveData.linescore;
  const o = ls.outs ?? 0;
  const outs = (o >= 3 ? 0 : o) as 0 | 1 | 2; // mid-change-of-innings: outs may briefly hit 3
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
  let lastInningKey = "";
  let lastLineupHash = "";
  let lastNrsi: Awaited<ReturnType<typeof computeNrsiStep>> | null = null;
  let lastEnv: { parkRunFactor: number; weatherRunFactor: number; weather?: Record<string, unknown> } | null = null;
  let lastPitcherId: number | null = null;
  let lastPitcherName = "";
  let lastPitcherThrows: "L" | "R" = "R";

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

    const inningKey = `${inning}-${half}-${(outs ?? 0) >= 3 ? "end" : inningState || "live"}`;
    const lh = lineupHash(
      tick.feed.liveData.boxscore?.teams.home.battingOrder,
      tick.feed.liveData.boxscore?.teams.away.battingOrder,
    );
    const upcoming = getUpcomingForCurrentInning(tick.feed);

    const shouldRecompute =
      status === "Live" &&
      upcoming !== null &&
      upcoming.pitcherId !== null &&
      (inningKey !== lastInningKey || lh !== lastLineupHash);

    console.log(
      "[watcher] tick",
      JSON.stringify({
        gamePk: input.gamePk,
        status,
        inningKey,
        upcoming: upcoming
          ? { pitcherId: upcoming.pitcherId, batters: upcoming.upcomingBatterIds.length }
          : null,
        shouldRecompute,
      }),
    );

    if (shouldRecompute && upcoming) {
      const [splits, park, weather] = await Promise.all([
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
      ]);
      const startState = readMarkovStartState(tick.feed);
      const paInGameForPitcher = readPaInGameForPitcher(tick.feed, upcoming.pitcherId!);
      lastNrsi = await computeNrsiStep({
        gamePk: input.gamePk,
        pitcher: splits.pitcher,
        batters: splits.batters,
        park: park.components,
        weather: weather.components,
        startState,
        paInGameForPitcher,
      });
      lastEnv = {
        parkRunFactor: park.runFactor,
        weatherRunFactor: weather.factor,
        weather: weather.info as unknown as Record<string, unknown>,
      };
      lastPitcherId = splits.pitcher.id;
      lastPitcherName = splits.pitcher.fullName;
      lastPitcherThrows = splits.pitcher.throws;
      lastInningKey = inningKey;
      lastLineupHash = lh;
    }

    const nrsi = lastNrsi;
    const env = lastEnv;

    const decision = isDecisionMoment({ status, inning, half, outs, inningState });

    const state: GameState = {
      gamePk: input.gamePk,
      status,
      detailedState: tick.feed.gameData.status.detailedState ?? "",
      inning,
      half,
      outs,
      isDecisionMoment: decision,
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
          ? { id: lastPitcherId, name: lastPitcherName, throws: lastPitcherThrows }
          : null,
      upcomingBatters: nrsi?.perBatter ?? [],
      pHitEvent: nrsi?.pHitEvent ?? null,
      pNoHitEvent: nrsi?.pNoHitEvent ?? null,
      breakEvenAmerican: nrsi?.breakEvenAmerican ?? null,
      env,
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
