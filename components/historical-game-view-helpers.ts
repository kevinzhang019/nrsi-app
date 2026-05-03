import type { GameState, PitcherInfo } from "@/lib/state/game-state";
import type { Linescore } from "@/lib/mlb/extract";
import type { HistoricalGame, HistoricalInning } from "@/lib/types/history";
import { americanBreakEven, roundOdds } from "@/lib/prob/odds";

export type InningSelection =
  | { kind: "half"; inning: number; half: "Top" | "Bottom" }
  | { kind: "full"; inning: number };

// Compute (away, home) cumulative runs scored through the END of the given
// half-inning. e.g. end of inning 5 Top → sum innings 1..4 both teams + inning 5 away.
// End of inning 5 Bottom → sum innings 1..5 both teams.
export function runsThrough(
  linescore: Linescore | null,
  inning: number,
  half: "Top" | "Bottom",
): { away: number; home: number } {
  if (!linescore) return { away: 0, home: 0 };
  let away = 0;
  let home = 0;
  for (const i of linescore.innings) {
    if (i.num < inning) {
      away += i.away.runs ?? 0;
      home += i.home.runs ?? 0;
    } else if (i.num === inning) {
      away += i.away.runs ?? 0;
      if (half === "Bottom") home += i.home.runs ?? 0;
    }
  }
  return { away, home };
}

// Build a frozen GameState representing the selected half-inning. The score
// header reflects runs through the END of this half; the inning/half label
// marks the selection; outs/bases are cleared (no in-progress mid-PA state);
// the prediction fields come from the captured snapshot for that half.
export function buildFrozenState(
  game: HistoricalGame,
  inning: HistoricalInning,
): GameState {
  const base = game.finalSnapshot!;
  const score = runsThrough(game.linescore, inning.inning, inning.half);
  const activePitcher: PitcherInfo | null = inning.pitcher?.active ?? null;
  const awayPitcher: PitcherInfo | null = inning.pitcher?.away ?? base.awayPitcher ?? null;
  const homePitcher: PitcherInfo | null = inning.pitcher?.home ?? base.homePitcher ?? null;

  return {
    ...base,
    status: "Final",
    inning: inning.inning,
    half: inning.half,
    outs: 0,
    bases: null,
    isDecisionMoment: false,
    isDecisionMomentFullInning: false,
    away: { ...base.away, runs: score.away },
    home: { ...base.home, runs: score.home },
    pitcher: activePitcher,
    awayPitcher,
    homePitcher,
    upcomingBatters: inning.perBatter,
    pHitEvent: inning.pRun,
    pNoHitEvent: inning.pNoRun,
    breakEvenAmerican: inning.breakEvenAmerican,
    // History only stores per-half-inning predictions. Mirror them onto the
    // FullInning fields so the GameCard footer pill renders the captured
    // value regardless of the user's predictMode setting.
    pHitEventFullInning: inning.pRun,
    pNoHitEventFullInning: inning.pNoRun,
    breakEvenAmericanFullInning: inning.breakEvenAmerican,
    env: inning.env,
    lineupStats: inning.lineupStats,
    // battingTeam=null routes GameCard's split layout to the paired branch
    // (each pitcher above the lineup he faced) so half-inning and full-inning
    // history views render the pitcher/lineup section identically.
    battingTeam: null,
    currentBatterId: null,
    nextHalfLeadoffId: null,
  };
}

// Build a frozen GameState representing a full inning (Top through Bottom).
// Score reflects runs through the END of this inning. Probability fields
// compose the two captured halves: P(no run in inning) = P(no run in Top) *
// P(no run in Bottom). Both pitchers are surfaced (each pitched the half
// against the OTHER team's lineup); battingTeam=null marks "no single
// batting team" for GameCard's wide-mode lineup pairing.
export function buildFullInningFrozenState(
  game: HistoricalGame,
  top: HistoricalInning,
  bottom: HistoricalInning,
): GameState {
  const base = game.finalSnapshot!;
  const score = runsThrough(game.linescore, top.inning, "Bottom");
  const awayPitcher: PitcherInfo | null =
    top.pitcher?.away ?? bottom.pitcher?.away ?? base.awayPitcher ?? null;
  const homePitcher: PitcherInfo | null =
    top.pitcher?.home ?? bottom.pitcher?.home ?? base.homePitcher ?? null;

  const pNoRunFull = top.pNoRun * bottom.pNoRun;
  const pRunFull = 1 - pNoRunFull;
  const breakEvenFull = roundOdds(americanBreakEven(pNoRunFull));

  return {
    ...base,
    status: "Final",
    inning: top.inning,
    half: "Top",
    outs: 0,
    bases: null,
    isDecisionMoment: false,
    isDecisionMomentFullInning: false,
    away: { ...base.away, runs: score.away },
    home: { ...base.home, runs: score.home },
    pitcher: null,
    awayPitcher,
    homePitcher,
    // Combined batter sequence so statsById in GameCard covers both lineups.
    upcomingBatters: [...top.perBatter, ...bottom.perBatter],
    pHitEvent: pRunFull,
    pNoHitEvent: pNoRunFull,
    breakEvenAmerican: breakEvenFull,
    pHitEventFullInning: pRunFull,
    pNoHitEventFullInning: pNoRunFull,
    breakEvenAmericanFullInning: breakEvenFull,
    env: top.env ?? bottom.env,
    lineupStats: {
      away: top.lineupStats?.away ?? bottom.lineupStats?.away ?? {},
      home: bottom.lineupStats?.home ?? top.lineupStats?.home ?? {},
    },
    battingTeam: null,
    currentBatterId: null,
    nextHalfLeadoffId: null,
  };
}

export type InningAvailability = {
  topAvailable: (n: number) => boolean;
  bottomAvailable: (n: number) => boolean;
  fullAvailable: (n: number) => boolean;
};

export function buildAvailability(
  innByKey: Map<string, HistoricalInning>,
): InningAvailability {
  return {
    topAvailable: (n) => innByKey.has(`${n}-Top`),
    bottomAvailable: (n) => innByKey.has(`${n}-Bottom`),
    fullAvailable: (n) => innByKey.has(`${n}-Top`) && innByKey.has(`${n}-Bottom`),
  };
}

// Default selection: prefer the first inning where BOTH halves were captured
// (full-inning view), falling back to the first available half if nothing has
// both. Innings 1..maxInning. Defaults to half-Top of inning 1 if nothing.
export function defaultInningSelection(
  innByKey: Map<string, HistoricalInning>,
  maxInning: number,
): InningSelection {
  for (let n = 1; n <= maxInning; n++) {
    if (innByKey.has(`${n}-Top`) && innByKey.has(`${n}-Bottom`)) {
      return { kind: "full", inning: n };
    }
  }
  for (let n = 1; n <= maxInning; n++) {
    if (innByKey.has(`${n}-Top`)) return { kind: "half", inning: n, half: "Top" };
    if (innByKey.has(`${n}-Bottom`)) return { kind: "half", inning: n, half: "Bottom" };
  }
  return { kind: "half", inning: 1, half: "Top" };
}
