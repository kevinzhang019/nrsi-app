import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { log } from "@/lib/log";
import { handleStream } from "./handlers/stream";
import { handleSnapshot } from "./handlers/snapshot";
import { handleHistoryDates, handleHistoryGame, handleHistoryGames } from "./handlers/history";

// Origins that are allowed to open an EventSource or call the JSON endpoints
// directly from a browser. Server-to-server fetches (no Origin header) get a
// wildcard so RSC fetches from Vercel work without a per-region allow-list.
//
// Override via `NRXI_ALLOWED_ORIGINS` (comma-separated) for preview deploys.
const DEFAULT_ORIGINS = [
  "https://nrsi-app.vercel.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

function allowedOrigins(): Set<string> {
  const raw = process.env.NRXI_ALLOWED_ORIGINS;
  if (!raw) return new Set(DEFAULT_ORIGINS);
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function setCors(req: IncomingMessage, res: ServerResponse, origins: Set<string>): void {
  const origin = req.headers.origin;
  if (typeof origin === "string" && origins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else if (!origin) {
    // No Origin header → not a browser request. Server-to-server fetches
    // (RSC) and curl land here. Wildcard is safe because no credentials.
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Vary", "Origin");
}

function notFound(res: ServerResponse): void {
  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain");
  res.end("Not Found\n");
}

export function buildServer(): Server {
  const origins = allowedOrigins();

  return createServer(async (req, res) => {
    if (!req.url || !req.method) {
      notFound(res);
      return;
    }

    setCors(req, res, origins);

    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Max-Age", "86400");
      res.statusCode = 204;
      res.end();
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    } catch {
      notFound(res);
      return;
    }
    const path = url.pathname;

    try {
      if (path === "/healthz" && req.method === "GET") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain");
        res.end("ok\n");
        return;
      }

      if (path === "/stream" && req.method === "GET") {
        await handleStream(req, res);
        return;
      }

      if (path === "/snapshot" && req.method === "GET") {
        await handleSnapshot(res);
        return;
      }

      if (path === "/history/dates" && req.method === "GET") {
        await handleHistoryDates(res);
        return;
      }

      if (path === "/history/games" && req.method === "GET") {
        const date = url.searchParams.get("date") ?? "";
        await handleHistoryGames(res, date);
        return;
      }

      const m = /^\/history\/game\/(\d+)$/.exec(path);
      if (m && req.method === "GET") {
        await handleHistoryGame(res, Number(m[1]));
        return;
      }

      notFound(res);
    } catch (err) {
      log.error("web/server", "unhandled", { path, err: String(err) });
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "internal" }));
      } else {
        try {
          res.end();
        } catch {
          /* */
        }
      }
    }
  });
}
