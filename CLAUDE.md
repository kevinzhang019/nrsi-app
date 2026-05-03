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
| 10 | Rerunning the cron makes scheduled games disappear — pk-list discriminator wipes still-scheduled rows | `services/lib/prune-snapshots.ts`, `services/supervisor.ts` |

## MLB Stats API gotchas

- **Live feed lives at `/api/v1.1/...`**, not `/api/v1/...`. v1 returns 404 for the same path.
- **Split sitCodes are `vl,vr`**, NOT `vsl,vsr`. The wrong codes return an empty `splits[]` array — silent failure, hardest kind of bug.
- **Splits don't exist for players with no PAs in that split this season.** Legacy v1 (`loadBatterProfile`/`loadPitcherProfile`) falls back to prior season (`SEASON - 1`) only when `stats[0].splits` is empty. v2 (`loadBatterPaProfile`/`loadPitcherPaProfile`) goes further: always fetches **both** `SEASON` and `SEASON - 1` in parallel and PA-weighted-blends them with a Marcel-style 3:2 recency multiplier on the rates, then EB-shrinks the combined baseline against true PA at `n0 = 200` and folds in the 30% last-30-day blend when L30 has ≥ 20 PA. `season=YYYY` aggregates exclude postseason for free.
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
- **Snapshot pruning:** supervisor calls `services/lib/prune-snapshots.ts:pruneStaleSnapshots({ todayET })` after seedSnapshot to delete any `nrxi:snapshot` field-keys whose row's own `officialDate < todayET`. Required because `publishGameState` resets the hash's 24h TTL on every tick — without prune, prior-day games linger forever. Discriminator is the row's own date (not the schedule fetch's pk list) so a partial/empty schedule fetch on a rerun can't wipe still-scheduled games. See BUGS.md bug #10.
- **Adaptive sleep:** `services/steps/fetch-live-diff.ts:chooseRecommendedWaitSeconds` — **5s** during active PAs (Live + `inningState ∉ {Middle, End}` + `outs < 3`), **15s** otherwise (inning breaks, pitching changes, replay reviews), **30s** pre-game, **5min** Delayed/Suspended.
- **Hard runtime caps:** `MAX_LOOPS = 1500` and `MAX_RUNTIME_MS = 6h`. A pathological game (extras + delays + scheduling bug) exits cleanly rather than running forever.
- **Logging:** plain `console.log` is fine — Railway captures stdout/stderr. `lib/log.ts` emits structured JSON `{t, level, scope, msg, ...}` filterable in the Railway dashboard.

## Caching keys

All Redis keys live in `lib/cache/keys.ts` — full table of shapes/owners/TTLs in `docs/ARCHITECTURE.md#caching-layout`. Don't hardcode key strings elsewhere.

## Persistence (Supabase)

Permanent archive of finished games lives in Supabase Postgres (free tier via Vercel Marketplace). Three tables, all written together at the watcher's Final exit:
- `games` — one row per Final game; JSONB blobs for linescore / lineups / final_snapshot.
- `inning_predictions` — one row per (game_pk, inning, half); the model's prediction at the start of that half-inning, plus `actual_runs` backfilled from the linescore.
- `plays` — one row per completed plate appearance, keyed `(game_pk, at_bat_index)`. Powers per-inning hitter / pitcher rollups on the history detail page. Captured **once at Final** from `liveData.plays.allPlays`, not per-tick — see "Default decisions" below.

