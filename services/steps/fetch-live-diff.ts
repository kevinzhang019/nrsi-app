import { fetchLiveDiff, fetchLiveFull } from "../../lib/mlb/client";
import { classifyStatus, type LiveFeed } from "../../lib/mlb/types";
import { log } from "../../lib/log";

export type WatcherTick = {
  feed: LiveFeed;
  newTimecode: string;
  recommendedWaitSeconds: number;
};

/**
 * Decide how long to sleep before the next poll.
 *
 * MLB's `metaData.wait` reflects when *they* expect the next state change —
 * during inning breaks, pitching changes, and replay reviews it inflates to
 * 30–120s. Capping it at 15s for those cases is fine; the half hasn't begun
 * yet, so polling faster wouldn't surface anything sooner.
 *
 * During active play (Live + at-bat in progress), MLB still tends to return
 * `wait ≈ 10s`, but real events (outs, walks, hits) can land at any moment.
 * We tighten the cap to 5s in that window so an out arriving just after a
 * poll waits at most ~5s for the next one. Trade-off is ~2× more diffPatch
 * calls during live PAs; MLB's Stats API tolerates this comfortably and the
 * Vercel Active CPU bump is small (Phase 2 Markov is ~50–200ms per tick).
 *
 * Floor stays at 5s — honor MLB's `wait` only when it's genuinely smaller,
 * which is rare.
 *
 * Exported for unit tests.
 */
export function chooseRecommendedWaitSeconds(feed: LiveFeed): number {
  const wait = feed.metaData?.wait ?? 10;
  const status = classifyStatus(
    feed.gameData.status.detailedState,
    feed.gameData.status.abstractGameState,
  );
  const ls = feed.liveData.linescore;
  const inningState = (ls.inningState || "").toLowerCase();
  const outs = ls.outs ?? 0;
  const isActivePa =
    status === "Live" &&
    inningState !== "middle" &&
    inningState !== "end" &&
    outs < 3;
  const cap = isActivePa ? 5 : 15;
  return Math.min(cap, Math.max(5, wait));
}

/**
 * Apply RFC 6902-ish JSON Patch ops to a doc. Tolerant — ignores unknown ops.
 */
function applyPatch(doc: unknown, patches: unknown[]): unknown {
  let cur: any = JSON.parse(JSON.stringify(doc));
  for (const p of patches as Array<{
    op: string;
    path: string;
    value?: unknown;
  }>) {
    if (!p || typeof p.path !== "string") continue;
    const segs = p.path.split("/").slice(1).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
    if (segs.length === 0) {
      if (p.op === "replace" || p.op === "add") cur = p.value;
      continue;
    }
    let parent = cur;
    for (let i = 0; i < segs.length - 1; i++) {
      const key = isFinite(Number(segs[i])) && Array.isArray(parent) ? Number(segs[i]) : segs[i];
      if (parent[key] === undefined) parent[key] = isFinite(Number(segs[i + 1])) ? [] : {};
      parent = parent[key];
    }
    const last = segs[segs.length - 1];
    const key = Array.isArray(parent) && isFinite(Number(last)) ? Number(last) : last;
    if (p.op === "remove") {
      if (Array.isArray(parent)) parent.splice(key as number, 1);
      else delete (parent as Record<string, unknown>)[key as string];
    } else {
      (parent as Record<string | number, unknown>)[key as string | number] = p.value;
    }
  }
  return cur;
}

export async function fetchLiveDiffStep(opts: {
  gamePk: number;
  startTimecode: string | null;
  prevDoc: LiveFeed | null;
}): Promise<WatcherTick> {
  const { gamePk, startTimecode, prevDoc } = opts;
  log.info("step", "fetchLiveDiff:start", { gamePk, startTimecode });

  let feed: LiveFeed;
  if (!startTimecode || !prevDoc) {
    feed = await fetchLiveFull(gamePk);
  } else {
    const r = await fetchLiveDiff(gamePk, startTimecode);
    if (r.full) {
      feed = r.full;
    } else if (r.patches.length > 0) {
      feed = applyPatch(prevDoc, r.patches) as LiveFeed;
    } else {
      feed = prevDoc;
    }
  }

  const newTimecode = feed.metaData?.timeStamp ?? startTimecode ?? "";
  const recommendedWaitSeconds = chooseRecommendedWaitSeconds(feed);
  log.info("step", "fetchLiveDiff:ok", { gamePk, newTimecode, recommendedWaitSeconds });
  return { feed, newTimecode, recommendedWaitSeconds };
}
