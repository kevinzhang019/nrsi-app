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

    let nrsi: Awaited<ReturnType<typeof computeNrsiStep>> | null = null;
    let env: { parkRunFactor: number; weatherRunFactor: number; weather?: Record<string, unknown> } | null = null;

    if (shouldRecompute && upcoming) {
      const [splits, parkFactor, weather] = await Promise.all([
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
      nrsi = await computeNrsiStep({
        gamePk: input.gamePk,
        pitcher: splits.pitcher,
        batters: splits.batters,
        parkRunFactor: parkFactor,
        weatherRunFactor: weather.factor,
      });
      env = {
        parkRunFactor: parkFactor,
        weatherRunFactor: weather.factor,
        weather: weather.info as unknown as Record<string, unknown>,
      };
      lastInningKey = inningKey;
      lastLineupHash = lh;
    }

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
      pitcher: nrsi
        ? {
            id: nrsi.perBatter[0]
              ? upcoming?.pitcherId ?? 0
              : 0,
            name: "",
            throws: "R",
          }
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
