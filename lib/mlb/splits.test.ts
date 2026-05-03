import { describe, it, expect } from "vitest";
import { LEAGUE_PA, __testing, type PaOutcomes } from "./splits";

const { combineSeasonsPa, buildSide, defaultPa } = __testing;

// Build a stat-row Record matching what paFromStat consumes (counts in raw fields).
function makeStat(opts: {
  pa: number;
  k?: number;
  bb?: number;
  hr?: number;
  hits?: number;
  doubles?: number;
  triples?: number;
  hbp?: number;
}): Record<string, unknown> {
  return {
    plateAppearances: opts.pa,
    hits: opts.hits ?? 0,
    doubles: opts.doubles ?? 0,
    triples: opts.triples ?? 0,
    homeRuns: opts.hr ?? 0,
    baseOnBalls: opts.bb ?? 0,
    hitByPitch: opts.hbp ?? 0,
    strikeOuts: opts.k ?? 0,
  };
}

function sumPa(rates: PaOutcomes): number {
  return (
    rates.single + rates.double + rates.triple + rates.hr + rates.bb + rates.hbp + rates.k + rates.ipOut
  );
}

describe("combineSeasonsPa", () => {
  const a: { rates: PaOutcomes; pa: number } = {
    pa: 100,
    rates: {
      single: 0.20,
      double: 0.05,
      triple: 0.00,
      hr: 0.05,
      bb: 0.10,
      hbp: 0.00,
      k: 0.30,
      ipOut: 0.30,
    },
  };
  const b: { rates: PaOutcomes; pa: number } = {
    pa: 600,
    rates: {
      single: 0.10,
      double: 0.05,
      triple: 0.00,
      hr: 0.02,
      bb: 0.08,
      hbp: 0.00,
      k: 0.25,
      ipOut: 0.50,
    },
  };

  it("returns null when both inputs are null", () => {
    expect(combineSeasonsPa(null, null)).toBeNull();
  });

  it("returns current rates and PA when prior is null", () => {
    const out = combineSeasonsPa(a, null);
    expect(out).not.toBeNull();
    expect(out!.truePa).toBe(100);
    expect(out!.rates).toEqual(a.rates);
  });

  it("returns prior rates and PA when current is null", () => {
    const out = combineSeasonsPa(null, b);
    expect(out).not.toBeNull();
    expect(out!.truePa).toBe(600);
    expect(out!.rates).toEqual(b.rates);
  });

  it("returns null when both inputs have pa = 0", () => {
    const zeroA = { ...a, pa: 0 };
    const zeroB = { ...b, pa: 0 };
    expect(combineSeasonsPa(zeroA, zeroB)).toBeNull();
  });

  it("blends using a 3:2 multiplier on PA", () => {
    // current 100 PA, prior 600 PA → weighted (3·100) : (2·600) = 300 : 1200
    // → current contributes 300 / 1500 = 0.20 of the blended rate.
    const out = combineSeasonsPa(a, b);
    expect(out).not.toBeNull();
    expect(out!.truePa).toBe(700);
    const wCurrent = (3 * 100) / (3 * 100 + 2 * 600);
    expect(wCurrent).toBeCloseTo(0.2, 10);
    const expectedHr = wCurrent * a.rates.hr + (1 - wCurrent) * b.rates.hr;
    expect(out!.rates.hr).toBeCloseTo(expectedHr, 10);
    expect(sumPa(out!.rates)).toBeCloseTo(1, 10);
  });

  it("with equal PA, leans 60/40 toward current via the 3:2 multiplier", () => {
    const equalCurrent = { ...a, pa: 500 };
    const equalPrior = { ...b, pa: 500 };
    const out = combineSeasonsPa(equalCurrent, equalPrior);
    expect(out).not.toBeNull();
    expect(out!.truePa).toBe(1000);
    const wCurrent = (3 * 500) / (3 * 500 + 2 * 500);
    expect(wCurrent).toBeCloseTo(0.6, 10);
    const expectedK = wCurrent * a.rates.k + (1 - wCurrent) * b.rates.k;
    expect(out!.rates.k).toBeCloseTo(expectedK, 10);
  });
});

