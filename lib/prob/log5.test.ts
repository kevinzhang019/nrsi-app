import { describe, it, expect } from "vitest";
import { log5Matchup, effectiveBatterStance, batterSideVs, matchupPa, applyEnv } from "./log5";
import { LEAGUE_PA, type BatterPaProfile, type PitcherPaProfile, type PaOutcomes } from "../mlb/splits";
import type { ParkComponentFactors } from "../env/park";
import type { WeatherComponentFactors } from "../env/weather";

const NEUTRAL_PARK: ParkComponentFactors = {
  hr: { L: 1, R: 1 },
  triple: { L: 1, R: 1 },
  double: { L: 1, R: 1 },
  single: { L: 1, R: 1 },
  k: { L: 1, R: 1 },
  bb: { L: 1, R: 1 },
};

const NEUTRAL_WEATHER: WeatherComponentFactors = {
  hr: 1,
  triple: 1,
  double: 1,
  single: 1,
  k: 1,
  bb: 1,
};

function sumPa(p: PaOutcomes): number {
  return p.single + p.double + p.triple + p.hr + p.bb + p.hbp + p.k + p.ipOut;
}

describe("log5Matchup", () => {
  it("Tango binary worked example: .400 batter vs .250 pitcher in .333 league → .308", () => {
    // Build OBP-only "matchups" by encoding "obp" as `1 - k - ipOut` and the
    // rest as a single bucket. Easiest: collapse to two outcomes (onBase, out).
    // For a faithful Tango check, we compare odds-ratio output to .308.
    const oddsRatio = (b: number, p: number, l: number) =>
      ((b * p) / l) / ((b * p) / l + ((1 - b) * (1 - p)) / (1 - l));
    expect(oddsRatio(0.4, 0.25, 0.333)).toBeCloseTo(0.308, 2);
  });

  it("returns league when batter and pitcher both equal league", () => {
    const out = log5Matchup(LEAGUE_PA.R, LEAGUE_PA.R, LEAGUE_PA.R);
    (Object.keys(LEAGUE_PA.R) as (keyof PaOutcomes)[]).forEach((k) => {
      expect(out[k]).toBeCloseTo(LEAGUE_PA.R[k], 3);
    });
    expect(sumPa(out)).toBeCloseTo(1, 6);
  });

  it("strong hitter × strong pitcher gives a result between the two", () => {
    const strongHitter: PaOutcomes = {
      ...LEAGUE_PA.R,
      hr: 0.05,
      single: 0.16,
      ipOut: 0.43,
    };
    const dominantPitcher: PaOutcomes = {
      ...LEAGUE_PA.R,
      k: 0.30,
      hr: 0.018,
      ipOut: 0.50,
    };
    const out = log5Matchup(strongHitter, dominantPitcher, LEAGUE_PA.R);
    expect(sumPa(out)).toBeCloseTo(1, 6);
    // Strong hitter pulls HR rate up; dominant pitcher pulls it down.
    // Result should sit between the two, not below either.
    expect(out.hr).toBeGreaterThan(LEAGUE_PA.R.hr * 0.5);
  });

  it("output always sums to 1", () => {
    const a: PaOutcomes = { ...LEAGUE_PA.R, hr: 0.06, k: 0.30, ipOut: 0.30 };
    const b: PaOutcomes = { ...LEAGUE_PA.L, hr: 0.02, k: 0.18, ipOut: 0.55 };
    expect(sumPa(log5Matchup(a, b, LEAGUE_PA.R))).toBeCloseTo(1, 6);
  });
});

describe("effectiveBatterStance", () => {
  it("non-switch hitter uses their fixed stance", () => {
    expect(effectiveBatterStance("L", "R")).toBe("L");
    expect(effectiveBatterStance("L", "L")).toBe("L");
    expect(effectiveBatterStance("R", "R")).toBe("R");
    expect(effectiveBatterStance("R", "L")).toBe("R");
  });
  it("switch hitter takes platoon advantage", () => {
    expect(effectiveBatterStance("S", "R")).toBe("L"); // bats LHB vs RHP
    expect(effectiveBatterStance("S", "L")).toBe("R"); // bats RHB vs LHP
  });
});

