import { describe, it, expect, vi } from "vitest";
import {
  buildSyntheticFinalState,
  performGracefulExit,
  type GracefulExitDeps,
} from "./finalize-game";
import type { GameState } from "../../lib/state/game-state";

function makeState(overrides: Partial<GameState> = {}): GameState {
  return {
    gamePk: 999,
    status: "Live",
    detailedState: "In Progress",
    inning: 9,
    half: "Top",
    outs: 2,
    bases: 0,
    isDecisionMoment: false,
    isDecisionMomentFullInning: false,
    away: { id: 1, name: "Phillies", runs: 7 },
    home: { id: 2, name: "Marlins", runs: 2 },
    venue: null,
    pitcher: null,
    awayPitcher: null,
    homePitcher: null,
    upcomingBatters: [],
    pHitEvent: 0.05,
    pNoHitEvent: 0.95,
    breakEvenAmerican: -1900,
    pHitEventFullInning: null,
    pNoHitEventFullInning: null,
    breakEvenAmericanFullInning: null,
    env: null,
    lineups: null,
    lineupStats: null,
    linescore: null,
    battingTeam: "away",
    currentBatterId: null,
    nextHalfLeadoffId: null,
    updatedAt: "2026-05-03T20:04:29.491Z",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<GracefulExitDeps> = {}): GracefulExitDeps {
  return {
    publishUpdate: vi.fn().mockResolvedValue(undefined),
    clearWatcherState: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("buildSyntheticFinalState", () => {
  it("flips status to Final and refreshes updatedAt while preserving everything else", () => {
    const last = makeState({ inning: 9, half: "Top", away: { id: 1, name: "Phillies", runs: 7 } });
    const now = new Date("2026-05-03T22:00:00.000Z");
    const out = buildSyntheticFinalState(last, now);
    expect(out.status).toBe("Final");
    expect(out.updatedAt).toBe("2026-05-03T22:00:00.000Z");
    expect(out.inning).toBe(9);
    expect(out.half).toBe("Top");
    expect(out.away.runs).toBe(7);
    expect(out.home.runs).toBe(2);
    expect(out.gamePk).toBe(999);
  });

  it("does not mutate the input state", () => {
    const last = makeState();
    const before = JSON.stringify(last);
    buildSyntheticFinalState(last, new Date());
    expect(JSON.stringify(last)).toBe(before);
  });
});

describe("performGracefulExit", () => {
  const baseInput = {
    gamePk: 823875,
    reason: "max-loops" as const,
  };

  it("publishes a synthetic Final and clears watcher state on every non-Final exit", async () => {
    const deps = makeDeps();
    const last = makeState({ inning: 9, half: "Top", status: "Live" });
    const outcome = await performGracefulExit(
      { ...baseInput, lastPublishedState: last },
      deps,
    );
    expect(outcome).toBe("published");
    expect(deps.publishUpdate).toHaveBeenCalledTimes(1);
    expect(deps.clearWatcherState).toHaveBeenCalledWith(823875);
    const published = (deps.publishUpdate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(published.status).toBe("Final");
    expect(published.inning).toBe(9);
    expect(published.half).toBe("Top");
  });

  it("skips entirely when there is no lastPublishedState", async () => {
    const deps = makeDeps();
    const outcome = await performGracefulExit(
      { ...baseInput, lastPublishedState: null },
      deps,
    );
    expect(outcome).toBe("skipped");
    expect(deps.publishUpdate).not.toHaveBeenCalled();
    expect(deps.clearWatcherState).not.toHaveBeenCalled();
  });

  it("skips synthetic Final publish when lastPublishedState is still Pre but still clears watcher state", async () => {
    // Regression guard for the pre-game-compute feature: a watcher that dies
    // mid-pre-game (max-runtime under the long pre-game window, abort, error,
    // max-loops) must NOT flip the Upcoming card to Finished. The next
    // supervisor cron spawns a fresh watcher, so leaving the Pre stub in
    // place is the correct UI signal. Watcher-state is still cleared so the
    // replacement doesn't try to resume from stale hoisted caches.
    const deps = makeDeps();
    const last = makeState({ status: "Pre", inning: null, half: null });
    const outcome = await performGracefulExit(
      { ...baseInput, lastPublishedState: last },
      deps,
    );
    expect(outcome).toBe("skipped");
    expect(deps.publishUpdate).not.toHaveBeenCalled();
    expect(deps.clearWatcherState).toHaveBeenCalledWith(823875);
  });

  it("does not throw when publishUpdate itself throws", async () => {
    const deps = makeDeps({
      publishUpdate: vi.fn().mockRejectedValue(new Error("redis down")),
    });
    await expect(
      performGracefulExit({ ...baseInput, lastPublishedState: makeState() }, deps),
    ).resolves.toBe("published");
    // Even when publish fails, watcher state is still cleared so the next
    // supervisor run doesn't try to resume from stale hoisted state.
    expect(deps.clearWatcherState).toHaveBeenCalledTimes(1);
  });

  it("does not throw when clearWatcherState throws", async () => {
    const deps = makeDeps({
      clearWatcherState: vi.fn().mockRejectedValue(new Error("redis down")),
    });
    await expect(
      performGracefulExit({ ...baseInput, lastPublishedState: makeState() }, deps),
    ).resolves.toBe("published");
    expect(deps.publishUpdate).toHaveBeenCalledTimes(1);
  });

  it("accepts every non-Final exit reason (same behavior across the bunch)", async () => {
    for (const reason of ["max-loops", "max-runtime", "abort", "error"] as const) {
      const deps = makeDeps();
      const out = await performGracefulExit(
        { ...baseInput, reason, lastPublishedState: makeState() },
        deps,
      );
      expect(out).toBe("published");
      expect(deps.publishUpdate).toHaveBeenCalledTimes(1);
      expect(deps.clearWatcherState).toHaveBeenCalledTimes(1);
    }
  });

  it("does not touch any DB persistence path — supervisor sweep owns finalization now", async () => {
    // Regression guard: the historical finalize-game contract included
    // `fetchLiveDiff`, `persistFinishedGame`, and `buildPlayRows` deps. The
    // new shape only has `publishUpdate` and `clearWatcherState`. If a
    // future refactor folds DB writes back in, this test will catch it.
    const deps = makeDeps();
    await performGracefulExit(
      { ...baseInput, lastPublishedState: makeState() },
      deps,
    );
    expect(Object.keys(deps).sort()).toEqual(
      ["clearWatcherState", "publishUpdate"].sort(),
    );
  });
});
