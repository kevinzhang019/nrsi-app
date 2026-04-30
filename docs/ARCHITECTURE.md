# Architecture

## Data flow

```
                    ┌──────────────────┐
                    │  Vercel Cron     │  schedule: "0 13 * * *"  (vercel.ts)
                    │  13:00 UTC daily │
                    └────────┬─────────┘
                             │ GET /api/cron/start-day
                             ▼
                  ┌─────────────────────┐
                  │  schedulerWorkflow  │  workflows/scheduler.ts
                  │  - fetchSchedule    │
                  │  - sleep til T-5min │
                  │  - start watcher    │
                  └────────┬────────────┘
                           │ start(gameWatcherWorkflow, ...) per game
                           ▼
   ┌─────────────────────────────────────────────────────────────┐
   │  gameWatcherWorkflow  (one per gamePk)                       │
   │  workflows/game-watcher.ts                                   │
   │                                                              │
   │  1. acquire Redis lock  ──────────────────┐                  │
   │  2. while !Final:                         │                  │
   │     fetchLiveDiff (timecode resume)       │                  │
   │     detect inningKey change               │ on transition:   │
   │     loadLineupSplits + park + weather  ◀──┤  recompute       │
   │     computeNrsi (DP)                      │                  │
   │     publishUpdate ──┐                     │                  │
   │     refresh lock    │                     │                  │
   │     sleep ~7-30s    │                     │                  │
   │  3. exit on Final   │                                        │
   └─────────────────────┼────────────────────────────────────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │   Upstash Redis      │   keys: lib/cache/keys.ts
              │   - nrsi:snapshot    │   ←── single source of truth
              │   - nrsi:games chan  │       for client UI
              │   - cached splits/   │
              │     park/weather     │
              └──────────┬───────────┘
                         │ poll every 2s
                         ▼
              ┌──────────────────────┐
              │  /api/stream  (SSE)  │   app/api/stream/route.ts
              │  fan-out to N clients│
              └──────────┬───────────┘
                         │ EventSource
                         ▼
              ┌──────────────────────┐
              │  React client        │   components/game-board.tsx
              │  Map<gamePk, State>  │   useGameStream hook
              │  sort + render cards │
              └──────────────────────┘
```

## Components

### Workflows

#### `workflows/scheduler.ts` — `schedulerWorkflow`
Daily entry point. Fetches today's schedule via `fetchScheduleStep`, then iterates games and `sleep`s until 5 minutes before each first pitch. At each wake, calls `startWatcherStep` (which wraps `start(gameWatcherWorkflow, ...)` because `start()` cannot run inside a workflow context). Persists `{gamePk: runId}` to Redis under `nrsi:runs:{date}` for ops visibility. After spawning all watchers, sleeps 12h and exits.

#### `workflows/game-watcher.ts` — `gameWatcherWorkflow`
The durable per-game poller. Receives `{ gamePk, ownerId, awayTeamName, homeTeamName }`.

