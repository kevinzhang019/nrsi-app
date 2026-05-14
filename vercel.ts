import type { VercelConfig } from "@vercel/config/v1";

// Vercel project config — frontend only. The watcher cron lives on Railway
// (see railway.toml). Re-adding `crons` here would re-fire the WDK scheduler
// (deleted in Phase D) and burn the Functions cap; Railway is the source of
// truth for scheduled work now.
//
// `functions` memory ceilings: Vercel default is 2048 MB. nrXi routes do thin
// Redis/Supabase reads + RSC render — 512 MB is plenty with cold-start
// headroom. /api/stream is an SSE endpoint held open ~290s per connection;
// memory × wall-time dominates its bill, so it gets the lowest tier.
export const config: VercelConfig = {
  framework: "nextjs",
  functions: {
    "app/**/*": { memory: 512 },
    "app/api/stream/route.ts": { memory: 256, maxDuration: 300 },
  },
};
