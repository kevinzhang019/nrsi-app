import { loadBatterPaProfile, loadPitcherPaProfile } from "@/lib/mlb/splits";
import { log } from "@/lib/log";
import type { BatterPaProfile, PitcherPaProfile } from "@/lib/mlb/splits";

export async function loadLineupSplitsStep(opts: {
  gamePk: number;
  pitcherId: number;
  batterIds: number[];
}): Promise<{ pitcher: PitcherPaProfile; batters: BatterPaProfile[] }> {
  const { gamePk, pitcherId, batterIds } = opts;
  log.info("step", "loadLineupSplits:start", { gamePk, pitcherId, n: batterIds.length });
  const [pitcher, ...batters] = await Promise.all([
    loadPitcherPaProfile(pitcherId),
    ...batterIds.map((id) => loadBatterPaProfile(id)),
  ]);
  log.info("step", "loadLineupSplits:ok", { gamePk });
  return { pitcher, batters };
}
