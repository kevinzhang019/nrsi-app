import { cacheJson } from "../cache/redis";
import { k } from "../cache/keys";
import { clamp } from "../utils";
import { log } from "../log";
import { getOrientationDeg, COMPASS_TO_DEG, classifyWind } from "./park-orientation";

const COVERS_URL = "https://www.covers.com/sport/mlb/weather";
const UA =
  process.env.MLB_USER_AGENT ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export type WeatherInfo = {
  tempF: number | null;
  windMph: number | null;
  windDir: "out" | "in" | "cross" | "calm" | null;
  precipPct: number | null;
  humidityPct: number | null;
  pressureInHg: number | null;
  isDome: boolean;
  source: "covers" | "fallback";
};

const DEFAULT: WeatherInfo = {
  tempF: null,
  windMph: null,
  windDir: null,
  precipPct: null,
  humidityPct: null,
  pressureInHg: null,
  isDome: false,
  source: "fallback",
};

// covers.com brick headers use city-style labels with shared cities
// disambiguated by nickname (e.g. "NY Yankees", "Chi. Cubs", "LA Dodgers").
// Each brick also includes the standard MLB abbreviation, which is the
// fallback we match on if the city label miss.
type CoversTeamId = { label: string; abbr: string };

const COVERS_TEAM: Record<string, CoversTeamId> = {
  "arizona diamondbacks": { label: "arizona", abbr: "ARI" },
  "atlanta braves": { label: "atlanta", abbr: "ATL" },
  "baltimore orioles": { label: "baltimore", abbr: "BAL" },
  "boston red sox": { label: "boston", abbr: "BOS" },
  "chicago cubs": { label: "chi. cubs", abbr: "CHC" },
  "chicago white sox": { label: "chi. white sox", abbr: "CHW" },
  "cincinnati reds": { label: "cincinnati", abbr: "CIN" },
  "cleveland guardians": { label: "cleveland", abbr: "CLE" },
  "colorado rockies": { label: "colorado", abbr: "COL" },
  "detroit tigers": { label: "detroit", abbr: "DET" },
  "houston astros": { label: "houston", abbr: "HOU" },
  "kansas city royals": { label: "kansas city", abbr: "KC" },
  "los angeles angels": { label: "la angels", abbr: "LAA" },
  "los angeles dodgers": { label: "la dodgers", abbr: "LAD" },
  "miami marlins": { label: "miami", abbr: "MIA" },
  "milwaukee brewers": { label: "milwaukee", abbr: "MIL" },
  "minnesota twins": { label: "minnesota", abbr: "MIN" },
  "new york mets": { label: "ny mets", abbr: "NYM" },
  "new york yankees": { label: "ny yankees", abbr: "NYY" },
  "athletics": { label: "athletics", abbr: "ATH" },
  "oakland athletics": { label: "athletics", abbr: "ATH" },
  "philadelphia phillies": { label: "philadelphia", abbr: "PHI" },
  "pittsburgh pirates": { label: "pittsburgh", abbr: "PIT" },
  "san diego padres": { label: "san diego", abbr: "SD" },
  "san francisco giants": { label: "san francisco", abbr: "SF" },
  "seattle mariners": { label: "seattle", abbr: "SEA" },
  "st. louis cardinals": { label: "st. louis", abbr: "STL" },
  "tampa bay rays": { label: "tampa bay", abbr: "TB" },
  "texas rangers": { label: "texas", abbr: "TEX" },
  "toronto blue jays": { label: "toronto", abbr: "TOR" },
  "washington nationals": { label: "washington", abbr: "WSH" },
};

function teamIdOf(team: string): CoversTeamId | null {
  const norm = team.toLowerCase().replace(/[^a-z0-9. ]/g, "").trim();
  if (norm in COVERS_TEAM) return COVERS_TEAM[norm];
  for (const [k, v] of Object.entries(COVERS_TEAM)) {
    if (norm.includes(k) || k.includes(norm)) return v;
  }
  return null;
}

