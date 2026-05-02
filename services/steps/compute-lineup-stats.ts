import { matchupPa, applyEnv, effectiveBatterStance } from "@/lib/prob/log5";
import { applyTtop } from "@/lib/prob/ttop";
import { applyDefense } from "@/lib/prob/defense";
import { applyFraming } from "@/lib/prob/framing";
import { LEAGUE_PA, type BatterPaProfile, type PitcherPaProfile } from "@/lib/mlb/splits";
import type { ParkComponentFactors } from "@/lib/env/park";
import type { WeatherComponentFactors } from "@/lib/env/weather";
import { defenseFactor, type OaaTable } from "@/lib/env/defense";
import { framingFactors, type FramingTable } from "@/lib/env/framing";
import { xSlgFromPa } from "@/lib/prob/expected-stats";
import { log } from "@/lib/log";
import type { LineupBatterStat } from "@/lib/state/game-state";

/**
 * Compute display-only xOBP/xSLG for a lineup of batters vs a single pitcher,
 * applying the same per-PA pipeline as computeNrXiStep but skipping the Markov
 * chain. Used by the watcher to populate lineupStats for the "one team at a
 * time" view, where stats need to be available for all 9 starters of either
 * team — not just the upcoming half-inning.
 *
 * paInGameForPitcher is fixed at 0 (clean-slate display). The live at-bat-side
 * stats already capture true TTOP via the existing computeNrXiStep call.
 */
export async function computeLineupStatsStep(opts: {
  gamePk: number;
  pitcher: PitcherPaProfile;
  batters: BatterPaProfile[];
  park: ParkComponentFactors;
  weather: WeatherComponentFactors;
  oaaTable?: OaaTable;
  framingTable?: FramingTable;
  catcherId?: number | null;
  fielderIds?: number[];
}): Promise<Record<string, LineupBatterStat>> {
  const {
    gamePk,
    pitcher,
    batters,
    park,
    weather,
    oaaTable,
    framingTable,
    catcherId,
    fielderIds,
  } = opts;
  log.info("step", "computeLineupStats:start", {
    gamePk,
    pitcherId: pitcher.id,
    n: batters.length,
  });

  const framingF = framingTable ? framingFactors(catcherId ?? null, framingTable) : { k: 1, bb: 1 };
  const defenseF =
    oaaTable && fielderIds && fielderIds.length > 0
      ? defenseFactor(fielderIds, oaaTable)
      : 1.0;

  const out: Record<string, LineupBatterStat> = {};
  for (const b of batters) {
    const stance = effectiveBatterStance(b.bats, pitcher.throws);
    const matchup = matchupPa(b, pitcher, LEAGUE_PA);
    const enved = applyEnv(matchup, park, weather, stance);
    const ttoAdjusted = applyTtop(enved, 0);
    const framed = applyFraming(ttoAdjusted, framingF);
    const defended = applyDefense(framed, defenseF);
    out[String(b.id)] = {
      pReach: 1 - defended.k - defended.ipOut,
      xSlg: xSlgFromPa(defended),
    };
  }

  log.info("step", "computeLineupStats:ok", { gamePk, n: batters.length });
  return out;
}
