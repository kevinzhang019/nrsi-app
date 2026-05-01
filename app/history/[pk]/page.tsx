import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { HistoricalGameView } from "@/components/historical-game-view";
import { SettingsProvider } from "@/lib/hooks/use-settings";
import { isSupabaseConfigured } from "@/lib/db/supabase";
import { getGame, getInningPredictions } from "@/lib/db/games";

async function DetailBody({ paramsPromise }: { paramsPromise: Promise<{ pk: string }> }) {
  await connection();
  const { pk: pkRaw } = await paramsPromise;
  const pk = Number(pkRaw);
  if (!Number.isFinite(pk)) notFound();

  if (!isSupabaseConfigured()) {
    return (
      <p className="rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-8 text-sm text-[var(--color-muted)]">
        History database not configured. See <code>/history</code> for setup instructions.
      </p>
    );
  }

  const [game, innings] = await Promise.all([getGame(pk), getInningPredictions(pk)]);
  if (!game) notFound();

  return <HistoricalGameView game={game} innings={innings} />;
}

function DetailSkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-16 animate-pulse rounded-md bg-[var(--color-subtle)]" />
      <div className="h-6 animate-pulse rounded bg-[var(--color-subtle)]" />
      <div className="h-[420px] max-w-md animate-pulse rounded-md border border-[var(--color-border)] bg-[var(--color-card)]" />
    </div>
  );
}

export default function HistoricalGameDetailPage({
  params,
}: {
  params: Promise<{ pk: string }>;
}) {
  return (
    <SettingsProvider>
      <main className="mx-auto max-w-[1400px] px-6 py-8">
        <header className="mb-8 flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-medium tracking-tight text-[var(--color-accent)]">game detail</h1>
            <p className="mt-1 text-sm text-[var(--color-muted)]">predictions per inning + actual outcome</p>
          </div>
          <Link
            href="/history"
            className="text-xs uppercase tracking-[0.16em] text-[var(--color-muted)] hover:text-[var(--color-accent)]"
          >
            ← history
          </Link>
        </header>
        <Suspense fallback={<DetailSkeleton />}>
          <DetailBody paramsPromise={params} />
        </Suspense>
      </main>
    </SettingsProvider>
  );
}
