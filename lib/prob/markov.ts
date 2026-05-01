import type { PaOutcomes } from "../mlb/splits";

/**
 * 24-state base-out Markov chain for half-inning run probability.
 *
 * States: (outs ∈ {0,1,2}) × (bases ∈ {0..7}) = 24 active states + 1 absorbing
 * "3 outs" state. Bases use a 3-bit encoding:
 *   bit 0 = runner on 1st, bit 1 = runner on 2nd, bit 2 = runner on 3rd.
 *
 * Per-PA transitions accept the canonical 8-outcome multinomial (1B / 2B / 3B
 * / HR / BB / HBP / K / ipOut) and emit a distribution over (next state, runs
 * scored).
 *
 * Advance probabilities are Tango defaults from "The Book" Ch 1; each tunable
 * constant is documented inline.
 */

export type Bases = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type GameState = { outs: 0 | 1 | 2; bases: Bases };

export type Transition = { next: { outs: number; bases: Bases }; runs: number; weight: number };

// =========================================================================
// Tunable advance probabilities (Tango defaults; tune via calibration shim).
// =========================================================================

/** P(runner on 2nd scores on a single) by outs at the start of the PA. */
const P_2_HOME_ON_1B: readonly [number, number, number] = [0.30, 0.45, 0.55];

/** P(runner on 1st scores on a double) by outs at the start of the PA. */
const P_1_HOME_ON_2B: readonly [number, number, number] = [0.40, 0.60, 0.70];

/** P(in-play out is a GIDP) when 1st is occupied AND outs < 2. */
const P_GIDP = 0.10;

/** P(in-play out is a sacrifice fly that scores 3rd) when 3rd is occupied AND outs < 2. */
const P_SF = 0.20;

// =========================================================================
// Bit helpers for the 3-bit `bases` encoding.
// =========================================================================

const ON_1ST = 1;
const ON_2ND = 2;
const ON_3RD = 4;

function popcount(b: Bases): number {
  return (b & ON_1ST ? 1 : 0) + (b & ON_2ND ? 1 : 0) + (b & ON_3RD ? 1 : 0);
}

function makeBases(b1: number, b2: number, b3: number): Bases {
  return ((b1 ? ON_1ST : 0) | (b2 ? ON_2ND : 0) | (b3 ? ON_3RD : 0)) as Bases;
}

// =========================================================================
// Per-outcome transition rules.
// =========================================================================

function transK(state: GameState): Transition[] {
  return [{ next: { outs: state.outs + 1, bases: state.bases }, runs: 0, weight: 1 }];
}

function transBb(state: GameState): Transition[] {
  // Forced advance only. Lead runner stays unless every base behind it is
  // occupied (chain force).
  const b1 = state.bases & ON_1ST ? 1 : 0;
  const b2 = state.bases & ON_2ND ? 1 : 0;
  const b3 = state.bases & ON_3RD ? 1 : 0;
  const runs = b1 && b2 && b3 ? 1 : 0;
  const new_b1 = 1;
  const new_b2 = b1 || b2 ? 1 : 0;
  const new_b3 = b3 || (b1 && b2) ? 1 : 0;
  return [
    { next: { outs: state.outs, bases: makeBases(new_b1, new_b2, new_b3) }, runs, weight: 1 },
  ];
}

function transHr(state: GameState): Transition[] {
  return [
    {
      next: { outs: state.outs, bases: 0 as Bases },
      runs: 1 + popcount(state.bases),
      weight: 1,
    },
  ];
}

function transTriple(state: GameState): Transition[] {
  // All runners score; batter to 3rd.
  return [
    {
      next: { outs: state.outs, bases: ON_3RD as Bases },
      runs: popcount(state.bases),
      weight: 1,
    },
  ];
}

function transDouble(state: GameState): Transition[] {
  // Runners on 2nd and 3rd score. Runner on 1st scores w/ prob w; else stops at 3rd.
  const w = P_1_HOME_ON_2B[state.outs];
  const b1 = state.bases & ON_1ST ? 1 : 0;
  const b2 = state.bases & ON_2ND ? 1 : 0;
  const b3 = state.bases & ON_3RD ? 1 : 0;
  const baseRuns = b2 + b3;
  if (!b1) {
    return [
      {
        next: { outs: state.outs, bases: ON_2ND as Bases },
        runs: baseRuns,
        weight: 1,
      },
    ];
  }
  return [
    {
      next: { outs: state.outs, bases: ON_2ND as Bases },
      runs: baseRuns + 1,
      weight: w,
    },
    {
      next: { outs: state.outs, bases: (ON_2ND | ON_3RD) as Bases },
      runs: baseRuns,
      weight: 1 - w,
    },
  ];
}

