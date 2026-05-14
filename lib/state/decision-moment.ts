import type { GameState } from "./game-state";
import type { PredictMode } from "@/lib/hooks/use-settings";

// Returns true when a Live game's card should sit in the dashboard's
// "highlighted" section under the chosen predict mode.
//
// Spec (user-facing): the bases are still clean and no out has been recorded
// in the current half yet — i.e. either:
//   - 3 outs (the half just ended), OR
//   - 0 outs AND no runners on (regulation), OR
//   - 0 outs AND only the Manfred runner on 2B (innings 10+).
// Runs scored on the leadoff PA (e.g. a leadoff HR) do not disqualify.
//
// In full mode the inning-boundary qualifiers tighten: only the bottom-half
// just ending (= the *full* inning is over) and only fresh top halves (= a new
// inning is starting) qualify. Fresh bottom halves are mid-inning under full
// mode and do not highlight.
//
// Reads only fields already on GameState (status / inning / half / outs /
// bases) — no dependency on the server-side
// isDecisionMoment / isDecisionMomentFullInning flags, which fire on a looser
// "is this a recompute point" predicate that the dashboard sectioning policy
// no longer wants to inherit.
export function decisionMomentFor(
  game: GameState,
  mode: PredictMode,
): boolean {
  if (game.status !== "Live") return false;
  if (game.inning === null || game.outs === null || game.half === null) return false;

  const { outs, half, inning } = game;
  const bases = game.bases ?? 0;

  // Half just ended.
  if (outs >= 3) {
    return mode === "full" ? half === "Bottom" : true;
  }

  // Fresh half / inning: no PA has produced an out yet. In extras (10+) the
  // Manfred runner sits on 2B at every half's first pitch, so the "clean"
  // bases bitmask is 0b010 = 2 there (bit0=1B, bit1=2B, bit2=3B); regulation
  // halves start with bases empty.
  const expectedBases = inning >= 10 ? 2 : 0;
  if (outs === 0 && bases === expectedBases) {
    return mode === "full" ? half === "Top" : true;
  }

  return false;
}
