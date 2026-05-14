import { describe, it, expect, beforeEach } from "vitest";
import { calibrate, inningBucket, loadCalibrator } from "./calibration";

beforeEach(() => loadCalibrator(null));

describe("inningBucket", () => {
  it("buckets innings correctly", () => {
    expect(inningBucket(1)).toBe("1");
    expect(inningBucket(2)).toBe("2-6");
    expect(inningBucket(6)).toBe("2-6");
    expect(inningBucket(7)).toBe("7-9");
    expect(inningBucket(9)).toBe("7-9");
    expect(inningBucket(10)).toBe("10+");
    expect(inningBucket(15)).toBe("10+");
    expect(inningBucket(undefined)).toBe("2-6"); // sensible default
  });
});

describe("calibrate", () => {
  it("returns p unchanged when no calibrator loaded", () => {
    expect(calibrate(0.3)).toBeCloseTo(0.3, 6);
    expect(calibrate(0.7, { inning: 5, half: "Top" })).toBeCloseTo(0.7, 6);
  });

  it("loadCalibrator(null) clears and returns identity", () => {
    loadCalibrator({ points: [{ pred: 0, actual: 0.2 }, { pred: 1, actual: 0.6 }] });
    expect(calibrate(0.5)).toBeCloseTo(0.4, 6); // 0.2 + 0.5 * (0.6 - 0.2)
    loadCalibrator(null);
    expect(calibrate(0.5)).toBeCloseTo(0.5, 6);
  });

  it("single-table form acts as global default", () => {
    loadCalibrator({ points: [{ pred: 0, actual: 0 }, { pred: 1, actual: 0.5 }] });
    // No ctx — falls through to global.
    expect(calibrate(0.5)).toBeCloseTo(0.25, 6);
    // With ctx but no matching key — still falls back to global.
    expect(calibrate(0.5, { inning: 3, half: "Top" })).toBeCloseTo(0.25, 6);
  });

  it("stratified map: picks bucket-half key when present", () => {
    loadCalibrator({
      "1-Top": { points: [{ pred: 0, actual: 0 }, { pred: 1, actual: 1 }] }, // identity
      "7-9-Top": { points: [{ pred: 0, actual: 0.05 }, { pred: 1, actual: 0.7 }] },
    });
    expect(calibrate(0.5, { inning: 1, half: "Top" })).toBeCloseTo(0.5, 6);
    expect(calibrate(0.5, { inning: 8, half: "Top" })).toBeCloseTo(0.05 + 0.5 * (0.7 - 0.05), 6);
  });

  it("stratified map: bucket-only key as a half-agnostic fallback", () => {
    loadCalibrator({
      "2-6": { points: [{ pred: 0, actual: 0 }, { pred: 1, actual: 0.8 }] },
    });
    expect(calibrate(0.5, { inning: 4, half: "Bottom" })).toBeCloseTo(0.4, 6);
  });

  it("clamps below first point and above last", () => {
    loadCalibrator({ points: [{ pred: 0.2, actual: 0.1 }, { pred: 0.8, actual: 0.9 }] });
    expect(calibrate(0.05)).toBeCloseTo(0.1, 6);
    expect(calibrate(0.95)).toBeCloseTo(0.9, 6);
  });
});
