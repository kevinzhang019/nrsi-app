"use client";

import { useMemo, useState } from "react";
import { GameCard } from "@/components/game-card";
import {
  InningTabSelector,
  type InningHalfKey,
  type InningHalfRow,
} from "@/components/inning-tab-selector";
import type { GameState, PitcherInfo } from "@/lib/state/game-state";
import type { Linescore } from "@/lib/mlb/extract";
import type { HistoricalGame, HistoricalInning } from "@/lib/types/history";

// Compute (away, home) cumulative runs scored before the start of the given
// half-inning. e.g. start of inning 5 Top → sum innings 1..4 both teams.
// Start of inning 5 Bottom → sum innings 1..4 both teams + inning 5 away.
function runsBefore(
  linescore: Linescore | null,
  inning: number,
  half: "Top" | "Bottom",
): { away: number; home: number } {
  if (!linescore) return { away: 0, home: 0 };
  let away = 0;
  let home = 0;
  for (const i of linescore.innings) {
    if (i.num < inning) {
      away += i.away.runs ?? 0;
      home += i.home.runs ?? 0;
    } else if (i.num === inning && half === "Bottom") {
      away += i.away.runs ?? 0;
    }
  }
  return { away, home };
}

function actualRunsLabel(actualRuns: number | null): string {
  if (actualRuns == null) return "—";
  if (actualRuns === 0) return "0 runs";
  if (actualRuns === 1) return "1 run";
  return `${actualRuns} runs`;
}

// Build a frozen GameState representing the game AT THE START of the
// selected half-inning. The score header reflects runs-before-this-half;
// the inning/half/outs/bases reflect a clean leadoff state; the prediction
// fields come from the captured snapshot for that half.
function buildFrozenState(
  game: HistoricalGame,
  inning: HistoricalInning,
): GameState {
  const base = game.finalSnapshot!;
  const before = runsBefore(game.linescore, inning.inning, inning.half);
  const activePitcher: PitcherInfo | null = inning.pitcher?.active ?? null;
  const awayPitcher: PitcherInfo | null = inning.pitcher?.away ?? base.awayPitcher ?? null;
  const homePitcher: PitcherInfo | null = inning.pitcher?.home ?? base.homePitcher ?? null;

  return {
    ...base,
    status: "Final",
    inning: inning.inning,
    half: inning.half,
    outs: 0,
    bases: null,
    isDecisionMoment: false,
    isDecisionMomentFullInning: false,
    away: { ...base.away, runs: before.away },
    home: { ...base.home, runs: before.home },
    pitcher: activePitcher,
    awayPitcher,
    homePitcher,
    upcomingBatters: inning.perBatter,
    pHitEvent: inning.pRun,
    pNoHitEvent: inning.pNoRun,
    breakEvenAmerican: inning.breakEvenAmerican,
    // Per-full-inning derives from two halves; not stored separately. Mirror
    // the half-inning value in "Bottom"; null in "Top" (we don't have the
    // bottom prediction handy at render time without joining).
    pHitEventFullInning: inning.half === "Bottom" ? inning.pRun : null,
    pNoHitEventFullInning: inning.half === "Bottom" ? inning.pNoRun : null,
    breakEvenAmericanFullInning: inning.half === "Bottom" ? inning.breakEvenAmerican : null,
    env: inning.env,
    lineupStats: inning.lineupStats,
    battingTeam: inning.half === "Top" ? "away" : "home",
    currentBatterId: inning.perBatter[0]?.id ?? null,
    nextHalfLeadoffId: null,
  };
}

function buildRows(innings: HistoricalInning[]): InningHalfRow[] {
  const has = new Set(innings.map((i) => `${i.inning}-${i.half}`));
  return Array.from({ length: 9 }, (_, idx) => {
    const n = idx + 1;
    return {
      inning: n,
      topAvailable: has.has(`${n}-Top`),
      bottomAvailable: has.has(`${n}-Bottom`),
    };
  });
}

function defaultSelection(rows: InningHalfRow[]): InningHalfKey {
  for (const r of rows) {
    if (r.topAvailable) return `${r.inning}-Top`;
    if (r.bottomAvailable) return `${r.inning}-Bottom`;
  }
  return "1-Top";
}

export function HistoricalGameView({
  game,
  innings,
}: {
  game: HistoricalGame;
  innings: HistoricalInning[];
}) {
  const rows = useMemo(() => buildRows(innings), [innings]);
  const innByKey = useMemo(() => {
    const m = new Map<InningHalfKey, HistoricalInning>();
    for (const i of innings) m.set(`${i.inning}-${i.half}`, i);
    return m;
  }, [innings]);

  const [selected, setSelected] = useState<InningHalfKey>(() => defaultSelection(rows));
  const inning = innByKey.get(selected) ?? null;

  if (!game.finalSnapshot) {
    return (
      <p className="text-sm text-[var(--color-muted)]">
        Final snapshot not stored for this game — older record predates the history feature.
      </p>
    );
  }

  const frozen = inning ? buildFrozenState(game, inning) : (game.finalSnapshot as GameState);

  return (
    <div className="space-y-6">
      <InningTabSelector rows={rows} selected={selected} onSelect={setSelected} />

      {inning && (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-4 py-3 text-xs text-[var(--color-muted)]">
          <span className="font-mono tabular-nums text-[var(--color-fg)]">
            P(no run) = {(inning.pNoRun * 100).toFixed(1)}%
          </span>
          <span className="mx-3 text-[var(--color-border)]">|</span>
          <span>actual: {actualRunsLabel(inning.actualRuns)}</span>
        </div>
      )}

      <div className="max-w-md">
        <GameCard game={frozen} />
      </div>
    </div>
  );
}
