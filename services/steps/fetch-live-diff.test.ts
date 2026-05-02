import { describe, expect, it } from "vitest";
import { chooseRecommendedWaitSeconds } from "./fetch-live-diff";
import type { LiveFeed } from "../../lib/mlb/types";

function makeFeed(opts: {
  wait?: number;
  abstract?: string;
  detailed?: string;
  inningState?: string;
  outs?: number;
}): LiveFeed {
  return {
    metaData: { timeStamp: "x", wait: opts.wait },
    gameData: {
      status: {
        abstractGameState: opts.abstract ?? "Live",
        detailedState: opts.detailed,
      },
      teams: {
        away: { id: 1, name: "A" },
        home: { id: 2, name: "B" },
      },
    },
    liveData: {
      linescore: {
        inningState: opts.inningState,
        outs: opts.outs,
      },
      plays: { allPlays: [] },
      boxscore: { teams: { home: { players: {} }, away: { players: {} } } },
    },
  } as unknown as LiveFeed;
}

describe("chooseRecommendedWaitSeconds", () => {
  it("caps at 5s during active live PA so outs surface within ~5s", () => {
    const wait = chooseRecommendedWaitSeconds(
      makeFeed({ wait: 12, abstract: "Live", inningState: "Top", outs: 1 }),
    );
    expect(wait).toBe(5);
  });

  it("keeps 15s cap during half-inning breaks (inningState=Middle)", () => {
    const wait = chooseRecommendedWaitSeconds(
      makeFeed({ wait: 60, abstract: "Live", inningState: "Middle", outs: 0 }),
    );
    expect(wait).toBe(15);
  });

  it("keeps 15s cap at the 3-out flicker so structural reload isn't rushed", () => {
    const wait = chooseRecommendedWaitSeconds(
      makeFeed({ wait: 30, abstract: "Live", inningState: "Top", outs: 3 }),
    );
    expect(wait).toBe(15);
  });

  it("uses 15s cap when not Live (Pre/Final)", () => {
    expect(
      chooseRecommendedWaitSeconds(
        makeFeed({ wait: 30, abstract: "Preview", outs: 0 }),
      ),
    ).toBe(15);
    expect(
      chooseRecommendedWaitSeconds(
        makeFeed({ wait: 30, abstract: "Final", outs: 0 }),
      ),
    ).toBe(15);
  });

  it("honors MLB's wait when smaller than the cap, but never below 5s", () => {
    expect(
      chooseRecommendedWaitSeconds(
        makeFeed({ wait: 8, abstract: "Live", inningState: "Bottom", outs: 1 }),
      ),
    ).toBe(5);
    expect(
      chooseRecommendedWaitSeconds(
        makeFeed({ wait: 2, abstract: "Live", inningState: "Bottom", outs: 1 }),
      ),
    ).toBe(5);
    expect(
      chooseRecommendedWaitSeconds(
        makeFeed({ wait: 12, abstract: "Live", inningState: "End", outs: 0 }),
      ),
    ).toBe(12);
  });

  it("defaults to 10→capped when wait field is absent", () => {
    expect(
      chooseRecommendedWaitSeconds(
        makeFeed({ abstract: "Live", inningState: "Top", outs: 2 }),
      ),
    ).toBe(5);
    expect(
      chooseRecommendedWaitSeconds(
        makeFeed({ abstract: "Live", inningState: "Middle", outs: 0 }),
      ),
    ).toBe(10);
  });
});
