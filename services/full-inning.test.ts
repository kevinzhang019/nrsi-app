import { describe, expect, it } from "vitest";
import { shouldSkipBottomNinth } from "./full-inning";

describe("shouldSkipBottomNinth", () => {
  it("skips bottom-9 when home is leading entering top of the 9th", () => {
    expect(
      shouldSkipBottomNinth({ inning: 9, half: "Top", homeRuns: 5, awayRuns: 3 }),
    ).toBe(true);
  });

  it("does NOT skip when game is tied entering top of the 9th", () => {
    expect(
      shouldSkipBottomNinth({ inning: 9, half: "Top", homeRuns: 3, awayRuns: 3 }),
    ).toBe(false);
  });

  it("does NOT skip when home is losing entering top of the 9th", () => {
    expect(
      shouldSkipBottomNinth({ inning: 9, half: "Top", homeRuns: 2, awayRuns: 4 }),
    ).toBe(false);
  });

  it("does not apply to bottom of the 9th", () => {
    expect(
      shouldSkipBottomNinth({ inning: 9, half: "Bottom", homeRuns: 5, awayRuns: 5 }),
    ).toBe(false);
  });

  it("does not apply outside the 9th inning", () => {
    expect(
      shouldSkipBottomNinth({ inning: 8, half: "Top", homeRuns: 10, awayRuns: 0 }),
    ).toBe(false);
  });

  it("does not apply in extras (≥10) — those compose normally", () => {
    expect(
      shouldSkipBottomNinth({ inning: 10, half: "Top", homeRuns: 5, awayRuns: 4 }),
    ).toBe(false);
  });
});