function brickMatchesTeam(textLower: string, textRaw: string, id: CoversTeamId): boolean {
  if (textLower.includes(id.label)) return true;
  return new RegExp(`\\b${id.abbr}\\b`).test(textRaw);
}

type CheerioStatic = ReturnType<typeof import("cheerio")["load"]>;

function parseBrick(
  $: CheerioStatic,
  brick: ReturnType<CheerioStatic>,
  outfieldDeg: number | null,
): WeatherInfo {
  const text = brick.text().toLowerCase().replace(/\s+/g, " ");
  const isDome = /dome|roof closed|indoor/.test(text);

  const tempM = text.match(/(-?\d{1,3}(?:\.\d+)?)\s*°?\s*f\b/);
  const windM = text.match(/wind:\s*(\d{1,2}(?:\.\d+)?)\s*mph/) || text.match(/(\d{1,2}(?:\.\d+)?)\s*mph/);
  const precipM =
    text.match(/p\.?o\.?p\.?[^0-9]*(\d{1,3})\s*%/) ||
    text.match(/precip[a-z]*[^0-9]*(\d{1,3})\s*%/);
  const humM = text.match(/humidity[^0-9]*(\d{1,3}(?:\.\d+)?)\s*%/);
  const presM = text.match(/(\d{2}\.\d{1,2})\s*(?:in\s*hg|inhg|inches)/);

  const iconSrc = brick.find(".covers-coversweather-windDirectionIcon").attr("src") || "";
  const iconCode = iconSrc.match(/wind_icons\/([a-z]+)\.png/i)?.[1]?.toLowerCase() ?? null;
  const windFromDeg = iconCode && iconCode in COMPASS_TO_DEG ? COMPASS_TO_DEG[iconCode] : null;
  const windMph = windM ? Math.round(parseFloat(windM[1])) : null;

  let windDir: WeatherInfo["windDir"] = null;
  if (isDome) windDir = null;
  else if (windMph === 0 || iconCode === "calm") windDir = "calm";
  else windDir = classifyWind(windFromDeg, outfieldDeg);

  return {
    tempF: tempM ? Math.round(parseFloat(tempM[1])) : null,
    windMph,
    windDir,
    precipPct: precipM ? parseInt(precipM[1], 10) : null,
    humidityPct: humM ? Math.round(parseFloat(humM[1])) : null,
    pressureInHg: presM ? parseFloat(presM[1]) : null,
    isDome,
    source: "covers",
  };
}

export async function parseCoversHtml(
  html: string,
  awayTeam: string,
  homeTeam: string,
): Promise<WeatherInfo> {
  const cheerio = await import("cheerio");
  const $ = cheerio.load(html);

  const awayId = teamIdOf(awayTeam);
  const homeId = teamIdOf(homeTeam);
  if (!awayId || !homeId) return DEFAULT;
  const outfieldDeg = getOrientationDeg(homeTeam);

  let result: WeatherInfo | null = null;
  $(".covers-CoversWeather-brick").each((_, el) => {
    if (result) return;
    const brick = $(el);
    const raw = brick.text().replace(/\s+/g, " ");
    const lower = raw.toLowerCase();
    if (brickMatchesTeam(lower, raw, awayId) && brickMatchesTeam(lower, raw, homeId)) {
      result = parseBrick($, brick, outfieldDeg);
    }
  });

  return result ?? DEFAULT;
}

async function scrapeCovers(awayTeam: string, homeTeam: string): Promise<WeatherInfo> {
  const res = await fetch(COVERS_URL, { headers: { "User-Agent": UA, Accept: "text/html" } });
  if (!res.ok) throw new Error(`covers.com HTTP ${res.status}`);
  const html = await res.text();
  return parseCoversHtml(html, awayTeam, homeTeam);
}

