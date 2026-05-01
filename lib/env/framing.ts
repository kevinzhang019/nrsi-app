import { cacheJson } from "../cache/redis";
import { k } from "../cache/keys";
import { log } from "../log";
import { clamp } from "../utils";

/**
 * Catcher framing — the skill of receiving borderline pitches in a way that
 * makes umpires more likely to call a strike. Stolen strikes shift K up and
 * BB down vs an average catcher receiving the same pitches.
 *
 * Top framers: ~+15 to +25 strikes added per season vs ~−15 to −20 for the
 * worst. Effect size: roughly K-rate ±1–2 pp, BB-rate ∓0.5–1 pp.
 *
 * Source: https://baseballsavant.mlb.com/leaderboard/catcher_framing
 *
 * Robo-ump kill switch: set NRSI_DISABLE_FRAMING=1 to zero the effect when
 * MLB's ABS challenge system goes full-season.
 */

const SAVANT_FRAMING_URL =
  "https://baseballsavant.mlb.com/leaderboard/catcher_framing";

const UA = process.env.MLB_USER_AGENT || "nrsi-app/0.1";

export type FramingRow = {
  catcherId: number;
  /** Strikes added vs an average catcher on the same pitches (season total). */
  strikesAdded: number;
  /** Total called pitches (denominator for shrinkage). */
  calledPitches: number;
};

export type FramingTable = Map<number, FramingRow>;

/** Empirical-Bayes prior strength in called pitches. League mean = 0. */
const SHRINK_N0 = 2000;

/**
 * Per-strike-added-per-pitch impact on the K and BB rates relative to neutral.
 * From FanGraphs / Baseball Prospectus framing-runs research, roughly 0.13
 * runs per stolen strike, distributed across K bumps and BB suppressions.
 *
 * In rate terms a top framer (+20 strikes / ~9000 pitches = +0.0022 strikes/pitch)
 * shifts K-rate by ~+1.5pp and BB-rate by ~-0.7pp. Multiplier coefficients are
 * tuned so that a +0.005 strikes/pitch (≈ extreme top of league) maps to
 * ~+5% K and -5% BB — the boundary of our clamp.
 */
const K_MULT_PER_RATE = 10.0;   // 0.005 × 10 = +0.05
const BB_MULT_PER_RATE = -8.0;  // 0.005 × -8 = -0.04

const FACTOR_CLAMP_LO = 0.95;
const FACTOR_CLAMP_HI = 1.05;

function num(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

async function scrapeFraming(season: number): Promise<FramingTable> {
  const url = `${SAVANT_FRAMING_URL}?year=${season}&min=q`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html" },
  });
  if (!res.ok) throw new Error(`Savant framing HTTP ${res.status}`);
  const html = await res.text();
  return parseFramingHtml(html);
}

export function parseFramingHtml(html: string): FramingTable {
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
  const out = new Map<number, FramingRow>();
  for (const row of data) {
    const r = row as Record<string, unknown>;
    const catcherId = num(r.entity_id ?? r.player_id ?? r.id ?? r.catcher_id);
    const strikesAdded = num(
      r.runs_extra_strikes ?? r.strikes_added ?? r.strikes_above_average ?? r.framing_strikes,
    );
    const called = num(
      r.called_pitches ?? r.n_called_pitches ?? r.framing_attempts ?? r.attempts,
    ) ?? 0;
    if (catcherId === null || strikesAdded === null) continue;
    out.set(catcherId, { catcherId, strikesAdded, calledPitches: called });
  }
  return out;
}

export async function loadFramingTable(season: number): Promise<FramingTable> {
  const arr = await cacheJson<Array<[number, FramingRow]>>(
    k.framing(season),
    60 * 60 * 24,
    async () => {
      try {
        const table = await scrapeFraming(season);
        return Array.from(table.entries());
      } catch (e) {
        log.warn("framing", "scrape:failed", { season, err: String(e) });
        return [];
      }
    },
  );
  return new Map(arr);
}

/** Empirical-Bayes shrinkage toward the league mean (≈ 0 strikes added). */
function shrinkFraming(row: FramingRow | undefined): { strikesPerPitch: number } {
  if (!row || row.calledPitches <= 0) return { strikesPerPitch: 0 };
  const n = row.calledPitches;
  // Shrunken total strikes added in expectation.
  const shrunkTotal = (n * row.strikesAdded) / (n + SHRINK_N0);
  return { strikesPerPitch: shrunkTotal / n };
}

export const NEUTRAL_FRAMING_FACTORS = { k: 1, bb: 1 } as const;

/**
 * Build the K and BB multipliers for a given catcher. A top framer pushes
 * K up and BB down; a bad framer does the opposite. Multipliers are clamped
 * to [0.95, 1.05] to bound a single-source signal.
 *
 * If the framing table is empty (scrape failed) or the catcher is unknown,
 * returns identity factors so the multinomial is unchanged.
 */
export function framingFactors(
  catcherId: number | null,
  table: FramingTable,
): { k: number; bb: number } {
  if (process.env.NRSI_DISABLE_FRAMING === "1") {
    return { ...NEUTRAL_FRAMING_FACTORS };
  }
  if (catcherId === null || table.size === 0) {
    return { ...NEUTRAL_FRAMING_FACTORS };
  }
  const { strikesPerPitch } = shrinkFraming(table.get(catcherId));
  const k = clamp(1 + strikesPerPitch * K_MULT_PER_RATE, FACTOR_CLAMP_LO, FACTOR_CLAMP_HI);
  const bb = clamp(1 + strikesPerPitch * BB_MULT_PER_RATE, FACTOR_CLAMP_LO, FACTOR_CLAMP_HI);
  return { k, bb };
}

// Internal helpers exported for tests.
export const __testing = { shrinkFraming, SHRINK_N0, K_MULT_PER_RATE, BB_MULT_PER_RATE };
