import { log } from "../../lib/log";
import type { GameState } from "../../lib/state/game-state";

// Builds a synthetic Final state from the last successfully-published state.
// Used by every non-Final exit path so the dashboard moves the game out of
// the Active section into Finished. Flipping `status` to "Final" is enough;
// the rest of the fields stay as they were.
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
// them without touching Redis.
export type GracefulExitDeps = {
  publishUpdate: (state: GameState) => Promise<void>;
  clearWatcherState: (gamePk: number) => Promise<void>;
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
};

export type GracefulExitOutcome = "published" | "skipped";

// Best-effort dashboard cleanup when the watcher exits via any non-Final
// path (budget caps, abort signal, uncaught error). Publishes a synthetic
// `{ ...lastState, status: "Final" }` so the dashboard moves the game out
// of Active, then clears the watcher-state Redis key.
//
// Persistence is NOT done here anymore — the supervisor's `sweepFinalize`
// runs every 60s, fetches a fresh feed, and finalizes any game that's
// truly Final per MLB. Per-inning predictions are already durable in
// Supabase via the watcher's per-boundary `upsertInningPrediction` calls.
//
// Catches every error internally — never throws. The caller (run-watcher.ts)
// can call this and continue with `return { reason: <budget> }` exactly as
// before.
export async function performGracefulExit(
  input: GracefulExitInput,
  deps: GracefulExitDeps,
): Promise<GracefulExitOutcome> {
  const { gamePk, reason, lastPublishedState } = input;

  if (!lastPublishedState) {
    log.warn("watcher", "graceful-exit:skipped", {
      gamePk,
      reason,
      detail: "no lastPublishedState",
    });
    return "skipped";
  }

  // Don't synthetic-Final a game that's still in Pre. The pre-game compute
  // path means a watcher dying via max-runtime / abort / error / max-loops
  // during the long pre-game window would otherwise flip the Upcoming card
  // to Finished hours before first pitch. Leaving the Pre stub in place is
  // the correct UI signal: the game is still scheduled, and the next
  // supervisor cron will spawn a fresh watcher. We still clear the
  // watcher-state Redis key below so the next watcher rebuilds caches from
  // scratch instead of trying to resume from a stale bundle.
  if (lastPublishedState.status === "Pre") {
    log.warn("watcher", "graceful-exit:skipped", {
      gamePk,
      reason,
      detail: "lastPublishedState status=Pre — leaving stub in place",
    });
    try {
      await deps.clearWatcherState(gamePk);
    } catch (err) {
      log.warn("watcher", "graceful-exit:clearWatcherState-fail", {
        gamePk,
        err: String(err),
      });
    }
    return "skipped";
  }

  const synthetic = buildSyntheticFinalState(lastPublishedState);

  log.warn("watcher", "graceful-exit:publish-synthetic", {
    gamePk,
    reason,
    lastInning: lastPublishedState.inning,
    lastHalf: lastPublishedState.half,
    lastStatus: lastPublishedState.status,
  });

  try {
    await deps.publishUpdate(synthetic);
  } catch (err) {
    log.warn("watcher", "graceful-exit:publish-fail", {
      gamePk,
      reason,
      err: String(err),
    });
  }

  // Clear the watcher-state Redis key so a future supervisor run doesn't
  // try to resume from a hoisted-state bundle that no longer reflects
  // reality. Best-effort; the 24h TTL is the backstop.
  try {
    await deps.clearWatcherState(gamePk);
  } catch (err) {
    log.warn("watcher", "graceful-exit:clearWatcherState-fail", {
      gamePk,
      err: String(err),
    });
  }

  return "published";
}
