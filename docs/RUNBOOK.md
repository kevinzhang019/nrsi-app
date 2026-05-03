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
- `scope:watcher` — per-game watcher events (`start`, `tick`, `final`, `lock-held-by-other`, `max-loops`, `max-runtime`).
- `scope:step` — individual step calls (`fetchSchedule:ok`, `seedSnapshot:ok`, `publishUpdate:ok`, `persistFinishedGame:ok`, etc.).
- `scope:retry` — `withRetry` exponential-backoff events.
- `scope:lock` — acquire / refresh / failure events.
- `scope:prune` — snapshot prune step output.

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
- `watcher:final {plays: N}` and `step persistFinishedGame:start {plays: N}` — emitted on a game's Final exit. `N` is the count of completed plate appearances captured from `liveData.plays.allPlays`. Healthy range: ~70–90 for a 9-inning game, more for extras. `plays: 0` on a real Final game means either the live feed dropped `allPlays` (rare; refetch + replay via the backfill path) or the migration `0003_plays.sql` hasn't been applied yet.

---

## Recovering from a stuck watcher

The lock TTL is **30 seconds**, so most "stuck" watchers self-heal — wait 30s and the next cycle's spawn will acquire the lock cleanly. If you need faster recovery:

```bash
# Clear the lock so a new watcher can immediately take over
set -a; source .env.local; set +a
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/del/nrxi:lock:<gamePk>"

# (optional) wipe the watcher's persisted hoisted state — forces a fresh
# Phase 1 reload on the next watcher start. Loses captured-innings progress
# for the half-innings already captured this game; only do this if the
# state itself is corrupt.
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

## One-time cache flush after scraper deploys

When fixing a park or weather scraper bug ([BUGS.md](BUGS.md) bug #6), the bad `[]` / `DEFAULT` value is cached under the working keys. Flush so the next watcher tick re-fetches fresh data:

```bash
set -a; source .env.local; set +a

# Park factors (24h TTL)
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/del/park:factors:2026"

# All weather keys (30 min TTL — could also just wait it out)
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/keys/weather:*" \
  | python3 -c 'import sys,json; [print(k) for k in json.load(sys.stdin).get("result",[])]' \
  | xargs -I{} curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/del/{}"
```

Most other caches (`hand:*`, `bat:splitsraw:*`, `pit:splitsraw:*`, `oaa:*`, `framing:*`, `venue:*`) are safe to leave — their data shape didn't change in the bug fix. See [ARCHITECTURE.md → caching layout](ARCHITECTURE.md#caching-layout) for the full key inventory.

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
