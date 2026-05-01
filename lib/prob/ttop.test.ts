import { describe, it, expect } from "vitest";
import { ttoIndex, ttopFactors, applyTtop } from "./ttop";
import { LEAGUE_PA, type PaOutcomes } from "../mlb/splits";

describe("ttoIndex", () => {
  it("buckets PA-in-game into 1st/2nd/3rd/4th time through", () => {
    expect(ttoIndex(0)).toBe(1);
    expect(ttoIndex(8)).toBe(1);
    expect(ttoIndex(9)).toBe(2);
    expect(ttoIndex(17)).toBe(2);
    expect(ttoIndex(18)).toBe(3);
    expect(ttoIndex(26)).toBe(3);
    expect(ttoIndex(27)).toBe(4);
    expect(ttoIndex(50)).toBe(4);
  });
});

describe("ttopFactors", () => {
  it("first time through is identity", () => {
    const f = ttopFactors(0);
    expect(f.k).toBe(1);
    expect(f.bb).toBe(1);
    expect(f.hr).toBe(1);
  });

  it("each successive pass weakens K, strengthens BB and HR", () => {
    const f1 = ttopFactors(0);
    const f2 = ttopFactors(9);
    const f3 = ttopFactors(18);
    const f4 = ttopFactors(27);
    expect(f2.k).toBeLessThan(f1.k);
    expect(f3.k).toBeLessThan(f2.k);
    expect(f4.k).toBeLessThan(f3.k);
    expect(f2.bb).toBeGreaterThan(f1.bb);
    expect(f3.bb).toBeGreaterThan(f2.bb);
    expect(f4.bb).toBeGreaterThan(f3.bb);
    expect(f2.hr).toBeGreaterThan(f1.hr);
    expect(f3.hr).toBeGreaterThan(f2.hr);
    expect(f4.hr).toBeGreaterThan(f3.hr);
  });
});

describe("applyTtop", () => {
  function sumPa(p: PaOutcomes): number {
    return p.single + p.double + p.triple + p.hr + p.bb + p.hbp + p.k + p.ipOut;
  }

  it("preserves sum-to-1 invariant", () => {
    const out = applyTtop({ ...LEAGUE_PA.R }, 18);
    expect(sumPa(out)).toBeCloseTo(1, 6);
  });

  it("3rd time through: HR rate up vs baseline", () => {
    const baseline: PaOutcomes = { ...LEAGUE_PA.R };
    const ttop3 = applyTtop(baseline, 18);
    expect(ttop3.hr).toBeGreaterThan(baseline.hr);
  });
});
