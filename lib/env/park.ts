import { cacheJson } from "../cache/redis";
import { k } from "../cache/keys";
import { log } from "../log";

const SAVANT_URL =
  "https://baseballsavant.mlb.com/leaderboard/statcast-park-factors?type=year&year=";

const UA = process.env.MLB_USER_AGENT || "nrxi-app/0.1";

type BatSide = "L" | "R" | "all";

type ParkRow = {
  team: string;
  runsIndex: number;
  // Optional per-component fields. When the scrape returns only `index_runs`,
  // these are undefined and the consumer falls back to a derivation.
  hrIndex?: number;
  doubleIndex?: number;
  tripleIndex?: number;
  singleIndex?: number;
  kIndex?: number;
  bbIndex?: number;
};

export function parseSavantHtml(html: string): ParkRow[] {
  const m =
    html.match(/<script[^>]*id="park-factors-data"[^>]*>([\s\S]*?)<\/script>/) ||
    html.match(/var\s+data\s*=\s*(\[\{[\s\S]*?\}\])\s*;/);
  if (m) {
    try {
      return parseSavantData(JSON.parse(m[1]));
    } catch {
      // fall through
    }
  }
  return regexParseTable(html);
}

async function scrapeParkFactors(season: number, batSide: BatSide = "all"): Promise<ParkRow[]> {
  // Savant accepts `batSide=L` or `batSide=R` for handedness-controlled park
  // factors; empty / `all` returns the combined index. Per FanGraphs' spray-angle
  // work and Savant's own park-factor methodology, the HR component swings ≫20%
  // by handedness in extreme parks (Yankees RF, Fenway LF), so per-side factors
  // are not optional for a serious model.
  const sideParam = batSide === "all" ? "" : batSide;
  const url = `${SAVANT_URL}${season}&batSide=${sideParam}&stat=index_runs&condition=All&rolling=`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
  if (!res.ok) throw new Error(`Savant park factors HTTP ${res.status}`);
  const html = await res.text();
  return parseSavantHtml(html);
}

function asIndex(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (!Number.isFinite(n)) return undefined;
  // Savant may publish either a centered-on-100 index (e.g., 105) or a ratio
  // (e.g., 1.05). Normalize both to ratio form.
  return n > 5 ? n / 100 : n;
}

// Savant uses a few quirky short forms that don't substring-match the
// canonical MLB team names. Normalize at parse time.
const SAVANT_NAME_ALIAS: Record<string, string> = {
  "d-backs": "Diamondbacks",
  "dbacks": "Diamondbacks",
  "a's": "Athletics",
};

function canonicalizeSavantTeam(team: string): string {
  return SAVANT_NAME_ALIAS[team.trim().toLowerCase()] ?? team;
}

function parseSavantData(data: unknown): ParkRow[] {
  if (!Array.isArray(data)) return [];
  return data
    .map((row): ParkRow | null => {
      const r = row as Record<string, unknown>;
      // Savant's live JSON uses `name_display_club` (e.g. "Red Sox", "Dodgers").
      // Older legacy keys kept as fallbacks.
      const teamRaw = (r.name_display_club ||
        r.team_name ||
        r.name ||
        r.team ||
        r.venue_name) as string | undefined;
      const team = teamRaw ? canonicalizeSavantTeam(String(teamRaw)) : undefined;
      const runs = asIndex(r.index_runs ?? r.runs_index ?? r.runs);
      if (!team || runs === undefined) return null;
      return {
        team: String(team),
        runsIndex: runs,
        hrIndex: asIndex(r.index_hr ?? r.hr_index ?? r.hr),
        doubleIndex: asIndex(r.index_2b ?? r.double_index ?? r["2b"]),
        tripleIndex: asIndex(r.index_3b ?? r.triple_index ?? r["3b"]),
        singleIndex: asIndex(r.index_1b ?? r.single_index ?? r["1b"]),
        kIndex: asIndex(r.index_so ?? r.index_k ?? r.so ?? r.k),
        bbIndex: asIndex(r.index_bb ?? r.bb_index ?? r.bb),
      };
    })
    .filter((x): x is ParkRow => x !== null);
}

function regexParseTable(html: string): ParkRow[] {
  const rows: ParkRow[] = [];
  const re = /<tr[^>]*>[\s\S]*?<td[^>]*>([A-Z]{2,3})[\s\S]*?<td[^>]*>([0-9.]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const team = m[1];
    const v = parseFloat(m[2]);
    if (Number.isFinite(v)) rows.push({ team, runsIndex: v > 5 ? v / 100 : v });
  }
  return rows;
}

export async function loadParkFactors(season: number): Promise<ParkRow[]> {
  return cacheJson(k.parkFactors(season), 60 * 60 * 24, async () => {
    try {
      return await scrapeParkFactors(season, "all");
    } catch (e) {
      log.warn("park", "scrape:failed", { season, err: String(e) });
      return [];
    }
  });
}

/** Per-handedness park factors (scraped with `batSide=L` / `batSide=R`). */
async function loadParkFactorsByHand(season: number, batSide: "L" | "R"): Promise<ParkRow[]> {
  return cacheJson(k.parkFactorsHand(season, batSide), 60 * 60 * 24, async () => {
    try {
      return await scrapeParkFactors(season, batSide);
    } catch (e) {
      log.warn("park", "scrape:hand-failed", { season, batSide, err: String(e) });
      return [];
    }
  });
}

