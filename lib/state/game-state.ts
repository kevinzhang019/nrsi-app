import type { GameStatus } from "../mlb/types";
import type { TeamLineup, Linescore } from "../mlb/extract";

export type PerBatter = {
  id: number;
  name: string;
  bats: "L" | "R" | "S";
  pReach: number;
};

export type GameState = {
  gamePk: number;
  status: GameStatus;
  detailedState: string;
  inning: number | null;
  half: "Top" | "Bottom" | null;
  outs: number | null;
  isDecisionMoment: boolean;
  away: { id: number; name: string; runs: number };
  home: { id: number; name: string; runs: number };
  venue: { id: number; name: string } | null;
  pitcher: { id: number; name: string; throws: "L" | "R" } | null;
  upcomingBatters: PerBatter[];
  pHitEvent: number | null;
  pNoHitEvent: number | null;
  breakEvenAmerican: number | null;
  env: { parkRunFactor: number; weatherRunFactor: number; weather?: Record<string, unknown> } | null;
  lineups: { away: TeamLineup | null; home: TeamLineup | null } | null;
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
