import type { HistoricalGame, HistoricalInning, InningCapture } from "@/lib/types/history";
import { supabaseAdmin } from "./supabase";

// Bucket games by their venue-local game day (YYYY-MM-DD) so a 7pm PT start
// goes to its actual local day, not the next UTC day. MLB exposes this
// directly as `gameData.datetime.officialDate` in the live feed and as
// `dates[].date` in the schedule — both already in venue-local convention,
// no timezone math needed. The ET fallback exists only for legacy snapshots
// that pre-date the officialDate plumbing; new captures should always have it.
export function gameDateOf(officialDate: string | undefined, startTime: string | undefined): string {
  if (officialDate && /^\d{4}-\d{2}-\d{2}$/.test(officialDate)) return officialDate;
  const t = startTime ? new Date(startTime) : new Date();
  const ny = new Date(t.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const y = ny.getFullYear();
  const m = String(ny.getMonth() + 1).padStart(2, "0");
  const d = String(ny.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Distinct game dates we have data for, latest first. Drives the date strip
// + calendar-disabled-days UI on /history.
export async function listGameDates(): Promise<string[]> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("games")
    .select("game_date")
    .order("game_date", { ascending: false });
  if (error) throw new Error(`listGameDates: ${error.message}`);
  const seen = new Set<string>();
  for (const row of data ?? []) {
    if (typeof row.game_date === "string") seen.add(row.game_date);
  }
  return Array.from(seen);
}

function rowToGame(row: Record<string, unknown>): HistoricalGame {
  return {
    gamePk: row.game_pk as number,
    gameDate: row.game_date as string,
    startTime: (row.start_time as string | null) ?? null,
    status: row.status as string,
    detailedState: (row.detailed_state as string | null) ?? null,
    away: {
      id: (row.away_team_id as number | null) ?? null,
      name: (row.away_team_name as string | null) ?? null,
      runs: (row.away_runs as number | null) ?? null,
    },
    home: {
      id: (row.home_team_id as number | null) ?? null,
      name: (row.home_team_name as string | null) ?? null,
      runs: (row.home_runs as number | null) ?? null,
    },
    venue: {
      id: (row.venue_id as number | null) ?? null,
      name: (row.venue_name as string | null) ?? null,
    },
    linescore: (row.linescore as HistoricalGame["linescore"]) ?? null,
    weather: (row.weather as Record<string, unknown> | null) ?? null,
    env: (row.env as HistoricalGame["env"]) ?? null,
    lineups: (row.lineups as HistoricalGame["lineups"]) ?? null,
    pitchersUsed: (row.pitchers_used as HistoricalGame["pitchersUsed"]) ?? null,
    finalSnapshot: (row.final_snapshot as HistoricalGame["finalSnapshot"]) ?? null,
  };
}

export async function listGamesByDate(gameDate: string): Promise<HistoricalGame[]> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("games")
    .select("*")
    .eq("game_date", gameDate)
    .order("start_time", { ascending: true });
  if (error) throw new Error(`listGamesByDate: ${error.message}`);
  return (data ?? []).map(rowToGame);
}

export async function getGame(gamePk: number): Promise<HistoricalGame | null> {
  const sb = supabaseAdmin();
  const { data, error } = await sb.from("games").select("*").eq("game_pk", gamePk).maybeSingle();
  if (error) throw new Error(`getGame: ${error.message}`);
  return data ? rowToGame(data) : null;
}

export async function getInningPredictions(gamePk: number): Promise<HistoricalInning[]> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("inning_predictions")
    .select("*")
    .eq("game_pk", gamePk)
    .order("inning", { ascending: true })
    .order("half", { ascending: true });
  if (error) throw new Error(`getInningPredictions: ${error.message}`);
  return (data ?? []).map((row) => ({
    inning: row.inning as number,
    half: row.half as "Top" | "Bottom",
    pNoRun: row.p_no_run as number,
    pRun: row.p_run as number,
    breakEvenAmerican: (row.break_even_american as number) ?? 0,
    perBatter: row.per_batter as InningCapture["perBatter"],
    pitcher: row.pitcher as InningCapture["pitcher"],
    env: row.env as InningCapture["env"],
    lineupStats: row.lineup_stats as InningCapture["lineupStats"],
    defenseKey: (row.defense_key as string | null) ?? "",
    capturedAt: row.captured_at as string,
    actualRuns: (row.actual_runs as number | null) ?? null,
  }));
}
