# Probability model — v2.2 (Log5 + 24-state Markov, plus xstats / aging / workload / Stuff+)

The model that drives `P(nrXi)` and the break-even American odds shown on every card.

> **v2.2 added** (May 2026 model review — see `/Users/kevin/.claude/plans/review-our-current-probability-polished-rossum.md`):
> - **Marcel-style aging** on the prior-season blend (`lib/mlb/aging.ts`).
> - **Smooth pitch-/PA-count TTOP** replacing the step function (Brill 2023 / Carleton). Same overall magnitudes as v2.1, no discontinuity at order pass 3.
> - **Savant xHR denoiser** on hitter HR rates (`lib/env/expected-stats.ts`). Hitters only — pitcher xstats deliberately skipped per BP "Siren Song".
> - **Per-handedness park factors** — Savant scrape now fetches `batSide=L` and `batSide=R` in parallel; combined index is the fallback.
> - **Reliever 7-day pitch-count workload drag** on K rate (`lib/env/workload.ts`). Driveline PULSE / Carleton.
> - **FanGraphs Stuff+/Pitching+ pitcher-quality prior** — small K↑/HR↓ bias for high-Pitching+ pitchers (`lib/env/stuff.ts`).
> - **Per-batter GIDP rate** threaded into Markov in place of the hardcoded league-mean 0.10.
> - **Stratified isotonic calibration** keyed by `(inning_bucket, half)` — still ships identity until ≥1k samples per bin accumulate.
> - **Tightened framing clamp** for the ABS-challenge regime — `[0.97, 1.03]` with halved K/BB coefficients; `NRXI_FRAMING_CLAMP` env override.

## Definitions

- **Plate appearance (PA) outcome** — one of `{single, double, triple, hr, bb, hbp, k, ipOut}`. The eight outcomes are mutually exclusive and exhaustive; rates sum to 1. `ipOut` (in-play out) is the residual covering ground outs, fly outs, sac flies, double plays, etc.
- **nrXi** — No-Run-Scoring-Inning. We compute `P(nrXi) = 1 − P(≥1 run scores)`.
- **Break-even American odds** — the American odds at which a "no run" bet has zero expected value, given the model's `q = P(nrXi)`. Quoted lines better than break-even are positive-EV; worse are negative-EV.

## Two-stage pipeline

```
   batter splits           pitcher splits          league rates
   ─ Marcel-aged prior     ─ Marcel-aged prior     ─ LEAGUE_PA[hand]
   ─ Savant xHR denoiser   ─ 7-day workload drag
   ─ per-batter gidpRate   ─ Stuff+ K↑/HR↓ bias
        ▼                        ▼                       ▼
   ┌──────────────────────────────────────────┐
   │  Stage 1: per-PA outcome distribution    │
   │  (generalized multinomial Log5)          │
   │  → 8-vector summing to 1                 │
   └──────────────────────────────────────────┘
        ▼ park (per-handedness)   ▼ weather (per-component)
   ┌──────────────────────────────────────────┐
   │  applyEnv: scale each outcome rate, then │
   │  renormalize so total stays 1            │
   └──────────────────────────────────────────┘
        ▼ paInGameForPitcher (smooth, not stepped)
   ┌──────────────────────────────────────────┐
   │  applyTtop: linear K↓ / BB↑ / HR↑ slopes │
   │  per PA-in-game; no discontinuity        │
   └──────────────────────────────────────────┘
        ▼ live catcherId (Statcast framing, ABS-tightened)
   ┌──────────────────────────────────────────┐
   │  applyFraming: K up, BB down (or vice    │
   │  versa). Renormalize.                    │
   └──────────────────────────────────────────┘
        ▼ live fielderIds (Statcast OAA, sum of 7)
   ┌──────────────────────────────────────────┐
   │  applyDefense: reweight in-play block —  │
   │  better defense → more ipOut, fewer hits │
   └──────────────────────────────────────────┘
        ▼ live (outs, bases) + per-batter gidpRate array
   ┌──────────────────────────────────────────┐
   │  Stage 2: 24-state base-out Markov chain │
   │  iterated PA-by-PA through upcoming order│
   │  → P(≥1 run scores)                      │
   └──────────────────────────────────────────┘
        ▼ (inning_bucket, half) context
   ┌──────────────────────────────────────────┐
   │  calibrate(p, ctx): stratified isotonic  │
   │  per (inning_bucket × half); identity    │
   │  until per-bin samples accumulate        │
   └──────────────────────────────────────────┘
        ▼
     pNoHitEvent = 1 - pHit  →  break-even odds
```

