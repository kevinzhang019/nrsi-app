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

  // Baseball-field diamond geometry: 2B at top (14, 7), 1B at right (21, 14),
  // 3B at left (7, 14). Adjacent bases are ~9.9 units apart so the ~8-unit-wide
  // rotated squares have ~2 units of clear space between them — half the gap
  // of the prior 6-unit spacing for a denser, more readable diamond.
  return (
    <svg
      viewBox="0 0 28 20"
      className="block h-[20px] w-7 overflow-visible"
      aria-hidden
      focusable="false"
    >
      <Base x={14} y={8} filled={on2} />
      <Base x={21} y={15} filled={on1} />
      <Base x={7} y={15} filled={on3} />
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
