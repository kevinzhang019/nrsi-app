import type { GameState } from "./game-state";
import type { PredictMode } from "@/lib/hooks/use-settings";

export function decisionMomentFor(
  game: GameState,
  mode: PredictMode,
): boolean {
  if (mode === "full") return game.isDecisionMomentFullInning ?? false;
  return game.isDecisionMoment ?? false;
}
