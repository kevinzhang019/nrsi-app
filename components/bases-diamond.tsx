"use client";

// Three-square diamond glyph for live base occupancy. Bit0=1B (right),
// bit1=2B (top), bit2=3B (left). Filled square = runner on, empty = hairline
// outline. Matches the CAD-blueprint aesthetic of <ParkOutline>: same 1.25px
// hairline stroke, single accent fill, 240ms transitions.
//
// `bases === null` (Pre / Final / Delayed) → renders nothing.
export function BasesDiamond({ bases }: { bases: number | null }) {
  if (bases === null) return null;

  const on1 = (bases & 1) !== 0;
  const on2 = (bases & 2) !== 0;
  const on3 = (bases & 4) !== 0;

  // 28x18 viewBox so the diamond reads as wider-than-tall (home plate is
  // implied below the bottom edge — we don't draw it, the InningState dots
  // sit there). Each base square is rotated 45° around its center.
  return (
    <svg
      viewBox="0 0 28 22"
      className="block h-[18px] w-7 overflow-visible"
      aria-hidden
      focusable="false"
    >
      <Base x={14} y={7} filled={on2} />
      <Base x={23} y={13} filled={on1} />
      <Base x={5} y={13} filled={on3} />
    </svg>
  );
}

function Base({ x, y, filled }: { x: number; y: number; filled: boolean }) {
  // 4.6px half-diagonal → ~6.5px sides at 45°. Stroke matches outs-dots
  // hairline weight; fill swaps to accent on `filled`.
  const s = 4.6;
  return (
    <rect
      x={x - s}
      y={y - s}
      width={s * 2}
      height={s * 2}
      transform={`rotate(45 ${x} ${y})`}
      className={
        filled
          ? "fill-[var(--color-accent)] stroke-[var(--color-accent)]"
          : "fill-transparent stroke-[var(--color-border)]"
      }
      strokeWidth={1.25}
      style={{ transition: "fill 240ms ease, stroke 240ms ease" }}
    />
  );
}
