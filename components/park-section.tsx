"use client";

import { ParkOutline } from "@/components/park-outline";
import { cn } from "@/lib/utils";

type Weather = {
  tempF?: number | null;
  windMph?: number | null;
  windDir?: string | null;
  windCardinal?: string | null;
  precipPct?: number | null;
  humidityPct?: number | null;
  pressureInHg?: number | null;
  isDome?: boolean;
  source?: string;
};

const COMPASS_TO_DEG: Record<string, number> = {
  n: 0, nne: 22.5, ne: 45, ene: 67.5,
  e: 90, ese: 112.5, se: 135, sse: 157.5,
  s: 180, ssw: 202.5, sw: 225, wsw: 247.5,
  w: 270, wnw: 292.5, nw: 315, nnw: 337.5,
};

function formatWindMph(mph: number): string {
  // Match covers.com: keep one decimal if present, drop trailing .0
  const rounded = Math.round(mph * 10) / 10;
  return Number.isInteger(rounded) ? rounded.toString() : rounded.toFixed(1);
}

function WindStat({ mph, cardinal }: { mph: number | null | undefined; cardinal: string | null | undefined }) {
  const hasSpeed = mph != null && Number.isFinite(mph);
  const isCalm = cardinal === "calm" || mph === 0;
  const fromDeg = cardinal && cardinal in COMPASS_TO_DEG ? COMPASS_TO_DEG[cardinal] : null;
  // Arrow points the direction wind is going (FROM + 180°). Asset points up (north) by default.
  const rotateDeg = fromDeg != null ? (fromDeg + 180) % 360 : null;

  return (
    <div className="flex flex-col">
      <span className="text-[9px] uppercase tracking-[0.18em] text-[var(--color-muted)]/70">Wind</span>
      {hasSpeed ? (
        <span className="flex items-center gap-1.5 font-mono tabular-nums text-[12px] text-[var(--color-fg)]">
          {isCalm ? (
            <span aria-hidden className="inline-block h-3 w-3 rounded-full border border-[var(--color-muted)]/60" />
          ) : rotateDeg != null ? (
            <svg
              aria-hidden
              viewBox="0 0 12 12"
              className="h-3 w-3 shrink-0 text-[var(--color-fg)]"
              style={{ transform: `rotate(${rotateDeg}deg)` }}
            >
              <path
                d="M6 1 L6 11 M6 1 L3 4 M6 1 L9 4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <span aria-hidden className="inline-block h-3 w-3" />
          )}
          <span>{formatWindMph(mph)} mph</span>
          {!isCalm && cardinal && cardinal in COMPASS_TO_DEG && (
            <span className="text-[10px] uppercase tracking-wider text-[var(--color-muted)]/80">
              {cardinal}
            </span>
          )}
        </span>
      ) : (
        <span className="font-mono tabular-nums text-[12px] text-[var(--color-muted)]/50">—</span>
      )}
    </div>
  );
}

function FactorBadge({ label, value }: { label: string; value: number | null }) {
  if (value === null || !Number.isFinite(value)) {
    return (
      <div className="flex flex-col items-start">
        <span className="text-[9px] uppercase tracking-[0.2em] text-[var(--color-muted)]/70">
          {label}
        </span>
        <span className="font-mono tabular-nums text-[14px] text-[var(--color-muted)]">—</span>
      </div>
    );
  }
  const tone =
    value > 1.02
      ? "text-[var(--color-good)]"
      : value < 0.98
      ? "text-[var(--color-bad)]"
      : "text-[var(--color-fg)]";
  const arrow = value > 1.02 ? "↑" : value < 0.98 ? "↓" : "→";
  return (
    <div className="flex flex-col items-start">
      <span className="text-[9px] uppercase tracking-[0.2em] text-[var(--color-muted)]/70">
        {label}
      </span>
      <span className={cn("font-mono tabular-nums text-[14px]", tone)}>
        {value.toFixed(2)} <span className="text-[10px]">{arrow}</span>
      </span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-col">
      <span className="text-[9px] uppercase tracking-[0.18em] text-[var(--color-muted)]/70">
        {label}
      </span>
      <span className="font-mono tabular-nums text-[12px] text-[var(--color-fg)]">
        {value ?? <span className="text-[var(--color-muted)]/50">—</span>}
      </span>
    </div>
  );
}

export function ParkSection({
  venueId,
  venueName,
  highlighted,
  parkRunFactor,
  weatherRunFactor,
  weather,
}: {
  venueId: number | null;
  venueName: string | null;
  highlighted: boolean;
  parkRunFactor: number | null;
  weatherRunFactor: number | null;
  weather: Weather | null;
}) {
  const w = weather ?? {};
  const dome = w.isDome === true;

  return (
    <div className="rounded border border-[var(--color-border)] bg-[var(--color-subtle)]/40">
      <div className="flex items-stretch gap-3 px-3 py-3">
        <div className="flex shrink-0 flex-col items-center justify-center">
          {venueId != null ? (
            <ParkOutline venueId={venueId} highlighted={highlighted} size={88} />
          ) : (
            <div className="grid h-[88px] w-[88px] place-items-center text-[10px] uppercase tracking-wider text-[var(--color-muted)]/60">
              no shape
            </div>
          )}
          <span className="mt-1 max-w-[110px] truncate text-center text-[9px] uppercase tracking-[0.16em] text-[var(--color-muted)]">
            {venueName ?? "Venue"}
          </span>
        </div>
        <div className="flex-1 space-y-3">
          <div className="flex gap-6">
            <FactorBadge label="Park" value={parkRunFactor} />
            <FactorBadge label="Wx" value={weatherRunFactor} />
            {dome && (
              <span className="self-center rounded-sm bg-[var(--color-subtle)] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.2em] text-[var(--color-muted)]">
                dome
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            <Stat label="Temp" value={w.tempF != null ? `${Math.round(w.tempF)} °F` : null} />
            <WindStat mph={w.windMph} cardinal={w.windCardinal} />
            <Stat
              label="Hum"
              value={w.humidityPct != null ? `${Math.round(w.humidityPct)}%` : null}
            />
            <Stat
              label="Precip"
              value={w.precipPct != null ? `${Math.round(w.precipPct)}%` : null}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
