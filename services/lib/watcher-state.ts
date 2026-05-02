import { redis } from "../../lib/cache/redis";
import type { NrXiResult } from "../steps/compute-nrXi";
import type { LineupBatterStat } from "../../lib/state/game-state";
import type { TeamLineup } from "../../lib/mlb/extract";
import type { InningCapture } from "../../lib/types/history";

// What we persist across watcher restarts. Replaces WDK's "vars survive
// sleep()" durability. Trade-offs: skip large/cheap-to-rebuild things
// (LiveFeed, splitsCache, parkCache, weatherCache, defenseCache) and drop the
// trigger keys (lastStructuralKey/lastPlayStateKey) so the first tick after a
// restart unconditionally fires a Phase 1 reload — that rebuilds the caches
// and overwrites the published view with one fresh recompute. Cheap.
//
// What we keep:
// - capturedInnings: critical — the per-inning prediction snapshots that
//   land in Supabase at game end. Losing this means losing history.
// - lastNrXi / lastEnv / lastFullInning / lastLineupStats / lastPitcher* /
//   lastAwayPitcher / lastHomePitcher: preserves the published snapshot's
//   richer fields for the very first tick after restart, before Phase 1
//   reload completes.
// - lastEnrichedHash / lastLineups: saves an enrichLineupHands network call.
type PitcherCore = {
  id: number;
  name: string;
  throws: "L" | "R";
  era: number | null;
  whip: number | null;
};

export type WatcherState = {
  capturedInnings: Record<string, InningCapture>;
  lastEnrichedHash: string;
  lastLineups: { away: TeamLineup | null; home: TeamLineup | null } | null;
  lastNrXi: NrXiResult | null;
  lastEnv: {
    parkRunFactor: number;
    weatherRunFactor: number;
    weather?: Record<string, unknown>;
  } | null;
  lastFullInning: { pHit: number; pNo: number; breakEven: number } | null;
  lastLineupStats: {
    away: Record<string, LineupBatterStat>;
    home: Record<string, LineupBatterStat>;
  } | null;
  lastPitcherId: number | null;
  lastPitcherName: string;
  lastPitcherThrows: "L" | "R";
  lastPitcherEra: number | null;
  lastPitcherWhip: number | null;
  lastAwayPitcher: PitcherCore | null;
  lastHomePitcher: PitcherCore | null;
};

export function emptyWatcherState(): WatcherState {
  return {
    capturedInnings: {},
    lastEnrichedHash: "",
    lastLineups: null,
    lastNrXi: null,
    lastEnv: null,
    lastFullInning: null,
    lastLineupStats: null,
    lastPitcherId: null,
    lastPitcherName: "",
    lastPitcherThrows: "R",
    lastPitcherEra: null,
    lastPitcherWhip: null,
    lastAwayPitcher: null,
    lastHomePitcher: null,
  };
}

const TTL_SECONDS = 24 * 60 * 60;

function key(gamePk: number): string {
  return `nrxi:watcher-state:${gamePk}`;
}

export async function loadWatcherState(gamePk: number): Promise<WatcherState> {
  const r = redis();
  // @upstash/redis auto-parses JSON on read — guard against shape drift by
  // catching malformed payloads and starting fresh. See CLAUDE.md bug #4.
  try {
    const raw = await r.get<WatcherState>(key(gamePk));
    if (!raw) return emptyWatcherState();
    return { ...emptyWatcherState(), ...raw };
  } catch {
    return emptyWatcherState();
  }
}

export async function saveWatcherState(gamePk: number, state: WatcherState): Promise<void> {
  const r = redis();
  await r.set(key(gamePk), JSON.stringify(state), { ex: TTL_SECONDS });
}

export async function clearWatcherState(gamePk: number): Promise<void> {
  const r = redis();
  await r.del(key(gamePk));
}
