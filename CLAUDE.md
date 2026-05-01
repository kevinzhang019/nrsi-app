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

### 8. Predictions stale within a half-inning + squared/missing-half full-inning at transitions

**Symptom:** while a half-inning is in progress, the displayed P(no run) doesn't move as outs/bases change — a strikeout, walk, or single doesn't shift the value at all. At half-inning boundaries the card highlights via `isDecisionMoment` but the prediction either stays at the prior value or jumps to a clearly wrong number (notably squared or missing one half).

**Root causes:**
1. **Recompute trigger only fired on inning/half boundaries.** The old `shouldRecompute` keyed off `inningKey = "${inning}-${half}-${(outs ?? 0) >= 3 ? "end" : inningState}"`. Outs going 1→2 or bases changing under 3 outs did NOT change `inningKey`, so `lastNrXi` stayed pinned at the value computed at the start of the half-inning.
2. **Full-inning composition used raw `half` from `ls.isTopInning` instead of `upcoming.half`.** At end of TOP of N, raw `half==="Top"` but `upcoming.half==="Bottom"` (lineup.ts already flipped via `isMiddleOrEnd`); the code multiplied `lastNrXi.pNoHitEvent × oppHalf.pNoHitEvent` where both equaled P(bottom of N clean) — producing a squared value. At end of BOTTOM of N, raw `half==="Bottom"` but `upcoming.half==="Top"` of N+1; the `else if (half === "Bottom")` branch silently dropped the bottom-of-N+1 factor.
3. **`readMarkovStartState` only clamped outs.** With `outs===3`, outs was clamped to 0 but bases were still read from `ls.offense`, leaking stranded runners from the just-ended half into the next-half compute.

