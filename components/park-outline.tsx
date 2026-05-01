"use client";

import shapesJson from "@/lib/parks/shapes.json";

type Shape = { name: string; viewBox: string; d: string };
const PARKS: Record<string, Shape> = shapesJson as Record<string, Shape>;

export function ParkOutline({
  venueId,
  highlighted,
  size = 28,
}: {
  venueId: number | null | undefined;
  highlighted: boolean;
  size?: number;
}) {
  if (venueId == null) return null;
  const shape = PARKS[String(venueId)];
  if (!shape) return null;

  return (
    <svg
      role="img"
      aria-label={`${shape.name} outline`}
      width={size}
      height={size}
      viewBox={shape.viewBox}
      fill="none"
      stroke={highlighted ? "var(--color-accent)" : "var(--color-muted)"}
      strokeWidth={1.25}
      strokeLinejoin="round"
      strokeLinecap="round"
      style={{
        vectorEffect: "non-scaling-stroke",
        transition: "stroke 240ms ease-out",
      }}
    >
      <path d={shape.d} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
