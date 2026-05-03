import { describe, it, expect, vi } from "vitest";
import {
  buildSyntheticFinalState,
  performGracefulExit,
  type GracefulExitDeps,
} from "./finalize-game";
import type { GameState } from "../../lib/state/game-state";
import type { LiveFeed } from "../../lib/mlb/types";

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

function makeFeed(detailedState: string, abstractGameState: string): LiveFeed {
  return {
    gameData: {
      status: { detailedState, abstractGameState },
    },
  } as unknown as LiveFeed;
}

function makeDeps(overrides: Partial<GracefulExitDeps> = {}): GracefulExitDeps {
  return {
    fetchLiveDiff: vi.fn().mockResolvedValue({ feed: makeFeed("In Progress", "Live") }),
    publishUpdate: vi.fn().mockResolvedValue(undefined),
    persistFinishedGame: vi.fn().mockResolvedValue(undefined),
    clearWatcherState: vi.fn().mockResolvedValue(undefined),
    buildPlayRows: vi.fn().mockReturnValue([]),
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
    capturedInnings: {},
  };

  it("finalizes when the final fetch shows status === Final", async () => {
    const deps = makeDeps({
      fetchLiveDiff: vi.fn().mockResolvedValue({ feed: makeFeed("Final", "Final") }),
      buildPlayRows: vi.fn().mockReturnValue([{ atBatIndex: 0 } as never]),
    });
    const last = makeState();
    const outcome = await performGracefulExit(
      { ...baseInput, lastPublishedState: last },
      deps,
    );
    expect(outcome).toBe("finalized");
    expect(deps.persistFinishedGame).toHaveBeenCalledTimes(1);
    expect(deps.publishUpdate).not.toHaveBeenCalled();
    expect(deps.clearWatcherState).toHaveBeenCalledWith(823875);
    const persistArgs = (deps.persistFinishedGame as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(persistArgs.finalState.status).toBe("Final");
    expect(persistArgs.finalState.gamePk).toBe(999);
    expect(persistArgs.playRows).toHaveLength(1);
  });

  it("publishes a synthetic Final when the feed still says Live", async () => {
    const deps = makeDeps({
      fetchLiveDiff: vi.fn().mockResolvedValue({ feed: makeFeed("In Progress", "Live") }),
    });
    const last = makeState({ inning: 9, half: "Top", status: "Live" });
    const outcome = await performGracefulExit(
      { ...baseInput, lastPublishedState: last },
      deps,
    );
    expect(outcome).toBe("abandoned");
    expect(deps.publishUpdate).toHaveBeenCalledTimes(1);
    expect(deps.persistFinishedGame).not.toHaveBeenCalled();
    expect(deps.clearWatcherState).not.toHaveBeenCalled();
    const published = (deps.publishUpdate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(published.status).toBe("Final");
    expect(published.inning).toBe(9);
    expect(published.half).toBe("Top");
  });

  it("publishes a synthetic Final when the final fetch throws", async () => {
    const deps = makeDeps({
      fetchLiveDiff: vi.fn().mockRejectedValue(new Error("network blew up")),
    });
    const last = makeState();
    const outcome = await performGracefulExit(
      { ...baseInput, lastPublishedState: last },
      deps,
    );
    expect(outcome).toBe("abandoned");
    expect(deps.publishUpdate).toHaveBeenCalledTimes(1);
    expect(deps.persistFinishedGame).not.toHaveBeenCalled();
  });

  it("falls through to abandoned if persistFinishedGame throws on a real Final", async () => {
    const deps = makeDeps({
      fetchLiveDiff: vi.fn().mockResolvedValue({ feed: makeFeed("Final", "Final") }),
      persistFinishedGame: vi.fn().mockRejectedValue(new Error("supabase down")),
    });
    const outcome = await performGracefulExit(
      { ...baseInput, lastPublishedState: makeState() },
      deps,
    );
    expect(outcome).toBe("abandoned");
    expect(deps.publishUpdate).toHaveBeenCalledTimes(1);
  });

  it("skips entirely when there is no lastPublishedState", async () => {
    const deps = makeDeps();
    const outcome = await performGracefulExit(
      { ...baseInput, lastPublishedState: null },
      deps,
    );
    expect(outcome).toBe("skipped");
    expect(deps.fetchLiveDiff).not.toHaveBeenCalled();
    expect(deps.publishUpdate).not.toHaveBeenCalled();
    expect(deps.persistFinishedGame).not.toHaveBeenCalled();
  });

  it("does not throw when publishUpdate itself throws on the abandoned path", async () => {
    const deps = makeDeps({
      publishUpdate: vi.fn().mockRejectedValue(new Error("redis down")),
    });
    await expect(
      performGracefulExit({ ...baseInput, lastPublishedState: makeState() }, deps),
    ).resolves.toBe("abandoned");
  });

  it("accepts the new abort + error reasons (same behavior as max-loops)", async () => {
    for (const reason of ["abort", "error"] as const) {
      const deps = makeDeps({
        fetchLiveDiff: vi.fn().mockResolvedValue({ feed: makeFeed("In Progress", "Live") }),
      });
      const out = await performGracefulExit(
        { ...baseInput, reason, lastPublishedState: makeState() },
        deps,
      );
      expect(out).toBe("abandoned");
      expect(deps.publishUpdate).toHaveBeenCalledTimes(1);
    }
  });
});