## Stage 1 — per-PA outcome distribution (`lib/prob/log5.ts`)

### Generalized multinomial Log5 (Hong, *SABR Journal*)

For each outcome category `i`:

```
P(E_i | matchup) = (b_i × p_i / l_i) / Σ_j (b_j × p_j / l_j)
```

where `b_i` is the batter's rate, `p_i` is the pitcher's rate, `l_i` is the league rate (vs the pitcher's hand), all per-PA. The numerator is computed independently per outcome; the denominator renormalizes so the result sums to 1.

This is the canonical sabermetric matchup formula — it respects the asymmetry around league mean that a simple arithmetic average does not. Tango binary worked example: a `.400` OBP hitter vs a `.250` OBP-allowed pitcher in a `.333` league → `.308` (a naive average would say `.325`).

Implementation: `lib/prob/log5.ts:log5Matchup`.

### Profile inputs (`lib/mlb/splits.ts`)

`loadBatterPaProfile(playerId)` returns:

```ts
{
  paVs: { L: PaOutcomes, R: PaOutcomes },   // splits keyed by pitcher hand
  paCounts: { L: number, R: number },
  bats: HandCode,
  gidpRate: number,                          // per-eligible-ipOut P(GIDP); EB-shrunk; ∈ [0.03, 0.20]
}
```

`loadPitcherPaProfile(playerId)` returns the same `paVs` / `paCounts` shape plus `throws`. Each side of `paVs` is built by:

1. Pulling raw counts from the MLB Stats API splits payload **for both current and prior regular seasons in parallel** (each cached 12h, regular-season only — `season=YYYY` aggregates exclude postseason by default).
2. Converting each season's splits to per-PA rates: `single = (H − 2B − 3B − HR) / PA`, `bb = BB / PA`, etc. The `ipOut` rate is `1 − Σ(other rates)` so the multinomial sums to 1 by construction.
3. **Marcel-style aging projection** on the *prior*-season rates before any blending (`lib/mlb/aging.ts:applyAging`). One year of role-specific aging is applied multiplicatively — batter peak 27, pitcher peak 28; HR/triple/double slopes are negative past peak (and shallow-negative below it), K slope is positive past peak (rising K% with age) for batters and negative for pitchers (velo loss → fewer K), BB slopes mostly upward. Slopes are derived from FanGraphs aging-curve work (HR fades ~3-4%/yr past 32 for hitters; pitcher K rate slips ~1.5%/yr past peak). Each single-outcome multiplier is clamped to `[0.85, 1.15]` so an extreme age can't blow up the rate. Age is read from `currentAge` on the MLB people endpoint (or derived from `birthDate` when only that is exposed). Unknown age → identity (no projection).
4. **Role-specific Marcel-style recency blend** of current + aged-prior into a single baseline rate: `combined = (wCurrent × currentPa × currentRates + wPrior × priorPa × priorAgedRates) / (wCurrent × currentPa + wPrior × priorPa)`. Hitters use `wCurrent:wPrior = 3:2` (decay 0.67); pitchers use `2:1` (decay 0.5). The split mirrors Marcel's own (5/4/3 hitters vs 4/3/2 pitchers) — pitcher rates are noisier year-to-year, so the prior year carries less weight. Both decays sit inside the published 0.6-0.8 band (Marcel hitters ≈ 0.75; ZiPS uses 0.625-0.8). Either side can be missing — combine collapses to whichever exists. Constants live in `lib/mlb/splits.ts:BATTER_BLEND` / `PITCHER_BLEND`.
5. **Empirical-Bayes shrinkage** of the combined baseline to `LEAGUE_PA[handedness]` with **role-specific** prior strength: hitter `n0 = 200` PA, pitcher `n0 = 500` PA. Applied against the **actual** observed PA (`currentPa + priorPa`, *not* the weighted PA): `shrunken = (truePa × combined + n0 × league) / (truePa + n0)`. The hitter/pitcher split tracks Carleton-style stabilization rates: composite per-PA hitter rates land around `n0 ≈ 200-400`, but pitcher batted-ball-driven components (BABIP ≈ 2000 BIP, HR ≈ 1320 BF to stabilize) need a much stronger prior than hitter equivalents (820 BIP, 170 PA). Pitcher `n0 = 500` is a single-knob compromise across the per-PA outcome bundle — K%/BB% would prefer smaller, BABIP/HR much larger.
6. **Recent-form blend** (last 30 days, weight `0.10` if there is material recent data — `≥ 80 PA`): `(1 − w) × baseline_shrunk + w × recent_shrunk`. Same values for hitters and pitchers. The 10% / 80-PA gate is a deliberate in-game-model deviation from published projection systems (Marcel, ZiPS, Steamer, PECOTA all re-fit on full year-to-date and use **no L30 component at all**). Empirical work — *The Book* (Tango/Lichtman/Dolphin), Razzball L3-L5 replications, FiveThirtyEight hot-hand — pegs the L30 signal at ~5 wOBA points / 0.0-0.2% improvement over the baseline projection: small but non-zero.
7. **Hitter-only Savant xHR denoiser** (`lib/env/expected-stats.ts:hrRateMultiplier`). For batters, after the side rates are built, the season's `xhr / pa` and `hr / pa` are pulled from the Savant `expected_statistics` leaderboard, their ratio EB-shrunk against 1.0 with `n0 = 50 BBE` (FanGraphs barrel stabilization threshold), clamped to `[0.7, 1.3]`, and applied multiplicatively to BOTH `paVs.L.hr` and `paVs.R.hr`. Savant doesn't publish handedness-split expected stats — same multiplier on both sides. **Pitchers deliberately skip this step** per BP "Siren Song of Statcast Expected Metrics" — pitcher xstats are noise year-to-year.
8. **Pitcher-only Stuff+/Pitching+ bias** (`lib/env/stuff.ts:stuffFactors`). The FanGraphs Pitching+ composite is mapped to a small K↑ / HR↓ multiplier band: `1 + (Pitching+ − 100) × 0.0015` on K, `1 + (Pitching+ − 100) × (-0.002)` on HR, both clamped to `[0.95, 1.05]`. Joins to MLBAMID through FG's `xmlbamid` field when exposed — degrades to identity when the row is missing or the scrape fails.
9. **Pitcher-only 7-day workload drag** (`lib/env/workload.ts:workloadKFactor`). Total pitches thrown by the pitcher in the last 7 days are read from `byDateRange&group=pitching` (cached 6h). A K-rate multiplier ramps smoothly from 1.0 at 120 pitches to 0.97 at 200 pitches. Driveline PULSE / FanGraphs B2B research finds 7-day pitch count is the strongest cheap fatigue proxy — "pitched yesterday" alone is too narrow.

Steps 7-9 are applied AFTER shrinkage + recency blend so the denoiser/bias acts on the final calibrated baseline; each step renormalizes the multinomial.

`LEAGUE_PA` constants are 2024–2025 MLB averages by pitcher hand, sourced from FanGraphs splits leaderboards. They drift very slowly year-over-year; refresh annually or when calibration starts to drift.

### Switch-hitter rule

`effectiveBatterStance(batter.bats, pitcher.throws)` and `batterSideVs(batter, pitcher, rule)` resolve which split to read:

- **`actual` (default)** — switch hitters always face from the side opposite the pitcher's throwing hand (canonical platoon advantage). For a non-switch hitter, the rule degenerates to `batterSide = pitcher.throws`, `pitcherSide = batter.bats`.
- **`max` (legacy v1)** — pick the side with the highest non-out rate for the batter and the most permissive side for the pitcher. Reachable via `NRXI_SWITCH_HITTER_RULE=max`.

### Park factors (`lib/env/park.ts`)

`getParkComponentFactors(homeTeamName, season)` returns per-outcome multipliers `{hr, triple, double, single, k, bb}` keyed by batter handedness (L/R).

**Per-handedness scrape (v2.2):** the loader fetches three Savant tables in parallel — combined (`batSide=` empty), `batSide=L`, `batSide=R` — and populates `ParkComponentFactors.L` from the LHB-only scrape and `.R` from the RHB-only scrape, with the combined table as a fallback when either side's scrape is empty. This is mandatory for an accurate HR-rate adjustment: HR factors swing >20% by handedness in extreme parks (Yankees short porch in RF for LHB, Fenway monster LF for RHB; cf. FanGraphs spray-angle write-up).

When the Statcast scrape returns full per-component fields (`index_hr`, `index_2b`, etc.), those are used directly. When it returns only `index_runs`, components are derived:

| Component | Derivation | Rationale |
|---|---|---|
| `hr` | `runs^1.5` | Most park-sensitive — batted-ball physics |
| `triple` | `runs^1.0` | Field dimensions modestly sensitive |
| `double` | `runs^0.7` | Moderate |
| `single` | `runs^0.4` | Mostly batter-pitcher interaction |
| `k`, `bb` | `1.0` | Park-independent |

All factors clamped to `[0.5, 1.8]`; failures on either handedness scrape degrade to the combined index, and a full failure degrades to neutral (all 1.0).

### Weather factors (`lib/env/weather.ts`)

`weatherComponentFactors(WeatherInfo)` returns per-outcome multipliers. The HR delta is the active dimension; everything else is a damped fraction:

```
hrDelta = clamp((tempF - 70) × 0.011, ±0.18)            ← Hampson 2013
        + (windOut ? +clamp(mph × 0.005, 0, 0.10) : 0)
        − (windIn  ? +clamp(mph × 0.005, 0, 0.10) : 0)
        + clamp((humidityPct - 50) × 0.001, ±0.04)      ← humid air = less dense
        + clamp((30.0 - pressureInHg) × 0.005, ±0.03)   ← lower pressure = less dense
        + (precip > 60% ? -0.05 : 0)
        clamped to ±0.25 total

hr     = 1 + hrDelta
triple = 1 + 0.30 × hrDelta
double = 1 + 0.30 × hrDelta
single = 1 + 0.10 × hrDelta
k, bb  = 1 (literature reports no significant weather signal)
```

Domes return `NEUTRAL_WEATHER`. Coefficient sources cited inline in `weather.ts`.

### `applyEnv`

Multiplies each outcome rate of the matchup multinomial by the corresponding park × weather factor, then **renormalizes**. So a 1.10× HR boost steals mass proportionally from the other outcomes (mostly `ipOut`) rather than inflating the absolute outcome sum. This is the principled way to apply multipliers on a multinomial.

The batter handedness chooses which side of the park-component table to read (parks favor LHB/RHB asymmetrically — Yankees' short porch in RF, Fenway's Green Monster, etc.).

## Stage 1.5 — Times-Through-the-Order Penalty (`lib/prob/ttop.ts`)

Tango (*The Book*, Ch 9) and Carleton (*Baseball Prospectus*) document a progressive degradation each time a starting pitcher cycles through the lineup — more contact, harder contact, slightly more walks, slightly fewer strikeouts. **Brill, Deshpande & Wyner** (*JQAS* 2023, "Bayesian analysis of the times through the order penalty") controlled for batter/pitcher quality + home-field and showed the apparent *discontinuous* jump between the 2nd and 3rd pass largely disappears — what remains is a smooth within-game decline that Carleton's later pitch-count work attributes to fatigue.

v2.2 keeps the consensus magnitudes from Lichtman/Tango/Carleton but drops the step function. Each rate is a linear function of `paInGameForPitcher`:

```
k_factor  = max(0.85, 1 - 0.0040 × pa)   // K shrinks
bb_factor = min(1.15, 1 + 0.0030 × pa)   // BB grows
hr_factor = min(1.45, 1 + 0.0110 × pa)   // HR grows
```

Slopes calibrated to land on Lichtman's bucket midpoints (PA 13 / 22 / 31) — at PA 22 (mid-3rd-pass) the factors are 0.912 / 1.066 / 1.242, matching the old bucketed values 0.911 / 1.060 / 1.233. Floors and ceilings protect against open-bullpen edge cases (a starter who somehow reaches the 5th time through doesn't continue to degrade linearly).

