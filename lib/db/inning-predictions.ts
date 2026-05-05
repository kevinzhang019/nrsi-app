import type { LiveFeed } from "@/lib/mlb/types";
import type { GameState, PitcherInfo } from "@/lib/state/game-state";
import type { InningCapture } from "@/lib/types/history";
import { extractLineups, extractLinescore } from "@/lib/mlb/extract";
import { classifyStatus } from "@/lib/mlb/types";
import { buildPlayRows } from "@/lib/history/build-plays";
import { isSupabaseConfigured, supabaseAdmin } from "./supabase";
import { gameDateOf } from "./games";
import { log } from "@/lib/log";

// Identity fields needed to satisfy the games table's NOT NULL constraints
// (game_pk, game_date, status). Pulled from the watcher's GameState at the
// moment of the first per-boundary write. The supervisor sweep later
// overwrites everything except game_pk + game_date with feed-derived values
// at finalization.
export type GameStubContext = {
  gamePk: number;
  gameDate: string;
  startTime: string | null;
  status: string;
  detailedState: string | null;
  away: { id: number; name: string };
  home: { id: number; name: string };
  venue: { id: number; name: string } | null;
};

// Build the stub context from the watcher's live GameState.
export function gameStubContextFromState(state: GameState): GameStubContext {
  return {
    gamePk: state.gamePk,
    gameDate: gameDateOf(state.officialDate, state.startTime),
    startTime: state.startTime ?? null,
    status: state.status,
    detailedState: state.detailedState || null,
    away: { id: state.away.id, name: state.away.name },
    home: { id: state.home.id, name: state.home.name },
    venue: state.venue ? { id: state.venue.id, name: state.venue.name } : null,
  };
}

// Per-half-inning write. Fire-and-forget — caller should `.catch(log.warn)`.
// The supervisor sweep backstops any rows that don't make it.
//
// Two sequential upserts, both individually idempotent so a partial failure
// is safe. supabase-js doesn't expose multi-statement transactions, but the
// games stub uses ignoreDuplicates so the prediction insert is the only
// failure mode worth retrying — and the sweep handles that.
export async function upsertInningPrediction(args: {
  context: GameStubContext;
  capture: InningCapture;
}): Promise<void> {
  if (!isSupabaseConfigured()) return;
  const sb = supabaseAdmin();
  const { context, capture } = args;

  const stubGame = {
    game_pk: context.gamePk,
    game_date: context.gameDate,
    start_time: context.startTime,
    status: context.status,
    detailed_state: context.detailedState,
    away_team_id: context.away.id,
    away_team_name: context.away.name,
    home_team_id: context.home.id,
    home_team_name: context.home.name,
    venue_id: context.venue?.id ?? null,
    venue_name: context.venue?.name ?? null,
  };

  const { error: stubErr } = await sb
    .from("games")
    .upsert(stubGame, { onConflict: "game_pk", ignoreDuplicates: true });
  if (stubErr) {
    throw new Error(`upsertInningPrediction: stub games insert failed — ${stubErr.message}`);
  }

  const predictionRow = {
    game_pk: context.gamePk,
    inning: capture.inning,
    half: capture.half,
    p_no_run: capture.pNoRun,
    p_run: capture.pRun,
    break_even_american: capture.breakEvenAmerican,
    per_batter: capture.perBatter,
    pitcher: capture.pitcher,
    env: capture.env,
    lineup_stats: capture.lineupStats,
    defense_key: capture.defenseKey,
    captured_at: capture.capturedAt,
    // actual_runs intentionally left null — filled by `finalizeGame`.
  };

  const { error: predErr } = await sb
    .from("inning_predictions")
    .upsert(predictionRow, { onConflict: "game_pk,inning,half" });
  if (predErr) {
    throw new Error(`upsertInningPrediction: inning_predictions upsert failed — ${predErr.message}`);
  }
}

// Pull both teams' last-pitcher entries from the boxscore. Best-effort audit
// trail — denormalized for /history detail UI. Called by `finalizeGame`.
function pitchersFromFeed(feed: LiveFeed): { away: PitcherInfo[]; home: PitcherInfo[] } {
  const teams = feed.liveData.boxscore?.teams;
  const collect = (
    side: "away" | "home",
    list: number[] | undefined,
  ): PitcherInfo[] => {
    if (!teams || !list || list.length === 0) return [];
    const last = list[list.length - 1];
    const key = `ID${last}`;
    const p = teams[side].players?.[key];
    if (!p) return [];
    const era = parsePitcherStat(p.seasonStats?.pitching?.era);
    const whip = parsePitcherStat(p.seasonStats?.pitching?.whip);
    return [{
      id: p.person?.id ?? last,
      name: p.person?.fullName ?? `#${last}`,
      throws: "R",
      era,
      whip,
      pitchCount: null,
    }];
  };
  return {
    away: collect("away", teams?.away.pitchers),
    home: collect("home", teams?.home.pitchers),
  };
}

