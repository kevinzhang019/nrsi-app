"use client";

import type { TeamLineup } from "@/lib/mlb/extract";
import { cn } from "@/lib/utils";

type Marker = "current" | "next" | null;

export type BatterStats = { pReach: number; xSlg: number };

function formatBatterDisplayName(name: string): string {
  const trimmed = name.trim();
  const space = trimmed.indexOf(" ");
  if (space <= 0) return trimmed;
  return `${trimmed[0]}. ${trimmed.slice(space + 1)}`;
}

function formatBaseballRate(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const clamped = Math.max(0, Math.min(n, 9.999));
  const fixed = clamped.toFixed(3);
  return fixed.startsWith("0") ? fixed.slice(1) : fixed;
}

const mlbPlayerUrl = (id: number) => `https://www.mlb.com/player/${id}`;

export function LineupColumn({
  label,
  lineup,
  highlightId,
  highlightKind,
  statsById,
  align = "left",
}: {
  label: string;
  lineup: TeamLineup | null;
  highlightId: number | null;
  highlightKind: Marker;
  statsById?: Map<number, BatterStats>;
  align?: "left" | "right";
}) {
  const headerAlign = align === "right" ? "text-right" : "text-left";
  const isCurrentColumn = highlightKind === "current";
  const isNextColumn = highlightKind === "next";

  const renderStats = (id: number) => {
    const s = statsById?.get(id);
    return (
      <>
        <span className="ml-auto w-10 shrink-0 text-right font-mono tabular-nums text-[10px] text-[var(--color-fg)]/85">
          {s ? formatBaseballRate(s.pReach) : "—"}
        </span>
        <span className="w-10 shrink-0 text-right font-mono tabular-nums text-[10px] text-[var(--color-fg)]/85">
          {s ? formatBaseballRate(s.xSlg) : "—"}
        </span>
      </>
    );
  };

  return (
    <div className="space-y-1">
      {label !== "" && (
        <div
          className={cn(
            "text-[10px] uppercase tracking-[0.18em] text-[var(--color-muted)]",
            headerAlign,
          )}
        >
          <span>{label}</span>
        </div>
      )}
      {lineup === null || lineup.length === 0 ? (
        <div className="rounded border border-dashed border-[var(--color-border)] px-2 py-3 text-center text-[10px] uppercase tracking-wider text-[var(--color-muted)]">
          Lineup pending
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-[var(--color-border)]/60 bg-[var(--color-subtle)]/30">
         <div className="min-w-max">
          <div className="flex items-center gap-2 whitespace-nowrap border-b border-[var(--color-border)]/40 px-1.5 py-1 text-[10px] tracking-[0.18em] text-[var(--color-muted)]">
            <span className="w-4" aria-hidden />
            <span className="mr-auto">Batter</span>
            <span className="w-10 shrink-0 text-right">xOBP</span>
            <span className="w-10 shrink-0 text-right">xSLG</span>
          </div>
          <ol className="divide-y divide-[var(--color-border)]/40">
            {lineup.map((slot) => {
              const starterIsCurrent = isCurrentColumn && slot.starter.id === highlightId;
              const starterIsNext = isNextColumn && slot.starter.id === highlightId;
              const starterIsAccent = starterIsCurrent || starterIsNext;
              return (
                <li key={slot.spot}>
                  <div
                    className={cn(
                      "flex items-center gap-2 whitespace-nowrap px-1.5 py-1",
                      starterIsCurrent && "rounded bg-[var(--color-accent-soft)]/60",
                    )}
                  >
                    <span className="w-4 font-mono text-[10px] uppercase tabular-nums text-[var(--color-muted)]">
                      {slot.starter.bats ?? "—"}
                    </span>
                    <a
                      href={mlbPlayerUrl(slot.starter.id)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={cn(
                        "text-[12px] hover:underline underline-offset-2",
                        starterIsAccent
                          ? "text-[var(--color-accent)] font-medium"
                          : "text-[var(--color-fg)]/90",
                      )}
                      title={slot.starter.name}
                    >
                      {formatBatterDisplayName(slot.starter.name)}
                    </a>
                    {renderStats(slot.starter.id)}
                  </div>
                  {slot.subs.map((sub) => {
                    const subIsCurrent = isCurrentColumn && sub.id === highlightId;
                    const subIsNext = isNextColumn && sub.id === highlightId;
                    const subIsAccent = subIsCurrent || subIsNext;
                    return (
                      <div
                        key={sub.id}
                        className={cn(
                          "flex items-center gap-2 whitespace-nowrap py-0.5 pl-[1.375rem] pr-1.5",
                          subIsCurrent && "rounded bg-[var(--color-accent-soft)]/60",
                        )}
                      >
                        <span className="w-4 font-mono text-[10px] uppercase tabular-nums text-[var(--color-muted)]/70">
                          {sub.bats ?? "—"}
                        </span>
                        <a
                          href={mlbPlayerUrl(sub.id)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={cn(
                            "text-[11px] hover:underline underline-offset-2",
                            subIsAccent
                              ? "text-[var(--color-accent)] font-medium"
                              : "text-[var(--color-fg)]/90",
                          )}
                          title={sub.name}
                        >
                          <span className="mr-1 text-[var(--color-muted)]/60">↳</span>
                          {formatBatterDisplayName(sub.name)}
                        </a>
                        {renderStats(sub.id)}
                      </div>
                    );
                  })}
                </li>
              );
            })}
          </ol>
         </div>
        </div>
      )}
    </div>
  );
}