`applyTtop(pa, paInGameForPitcher)` multiplies `k`, `bb`, `hr` by the smooth factors and renormalizes. For relievers, `paInGameForPitcher` resets to 0 when they enter (handled in the watcher by reading `boxscore.players.ID{pitcherId}.stats.pitching.battersFaced`).

`ttoIndex(pa)` (1 / 2 / 3 / 4) is retained for display + log lines but is no longer load-bearing on the probability path.

This is negligible for first-inning probabilities but materially shifts late-game numbers when the starter is still in.

## Stage 1.6 — Catcher framing (`lib/env/framing.ts`, `lib/prob/framing.ts`)

Catcher framing is the skill of receiving borderline pitches in a way that makes umpires more likely to call them strikes. Top framers add ~+15 to +25 called strikes per season vs an average receiver; the worst lose ~−15 to −20.

**Source**: per-catcher framing leaderboard at `https://baseballsavant.mlb.com/leaderboard/catcher_framing` (cached 24h, scraped from the embedded JSON).

**Empirical-Bayes shrinkage** to league mean (≈ 0 strikes added) with prior strength `n0 = 2000` called pitches: `shrunk_strikes_per_pitch = strikesAdded / (calledPitches + n0)`. A catcher with 9000 called pitches sees ~80% of their observed rate; a backup with 200 sees ~10%.

