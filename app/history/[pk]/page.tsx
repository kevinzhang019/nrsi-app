import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { HistoricalGameView } from "@/components/historical-game-view";
import { SettingsProvider } from "@/lib/hooks/use-settings";
import type { HistoricalGame, HistoricalInning, PlayRow } from "@/lib/types/history";

// Single bundled fetch from the Railway "web" service — replaces the
// previous three-call Promise.all that imported @supabase/supabase-js into
// the Vercel bundle. See bin/web.ts and services/web/handlers/history.ts.
async function fetchGameDetail(
  base: string,
  pk: number,
): Promise<{ game: HistoricalGame; innings: HistoricalInning[]; plays: PlayRow[] } | null> {
  const res = await fetch(`${base}/history/game/${pk}`, { next: { revalidate: 30 } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`game ${pk}: ${res.status}`);
  return (await res.json()) as {
    game: HistoricalGame;
    innings: HistoricalInning[];
    plays: PlayRow[];
  };
}

async function DetailBody({ paramsPromise }: { paramsPromise: Promise<{ pk: string }> }) {
  await connection();
  const { pk: pkRaw } = await paramsPromise;
  const pk = Number(pkRaw);
  if (!Number.isFinite(pk)) notFound();

  const base = process.env.NRXI_API_BASE;
  if (!base) {
    return (
      <p className="rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-8 text-sm text-[var(--color-muted)]">
        History service unavailable. See <code>/history</code> for setup instructions.
      </p>
    );
  }

  const detail = await fetchGameDetail(base, pk);
  if (!detail) notFound();

  return (
    <HistoricalGameView game={detail.game} innings={detail.innings} plays={detail.plays} />
  );
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
      <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 sm:py-8">
        <header className="mb-4 flex items-start justify-between">
          <h1 className="text-2xl font-medium tracking-tight text-[var(--color-accent)]">game details</h1>
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
