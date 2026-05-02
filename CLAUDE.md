# CLAUDE.md — nrXi implementation notes

> Read this **before** modifying any code in this repo. It documents project-level guidelines, framework-specific patterns, and the load-bearing invariants that look weird until you know the reason. Long-form prose for individual bugs and UI components has moved into `docs/`; this file is the always-on quick scan.

## At a glance

- **What:** live MLB no-run-scoring-inning probability dashboard
- **Stack:** Next.js 16 App Router (Cache Components on) on **Vercel** for the frontend + a **Railway-hosted Node supervisor** for the live game watchers + Upstash Redis (Vercel Marketplace) + Supabase Postgres (history archive) + Tailwind v4 + Vitest
- **Status:** Vercel frontend at https://nrsi-app.vercel.app; Railway supervisor cron `0 12 * * *`; 174/174 unit tests passing; build green

## Detailed docs

| Doc | When to read |
|---|---|
| `docs/ARCHITECTURE.md` | Data flow, services + components, libraries, Redis caching layout, design rationale |
| `docs/PROBABILITY_MODEL.md` | The full math (Log5 → env → TTOP → framing → defense → Markov → calibration) |
| `docs/BUGS.md` | Full archaeology of every bug listed in the index below — read the relevant entry before touching the surrounding code |
| `docs/UI.md` | Settings panel, dashboard motion, lineup row, pitcher row, park outline, bases diamond — UI contracts and frontend invariants |
| `docs/RUNBOOK.md` | Inspecting Railway runs, raw Redis state, restarting watchers, snapshot zombies, env var checklist, cache flush procedures |

## Bug index — do NOT re-introduce

Full write-ups in `docs/BUGS.md`. Each line: bug # · symptom · primary file.

| # | One-line symptom | Primary file |
|---|---|---|
| 1 | *(no longer reachable — WDK removed)* Workflows never appear in runs list, `/.well-known/workflow/v1/*` 404. Re-adding `withWorkflow()` to `next.config.ts` would refire the WDK cron and re-burn the Functions cap. | `next.config.ts` |
| 2 | App throws `Missing UPSTASH_REDIS_REST_URL` even though Marketplace Upstash is provisioned | `lib/cache/redis.ts` |
| 3 | Build fails with `Uncached data was accessed outside of <Suspense>` — Cache Components needs `connection()` + `<Suspense>` | dynamic pages and route handlers |
| 4 | `JSON.parse` silently throws because `@upstash/redis` auto-parses JSON on read | `lib/pubsub/publisher.ts`, `lib/pubsub/subscriber.ts`, `app/games/[pk]/page.tsx` |
| 5 | Watcher overwrites Redis with `null` fields on steady-state ticks — loop-scoped `let` instead of watcher scope | `services/run-watcher.ts` (hoisted vars after `try {` block) |
| 6 | Park / weather scrapers silently return neutral 1.0 — broken Savant key + dead covers.com URL | `lib/env/park.ts`, `lib/env/weather.ts`, `lib/env/park-orientation.ts` |
| 7 | Every batter renders as a righty — boxscore omits `batSide` for most players | `lib/mlb/extract.ts`, `services/steps/enrich-lineup-hands.ts` |
| 8 | Predictions stale within a half-inning + squared/missing-half full-inning at transitions | `services/run-watcher.ts` (two-phase trigger, `services/start-state.ts:readMarkovStartState`) |
| 9 | Zombie "Live" games linger on the dashboard after a paused/crashed runtime | `services/lib/prune-snapshots.ts`, called from `services/supervisor.ts` |

## MLB Stats API gotchas

