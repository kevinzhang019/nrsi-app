import { describe, it, expect } from "vitest";
import { hrRateMultiplier, type ExpectedRow } from "./expected-stats";

function row(over: Partial<ExpectedRow> = {}): ExpectedRow {
  return {
    playerId: 1,
    pa: 600,
    bbe: 400,
    hr: 25,
    xHr: 25,
    xwOba: 0.330,
    barrelRate: 0.08,
    ...over,
  };
}

describe("hrRateMultiplier", () => {
  it("identity when xHR equals observed HR", () => {
    expect(hrRateMultiplier(row())).toBeCloseTo(1, 6);
  });

  it("identity when row is missing or zero PA", () => {
    expect(hrRateMultiplier(undefined)).toBe(1);
    expect(hrRateMultiplier(row({ pa: 0 }))).toBe(1);
    expect(hrRateMultiplier(row({ bbe: 0 }))).toBe(1);
    expect(hrRateMultiplier(row({ hr: 0 }))).toBe(1);
  });

  it("lucky season (HR > xHR): multiplier shrinks toward < 1", () => {
    const m = hrRateMultiplier(row({ hr: 35, xHr: 20 })); // observed >> expected
    expect(m).toBeLessThan(1);
    expect(m).toBeGreaterThanOrEqual(0.7);
  });

  it("unlucky season (HR < xHR): multiplier > 1", () => {
    const m = hrRateMultiplier(row({ hr: 15, xHr: 30 })); // expected >> observed
    expect(m).toBeGreaterThan(1);
    expect(m).toBeLessThanOrEqual(1.3);
  });

  it("low-BBE: shrinks heavily toward 1", () => {
    // Modest divergence (ratio 1.25) so we don't clamp before the shrinkage
    // difference is visible — both endpoints would otherwise hit the ceiling.
    const big = hrRateMultiplier(row({ hr: 20, xHr: 25, bbe: 400 }));
    const small = hrRateMultiplier(row({ hr: 20, xHr: 25, bbe: 30 }));
    expect(Math.abs(1 - small)).toBeLessThan(Math.abs(1 - big));
  });
});
