import type { PlayRow } from "@/lib/types/history";

export type BatterLine = {
  playerId: number;
  name: string;
  pa: number;
  ab: number;
  h: number;
  hr: number;
  bb: number;
  hbp: number;
  k: number;
  r: number;
  rbi: number;
};

export type PitcherLine = {
  playerId: number;
  name: string;
  bf: number;
  ipOuts: number;
  h: number;
  bb: number;
  hbp: number;
  k: number;
  hr: number;
  r: number;
};

// Event-type sets. MLB Stats API uses snake_case eventTypes.
const HIT_TYPES = new Set(["single", "double", "triple", "home_run"]);
const HR_TYPES = new Set(["home_run"]);
const BB_TYPES = new Set(["walk", "intent_walk"]);
const HBP_TYPES = new Set(["hit_by_pitch"]);
const K_TYPES = new Set(["strikeout", "strikeout_double_play"]);
// PA-but-not-AB events: sac flies, sac bunts, walks, HBP, catcher interference.
const NON_AB_TYPES = new Set([
  "walk",
  "intent_walk",
  "hit_by_pitch",
  "sac_fly",
  "sac_fly_double_play",
  "sac_bunt",
  "sac_bunt_double_play",
  "catcher_interf",
  "batter_interference",
]);

function emptyBatter(playerId: number, name: string): BatterLine {
  return { playerId, name, pa: 0, ab: 0, h: 0, hr: 0, bb: 0, hbp: 0, k: 0, r: 0, rbi: 0 };
}

function emptyPitcher(playerId: number, name: string): PitcherLine {
  return { playerId, name, bf: 0, ipOuts: 0, h: 0, bb: 0, hbp: 0, k: 0, hr: 0, r: 0 };
}

// Roll up batter stat lines from an arbitrary slice of PlayRow. Caller
// pre-filters to whatever scope it wants (single inning, single half, full
// game). One row per unique batterId; ordered by first appearance.
export function rollupBatters(rows: PlayRow[]): BatterLine[] {
  const map = new Map<number, BatterLine>();
  for (const r of rows) {
    let b = map.get(r.batterId);
    if (!b) {
      b = emptyBatter(r.batterId, r.batterName);
      map.set(r.batterId, b);
    }
    const et = r.eventType ?? "";
    b.pa++;
    if (!NON_AB_TYPES.has(et)) b.ab++;
    if (HIT_TYPES.has(et)) b.h++;
    if (HR_TYPES.has(et)) b.hr++;
    if (BB_TYPES.has(et)) b.bb++;
    if (HBP_TYPES.has(et)) b.hbp++;
    if (K_TYPES.has(et)) b.k++;
    b.rbi += r.rbi;
  }
  // Runs scored: a play's `runners[]` is captured into runs_on_play; but the
  // batter who *scored* (vs drove in) isn't directly known per row without
  // walking runners. Approximation: HR scores the batter; otherwise leave R
  // on the batter at 0 — pitcher R is the load-bearing display anyway.
  for (const r of rows) {
    if (HR_TYPES.has(r.eventType ?? "")) {
      const b = map.get(r.batterId);
      if (b) b.r++;
    }
  }
  return Array.from(map.values());
}

// Roll up pitcher stat lines. ipOuts is computed by walking the slice in
// at_bat_index order and tracking the running outs total per (inning, half) —
// each play's contribution is `max(0, endOuts - prevOuts)` attributed to the
// pitcher who threw it.
export function rollupPitchers(rows: PlayRow[]): PitcherLine[] {
  const map = new Map<number, PitcherLine>();
  const sorted = [...rows].sort((a, b) => a.atBatIndex - b.atBatIndex);

  let curKey: string | null = null;
  let prevOuts = 0;

  for (const r of sorted) {
    let p = map.get(r.pitcherId);
    if (!p) {
      p = emptyPitcher(r.pitcherId, r.pitcherName);
      map.set(r.pitcherId, p);
    }
    const et = r.eventType ?? "";
    p.bf++;
    if (HIT_TYPES.has(et)) p.h++;
    if (HR_TYPES.has(et)) p.hr++;
    if (BB_TYPES.has(et)) p.bb++;
    if (HBP_TYPES.has(et)) p.hbp++;
    if (K_TYPES.has(et)) p.k++;
    p.r += r.runsOnPlay;

    const key = `${r.inning}-${r.half}`;
    if (key !== curKey) {
      curKey = key;
      prevOuts = 0;
    }
    if (typeof r.endOuts === "number") {
      const inc = Math.max(0, r.endOuts - prevOuts);
      p.ipOuts += inc;
      prevOuts = r.endOuts;
    }
  }
  return Array.from(map.values());
}

// Convenience formatter: 7 outs → "2.1" (2 full innings + 1 out).
export function formatIp(outs: number): string {
  const full = Math.floor(outs / 3);
  const rem = outs % 3;
  return `${full}.${rem}`;
}
