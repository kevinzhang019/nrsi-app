import { cacheJson } from "../cache/redis";
import { k } from "../cache/keys";
import { log } from "../log";

const SAVANT_URL =
  "https://baseballsavant.mlb.com/leaderboard/statcast-park-factors?type=year&year=";

const UA = process.env.MLB_USER_AGENT || "nrsi-app/0.1";

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

async function scrapeParkFactors(season: number): Promise<ParkRow[]> {
  const url = `${SAVANT_URL}${season}&batSide=&stat=index_runs&condition=All&rolling=`;
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
      return await scrapeParkFactors(season);
    } catch (e) {
      log.warn("park", "scrape:failed", { season, err: String(e) });
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
 * Per-outcome park factors. Same factor applied to L and R for v1 (Savant
 * scrape currently returns combined indices). Future revision can fetch
 * `batSide=L` / `batSide=R` separately for true handedness-controlled factors.
 *
 * When the scrape returns only `index_runs`, components are derived from runs
 * via published per-outcome park-factor sensitivities (HR is the most
 * leverage-sensitive component; K/BB are essentially park-independent).
 *
 * Source for derivation exponents: FanGraphs 5-year regressed PFs by
 * component, https://library.fangraphs.com/park-factors-5-year-regressed/.
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

export async function getParkComponentFactors(
  homeTeamName: string,
  season: number,
): Promise<ParkComponentFactors> {
  const table = await loadParkFactors(season);
  if (table.length === 0) return NEUTRAL_PARK;
  const match = findRow(table, homeTeamName);
  if (!match) return NEUTRAL_PARK;
  const runs = clampIdx(match.runsIndex);

  // HR is the most park-sensitive component (~1.5x runs sensitivity in physics
  // terms). Doubles/triples scale with field dimensions but less strongly.
  // Singles barely move. K/BB are essentially park-independent — pitch-by-pitch
  // outcomes between battery and hitter dominate.
  const hr = clampIdx(match.hrIndex ?? deriveFromRuns(runs, 1.5));
  const triple = clampIdx(match.tripleIndex ?? deriveFromRuns(runs, 1.0));
  const dbl = clampIdx(match.doubleIndex ?? deriveFromRuns(runs, 0.7));
  const single = clampIdx(match.singleIndex ?? deriveFromRuns(runs, 0.4));
  const k = clampIdx(match.kIndex ?? 1);
  const bb = clampIdx(match.bbIndex ?? 1);

  return {
    hr: { L: hr, R: hr },
    triple: { L: triple, R: triple },
    double: { L: dbl, R: dbl },
    single: { L: single, R: single },
    k: { L: k, R: k },
    bb: { L: bb, R: bb },
  };
}
