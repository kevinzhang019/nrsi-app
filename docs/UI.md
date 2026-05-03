# UI contracts and frontend invariants

Stable behavior the frontend depends on. Each section explains what's rendered, what data it reads, and the non-obvious bits that broke before. The matching one-liners in `CLAUDE.md`'s "Don't change without thinking" list are the surface invariants; this file is the prose behind them.

---

## Settings panel (predict mode + view mode)

Top-right gear icon in `app/page.tsx` opens a popover with two segmented toggles. State lives in `SettingsProvider` (`lib/hooks/use-settings.tsx`) — React Context + `localStorage`. Provider is rendered ABOVE `<Suspense>`/`<GameBoard>` so every card and child component reads the same setting.

**User-facing defaults:** `predictMode: "full"`, `viewMode: "single"`. Persisted to `localStorage` under `nrxi:settings`. Both defaults are the LEFT option of their segmented toggle in the gear popover — users opt into half-inning / split-view. Changing the defaults is a UX call — be deliberate.

### Predict mode (`half` | `full`)

Picks which probability `<ProbabilityPill>` shows.
- `half` → `pNoHitEvent` / `breakEvenAmerican` — P(no run scored in the current half-inning).
- `full` → `pNoHitEventFullInning` / `breakEvenAmericanFullInning` — P(no run scored across BOTH halves of the current inning).

The full-inning value is computed server-side in `services/run-watcher.ts`:
- `half === "Top"`: `pNoFull = pNoTop_current × pNoBot_clean`. The bottom-half factor comes from a SECOND `computeNrXiStep` call with `startState: { outs: 0, bases: 0 }` (or `bases: 2` in extras for the Manfred runner), the home team's 9 starters, and the away team's current pitcher.
- `half === "Bottom"`: `pNoFull = pNoBot_current` — the top is over, so half = full.
- **Top of the 9th, home leading**: `pNoFull = pNoTop_current` — bottom-9 won't be played, so we skip the bottom multiplier. Predicate `services/full-inning.ts:shouldSkipBottomNinth({inning, half, homeRuns, awayRuns})` gates this. Tied or visitors-ahead in top-9 → bottom-9 plays and we compose normally. Bottom of 9 + extras always compose normally.
- Opposing pitcher unknown (rare; pre-game with no probable starter, or a feed gap): `pNoHitEventFullInning = null` — the pill renders `—`. **No silent fall-through to half-inning.** That was an explicit product decision; preserve it.

### View mode (`single` | `split`)

