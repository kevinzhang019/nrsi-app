import { classifyStatus } from "../../lib/mlb/types";
import { log } from "../../lib/log";
import type { GameState } from "../../lib/state/game-state";
import type { LiveFeed } from "../../lib/mlb/types";
import type { InningCapture, PlayRow } from "../../lib/types/history";

// Builds a synthetic Final state from the last successfully-published state.
// Used by the graceful-exit path when the watcher runs out of MAX_LOOPS /
// MAX_RUNTIME_MS budget but the live feed still says the game is in progress
// (likely an MLB feed lag or our budget being too tight). Flipping `status`
// to "Final" is enough to move the game out of the dashboard's Active
// section into Finished — the rest of the fields stay as they were.
//
// Pure function. Caller is responsible for actually publishing the result
// and for not calling this when `lastPublishedState` is null.
export function buildSyntheticFinalState(
  lastPublishedState: GameState,
  now: Date = new Date(),
): GameState {
  return {
    ...lastPublishedState,
    status: "Final",
    updatedAt: now.toISOString(),
  };
}

// Dependencies the orchestrator needs. Injected so the unit test can stub
// them without touching Redis, MLB, or Supabase.
export type GracefulExitDeps = {
  fetchLiveDiff: () => Promise<{ feed: LiveFeed }>;
  publishUpdate: (state: GameState) => Promise<void>;
  persistFinishedGame: (args: {
    finalState: GameState;
    capturedInnings: Record<string, InningCapture>;
    playRows: PlayRow[];
  }) => Promise<void>;
  clearWatcherState: (gamePk: number) => Promise<void>;
  buildPlayRows: (feed: LiveFeed, gamePk: number) => PlayRow[];
};

// All the ways a watcher can exit without taking the normal Final branch.
// Each one leaves the snapshot stuck in "Live" state if not cleaned up:
//   - max-loops    : MAX_LOOPS budget tripped (loop counter ceiling)
//   - max-runtime  : MAX_RUNTIME_MS budget tripped (wall-clock ceiling)
//   - abort        : SIGTERM / supervisor abort signal — process is shutting
//                    down, drain budget gives us ~30s to clean up
//   - error        : an uncaught error thrown by any step in the main loop
export type GracefulExitReason = "max-loops" | "max-runtime" | "abort" | "error";

export type GracefulExitInput = {
  gamePk: number;
  reason: GracefulExitReason;
  // The last state successfully published in the main loop. May be null if
  // the watcher never reached its first publish (very rare); in that case the
  // helper logs and no-ops because there's no useful state to publish.
  lastPublishedState: GameState | null;
  capturedInnings: Record<string, InningCapture>;
};

export type GracefulExitOutcome = "finalized" | "abandoned" | "skipped";

