import type { VercelConfig } from "@vercel/config/v1";

// Vercel project config — frontend only. The watcher cron lives on Railway
// (see railway.toml). Re-adding `crons` here would re-fire the WDK scheduler
// (deleted in Phase D) and burn the Functions cap; Railway is the source of
// truth for scheduled work now.
export const config: VercelConfig = {
  framework: "nextjs",
};
