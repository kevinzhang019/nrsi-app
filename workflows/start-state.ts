import type { LiveFeed } from "@/lib/mlb/types";
import type { Bases, GameState as MarkovState } from "@/lib/prob/markov";

// Read live (outs, bases) from the MLB feed. Bases use the canonical 3-bit
// encoding shared with the Markov chain (bit0=1st, bit1=2nd, bit2=3rd).
//
// Half-boundary short-circuit: when the feed indicates the half-inning is
// over (inningState is "middle"/"end" OR outs >= 3), force {0, 0} — or
// {0, 2} (Manfred runner on 2B) when the upcoming half is in extras (inning
// >= 10). This mirrors the isMiddleOrEnd predicate in lib/mlb/lineup.ts:26 —
// that predicate already flips `upcoming` to the next half-inning, so the
// Markov startState must agree (no phantom stranded runners from `ls.offense`
// polluting the next-half compute).
//
// `upcomingInning` is the inning of the half we'll Markov from when the half
// is over (= getUpcomingForCurrentInning(feed).inning). Mid-PA we trust the
// live feed's offense state — MLB Stats API populates the Manfred runner
// there at extra-half leadoff.
export function readMarkovStartState(feed: LiveFeed, upcomingInning: number | null): MarkovState {
  const ls = feed.liveData.linescore;
  const o = ls.outs ?? 0;
  const inningState = (ls.inningState || "").toLowerCase();
  const isHalfOver = inningState === "middle" || inningState === "end" || o >= 3;
  if (isHalfOver) {
    const manfred = upcomingInning != null && upcomingInning >= 10;
    return { outs: 0, bases: manfred ? 2 : 0 };
  }
  const outs = o as 0 | 1 | 2;
  const off = ls.offense ?? {};
  const b1 = off.first?.id ? 1 : 0;
  const b2 = off.second?.id ? 2 : 0;
  const b3 = off.third?.id ? 4 : 0;
  return { outs, bases: ((b1 | b2 | b3) as Bases) };
}
