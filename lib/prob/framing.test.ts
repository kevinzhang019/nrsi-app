import { describe, it, expect } from "vitest";
import { applyFraming } from "./framing";
import { LEAGUE_PA, type PaOutcomes } from "../mlb/splits";

function sumPa(p: PaOutcomes): number {
  return p.single + p.double + p.triple + p.hr + p.bb + p.hbp + p.k + p.ipOut;
}

describe("applyFraming", () => {
  it("identity factors preserve multinomial exactly", () => {
    const input: PaOutcomes = { ...LEAGUE_PA.R };
    const out = applyFraming(input, { k: 1, bb: 1 });
    (Object.keys(input) as (keyof PaOutcomes)[]).forEach((k) => {
      expect(out[k]).toBeCloseTo(input[k], 10);
    });
  });

  it("top-framer factors → K up, BB down, sum still 1", () => {
    const input: PaOutcomes = { ...LEAGUE_PA.R };
    const out = applyFraming(input, { k: 1.04, bb: 0.96 });
    expect(out.k).toBeGreaterThan(input.k);
    expect(out.bb).toBeLessThan(input.bb);
    expect(sumPa(out)).toBeCloseTo(1, 6);
  });

  it("bad-framer factors → K down, BB up, sum still 1", () => {
    const input: PaOutcomes = { ...LEAGUE_PA.R };
    const out = applyFraming(input, { k: 0.96, bb: 1.04 });
    expect(out.k).toBeLessThan(input.k);
    expect(out.bb).toBeGreaterThan(input.bb);
    expect(sumPa(out)).toBeCloseTo(1, 6);
  });

  it("hits + HR + HBP unchanged at the multiplier level (only renormalize touches them)", () => {
    const input: PaOutcomes = { ...LEAGUE_PA.R };
    const out = applyFraming(input, { k: 1.04, bb: 0.96 });
    const ratioBefore = input.hr / input.single;
    const ratioAfter = out.hr / out.single;
    // Renormalize scales all by same factor → ratios preserved.
    expect(ratioAfter).toBeCloseTo(ratioBefore, 6);
  });
});
