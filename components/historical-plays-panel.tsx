"use client";

import type { PlayRow } from "@/lib/types/history";
import {
  rollupBatters,
  rollupPitchers,
  formatIp,
  type BatterLine,
  type PitcherLine,
} from "@/lib/history/rollup-plays";

type Slice = { inning: number; half: "Top" | "Bottom" } | { inning: number; half: null };

function filterSlice(plays: PlayRow[], slice: Slice): PlayRow[] {
  if (slice.half) {
    return plays.filter((p) => p.inning === slice.inning && p.half === slice.half);
  }
  return plays.filter((p) => p.inning === slice.inning);
}

function HitterTable({ rows }: { rows: BatterLine[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-max text-xs">
        <thead className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-muted)]">
          <tr>
            <th className="px-2 py-1.5 text-left font-normal">batter</th>
            <th className="px-2 py-1.5 text-right font-normal">PA</th>
            <th className="px-2 py-1.5 text-right font-normal">AB</th>
            <th className="px-2 py-1.5 text-right font-normal">H</th>
            <th className="px-2 py-1.5 text-right font-normal">HR</th>
            <th className="px-2 py-1.5 text-right font-normal">BB</th>
            <th className="px-2 py-1.5 text-right font-normal">K</th>
            <th className="px-2 py-1.5 text-right font-normal">R</th>
            <th className="px-2 py-1.5 text-right font-normal">RBI</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.playerId} className="border-t border-[var(--color-border)]">
              <td className="px-2 py-1.5 text-left whitespace-nowrap">{b.name}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{b.pa}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{b.ab}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{b.h}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{b.hr}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{b.bb}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{b.k}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{b.r}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{b.rbi}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PitcherTable({ rows }: { rows: PitcherLine[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-max text-xs">
        <thead className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-muted)]">
          <tr>
            <th className="px-2 py-1.5 text-left font-normal">pitcher</th>
            <th className="px-2 py-1.5 text-right font-normal">IP</th>
            <th className="px-2 py-1.5 text-right font-normal">BF</th>
            <th className="px-2 py-1.5 text-right font-normal">H</th>
            <th className="px-2 py-1.5 text-right font-normal">BB</th>
            <th className="px-2 py-1.5 text-right font-normal">K</th>
            <th className="px-2 py-1.5 text-right font-normal">HR</th>
            <th className="px-2 py-1.5 text-right font-normal">R</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.playerId} className="border-t border-[var(--color-border)]">
              <td className="px-2 py-1.5 text-left whitespace-nowrap">{p.name}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{formatIp(p.ipOuts)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{p.bf}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{p.h}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{p.bb}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{p.k}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{p.hr}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{p.r}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PlayLog({ rows }: { rows: PlayRow[] }) {
  if (rows.length === 0) return null;
  return (
    <ol className="space-y-1 text-xs text-[var(--color-muted)]">
      {rows.map((p) => (
        <li
          key={`${p.gamePk}-${p.atBatIndex}`}
          className="flex items-baseline gap-3 border-t border-[var(--color-border)] pt-1.5"
        >
          <span className="w-8 shrink-0 text-right tabular-nums opacity-60">
            #{p.atBatIndex}
          </span>
          <span className="text-[var(--color-fg)]">{p.batterName}</span>
          <span className="opacity-60">vs</span>
          <span>{p.pitcherName}</span>
          <span className="ml-auto whitespace-nowrap text-[var(--color-fg)]">
            {p.event ?? "—"}
          </span>
          <span className="w-12 shrink-0 text-right tabular-nums opacity-60">
            {p.awayScore ?? 0}–{p.homeScore ?? 0}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-muted)]">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function HistoricalPlaysPanel({
  plays,
  selection,
}: {
  plays: PlayRow[];
  selection:
    | { kind: "half"; inning: number; half: "Top" | "Bottom" }
    | { kind: "full"; inning: number };
}) {
  if (plays.length === 0) {
    return (
      <p className="rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-6 text-sm text-[var(--color-muted)]">
        No play-by-play stored for this game. Older records predate the per-play archive.
      </p>
    );
  }

  if (selection.kind === "half") {
    const slice = filterSlice(plays, { inning: selection.inning, half: selection.half });
    if (slice.length === 0) {
      return (
        <p className="rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-6 text-sm text-[var(--color-muted)]">
          No plays recorded for this half-inning.
        </p>
      );
    }
    const batters = rollupBatters(slice);
    const pitchers = rollupPitchers(slice);
    return (
      <div className="grid gap-6 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-6 md:grid-cols-2">
        <Section title="batters this half">
          <HitterTable rows={batters} />
        </Section>
        <Section title="pitchers this half">
          <PitcherTable rows={pitchers} />
        </Section>
        <div className="md:col-span-2">
          <Section title="play log">
            <PlayLog rows={slice} />
          </Section>
        </div>
      </div>
    );
  }

  // Full-inning view: split into Top and Bottom for clarity.
  const top = filterSlice(plays, { inning: selection.inning, half: "Top" });
  const bottom = filterSlice(plays, { inning: selection.inning, half: "Bottom" });
  if (top.length === 0 && bottom.length === 0) {
    return (
      <p className="rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-6 text-sm text-[var(--color-muted)]">
        No plays recorded for this inning.
      </p>
    );
  }
  return (
    <div className="space-y-6">
      {top.length > 0 && (
        <div className="grid gap-6 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-6 md:grid-cols-2">
          <div className="md:col-span-2">
            <h3 className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-accent)]">
              top {selection.inning}
            </h3>
          </div>
          <Section title="batters">
            <HitterTable rows={rollupBatters(top)} />
          </Section>
          <Section title="pitchers">
            <PitcherTable rows={rollupPitchers(top)} />
          </Section>
          <div className="md:col-span-2">
            <Section title="play log">
              <PlayLog rows={top} />
            </Section>
          </div>
        </div>
      )}
      {bottom.length > 0 && (
        <div className="grid gap-6 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-6 md:grid-cols-2">
          <div className="md:col-span-2">
            <h3 className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-accent)]">
              bottom {selection.inning}
            </h3>
          </div>
          <Section title="batters">
            <HitterTable rows={rollupBatters(bottom)} />
          </Section>
          <Section title="pitchers">
            <PitcherTable rows={rollupPitchers(bottom)} />
          </Section>
          <div className="md:col-span-2">
            <Section title="play log">
              <PlayLog rows={bottom} />
            </Section>
          </div>
        </div>
      )}
    </div>
  );
}
