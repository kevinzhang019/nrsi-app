"use client";

import { useMemo } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useGameStream } from "@/lib/hooks/use-game-stream";
import { GameCard } from "@/components/game-card";
import { HistoricalCardLink } from "@/components/historical-card-link";
import type { GameState } from "@/lib/state/game-state";
import { decisionMomentFor } from "@/lib/state/decision-moment";
import { useSettings } from "@/lib/hooks/use-settings";
import type { PredictMode } from "@/lib/hooks/use-settings";

const STATUS_ORDER: Record<string, number> = {
  Live: 0,
  Delayed: 1,
  Suspended: 2,
  Pre: 3,
  Final: 4,
  Other: 5,
};

function makeSortGames(mode: PredictMode) {
  return function sortGames(a: GameState, b: GameState): number {
    const da = decisionMomentFor(a, mode);
    const db = decisionMomentFor(b, mode);
    if (da !== db) return da ? -1 : 1;
    const oa = STATUS_ORDER[a.status] ?? 5;
    const ob = STATUS_ORDER[b.status] ?? 5;
    if (oa !== ob) return oa - ob;
    if (a.status === "Live" && b.status === "Live") return (b.inning ?? 0) - (a.inning ?? 0);
    return 0;
  };
}

function sortByStartTime(a: GameState, b: GameState): number {
  return (a.startTime ?? "").localeCompare(b.startTime ?? "");
}

type Section = { id: string; label: string; games: GameState[] };

export function GameBoard({ initial }: { initial: GameState[] }) {
  const games = useGameStream(initial);
  const { settings } = useSettings();
  const mode = settings.predictMode;

  const sections = useMemo<Section[]>(() => {
    const sortGames = makeSortGames(mode);
    const hi: GameState[] = [];
    const ac: GameState[] = [];
    const up: GameState[] = [];
    const fi: GameState[] = [];
    for (const g of games) {
      if (decisionMomentFor(g, mode)) hi.push(g);
      else if (g.status === "Live" || g.status === "Delayed" || g.status === "Suspended") ac.push(g);
      else if (g.status === "Final") fi.push(g);
      else up.push(g);
    }
    hi.sort(sortGames);
    ac.sort(sortGames);
    up.sort(sortByStartTime);
    fi.sort(sortGames);
    return [
      { id: "highlighted", label: "Start of Inning", games: hi },
      { id: "active", label: "Active", games: ac },
      { id: "upcoming", label: "Upcoming", games: up },
      { id: "finished", label: "Finished", games: fi },
    ].filter((s) => s.games.length > 0);
  }, [games, mode]);

  if (sections.length === 0) {
    return (
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-12 text-center">
        <p className="text-sm text-[var(--color-muted)]">
          Waiting for the daily schedule. The poller will populate this board within a few seconds of game start.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {sections.map((section) => (
        <section key={section.id}>
          <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted)]">
            {section.label}
            <span className="ml-2 font-mono text-[var(--color-muted)]/70">{section.games.length}</span>
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            <AnimatePresence mode="popLayout" initial={false}>
              {section.games.map((g) => (
                <motion.div
                  key={g.gamePk}
                  layout
                  layoutId={`card-${g.gamePk}`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ type: "spring", stiffness: 350, damping: 32, opacity: { duration: 0.25 } }}
                >
                  {section.id === "finished" ? <HistoricalCardLink game={g} /> : <GameCard game={g} />}
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </section>
      ))}
    </div>
  );
}
