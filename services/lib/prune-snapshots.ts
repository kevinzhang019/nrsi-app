import { redis } from "../../lib/cache/redis";
import { k } from "../../lib/cache/keys";
import { todayInTz } from "../../lib/utils";
import { log } from "../../lib/log";

// Remove snapshot field-keys whose `officialDate` is older than today (ET).
//
// Why discriminate by date and not by today's schedule pk-list: the supervisor
// runs on a daily Railway cron, but a manual rerun can fetch a slightly
// different schedule (transient API hiccup, postponement, midnight ET
// rollover). Pruning by "not in today's pk list" then deletes still-scheduled
// games from the dashboard hash. The snapshot rows already carry an
// `officialDate` (set by `seedSnapshotStep` and preserved by every live
// publish) so we can identify yesterday's leftovers without consulting the
// schedule at all. See `docs/BUGS.md` bug #10.
//
// Why prune at all: `publishGameState` does HSET + `expire(24h)` on every
// tick, which means the hash's TTL never actually expires while any watcher
// is publishing today. Old games from prior days (especially ones the
// previous runtime was mid-watching when it crashed/was paused) can stay in
// the hash indefinitely, surfacing on the dashboard as zombie "Live" games.
//
// Conservative on parse failure: any field-value we can't parse, or that
// lacks an `officialDate` string, is left alone. A transient deserialization
// bug must never become a hash wipe.
//
// Safety: we only touch the snapshot hash. Watcher locks
// (`nrxi:lock:{gamePk}`) and watcher-state keys carry their own TTLs and
// expire on their own.
export async function pruneStaleSnapshots(opts?: { todayET?: string }): Promise<{
  total: number;
  kept: number;
  deleted: number;
}> {
  const r = redis();
  const todayET = opts?.todayET ?? todayInTz("America/New_York");

  const all = await r.hgetall<Record<string, unknown>>(k.snapshot());
  if (!all) {
    log.info("prune", "snapshots", { total: 0, kept: 0, deleted: 0, todayET });
    return { total: 0, kept: 0, deleted: 0 };
  }

  const stale: string[] = [];
  for (const [field, value] of Object.entries(all)) {
    const officialDate = readOfficialDate(value);
    if (officialDate !== null && officialDate < todayET) {
      stale.push(field);
    }
  }

  if (stale.length > 0) {
    await r.hdel(k.snapshot(), ...stale);
  }

  const total = Object.keys(all).length;
  log.info("prune", "snapshots", {
    total,
    kept: total - stale.length,
    deleted: stale.length,
    todayET,
  });

  return { total, kept: total - stale.length, deleted: stale.length };
}

// Upstash auto-parses JSON strings → objects on read; tolerate both shapes
// the same way `getSnapshot` does in `lib/pubsub/publisher.ts`.
function readOfficialDate(value: unknown): string | null {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (parsed && typeof parsed === "object" && "officialDate" in parsed) {
    const od = (parsed as { officialDate: unknown }).officialDate;
    if (typeof od === "string") return od;
  }
  return null;
}
