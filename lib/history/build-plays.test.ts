import { describe, expect, it } from "vitest";
import { buildPlayRows } from "./build-plays";
import type { LiveFeed, PlayDoc } from "@/lib/mlb/types";

function makeFeed(plays: PlayDoc[], boxscorePlayers?: Record<string, { person: { id: number; fullName: string } }>): LiveFeed {
  return {
    metaData: { timeStamp: "t" },
    gameData: {
      status: { abstractGameState: "Final", detailedState: "Final" },
      teams: { away: { id: 1, name: "A" }, home: { id: 2, name: "B" } },
    },
    liveData: {
      linescore: {},
      plays: { allPlays: plays },
      boxscore: {
        teams: {
          away: { players: boxscorePlayers ?? {} },
          home: { players: {} },
        },
      },
    },
  } as unknown as LiveFeed;
}

function play(over: Partial<PlayDoc> & { atBatIndex: number; inning: number; halfInning: "top" | "bottom"; batter: number; pitcher: number; }): PlayDoc {
  const { atBatIndex, inning, halfInning, batter, pitcher, ...rest } = over;
  return {
    about: { atBatIndex, inning, halfInning, isComplete: true },
    matchup: {
      batter: { id: batter },
      pitcher: { id: pitcher },
    },
    result: { event: "Single", eventType: "single" },
    count: { outs: 1 },
    runners: [],
    ...rest,
  };
}

describe("buildPlayRows", () => {
  it("emits one row per completed PA with normalized half", () => {
    const feed = makeFeed([
      play({ atBatIndex: 0, inning: 1, halfInning: "top", batter: 100, pitcher: 200 }),
      play({ atBatIndex: 1, inning: 1, halfInning: "top", batter: 101, pitcher: 200 }),
      play({ atBatIndex: 2, inning: 1, halfInning: "bottom", batter: 300, pitcher: 400 }),
    ]);
    const rows = buildPlayRows(feed, 12345);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      gamePk: 12345,
      atBatIndex: 0,
      inning: 1,
      half: "Top",
      batterId: 100,
      pitcherId: 200,
    });
    expect(rows[2].half).toBe("Bottom");
  });

  it("skips incomplete plays", () => {
    const incomplete = play({ atBatIndex: 5, inning: 3, halfInning: "top", batter: 1, pitcher: 2 });
    incomplete.about!.isComplete = false;
    const feed = makeFeed([incomplete]);
    expect(buildPlayRows(feed, 1)).toHaveLength(0);
  });

  it("skips plays missing batter or pitcher id", () => {
    const noBatter = play({ atBatIndex: 0, inning: 1, halfInning: "top", batter: 1, pitcher: 2 });
    delete noBatter.matchup!.batter!.id;
    const feed = makeFeed([noBatter]);
    expect(buildPlayRows(feed, 1)).toHaveLength(0);
  });

  it("resolves name from boxscore players, falls back to matchup, then 'Unknown'", () => {
    const feed = makeFeed(
      [
        play({ atBatIndex: 0, inning: 1, halfInning: "top", batter: 100, pitcher: 200 }),
        play({
          atBatIndex: 1,
          inning: 1,
          halfInning: "top",
          batter: 101,
          pitcher: 200,
          matchup: {
            batter: { id: 101, fullName: "Fallback Batter" },
            pitcher: { id: 200 },
          },
        }),
      ],
      {
        ID100: { person: { id: 100, fullName: "Box Batter" } },
        ID200: { person: { id: 200, fullName: "Box Pitcher" } },
      },
    );
    const rows = buildPlayRows(feed, 1);
    expect(rows[0].batterName).toBe("Box Batter");
    expect(rows[0].pitcherName).toBe("Box Pitcher");
    expect(rows[1].batterName).toBe("Fallback Batter"); // matchup fallback
  });

  it("counts runs_on_play from runners with movement.end === 'score'", () => {
    const homer = play({
      atBatIndex: 7,
      inning: 5,
      halfInning: "top",
      batter: 1,
      pitcher: 2,
      result: { event: "Home Run", eventType: "home_run", rbi: 3 },
      runners: [
        { details: { runner: { id: 50 } }, movement: { end: "score" } },
        { details: { runner: { id: 51 } }, movement: { end: "score" } },
        { details: { runner: { id: 1 } }, movement: { end: "score" } },
      ],
    });
    const feed = makeFeed([homer]);
    const rows = buildPlayRows(feed, 1);
    expect(rows[0].runsOnPlay).toBe(3);
    expect(rows[0].rbi).toBe(3);
  });

  it("sorts by atBatIndex even if input is shuffled", () => {
    const feed = makeFeed([
      play({ atBatIndex: 5, inning: 2, halfInning: "top", batter: 1, pitcher: 2 }),
      play({ atBatIndex: 0, inning: 1, halfInning: "top", batter: 1, pitcher: 2 }),
      play({ atBatIndex: 3, inning: 1, halfInning: "bottom", batter: 1, pitcher: 2 }),
    ]);
    const rows = buildPlayRows(feed, 1);
    expect(rows.map((r) => r.atBatIndex)).toEqual([0, 3, 5]);
  });
});
