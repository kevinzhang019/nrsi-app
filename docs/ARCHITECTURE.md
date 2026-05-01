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
   │     computeNrXi (DP)                      │                  │
   │     publishUpdate ──┐                     │                  │
   │     refresh lock    │                     │                  │
   │     sleep ~7-30s    │                     │                  │
   │  3. exit on Final   │                                        │
   └─────────────────────┼────────────────────────────────────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │   Upstash Redis      │   keys: lib/cache/keys.ts
              │   - nrxi:snapshot    │   ←── single source of truth
              │   - nrxi:games chan  │       for client UI
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
Daily entry point. Fetches today's schedule via `fetchScheduleStep`, immediately calls `seedSnapshotStep(games)` to write a `Pre` stub `GameState` for every scheduled game so the dashboard's Upcoming section is populated before any watcher starts. Then iterates games and `sleep`s until 5 minutes before each first pitch. At each wake, calls `startWatcherStep` (which wraps `start(gameWatcherWorkflow, ...)` because `start()` cannot run inside a workflow context). Persists `{gamePk: runId}` to Redis under `nrxi:runs:{date}` for ops visibility. After spawning all watchers, sleeps 12h and exits.

#### `workflows/game-watcher.ts` — `gameWatcherWorkflow`
The durable per-game poller. Receives `{ gamePk, ownerId, awayTeamName, homeTeamName }`.

