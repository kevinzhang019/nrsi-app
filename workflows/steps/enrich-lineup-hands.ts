import { loadHand } from "@/lib/mlb/splits";
import { log } from "@/lib/log";
import type { TeamLineup } from "@/lib/mlb/extract";
import type { HandCode } from "@/lib/mlb/types";

type Lineups = { away: TeamLineup | null; home: TeamLineup | null };

function collectIds(lineups: Lineups): number[] {
  const ids = new Set<number>();
  for (const team of [lineups.away, lineups.home]) {
    if (!team) continue;
    for (const slot of team) {
      ids.add(slot.starter.id);
      for (const sub of slot.subs) ids.add(sub.id);
    }
  }
  return [...ids];
}

function applyHands(lineup: TeamLineup | null, hands: Map<number, HandCode>): TeamLineup | null {
  if (!lineup) return null;
  return lineup.map((slot) => ({
    spot: slot.spot,
    starter: { ...slot.starter, bats: hands.get(slot.starter.id) ?? slot.starter.bats },
    subs: slot.subs.map((s) => ({ ...s, bats: hands.get(s.id) ?? s.bats })),
  }));
}

export async function enrichLineupHandsStep(opts: {
  gamePk: number;
  lineups: Lineups;
}): Promise<Lineups> {
  "use step";
  const { gamePk, lineups } = opts;
  const ids = collectIds(lineups);
  log.info("step", "enrichLineupHands:start", { gamePk, n: ids.length });
  if (ids.length === 0) return lineups;

  const results = await Promise.all(
    ids.map((id) =>
      loadHand(id).then(
        (h) => ({ id, bats: h.bats as HandCode }),
        (e) => {
          log.warn("step", "enrichLineupHands:loadHand:fail", { gamePk, id, err: String(e) });
          return null;
        },
      ),
    ),
  );

  const hands = new Map<number, HandCode>();
  for (const r of results) if (r) hands.set(r.id, r.bats);

  log.info("step", "enrichLineupHands:ok", { gamePk, hydrated: hands.size });
  return {
    away: applyHands(lineups.away, hands),
    home: applyHands(lineups.home, hands),
  };
}