**Multiplier construction** (v2.2 ABS-tightened): `k = 1 + strikesPerPitch × 5.0`, `bb = 1 − strikesPerPitch × 4.0`, both clamped to `[1 − halfWidth, 1 + halfWidth]` where `halfWidth = 0.03` by default. The coefficients are halved and the clamp tightened from the pre-ABS v2.1 spec (`coefficients 10 / -8`, clamp `[0.95, 1.05]`) because 2026 walk rate is up to 9.6% YTD vs. 8.4% in 2025 and the umpire-called zone has visibly shrunk (Statcast vs. ABS via `baseballsavant.mlb.com/abs`). Framing variance is collapsing toward the Hawk-Eye truth — the wider pre-ABS clamp would now overstate the catcher effect.

**Apply step** (`applyFraming` in `lib/prob/framing.ts`): multiplies the K and BB cells of the multinomial, then renormalizes. Mass that flows out of K and BB redistributes proportionally across the other six cells (mostly into `ipOut`). 1B/2B/3B/HR/HBP unchanged at the multiplier level.

**Robo-ump kill switch**: `NRXI_DISABLE_FRAMING=1` returns identity factors. Wire it in once MLB's ABS challenge system goes full-season — framing's value collapses overnight. **`NRXI_FRAMING_CLAMP`** env override (e.g. `0.02`) replaces the default 0.03 half-width without a code change — useful mid-season if the published ABS impact grows.

