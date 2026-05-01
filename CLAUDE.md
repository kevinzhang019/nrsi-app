# CLAUDE.md — nrXi implementation notes

> Read this **before** modifying any code in this repo. It documents the non-obvious bugs we already hit, framework-specific patterns we landed on, and decisions that look weird until you know the reason.

## At a glance

- **What:** live MLB no-run-scoring-inning probability dashboard
- **Stack:** Next.js 16 App Router (Cache Components on) + Vercel Workflow DevKit + Upstash Redis (Vercel Marketplace) + Tailwind v4 + Vitest
- **Status:** deployed to https://nrsi-app.vercel.app, scheduler workflow runs daily at 13:00 UTC, 72/72 unit tests passing, build green

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

### 5. Loop-scoped `nrXi`/`env`/`pitcher` vars overwrite Redis with nulls

**Symptom:** the watcher first publishes a state with valid probabilities, then on the next tick (no inning change) overwrites it with `pHitEvent: null, upcomingBatters: [], pitcher: null`. Frontend shows "—" everywhere despite watchers being healthy.

**Root cause:** in `workflows/game-watcher.ts`, the watcher loop only runs the compute path when `shouldRecompute` is true (inning changed OR lineup changed). The result was assigned to a local `let nrXi` declared INSIDE the loop body, which reset to `null` on every iteration. Every steady-state tick then constructed a `state` with null fields and `publishUpdateStep(state)` happily wrote it.

**Fix:** hoist the cached values to the workflow scope so they persist across ticks. Currently at `workflows/game-watcher.ts:42-46`:
```ts
let lastNrXi: Awaited<ReturnType<typeof computeNrXiStep>> | null = null;
let lastEnv: { parkRunFactor: number; weatherRunFactor: number; weather?: ... } | null = null;
let lastPitcherId: number | null = null;
let lastPitcherName = "";
let lastPitcherThrows: "L" | "R" = "R";
```

These get **updated only when** `shouldRecompute && upcoming` (line 94) and read every tick (line 131). Don't move these back into the loop body.

### 6. Park / weather scrapers silently fall back to neutral 1.0

**Symptom:** every game shows `parkRunFactor: 1.0` and `weather.source: "fallback"`. nrXi math runs as if every park is neutral and every game is calm 70°F. No errors logged at error level — only `log.warn("park", "scrape:failed", …)` and `log.warn("weather", "scrape:failed", …)` which are easy to miss in noisy logs.

**Root causes:**
1. **Savant park factors:** the live JSON's team key is `name_display_club` (short forms like `"Red Sox"`, `"D-backs"`). The old parser only checked `team_name` / `name` / `team`, so every row got filtered out and `loadParkFactors` returned `[]`. Fixed in `lib/env/park.ts:parseSavantData` — the team-field fallback chain now starts with `name_display_club`. Also added `D-backs` → `Diamondbacks` and `A's` → `Athletics` aliases via `canonicalizeSavantTeam` so `findRow`'s substring matcher resolves them.
2. **covers.com weather:** the URL `https://contests.covers.com/weather/MLB` is a hard 404. Real URL is `https://www.covers.com/sport/mlb/weather`. Selectors changed too — the cheerio walk now iterates `.covers-CoversWeather-brick`, matches by city-form label OR MLB abbr (`COVERS_TEAM` map), and pulls wind direction from the `.covers-coversweather-windDirectionIcon`'s `src` (e.g. `wind_icons/nw.png`). Wind compass codes are translated to "out/in/cross" via `lib/env/park-orientation.ts` — a new module with home-plate→CF bearings for all 30 parks.

**Why the fallback hides the failure:** `cacheJson` in `lib/cache/redis.ts` caches whatever the inner function returns, including `[]` for park (24 h TTL) and `DEFAULT` for weather (30 min TTL). Both `getParkRunFactor` and `weatherRunFactor` interpret those as "no signal" and return `1.0`. Net effect: the model thinks Coors Field and Oracle Park play identically.

