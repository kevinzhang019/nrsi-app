import { describe, it, expect, vi } from "vitest";
import { runSupervisor, defaultIdleDeadline } from "./supervisor";
import type { ScheduledGame } from "./steps/fetch-schedule";

function game(opts: Partial<ScheduledGame> & { gamePk: number; gameDate: string }): ScheduledGame {
  return {
    gamePk: opts.gamePk,
    gameDate: opts.gameDate,
    officialDate: opts.officialDate ?? opts.gameDate.slice(0, 10),
    abstractGameState: opts.abstractGameState ?? "Preview",
    detailedState: opts.detailedState ?? "Scheduled",
    awayTeam: opts.awayTeam ?? { id: 1, name: "Away" },
    homeTeam: opts.homeTeam ?? { id: 2, name: "Home" },
    awayProbablePitcher: opts.awayProbablePitcher ?? null,
    homeProbablePitcher: opts.homeProbablePitcher ?? null,
    venueId: opts.venueId ?? null,
  };
}

describe("defaultIdleDeadline", () => {
  it("returns 06:00 UTC of the day after `now`", () => {
    const now = new Date(Date.UTC(2026, 3, 15, 14, 0, 0)); // 2026-04-15 14:00 UTC
    const d = defaultIdleDeadline(now);
    expect(d.toISOString()).toBe("2026-04-16T06:00:00.000Z");
  });

  it("rolls correctly across month boundaries", () => {
    const now = new Date(Date.UTC(2026, 3, 30, 23, 0, 0)); // 2026-04-30 23:00 UTC
    const d = defaultIdleDeadline(now);
    expect(d.toISOString()).toBe("2026-05-01T06:00:00.000Z");
  });
});

