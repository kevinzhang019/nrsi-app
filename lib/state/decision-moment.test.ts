import { describe, expect, it } from "vitest";
import { isDecisionMoment, isDecisionMomentFullInning, type GameState } from "./game-state";
import { decisionMomentFor } from "./decision-moment";

type PredicateInput = Parameters<typeof isDecisionMoment>[0];

const live = (overrides: Partial<PredicateInput>): PredicateInput => ({
  status: "Live",
  inning: 5,
  half: "Top",
  outs: 1,
  inningState: "Top",
  ...overrides,
});

describe("isDecisionMoment (half-inning)", () => {
  it("fires at end of TOP (outs=3)", () => {
    expect(isDecisionMoment(live({ half: "Top", outs: 3 }))).toBe(true);
  });

  it("fires at end of BOTTOM (outs=3)", () => {
    expect(isDecisionMoment(live({ half: "Bottom", outs: 3 }))).toBe(true);
  });

  it("fires when inningState is middle", () => {
    expect(isDecisionMoment(live({ inningState: "Middle" }))).toBe(true);
  });

  it("fires when inningState is end", () => {
    expect(isDecisionMoment(live({ inningState: "End" }))).toBe(true);
  });

  it("fires at start of TOP (outs=0)", () => {
    expect(isDecisionMoment(live({ half: "Top", outs: 0 }))).toBe(true);
  });

  it("does not fire mid-half (1 out)", () => {
    expect(isDecisionMoment(live({ outs: 1 }))).toBe(false);
  });

  it("does not fire when status is not Live", () => {
    expect(isDecisionMoment(live({ status: "Pre", outs: 3 }))).toBe(false);
  });
});

describe("isDecisionMomentFullInning", () => {
  // Spec: cards highlight at every 3-out boundary regardless of predict mode.
  // The full-inning variant now mirrors the half-inning variant exactly.
  it("fires at end of TOP (outs=3) — same as half-inning", () => {
    expect(
      isDecisionMomentFullInning(live({ half: "Top", outs: 3, inningState: "Top" })),
    ).toBe(true);
  });

  it("fires when inningState is middle — same as half-inning", () => {
    expect(
      isDecisionMomentFullInning(live({ half: "Top", outs: 3, inningState: "Middle" })),
    ).toBe(true);
  });

  it("fires at end of BOTTOM (outs=3)", () => {
    expect(
      isDecisionMomentFullInning(live({ half: "Bottom", outs: 3, inningState: "Bottom" })),
    ).toBe(true);
  });

  it("fires when inningState is end (between innings)", () => {
    expect(
      isDecisionMomentFullInning(live({ half: "Bottom", outs: 3, inningState: "End" })),
    ).toBe(true);
  });

  it("fires at start of new inning (Top, outs=0, inning>1)", () => {
    expect(
      isDecisionMomentFullInning(live({ inning: 2, half: "Top", outs: 0 })),
    ).toBe(true);
  });

  it("does not fire mid-half", () => {
    expect(isDecisionMomentFullInning(live({ outs: 1 }))).toBe(false);
  });

  it("does not fire when not a baseline decision moment", () => {
    expect(
      isDecisionMomentFullInning(live({ status: "Pre", outs: 3 })),
    ).toBe(false);
  });
});

describe("decisionMomentFor", () => {
  const base = {
    isDecisionMoment: true,
    isDecisionMomentFullInning: false,
  } as unknown as GameState;

  it("picks half flag in half mode", () => {
    expect(decisionMomentFor(base, "half")).toBe(true);
  });

  it("picks full flag in full mode", () => {
    expect(decisionMomentFor(base, "full")).toBe(false);
  });

  it("treats missing full flag as false (back-compat for old snapshots)", () => {
    const stale = { isDecisionMoment: true } as unknown as GameState;
    expect(decisionMomentFor(stale, "full")).toBe(false);
    expect(decisionMomentFor(stale, "half")).toBe(true);
  });
});