- **Live feed lives at `/api/v1.1/...`**, not `/api/v1/...`. v1 returns 404 for the same path.
- **Split sitCodes are `vl,vr`**, NOT `vsl,vsr`. The wrong codes return an empty `splits[]` array — silent failure, hardest kind of bug.
- **Splits don't exist for players with no PAs in that split this season.** Code falls back to prior season (`SEASON - 1`) if `stats[0].splits` is empty. See `lib/mlb/splits.ts:loadBatterProfile`/`loadPitcherProfile` (legacy) and `loadBatterPaProfile`/`loadPitcherPaProfile` (v2 — also blends in last-30-day with graceful fallback).
- **Switch-hitter platoon resolution defaults to canonical** (`actual` rule — bat opposite of pitcher hand). Legacy `max(L, R)` reachable via `NRXI_SWITCH_HITTER_RULE=max`. Implementation in `lib/prob/log5.ts:effectiveBatterStance` and `batterSideVs`.
- **`boxscore.teams.*.battingOrder` is empty until lineups post** (~30 min before first pitch). `getUpcomingForCurrentInning` returns `null` if the array is < 9 long.
- **`outs === 3` flickers at half-inning transitions.** Don't use raw `outs` as the recompute trigger; use a composite `inningKey = "${inning}-${half}-${outs >= 3 ? 'end' : inningState || 'live'}"`.
- **Respect `metaData.wait`.** The live feed includes a server-side hint (typically 10s). Polling faster wastes calls and risks rate limits.
- **`User-Agent` matters.** Set `MLB_USER_AGENT` env var to identify yourself; the default is `nrxi-app/0.1`.

## Railway watcher conventions

The watcher used to run on Vercel Workflow DevKit; that's been replaced by a Railway-hosted Node supervisor. Detail in `docs/ARCHITECTURE.md`; ops in `docs/RUNBOOK.md`. Invariants:

- **Cron:** `0 12 * * *` UTC declared in `railway.toml`. Entry point `bin/supervisor.ts` → `services/supervisor.ts:runSupervisor`. Restart policy `NEVER` so the supervisor's clean exit scales the container to zero.
- **Pre-game lead 90s.** Each watcher task scheduled at `gameDate − 90s` via `setTimeout`; idle until then.
- **Idle-exit predicate:** `pending.size === 0 && Date.now() >= tomorrow06UTC`. Off-season days exit within seconds. The 06:00 UTC cutoff protects late-running doubleheaders.
- **Single-instance lock:** every watcher acquires `nrxi:lock:{gamePk}` with a **30s TTL** via `services/lib/lock.ts:acquireWatcherLock`. A background `setInterval` refreshes every 10s in `startLockRefresher` — decoupled from loop cadence so long pre-game / Delayed sleeps don't risk lock expiration.
- **State durability:** hoisted vars (`lastNrXi`, `lastEnv`, `capturedInnings`, etc.) JSON-serialized to `nrxi:watcher-state:{gamePk}` on every tick (`services/lib/watcher-state.ts:saveWatcherState`). On watcher restart, hydrated by `loadWatcherState`. Trigger keys are deliberately NOT persisted — first tick after restart unconditionally fires Phase 1 reload to rebuild caches.
- **Snapshot pruning:** supervisor calls `services/lib/prune-snapshots.ts:pruneStaleSnapshots(todaysGamePks)` after seedSnapshot to delete any `nrxi:snapshot` field-keys not in today's schedule. Required because `publishGameState` resets the hash's 24h TTL on every tick — without prune, prior-day games linger forever.
- **Adaptive sleep:** `services/steps/fetch-live-diff.ts:chooseRecommendedWaitSeconds` — **5s** during active PAs (Live + `inningState ∉ {Middle, End}` + `outs < 3`), **15s** otherwise (inning breaks, pitching changes, replay reviews), **30s** pre-game, **5min** Delayed/Suspended.
- **Hard runtime caps:** `MAX_LOOPS = 1500` and `MAX_RUNTIME_MS = 6h`. A pathological game (extras + delays + scheduling bug) exits cleanly rather than running forever.
- **Logging:** plain `console.log` is fine — Railway captures stdout/stderr. `lib/log.ts` emits structured JSON `{t, level, scope, msg, ...}` filterable in the Railway dashboard.

## Caching keys

All Redis keys live in `lib/cache/keys.ts` — full table of shapes/owners/TTLs in `docs/ARCHITECTURE.md#caching-layout`. Don't hardcode key strings elsewhere.

