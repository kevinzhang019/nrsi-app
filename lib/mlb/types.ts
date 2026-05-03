import { z } from "zod";

export const HandCode = z.enum(["L", "R", "S"]);
export type HandCode = z.infer<typeof HandCode>;
export const PitchHand = z.enum(["L", "R"]);
export type PitchHand = z.infer<typeof PitchHand>;

export const ScheduleGame = z.object({
  gamePk: z.number(),
  gameDate: z.string(),
  status: z.object({
    abstractGameState: z.string(),
    detailedState: z.string().optional(),
    codedGameState: z.string().optional(),
  }),
  teams: z.object({
    away: z.object({
      team: z.object({ id: z.number(), name: z.string() }),
      probablePitcher: z.object({ id: z.number(), fullName: z.string() }).optional(),
      score: z.number().optional(),
    }),
    home: z.object({
      team: z.object({ id: z.number(), name: z.string() }),
      probablePitcher: z.object({ id: z.number(), fullName: z.string() }).optional(),
      score: z.number().optional(),
    }),
  }),
  venue: z.object({ id: z.number(), name: z.string() }).optional(),
  linescore: z
    .object({
      currentInning: z.number().optional(),
      isTopInning: z.boolean().optional(),
      inningHalf: z.string().optional(),
    })
    .optional(),
});
export type ScheduleGame = z.infer<typeof ScheduleGame>;

export const ScheduleResponse = z.object({
  dates: z.array(
    z.object({
      date: z.string(),
      games: z.array(ScheduleGame),
    }),
  ),
});

export const PersonResponse = z.object({
  people: z.array(
    z.object({
      id: z.number(),
      fullName: z.string(),
      batSide: z.object({ code: HandCode }).optional(),
      pitchHand: z.object({ code: PitchHand }).optional(),
    }),
  ),
});

export const SplitsResponse = z.object({
  stats: z
    .array(
      z.object({
        splits: z.array(
          z.object({
            split: z.object({ code: z.string(), description: z.string().optional() }),
            stat: z
              .object({
                obp: z.union([z.string(), z.number()]).optional(),
                whip: z.union([z.string(), z.number()]).optional(),
                avg: z.union([z.string(), z.number()]).optional(),
                ops: z.union([z.string(), z.number()]).optional(),
              })
              .passthrough(),
          }),
        ),
      }),
    )
    .default([]),
});

export type BoxscorePlayer = {
  person?: { id: number; fullName?: string };
  position?: { abbreviation?: string; code?: string };
  // String like "100" (starter at slot 1), "101" (first sub at slot 1),
  // "102" (second sub at slot 1), "200" (starter at slot 2), etc.
  // Players who never batted may have it omitted.
  battingOrder?: string;
  battingOrderSlot?: number;
  batSide?: { code?: HandCode };
  stats?: { pitching?: { battersFaced?: number; numberOfPitches?: number } };
  // MLB returns season ERA/WHIP as strings (e.g. "3.42", "1.18").
  seasonStats?: {
    pitching?: { era?: string; whip?: string };
  };
};

// Subset of `liveData.plays.allPlays[]` we consume. Plain TS, no zod — same
// trust convention as the rest of LiveFeed. Anything we read in
// lib/history/build-plays.ts goes here; everything else stays on `raw`.
export type PlayDoc = {
  about?: {
    atBatIndex?: number;
    inning?: number;
    halfInning?: string; // 'top' | 'bottom'
    isComplete?: boolean;
  };
  matchup?: {
    batter?: { id?: number; fullName?: string };
    pitcher?: { id?: number; fullName?: string };
    batSide?: { code?: HandCode };
    pitchHand?: { code?: PitchHand };
  };
  result?: {
    event?: string;
    eventType?: string;
    rbi?: number;
    awayScore?: number;
    homeScore?: number;
  };
  count?: { outs?: number };
  runners?: Array<{
    details?: { runner?: { id?: number } };
    movement?: { end?: string | null };
  }>;
};

export type LiveFeed = {
  metaData: { timeStamp: string; wait?: number };
  gameData: {
    status: { abstractGameState: string; detailedState?: string; codedGameState?: string };
    teams: { away: { id: number; name: string }; home: { id: number; name: string } };
    venue?: { id: number; name: string };
    // Live feed datetime block. `officialDate` is YYYY-MM-DD in venue-local
    // time — the canonical game-day MLB groups by, used as the history bucket
    // key. `dateTime` is the canonical UTC ISO start time.
    datetime?: { officialDate?: string; dateTime?: string };
  };
  liveData: {
    linescore: {
      currentInning?: number;
      inningHalf?: "Top" | "Bottom" | string;
      inningState?: string;
      isTopInning?: boolean;
      outs?: number;
      balls?: number;
      strikes?: number;
      offense?: {
        batter?: { id: number };
        onDeck?: { id: number };
        inHole?: { id: number };
        battingOrder?: number;
        first?: { id: number };
        second?: { id: number };
        third?: { id: number };
      };
      defense?: {
        pitcher?: { id: number };
        catcher?: { id: number };
        first?: { id: number };
        second?: { id: number };
        third?: { id: number };
        shortstop?: { id: number };
        left?: { id: number };
        center?: { id: number };
        right?: { id: number };
      };
      teams?: {
        home: { runs?: number; hits?: number; errors?: number; leftOnBase?: number };
        away: { runs?: number; hits?: number; errors?: number; leftOnBase?: number };
      };
      innings?: Array<{
        num?: number;
        ordinalNum?: string;
        home?: { runs?: number; hits?: number; errors?: number };
        away?: { runs?: number; hits?: number; errors?: number };
      }>;
    };
    boxscore?: {
      teams: {
        away: {
          battingOrder?: number[];
          pitchers?: number[];
          bench?: number[];
          bullpen?: number[];
          players?: Record<string, BoxscorePlayer>;
        };
        home: {
          battingOrder?: number[];
          pitchers?: number[];
          bench?: number[];
          bullpen?: number[];
          players?: Record<string, BoxscorePlayer>;
        };
      };
    };
    plays?: {
      currentPlay?: {
        about?: { atBatIndex?: number; halfInning?: string; inning?: number };
        matchup?: {
          batter?: { id: number };
          pitcher?: { id: number };
          batSide?: { code: HandCode };
          pitchHand?: { code: PitchHand };
        };
      };
      // Full game play log. Present on full feeds; we only consume it once
      // at the Final exit branch in services/run-watcher.ts so per-tick cost
      // is zero. Each completed plate appearance becomes one `plays` row.
      allPlays?: PlayDoc[];
    };
  };
};

export type GameStatus = "Pre" | "Live" | "Final" | "Delayed" | "Suspended" | "Other";

export function classifyStatus(detailed: string | undefined, abstract: string): GameStatus {
  const d = (detailed || "").toLowerCase();
  if (abstract === "Final") return "Final";
  if (d.includes("delay")) return "Delayed";
  if (d.includes("suspend") || d.includes("postpon")) return "Suspended";
  if (abstract === "Live") return "Live";
  if (abstract === "Preview") return "Pre";
  return "Other";
}
