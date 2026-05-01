"use client";

import type { TeamLineup } from "@/lib/mlb/extract";
import { cn } from "@/lib/utils";

type Marker = "current" | "next" | null;

function lastName(name: string): string {
  const parts = name.trim().split(" ");
  return parts[parts.length - 1] || name;
}

function MarkerDot({ kind }: { kind: Marker }) {
  if (!kind) return <span className="inline-block w-2 shrink-0" />;
  const color = kind === "current" ? "var(--color-accent)" : "var(--color-good)";
  return (
    <span
      aria-label={kind === "current" ? "at bat" : "leads off next half"}
      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ background: color, boxShadow: `0 0 6px ${color}` }}
    />
  );
}

export function LineupColumn({
  label,
  lineup,
  highlightId,
  highlightKind,
  pReachById,
  align = "left",
}: {
  label: string;
  lineup: TeamLineup | null;
  highlightId: number | null;
  highlightKind: Marker;
  pReachById?: Map<number, number>;
  align?: "left" | "right";
}) {
  const showPReach = (id: number) => {
    if (!pReachById) return null;
    const p = pReachById.get(id);
    if (p == null) return null;
    return (
      <span className="ml-auto font-mono tabular-nums text-[10px] text-[var(--color-muted)]">
        {(p * 100).toFixed(0)}
      </span>
    );
  };

  const headerAlign = align === "right" ? "text-right" : "text-left";

  return (
    <div className="space-y-1">
      <div
        className={cn(
          "flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-[var(--color-muted)]",
          headerAlign,
        )}
      >
        <span>{label}</span>
        {highlightKind && (
          <span
            className={cn(
              "rounded-sm px-1 py-px text-[8px] tracking-[0.2em]",
              highlightKind === "current"
                ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                : "bg-[color:var(--color-good)]/15 text-[var(--color-good)]",
            )}
          >
            {highlightKind === "current" ? "AT BAT" : "ON DECK ½"}
          </span>
        )}
      </div>
      {lineup === null || lineup.length === 0 ? (
        <div className="rounded border border-dashed border-[var(--color-border)] px-2 py-3 text-center text-[10px] uppercase tracking-wider text-[var(--color-muted)]">
          Lineup pending
        </div>
      ) : (
        <ol className="divide-y divide-[var(--color-border)]/40 rounded border border-[var(--color-border)]/60 bg-[var(--color-subtle)]/30">
          {lineup.map((slot) => {
            const starterIsCurrent = slot.starter.id === highlightId;
            return (
              <li key={slot.spot} className="px-1.5">
                <div
                  className={cn(
                    "flex items-center gap-2 py-1",
                    starterIsCurrent && "rounded bg-[var(--color-accent-soft)]/60",
                  )}
                >
                  <MarkerDot kind={starterIsCurrent ? highlightKind : null} />
                  <span className="w-3 font-mono text-[10px] tabular-nums text-[var(--color-muted)]">
                    {slot.spot}
                  </span>
                  <span className="w-7 font-mono text-[10px] uppercase tracking-wider text-[var(--color-muted)]/80">
                    {slot.starter.position}
                  </span>
                  <span
                    className={cn(
                      "truncate text-[12px]",
                      starterIsCurrent
                        ? "text-[var(--color-fg)] font-medium"
                        : "text-[var(--color-fg)]/90",
                    )}
                    title={slot.starter.name}
                  >
                    {lastName(slot.starter.name)}
                  </span>
                  <span className="text-[9px] uppercase text-[var(--color-muted)]/60">
                    {slot.starter.bats}
                  </span>
                  {showPReach(slot.starter.id)}
                </div>
                {slot.subs.map((sub) => {
                  const subIsCurrent = sub.id === highlightId;
                  return (
                    <div
                      key={sub.id}
                      className={cn(
                        "flex items-center gap-2 py-0.5 pl-4",
                        subIsCurrent && "rounded bg-[var(--color-accent-soft)]/60",
                      )}
                    >
                      <MarkerDot kind={subIsCurrent ? highlightKind : null} />
                      <span className="w-3 text-[var(--color-muted)]/60">↳</span>
                      <span className="w-7 font-mono text-[10px] uppercase tracking-wider text-[var(--color-muted)]/60">
                        {sub.position}
                      </span>
                      <span
                        className={cn(
                          "truncate text-[11px]",
                          subIsCurrent
                            ? "text-[var(--color-fg)]"
                            : "text-[var(--color-muted)]",
                        )}
                        title={sub.name}
                      >
                        {lastName(sub.name)}
                      </span>
                      <span className="text-[9px] uppercase text-[var(--color-muted)]/40">
                        {sub.bats}
                      </span>
                      {showPReach(sub.id)}
                    </div>
                  );
                })}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
