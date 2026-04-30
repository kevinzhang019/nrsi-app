# CLAUDE.md — NRSI app implementation notes

> Read this **before** modifying any code in this repo. It documents the non-obvious bugs we already hit, framework-specific patterns we landed on, and decisions that look weird until you know the reason.

## At a glance

- **What:** live MLB no-run-scoring-inning probability dashboard
- **Stack:** Next.js 16 App Router (Cache Components on) + Vercel Workflow DevKit + Upstash Redis (Vercel Marketplace) + Tailwind v4 + Vitest
- **Status:** deployed to https://nrsi-app.vercel.app, scheduler workflow runs daily at 13:00 UTC, 24/24 unit tests passing, build green

## Bugs we already hit — do NOT re-introduce

### 1. Missing `withWorkflow()` in `next.config.ts`

**Symptom:** `start(workflow)` calls return successfully but workflows never appear in the runs list, and `/.well-known/workflow/v1/*` routes 404.

**Root cause:** Workflow DevKit needs the framework adapter to register its runtime endpoints. Without it, `start()` is a no-op in production.

**Fix:** wrap the config:
```ts
// next.config.ts
import { withWorkflow } from "workflow/next";
import type { NextConfig } from "next";
const nextConfig: NextConfig = { cacheComponents: true, serverExternalPackages: ["cheerio"] };
export default withWorkflow(nextConfig);
```

**Verify after build:** the route table should include `ƒ /.well-known/workflow/v1/flow`, `step`, `webhook/[token]`.

### 2. Vercel Marketplace Upstash provisions `KV_REST_API_*`, not `UPSTASH_REDIS_REST_*`

**Symptom:** `vercel env ls` shows `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `KV_URL`, `REDIS_URL` — but the app throws `Missing UPSTASH_REDIS_REST_URL / TOKEN`.

**Root cause:** the Marketplace integration uses Vercel KV's legacy naming for backwards compat, even though the underlying provider is Upstash.

**Fix:** `lib/cache/redis.ts` reads `KV_REST_API_URL || UPSTASH_REDIS_REST_URL` (and same for token). Both work.

### 3. Cache Components requires `connection()` + `<Suspense>` for dynamic data

**Symptom:** `npm run build` fails with: `Route "/...": Uncached data was accessed outside of <Suspense>.` Or: `Route segment config "runtime" is not compatible with nextConfig.cacheComponents. Please remove it.`

**Root cause:** With `cacheComponents: true`, Next.js 16 prerenders pages at build time by default. Anything that reads runtime data (cookies, headers, dynamic route params, Redis, network) must be:
1. Inside an async server component
2. Wrapped in `<Suspense>`
3. Have `await connection()` called inside it (from `next/server`)

You **cannot** use `export const runtime = "nodejs"` or `export const dynamic = "force-dynamic"` in route handlers when Cache Components is on.

**Pattern we use:**
```tsx
import { Suspense } from "react";
import { connection } from "next/server";

async function DataLoader() {
  await connection();
  const data = await fetchSomething();
  return <Component data={data} />;
}

