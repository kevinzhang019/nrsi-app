# nrXi

Live MLB **No-Run-Scoring-Inning** probability board. Every active game gets a half-inning-by-half-inning estimate of the chance no run scores, plus the minimum American odds at which a "no run" bet is positive-EV.

Built on Next.js 16 (App Router + Cache Components) for the frontend, a **Railway-hosted Node supervisor** for the live game watchers, and Upstash Redis + Supabase for state and history.

## What you see

- **Every MLB game for the day**, grouped into four sections in this order: **Highlighted → Active → Upcoming → Finished**. Empty sections are hidden. Cards smoothly fade between sections (via `motion`'s `AnimatePresence` + `layoutId`) when a game's state changes — most commonly when a decision moment starts or ends.
- Per-card: teams, score, current inning + half + outs, current pitcher (R/L), upcoming batter chips with per-batter `P(reach)` percentages, **a CAD-blueprint silhouette of the home park** (foul-line wedge + outfield wall, hairline stroke that turns green alongside the card's ring on decision moments), and a footer with `P(nrXi)` and **break-even American odds**.
- **Decision-moment cards** (end-of-half-inning, or top-of-inning with 0 outs) are surfaced into the **Highlighted** section with a green ring — the windows where a "no run this inning" bet is being priced.
- **Drill-down at `/games/{gamePk}`** for the full upcoming lineup table with each batter's reach probability.
- **History at `/history` and `/history/{gamePk}`** for the persisted archive of finished games + their per-inning prediction snapshots.
- Live updates pushed via **SSE** as watchers detect inning transitions; cards re-render in place without remount, so live data keeps flowing through any cross-section animation.

## Tech stack

| Piece | Choice | Why |
|---|---|---|
| Framework | Next.js 16 App Router | Cache Components for partial pre-render |
| Watcher | Railway-hosted Node supervisor | Cron-triggered, scale-to-zero outside MLB hours, fits inside the Hobby $5 credit |
| Cache / pubsub | Upstash Redis (REST) | Marketplace integration, no TCP connection limits |
| History archive | Supabase Postgres | Finished games + per-inning prediction snapshots |
| Styling | Tailwind v4 | `@theme` tokens, dark-by-default |
| Tests | Vitest | 174 unit tests covering math + service primitives |

## Quick start (local dev)

```bash
# 1. Clone and install
git clone https://github.com/kevinzhang019/nrxi-app.git
cd nrxi-app
npm install

# 2. Pull env vars (Vercel Marketplace populates KV_*, SUPABASE_*)
vercel link
vercel env pull .env.local

# 3. Run the frontend dev server
npm run dev
# → http://localhost:3000
```

The `.env.local` will contain `KV_REST_API_URL` / `KV_REST_API_TOKEN` from the Marketplace Upstash integration plus `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`. The frontend reads from these. The watcher (which actually populates the data) runs on Railway — see `docs/RUNBOOK.md` for ops.

## Deploy

The frontend deploys to Vercel via standard `vercel deploy --prod`. The watcher deploys to Railway by pushing to GitHub — `railway.toml` declares the service:

- **Cron:** `0 12 * * *` (Railway native cron service)
- **Start command:** `npx tsx bin/supervisor.ts`
- **Restart policy:** never (the supervisor exits cleanly when idle so Railway scales to zero)

To trigger the supervisor manually outside the cron window:
- **Railway dashboard** → service → Deployments → ⋮ → Run Now, OR
- Run locally: `npx tsx bin/supervisor.ts`

The cron fires daily at 12:00 UTC. The supervisor fetches today's MLB schedule, schedules per-game watcher tasks at `gameDate − 90s`, runs them in-process until each goes Final, then exits at the next 06:00 UTC after the active set drains.

## Project structure

```
app/                  Next.js App Router pages, API routes, SSE
components/           Client components (game-board, card, lineup-column)
lib/
  mlb/                Stats API client, types, lineup logic
  prob/               Pure math: Log5, Markov chain, TTOP, framing, defense, calibration
  env/                Park (Baseball Savant) + weather (covers.com) + defense (Statcast) factors
  cache/              Upstash client + key conventions
  pubsub/             Snapshot publisher + subscriber iterator
  state/              Canonical GameState type
  db/                 Supabase service-role client + history queries
  hooks/              Client React hooks (useGameStream)
  parks/              Pre-built ballpark SVG path data (shapes.json + team→venueId map)
  types/              Shared types (history archive)
services/             Railway-side: supervisor, run-watcher, lib/* primitives, steps/*
bin/                  CLI entry points: supervisor (Railway cron), run-watcher-once,
                      prune-snapshots, seed-once, inspect-snapshot
scripts/              Build scripts (build-park-shapes.mjs)
docs/                 Architecture, probability model, historical bugs, UI contracts, runbook
railway.toml          Railway service config (cron, start command)
vercel.ts             Vercel project config (frontend only — no cron)
```

## Useful commands

| Command | What it does |
|---|---|
| `npm run dev` | Local Next.js dev server |
| `npm run build` | Production build (Turbopack, Cache Components) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Run all unit tests (Vitest) |
| `npm run build:park-shapes` | Refresh `lib/parks/shapes.json` from `bdilday/GeomMLBStadiums` (one-off; output is committed) |
| `npx tsx bin/supervisor.ts` | Run the supervisor locally (same code Railway runs) |
| `npx tsx bin/run-watcher-once.ts <gamePk>` | Run a single watcher locally for debugging |
| `npx tsx bin/inspect-snapshot.ts` | Read-only field-key dump of `nrxi:snapshot` |
| `npx tsx bin/prune-snapshots.ts` | One-shot zombie-snapshot cleanup |
| `npx tsx bin/seed-once.ts` | Re-seed today's snapshots after a wipe |
| `vercel logs <deployment-url>` | Tail Vercel runtime logs (frontend only) |

## Links

- **Production:** https://nrsi-app.vercel.app (Vercel SSO required)
- **GitHub:** https://github.com/kevinzhang019/nrxi-app
- **Vercel project:** kevinzhang019s-projects/nrxi-app (frontend)
- **Railway project:** `dee88e6b-6ae3-4e44-a0f8-eb3987216457` (watcher supervisor)

## How it works (in 5 lines)

A Railway cron at 12:00 UTC daily spawns `bin/supervisor.ts`. The supervisor fetches today's MLB schedule, seeds `Pre`-state stubs into Redis, prunes any stale snapshot field-keys, and schedules a per-game watcher task to start 90 seconds before each game's first pitch. Each watcher holds a Redis lock (one watcher per `gamePk`, ever), polls the MLB live feed via the lightweight `diffPatch` endpoint, recomputes `P(nrXi)` on every half-inning transition, persists hoisted state per tick (so a process restart resumes mid-game), and publishes the live `GameState` to a Redis snapshot hash. The supervisor exits cleanly once all watchers finish AND the wall clock is past the next 06:00 UTC — Railway scales the container to zero until the next cron firing. The Vercel-hosted frontend's `/api/stream` SSE route polls the same Redis snapshot every 2s and pushes diffs to all connected browsers.

Full diagram and per-component description in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**. Operations playbook in **[docs/RUNBOOK.md](docs/RUNBOOK.md)**.

## Probability model (in 5 lines)

For each upcoming batter, build a per-PA outcome distribution `{1B, 2B, 3B, HR, BB, HBP, K, ipOut}` via **generalized multinomial Log5** (Hong / Tango) on shrunken season + last-30-day splits, then scale per outcome by **handedness-keyed park factors**, **HR-weighted weather** (Baseball Savant + covers.com), the **times-through-the-order penalty** keyed off cumulative batters faced, and **catcher-framing + fielder-OAA factors** from Statcast. A **24-state base-out Markov chain** iterates the resulting non-stationary kernel forward through the live `(outs, bases)` state until absorption, returning `P(≥1 run scores)`. The complement is `P(nrXi)`, fed through an **isotonic calibration shim** (identity in v1; fitted later from production pairs). American break-even odds = `q ≥ 0.5 → -100·q/(1-q)`, else `+100·(1-q)/q`.

Tango league-mean run-frequency anchor (`P(≥1 run | 0 outs, empty) ≈ 0.27`) and 50k-trial Monte Carlo cross-check live in `lib/prob/markov.test.ts`. Math derivations, file references, and calibration caveats in **[docs/PROBABILITY_MODEL.md](docs/PROBABILITY_MODEL.md)**.

## For Claude / agents

If you're an AI agent picking up this codebase: start with **[CLAUDE.md](CLAUDE.md)** before touching any code. It logs the load-bearing invariants (watcher state durability, lock TTL semantics, snapshot prune step, Cache Components' `connection()` requirement, Upstash JSON auto-parsing, MLB Stats API gotchas) and points at the detailed docs (`docs/ARCHITECTURE.md`, `docs/BUGS.md`, `docs/UI.md`, `docs/RUNBOOK.md`, `docs/PROBABILITY_MODEL.md`).