## Stage 1.7 — Fielder defense / OAA (`lib/env/defense.ts`, `lib/prob/defense.ts`)

Outs Above Average (OAA) measures how many outs a fielder makes vs an average fielder facing the same plays. Top team-aggregate: ~+50; bottom: ~−40. Translates to roughly ±2pp BABIP — small per PA, compounding across the inning's worth of contact.

**Source**: per-player OAA leaderboard at `https://baseballsavant.mlb.com/leaderboard/outs_above_average` (cached 24h).

**Live alignment**: the watcher reads the seven non-battery fielders from `liveData.linescore.defense.{first, second, third, shortstop, left, center, right}` ids on every tick and adds a `defenseAlignmentKey` to the recompute trigger. Defensive subs late in the game (defensive replacements, position swaps) are picked up automatically — no need to reason about lineups.

**Empirical-Bayes shrinkage** toward the position mean (≈ 0 OAA) with prior strength `n0 = 200` opportunities: `shrunkOaa = (n × oaa) / (n + n0)`. Stabilizes backups with low samples without dropping signal from regular starters.

**Factor construction**: `factor = 1 − Σ shrunkOaa / 1200`, clamped to `[0.90, 1.10]`. The scale is calibrated so a `±60` team-aggregate OAA maps to a `±5%` swing on the in-play hit rate.

