import { describe, it, expect } from "vitest";
import { applyDefense } from "./defense";
import { LEAGUE_PA, type PaOutcomes } from "../mlb/splits";

function sumPa(p: PaOutcomes): number {
  return p.single + p.double + p.triple + p.hr + p.bb + p.hbp + p.k + p.ipOut;
}

describe("applyDefense", () => {
  it("identity factor (1) preserves multinomial exactly", () => {
    const input: PaOutcomes = { ...LEAGUE_PA.R };
    const out = applyDefense(input, 1);
    (Object.keys(input) as (keyof PaOutcomes)[]).forEach((k) => {
      expect(out[k]).toBeCloseTo(input[k], 10);
    });
  });

  it("factor < 1 → fewer hits, more ipOut, total still 1", () => {
    const input: PaOutcomes = { ...LEAGUE_PA.R };
    const out = applyDefense(input, 0.95);
    const inHits = input.single + input.double + input.triple;
    const outHits = out.single + out.double + out.triple;
    expect(outHits).toBeLessThan(inHits);
    expect(out.ipOut).toBeGreaterThan(input.ipOut);
    expect(sumPa(out)).toBeCloseTo(1, 6);
  });

  it("factor > 1 → more hits, less ipOut, total still 1", () => {
    const input: PaOutcomes = { ...LEAGUE_PA.R };
    const out = applyDefense(input, 1.05);
    const inHits = input.single + input.double + input.triple;
    const outHits = out.single + out.double + out.triple;
    expect(outHits).toBeGreaterThan(inHits);
    expect(out.ipOut).toBeLessThan(input.ipOut);
    expect(sumPa(out)).toBeCloseTo(1, 6);
  });

  it("K, BB, HBP, HR are unchanged", () => {
    const input: PaOutcomes = { ...LEAGUE_PA.R };
    const out = applyDefense(input, 0.92);
    expect(out.k).toBeCloseTo(input.k, 10);
    expect(out.bb).toBeCloseTo(input.bb, 10);
    expect(out.hbp).toBeCloseTo(input.hbp, 10);
    expect(out.hr).toBeCloseTo(input.hr, 10);
  });

  it("hit reapportionment preserves single:double:triple ratios", () => {
    const input: PaOutcomes = { ...LEAGUE_PA.R };
    const out = applyDefense(input, 0.90);
    const inRatio12 = input.single / input.double;
    const outRatio12 = out.single / out.double;
    expect(outRatio12).toBeCloseTo(inRatio12, 6);
  });

  it("zero-hits input is unchanged (no in-play mass to redistribute)", () => {
    const input: PaOutcomes = {
      single: 0, double: 0, triple: 0, hr: 0.05,
      bb: 0.10, hbp: 0.01, k: 0.30, ipOut: 0.54,
    };
    const out = applyDefense(input, 0.90);
    (Object.keys(input) as (keyof PaOutcomes)[]).forEach((k) => {
      expect(out[k]).toBeCloseTo(input[k], 10);
    });
  });
});