export default function Page() {
  return (
    <Suspense fallback={<Skeleton />}>
      <DataLoader />
    </Suspense>
  );
}
```

For API routes, `await connection()` at the top of the handler is enough — no Suspense needed.

### 4. `@upstash/redis` auto-parses JSON on read

**Symptom:** `r.hgetall(...)` returns objects in production but tests/local pass when stored values are JSON strings. Code doing `JSON.parse(value)` silently throws and gets filtered out, leaving callers with empty arrays.

**Root cause:** the Upstash REST SDK detects values that look like JSON and parses them automatically. If you stored `JSON.stringify(state)`, you read back an object — not a string.

**Fix in this repo:** `lib/pubsub/publisher.ts:getSnapshot`, `lib/pubsub/subscriber.ts:iterateSnapshotChanges`, and `app/games/[pk]/page.tsx:getGame` all tolerate both shapes:
```ts
if (raw && typeof raw === "object") return raw as T;
if (typeof raw === "string") return JSON.parse(raw) as T;
return null;
```

### 5. Loop-scoped `nrsi`/`env`/`pitcher` vars overwrite Redis with nulls

**Symptom:** the watcher first publishes a state with valid probabilities, then on the next tick (no inning change) overwrites it with `pHitEvent: null, upcomingBatters: [], pitcher: null`. Frontend shows "—" everywhere despite watchers being healthy.

**Root cause:** in `workflows/game-watcher.ts`, the watcher loop only runs the compute path when `shouldRecompute` is true (inning changed OR lineup changed). The result was assigned to a local `let nrsi` declared INSIDE the loop body, which reset to `null` on every iteration. Every steady-state tick then constructed a `state` with null fields and `publishUpdateStep(state)` happily wrote it.

**Fix:** hoist the cached values to the workflow scope so they persist across ticks. Currently at `workflows/game-watcher.ts:42-46`:
```ts
let lastNrsi: Awaited<ReturnType<typeof computeNrsiStep>> | null = null;
let lastEnv: { parkRunFactor: number; weatherRunFactor: number; weather?: ... } | null = null;
let lastPitcherId: number | null = null;
let lastPitcherName = "";
let lastPitcherThrows: "L" | "R" = "R";
```

These get **updated only when** `shouldRecompute && upcoming` (line 94) and read every tick (line 131). Don't move these back into the loop body.

## MLB Stats API gotchas

- **Live feed lives at `/api/v1.1/...`**, not `/api/v1/...`. v1 returns 404 for the same path.
- **Split sitCodes are `vl,vr`**, NOT `vsl,vsr`. The wrong codes return an empty `splits[]` array — silent failure, hardest kind of bug.
- **Splits don't exist for players with no PAs in that split this season.** Code falls back to prior season (`SEASON - 1`) if `stats[0].splits` is empty. See `lib/mlb/splits.ts:loadBatterProfile`/`loadPitcherProfile`.
- **Switch hitters use the MAX of both splits.** This is a user-specified rule, not standard MLB convention. See `lib/prob/reach-prob.ts:21-28` and the rationale in CLAUDE.md.
- **`boxscore.teams.*.battingOrder` is empty until lineups post** (~30 min before first pitch). `getUpcomingForCurrentInning` returns `null` if the array is < 9 long.
- **`outs === 3` flickers at half-inning transitions.** Don't use raw `outs` as the recompute trigger; use a composite `inningKey = "${inning}-${half}-${outs >= 3 ? 'end' : inningState || 'live'}"`.
- **Respect `metaData.wait`.** The live feed includes a server-side hint (typically 10s). Polling faster wastes calls and risks rate limits.
- **`User-Agent` matters.** Set `MLB_USER_AGENT` env var to identify yourself; the default is `nrsi-app/0.1`.

## Workflow DevKit conventions in this repo

- `"use workflow"` directive marks an orchestrator. Variables in workflow scope persist across `sleep()` boundaries.
- `"use step"` directive marks a function with full Node.js access, automatic retry, and durable result caching.
- **`start()` cannot be called from inside a workflow.** Wrap it in a step. See `workflows/scheduler.ts:startWatcherStep`.
- **Single-instance lock pattern:** every watcher acquires `nrsi:lock:{gamePk}` with a 90s TTL via `acquireWatcherLockStep`. The watcher refreshes it every loop iteration via `refreshWatcherLockStep` (line 181-185). If a second watcher spawns for the same game, it sees the lock and exits with `{ reason: "lock-held" }` — no double-polling.
- **No `console.log` from inside workflow function.** It works in steps, but the workflow function itself can't access Node APIs (sandbox). Most logging happens in steps via `lib/log.ts`.
- **Adaptive sleep:** Live games sleep `metaData.wait` (~7-10s); Pre/Final sleep 30s; Delayed/Suspended sleep 5min.

## Caching layout (Redis keys)

All keys come from `lib/cache/keys.ts`. Source of truth — don't hardcode key strings elsewhere.

| Key shape | Owner | Value | TTL |
|---|---|---|---|
| `bat:splitsraw:{playerId}:{season}` | `lib/mlb/splits.ts` | raw `SplitsResponse` JSON | 12h |
| `pit:splitsraw:{playerId}:{season}` | `lib/mlb/splits.ts` | raw `SplitsResponse` JSON | 12h |
| `hand:{playerId}` | `lib/mlb/splits.ts:loadHand` | `{ id, fullName, bats, throws }` | 30d |
| `park:factors:{season}` | `lib/env/park.ts` | `ParkRow[]` from Baseball Savant | 24h |
| `venue:{venueId}` | `lib/env/venues.ts` | `VenueInfo` | 30d |
| `weather:{gamePk}` | `lib/env/weather.ts` | `WeatherInfo` from covers.com | 30 min |
| `nrsi:lock:{gamePk}` | `workflows/steps/lock.ts` | watcher `ownerId` | 90s |
| `nrsi:runs:{YYYY-MM-DD}` | `workflows/scheduler.ts` | hash `{gamePk: runId}` | 36h |
| `nrsi:snapshot` | `lib/pubsub/publisher.ts` | hash `{gamePk: GameState JSON}` | 24h |
| `nrsi:games` (channel) | `lib/pubsub/publisher.ts` | published `GameState` JSON | n/a |

## Default decisions worth preserving

- **Switch-hitter rule:** `Math.max(L, R)` for both pitcher WHIPs and batter OBPs. Generous toward "batter reaches." Per user spec, NOT standard convention.
- **Pitcher pseudo-OBP:** `clamp(WHIP / 3.5, 0.18, 0.55)`. Rough overestimate of pitcher's allowed-OBP based on WHIP. Don't change the divisor without explicit user OK.
- **"Hit event" definition:** 2 batters reach base in the inning. Per user spec.
- **Decision moment:** `outs === 3` (end of half-inning) OR `(half === "Top" && outs === 0)` (top of inning, no outs yet). These are the betting decision points the user cares about.
- **Break-even rounding:** American odds rounded to nearest 5 in display; raw value used for EV calc.
- **Probability bounds:** `pReach` clamped to `[0.05, 0.85]` to avoid degenerate edges from bad split data.

## Validator hook quirks (advisory only)

The session has a `posttooluse-validate` hook that flags things like "Workflow files should import and use logging." It runs a regex against specific lines and frequently misses logging that's actually present (e.g. `log.info(...)` calls or `console.log` on non-flagged lines). **Treat its suggestions as advisory.** Don't add redundant `console.log` just to silence it. The real signals are: TypeScript errors, build errors, and test failures.

## Debugging runbook

```bash
# 1. Are workflows running?
npx workflow inspect runs --backend vercel --project nrsi-app --team kevinzhang019s-projects | head