**Don't change without thinking:**
- `parseSavantData` team-field order (`name_display_club` first; live JSON's actual key)
- `SAVANT_NAME_ALIAS` (`d-backs` → `Diamondbacks`, `a's` → `Athletics`)
- `COVERS_URL` — the contests subdomain is gone; only `www.covers.com/sport/mlb/weather` works
- `COVERS_TEAM` labels — covers.com disambiguates shared cities as `NY Yankees`, `Chi. Cubs`, `LA Dodgers`, etc. Don't simplify to nicknames-only
- Wind direction is **FROM** convention (meteorological). `classifyWind` flips that to outfield-relative via park orientation

**How to detect regression:** the fixture-driven tests in `lib/env/park.test.ts` and `lib/env/weather.test.ts` parse captured HTML from `lib/env/__fixtures__/`. If covers.com or Savant change their structure, those tests fail loud in CI instead of the production scrape silently going neutral. To refresh fixtures after an upstream change: re-run the curl commands in the runbook section, paste into the fixture files, and update the test assertions.

**One-time cache flush after deploy** (the bad `[]` / `DEFAULT` is cached under the working keys):
```bash
set -a; source .env.local; set +a
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/del/park:factors:2026"
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/keys/weather:*" \
  | python3 -c 'import sys,json; [print(k) for k in json.load(sys.stdin).get("result",[])]' \
  | xargs -I{} curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/del/{}"
```

### 7. Boxscore omits `batSide` — every batter renders as a righty

**Symptom:** the lineup column on every game card shows `R` next to all 9 batters (and any subs). The actively-on-deck `upcomingBatters` array — populated through a different path — has correct handedness, but the full lineup rendered by `<LineupColumn>` is uniformly right-handed.

**Root cause:** `lib/mlb/extract.ts:entryFrom` previously did `bats: (p.batSide?.code as HandCode | undefined) ?? "R"`. The MLB live feed boxscore (`liveData.boxscore.teams.*.players[ID*]`) populates positions, batting-order codes, and per-game stats reliably — but **routinely omits `batSide`** for most or all players. The default-to-R then silently lied for 18 batters per game. The canonical source for handedness is `/api/v1/people/{id}` (already cached 30d in `hand:{playerId}` via `loadHand` in `lib/mlb/splits.ts`), but that lookup was only being made for the ~3 upcoming batters going through `loadBatterPaProfile`, never for the full lineup roster.

**Fix:**
1. `LineupEntry.bats` is now `HandCode | null` and `entryFrom` returns `null` when `batSide` is absent — no more silent lie.
2. New step `workflows/steps/enrich-lineup-hands.ts` fans out `loadHand()` over every starter+sub id (deduped via `Set`) and overwrites `bats` with the canonical code. Per-id failures degrade to whatever extract produced rather than killing the whole tick.
3. `workflows/game-watcher.ts` hoists `lastLineups` + `lastEnrichedHash` into workflow scope (same pattern as bug #5) and runs enrichment only when the boxscore battingOrder hash (`lh`) changes. Crucially this is **independent of `shouldRecompute`** — Pre-game lineups (status !== "Live") still get hydrated as soon as they post. Steady-state ticks reuse the cached enriched lineups.
4. UI fallback: `slot.starter.bats ?? "—"` keeps column width stable on the rare case enrichment misses.

**Why pitcher `throws` doesn't have this bug:** `pitcher.throws` flows through `loadHand(pitcherId)` → `splits.pitcher.throws` → `lastPitcherThrows` → published `GameState.pitcher.throws`. `loadHand` itself defaults to `"R"` (`lib/mlb/splits.ts:192-193`) but `/people/{id}` reliably returns `pitchHand.code` for every MLB pitcher, so the fallback never fires.

**Don't change without thinking:**
- `bats: HandCode | null` typing in `LineupEntry` (`lib/mlb/extract.ts:6`) — narrowing it back to non-null reintroduces the silent lie via the type system
- The `lh !== lastEnrichedHash` independent-of-`shouldRecompute` check in `workflows/game-watcher.ts` — gating it on `shouldRecompute` would skip Pre-game enrichment because that block requires `status === "Live"`
- Hoisting `lastLineups` to workflow scope (same reason as bug #5) — keeping it loop-local would cause wasteful re-fetches every tick
- `loadHand` exported from `lib/mlb/splits.ts` — the watcher's enrichment step depends on it

**No cache flush required.** The bad data lived in `nrxi:snapshot` (24h TTL); the next watcher tick after deploy overwrites it. The `hand:{playerId}` keys were always correct — we just weren't reading them for the lineup. Finished games will be replaced by tomorrow's scheduler at 13:00 UTC, or expire naturally within 24h.

## MLB Stats API gotchas

- **Live feed lives at `/api/v1.1/...`**, not `/api/v1/...`. v1 returns 404 for the same path.
- **Split sitCodes are `vl,vr`**, NOT `vsl,vsr`. The wrong codes return an empty `splits[]` array — silent failure, hardest kind of bug.
- **Splits don't exist for players with no PAs in that split this season.** Code falls back to prior season (`SEASON - 1`) if `stats[0].splits` is empty. See `lib/mlb/splits.ts:loadBatterProfile`/`loadPitcherProfile` (legacy) and `loadBatterPaProfile`/`loadPitcherPaProfile` (v2 — also blends in last-30-day with graceful fallback).
- **Switch-hitter platoon resolution defaults to canonical** (`actual` rule — bat opposite of pitcher hand). Legacy `max(L, R)` reachable via `NRXI_SWITCH_HITTER_RULE=max`. Implementation in `lib/prob/log5.ts:effectiveBatterStance` and `batterSideVs`.
- **`boxscore.teams.*.battingOrder` is empty until lineups post** (~30 min before first pitch). `getUpcomingForCurrentInning` returns `null` if the array is < 9 long.
- **`outs === 3` flickers at half-inning transitions.** Don't use raw `outs` as the recompute trigger; use a composite `inningKey = "${inning}-${half}-${outs >= 3 ? 'end' : inningState || 'live'}"`.
- **Respect `metaData.wait`.** The live feed includes a server-side hint (typically 10s). Polling faster wastes calls and risks rate limits.
- **`User-Agent` matters.** Set `MLB_USER_AGENT` env var to identify yourself; the default is `nrxi-app/0.1`.

## Workflow DevKit conventions in this repo

- `"use workflow"` directive marks an orchestrator. Variables in workflow scope persist across `sleep()` boundaries.
- `"use step"` directive marks a function with full Node.js access, automatic retry, and durable result caching.
- **`start()` cannot be called from inside a workflow.** Wrap it in a step. See `workflows/scheduler.ts:startWatcherStep`.
- **Single-instance lock pattern:** every watcher acquires `nrxi:lock:{gamePk}` with a 90s TTL via `acquireWatcherLockStep`. The watcher refreshes it every loop iteration via `refreshWatcherLockStep` (line 181-185). If a second watcher spawns for the same game, it sees the lock and exits with `{ reason: "lock-held" }` — no double-polling.
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
| `oaa:{season}` | `lib/env/defense.ts` | `OaaTable` (per-fielder Outs Above Average) | 24h |
| `framing:{season}` | `lib/env/framing.ts` | `FramingTable` (per-catcher framing runs) | 24h |
| `venue:{venueId}` | `lib/env/venues.ts` | `VenueInfo` | 30d |
| `weather:{gamePk}` | `lib/env/weather.ts` | `WeatherInfo` from covers.com | 30 min |
| `nrxi:lock:{gamePk}` | `workflows/steps/lock.ts` | watcher `ownerId` | 90s |
| `nrxi:runs:{YYYY-MM-DD}` | `workflows/scheduler.ts` | hash `{gamePk: runId}` | 36h |
| `nrxi:snapshot` | `lib/pubsub/publisher.ts` | hash `{gamePk: GameState JSON}` | 24h |
| `nrxi:games` (channel) | `lib/pubsub/publisher.ts` | published `GameState` JSON | n/a |

## Default decisions worth preserving

- **v2 model is the default.** Probability pipeline is `Log5 → applyEnv → applyTtop → 24-state Markov → calibrate`. The legacy `pReach` + 2-state DP path is retained in `lib/prob/{reach-prob,inning-dp}.ts` and `loadBatterProfile` / `loadPitcherProfile` for back-compat but is **not invoked by the watcher**. See `docs/PROBABILITY_MODEL.md` for the full math.
- **Switch-hitter rule:** `actual` (canonical platoon advantage) by default — switch hitters bat from the side opposite the pitcher's throwing hand. Legacy v1 `max(L, R)` rule is reachable via env `NRXI_SWITCH_HITTER_RULE=max`. Implemented in `lib/prob/log5.ts:effectiveBatterStance` and `batterSideVs`.
- **nrXi definition:** v2 computes `P(nrXi) = 1 − P(≥1 run scores)` directly via the Markov chain — no proxy. The legacy `pHitEvent` field name on `NrXiResult` is preserved for UI back-compat but its semantics are now exact.
- **Decision moment:** `outs === 3` (end of half-inning) OR `(half === "Top" && outs === 0)` (top of inning, no outs yet).
- **Break-even rounding:** American odds rounded to nearest 5 in display; raw value used for EV calc.
- **League-rate constants** (`LEAGUE_PA` in `lib/mlb/splits.ts`) are 2024–2025 averages by pitcher hand. Refresh annually.
- **Empirical-Bayes shrinkage** prior strength `n0 = 200` PA. Don't change without a calibration study.
- **TTOP factors** (`lib/prob/ttop.ts`) come from Tango / Lichtman / Carleton published values. Don't tune without backtest data.
- **Calibration shim is identity in v1.** Fit isotonic regression from production `(predicted, actual)` pairs once ≥1k inning outcomes accumulate, then load via `loadCalibrator(table)`.
- **v2.1: catcher framing + fielder OAA** (`lib/env/{framing,defense}.ts`, `lib/prob/{framing,defense}.ts`). Framing acts on K and BB cells, OAA on the in-play block. EB shrinkage priors: `n0 = 2000` called pitches for framing, `n0 = 200` opportunities for OAA. Factor clamps: framing `[0.95, 1.05]`, defense `[0.90, 1.10]`. Both default to identity when scrape fails or live alignment is missing — pipeline degrades gracefully to v2.
- **Robo-ump kill switch:** `NRXI_DISABLE_FRAMING=1` zeroes the framing effect. Flip when MLB's ABS challenge system goes full-season; framing's value collapses overnight.
- **Live defensive alignment** read from `liveData.linescore.defense.{catcher, first, second, third, shortstop, left, center, right}` ids each tick. The watcher's `defenseAlignmentKey` is part of the recompute trigger so defensive subs auto-invalidate the cache.

## Validator hook quirks (advisory only)

The session has a `posttooluse-validate` hook that flags things like "Workflow files should import and use logging." It runs a regex against specific lines and frequently misses logging that's actually present (e.g. `log.info(...)` calls or `console.log` on non-flagged lines). **Treat its suggestions as advisory.** Don't add redundant `console.log` just to silence it. The real signals are: TypeScript errors, build errors, and test failures.

## Debugging runbook

```bash
# 1. Are workflows running?
npx workflow inspect runs --backend vercel --project nrxi-app --team kevinzhang019s-projects | head

# 2. Inspect a specific run
npx workflow inspect run <runId> --backend vercel --project nrxi-app --team kevinzhang019s-projects --json

# 3. What's in the snapshot right now?
vercel curl /api/snapshot | python3 -m json.tool

# 4. Raw Redis state (env loaded from .env.local)
set -a; source .env.local; set +a
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/keys/*"
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/hgetall/nrxi:snapshot"

# 5. Tail runtime logs
vercel logs <deployment-url>

# 6. Cancel a stuck run + clear its lock
npx workflow cancel <runId> --backend vercel --project nrxi-app --team kevinzhang019s-projects
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/del/nrxi:lock:<gamePk>"

# 7. Restart watcher manually
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"gamePk":NNNN,"awayTeamName":"...","homeTeamName":"..."}' \
  https://nrsi-app.vercel.app/api/workflows/game-watcher
```

## Don't change without thinking

- The hoisted `lastNrXi`/`lastEnv`/`lastPitcher*` vars in `workflows/game-watcher.ts:42-46` (bug #5)
- The `JSON.parse`-tolerance in `getSnapshot`/`iterateSnapshotChanges`/`getGame` (bug #4)
- The `vl,vr` sitCodes in `lib/mlb/client.ts:fetchSplits` and `lib/mlb/splits.ts`
- The `await connection()` calls at the top of every dynamic route handler and dynamic page (bug #3)
- The `withWorkflow(nextConfig)` wrapper in `next.config.ts` (bug #1)
- The `KV_REST_API_*` fallback in `lib/cache/redis.ts` (bug #2)
- The single-poller lock semantics — refresh TTL every tick, never do `await sleep(...)` longer than the lock TTL minus a margin
- The `season || season-1` fallback in `loadBatterProfile` / `loadPitcherProfile` — early-season splits are empty and prior-season is the only useful proxy
- The `hsetnx` (NOT `hset`) call in `workflows/steps/seed-snapshot.ts` — `hset` would clobber any watcher that already published a real state, replacing live data with a `Pre` stub
- The `layoutId={`card-${gamePk}`}` on the `motion.div` wrapper in `components/game-board.tsx` — without a stable `layoutId`, cards moving between the four section `<AnimatePresence>` parents would unmount/remount and lose their cross-section fade
- The `overflow-x-auto` wrapper around each `<ol>` in `components/lineup-column.tsx` paired with `min-w-max` on the `<ol>` and `whitespace-nowrap` on each row — this is what makes the whole lineup section scroll as a unit. Putting overflow on individual rows would break the user's "section moves together" requirement.
- The `xSlg` field on `NrXiPerBatter` / `PerBatter` — derived via `xSlgFromPa` in `lib/prob/expected-stats.ts`. The denominator deliberately strips BB+HBP (`1 - bb - hbp`) so the result lines up with conventional baseball-card SLG, not bases-per-PA. Don't "simplify" by dropping the denominator — that changes the semantics.
- The y-flip in `scripts/build-park-shapes.mjs:ty` (`VIEW_SIZE - (offY + (y - minY) * scale)`) — the GeomMLBStadiums CSV uses +y "into the outfield"; SVG uses +y "down the screen." Without the flip, every park renders upside down (home plate at the top, CF at the bottom). If you ever regenerate with a non-flipped version, every silhouette will look wrong.
- The `venue: g.venueId != null ? { id: g.venueId, name: "" } : null` line in `workflows/steps/seed-snapshot.ts` — the empty string is intentional. The watcher fills in the real venue name on its first publish. `<ParkOutline>` only needs the id, so empty-string is fine; `null` would hide the outline on Pre-game cards.
- The team→venueId map in `lib/parks/team-to-venue.ts` — Athletics map to Sutter Health Park (2529) but the polygon is Oakland Coliseum geometry; Rays map to Tropicana (12) regardless of any temporary relocation. These are deliberate compromises so the outline always renders. Don't drop entries — that just hides the silhouette.
- The `lh !== lastEnrichedHash` enrichment trigger in `workflows/game-watcher.ts` and the hoisted `lastLineups`/`lastEnrichedHash` workflow-scope vars (bug #7) — independent of `shouldRecompute` so Pre-game lineups hydrate the moment they post
- `LineupEntry.bats: HandCode | null` (`lib/mlb/extract.ts`) — the explicit nullability is the type-system guard against the bug-#7 default-to-R lie

## Dashboard sectioning + motion (added in this PR)

The dashboard groups today's games into four sections in fixed order: **Highlighted → Active → Upcoming → Finished**. Each is a separate `<AnimatePresence mode="popLayout">` parent, and each card is a `<motion.div layout layoutId={`card-${gamePk}`}>` so a card animates smoothly when `isDecisionMoment` flips (Active ↔ Highlighted) or when status changes (Pre → Live → Final).

Two things make this work end-to-end:

1. **`workflows/steps/seed-snapshot.ts`** runs at the top of the daily scheduler and writes a `Pre` stub `GameState` into `nrxi:snapshot` for every scheduled game via `hsetnx`. This is what populates the Upcoming section before any per-game watcher starts (~5 min pre-game). When a watcher's first `publishGameState` lands, the `hset` overwrites the stub atomically — same `gamePk` → same `layoutId` → card stays mounted, fields fill in.
2. **`useGameStream` keeps a stable `Map<gamePk, GameState>`.** SSE updates merge into the map; `<GameBoard>` re-derives sections via `useMemo`; cards already in flight finish their layout animation while still receiving fresh props. Don't add a section-name suffix to the `key` or `layoutId` — that would force remounts on section changes.

If you ever need to suppress the fade for a specific case (e.g. initial paint), use `<AnimatePresence initial={false}>` (already set in `game-board.tsx`).

## Lineup row contract

Each batter row in `components/lineup-column.tsx` shows exactly four fields, left → right: **bats** (handedness) · **F. Lastname** · **xOBP** · **xSLG**. The marker dot, batting-order spot number, and position abbreviation were intentionally removed — the current-batter signal is conveyed solely by the row-level background highlight (`bg-[var(--color-accent-soft)]/60`). Only the **at-bat** batter is highlighted; the next-half (on-deck) batter gets no row treatment. The lineup column header used to render `AT BAT` / `ON DECK` pills next to the team label — those were removed so the row highlight is the single focus signal.

The **bats** field is `HandCode | null` and gets hydrated from `/people/{id}` (cached 30d via `loadHand`) by `workflows/steps/enrich-lineup-hands.ts` — the live-feed boxscore omits `batSide` for most players, so reading it raw silently produces 18 right-handers per game (see bug #7). The render falls back to `"—"` if enrichment somehow misses, keeping the column width stable.

Each team's `<ol>` is wrapped in `<div className="overflow-x-auto">` with `min-w-max` on the `<ol>` and `whitespace-nowrap` on each row, so the **whole list translates as a unit** when scrolled (not row-by-row). Don't break this by putting overflow on individual rows or by adding `flex-wrap` to the row.

The displayed numbers come from `statsById: Map<id, { pReach, xSlg }>` built in `components/game-card.tsx` from `game.upcomingBatters`. Both values are computed server-side in `workflows/steps/compute-nrXi.ts` via `xSlgFromPa` (`lib/prob/expected-stats.ts`) and threaded through `NrXiPerBatter → PerBatter`. `pReach` and `xObp` are the same number — different name, identical value (`1 - k - ipOut`).

Display formatting uses `formatBaseballRate(n)`: 3 decimal places, leading `0` stripped only when present (so xOBP renders `.345` and xSLG renders `.412` or `1.234` if it ever exceeds 1).

## Park outline (CAD-blueprint glyph)

`<ParkOutline>` (`components/park-outline.tsx`) renders a 28px SVG silhouette of the home park — foul-line wedge + outfield outer wall, single 1.25px hairline stroke, no fill. It sits in the env-chip row of `<GameCard>` where the text label "Park" used to be; the outline literally is the label, with the numeric park run-factor rendered to its right.

Stroke transitions `var(--color-muted) → var(--color-accent)` over 240ms when `highlighted` flips, so the outline lights up **in lockstep** with the existing decision-moment ring + `flash-fresh` keyframe. One unified accent (green — `--color-accent` is now `#22c55e`) alert state across the whole card; no competing visual cues.

Pipeline:
1. **Source data:** `bdilday/GeomMLBStadiums/inst/extdata/mlb_stadia_paths.csv` — the polygon data Baseball Savant uses for spray charts. ~16k rows × 30 parks, columns `team,x,y,segment`.
2. **Build script:** `scripts/build-park-shapes.mjs` (run via `npm run build:park-shapes`) fetches the CSV, filters to `foul_lines` + `outfield_outer`, normalizes each park into a 100×100 viewBox with home plate at the bottom, and writes `lib/parks/shapes.json` keyed by MLB venueId (mapped through `lib/parks/team-to-venue.ts`).
3. **Runtime:** `<ParkOutline venueId={game.venue?.id} highlighted={game.isDecisionMoment} />` reads the JSON, renders the path, returns `null` if the venueId is unknown so layout doesn't shift.
4. **Pre-game cards:** `seedSnapshotStep` populates `venue.id` from the schedule so the outline appears in the Upcoming section before any watcher starts. Park run-factor renders as `—` until the watcher's first publish.

Refresh path: `npm run build:park-shapes` whenever a team relocates or a new park opens. Output is committed; deterministic re-runs produce byte-identical JSON.
