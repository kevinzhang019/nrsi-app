#!/usr/bin/env node
// Railway "web" service entry point. Always-on, separate from the cron
// supervisor (bin/supervisor.ts). Hosts the SSE stream, snapshot JSON, and
// history read endpoints that were previously Vercel Fluid Compute functions
// — Vercel's per-request provisioned-memory billing made the long-lived
// /api/stream connection prohibitively expensive at our viewership scale.
//
// Configured on the Railway dashboard as a separate service pointing at the
// same repo with startCommand `npx tsx bin/web.ts` and restartPolicy=ALWAYS.

// MUST be the first import — loads .env.local for local-dev runs before any
// module reads process.env. Production (Railway) has no file and the loader
// no-ops.
import "../services/lib/load-env";
import { buildServer } from "../services/web/server";
import { log } from "../lib/log";

const port = Number(process.env.PORT || 3001);
const server = buildServer();

server.listen(port, () => {
  log.info("bin/web", "listening", { port });
});

let shuttingDown = false;
function shutdown(sig: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.warn("bin/web", "signal", { sig });
  server.close(() => process.exit(0));
  // Force-exit if open SSE connections refuse to drain within 10s.
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
