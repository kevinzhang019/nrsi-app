"use client";

import type { Linescore } from "@/lib/mlb/extract";
import { cn } from "@/lib/utils";

function teamShort(name: string): string {
  const parts = name.split(" ");
  if (parts.length === 1) return name.slice(0, 3).toUpperCase();
  const last = parts[parts.length - 1];
  if (["Sox", "Jays", "Rays"].includes(last)) return parts.slice(-2).join(" ");
  return last;
}

export function LineScore({
  linescore,
  awayName,
  homeName,
  currentInning,
  half,
}: {
  linescore: Linescore;
  awayName: string;
  homeName: string;
  currentInning: number | null;
  half: "Top" | "Bottom" | null;
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

  function cellRuns(v: number | null, isCurrent: boolean) {
    if (v === null) {
      return <span className="text-[var(--color-muted)]/50">{isCurrent ? "·" : ""}</span>;
    }
    return <span className="text-[var(--color-fg)]">{v}</span>;
  }

  const renderRow = (
    side: "away" | "home",
    teamLabel: string,
    totals: { R: number; H: number; E: number },
  ) => {
    const isThisHalf = (n: number) => {
      if (currentInning !== n) return false;
      if (half === "Top") return side === "away";
      if (half === "Bottom") return side === "home";
      return false;
    };
    return (
      <tr>
        <td className="pr-2 text-left text-[10px] uppercase tracking-[0.16em] text-[var(--color-muted)]">
          {teamLabel}
        </td>
        {innings.map((inn) => {
          const cur = isThisHalf(inn.num);
          return (
            <td
              key={inn.num}
              className={cn(
                "px-1 text-center font-mono tabular-nums text-[11px] leading-none",
                cur && "text-[var(--color-accent)]",
              )}
            >
              {cellRuns(inn[side].runs, cur)}
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
            {innings.map((inn) => (
              <th
                key={inn.num}
                className="px-1 text-center font-mono text-[9px] uppercase tracking-wider text-[var(--color-muted)]/70"
              >
                {inn.num}
              </th>
            ))}
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
