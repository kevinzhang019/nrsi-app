import type { GameState, LineupBatterStat, PitcherInfo } from "@/lib/state/game-state";
import type { Linescore, TeamLineup } from "@/lib/mlb/extract";
import type { NrXiPerBatter } from "@/services/steps/compute-nrXi";

// One inning's prediction snapshot, taken at the moment that half-inning
// began (clean state: 0 outs, 0 bases). Captured live by the watcher; later
// flushed to `inning_predictions` when the game finalizes.
export type InningCapture = {
  inning: number;
  half: "Top" | "Bottom";
  pNoRun: number;
  pRun: number;
  breakEvenAmerican: number;
  perBatter: NrXiPerBatter[];
  // active = the pitcher facing this half's batters; away/home are both teams'
  // last-known pitcher cores at the moment of capture so the detail UI can
  // render either side regardless of which half is selected.
  pitcher: {
    active: PitcherInfo | null;
    away: PitcherInfo | null;
    home: PitcherInfo | null;
  };
  env: {
    parkRunFactor: number;
    weatherRunFactor: number;
    weather?: Record<string, unknown>;
  } | null;
  lineupStats: { away: Record<string, LineupBatterStat>; home: Record<string, LineupBatterStat> } | null;
  defenseKey: string;
  capturedAt: string;
};

// One row in the `games` table. game_date is a YYYY-MM-DD string.
export type HistoricalGame = {
  gamePk: number;
  gameDate: string;
  startTime: string | null;
  status: string;
  detailedState: string | null;
  away: { id: number | null; name: string | null; runs: number | null };
  home: { id: number | null; name: string | null; runs: number | null };
  venue: { id: number | null; name: string | null };
  linescore: Linescore | null;
  weather: Record<string, unknown> | null;
  env: { parkRunFactor: number; weatherRunFactor: number } | null;
  lineups: { away: TeamLineup | null; home: TeamLineup | null } | null;
  pitchersUsed: { away: PitcherInfo[]; home: PitcherInfo[] } | null;
  finalSnapshot: GameState | null;
};

export type HistoricalInning = InningCapture & {
  actualRuns: number | null;
};

// One plate appearance, written once at the watcher's Final exit. Mirrors
// the columns of supabase migration 0003_plays.sql exactly.
export type PlayRow = {
  gamePk: number;
  atBatIndex: number;
  inning: number;
  half: "Top" | "Bottom";
  batterId: number;
  batterName: string;
  batterSide: string | null;
  pitcherId: number;
  pitcherName: string;
  pitcherHand: string | null;
  event: string | null;
  eventType: string | null;
  rbi: number;
  runsOnPlay: number;
  endOuts: number | null;
  awayScore: number | null;
  homeScore: number | null;
  raw: Record<string, unknown>;
};
