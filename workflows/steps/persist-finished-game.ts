import { saveFinishedGame, type SaveFinishedGameArgs } from "@/lib/db/games";
import { isSupabaseConfigured } from "@/lib/db/supabase";
import { log } from "@/lib/log";

// Persists the finished game + all captured per-inning predictions to the
// `games` and `inning_predictions` tables. Runs only when Supabase is
// configured (Vercel Marketplace integration installed) — otherwise logs and
// no-ops so the watcher's Final exit path is unaffected on dev/preview boxes
// without DB credentials.
export async function persistFinishedGameStep(args: SaveFinishedGameArgs): Promise<void> {
  "use step";
  const gamePk = args.finalState.gamePk;
  log.info("step", "persistFinishedGame:start", {
    gamePk,
    innings: Object.keys(args.capturedInnings).length,
  });
  if (!isSupabaseConfigured()) {
    log.warn("step", "persistFinishedGame:skip-no-config", { gamePk });
    return;
  }
  await saveFinishedGame(args);
  log.info("step", "persistFinishedGame:ok", { gamePk });
}