**Fix (all in `workflows/game-watcher.ts`):**
1. Two-phase trigger. `structuralKey` = `${upcoming.half}|${upcoming.inning}|${lh}|${dk}|${op}|${atBat}` — fires heavy reload (splits/park/weather/defense, the two `loadLineupSplitsStep` bundles, both `computeLineupStatsStep`, and `oppHalfClean` via `computeNrXiStep`) only on half-inning / lineup / defense / opp-pitcher / at-bat changes. `playStateKey` = `${outs}-${bases}-${atBatIndex}` — fires the per-PA `computeNrXiStep` recompute against the live startState, reusing the cached non-state inputs.
2. `oppHalfCleanCache` is hoisted to workflow scope and recomputed ONLY in the structural-reload phase. Phase 2 reads it for full-inning composition keyed off `upcoming.half` (not raw `half`), which fixes both transition bugs.
3. `readMarkovStartState` short-circuits to `{outs: 0, bases: 0}` when `inningState` is `middle`/`end` OR `outs >= 3`. The predicate mirrors `isMiddleOrEnd` in `lib/mlb/lineup.ts:26` so the Markov startState is consistent with which half `upcoming` has flipped to.
4. The at-bat batter id is in `structuralKey` because `upcoming.upcomingBatterIds` rotates by one per PA — without invalidating the splits cache on rotation, the Markov chain models the wrong starting batter. Per-batter PA profiles hit the 12h Redis cache on reload, and workflow step result-caching dedupes `computeLineupStatsStep` / `oppHalfClean` across rotations within the same half (their inputs don't change).

**Don't change without thinking:**
- The split between `structuralKey` and `playStateKey`. Folding them back into a single key forces lineupStats / oppHalfClean to recompute every PA (still correct via step caching, but wasteful and obscures the "heavy vs cheap" intent).
- Using `upcoming.half` (NOT raw `half`) in the full-inning composition AND in `lineupStats` defensive-alignment gating. Reverting reintroduces the squared bug at end-of-top and the missing-half bug at end-of-bottom.
- Including `atBat` (= `upcoming.upcomingBatterIds[0]`) in `structuralKey`. Without it, the Markov chain runs a stale batter sequence between PAs because `splitsCache.batters` order is frozen at the previous reload.
- Including `atBatIndex` in `playStateKey`. A solo HR with empty bases keeps `(outs, bases)` constant but ticks `atBatIndex` (and the upcoming sequence rotates) — without it, the recompute would skip a meaningful state change.
- The `isHalfOver` short-circuit in `readMarkovStartState`. Reverting to outs-only clamping reintroduces phantom-stranded-runners in the next-half compute.

**No cache flush required.** Stale snapshots overwrite on the next watcher tick.

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
- **User-facing settings defaults:** `predictMode: "full"`, `viewMode: "single"` (`lib/hooks/use-settings.tsx`). Persisted to `localStorage` under `nrxi:settings`. Both defaults are the LEFT option of their segmented toggle in the gear popover — users opt into half-inning / split-view. Changing the defaults is a UX call — be deliberate.

## Settings panel (predict mode + view mode)

Top-right gear icon in `app/page.tsx` opens a popover with two segmented toggles. State lives in `SettingsProvider` (`lib/hooks/use-settings.tsx`) — React Context + `localStorage`. Provider is rendered ABOVE `<Suspense>`/`<GameBoard>` so every card and child component reads the same setting.

**Predict mode (`half` | `full`):** picks which probability `<ProbabilityPill>` shows.
- `half` → `pNoHitEvent` / `breakEvenAmerican` — P(no run scored in the current half-inning).
- `full` → `pNoHitEventFullInning` / `breakEvenAmericanFullInning` — P(no run scored across BOTH halves of the current inning).

The full-inning value is computed server-side in `workflows/game-watcher.ts`:
- `half === "Top"`: `pNoFull = pNoTop_current × pNoBot_clean`. The bottom-half factor comes from a SECOND `computeNrXiStep` call with `startState: { outs: 0, bases: 0 }`, the home team's 9 starters, and the away team's current pitcher.
- `half === "Bottom"`: `pNoFull = pNoBot_current` — the top is over, so half = full.
- Opposing pitcher unknown (rare; pre-game with no probable starter, or a feed gap): `pNoHitEventFullInning = null` — the pill renders `—`. **No silent fall-through to half-inning.** That was an explicit product decision; preserve it.

**View mode (`single` | `split`):** picks which lineup layout `<GameCard>` renders.
- `single` (default) → `<LineupSinglePane>` shows ONE team at a time with team-name tabs above the column. Auto-snaps to `game.battingTeam` on every half-inning flip; manual click on the other tab is an ad-hoc peek that resets on the next flip. Pre-game default = away. Stats come from `game.lineupStats[selectedSide]`.
- `split` → existing two-column `<LineupColumn>` pair. Stats come from `game.upcomingBatters` (only the upcoming half-inning's batters get numbers; the rest show `—`).

**`game.lineupStats`** is `{ away: Record<id, {pReach,xSlg}>, home: Record<id, {pReach,xSlg}> } | null`. Populated by `workflows/steps/compute-lineup-stats.ts` — same per-PA pipeline as `compute-nrXi` (Log5 → env → TTOP → framing → defense) but skips the Markov chain, since these are display-only stats. Two parallel `loadLineupSplitsStep` calls (one per team's 9 starters vs the OPPOSING pitcher) feed two `computeLineupStatsStep` calls. Cached batter PA profiles (12h Redis) make repeat loads cheap.

**Defensive alignment is conditional:** when computing AWAY batters' stats, framing/OAA factors apply only when `half === "Top"` (the live alignment IS the home defense). When AWAY is sitting in the dugout, we don't know who the home defense will be, so framing/OAA are disabled (graceful v2 degradation). Same logic mirrored for HOME batters.

## Don't change without thinking (settings panel additions)

- The hoisted `lastFullInning` / `lastLineupStats` / `lastOppPitcherHash` in `workflows/game-watcher.ts` — same bug-#5/#7 trap as the other `lastX` vars. Loop-scoped versions would null-overwrite Redis on every steady-state tick.
- The lineup-hands enrichment block (`if (lh !== lastEnrichedHash)`) is now positioned BEFORE the `shouldRecompute` block, not after. The new full-inning + lineup-stats compute reads `lastLineups` to extract starter ids; if enrichment ran after, the first recompute would see `lastLineups === null` and silently emit empty `lineupStats`. Don't move it back below.
- `lineupStats` is keyed by `Record<string, ...>` not `Map<number, ...>` because the watcher serializes `GameState` to JSON and writes it to Redis (CLAUDE.md bug #4). Maps don't round-trip through JSON; string-keyed records do. The client converts back to a `Map` in `<LineupSinglePane>`.
- The opposing-pitcher hash (`op`) added to the recompute trigger in `workflows/game-watcher.ts` — when the opposite team's listed starter changes (rare; pre-game roster updates), full-inning + opposing-team lineupStats need to refresh. Removing `op` from the trigger would silently freeze those values.
- `pNoHitEventFullInning === null` when opposing pitcher is unknown — UI renders `—`. **Do not** fall back to `pNoHitEvent`; the user explicitly chose "show '—' until full is computable" so the displayed number always means what its label says.
- `LineupColumn`'s empty-string label suppression (`{label !== "" && ...}`) is what lets `<LineupSinglePane>` reuse the column without a duplicate header (the team-name tabs above already serve as the label).
- `SettingsProvider` initializes with `DEFAULTS` on the server and re-reads `localStorage` in a client-only `useEffect`. Without the deferred read, hydration would mismatch when a user has a non-default preference saved.

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
- **Pitch count is read fresh every tick** in the state-construction block of `workflows/game-watcher.ts` via `readPitcherPitchCount`, NOT inside the structural-reload branch. Pitch count changes on every pitch; structural reload only fires on PA boundaries. Hoisting it into a `lastPitchCount` workflow var would freeze the value mid-PA.
- **`game.awayPitcher` / `game.homePitcher` carry the LAST pitcher used by each team** (last entry of `boxscore.teams[side].pitchers[]`, sourced via `readBothPitchers`). When the team is fielding, that's the active mound pitcher; when sitting, it's whoever last pitched today. **No bullpen projection.** Split-mode renders both (currently-pitching on top, the other with `muted` styling) — removing this would silently make the muted pitcher disappear during the team's at-bat. Hoisted as `lastAwayPitcher` / `lastHomePitcher` in workflow scope per the bug #5/#7 pattern.
- **Single-pane `selectedSide` state lives in `GameCard`, not `LineupSinglePane`** (`components/game-card.tsx`). The pitcher row above the pane AND the lineup pane both derive from it (single mode shows the OPPOSING pitcher to `selectedSide`). Moving it back to the child would force the pitcher row to read its sibling's state via prop drilling backwards.

## Dashboard sectioning + motion (added in this PR)

The dashboard groups today's games into four sections in fixed order: **Highlighted → Active → Upcoming → Finished**. Each is a separate `<AnimatePresence mode="popLayout">` parent, and each card is a `<motion.div layout layoutId={`card-${gamePk}`}>` so a card animates smoothly when `isDecisionMoment` flips (Active ↔ Highlighted) or when status changes (Pre → Live → Final).

Two things make this work end-to-end:

1. **`workflows/steps/seed-snapshot.ts`** runs at the top of the daily scheduler and writes a `Pre` stub `GameState` into `nrxi:snapshot` for every scheduled game via `hsetnx`. This is what populates the Upcoming section before any per-game watcher starts (~5 min pre-game). When a watcher's first `publishGameState` lands, the `hset` overwrites the stub atomically — same `gamePk` → same `layoutId` → card stays mounted, fields fill in.
2. **`useGameStream` keeps a stable `Map<gamePk, GameState>`.** SSE updates merge into the map; `<GameBoard>` re-derives sections via `useMemo`; cards already in flight finish their layout animation while still receiving fresh props. Don't add a section-name suffix to the `key` or `layoutId` — that would force remounts on section changes.

If you ever need to suppress the fade for a specific case (e.g. initial paint), use `<AnimatePresence initial={false}>` (already set in `game-board.tsx`).

## Lineup row contract

Each batter row in `components/lineup-column.tsx` shows exactly four fields, left → right: **bats** (handedness) · **F. Lastname** · **xOBP** · **xSLG**. The marker dot, batting-order spot number, and position abbreviation were intentionally removed — the focus signals are now (1) the row-level background highlight (`bg-[var(--color-accent-soft)]/60`) and (2) the name text rendered in `var(--color-accent)`. The **at-bat** batter gets both: row background + green name. The **next-half (on-deck) leadoff** batter gets the green name only — no row background. Both states share `--color-accent` so the card's focus color stays unified; the row background is what distinguishes "now batting" from "leads off next half." The lineup column header used to render `AT BAT` / `ON DECK` pills next to the team label — those were removed so the row+name pair is the single focus signal.

The **bats** field is `HandCode | null` and gets hydrated from `/people/{id}` (cached 30d via `loadHand`) by `workflows/steps/enrich-lineup-hands.ts` — the live-feed boxscore omits `batSide` for most players, so reading it raw silently produces 18 right-handers per game (see bug #7). The render falls back to `"—"` if enrichment somehow misses, keeping the column width stable.

Each team's `<ol>` is wrapped in `<div className="overflow-x-auto">` with `min-w-max` on the `<ol>` and `whitespace-nowrap` on each row, so the **whole list translates as a unit** when scrolled (not row-by-row). Don't break this by putting overflow on individual rows or by adding `flex-wrap` to the row.

The **xOBP and xSLG stat spans** (both header and data cells) carry `shrink-0` in addition to `w-10`. Without it, flex can compress them when the name column is long — the row scrolls as a unit anyway so there's no reason to ever compress the stat columns. Both header `<span className="w-10 shrink-0 ...">` and data `<span className="w-10 shrink-0 ...">` must keep `shrink-0` or the columns narrow under long names.

The displayed numbers come from `statsById: Map<id, { pReach, xSlg }>` built in `components/game-card.tsx` from `game.upcomingBatters`. Both values are computed server-side in `workflows/steps/compute-nrXi.ts` via `xSlgFromPa` (`lib/prob/expected-stats.ts`) and threaded through `NrXiPerBatter → PerBatter`. `pReach` and `xObp` are the same number — different name, identical value (`1 - k - ipOut`).

Display formatting uses `formatBaseballRate(n)`: 3 decimal places, leading `0` stripped only when present (so xOBP renders `.345` and xSLG renders `.412` or `1.234` if it ever exceeds 1).

**Player-name links.** The batter name (starter and sub `↳` rows) is an `<a target="_blank" rel="noopener noreferrer" href="https://www.mlb.com/player/{id}">` — clicking opens the canonical MLB.com player page in a new tab (mlb.com resolves the bare id to the slugged URL server-side, so we don't need a name slug). The pitcher row at the top of `components/game-card.tsx` is wrapped the same way around `game.pitcher.name`. The accent classes (`text-[var(--color-accent)] font-medium`) and the sub `↳` glyph live INSIDE the anchor so the visible name string is the click target and the at-bat/on-deck focus signal still applies. Hover affordance is `hover:underline underline-offset-2` only — no color change on hover, since the accent color is reserved for the at-bat / next-half-leadoff signal.

## Pitcher row contract

`<PitcherRow>` (`components/pitcher-row.tsx`) renders one pitcher's row above the lineup section. Layout: name link · `(LHP|RHP)` · `ERA x.xx` · `WHIP x.xx` · `P NN`. Spacing is `gap-x-2` (tightened from `gap-x-3`) so a long name + 3 stats fits without wrapping on a normal-width card; the row still uses `flex-wrap` for genuinely-long edge cases.

The "P" stat is the pitcher's cumulative in-game pitch count, sourced from `boxscore.teams.{side}.players[ID{pitcherId}].stats.pitching.numberOfPitches` via `readPitcherPitchCount` in `workflows/game-watcher.ts`. It is read **fresh every tick** in the state-construction block (NOT cached in workflow scope) so the count updates intra-PA — pitch count changes on every pitch, far more often than the structural reload fires.

**Per view-mode rendering** in `components/game-card.tsx`:
- **`viewMode === "single"`**: ONE row, showing the OPPOSING pitcher to the selected lineup side (`selectedSide === "away" ? game.homePitcher : game.awayPitcher`). Half-inning flip auto-snaps both the lineup pane AND this pitcher row, since `selectedSide` is lifted to `GameCard` and shared.
- **`viewMode === "split"`**: TWO rows stacked. The currently-pitching team's pitcher is on top in normal color; the other team's last pitcher is below with `muted` styling (`text-[var(--color-muted)]` on the name + stat values). Determined by `game.half`: `Top → home pitches`, `Bottom → away pitches`. Pre-game / Final default to home on top.

The "other team's pitcher" displayed in split mode is the last pitcher who pitched for that team (`boxscore.teams[side].pitchers[]` last entry — `bothPitchers.{away,home}PitcherId` in the watcher). **No bullpen projection.** When the team is fielding it equals the active mound pitcher; when sitting it's whoever last pitched. This mirrors how `game.pitcher` already behaves for the prob pipeline.

`PitcherInfo.pitchCount` may be `null` when the boxscore hasn't populated it yet (very early pre-game) — the row hides the P stat in that case rather than rendering "P 0" as if zero pitches were thrown.

## Park outline (CAD-blueprint glyph)

`<ParkOutline>` (`components/park-outline.tsx`) renders a 28px SVG silhouette of the home park — foul-line wedge + outfield outer wall, single 1.25px hairline stroke, no fill. It sits in the env-chip row of `<GameCard>` where the text label "Park" used to be; the outline literally is the label, with the numeric park run-factor rendered to its right.

Stroke transitions `var(--color-muted) → var(--color-accent)` over 240ms when `highlighted` flips, so the outline lights up **in lockstep** with the existing decision-moment ring + `flash-fresh` keyframe. One unified accent (green — `--color-accent` is now `#22c55e`) alert state across the whole card; no competing visual cues.

Pipeline:
1. **Source data:** `bdilday/GeomMLBStadiums/inst/extdata/mlb_stadia_paths.csv` — the polygon data Baseball Savant uses for spray charts. ~16k rows × 30 parks, columns `team,x,y,segment`.
2. **Build script:** `scripts/build-park-shapes.mjs` (run via `npm run build:park-shapes`) fetches the CSV, filters to `foul_lines` + `outfield_outer`, normalizes each park into a 100×100 viewBox with home plate at the bottom, and writes `lib/parks/shapes.json` keyed by MLB venueId (mapped through `lib/parks/team-to-venue.ts`).
3. **Runtime:** `<ParkOutline venueId={game.venue?.id} highlighted={game.isDecisionMoment} />` reads the JSON, renders the path, returns `null` if the venueId is unknown so layout doesn't shift.
4. **Pre-game cards:** `seedSnapshotStep` populates `venue.id` from the schedule so the outline appears in the Upcoming section before any watcher starts. Park run-factor renders as `—` until the watcher's first publish.

Refresh path: `npm run build:park-shapes` whenever a team relocates or a new park opens. Output is committed; deterministic re-runs produce byte-identical JSON.

## Bases diamond

`<BasesDiamond>` (`components/bases-diamond.tsx`) is the live base-occupancy glyph in the header right column of `<GameCard>`, sitting **below** the inning indicator + outs dots. Three squares rotated 45° in a diamond formation: 2B at top, 1B at right, 3B at left, home plate implied below the bottom edge (not drawn). Filled square = runner on base (`var(--color-accent)` fill + stroke); empty square = 1.25px hairline stroke against `var(--color-border)`, fill transparent. Both states share a 240ms `fill/stroke` transition so the diamond animates smoothly when a runner reaches or scores. Same hairline weight + accent palette as `<ParkOutline>` so the card has one unified CAD-blueprint visual language.

**Data source:** `GameState.bases` is a 3-bit bitmask — `bit0=1B, bit1=2B, bit2=3B` — populated by `readDisplayBases(feed, status)` in `workflows/game-watcher.ts` straight from `liveData.linescore.offense.{first,second,third}`. **NOT** the same as `readMarkovStartState`'s output: that function force-zeros bases when the half is over (so the next-half Markov compute doesn't see phantom stranded runners), but for display we want the actual current bases even when outs flicker to 3 mid-tick before the half flips. Two separate readers, two different invariants — don't unify them.

**Null semantics:** `bases === null` when `status !== "Live"` (Pre / Final / Delayed / Suspended) and `<BasesDiamond>` returns `null` in that case so layout collapses cleanly. Pre-game stubs from `seedSnapshotStep` set `bases: null`. Don't fall back to `0` (empty diamond) — the absence of the glyph IS the signal that the game isn't live, matching how the outs dots only render in the Live branch of `<InningState>`.

**SVG layout:** `viewBox="0 0 28 22"` with squares centered at `(14, 7)`, `(23, 13)`, `(5, 13)` and a half-diagonal of `4.6` (~6.5px sides at 45°). The viewBox has ~3px top-padding above the 2B square's rotated extent — earlier versions used `viewBox="0 0 28 18"` and clipped the top corner of 2B. Don't shrink the viewBox vertical extent without also moving the squares down. `overflow-visible` on the SVG is a belt-and-suspenders for sub-pixel rounding.

**Don't change without thinking:**
- `readDisplayBases` vs `readMarkovStartState` — they diverge intentionally at half-boundaries. Folding them would either show empty bases mid-tick at end-of-half (display bug) or pollute the next-half Markov compute (probability bug).
- `bases: null` for non-Live states — keeps the diamond from rendering a misleading "empty" state for finished/scheduled games.
- The viewBox top-padding (`y=7` for 2B, viewBox height 22) — reverting to a tighter viewBox clips the 2B square.
- Square fill class swaps `fill-[var(--color-accent)]` ↔ `fill-transparent` (NOT `fill-none` or removing the prop). Without `fill-transparent`, hovering or focus events on parent elements can surface the SVG default fill = black.
