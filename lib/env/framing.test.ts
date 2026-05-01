import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { framingFactors, NEUTRAL_FRAMING_FACTORS, type FramingTable } from "./framing";

function makeTable(rows: Array<{ id: number; strikes: number; called: number }>): FramingTable {
  const t = new Map();
  for (const r of rows) {
    t.set(r.id, { catcherId: r.id, strikesAdded: r.strikes, calledPitches: r.called });
  }
  return t;
}

describe("framingFactors", () => {
  it("empty table → neutral", () => {
    expect(framingFactors(123, new Map())).toEqual(NEUTRAL_FRAMING_FACTORS);
  });

  it("null catcher → neutral", () => {
    const t = makeTable([{ id: 1, strikes: 20, called: 9000 }]);
    expect(framingFactors(null, t)).toEqual(NEUTRAL_FRAMING_FACTORS);
  });

  it("unknown catcher in non-empty table → neutral", () => {
    const t = makeTable([{ id: 1, strikes: 20, called: 9000 }]);
    expect(framingFactors(9999, t)).toEqual(NEUTRAL_FRAMING_FACTORS);
  });

  it("league-average catcher (0 strikes added) → near identity", () => {
    const t = makeTable([{ id: 1, strikes: 0, called: 9000 }]);
    const f = framingFactors(1, t);
    expect(f.k).toBeCloseTo(1, 3);
    expect(f.bb).toBeCloseTo(1, 3);
  });

  it("top framer → K up, BB down", () => {
    const t = makeTable([{ id: 1, strikes: 25, called: 9000 }]);
    const f = framingFactors(1, t);
    expect(f.k).toBeGreaterThan(1);
    expect(f.bb).toBeLessThan(1);
  });

  it("bottom framer → K down, BB up", () => {
    const t = makeTable([{ id: 1, strikes: -20, called: 9000 }]);
    const f = framingFactors(1, t);
    expect(f.k).toBeLessThan(1);
    expect(f.bb).toBeGreaterThan(1);
  });

  it("clamps to [0.95, 1.05]", () => {
    const extreme = makeTable([{ id: 1, strikes: 500, called: 1000 }]);
    const f = framingFactors(1, extreme);
    expect(f.k).toBeLessThanOrEqual(1.05);
    expect(f.bb).toBeGreaterThanOrEqual(0.95);
  });

  it("low-sample catcher (same rate) is shrunk further toward neutral", () => {
    // Both at the same per-pitch rate of strikes added (~0.0022).
    // After EB shrinkage, the low-sample factor should be closer to 1.
    const highSample = makeTable([{ id: 1, strikes: 20, called: 9000 }]);
    const lowSample = makeTable([{ id: 1, strikes: 1, called: 450 }]);
    const fHigh = framingFactors(1, highSample);
    const fLow = framingFactors(1, lowSample);
    expect(Math.abs(1 - fLow.k)).toBeLessThan(Math.abs(1 - fHigh.k));
  });
});

describe("framingFactors kill switch", () => {
  const original = process.env.NRSI_DISABLE_FRAMING;
  beforeEach(() => { process.env.NRSI_DISABLE_FRAMING = "1"; });
  afterEach(() => {
    if (original === undefined) delete process.env.NRSI_DISABLE_FRAMING;
    else process.env.NRSI_DISABLE_FRAMING = original;
  });

  it("returns neutral regardless of catcher when disabled", () => {
    const t = makeTable([{ id: 1, strikes: 25, called: 9000 }]);
    expect(framingFactors(1, t)).toEqual(NEUTRAL_FRAMING_FACTORS);
  });
});
