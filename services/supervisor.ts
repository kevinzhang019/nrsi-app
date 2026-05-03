import { sleepMs, isAbortError } from "./lib/sleep";
import { withRetry } from "./lib/with-retry";
import { runWatcher } from "./run-watcher";
import { fetchScheduleStep, type ScheduledGame } from "./steps/fetch-schedule";
import { seedSnapshotStep } from "./steps/seed-snapshot";
import { pruneStaleSnapshots } from "./lib/prune-snapshots";
import { todayInTz } from "../lib/utils";
import { log } from "../lib/log";

// Pre-game lead time. Watchers spawn at gameDate - PRE_GAME_LEAD_MS so they
// have a few ticks to acquire the lock and seed before first pitch. 90s is
// tighter than the WDK scheduler's 5min lead, saving ~135 unnecessary polls
// per slate (15 games × ~9 saved 30s polls each).
const PRE_GAME_LEAD_MS = 90 * 1000;

// Idle-exit poll cadence. Cheap — every minute we check whether we can shut
// the supervisor down.
const IDLE_CHECK_INTERVAL_MS = 60 * 1000;

// SIGTERM drain budget. Watchers get this long to finish their current tick
// (publish + state save) before the process exits hard.
const DRAIN_TIMEOUT_MS = 30 * 1000;

export type SupervisorOpts = {
  // Override for tests — defaults to today in America/New_York like the WDK
  // scheduler does.
  date?: string;
  // Override for tests — defaults to a real schedule fetch + Redis seed.
  fetchScheduleFn?: (date: string) => Promise<ScheduledGame[]>;
  seedSnapshotFn?: (games: ScheduledGame[]) => Promise<{ seeded: number }>;
  pruneStaleSnapshotsFn?: (opts?: { todayET?: string }) => Promise<{
    total: number;
    kept: number;
    deleted: number;
  }>;
  runWatcherFn?: typeof runWatcher;
  // Override for tests — defaults to "tomorrow at 06:00 UTC". Returning a Date
  // lets tests synthesise a deadline in the very-near future to verify the
  // idle-exit logic without sleeping for hours.
  computeIdleDeadlineFn?: (now: Date) => Date;
  signal?: AbortSignal;
  // Polling cadence override (tests inject a smaller value).
  idleCheckIntervalMs?: number;
};

// Compute the supervisor's idle-exit deadline. The 06:00 UTC cutoff protects
// against late-running doubleheaders that finish past midnight UTC: if the
// last game's Final lands at 04:30 UTC the next day, the supervisor still
// has 90 minutes of slack to clean up before exiting. Railway cron then
// boots a fresh supervisor at 12:00 UTC.
export function defaultIdleDeadline(now: Date): Date {
  const d = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      6,
      0,
      0,
      0,
    ),
  );
  return d;
}

export async function runSupervisor(opts: SupervisorOpts = {}): Promise<{
  scheduled: number;
  reason: "idle" | "aborted";
}> {
  const date = opts.date ?? todayInTz("America/New_York");
  const fetchSchedule = opts.fetchScheduleFn ?? ((d: string) => fetchScheduleStep(d));
  const seedSnapshot = opts.seedSnapshotFn ?? ((g: ScheduledGame[]) => seedSnapshotStep(g));
  const pruneSnapshotsFn = opts.pruneStaleSnapshotsFn ?? pruneStaleSnapshots;
  const runWatcherImpl = opts.runWatcherFn ?? runWatcher;
  const computeIdleDeadline = opts.computeIdleDeadlineFn ?? defaultIdleDeadline;
  const idleInterval = opts.idleCheckIntervalMs ?? IDLE_CHECK_INTERVAL_MS;
  const signal = opts.signal;

  log.info("supervisor", "start", { date });
  const games = await withRetry(() => fetchSchedule(date), { signal, label: "fetchSchedule" });
  log.info("supervisor", "schedule", { count: games.length });

  if (games.length > 0) {
    await withRetry(() => seedSnapshot(games), { signal, label: "seedSnapshot" });
    log.info("supervisor", "seeded");
  }

  // Drop snapshot field-keys whose `officialDate` is older than today (ET).
  // Required because `publishGameState` resets the hash's 24h TTL on every
  // tick, so games from a prior runtime that was mid-watching when
  // paused/crashed can otherwise hang around as "Live" zombies on the
  // dashboard. Discriminator is the row's own `officialDate` rather than the
  // schedule fetch's pk list — a manual rerun whose fetch is partial or
  // empty no longer wipes today's still-scheduled games. See BUGS.md bug #10.
  await withRetry(() => pruneSnapshotsFn({ todayET: date }), {
    signal,
    label: "pruneStaleSnapshots",
  });

  // pending = scheduled-but-not-yet-finished. A game stays in this set from
  // schedule time until its watcher returns (Final, lock-held, max-loops, or
  // aborted). Idle exit fires only when this set drains AND we're past the
  // deadline.
  const pending = new Set<number>();
  const tasks: Promise<void>[] = [];

  for (const g of games) {
    if (g.abstractGameState === "Final") {
      log.info("supervisor", "skip-final", { gamePk: g.gamePk });
      continue;
    }
    pending.add(g.gamePk);

    const startAt = Math.max(Date.now(), new Date(g.gameDate).getTime() - PRE_GAME_LEAD_MS);
    const delayMs = startAt - Date.now();

    const task = (async () => {
      try {
        if (delayMs > 0) {
          try {
            await sleepMs(delayMs, signal);
          } catch (err) {
            if (isAbortError(err)) return;
            throw err;
          }
        }
        if (signal?.aborted) return;
        const ownerId = `watcher-${g.gamePk}-${Date.now()}`;
        await runWatcherImpl(
          {
            gamePk: g.gamePk,
            ownerId,
            awayTeamName: g.awayTeam.name,
            homeTeamName: g.homeTeam.name,
          },
          signal,
        );
      } catch (err) {
        log.error("supervisor", "watcher-task:fail", {
          gamePk: g.gamePk,
          err: String(err),
        });
      } finally {
        pending.delete(g.gamePk);
      }
    })();
    tasks.push(task);
  }

  // Idle-exit loop. Sleeps in IDLE_CHECK_INTERVAL_MS slices so a SIGTERM gets
  // picked up promptly. We exit cleanly once nothing is pending AND we're
  // past the cutoff (so doubleheaders finishing past midnight don't trigger
  // a premature exit).
  const deadline = computeIdleDeadline(new Date());
  log.info("supervisor", "idle-deadline", { deadline: deadline.toISOString() });

  while (true) {
    if (signal?.aborted) {
      log.info("supervisor", "aborted");
      break;
    }
    if (pending.size === 0 && Date.now() >= deadline.getTime()) {
      log.info("supervisor", "idle-exit", { date });
      break;
    }
    try {
      await sleepMs(idleInterval, signal);
    } catch (err) {
      if (isAbortError(err)) break;
      throw err;
    }
  }

  // Drain — give watchers a finite window to wind down. They should return
  // promptly because they observe the same abort signal we forwarded.
  await Promise.race([
    Promise.allSettled(tasks),
    sleepMs(DRAIN_TIMEOUT_MS).then(() => {
      log.warn("supervisor", "drain-timeout");
    }),
  ]);

  return {
    scheduled: tasks.length,
    reason: signal?.aborted ? "aborted" : "idle",
  };
}
