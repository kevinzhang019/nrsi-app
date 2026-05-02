"use client";

import { useContext } from "react";
import type { PitcherInfo } from "@/lib/state/game-state";
import { cn } from "@/lib/utils";
import { SuppressPlayerLinksContext } from "@/components/lineup-column";

export function PitcherRow({ pitcher, muted = false }: { pitcher: PitcherInfo; muted?: boolean }) {
  const nameClass = muted ? "text-[var(--color-muted)]" : "text-[var(--color-fg)]";
  const valueClass = muted ? "text-[var(--color-muted)]" : "text-[var(--color-fg)]";
  const suppressLinks = useContext(SuppressPlayerLinksContext);
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className={cn("text-[13px]", nameClass)}>
          {suppressLinks ? (
            <span>{pitcher.name}</span>
          ) : (
            <a
              href={`https://www.mlb.com/player/${pitcher.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline underline-offset-2"
            >
              {pitcher.name}
            </a>
          )}{" "}
          <span className="text-[11px] text-[var(--color-muted)]">
            ({pitcher.throws}HP)
          </span>
        </span>
        {pitcher.era !== null && Number.isFinite(pitcher.era) && (
          <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-muted)]">
            ERA <span className={cn("font-mono tabular-nums", valueClass)}>{pitcher.era.toFixed(2)}</span>
          </span>
        )}
        {pitcher.whip !== null && Number.isFinite(pitcher.whip) && (
          <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-muted)]">
            WHIP <span className={cn("font-mono tabular-nums", valueClass)}>{pitcher.whip.toFixed(2)}</span>
          </span>
        )}
        {pitcher.pitchCount !== null && Number.isFinite(pitcher.pitchCount) && (
          <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-muted)]">
            P <span className={cn("font-mono tabular-nums", valueClass)}>{pitcher.pitchCount}</span>
          </span>
        )}
      </div>
    </div>
  );
}
