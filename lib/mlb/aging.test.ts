import { describe, it, expect } from "vitest";
import { agingMultipliers, applyAging, ageFromBirthDate } from "./aging";
import { LEAGUE_PA, type PaOutcomes } from "./splits";

describe("agingMultipliers", () => {
  it("at batter peak (age 27): identity", () => {
    const m = agingMultipliers(27, "batter");
    expect(m.hr).toBeCloseTo(1, 6);
    expect(m.k).toBeCloseTo(1, 6);
    expect(m.bb).toBeCloseTo(1, 6);
  });

  it("at pitcher peak (age 28): identity", () => {
    const m = agingMultipliers(28, "pitcher");
    expect(m.hr).toBeCloseTo(1, 6);
    expect(m.k).toBeCloseTo(1, 6);
  });

  it("aging batter past 30: HR fades, K rises", () => {
    const m = agingMultipliers(34, "batter");
    expect(m.hr).toBeLessThan(1);
    expect(m.k).toBeGreaterThan(1);
  });

  it("aging pitcher past 30: HR allowed rises, K rate falls", () => {
    const m = agingMultipliers(34, "pitcher");
    expect(m.hr).toBeGreaterThan(1);
    expect(m.k).toBeLessThan(1);
  });

  it("unknown age: identity", () => {
    const m = agingMultipliers(undefined, "batter");
    expect(m.hr).toBe(1);
    expect(m.k).toBe(1);
  });

  it("factor clamps so extreme ages can't blow up", () => {
    const m = agingMultipliers(45, "batter");
    expect(m.hr).toBeGreaterThanOrEqual(0.85);
    expect(m.k).toBeLessThanOrEqual(1.15);
  });
});

describe("applyAging", () => {
  function sum(p: PaOutcomes): number {
    return p.single + p.double + p.triple + p.hr + p.bb + p.hbp + p.k + p.ipOut;
  }

  it("preserves sum-to-1", () => {
    const aged = applyAging({ ...LEAGUE_PA.R }, 33, "batter");
    expect(sum(aged)).toBeCloseTo(1, 6);
  });

  it("undefined age returns input unchanged", () => {
    const pa = { ...LEAGUE_PA.R };
    expect(applyAging(pa, undefined, "batter")).toEqual(pa);
  });

  it("aging a 35yo batter reduces HR rate", () => {
    const pa = { ...LEAGUE_PA.R };
    const aged = applyAging(pa, 35, "batter");
    expect(aged.hr).toBeLessThan(pa.hr);
  });
});

describe("ageFromBirthDate", () => {
  it("computes age from YYYY-MM-DD", () => {
    const ref = new Date("2026-05-13T00:00:00Z");
    expect(ageFromBirthDate("1995-01-15", ref)).toBe(31);
    expect(ageFromBirthDate("1995-06-15", ref)).toBe(30); // hasn't had birthday yet
  });

  it("returns undefined for missing or malformed input", () => {
    expect(ageFromBirthDate(undefined)).toBeUndefined();
    expect(ageFromBirthDate("not-a-date")).toBeUndefined();
  });
});
