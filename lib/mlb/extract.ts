import type { LiveFeed, BoxscorePlayer, HandCode } from "./types";

export type LineupEntry = {
  id: number;
  name: string;
  // null when the boxscore omits batSide; the watcher hydrates this from
  // /people/{id} via enrichLineupHandsStep before publishing.
  bats: HandCode | null;
  position: string;
};

export type LineupSlot = {
  spot: number;            // 1..9 lineup position
  starter: LineupEntry;
  subs: LineupEntry[];     // in chronological order subbed in (by sub index)
};

export type TeamLineup = LineupSlot[];

export type Linescore = {
  innings: Array<{
    num: number;
    away: { runs: number | null; hits: number | null; errors: number | null };
    home: { runs: number | null; hits: number | null; errors: number | null };
  }>;
  totals: {
    away: { R: number; H: number; E: number };
    home: { R: number; H: number; E: number };
  };
};

function entryFrom(p: BoxscorePlayer): LineupEntry | null {
  if (!p.person?.id) return null;
  return {
    id: p.person.id,
    name: p.person.fullName ?? `#${p.person.id}`,
    bats: (p.batSide?.code as HandCode | undefined) ?? null,
    position: p.position?.abbreviation ?? "",
  };
}

function buildLineup(players: Record<string, BoxscorePlayer> | undefined): TeamLineup | null {
  if (!players) return null;
  // Group by lineup spot. battingOrder is a string like "100", "101", etc.
  // Hundreds digit = lineup spot (1-9). Last two digits = sub index (00 starter, 01 first sub, 02 second sub, …).
  const bySlot = new Map<number, Array<{ subIdx: number; entry: LineupEntry }>>();
  for (const p of Object.values(players)) {
    if (!p.battingOrder) continue;
    const code = parseInt(p.battingOrder, 10);
    if (!Number.isFinite(code)) continue;
    const spot = Math.floor(code / 100);
    const subIdx = code % 100;
    if (spot < 1 || spot > 9) continue;
    const entry = entryFrom(p);
    if (!entry) continue;
    if (!bySlot.has(spot)) bySlot.set(spot, []);
    bySlot.get(spot)!.push({ subIdx, entry });
  }
  if (bySlot.size === 0) return null;
  const slots: LineupSlot[] = [];
  for (let spot = 1; spot <= 9; spot++) {
    const arr = bySlot.get(spot);
    if (!arr || arr.length === 0) continue;
    arr.sort((a, b) => a.subIdx - b.subIdx);
    const [starter, ...subs] = arr;
    slots.push({
      spot,
      starter: starter.entry,
      subs: subs.map((s) => s.entry),
    });
  }
  return slots.length === 9 ? slots : slots.length > 0 ? slots : null;
}

export function extractLineups(feed: LiveFeed): { away: TeamLineup | null; home: TeamLineup | null } {
  const teams = feed.liveData.boxscore?.teams;
  return {
    away: buildLineup(teams?.away.players),
    home: buildLineup(teams?.home.players),
  };
}

export function extractLinescore(feed: LiveFeed): Linescore {
  const ls = feed.liveData.linescore;
  const innings = (ls.innings ?? []).map((i) => ({
    num: i.num ?? 0,
    away: {
      runs: i.away?.runs ?? null,
      hits: i.away?.hits ?? null,
      errors: i.away?.errors ?? null,
    },
    home: {
      runs: i.home?.runs ?? null,
      hits: i.home?.hits ?? null,
      errors: i.home?.errors ?? null,
    },
  }));
  return {
    innings,
    totals: {
      away: {
        R: ls.teams?.away.runs ?? 0,
        H: ls.teams?.away.hits ?? 0,
        E: ls.teams?.away.errors ?? 0,
      },
      home: {
        R: ls.teams?.home.runs ?? 0,
        H: ls.teams?.home.hits ?? 0,
        E: ls.teams?.home.errors ?? 0,
      },
    },
  };
}

/**
 * Identify the current batter (for the team batting now) and the leadoff
 * batter for the next half-inning (the team coming up). The card UI uses
 * these to highlight rows in each lineup.
 */
export function extractBatterFocus(feed: LiveFeed): {
  battingTeam: "home" | "away" | null;
  currentBatterId: number | null;
  nextHalfLeadoffId: number | null;
} {
  const ls = feed.liveData.linescore;
  const bx = feed.liveData.boxscore;
  if (!ls || !bx) return { battingTeam: null, currentBatterId: null, nextHalfLeadoffId: null };

  const isTop = ls.isTopInning ?? true;
  const outs = ls.outs ?? 0;
  const inningState = (ls.inningState || "").toLowerCase();
  const halfOver = inningState === "middle" || inningState === "end" || outs >= 3;

  const battingTeam: "home" | "away" = halfOver
    ? isTop
      ? "home"
      : "away"
    : isTop
    ? "away"
    : "home";
  const otherTeam = battingTeam === "home" ? "away" : "home";

  // Current batter for the team batting now.
  let currentBatterId: number | null = null;
  if (halfOver) {
    // Leadoff for the next half — pull from offense.battingOrder if present.
    const order = bx.teams[battingTeam].battingOrder ?? [];
    const spot = (ls.offense?.battingOrder ?? 0) % 9;
    currentBatterId = order[spot] ?? order[0] ?? null;
  } else {
    currentBatterId = ls.offense?.batter?.id ?? null;
  }

  // Next-half leadoff for the OTHER team.
  const otherOrder = bx.teams[otherTeam].battingOrder ?? [];
  // We don't know exactly where they left off without more state, so default
  // to the next batter in their order; if MLB feed exposes per-team offense
  // state we'd use it here. For now, leadoff = order[0] when the team hasn't
  // batted yet, otherwise null (we'll just highlight the last known batter).
  const nextHalfLeadoffId = otherOrder[0] ?? null;

  return { battingTeam, currentBatterId, nextHalfLeadoffId };
}
