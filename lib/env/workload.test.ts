import { describe, it, expect } from "vitest";
import { workloadKFactor, applyWorkload } from "./workload";
import { LEAGUE_PA, type PaOutcomes } from "../mlb/splits";

describe("workloadKFactor", () => {
  it("under threshold → identity", () => {
    expect(workloadKFactor(0)).toBe(1);
    expect(workloadKFactor(60)).toBe(1);
    expect(workloadKFactor(120)).toBe(1);
  });

  it("at and above high-load cap → 0.97", () => {
    expect(workloadKFactor(200)).toBeCloseTo(0.97, 6);
    expect(workloadKFactor(400)).toBeCloseTo(0.97, 6);
  });

  it("between threshold and cap: smooth linear ramp", () => {
    const mid = workloadKFactor(160);
    expect(mid).toBeGreaterThan(0.97);
    expect(mid).toBeLessThan(1);
  });

  it("non-finite input → identity", () => {
    expect(workloadKFactor(NaN)).toBe(1);
  });
});

describe("applyWorkload", () => {
  function sum(p: PaOutcomes): number {
    return p.single + p.double + p.triple + p.hr + p.bb + p.hbp + p.k + p.ipOut;
  }

  it("preserves sum-to-1", () => {
    const adj = applyWorkload({ ...LEAGUE_PA.R }, 0.97);
    expect(sum(adj)).toBeCloseTo(1, 6);
  });

  it("identity when factor === 1", () => {
    const pa = { ...LEAGUE_PA.R };
    expect(applyWorkload(pa, 1)).toEqual(pa);
  });

  it("factor < 1 reduces K rate", () => {
    const pa = { ...LEAGUE_PA.R };
    const adj = applyWorkload(pa, 0.97);
    expect(adj.k).toBeLessThan(pa.k);
  });
});