# 2. Inspect a specific run
npx workflow inspect run <runId> --backend vercel --project nrsi-app --team kevinzhang019s-projects --json

# 3. What's in the snapshot right now?
vercel curl /api/snapshot | python3 -m json.tool

# 4. Raw Redis state (env loaded from .env.local)
set -a; source .env.local; set +a
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/keys/*"
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/hgetall/nrsi:snapshot"

# 5. Tail runtime logs
vercel logs <deployment-url>

# 6. Cancel a stuck run + clear its lock
npx workflow cancel <runId> --backend vercel --project nrsi-app --team kevinzhang019s-projects
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/del/nrsi:lock:<gamePk>"

# 7. Restart watcher manually
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"gamePk":NNNN,"awayTeamName":"...","homeTeamName":"..."}' \
  https://nrsi-app.vercel.app/api/workflows/game-watcher
```

## Don't change without thinking

- The hoisted `lastNrsi`/`lastEnv`/`lastPitcher*` vars in `workflows/game-watcher.ts:42-46` (bug #5)
- The `JSON.parse`-tolerance in `getSnapshot`/`iterateSnapshotChanges`/`getGame` (bug #4)
- The `vl,vr` sitCodes in `lib/mlb/client.ts:fetchSplits` and `lib/mlb/splits.ts`
- The `await connection()` calls at the top of every dynamic route handler and dynamic page (bug #3)
- The `withWorkflow(nextConfig)` wrapper in `next.config.ts` (bug #1)
- The `KV_REST_API_*` fallback in `lib/cache/redis.ts` (bug #2)
- The single-poller lock semantics — refresh TTL every tick, never do `await sleep(...)` longer than the lock TTL minus a margin
- The `season || season-1` fallback in `loadBatterProfile` / `loadPitcherProfile` — early-season splits are empty and prior-season is the only useful proxy
- The `hsetnx` (NOT `hset`) call in `workflows/steps/seed-snapshot.ts` — `hset` would clobber any watcher that already published a real state, replacing live data with a `Pre` stub
- The `layoutId={`card-${gamePk}`}` on the `motion.div` wrapper in `components/game-board.tsx` — without a stable `layoutId`, cards moving between the four section `<AnimatePresence>` parents would unmount/remount and lose their cross-section fade

## Dashboard sectioning + motion (added in this PR)

The dashboard groups today's games into four sections in fixed order: **Highlighted → Active → Upcoming → Finished**. Each is a separate `<AnimatePresence mode="popLayout">` parent, and each card is a `<motion.div layout layoutId={`card-${gamePk}`}>` so a card animates smoothly when `isDecisionMoment` flips (Active ↔ Highlighted) or when status changes (Pre → Live → Final).

Two things make this work end-to-end:

1. **`workflows/steps/seed-snapshot.ts`** runs at the top of the daily scheduler and writes a `Pre` stub `GameState` into `nrsi:snapshot` for every scheduled game via `hsetnx`. This is what populates the Upcoming section before any per-game watcher starts (~5 min pre-game). When a watcher's first `publishGameState` lands, the `hset` overwrites the stub atomically — same `gamePk` → same `layoutId` → card stays mounted, fields fill in.
2. **`useGameStream` keeps a stable `Map<gamePk, GameState>`.** SSE updates merge into the map; `<GameBoard>` re-derives sections via `useMemo`; cards already in flight finish their layout animation while still receiving fresh props. Don't add a section-name suffix to the `key` or `layoutId` — that would force remounts on section changes.

If you ever need to suppress the fade for a specific case (e.g. initial paint), use `<AnimatePresence initial={false}>` (already set in `game-board.tsx`).
