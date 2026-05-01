import { describe, it, expect } from "vitest";
import { pAtLeastOneRun, transitionsForOutcome, type Bases, type GameState } from "./markov";
import type { PaOutcomes } from "../mlb/splits";
import { LEAGUE_PA } from "../mlb/splits";

const ZERO_PA: PaOutcomes = {
  single: 0, double: 0, triple: 0, hr: 0, bb: 0, hbp: 0, k: 0, ipOut: 0,
};

function only(outcome: keyof PaOutcomes): PaOutcomes {
  return { ...ZERO_PA, [outcome]: 1 };
}

describe("transitionsForOutcome — K", () => {
  it("adds an out, bases unchanged, no runs", () => {
    const trs = transitionsForOutcome("k", { outs: 1, bases: 5 as Bases });
    expect(trs.length).toBe(1);
    expect(trs[0].next.outs).toBe(2);
    expect(trs[0].next.bases).toBe(5);
    expect(trs[0].runs).toBe(0);
  });
});

describe("transitionsForOutcome — HR", () => {
  it("clears bases and scores 1 + popcount(bases)", () => {
    const cases: Array<[Bases, number]> = [
      [0, 1], [1, 2], [2, 2], [3, 3], [4, 2], [5, 3], [6, 3], [7, 4],
    ];
    for (const [bases, expectedRuns] of cases) {
      const trs = transitionsForOutcome("hr", { outs: 0, bases });
      expect(trs[0].next.bases).toBe(0);
      expect(trs[0].runs).toBe(expectedRuns);
    }
  });
});

describe("transitionsForOutcome — Triple", () => {
  it("scores all base-runners, batter to 3rd", () => {
    expect(transitionsForOutcome("triple", { outs: 0, bases: 7 as Bases })[0].runs).toBe(3);
    expect(transitionsForOutcome("triple", { outs: 0, bases: 7 as Bases })[0].next.bases).toBe(4);
    expect(transitionsForOutcome("triple", { outs: 0, bases: 0 as Bases })[0].runs).toBe(0);
  });
});

describe("transitionsForOutcome — BB", () => {
  it("on bases empty: batter to 1st, no runs", () => {
    const trs = transitionsForOutcome("bb", { outs: 0, bases: 0 as Bases });
    expect(trs[0].next.bases).toBe(1);
    expect(trs[0].runs).toBe(0);
  });
  it("with bases loaded: forces a run", () => {
    const trs = transitionsForOutcome("bb", { outs: 0, bases: 7 as Bases });
    expect(trs[0].next.bases).toBe(7);
    expect(trs[0].runs).toBe(1);
  });
  it("with runner on 3rd only: no force, batter to 1st, no runs", () => {
    const trs = transitionsForOutcome("bb", { outs: 0, bases: 4 as Bases });
    expect(trs[0].next.bases).toBe(5); // 1st + 3rd
    expect(trs[0].runs).toBe(0);
  });
});

describe("transitionsForOutcome — IPout", () => {
  it("at 2 outs: just +1 out, no advancement", () => {
    const trs = transitionsForOutcome("ipOut", { outs: 2, bases: 7 as Bases });
    expect(trs.length).toBe(1);
    expect(trs[0].next.outs).toBe(3);
    expect(trs[0].next.bases).toBe(7);
    expect(trs[0].runs).toBe(0);
  });
  it("with runner on 3rd, < 2 outs: branches include a sac fly that scores 3rd", () => {
    const trs = transitionsForOutcome("ipOut", { outs: 0, bases: 4 as Bases });
    const sf = trs.find((t) => t.runs === 1);
    expect(sf).toBeDefined();
    expect(sf!.next.outs).toBe(1);
  });
});

