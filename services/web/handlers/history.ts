import type { ServerResponse } from "node:http";
import {
  getGame,
  getInningPredictions,
  listGameDates,
  listGamesByDate,
} from "@/lib/db/games";
import { getGamePlays } from "@/lib/db/plays";
import { isSupabaseConfigured } from "@/lib/db/supabase";

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  // Past-date history is effectively immutable; today's bucket changes as
  // sweepFinalize lands games. Short TTL is a fair trade for backend load.
  res.setHeader("Cache-Control", "public, max-age=10, s-maxage=10");
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ error: message }));
}

function checkConfig(res: ServerResponse): boolean {
  if (isSupabaseConfigured()) return true;
  sendError(res, 503, "Supabase not configured on this service");
  return false;
}

export async function handleHistoryDates(res: ServerResponse): Promise<void> {
  if (!checkConfig(res)) return;
  try {
    const dates = await listGameDates();
    send(res, 200, { dates });
  } catch (err) {
    sendError(res, 500, `listGameDates: ${String(err)}`);
  }
}

export async function handleHistoryGames(res: ServerResponse, date: string): Promise<void> {
  if (!checkConfig(res)) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    sendError(res, 400, "date must be YYYY-MM-DD");
    return;
  }
  try {
    const games = await listGamesByDate(date);
    send(res, 200, { games });
  } catch (err) {
    sendError(res, 500, `listGamesByDate: ${String(err)}`);
  }
}

export async function handleHistoryGame(res: ServerResponse, pk: number): Promise<void> {
  if (!checkConfig(res)) return;
  if (!Number.isFinite(pk) || pk <= 0) {
    sendError(res, 400, "pk must be a positive integer");
    return;
  }
  try {
    const [game, innings, plays] = await Promise.all([
      getGame(pk),
      getInningPredictions(pk),
      getGamePlays(pk),
    ]);
    if (!game) {
      sendError(res, 404, "game not found");
      return;
    }
    send(res, 200, { game, innings, plays });
  } catch (err) {
    sendError(res, 500, `getGame: ${String(err)}`);
  }
}