describe("runSupervisor", () => {
  it("exits idle immediately when there are no games and the deadline is past", async () => {
    const fetchScheduleFn = vi.fn().mockResolvedValue([]);
    const seedSnapshotFn = vi.fn().mockResolvedValue({ seeded: 0 });
    const pruneStaleSnapshotsFn = vi.fn().mockResolvedValue({ total: 0, kept: 0, deleted: 0 });
    const runWatcherFn = vi.fn();
    const result = await runSupervisor({
      date: "2026-04-15",
      fetchScheduleFn,
      seedSnapshotFn,
      pruneStaleSnapshotsFn,
      runWatcherFn,
      // Past deadline so the very first idle check exits.
      computeIdleDeadlineFn: () => new Date(Date.now() - 1000),
      idleCheckIntervalMs: 5,
    });
    expect(result).toEqual({ scheduled: 0, reason: "idle" });
    expect(fetchScheduleFn).toHaveBeenCalledTimes(1);
    // No games -> seed not called (avoids a no-op Redis call).
    expect(seedSnapshotFn).not.toHaveBeenCalled();
    // Prune still runs even with zero games — that's how off-season days
    // cleanly wipe the prior day's stale snapshot entries. It receives the
    // supervisor's `date` as the cutoff so prune and seed share one clock.
    expect(pruneStaleSnapshotsFn).toHaveBeenCalledWith({ todayET: "2026-04-15" });
    expect(runWatcherFn).not.toHaveBeenCalled();
  });

  it("skips games already Final", async () => {
    const games = [
      game({ gamePk: 100, gameDate: new Date(Date.now() + 100).toISOString(), abstractGameState: "Final" }),
      game({ gamePk: 200, gameDate: new Date(Date.now() + 100).toISOString() }),
    ];
    const runWatcherFn = vi.fn().mockResolvedValue({ reason: "final" });
    await runSupervisor({
      date: "2026-04-15",
      fetchScheduleFn: vi.fn().mockResolvedValue(games),
      seedSnapshotFn: vi.fn().mockResolvedValue({ seeded: 2 }),
      pruneStaleSnapshotsFn: vi.fn().mockResolvedValue({ total: 0, kept: 0, deleted: 0 }),
      runWatcherFn,
      computeIdleDeadlineFn: () => new Date(Date.now() - 1000),
      idleCheckIntervalMs: 5,
    });
    // Only the non-Final game gets a watcher.
    expect(runWatcherFn).toHaveBeenCalledTimes(1);
    expect(runWatcherFn.mock.calls[0][0]).toMatchObject({ gamePk: 200 });
  });

  it("waits for active watchers to finish before idle-exit", async () => {
    const games = [
      // gameDate already past so watcher starts immediately.
      game({ gamePk: 300, gameDate: new Date(Date.now() - 1000).toISOString() }),
    ];
    let resolveWatcher: () => void = () => {};
    const watcherPromise = new Promise<{ reason: "final" }>((resolve) => {
      resolveWatcher = () => resolve({ reason: "final" });
    });
    const runWatcherFn = vi.fn().mockReturnValue(watcherPromise);

    const supervisorPromise = runSupervisor({
      date: "2026-04-15",
      fetchScheduleFn: vi.fn().mockResolvedValue(games),
      seedSnapshotFn: vi.fn().mockResolvedValue({ seeded: 1 }),
      pruneStaleSnapshotsFn: vi.fn().mockResolvedValue({ total: 0, kept: 0, deleted: 0 }),
      runWatcherFn,
      // Past deadline so the only thing keeping us alive is `pending.size > 0`.
      computeIdleDeadlineFn: () => new Date(Date.now() - 1000),
      idleCheckIntervalMs: 5,
    });

    // Give the supervisor time to schedule + spin its idle loop.
    await new Promise((r) => setTimeout(r, 30));
    expect(runWatcherFn).toHaveBeenCalledTimes(1);

    // Now release the watcher; supervisor should idle-exit on next check.
    resolveWatcher();
    const result = await supervisorPromise;
    expect(result).toEqual({ scheduled: 1, reason: "idle" });
  });

  it("calls prune with the supervisor's date as todayET, regardless of games count", async () => {
    // Regression for BUGS.md bug #10: a rerun whose schedule fetch happens to
    // return zero games (transient API issue, postponements) must not pass a
    // pk-list to prune — we now pass the date, so prune discriminates by each
    // row's own officialDate and leaves today's still-scheduled rows alone.
    const pruneStaleSnapshotsFn = vi.fn().mockResolvedValue({ total: 5, kept: 5, deleted: 0 });
    await runSupervisor({
      date: "2026-05-02",
      fetchScheduleFn: vi.fn().mockResolvedValue([]),
      seedSnapshotFn: vi.fn().mockResolvedValue({ seeded: 0 }),
      pruneStaleSnapshotsFn,
      runWatcherFn: vi.fn(),
      computeIdleDeadlineFn: () => new Date(Date.now() - 1000),
      idleCheckIntervalMs: 5,
    });
    expect(pruneStaleSnapshotsFn).toHaveBeenCalledTimes(1);
    expect(pruneStaleSnapshotsFn).toHaveBeenCalledWith({ todayET: "2026-05-02" });
  });

  it("aborts via signal even when watchers are still running", async () => {
    const games = [
      game({ gamePk: 400, gameDate: new Date(Date.now() - 1000).toISOString() }),
    ];
    // Watcher never resolves on its own — only abort can end it.
    const runWatcherFn = vi.fn().mockImplementation(
      (_input: unknown, signal?: AbortSignal) =>
        new Promise<{ reason: "aborted" }>((resolve) => {
          signal?.addEventListener("abort", () => resolve({ reason: "aborted" }));
        }),
    );
    const ac = new AbortController();
    const supervisorPromise = runSupervisor({
      date: "2026-04-15",
      fetchScheduleFn: vi.fn().mockResolvedValue(games),
      seedSnapshotFn: vi.fn().mockResolvedValue({ seeded: 1 }),
      pruneStaleSnapshotsFn: vi.fn().mockResolvedValue({ total: 0, kept: 0, deleted: 0 }),
      runWatcherFn,
      // Far-future deadline so only abort can end the supervisor.
      computeIdleDeadlineFn: () => new Date(Date.now() + 60 * 60 * 1000),
      idleCheckIntervalMs: 5,
      signal: ac.signal,
    });

    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    const result = await supervisorPromise;
    expect(result).toEqual({ scheduled: 1, reason: "aborted" });
  });
});
