"use client";

import { useMemo } from "react";
import type { GameState } from "@/lib/state/game-state";
import { LineupColumn, type BatterStats } from "@/components/lineup-column";
import { cn } from "@/lib/utils";

type Side = "away" | "home";

function teamShort(name: string): string {
  const parts = name.split(" ");
  if (parts.length === 1) return name;
  const last = parts[parts.length - 1];
  if (["Sox", "Jays"].includes(last)) return parts.slice(-2).join(" ");
  return last;
}

export function LineupSinglePane({
  game,
  upcomingStatsById,
  awayHighlightId,
  awayHighlightKind,
  homeHighlightId,
  homeHighlightKind,
  selectedSide,
  onSelectSide,
}: {
  game: GameState;
  // Stats for the upcoming half-inning (already on the published state). Used
  // as a fallback when full-lineup stats haven't been computed yet, so the
  // upcoming batters at least show numbers in early ticks.
  upcomingStatsById: Map<number, BatterStats>;
  awayHighlightId: number | null;
  awayHighlightKind: "current" | "next" | null;
  homeHighlightId: number | null;
  homeHighlightKind: "current" | "next" | null;
  // Lifted to GameCard so the pitcher rendered above the pane can react to the
  // same selection (single-mode shows the OPPOSING pitcher to selectedSide).
  selectedSide: Side;
  onSelectSide: (side: Side) => void;
}) {
  const statsById = useMemo(() => {
    const m = new Map<number, BatterStats>();
    const fromState = game.lineupStats?.[selectedSide];
    if (fromState) {
      for (const [id, s] of Object.entries(fromState)) {
        const n = Number(id);
        if (Number.isFinite(n)) m.set(n, s);
      }
    }
    // Merge the upcoming-batter stats on top so any in-play subs (not in the
    // starter set) still show numbers when they're due up.
    if (selectedSide === game.battingTeam) {
      for (const [id, s] of upcomingStatsById) {
        if (!m.has(id)) m.set(id, s);
      }
    }
    return m;
  }, [game.lineupStats, selectedSide, game.battingTeam, upcomingStatsById]);

  const lineup = game.lineups?.[selectedSide] ?? null;
  const highlightId =
    selectedSide === "away" ? awayHighlightId : homeHighlightId;
  const highlightKind =
    selectedSide === "away" ? awayHighlightKind : homeHighlightKind;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-center gap-6 text-[12px] uppercase tracking-[0.18em]">
        {(["away", "home"] as Side[]).map((side) => {
          const name =
            side === "away" ? game.away.name : game.home.name;
          const isSelected = side === selectedSide;
          return (
            <button
              key={side}
              type="button"
              onClick={() => onSelectSide(side)}
              className={cn(
                "transition-colors",
                isSelected
                  ? "text-[var(--color-fg)] font-medium"
                  : "text-[var(--color-muted)] hover:text-[var(--color-fg)]/85",
              )}
            >
              {teamShort(name)}
            </button>
          );
        })}
      </div>
      <LineupColumn
        label=""
        lineup={lineup}
        highlightId={highlightId}
        highlightKind={highlightKind}
        statsById={statsById}
      />
    </div>
  );
}
