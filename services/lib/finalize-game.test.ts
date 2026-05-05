import { describe, it, expect, vi } from "vitest";
import {
  buildSyntheticFinalState,
  performGracefulExit,
  type GracefulExitDeps,
} from "./finalize-game";
import type { GameState } from "../../lib/state/game-state";
import type { LiveFeed } from "../../lib/mlb/types";
import type { InningCapture } from "../../lib/types/history";

function makeInningCapture(
  inning: number,
  half: "Top" | "Bottom",
  overrides: Partial<InningCapture> = {},
): InningCapture {
  return {
    inning,
    half,
    pNoRun: 0.7,
    pRun: 0.3,
    breakEvenAmerican: -230,
    perBatter: [],
    pitcher: { active: null, away: null, home: null },
    env: null,
    lineupStats: null,
    defenseKey: "",
    capturedAt: "2026-05-03T19:00:00.000Z",
    ...overrides,
  };
}

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

  describe("abandoned path persistence (bug: missing inning_predictions)", () => {
    it("persists captured innings on the abandoned path so they don't evaporate with the 24h Redis TTL", async () => {
      const deps = makeDeps({
        fetchLiveDiff: vi.fn().mockResolvedValue({ feed: makeFeed("In Progress", "Live") }),
      });
      const captured = {
        "1-Top": makeInningCapture(1, "Top"),
        "1-Bottom": makeInningCapture(1, "Bottom"),
        "2-Top": makeInningCapture(2, "Top"),
      };
      const outcome = await performGracefulExit(
        { ...baseInput, capturedInnings: captured, lastPublishedState: makeState() },
        deps,
      );
      expect(outcome).toBe("abandoned");
      expect(deps.persistFinishedGame).toHaveBeenCalledTimes(1);
      const args = (deps.persistFinishedGame as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(args.finalState.status).toBe("Final");
      expect(args.capturedInnings).toBe(captured);
      expect(Object.keys(args.capturedInnings)).toHaveLength(3);
      // Dashboard cleanup still happens too — both writes matter.
      expect(deps.publishUpdate).toHaveBeenCalledTimes(1);
      // Watcher state is NOT cleared on abandoned (24h TTL drains it),
      // distinguishing this from the finalized path.
      expect(deps.clearWatcherState).not.toHaveBeenCalled();
    });

    it("persists when there are play rows even with zero captured innings", async () => {
      const deps = makeDeps({
        fetchLiveDiff: vi.fn().mockResolvedValue({ feed: makeFeed("In Progress", "Live") }),
        buildPlayRows: vi.fn().mockReturnValue([{ atBatIndex: 0 } as never, { atBatIndex: 1 } as never]),
      });
      const outcome = await performGracefulExit(
        { ...baseInput, lastPublishedState: makeState() },
        deps,
      );
      expect(outcome).toBe("abandoned");
      expect(deps.persistFinishedGame).toHaveBeenCalledTimes(1);
      const args = (deps.persistFinishedGame as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(args.playRows).toHaveLength(2);
    });

    it("skips persist entirely when there are no captures and no plays — no empty `games` row", async () => {
      const deps = makeDeps({
        fetchLiveDiff: vi.fn().mockResolvedValue({ feed: makeFeed("In Progress", "Live") }),
      });
      const outcome = await performGracefulExit(
        { ...baseInput, lastPublishedState: makeState() },
        deps,
      );
      expect(outcome).toBe("abandoned");
      expect(deps.persistFinishedGame).not.toHaveBeenCalled();
      // Dashboard still gets the synthetic Final.
      expect(deps.publishUpdate).toHaveBeenCalledTimes(1);
    });

    it("returns abandoned and still publishes when persistFinishedGame throws", async () => {
      const deps = makeDeps({
        fetchLiveDiff: vi.fn().mockResolvedValue({ feed: makeFeed("In Progress", "Live") }),
        persistFinishedGame: vi.fn().mockRejectedValue(new Error("supabase down")),
      });
      const captured = { "1-Top": makeInningCapture(1, "Top") };
      const outcome = await performGracefulExit(
        { ...baseInput, capturedInnings: captured, lastPublishedState: makeState() },
        deps,
      );
      expect(outcome).toBe("abandoned");
      expect(deps.persistFinishedGame).toHaveBeenCalledTimes(1);
      // Publish still fires — dashboard cleanup is independent of persist.
      expect(deps.publishUpdate).toHaveBeenCalledTimes(1);
    });

    it("falls back to empty playRows and still persists captures when buildPlayRows throws", async () => {
      const deps = makeDeps({
        fetchLiveDiff: vi.fn().mockResolvedValue({ feed: makeFeed("In Progress", "Live") }),
        buildPlayRows: vi.fn().mockImplementation(() => {
          throw new Error("malformed allPlays");
        }),
      });
      const captured = { "1-Top": makeInningCapture(1, "Top") };
      const outcome = await performGracefulExit(
        { ...baseInput, capturedInnings: captured, lastPublishedState: makeState() },
        deps,
      );
      expect(outcome).toBe("abandoned");
      expect(deps.persistFinishedGame).toHaveBeenCalledTimes(1);
      const args = (deps.persistFinishedGame as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(args.playRows).toEqual([]);
      expect(Object.keys(args.capturedInnings)).toHaveLength(1);
    });

    it("persists captures even when the final feed fetch failed (no feed → empty plays)", async () => {
      const deps = makeDeps({
        fetchLiveDiff: vi.fn().mockRejectedValue(new Error("network blew up")),
      });
      const captured = { "1-Top": makeInningCapture(1, "Top") };
      const outcome = await performGracefulExit(
        { ...baseInput, capturedInnings: captured, lastPublishedState: makeState() },
        deps,
      );
      expect(outcome).toBe("abandoned");
      // buildPlayRows should NOT be called when feed fetch failed.
      expect(deps.buildPlayRows).not.toHaveBeenCalled();
      expect(deps.persistFinishedGame).toHaveBeenCalledTimes(1);
      const args = (deps.persistFinishedGame as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(args.playRows).toEqual([]);
    });
  });
});
