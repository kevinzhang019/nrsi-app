import { fetchSchedule } from "@/lib/mlb/client";
import { log } from "@/lib/log";

export type ScheduledGame = {
  gamePk: number;
  gameDate: string;
  // Venue-local game day (YYYY-MM-DD). Comes from the schedule's `dates[].date`
  // grouping, which is MLB's official date for the game in venue-local time.
  // Used to bucket history rows by the day the game actually started locally,
  // not by the UTC instant of first pitch.
  officialDate: string;
  abstractGameState: string;
  detailedState: string;
  awayTeam: { id: number; name: string };
  homeTeam: { id: number; name: string };
  awayProbablePitcher: number | null;
  homeProbablePitcher: number | null;
  venueId: number | null;
};

export async function fetchScheduleStep(date: string): Promise<ScheduledGame[]> {
  log.info("step", "fetchSchedule:start", { date });
  const r = await fetchSchedule(date);
  const games: ScheduledGame[] = [];
  for (const d of r.dates) {
    for (const g of d.games) {
      games.push({
        gamePk: g.gamePk,
        gameDate: g.gameDate,
        officialDate: d.date,
        abstractGameState: g.status.abstractGameState,
        detailedState: g.status.detailedState ?? "",
        awayTeam: { id: g.teams.away.team.id, name: g.teams.away.team.name },
        homeTeam: { id: g.teams.home.team.id, name: g.teams.home.team.name },
        awayProbablePitcher: g.teams.away.probablePitcher?.id ?? null,
        homeProbablePitcher: g.teams.home.probablePitcher?.id ?? null,
        venueId: g.venue?.id ?? null,
      });
    }
  }
  log.info("step", "fetchSchedule:ok", { date, count: games.length });
  return games;
}
