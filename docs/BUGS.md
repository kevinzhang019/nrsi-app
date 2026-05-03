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

**Fix:** `services/lib/prune-snapshots.ts:pruneStaleSnapshots({ todayET })` reads the snapshot hash and deletes any field-key whose row's own `officialDate < todayET`. The supervisor calls it after `seedSnapshot` on every cron firing (`services/supervisor.ts`), passing the same `date` it used for the schedule fetch so prune and seed share one clock.

The original implementation discriminated by "field-keys not in today's schedule pk list" — that was reverted in 2026-05-02 because a manual cron rerun whose schedule fetch came back partial or empty wiped still-scheduled games (see Bug 10). The row's own `officialDate` is sourced from the seed step (`services/steps/seed-snapshot.ts:officialDate: g.officialDate`) and preserved by every live publish, so we can identify yesterday's leftovers without consulting the schedule at all.

```ts
// services/supervisor.ts (excerpt)
await withRetry(() => seedSnapshot(games), { signal, label: "seedSnapshot" });
await withRetry(() => pruneSnapshotsFn({ todayET: date }), {
  signal,
  label: "pruneStaleSnapshots",
});
```

Also shipped:
- `bin/prune-snapshots.ts` — one-shot CLI for emergency cleanup outside a cron firing. `--date YYYY-MM-DD` overrides the cutoff (no longer fetches the schedule).
- `bin/seed-once.ts` — recovery helper after `bin/prune-snapshots.ts --all` wipes the hash.
- `bin/inspect-snapshot.ts` — read-only field-key dump.

**Regression check:** after each natural cron firing, `npx tsx bin/inspect-snapshot.ts` should print only rows whose `officialDate === todayET`. Rows with stale `officialDate` mean prune regressed.

**Don't change without thinking:**
- The `pruneStaleSnapshots` call after `seedSnapshot` in `services/supervisor.ts`. Removing it lets prior-day field-keys accumulate forever (until the entire hash TTL elapses without ANY publish — which doesn't happen during the season).
- `pruneStaleSnapshots` operating on `nrxi:snapshot` only — never touches `nrxi:lock:*` or `nrxi:watcher-state:*` (those have their own TTLs and per-gamePk semantics).
- The conservative-on-parse-failure behavior: rows that don't parse, or that lack `officialDate`, are kept. A transient deserialization bug must never become a hash wipe.

**Why an alternative `r.del(snapshot)` + reseed wasn't chosen:** date-based pruning preserves any HSET writes that landed between schedule fetch and the prune call (e.g., a watcher whose game is on today's schedule and started publishing during the supervisor boot). DEL would briefly wipe valid in-progress data. The date-based approach is one HGETALL + one HDEL of the stale list — trivial cost.

---

## Bug 10: Cron rerun pruned today's still-scheduled games

**Symptom:** user reran the daily Railway cron (`0 12 * * *` UTC) on 2026-05-02 and "scheduled games later in the day disappeared" from the dashboard. They never came back without redeploying / waiting for the next natural cron firing.

**Root cause:** `pruneStaleSnapshots(todaysGamePks)` discriminated by "field-keys not in the schedule fetch's pk list" and ran unconditionally after seed. The dashboard reads only from the `nrxi:snapshot` hash (`getSnapshot()` in `lib/pubsub/publisher.ts`, called from `app/page.tsx`) — there is no fallback to the MLB schedule API, so any pk that drops out of `todaysGamePks` between two cron runs vanishes from the UI.

The pk-list discriminator is fragile in three real-world ways:

1. **Empty schedule fetch.** `runSupervisor` only calls `seedSnapshot` when `games.length > 0` but **always** called prune. A transient MLB API hiccup that returns `{ dates: [] }`, or a date with a league-wide postponement, wiped the entire hash.
2. **TZ rollover at the rerun moment.** `todayInTz("America/New_York")` is computed at supervisor start. A rerun firing after midnight ET (around 04:00–05:00 UTC) queried tomorrow's schedule, today's pks weren't in `todaysGamePks`, and today's still-Live or still-Pre rows got pruned.
3. **Mid-day postponements.** A single game removed from MLB's schedule between the first and second runs (rainout reclassified) had its snapshot field deleted on rerun even though everything else was fine.

