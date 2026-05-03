# Architecture

## Data flow

```
                    ┌──────────────────┐
                    │  Railway Cron    │  schedule: "0 12 * * *"  (railway.toml)
                    │  12:00 UTC daily │  restart: NEVER (scale-to-zero on idle exit)
                    └────────┬─────────┘
                             │ spawn `npx tsx bin/supervisor.ts`
                             ▼
                  ┌─────────────────────┐
                  │  services/supervisor│  bin/supervisor.ts → services/supervisor.ts
                  │  - fetchSchedule    │
                  │  - seedSnapshot     │  hsetnx Pre stubs into nrxi:snapshot
                  │  - pruneStale       │  hdel field-keys whose officialDate < today (ET)
                  │  - per game: setTimeout(gameDate-90s, runWatcher)
                  │  - idle-loop until pending=0 AND now > tomorrow 06:00 UTC
                  │  - process.exit(0) → Railway scales container to zero
                  └────────┬────────────┘
                           │ in-process: void runWatcher(input, abortSignal) per game
                           ▼
   ┌─────────────────────────────────────────────────────────────┐
   │  services/run-watcher  (one async task per gamePk)          │
   │                                                              │
   │  1. acquire Redis lock (30s TTL) ─────────────┐             │
   │     start background refresher (every 10s)    │             │
   │  2. hydrate hoisted state from                 │             │
   │     nrxi:watcher-state:{gamePk}                │             │
   │  3. while !Final && loops < 1500 && < 6h:      │             │
   │     fetchLiveDiff (timecode resume)            │ on inning   │
   │     compute (structuralKey, playStateKey)      │ transition: │
   │     loadLineupSplits + park + weather + def ◀──┤  recompute  │
   │     prewarmBenchAndBullpen (fire-and-forget)   │             │
   │     computeNrXi (24-state Markov)              │             │
   │     buildInningCapture (clean half boundary)   │             │
   │     publishUpdate → nrxi:snapshot HSET         │             │
   │     saveWatcherState (every tick) ─────────────┤             │
   │     adaptive sleep 5s/15s/30s/300s             │             │
   │  4. on Final: buildPlayRows(tick.feed)          │             │
   │     persistFinishedGameStep                     │             │
   │     → games + inning_predictions + plays        │             │
   │       in Supabase                               │             │
   │     clearWatcherState; exit                    │             │
   └─────────────────────┼───────────────────────────────────────┘
                         │
                         ▼
              ┌──────────────────────┐         ┌──────────────────┐
              │   Upstash Redis      │         │  Supabase Postgres │
              │   - nrxi:snapshot    │         │  - games          │
              │   - nrxi:games chan  │         │  - inning_predic. │
              │   - nrxi:lock:{pk}   │         │  - plays           │
              │                      │         └─────────┬────────┘
              │   - nrxi:watcher-    │                   │
              │     state:{pk}       │                   │ server-component
              │   - cached splits/   │                   │ reads
              │     park/weather/    │                   ▼
              │     defense          │         ┌──────────────────┐
              └──────────┬───────────┘         │  Vercel SSR      │
                         │ poll every 2s        │  /history pages   │
                         ▼                       └──────────────────┘
              ┌──────────────────────┐
              │  Vercel /api/stream  │   app/api/stream/route.ts (SSE)
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

**The migration that shaped this diagram:** the watcher used to run as a Vercel Workflow DevKit (WDK) orchestrator on the same Vercel deployment as the frontend, kicked daily by a Vercel Cron. That was burning the Fluid Compute free-tier cap. The new design splits compute: the watcher is a Railway-hosted Node supervisor that scales to zero outside MLB hours; the frontend stays on Vercel free-tier serving SSR + the SSE fan-out. Same Upstash Redis, same Supabase — both providers connect to the same data plane.

## Activity-window mitigation

Three levers the Railway architecture adds to keep CPU usage close to the actual MLB game window:

1. **Process-level idle exit.** The supervisor exits cleanly once `pending.size === 0 && now > tomorrow06UTC`. Railway interprets the clean exit as "scale to zero" — no compute is billed until the next cron firing. The 06:00 UTC cutoff (next-day) protects late-running doubleheaders that finish past midnight UTC. Off-season days with zero scheduled games: supervisor exits within seconds. See `services/supervisor.ts:defaultIdleDeadline`.
2. **Tighter pre-game start.** Watchers spawn at `gameDate - 90s` instead of the legacy `gameDate - 5min`. Saves ~9 wasted polls × ~15 games/day = ~135 fewer pre-game fetches per slate. See `services/supervisor.ts:PRE_GAME_LEAD_MS`.
3. **Lower lock TTL with background refresher.** Lock TTL is 30s (was 90s under WDK), refreshed by a background `setInterval` every 10s in `services/lib/lock.ts:startLockRefresher`. The decoupled refresher means long pre-game / Delayed sleeps don't risk lock expiration regardless of loop cadence. A crashed pod's lock expires within 30s, after which a replacement watcher can take over.

## Components

### Services (Railway)

#### `services/supervisor.ts` — `runSupervisor`
Daily entry point invoked by `bin/supervisor.ts`. Fetches today's schedule, calls `seedSnapshotStep` (hsetnx Pre stubs), runs `pruneStaleSnapshots({ todayET: date })` to wipe field-keys whose row's own `officialDate < todayET`, then enqueues per-game watcher tasks with `setTimeout(gameDate - 90s, runWatcher)`. Tracks `pending: Set<gamePk>` and exits cleanly when the set drains AND we're past `defaultIdleDeadline()` (next-day 06:00 UTC). On SIGTERM, drains watchers up to a 30s budget, then exits.

Test seams: `fetchScheduleFn`, `seedSnapshotFn`, `pruneStaleSnapshotsFn`, `runWatcherFn`, `computeIdleDeadlineFn`, `idleCheckIntervalMs` are all injectable.

#### `services/run-watcher.ts` — `runWatcher`
One async task per gamePk, lives inside the supervisor process. Receives `{ gamePk, ownerId, awayTeamName, homeTeamName }` and an `AbortSignal`.

**Lifecycle:**
1. Acquire `nrxi:lock:{gamePk}` (30s TTL via `services/lib/lock.ts:acquireWatcherLock`). If held by another, exit with `{ reason: "lock-held" }`.
2. Start background `setInterval` refreshing the lock every 10s via `startLockRefresher`. Stops on watcher exit or parent process abort.
3. Hydrate hoisted state from `nrxi:watcher-state:{gamePk}` (`services/lib/watcher-state.ts:loadWatcherState`). On first start this returns an empty state; on a process restart we recover `capturedInnings` and the last-published view. Trigger keys (`structuralKey`, `playStateKey`) are deliberately NOT persisted — the first tick after restart unconditionally fires Phase 1 reload to rebuild caches.
4. Loop up to `MAX_LOOPS = 1500` AND `Date.now() - startedAt < 6h`:
   - `fetchLiveDiffStep` with last seen `metaData.timeStamp` for tiny diff payloads.
   - Build `structuralKey` (half | inning | lineup | defense | opposing pitcher | atBat batter | bottom-9-skipped flag) and `playStateKey` (outs | bases | atBatIndex). Set `shouldReloadStructure` and `shouldRecomputePlay` triggers.
   - **Phase 1 (structural reload):** parallel fetch `loadLineupSplitsStep`, `loadParkFactorStep`, `loadWeatherStep`, `loadDefenseStep`. Compute display lineup stats for both teams. Pre-compute opposite-half clean-state P(no run) for full-inning composition (skipped at top-9 when the home team is leading — see `services/full-inning.ts:shouldSkipBottomNinth`; the score is part of `structuralKey` so a tying run mid-top-9 forces a reload). Persist to hoisted `lastNrXi`, `lastEnv`, `lastPitcher*`, `lastLineupStats`, etc. Also kick off `prewarmBenchAndBullpenStep` **fire-and-forget** (`void`-prefixed, not awaited) — it loads handedness + per-PA splits for every bench hitter and bullpen pitcher on both teams so a future pinch-hit / relief change is a pure Redis hit instead of a critical-path MLB Stats API round-trip.
   - **Phase 2 (play-state recompute):** `computeNrXiStep` against current outs/bases. Update `lastFullInning`. Cheap — reuses Phase 1 caches.
   - Build `GameState` from current feed + last computed nrXi. `publishUpdateStep` writes to `nrxi:snapshot` hash.
   - `buildInningCapture` records the per-half-inning prediction snapshot exactly once at `outs===0 && (bases===0 || bases===2)` (the Manfred runner allowance for extras).
   - `saveWatcherState` serializes the hoisted-var bundle to Redis (`nrxi:watcher-state:{gamePk}`, 24h TTL). One HSET per tick.
   - If `status === "Final"`: call `buildPlayRows(tick.feed, gamePk)` (pure transform of `liveData.plays.allPlays` — completed PAs only, with names resolved from boxscore), then `persistFinishedGameStep` (Supabase upsert of `games` + `inning_predictions` + `plays`), `clearWatcherState`, return `{ reason: "final" }`. Per-play capture is **post-game only**, not per-tick — terminal feed already has the full play log, and history-only data shouldn't inflate `saveWatcherState` writes.
   - Adaptive sleep: 5s during active PAs, 15s otherwise (Live), 30s Pre, 300s Delayed/Suspended. See `services/steps/fetch-live-diff.ts:chooseRecommendedWaitSeconds`.

The core probability pipeline (Log5 → env → TTOP → framing → defense → 24-state Markov → calibrate) lives in `lib/prob/*` and is unchanged from the WDK days. See [`PROBABILITY_MODEL.md`](PROBABILITY_MODEL.md).

#### `services/lib/*` — primitives

| File | Replaces | Purpose |
|---|---|---|
| `sleep.ts` | WDK `sleep()` | `sleepMs(ms, signal?)` cancellable via AbortSignal |
| `with-retry.ts` | WDK step auto-retry | exponential-backoff wrapper |
| `lock.ts` | `workflows/steps/lock.ts` | acquire (30s TTL) + background refresher every 10s |
| `watcher-state.ts` | WDK hoisted-var durability | JSON serialize hoisted vars to Redis per tick |
| `prune-snapshots.ts` | (new) | hdel snapshot field-keys whose row's own `officialDate < todayET` |
| `load-env.ts` | Next.js auto-load of `.env.local` | tsx doesn't auto-load it; bin/* scripts import this first |

#### `services/steps/*` — plain async helpers

What used to be WDK `"use step"` functions, now plain async functions called via `withRetry()` from the watcher loop. Same bodies, no directive overhead. See [BUGS.md](BUGS.md#9-snapshot-zombie-hash-entries) for one bug introduced by the migration that we then fixed.

| Step | Purpose | Notes |
|---|---|---|
| `fetch-schedule.ts` | Pull MLB daily schedule | populates `officialDate` (venue-local YYYY-MM-DD) per game |
| `seed-snapshot.ts` | Write `Pre` stub GameStates | uses `hsetnx`, never overwrites a real watcher state |
| `fetch-live-diff.ts` | Pull live feed (full or diff-patch), apply patches | exports `chooseRecommendedWaitSeconds` |
| `load-lineup-splits.ts` | Resolve pitcher + 9 batters with cached PA-multinomial profiles | underlying `loadBatterPaProfile` is Redis-cached 12h |
| `load-park-factor.ts` | Baseball Savant scrape: runs index + per-component factors | degrades to 1.0 on scrape failure |
| `load-weather.ts` | covers.com scrape: WeatherInfo + per-component factors | degrades to 1.0 |
| `load-defense.ts` | Statcast scrapes: OAA + framing tables (parallel, 24h cache) | degrades to neutral |
| `compute-nrXi.ts` | Log5 + env + TTOP + framing + defense + Markov chain | derives per-PA `pReach`/xOBP and `xSlg` |
| `compute-lineup-stats.ts` | Display-only xOBP/xSLG for both teams' starters | drives the "one team at a time" view |
| `enrich-lineup-hands.ts` | Hydrate batter handedness from `/people/{id}` | 30d Redis TTL, graceful per-id fail |
| `publish-update.ts` | Write `GameState` to Redis snapshot + publish to channel | resets snapshot 24h TTL each call |
| `persist-finished-game.ts` | Upsert games + inning_predictions + plays to Supabase | no-ops if Supabase env vars unset |

### `bin/*` — CLI tools

- `bin/supervisor.ts` — Railway cron entry. Forwards SIGTERM via AbortController.
- `bin/run-watcher-once.ts` — local-dev: run a single watcher against a gamePk, exit when Final.
- `bin/prune-snapshots.ts` — one-shot zombie cleanup. The supervisor does this every cron firing now too; this is for emergencies.
- `bin/seed-once.ts` — re-seed today's snapshots after a `--all` wipe.
- `bin/inspect-snapshot.ts` — read-only field-key dump of `nrxi:snapshot`.

All bin scripts import `services/lib/load-env` first to pick up `.env.local` for local dev (no-op on Railway).

### API routes (Vercel)

#### `app/api/snapshot/route.ts`
GET. Reads `nrxi:snapshot` via `lib/pubsub/publisher.ts:getSnapshot`, sorts (Live > Delayed > Suspended > Pre > Final, then by inning desc), returns `{ games, ts }`. Used by the SSR initial paint.

#### `app/api/stream/route.ts`
GET. Server-Sent Events stream. On connect, sends a `snapshot` event with current state, then enters a `while !abort` loop polling `nrxi:snapshot` every 2s and emitting `update` events for any changed `gamePk`. 15s heartbeat prevents proxy timeouts. EventSource auto-reconnects on Vercel's ~300s function lifecycle boundary.

The two old WDK-era routes (`/api/cron/start-day` and `/api/workflows/*`) are gone — Railway is the cron source now, and there's no manual-trigger HTTP surface.

### Libraries

#### `lib/mlb/`
- `client.ts` — typed wrappers for `statsapi.mlb.com`. `fetchSchedule`, `fetchLiveFull`, `fetchLiveDiff`, `fetchPerson`, `fetchSplits`, `fetchVenue`. Sets `User-Agent` from `MLB_USER_AGENT` env (defaults to `nrxi-app/0.1`).
- `types.ts` — Zod schemas (`ScheduleResponse`, `PersonResponse`, `SplitsResponse`) and a `LiveFeed` TypeScript type. Includes `gameData.datetime.officialDate` (venue-local YYYY-MM-DD, the canonical history bucket key).
- `splits.ts` — Two parallel loader sets:
  - **v1 legacy** — `loadBatterProfile` / `loadPitcherProfile` return scalar `obpVs` / `whipVs`. Retained for the deprecated `pReach` path.
  - **v2** — `loadBatterPaProfile` / `loadPitcherPaProfile` return per-handedness `paVs: PaOutcomes` (8-outcome multinomial). Pulls **current + prior regular-season splits in parallel**, blends them via a Marcel-style 3:2 recency multiplier on PA, EB-shrinks the combined baseline against true PA at `n0 = 200`, then folds in a 30% last-30-day blend when L30 has ≥ 20 PA.
- `lineup.ts` — `getUpcomingForCurrentInning(feed)` extracts the next 9 upcoming batters and their pitcher. Handles `Middle`/`End`/`outs===3` half-boundary advancement. Returns `null` if `boxscore.battingOrder` < 9.
- `extract.ts` — `extractLineups`, `extractLinescore`, `extractBatterFocus(feed, lastBatterIds?)`. The last function returns `{ battingTeam, currentBatterId, nextHalfLeadoffId }` for the lineup highlight; `nextHalfLeadoffId` requires per-team `lastBatterIds` (tracked by the watcher across ticks) to resolve to the actual on-deck spot — without it, MLB's live feed only exposes offense state for the team currently batting, so the leadoff falls back to `order[0]`.

#### `lib/env/`
- `park.ts` — Baseball Savant scraper. `getParkRunFactor` (legacy), `getParkComponentFactors` (per-outcome handedness-keyed factors).
- `park-orientation.ts` — outfield bearing per park, used to classify wind direction.
- `weather.ts` — covers.com HTML scraper. `parseCoversHtml(html, awayTeam, homeTeam)` is the testable seam. Returns `WeatherInfo` consumed by `weatherRunFactor` (legacy) and `weatherComponentFactors` (per-outcome).
- `defense.ts` — Statcast OAA leaderboard scraper. `loadOaaTable(season)` (24h cache). `defenseFactor(fielderIds, table)` ∈ `[0.90, 1.10]`.
- `framing.ts` — Statcast catcher framing leaderboard. `loadFramingTable(season)` (24h cache). `framingFactors(catcherId, table)` returns `{k, bb}` ∈ `[0.95, 1.05]`. `NRXI_DISABLE_FRAMING=1` is the robo-ump kill switch.
- `venues.ts` — venue metadata cache.
- `__fixtures__/` — captured HTML for parser regression tests.

#### `lib/parks/`
Pre-built ballpark silhouette data, generated once at build time.
- `shapes.json` — keyed by MLB venueId. Each entry has `{ name, viewBox, d }`.
- `team-to-venue.ts` — team slug → venueId map.
- Refresh via `npm run build:park-shapes`.

#### `lib/prob/`
Pure, fully unit-tested math.
- `log5.ts` — generalized multinomial Log5, switch-hitter routing, matchup builder, env scaling.
- `markov.ts` — 24-state base-out Markov chain. `pAtLeastOneRun(start, lineup)`.
- `ttop.ts` — Times-Through-the-Order Penalty.
- `framing.ts` — `applyFraming(pa, {k, bb})` reweights K and BB cells.
- `defense.ts` — `applyDefense(pa, factor)` reweights the in-play block.
- `calibration.ts` — Identity calibrator + isotonic loader.
- `expected-stats.ts` — `xObpFromPa`, `xSlgFromPa`.
- `odds.ts` — `americanBreakEven`, `impliedProb`, `roundOdds`.
- **Legacy v1** — `reach-prob.ts:pReach`, `inning-dp.ts:pAtLeastTwoReach`. Not used by the watcher.

See [PROBABILITY_MODEL.md](PROBABILITY_MODEL.md) for the full math.

#### `lib/pubsub/`
- `publisher.ts` — `publishGameState(state)` does three things atomically (best-effort): publish to channel, hset to snapshot, expire snapshot. `getSnapshot()` reads the hash and tolerates both string and auto-parsed-object values (BUGS.md bug #4).
- `subscriber.ts` — `iterateSnapshotChanges(redis, intervalMs, abort)` async generator polled by the SSE route.

#### `lib/cache/`
- `redis.ts` — singleton Upstash `Redis`. Reads `KV_REST_API_*` first, falls back to `UPSTASH_REDIS_REST_*`. **Use the read/write token, NOT `KV_REST_API_READ_ONLY_TOKEN`** — the watcher writes constantly. `cacheJson(key, ttl, loader)` is a small read-through helper.
- `keys.ts` — every Redis key shape lives here. Don't hardcode key strings elsewhere.

#### `lib/db/`
- `supabase.ts` — service-role client (no auth/cookies). `isSupabaseConfigured()` guard makes the persist path a clean no-op when env vars are missing.
- `games.ts` — `saveFinishedGame(args)` upserts to `games` + `inning_predictions` + `plays`. Idempotent on `game_pk` / `(game_pk, inning, half)` / `(game_pk, at_bat_index)`. `gameDateOf(officialDate, startTime)` buckets by venue-local day. Read functions: `listGameDates`, `listGamesByDate`, `getGame`, `getInningPredictions`.
- `plays.ts` — `getGamePlays(gamePk)` returns the per-PA archive ordered by `at_bat_index`, used by the history detail page for per-inning hitter / pitcher rollups.

#### `lib/history/`
- `build-plays.ts` — pure transform `buildPlayRows(feed, gamePk): PlayRow[]`. Iterates `liveData.plays.allPlays`, keeps only `about.isComplete === true`, resolves batter / pitcher names from the boxscore players map (`ID${id}`) with `matchup.{batter,pitcher}.fullName` as a fallback, sums `runs_on_play` from `runners[]` with `movement.end === 'score'`. Called once at the watcher's Final exit — zero per-tick cost.
- `rollup-plays.ts` — pure rollups. `rollupBatters(rows)` produces `{pa, ab, h, hr, bb, hbp, k, r, rbi}` per unique `batterId`; `rollupPitchers(rows)` produces `{bf, ipOuts, h, bb, hbp, k, hr, r}` per unique `pitcherId` and attributes outs to the pitcher who threw each play (handles mid-inning changes correctly). `formatIp(outs)` renders `7 → "2.1"`. Caller pre-filters to whatever (inning, half) slice it wants.

##### Caching layout

All keys come from `lib/cache/keys.ts`.

| Key shape | Owner | Value | TTL |
|---|---|---|---|
| `bat:splitsraw:{playerId}:{season}` | `lib/mlb/splits.ts` | raw `SplitsResponse` JSON | 12h |
| `pit:splitsraw:{playerId}:{season}` | `lib/mlb/splits.ts` | raw `SplitsResponse` JSON | 12h |
| `hand:{playerId}` | `lib/mlb/splits.ts:loadHand` | `{ id, fullName, bats, throws }` | 30d |
| `park:factors:{season}` | `lib/env/park.ts` | `ParkRow[]` from Baseball Savant | 24h |
| `oaa:{season}` | `lib/env/defense.ts` | `OaaTable` | 24h |
| `framing:{season}` | `lib/env/framing.ts` | `FramingTable` | 24h |
| `venue:{venueId}` | `lib/env/venues.ts` | `VenueInfo` | 30d |
| `weather:{gamePk}` | `lib/env/weather.ts` | `WeatherInfo` | 30 min |
| `nrxi:lock:{gamePk}` | `services/lib/lock.ts` | watcher `ownerId` | 30s |
| `nrxi:watcher-state:{gamePk}` | `services/lib/watcher-state.ts` | hoisted-var bundle JSON | 24h |
| `nrxi:snapshot` | `lib/pubsub/publisher.ts` | hash `{gamePk: GameState JSON}` | 24h (reset on every publish) |
| `nrxi:games` (channel) | `lib/pubsub/publisher.ts` | published `GameState` JSON | n/a |

#### `lib/state/game-state.ts`
The canonical `GameState` type that flows from watcher → Redis → SSE → React. Includes optional `officialDate?: string` for venue-local bucketing. Also exports `isDecisionMoment` and `isDecisionMomentFullInning` predicates used both server-side and conceptually mirrored client-side.

### Frontend (Vercel)

#### `app/page.tsx`
Server component. Suspense-wraps `<GameBoardLoader />` which calls `getInitialGames()` (cached read of `nrxi:snapshot`). Skeleton fallback during initial paint.

#### `components/game-board.tsx`
Client. Uses `useGameStream(initial)` to maintain a live `Map<gamePk, GameState>`. Partitions games into Highlighted / Active / Upcoming / Finished sections, with `motion`'s `<AnimatePresence mode="popLayout">` for cross-section motion. Each card has a stable `layoutId={`card-${gamePk}`}` so it cross-fades when sections change.

#### `components/game-card.tsx`
Per-game card with two team rows, `<InningState>` block, pitcher line, two `<LineupColumn>`s, footer with `<ProbabilityPill>`. Decision moments add `ring-2 ring-[var(--color-accent)]/60` and a brief flash.

#### `app/games/[pk]/page.tsx`
Drilldown. Full upcoming-lineup table with `pReach`%, plus the three-column nrXi/odds/env summary.

#### `app/history/`
Server-component-only routes for the persisted-games archive.
- `page.tsx` — date strip + calendar popover (only data-days enabled). Lists games via `lib/db/games.ts:listGamesByDate`.
- `[pk]/page.tsx` — single wide frozen-state `<GameCard wide>` whose `<LineScore>` cells are themselves the inning picker (no separate selector). Inning *number* click → full-inning composition; runs cell click → that half-inning. State lives in `<HistoricalGameView>` and is forwarded into `<GameCard>` → `<LineScore>`. Below the card, `<HistoricalPlaysPanel>` renders per-tab Batters / Pitchers / play-log tables sourced from `lib/db/plays.ts:getGamePlays`. The `/history` listing page wraps `<GameCard>` in a Next `<Link>` and uses `<SuppressPlayerLinks>` (defined in `components/lineup-column.tsx`) to prevent nested-`<a>` hydration errors. See [UI.md](UI.md) for details.

#### `components/park-outline.tsx`
Inline SVG glyph rendering each home park's silhouette. Reads `lib/parks/shapes.json` keyed by `game.venue.id`. Hairline 1.25px stroke that transitions to the accent color on `highlighted=true`.

#### `lib/hooks/use-game-stream.ts`
Client hook. Opens an `EventSource` to `/api/stream`, listens for `snapshot` and `update` events, dispatches into a `useReducer`. Auto-reconnects.

## Why these decisions

### Single-poller pattern (lock per gamePk)

Every browser hitting MLB directly would burn through the soft rate limit (~10 req/sec/IP). Instead, exactly one watcher polls per game (enforced by `nrxi:lock:{gamePk}`), publishes to Redis, and the SSE route fans out to all clients. With 15 concurrent live games and a ~7s poll cadence, the global request rate is ~2 req/sec.

The lock has a 30s TTL refreshed every 10s by a background `setInterval` (`services/lib/lock.ts:startLockRefresher`). Decoupling the refresher from the loop cadence means long pre-game / Delayed sleeps don't risk lock expiration. A crashed pod's lock expires within 30s — fast crash recovery without wedging a game offline.

### Why Railway-hosted Node supervisor

Three reasons. First, the Vercel free tier's Fluid Compute cap can't sustain a 24/7 polling system — the watcher was burning the budget. Second, the workload is bursty (10–14 hours/day during MLB season, near-zero off-season), so scale-to-zero matters. The supervisor's `process.exit(0)` after idle-deadline lets Railway stop the container entirely until the next cron firing. Third, Railway's native cron + simple Node runtime maps cleanly to "fetch schedule, run async tasks, exit when done" — no orchestration framework needed.

What we gave up vs. WDK: durable `sleep()` and free crash-replay. Replaced with Redis-persisted hoisted state (`services/lib/watcher-state.ts`) — restart hydrates capturedInnings + the last-published view, then the first tick rebuilds caches via Phase 1 reload. Net: same behavior, slightly different mechanism.

### Why we kept Vercel for the frontend

Free SSR + the SSE fan-out + Cache Components partial prerendering — all the things the watcher doesn't need but the dashboard does. Splitting compute lets each provider do what it's good at, and both connect to the same Upstash + Supabase data plane with no coordination.

### Why Cache Components

Next.js 16's Cache Components mode lets the page shell prerender at build time while dynamic data streams in via Suspense boundaries. First paint is instant (HTML from CDN); live data arrives ~50ms later when the SSE connection establishes.

Cost: every dynamic data access must be wrapped in `<Suspense>` and call `connection()` inside, and we lose the `runtime`/`dynamic` route segment exports.

## Trade-offs we accepted

- **2-second SSE poll latency.** True Redis pub/sub from Vercel Functions is awkward (each connection is a TCP subscription, Upstash REST doesn't support it). 2s is well under the natural data-change rate (~7s minimum between inning transitions).
- **Park + weather double-counting** is now mitigated. v2 applies park factors per outcome (HR most, K/BB not at all) and weather likewise.
- **HTML scraping fragility.** Both Baseball Savant and covers.com return HTML. Scrapers wrap try/catch with neutral fallbacks. Captured fixtures in `lib/env/__fixtures__/` give regression tests.
- **Switch hitters use canonical platoon advantage** (v2 `actual` rule). `NRXI_SWITCH_HITTER_RULE=max` revives v1's generous `max(L, R)`.
- **Calibration shim is identity.** Needs ≥1k production `(predicted, actual)` pairs before isotonic regression can be fit.
- **MAX_LOOPS = 1500 + 6h wall-clock cap.** Long delays could exhaust this; we'd want re-spawn from the supervisor if a game is suspended overnight.
- **Supabase Marketplace is a convenience layer, not a runtime requirement.** Both Vercel and Railway connect to Supabase directly via the same `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` from the Supabase dashboard. If you ever rotate the key, manually re-sync to both. See [RUNBOOK.md](RUNBOOK.md#supabase-key-rotation).
