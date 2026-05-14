"use client";

import { useEffect, useState } from "react";
import type { GameStatus } from "@/lib/mlb/types";
import { BasesDiamond } from "@/components/bases-diamond";

function formatStartTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function InningState({
  status,
  inning,
  half,
  outs,
  bases,
  detailed,
  startTime,
}: {
  status: GameStatus;
  inning: number | null;
  half: "Top" | "Bottom" | null;
  outs: number | null;
  bases: number | null;
  detailed?: string;
  startTime?: string;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (status === "Pre") {
    const localTime = mounted && startTime ? formatStartTime(startTime) : "";
    return (
      <div className="text-right">
        <div className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted)]">
          {localTime || detailed || "Pre-game"}
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
      <div className="mt-2.5 flex justify-end">
        <BasesDiamond bases={bases} />
      </div>
    </div>
  );
}