// Best-effort cleanup when the watcher exits via any non-Final path (budget
// caps, abort signal, uncaught error). Three possible paths:
//
// 1. "finalized" — one final feed fetch shows the game has actually flipped
//    to Final. Persists the full game (Supabase) and clears watcher state,
//    same as the main-loop Final branch. This is the common case: MLB lags
//    a few minutes between the actual end and flipping the status field.
//
// 2. "abandoned" — feed still says Live (or fetch failed). Publishes a
//    synthetic { ...lastPublishedState, status: "Final" } so the dashboard
//    moves the game out of Active into Finished, AND persists the captured
//    per-inning predictions so they don't evaporate with the watcher's
//    24h Redis TTL. The synthetic state's score / linescore lag MLB's true
//    final, but `actual_runs` is nullable in the schema and any future
//    re-run cleanly overwrites the row via the `(game_pk)` /
//    `(game_pk, inning, half)` upsert. Skipped entirely when there are no
//    captures and no plays — no point creating an empty `games` row.
//
// 3. "skipped" — no lastPublishedState (we never even reached the first
//    publish). Nothing to clean up; just log and return. The seeded "Pre"
//    snapshot, if any, will get cleaned by tomorrow's prune.
//
// Catches every error internally — never throws. The whole point is that the
// caller (run-watcher.ts) can call this, ignore its return, and continue
// with `return { reason: <budget> }` exactly as before.
export async function performGracefulExit(
  input: GracefulExitInput,
  deps: GracefulExitDeps,
): Promise<GracefulExitOutcome> {
  const { gamePk, reason, lastPublishedState, capturedInnings } = input;

  if (!lastPublishedState) {
    log.warn("watcher", "graceful-exit:skipped", {
      gamePk,
      reason,
      detail: "no lastPublishedState",
    });
    return "skipped";
  }

  // Final feed fetch — best-effort. Lets us catch the common "MLB hadn't
  // flipped to Final yet when we hit the budget" case and finalize for real.
  let feed: LiveFeed | null = null;
  try {
    const tick = await deps.fetchLiveDiff();
    feed = tick.feed;
  } catch (err) {
    log.warn("watcher", "graceful-exit:fetch-fail", {
      gamePk,
      reason,
      err: String(err),
    });
  }

  const liveStatus = feed
    ? classifyStatus(
        feed.gameData.status.detailedState,
        feed.gameData.status.abstractGameState,
      )
    : null;

  if (feed && liveStatus === "Final") {
    // Real Final — same path as the main-loop Final branch.
    try {
      const playRows = deps.buildPlayRows(feed, gamePk);
      const finalState = buildSyntheticFinalState(lastPublishedState);
      log.info("watcher", "graceful-exit:finalized", {
        gamePk,
        reason,
        innings: Object.keys(capturedInnings).length,
        plays: playRows.length,
      });
      await deps.persistFinishedGame({ finalState, capturedInnings, playRows });
      try {
        await deps.clearWatcherState(gamePk);
      } catch (err) {
        log.warn("watcher", "graceful-exit:clearWatcherState-fail", {
          gamePk,
          err: String(err),
        });
      }
      return "finalized";
    } catch (err) {
      log.warn("watcher", "graceful-exit:finalize-fail", {
        gamePk,
        reason,
        err: String(err),
      });
      // Fall through to abandoned: at least flip the dashboard.
    }
  }

  // Abandoned: no verified Final, but we still have a published state. Flip
  // its status to Final so the dashboard moves it out of Active, and persist
  // whatever per-inning predictions we captured so they survive the watcher's
  // 24h Redis TTL. Skipped entirely when there's nothing to save.
  const synthetic = buildSyntheticFinalState(lastPublishedState);

  // Build playRows from the last successful feed fetch, if any. If we never
  // got a feed (fetch threw above) or the transform throws on a partial feed,
  // fall through with an empty array — the inning_predictions are the
  // load-bearing data here.
  let playRows: PlayRow[] = [];
  if (feed) {
    try {
      playRows = deps.buildPlayRows(feed, gamePk);
    } catch (err) {
      log.warn("watcher", "graceful-exit:buildPlayRows-fail", {
        gamePk,
        reason,
        err: String(err),
      });
    }
  }

  const inningCount = Object.keys(capturedInnings).length;

  log.warn("watcher", "graceful-exit:abandoned", {
    gamePk,
    reason,
    innings: inningCount,
    plays: playRows.length,
    lastInning: lastPublishedState.inning,
    lastHalf: lastPublishedState.half,
    lastStatus: lastPublishedState.status,
  });

  // Persist before publish: if both fail, we still want the inning data
  // landed. Skip the persist call entirely when there's nothing to save —
  // an empty `games` row is worse than no row.
  if (inningCount > 0 || playRows.length > 0) {
    try {
      await deps.persistFinishedGame({
        finalState: synthetic,
        capturedInnings,
        playRows,
      });
    } catch (err) {
      log.warn("watcher", "graceful-exit:persist-fail", {
        gamePk,
        reason,
        err: String(err),
      });
    }
  }

  try {
    await deps.publishUpdate(synthetic);
    return "abandoned";
  } catch (err) {
    log.warn("watcher", "graceful-exit:publish-fail", {
      gamePk,
      reason,
      err: String(err),
    });
    return "abandoned";
  }
}