export async function loadWeather(
  gamePk: number,
  awayTeam: string,
  homeTeam: string,
): Promise<WeatherInfo> {
  return cacheJson(k.weather(gamePk), 60 * 30, async () => {
    try {
      return await scrapeCovers(awayTeam, homeTeam);
    } catch (e) {
      log.warn("weather", "scrape:failed", { gamePk, err: String(e) });
      return DEFAULT;
    }
  });
}

/**
 * @deprecated v1 single-scalar weather factor. Use `weatherComponentFactors`
 * for the v2 model — weather affects HR rate strongly, 2B/3B mildly, and BB/K
 * essentially not at all. The legacy single-factor version is retained only
 * for the v1 `pReach` code path.
 */
export function weatherRunFactor(w: WeatherInfo): number {
  if (w.isDome) return 1.0;
  let f = 1.0;
  if (w.tempF !== null) f *= 1 + clamp((w.tempF - 70) * 0.004, -0.10, 0.10);
  if (w.windMph !== null && w.windDir === "out") f *= 1 + clamp(w.windMph * 0.005, 0, 0.08);
  if (w.windMph !== null && w.windDir === "in") f *= 1 - clamp(w.windMph * 0.005, 0, 0.08);
  if (w.precipPct !== null && w.precipPct > 60) f *= 0.95;
  return clamp(f, 0.85, 1.15);
}

/**
 * Per-outcome multipliers driven by weather. Multipliers are applied to the
 * Log5 multinomial then renormalized — so a 1.10× HR boost steals mass from
 * `ipOut` rather than inflating the absolute outcome sum.
 *
 * Coefficients from the literature:
 *   - Hampson 2013 (AMS): every 1°C → +1.96% HR rate (≈ 0.011 per °F).
 *   - Wind out/in: ~0.5% per mph on HR rate (Sportradar / multiple writeups).
 *   - Humidity: humid air is *less* dense → +HR; ~0.1% per percentage point.
 *   - Pressure: higher pressure → denser air → -HR; ~0.5% per inHg below 30.
 *   - K, BB, HBP: literature reports no significant weather signal.
 *
 * 2B/3B/1B receive a damped fraction (≈ 30% / 30% / 10%) of the HR adjustment
 * because batted-ball carry partly determines whether a fly turns into an
 * extra-base hit vs an out/single, but K/BB are pure pitch outcomes.
 */
export type WeatherComponentFactors = {
  hr: number;
  triple: number;
  double: number;
  single: number;
  k: number;
  bb: number;
};

export const NEUTRAL_WEATHER: WeatherComponentFactors = {
  hr: 1,
  triple: 1,
  double: 1,
  single: 1,
  k: 1,
  bb: 1,
};

export function weatherComponentFactors(w: WeatherInfo): WeatherComponentFactors {
  if (w.isDome) return NEUTRAL_WEATHER;

  // Build the HR delta from temp + wind + humidity + pressure; clamp the total.
  let hrDelta = 0;
  if (w.tempF !== null) hrDelta += clamp((w.tempF - 70) * 0.011, -0.18, 0.18);
  if (w.windMph !== null && w.windDir === "out") hrDelta += clamp(w.windMph * 0.005, 0, 0.10);
  if (w.windMph !== null && w.windDir === "in") hrDelta -= clamp(w.windMph * 0.005, 0, 0.10);
  if (w.humidityPct !== null) hrDelta += clamp((w.humidityPct - 50) * 0.001, -0.04, 0.04);
  if (w.pressureInHg !== null) hrDelta += clamp((30.0 - w.pressureInHg) * 0.005, -0.03, 0.03);
  if (w.precipPct !== null && w.precipPct > 60) hrDelta -= 0.05;
  hrDelta = clamp(hrDelta, -0.25, 0.25);

  return {
    hr: 1 + hrDelta,
    triple: 1 + hrDelta * 0.30,
    double: 1 + hrDelta * 0.30,
    single: 1 + hrDelta * 0.10,
    k: 1,
    bb: 1,
  };
}
