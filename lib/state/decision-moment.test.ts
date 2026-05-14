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
  // Returns a GameState-shaped fixture with just the fields decisionMomentFor
  // reads. Other fields are cast through `as unknown as GameState` since the
  // predicate ignores them entirely.
  function game(overrides: {
    status?: GameState["status"];
    inning?: number | null;
    half?: GameState["half"];
    outs?: number | null;
    bases?: number | null;
    /** Runs scored so far in the inning's away (top) half. */
    topRuns?: number;
    /** Runs scored so far in the inning's bottom half. */
    bottomRuns?: number;
  }): GameState {
    const inning = overrides.inning === undefined ? 5 : overrides.inning;
    const linescore =
      inning !== null
        ? {
            innings: Array.from({ length: inning }, (_, i) => ({
              num: i + 1,
              away: {
                runs: i === inning - 1 ? overrides.topRuns ?? 0 : 0,
                hits: 0,
                errors: 0,
              },
              home: {
                runs: i === inning - 1 ? overrides.bottomRuns ?? 0 : 0,
                hits: 0,
                errors: 0,
              },
            })),
            totals: {
              away: { R: 0, H: 0, E: 0 },
              home: { R: 0, H: 0, E: 0 },
            },
          }
        : null;
    return {
      status: overrides.status ?? "Live",
      inning,
      half: overrides.half ?? "Top",
      outs: overrides.outs ?? 0,
      bases: overrides.bases ?? 0,
      linescore,
    } as unknown as GameState;
  }

  describe("half mode", () => {
    it("highlights a fresh top half (0 outs, 0 bases, 0 runs)", () => {
      expect(decisionMomentFor(game({ half: "Top", outs: 0, bases: 0 }), "half")).toBe(true);
    });

    it("highlights a fresh bottom half (0 outs, 0 bases, 0 runs)", () => {
      expect(decisionMomentFor(game({ half: "Bottom", outs: 0, bases: 0 }), "half")).toBe(true);
    });

    it("highlights 3 outs at the top (transition)", () => {
      expect(decisionMomentFor(game({ half: "Top", outs: 3 }), "half")).toBe(true);
    });

    it("highlights 3 outs at the bottom (transition)", () => {
      expect(decisionMomentFor(game({ half: "Bottom", outs: 3 }), "half")).toBe(true);
    });

    it("does NOT highlight a fresh top with a runner on (e.g. leadoff walk)", () => {
      expect(decisionMomentFor(game({ outs: 0, bases: 1 }), "half")).toBe(false);
    });

    it("highlights a fresh top after a leadoff HR (0 outs, 0 bases, 1 run)", () => {
      expect(decisionMomentFor(game({ half: "Top", outs: 0, bases: 0, topRuns: 1 }), "half")).toBe(
        true,
      );
    });

    it("highlights a fresh bottom after a leadoff HR (0 outs, 0 bases, 1 run)", () => {
      expect(
        decisionMomentFor(game({ half: "Bottom", outs: 0, bases: 0, bottomRuns: 1 }), "half"),
      ).toBe(true);
    });

    it("does NOT highlight mid-PA (1 out, runners on, run scored)", () => {
      expect(decisionMomentFor(game({ outs: 1, bases: 2, topRuns: 1 }), "half")).toBe(false);
    });

    it("highlights extra-innings fresh half with only the Manfred runner on 2B", () => {
      expect(
        decisionMomentFor(game({ inning: 10, half: "Top", outs: 0, bases: 2 }), "half"),
      ).toBe(true);
      expect(
        decisionMomentFor(game({ inning: 12, half: "Bottom", outs: 0, bases: 2 }), "half"),
      ).toBe(true);
    });

    it("does NOT highlight extras with the Manfred runner advanced (e.g. 1B+2B)", () => {
      expect(
        decisionMomentFor(game({ inning: 10, half: "Top", outs: 0, bases: 3 }), "half"),
      ).toBe(false);
    });

    it("highlights extras with the Manfred runner still on 2B even after a run scored", () => {
      expect(
        decisionMomentFor(
          game({ inning: 10, half: "Top", outs: 0, bases: 2, topRuns: 1 }),
          "half",
        ),
      ).toBe(true);
    });

    it("does NOT highlight a regulation fresh half with a runner on 2B", () => {
      expect(decisionMomentFor(game({ inning: 5, outs: 0, bases: 2 }), "half")).toBe(false);
    });

    it("does NOT highlight when status is not Live", () => {
      expect(decisionMomentFor(game({ status: "Pre", outs: 0, bases: 0 }), "half")).toBe(false);
      expect(decisionMomentFor(game({ status: "Final", outs: 3 }), "half")).toBe(false);
    });
  });

  describe("full mode", () => {
    it("highlights a fresh top half (= new inning starting)", () => {
      expect(decisionMomentFor(game({ half: "Top", outs: 0, bases: 0 }), "full")).toBe(true);
    });

    it("does NOT highlight a fresh bottom half (mid-inning)", () => {
      expect(decisionMomentFor(game({ half: "Bottom", outs: 0, bases: 0 }), "full")).toBe(false);
    });

    it("highlights 3 outs at the bottom (= full inning just ended)", () => {
      expect(decisionMomentFor(game({ half: "Bottom", outs: 3 }), "full")).toBe(true);
    });

    it("does NOT highlight 3 outs at the top (mid-inning transition to bottom)", () => {
      expect(decisionMomentFor(game({ half: "Top", outs: 3 }), "full")).toBe(false);
    });

    it("highlights a fresh top after a leadoff HR (runs scored, bases still clean)", () => {
      expect(decisionMomentFor(game({ half: "Top", outs: 0, bases: 0, topRuns: 1 }), "full")).toBe(
        true,
      );
    });

    it("does NOT highlight a fresh top with a runner on", () => {
      expect(decisionMomentFor(game({ half: "Top", outs: 0, bases: 1 }), "full")).toBe(false);
    });

    it("highlights extras fresh top with only the Manfred runner on 2B", () => {
      expect(
        decisionMomentFor(game({ inning: 10, half: "Top", outs: 0, bases: 2 }), "full"),
      ).toBe(true);
    });

    it("does NOT highlight extras fresh bottom (mid-inning under full mode)", () => {
      expect(
        decisionMomentFor(game({ inning: 10, half: "Bottom", outs: 0, bases: 2 }), "full"),
      ).toBe(false);
    });

    it("does NOT highlight extras with the Manfred runner advanced", () => {
      expect(
        decisionMomentFor(game({ inning: 10, half: "Top", outs: 0, bases: 3 }), "full"),
      ).toBe(false);
    });
  });
});