describe("pAtLeastOneRun — sanity bounds", () => {
  it("returns 0 when nobody can do anything (all ipOut)", () => {
    const lineup = Array(9).fill(only("ipOut"));
    const p = pAtLeastOneRun({ outs: 0, bases: 0 }, lineup);
    expect(p).toBeCloseTo(0, 6);
  });

  it("returns 1 when first batter homers", () => {
    const lineup = [only("hr")];
    const p = pAtLeastOneRun({ outs: 0, bases: 0 }, lineup);
    expect(p).toBeCloseTo(1, 6);
  });

  it("starting at 3 outs: returns 0", () => {
    const lineup = Array(9).fill(only("hr"));
    const p = pAtLeastOneRun({ outs: 3 as 0 | 1 | 2, bases: 0 }, lineup);
    expect(p).toBe(0);
  });

  it("starting with runner on 3rd, 0 outs: even modest contact scores", () => {
    // A lineup that only hits singles has plenty of runs from this state.
    const lineup = Array(9).fill(only("single"));
    const p = pAtLeastOneRun({ outs: 0, bases: 4 }, lineup);
    expect(p).toBeCloseTo(1, 6); // first batter hits a single → 3rd scores
  });
});

describe("pAtLeastOneRun — Tango league-mean run-frequency anchor", () => {
  it("9 league-mean batters from (0 outs, empty) ≈ 0.27 (P(NRSI) ≈ 0.73)", () => {
    // Tango's run-frequency table for 2010–2015: P(≥1 run | 0 outs, empty) = 0.268.
    // Modern (2022) MLB observed: 0.266 (Albert / bayesball.github.io).
    // We accept ±0.04 tolerance because:
    //   (a) our LEAGUE_PA constants are approximate,
    //   (b) extra-base advance probabilities are Tango defaults (no team customization),
    //   (c) runners on first NEVER advance to 3rd on a single in v1 (slight under-bias).
    const lineup = Array(9).fill({ ...LEAGUE_PA.R });
    const p = pAtLeastOneRun({ outs: 0, bases: 0 }, lineup);
    expect(p).toBeGreaterThan(0.22);
    expect(p).toBeLessThan(0.32);
  });
});

describe("pAtLeastOneRun — Monte Carlo cross-check", () => {
  it("matches simulation within 1pp for a varied multinomial", () => {
    const pa: PaOutcomes = { ...LEAGUE_PA.R };
    const lineup = Array(9).fill(pa);
    const exact = pAtLeastOneRun({ outs: 0, bases: 0 }, lineup);
    const sim = simulateInning(lineup, 50_000);
    expect(Math.abs(exact - sim)).toBeLessThan(0.01);
  });
});

// =========================================================================
// Reference Monte Carlo using the SAME transition rules as the chain.
// (Validates the chain math, not the rules themselves.)
// =========================================================================

function simulateInning(lineup: PaOutcomes[], trials: number): number {
  const seed = 12345;
  let r = seed;
  function rand(): number {
    r = (r * 1664525 + 1013904223) >>> 0;
    return r / 0x100000000;
  }

  function pickOutcome(pa: PaOutcomes): keyof PaOutcomes {
    const u = rand();
    let acc = 0;
    const keys: (keyof PaOutcomes)[] = ["single", "double", "triple", "hr", "bb", "hbp", "k", "ipOut"];
    for (const k of keys) {
      acc += pa[k];
      if (u < acc) return k;
    }
    return "ipOut";
  }

  let runHits = 0;
  for (let t = 0; t < trials; t++) {
    let outs = 0;
    let bases = 0;
    let runs = 0;
    for (const pa of lineup) {
      if (outs >= 3) break;
      const oc = pickOutcome(pa);
      const trs = transitionsForOutcome(oc, { outs: outs as 0 | 1 | 2, bases: bases as Bases });
      const u = rand();
      let acc = 0;
      let chosen = trs[0];
      for (const tr of trs) {
        acc += tr.weight;
        if (u < acc) { chosen = tr; break; }
      }
      runs += chosen.runs;
      outs = chosen.next.outs;
      bases = chosen.next.bases;
      if (runs > 0) break;
    }
    if (runs > 0) runHits++;
  }
  return runHits / trials;
}
