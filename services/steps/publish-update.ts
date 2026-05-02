import { publishGameState } from "@/lib/pubsub/publisher";
import { log } from "@/lib/log";
import type { GameState } from "@/lib/state/game-state";

export async function publishUpdateStep(state: GameState): Promise<void> {
  log.info("step", "publishUpdate:start", { gamePk: state.gamePk, status: state.status });
  await publishGameState(state);
  log.info("step", "publishUpdate:ok", { gamePk: state.gamePk });
}
