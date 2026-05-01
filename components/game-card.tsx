"use client";

import type { GameState } from "@/lib/state/game-state";
import { cn } from "@/lib/utils";
import { ProbabilityPill } from "@/components/probability-pill";
import { InningState } from "@/components/inning-state";
import { ParkOutline } from "@/components/park-outline";

function teamShort(name: string): string {
  const parts = name.split(" ");
  if (parts.length === 1) return name.slice(0, 3).toUpperCase();
  const last = parts[parts.length - 1];
  if (["Sox", "Jays", "Rays"].includes(last)) return parts.slice(-2).join(" ");
  return last;
}

function envChip(label: string, value: number | null) {
  if (value === null || !Number.isFinite(value)) return null;
  const arrow = value > 1.02 ? "↑" : value < 0.98 ? "↓" : "→";
  const tone =
    value > 1.02 ? "text-[var(--color-good)]" : value < 0.98 ? "text-[var(--color-bad)]" : "text-[var(--color-muted)]";
  return (
    <span className={cn("text-[10px] uppercase tracking-wider", tone)}>
      {label} {value.toFixed(2)} {arrow}
    </span>
  );
}

function ParkFactor({ value }: { value: number | null }) {
  if (value === null || !Number.isFinite(value)) {
    return (
      <span className="text-[10px] uppercase tracking-wider text-[var(--color-muted)]">—</span>
    );
  }
  const arrow = value > 1.02 ? "↑" : value < 0.98 ? "↓" : "→";
  const tone =
    value > 1.02
      ? "text-[var(--color-good)]"
      : value < 0.98
      ? "text-[var(--color-bad)]"
      : "text-[var(--color-muted)]";
  return (
    <span className={cn("font-mono tabular-nums text-[10px] uppercase tracking-wider", tone)}>
      {value.toFixed(2)} {arrow}
    </span>
  );
}

export function GameCard({ game }: { game: GameState }) {
  const decision = game.isDecisionMoment;

  return (
    <article
      data-fresh={decision ? "true" : "false"}
      className={cn(
        "group relative overflow-hidden rounded-md border bg-[var(--color-card)] transition",
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

      <section className="space-y-3 px-4 py-4">
        {game.pitcher && (
          <div className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted)]">
            Next half ·{" "}
            <span className="text-[var(--color-fg)]">
              vs {game.pitcher.throws}HP
            </span>
          </div>
        )}

        {game.upcomingBatters.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {game.upcomingBatters.slice(0, 6).map((b) => (
              <span
                key={b.id}
                className="inline-flex items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-subtle)] px-2 py-0.5 text-[11px]"
                title={`${b.name} (${b.bats}HB)`}
              >
                <span className="font-mono tabular-nums text-[var(--color-fg)]">
                  {(b.pReach * 100).toFixed(0)}%
                </span>
                <span className="text-[var(--color-muted)]">{lastName(b.name)}</span>
              </span>
            ))}
          </div>
        )}

        {(game.venue?.id || game.env || game.pNoHitEvent !== null) && (
          <div className="flex items-center gap-3 pt-1">
            <span className="inline-flex items-center gap-1.5">
              <ParkOutline
                venueId={game.venue?.id ?? null}
                highlighted={game.isDecisionMoment}
                size={28}
              />
              <ParkFactor value={game.env?.parkRunFactor ?? null} />
            </span>
            {envChip("Wx", game.env?.weatherRunFactor ?? null)}
          </div>
        )}
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

function lastName(name: string): string {
  const parts = name.split(" ");
  return parts[parts.length - 1] || name;
}
