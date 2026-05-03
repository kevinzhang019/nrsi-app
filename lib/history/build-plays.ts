import type { LiveFeed, PlayDoc } from "@/lib/mlb/types";
import type { PlayRow } from "@/lib/types/history";

// Look a player's full name up from the boxscore players table. The watcher
// has the full feed in scope at Final; matchup.batter.fullName is sometimes
// present but not always, while the boxscore players map is the canonical
// source. Fall through to the matchup name, then to "Unknown" so we never
// emit a NULL on a NOT NULL column.
function resolveName(
  feed: LiveFeed,
  id: number | undefined,
  fallback: string | undefined,
): string {
  if (!id) return fallback || "Unknown";
  const teams = feed.liveData.boxscore?.teams;
  const key = `ID${id}`;
  const p = teams?.home.players?.[key] ?? teams?.away.players?.[key];
  return p?.person?.fullName || fallback || "Unknown";
}

function normalizeHalf(raw: string | undefined): "Top" | "Bottom" | null {
  const v = (raw || "").toLowerCase();
  if (v === "top") return "Top";
  if (v === "bottom") return "Bottom";
  return null;
}

function countRunsOnPlay(play: PlayDoc): number {
  const runners = play.runners ?? [];
  let n = 0;
  for (const r of runners) {
    if (r.movement?.end === "score") n++;
  }
  return n;
}

// Pure transform — no I/O. Iterates `feed.liveData.plays.allPlays`, keeps only
// completed plate appearances with valid identity (atBatIndex, inning, half,
// batter, pitcher), and produces one PlayRow per PA ready for upsert into the
// `plays` table.
export function buildPlayRows(feed: LiveFeed, gamePk: number): PlayRow[] {
  const all = feed.liveData.plays?.allPlays ?? [];
  const rows: PlayRow[] = [];
  for (const play of all) {
    const about = play.about ?? {};
    if (about.isComplete !== true) continue;
    const atBatIndex = about.atBatIndex;
    const inning = about.inning;
    const half = normalizeHalf(about.halfInning);
    const batterId = play.matchup?.batter?.id;
    const pitcherId = play.matchup?.pitcher?.id;
    if (
      typeof atBatIndex !== "number" ||
      typeof inning !== "number" ||
      half == null ||
      typeof batterId !== "number" ||
      typeof pitcherId !== "number"
    ) {
      continue;
    }

    rows.push({
      gamePk,
      atBatIndex,
      inning,
      half,
      batterId,
      batterName: resolveName(feed, batterId, play.matchup?.batter?.fullName),
      batterSide: play.matchup?.batSide?.code ?? null,
      pitcherId,
      pitcherName: resolveName(feed, pitcherId, play.matchup?.pitcher?.fullName),
      pitcherHand: play.matchup?.pitchHand?.code ?? null,
      event: play.result?.event ?? null,
      eventType: play.result?.eventType ?? null,
      rbi: typeof play.result?.rbi === "number" ? play.result.rbi : 0,
      runsOnPlay: countRunsOnPlay(play),
      endOuts: typeof play.count?.outs === "number" ? play.count.outs : null,
      awayScore: typeof play.result?.awayScore === "number" ? play.result.awayScore : null,
      homeScore: typeof play.result?.homeScore === "number" ? play.result.homeScore : null,
      raw: play as unknown as Record<string, unknown>,
    });
  }
  // Stable order — at_bat_index is monotonic across the whole game.
  rows.sort((a, b) => a.atBatIndex - b.atBatIndex);
  return rows;
}
