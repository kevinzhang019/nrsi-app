import { Suspense } from "react";
import { connection } from "next/server";
import { redis } from "@/lib/cache/redis";
import { k } from "@/lib/cache/keys";
import type { GameState } from "@/lib/state/game-state";
import { notFound } from "next/navigation";

async function getGame(pk: number): Promise<GameState | null> {
  await connection();
  const r = redis();
  const all = await r.hgetall<Record<string, unknown>>(k.snapshot());
  const raw = all?.[String(pk)];
  if (!raw) return null;
  if (typeof raw === "object") return raw as GameState;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as GameState;
    } catch {
      return null;
    }
  }
  return null;
}

async function GameDetail({ params }: { params: Promise<{ pk: string }> }) {
  const { pk } = await params;
  const pkN = Number(pk);
  if (!Number.isFinite(pkN)) notFound();
  const game = await getGame(pkN);
  if (!game) notFound();

  return (
    <>
      <header className="mt-6 mb-8 flex items-baseline justify-between">
        <div>
          <h1 className="font-mono text-2xl tabular-nums">
            {game.away.name} @ {game.home.name}
          </h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            {game.detailedState} · Inning {game.inning ?? "–"} {game.half ?? ""}
          </p>
        </div>
        <div className="font-mono text-3xl tabular-nums">
          {game.away.runs}-{game.home.runs}
        </div>
      </header>

      {game.upcomingBatters.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted)]">
            Upcoming half — per-batter reach probabilities
          </h2>
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted)]">
                <th className="py-2 text-left font-normal">#</th>
                <th className="py-2 text-left font-normal">Batter</th>
                <th className="py-2 text-left font-normal">Bats</th>
                <th className="py-2 text-right font-normal">P(reach)</th>
              </tr>
            </thead>
            <tbody>
              {game.upcomingBatters.map((b, i) => (
                <tr key={b.id} className="border-b border-[var(--color-border)]/50">
                  <td className="py-2 font-mono text-sm tabular-nums text-[var(--color-muted)]">{i + 1}</td>
                  <td className="py-2 text-sm">{b.name}</td>
                  <td className="py-2 text-sm">{b.bats}HB</td>
                  <td className="py-2 text-right font-mono text-sm tabular-nums">
                    {(b.pReach * 100).toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="grid grid-cols-3 gap-4 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-6">
        <div>
          <div className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted)]">P(no run)</div>
          <div className="mt-1 font-mono text-2xl tabular-nums">
            {game.pNoHitEvent !== null ? `${(game.pNoHitEvent * 100).toFixed(1)}%` : "—"}
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted)]">Min +EV odds</div>
          <div className="mt-1 font-mono text-2xl tabular-nums text-[var(--color-accent)]">
            {game.breakEvenAmerican !== null
              ? game.breakEvenAmerican > 0
                ? `+${Math.round(game.breakEvenAmerican)}`
                : Math.round(game.breakEvenAmerican)
              : "—"}
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted)]">Env</div>
          <div className="mt-1 space-y-0.5 font-mono text-sm tabular-nums">
            <div>Park {game.env?.parkRunFactor.toFixed(2) ?? "—"}</div>
            <div>Wx {game.env?.weatherRunFactor.toFixed(2) ?? "—"}</div>
          </div>
        </div>
      </section>
    </>
  );
}

export default function GameDrilldown({ params }: { params: Promise<{ pk: string }> }) {
  return (
    <main className="mx-auto max-w-[900px] px-6 py-10">
      <a href="/" className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted)] hover:text-[var(--color-fg)]">
        ← Back to board
      </a>
      <Suspense fallback={<DetailSkeleton />}>
        <GameDetail params={params} />
      </Suspense>
    </main>
  );
}

function DetailSkeleton() {
  return <div className="mt-10 h-[400px] animate-pulse rounded-md border border-[var(--color-border)] bg-[var(--color-card)]" />;
}
