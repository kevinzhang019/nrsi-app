import type { GameStatus } from "../mlb/types";
import type { TeamLineup, Linescore } from "../mlb/extract";

export type PerBatter = {
  id: number;
  name: string;
  bats: "L" | "R" | "S";
  pReach: number;
  xSlg: number;
};

export type LineupBatterStat = { pReach: number; xSlg: number };

export type PitcherInfo = {
  id: number;
  name: string;
  throws: "L" | "R";
  era: number | null;
  whip: number | null;
  pitchCount: number | null;
};

export type GameState = {
  gamePk: number;
  status: GameStatus;
  detailedState: string;
  inning: number | null;
  half: "Top" | "Bottom" | null;
  outs: number | null;
  // Live base occupancy as a 3-bit bitmask: bit0=1B, bit1=2B, bit2=3B.
  // Sourced from `liveData.linescore.offense` raw — NOT the half-over-zeroed
  // Markov startState, since the display shows the actual current bases even
  // mid-tick when outs flicker to 3 before the half flips. Null when status is
  // not Live (Pre / Final / Delayed) so the diamond doesn't render at all.
  bases: number | null;
  isDecisionMoment: boolean;
  // Full-inning variant: only true at full-inning boundaries (end of Bottom,
  // start of new inning, between innings). False at Top→Bottom mid-inning
  // transitions where the half-inning value `isDecisionMoment` does fire.
  // Both flags ship on every snapshot; client picks one based on predictMode.
  isDecisionMomentFullInning: boolean;
  away: { id: number; name: string; runs: number };
  home: { id: number; name: string; runs: number };
  venue: { id: number; name: string } | null;
  pitcher: PitcherInfo | null;
  // Both teams' most recent pitcher (last entry of boxscore.teams[side].pitchers[]).
  // While the team is fielding this equals the active mound pitcher; while sitting
  // it's whoever last pitched. NOT a bullpen projection. The "currently pitching"
  // one is whichever side opposes the current batting team — `pitcher` above
  // mirrors that for the probability pipeline.
  awayPitcher: PitcherInfo | null;
  homePitcher: PitcherInfo | null;
  upcomingBatters: PerBatter[];
  pHitEvent: number | null;
  pNoHitEvent: number | null;
  breakEvenAmerican: number | null;
  // Full-inning probability: P(at least one run scores in BOTH halves of the
  // current inning). When half==="Bottom", equals the half-inning value (top
  // is over). Null when the opposing pitcher / opposing lineup can't be
  // resolved yet — UI renders "—".
  pHitEventFullInning: number | null;
  pNoHitEventFullInning: number | null;
  breakEvenAmericanFullInning: number | null;
  env: { parkRunFactor: number; weatherRunFactor: number; weather?: Record<string, unknown> } | null;
  lineups: { away: TeamLineup | null; home: TeamLineup | null } | null;
  // Full-lineup display stats (xOBP/xSLG) for both teams' starters, keyed by
  // player id. Drives the "one team at a time" view that shows stats for all
  // 9 batters of either team, regardless of who's currently up.
  lineupStats: {
    away: Record<string, LineupBatterStat>;
    home: Record<string, LineupBatterStat>;
  } | null;
  linescore: Linescore | null;
  battingTeam: "home" | "away" | null;
  currentBatterId: number | null;
  nextHalfLeadoffId: number | null;
  updatedAt: string;
  startTime?: string;
};

export function isDecisionMoment(state: {
  status: GameStatus;
  inning: number | null;
  half: GameState["half"];
  outs: number | null;
  inningState?: string;
}): boolean {
  if (state.status !== "Live") return false;
  if (state.inning === null || state.outs === null) return false;
  const s = (state.inningState || "").toLowerCase();
  if (s === "middle" || s === "end") return true;
  if (state.outs >= 3) return true;
  if (state.half === "Top" && state.outs === 0) return true;
  return false;
}

// Full-inning variant. NOTE: depends on `state.half` being the RAW
// `ls.isTopInning`-derived value (NOT `upcoming.half`). The watcher publishes
// raw half (game-watcher.ts ~line 235), so during inningState === "middle"
// raw half is still "Top" — that's how we distinguish a Top→Bottom mid-inning
// flip (skip) from a Bottom→Top-of-next inter-inning flip (highlight).
export function isDecisionMomentFullInning(state: {
  status: GameStatus;
  inning: number | null;
  half: GameState["half"];
  outs: number | null;
  inningState?: string;
}): boolean {
  if (!isDecisionMoment(state)) return false;
  const s = (state.inningState || "").toLowerCase();
  if (s === "middle") return false;
  if (state.half === "Top" && state.outs !== null && state.outs >= 3) return false;
  return true;
}
