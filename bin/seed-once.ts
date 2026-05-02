#!/usr/bin/env node
// One-shot snapshot seeder. Wraps fetchScheduleStep + seedSnapshotStep so we
// can populate today's "Pre" stubs into Redis without booting the full
// supervisor (which then sits idle for hours waiting for game starts).
//
// Useful after a snapshot wipe (`bin/prune-snapshots.ts --all`) or for
// recovering after the runtime missed its scheduled cron.
//
// Usage: npx tsx bin/seed-once.ts [--date 2026-05-02]

import "../services/lib/load-env";
import { fetchScheduleStep } from "../services/steps/fetch-schedule";
import { seedSnapshotStep } from "../services/steps/seed-snapshot";
import { todayInTz } from "../lib/utils";
import { log } from "../lib/log";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const date = arg("--date") ?? todayInTz("America/New_York");
  const games = await fetchScheduleStep(date);
  log.info("bin/seed-once", "schedule", { date, count: games.length });
  const result = await seedSnapshotStep(games);
  log.info("bin/seed-once", "done", { date, ...result });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