**Apply step** (`applyDefense` in `lib/prob/defense.ts`): reweights only the in-play block.
- `inPlayHits = 1B + 2B + 3B`
- `newHits = inPlayHits × factor`
- `newIpOut = ipOut + (inPlayHits − newHits)` — mass moves between hits and outs
- 1B/2B/3B reapportioned in proportion to their original ratios (doubles don't disappear when the factor shrinks)
- K, BB, HBP, HR untouched (battery outcomes; defense doesn't affect them)

**Catcher excluded from OAA**: catcher defense is captured by framing (acts on K/BB) and pop time / blocking (Tier 3, not modeled). Including catcher OAA would risk double-counting with framing.

## Stage 2 — 24-state base-out Markov chain (`lib/prob/markov.ts`)

### State space

`(outs ∈ {0,1,2}) × (bases ∈ {0..7})` = 24 active states + 1 absorbing 3-out state.

Bases use a 3-bit encoding:
- bit 0 (value 1) = runner on 1st
- bit 1 (value 2) = runner on 2nd
- bit 2 (value 4) = runner on 3rd

So `0` = empty, `1` = 1st only, `4` = 3rd only, `7` = loaded, etc.

### Transition rules (Tango defaults)

For each PA, the outcome (sampled from the Stage-1 multinomial) determines a deterministic-or-branching transition. Advance probabilities are tunable constants at the top of `markov.ts`.

| Outcome | Transition |
|---|---|
| `K` | outs+1, bases unchanged, 0 runs |
| `BB` / `HBP` | Forced advance only. Lead runner scores **only** if loaded. New 1st always set; chain force from 1st→2nd→3rd. |
| `1B` | Batter to 1st; runner on 3rd scores; runner on 2nd scores w/ prob `[0.30, 0.45, 0.55]` by 0/1/2 outs (else stops at 3rd); runner on 1st advances to 2nd. |
| `2B` | Batter to 2nd; runners on 2nd and 3rd score; runner on 1st scores w/ prob `[0.40, 0.60, 0.70]` (else stops at 3rd). |
| `3B` | Batter to 3rd; all other runners score. |
| `HR` | All runners + batter score; bases empty; runs = `1 + popcount(bases)`. |
| `ipOut` | At 2 outs: outs+1, no advancement. At <2 outs with 1st occupied: **per-batter `gidpRate`** (default 0.10, clamped `[0.03, 0.20]`) GIDP (outs+2, clear 1st). At <2 outs with 3rd occupied: 20% sac fly (outs+1, clear 3rd, 1 run). Else: outs+1, bases unchanged. |

Each transition emits `{next: GameState, runs: number, weight: number}`. Weights for branching outcomes (1B/2B/ipOut) sum to 1 within that outcome.

**Per-batter GIDP rate (v2.2).** `pAtLeastOneRun(start, lineup, { gidpRates })` accepts a parallel `gidpRates: number[]` array — entry `i` is the per-batter rate for `lineup[i]`. When the option / entry is missing, the chain falls back to the league-mean 0.10. Each batter's `gidpRate` is computed in `loadBatterPaProfile` by EB-shrinking observed `GIDP/PA` against the league rate, scaling by the league `P(GIDP | eligible) / (GIDP / PA)` bridge (≈ 6.67), and clamping to `[0.03, 0.20]`. High-GB hitters drift toward the ceiling; high-FB / fast hitters toward the floor. League rates from Retrosheet aggregates.

### Forward iteration

`pAtLeastOneRun(start, lineup)` runs a forward chain:

```
alive: Map<stateKey, mass>           // all mass that has not yet absorbed
pHasRun: scalar                       // absorbing state for "≥1 run scored"

for each upcoming batter:
  for each (state, mass) in alive:
    for each outcome in 8-vector:
      for each transition emitted:
        m = mass × outcomeProb × transitionWeight
        if transition.runs > 0:        pHasRun += m       // absorbed
        else if next.outs >= 3:        // absorbed silently (no runs, inning ended)
        else:                           alive[next] += m

return pHasRun
```

The chain is **non-stationary**: each PA uses the *current* batter's Log5+env+ttop multinomial as its kernel. The `alive` map collapses to empty as the inning absorbs into either "scored" or "3 outs without scoring" — typically within 5–8 PAs. Iteration cap is the lineup length (we always pass at least 9).

### Live state from the MLB feed

The watcher reads:

```ts
function readMarkovStartState(feed): { outs, bases }
function readPaInGameForPitcher(feed, pitcherId): number
```

`outs` from `linescore.outs`, `bases` bitmap from `linescore.offense.{first,second,third}` ids, and `paInGameForPitcher` from the boxscore's `stats.pitching.battersFaced` for the current pitcher (resets when a reliever enters).

This means the model uses the actual mid-inning state — runner on 3rd with 0 outs gets the ~85% run probability it deserves, not the ~27% league-average start-of-inning value.

## Calibration shim (`lib/prob/calibration.ts`)

A monotone post-hoc transform applied to the model's final probability. **Ships as identity** (no-op) — there is no production data yet. Once we have ≥ 1k `(predicted, actual)` pairs per stratum from live games, fit isotonic regression on the residuals and load the resulting JSON map via `loadCalibrator(map)`.

**Stratified by `(inning_bucket, half)` (v2.2).** The run-distribution per inning differs systematically — inning 1 is lineup-position-dependent (top of order), 7-9 is reliever-dominant + leverage-heavy, 10+ has the Manfred runner on 2nd. A single global isotonic fit under-calibrates the tails. Buckets:

| Bucket | Innings |
|---|---|
| `"1"` | Inning 1 only |
| `"2-6"` | Innings 2 through 6 (starter-dominant, standard RE) |
| `"7-9"` | Innings 7 through 9 (reliever-dominant) |
| `"10+"` | Extras (Manfred runner) |

Lookup order at `calibrate(p, { inning, half })`:
1. Exact `"${bucket}-${half}"` key (e.g., `"7-9-Top"`).
2. Bucket-only key (e.g., `"2-6"`) — half-agnostic fallback.
3. Global `"global"` key — bucket-agnostic fallback.
4. Identity (no calibrator loaded for this stratum).

`loadCalibrator(table | map | null)` accepts a single `CalibratorTable` (treated as the global default), a `CalibrationMap` keyed by bucket / half, or `null` to clear. The structural plumbing ships now so the post-fit hot-swap is a one-line config change.

Each per-bucket table is piecewise-linear interpolation between sorted `{pred, actual}` points (binary search; O(log n)). Monotone and idempotent — never inverts the model's ordering, and applying twice equals applying once.

References: Niculescu-Mizil & Caruana, *Predicting Good Probabilities with Supervised Learning* (ICML 2005); Kull, Filho, Flach (2017) for beta calibration as a small-sample alternative we may swap in for buckets that don't yet have 1k samples.

The watcher threads `inning` + `half` into `computeNrXiStep` (both for the live recompute and the opposite-half pre-compute used for full-inning composition) — see `services/run-watcher.ts:540-595`.

## American odds break-even — `lib/prob/odds.ts`

Given `q = P(nrXi)` (probability the bet wins):

```
americanBreakEven(q) =
   q ≥ 0.5  →  -100 · q / (1 - q)         // negative odds
   q < 0.5  →  +100 · (1 - q) / q         // positive odds
```

Round-trips through `impliedProb(american)`. A quoted line `A` is **positive-EV** iff `impliedProb(A) < q`. Display value uses `roundOdds(...)` rounded to nearest 5; the raw unrounded value is used for any actual EV comparison.

## Derived per-PA stats (`lib/prob/expected-stats.ts`)

Two scoreboard-friendly rate stats are derived from each batter's post-pipeline `PaOutcomes` and surfaced in the UI alongside the watcher output. They are pure functions of the multinomial — no extra computation cost — and both are exact under the model.

### xOBP — `xObpFromPa(pa)`

```
xOBP = 1 − k − ipOut
     = single + double + triple + hr + bb + hbp
```

The probability that this PA reaches base. Identical in value to the legacy `pReach` field on `NrXiPerBatter` (preserved by name for UI back-compat); the two are interchangeable.

### xSLG — `xSlgFromPa(pa)`

```
xSLG = (1·single + 2·double + 3·triple + 4·hr) / (1 − bb − hbp)
```

Expected SLG for this PA: total bases per AB. The `(1 − bb − hbp)` denominator strips walks and HBPs to match conventional SLG (bases per AB, not bases per PA). Range is `[0, 4]` — at the limit (every PA an HR) xSLG = 4.0. A small `1e-9` floor on the denominator guards against pathological inputs; under the model `bb + hbp` never approach 1.

Both stats are computed by `computeNrXiStep` and threaded through `NrXiPerBatter → PerBatter → GameState`, then displayed on each batter row in the dashboard lineup column.

## End-to-end (`services/steps/compute-nrXi.ts`)

```ts
for each upcoming batter b at index i:
  matchup    = log5Matchup(b.paVs[batterSide], pitcher.paVs[pitcherSide], LEAGUE_PA[pitcher.throws])
  enved      = applyEnv(matchup, park, weather, batterStance)
  ttoAdj     = applyTtop(enved, paInGameForPitcher + i)
  framed     = applyFraming(ttoAdj, framingFactors(catcherId, framingTable))
  pa_i       = applyDefense(framed, defenseFactor(fielderIds, oaaTable))
  pReach_i   = 1 - pa_i.k - pa_i.ipOut             // == xOBP
  xSlg_i     = xSlgFromPa(pa_i)
  gidpRate_i = b.gidpRate                          // per-batter, falls back to 0.10

pHit  = calibrate(
          pAtLeastOneRun(startState, [pa_1, ..., pa_n], { gidpRates: [gidpRate_1, ..., gidpRate_n] }),
          { inning, half },                                 // stratified isotonic
        )
pNo   = 1 - pHit
odds  = roundOdds(americanBreakEven(pNo))
```

The per-batter pre-stream adjustments (aging, xHR denoiser, Stuff+, workload) are NOT in this loop — they're baked into `b.paVs` and `pitcher.paVs` at load time inside `loadBatterPaProfile` / `loadPitcherPaProfile`. See **Profile inputs** above for the full sequence.

Result shape (`NrXiResult`):

```ts
{
  pHitEvent: number,            // P(≥1 run) — name kept for UI back-compat
  pNoHitEvent: number,          // P(nrXi)
  breakEvenAmerican: number,
  startState: { outs, bases },
  perBatter: Array<{
    id, name, bats,
    pReach: number,             // OBP-equivalent for UI: 1 - k - ipOut (== xOBP)
    xSlg: number,               // expected SLG: bases / (1 - bb - hbp)
    pa: PaOutcomes,             // full multinomial after Log5+env+ttop+framing+defense
  }>,
}
```

The watcher publishes this verbatim into `GameState`, which the SSE stream pushes to clients. The `pa` field rides along untyped on the client (it's not declared on `PerBatter`) — only `pReach` and `xSlg` are part of the typed client contract.

## Verification

- **Unit tests** in `lib/prob/{log5,markov,ttop,expected-stats}.test.ts` and `lib/env/{park,weather}.test.ts`.
- **Tango league-mean run-frequency anchor**: 9 league-average batters from `(0 outs, empty)` → `P(≥1 run) ∈ [0.22, 0.32]` (Tango's published value 2010–2015 is 0.268; Albert 2022 confirms 0.266).
- **Monte Carlo cross-check**: 50k inning simulations using the same per-PA distribution agree with the closed-form chain to within 1pp.
- **Renormalization invariants**: Log5, applyEnv, applyTtop, applyFraming, applyDefense all preserve sum-to-1 across every outcome shape.
- **v2.1 pipeline neutrality**: applying `applyFraming({k:1, bb:1})` and `applyDefense(_, 1)` to the league-mean multinomial leaves the Tango anchor unchanged. Tested in `markov.test.ts`.
- **Switch-hitter routing**: LHB/RHB/Switch all route through the correct platoon splits (tested in `log5.test.ts`).
- **Per-transition rules**: K, BB, HR, Triple, IPout transitions tested individually for correct base-state and run output across the 8 base configurations.

## Calibration caveats (open work)

Resolved in v2.2 (see header note for the full list):
- ~~**Park-factor scrape returns combined indices** (not per-handedness).~~ `getParkComponentFactors` now fetches `batSide=L` and `batSide=R` in parallel; combined index is the fallback.
- ~~**GIDP probability within `ipOut` is a league-mean approximation.**~~ Per-batter rate via `BatterPaProfile.gidpRate`, threaded through `pAtLeastOneRun({ gidpRates })`.
- ~~**Calibration shim is identity.**~~ Still identity at runtime, but now stratified by `(inning_bucket, half)` and ready for a per-stratum hot-swap once samples accumulate.

Open:
- **League-rate constants** are approximate. Refresh annually from FanGraphs vs LHP / vs RHP leaderboards.
- **Advance probabilities** on singles/doubles are Tango defaults — not team-specific. Future work: pull team baserunning rate (BsR) and scale.
- **SF probability** within `ipOut` is still league-mean. Per-batter FB% would refine.
- **Bullpen modeling absent.** When a reliever enters, the watcher recomputes with the new pitcher's profile and resets `paInGameForPitcher` (and Stuff+ / workload reload via the new profile), but the model does not anticipate the swap.
- **Date-range splits** (last-30) depend on `byDateRangeSplits` honoring `sitCodes`. If the API doesn't, the loader silently falls back to season-only. Verify in production logs.
- **Stuff+ scrape join is fragile.** FanGraphs only exposes `xmlbamid` on some leaderboard variants; when missing, the row can't be joined to MLB Stats API ids and the factor degrades to identity. Look at `lib/env/stuff.ts` log lines if Stuff+ is silently identity for everyone.
- **xstats and Stuff+ scrapes are best-effort.** Both degrade to identity on network failure. The model never breaks; it just loses the denoiser/bias for that cache window.
- **No backtest yet for v2.2.** Tango league-mean anchor (`P(≥1 run) ∈ [0.22, 0.32]`) still passes with 9 league-mean batters and default args — but the per-stratum calibration won't be fit until Supabase has enough samples per (inning_bucket, half).

## Legacy v1 model (deprecated)

The earlier `pReach` (single-blend OBP) + `pAtLeastTwoReach` (2-state DP) + flat `weatherRunFactor` model is retained in the codebase for back-compat (`lib/prob/reach-prob.ts`, `lib/prob/inning-dp.ts`) but no longer used by the watcher. Cleanup pass after v2 is the default for two weeks with no rollback. The v1 weaknesses that motivated the rewrite are documented in `/Users/kevin/.claude/plans/how-is-run-probability-nifty-pony.md`.
