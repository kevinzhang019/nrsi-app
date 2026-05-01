import { getParkRunFactor, getParkComponentFactors, type ParkComponentFactors } from "@/lib/env/park";
import { log } from "@/lib/log";

export async function loadParkFactorStep(opts: {
  gamePk: number;
  homeTeamName: string;
  season: number;
}): Promise<{ runFactor: number; components: ParkComponentFactors }> {
  "use step";
  const { gamePk, homeTeamName, season } = opts;
  log.info("step", "loadParkFactor:start", { gamePk, homeTeamName, season });
  const [runFactor, components] = await Promise.all([
    getParkRunFactor(homeTeamName, season),
    getParkComponentFactors(homeTeamName, season),
  ]);
  log.info("step", "loadParkFactor:ok", { gamePk, runFactor, hr: components.hr.R });
  return { runFactor, components };
}
