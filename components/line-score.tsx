"use client";

import type { Linescore } from "@/lib/mlb/extract";
import { cn } from "@/lib/utils";
import type { InningSelection, InningAvailability } from "@/components/historical-game-view-helpers";

function teamShort(name: string): string {
  const parts = name.split(" ");
  if (parts.length === 1) return name;
  const last = parts[parts.length - 1];
  if (["Sox", "Jays"].includes(last)) return parts.slice(-2).join(" ");
  return last;
}

export function LineScore({
  linescore,
  awayName,
  homeName,
  currentInning,
  half,
  selection,
  availability,
  onSelectInning,
  onSelectHalf,
}: {
  linescore: Linescore;
  awayName: string;
  homeName: string;
  currentInning: number | null;
  half: "Top" | "Bottom" | null;
  selection?: InningSelection | null;
  availability?: InningAvailability;
  onSelectInning?: (n: number) => void;
  onSelectHalf?: (n: number, half: "Top" | "Bottom") => void;
}) {
  // Pad to at least 9 columns so the layout is stable from inning 1.
  const innings = linescore.innings.slice();
  const innNum = (innings[innings.length - 1]?.num ?? 0);
  for (let i = innings.length + 1; i <= Math.max(9, innNum); i++) {
    innings.push({
      num: i,
      away: { runs: null, hits: null, errors: null },
      home: { runs: null, hits: null, errors: null },
    });
  }

  function cellRuns(v: number | null, accent: boolean) {
    if (v === null) {
      return <span className="text-[var(--color-muted)]/50">{accent ? "·" : ""}</span>;
    }
    return <span className={accent ? "text-[var(--color-accent)]" : "text-[var(--color-fg)]"}>{v}</span>;
  }

  const renderRow = (
    side: "away" | "home",
    teamLabel: string,
    totals: { R: number; H: number; E: number },
  ) => {
    const sideHalf: "Top" | "Bottom" = side === "away" ? "Top" : "Bottom";
    const isLiveHalf = (n: number) => {
      if (currentInning !== n) return false;
      if (half === "Top") return side === "away";
      if (half === "Bottom") return side === "home";
      return false;
    };
    const isSelectedHalf = (n: number) =>
      selection?.kind === "half" && selection.inning === n && selection.half === sideHalf;
    const isInFullSelection = (n: number) =>
      selection?.kind === "full" && selection.inning === n;
    return (
      <tr>
        <td className="pr-2 text-left text-[10px] uppercase tracking-[0.16em] text-[var(--color-muted)]">
          {teamLabel}
        </td>
        {innings.map((inn) => {
          const accent = isLiveHalf(inn.num) || isSelectedHalf(inn.num) || isInFullSelection(inn.num);
          const halfAvailable = availability
            ? sideHalf === "Top"
              ? availability.topAvailable(inn.num)
              : availability.bottomAvailable(inn.num)
            : true;
          const cellContent = cellRuns(inn[side].runs, accent);
          if (onSelectHalf) {
            return (
              <td key={inn.num} className="px-1 text-center font-mono tabular-nums text-[11px] leading-none">
                <button
                  type="button"
                  disabled={!halfAvailable}
                  onClick={() => onSelectHalf(inn.num, sideHalf)}
                  className={cn(
                    "block w-full rounded px-1 py-0.5 transition-colors",
                    halfAvailable
                      ? "hover:bg-[var(--color-subtle)] focus-visible:bg-[var(--color-subtle)] focus-visible:outline-none"
                      : "cursor-not-allowed text-[var(--color-muted)]/30",
                    isSelectedHalf(inn.num) &&
                      "bg-[var(--color-accent-soft)] ring-1 ring-[var(--color-accent)]/40",
                  )}
                  aria-label={`${sideHalf} of inning ${inn.num}`}
                  aria-pressed={isSelectedHalf(inn.num)}
                >
                  {cellContent}
                </button>
              </td>
            );
          }
          return (
            <td
              key={inn.num}
              className={cn(
                "px-1 text-center font-mono tabular-nums text-[11px] leading-none",
              )}
            >
              {cellContent}
            </td>
          );
        })}
        <td className="border-l border-[var(--color-border)] pl-2 text-center font-mono tabular-nums text-[12px] text-[var(--color-fg)]">
          {totals.R}
        </td>
        <td className="px-1 text-center font-mono tabular-nums text-[12px] text-[var(--color-muted)]">
          {totals.H}
        </td>
        <td className="px-1 text-center font-mono tabular-nums text-[12px] text-[var(--color-muted)]">
          {totals.E}
        </td>
      </tr>
    );
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-0">
        <thead>
          <tr>
            <th className="pr-2 text-left text-[9px] uppercase tracking-[0.16em] text-[var(--color-muted)]/70" />
            {innings.map((inn) => {
              const fullAvailable = availability ? availability.fullAvailable(inn.num) : true;
              const fullSelected =
                selection?.kind === "full" && selection.inning === inn.num;
              const headerCls = cn(
                "px-1 text-center font-mono text-[9px] uppercase tracking-wider",
                fullSelected ? "text-[var(--color-accent)]" : "text-[var(--color-muted)]/70",
              );
              if (onSelectInning) {
                return (
                  <th key={inn.num} className="px-0.5 py-0.5">
                    <button
                      type="button"
                      disabled={!fullAvailable}
                      onClick={() => onSelectInning(inn.num)}
                      className={cn(
                        "w-full rounded px-1 py-0.5 transition-colors",
                        fullAvailable
                          ? "hover:bg-[var(--color-subtle)] focus-visible:bg-[var(--color-subtle)] focus-visible:outline-none"
                          : "cursor-not-allowed",
                        fullSelected &&
                          "bg-[var(--color-accent-soft)] ring-1 ring-[var(--color-accent)]/40",
                        headerCls,
                      )}
                      aria-label={`Full inning ${inn.num}`}
                      aria-pressed={fullSelected}
                    >
                      {inn.num}
                    </button>
                  </th>
                );
              }
              return (
                <th key={inn.num} className={headerCls}>
                  {inn.num}
                </th>
              );
            })}
            <th className="border-l border-[var(--color-border)] pl-2 text-center text-[9px] uppercase tracking-[0.16em] text-[var(--color-muted)]/70">
              R
            </th>
            <th className="px-1 text-center text-[9px] uppercase tracking-[0.16em] text-[var(--color-muted)]/70">
              H
            </th>
            <th className="px-1 text-center text-[9px] uppercase tracking-[0.16em] text-[var(--color-muted)]/70">
              E
            </th>
          </tr>
        </thead>
        <tbody>
          {renderRow("away", teamShort(awayName), linescore.totals.away)}
          {renderRow("home", teamShort(homeName), linescore.totals.home)}
        </tbody>
      </table>
    </div>
  );
}
