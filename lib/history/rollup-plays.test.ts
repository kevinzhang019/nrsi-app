import { describe, expect, it } from "vitest";
import { rollupBatters, rollupPitchers, formatIp } from "./rollup-plays";
import type { PlayRow } from "@/lib/types/history";

let nextIdx = 0;
function row(over: Partial<PlayRow> & { batterId: number; pitcherId: number; eventType: string }): PlayRow {
  return {
    gamePk: 1,
    atBatIndex: nextIdx++,
    inning: 1,
    half: "Top",
    batterId: over.batterId,
    batterName: `B${over.batterId}`,
    batterSide: "R",
    pitcherId: over.pitcherId,
    pitcherName: `P${over.pitcherId}`,
    pitcherHand: "R",
    event: over.eventType,
    eventType: over.eventType,
    rbi: 0,
    runsOnPlay: 0,
    endOuts: 0,
    awayScore: 0,
    homeScore: 0,
    raw: {},
    ...over,
  };
}

describe("rollupBatters", () => {
  it("counts PA, AB, H, HR, BB, HBP, K, RBI correctly", () => {
    nextIdx = 0;
    const rows: PlayRow[] = [
      row({ batterId: 1, pitcherId: 2, eventType: "single", rbi: 1 }),
      row({ batterId: 1, pitcherId: 2, eventType: "walk" }),
      row({ batterId: 1, pitcherId: 2, eventType: "strikeout" }),
      row({ batterId: 1, pitcherId: 2, eventType: "home_run", rbi: 2 }),
      row({ batterId: 1, pitcherId: 2, eventType: "hit_by_pitch" }),
      row({ batterId: 1, pitcherId: 2, eventType: "sac_fly", rbi: 1 }),
    ];
    const [b] = rollupBatters(rows);
    expect(b).toMatchObject({
      pa: 6,
      ab: 3, // single, K, HR — exclude BB, HBP, sac_fly
      h: 2, // single + HR
      hr: 1,
      bb: 1,
      hbp: 1,
      k: 1,
      rbi: 4,
      r: 1, // HR scores the batter
    });
  });

  it("returns one line per unique batter", () => {
    nextIdx = 0;
    const rows: PlayRow[] = [
      row({ batterId: 1, pitcherId: 2, eventType: "single" }),
      row({ batterId: 2, pitcherId: 2, eventType: "field_out" }),
      row({ batterId: 1, pitcherId: 2, eventType: "double" }),
    ];
    const lines = rollupBatters(rows);
    expect(lines).toHaveLength(2);
    const b1 = lines.find((l) => l.playerId === 1)!;
    expect(b1.pa).toBe(2);
    expect(b1.h).toBe(2);
  });
});

describe("rollupPitchers", () => {
  it("attributes BF, K, BB, H, HR, R correctly", () => {
    nextIdx = 0;
    const rows: PlayRow[] = [
      row({ batterId: 10, pitcherId: 99, eventType: "single", runsOnPlay: 1, endOuts: 0 }),
      row({ batterId: 11, pitcherId: 99, eventType: "strikeout", endOuts: 1 }),
      row({ batterId: 12, pitcherId: 99, eventType: "walk", endOuts: 1 }),
      row({ batterId: 13, pitcherId: 99, eventType: "home_run", runsOnPlay: 2, endOuts: 1 }),
      row({ batterId: 14, pitcherId: 99, eventType: "field_out", endOuts: 2 }),
      row({ batterId: 15, pitcherId: 99, eventType: "field_out", endOuts: 3 }),
    ];
    const [p] = rollupPitchers(rows);
    expect(p).toMatchObject({
      bf: 6,
      h: 2,
      hr: 1,
      bb: 1,
      k: 1,
      r: 3,
      ipOuts: 3,
    });
  });

  it("computes ipOuts as monotonic delta within an inning, resetting per (inning, half)", () => {
    nextIdx = 0;
    const rows: PlayRow[] = [
      row({ batterId: 1, pitcherId: 99, eventType: "field_out", endOuts: 1, inning: 1, half: "Top" }),
      row({ batterId: 2, pitcherId: 99, eventType: "field_out", endOuts: 2, inning: 1, half: "Top" }),
      row({ batterId: 3, pitcherId: 99, eventType: "field_out", endOuts: 3, inning: 1, half: "Top" }),
      // New half — outs reset.
      row({ batterId: 4, pitcherId: 99, eventType: "field_out", endOuts: 1, inning: 1, half: "Bottom" }),
    ];
    const [p] = rollupPitchers(rows);
    expect(p.ipOuts).toBe(4);
  });

  it("attributes outs to the pitcher who threw the play (mid-inning change)", () => {
    nextIdx = 0;
    const rows: PlayRow[] = [
      row({ batterId: 1, pitcherId: 50, eventType: "field_out", endOuts: 1 }),
      row({ batterId: 2, pitcherId: 50, eventType: "single", endOuts: 1 }),
      // Pitching change: pitcher 51 enters at 1 out, gets 2 K's.
      row({ batterId: 3, pitcherId: 51, eventType: "strikeout", endOuts: 2 }),
      row({ batterId: 4, pitcherId: 51, eventType: "strikeout", endOuts: 3 }),
    ];
    const lines = rollupPitchers(rows);
    const p50 = lines.find((l) => l.playerId === 50)!;
    const p51 = lines.find((l) => l.playerId === 51)!;
    expect(p50.ipOuts).toBe(1);
    expect(p51.ipOuts).toBe(2);
  });
});

describe("formatIp", () => {
  it("formats outs as IP with .0/.1/.2 fractions", () => {
    expect(formatIp(0)).toBe("0.0");
    expect(formatIp(1)).toBe("0.1");
    expect(formatIp(3)).toBe("1.0");
    expect(formatIp(7)).toBe("2.1");
    expect(formatIp(27)).toBe("9.0");
  });
});
