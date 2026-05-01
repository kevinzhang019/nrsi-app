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

export type LiveFeed = {
  metaData: { timeStamp: string; wait?: number };
  gameData: {
    status: { abstractGameState: string; detailedState?: string; codedGameState?: string };
    teams: { away: { id: number; name: string }; home: { id: number; name: string } };
    venue?: { id: number; name: string };
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
      defense?: { pitcher?: { id: number } };
      teams?: { home: { runs: number }; away: { runs: number } };
    };
    boxscore?: {
      teams: {
        away: {
          battingOrder?: number[];
          pitchers?: number[];
          players?: Record<string, { stats?: { pitching?: { battersFaced?: number } } }>;
        };
        home: {
          battingOrder?: number[];
          pitchers?: number[];
          players?: Record<string, { stats?: { pitching?: { battersFaced?: number } } }>;
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
