import { describe, it, expect } from "vitest";
import { defenseFactor, NEUTRAL_DEFENSE_FACTOR, type OaaTable } from "./defense";

function makeTable(rows: Array<{ id: number; oaa: number; opps: number; pos?: string }>): OaaTable {
  const t = new Map();
  for (const r of rows) {
    t.set(r.id, { playerId: r.id, oaa: r.oaa, opportunities: r.opps, position: r.pos ?? "OF" });
  }
  return t;
}

describe("defenseFactor", () => {
  it("empty table → neutral", () => {
    expect(defenseFactor([1, 2, 3, 4, 5, 6, 7], new Map())).toBe(NEUTRAL_DEFENSE_FACTOR);
  });

  it("empty fielders list → neutral", () => {
    const t = makeTable([{ id: 1, oaa: 50, opps: 500 }]);
    expect(defenseFactor([], t)).toBe(NEUTRAL_DEFENSE_FACTOR);
  });

  it("all-zero OAA → neutral", () => {
    const t = makeTable([
      { id: 1, oaa: 0, opps: 500 },
      { id: 2, oaa: 0, opps: 500 },
      { id: 3, oaa: 0, opps: 500 },
      { id: 4, oaa: 0, opps: 500 },
      { id: 5, oaa: 0, opps: 500 },
      { id: 6, oaa: 0, opps: 500 },
      { id: 7, oaa: 0, opps: 500 },
    ]);
    expect(defenseFactor([1, 2, 3, 4, 5, 6, 7], t)).toBe(1);
  });

  it("strong defense (Σ OAA ~+50) → factor < 1", () => {
    const t = makeTable([
      { id: 1, oaa: 12, opps: 500 },
      { id: 2, oaa: 10, opps: 500 },
      { id: 3, oaa: 9, opps: 500 },
      { id: 4, oaa: 8, opps: 500 },
      { id: 5, oaa: 5, opps: 500 },
      { id: 6, oaa: 4, opps: 500 },
      { id: 7, oaa: 2, opps: 500 },
    ]);
    const f = defenseFactor([1, 2, 3, 4, 5, 6, 7], t);
    expect(f).toBeLessThan(1);
    expect(f).toBeGreaterThan(0.95);
  });

  it("weak defense (Σ OAA ~−40) → factor > 1", () => {
    const t = makeTable([
      { id: 1, oaa: -8, opps: 500 },
      { id: 2, oaa: -7, opps: 500 },
      { id: 3, oaa: -6, opps: 500 },
      { id: 4, oaa: -6, opps: 500 },
      { id: 5, oaa: -5, opps: 500 },
      { id: 6, oaa: -5, opps: 500 },
      { id: 7, oaa: -3, opps: 500 },
    ]);
    const f = defenseFactor([1, 2, 3, 4, 5, 6, 7], t);
    expect(f).toBeGreaterThan(1);
    expect(f).toBeLessThan(1.05);
  });

  it("clamps to [0.90, 1.10]", () => {
    const great = makeTable([
      { id: 1, oaa: 200, opps: 500 },
      { id: 2, oaa: 200, opps: 500 },
    ]);
    const awful = makeTable([
      { id: 1, oaa: -200, opps: 500 },
      { id: 2, oaa: -200, opps: 500 },
    ]);
    expect(defenseFactor([1, 2], great)).toBe(0.90);
    expect(defenseFactor([1, 2], awful)).toBe(1.10);
  });

  it("low-sample player gets shrunk toward zero", () => {
    // Same raw OAA but very different sample sizes.
    const highSample = makeTable([{ id: 1, oaa: 20, opps: 500 }]);
    const lowSample = makeTable([{ id: 1, oaa: 20, opps: 20 }]);
    const fHigh = defenseFactor([1], highSample);
    const fLow = defenseFactor([1], lowSample);
    // Low-sample is shrunk more → factor closer to 1.
    expect(Math.abs(1 - fLow)).toBeLessThan(Math.abs(1 - fHigh));
  });

  it("missing fielder ids contribute 0 (no degradation)", () => {
    const t = makeTable([{ id: 1, oaa: 30, opps: 500 }]);
    const fWithUnknown = defenseFactor([1, 9999], t);
    const fAlone = defenseFactor([1], t);
    expect(fWithUnknown).toBeCloseTo(fAlone, 6);
  });
});