describe("buildSide", () => {
  it("falls back to defaultPa when current, prior, and recent are all empty", () => {
    const sideL = buildSide(null, null, null, LEAGUE_PA.L, "L");
    expect(sideL.pa).toBe(0);
    expect(sideL.rates).toEqual(defaultPa("L"));
  });

  it("with only prior season data (no current, no recent), shrinks against priorPa", () => {
    // Big-sample prior with K rate well above league.
    const prior = makeStat({ pa: 600, k: 240, bb: 60, hr: 18, hits: 150, doubles: 30 });
    const side = buildSide(null, prior, null, LEAGUE_PA.R, "R");
    expect(side.pa).toBe(600);
    // shrinkage weight w = 600 / (600 + 200) = 0.75
    // observed K rate = 240/600 = 0.40, league K = 0.226
    // shrunk K = 0.75·0.40 + 0.25·0.226 = 0.3565
    expect(side.rates.k).toBeCloseTo(0.75 * 0.4 + 0.25 * LEAGUE_PA.R.k, 4);
    expect(sumPa(side.rates)).toBeCloseTo(1, 6);
  });

  it("with current and prior both present, the 3:2 blend leans toward current", () => {
    const current = makeStat({ pa: 600, k: 60, bb: 60, hr: 18, hits: 150, doubles: 30 }); // K rate 0.10
    const prior = makeStat({ pa: 600, k: 240, bb: 60, hr: 18, hits: 150, doubles: 30 }); // K rate 0.40
    const side = buildSide(current, prior, null, LEAGUE_PA.R, "R");
    expect(side.pa).toBe(1200);
    // Blended K rate before shrinkage: (3·600·0.10 + 2·600·0.40) / (3·600 + 2·600)
    //   = (180 + 480) / 3000 = 0.22
    // Shrinkage weight against true PA: w = 1200 / 1400 ≈ 0.857
    // Shrunk K = 0.857·0.22 + 0.143·0.226 ≈ 0.2209
    const blendedK = 0.22;
    const w = 1200 / 1400;
    const expected = w * blendedK + (1 - w) * LEAGUE_PA.R.k;
    expect(side.rates.k).toBeCloseTo(expected, 4);
  });

  it("drops L30 when its PA is below the materiality gate (20)", () => {
    const current = makeStat({ pa: 600, k: 60, hits: 150, doubles: 30 });
    const recent = makeStat({ pa: 10, k: 10, hits: 0 }); // tiny sample → drop
    const sideWith = buildSide(current, null, recent, LEAGUE_PA.R, "R");
    const sideWithout = buildSide(current, null, null, LEAGUE_PA.R, "R");
    expect(sideWith.rates).toEqual(sideWithout.rates);
  });

  it("when only L30 is present, blends 0.7·league + 0.3·recentShrunk", () => {
    const recent = makeStat({ pa: 100, k: 50, hits: 30, doubles: 10 }); // K rate 0.50
    const side = buildSide(null, null, recent, LEAGUE_PA.R, "R");
    // baselineRaw is null → baselineShrunk = league
    // recent shrinkage: w = 100/300 ≈ 0.333; recentShrunk K = 0.333·0.50 + 0.667·0.226 ≈ 0.317
    const wRecent = 100 / 300;
    const recentShrunkK = wRecent * 0.5 + (1 - wRecent) * LEAGUE_PA.R.k;
    const expectedK = 0.7 * LEAGUE_PA.R.k + 0.3 * recentShrunkK;
    expect(side.rates.k).toBeCloseTo(expectedK, 4);
    expect(sumPa(side.rates)).toBeCloseTo(1, 6);
  });

  it("blended distribution always sums to 1 across realistic inputs", () => {
    const current = makeStat({ pa: 250, k: 70, bb: 25, hr: 8, hbp: 3, hits: 65, doubles: 14, triples: 1 });
    const prior = makeStat({ pa: 580, k: 150, bb: 60, hr: 22, hbp: 6, hits: 145, doubles: 30, triples: 3 });
    const recent = makeStat({ pa: 95, k: 25, bb: 12, hr: 4, hbp: 1, hits: 28, doubles: 6 });
    const side = buildSide(current, prior, recent, LEAGUE_PA.L, "L");
    expect(sumPa(side.rates)).toBeCloseTo(1, 6);
    expect(side.pa).toBe(830);
  });
});
