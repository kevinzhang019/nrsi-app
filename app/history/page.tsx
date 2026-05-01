import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { HistoryDateStrip } from "@/components/history-date-strip";
import { HistoricalCardLink } from "@/components/historical-card-link";
import { SettingsProvider } from "@/lib/hooks/use-settings";
import { isSupabaseConfigured } from "@/lib/db/supabase";
import { listGameDates, listGamesByDate } from "@/lib/db/games";
import type { GameState } from "@/lib/state/game-state";

type SearchParams = Record<string, string | string[] | undefined>;

async function HistoryBody({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await connection();
  const params = await searchParams;

  if (!isSupabaseConfigured()) {
    return <NotConfigured />;
  }

  const dates = await listGameDates();
  const requested = typeof params.date === "string" ? params.date : null;
  const selectedDate = requested && dates.includes(requested) ? requested : dates[0] ?? "";

  const games = selectedDate ? await listGamesByDate(selectedDate) : [];

  return (
    <div className="space-y-6">
      <HistoryDateStrip availableDates={dates} selectedDate={selectedDate} />

      {games.length === 0 ? (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-12 text-center">
          <p className="text-sm text-[var(--color-muted)]">
            {dates.length === 0
              ? "No finished games yet — once a game ends, it'll show up here."
              : "No games on this date."}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {games.map((g) => {
            const snapshot = g.finalSnapshot;
            if (!snapshot) return null;
            // Stored snapshot is exactly a GameState shape; round-trip via JSONB.
            return <HistoricalCardLink key={g.gamePk} game={snapshot as GameState} />;
          })}
        </div>
      )}
    </div>
  );
}

function NotConfigured() {
  return (
    <div className="space-y-3 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-8 text-sm text-[var(--color-muted)]">
      <p className="text-[var(--color-fg)]">History database not configured.</p>
      <p>
        Install the Supabase integration via the Vercel Marketplace, then run
        <code className="ml-1 rounded bg-[var(--color-subtle)] px-1.5 py-0.5 font-mono text-xs">
          supabase/migrations/0001_history.sql
        </code>{" "}
        in the Supabase SQL editor.
      </p>
      <p>
        Required env vars: <code className="font-mono text-xs">SUPABASE_URL</code> and{" "}
        <code className="font-mono text-xs">SUPABASE_SERVICE_ROLE_KEY</code>.
      </p>
    </div>
  );
}

function HistorySkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-9 animate-pulse rounded-md bg-[var(--color-subtle)]" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-[220px] animate-pulse rounded-md border border-[var(--color-border)] bg-[var(--color-card)]"
          />
        ))}
      </div>
    </div>
  );
}

export default function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  return (
    <SettingsProvider>
      <main className="mx-auto max-w-[1400px] px-6 py-8">
        <header className="mb-8 flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-medium tracking-tight text-[var(--color-accent)]">history</h1>
            <p className="mt-1 text-sm text-[var(--color-muted)]">past per-inning predictions</p>
          </div>
          <Link
            href="/"
            className="text-xs uppercase tracking-[0.16em] text-[var(--color-muted)] hover:text-[var(--color-accent)]"
          >
            ← live
          </Link>
        </header>
        <Suspense fallback={<HistorySkeleton />}>
          <HistoryBody searchParams={searchParams} />
        </Suspense>
      </main>
    </SettingsProvider>
  );
}
