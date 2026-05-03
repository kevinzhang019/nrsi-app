// Single source of truth for the team-logo asset path.
// Logos are fetched once via `scripts/fetch-team-logos.mjs` into public/logos/.
export function teamLogoSrc(teamId: number): string {
  return `/logos/${teamId}.svg`;
}
