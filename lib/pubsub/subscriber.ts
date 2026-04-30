import { k } from "../cache/keys";
import type { GameState } from "../state/game-state";

/**
 * Long-poll Upstash for new updates. Upstash REST doesn't support raw pub/sub
 * subscribe, so we use a Redis stream-style fan-out:
 *   - publishGameState writes to the snapshot hash
 *   - this subscriber polls the snapshot hash and emits diffs
 *
 * For low-latency push we'd swap to Upstash WebSocket pub/sub or a TCP client.
 */
export async function* iterateSnapshotChanges(
  redisClient: import("@upstash/redis").Redis,
  intervalMs = 2000,
  abort: AbortSignal,
): AsyncIterable<GameState> {
  const lastSeen = new Map<number, string>();
  while (!abort.aborted) {
    const all = await redisClient.hgetall<Record<string, unknown>>(k.snapshot());
    if (all) {
      for (const [pk, raw] of Object.entries(all)) {
        let state: GameState | null = null;
        let signature = "";
        if (raw && typeof raw === "object") {
          state = raw as GameState;
          signature = JSON.stringify(raw);
        } else if (typeof raw === "string") {
          signature = raw;
          try {
            state = JSON.parse(raw) as GameState;
          } catch {
            state = null;
          }
        }
        if (!state) continue;
        if (lastSeen.get(Number(pk)) === signature) continue;
        lastSeen.set(Number(pk), signature);
        yield state;
      }
    }
    await sleep(intervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
