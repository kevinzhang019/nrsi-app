# Historical bugs — do NOT re-introduce

Each bug here was hit in production or during development and cost real time. The corresponding one-line entries in `CLAUDE.md` ("Don't change without thinking" / "Bug index") are the surface invariants; this file is the archaeology behind them. Read the relevant entry before touching the surrounding code.

---

## Bug 1: Missing `withWorkflow()` in `next.config.ts` — *no longer reachable*

> **Status:** Vercel WDK was removed entirely in commit `0d6e962`. The watcher now runs on Railway. This bug can't fire anymore unless someone re-adds `withWorkflow()` and the `0 13 * * *` cron entry — and if they do, the WDK scheduler will re-fire and re-burn the Vercel Functions cap (the original reason we migrated). The lesson is preserved here for context; **the action item is "do not re-add WDK to this codebase"**.

**Symptom (historical):** `start(workflow)` calls returned successfully but workflows never appeared in the runs list, and `/.well-known/workflow/v1/*` routes 404'd.

**Root cause:** Workflow DevKit needed the Next adapter to register its runtime endpoints. Without it, `start()` was a no-op.

**Fix that was applied (and later removed):** the config used to wrap `nextConfig` with `withWorkflow()` from `workflow/next`. After Phase D of the Railway migration, `next.config.ts` is back to a plain `export default nextConfig` and the four `@workflow/*` deps are gone from `package.json`.

**Why we don't need this anymore:** Railway runs the supervisor as a plain Node process via `npx tsx bin/supervisor.ts`. No durable orchestrator framework, no `/.well-known` runtime endpoints, no plugin to forget.

---

## Bug 2: Vercel Marketplace Upstash provisions `KV_REST_API_*`, not `UPSTASH_REDIS_REST_*`

