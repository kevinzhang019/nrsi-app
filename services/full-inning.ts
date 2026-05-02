// Pure predicate: at top of the 9th, the bottom of the 9th is skipped only
// when the home team is already winning. Tied or trailing → bottom plays, so
// the full-inning probability must compose top × bottom_clean like every
// other inning. See CLAUDE.md "Full-inning composition".
export function shouldSkipBottomNinth(args: {
  inning: number | null;
  half: "Top" | "Bottom" | null;
  homeRuns: number;
  awayRuns: number;
}): boolean {
  return (
    args.inning === 9 &&
    args.half === "Top" &&
    args.homeRuns > args.awayRuns
  );
}
