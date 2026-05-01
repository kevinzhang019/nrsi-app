# Probability model — v2 (Log5 + 24-state Markov)

The model that drives `P(NRSI)` and the break-even American odds shown on every card.

## Definitions

- **Plate appearance (PA) outcome** — one of `{single, double, triple, hr, bb, hbp, k, ipOut}`. The eight outcomes are mutually exclusive and exhaustive; rates sum to 1. `ipOut` (in-play out) is the residual covering ground outs, fly outs, sac flies, double plays, etc.
- **NRSI** — No-Run-Scoring-Inning. We compute `P(NRSI) = 1 − P(≥1 run scores)`.
- **Break-even American odds** — the American odds at which a "no run" bet has zero expected value, given the model's `q = P(NRSI)`. Quoted lines better than break-even are positive-EV; worse are negative-EV.

## Two-stage pipeline

```
   batter splits   pitcher splits   league rates
        ▼               ▼                ▼
   ┌──────────────────────────────────────────┐
   │  Stage 1: per-PA outcome distribution    │
   │  (generalized multinomial Log5)          │
   │  → 8-vector summing to 1                 │
   └──────────────────────────────────────────┘
        ▼ park (per-component)   ▼ weather (per-component)
   ┌──────────────────────────────────────────┐
   │  applyEnv: scale each outcome rate, then │
   │  renormalize so total stays 1            │
   └──────────────────────────────────────────┘
        ▼ paInGameForPitcher
   ┌──────────────────────────────────────────┐
   │  applyTtop: weaken K, strengthen BB/HR   │
   │  per times-through-the-order bucket      │
   └──────────────────────────────────────────┘
        ▼ live (outs, bases) from MLB feed
   ┌──────────────────────────────────────────┐
   │  Stage 2: 24-state base-out Markov chain │
   │  iterated PA-by-PA through upcoming order│
   │  → P(≥1 run scores)                      │
   └──────────────────────────────────────────┘
        ▼
   ┌──────────────────────────────────────────┐
   │  calibrate(): identity in v1, isotonic   │
   │  once we have production (pred,actual)   │
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

`loadBatterPaProfile(playerId)` and `loadPitcherPaProfile(playerId)` return:

```ts
{
  paVs: { L: PaOutcomes, R: PaOutcomes },   // hitter splits keyed by pitcher hand;
                                             // pitcher splits keyed by batter hand
  paCounts: { L: number, R: number },
  bats / throws: HandCode,
}
```

Each side is built by:
1. Pulling raw counts from the MLB Stats API splits payload (cached 12h).
2. Converting to per-PA rates: `single = (H − 2B − 3B − HR) / PA`, `bb = BB / PA`, etc. The `ipOut` rate is `1 − Σ(other rates)` so the multinomial sums to 1 by construction.
3. **Empirical-Bayes shrinkage** to `LEAGUE_PA[handedness]` with prior strength `n0 = 200` PA: `shrunken = (n × observed + n0 × league) / (n + n0)`. Stabilizes early-season and small-sample players.
4. **Recent-form blend** (last 30 days, weight 0.30 if there is material recent data): `(1 − w) × season_shrunk + w × recent_shrunk`. Falls back gracefully to season-only if the date-range fetch is empty.

`LEAGUE_PA` constants are 2024–2025 MLB averages by pitcher hand, sourced from FanGraphs splits leaderboards. They drift very slowly year-over-year; refresh annually or when calibration starts to drift.

### Switch-hitter rule

`effectiveBatterStance(batter.bats, pitcher.throws)` and `batterSideVs(batter, pitcher, rule)` resolve which split to read:

- **`actual` (default)** — switch hitters always face from the side opposite the pitcher's throwing hand (canonical platoon advantage). For a non-switch hitter, the rule degenerates to `batterSide = pitcher.throws`, `pitcherSide = batter.bats`.
- **`max` (legacy v1)** — pick the side with the highest non-out rate for the batter and the most permissive side for the pitcher. Reachable via `NRSI_SWITCH_HITTER_RULE=max`.

### Park factors (`lib/env/park.ts`)

`getParkComponentFactors(homeTeamName, season)` returns per-outcome multipliers `{hr, triple, double, single, k, bb}` keyed by batter handedness (L/R).

When the Statcast scrape returns full per-component fields (`index_hr`, `index_2b`, etc.), those are used directly. When it returns only `index_runs`, components are derived:

| Component | Derivation | Rationale |
|---|---|---|
| `hr` | `runs^1.5` | Most park-sensitive — batted-ball physics |
| `triple` | `runs^1.0` | Field dimensions modestly sensitive |
| `double` | `runs^0.7` | Moderate |
| `single` | `runs^0.4` | Mostly batter-pitcher interaction |
| `k`, `bb` | `1.0` | Park-independent |

All factors clamped to `[0.5, 1.8]`; failures degrade to neutral (all 1.0).

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

Tango (*The Book*, Ch 9) and Carleton (*Baseball Prospectus*) document a progressive degradation each time a starting pitcher cycles through the lineup — more contact, harder contact, slightly more walks, slightly fewer strikeouts. Approximate published deltas vs the 1st time through:

| TTO bucket | PA range | K factor | BB factor | HR factor |
|---|---|---|---|---|
| 1st | 1–9 | 1.000 | 1.000 | 1.000 |
| 2nd | 10–18 | 0.956 | 1.036 | 1.133 |
| 3rd | 19–27 | 0.911 | 1.060 | 1.233 |
| 4th+ | 28+ | 0.889 | 1.096 | 1.333 |

`applyTtop(pa, paInGameForPitcher)` multiplies `k`, `bb`, `hr` by the bucket's factor and renormalizes. For relievers, `paInGameForPitcher` resets to 0 when they enter (handled in the watcher by reading `boxscore.players.ID{pitcherId}.stats.pitching.battersFaced`).

This is negligible for first-inning probabilities but materially shifts late-game numbers when the starter is still in.

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
| `ipOut` | At 2 outs: outs+1, no advancement. At <2 outs with 1st occupied: 10% GIDP (outs+2, clear 1st). At <2 outs with 3rd occupied: 20% sac fly (outs+1, clear 3rd, 1 run). Else: outs+1, bases unchanged. |

Each transition emits `{next: GameState, runs: number, weight: number}`. Weights for branching outcomes (1B/2B/ipOut) sum to 1 within that outcome.

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

A monotone post-hoc transform applied to the model's final probability. **V1 ships as identity** (no-op) — there is no production data yet. Once we have ≥ 1k `(predicted, actual)` pairs from live games, fit isotonic regression on the residuals and load the resulting JSON table via `loadCalibrator(table)`.

The shim does piecewise-linear interpolation between sorted `{pred, actual}` points (binary search; O(log n)). It is monotone and idempotent — never inverts the model's ordering, and applying it twice equals applying it once.

Reference: Niculescu-Mizil & Caruana, *Predicting Good Probabilities with Supervised Learning* (ICML 2005). Isotonic > Platt for tree-shaped / simulator-style errors.

## American odds break-even — `lib/prob/odds.ts`

Given `q = P(NRSI)` (probability the bet wins):

```
americanBreakEven(q) =
   q ≥ 0.5  →  -100 · q / (1 - q)         // negative odds
   q < 0.5  →  +100 · (1 - q) / q         // positive odds
