import { loadOaaTable, type OaaTable } from "@/lib/env/defense";
import { loadFramingTable, type FramingTable } from "@/lib/env/framing";
import { log } from "@/lib/log";

export async function loadDefenseStep(opts: {
  gamePk: number;
  season: number;
}): Promise<{ oaaTable: OaaTable; framingTable: FramingTable }> {
  const { gamePk, season } = opts;
  log.info("step", "loadDefense:start", { gamePk, season });
  const [oaaTable, framingTable] = await Promise.all([
    loadOaaTable(season),
    loadFramingTable(season),
  ]);
  log.info("step", "loadDefense:ok", {
    gamePk,
    oaaCount: oaaTable.size,
    framingCount: framingTable.size,
  });
  return { oaaTable, framingTable };
}
