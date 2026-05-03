import { redis } from "../../lib/cache/redis";
import { k } from "../../lib/cache/keys";
import { publishGameState } from "../../lib/pubsub/publisher";
import { log } from "../../lib/log";
import { buildSyntheticFinalState } from "./finalize-game";
import type { GameState } from "../../lib/state/game-state";

// Default "fresh enough" threshold. A healthy watcher's lock TTL is 30s with
// a 10s refresh cadence, so any live publishing watcher always has a lock.
// updatedAt-staleness is just a safety margin against the brief window
// between publish and exit within a single tick. 60s comfortably covers
// active PAs (5s/loop) and inning breaks (15s/loop) without false-positiving
// during normal operation.
//
// We deliberately do NOT bump this higher to cover Delayed/Suspended games
// (which poll at 300s) — those games still have a live lock during the
// delay, so the lock check filters them out before the threshold matters.
export const DEFAULT_STALE_AFTER_MS = 60 * 1000;

export type StaleLiveCleanResult = {
  total: number;
  staleLive: number;
  cleaned: number;
};

export type StaleLiveCleanDeps = {
  // Reads the snapshot hash. Returns null when empty.
  hgetall: () => Promise<Record<string, unknown> | null>;
  // Returns the lock value if held, null otherwise.
  getLock: (gamePk: number) => Promise<string | null>;
  // Republishes a (synthetic Final) state.
  publishUpdate: (state: GameState) => Promise<void>;
};

// Same Upstash auto-parse tolerance as `pruneStaleSnapshots` and `getSnapshot`.
function tryParseState(raw: unknown): GameState | null {
  if (raw && typeof raw === "object") return raw as GameState;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as GameState;
    } catch {
      return null;
    }
  }
  return null;
}

// Scans the snapshot hash for entries that look like dead watchers — Live
// status, no lock held, and last publish older than the staleness threshold —
// and republishes a synthetic Final for each. This is the only defense
// against process-kill scenarios (SIGKILL, OOM, container eviction) where
// the in-process gracefulExit path can't run because the process is already
// dead.
//
// The supervisor calls this in its idle loop every 60s, so a freshly-killed
// watcher's snapshot is reclaimed within ~60s of the lock TTL expiring
// (~90s end-to-end). A `pruneStaleSnapshots` run the next morning still
// removes the row outright — this just unfreezes the dashboard sooner.
//
// Safe to run while watchers are active: the lock check ensures we only
// touch entries where no one is currently writing. Idempotent: rerunning
// against an already-cleaned snapshot is a no-op (status is now "Final").
//
// Errors per-entry are caught and logged so one malformed row can't poison
// the whole pass.
export async function detectAndCleanStaleLive(
  opts: { staleAfterMs?: number; nowMs?: number },
  deps: StaleLiveCleanDeps,
): Promise<StaleLiveCleanResult> {
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const nowMs = opts.nowMs ?? Date.now();

  let all: Record<string, unknown> | null = null;
  try {
    all = await deps.hgetall();
  } catch (err) {
    log.warn("stale-live-detector", "hgetall:fail", { err: String(err) });
    return { total: 0, staleLive: 0, cleaned: 0 };
  }
  if (!all) return { total: 0, staleLive: 0, cleaned: 0 };

  const total = Object.keys(all).length;
  let staleLive = 0;
  let cleaned = 0;

  for (const [field, value] of Object.entries(all)) {
    const state = tryParseState(value);
    if (!state) continue;
    if (state.status !== "Live") continue;

    const updatedAtMs = Date.parse(state.updatedAt);
    if (!Number.isFinite(updatedAtMs)) continue;
    if (nowMs - updatedAtMs < staleAfterMs) continue;

    staleLive += 1;

    let lock: string | null = null;
    try {
      lock = await deps.getLock(state.gamePk);
    } catch (err) {
      log.warn("stale-live-detector", "getLock:fail", {
        gamePk: state.gamePk,
        err: String(err),
      });
      continue;
    }
    if (lock !== null) continue; // active watcher; leave alone

    try {
      const synthetic = buildSyntheticFinalState(state, new Date(nowMs));
      log.warn("stale-live-detector", "cleaning", {
        gamePk: state.gamePk,
        field,
        lastInning: state.inning,
        lastHalf: state.half,
        ageMs: nowMs - updatedAtMs,
      });
      await deps.publishUpdate(synthetic);
      cleaned += 1;
    } catch (err) {
      log.warn("stale-live-detector", "publish:fail", {
        gamePk: state.gamePk,
        err: String(err),
      });
    }
  }

  if (staleLive > 0 || cleaned > 0) {
    log.info("stale-live-detector", "pass", { total, staleLive, cleaned });
  }
  return { total, staleLive, cleaned };
}

// Convenience wrapper that wires the real Redis client and publisher. The
// supervisor calls this; tests use `detectAndCleanStaleLive` directly with
// injected deps.
export function defaultStaleLiveCleanDeps(): StaleLiveCleanDeps {
  const r = redis();
  return {
    hgetall: () => r.hgetall<Record<string, unknown>>(k.snapshot()),
    getLock: (gamePk: number) => r.get<string>(k.watcherLock(gamePk)),
    publishUpdate: (state: GameState) => publishGameState(state),
  };
}
