"use client";

import { useEffect, useMemo, useState } from "react";
import type { GameState } from "@/lib/state/game-state";
import { cn } from "@/lib/utils";
import { ProbabilityPill } from "@/components/probability-pill";
import { InningState } from "@/components/inning-state";
import { LineScore } from "@/components/line-score";
import { teamLogoSrc } from "@/lib/teams/logo";
import { LineupColumn } from "@/components/lineup-column";
import { LineupSinglePane } from "@/components/lineup-single-pane";
import { ParkSection } from "@/components/park-section";
import { PitcherRow } from "@/components/pitcher-row";
import { useSettings } from "@/lib/hooks/use-settings";
import { decisionMomentFor } from "@/lib/state/decision-moment";
import type {
  InningSelection,
  InningAvailability,
} from "@/components/historical-game-view-helpers";

type Side = "away" | "home";

function teamShort(name: string): string {
  const parts = name.split(" ");
  if (parts.length === 1) return name;
  const last = parts[parts.length - 1];
  if (["Sox", "Jays"].includes(last)) return parts.slice(-2).join(" ");
  return last;
}

export function GameCard({
  game,
  historical = false,
  wide = false,
  selection = null,
  inningAvailability,
  onSelectInning,
  onSelectHalf,
}: {
  game: GameState;
  historical?: boolean;
  wide?: boolean;
  selection?: InningSelection | null;
  inningAvailability?: InningAvailability;
  onSelectInning?: (n: number) => void;
  onSelectHalf?: (n: number, half: "Top" | "Bottom") => void;
}) {
  const { settings } = useSettings();
  const decision = !historical && decisionMomentFor(game, settings.predictMode);
  // Wide mode forces side-by-side lineups regardless of the user's
  // viewMode setting — the detail page is wide enough that single-pane
  // would waste horizontal space.
  const effectiveViewMode = wide ? "split" : settings.viewMode;

  // Single-pane lineup selection. Lifted here so the pitcher row above the
  // pane can render the OPPOSING pitcher to the selected lineup. Auto-snaps
  // to the new batting team on half-inning flips; clicks set an ad-hoc peek
  // that resets on the next flip.
  const [manualOverride, setManualOverride] = useState<Side | null>(null);
  const [lastBattingSide, setLastBattingSide] = useState<Side | null>(game.battingTeam);
  useEffect(() => {
    if (game.battingTeam !== lastBattingSide) {
      setManualOverride(null);
      setLastBattingSide(game.battingTeam);
    }
  }, [game.battingTeam, lastBattingSide]);
  const selectedSide: Side = manualOverride ?? game.battingTeam ?? "away";

  // Map upcoming-batter xOBP (pReach) and xSLG onto their player ids so the
  // lineup rows can show stats inline for batters in the upcoming sequence.
  const statsById = useMemo(() => {
    const m = new Map<number, { pReach: number; xSlg: number }>();
    for (const b of game.upcomingBatters) m.set(b.id, { pReach: b.pReach, xSlg: b.xSlg });
    return m;
  }, [game.upcomingBatters]);

  // Per the user spec: highlight current batter for the team currently batting,
  // and next-half leadoff for the team coming up. The watcher resolved which
  // team is which via extractBatterFocus.
  const awayHighlightId =
    game.battingTeam === "away"
      ? game.currentBatterId
      : game.battingTeam === "home"
      ? game.nextHalfLeadoffId
      : null;
  const homeHighlightId =
    game.battingTeam === "home"
      ? game.currentBatterId
      : game.battingTeam === "away"
      ? game.nextHalfLeadoffId
      : null;

  const awayMarker: "current" | "next" | null =
    game.battingTeam === "away" ? "current" : game.battingTeam === "home" ? "next" : null;
  const homeMarker: "current" | "next" | null =
    game.battingTeam === "home" ? "current" : game.battingTeam === "away" ? "next" : null;

  return (
    <article
      data-fresh={decision ? "true" : "false"}
      className={cn(
        "group relative overflow-hidden rounded-lg border bg-[var(--color-card)] transition",
        "border-[var(--color-border)]",
        decision && "ring-2 ring-[var(--color-accent)]/60 border-[var(--color-accent)]/40",
      )}
    >
      <header className="flex items-start justify-between border-b border-[var(--color-border)] px-4 py-3">
        <div className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5">
          <img
            src={teamLogoSrc(game.away.id)}
            alt=""
            width={28}
            height={28}
            loading="lazy"
            decoding="async"
            className="size-7 shrink-0 object-contain"
          />
          <span className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-fg)]/85 truncate">
            {teamShort(game.away.name)}
          </span>
          <span className="font-mono text-2xl tabular-nums justify-self-end">{game.away.runs}</span>
          <img
            src={teamLogoSrc(game.home.id)}
            alt=""
            width={28}
            height={28}
            loading="lazy"
            decoding="async"
            className="size-7 shrink-0 object-contain"
          />
          <span className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-fg)]/85 truncate">
            {teamShort(game.home.name)}
          </span>
          <span className="font-mono text-2xl tabular-nums justify-self-end">{game.home.runs}</span>
        </div>
        <InningState
          status={game.status}
          inning={game.inning}
          half={game.half}
          outs={game.outs}
          bases={game.bases}
          detailed={game.detailedState}
        />
      </header>

      {game.linescore && (
        <section className="border-b border-[var(--color-border)] bg-[var(--color-subtle)]/30 px-4 py-2.5">
          <LineScore
            linescore={game.linescore}
            awayName={game.away.name}
            homeName={game.home.name}
            awayId={game.away.id}
            homeId={game.home.id}
            currentInning={historical ? null : game.inning}
            half={historical ? null : game.half}
            selection={selection}
            availability={inningAvailability}
            onSelectInning={onSelectInning}
            onSelectHalf={onSelectHalf}
          />
        </section>
      )}

      <section className="space-y-3 px-4 py-4">
        {(!historical || wide) && (effectiveViewMode === "single" ? (
          <>
            {(() => {
              // Pitcher pitching to the selected lineup (the OPPOSING side).
              const opposing = selectedSide === "away" ? game.homePitcher : game.awayPitcher;
              const fallback = opposing ?? game.pitcher;
              return fallback ? <PitcherRow pitcher={fallback} /> : null;
            })()}
            <LineupSinglePane
              game={game}
              upcomingStatsById={statsById}
              awayHighlightId={awayHighlightId}
              awayHighlightKind={awayMarker}
              homeHighlightId={homeHighlightId}
              homeHighlightKind={homeMarker}
              selectedSide={selectedSide}
              onSelectSide={setManualOverride}
            />
          </>
        ) : (
          <>
            {game.battingTeam === null ? (
              // Full-inning view: each lineup paired with the OPPOSING pitcher
              // (the one who actually pitched to it that half). Render the
              // pitchers above their respective lineup columns instead of
              // stacked at the top.
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  {game.homePitcher && <PitcherRow pitcher={game.homePitcher} />}
                  <LineupColumn
                    label={teamShort(game.away.name)}
                    lineup={game.lineups?.away ?? null}
                    highlightId={null}
                    highlightKind={null}
                    statsById={statsById}
                  />
                </div>
                <div className="space-y-2">
                  {game.awayPitcher && <PitcherRow pitcher={game.awayPitcher} />}
                  <LineupColumn
                    label={teamShort(game.home.name)}
                    lineup={game.lineups?.home ?? null}
                    highlightId={null}
                    highlightKind={null}
                    statsById={statsById}
                  />
                </div>
              </div>
            ) : (
              <>
                {(() => {
                  // Currently-pitching team is the one fielding now: Top → home pitches,
                  // Bottom → away pitches. Pre-game / Final default to home on top.
                  const fieldingSide: Side =
                    game.half === "Top" ? "home" : game.half === "Bottom" ? "away" : "home";
                  const top = fieldingSide === "away" ? game.awayPitcher : game.homePitcher;
                  const bottom = fieldingSide === "away" ? game.homePitcher : game.awayPitcher;
                  if (!top && !bottom) return game.pitcher ? <PitcherRow pitcher={game.pitcher} /> : null;
                  return (
                    <div className="space-y-1">
                      {top && <PitcherRow pitcher={top} />}
                      {bottom && <PitcherRow pitcher={bottom} muted />}
                    </div>
                  );
                })()}
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <LineupColumn
                    label={teamShort(game.away.name)}
                    lineup={game.lineups?.away ?? null}
                    highlightId={awayHighlightId}
                    highlightKind={awayMarker}
                    statsById={statsById}
                  />
                  <LineupColumn
                    label={teamShort(game.home.name)}
                    lineup={game.lineups?.home ?? null}
                    highlightId={homeHighlightId}
                    highlightKind={homeMarker}
                    statsById={statsById}
                  />
                </div>
              </>
            )}
          </>
        ))}

        <ParkSection
          venueId={game.venue?.id ?? null}
          venueName={game.venue?.name ?? null}
          highlighted={decision}
          parkRunFactor={game.env?.parkRunFactor ?? null}
          weatherRunFactor={game.env?.weatherRunFactor ?? null}
          weather={(game.env?.weather as Record<string, unknown> | undefined) ?? null}
        />
      </section>

      <footer className="border-t border-[var(--color-border)] bg-[var(--color-subtle)]/40 px-4 py-3">
        <ProbabilityPill
          pNoHitEvent={
            historical && !wide
              ? null
              : settings.predictMode === "full"
              ? game.pNoHitEventFullInning
              : game.pNoHitEvent
          }
          breakEvenAmerican={
            historical && !wide
              ? null
              : settings.predictMode === "full"
              ? game.breakEvenAmericanFullInning
              : game.breakEvenAmerican
          }
          inning={game.inning}
        />
      </footer>
    </article>
  );
}