**Symptom:** `vercel env ls` shows `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `KV_URL`, `REDIS_URL` — but the app throws `Missing UPSTASH_REDIS_REST_URL / TOKEN`.

**Root cause:** the Marketplace integration uses Vercel KV's legacy naming for backwards compat, even though the underlying provider is Upstash.

**Fix:** `lib/cache/redis.ts` reads `KV_REST_API_URL || UPSTASH_REDIS_REST_URL` (and same for token). Both work.

---

## Bug 3: Cache Components requires `connection()` + `<Suspense>` for dynamic data

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

---

## Bug 4: `@upstash/redis` auto-parses JSON on read

**Symptom:** `r.hgetall(...)` returns objects in production but tests/local pass when stored values are JSON strings. Code doing `JSON.parse(value)` silently throws and gets filtered out, leaving callers with empty arrays.

**Root cause:** the Upstash REST SDK detects values that look like JSON and parses them automatically. If you stored `JSON.stringify(state)`, you read back an object — not a string.

**Fix in this repo:** `lib/pubsub/publisher.ts:getSnapshot`, `lib/pubsub/subscriber.ts:iterateSnapshotChanges`, and `app/games/[pk]/page.tsx:getGame` all tolerate both shapes:
```ts
if (raw && typeof raw === "object") return raw as T;
if (typeof raw === "string") return JSON.parse(raw) as T;
return null;
```

---

## Bug 5: Loop-scoped `nrXi`/`env`/`pitcher` vars overwrite Redis with nulls

**Symptom:** the watcher first publishes a state with valid probabilities, then on the next tick (no inning change) overwrites it with `pHitEvent: null, upcomingBatters: [], pitcher: null`. Frontend shows "—" everywhere despite watchers being healthy.

**Root cause:** the watcher loop only runs the compute path when `shouldRecomputePlay` is true (inning changed OR play state advanced). If the result was assigned to a local `let nrXi` declared INSIDE the loop body, it reset to `null` on every iteration. Every steady-state tick then constructed a `state` with null fields and `publishUpdateStep(state)` happily wrote it.

**Fix:** hoist the cached values to the **watcher scope** (above the loop, inside the `try { ... }` block in `services/run-watcher.ts:runWatcher`). Roughly:
```ts
let lastNrXi: Awaited<ReturnType<typeof computeNrXiStep>> | null = restored.lastNrXi;
let lastEnv = restored.lastEnv;
let lastPitcherId = restored.lastPitcherId;
let lastPitcherName = restored.lastPitcherName;
let lastPitcherThrows: "L" | "R" = restored.lastPitcherThrows;
// ... plus lastFullInning, lastLineupStats, lastAwayPitcher, lastHomePitcher, etc.
```

These get **updated only when** `shouldReloadStructure && upcoming` (Phase 1) or `shouldRecomputePlay && upcoming && caches != null` (Phase 2), and read on every tick when constructing the published `state`. Don't move them back into the loop body.

**Railway-specific addition:** the bundle is also persisted to `nrxi:watcher-state:{gamePk}` on every tick via `services/lib/watcher-state.ts:saveWatcherState`, so a Railway pod restart hydrates the same hoisted vars instead of starting fresh. WDK gave us this durability for free; on Railway we serialize it explicitly.

---

## Bug 6: Park / weather scrapers silently fall back to neutral 1.0

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

**One-time cache flush after deploy** — see `docs/RUNBOOK.md`.

---

## Bug 7: Boxscore omits `batSide` — every batter renders as a righty

**Symptom:** the lineup column on every game card shows `R` next to all 9 batters (and any subs). The actively-on-deck `upcomingBatters` array — populated through a different path — has correct handedness, but the full lineup rendered by `<LineupColumn>` is uniformly right-handed.

**Root cause:** `lib/mlb/extract.ts:entryFrom` previously did `bats: (p.batSide?.code as HandCode | undefined) ?? "R"`. The MLB live feed boxscore (`liveData.boxscore.teams.*.players[ID*]`) populates positions, batting-order codes, and per-game stats reliably — but **routinely omits `batSide`** for most or all players. The default-to-R then silently lied for 18 batters per game. The canonical source for handedness is `/api/v1/people/{id}` (already cached 30d in `hand:{playerId}` via `loadHand` in `lib/mlb/splits.ts`), but that lookup was only being made for the ~3 upcoming batters going through `loadBatterPaProfile`, never for the full lineup roster.

**Fix:**
1. `LineupEntry.bats` is now `HandCode | null` and `entryFrom` returns `null` when `batSide` is absent — no more silent lie.
2. New step `services/steps/enrich-lineup-hands.ts` fans out `loadHand()` over every starter+sub id (deduped via `Set`) and overwrites `bats` with the canonical code. Per-id failures degrade to whatever extract produced rather than killing the whole tick.
3. `services/run-watcher.ts` hoists `lastLineups` + `lastEnrichedHash` into the watcher scope (same pattern as bug #5) and runs enrichment only when the boxscore battingOrder hash (`lh`) changes. Crucially this is **independent of `shouldRecomputePlay`** — Pre-game lineups (status !== "Live") still get hydrated as soon as they post. Steady-state ticks reuse the cached enriched lineups.
4. UI fallback: `slot.starter.bats ?? "—"` keeps column width stable on the rare case enrichment misses.

**Why pitcher `throws` doesn't have this bug:** `pitcher.throws` flows through `loadHand(pitcherId)` → `splits.pitcher.throws` → `lastPitcherThrows` → published `GameState.pitcher.throws`. `loadHand` itself defaults to `"R"` but `/people/{id}` reliably returns `pitchHand.code` for every MLB pitcher, so the fallback never fires.

**Don't change without thinking:**
- `bats: HandCode | null` typing in `LineupEntry` (`lib/mlb/extract.ts:6`) — narrowing it back to non-null reintroduces the silent lie via the type system
- The `lh !== lastEnrichedHash` check that runs **independent of** `shouldRecomputePlay` in `services/run-watcher.ts` — gating it on `shouldRecomputePlay` would skip Pre-game enrichment because that branch requires `status === "Live"`
- Hoisting `lastLineups` to the watcher scope (same reason as bug #5) — keeping it loop-local would cause wasteful re-fetches every tick
- `loadHand` exported from `lib/mlb/splits.ts` — the enrichment step depends on it

**No cache flush required.** The bad data lived in `nrxi:snapshot` (24h TTL); the next watcher tick after deploy overwrites it. The `hand:{playerId}` keys were always correct — we just weren't reading them for the lineup. Finished games are replaced on the next supervisor cron firing or expire naturally within 24h.

---

## Bug 8: Predictions stale within a half-inning + squared/missing-half full-inning at transitions

**Symptom:** while a half-inning is in progress, the displayed P(no run) doesn't move as outs/bases change — a strikeout, walk, or single doesn't shift the value at all. At half-inning boundaries the card highlights via `isDecisionMoment` but the prediction either stays at the prior value or jumps to a clearly wrong number (notably squared or missing one half).

**Root causes:**
1. **Recompute trigger only fired on inning/half boundaries.** The old `shouldRecompute` keyed off `inningKey = "${inning}-${half}-${(outs ?? 0) >= 3 ? "end" : inningState}"`. Outs going 1→2 or bases changing under 3 outs did NOT change `inningKey`, so `lastNrXi` stayed pinned at the value computed at the start of the half-inning.
2. **Full-inning composition used raw `half` from `ls.isTopInning` instead of `upcoming.half`.** At end of TOP of N, raw `half==="Top"` but `upcoming.half==="Bottom"` (lineup.ts already flipped via `isMiddleOrEnd`); the code multiplied `lastNrXi.pNoHitEvent × oppHalf.pNoHitEvent` where both equaled P(bottom of N clean) — producing a squared value. At end of BOTTOM of N, raw `half==="Bottom"` but `upcoming.half==="Top"` of N+1; the `else if (half === "Bottom")` branch silently dropped the bottom-of-N+1 factor.
3. **`readMarkovStartState` only clamped outs.** With `outs===3`, outs was clamped to 0 but bases were still read from `ls.offense`, leaking stranded runners from the just-ended half into the next-half compute.

**Fix (all in `services/run-watcher.ts` + `services/start-state.ts`):**
1. Two-phase trigger. `structuralKey` = `${upcoming.half}|${upcoming.inning}|${lh}|${dk}|${op}|${atBat}` — fires heavy reload (splits/park/weather/defense, the two `loadLineupSplitsStep` bundles, both `computeLineupStatsStep`, and `oppHalfClean` via `computeNrXiStep`) only on half-inning / lineup / defense / opp-pitcher / at-bat changes. `playStateKey` = `${outs}-${bases}-${atBatIndex}` — fires the per-PA `computeNrXiStep` recompute against the live startState, reusing the cached non-state inputs.
2. `oppHalfCleanCache` is hoisted to watcher scope and recomputed ONLY in the structural-reload phase. Phase 2 reads it for full-inning composition keyed off `upcoming.half` (not raw `half`), which fixes both transition bugs.
3. `readMarkovStartState` (in `services/start-state.ts`) short-circuits to `{outs: 0, bases: 0}` when `inningState` is `middle`/`end` OR `outs >= 3`. The predicate mirrors `isMiddleOrEnd` in `lib/mlb/lineup.ts:26` so the Markov startState is consistent with which half `upcoming` has flipped to.
4. The at-bat batter id is in `structuralKey` because `upcoming.upcomingBatterIds` rotates by one per PA — without invalidating the splits cache on rotation, the Markov chain models the wrong starting batter. Per-batter PA profiles hit the 12h Redis cache on reload, so the rotation-driven reload is cheap.

**Don't change without thinking:**
- The split between `structuralKey` and `playStateKey`. Folding them back into a single key forces lineupStats / oppHalfClean to recompute every PA (wasteful and obscures the "heavy vs cheap" intent).
- Using `upcoming.half` (NOT raw `half`) in the full-inning composition AND in `lineupStats` defensive-alignment gating. Reverting reintroduces the squared bug at end-of-top and the missing-half bug at end-of-bottom.
- Including `atBat` (= `upcoming.upcomingBatterIds[0]`) in `structuralKey`. Without it, the Markov chain runs a stale batter sequence between PAs because `splitsCache.batters` order is frozen at the previous reload.
- Including `atBatIndex` in `playStateKey`. A solo HR with empty bases keeps `(outs, bases)` constant but ticks `atBatIndex` (and the upcoming sequence rotates) — without it, the recompute would skip a meaningful state change.
- The `isHalfOver` short-circuit in `readMarkovStartState`. Reverting to outs-only clamping reintroduces phantom-stranded-runners in the next-half compute.

**No cache flush required.** Stale snapshots overwrite on the next watcher tick.

---

## Bug 9: Snapshot zombie hash entries

**Symptom:** the dashboard shows games that aren't in today's MLB schedule — typically lingering "Live" or "Pre" cards from a prior runtime that crashed or was paused mid-game. The cards never update because no watcher is publishing for those gamePks anymore, but the rows persist in the `nrxi:snapshot` Redis hash.

Example: discovered after the Vercel WDK runtime was paused mid-day. Today's supervisor on Railway logged `seedSnapshot:ok seeded:0` (HSETNX skipped today's games because the hash already contained yesterday's pks under different field-keys), then a manual `bin/inspect-snapshot.ts` showed 41 zombie field-keys.

**Root cause:** `lib/pubsub/publisher.ts:publishGameState` does:
```ts
await Promise.all([
  r.publish(k.pubsubChannel(), JSON.stringify(state)),
  r.hset(k.snapshot(), { [String(state.gamePk)]: JSON.stringify(state) }),
  r.expire(k.snapshot(), 60 * 60 * 24),
]);
```

Every tick of every watcher resets the entire hash's 24h TTL. As long as **any** watcher is publishing today, the hash never expires — and any field-keys from prior runtimes (especially under different gamePks) stay forever.

**Fix:** `services/lib/prune-snapshots.ts:pruneStaleSnapshots(todaysGamePks)` deletes any field-key not in the keep set. The supervisor calls it after `seedSnapshot` on every cron firing (`services/supervisor.ts`). Idempotent and cheap (one `HKEYS` + at most one `HDEL` of the diff list).

```ts
// services/supervisor.ts (excerpt)
await withRetry(() => seedSnapshot(games), { signal, label: "seedSnapshot" });
await withRetry(() => pruneSnapshotsFn(games.map((g) => g.gamePk)), {
  signal,
  label: "pruneStaleSnapshots",
});
```

Also shipped:
- `bin/prune-snapshots.ts` — one-shot CLI for emergency cleanup outside a cron firing.
- `bin/seed-once.ts` — recovery helper after `bin/prune-snapshots.ts --all` wipes the hash.
- `bin/inspect-snapshot.ts` — read-only field-key dump.

**Regression check:** after each natural cron firing, `npx tsx bin/inspect-snapshot.ts` should print exactly today's gamePks. If it ever shows extras, the prune step has regressed.

**Don't change without thinking:**
- The `pruneStaleSnapshots` call after `seedSnapshot` in `services/supervisor.ts`. Removing it lets prior-day field-keys accumulate forever (until the entire hash TTL elapses without ANY publish — which doesn't happen during the season).
- `pruneStaleSnapshots` operating on `nrxi:snapshot` only — never touches `nrxi:lock:*` or `nrxi:watcher-state:*` (those have their own TTLs and per-gamePk semantics).
- The supervisor calling prune even when `games.length === 0` (off-season days). That's exactly when prior-day field-keys most need wiping.

**Why an alternative `r.del(snapshot)` + reseed wasn't chosen:** diff-based pruning preserves any HSET writes that landed between schedule fetch and the prune call (e.g., a watcher whose game is on today's schedule and started publishing during the supervisor boot). DEL would briefly wipe valid in-progress data. The diff-based approach is also one extra HKEYS + one HDEL of the diff list — trivial cost.
