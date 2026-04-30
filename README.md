# NRSI

Live MLB **No-Run-Scoring-Inning** probability board. Every active game gets a half-inning-by-half-inning estimate of the chance no run scores, plus the minimum American odds at which a "no run" bet is positive-EV.

Built on Next.js 16 (App Router + Cache Components), Vercel Workflow DevKit, and Upstash Redis.

## What you see

- All MLB games for the day, **active games at the top**
- Per-card: teams, score, current inning + half + outs, current pitcher (R/L), upcoming batter chips with per-batter `P(reach)` percentages, and a footer with `P(NRSI)` and **break-even American odds**
- **Decision-moment cards highlighted** in amber: end-of-half-inning, or top-of-inning with 0 outs (the windows where a "no run this inning" bet is being priced)
- **Drill-down at `/games/{gamePk}`** for the full upcoming lineup table with each batter's reach probability
- Live updates pushed via **SSE** as watchers detect inning transitions

## Tech stack

| Piece | Choice | Why |
|---|---|---|
| Framework | Next.js 16 App Router | Cache Components for partial pre-render |
| Workflows | Vercel Workflow DevKit | Durable per-game pollers that survive restarts |
| Cache / pubsub | Upstash Redis (REST) | Marketplace integration, no TCP connection limits |
| Styling | Tailwind v4 | `@theme` tokens, dark-by-default |
| Tests | Vitest | 24 unit tests covering the math |

## Quick start (local dev)

```bash
# 1. Clone and install
git clone https://github.com/kevinzhang019/nrsi-app.git
cd nrsi-app
npm install

# 2. Link the project to Vercel and pull production env vars
vercel link
vercel env pull .env.local

# 3. Run dev server
npm run dev
# → http://localhost:3000
```

The `.env.local` will contain `KV_REST_API_URL` / `KV_REST_API_TOKEN` from the Marketplace Upstash integration. Without those the app boots but Redis-backed routes will throw on first call.

## Deploy

```bash
# Deploy to production
vercel deploy --prod

# Manually kick off the daily scheduler (cron also fires this at 13:00 UTC)
vercel curl /api/cron/start-day

# Watch workflow runs
npx workflow web --backend vercel --project nrsi-app --team kevinzhang019s-projects

# Tail runtime logs
vercel logs <deployment-url>
```

The cron in `vercel.ts` fires `GET /api/cron/start-day` daily at 13:00 UTC. That kicks off `schedulerWorkflow`, which spawns one durable `gameWatcherWorkflow` per game ~5 minutes before first pitch.

## Project structure

```
app/                  Next.js App Router pages, API routes, SSE
components/           Client components (game-board, card, decision-card)
lib/
  mlb/                Stats API client, types, lineup logic
  prob/               Pure math: pReach, inning DP, American odds
  env/                Park (Baseball Savant) + weather (covers.com) factors
  cache/              Upstash client + key conventions
  pubsub/             Snapshot publisher + subscriber iterator
  state/              Canonical GameState type
  hooks/              Client React hooks (useGameStream)
workflows/            Vercel Workflow DevKit: scheduler, game-watcher, steps
docs/                 Architecture + probability model deep dives
```

## Useful commands

| Command | What it does |
|---|---|
| `npm run dev` | Local Next.js dev server |
| `npm run build` | Production build (Turbopack, Cache Components) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Run all unit tests (Vitest) |
| `npm run workflow:web` | Open Workflow runs UI for the linked project |
| `vercel curl /api/snapshot` | Hit production-protected snapshot endpoint |
| `vercel curl /api/cron/start-day` | Manually trigger the daily scheduler |
| `npx workflow inspect runs --backend vercel ...` | List workflow runs |
| `npx workflow cancel <runId> --backend vercel ...` | Cancel a stuck run |

## Links

- **Production:** https://nrsi-app.vercel.app (Vercel SSO required)
- **GitHub:** https://github.com/kevinzhang019/nrsi-app
- **Vercel project:** kevinzhang019s-projects/nrsi-app

## How it works (in 5 lines)

A daily cron triggers `schedulerWorkflow`. For each scheduled game, the scheduler sleeps until 5 minutes before first pitch, then spawns a `gameWatcherWorkflow`. Each watcher holds a Redis lock (one watcher per `gamePk`, ever), polls the MLB live feed via the lightweight `diffPatch` endpoint, recomputes `P(NRSI)` on every half-inning transition, and publishes a `GameState` to a Redis snapshot hash. The `/api/stream` SSE route polls that snapshot hash and pushes diffs to all connected browsers.

Full diagram and per-component description in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Probability model (in 5 lines)

For each upcoming batter, compute `pReach = (batter's OBP vs pitcher's hand + pitcher's WHIP/3.5 evaluated against batter's hand) / 2`, then multiply by park (Baseball Savant runs index) and weather (covers.com — temp, wind, precip) factors. Switch hitters use the **higher** of both pitcher splits and **higher** of both batter OBPs (intentionally generous). A small Bayesian DP over `(outs, reaches_so_far)` walks the upcoming order forward, terminating at 3 outs, returning `P(>=2 batters reach)`. The complement is `P(NRSI)`. American break-even odds = `q ≥ 0.5 → -100·q/(1-q)`, else `+100·(1-q)/q`.

Math derivations, file references, and calibration caveats in **[docs/PROBABILITY_MODEL.md](docs/PROBABILITY_MODEL.md)**.

## For Claude / agents

If you're an AI agent picking up this codebase: start with **[CLAUDE.md](CLAUDE.md)** before touching any code. It logs the five non-obvious bugs we already hit and the gotchas for Workflow DevKit, Cache Components, Upstash JSON auto-parsing, and the MLB Stats API.
