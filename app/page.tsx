import { Suspense } from "react";
import { connection } from "next/server";
import { GameBoard } from "@/components/game-board";
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
    <main className="mx-auto max-w-[1400px] px-6 py-8">
      <header className="mb-8 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-medium tracking-tight">NRSI</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            per-inning scoring probabilities • live MLB
          </p>
        </div>
      </header>
      <Suspense fallback={<BoardSkeleton />}>
        <GameBoardLoader />
      </Suspense>
    </main>
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