**Lifecycle:**
1. Acquire `nrsi:lock:{gamePk}` (90s TTL). If held by another, exit immediately with `{ reason: "lock-held" }`.
2. Loop up to `MAX_LOOPS = 1500`:
   - `fetchLiveDiffStep` with last seen `metaData.timeStamp` for tiny diff payloads (falls back to full feed if no prior state).
   - Compute `inningKey = "${inning}-${half}-${end|live}"` and `lineupHash`. Set `shouldRecompute = status === "Live" && upcoming != null && pitcherId != null && (inningKey changed || lineup changed)`.
   - If recompute: parallel fetch `loadLineupSplitsStep`, `loadParkFactorStep`, `loadWeatherStep`. Then `computeNrsiStep`. Persist results into hoisted `lastNrsi`, `lastEnv`, `lastPitcher*` (workflow scope, not loop scope — see CLAUDE.md bug #5).
   - Build `GameState` from current feed + last computed nrsi. `publishUpdateStep` writes to `nrsi:snapshot` hash.
   - If `status === "Final"`, return `{ reason: "final" }`.
   - Refresh lock TTL, then `sleep(waitSec)` adaptive: Live→`metaData.wait` (~7-10s), Pre→30s, Delayed/Suspended→300s.

#### `workflows/steps/*`
Each step is a `"use step"` function — full Node.js access, automatic retry on throw, durable result caching.

| Step | Purpose | Retries |
|---|---|---|
| `fetch-schedule.ts` | Pull MLB daily schedule | yes |
| `fetch-live-diff.ts` | Pull live feed (full or diff-patch), apply patches | yes |
| `load-lineup-splits.ts` | Resolve pitcher + 9 batters with cached splits | yes |
| `load-park-factor.ts` | Baseball Savant runs index for home park | yes (degrades to 1.0) |
| `load-weather.ts` | covers.com scrape, classify wind, compute factor | yes (degrades to 1.0) |
| `compute-nrsi.ts` | Pure DP — no I/O, but as a step for cache | n/a |
| `publish-update.ts` | Write `GameState` to Redis snapshot + publish | yes |
| `lock.ts` | `acquire`/`refresh` watcher lock via Redis SETNX | yes |

### API routes

#### `app/api/cron/start-day/route.ts`
GET handler invoked by Vercel Cron at 13:00 UTC. Optional `Bearer $CRON_SECRET` auth. Calls `start(schedulerWorkflow)` and returns `{ ok, runId }`. Also callable manually for testing.

#### `app/api/snapshot/route.ts`
GET. Reads `nrsi:snapshot` via `lib/pubsub/publisher.ts:getSnapshot`, sorts (Live > Delayed > Suspended > Pre > Final, then by inning desc), returns `{ games, ts }`. Used by the SSR initial paint.

#### `app/api/stream/route.ts`
GET. Server-Sent Events stream. On connect, sends a `snapshot` event with current state, then enters a `while !abort` loop polling `nrsi:snapshot` every 2s and emitting `update` events for any changed `gamePk`. 15s heartbeat prevents proxy timeouts. EventSource auto-reconnects on Vercel's ~300s function lifecycle boundary.

#### `app/api/workflows/{scheduler,game-watcher}/route.ts`
POST handlers for manual operational triggers — useful for restarting a watcher after cancellation, or kicking off the scheduler outside the cron window.

### Libraries

#### `lib/mlb/`
- `client.ts` — typed wrappers for `statsapi.mlb.com`. `fetchSchedule`, `fetchLiveFull`, `fetchLiveDiff`, `fetchPerson`, `fetchSplits`, `fetchVenue`. Sets `User-Agent` from env, throws on non-2xx.
- `types.ts` — Zod schemas (`ScheduleResponse`, `PersonResponse`, `SplitsResponse`) and a `LiveFeed` TypeScript type. Exports `classifyStatus(detailed, abstract)` to bucket detailed states into our `GameStatus` enum (Pre/Live/Final/Delayed/Suspended/Other).
- `splits.ts` — `loadBatterProfile`, `loadPitcherProfile`. Both use cache-or-fetch via Upstash, with prior-season fallback when current-season splits are empty.
- `lineup.ts` — `getUpcomingForCurrentInning(feed)` extracts the next 9 upcoming batters and their pitcher from a `LiveFeed`. Handles `Middle`/`End`/`outs===3` by advancing to the next half-inning. Returns `null` if `boxscore.battingOrder` < 9.

#### `lib/env/`
- `park.ts` — Baseball Savant scraper. Tries `<script id="park-factors-data">` JSON embed, falls back to a regex over the HTML table. Caches the full table for the season; lookup is by team name with abbreviation mapping.
- `weather.ts` — covers.com HTML scraper using `cheerio` (declared in `serverExternalPackages` of `next.config.ts`). Matches game blocks by team-name pair, extracts temp/wind/precip/dome via regex on row text. `weatherRunFactor()` converts `WeatherInfo` to a multiplicative factor in [0.85, 1.15].
- `venues.ts` — venue metadata cache, used for ops display only.

#### `lib/prob/`
Pure, fully unit-tested math.
- `reach-prob.ts:pReach` — single-batter reach probability.
- `inning-dp.ts:pAtLeastTwoReach` — Bayesian DP, returns P(hit event).
- `odds.ts` — `americanBreakEven`, `impliedProb`, `roundOdds`.

See **[PROBABILITY_MODEL.md](PROBABILITY_MODEL.md)** for the full math and assumptions.

#### `lib/pubsub/`
- `publisher.ts` — `publishGameState(state)` does three things atomically (best-effort): publish to channel, hset to snapshot, expire snapshot. `getSnapshot()` reads the hash and tolerates both string and auto-parsed-object values (CLAUDE.md bug #4).
- `subscriber.ts` — `iterateSnapshotChanges(redis, intervalMs, abort)` is an async generator that polls the snapshot hash, dedupes by JSON signature, and yields `GameState` objects. The SSE route consumes this.

#### `lib/cache/`
- `redis.ts` — singleton Upstash `Redis` instance with lazy init. Reads `KV_REST_API_*` first, falls back to `UPSTASH_REDIS_REST_*`. `cacheJson(key, ttl, loader)` is a small read-through helper.
- `keys.ts` — every Redis key shape lives here. Don't hardcode key strings elsewhere.

#### `lib/state/game-state.ts`
The canonical `GameState` type that flows from watcher → Redis → SSE → React. Also exports `isDecisionMoment({status, inning, half, outs, inningState})` used both server-side (when constructing state) and conceptually mirrored in the client-side decision-card highlight rule.

### Frontend

#### `app/page.tsx`
Server component. Suspense-wraps `<GameBoardLoader />` which calls `getInitialGames()` (cached read of `nrsi:snapshot`). Renders header + grid. Skeleton fallback during initial paint.

#### `components/game-board.tsx`
Client. Uses `useGameStream(initial)` to maintain a live `Map<gamePk, GameState>`. Sorts: decision-moments first, then by status order, then by inning desc. Renders `<GameCard>` per game.

#### `components/game-card.tsx`
Per-game card. Two team rows (mono-spaced score, small-caps name), `<InningState>` block (top/bottom indicator, outs as filled circles), pitcher line, upcoming-batter chips with per-batter `pReach`%, env chips, and a footer `<ProbabilityPill>` with `P(NRSI)` + break-even American odds. Decision moments add `ring-2 ring-amber-400/60` and a brief flash animation on update.

#### `app/games/[pk]/page.tsx`
Drilldown. Full upcoming-lineup table with each batter's `pReach`%, plus the three-column NRSI/odds/env summary. Same Suspense + connection() pattern as the index page.

#### `lib/hooks/use-game-stream.ts`
Client hook. Opens an `EventSource` to `/api/stream`, listens for `snapshot` and `update` events, dispatches into a `useReducer` that maintains `{ byPk, freshIds }`. Auto-reconnects via the browser's built-in EventSource behavior.

## Why these decisions

### Single-poller pattern (lock per gamePk)

Every browser hitting MLB directly would burn through the soft rate limit (~10 req/sec/IP) within minutes once a few users connect. Instead, exactly one watcher polls per game (enforced by `nrsi:lock:{gamePk}`), publishes to Redis, and the SSE route fans out to all clients. With 15 concurrent live games and a ~7s poll cadence, the global request rate is ~2 req/sec — comfortable.

The lock has a 90s TTL and is refreshed every loop iteration. If a watcher process dies (deploy, crash), another can take over after the TTL expires. The `ownerId` is stored in the lock so `refreshWatcherLockStep` can also detect ownership transfer.

### Why Workflow DevKit over cron-every-minute

Two reasons. First, Vercel Cron has a 1-minute minimum interval — too slow for inning transitions. Second, naive long-running serverless functions hit the 300s execution timeout. Workflow DevKit gives us durable `sleep()` that doesn't consume compute (the sleeping run is checkpointed and resumed in a fresh function invocation). Each watcher can run for 4+ hours of game time without paying for idle compute.

The other big win is automatic step retry. If the MLB API returns a 500 mid-inning, the step throws and Workflow retries with exponential backoff. The workflow function above the step doesn't know or care.

### Why Cache Components

Next.js 16's Cache Components mode lets the page shell prerender at build time while dynamic data streams in via Suspense boundaries. First paint is instant (HTML from CDN), live data arrives ~50ms later when the SSE connection establishes. Without this we'd either pay full SSR latency on every request or build a separate static landing page.

Cost: we have to wrap every dynamic data access in `<Suspense>` and call `connection()` inside, and we lose the `runtime`/`dynamic` route segment exports. Worth it for the perceived performance.

## Trade-offs we accepted

- **2-second SSE poll latency.** True Redis pub/sub from Vercel Functions is awkward (each connection is a TCP subscription, Upstash REST doesn't support it, persistent connections fight Fluid Compute's lifecycle). The 2s poll is well under the natural data-change rate (~7s minimum between inning transitions). Sub-second push would be over-engineering. See the conversation history for full analysis.
- **Park + weather double-counting.** Statcast park factors are *runs* indices that already encompass average weather. Multiplying by our weather factor on top is mildly redundant. Acceptable for v1; if/when we calibrate against actual results we can switch to *batting park factor* (BPF) only.
- **HTML scraping fragility.** Both Baseball Savant and covers.com return HTML, not stable JSON APIs. Scrapers are wrapped in try/catch with `1.0` fallback, so a layout change degrades gracefully (env factors stop working but the rest of the system is unaffected). Watch for `park:scrape:failed` and `weather:scrape:failed` log lines.
- **Switch hitters use `max(L, R)`.** Generous. Standard convention is "opposite of pitcher's hand." User-specified, intentional. Documented in CLAUDE.md and PROBABILITY_MODEL.md.
- **No retry budget on the workflow loop.** `MAX_LOOPS = 1500` × ~7s = ~3 hours of game time. Long delays could exhaust this; we'd want to handle re-spawn from the scheduler if a game is suspended overnight.
