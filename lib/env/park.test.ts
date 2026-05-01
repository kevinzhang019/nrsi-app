import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NEUTRAL_PARK, parseSavantHtml } from "./park";

const SAVANT_FIXTURE = readFileSync(
  join(__dirname, "__fixtures__/savant-park-2025.html"),
  "utf-8",
);

describe("NEUTRAL_PARK", () => {
  it("all components are 1.0 for both handedness sides", () => {
    for (const c of ["hr", "triple", "double", "single", "k", "bb"] as const) {
      expect(NEUTRAL_PARK[c].L).toBe(1);
      expect(NEUTRAL_PARK[c].R).toBe(1);
    }
  });
});

describe("parseSavantHtml", () => {
  const rows = parseSavantHtml(SAVANT_FIXTURE);

  it("extracts at least 25 team rows from the live Savant JSON shape", () => {
    expect(rows.length).toBeGreaterThanOrEqual(25);
  });

  it("returns runsIndex as ratios (typically 0.85–1.20)", () => {
    for (const r of rows) {
      expect(r.runsIndex).toBeGreaterThan(0.8);
      expect(r.runsIndex).toBeLessThan(1.3);
    }
  });

  it("populates per-component fields (hr, 2b, 3b, 1b, k, bb)", () => {
    // After the parser fix, every row should have all components since the
    // live JSON includes index_hr/index_2b/index_3b/index_1b/index_so/index_bb.
    const withAllComponents = rows.filter(
      (r) =>
        r.hrIndex !== undefined &&
        r.doubleIndex !== undefined &&
        r.tripleIndex !== undefined &&
        r.singleIndex !== undefined &&
        r.kIndex !== undefined &&
        r.bbIndex !== undefined,
    );
    expect(withAllComponents.length).toBe(rows.length);
  });

  it("includes Red Sox with a runs-friendly Fenway value (>1.05)", () => {
    const bos = rows.find((r) => r.team === "Red Sox");
    expect(bos).toBeDefined();
    expect(bos!.runsIndex).toBeGreaterThan(1.05);
  });

  it("normalizes 'D-backs' to 'Diamondbacks' so substring matching works", () => {
    const ari = rows.find((r) => r.team === "Diamondbacks");
    expect(ari).toBeDefined();
  });
});
