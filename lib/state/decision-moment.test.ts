import { describe, expect, it } from "vitest";
import { isDecisionMoment, isDecisionMomentFullInning, type GameState } from "./game-state";
import { decisionMomentFor } from "./decision-moment";

type PredicateInput = Parameters<typeof isDecisionMomentFullInning>[0];

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
  // Spec: full-inning highlights only when the upcoming half is a TOP — i.e.
  // a new inning is about to begin. Driven by `upcomingHalf` from
  // getUpcomingForCurrentInning, which is robust to MLB feed quirks at
  // half-boundaries (where inningState may be "middle"/"end" inconsistently).

  it("fires at end of BOTTOM — upcomingHalf flips to Top of next inning", () => {
    expect(
      isDecisionMomentFullInning(
        live({ half: "Bottom", outs: 3, inningState: "Bottom", upcomingHalf: "Top" }),
      ),
    ).toBe(true);
  });

  it("fires when inningState is end (between innings, upcoming is Top)", () => {
    expect(
      isDecisionMomentFullInning(
        live({ half: "Bottom", outs: 3, inningState: "End", upcomingHalf: "Top" }),
      ),
    ).toBe(true);
  });

  it("fires at start of game (Top, outs=0, upcomingHalf=Top)", () => {
    expect(
      isDecisionMomentFullInning(
        live({ inning: 1, half: "Top", outs: 0, inningState: "Top", upcomingHalf: "Top" }),
      ),
    ).toBe(true);
  });

  it("fires at start of any new inning's top (mid-game, upcomingHalf=Top)", () => {
    expect(
      isDecisionMomentFullInning(
        live({ inning: 5, half: "Top", outs: 0, inningState: "Top", upcomingHalf: "Top" }),
      ),
    ).toBe(true);
  });

  it("does NOT fire at end of TOP — upcomingHalf flips to Bottom (mid-inning)", () => {
    expect(
      isDecisionMomentFullInning(
        live({ half: "Top", outs: 3, inningState: "Top", upcomingHalf: "Bottom" }),
      ),
    ).toBe(false);
  });

  it("does NOT fire when inningState is middle (top→bottom flip)", () => {
    expect(
      isDecisionMomentFullInning(
        live({ half: "Top", outs: 3, inningState: "Middle", upcomingHalf: "Bottom" }),
      ),
    ).toBe(false);
  });

  it("does not fire mid-half", () => {
    expect(
      isDecisionMomentFullInning(live({ outs: 1, upcomingHalf: "Top" })),
    ).toBe(false);
  });

  it("does not fire when not a baseline decision moment", () => {
    expect(
      isDecisionMomentFullInning(live({ status: "Pre", outs: 3, upcomingHalf: "Top" })),
    ).toBe(false);
  });

  it("does not fire when upcomingHalf is missing (defensive default)", () => {
    expect(
      isDecisionMomentFullInning(live({ half: "Bottom", outs: 3, inningState: "End" })),
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
