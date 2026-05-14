import type { VercelConfig } from "@vercel/config/v1";

// Vercel project config — frontend only. The watcher cron lives on Railway
// (see railway.toml). Re-adding `crons` here would re-fire the WDK scheduler
// (deleted in Phase D) and burn the Functions cap; Railway is the source of
// truth for scheduled work now.
//
// SSE + snapshot JSON + history reads previously lived in app/api/* and are
// now hosted on a separate always-on Railway "web" service (bin/web.ts).
// Vercel's per-request provisioned-memory billing made long-lived /api/stream
// connections (256 MB × ~290s held open) the dominant memory-time cost. The
// client EventSource and history-page RSC fetches go straight to the Railway
// host via NEXT_PUBLIC_NRXI_API_BASE / NRXI_API_BASE env vars.
//
// `functions` memory ceiling: Vercel default is 2048 MB. nrXi routes now do
// thin RSC renders + at most one Redis/HTTP read — 512 MB has plenty of
// cold-start headroom.
export const config: VercelConfig = {
  framework: "nextjs",
  functions: {
    "app/**/*": { memory: 512 },
  },
};
