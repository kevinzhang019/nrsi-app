import { pAtLeastOneRun, type Bases, type GameState } from "@/lib/prob/markov";
import { matchupPa, applyEnv } from "@/lib/prob/log5";
import { applyTtop } from "@/lib/prob/ttop";
import { applyDefense } from "@/lib/prob/defense";
import { applyFraming } from "@/lib/prob/framing";
import { LEAGUE_PA, type BatterPaProfile, type PaOutcomes, type PitcherPaProfile } from "@/lib/mlb/splits";
import type { ParkComponentFactors } from "@/lib/env/park";
import type { WeatherComponentFactors } from "@/lib/env/weather";
import { defenseFactor, type OaaTable } from "@/lib/env/defense";
import { framingFactors, type FramingTable } from "@/lib/env/framing";
import { effectiveBatterStance } from "@/lib/prob/log5";
import { calibrate } from "@/lib/prob/calibration";
import { americanBreakEven, roundOdds } from "@/lib/prob/odds";
import { log } from "@/lib/log";
import type { HandCode } from "@/lib/mlb/types";

export type NrsiPerBatter = {
  id: number;
  name: string;
  bats: HandCode;
  /** OBP-equivalent for display continuity with v1: 1 - k - ipOut. */
  pReach: number;
  /** Per-PA outcome distribution after Log5 + env + TTOP + framing + defense. */
  pa: PaOutcomes;
};

export type NrsiResult = {
  pHitEvent: number; // P(≥1 run) — name kept for back-compat
  pNoHitEvent: number; // P(NRSI)
  breakEvenAmerican: number;
  startState: GameState;
  perBatter: NrsiPerBatter[];
};

export async function computeNrsiStep(opts: {
  gamePk: number;
  pitcher: PitcherPaProfile;
  batters: BatterPaProfile[];
  park: ParkComponentFactors;
  weather: WeatherComponentFactors;
  startState: GameState;
  paInGameForPitcher: number;
  // v2.1 — optional. When tables/ids are missing the step degrades to v2 behavior.
  oaaTable?: OaaTable;
  framingTable?: FramingTable;
  catcherId?: number | null;
  fielderIds?: number[]; // 7 non-battery fielders
}): Promise<NrsiResult> {
  "use step";
  const {
    gamePk,
    pitcher,
    batters,
    park,
    weather,
    startState,
    paInGameForPitcher,
    oaaTable,
    framingTable,
    catcherId,
    fielderIds,
  } = opts;

  log.info("step", "computeNrsi:start", {
    gamePk,
    pitcherId: pitcher.id,
    n: batters.length,
    startOuts: startState.outs,
    startBases: startState.bases,
    ttoStart: paInGameForPitcher,
    catcherId: catcherId ?? null,
    nFielders: fielderIds?.length ?? 0,
  });

  // Pre-compute the two v2.1 factors once per inning recompute (constant across batters).
  const framingF = framingTable ? framingFactors(catcherId ?? null, framingTable) : { k: 1, bb: 1 };
  const defenseF =
    oaaTable && fielderIds && fielderIds.length > 0
      ? defenseFactor(fielderIds, oaaTable)
      : 1.0;

  const perBatter: NrsiPerBatter[] = [];
  const lineup: PaOutcomes[] = [];

  for (let i = 0; i < batters.length; i++) {
    const b = batters[i];
    const stance = effectiveBatterStance(b.bats, pitcher.throws);
    const matchup = matchupPa(b, pitcher, LEAGUE_PA);
    const enved = applyEnv(matchup, park, weather, stance);
    const ttoAdjusted = applyTtop(enved, paInGameForPitcher + i);
    const framed = applyFraming(ttoAdjusted, framingF);
    const defended = applyDefense(framed, defenseF);
    lineup.push(defended);
    perBatter.push({
      id: b.id,
      name: b.fullName,
      bats: b.bats,
      pReach: 1 - defended.k - defended.ipOut,
      pa: defended,
    });
  }

  const rawPHit = pAtLeastOneRun(startState, lineup);
  const pHit = calibrate(rawPHit);
  const pNo = 1 - pHit;

  const result: NrsiResult = {
    pHitEvent: pHit,
    pNoHitEvent: pNo,
    breakEvenAmerican: roundOdds(americanBreakEven(pNo)),
    startState,
    perBatter,
  };

  log.info("step", "computeNrsi:ok", {
    gamePk,
    pHit,
    pNo,
    odds: result.breakEvenAmerican,
    startOuts: startState.outs,
    startBases: startState.bases,
    ttoStart: paInGameForPitcher,
    framingK: framingF.k,
    framingBB: framingF.bb,
    defenseFactor: defenseF,
  });

  return result;
}
