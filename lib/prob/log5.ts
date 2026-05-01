import type { PaOutcomes, BatterPaProfile, PitcherPaProfile } from "../mlb/splits";
import type { HandCode, PitchHand } from "../mlb/types";
import type { ParkComponentFactors } from "../env/park";
import type { WeatherComponentFactors } from "../env/weather";

/** Switch-hitter rule. "actual" = canonical platoon (default). "max" = legacy v1 behavior. */
export type SwitchHitterRule = "actual" | "max";

const DEFAULT_SWITCH_RULE: SwitchHitterRule =
  (process.env.NRSI_SWITCH_HITTER_RULE as SwitchHitterRule | undefined) ?? "actual";

/**
 * Generalized multinomial Log5 (Hong, SABR Journal):
 *   P(E_i) = (b_i × p_i / l_i) / Σ_j (b_j × p_j / l_j)
 *
 * Each outcome rate is treated independently in the numerator, then renormalized
 * so the result sums to 1. This is the canonical sabermetric matchup formula —
 * it respects the asymmetry around the league mean that a simple arithmetic
 * average does not.
 *
 * Tango worked example for OBP (binary case):
 *   .400 batter vs .250 pitcher in .333 league → .308 (not .325 as a naive avg).
 */
export function log5Matchup(
  batter: PaOutcomes,
  pitcher: PaOutcomes,
  league: PaOutcomes,
): PaOutcomes {
  const keys = Object.keys(batter) as (keyof PaOutcomes)[];
  const raw = keys.map((key) => {
    const l = Math.max(league[key], 1e-6); // avoid div-by-zero on rare outcomes
    return (batter[key] * pitcher[key]) / l;
  });
  const sum = raw.reduce((a, b) => a + b, 0);
  const out = {} as PaOutcomes;
  keys.forEach((key, i) => {
    out[key] = sum > 0 ? raw[i] / sum : league[key];
  });
  return out;
}

/**
 * The actual stance a switch hitter takes against a given pitcher hand.
 * Switch hitters bat from the opposite side of the pitcher's throwing hand
 * (so they always have the platoon advantage). Non-switch hitters bat from
 * their fixed side regardless.
 */
export function effectiveBatterStance(
  batterBats: HandCode,
  pitcherThrows: PitchHand,
): "L" | "R" {
  if (batterBats === "S") return pitcherThrows === "R" ? "L" : "R";
  return batterBats;
}

/**
 * Resolve which side of the L/R split tables to read for both the batter and
 * the pitcher in this matchup.
 *
 * Note the different keying conventions:
 *   - batter.paVs.L = hitter's stats vs LHP (key = pitcher hand)
 *   - pitcher.paVs.L = pitcher's stats vs LHB (key = batter hand)
 *
 * So for non-switch hitters:
 *   batterSide = pitcher.throws       // hitter's stats vs that pitcher hand
 *   pitcherSide = batter.bats         // pitcher's stats vs that batter hand
 *
 * For switch hitters under "actual":
 *   batterSide = pitcher.throws       // his split table is keyed the same way
 *   pitcherSide = effectiveBatterStance (= opposite of pitcher hand)
 *
 * Under legacy "max", we pick whichever side gives the highest non-out rate
 * for the batter and the most permissive side for the pitcher — this mirrors
 * the v1 model's `Math.max` rule but applied to the multinomial.
 */
export function batterSideVs(
  batter: BatterPaProfile,
  pitcher: PitcherPaProfile,
  rule: SwitchHitterRule = DEFAULT_SWITCH_RULE,
): { batterSide: "L" | "R"; pitcherSide: "L" | "R" } {
  if (batter.bats === "S" && rule === "max") {
    const onBaseLikeL = 1 - batter.paVs.L.k - batter.paVs.L.ipOut;
    const onBaseLikeR = 1 - batter.paVs.R.k - batter.paVs.R.ipOut;
    const batterSide: "L" | "R" = onBaseLikeR >= onBaseLikeL ? "R" : "L";
    const pAllowL = 1 - pitcher.paVs.L.k - pitcher.paVs.L.ipOut;
    const pAllowR = 1 - pitcher.paVs.R.k - pitcher.paVs.R.ipOut;
    const pitcherSide: "L" | "R" = pAllowR >= pAllowL ? "R" : "L";
    return { batterSide, pitcherSide };
  }
  const stance = effectiveBatterStance(batter.bats, pitcher.throws);
  return { batterSide: pitcher.throws, pitcherSide: stance };
}

/**
 * Run Log5 for a specific batter–pitcher matchup using their per-handedness
 * profiles plus the league per-pitcher-hand rates. Returns the per-PA outcome
 * distribution for THIS plate appearance.
 */
export function matchupPa(
  batter: BatterPaProfile,
  pitcher: PitcherPaProfile,
  league: { L: PaOutcomes; R: PaOutcomes },
  rule: SwitchHitterRule = DEFAULT_SWITCH_RULE,
): PaOutcomes {
  const { batterSide, pitcherSide } = batterSideVs(batter, pitcher, rule);
  // The league baseline is keyed by pitcher hand (vs LHP / vs RHP averages).
  // Use the actual pitcher's hand as the league reference, regardless of the
  // batter side we ended up reading.
  return log5Matchup(batter.paVs[batterSide], pitcher.paVs[pitcherSide], league[pitcher.throws]);
}

/**
 * Apply park × weather environment multipliers to a per-PA distribution and
 * renormalize. Multipliers apply *before* renormalization so a 1.10× HR boost
 * steals mass from `ipOut` rather than inflating the absolute outcome sum.
 *
 * The batter handedness chooses which side of the park-component table to
 * read (parks favor LHB/RHB asymmetrically — Yankee Stadium short porch in
 * RF, Fenway green monster in LF, etc.).
 */
export function applyEnv(
  pa: PaOutcomes,
  park: ParkComponentFactors,
  weather: WeatherComponentFactors,
  batterStance: "L" | "R",
): PaOutcomes {
  const adj: PaOutcomes = {
    single: pa.single * park.single[batterStance] * weather.single,
    double: pa.double * park.double[batterStance] * weather.double,
    triple: pa.triple * park.triple[batterStance] * weather.triple,
    hr: pa.hr * park.hr[batterStance] * weather.hr,
    bb: pa.bb * park.bb[batterStance] * weather.bb,
    hbp: pa.hbp,
    k: pa.k * park.k[batterStance] * weather.k,
    ipOut: pa.ipOut,
  };
  const total =
    adj.single + adj.double + adj.triple + adj.hr + adj.bb + adj.hbp + adj.k + adj.ipOut;
  if (total <= 0) return pa;
  (Object.keys(adj) as (keyof PaOutcomes)[]).forEach((key) => {
    adj[key] = adj[key] / total;
  });
  return adj;
}