Picks which lineup layout `<GameCard>` renders.
- `single` (default) → `<LineupSinglePane>` shows ONE team at a time with team-name tabs above the column. Auto-snaps to `game.battingTeam` on every half-inning flip; manual click on the other tab is an ad-hoc peek that resets on the next flip. Pre-game default = away. Stats come from `game.lineupStats[selectedSide]`.
- `split` → existing two-column `<LineupColumn>` pair. Stats come from `game.upcomingBatters` (only the upcoming half-inning's batters get numbers; the rest show `—`).

`game.lineupStats` is `{ away: Record<id, {pReach,xSlg}>, home: Record<id, {pReach,xSlg}> } | null`. Populated by `services/steps/compute-lineup-stats.ts` — same per-PA pipeline as `compute-nrXi` (Log5 → env → TTOP → framing → defense) but skips the Markov chain, since these are display-only stats. Two parallel `loadLineupSplitsStep` calls (one per team's 9 starters vs the OPPOSING pitcher) feed two `computeLineupStatsStep` calls. Cached batter PA profiles (12h Redis) make repeat loads cheap.

**Defensive alignment is conditional:** when computing AWAY batters' stats, framing/OAA factors apply only when `half === "Top"` (the live alignment IS the home defense). When AWAY is sitting in the dugout, we don't know who the home defense will be, so framing/OAA are disabled (graceful v2 degradation). Same logic mirrored for HOME batters.

### Don't change without thinking

- The hoisted `lastFullInning` / `lastLineupStats` / `lastOppPitcherHash` in `services/run-watcher.ts` — same bug-#5/#7 trap as the other `lastX` vars. Loop-scoped versions would null-overwrite Redis on every steady-state tick.
- The lineup-hands enrichment block (`if (lh !== lastEnrichedHash)`) is positioned BEFORE the `shouldRecompute` block, not after. The full-inning + lineup-stats compute reads `lastLineups` to extract starter ids; if enrichment ran after, the first recompute would see `lastLineups === null` and silently emit empty `lineupStats`. Don't move it back below.
- `lineupStats` is keyed by `Record<string, ...>` not `Map<number, ...>` because the watcher serializes `GameState` to JSON and writes it to Redis (BUGS.md bug #4). Maps don't round-trip through JSON; string-keyed records do. The client converts back to a `Map` in `<LineupSinglePane>`.
- The opposing-pitcher hash (`op`) added to the recompute trigger in `services/run-watcher.ts` — when the opposite team's listed starter changes (rare; pre-game roster updates), full-inning + opposing-team lineupStats need to refresh. Removing `op` from the trigger would silently freeze those values.
- `pNoHitEventFullInning === null` when opposing pitcher is unknown — UI renders `—`. **Do not** fall back to `pNoHitEvent`; the user explicitly chose "show '—' until full is computable" so the displayed number always means what its label says.
- `LineupColumn`'s empty-string label suppression (`{label !== "" && ...}`) is what lets `<LineupSinglePane>` reuse the column without a duplicate header (the team-name tabs above already serve as the label).
- `SettingsProvider` initializes with `DEFAULTS` on the server and re-reads `localStorage` in a client-only `useEffect`. Without the deferred read, hydration would mismatch when a user has a non-default preference saved.

---

## Dashboard sectioning + motion

The dashboard groups today's games into four sections in fixed order: **Highlighted → Active → Upcoming → Finished**. Each is a separate `<AnimatePresence mode="popLayout">` parent, and each card is a `<motion.div layout layoutId={`card-${gamePk}`}>` so a card animates smoothly when `isDecisionMoment` flips (Active ↔ Highlighted) or when status changes (Pre → Live → Final).

Two things make this work end-to-end:

1. **`services/steps/seed-snapshot.ts`** runs at the top of the supervisor (Railway cron `0 12 * * *`) and writes a `Pre` stub `GameState` into `nrxi:snapshot` for every scheduled game via `hsetnx`. This is what populates the Upcoming section before any per-game watcher starts (~90s pre-game). When a watcher's first `publishGameState` lands, the `hset` overwrites the stub atomically — same `gamePk` → same `layoutId` → card stays mounted, fields fill in.
2. **`useGameStream` keeps a stable `Map<gamePk, GameState>`.** SSE updates merge into the map; `<GameBoard>` re-derives sections via `useMemo`; cards already in flight finish their layout animation while still receiving fresh props. Don't add a section-name suffix to the `key` or `layoutId` — that would force remounts on section changes.

If you ever need to suppress the fade for a specific case (e.g. initial paint), use `<AnimatePresence initial={false}>` (already set in `game-board.tsx`).

---

## Lineup row contract

Each batter row in `components/lineup-column.tsx` shows exactly four fields, left → right: **bats** (handedness) · **F. Lastname** · **xOBP** · **xSLG**. The marker dot, batting-order spot number, and position abbreviation were intentionally removed — the focus signals are now (1) the row-level background highlight (`bg-[var(--color-accent-soft)]/60`) and (2) the name text rendered in `var(--color-accent)`. The **at-bat** batter gets both: row background + green name. The **next-half (on-deck) leadoff** batter gets the green name only — no row background. Both states share `--color-accent` so the card's focus color stays unified; the row background is what distinguishes "now batting" from "leads off next half." The lineup column header used to render `AT BAT` / `ON DECK` pills next to the team label — those were removed so the row+name pair is the single focus signal.

**Where the on-deck id comes from.** `lib/mlb/extract.ts:extractBatterFocus(feed, lastBatterIds)` resolves `nextHalfLeadoffId` for the team coming up. Because MLB's `linescore.offense` only tracks the team currently at bat, the watcher tracks the most-recent batter per team itself: hoisted `lastAwayBatterId` / `lastHomeBatterId` in `services/run-watcher.ts`, persisted via `saveWatcherState`. With those in hand, leadoff = `order[(idxOfOtherTeamLastBatter + 1) % 9]`. Fallback when that team hasn't batted yet (or the id isn't in the current `battingOrder`) is `order[0]`. The fallback path was the old default for every half-boundary, which manifested as "the highlight is always the leadoff hitter" regardless of where the team actually left off — don't regress to it.

The **bats** field is `HandCode | null` and gets hydrated from `/people/{id}` (cached 30d via `loadHand`) by `services/steps/enrich-lineup-hands.ts` — the live-feed boxscore omits `batSide` for most players, so reading it raw silently produces 18 right-handers per game (see BUGS.md bug #7). The render falls back to `"—"` if enrichment somehow misses, keeping the column width stable.

Each team's `<ol>` is wrapped in `<div className="overflow-x-auto">` with `min-w-max` on the `<ol>` and `whitespace-nowrap` on each row, so the **whole list translates as a unit** when scrolled (not row-by-row). Don't break this by putting overflow on individual rows or by adding `flex-wrap` to the row.

The **xOBP and xSLG stat spans** (both header and data cells) carry `shrink-0` in addition to `w-10`. Without it, flex can compress them when the name column is long — the row scrolls as a unit anyway so there's no reason to ever compress the stat columns. Both header `<span className="w-10 shrink-0 ...">` and data `<span className="w-10 shrink-0 ...">` must keep `shrink-0` or the columns narrow under long names.

The displayed numbers come from `statsById: Map<id, { pReach, xSlg }>` built in `components/game-card.tsx` from `game.upcomingBatters`. Both values are computed server-side in `services/steps/compute-nrXi.ts` via `xSlgFromPa` (`lib/prob/expected-stats.ts`) and threaded through `NrXiPerBatter → PerBatter`. `pReach` and `xObp` are the same number — different name, identical value (`1 - k - ipOut`).

Display formatting uses `formatBaseballRate(n)`: 3 decimal places, leading `0` stripped only when present (so xOBP renders `.345` and xSLG renders `.412` or `1.234` if it ever exceeds 1).

**Player-name links.** The batter name (starter and sub `↳` rows) is an `<a target="_blank" rel="noopener noreferrer" href="https://www.mlb.com/player/{id}">` — clicking opens the canonical MLB.com player page in a new tab (mlb.com resolves the bare id to the slugged URL server-side, so we don't need a name slug). The pitcher row at the top of `components/game-card.tsx` is wrapped the same way around `game.pitcher.name`. The accent classes (`text-[var(--color-accent)] font-medium`) and the sub `↳` glyph live INSIDE the anchor so the visible name string is the click target and the at-bat/on-deck focus signal still applies. Hover affordance is `hover:underline underline-offset-2` only — no color change on hover, since the accent color is reserved for the at-bat / next-half-leadoff signal.

---

## Pitcher row contract

`<PitcherRow>` (`components/pitcher-row.tsx`) renders one pitcher's row above the lineup section. Layout: name link · `(LHP|RHP)` · `ERA x.xx` · `WHIP x.xx` · `P NN`. Spacing is `gap-x-2` (tightened from `gap-x-3`) so a long name + 3 stats fits without wrapping on a normal-width card; the row still uses `flex-wrap` for genuinely-long edge cases.

The "P" stat is the pitcher's cumulative in-game pitch count, sourced from `boxscore.teams.{side}.players[ID{pitcherId}].stats.pitching.numberOfPitches` via `readPitcherPitchCount` in `services/run-watcher.ts`. It is read **fresh every tick** in the state-construction block (NOT cached in watcher scope) so the count updates intra-PA — pitch count changes on every pitch, far more often than the structural reload fires.

**Per view-mode rendering** in `components/game-card.tsx`:
- **`viewMode === "single"`**: ONE row, showing the OPPOSING pitcher to the selected lineup side (`selectedSide === "away" ? game.homePitcher : game.awayPitcher`). Half-inning flip auto-snaps both the lineup pane AND this pitcher row, since `selectedSide` is lifted to `GameCard` and shared.
- **`viewMode === "split"`**: TWO rows stacked. The currently-pitching team's pitcher is on top in normal color; the other team's last pitcher is below with `muted` styling (`text-[var(--color-muted)]` on the name + stat values). Determined by `game.half`: `Top → home pitches`, `Bottom → away pitches`. Pre-game / Final default to home on top.

The "other team's pitcher" displayed in split mode is the last pitcher who pitched for that team (`boxscore.teams[side].pitchers[]` last entry — `bothPitchers.{away,home}PitcherId` in the watcher). **No bullpen projection.** When the team is fielding it equals the active mound pitcher; when sitting it's whoever last pitched. This mirrors how `game.pitcher` already behaves for the prob pipeline.

`PitcherInfo.pitchCount` may be `null` when the boxscore hasn't populated it yet (very early pre-game) — the row hides the P stat in that case rather than rendering "P 0" as if zero pitches were thrown.

---

## Park outline (CAD-blueprint glyph)

`<ParkOutline>` (`components/park-outline.tsx`) renders a 28px SVG silhouette of the home park — foul-line wedge + outfield outer wall, single 1.25px hairline stroke, no fill. It sits in the env-chip row of `<GameCard>` where the text label "Park" used to be; the outline literally is the label, with the numeric park run-factor rendered to its right.

Stroke transitions `var(--color-muted) → var(--color-accent)` over 240ms when `highlighted` flips, so the outline lights up **in lockstep** with the existing decision-moment ring + `flash-fresh` keyframe. One unified accent (green — `--color-accent` is now `#22c55e`) alert state across the whole card; no competing visual cues.

Pipeline:
1. **Source data:** `bdilday/GeomMLBStadiums/inst/extdata/mlb_stadia_paths.csv` — the polygon data Baseball Savant uses for spray charts. ~16k rows × 30 parks, columns `team,x,y,segment`.
2. **Build script:** `scripts/build-park-shapes.mjs` (run via `npm run build:park-shapes`) fetches the CSV, filters to `foul_lines` + `outfield_outer`, normalizes each park into a 100×100 viewBox with home plate at the bottom, and writes `lib/parks/shapes.json` keyed by MLB venueId (mapped through `lib/parks/team-to-venue.ts`).
3. **Runtime:** `<ParkOutline venueId={game.venue?.id} highlighted={game.isDecisionMoment} />` reads the JSON, renders the path, returns `null` if the venueId is unknown so layout doesn't shift.
4. **Pre-game cards:** `seedSnapshotStep` populates `venue.id` from the schedule so the outline appears in the Upcoming section before any watcher starts. Park run-factor renders as `—` until the watcher's first publish.

Refresh path: `npm run build:park-shapes` whenever a team relocates or a new park opens. Output is committed; deterministic re-runs produce byte-identical JSON.

---

## Bases diamond

`<BasesDiamond>` (`components/bases-diamond.tsx`) is the live base-occupancy glyph in the header right column of `<GameCard>`, sitting **below** the inning indicator + outs dots. Three squares rotated 45° in a diamond formation: 2B at top, 1B at right, 3B at left, home plate implied below the bottom edge (not drawn). Filled square = runner on base (`var(--color-accent)` fill + stroke); empty square = 1.25px hairline stroke against `var(--color-border)`, fill transparent. Both states share a 240ms `fill/stroke` transition so the diamond animates smoothly when a runner reaches or scores. Same hairline weight + accent palette as `<ParkOutline>` so the card has one unified CAD-blueprint visual language.

**Data source:** `GameState.bases` is a 3-bit bitmask — `bit0=1B, bit1=2B, bit2=3B` — populated by `readDisplayBases(feed, status)` in `services/run-watcher.ts` straight from `liveData.linescore.offense.{first,second,third}`. **NOT** the same as `readMarkovStartState`'s output: that function force-zeros bases when the half is over (so the next-half Markov compute doesn't see phantom stranded runners), but for display we want the actual current bases even when outs flicker to 3 mid-tick before the half flips. Two separate readers, two different invariants — don't unify them.

**Null semantics:** `bases === null` when `status !== "Live"` (Pre / Final / Delayed / Suspended) and `<BasesDiamond>` returns `null` in that case so layout collapses cleanly. Pre-game stubs from `seedSnapshotStep` set `bases: null`. Don't fall back to `0` (empty diamond) — the absence of the glyph IS the signal that the game isn't live, matching how the outs dots only render in the Live branch of `<InningState>`.

**SVG layout:** `viewBox="0 0 28 22"` with squares centered at `(14, 7)`, `(23, 13)`, `(5, 13)` and a half-diagonal of `4.6` (~6.5px sides at 45°). The viewBox has ~3px top-padding above the 2B square's rotated extent — earlier versions used `viewBox="0 0 28 18"` and clipped the top corner of 2B. Don't shrink the viewBox vertical extent without also moving the squares down. `overflow-visible` on the SVG is a belt-and-suspenders for sub-pixel rounding.

**Don't change without thinking:**
- `readDisplayBases` vs `readMarkovStartState` — they diverge intentionally at half-boundaries. Folding them would either show empty bases mid-tick at end-of-half (display bug) or pollute the next-half Markov compute (probability bug).
- `bases: null` for non-Live states — keeps the diamond from rendering a misleading "empty" state for finished/scheduled games.
- The viewBox top-padding (`y=7` for 2B, viewBox height 22) — reverting to a tighter viewBox clips the 2B square.
- Square fill class swaps `fill-[var(--color-accent)]` ↔ `fill-transparent` (NOT `fill-none` or removing the prop). Without `fill-transparent`, hovering or focus events on parent elements can surface the SVG default fill = black.

---

## History page — wide game card + linescore-as-picker

`/history/[pk]` is a single wide frozen `<GameCard>` (`components/game-card.tsx`, `wide` prop) whose `<LineScore>` cells *are* the inning picker. There is no separate selector strip. Composition lives in `<HistoricalGameView>` (`components/historical-game-view.tsx`); the per-tab plays panel renders below.

**Selection model.** `InningSelection` (defined in `components/historical-game-view-helpers.ts`) is a discriminated union: `{ kind: "half"; inning; half }` or `{ kind: "full"; inning }`. Default selection prefers the first inning where BOTH halves were captured (full-inning view); falls back to the first available half if nothing has both. State is `useState` in `<HistoricalGameView>` and forwarded into `<GameCard>` via `selection`, `inningAvailability`, `onSelectInning`, `onSelectHalf`. `<GameCard>` forwards them all into `<LineScore>` unchanged.

**Click contracts on the linescore.**
- Header `<th>` for inning N → `<button>` when `onSelectInning` is set. Click sets `{ kind: "full", inning: N }` if both halves are captured; falls back gracefully to whichever half exists if only one was captured (e.g. walkoff bottom-9 not played). Disabled when neither half is available.
- Away-row `<td>` for inning N → `<button>` setting `{ kind: "half", inning: N, half: "Top" }` (away bats in Top).
- Home-row `<td>` → `<button>` setting `{ kind: "half", inning: N, half: "Bottom" }`.
- Disabled state when the corresponding half wasn't captured. Highlight uses `bg-[var(--color-accent-soft)]` + `ring-1 ring-[var(--color-accent)]/40` on the cell; for full-inning, BOTH the away and home cells of the inning highlight (alongside the header number) so the entire inning column reads as selected.

**Live-mode `<LineScore>` is unchanged.** When `selection`/`onSelectInning`/`onSelectHalf` are not passed (the dashboard live `<GameCard>`), cells render as plain `<td>`/`<th>` and the live `currentInning`+`half` highlight runs as before. The detail page passes `currentInning={null}` + `half={null}` so the live highlight doesn't compete with the selection highlight.

**Wide `<GameCard>` layout.** When `wide`:
- Drops the `max-w-md` constraint (the page wraps it at `max-w-[1400px]`).
- Forces `viewMode = "split"` regardless of the user's setting — the page is wide enough that single-pane wastes horizontal space.
- Surfaces lineups + pitchers in `historical` mode (the narrow `historical` `<GameCard>` used by `<HistoricalCardLink>` on the dashboard list still hides them — wide is opt-in).
- Surfaces the captured `<ProbabilityPill>` in `historical` mode (narrow historical mode renders the pill empty so the dashboard list of past games doesn't get cluttered).

**Both historical views set `battingTeam = null`.** Half-inning (`buildFrozenState`) and full-inning (`buildFullInningFrozenState`) frozen states both null out `battingTeam` so `<GameCard>`'s split layout routes to the same paired-pitcher branch — the pitcher/lineup section renders identically across the two views, and clicking a `<LineScore>` cell only changes the score header and the captured probability, not the layout. Don't restore `battingTeam: "away" | "home"` on the half-inning helper; it would re-fork the layouts and add live-game-style highlighting on a frozen lineup.

**Full-inning view.** `buildFullInningFrozenState(game, top, bottom)` (in `historical-game-view-helpers.ts`) composes the two captured halves:
- `pNoRunFull = top.pNoRun * bottom.pNoRun` — independence assumption is fine here, the two halves are independent draws against different lineups + pitchers. `breakEvenAmericanFullInning` re-derives via `americanBreakEven` + `roundOdds` from `lib/prob/odds.ts`.
- Score header = `runsBefore(linescore, inning, "Top")` — the state at the *start* of Top, since this is "what was the prediction going into this whole inning."
- `inning = N`, `half = "Top"`, `outs = 0`, `bases = null` — canonical clean-state markers.
- `battingTeam = null` is the "no single batting team" signal that flips `<GameCard>` into a paired-pitcher layout: home pitcher above the away lineup column (he pitched to them in Top); away pitcher above the home lineup column (he pitched to them in Bottom). Don't fold this back into the regular split branch — the regular branch stacks both pitchers at the top, which is correct for live-game viewing but wrong for full-inning history where each pitcher belongs visually with the lineup he faced.
- `upcomingBatters = [...top.perBatter, ...bottom.perBatter]` so the `statsById` map in `<GameCard>` covers both teams' batters.

**Don't change without thinking:**
- The `(!historical || wide)` gate on the lineup section in `components/game-card.tsx` — narrowing it back to `!historical` hides lineups on the detail page; widening it to drop the historical guard entirely would surface lineups on the dashboard `<HistoricalCardLink>` cards (which is intentionally not what we want — the listing should stay compact).
- The `historical && !wide ? null : ...` gate on the footer `<ProbabilityPill>` — same reason. Wide historical wants the captured prediction; narrow historical (the listing card) wants it suppressed.
- `<LineScore>`'s `currentInning={historical ? null : game.inning}` / `half={historical ? null : game.half}` override at the call site in `<GameCard>` — passing the live values into the historical detail page would mix the live half-inning highlight with the selection highlight on the same cells.
- `defaultInningSelection` prefers full over half when both are captured. If you change this default to "first half-inning," the page's first paint flips to a half-inning view even when full is available, and the user has to click into the full view manually — wrong default for the page's primary use (looking at full-inning predictions).
- The `pa` field on `NrXiPerBatter` round-trips through Supabase JSON. The full-inning frozen state stitches `[...top.perBatter, ...bottom.perBatter]` so any test fixture for `perBatter` must include `pa`.

---

## History page — plays panel (per-inning hitter / pitcher rollups)

`<HistoricalPlaysPanel>` (`components/historical-plays-panel.tsx`) renders **below** the frozen-state `<GameCard>` on `/history/[pk]`. For the currently selected inning tab it shows three sections: a Batters table, a Pitchers table, and a play-by-play log. Composed in `<HistoricalGameView>` inside the same wrapping `space-y-6` as the card so the whole thing scrolls as one column.

**Data source:** `lib/db/plays.ts:getGamePlays(pk)` — one row per completed plate appearance, written once at the watcher's Final exit (see [ARCHITECTURE.md](ARCHITECTURE.md) → `lib/history/`). Pre-`0003_plays.sql` games have no rows; the panel renders a "no play-by-play stored" hint instead of an empty table.

**Per-tab slicing:** caller passes the same `InningSelection` the card uses. For `kind: "half"` the panel filters `plays.filter(p => p.inning === sel.inning && p.half === sel.half)` and renders one block. For `kind: "full"` it splits into two blocks (top + bottom of the same inning) so the rollups stay cleanly attributable — combining halves would conflate the two batting teams in the Batters table.

**Rollup attribution:**
- `rollupBatters(rows)` — one row per unique `batterId`. PA counts every completed PA; AB excludes BB / IBB / HBP / SF / SH / catcher's interference. R is approximated from `eventType === "home_run"` only — runner-scored attribution per row would need walking `runners[]` against the batter id, which we skip in v1 (pitcher R is the load-bearing display, sourced from `runs_on_play` directly).
- `rollupPitchers(rows)` — one row per unique `pitcherId`. `ipOuts` walks the rows in `at_bat_index` order, tracks the running outs total per `(inning, half)` (resets on key change), and attributes each `max(0, endOuts − prevOuts)` increment to the pitcher who threw the play. This handles mid-inning pitching changes correctly. R = sum of `runs_on_play` (counted at capture time from `runners[]` with `movement.end === "score"`).

**Don't change without thinking:**
- `selection.kind === "full"` keeps top/bottom in **separate** rendered blocks. Merging them under one Batters table would mix the two teams' lineups (top half = away batters, bottom half = home).
- `formatIp(outs)` returns `"X.Y"` strings (`7 → "2.1"`), not decimal IP — this is conventional baseball notation. Don't switch to `outs / 3` because it'd render `2.333`.
- The `{plays.length === 0}` short-circuit at the top of the panel renders a friendly hint for older games. Don't replace with `notFound()` — pre-archive games still have valid card / inning data, only the play log is missing.
- Reading `plays` from Supabase is part of the page's `Promise.all` next to `getGame` / `getInningPredictions`. Keep it parallel — serializing the three calls inflates TTFB on the history detail page for no benefit.
