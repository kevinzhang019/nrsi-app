"use client";

import { cn } from "@/lib/utils";

export type InningHalfKey = `${number}-${"Top" | "Bottom"}`;

export type InningHalfRow = {
  inning: number;
  topAvailable: boolean;
  bottomAvailable: boolean;
};

// 9 inning columns. Each column has a Top half + Bottom half cell. The
// selected cell is highlighted with the accent color; unavailable halves
// (e.g. unplayed bottom-9 walkoff) render disabled. Mirrors the
// <Segmented> visual language used by SettingsButton.
export function InningTabSelector({
  rows,
  selected,
  onSelect,
}: {
  rows: InningHalfRow[];
  selected: InningHalfKey;
  onSelect: (key: InningHalfKey) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted)]">
        Inning
      </div>
      <div className="grid grid-cols-9 gap-1 rounded border border-[var(--color-border)] bg-[var(--color-subtle)]/60 p-1">
        {rows.map((row) => (
          <div key={row.inning} className="space-y-1">
            <div className="text-center text-[10px] font-mono tabular-nums text-[var(--color-muted)]/70">
              {row.inning}
            </div>
            <HalfCell
              available={row.topAvailable}
              selected={selected === `${row.inning}-Top`}
              label="T"
              onClick={() => onSelect(`${row.inning}-Top`)}
            />
            <HalfCell
              available={row.bottomAvailable}
              selected={selected === `${row.inning}-Bottom`}
              label="B"
              onClick={() => onSelect(`${row.inning}-Bottom`)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function HalfCell({
  available,
  selected,
  label,
  onClick,
}: {
  available: boolean;
  selected: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={!available}
      onClick={onClick}
      className={cn(
        "h-7 w-full rounded text-[11px] font-mono transition-colors",
        selected
          ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)] font-medium"
          : available
          ? "text-[var(--color-muted)] hover:text-[var(--color-fg)]"
          : "text-[var(--color-muted)]/30 cursor-not-allowed",
      )}
    >
      {label}
    </button>
  );
}