function transSingle(state: GameState): Transition[] {
  // Runner on 3rd scores. Runner on 2nd scores w/ prob w; else stops at 3rd.
  // Runner on 1st advances to 2nd. Batter to 1st.
  const w = P_2_HOME_ON_1B[state.outs];
  const b1 = state.bases & ON_1ST ? 1 : 0;
  const b2 = state.bases & ON_2ND ? 1 : 0;
  const b3 = state.bases & ON_3RD ? 1 : 0;
  const baseRuns = b3; // runner on 3rd always scores
  const r1NewPos = b1 ? 1 : 0; // runner from 1st now on 2nd

  if (!b2) {
    // No 2nd-runner advancement decision needed.
    const new_b1 = 1; // batter
    const new_b2 = r1NewPos;
    const new_b3 = 0;
    return [
      {
        next: { outs: state.outs, bases: makeBases(new_b1, new_b2, new_b3) },
        runs: baseRuns,
        weight: 1,
      },
    ];
  }
  // 2nd was occupied — branch on whether 2nd runner scores or stops at 3rd.
  return [
    {
      // 2nd scores
      next: { outs: state.outs, bases: makeBases(1, r1NewPos, 0) },
      runs: baseRuns + 1,
      weight: w,
    },
    {
      // 2nd stops at 3rd
      next: { outs: state.outs, bases: makeBases(1, r1NewPos, 1) },
      runs: baseRuns,
      weight: 1 - w,
    },
  ];
}

function transIpOut(state: GameState): Transition[] {
  const b1 = state.bases & ON_1ST ? 1 : 0;
  const b2 = state.bases & ON_2ND ? 1 : 0;
  const b3 = state.bases & ON_3RD ? 1 : 0;

  // At 2 outs: just +1 out, no advancement (third out ends inning).
  if (state.outs >= 2) {
    return [{ next: { outs: state.outs + 1, bases: state.bases }, runs: 0, weight: 1 }];
  }

  const branches: Transition[] = [];
  let plainWeight = 1;

  // GIDP: requires runner on 1st AND outs < 2. Adds 2 outs total. No
  // runner advances; runner from 3rd does NOT score (force at home not modeled
  // separately — GIDP from a non-1st-runner force is rare and absorbed here).
  if (b1) {
    const gidpOuts = state.outs + 2;
    branches.push({
      // Clear 1st (the lead runner) since they were forced out at 2nd.
      next: { outs: gidpOuts, bases: makeBases(0, b2, b3) },
      runs: 0,
      weight: P_GIDP,
    });
    plainWeight -= P_GIDP;
  }

  // Sac fly: requires runner on 3rd AND outs < 2. Runner from 3rd scores.
  if (b3) {
    branches.push({
      next: { outs: state.outs + 1, bases: makeBases(b1, b2, 0) },
      runs: 1,
      weight: P_SF,
    });
    plainWeight -= P_SF;
  }

  // Plain out: bases unchanged, +1 out.
  if (plainWeight > 0) {
    branches.push({
      next: { outs: state.outs + 1, bases: state.bases },
      runs: 0,
      weight: plainWeight,
    });
  }

  return branches;
}

export function transitionsForOutcome(
  outcome: keyof PaOutcomes,
  state: GameState,
): Transition[] {
  switch (outcome) {
    case "k":
      return transK(state);
    case "bb":
    case "hbp":
      return transBb(state);
    case "hr":
      return transHr(state);
    case "triple":
      return transTriple(state);
    case "double":
      return transDouble(state);
    case "single":
      return transSingle(state);
    case "ipOut":
      return transIpOut(state);
  }
}

// =========================================================================
// Forward chain.
// =========================================================================

const OUTCOME_KEYS: readonly (keyof PaOutcomes)[] = [
  "single",
  "double",
  "triple",
  "hr",
  "bb",
  "hbp",
  "k",
  "ipOut",
] as const;

function stateKey(outs: number, bases: Bases): number {
  return outs * 8 + bases;
}

/**
 * Probability that AT LEAST ONE run scores from `start` to the end of the
 * (half-)inning, given the upcoming `lineup` of per-PA outcome distributions.
 *
 * The chain runs forward up to lineup.length PAs. In practice the inning
 * absorbs (3 outs) within ~5–8 PAs. If the lineup runs out before absorption,
 * the remaining "alive" mass is treated as no-runs (conservative).
 */
export function pAtLeastOneRun(
  start: GameState,
  lineup: PaOutcomes[],
): number {
  if (start.outs >= 3) return 0;
  let alive = new Map<number, number>([[stateKey(start.outs, start.bases), 1]]);
  let pHasRun = 0;

  for (let i = 0; i < lineup.length; i++) {
    if (alive.size === 0) break;
    const pa = lineup[i];
    const next = new Map<number, number>();

    for (const [key, mass] of alive) {
      if (mass <= 0) continue;
      const outs = Math.floor(key / 8) as 0 | 1 | 2;
      const bases = (key % 8) as Bases;
      const state: GameState = { outs, bases };

      for (const oc of OUTCOME_KEYS) {
        const p = pa[oc];
        if (p <= 0) continue;
        const transitions = transitionsForOutcome(oc, state);
        for (const tr of transitions) {
          const m = mass * p * tr.weight;
          if (m <= 0) continue;
          if (tr.runs > 0) {
            pHasRun += m;
          } else if (tr.next.outs >= 3) {
            // Inning ends with no runs — absorbed silently.
          } else {
            const k = stateKey(tr.next.outs, tr.next.bases);
            next.set(k, (next.get(k) ?? 0) + m);
          }
        }
      }
    }

    alive = next;
  }

  return pHasRun;
}
