"use client";

import { ParkOutline } from "@/components/park-outline";
import { cn } from "@/lib/utils";

type Weather = {
  tempF?: number | null;
  windMph?: number | null;
  windDir?: string | null;
  precipPct?: number | null;
  humidityPct?: number | null;
  pressureInHg?: number | null;
  isDome?: boolean;
  source?: string;
};

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
  const wind = w.windMph != null
    ? `${w.windDir && w.windDir !== "calm" ? w.windDir.toUpperCase() : ""} ${w.windMph}`.trim()
    : null;

  return (
    <div className="rounded border border-[var(--color-border)] bg-[var(--color-subtle)]/40">
      <div className="flex items-stretch gap-4 px-4 py-4">
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
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
            <Stat label="Temp" value={w.tempF != null ? `${Math.round(w.tempF)} °F` : null} />
            <Stat label="Wind" value={wind ? `${wind} mph` : null} />
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
