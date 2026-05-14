import { describe, it, expect } from "vitest";
import { applyStuff, stuffFactors, type StuffRow } from "./stuff";
import { LEAGUE_PA, type PaOutcomes } from "../mlb/splits";

function row(over: Partial<StuffRow> = {}): StuffRow {
  return {
    playerId: 1,
    pitchingPlus: 100,
    stuffPlus: 100,
    locationPlus: 100,
    ...over,
  };
}

describe("stuffFactors", () => {
  it("league-average Pitching+ → identity", () => {
    const f = stuffFactors(row({ pitchingPlus: 100 }));
    expect(f.k).toBeCloseTo(1, 6);
    expect(f.hr).toBeCloseTo(1, 6);
  });

  it("missing row or null Pitching+ → identity", () => {
    expect(stuffFactors(undefined)).toEqual({ k: 1, hr: 1 });
    expect(stuffFactors(row({ pitchingPlus: null }))).toEqual({ k: 1, hr: 1 });
  });

  it("high Pitching+ (good pitcher) → K up, HR down", () => {
    const f = stuffFactors(row({ pitchingPlus: 120 }));
    expect(f.k).toBeGreaterThan(1);
    expect(f.hr).toBeLessThan(1);
  });

  it("low Pitching+ → K down, HR up", () => {
    const f = stuffFactors(row({ pitchingPlus: 80 }));
    expect(f.k).toBeLessThan(1);
    expect(f.hr).toBeGreaterThan(1);
  });

  it("factors clamped to [0.95, 1.05]", () => {
    const top = stuffFactors(row({ pitchingPlus: 200 }));
    const bottom = stuffFactors(row({ pitchingPlus: 30 }));
    expect(top.k).toBeLessThanOrEqual(1.05);
    expect(top.hr).toBeGreaterThanOrEqual(0.95);
    expect(bottom.k).toBeGreaterThanOrEqual(0.95);
    expect(bottom.hr).toBeLessThanOrEqual(1.05);
  });
});

describe("applyStuff", () => {
  function sum(p: PaOutcomes): number {
    return p.single + p.double + p.triple + p.hr + p.bb + p.hbp + p.k + p.ipOut;
  }

  it("preserves sum-to-1", () => {
    const adj = applyStuff({ ...LEAGUE_PA.R }, { k: 1.04, hr: 0.96 });
    expect(sum(adj)).toBeCloseTo(1, 6);
  });

  it("identity factors return input unchanged", () => {
    const pa = { ...LEAGUE_PA.R };
    expect(applyStuff(pa, { k: 1, hr: 1 })).toEqual(pa);
  });
});
