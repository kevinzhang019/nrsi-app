import { redis } from "@/lib/cache/redis";
import { k } from "@/lib/cache/keys";
import { log } from "@/lib/log";
import type { GameState } from "@/lib/state/game-state";
import type { ScheduledGame } from "./fetch-schedule";

export async function seedSnapshotStep(games: ScheduledGame[]): Promise<{ seeded: number }> {
  log.info("step", "seedSnapshot:start", { count: games.length });
  const r = redis();
  const now = new Date().toISOString();
  let seeded = 0;
  for (const g of games) {
    const stub: GameState = {
      gamePk: g.gamePk,
      status: "Pre",
      detailedState: g.detailedState || "Scheduled",
      inning: null,
      half: null,
      outs: null,
      bases: null,
      isDecisionMoment: false,
      isDecisionMomentFullInning: false,
      away: { id: g.awayTeam.id, name: g.awayTeam.name, runs: 0 },
      home: { id: g.homeTeam.id, name: g.homeTeam.name, runs: 0 },
      venue: g.venueId != null ? { id: g.venueId, name: "" } : null,
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
      lineups: null,
      lineupStats: null,
      linescore: null,
      battingTeam: null,
      currentBatterId: null,
      nextHalfLeadoffId: null,
      updatedAt: now,
      startTime: g.gameDate,
      officialDate: g.officialDate,
    };
    const wrote = await r.hsetnx(k.snapshot(), String(g.gamePk), JSON.stringify(stub));
    if (wrote === 1) seeded += 1;
  }
  await r.expire(k.snapshot(), 60 * 60 * 24);
  log.info("step", "seedSnapshot:ok", { count: games.length, seeded });
  return { seeded };
}
