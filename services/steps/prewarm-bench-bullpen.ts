import {
  loadBatterPaProfile,
  loadHand,
  loadPitcherPaProfile,
} from "@/lib/mlb/splits";
import { log } from "@/lib/log";
import type { LiveFeed } from "@/lib/mlb/types";

// Pre-warms Redis caches for bench hitters and bullpen pitchers so that when
// a substitution happens mid-game, the recompute path is a pure cache hit
// instead of a fresh MLB Stats API round-trip on the critical path.
export async function prewarmBenchAndBullpenStep(opts: {
  gamePk: number;
  feed: LiveFeed;
}): Promise<void> {
  const { gamePk, feed } = opts;
  const teams = feed.liveData.boxscore?.teams;
  if (!teams) return;

  const benchIds = dedupe([
    ...(teams.away.bench ?? []),
    ...(teams.home.bench ?? []),
  ]);
  const bullpenIds = dedupe([
    ...(teams.away.bullpen ?? []),
    ...(teams.home.bullpen ?? []),
  ]);
  const allIds = dedupe([...benchIds, ...bullpenIds]);

  if (allIds.length === 0) return;

  log.info("step", "prewarmBenchBullpen:start", {
    gamePk,
    bench: benchIds.length,
    bullpen: bullpenIds.length,
  });

  const tasks: Promise<unknown>[] = [
    ...allIds.map((id) =>
      loadHand(id).catch((err) =>
        log.warn("step", "prewarmBenchBullpen:hand", {
          gamePk,
          playerId: id,
          err: String(err),
        }),
      ),
    ),
    ...benchIds.map((id) =>
      loadBatterPaProfile(id).catch((err) =>
        log.warn("step", "prewarmBenchBullpen:bat", {
          gamePk,
          playerId: id,
          err: String(err),
        }),
      ),
    ),
    ...bullpenIds.map((id) =>
      loadPitcherPaProfile(id).catch((err) =>
        log.warn("step", "prewarmBenchBullpen:pit", {
          gamePk,
          playerId: id,
          err: String(err),
        }),
      ),
    ),
  ];

  await Promise.allSettled(tasks);
  log.info("step", "prewarmBenchBullpen:ok", { gamePk });
}

function dedupe(ids: number[]): number[] {
  return [...new Set(ids.filter((n) => Number.isInteger(n)))];
}
