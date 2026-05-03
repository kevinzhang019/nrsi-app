import { describe, it, expect, vi, beforeEach } from "vitest";

const handCalls: number[] = [];
const batCalls: number[] = [];
const pitCalls: number[] = [];
let throwOn: { kind: "hand" | "bat" | "pit"; id: number } | null = null;

vi.mock("@/lib/mlb/splits", () => ({
  loadHand: async (id: number) => {
    handCalls.push(id);
    if (throwOn?.kind === "hand" && throwOn.id === id) throw new Error("boom-hand");
    return { id, fullName: `P${id}`, bats: "R", throws: "R" };
  },
  loadBatterPaProfile: async (id: number) => {
    batCalls.push(id);
    if (throwOn?.kind === "bat" && throwOn.id === id) throw new Error("boom-bat");
    return { id, fullName: `B${id}` };
  },
  loadPitcherPaProfile: async (id: number) => {
    pitCalls.push(id);
    if (throwOn?.kind === "pit" && throwOn.id === id) throw new Error("boom-pit");
    return { id, fullName: `H${id}` };
  },
}));

import { prewarmBenchAndBullpenStep } from "./prewarm-bench-bullpen";
import type { LiveFeed } from "@/lib/mlb/types";

function makeFeed(opts: {
  awayBench?: number[];
  homeBench?: number[];
  awayBullpen?: number[];
  homeBullpen?: number[];
}): LiveFeed {
  return {
    liveData: {
      boxscore: {
        teams: {
          away: { bench: opts.awayBench, bullpen: opts.awayBullpen, players: {} },
          home: { bench: opts.homeBench, bullpen: opts.homeBullpen, players: {} },
        },
      },
    },
  } as unknown as LiveFeed;
}

beforeEach(() => {
  handCalls.length = 0;
  batCalls.length = 0;
  pitCalls.length = 0;
  throwOn = null;
});

describe("prewarmBenchAndBullpenStep", () => {
  it("loads hand for every bench + bullpen id and routes batter/pitcher loaders correctly", async () => {
    const feed = makeFeed({
      awayBench: [1, 2],
      homeBench: [3, 4],
      awayBullpen: [10, 11],
      homeBullpen: [12, 13],
    });

    await prewarmBenchAndBullpenStep({ gamePk: 999, feed });

    expect(handCalls.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 10, 11, 12, 13]);
    expect(batCalls.sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(pitCalls.sort((a, b) => a - b)).toEqual([10, 11, 12, 13]);
  });

  it("dedupes ids that appear on multiple lists", async () => {
    const feed = makeFeed({
      awayBench: [1, 1, 2],
      homeBench: [2, 3],
      awayBullpen: [10, 10],
      homeBullpen: [11],
    });

    await prewarmBenchAndBullpenStep({ gamePk: 1, feed });

    expect(handCalls.sort((a, b) => a - b)).toEqual([1, 2, 3, 10, 11]);
    expect(batCalls.sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(pitCalls.sort((a, b) => a - b)).toEqual([10, 11]);
  });

  it("no-ops when boxscore is missing", async () => {
    const feed = { liveData: {} } as unknown as LiveFeed;
    await prewarmBenchAndBullpenStep({ gamePk: 1, feed });
    expect(handCalls).toEqual([]);
    expect(batCalls).toEqual([]);
    expect(pitCalls).toEqual([]);
  });

  it("no-ops when bench and bullpen arrays are absent", async () => {
    const feed = makeFeed({});
    await prewarmBenchAndBullpenStep({ gamePk: 1, feed });
    expect(handCalls).toEqual([]);
    expect(batCalls).toEqual([]);
    expect(pitCalls).toEqual([]);
  });

  it("a single loader failure does not abort the others", async () => {
    throwOn = { kind: "bat", id: 2 };
    const feed = makeFeed({
      awayBench: [1, 2],
      homeBench: [3],
      awayBullpen: [10],
      homeBullpen: [11],
    });

    await expect(
      prewarmBenchAndBullpenStep({ gamePk: 1, feed }),
    ).resolves.toBeUndefined();

    expect(handCalls.sort((a, b) => a - b)).toEqual([1, 2, 3, 10, 11]);
    expect(batCalls.sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(pitCalls.sort((a, b) => a - b)).toEqual([10, 11]);
  });
});
