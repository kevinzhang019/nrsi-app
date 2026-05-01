"use client";

import Link from "next/link";
import { GameCard } from "@/components/game-card";
import type { GameState } from "@/lib/state/game-state";

// Wraps the live <GameCard> for use on /history. Disables pointer events on
// the inner card so the lineup-pane selector buttons don't intercept clicks
// — the whole card navigates to the detail view instead.
export function HistoricalCardLink({ game }: { game: GameState }) {
  return (
    <Link
      href={`/history/${game.gamePk}`}
      className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 rounded-lg"
    >
      <div className="pointer-events-none">
        <GameCard game={game} />
      </div>
    </Link>
  );
}