**Fix:** discriminate by each row's own `officialDate`, not by the schedule-fetch pk list. `pruneStaleSnapshots({ todayET })` now `HGETALL`s the snapshot hash, parses each value, and deletes only when `officialDate < todayET`. Rows whose value can't be parsed, or that lack an `officialDate`, are kept (conservative — a transient deserialization bug must never become a hash wipe).

This is robust to all three failure modes:
- Empty schedule fetch → today's rows all have `officialDate === todayET`, none get deleted.
- TZ rollover → only rows with yesterday's `officialDate` get cleaned, which is exactly what we want.
- Mid-day postponement → row stays until its `officialDate` becomes yesterday, then gets cleaned tomorrow.

Also keeps Bug 9's original guarantee: zombies from a paused/crashed prior runtime still get cleaned because their `officialDate` is `< todayET`.

**Regression check:** simulate a rerun in `services/supervisor.test.ts` with `fetchScheduleFn` returning `[]` and assert the prune call site receives `{ todayET: date }`, not a pk list. Unit-test `pruneStaleSnapshots` with mixed today/yesterday rows and confirm only yesterday is deleted.

**Don't change without thinking:**
- The discriminator must be the row's own `officialDate`, not today's schedule pk list. Reintroducing the pk-list form re-opens this bug.
- The conservative parse-failure behavior. Strict mode (delete on parse failure) reintroduces the "transient deserialization wipes the hash" risk.
- The supervisor passing its own `date` as `todayET`. Letting prune compute its own clock independently can drift if the supervisor was started near a midnight rollover.

---

## Bug 11: Snapshots stuck "Live" at varying innings after a watcher exits without cleanup

**Symptom:** the dashboard's Active section showed multiple "Live" games whose state hadn't updated for hours — Phillies @ Marlins frozen at 9 Top 7-2, Giants @ Rays frozen at 9 Top 1-1, Orioles @ Yankees frozen at 6 Bot 3-4, etc. `npx tsx bin/inspect-snapshot.ts` confirmed 8 entries with `status: "Live"` but `updatedAt` 1-3 hours ago, and `nrxi:lock:{gamePk}` was empty for all of them. Other (still-active) watchers were running normally for the late-evening games — only the early-PM games' watchers had vanished.

The frozen innings varied (6th, 7th, 9th), which ruled out an "all watchers hit MAX_LOOPS at the 9th" hypothesis: a watcher at the 6th inning has been alive for ~80 minutes, nowhere near the old 1500-loop cap (≈2h at 5s/loop).

**Root cause:** the watcher had **four** non-Final exit paths in `services/run-watcher.ts`, all of which `return`ed without publishing a Final status, calling `persistFinishedGameStep`, or deleting the snapshot field:

1. **`MAX_LOOPS`** (the 1500 cap) — `log.warn(...); return { reason: "max-loops" };` at the bottom of the loop. At 5s/loop active-PA cadence this fires after ≈2h, well within the runtime of a normal 9-inning game.
2. **`MAX_RUNTIME_MS`** (the 6h wall-clock cap) — same shape: `log.warn(...); return { reason: "max-runtime" };`.
3. **Abort signal (SIGTERM)** — both the top-of-loop `if (signal?.aborted) return { reason: "aborted" };` and the `await sleepMs(...)` catch. When Railway redeploys or kills the container, every in-flight watcher fires this path and freezes its snapshot.
4. **Uncaught error** — any thrown step (Redis hiccup, MLB API parse error, etc.) propagated up to `services/supervisor.ts:138` which logged and removed from `pending`. The watcher exited, snapshot froze.

Plus a fifth scenario the in-process code can't catch: **process kill** (SIGKILL, OOM, container eviction) — no JS code runs at all.

There was also a **secondary cascade**: when a new supervisor restarted seconds after a kill (e.g., manual deploy), the `acquireWatcherLock` call for early-PM games returned `false` because the dead watcher's lock still had ~30s TTL remaining. The new watcher returned `{ reason: "lock-held" }` immediately and the supervisor never retried. By the time the lock expired naturally, the supervisor had moved on.

The dashboard reads from `nrxi:snapshot` (a Redis hash with 24h TTL that gets reset to 24h on every `publishGameState` call). Once a watcher dies, nothing republishes that field, but `pruneStaleSnapshots` only deletes rows where `officialDate < todayET` — so today's stuck-Live snapshots survive until tomorrow's supervisor cron at 12:00 UTC.

