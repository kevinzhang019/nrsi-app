import { sleep } from "workflow";
import { start } from "workflow/api";
import { fetchScheduleStep } from "./steps/fetch-schedule";
import { seedSnapshotStep } from "./steps/seed-snapshot";
import { gameWatcherWorkflow } from "./game-watcher";
import { redis } from "@/lib/cache/redis";
import { k } from "@/lib/cache/keys";
import { todayInTz } from "@/lib/utils";

async function startWatcherStep(opts: {
  gamePk: number;
  awayTeamName: string;
  homeTeamName: string;
  date: string;
}): Promise<string> {
  "use step";
  console.log("[scheduler] starting watcher", opts.gamePk);
  const ownerId = `watcher-${opts.gamePk}-${Date.now()}`;
  const run = await start(gameWatcherWorkflow, [
    {
      gamePk: opts.gamePk,
      ownerId,
      awayTeamName: opts.awayTeamName,
      homeTeamName: opts.homeTeamName,
    },
  ]);
  await redis().hset(k.runsByDate(opts.date), { [String(opts.gamePk)]: run.runId });
  await redis().expire(k.runsByDate(opts.date), 60 * 60 * 36);
  return run.runId;
}

export async function schedulerWorkflow() {
  "use workflow";
  console.log("[scheduler] start");
  const date = todayInTz("America/New_York");
  const games = await fetchScheduleStep(date);
  console.log("[scheduler] games", games.length);

  await seedSnapshotStep(games);
  console.log("[scheduler] seeded snapshot");

  for (const g of games) {
    const t = new Date(g.gameDate).getTime();
    const fivePre = t - 5 * 60 * 1000;
    const now = Date.now();
    const waitMs = Math.max(0, fivePre - now);
    if (waitMs > 0) await sleep(`${Math.floor(waitMs / 1000)}s`);
    await startWatcherStep({
      gamePk: g.gamePk,
      awayTeamName: g.awayTeam.name,
      homeTeamName: g.homeTeam.name,
      date,
    });
  }

  console.log("[scheduler] all watchers spawned, sleeping until next day");
  await sleep("12h");
  return { spawned: games.length };
}
