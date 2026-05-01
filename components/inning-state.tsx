"use client";

import type { GameStatus } from "@/lib/mlb/types";
import { BasesDiamond } from "@/components/bases-diamond";

export function InningState({
  status,
  inning,
  half,
  outs,
  bases,
  detailed,
}: {
  status: GameStatus;
  inning: number | null;
  half: "Top" | "Bottom" | null;
  outs: number | null;
  bases: number | null;
  detailed?: string;
}) {
  if (status === "Pre") {
    return (
      <div className="text-right">
        <div className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted)]">
          {detailed || "Pre-game"}
        </div>
      </div>
    );
  }
  if (status === "Final") {
    return (
      <div className="text-right">
        <div className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted)]">Final</div>
      </div>
    );
  }
  if (status === "Delayed" || status === "Suspended") {
    return (
      <div className="text-right">
        <div className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-bad)]">{detailed || status}</div>
      </div>
    );
  }

  return (
    <div className="text-right">
      <div className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted)]">
        {half === "Top" ? "▲" : "▼"} {inning ?? "–"}
      </div>
      <div className="mt-1.5 flex justify-end gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={`inline-block size-1.5 rounded-full ${
              (outs ?? 0) > i ? "bg-[var(--color-fg)]" : "bg-[var(--color-border)]"
            }`}
          />
        ))}
      </div>
      <div className="mt-1.5 flex justify-end">
        <BasesDiamond bases={bases} />
      </div>
    </div>
  );
}
