import { describe, expect, it } from "vitest";
import type { GameState } from "@/lib/state/game-state";
import type { HistoricalGame, HistoricalInning } from "@/lib/types/history";
import { LEAGUE_PA } from "@/lib/mlb/splits";
import {
  buildAvailability,
  buildFullInningFrozenState,
  defaultInningSelection,
  runsBefore,
} from "./historical-game-view-helpers";

const baseSnapshot: GameState = {
  gamePk: 1,
  status: "Final",
  detailedState: "Final",
  inning: 9,
  half: "Bottom",
  outs: 3,
  bases: null,
  isDecisionMoment: false,
  isDecisionMomentFullInning: false,
  away: { id: 1, name: "Aways", runs: 5 },
  home: { id: 2, name: "Homes", runs: 3 },
  venue: { id: 100, name: "Park" },
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
  lineups: { away: null, home: null },
  lineupStats: null,
  linescore: null,
  battingTeam: null,
  currentBatterId: null,
  nextHalfLeadoffId: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function makeGame(): HistoricalGame {
  return {
    gamePk: 1,
    gameDate: "2026-05-01",
    startTime: null,
    status: "Final",
    detailedState: "Final",
    away: { id: 1, name: "Aways", runs: 5 },
    home: { id: 2, name: "Homes", runs: 3 },
    venue: { id: 100, name: "Park" },
    linescore: {
      innings: [
        { num: 1, away: { runs: 1, hits: null, errors: null }, home: { runs: 0, hits: null, errors: null } },
        { num: 2, away: { runs: 0, hits: null, errors: null }, home: { runs: 2, hits: null, errors: null } },
        { num: 3, away: { runs: 4, hits: null, errors: null }, home: { runs: 1, hits: null, errors: null } },
      ],
      totals: { away: { R: 5, H: 8, E: 0 }, home: { R: 3, H: 6, E: 1 } },
    },
    weather: null,
    env: null,
    lineups: null,
    pitchersUsed: null,
    finalSnapshot: baseSnapshot,
  };
}

function makeInning(
  inning: number,
  half: "Top" | "Bottom",
  pNoRun: number,
  pRun: number,
): HistoricalInning {
  return {
    inning,
    half,
    pNoRun,
    pRun,
    breakEvenAmerican: -150,
    perBatter: [
      { id: 100 + inning, name: `B${inning}-${half}`, bats: "R", pReach: 0.3, xSlg: 0.4, pa: { ...LEAGUE_PA.R } },
    ],
    pitcher: {
      active: { id: half === "Top" ? 200 : 201, name: half === "Top" ? "HomeP" : "AwayP", throws: "R", era: 3, whip: 1.1, pitchCount: 50 },
      away: { id: 201, name: "AwayP", throws: "L", era: 3.2, whip: 1.2, pitchCount: 70 },
      home: { id: 200, name: "HomeP", throws: "R", era: 3, whip: 1.1, pitchCount: 50 },
    },
    env: { parkRunFactor: 1.02, weatherRunFactor: 0.98 },
    lineupStats: { away: { "1": { pReach: 0.3, xSlg: 0.4 } }, home: { "2": { pReach: 0.32, xSlg: 0.42 } } },
    defenseKey: "k",
    capturedAt: "2026-05-01T18:00:00.000Z",
    actualRuns: 0,
  };
}

describe("runsBefore", () => {
  it("sums all prior innings + away half when half=Bottom", () => {
    const g = makeGame();
    const before = runsBefore(g.linescore, 3, "Bottom");
    expect(before.away).toBe(1 + 0 + 4); // innings 1,2 + away of 3
    expect(before.home).toBe(0 + 2);
  });

  it("excludes the same-inning away when half=Top", () => {
    const g = makeGame();
    const before = runsBefore(g.linescore, 3, "Top");
    expect(before.away).toBe(1);
    expect(before.home).toBe(2);
  });
});

describe("buildAvailability", () => {
  it("flags fullAvailable only when both halves are present", () => {
    const innings = [makeInning(1, "Top", 0.7, 0.3), makeInning(1, "Bottom", 0.65, 0.35), makeInning(2, "Top", 0.7, 0.3)];
    const map = new Map(innings.map((i) => [`${i.inning}-${i.half}`, i] as const));
    const a = buildAvailability(map);
    expect(a.fullAvailable(1)).toBe(true);
    expect(a.fullAvailable(2)).toBe(false);
    expect(a.topAvailable(2)).toBe(true);
    expect(a.bottomAvailable(2)).toBe(false);
    expect(a.fullAvailable(3)).toBe(false);
  });
});

describe("defaultInningSelection", () => {
  it("prefers the first full inning", () => {
    const innings = [makeInning(1, "Top", 0.7, 0.3), makeInning(2, "Top", 0.7, 0.3), makeInning(2, "Bottom", 0.6, 0.4)];
    const map = new Map(innings.map((i) => [`${i.inning}-${i.half}`, i] as const));
    expect(defaultInningSelection(map, 9)).toEqual({ kind: "full", inning: 2 });
  });

  it("falls back to the first available half when no full inning exists", () => {
    const innings = [makeInning(1, "Top", 0.7, 0.3)];
    const map = new Map(innings.map((i) => [`${i.inning}-${i.half}`, i] as const));
    expect(defaultInningSelection(map, 9)).toEqual({ kind: "half", inning: 1, half: "Top" });
  });

  it("defaults to inning-1 Top when nothing is captured", () => {
    expect(defaultInningSelection(new Map(), 9)).toEqual({ kind: "half", inning: 1, half: "Top" });
  });
});

describe("buildFullInningFrozenState", () => {
  it("composes pNoRun multiplicatively across both halves", () => {
    const game = makeGame();
    const top = makeInning(2, "Top", 0.8, 0.2);
    const bottom = makeInning(2, "Bottom", 0.75, 0.25);
    const frozen = buildFullInningFrozenState(game, top, bottom);
    expect(frozen.pNoHitEvent).toBeCloseTo(0.6, 6);
    expect(frozen.pHitEvent).toBeCloseTo(0.4, 6);
    expect(frozen.pNoHitEventFullInning).toBeCloseTo(0.6, 6);
    expect(frozen.pHitEventFullInning).toBeCloseTo(0.4, 6);
    // breakEven of pNoRun=0.6 → favorite, negative odds, rounded to nearest 5.
    expect(frozen.breakEvenAmerican).toBeLessThan(0);
    expect(Math.abs(frozen.breakEvenAmerican! % 5)).toBe(0);
  });

  it("scores the header at runs-before-Top of the inning", () => {
    const game = makeGame();
    const top = makeInning(3, "Top", 0.7, 0.3);
    const bottom = makeInning(3, "Bottom", 0.7, 0.3);
    const frozen = buildFullInningFrozenState(game, top, bottom);
    // Innings 1,2 only — inning-3 runs not yet "in" for full-inning view.
    expect(frozen.away.runs).toBe(1);
    expect(frozen.home.runs).toBe(2);
  });

  it("sets battingTeam=null and inning/half=Top/0", () => {
    const game = makeGame();
    const top = makeInning(2, "Top", 0.7, 0.3);
    const bottom = makeInning(2, "Bottom", 0.7, 0.3);
    const frozen = buildFullInningFrozenState(game, top, bottom);
    expect(frozen.battingTeam).toBeNull();
    expect(frozen.inning).toBe(2);
    expect(frozen.half).toBe("Top");
    expect(frozen.outs).toBe(0);
    expect(frozen.bases).toBeNull();
  });

  it("merges both halves' upcoming batters", () => {
    const game = makeGame();
    const top = makeInning(2, "Top", 0.7, 0.3);
    const bottom = makeInning(2, "Bottom", 0.7, 0.3);
    const frozen = buildFullInningFrozenState(game, top, bottom);
    expect(frozen.upcomingBatters).toHaveLength(2);
  });

  it("works for extras (Manfred runner) — composes the same way", () => {
    const game = makeGame();
    const top = makeInning(10, "Top", 0.6, 0.4);
    const bottom = makeInning(10, "Bottom", 0.55, 0.45);
    const frozen = buildFullInningFrozenState(game, top, bottom);
    expect(frozen.inning).toBe(10);
    expect(frozen.pNoHitEvent).toBeCloseTo(0.6 * 0.55, 6);
  });

  it("preserves both pitcher cores for the wide-mode pairing", () => {
    const game = makeGame();
    const top = makeInning(2, "Top", 0.7, 0.3);
    const bottom = makeInning(2, "Bottom", 0.7, 0.3);
    const frozen = buildFullInningFrozenState(game, top, bottom);
    expect(frozen.awayPitcher?.id).toBe(201);
    expect(frozen.homePitcher?.id).toBe(200);
    expect(frozen.pitcher).toBeNull();
  });
});
