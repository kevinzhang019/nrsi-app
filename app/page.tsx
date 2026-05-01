import { Suspense } from "react";
import { connection } from "next/server";
import { GameBoard } from "@/components/game-board";
import { HistoryButton } from "@/components/history-button";
import { SettingsButton } from "@/components/settings-button";
import { SettingsProvider } from "@/lib/hooks/use-settings";
import { getSnapshot } from "@/lib/pubsub/publisher";
import type { GameState } from "@/lib/state/game-state";

async function getInitialGames(): Promise<GameState[]> {
  await connection();
  try {
    return await getSnapshot();
  } catch {
    return [];
  }
}

async function GameBoardLoader() {
  const initial = await getInitialGames();
  return <GameBoard initial={initial} />;
}

export default function Page() {
  return (
    <SettingsProvider>
      <main className="mx-auto max-w-[1400px] px-6 py-8">
        <header className="mb-8 flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-medium tracking-tight text-[var(--color-accent)]">nrXi</h1>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              live MLB per-inning scoring probabilities
            </p>
          </div>
          <div className="flex items-center gap-1">
            <HistoryButton />
            <SettingsButton />
          </div>
        </header>
        <Suspense fallback={<BoardSkeleton />}>
          <GameBoardLoader />
        </Suspense>
      </main>
    </SettingsProvider>
  );
}

function BoardSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="h-[220px] animate-pulse rounded-md border border-[var(--color-border)] bg-[var(--color-card)]"
        />
      ))}
    </div>
  );
}
