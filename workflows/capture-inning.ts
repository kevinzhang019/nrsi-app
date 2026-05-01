import type { InningCapture } from "@/lib/types/history";
import type { NrXiResult } from "./steps/compute-nrXi";
import type { GameState, PitcherInfo } from "@/lib/state/game-state";

export type CaptureArgs = {
  inning: number | null;
  half: "Top" | "Bottom" | null;
  nrXi: NrXiResult | null;
  pitcher: PitcherInfo | null;
  awayPitcher: PitcherInfo | null;
  homePitcher: PitcherInfo | null;
  env: GameState["env"];
  lineupStats: GameState["lineupStats"];
  defenseKey: string;
};

// Decide whether this tick should record a per-inning prediction snapshot,
// and produce one if so. Pure (no I/O) so it's unit-testable without
// instantiating the workflow runtime.
//
// Records only when:
//   - inning is in [1, 9]
//   - half is set
//   - nrXi was computed against a clean state (0 outs, 0 bases) — this is
//     true exactly at half-inning boundaries because readMarkovStartState in
//     the watcher zeroes outs/bases on inningState=middle/end / outs>=3.
//
// Caller is responsible for the once-per-(inning,half) guard against the
// `existing` map; this helper returns the would-be entry whether or not it's
// new, so the caller can decide.
export function buildInningCapture(args: CaptureArgs): { key: string; capture: InningCapture } | null {
  const { inning, half, nrXi } = args;
  if (inning == null || half == null) return null;
  if (inning < 1 || inning > 9) return null;
  if (!nrXi) return null;
  if (nrXi.startState.outs !== 0 || nrXi.startState.bases !== 0) return null;
  return {
    key: `${inning}-${half}`,
    capture: {
      inning,
      half,
      pNoRun: nrXi.pNoHitEvent,
      pRun: nrXi.pHitEvent,
      breakEvenAmerican: nrXi.breakEvenAmerican,
      perBatter: nrXi.perBatter,
      pitcher: {
        active: args.pitcher,
        away: args.awayPitcher,
        home: args.homePitcher,
      },
      env: args.env,
      lineupStats: args.lineupStats,
      defenseKey: args.defenseKey,
      capturedAt: new Date().toISOString(),
    },
  };
}