const TEAM_ABBR: Record<string, string> = {
  "arizona diamondbacks": "ARI",
  "atlanta braves": "ATL",
  "baltimore orioles": "BAL",
  "boston red sox": "BOS",
  "chicago cubs": "CHC",
  "chicago white sox": "CWS",
  "cincinnati reds": "CIN",
  "cleveland guardians": "CLE",
  "colorado rockies": "COL",
  "detroit tigers": "DET",
  "houston astros": "HOU",
  "kansas city royals": "KC",
  "los angeles angels": "LAA",
  "los angeles dodgers": "LAD",
  "miami marlins": "MIA",
  "milwaukee brewers": "MIL",
  "minnesota twins": "MIN",
  "new york mets": "NYM",
  "new york yankees": "NYY",
  "athletics": "OAK",
  "oakland athletics": "OAK",
  "philadelphia phillies": "PHI",
  "pittsburgh pirates": "PIT",
  "san diego padres": "SD",
  "san francisco giants": "SF",
  "seattle mariners": "SEA",
  "st. louis cardinals": "STL",
  "tampa bay rays": "TB",
  "texas rangers": "TEX",
  "toronto blue jays": "TOR",
  "washington nationals": "WSH",
};

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
}

function findRow(table: ParkRow[], homeTeamName: string): ParkRow | null {
  const norm = normalize(homeTeamName);
  const abbr = TEAM_ABBR[norm];
  return (
    table.find((r) => r.team === abbr) ||
    table.find((r) => normalize(r.team) === norm) ||
    table.find((r) => norm.includes(normalize(r.team)) || normalize(r.team).includes(norm)) ||
    null
  );
}

function clampIdx(n: number): number {
  if (!Number.isFinite(n) || n < 0.5 || n > 1.8) return 1.0;
  return n;
}

export async function getParkRunFactor(homeTeamName: string, season: number): Promise<number> {
  const table = await loadParkFactors(season);
  if (table.length === 0) return 1.0;
  const match = findRow(table, homeTeamName);
  if (!match) return 1.0;
  return clampIdx(match.runsIndex);
}

/**
 * Per-outcome park factors keyed by hitter handedness. When the Savant scrape
 * returns full per-component fields, those are used directly. When only the
 * runs index is published, components are derived per-side from runs via
 * published per-outcome sensitivities (HR most park-sensitive; K/BB park-independent).
 *
 * Source for derivation exponents: FanGraphs 5-year regressed PFs by component,
 * https://library.fangraphs.com/park-factors-5-year-regressed/.
 *
 * Source for the handedness split: Savant publishes `batSide=L|R` variants of
 * the same leaderboard. HR especially swings >20% by handedness in extreme
 * parks (Yankees short porch RF for LHB, Fenway monster LF for RHB) —
 * per-side factors are mandatory for an accurate HR-rate adjustment.
 */
export type ParkComponentFactors = {
  hr: { L: number; R: number };
  triple: { L: number; R: number };
  double: { L: number; R: number };
  single: { L: number; R: number };
  k: { L: number; R: number };
  bb: { L: number; R: number };
};

export const NEUTRAL_PARK: ParkComponentFactors = {
  hr: { L: 1, R: 1 },
  triple: { L: 1, R: 1 },
  double: { L: 1, R: 1 },
  single: { L: 1, R: 1 },
  k: { L: 1, R: 1 },
  bb: { L: 1, R: 1 },
};

function deriveFromRuns(runs: number, exponent: number): number {
  // Sublinear / superlinear derivation around 1.0. exponent=1 → identity.
  return clampIdx(Math.pow(runs, exponent));
}

type SideComponents = {
  hr: number;
  triple: number;
  double: number;
  single: number;
  k: number;
  bb: number;
};

function componentsFromRow(row: ParkRow): SideComponents {
  const runs = clampIdx(row.runsIndex);
  return {
    hr: clampIdx(row.hrIndex ?? deriveFromRuns(runs, 1.5)),
    triple: clampIdx(row.tripleIndex ?? deriveFromRuns(runs, 1.0)),
    double: clampIdx(row.doubleIndex ?? deriveFromRuns(runs, 0.7)),
    single: clampIdx(row.singleIndex ?? deriveFromRuns(runs, 0.4)),
    k: clampIdx(row.kIndex ?? 1),
    bb: clampIdx(row.bbIndex ?? 1),
  };
}

const NEUTRAL_SIDE: SideComponents = { hr: 1, triple: 1, double: 1, single: 1, k: 1, bb: 1 };

export async function getParkComponentFactors(
  homeTeamName: string,
  season: number,
): Promise<ParkComponentFactors> {
  // Fetch combined + both handedness tables in parallel. Either side may be
  // empty (scrape failure or seasonally-thin data); fall back to combined,
  // then to neutral.
  const [combined, leftTable, rightTable] = await Promise.all([
    loadParkFactors(season),
    loadParkFactorsByHand(season, "L"),
    loadParkFactorsByHand(season, "R"),
  ]);

  const combinedMatch = combined.length > 0 ? findRow(combined, homeTeamName) : null;
  const leftMatch = leftTable.length > 0 ? findRow(leftTable, homeTeamName) : null;
  const rightMatch = rightTable.length > 0 ? findRow(rightTable, homeTeamName) : null;

  if (!combinedMatch && !leftMatch && !rightMatch) return NEUTRAL_PARK;

  const fallback = combinedMatch ? componentsFromRow(combinedMatch) : NEUTRAL_SIDE;
  const left = leftMatch ? componentsFromRow(leftMatch) : fallback;
  const right = rightMatch ? componentsFromRow(rightMatch) : fallback;

  return {
    hr: { L: left.hr, R: right.hr },
    triple: { L: left.triple, R: right.triple },
    double: { L: left.double, R: right.double },
    single: { L: left.single, R: right.single },
    k: { L: left.k, R: right.k },
    bb: { L: left.bb, R: right.bb },
  };
}
