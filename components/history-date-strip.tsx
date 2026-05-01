"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

function CalendarIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}

// Render a chip for one available game-date plus a calendar popover. The
// strip is the primary nav; the calendar handles long-distance jumps. Only
// dates in `availableDates` (sorted desc, ISO YYYY-MM-DD) are selectable —
// the rest of the calendar is rendered greyed out.
export function HistoryDateStrip({
  availableDates,
  selectedDate,
}: {
  availableDates: string[];
  selectedDate: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function navigateTo(date: string) {
    const next = new URLSearchParams(params.toString());
    next.set("date", date);
    router.push(`/history?${next.toString()}`);
  }

  // Auto-scroll the selected chip into view on mount/change.
  useEffect(() => {
    if (!stripRef.current) return;
    const el = stripRef.current.querySelector<HTMLElement>(`[data-date="${selectedDate}"]`);
    if (el) el.scrollIntoView({ inline: "center", block: "nearest" });
  }, [selectedDate]);

  return (
    <div ref={wrapRef} className="relative flex items-center gap-2">
      <div
        ref={stripRef}
        className="flex flex-1 items-center gap-1.5 overflow-x-auto pb-1 [scrollbar-width:thin]"
      >
        {availableDates.length === 0 ? (
          <span className="text-xs text-[var(--color-muted)]">No history yet — finished games will appear here.</span>
        ) : (
          availableDates.map((d) => {
            const selected = d === selectedDate;
            return (
              <button
                key={d}
                type="button"
                data-date={d}
                onClick={() => navigateTo(d)}
                className={cn(
                  "shrink-0 rounded-md border px-3 py-1.5 text-xs font-mono tabular-nums transition-colors",
                  selected
                    ? "border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                    : "border-[var(--color-border)] bg-[var(--color-card)] text-[var(--color-muted)] hover:text-[var(--color-fg)]",
                )}
              >
                {formatChip(d)}
              </button>
            );
          })
        )}
      </div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Open calendar"
        aria-expanded={open}
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-md border transition-colors",
          open
            ? "border-[var(--color-border)] bg-[var(--color-card)] text-[var(--color-accent)]"
            : "border-transparent text-[var(--color-muted)] hover:text-[var(--color-accent)]",
        )}
      >
        <CalendarIcon className="h-5 w-5" />
      </button>
      {open && (
        <CalendarPopover
          availableDates={availableDates}
          selectedDate={selectedDate}
          onSelect={(d) => {
            setOpen(false);
            navigateTo(d);
          }}
        />
      )}
    </div>
  );
}

function formatChip(iso: string): string {
  // Parse YYYY-MM-DD as local-time-of-the-game-day to avoid TZ shifts.
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function CalendarPopover({
  availableDates,
  selectedDate,
  onSelect,
}: {
  availableDates: string[];
  selectedDate: string;
  onSelect: (date: string) => void;
}) {
  const enabled = useMemo(() => new Set(availableDates), [availableDates]);
  const [view, setView] = useState<{ y: number; m: number }>(() => {
    const [y, m] = selectedDate.split("-").map(Number);
    return { y, m: m - 1 };
  });

  const cells = useMemo(() => buildMonth(view.y, view.m), [view.y, view.m]);

  return (
    <div className="absolute right-0 top-full z-20 mt-2 w-72 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-3 shadow-xl">
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => setView(prev => stepMonth(prev, -1))}
          className="rounded px-2 py-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)]"
        >
          ‹
        </button>
        <span className="text-xs font-medium uppercase tracking-[0.16em] text-[var(--color-muted)]">
          {new Date(view.y, view.m, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" })}
        </span>
        <button
          type="button"
          aria-label="Next month"
          onClick={() => setView(prev => stepMonth(prev, 1))}
          className="rounded px-2 py-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)]"
        >
          ›
        </button>
      </div>
      <div className="mb-1 grid grid-cols-7 text-center text-[10px] uppercase tracking-wider text-[var(--color-muted)]/70">
        {["S", "M", "T", "W", "T", "F", "S"].map((c, i) => (
          <span key={i}>{c}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((cell, i) => {
          if (!cell) return <span key={i} />;
          const has = enabled.has(cell.iso);
          const isSelected = cell.iso === selectedDate;
          return (
            <button
              key={cell.iso}
              type="button"
              disabled={!has}
              onClick={() => has && onSelect(cell.iso)}
              className={cn(
                "h-8 rounded text-xs font-mono tabular-nums transition-colors",
                isSelected
                  ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)] font-medium"
                  : has
                  ? "text-[var(--color-fg)] hover:bg-[var(--color-subtle)]"
                  : "text-[var(--color-muted)]/30 cursor-not-allowed",
              )}
            >
              {cell.day}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function stepMonth({ y, m }: { y: number; m: number }, delta: number): { y: number; m: number } {
  const dt = new Date(y, m + delta, 1);
  return { y: dt.getFullYear(), m: dt.getMonth() };
}

type Cell = { day: number; iso: string } | null;

function buildMonth(year: number, month: number): Cell[] {
  const first = new Date(year, month, 1);
  const startWeekday = first.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: Cell[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    cells.push({ day: d, iso });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}
