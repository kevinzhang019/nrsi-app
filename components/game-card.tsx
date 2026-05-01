"use client";

import { useMemo } from "react";
import type { GameState } from "@/lib/state/game-state";
import { cn } from "@/lib/utils";
import { ProbabilityPill } from "@/components/probability-pill";
import { InningState } from "@/components/inning-state";
import { LineScore } from "@/components/line-score";
import { LineupColumn } from "@/components/lineup-column";
import { ParkSection } from "@/components/park-section";

function teamShort(name: string): string {
  const parts = name.split(" ");
  if (parts.length === 1) return name.slice(0, 3).toUpperCase();
  const last = parts[parts.length - 1];
  if (["Sox", "Jays", "Rays"].includes(last)) return parts.slice(-2).join(" ");
  return last;
}

export function GameCard({ game }: { game: GameState }) {
  const decision = game.isDecisionMoment;

  // Map upcoming-batter pReach values onto their player ids so the lineup
  // rows can show probabilities inline for batters in the upcoming sequence.
  const pReachById = useMemo(() => {
    const m = new Map<number, number>();
    for (const b of game.upcomingBatters) m.set(b.id, b.pReach);
    return m;
  }, [game.upcomingBatters]);

  // Per the user spec: highlight current batter for the team currently batting,
  // and next-half leadoff for the team coming up. The watcher resolved which
  // team is which via extractBatterFocus.
  const awayHighlightId =
    game.battingTeam === "away"
      ? game.currentBatterId
      : game.battingTeam === "home"
      ? game.nextHalfLeadoffId
      : null;
  const homeHighlightId =
    game.battingTeam === "home"
      ? game.currentBatterId
      : game.battingTeam === "away"
      ? game.nextHalfLeadoffId
      : null;

  const awayMarker: "current" | "next" | null =
    game.battingTeam === "away" ? "current" : game.battingTeam === "home" ? "next" : null;
  const homeMarker: "current" | "next" | null =
    game.battingTeam === "home" ? "current" : game.battingTeam === "away" ? "next" : null;

  return (
    <article
      data-fresh={decision ? "true" : "false"}
      className={cn(
        "group relative overflow-hidden rounded-lg border bg-[var(--color-card)] transition",
        "border-[var(--color-border)]",
        decision && "ring-2 ring-[var(--color-accent)]/60 border-[var(--color-accent)]/40",
      )}
    >
      <header className="flex items-start justify-between border-b border-[var(--color-border)] px-4 py-3">
        <div className="space-y-1">
          <div className="flex items-baseline gap-3">
            <span className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted)]">
              {teamShort(game.away.name)}
            </span>
            <span className="font-mono text-2xl tabular-nums">{game.away.runs}</span>
          </div>
          <div className="flex items-baseline gap-3">
            <span className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted)]">
              {teamShort(game.home.name)}
            </span>
            <span className="font-mono text-2xl tabular-nums">{game.home.runs}</span>
          </div>
        </div>
        <InningState
          status={game.status}
          inning={game.inning}
          half={game.half}
          outs={game.outs}
          detailed={game.detailedState}
        />
      </header>

      {game.linescore && (
        <section className="border-b border-[var(--color-border)] bg-[var(--color-subtle)]/30 px-4 py-2.5">
          <LineScore
            linescore={game.linescore}
            awayName={game.away.name}
            homeName={game.home.name}
            currentInning={game.inning}
            half={game.half}
          />
        </section>
      )}

      <section className="space-y-3 px-4 py-4">
        {game.pitcher && (
          <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted)]">
            <span>
              On the bump ·{" "}
              <span className="text-[var(--color-fg)]">
                {game.pitcher.name} <span className="text-[var(--color-muted)]">({game.pitcher.throws}HP)</span>
              </span>
            </span>
            {game.battingTeam && (
              <span className="text-[10px]">
                <span className="text-[var(--color-accent)]">●</span> at bat ·{" "}
                <span className="text-[var(--color-good)]">●</span> next ½
              </span>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <LineupColumn
            label={teamShort(game.away.name)}
            lineup={game.lineups?.away ?? null}
            highlightId={awayHighlightId}
            highlightKind={awayMarker}
            pReachById={pReachById}
          />
          <LineupColumn
            label={teamShort(game.home.name)}
            lineup={game.lineups?.home ?? null}
            highlightId={homeHighlightId}
            highlightKind={homeMarker}
            pReachById={pReachById}
          />
        </div>

        <ParkSection
          venueId={game.venue?.id ?? null}
          venueName={game.venue?.name ?? null}
          highlighted={decision}
          parkRunFactor={game.env?.parkRunFactor ?? null}
          weatherRunFactor={game.env?.weatherRunFactor ?? null}
          weather={(game.env?.weather as Record<string, unknown> | undefined) ?? null}
        />
      </section>

      <footer className="border-t border-[var(--color-border)] bg-[var(--color-subtle)]/40 px-4 py-3">
        <ProbabilityPill
          pNoHitEvent={game.pNoHitEvent}
          breakEvenAmerican={game.breakEvenAmerican}
        />
      </footer>
    </article>
  );
}