**Fix:** two complementary layers.

**Layer 1 — in-process gracefulExit** (`services/lib/finalize-game.ts:performGracefulExit`). New helper called from all four non-Final exit paths. Captures the last successfully-published state (hoisted `lastPublishedState: GameState | null` set after each `publishUpdateStep`), does one final `fetchLiveDiff` (best-effort, never throws), then:

- If MLB has flipped to Final → run the existing Final logic (`buildPlayRows` + `persistFinishedGameStep` + `clearWatcherState`). Common case: MLB lags a few minutes between actual game end and flipping the status field.
- Otherwise → republish `{ ...lastPublishedState, status: "Final" }` so the dashboard moves the game out of Active. Doesn't call `persistFinishedGame` here because we don't have a verified terminal feed and don't want to write half-baked rows into the archive.
- If `lastPublishedState` is null (watcher never reached its first publish) → log and skip.

The main loop body in `services/run-watcher.ts` is wrapped in a single try/catch so any thrown step routes into `gracefulExit("error")` instead of bubbling to the supervisor. The two abort returns (top-of-loop and sleep-catch) also call `gracefulExit("abort")` first.

`MAX_LOOPS` was also bumped from 1500 to 5000 (≈7h at 5s/loop) so normal games never hit the budget. The 6h wall-clock `MAX_RUNTIME_MS` is the real ceiling now; MAX_LOOPS is just a defense against tight-loop bugs.

**Layer 2 — supervisor stale-Live detector** (`services/lib/stale-live-detector.ts:detectAndCleanStaleLive`). Called every `IDLE_CHECK_INTERVAL_MS` (60s) from the supervisor's idle loop. Scans `nrxi:snapshot`, and for each entry where `status === "Live"` AND `nrxi:lock:{gamePk}` is missing AND `updatedAt > 60s ago`, republishes a synthetic `{ ...state, status: "Final" }`. The lock check is the load-bearing signal — `startLockRefresher` keeps the lock fresh every 10s while a watcher is alive, so `lock missing === watcher dead`. The 60s threshold is just a safety margin against the brief publish/exit race within a single tick.

This is the only defense against the process-kill scenarios where no in-process code can run. It also unblocks the secondary lock-held cascade: even if a new supervisor returns "lock-held" for an early-PM game, the next idle pass cleans the orphaned snapshot within 60s of the dead watcher's lock expiring.

**Regression check:**
- `services/lib/finalize-game.test.ts` — covers all three outcomes (`finalized` / `abandoned` / `skipped`) plus all four exit reasons.
- `services/lib/stale-live-detector.test.ts` — covers active-lock guard, threshold guard, status filter, malformed entries, mixed snapshots, hgetall/getLock failures, custom thresholds.
- `services/supervisor.test.ts` — periodic detector invocation while watchers pending, and detector throwing doesn't crash the supervisor.

**Don't change without thinking:**
- Hoisted `lastPublishedState` set after every successful `publishUpdateStep`. Folding into loop scope, or moving the assignment before the publish, breaks the synthetic-Final reconstruction.
- `gracefulExit` wired to all four non-Final exit paths (`max-loops`, `max-runtime`, `abort`, `error`). Removing it from any one path reintroduces stuck-Live snapshots for that exit class.
- The main loop body's try/catch — folding it back into per-step error handling means an uncaught step propagates to the supervisor without cleanup.
- The stale-Live detector's `lock missing === watcher dead` premise. Any change to lock TTL (currently 30s) or refresher cadence (currently 10s in `services/lib/lock.ts`) must keep that invariant. If both move toward `TTL ≈ refresh interval`, a healthy watcher can briefly look "dead" between refreshes and the detector will false-positive-clean it.
- The 60s `DEFAULT_STALE_AFTER_MS`. Raising it delays cleanup; lowering it risks racing the publish/exit gap inside a single tick. Don't try to use it to cover Delayed/Suspended games (300s polling) — those still have a live lock and the lock check filters them out before the threshold matters.
- The detector running BEFORE the sleep but AFTER the break checks in `services/supervisor.ts`. Moving it before the break would run it on past-deadline supervisors (no Live games to clean — wasted call). Moving it after the sleep delays first-pass cleanup by 60s.
