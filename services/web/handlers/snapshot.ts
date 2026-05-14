import type { ServerResponse } from "node:http";
import { getSnapshot } from "@/lib/pubsub/publisher";

// Status sort order matches the dashboard sectioning: Live first, then any
// delayed/suspended games, then upcoming (Pre), then finished, then unknown.
const STATUS_ORDER: Record<string, number> = {
  Live: 0,
  Delayed: 1,
  Suspended: 2,
  Pre: 3,
  Final: 4,
  Other: 5,
};

type SortableGame = { status: string; inning: number | null };

function compareGames(a: SortableGame, b: SortableGame): number {
  const oa = STATUS_ORDER[a.status] ?? 5;
  const ob = STATUS_ORDER[b.status] ?? 5;
  if (oa !== ob) return oa - ob;
  if (a.inning !== null && b.inning !== null) return (b.inning ?? 0) - (a.inning ?? 0);
  return 0;
}

export async function handleSnapshot(res: ServerResponse): Promise<void> {
  try {
    const games = await getSnapshot();
    games.sort(compareGames);
    const body = JSON.stringify({ games, ts: new Date().toISOString() });
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(body);
  } catch (err) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: String(err) }));
  }
}
