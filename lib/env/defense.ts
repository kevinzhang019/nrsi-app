import { cacheJson } from "../cache/redis";
import { k } from "../cache/keys";
import { log } from "../log";
import { clamp } from "../utils";

/**
 * Fielder defense (Outs Above Average) loaded from Statcast Savant.
 *
 * The leaderboard publishes per-player OAA — how many outs that fielder made
 * above (or below) what an average fielder would have on the same plays.
 * Top team aggregate: ~+50; bottom: ~−40.
 *
 * Source: https://baseballsavant.mlb.com/leaderboard/outs_above_average
 */

const SAVANT_OAA_URL =
  "https://baseballsavant.mlb.com/leaderboard/outs_above_average";

const UA = process.env.MLB_USER_AGENT || "nrsi-app/0.1";

export type OaaRow = {
  playerId: number;
  oaa: number;          // raw season OAA
  opportunities: number;
  position: string;     // 1B/2B/3B/SS/LF/CF/RF (catcher excluded — that's framing)
};

export type OaaTable = Map<number, OaaRow>;

/**
 * Empirical-Bayes prior strength in opportunities. Position mean is
 * approximately 0 by construction — OAA is "above average". A fielder with
 * 200 opportunities contributes 50/50 with the position mean.
 */
const SHRINK_N0 = 200;

/**
 * Linear scaling for sum-of-OAA → factor. SCALE ≈ 1200 means ±60 team-OAA
 * maps to a ±5% factor swing on the in-play block.
 */
const FACTOR_SCALE = 1200;

const FACTOR_CLAMP_LO = 0.90;
const FACTOR_CLAMP_HI = 1.10;

function num(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

async function scrapeOaa(season: number): Promise<OaaTable> {
  const url = `${SAVANT_OAA_URL}?type=Fielder&year=${season}&min=1`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html" },
  });
  if (!res.ok) throw new Error(`Savant OAA HTTP ${res.status}`);
  const html = await res.text();
  return parseOaaHtml(html);
}

export function parseOaaHtml(html: string): OaaTable {
  const m =
    html.match(/<script[^>]*id="[^"]*data[^"]*"[^>]*>([\s\S]*?)<\/script>/i) ||
    html.match(/var\s+data\s*=\s*(\[\{[\s\S]*?\}\])\s*;/);
  if (!m) return new Map();
  let data: unknown;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return new Map();
  }
  if (!Array.isArray(data)) return new Map();
  const out = new Map<number, OaaRow>();
  for (const row of data) {
    const r = row as Record<string, unknown>;
    const playerId = num(r.entity_id ?? r.player_id ?? r.id);
    const oaa = num(r.outs_above_average ?? r.oaa);
    const opps = num(r.attempts ?? r.opportunities ?? r.fielding_attempts) ?? 0;
    if (playerId === null || oaa === null) continue;
    const position = String(r.fielding_position ?? r.position ?? r.pos ?? "");
    out.set(playerId, { playerId, oaa, opportunities: opps, position });
  }
  return out;
}

export async function loadOaaTable(season: number): Promise<OaaTable> {
  const arr = await cacheJson<Array<[number, OaaRow]>>(
    k.oaa(season),
    60 * 60 * 24,
    async () => {
      try {
        const table = await scrapeOaa(season);
        return Array.from(table.entries());
      } catch (e) {
        log.warn("oaa", "scrape:failed", { season, err: String(e) });
        return [];
      }
    },
  );
  return new Map(arr);
}

/**
 * Empirical-Bayes shrinkage of a player's raw OAA toward the position mean
 * (≈ 0 by definition of "above average"). Stabilizes low-sample backups.
 */
function shrinkOaa(row: OaaRow | undefined): number {
  if (!row) return 0;
  const n = Math.max(0, row.opportunities);
  return (n * row.oaa) / (n + SHRINK_N0);
}

/**
 * Build a defensive multiplier for the in-play block from the seven non-battery
 * fielders currently on the field.
 *
 * Returns a factor in [0.90, 1.10]:
 *   - factor < 1 → defense converts more contact to outs (good defense, fewer hits).
 *   - factor = 1 → neutral.
 *   - factor > 1 → defense lets more contact through (bad defense, more hits).
 *
 * Catcher is excluded — its defensive value is captured by `framingFactors`
 * and acts on K/BB cells, not the in-play block. Pitcher is excluded — pitcher
 * defense is included in pitcher splits already.
 */
export function defenseFactor(
  fielderIds: number[],
  table: OaaTable,
): number {
  if (fielderIds.length === 0 || table.size === 0) return 1.0;
  let sum = 0;
  for (const id of fielderIds) {
    sum += shrinkOaa(table.get(id));
  }
  const factor = 1 - sum / FACTOR_SCALE;
  return clamp(factor, FACTOR_CLAMP_LO, FACTOR_CLAMP_HI);
}

export const NEUTRAL_DEFENSE_FACTOR = 1.0;

// Internal helpers exported for tests.
export const __testing = { shrinkOaa, SHRINK_N0, FACTOR_SCALE };