## Persistence (Supabase)

Permanent archive of finished games + per-inning predictions lives in Supabase Postgres (free tier via Vercel Marketplace). Two tables: `games` (one row per Final game, JSONB blobs for linescore/lineups/final_snapshot) and `inning_predictions` (one row per (game_pk, inning, half) capturing the model's prediction at the start of that half-inning, plus actual_runs backfilled from the linescore).

- **Schema:** `supabase/migrations/0001_history.sql` (base) + `0002_extras.sql` (relax `inning between 1 and 12` → `inning >= 1` for extras). Apply via Supabase dashboard SQL editor or `node --env-file=.env.local scripts/migrate.mjs` (postgres-js, idempotent — every statement is `if not exists` or guarded). Service role is the only writer; RLS stays off.
- **Client:** `lib/db/supabase.ts` follows the `redisRestConfig()` / `redis()` split — `supabaseConfig()` for env-var lookup, `supabaseAdmin()` lazy singleton (service role).
- **Capture point:** `services/capture-inning.ts:buildInningCapture` is a pure helper called from `services/run-watcher.ts` after `state` is built and before `publishUpdateStep`. The **load-bearing guard** is `nrXi.startState.outs === 0 && (bases === 0 || bases === 2)` — that's true exactly at half-inning boundaries: `bases === 0` for regulation (1–9), `bases === 2` for the Manfred runner on 2B in extras (10+). Matches `readMarkovStartState`'s injection on `inningState=middle/end` / `outs >= 3`. The once-per-`${inning}-${half}` map guard prevents subsequent ticks from overwriting.
- **Persist point:** `persistFinishedGameStep` runs on the Final exit branch in `services/run-watcher.ts`. It no-ops if Supabase env vars aren't set, so the watcher's existing behavior is unaffected on dev boxes without DB credentials.
- **History bucket key:** `lib/db/games.ts:gameDateOf(officialDate, startTime)` prefers `GameState.officialDate` (venue-local YYYY-MM-DD from MLB's `gameData.datetime.officialDate`) over a TZ-converted derivation from `startTime`. Late-night PT games no longer slip into the next UTC day.
- **History UI:** `/history` (date strip + calendar popover, only data-days enabled) and `/history/[pk]` (inning tabs 1–9 + extras when present, frozen-state `<GameCard>` reuse via `<HistoricalGameView>`). Both pages put `connection()` + `await params/searchParams` inside the `<Suspense>` body — never at the page level — to keep Cache Components happy.

## Default decisions worth preserving

- **v2 model is the default.** Probability pipeline is `Log5 → applyEnv → applyTtop → applyFraming → applyDefense → 24-state Markov → calibrate`. The legacy `pReach` + 2-state DP path in `lib/prob/{reach-prob,inning-dp}.ts` is retained for back-compat but is **not invoked by the watcher**. See `docs/PROBABILITY_MODEL.md`.
- **Switch-hitter rule:** `actual` (canonical platoon advantage) by default — switch hitters bat opposite the pitcher's throwing hand. Legacy v1 `max(L, R)` reachable via `NRXI_SWITCH_HITTER_RULE=max`.
- **nrXi definition:** v2 computes `P(nrXi) = 1 − P(≥1 run scores)` directly via the Markov chain — no proxy. The legacy `pHitEvent` field name on `NrXiResult` is preserved for UI back-compat but its semantics are now exact.
- **Decision moment (half-inning):** `outs === 3` OR `inningState ∈ {middle, end}` OR `(half === "Top" && outs === 0)`. Fires at every half-boundary.
- **Decision moment (full-inning):** half-inning predicate AND `upcoming.half === "Top"`. Fires only when the next batter will lead off a TOP half (= a new inning is approaching). That covers end-of-bottom (upcoming flips to Top of N+1), inningState="end" between innings, and start of any inning's top (mid-game leadoff or game start). Does NOT fire at top→bottom mid-inning flips. **Why upcoming.half (not raw `state.half` + flag combos):** MLB's live feed inconsistently uses inningState="middle" vs "end" at boundaries, sometimes advances `inning`/`isTopInning` before posting an end state. `upcoming.half` from `getUpcomingForCurrentInning` is the canonical "next half to bat" and is the only reliable signal.
- **Full-inning composition:** `(rest_of_top × clean_bottom)` mid-top → `clean_bottom` at top-end (= half-inning) → `rest_of_bottom` mid-bottom → `clean_top × clean_bottom` of next inning at bottom-end. **9th inning is conditionally top-only** — predicate `services/full-inning.ts:shouldSkipBottomNinth({inning, half, homeRuns, awayRuns})` returns true only at top-9 *and* home is currently leading (bottom-9 won't be played). Tied or visitors-ahead in top-9 → bottom-9 plays and we compose normally. Bottom of 9 + extras always compose normally.
- **Manfred runner (extras):** at any half-boundary in inning ≥ 10, `readMarkovStartState` returns `{outs: 0, bases: 2}` (runner on 2B). Mid-PA we trust the live feed's offense state — MLB Stats API populates the Manfred runner there at extra-half leadoff. The `oppHalfCleanCache` also seeds `bases: 2` when `upcoming.inning >= 10`. Per-inning capture accepts both `bases === 0` (regulation) and `bases === 2` (Manfred) as clean half-boundary state.
- **Break-even rounding:** American odds rounded to nearest 5 in display; raw value used for EV calc.
- **League-rate constants** (`LEAGUE_PA` in `lib/mlb/splits.ts`) are 2024–2025 averages by pitcher hand. Refresh annually.
- **Empirical-Bayes shrinkage** prior strength `n0 = 200` PA. Don't change without a calibration study.
- **TTOP factors** (`lib/prob/ttop.ts`) come from Tango / Lichtman / Carleton published values. Don't tune without backtest data.
- **Calibration shim is identity in v1.** Fit isotonic regression from production `(predicted, actual)` pairs once ≥1k inning outcomes accumulate, then load via `loadCalibrator(table)`.
- **v2.1 framing + OAA:** EB shrinkage priors `n0 = 2000` called pitches (framing), `n0 = 200` opportunities (OAA). Factor clamps: framing `[0.95, 1.05]`, defense `[0.90, 1.10]`. Both default to identity when scrape fails or live alignment is missing — pipeline degrades gracefully to v2.
- **Robo-ump kill switch:** `NRXI_DISABLE_FRAMING=1` zeroes the framing effect. Flip when MLB's ABS challenge system goes full-season.
- **Live defensive alignment** read from `liveData.linescore.defense.{catcher, first, second, third, shortstop, left, center, right}` ids each tick. The watcher's `defenseAlignmentKey` is part of the recompute trigger so defensive subs auto-invalidate the cache.
- **User-facing settings defaults:** `predictMode: "full"`, `viewMode: "single"` (`lib/hooks/use-settings.tsx`). Both defaults are the LEFT option of their toggle. Changing the defaults is a UX call — be deliberate.

## Don't change without thinking

Each line is a load-bearing invariant. Where there's deeper context, the parenthetical points at `docs/BUGS.md` or `docs/UI.md`.

**Redis / persistence:**
- The `JSON.parse`-tolerance in `getSnapshot` / `iterateSnapshotChanges` / `getGame` (BUGS.md bug #4)
- The `KV_REST_API_*` fallback in `lib/cache/redis.ts` (BUGS.md bug #2). On Railway, use the read/write token (`KV_REST_API_TOKEN`), NOT `KV_REST_API_READ_ONLY_TOKEN` — the watcher writes constantly
- The `hsetnx` (NOT `hset`) call in `services/steps/seed-snapshot.ts` — `hset` would clobber any watcher that already published a real state, replacing live data with a `Pre` stub
- The `pruneStaleSnapshots` call in `services/supervisor.ts` after `seedSnapshot` — without it, prior-day games linger as zombie field-keys forever (BUGS.md bug #9)
- `lineupStats` keyed by `Record<string, ...>` not `Map<number, ...>` — Maps don't round-trip through JSON (UI.md → Settings panel; BUGS.md bug #4)

**Watcher scope (bug #5/#7 trap):**
- Hoisted `lastNrXi` / `lastEnv` / `lastPitcher*` vars after the `try {` block in `services/run-watcher.ts` — NOT inside the loop body (BUGS.md bug #5)
- `services/lib/watcher-state.ts:saveWatcherState` runs once per tick, JSON-serializing the hoisted bundle to `nrxi:watcher-state:{gamePk}`. On restart, `loadWatcherState` hydrates it. Folding the save call into a "every N ticks" optimization breaks crash-recovery for capturedInnings
- Hoisted `capturedInnings: Record<string, InningCapture>` and the `outs===0 && (bases===0 || bases===2)` clean-state guard in `buildInningCapture` — folding either back into loop scope or relaxing `outs===0` turns the per-inning archive into a stream of mid-PA snapshots. The `bases===2` allowance is specifically for the Manfred runner on 2B in extras; do not widen it further
- Hoisted `lastLineups` / `lastEnrichedHash` and the `lh !== lastEnrichedHash` enrichment trigger — independent of `shouldRecompute` so Pre-game lineups hydrate immediately (BUGS.md bug #7)
- Hoisted `lastFullInning` / `lastLineupStats` / `lastOppPitcherHash` (UI.md → Settings panel)
- Hoisted `lastAwayPitcher` / `lastHomePitcher` carrying each team's last-used pitcher (UI.md → Pitcher row)
- `oppHalfCleanCache` recomputed only in the structural-reload phase, then composed against `upcoming.half` (NOT raw `half`) (BUGS.md bug #8). Skipped when `bottomNinthSkipped` (top-9 with home leading); seeded with `bases: 2` when `upcoming.inning >= 10` (Manfred runner). Score deltas during top-9 flip the predicate, so the score is part of the structural reload trigger
- The conditional 9th-inning top-only branch in the full-inning composer (`bottomNinthSkipped` → `lastFullInning = lastNrXi`, predicate in `services/full-inning.ts:shouldSkipBottomNinth`). Making it unconditional (`upcoming.inning === 9 && upcoming.half === "Top"`) reintroduces a missing bottom-9 when visitors are tied or ahead. Removing the branch entirely reintroduces a hypothetical-bottom multiplier when home is already winning and won't bat
- The split between `structuralKey` and `playStateKey` in the watcher (BUGS.md bug #8)
- **Lock semantics:** TTL 30s, background `setInterval` refresher every 10s in `services/lib/lock.ts:startLockRefresher`. Folding the refresher back into the loop reintroduces the long-pre-game-sleep liveness gap
- **Supervisor idle-exit:** `pending.size === 0 && Date.now() >= tomorrow06UTC`. Folding into "exit when pending drains" causes premature exit on overnight games. The 06:00 UTC cutoff is load-bearing
- The `season || season-1` fallback in `loadBatterProfile` / `loadPitcherProfile` — early-season splits are empty and prior-season is the only useful proxy

**Watcher state reads:**
- `readMarkovStartState` (in `services/start-state.ts` for unit-testability) short-circuits to `{outs: 0, bases: 0}` when `inningState` is `middle`/`end` OR `outs >= 3` — and to `{outs: 0, bases: 2}` (Manfred runner on 2B) when the upcoming inning is ≥ 10. Mid-PA reads the feed's offense state directly (BUGS.md bug #8)
- `readDisplayBases` vs `readMarkovStartState` — they diverge intentionally at half-boundaries; folding them breaks either display or probability (UI.md → Bases diamond)
- **Pitch count read fresh every tick** in the state-construction block, NOT cached in watcher scope — pitch count changes on every pitch, far more often than structural reload (UI.md → Pitcher row)

**Framework / config:**
- **Do NOT re-add `withWorkflow()` to `next.config.ts`.** It would re-fire the WDK cron and re-burn the Vercel Functions cap. Railway is the cron source now (`railway.toml`). See BUGS.md bug #1
- `await connection()` at the top of every dynamic route handler and dynamic page (BUGS.md bug #3)
- The `vl,vr` sitCodes in `lib/mlb/client.ts:fetchSplits` and `lib/mlb/splits.ts`

**Scrapers (bug #6):**
- `parseSavantData` team-field order (`name_display_club` first)
- `SAVANT_NAME_ALIAS` (`d-backs` → `Diamondbacks`, `a's` → `Athletics`)
- `COVERS_URL` (only `www.covers.com/sport/mlb/weather` works)
- `COVERS_TEAM` labels (NY Yankees / Chi. Cubs / LA Dodgers etc.)
- Wind direction is **FROM** convention; `classifyWind` flips it via park orientation

**Type-system guards:**
- `LineupEntry.bats: HandCode | null` (`lib/mlb/extract.ts`) — narrowing back to non-null reintroduces the bug-#7 silent default-to-R lie
- `pNoHitEventFullInning === null` when opposing pitcher unknown — UI renders `—`. **Do not** fall back to `pNoHitEvent` (UI.md → Settings panel)

**UI structure:**
- `layoutId={`card-${gamePk}`}` on the `motion.div` wrapper in `components/game-board.tsx` — without a stable `layoutId`, cards moving between section `<AnimatePresence>` parents would unmount and lose cross-section fade (UI.md → Dashboard sectioning)
- `overflow-x-auto` wrapper around each `<ol>` in `components/lineup-column.tsx` paired with `min-w-max` and `whitespace-nowrap` — the lineup section translates as a unit (UI.md → Lineup row)
- `shrink-0` on xOBP/xSLG stat spans in `lineup-column.tsx` — without it, flex compresses the columns under long names (UI.md → Lineup row)
- `BasesDiamond` viewBox top-padding (`y=7` for 2B, viewBox height 22) — reverting clips the 2B square (UI.md → Bases diamond)
- `BasesDiamond` `fill-[var(--color-accent)]` ↔ `fill-transparent` swap (NOT `fill-none`) — without `fill-transparent`, ancestor focus surfaces the SVG default fill = black (UI.md → Bases diamond)
- `LineupColumn`'s empty-string label suppression — lets `<LineupSinglePane>` reuse the column without a duplicate header (UI.md → Settings panel)
- Single-pane `selectedSide` state lives in `GameCard`, not `LineupSinglePane` — both pitcher row and lineup pane derive from it (UI.md → Pitcher row)
- `SuppressPlayerLinksContext` in `components/lineup-column.tsx` — `<HistoricalCardLink>` wraps the whole `<GameCard>` in a Next `<Link>` (renders as `<a>`); without the suppression context, the inner player/pitcher `<a>` tags produce nested-`<a>` hydration errors. `LineupColumn` and `PitcherRow` swap to `<span>` when the context flag is true (UI.md → History page)

**Math / display:**
- `xSlg` field on `NrXiPerBatter` / `PerBatter` — denominator deliberately strips BB+HBP (`1 - bb - hbp`) so the result lines up with conventional baseball-card SLG, not bases-per-PA (UI.md → Lineup row)

**Park outline data pipeline:**
- y-flip in `scripts/build-park-shapes.mjs:ty` — CSV +y is into-outfield; SVG +y is downward. Without the flip, every park renders upside down
- `venue: g.venueId != null ? { id: g.venueId, name: "" } : null` line in `services/steps/seed-snapshot.ts` — empty string is intentional so `<ParkOutline>` renders on Pre-game cards
- The team→venueId map in `lib/parks/team-to-venue.ts` — Athletics → 2529 (Sutter Health Park) but polygon is Oakland Coliseum geometry; Rays → 12 (Tropicana) regardless of relocation

## Validator hook quirks (advisory only)

The session has a `posttooluse-validate` hook that flags things like "Workflow files should import and use logging." It runs a regex against specific lines and frequently misses logging that's actually present. **Treat its suggestions as advisory.** Don't add redundant `console.log` just to silence it. The real signals are: TypeScript errors, build errors, and test failures.
