# Operational runbook

Everyday inspection, recovery, and cache-management commands. Most local commands assume `.env.local` is loaded for the Redis + Supabase tokens (`bin/*` scripts auto-load it via `services/lib/load-env.ts`; raw `curl` against Upstash needs `set -a; source .env.local; set +a`).

The watcher lives on **Railway**; the frontend on **Vercel**; data in **Upstash Redis** + **Supabase**. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system picture.

---

## Inspecting Railway runs

The supervisor service runs at:
- **Project:** `dee88e6b-6ae3-4e44-a0f8-eb3987216457`
- **Service:** `f6828c0b-45f9-4c4f-b3b1-edb2421ade20`
- **Cron:** `0 12 * * *` (declared in `railway.toml`)

Tail logs from the Railway dashboard → service → Logs. Logs are structured JSON, one line per event. Useful filter terms:
- `scope:supervisor` — supervisor lifecycle (`start`, `schedule`, `seeded`, `idle-deadline`, `idle-exit`, `aborted`).
- `scope:watcher` — per-game watcher events (`start`, `tick`, `final`, `lock-held-by-other`, `max-loops`, `max-runtime`, `loop:error`, `graceful-exit:publish-synthetic`, `graceful-exit:skipped`, `upsertInningPrediction:fail`).
- `scope:step` — individual step calls (`fetchSchedule:ok`, `seedSnapshot:ok`, `publishUpdate:ok`, `enrichLineupHands:ok`, etc.).
- `scope:retry` — `withRetry` exponential-backoff events.
- `scope:lock` — acquire / refresh / failure events.
- `scope:prune` — snapshot prune step output.
- `scope:stale-live-detector` — supervisor's idle-loop snapshot scanner. `pass {total, staleLive, cleaned}` summary; `cleaning {gamePk, lastInning, lastHalf, ageMs}` per cleaned entry.
- `scope:sweep-finalize` — supervisor's idle-loop + exit-time post-game persistence sweep. `pass {gameDate, candidates, finalized, errors}` summary; `game:fail {gamePk, err}` per-game errors.
- `scope:finalizeGame` — the actual Supabase finalize call invoked by the sweep. `ok {gamePk, plays, innings}` on success; `actual_runs:fail` on a non-fatal per-half UPDATE error.
- `scope:xstats` / `scope:stuff` / `scope:workload` — v2.2 model-input scrapes. `scrape:failed` / `fail` means the model is running without that denoiser/bias on this cache window — never fatal. The watcher continues with identity factors. Sustained failures suggest upstream URL drift (FG especially) or rate-limit; cache-flush + retry once upstream is healthy. See [One-time cache flush after scraper deploys](#one-time-cache-flush-after-scraper-deploys).

JSON shape: `{t, level, scope, msg, ...payload}`. `gamePk` is in payload for per-game events.

---

## Reading current state

```bash
# Field-key dump of nrxi:snapshot (read-only, no writes)
npx tsx bin/inspect-snapshot.ts

# Snapshot via the public API (requires Vercel SSO if project is restricted)
curl -s https://nrsi-app.vercel.app/api/snapshot | python3 -m json.tool

# Raw Redis (load env first)
set -a; source .env.local; set +a
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/hgetall/nrxi:snapshot"
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/get/nrxi:lock:<gamePk>"
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/get/nrxi:watcher-state:<gamePk>"

# Per-PA archive sanity check (Supabase). After a Final game completes, the
# row count for that game should match the boxscore PA count (~70–90 for a
# 9-inning game). Run via the Supabase SQL editor or `scripts/sql.mjs`:
#   select count(*) from plays where game_pk = <pk>;
#   select inning, half, count(*) from plays where game_pk = <pk>
#     group by inning, half order by inning, half;
```

Common log signatures to watch for:
- `park:scrape:failed` / `weather:scrape:failed` — fixture-driven tests should also be failing in CI; see [BUGS.md](BUGS.md) bug #6.
- `lock-held-by-other` — a second watcher tried to spawn for a `gamePk` that already had one. Expected on manual triggers overlapping with cron.
- `prune:snapshots {deleted: N}` where `N > 0` — supervisor cleaned a row whose `officialDate` was older than today (ET). Healthy on the first cron firing after a day rollover; unhealthy if it keeps reporting `deleted > 0` within the same ET day (see [BUGS.md](BUGS.md) bug #9). On a same-day rerun, `deleted` should be 0 — non-zero suggests rows were written without `officialDate` and the parse-tolerance silently kept them yesterday.
- `watcher:final {gamePk, innings}` — emitted on a game's normal Final exit. `innings` is the count of half-inning predictions the watcher's in-process `capturedInnings` map saw during the game (each one was already written to Supabase via the per-boundary fire-and-forget `upsertInningPrediction`). Watcher does NO DB writes here — it just clears watcher state and exits. The supervisor's `sweepFinalize` lands `games`/`plays`/`actual_runs` within ≤60s.
- `watcher:upsertInningPrediction:fail {gamePk, key, err}` — per-boundary write to Supabase failed. Logged but doesn't block the tick — the supervisor's `sweepFinalize` backstops missing rows on its next iteration. Sustained patterns suggest Supabase free-tier throttle or a credentials issue.
- `watcher:graceful-exit:publish-synthetic {gamePk, reason, lastInning, lastHalf, lastStatus}` — watcher hit a non-Final exit (`max-loops` / `max-runtime` / `abort` / `error`). Published `{ ...lastPublishedState, status: "Final" }` so the dashboard moves the game out of Active, then cleared the watcher-state Redis key. **No DB writes here** — captured per-inning predictions are already in Supabase (per-boundary writes), and `sweepFinalize` will land `games`/`plays`/`actual_runs` once MLB flips the game to Final. Expected occasionally on container redeploys (`reason: "abort"`); a sustained pattern with `reason: "max-loops"` or `reason: "max-runtime"` suggests games are running longer than the budget. See [BUGS.md](BUGS.md) bug #11 (stuck-Live snapshots) and bug #12 (per-inning persistence).
- `watcher:graceful-exit:skipped {gamePk, reason, detail}` — synthetic Final publish was deliberately skipped. Two sub-cases via the `detail` field: `"no lastPublishedState"` (watcher exited before its first `publishUpdateStep`) or `"lastPublishedState status=Pre — leaving stub in place"` (watcher died mid-pre-game under the long pre-game lead; flipping an Upcoming card to Finished would be wrong UI). In both cases watcher-state is cleared so the next supervisor cron rebuilds from scratch.
- `watcher:loop:error` — uncaught throw from a step. Followed by `graceful-exit:publish-synthetic`. Investigate the root cause; recurring errors in the same `gamePk` mean the next supervisor spawn will hit the same step and exit again.
- `stale-live-detector:cleaning {gamePk, ageMs}` — the supervisor scanner found a snapshot whose lock is gone and `updatedAt` is stale. Republished synthetic Final. A burst of these right after a Railway redeploy is expected (in-process `gracefulExit` couldn't run for everyone). Sustained / non-deploy-correlated `cleaning` events suggest a class of watcher kill that bypasses both gracefulExit and the lock refresher (process OOM most likely).
- `sweep-finalize:pass {gameDate, candidates, finalized, errors}` — supervisor's post-game persistence sweep iteration. `candidates` is the count of today-bucket games whose archive isn't fully written; `finalized` is how many were flipped to Final per a fresh `fetchLiveFull` and persisted via `finalizeGame`; `errors` counts per-game failures (logged separately as `sweep-finalize:game:fail`). Quiet under normal conditions (only logged when `finalized > 0` or `errors > 0`).
- `finalizeGame:ok {gamePk, plays, innings}` — successful `finalizeGame` call. `plays` is the count of completed PAs upserted into the `plays` table (~70–90 for a 9-inning game, more for extras); `innings` is the count of `linescore.innings[]` entries for which `actual_runs` UPDATEs were dispatched. `plays: 0` on a real Final game means either the live feed dropped `allPlays` (rare — investigate) or the `0003_plays.sql` migration hasn't been applied.

---

## Expected pre-game state

Watchers spawn at `gameDate − 6h` (`PRE_GAME_LEAD_MS = 6h`). Day games (start ≤ 18:00 UTC) hit `Math.max(now, gameDate - 6h)` resolving to supervisor wake and start watching immediately; night games sit in `setTimeout` (zero resource cost — no Redis, no MLB calls, no lock) until their slot arrives. Pre-game ticks fire at 30-min cadence; once both lineups post and probable pitchers are known, the watcher runs the same Phase 1 + Phase 2 pipeline as live and surfaces a first-inning prediction on the dashboard. Persistence to Supabase is still gated on `status === "Live"`, so `inning_predictions` rows only land at first pitch.

The 6h window is the resource-efficiency knob: lineups typically post 30min-3h before first pitch, and probable pitchers are usually locked by T-6h. A wider lead would just burn Redis lock-refresh ops (10s cadence × extra hours) and MLB feed polls during the long stretch where MLB hasn't published anything yet.

What a healthy pre-game snapshot looks like a few hours before first pitch:

```bash
set -a; source .env.local; set +a
GAMEPK=<pk>
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" \
  "$KV_REST_API_URL/hget/nrxi:snapshot/$GAMEPK" \
  | jq -r '.result' \
  | jq '{status, detailedState, updatedAt, pNoHitEvent, pitcher: .pitcher.id, lineups: (.lineups != null)}'
```

- **Before lineups post:** `{status: "Pre", pNoHitEvent: null, pitcher: null, lineups: false}`. Identical to the seeded `seedSnapshotStep` stub. The watcher publishes this every 30 min (refreshing `updatedAt`) until lineups arrive.
- **After lineups post (~30 min before first pitch typically):** `{status: "Pre", pNoHitEvent: 0.6x, pitcher: <id>, lineups: true}`. The dashboard's Upcoming card shows a real `P(nr1i) / <odds>` pill, both lineup columns are populated, and the pitcher row carries the probable starter. Any lineup/pitcher change within 30 min triggers a Phase 1 reload on the next tick and a fresh prediction.
- **At first pitch:** `status` flips to `"Live"`, `atBatIndex` becomes a real value, Phase 2 recomputes once more, and the `(gamePk, 1, "Top")` row appears in `inning_predictions` — that row is the live recompute, not any earlier preview.

If a pre-game card on the dashboard is still showing the empty `nrXi / —` pill within 30 min of first pitch, check that lineups have actually posted on MLB's side (`curl -s "https://statsapi.mlb.com/api/v1.1/game/$GAMEPK/feed/live" | jq '.liveData.boxscore.teams.away.battingOrder | length'`). A length of 0 means MLB hasn't published the lineup yet — wait. A length of 9 with no prediction on our side means the watcher is stuck or crashed; see "Recovering from a stuck-Pre snapshot" below.

Log signatures while pre-game compute is healthy:
- `watcher:tick {gamePk, status: "Pre", shouldReloadStructure: true, shouldRecomputePlay: true}` on the first tick after lineups post.
- `step:loadLineupSplits:ok` / `step:loadParkFactor:ok` / `step:loadWeather:ok` / `step:loadDefense:ok` blocks running during pre-game ticks — same shape as live ticks.
- `watcher:tick {status: "Pre", shouldReloadStructure: false, shouldRecomputePlay: false}` on subsequent ticks where nothing changed. The 30-min sleep follows.
- Absence of `watcher:upsertInningPrediction:fail` during Pre — the capture block is short-circuited entirely while `status !== "Live"`, so no Supabase calls run yet.

---

## Recovering from a deploy-during-cron kill

Pushing to git triggers a Railway build, and when the new image becomes ready, Railway **SIGTERMs the currently-running cron container** to swap in the new deployment. The supervisor's `handleSignal` calls `ac.abort()`, the idle loop exits cleanly with `reason: "aborted"`, and every watcher task that was still in `sleepMs(delayMs, signal)` (waiting for its pre-game window) bails before `runWatcher` is ever called. **The new image does not run** — cron services only execute at the scheduled time. Net effect: today's seeded snapshots stay frozen at `status: "Pre"` with the seed `updatedAt`, no watchers run, and the dashboard's Active section stays empty for the rest of the day.

**How to tell this happened:**

```bash
set -a; source .env.local; set +a
# All today's snapshots Pre with the same seed updatedAt, no locks, no watcher-state
npx tsx bin/inspect-snapshot.ts
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/keys/nrxi:lock:*"
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/keys/nrxi:watcher-state:*"
```

If all three of (a) snapshots all Pre with the seed timestamp, (b) zero locks, (c) zero watcher-state keys, AND you pushed code earlier today, this is the deploy-during-cron pattern.

**Recovery (in order of effort):**

1. **Re-trigger the supervisor on Railway.** Dashboard → Deployments → ⋮ → Run Now. Runs the latest image immediately and is idempotent — `pruneStaleSnapshots` discriminates on each row's own `officialDate` so seeded "Pre" rows for today survive, and `acquireWatcherLock` ensures no double-watchers if anything is still racing.
2. **Or run locally.** `npx tsx bin/supervisor.ts` from your machine — picks up any games still pending and runs until you Ctrl-C or the natural 06:00 UTC cutoff.
3. **Or wait for the next 12:00 UTC cron firing.** Cheapest but loses the rest of today's games.

**Avoidance.** Batch your pushes — don't push between 12:00 UTC (supervisor wake) and the last game's natural exit (~05:00 UTC the next day). The MLB-quiet window is roughly **05:00 UTC – 12:00 UTC** (after the late West Coast game and before the next cron). Pushing inside that gap costs nothing because no supervisor is running. Outside it, every push kills the active supervisor and abandons watcher setTimeouts. A future fix is to persist the scheduled-game list to Redis on supervisor start and re-hydrate setTimeouts on the next cron firing if the previous run was interrupted — see `services/supervisor.ts` for the spawn loop.

---

## Recovering from a stuck-Live snapshot

If a game shows on the dashboard as "Live" with stale data (no recent `updatedAt`, frozen inning), the watcher exited without publishing Final. Three layers of recovery, in order of effort:

1. **Wait one supervisor idle pass (≤ 60s).** The supervisor calls `detectAndCleanStaleLive` every `IDLE_CHECK_INTERVAL_MS` while watchers are pending. Any snapshot with `status === "Live"` AND missing lock AND `updatedAt > 60s ago` gets a synthetic Final published automatically. Watch for `stale-live-detector:cleaning` log lines.

2. **Manual hdel** — only if the supervisor isn't running (off-season, container scaled to zero):

   ```bash
   set -a; source .env.local; set +a
   curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" \
     "$KV_REST_API_URL/hdel/nrxi:snapshot/<gamePk>"
   ```

3. **Wait for tomorrow's cron firing.** `pruneStaleSnapshots` deletes any row whose `officialDate < todayET`, so all of yesterday's stuck-Live entries get wiped at the next 12:00 UTC supervisor boot. Cheapest, slowest.

## Recovering from a stuck-Pre snapshot (live game still showing "Scheduled")

Inverse of the stuck-Live class: MLB has the game in progress but the dashboard's Upcoming card still shows `detailedState: "Scheduled"`. Cause: the watcher crashed somewhere before its first `publishUpdateStep` call (BUGS.md bug #13's class). With `lastPublishedState === null`, `performGracefulExit` skips the synthetic-Final publish and the 12:00 UTC seed stub (`status: "Pre"`) stays untouched in `nrxi:snapshot:{gamePk}`. **No supervisor detector covers this** — `stale-live-detector` only scans `status === "Live"`, and the supervisor never re-fetches the schedule mid-day. Manual recovery is required until a stuck-Pre detector lands.

1. **Confirm the diagnosis.**

   ```bash
   set -a; source .env.local; set +a
   GAMEPK=<pk>
   curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" \
     "$KV_REST_API_URL/hget/nrxi:snapshot/$GAMEPK" \
     | jq -r '.result' | jq '{status, detailedState, updatedAt, pitcher: .pitcher}'
   curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" \
     "$KV_REST_API_URL/get/nrxi:lock:$GAMEPK"
   ```

   If `status === "Pre"`, the lock is missing, and `updatedAt` is stale (older than ~30 min — pre-game ticks refresh it every 30 min), this is a stuck-Pre. Note: `pitcher === null` is NOT the diagnostic anymore — a healthy pre-game snapshot has `pitcher` and `pNoHitEvent` populated once lineups post (see "Expected pre-game state" above). Stale-`updatedAt`-with-missing-lock is the real signal: it means the watcher process is dead but the seed/preview row is still in `nrxi:snapshot`. Cross-check MLB's view: `curl -s "https://statsapi.mlb.com/api/v1/schedule?sportId=1&gamePk=$GAMEPK" | jq '.dates[].games[].status'`.

2. **Run a one-off watcher locally.** Hits prod Upstash + Supabase via `.env.local`:

   ```bash
   npx tsx bin/run-watcher-once.ts $GAMEPK
   ```

   The dashboard moves Upcoming → Active within ~5s of the first successful tick. Leave the process running until the game ends — it'll publish Final and exit cleanly. Closing the terminal early just leaves the snapshot Live; the supervisor's `stale-live-detector` will clean it up at the next idle pass.

3. **If `run-watcher-once` itself crashes,** the underlying bug class is back (deterministic Zod failure, MLB feed shape change, etc.). Read the log output for the schema path that failed (`["people", N, ...]` or similar), reproduce against the failing player id, and patch the schema. The Cortes/PitchHand fix in `lib/mlb/types.ts` is the model. Don't paper over by deleting the seed stub — that just hides the bug until tomorrow's cron rerun.

## Recovering from a missing /history entry

A finished game whose `games` row is missing or whose `actual_runs` are NULL on `/history`. Causes: the supervisor died between MLB-flip-to-Final and its next `sweepFinalize` iteration, OR Supabase was unreachable during the sweep, OR the watcher never fired any `upsertInningPrediction` (no captures stored, no stub games row).

1. **Wait one supervisor idle pass (≤ 60s).** Same cadence as the stale-Live detector. The sweep predicate matches today's games where `status != 'Final'` OR `linescore IS NULL` OR any `inning_predictions.actual_runs IS NULL`; for each, fetches a fresh feed and finalizes if MLB has flipped to Final. Watch for `sweep-finalize:pass {finalized: N}` and `finalizeGame:ok {plays, innings}` log lines.

2. **Re-trigger the supervisor.** From the Railway dashboard: Deployments → ⋮ → Run Now. The supervisor's idle loop will sweep pending finalizations on its first iteration (~immediately).

3. **Direct SQL audit:** verify what's actually persisted.

   ```sql
   -- games row state
   select game_pk, status, linescore is null as no_linescore, away_runs, home_runs
   from games where game_pk = <pk>;
   
   -- inning_predictions actual_runs coverage
   select inning, half, p_no_run, actual_runs
   from inning_predictions where game_pk = <pk>
   order by inning, half;
   
   -- plays count
   select count(*) from plays where game_pk = <pk>;
   ```

4. **If the watcher never wrote any predictions** (e.g., game finished before any half-boundary fired, or watcher died before its first publish), there's nothing to recover. The game won't appear on `/history`.

## Recovering from a stuck watcher

The lock TTL is **30 seconds**, so most "stuck" watchers self-heal — wait 30s and the next cycle's spawn will acquire the lock cleanly. If you need faster recovery:

```bash
# Clear the lock so a new watcher can immediately take over
set -a; source .env.local; set +a
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/del/nrxi:lock:<gamePk>"

# (optional) wipe the watcher's persisted hoisted state — forces a fresh
# Phase 1 reload on the next watcher start. Safe to do — capturedInnings
# is no longer in the saved bundle, and predictions are durable in
# Supabase from per-boundary writes. Only useful if the state itself is
# corrupt.
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/del/nrxi:watcher-state:<gamePk>"
```

Then trigger the supervisor manually from the Railway dashboard (Deployments → ⋮ → Run Now), OR run it locally for a single iteration:

```bash
npx tsx bin/supervisor.ts
```

---

## Running a single watcher locally for debugging

```bash
# Pick today's date if you don't pass --date
npx tsx bin/run-watcher-once.ts <gamePk>

# Or against a specific date's schedule (when ET has rolled past midnight)
npx tsx bin/run-watcher-once.ts <gamePk> --date 2026-05-01

# Or pass team names directly to skip the schedule lookup
npx tsx bin/run-watcher-once.ts <gamePk> --away "Cleveland Guardians" --home "Athletics"
```

Hits production Upstash + Supabase (the same data plane Railway uses). Loops until the game is Final, lock is held by Railway, or you Ctrl-C.

---

## Re-triggering the supervisor outside the natural cron window

From the Railway dashboard: Deployments → ⋮ → Run Now. Or run locally:

```bash
npx tsx bin/supervisor.ts
```

The supervisor will fetch today's schedule, seed snapshots, prune yesterday-or-older rows from the snapshot hash, and idle-loop until tomorrow 06:00 UTC (or until you Ctrl-C). On SIGTERM/SIGINT it drains active watchers up to 30s. A manual rerun on the same ET day is safe — prune discriminates by each row's own `officialDate`, not by the schedule fetch's pk list, so a partial/empty fetch on the rerun won't wipe still-scheduled rows (BUGS.md bug #10).

---

## Diagnosing snapshot zombies

The supervisor's `pruneStaleSnapshots` step deletes any row in the `nrxi:snapshot` hash whose own `officialDate` is older than today (ET) on every cron firing. If you see rows on the dashboard whose `officialDate` is yesterday or earlier, the prune step has been bypassed (or the row was written without `officialDate` and the parse-tolerance kept it).

```bash
# Read-only field-key dump — should only contain today's officialDate
npx tsx bin/inspect-snapshot.ts

# One-shot prune (emergency cleanup outside a cron firing)
npx tsx bin/prune-snapshots.ts                  # uses today (America/New_York) as the cutoff
npx tsx bin/prune-snapshots.ts --date 2026-05-02   # override the cutoff (no longer fetches the schedule)

# Nuclear option — wipe the entire hash (frontend goes blank until next seed)
npx tsx bin/prune-snapshots.ts --all

# Re-seed today's games as fresh "Pre" stubs (after --all, or when the seed
# never ran for some reason)
npx tsx bin/seed-once.ts
```

The `--date` flag now overrides the date used as the cutoff, NOT the schedule we fetch — there is no schedule fetch in this script any more. Pass tomorrow's date if you want to wipe today's rows too (rare; `--all` is faster).

If rows with stale `officialDate` keep appearing, something is writing to `nrxi:snapshot` outside the supervised path or with a missing/malformed `officialDate`. Search for `r.hset(k.snapshot()` in the codebase — currently the only writer is `lib/pubsub/publisher.ts:publishGameState`, which carries the seed step's `officialDate` through. See [BUGS.md](BUGS.md) bugs #9 and #10 for context.

---

## Env var checklist

**Required on Railway:**
- `KV_REST_API_URL` + `KV_REST_API_TOKEN` — Upstash Redis. **Use the read/write token, NOT `KV_REST_API_READ_ONLY_TOKEN`** — the watcher writes constantly (locks, snapshots, watcher-state, pubsub). `lib/cache/redis.ts:6-7` also accepts the `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` aliases.
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` — from the Supabase dashboard (Settings → API). Persistence silently no-ops when these are unset.
- `TZ=UTC` — keeps `todayInTz` and log timestamps unambiguous.

**Optional:**
- `MLB_USER_AGENT` — defaults to `nrxi-app/0.1`. Only set for MLB-side request attribution.
- `NRXI_DISABLE_FRAMING=1` — robo-ump kill switch (zeroes the framing factor).
- `NRXI_FRAMING_CLAMP=0.02` — override the framing-factor half-width (default `0.03`). Useful mid-season if ABS adoption keeps shrinking the human zone faster than the default clamp tightening anticipated. Range `[0, 0.2]`; out-of-range values fall back to the default.
- `NRXI_SWITCH_HITTER_RULE=max` — revives v1's `max(L, R)` switch-hitter rule (default is canonical platoon `actual`).

**Required on Vercel** (after unpause): same `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` + `KV_REST_API_*`. Both providers read from the same data plane.

---

## Supabase key rotation

The Supabase project lives on Supabase's infrastructure regardless of how it was provisioned (Vercel Marketplace install vs. direct Supabase signup). The Marketplace is a convenience layer for env-var injection on Vercel — it does NOT mediate the runtime connection.

**If you rotate the service-role key in the Supabase dashboard:** Vercel Marketplace's auto-injection does not propagate to Railway. Manually update `SUPABASE_SERVICE_ROLE_KEY` on Railway from the Supabase dashboard's new value.

**Don't click "Disconnect" in the Vercel Marketplace UI** without first transferring billing ownership to Supabase directly (Supabase dashboard → Settings → Billing → Transfer ownership). Marketplace disconnect can interpret as "tear down the resource" and delete the `games`, `inning_predictions`, and `plays` tables. For free-tier projects, leaving the Marketplace integration dormant is fine — no need to disconnect.

---

## Railway billing watch

Expected steady state: **$0** inside the $5 Hobby credit. Active CPU should sit near zero outside MLB hours and spike only during the supervisor cron + active watcher ticks (5–15s polls per live game).

Check usage in the Railway dashboard → service → Metrics. If you see:
- **CPU continuously elevated outside MLB hours** — the idle-exit predicate isn't firing. Check supervisor logs for `idle-deadline` and `idle-exit` events; verify `pending` set is draining.
- **Memory above ~512 MB** — a watcher leak. Profile per-tick allocations in `services/run-watcher.ts`.
- **Bandwidth charges** — Upstash REST traffic + MLB live-feed fetches should be small (<1 GB/month). Anomalies usually mean a polling-rate regression.

If costs creep above ~$15/mo for three consecutive months, the migration plan calls for a Fly.io move (Phase A–B code is portable; only the deploy config differs).

---

## Vercel function memory

Fluid Compute bills `provisioned_memory × instance_lifetime`. Defaults are wildly oversized for nrXi's thin RSC + Redis/Supabase workload, so `vercel.ts` declares explicit ceilings:

```ts
functions: {
  "app/**/*": { memory: 512 },
  "app/api/stream/route.ts": { memory: 256, maxDuration: 300 },
}
```

- **512 MB default** for all RSC pages and route handlers (down from 2048 MB). Page routes do thin Redis/Supabase reads + RSC render; 512 leaves cold-start headroom on React 19 + motion + tailwind.
- **256 MB on `/api/stream`** because the SSE route is held open ~290s per connection and the memory × wall-time product dominates its bill. The route does almost no allocation per connection — one Upstash subscription + a `TextEncoder`.

**Check in Vercel dashboard:** Project → Functions tab shows each route's memory tier on the latest deployment. Compare provisioned-memory line in Usage → Invocations week-over-week after a config change.

**If you add new routes / fire-and-forget work:**
- New `app/**` routes inherit the 512 MB default automatically (glob match).
- Adding `waitUntil(...)` or `after(...)` extends instance lifetime past the response — re-size the affected route in `vercel.ts` at the same time. There's currently **zero `waitUntil` / `after()` on the Vercel side**; it's audited and recorded in CLAUDE.md.
- If a page route OOMs (visible in function logs as `Process exited`), bump that specific glob to 1024 MB rather than the whole project.

---

## One-time cache flush after scraper deploys

When fixing a park or weather scraper bug ([BUGS.md](BUGS.md) bug #6), the bad `[]` / `DEFAULT` value is cached under the working keys. Flush so the next watcher tick re-fetches fresh data:

```bash
set -a; source .env.local; set +a

# Park factors (24h TTL) — combined + per-handedness (v2.2)
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/del/park:factors:2026"
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/del/park:factors:2026:L"
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/del/park:factors:2026:R"

# v2.2 scrapes — Savant xstats and FanGraphs Stuff+ (24h TTL each)
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/del/xstats:2026"
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/del/stuff:2026"

# Reliever 7-day pitch counts (6h TTL, per-player — usually faster to wait)
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/keys/workload:*" \
  | python3 -c 'import sys,json; [print(k) for k in json.load(sys.stdin).get("result",[])]' \
  | xargs -I{} curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/del/{}"

# All weather keys (30 min TTL — could also just wait it out)
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/keys/weather:*" \
  | python3 -c 'import sys,json; [print(k) for k in json.load(sys.stdin).get("result",[])]' \
  | xargs -I{} curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/del/{}"
```

Most other caches (`hand:*`, `bat:splitsraw:*`, `pit:splitsraw:*`, `oaa:*`, `framing:*`, `venue:*`) are safe to leave — their data shape didn't change in the bug fix. See [ARCHITECTURE.md → caching layout](ARCHITECTURE.md#caching-layout) for the full key inventory.

**Note on v2.2 scrape failures.** `xstats:*` and `stuff:*` both degrade to identity on failure — so a sustained `xstats:scrape:failed` / `stuff:scrape:failed` log signature means the model is running without those denoisers but is otherwise correct. The watcher will not crash. Re-running the scrape via cache flush is the right recovery once upstream is healthy.

---

## Refreshing scraper fixtures

When upstream Savant or covers.com changes structure, update the fixtures so the parse tests catch the regression (rather than the production scrape silently going neutral):

```bash
# Savant park factors live JSON (filename varies — check the test for the exact path)
curl -s 'https://baseballsavant.mlb.com/leaderboard/statcast-park-factors?type=year&year=2026&batSide=&stat=index_runs&condition=All' \
  > lib/env/__fixtures__/savant-park-factors.html

# covers.com weather page
curl -s 'https://www.covers.com/sport/mlb/weather' > lib/env/__fixtures__/covers-weather.html
```

Then re-run `npm test -- park weather` and update the assertions to match the new structure.
