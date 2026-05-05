import { describe, it, expect, vi } from "vitest";
import { sweepFinalize, type SweepFinalizeDeps } from "./sweep-finalize";
import type { LiveFeed } from "../../lib/mlb/types";

function makeFeed(detailedState: string, abstractGameState: string): LiveFeed {
  return {
    gameData: {
      status: { detailedState, abstractGameState },
    },
  } as unknown as LiveFeed;
}

function makeDeps(overrides: Partial<SweepFinalizeDeps> = {}): SweepFinalizeDeps {
  return {
    listCandidateGamePks: vi.fn().mockResolvedValue([]),
    fetchFreshFeed: vi.fn().mockResolvedValue(makeFeed("Final", "Final")),
    finalize: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("sweepFinalize", () => {
  it("no-ops when there are zero candidates", async () => {
    const deps = makeDeps({ listCandidateGamePks: vi.fn().mockResolvedValue([]) });
    const result = await sweepFinalize({ gameDate: "2026-05-04" }, deps);
    expect(result).toEqual({ candidates: 0, finalized: 0, errors: 0 });
    expect(deps.fetchFreshFeed).not.toHaveBeenCalled();
    expect(deps.finalize).not.toHaveBeenCalled();
  });

  it("finalizes each Final candidate and skips Live ones", async () => {
    const deps = makeDeps({
      listCandidateGamePks: vi.fn().mockResolvedValue([1, 2, 3]),
      fetchFreshFeed: vi.fn().mockImplementation(async (pk: number) => {
        // pk 2 is still Live; 1 and 3 are Final.
        if (pk === 2) return makeFeed("In Progress", "Live");
        return makeFeed("Final", "Final");
      }),
    });

    const result = await sweepFinalize({ gameDate: "2026-05-04" }, deps);
    expect(result).toEqual({ candidates: 3, finalized: 2, errors: 0 });
    expect(deps.fetchFreshFeed).toHaveBeenCalledTimes(3);
    expect(deps.finalize).toHaveBeenCalledTimes(2);
    const finalizedPks = (deps.finalize as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0].gamePk)
      .sort();
    expect(finalizedPks).toEqual([1, 3]);
  });

  it("counts errors per-game and continues to the next candidate", async () => {
    const deps = makeDeps({
      listCandidateGamePks: vi.fn().mockResolvedValue([1, 2, 3]),
      fetchFreshFeed: vi.fn().mockImplementation(async (pk: number) => {
        if (pk === 2) throw new Error("network down");
        return makeFeed("Final", "Final");
      }),
    });

    const result = await sweepFinalize({ gameDate: "2026-05-04" }, deps);
    expect(result.candidates).toBe(3);
    expect(result.finalized).toBe(2);
    expect(result.errors).toBe(1);
    expect(deps.finalize).toHaveBeenCalledTimes(2);
  });

  it("returns errors:1 and zero finalized when the candidate query throws", async () => {
    const deps = makeDeps({
      listCandidateGamePks: vi.fn().mockRejectedValue(new Error("supabase down")),
    });
    const result = await sweepFinalize({ gameDate: "2026-05-04" }, deps);
    expect(result).toEqual({ candidates: 0, finalized: 0, errors: 1 });
    expect(deps.fetchFreshFeed).not.toHaveBeenCalled();
  });

  it("never throws when finalize itself throws", async () => {
    const deps = makeDeps({
      listCandidateGamePks: vi.fn().mockResolvedValue([42]),
      finalize: vi.fn().mockRejectedValue(new Error("plays insert failed")),
    });
    const result = await sweepFinalize({ gameDate: "2026-05-04" }, deps);
    expect(result).toEqual({ candidates: 1, finalized: 0, errors: 1 });
  });

  it("re-running the sweep with no remaining work is a clean no-op", async () => {
    // First pass finalizes everything.
    const listFn = vi.fn().mockResolvedValueOnce([1]).mockResolvedValueOnce([]);
    const deps = makeDeps({
      listCandidateGamePks: listFn,
    });
    await sweepFinalize({ gameDate: "2026-05-04" }, deps);
    const second = await sweepFinalize({ gameDate: "2026-05-04" }, deps);
    expect(second).toEqual({ candidates: 0, finalized: 0, errors: 0 });
  });
});