function parsePitcherStat(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Build a synthetic GameState from a fresh feed for the `final_snapshot`
// JSONB column. /history reads this for the historical detail card. Most
// prediction-specific fields are null/empty — they belong to inning_predictions
// rows now, not the snapshot.
function syntheticFinalStateFromFeed(feed: LiveFeed, gamePk: number): GameState {
  const status = classifyStatus(
    feed.gameData.status.detailedState,
    feed.gameData.status.abstractGameState,
  );
  const ls = feed.liveData.linescore;
  return {
    gamePk,
    status,
    detailedState: feed.gameData.status.detailedState ?? "",
    inning: ls.currentInning ?? null,
    half: ls.isTopInning === true ? "Top" : ls.isTopInning === false ? "Bottom" : null,
    outs: ls.outs ?? null,
    bases: 0,
    isDecisionMoment: false,
    isDecisionMomentFullInning: false,
    away: {
      id: feed.gameData.teams.away.id,
      name: feed.gameData.teams.away.name,
      runs: ls.teams?.away.runs ?? 0,
    },
    home: {
      id: feed.gameData.teams.home.id,
      name: feed.gameData.teams.home.name,
      runs: ls.teams?.home.runs ?? 0,
    },
    venue: feed.gameData.venue
      ? { id: feed.gameData.venue.id, name: feed.gameData.venue.name }
      : null,
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
    lineups: extractLineups(feed),
    lineupStats: null,
    linescore: extractLinescore(feed),
    battingTeam: null,
    currentBatterId: null,
    nextHalfLeadoffId: null,
    updatedAt: new Date().toISOString(),
    startTime: feed.gameData.datetime?.dateTime,
    officialDate: feed.gameData.datetime?.officialDate,
  };
}

// Single-source-of-truth finalization. Called by the supervisor sweep when a
// game's status flips to Final per a fresh `fetchLiveFull` call. Idempotent:
// re-running over an already-finalized game produces no diff.
//
// 1. UPSERT the games row with full final shape from the feed.
// 2. UPSERT plays from buildPlayRows(feed).
// 3. UPDATE inning_predictions.actual_runs from linescore.innings[]
//    (top half = away.runs, bottom half = home.runs).
//
// Any partial failure is safe to retry — every step is keyed by stable PKs.
export async function finalizeGame(args: {
  gamePk: number;
  freshFeed: LiveFeed;
}): Promise<void> {
  if (!isSupabaseConfigured()) return;
  const sb = supabaseAdmin();
  const { gamePk, freshFeed } = args;

  const synthetic = syntheticFinalStateFromFeed(freshFeed, gamePk);
  const linescore = synthetic.linescore;
  const gameDate = gameDateOf(synthetic.officialDate, synthetic.startTime);

  const gameRow = {
    game_pk: gamePk,
    game_date: gameDate,
    start_time: synthetic.startTime ?? null,
    status: synthetic.status,
    detailed_state: synthetic.detailedState || null,
    away_team_id: synthetic.away.id,
    away_team_name: synthetic.away.name,
    away_runs: synthetic.away.runs,
    home_team_id: synthetic.home.id,
    home_team_name: synthetic.home.name,
    home_runs: synthetic.home.runs,
    venue_id: synthetic.venue?.id ?? null,
    venue_name: synthetic.venue?.name ?? null,
    linescore,
    weather: null,
    env: null,
    lineups: synthetic.lineups,
    pitchers_used: pitchersFromFeed(freshFeed),
    final_snapshot: synthetic,
  };

  const { error: gameErr } = await sb
    .from("games")
    .upsert(gameRow, { onConflict: "game_pk" });
  if (gameErr) {
    throw new Error(`finalizeGame: games upsert failed — ${gameErr.message}`);
  }

  const playRows = buildPlayRows(freshFeed, gamePk);
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
    if (playsErr) {
      throw new Error(`finalizeGame: plays upsert failed — ${playsErr.message}`);
    }
  }

  if (linescore && linescore.innings.length > 0) {
    // Run all inning UPDATEs in parallel — 9 innings × 2 halves = 18 round
    // trips. Each is keyed on the (game_pk, inning, half) PK so they don't
    // contend, and a missing prediction row just no-ops the UPDATE (rather
    // than erroring) which is exactly what we want.
    const updates: Promise<void>[] = [];
    for (const row of linescore.innings) {
      const top = row.away.runs;
      const bot = row.home.runs;
      if (typeof top === "number") {
        updates.push(
          updateActualRunsForHalf(sb, gamePk, row.num, "Top", top),
        );
      }
      if (typeof bot === "number") {
        updates.push(
          updateActualRunsForHalf(sb, gamePk, row.num, "Bottom", bot),
        );
      }
    }
    await Promise.all(updates);
  }

  log.info("finalizeGame", "ok", {
    gamePk,
    plays: playRows.length,
    innings: linescore?.innings.length ?? 0,
  });
}

async function updateActualRunsForHalf(
  sb: ReturnType<typeof supabaseAdmin>,
  gamePk: number,
  inning: number,
  half: "Top" | "Bottom",
  runs: number,
): Promise<void> {
  const { error } = await sb
    .from("inning_predictions")
    .update({ actual_runs: runs })
    .eq("game_pk", gamePk)
    .eq("inning", inning)
    .eq("half", half);
  if (error) {
    log.warn("finalizeGame", "actual_runs:fail", {
      gamePk,
      inning,
      half,
      err: error.message,
    });
  }
}

// Pure predicate: whether the game is in a state where finalization is safe
// to run. Mirrors classifyStatus but exposed here so the sweep can short-
// circuit before fetching feeds it'll throw away.
export function isStatusFinal(status: string): boolean {
  return status === "Final";
}
