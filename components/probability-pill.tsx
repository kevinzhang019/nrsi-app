"use client";

export function ProbabilityPill({
  pNoHitEvent,
  breakEvenAmerican,
  inning,
}: {
  pNoHitEvent: number | null | undefined;
  breakEvenAmerican: number | null | undefined;
  inning: number | null | undefined;
}) {
  const inningLabel = inning ?? "X";
  // Use == to catch both null and undefined. Stale Redis snapshot states
  // written before the *FullInning fields were added return undefined; the
  // pill should render "—" rather than NaN%.
  if (pNoHitEvent == null || breakEvenAmerican == null) {
    // No inning-specific prediction is being shown here, so always render
    // the project-name label "nrXi" — never bake a final inning number into
    // the placeholder (would surface "nr9i" on Finished cards).
    return (
      <div className="flex items-baseline justify-between text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted)]">
        <span>nrXi</span>
        <span>—</span>
      </div>
    );
  }
  const pct = (pNoHitEvent * 100).toFixed(1);
  const rounded = Math.round(breakEvenAmerican);
  const odds = rounded > 0 ? `+${rounded}` : String(rounded);
  const isPlusOrEven = rounded >= 100 || rounded === -100;
  const oddsColor = isPlusOrEven ? "text-[var(--color-bad)]" : "text-[var(--color-accent)]";
  return (
    <div className="flex items-baseline justify-between gap-3">
      <div>
        <div className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted)]">P(nr{inningLabel}i)</div>
        <div className="font-mono text-xl tabular-nums">{pct}%</div>
      </div>
      <div className="text-right">
        <div className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted)]">Min +EV</div>
        <div className={`font-mono text-xl tabular-nums ${oddsColor}`}>{odds}</div>
      </div>
    </div>
  );
}