```

Round-trips through `impliedProb(american)`. A quoted line `A` is **positive-EV** iff `impliedProb(A) < q`. Display value uses `roundOdds(...)` rounded to nearest 5; the raw unrounded value is used for any actual EV comparison.

## End-to-end (`workflows/steps/compute-nrsi.ts`)

```ts
for each upcoming batter b at index i:
  matchup = log5Matchup(b.paVs[batterSide], pitcher.paVs[pitcherSide], LEAGUE_PA[pitcher.throws])
  enved   = applyEnv(matchup, park, weather, batterStance)
  pa_i    = applyTtop(enved, paInGameForPitcher + i)

pHit  = calibrate(pAtLeastOneRun(startState, [pa_1, ..., pa_n]))
pNo   = 1 - pHit
odds  = roundOdds(americanBreakEven(pNo))
```

Result shape (`NrsiResult`):

```ts
{
  pHitEvent: number,            // P(≥1 run) — name kept for UI back-compat
  pNoHitEvent: number,          // P(NRSI)
  breakEvenAmerican: number,
  startState: { outs, bases },
  perBatter: Array<{
    id, name, bats,
    pReach: number,             // OBP-equivalent for UI: 1 - k - ipOut
    pa: PaOutcomes,             // full multinomial after Log5+env+ttop
  }>,
}
```

The watcher publishes this verbatim into `GameState`, which the SSE stream pushes to clients.

## Verification

- **Unit tests** in `lib/prob/{log5,markov,ttop}.test.ts` and `lib/env/{park,weather}.test.ts`.
- **Tango league-mean run-frequency anchor**: 9 league-average batters from `(0 outs, empty)` → `P(≥1 run) ∈ [0.22, 0.32]` (Tango's published value 2010–2015 is 0.268; Albert 2022 confirms 0.266).
- **Monte Carlo cross-check**: 50k inning simulations using the same per-PA distribution agree with the closed-form chain to within 1pp.
- **Renormalization invariants**: Log5, applyEnv, applyTtop all preserve sum-to-1 across every outcome shape.
- **Switch-hitter routing**: LHB/RHB/Switch all route through the correct platoon splits (tested in `log5.test.ts`).
- **Per-transition rules**: K, BB, HR, Triple, IPout transitions tested individually for correct base-state and run output across the 8 base configurations.

## Calibration caveats (open work)

- **League-rate constants** are approximate. Refresh annually from FanGraphs vs LHP / vs RHP leaderboards.
- **Advance probabilities** are Tango defaults — not team-specific. Future work: pull team baserunning rate (BsR) and scale.
- **GIDP / SF probabilities** within `ipOut` are league-mean approximations. Could be situational.
- **Bullpen modeling absent.** When a reliever enters, the watcher recomputes with the new pitcher's profile and resets `paInGameForPitcher`, but the model does not anticipate the swap.
- **Park-factor scrape returns combined indices** (not per-handedness) for now. The L/R split in `ParkComponentFactors` is a placeholder — same factor applied to both sides until the per-handedness scrape lands.
- **Date-range splits** (last-30) depend on `byDateRangeSplits` honoring `sitCodes`. If the API doesn't, the loader silently falls back to season-only. Verify in production logs.
- **Calibration shim is identity** — fit it from production `(predicted, actual)` pairs once ~1k inning outcomes have accumulated.

## Legacy v1 model (deprecated)

The earlier `pReach` (single-blend OBP) + `pAtLeastTwoReach` (2-state DP) + flat `weatherRunFactor` model is retained in the codebase for back-compat (`lib/prob/reach-prob.ts`, `lib/prob/inning-dp.ts`) but no longer used by the watcher. Cleanup pass after v2 is the default for two weeks with no rollback. The v1 weaknesses that motivated the rewrite are documented in `/Users/kevin/.claude/plans/how-is-run-probability-nifty-pony.md`.