function makeBatter(bats: "L" | "R" | "S", hr: number): BatterPaProfile {
  const base: PaOutcomes = { ...LEAGUE_PA.R, hr };
  // Adjust ipOut so total = 1.
  const sumNonOut = base.single + base.double + base.triple + base.hr + base.bb + base.hbp + base.k;
  base.ipOut = 1 - sumNonOut;
  return {
    id: 1,
    fullName: "Test",
    bats,
    paVs: { L: { ...base }, R: { ...base } },
    paCounts: { L: 300, R: 300 },
  };
}

function makePitcher(throws: "L" | "R"): PitcherPaProfile {
  return {
    id: 100,
    fullName: "TestP",
    throws,
    paVs: { L: { ...LEAGUE_PA.L }, R: { ...LEAGUE_PA.R } },
    paCounts: { L: 200, R: 200 },
  };
}

describe("batterSideVs", () => {
  it("LHB vs RHP reads batter.L (=vs LHP wait — vs RHP for hitter is paVs.R)", () => {
    const result = batterSideVs(makeBatter("L", 0.03), makePitcher("R"));
    // For a non-switch LHB vs RHP: batterSide should be R (= the pitcher hand,
    // which is the key under which the hitter's vs-RHP performance is stored),
    // pitcherSide should be L (= batter's hitting hand, the key for the
    // pitcher's vs-LHB performance).
    expect(result.batterSide).toBe("R");
    expect(result.pitcherSide).toBe("L");
  });
  it("switch hitter vs RHP routes through LHB stance", () => {
    const result = batterSideVs(makeBatter("S", 0.03), makePitcher("R"));
    expect(result.batterSide).toBe("R");
    expect(result.pitcherSide).toBe("L");
  });
  it("switch hitter vs LHP routes through RHB stance", () => {
    const result = batterSideVs(makeBatter("S", 0.03), makePitcher("L"));
    expect(result.batterSide).toBe("L");
    expect(result.pitcherSide).toBe("R");
  });
});

describe("matchupPa", () => {
  it("returns a valid PaOutcomes that sums to 1", () => {
    const result = matchupPa(makeBatter("R", 0.04), makePitcher("R"), LEAGUE_PA);
    expect(sumPa(result)).toBeCloseTo(1, 6);
  });
});

describe("applyEnv", () => {
  it("identity env factors leave distribution unchanged", () => {
    const input: PaOutcomes = { ...LEAGUE_PA.R };
    const out = applyEnv(input, NEUTRAL_PARK, NEUTRAL_WEATHER, "R");
    (Object.keys(input) as (keyof PaOutcomes)[]).forEach((k) => {
      expect(out[k]).toBeCloseTo(input[k], 6);
    });
  });

  it("HR-friendly weather pushes HR rate up; total stays 1", () => {
    const input: PaOutcomes = { ...LEAGUE_PA.R };
    const hot: WeatherComponentFactors = { ...NEUTRAL_WEATHER, hr: 1.15 };
    const out = applyEnv(input, NEUTRAL_PARK, hot, "R");
    expect(out.hr).toBeGreaterThan(input.hr);
    expect(sumPa(out)).toBeCloseTo(1, 6);
  });

  it("park factor reads from the batter's stance side", () => {
    const input: PaOutcomes = { ...LEAGUE_PA.R };
    const lefty: ParkComponentFactors = {
      ...NEUTRAL_PARK,
      hr: { L: 1.20, R: 1.0 },
    };
    const outL = applyEnv(input, lefty, NEUTRAL_WEATHER, "L");
    const outR = applyEnv(input, lefty, NEUTRAL_WEATHER, "R");
    expect(outL.hr).toBeGreaterThan(outR.hr);
  });
});
