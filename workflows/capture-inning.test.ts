import { describe, expect, it } from "vitest";
import { buildInningCapture } from "./capture-inning";
import type { NrXiResult } from "./steps/compute-nrXi";

const cleanNrXi: NrXiResult = {
  pHitEvent: 0.35,
  pNoHitEvent: 0.65,
  breakEvenAmerican: -185,
  startState: { outs: 0, bases: 0 },
  perBatter: [],
};

const dirtyNrXi: NrXiResult = {
  ...cleanNrXi,
  startState: { outs: 1, bases: 1 },
};

const baseArgs = {
  pitcher: null,
  awayPitcher: null,
  homePitcher: null,
  env: null,
  lineupStats: null,
  defenseKey: "k",
};

describe("buildInningCapture", () => {
  it("captures when start state is clean (0 outs, 0 bases)", () => {
    const out = buildInningCapture({ inning: 3, half: "Top", nrXi: cleanNrXi, ...baseArgs });
    expect(out).not.toBeNull();
    expect(out!.key).toBe("3-Top");
    expect(out!.capture.inning).toBe(3);
    expect(out!.capture.half).toBe("Top");
    expect(out!.capture.pNoRun).toBe(0.65);
  });

  it("returns null when start state has runners on", () => {
    const out = buildInningCapture({ inning: 3, half: "Top", nrXi: dirtyNrXi, ...baseArgs });
    expect(out).toBeNull();
  });

  it("returns null when nrXi is missing", () => {
    const out = buildInningCapture({ inning: 1, half: "Top", nrXi: null, ...baseArgs });
    expect(out).toBeNull();
  });

  it("returns null when inning or half is unknown", () => {
    expect(
      buildInningCapture({ inning: null, half: "Top", nrXi: cleanNrXi, ...baseArgs }),
    ).toBeNull();
    expect(
      buildInningCapture({ inning: 5, half: null, nrXi: cleanNrXi, ...baseArgs }),
    ).toBeNull();
  });

  it("returns null for innings outside 1-9", () => {
    expect(
      buildInningCapture({ inning: 0, half: "Top", nrXi: cleanNrXi, ...baseArgs }),
    ).toBeNull();
    expect(
      buildInningCapture({ inning: 10, half: "Bottom", nrXi: cleanNrXi, ...baseArgs }),
    ).toBeNull();
  });

  it("nests both teams' pitchers under the active label", () => {
    const out = buildInningCapture({
      inning: 4,
      half: "Bottom",
      nrXi: cleanNrXi,
      pitcher: { id: 100, name: "A", throws: "R", era: null, whip: null, pitchCount: null },
      awayPitcher: { id: 200, name: "Away", throws: "L", era: null, whip: null, pitchCount: null },
      homePitcher: { id: 100, name: "A", throws: "R", era: null, whip: null, pitchCount: null },
      env: null,
      lineupStats: null,
      defenseKey: "k",
    });
    expect(out!.capture.pitcher.active?.id).toBe(100);
    expect(out!.capture.pitcher.away?.id).toBe(200);
    expect(out!.capture.pitcher.home?.id).toBe(100);
  });
});
