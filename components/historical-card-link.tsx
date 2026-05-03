"use client";

import Link from "next/link";
import { GameCard } from "@/components/game-card";
import { SuppressPlayerLinks } from "@/components/lineup-column";
import type { GameState } from "@/lib/state/game-state";

// Wraps the live <GameCard> for use on /history. Disables pointer events on
// the inner card so the lineup-pane selector buttons don't intercept clicks
// — the whole card navigates to the detail view instead. Also suppresses
// nested player <a> tags inside the card to avoid <a> within <a> hydration
// errors.
export function HistoricalCardLink({ game }: { game: GameState }) {
  return (
    <Link
      href={`/history/${game.gamePk}`}
      className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 rounded-lg"
    >
      <div className="pointer-events-none">
        <SuppressPlayerLinks>
          <GameCard game={game} historical />
        </SuppressPlayerLinks>
      </div>
    </Link>
  );
}