- **Schema:** `supabase/migrations/0001_history.sql` (base) + `0002_extras.sql` (relax `inning between 1 and 12` → `inning >= 1` for extras) + `0003_plays.sql` (per-PA archive). Apply via Supabase dashboard SQL editor or `node --env-file=.env.local scripts/migrate.mjs` (postgres-js, idempotent — every statement is `if not exists` or guarded). Service role is the only writer; RLS stays off.
- **Client:** `lib/db/supabase.ts` follows the `redisRestConfig()` / `redis()` split — `supabaseConfig()` for env-var lookup, `supabaseAdmin()` lazy singleton (service role).
- **Inning-prediction capture point:** `services/capture-inning.ts:buildInningCapture` is a pure helper called from `services/run-watcher.ts` after `state` is built and before `publishUpdateStep`. The **load-bearing guard** is `nrXi.startState.outs === 0 && (bases === 0 || bases === 2)` — that's true exactly at half-inning boundaries: `bases === 0` for regulation (1–9), `bases === 2` for the Manfred runner on 2B in extras (10+). Matches `readMarkovStartState`'s injection on `inningState=middle/end` / `outs >= 3`. The once-per-`${inning}-${half}` map guard prevents subsequent ticks from overwriting.
- **Play-archive capture point:** `lib/history/build-plays.ts:buildPlayRows(feed, gamePk)` is a pure transform called **only at the Final exit branch** in `services/run-watcher.ts`. It iterates `feed.liveData.plays.allPlays`, filters `about.isComplete === true`, and resolves names via `boxscore.teams.{away,home}.players["ID${id}"].person.fullName` with `matchup.batter.fullName` as fallback. Per-tick capture would inflate `saveWatcherState` writes (~80 plays × ~500B per game) without buying anything since the data is history-only — the terminal feed already has the full play log.
- **Persist point:** `persistFinishedGameStep` runs on the Final exit branch in `services/run-watcher.ts`, upserting all three tables in one call. It no-ops if Supabase env vars aren't set, so the watcher's existing behavior is unaffected on dev boxes without DB credentials. Idempotent on `(game_pk)` / `(game_pk, inning, half)` / `(game_pk, at_bat_index)` so retries are safe.
- **Per-inning rollups:** `lib/history/rollup-plays.ts:rollupBatters/rollupPitchers` are pure functions. Caller pre-filters `PlayRow[]` to the desired (inning, half) slice. `ipOuts` is computed by walking plays in `at_bat_index` order and tracking running outs per (inning, half), attributing each `max(0, endOuts − prevOuts)` increment to the pitcher who threw the play.
- **History bucket key:** `lib/db/games.ts:gameDateOf(officialDate, startTime)` prefers `GameState.officialDate` (venue-local YYYY-MM-DD from MLB's `gameData.datetime.officialDate`) over a TZ-converted derivation from `startTime`. Late-night PT games no longer slip into the next UTC day.
- **History UI:** `/history` (date strip + calendar popover, only data-days enabled) and `/history/[pk]` (single wide frozen `<GameCard wide>` whose `<LineScore>` cells are themselves the inning picker — click the inning *number* for full-inning composition, click the runs cell in away/home row for that half. State lives in `<HistoricalGameView>`; `<HistoricalPlaysPanel>` renders per-tab batter / pitcher tables + play log below). Both pages put `connection()` + `await params/searchParams` inside the `<Suspense>` body — never at the page level — to keep Cache Components happy.

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
- **Empirical-Bayes shrinkage** prior strength `n0 = 200` PA, applied against **true** (unweighted) PA so the calibration stays grounded in real sample size. Don't change without a calibration study.
- **Cross-season blend (v2):** `W_CURRENT = 3`, `W_PRIOR = 2` Marcel-style multipliers on per-PA blending of current + prior regular-season splits. Recent year carries 1.5× per-PA weight of prior year in the blended rate. The multiplier biases *which* observations dominate; shrinkage strength stays tied to actual PA. Strict-Marcel form (using `weightedPa = 3·current + 2·prior` as `n` for shrinkage) would silently halve the effective shrinkage strength — would need a calibration retune.
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
- The `pruneStaleSnapshots` call in `services/supervisor.ts` after `seedSnapshot` — without it, prior-day games linger as zombie field-keys forever (BUGS.md bug #9). Don't switch its discriminator back to today's pk list — a rerun whose schedule fetch returns fewer games would wipe still-scheduled games (BUGS.md bug #10). The current row-`officialDate < todayET` form is robust to empty/partial fetches
- `lineupStats` keyed by `Record<string, ...>` not `Map<number, ...>` — Maps don't round-trip through JSON (UI.md → Settings panel; BUGS.md bug #4)

**Watcher scope (bug #5/#7 trap):**
- Hoisted `lastNrXi` / `lastEnv` / `lastPitcher*` vars after the `try {` block in `services/run-watcher.ts` — NOT inside the loop body (BUGS.md bug #5)
- `services/lib/watcher-state.ts:saveWatcherState` runs once per tick, JSON-serializing the hoisted bundle to `nrxi:watcher-state:{gamePk}`. On restart, `loadWatcherState` hydrates it. Folding the save call into a "every N ticks" optimization breaks crash-recovery for capturedInnings
- Hoisted `capturedInnings: Record<string, InningCapture>` and the `outs===0 && (bases===0 || bases===2)` clean-state guard in `buildInningCapture` — folding either back into loop scope or relaxing `outs===0` turns the per-inning archive into a stream of mid-PA snapshots. The `bases===2` allowance is specifically for the Manfred runner on 2B in extras; do not widen it further
- **`buildPlayRows` runs once at the Final exit, NOT per tick.** Folding it into the per-tick path inflates `saveWatcherState` writes for history-only data. The terminal `tick.feed` already carries the full `liveData.plays.allPlays` — the post-game one-shot is the load-bearing choice. Recovery on watcher retry is via the idempotent `(game_pk, at_bat_index)` upsert, same model as `inning_predictions`
- Hoisted `lastLineups` / `lastEnrichedHash` and the `lh !== lastEnrichedHash` enrichment trigger — independent of `shouldRecompute` so Pre-game lineups hydrate immediately (BUGS.md bug #7)
- Hoisted `lastFullInning` / `lastLineupStats` / `lastOppPitcherHash` (UI.md → Settings panel)
- Hoisted `lastAwayPitcher` / `lastHomePitcher` carrying each team's last-used pitcher (UI.md → Pitcher row)
- Hoisted `lastAwayBatterId` / `lastHomeBatterId` — most-recent batter id per team. **Updated only on live-PA ticks** (`status === "Live" && outs < 3 && inningState ∉ {middle, end}`), keyed off `ls.isTopInning`. Frozen across the half-inning break so `extractBatterFocus` can resolve the next-half on-deck leadoff as `order[(idxOfLastBatter + 1) % 9]` for the OTHER team instead of always `order[0]`. Updating on middle/end ticks reintroduces the old "always #1 batter" highlight bug because MLB sometimes pre-flips `offense.batter` to the next half's leadoff during the inning break (UI.md → Lineup row)
- `oppHalfCleanCache` recomputed only in the structural-reload phase, then composed against `upcoming.half` (NOT raw `half`) (BUGS.md bug #8). Skipped when `bottomNinthSkipped` (top-9 with home leading); seeded with `bases: 2` when `upcoming.inning >= 10` (Manfred runner). Score deltas during top-9 flip the predicate, so the score is part of the structural reload trigger
- The conditional 9th-inning top-only branch in the full-inning composer (`bottomNinthSkipped` → `lastFullInning = lastNrXi`, predicate in `services/full-inning.ts:shouldSkipBottomNinth`). Making it unconditional (`upcoming.inning === 9 && upcoming.half === "Top"`) reintroduces a missing bottom-9 when visitors are tied or ahead. Removing the branch entirely reintroduces a hypothetical-bottom multiplier when home is already winning and won't bat
- The split between `structuralKey` and `playStateKey` in the watcher (BUGS.md bug #8)
- **`prewarmBenchAndBullpenStep` is fire-and-forget.** Called from the Phase 1 structural-reload branch in `services/run-watcher.ts` with `void` (NOT awaited). It loads handedness + per-PA splits for every bench hitter and bullpen pitcher on both teams so a future pinch-hit / relief change is a pure Redis cache hit instead of a critical-path MLB Stats API round-trip. Awaiting it would put roster-warmup latency on the prediction critical path; folding the call into `Promise.all` alongside the four blocking loaders defeats the entire point. Errors are caught + warn-logged; the loaders themselves already swallow per-player API errors and fall through to league means
- **Lock semantics:** TTL 30s, background `setInterval` refresher every 10s in `services/lib/lock.ts:startLockRefresher`. Folding the refresher back into the loop reintroduces the long-pre-game-sleep liveness gap
- **Supervisor idle-exit:** `pending.size === 0 && Date.now() >= tomorrow06UTC`. Folding into "exit when pending drains" causes premature exit on overnight games. The 06:00 UTC cutoff is load-bearing
- The `season || season-1` fallback in **legacy v1** `loadBatterProfile` / `loadPitcherProfile` — early-season splits are empty and prior-season is the only useful proxy. The v2 loaders no longer use a fallback; they always fetch both seasons and 3:2-blend (see "Default decisions worth preserving" → "Cross-season blend"). Don't collapse v2 back to the v1 fallback pattern — early-season predictions for veterans would lose ~93% of their useful prior-year signal

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
- `<GameCard>` `wide` prop on the historical detail page — drops `max-w-md`, forces `viewMode = "split"`, surfaces lineups + the `<ProbabilityPill>` even with `historical` (the narrow `historical` listing card via `<HistoricalCardLink>` keeps both hidden for compactness). Both gates (`(!historical || wide)` on the lineup section, `historical && !wide ? null : ...` on the pill) are load-bearing: relax the historical guard outside `wide` and the dashboard listing turns cluttered; tighten them and the detail page goes blank. (UI.md → History page wide card)
- `battingTeam === null` branch in `components/game-card.tsx`'s split layout — both full-inning AND half-inning historical frozen states use this marker to pair the home pitcher above the away lineup column and the away pitcher above the home lineup column. The regular split branch stacks both pitchers at the top, which is right for live games but wrong for history. Don't fold them, and don't reintroduce `battingTeam: "away" | "home"` in `buildFrozenState` — the half-inning view would lose the paired layout and revert to live-game-style stacked pitchers + batter highlights on a frozen lineup. (UI.md → History page wide card)
- `<LineScore>`'s `currentInning={historical ? null : game.inning}` / `half={historical ? null : game.half}` override at the call site in `<GameCard>` — passing the live values into the historical detail page mixes the live half-inning highlight with the selection highlight on the same cells. (UI.md → History page wide card)
- `defaultInningSelection` in `components/historical-game-view-helpers.ts` prefers full-inning over half-inning when both halves are captured. The detail page's primary use is full-inning predictions; flipping the default to "first half-inning" forces a click for the most common view. (UI.md → History page wide card)

**Math / display:**
- `xSlg` field on `NrXiPerBatter` / `PerBatter` — denominator deliberately strips BB+HBP (`1 - bb - hbp`) so the result lines up with conventional baseball-card SLG, not bases-per-PA (UI.md → Lineup row)

**Park outline data pipeline:**
- y-flip in `scripts/build-park-shapes.mjs:ty` — CSV +y is into-outfield; SVG +y is downward. Without the flip, every park renders upside down
- `venue: g.venueId != null ? { id: g.venueId, name: "" } : null` line in `services/steps/seed-snapshot.ts` — empty string is intentional so `<ParkOutline>` renders on Pre-game cards
- The team→venueId map in `lib/parks/team-to-venue.ts` — Athletics → 2529 (Sutter Health Park) but polygon is Oakland Coliseum geometry; Rays → 12 (Tropicana) regardless of relocation

## Validator hook quirks (advisory only)

The session has a `posttooluse-validate` hook that flags things like "Workflow files should import and use logging." It runs a regex against specific lines and frequently misses logging that's actually present. **Treat its suggestions as advisory.** Don't add redundant `console.log` just to silence it. The real signals are: TypeScript errors, build errors, and test failures.
