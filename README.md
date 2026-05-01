# nrXi

Live MLB **No-Run-Scoring-Inning** probability board. Every active game gets a half-inning-by-half-inning estimate of the chance no run scores, plus the minimum American odds at which a "no run" bet is positive-EV.

Built on Next.js 16 (App Router + Cache Components), Vercel Workflow DevKit, and Upstash Redis.

## What you see

- **Every MLB game for the day**, grouped into four sections in this order: **Highlighted → Active → Upcoming → Finished**. Empty sections are hidden. Cards smoothly fade between sections (via `motion`'s `AnimatePresence` + `layoutId`) when a game's state changes — most commonly when a decision moment starts or ends.
- Per-card: teams, score, current inning + half + outs, current pitcher (R/L), upcoming batter chips with per-batter `P(reach)` percentages, **a CAD-blueprint silhouette of the home park** (foul-line wedge + outfield wall, hairline stroke that turns green alongside the card's ring on decision moments), and a footer with `P(nrXi)` and **break-even American odds**
- **Decision-moment cards** (end-of-half-inning, or top-of-inning with 0 outs) are surfaced into the **Highlighted** section with a green ring — the windows where a "no run this inning" bet is being priced
- **Drill-down at `/games/{gamePk}`** for the full upcoming lineup table with each batter's reach probability
- Live updates pushed via **SSE** as watchers detect inning transitions; cards re-render in place without remount, so live data keeps flowing through any cross-section animation

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
git clone https://github.com/kevinzhang019/nrxi-app.git
cd nrxi-app
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
npx workflow web --backend vercel --project nrxi-app --team kevinzhang019s-projects

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
  parks/              Pre-built ballpark SVG path data (shapes.json + team→venueId map)
workflows/            Vercel Workflow DevKit: scheduler, game-watcher, steps
scripts/              One-off build scripts (build-park-shapes.mjs)
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
| `npm run build:park-shapes` | Refresh `lib/parks/shapes.json` from `bdilday/GeomMLBStadiums` (one-off; output is committed) |
| `vercel curl /api/snapshot` | Hit production-protected snapshot endpoint |
| `vercel curl /api/cron/start-day` | Manually trigger the daily scheduler |
| `npx workflow inspect runs --backend vercel ...` | List workflow runs |
| `npx workflow cancel <runId> --backend vercel ...` | Cancel a stuck run |

## Links

- **Production:** https://nrsi-app.vercel.app (Vercel SSO required)
- **GitHub:** https://github.com/kevinzhang019/nrxi-app
- **Vercel project:** kevinzhang019s-projects/nrxi-app

## How it works (in 5 lines)

A daily cron triggers `schedulerWorkflow`. For each scheduled game, the scheduler sleeps until 5 minutes before first pitch, then spawns a `gameWatcherWorkflow`. Each watcher holds a Redis lock (one watcher per `gamePk`, ever), polls the MLB live feed via the lightweight `diffPatch` endpoint, recomputes `P(nrXi)` on every half-inning transition, and publishes a `GameState` to a Redis snapshot hash. The `/api/stream` SSE route polls that snapshot hash and pushes diffs to all connected browsers.

Full diagram and per-component description in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Probability model (in 5 lines)

For each upcoming batter, build a per-PA outcome distribution `{1B, 2B, 3B, HR, BB, HBP, K, ipOut}` via **generalized multinomial Log5** (Hong / Tango) on shrunken season + last-30-day splits, then scale per outcome by **handedness-keyed park factors** and **HR-weighted weather** (Baseball Savant + covers.com), then apply the **times-through-the-order penalty** keyed off cumulative batters faced. A **24-state base-out Markov chain** iterates the resulting non-stationary kernel forward through the live `(outs, bases)` state until absorption, returning `P(≥1 run scores)`. The complement is `P(nrXi)`, fed through an **isotonic calibration shim** (identity in v1; fitted later from production pairs). American break-even odds = `q ≥ 0.5 → -100·q/(1-q)`, else `+100·(1-q)/q`.

Tango league-mean run-frequency anchor (`P(≥1 run | 0 outs, empty) ≈ 0.27`) and 50k-trial Monte Carlo cross-check live in `lib/prob/markov.test.ts`. Math derivations, file references, and calibration caveats in **[docs/PROBABILITY_MODEL.md](docs/PROBABILITY_MODEL.md)**.

## For Claude / agents

If you're an AI agent picking up this codebase: start with **[CLAUDE.md](CLAUDE.md)** before touching any code. It logs the five non-obvious bugs we already hit and the gotchas for Workflow DevKit, Cache Components, Upstash JSON auto-parsing, and the MLB Stats API.
