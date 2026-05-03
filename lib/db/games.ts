import type { GameState, PitcherInfo } from "@/lib/state/game-state";
import type { Linescore } from "@/lib/mlb/extract";
import type { HistoricalGame, HistoricalInning, InningCapture, PlayRow } from "@/lib/types/history";
import { supabaseAdmin } from "./supabase";

// Bucket games by their venue-local game day (YYYY-MM-DD) so a 7pm PT start
// goes to its actual local day, not the next UTC day. MLB exposes this
// directly as `gameData.datetime.officialDate` in the live feed and as
// `dates[].date` in the schedule — both already in venue-local convention,
// no timezone math needed. The ET fallback exists only for legacy snapshots
// that pre-date the officialDate plumbing; new captures should always have it.
function gameDateOf(officialDate: string | undefined, startTime: string | undefined): string {
  if (officialDate && /^\d{4}-\d{2}-\d{2}$/.test(officialDate)) return officialDate;
  const t = startTime ? new Date(startTime) : new Date();
  const ny = new Date(t.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const y = ny.getFullYear();
  const m = String(ny.getMonth() + 1).padStart(2, "0");
  const d = String(ny.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Pull all distinct pitchers seen in the live snapshots — used as a compact
// audit trail. We just store both teams' last-known pitcher cores; the full
// boxscore pitchers list isn't carried on GameState.
function pitchersFromState(state: GameState): { away: PitcherInfo[]; home: PitcherInfo[] } {
  return {
    away: state.awayPitcher ? [state.awayPitcher] : [],
    home: state.homePitcher ? [state.homePitcher] : [],
  };
}

function actualRunsFor(linescore: Linescore | null, inning: number, half: "Top" | "Bottom"): number | null {
  if (!linescore) return null;
  const row = linescore.innings.find((i) => i.num === inning);
  if (!row) return null;
  return half === "Top" ? row.away.runs : row.home.runs;
}

export type SaveFinishedGameArgs = {
  finalState: GameState;
  capturedInnings: Record<string, InningCapture>;
  // Built once at the watcher's Final exit by lib/history/build-plays.ts. May
  // be empty on dev fixtures that don't carry liveData.plays.allPlays.
  playRows: PlayRow[];
};

// Persist a finished game + its captured per-inning predictions. Idempotent:
// the watcher's Final exit branch could fire twice if the workflow retries the
// step, so we upsert on (game_pk) and (game_pk, inning, half).
export async function saveFinishedGame(args: SaveFinishedGameArgs): Promise<void> {
  const { finalState, capturedInnings, playRows } = args;
  const sb = supabaseAdmin();

  const gameDate = gameDateOf(finalState.officialDate, finalState.startTime);

  const gameRow = {
    game_pk: finalState.gamePk,
    game_date: gameDate,
    start_time: finalState.startTime ?? null,
    status: finalState.status,
    detailed_state: finalState.detailedState || null,
    away_team_id: finalState.away.id,
    away_team_name: finalState.away.name,
    away_runs: finalState.away.runs,
    home_team_id: finalState.home.id,
    home_team_name: finalState.home.name,
    home_runs: finalState.home.runs,
    venue_id: finalState.venue?.id ?? null,
    venue_name: finalState.venue?.name ?? null,
    linescore: finalState.linescore,
    weather: (finalState.env?.weather as Record<string, unknown> | undefined) ?? null,
    env: finalState.env
      ? { parkRunFactor: finalState.env.parkRunFactor, weatherRunFactor: finalState.env.weatherRunFactor }
      : null,
    lineups: finalState.lineups,
    pitchers_used: pitchersFromState(finalState),
    final_snapshot: finalState,
  };

  const { error: gameErr } = await sb.from("games").upsert(gameRow, { onConflict: "game_pk" });
  if (gameErr) throw new Error(`saveFinishedGame: games upsert failed — ${gameErr.message}`);

  const inningRows = Object.values(capturedInnings).map((cap) => ({
    game_pk: finalState.gamePk,
    inning: cap.inning,
    half: cap.half,
    p_no_run: cap.pNoRun,
    p_run: cap.pRun,
    break_even_american: cap.breakEvenAmerican,
    per_batter: cap.perBatter,
    pitcher: cap.pitcher,
    env: cap.env,
    lineup_stats: cap.lineupStats,
    defense_key: cap.defenseKey,
    actual_runs: actualRunsFor(finalState.linescore, cap.inning, cap.half),
    captured_at: cap.capturedAt,
  }));

  if (inningRows.length > 0) {
    const { error: innErr } = await sb
      .from("inning_predictions")
      .upsert(inningRows, { onConflict: "game_pk,inning,half" });
    if (innErr) throw new Error(`saveFinishedGame: inning_predictions upsert failed — ${innErr.message}`);
  }

  if (playRows.length > 0) {
    const dbRows = playRows.map((p) => ({
      game_pk: p.gamePk,
      at_bat_index: p.atBatIndex,
      inning: p.inning,
      half: p.half,
      batter_id: p.batterId,
      batter_name: p.batterName,
      batter_side: p.batterSide,
      pitcher_id: p.pitcherId,
      pitcher_name: p.pitcherName,
      pitcher_hand: p.pitcherHand,
      event: p.event,
      event_type: p.eventType,
      rbi: p.rbi,
      runs_on_play: p.runsOnPlay,
      end_outs: p.endOuts,
      away_score: p.awayScore,
      home_score: p.homeScore,
      raw: p.raw,
    }));
    const { error: playsErr } = await sb
      .from("plays")
      .upsert(dbRows, { onConflict: "game_pk,at_bat_index" });
    if (playsErr) throw new Error(`saveFinishedGame: plays upsert failed — ${playsErr.message}`);
  }
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
