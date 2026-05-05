import { fetchLiveFull } from "../../lib/mlb/client";
import { classifyStatus, type LiveFeed } from "../../lib/mlb/types";
import { finalizeGame } from "../../lib/db/inning-predictions";
import { isSupabaseConfigured, supabaseAdmin } from "../../lib/db/supabase";
import { log } from "../../lib/log";

export type SweepFinalizeResult = {
  candidates: number;
  finalized: number;
  errors: number;
};

export type SweepFinalizeDeps = {
  // Returns the gamePks that may need finalization for the given date.
  // Predicate matches games where we know history is incomplete: stub-only
  // (status != 'Final' or linescore IS NULL) OR at least one inning row
  // still has a NULL actual_runs.
  listCandidateGamePks: (gameDate: string) => Promise<number[]>;
  // Fresh fetchLiveFull — single source of truth for finalization. Throws
  // on network/parse error.
  fetchFreshFeed: (gamePk: number) => Promise<LiveFeed>;
  // Idempotent finalize: UPDATE games + UPSERT plays + UPDATE actual_runs.
  finalize: (args: { gamePk: number; freshFeed: LiveFeed }) => Promise<void>;
};

// Centralized post-game persistence. Runs in the supervisor's idle loop.
// For every today-bucket game whose archive isn't fully written, fetches a
// fresh feed and (if MLB has actually flipped to Final) runs `finalizeGame`.
// Idempotent — re-running over an already-finalized game produces no diff.
//
// Errors per gamePk are caught + warn-logged so one bad game doesn't poison
// the whole pass. Never throws out — supervisor can call this freely.
export async function sweepFinalize(
  opts: { gameDate: string },
  deps: SweepFinalizeDeps,
): Promise<SweepFinalizeResult> {
  const { gameDate } = opts;

  let candidates: number[] = [];
  try {
    candidates = await deps.listCandidateGamePks(gameDate);
  } catch (err) {
    log.warn("sweep-finalize", "listCandidates:fail", {
      gameDate,
      err: String(err),
    });
    return { candidates: 0, finalized: 0, errors: 1 };
  }

  if (candidates.length === 0) {
    return { candidates: 0, finalized: 0, errors: 0 };
  }

  let finalized = 0;
  let errors = 0;

  for (const gamePk of candidates) {
    try {
      const feed = await deps.fetchFreshFeed(gamePk);
      const status = classifyStatus(
        feed.gameData.status.detailedState,
        feed.gameData.status.abstractGameState,
      );
      if (status !== "Final") {
        // Not actually Final yet — leave alone. Will be picked up on a
        // later sweep. Stub-only games whose watchers crashed pre-Final
        // also land here; they'll finalize whenever MLB posts the result.
        continue;
      }
      await deps.finalize({ gamePk, freshFeed: feed });
      finalized += 1;
    } catch (err) {
      errors += 1;
      log.warn("sweep-finalize", "game:fail", {
        gamePk,
        err: String(err),
      });
    }
  }

  if (finalized > 0 || errors > 0) {
    log.info("sweep-finalize", "pass", {
      gameDate,
      candidates: candidates.length,
      finalized,
      errors,
    });
  }
  return { candidates: candidates.length, finalized, errors };
}

// Default deps wired to real Supabase + MLB client. Supervisor uses this;
// tests inject `sweepFinalize` directly with stub deps.
export function defaultSweepFinalizeDeps(): SweepFinalizeDeps | null {
  if (!isSupabaseConfigured()) return null;
  return {
    listCandidateGamePks: defaultListCandidateGamePks,
    fetchFreshFeed: fetchLiveFull,
    finalize: finalizeGame,
  };
}

// Two-stage candidate query: (1) games today whose row is missing or stub-
// only, (2) games today with at least one inning_predictions.actual_runs IS
// NULL. Union of both. We do two queries instead of a JOIN because supabase-
// js doesn't expose efficient subquery patterns and the dataset is tiny
// (≤30 games/day).
async function defaultListCandidateGamePks(gameDate: string): Promise<number[]> {
  const sb = supabaseAdmin();
  const ids = new Set<number>();

  // Stage 1: games row missing/stub
  const { data: stubData, error: stubErr } = await sb
    .from("games")
    .select("game_pk, status, linescore")
    .eq("game_date", gameDate);
  if (stubErr) throw new Error(`sweepFinalize.listCandidates: games query failed — ${stubErr.message}`);
  for (const row of stubData ?? []) {
    if (row.status !== "Final" || row.linescore == null) {
      ids.add(row.game_pk as number);
    }
  }

  // Stage 2: any inning row with NULL actual_runs for a today game.
  // We can scope this via a join on game_date by first listing today's pks
  // (cheap — already fetched above), then querying inning_predictions
  // restricted to those pks.
  const todayPks = (stubData ?? []).map((r) => r.game_pk as number);
  if (todayPks.length > 0) {
    const { data: nullData, error: nullErr } = await sb
      .from("inning_predictions")
      .select("game_pk")
      .in("game_pk", todayPks)
      .is("actual_runs", null);
    if (nullErr) {
      throw new Error(
        `sweepFinalize.listCandidates: inning_predictions query failed — ${nullErr.message}`,
      );
    }
    for (const row of nullData ?? []) {
      ids.add(row.game_pk as number);
    }
  }

  return [...ids];
}
