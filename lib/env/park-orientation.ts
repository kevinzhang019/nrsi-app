// Home-plate-to-center-field compass bearing (degrees, 0=N, 90=E) for every
// MLB park. Used to translate covers.com's wind-FROM compass icon into the
// "out / in / cross" classification weather.ts needs.
//
// Bearings rounded to nearest 5°. Source: Andrew Clem stadium pages
// (andrewclem.com/Baseball) cross-checked against SeamHeads ballpark database.
// Octant-level accuracy is sufficient — we only choose between three buckets
// at 45° boundaries, so even a 30° error rarely changes the classification.

const ORIENTATION_BY_TEAM: Record<string, number> = {
  // AL East
  "baltimore orioles": 60,        // Camden Yards — CF roughly ENE
  "boston red sox": 45,           // Fenway — CF NE
  "new york yankees": 25,         // Yankee Stadium — CF NNE
  "tampa bay rays": 65,           // Tropicana — dome (kept for completeness)
  "toronto blue jays": 0,         // Rogers Centre — CF N (retractable)

  // AL Central
  "chicago white sox": 30,        // Rate Field — CF NNE
  "cleveland guardians": 0,       // Progressive Field — CF N
  "detroit tigers": 150,          // Comerica Park — CF SSE
  "kansas city royals": 105,      // Kauffman — CF E
  "minnesota twins": 90,          // Target Field — CF E

  // AL West
  "houston astros": 345,          // Minute Maid — CF NNW (retractable)
  "los angeles angels": 60,       // Angel Stadium — CF ENE
  "athletics": 60,                // Sutter Health (Sacramento) — approx
  "oakland athletics": 60,
  "seattle mariners": 0,          // T-Mobile Park — CF N (retractable)
  "texas rangers": 0,             // Globe Life Field — CF N (retractable)

  // NL East
  "atlanta braves": 65,           // Truist Park — CF ENE
  "miami marlins": 70,            // LoanDepot Park — CF ENE (retractable)
  "new york mets": 0,             // Citi Field — CF N
  "philadelphia phillies": 30,    // Citizens Bank Park — CF NNE
  "washington nationals": 30,     // Nationals Park — CF NNE

  // NL Central
  "chicago cubs": 35,             // Wrigley Field — CF NNE
  "cincinnati reds": 75,          // Great American Ball Park — CF ENE
  "milwaukee brewers": 100,       // American Family Field — CF E (retractable)
  "pittsburgh pirates": 95,       // PNC Park — CF E
  "st. louis cardinals": 60,      // Busch Stadium — CF ENE

  // NL West
  "arizona diamondbacks": 25,     // Chase Field — CF NNE (retractable)
  "colorado rockies": 0,          // Coors Field — CF N
  "los angeles dodgers": 25,      // Dodger Stadium — CF NNE
  "san diego padres": 30,         // Petco Park — CF NNE
  "san francisco giants": 90,     // Oracle Park — CF E
};

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
}

export function getOrientationDeg(homeTeamName: string): number | null {
  const norm = normalize(homeTeamName);
  if (norm in ORIENTATION_BY_TEAM) return ORIENTATION_BY_TEAM[norm];
  for (const [k, v] of Object.entries(ORIENTATION_BY_TEAM)) {
    if (norm.includes(k) || k.includes(norm)) return v;
  }
  return null;
}

export const COMPASS_TO_DEG: Record<string, number> = {
  n: 0, nne: 22.5, ne: 45, ene: 67.5,
  e: 90, ese: 112.5, se: 135, sse: 157.5,
  s: 180, ssw: 202.5, sw: 225, wsw: 247.5,
  w: 270, wnw: 292.5, nw: 315, nnw: 337.5,
};

/**
 * Classify a wind whose FROM-direction is `windFromDeg` (0=N) at a park whose
 * home→CF bearing is `outfieldDeg`. Returns "out" if wind blows from home
 * toward outfield, "in" if from outfield toward home, "cross" otherwise.
 *
 * Convention: meteorological wind direction is the direction the wind is
 * coming FROM. So an "out" wind is one whose FROM-direction is opposite the
 * outfield (i.e. coming from behind home plate).
 */
export function classifyWind(
  windFromDeg: number | null,
  outfieldDeg: number | null,
): "out" | "in" | "cross" | null {
  if (windFromDeg === null || outfieldDeg === null) return null;
  const homeBehindDeg = (outfieldDeg + 180) % 360;
  const delta = Math.abs(((windFromDeg - homeBehindDeg + 540) % 360) - 180);
  if (delta < 45) return "out";
  if (delta > 135) return "in";
  return "cross";
}
