import type { PlayRow } from "@/lib/types/history";
import { supabaseAdmin } from "./supabase";

function rowToPlay(row: Record<string, unknown>): PlayRow {
  return {
    gamePk: row.game_pk as number,
    atBatIndex: row.at_bat_index as number,
    inning: row.inning as number,
    half: row.half as "Top" | "Bottom",
    batterId: row.batter_id as number,
    batterName: row.batter_name as string,
    batterSide: (row.batter_side as string | null) ?? null,
    pitcherId: row.pitcher_id as number,
    pitcherName: row.pitcher_name as string,
    pitcherHand: (row.pitcher_hand as string | null) ?? null,
    event: (row.event as string | null) ?? null,
    eventType: (row.event_type as string | null) ?? null,
    rbi: (row.rbi as number) ?? 0,
    runsOnPlay: (row.runs_on_play as number) ?? 0,
    endOuts: (row.end_outs as number | null) ?? null,
    awayScore: (row.away_score as number | null) ?? null,
    homeScore: (row.home_score as number | null) ?? null,
    raw: (row.raw as Record<string, unknown>) ?? {},
  };
}

// Fetch every play for one game, ordered by at_bat_index. Used by the
// history detail page to render per-inning hitter/pitcher rollups.
export async function getGamePlays(gamePk: number): Promise<PlayRow[]> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("plays")
    .select("*")
    .eq("game_pk", gamePk)
    .order("at_bat_index", { ascending: true });
  if (error) throw new Error(`getGamePlays: ${error.message}`);
  return (data ?? []).map(rowToPlay);
}
