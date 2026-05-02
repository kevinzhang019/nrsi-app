import { describe, expect, it } from "vitest";
import { readMarkovStartState } from "./start-state";
import type { LiveFeed } from "@/lib/mlb/types";

function feedWith(linescore: Partial<LiveFeed["liveData"]["linescore"]>): LiveFeed {
  return {
    metaData: { timeStamp: "x" },
    gameData: {
      status: { abstractGameState: "Live" },
      teams: { away: { id: 1, name: "A" }, home: { id: 2, name: "H" } },
    },
    liveData: {
      linescore: linescore as LiveFeed["liveData"]["linescore"],
    },
  } as LiveFeed;
}

describe("readMarkovStartState", () => {
  it("zeroes outs/bases at half-end in regulation", () => {
    const feed = feedWith({
      outs: 3,
      inningState: "End",
      offense: { second: { id: 999 } },
    });
    expect(readMarkovStartState(feed, 5)).toEqual({ outs: 0, bases: 0 });
  });

  it("injects Manfred runner on 2B at half-end in extras (inning >= 10)", () => {
    const feed = feedWith({
      outs: 3,
      inningState: "End",
    });
    expect(readMarkovStartState(feed, 10)).toEqual({ outs: 0, bases: 2 });
    expect(readMarkovStartState(feed, 12)).toEqual({ outs: 0, bases: 2 });
  });

  it("does not inject Manfred when upcomingInning is null (unknown)", () => {
    const feed = feedWith({ outs: 3, inningState: "End" });
    expect(readMarkovStartState(feed, null)).toEqual({ outs: 0, bases: 0 });
  });

  it("zeroes when inningState is middle regardless of bases on offense", () => {
    const feed = feedWith({
      outs: 0,
      inningState: "Middle",
      offense: { first: { id: 111 }, second: { id: 222 } },
    });
    expect(readMarkovStartState(feed, 6)).toEqual({ outs: 0, bases: 0 });
  });

  it("Manfred override applies on inningState=middle for next-half extras", () => {
    const feed = feedWith({ outs: 0, inningState: "Middle" });
    expect(readMarkovStartState(feed, 11)).toEqual({ outs: 0, bases: 2 });
  });

  it("mid-PA reads bases from feed (not Manfred-overridden)", () => {
    // Top of 10 leadoff: feed populates Manfred runner on 2B in offense.second.
    // We trust the feed mid-PA — no manual injection.
    const feed = feedWith({
      outs: 0,
      inningState: "Top",
      offense: { second: { id: 999 } },
    });
    expect(readMarkovStartState(feed, 10)).toEqual({ outs: 0, bases: 2 });
  });

  it("mid-PA reads runners on 1B+3B", () => {
    const feed = feedWith({
      outs: 1,
      inningState: "Top",
      offense: { first: { id: 1 }, third: { id: 3 } },
    });
    // bit0 (1B) + bit2 (3B) = 1 + 4 = 5
    expect(readMarkovStartState(feed, 5)).toEqual({ outs: 1, bases: 5 });
  });

  it("mid-PA empty bases gives bases=0 even in extras", () => {
    // If MLB feed somehow doesn't populate offense.second at top-10 leadoff,
    // readMarkovStartState reflects that — we don't second-guess mid-PA.
    const feed = feedWith({ outs: 0, inningState: "Top", offense: {} });
    expect(readMarkovStartState(feed, 10)).toEqual({ outs: 0, bases: 0 });
  });
});
