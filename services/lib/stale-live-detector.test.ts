import { describe, it, expect, vi } from "vitest";
import { detectAndCleanStaleLive, type StaleLiveCleanDeps } from "./stale-live-detector";
import type { GameState } from "../../lib/state/game-state";

const NOW_MS = Date.parse("2026-05-03T22:00:00.000Z");

function state(overrides: Partial<GameState> & { gamePk: number; updatedAt: string }): GameState {
  return {
    gamePk: overrides.gamePk,
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
    pHitEvent: null,
    pNoHitEvent: null,
    breakEvenAmerican: null,
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
    updatedAt: overrides.updatedAt,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<StaleLiveCleanDeps> = {}): StaleLiveCleanDeps {
  return {
    hgetall: vi.fn().mockResolvedValue(null),
    getLock: vi.fn().mockResolvedValue(null),
    publishUpdate: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("detectAndCleanStaleLive", () => {
  it("is a no-op when the snapshot hash is empty", async () => {
    const deps = makeDeps({ hgetall: vi.fn().mockResolvedValue(null) });
    const r = await detectAndCleanStaleLive({ nowMs: NOW_MS }, deps);
    expect(r).toEqual({ total: 0, staleLive: 0, cleaned: 0 });
    expect(deps.publishUpdate).not.toHaveBeenCalled();
  });

  it("publishes a synthetic Final for a stale-Live entry with no lock", async () => {
    const stuck = state({
      gamePk: 823875,
      status: "Live",
      // 5 minutes old — well past the 60s default threshold.
      updatedAt: new Date(NOW_MS - 5 * 60 * 1000).toISOString(),
    });
    const deps = makeDeps({
      hgetall: vi.fn().mockResolvedValue({ "823875": stuck }),
      getLock: vi.fn().mockResolvedValue(null),
    });
    const r = await detectAndCleanStaleLive({ nowMs: NOW_MS }, deps);
    expect(r).toEqual({ total: 1, staleLive: 1, cleaned: 1 });
    expect(deps.publishUpdate).toHaveBeenCalledTimes(1);
    const published = (deps.publishUpdate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(published.status).toBe("Final");
    expect(published.gamePk).toBe(823875);
    expect(published.inning).toBe(9);
  });

  it("leaves an entry alone when the lock is still held (active watcher)", async () => {
    const live = state({
      gamePk: 825013,
      status: "Live",
      updatedAt: new Date(NOW_MS - 5 * 60 * 1000).toISOString(),
    });
    const deps = makeDeps({
      hgetall: vi.fn().mockResolvedValue({ "825013": live }),
      getLock: vi.fn().mockResolvedValue("watcher-825013-12345"),
    });
    const r = await detectAndCleanStaleLive({ nowMs: NOW_MS }, deps);
    expect(r).toEqual({ total: 1, staleLive: 1, cleaned: 0 });
    expect(deps.publishUpdate).not.toHaveBeenCalled();
  });

  it("leaves an entry alone when updatedAt is fresh (under threshold)", async () => {
    const fresh = state({
      gamePk: 825013,
      status: "Live",
      updatedAt: new Date(NOW_MS - 10 * 1000).toISOString(), // 10s old
    });
    const deps = makeDeps({
      hgetall: vi.fn().mockResolvedValue({ "825013": fresh }),
      getLock: vi.fn().mockResolvedValue(null),
    });
    const r = await detectAndCleanStaleLive({ nowMs: NOW_MS }, deps);
    expect(r).toEqual({ total: 1, staleLive: 0, cleaned: 0 });
    expect(deps.getLock).not.toHaveBeenCalled();
    expect(deps.publishUpdate).not.toHaveBeenCalled();
  });

  it("ignores entries with non-Live status", async () => {
    const final = state({
      gamePk: 822742,
      status: "Final",
      updatedAt: new Date(NOW_MS - 5 * 60 * 1000).toISOString(),
    });
    const pre = state({
      gamePk: 999999,
      status: "Pre",
      updatedAt: new Date(NOW_MS - 60 * 60 * 1000).toISOString(),
    });
    const deps = makeDeps({
      hgetall: vi.fn().mockResolvedValue({ "822742": final, "999999": pre }),
    });
    const r = await detectAndCleanStaleLive({ nowMs: NOW_MS }, deps);
    expect(r).toEqual({ total: 2, staleLive: 0, cleaned: 0 });
    expect(deps.getLock).not.toHaveBeenCalled();
    expect(deps.publishUpdate).not.toHaveBeenCalled();
  });

  it("tolerates Upstash auto-parsed objects AND raw JSON strings in the same hash", async () => {
    const objShape = state({
      gamePk: 100,
      updatedAt: new Date(NOW_MS - 5 * 60 * 1000).toISOString(),
    });
    const stringShape = JSON.stringify(
      state({
        gamePk: 200,
        updatedAt: new Date(NOW_MS - 5 * 60 * 1000).toISOString(),
      }),
    );
    const deps = makeDeps({
      hgetall: vi.fn().mockResolvedValue({ "100": objShape, "200": stringShape }),
    });
    const r = await detectAndCleanStaleLive({ nowMs: NOW_MS }, deps);
    expect(r).toEqual({ total: 2, staleLive: 2, cleaned: 2 });
    expect(deps.publishUpdate).toHaveBeenCalledTimes(2);
  });

  it("skips malformed entries instead of throwing", async () => {
    const good = state({
      gamePk: 100,
      updatedAt: new Date(NOW_MS - 5 * 60 * 1000).toISOString(),
    });
    const deps = makeDeps({
      hgetall: vi.fn().mockResolvedValue({
        "100": good,
        "200": "not-json",
        "300": null,
        "400": 12345,
      }),
    });
    const r = await detectAndCleanStaleLive({ nowMs: NOW_MS }, deps);
    expect(r).toEqual({ total: 4, staleLive: 1, cleaned: 1 });
  });

  it("processes a mixed snapshot (1 stale-cleanable, 1 lock-held, 1 fresh, 1 Final)", async () => {
    const stuck = state({
      gamePk: 100,
      updatedAt: new Date(NOW_MS - 10 * 60 * 1000).toISOString(),
    });
    const lockHeld = state({
      gamePk: 200,
      updatedAt: new Date(NOW_MS - 10 * 60 * 1000).toISOString(),
    });
    const fresh = state({
      gamePk: 300,
      updatedAt: new Date(NOW_MS - 5 * 1000).toISOString(),
    });
    const final = state({
      gamePk: 400,
      status: "Final",
      updatedAt: new Date(NOW_MS - 60 * 60 * 1000).toISOString(),
    });
    const deps = makeDeps({
      hgetall: vi.fn().mockResolvedValue({
        "100": stuck,
        "200": lockHeld,
        "300": fresh,
        "400": final,
      }),
      getLock: vi.fn().mockImplementation(async (pk: number) => (pk === 200 ? "owner-200" : null)),
    });
    const r = await detectAndCleanStaleLive({ nowMs: NOW_MS }, deps);
    expect(r).toEqual({ total: 4, staleLive: 2, cleaned: 1 });
    expect(deps.publishUpdate).toHaveBeenCalledTimes(1);
    const published = (deps.publishUpdate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(published.gamePk).toBe(100);
  });

  it("returns gracefully when hgetall throws", async () => {
    const deps = makeDeps({
      hgetall: vi.fn().mockRejectedValue(new Error("redis down")),
    });
    const r = await detectAndCleanStaleLive({ nowMs: NOW_MS }, deps);
    expect(r).toEqual({ total: 0, staleLive: 0, cleaned: 0 });
  });

  it("continues past per-entry getLock failures", async () => {
    const a = state({
      gamePk: 100,
      updatedAt: new Date(NOW_MS - 5 * 60 * 1000).toISOString(),
    });
    const b = state({
      gamePk: 200,
      updatedAt: new Date(NOW_MS - 5 * 60 * 1000).toISOString(),
    });
    const deps = makeDeps({
      hgetall: vi.fn().mockResolvedValue({ "100": a, "200": b }),
      getLock: vi.fn().mockImplementation(async (pk: number) => {
        if (pk === 100) throw new Error("redis hiccup");
        return null;
      }),
    });
    const r = await detectAndCleanStaleLive({ nowMs: NOW_MS }, deps);
    expect(r).toEqual({ total: 2, staleLive: 2, cleaned: 1 });
    expect(deps.publishUpdate).toHaveBeenCalledTimes(1);
    const published = (deps.publishUpdate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(published.gamePk).toBe(200);
  });

  it("respects a custom staleAfterMs threshold", async () => {
    const justOverDefault = state({
      gamePk: 100,
      updatedAt: new Date(NOW_MS - 70 * 1000).toISOString(), // 70s
    });
    // With a 2-minute threshold, 70s is fresh — should NOT clean.
    const deps = makeDeps({
      hgetall: vi.fn().mockResolvedValue({ "100": justOverDefault }),
    });
    const r = await detectAndCleanStaleLive(
      { nowMs: NOW_MS, staleAfterMs: 120 * 1000 },
      deps,
    );
    expect(r).toEqual({ total: 1, staleLive: 0, cleaned: 0 });
  });
});