**Lifecycle:**
1. Acquire `nrxi:lock:{gamePk}` (90s TTL). If held by another, exit immediately with `{ reason: "lock-held" }`.
2. Loop up to `MAX_LOOPS = 1500`:
   - `fetchLiveDiffStep` with last seen `metaData.timeStamp` for tiny diff payloads (falls back to full feed if no prior state).
   - Compute `inningKey = "${inning}-${half}-${end|live}"` and `lineupHash`. Set `shouldRecompute = status === "Live" && upcoming != null && pitcherId != null && (inningKey changed || lineup changed)`.
   - If recompute: parallel fetch `loadLineupSplitsStep`, `loadParkFactorStep`, `loadWeatherStep`. Then `computeNrXiStep`. Persist results into hoisted `lastNrXi`, `lastEnv`, `lastPitcher*` (workflow scope, not loop scope — see CLAUDE.md bug #5).
   - Build `GameState` from current feed + last computed nrXi. `publishUpdateStep` writes to `nrxi:snapshot` hash.
   - If `status === "Final"`, return `{ reason: "final" }`.
   - Refresh lock TTL, then `sleep(waitSec)` adaptive: Live→`metaData.wait` (~7-10s), Pre→30s, Delayed/Suspended→300s.

#### `workflows/steps/*`
Each step is a `"use step"` function — full Node.js access, automatic retry on throw, durable result caching.

| Step | Purpose | Retries |
|---|---|---|
| `fetch-schedule.ts` | Pull MLB daily schedule | yes |
| `seed-snapshot.ts` | Write `Pre` stub GameStates for every scheduled game via `hsetnx` (never overwrites a real watcher state) | yes |
| `fetch-live-diff.ts` | Pull live feed (full or diff-patch), apply patches | yes |
| `load-lineup-splits.ts` | Resolve pitcher + 9 batters with cached PA-multinomial profiles | yes |
| `load-park-factor.ts` | Baseball Savant scrape: runs index + per-component factors | yes (degrades to 1.0) |
| `load-weather.ts` | covers.com scrape: WeatherInfo + per-component factors | yes (degrades to 1.0) |
| `load-defense.ts` | Statcast scrapes: OAA + framing tables (parallel, 24h cache) | yes (degrades to neutral) |
| `compute-nrXi.ts` | Log5 + applyEnv + applyTtop + applyFraming + applyDefense + Markov chain. Derives per-PA `pReach`/xOBP and `xSlg` from the final multinomial. | n/a |
| `publish-update.ts` | Write `GameState` to Redis snapshot + publish | yes |
| `lock.ts` | `acquire`/`refresh` watcher lock via Redis SETNX | yes |

### API routes

#### `app/api/cron/start-day/route.ts`
GET handler invoked by Vercel Cron at 13:00 UTC. Optional `Bearer $CRON_SECRET` auth. Calls `start(schedulerWorkflow)` and returns `{ ok, runId }`. Also callable manually for testing.

#### `app/api/snapshot/route.ts`
GET. Reads `nrxi:snapshot` via `lib/pubsub/publisher.ts:getSnapshot`, sorts (Live > Delayed > Suspended > Pre > Final, then by inning desc), returns `{ games, ts }`. Used by the SSR initial paint.

#### `app/api/stream/route.ts`
GET. Server-Sent Events stream. On connect, sends a `snapshot` event with current state, then enters a `while !abort` loop polling `nrxi:snapshot` every 2s and emitting `update` events for any changed `gamePk`. 15s heartbeat prevents proxy timeouts. EventSource auto-reconnects on Vercel's ~300s function lifecycle boundary.

#### `app/api/workflows/{scheduler,game-watcher}/route.ts`
POST handlers for manual operational triggers — useful for restarting a watcher after cancellation, or kicking off the scheduler outside the cron window.

### Libraries

#### `lib/mlb/`
- `client.ts` — typed wrappers for `statsapi.mlb.com`. `fetchSchedule`, `fetchLiveFull`, `fetchLiveDiff`, `fetchPerson`, `fetchSplits`, `fetchVenue`. Sets `User-Agent` from env, throws on non-2xx.
- `types.ts` — Zod schemas (`ScheduleResponse`, `PersonResponse`, `SplitsResponse`) and a `LiveFeed` TypeScript type covering live `linescore.offense.{first,second,third}` runner ids and `boxscore...battersFaced` for TTOP. Exports `classifyStatus(detailed, abstract)`.
- `splits.ts` — Two parallel loader sets:
  - **v1 legacy** — `loadBatterProfile` / `loadPitcherProfile` return scalar `obpVs` / `whipVs`. Retained for the deprecated `pReach` path.
  - **v2** — `loadBatterPaProfile` / `loadPitcherPaProfile` return per-handedness `paVs: PaOutcomes` (8-outcome multinomial: 1B/2B/3B/HR/BB/HBP/K/ipOut), with empirical-Bayes shrinkage to `LEAGUE_PA` and a last-30-day blend (graceful fallback to season-only).
- `lineup.ts` — `getUpcomingForCurrentInning(feed)` extracts the next 9 upcoming batters and their pitcher from a `LiveFeed`. Handles `Middle`/`End`/`outs===3` by advancing to the next half-inning. Returns `null` if `boxscore.battingOrder` < 9.

#### `lib/env/`
- `park.ts` — Baseball Savant scraper. `getParkRunFactor` returns the legacy single runs index. `getParkComponentFactors` returns per-outcome handedness-keyed factors `{hr, triple, double, single, k, bb}`, derived from `index_runs` when component fields aren't published in the scrape. `parseSavantHtml` is the testable seam.
- `park-orientation.ts` — outfield bearing (degrees from home plate to dead center) for each park, used to classify `windFromDeg` → `out`/`in`/`cross`. Lookup by team name.
- `weather.ts` — covers.com HTML scraper. `parseCoversHtml(html, awayTeam, homeTeam)` is the testable seam (matches game brick by team city/abbr label, extracts temp/wind/precip/humidity/pressure via regex, classifies wind via the icon's `wind_icons/{compass}.png` filename + park orientation). Returns `WeatherInfo`. Two consumers: `weatherRunFactor` (legacy single scalar, deprecated) and `weatherComponentFactors` (per-outcome multipliers — HR-heavy, K/BB unaffected).
- `defense.ts` — Statcast OAA leaderboard scraper (`parseOaaHtml`). `loadOaaTable(season)` returns `Map<playerId, OaaRow>` (cached 24h). `defenseFactor(fielderIds, table)` sums shrunken OAA across the seven non-battery fielders to produce a multiplier in `[0.90, 1.10]` for the in-play block.
- `framing.ts` — Statcast catcher framing leaderboard scraper (`parseFramingHtml`). `loadFramingTable(season)` returns `Map<catcherId, FramingRow>` (cached 24h). `framingFactors(catcherId, table)` returns `{k, bb}` factors clamped to `[0.95, 1.05]`. `NRXI_DISABLE_FRAMING=1` is the robo-ump kill switch.
- `venues.ts` — venue metadata cache, used for ops display only.
- `__fixtures__/` — captured HTML from Savant + covers.com, used by parse tests so we don't hit the live sites in CI.

#### `lib/parks/`
Pre-built ballpark silhouette data, generated once at build time.
- `shapes.json` — keyed by MLB venueId. Each entry has `{ name, viewBox, d }` where `d` is a single SVG path string (foul-line wedge + outfield outer wall, normalized into a 100×100 viewBox with home plate at the bottom).
- `team-to-venue.ts` — hand-curated map from the GeomMLBStadiums team slug (`angels`, `blue_jays`, …) to MLB Stats API `venueId`, plus a `venueId → park name` map for component labels.
- Refresh via `npm run build:park-shapes` (see `scripts/build-park-shapes.mjs`).

#### `lib/prob/`
Pure, fully unit-tested math.
- `log5.ts` — Generalized multinomial Log5 (`log5Matchup`), switch-hitter routing (`effectiveBatterStance`, `batterSideVs`), full matchup builder (`matchupPa`), and post-matchup environment scaling (`applyEnv`).
- `markov.ts` — 24-state base-out Markov chain. `transitionsForOutcome(outcome, state)` for the 8 PA outcomes; `pAtLeastOneRun(start, lineup)` runs the chain forward through the upcoming order.
- `ttop.ts` — Times-Through-the-Order Penalty: K weakens, BB and HR strengthen each pass through the lineup. `ttoIndex(paInGameForPitcher)`, `applyTtop(pa, paInGameForPitcher)`.
- `framing.ts` — `applyFraming(pa, {k, bb})` reweights the K and BB cells of the multinomial using the live catcher's framing factors.
- `defense.ts` — `applyDefense(pa, factor)` reweights the in-play block (1B/2B/3B/ipOut) using the seven non-battery fielders' aggregated OAA.
- `calibration.ts` — Identity calibrator + isotonic interpolation table loader. Ships as no-op until production `(predicted, actual)` pairs accumulate.
- `expected-stats.ts` — Per-PA derived rate stats: `xObpFromPa(pa)` (= `1 - k - ipOut`, equal to `pReach`) and `xSlgFromPa(pa)` (= bases per AB, excluding BB+HBP from the denominator). Pure helpers used by `computeNrXiStep` to populate `NrXiPerBatter.xSlg` for the lineup UI.
- `odds.ts` — `americanBreakEven`, `impliedProb`, `roundOdds`.
- **Legacy v1** — `reach-prob.ts:pReach`, `inning-dp.ts:pAtLeastTwoReach`. Retained for back-compat; not used by the watcher.

See **[PROBABILITY_MODEL.md](PROBABILITY_MODEL.md)** for the full math and assumptions.

#### `lib/pubsub/`
- `publisher.ts` — `publishGameState(state)` does three things atomically (best-effort): publish to channel, hset to snapshot, expire snapshot. `getSnapshot()` reads the hash and tolerates both string and auto-parsed-object values (CLAUDE.md bug #4).
- `subscriber.ts` — `iterateSnapshotChanges(redis, intervalMs, abort)` is an async generator that polls the snapshot hash, dedupes by JSON signature, and yields `GameState` objects. The SSE route consumes this.

#### `lib/cache/`
- `redis.ts` — singleton Upstash `Redis` instance with lazy init. Reads `KV_REST_API_*` first, falls back to `UPSTASH_REDIS_REST_*`. `cacheJson(key, ttl, loader)` is a small read-through helper.
- `keys.ts` — every Redis key shape lives here. Don't hardcode key strings elsewhere.

##### Caching layout

All keys come from `lib/cache/keys.ts`. Source of truth — don't hardcode key strings elsewhere.

| Key shape | Owner | Value | TTL |
|---|---|---|---|
| `bat:splitsraw:{playerId}:{season}` | `lib/mlb/splits.ts` | raw `SplitsResponse` JSON | 12h |
| `pit:splitsraw:{playerId}:{season}` | `lib/mlb/splits.ts` | raw `SplitsResponse` JSON | 12h |
| `hand:{playerId}` | `lib/mlb/splits.ts:loadHand` | `{ id, fullName, bats, throws }` | 30d |
| `park:factors:{season}` | `lib/env/park.ts` | `ParkRow[]` from Baseball Savant | 24h |
| `oaa:{season}` | `lib/env/defense.ts` | `OaaTable` (per-fielder Outs Above Average) | 24h |
| `framing:{season}` | `lib/env/framing.ts` | `FramingTable` (per-catcher framing runs) | 24h |
| `venue:{venueId}` | `lib/env/venues.ts` | `VenueInfo` | 30d |
| `weather:{gamePk}` | `lib/env/weather.ts` | `WeatherInfo` from covers.com | 30 min |
| `nrxi:lock:{gamePk}` | `workflows/steps/lock.ts` | watcher `ownerId` | 90s |
| `nrxi:runs:{YYYY-MM-DD}` | `workflows/scheduler.ts` | hash `{gamePk: runId}` | 36h |
| `nrxi:snapshot` | `lib/pubsub/publisher.ts` | hash `{gamePk: GameState JSON}` | 24h |
| `nrxi:games` (channel) | `lib/pubsub/publisher.ts` | published `GameState` JSON | n/a |

#### `lib/state/game-state.ts`
The canonical `GameState` type that flows from watcher → Redis → SSE → React. Also exports `isDecisionMoment({status, inning, half, outs, inningState})` used both server-side (when constructing state) and conceptually mirrored in the client-side decision-card highlight rule.

### Frontend

#### `app/page.tsx`
Server component. Suspense-wraps `<GameBoardLoader />` which calls `getInitialGames()` (cached read of `nrxi:snapshot`). Renders header + grid. Skeleton fallback during initial paint.

#### `components/game-board.tsx`
Client. Uses `useGameStream(initial)` to maintain a live `Map<gamePk, GameState>`. Partitions games into four sections — **Highlighted** (`isDecisionMoment === true`), **Active** (Live/Delayed/Suspended and not in a decision moment), **Upcoming** (Pre / Other, sorted by `startTime`), **Finished** (Final). Empty sections are hidden. Each section's grid is wrapped in `motion`'s `<AnimatePresence mode="popLayout">`; each card is a `<motion.div layout layoutId={`card-${gamePk}`}>` so a card moving between sections (e.g. when `isDecisionMoment` flips) cross-fades smoothly without remounting `<GameCard>`. Live SSE updates flow through unaffected since the inner `<GameCard key={gamePk}>` keeps reconciling.

#### `components/game-card.tsx`
Per-game card. Two team rows (mono-spaced score, small-caps name), `<InningState>` block (top/bottom indicator, outs as filled circles), pitcher line, two `<LineupColumn>`s (away + home) with each batter rendered as **hand · F. Lastname · xOBP · xSLG**. Only the at-bat batter's row is highlighted (next-half leadoff is no longer marked). Each team's lineup is wrapped in `overflow-x-auto` with `min-w-max` so the whole list translates as a unit on narrow widths. Footer: `<ProbabilityPill>` with `P(nrXi)` + break-even American odds. Decision moments add `ring-2 ring-[var(--color-accent)]/60` (now green) and a brief flash animation on update.

#### `app/games/[pk]/page.tsx`
Drilldown. Full upcoming-lineup table with each batter's `pReach`%, plus the three-column nrXi/odds/env summary. Same Suspense + connection() pattern as the index page.

#### `components/park-outline.tsx`
Inline SVG glyph rendering each home park's silhouette (foul lines + outfield wall) at ~28px. Reads from `lib/parks/shapes.json` keyed by `game.venue.id`. Hairline 1.25px stroke (`vector-effect: non-scaling-stroke`) — `var(--color-muted)` by default, transitions to `var(--color-accent)` over 240ms when `highlighted` is true so the outline turns green in lockstep with the card's decision-moment ring. Returns `null` when the venueId is unknown so card layout doesn't shift. Slotted into the env-chip row of `<GameCard>` where the text label "Park" used to sit — the outline literally is the label, with the numeric park run-factor rendered to its right.

#### Build-time scripts

##### `scripts/build-park-shapes.mjs`
One-off Node script (`npm run build:park-shapes`). Fetches `https://raw.githubusercontent.com/bdilday/GeomMLBStadiums/master/inst/extdata/mlb_stadia_paths.csv` (~900KB, ~16k rows × 30 parks), filters to `foul_lines` + `outfield_outer` segments, computes a per-park bounding box, scales into a 100×100 viewBox with 4-unit padding, **flips y** (CSV +y is into outfield → SVG +y is downward, so home plate ends up at the bottom), and emits the deterministic `lib/parks/shapes.json`. Output is committed; no runtime CSV fetch.

#### `lib/hooks/use-game-stream.ts`
Client hook. Opens an `EventSource` to `/api/stream`, listens for `snapshot` and `update` events, dispatches into a `useReducer` that maintains `{ byPk, freshIds }`. Auto-reconnects via the browser's built-in EventSource behavior.

## Why these decisions

### Single-poller pattern (lock per gamePk)

Every browser hitting MLB directly would burn through the soft rate limit (~10 req/sec/IP) within minutes once a few users connect. Instead, exactly one watcher polls per game (enforced by `nrxi:lock:{gamePk}`), publishes to Redis, and the SSE route fans out to all clients. With 15 concurrent live games and a ~7s poll cadence, the global request rate is ~2 req/sec — comfortable.

The lock has a 90s TTL and is refreshed every loop iteration. If a watcher process dies (deploy, crash), another can take over after the TTL expires. The `ownerId` is stored in the lock so `refreshWatcherLockStep` can also detect ownership transfer.

### Why Workflow DevKit over cron-every-minute

Two reasons. First, Vercel Cron has a 1-minute minimum interval — too slow for inning transitions. Second, naive long-running serverless functions hit the 300s execution timeout. Workflow DevKit gives us durable `sleep()` that doesn't consume compute (the sleeping run is checkpointed and resumed in a fresh function invocation). Each watcher can run for 4+ hours of game time without paying for idle compute.

The other big win is automatic step retry. If the MLB API returns a 500 mid-inning, the step throws and Workflow retries with exponential backoff. The workflow function above the step doesn't know or care.

### Why Cache Components

Next.js 16's Cache Components mode lets the page shell prerender at build time while dynamic data streams in via Suspense boundaries. First paint is instant (HTML from CDN), live data arrives ~50ms later when the SSE connection establishes. Without this we'd either pay full SSR latency on every request or build a separate static landing page.

Cost: we have to wrap every dynamic data access in `<Suspense>` and call `connection()` inside, and we lose the `runtime`/`dynamic` route segment exports. Worth it for the perceived performance.

## Trade-offs we accepted

- **2-second SSE poll latency.** True Redis pub/sub from Vercel Functions is awkward (each connection is a TCP subscription, Upstash REST doesn't support it, persistent connections fight Fluid Compute's lifecycle). The 2s poll is well under the natural data-change rate (~7s minimum between inning transitions). Sub-second push would be over-engineering. See the conversation history for full analysis.
- **Park + weather double-counting** is now mitigated. v2 applies park factors per outcome (HR most, K/BB not at all) and weather likewise (HR-driven). The combined effect on the multinomial is more principled than the v1 flat multiplier.
- **HTML scraping fragility.** Both Baseball Savant and covers.com return HTML, not stable JSON APIs. Scrapers are wrapped in try/catch with neutral fallbacks, so a layout change degrades gracefully. Captured fixtures in `lib/env/__fixtures__/` give us regression tests for the parsers without hitting live sites in CI. Watch for `park:scrape:failed` and `weather:scrape:failed` log lines.
- **Switch hitters use canonical platoon advantage by default** (v2 `actual` rule). Set `NRXI_SWITCH_HITTER_RULE=max` to revive v1's generous `max(L, R)` rule.
- **Calibration shim is identity.** Ships as a no-op; needs ≥1k production `(predicted, actual)` pairs before isotonic regression can be fit and committed.
- **No retry budget on the workflow loop.** `MAX_LOOPS = 1500` × ~7s = ~3 hours of game time. Long delays could exhaust this; we'd want to handle re-spawn from the scheduler if a game is suspended overnight.
