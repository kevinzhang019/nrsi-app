# Operational runbook

Everyday inspection, recovery, and cache-management commands. Most assume `.env.local` is loaded for the Redis token (`set -a; source .env.local; set +a`).

---

## Inspecting workflow runs

```bash
# List recent runs
npx workflow inspect runs --backend vercel --project nrxi-app --team kevinzhang019s-projects | head

# Drill into a specific run
npx workflow inspect run <runId> --backend vercel --project nrxi-app --team kevinzhang019s-projects --json
```

Open the runs UI in a browser:

```bash
npx workflow web --backend vercel --project nrxi-app --team kevinzhang019s-projects
```

---

## Reading current state

```bash
# Snapshot via the API (requires Vercel SSO)
vercel curl /api/snapshot | python3 -m json.tool

# Raw Redis (load env first)
set -a; source .env.local; set +a
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/keys/*"
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/hgetall/nrxi:snapshot"
```

---

## Tailing logs

```bash
vercel logs <deployment-url>
```

Common log signatures to watch for:
- `park:scrape:failed` / `weather:scrape:failed` — fixture-driven tests should also be failing in CI; see BUGS.md bug #6.
- `lock-held` — a second watcher tried to spawn for a `gamePk` that already had one. Expected during deploys.

---

## Recovering from stuck workflows

```bash
# Cancel a stuck run
npx workflow cancel <runId> --backend vercel --project nrxi-app --team kevinzhang019s-projects

# Clear the watcher lock so a new run can take over
set -a; source .env.local; set +a
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/del/nrxi:lock:<gamePk>"
```

The lock has a 90s TTL, so doing nothing also works — but clearing it speeds recovery if a new watcher needs to spawn immediately.

---

## Restarting a watcher manually

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"gamePk":NNNN,"awayTeamName":"...","homeTeamName":"..."}' \
  https://nrsi-app.vercel.app/api/workflows/game-watcher
```

---

## Re-triggering the daily scheduler

The Vercel Cron in `vercel.ts` fires this at 13:00 UTC. To force a run outside the cron window:

```bash
vercel curl /api/cron/start-day
```

---

## One-time cache flush after scraper deploys

When fixing a park or weather scraper bug (BUGS.md bug #6), the bad `[]` / `DEFAULT` value is cached under the working keys. Flush so the next watcher tick re-fetches fresh data:

```bash
set -a; source .env.local; set +a

# Park factors (24h TTL)
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/del/park:factors:2026"

# All weather keys (30 min TTL — could also just wait it out)
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/keys/weather:*" \
  | python3 -c 'import sys,json; [print(k) for k in json.load(sys.stdin).get("result",[])]' \
  | xargs -I{} curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/del/{}"
```

Most other caches (`hand:*`, `bat:splitsraw:*`, `pit:splitsraw:*`, `oaa:*`, `framing:*`, `venue:*`) are safe to leave — their data shape didn't change in the bug fix. See `docs/ARCHITECTURE.md#caching-layout` for the full key inventory.

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
