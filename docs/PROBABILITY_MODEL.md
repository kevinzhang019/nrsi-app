# Probability model

The model that drives `P(NRSI)` and the break-even American odds shown on every card.

## Definitions

- **Reach base** — a batter ends his plate appearance on base (hit, walk, HBP, error). Operationalized as the batter's on-base percentage (OBP).
- **Hit event** — at least 2 batters reach base in the half-inning being modeled. *User-specified definition.* (A "no run" bet typically wins if no run scores; here we proxy that with "fewer than 2 reach.")
- **NRSI** — No-Run-Scoring-Inning. We compute `P(NRSI) = 1 − P(hit event)`.
- **Break-even American odds** — the American odds at which a "no run" bet has zero expected value, given the model's `q = P(NRSI)`. Quoted lines better than break-even are positive-EV; worse are negative-EV.

## Per-batter reach probability — `lib/prob/reach-prob.ts`

```
pitcherPseudoObp(whip)      = clamp(whip / 3.5, 0.18, 0.55)

pReach(batter, pitcher, env) =
   batterObp:    if batter.bats === "S": max(batter.obpVs.L, batter.obpVs.R)
                 else:                   batter.obpVs[pitcher.throws]
   pitcherWhip:  if batter.bats === "S": max(pitcher.whipVs.L, pitcher.whipVs.R)
                 else:                   pitcher.whipVs[batter.bats]
   raw          = (batterObp + pitcherPseudoObp(pitcherWhip)) / 2
   adjusted     = raw * env.parkRunFactor * env.weatherRunFactor
   clamped      = clamp(adjusted, 0.05, 0.85)
```

Implementation: `lib/prob/reach-prob.ts:13-33`. The `pitcherPseudoObp` helper at `:9-11` is the rough "convert WHIP to OBP-equivalent" hack the user specified.

### Why this shape

- **Average of two estimates.** The batter's OBP-against-handedness gives one signal; the pitcher's WHIP-against-handedness (converted to a pseudo-OBP) gives another. Averaging hedges against each player's small-sample noise.
- **WHIP / 3.5.** WHIP counts walks + hits per inning (3 outs). Most outs come from at-bats where the batter doesn't reach. A rough conversion: if WHIP is 1.4, the pitcher allows ~1.4 baserunners per ~3.5 PAs, so reach rate ≈ 1.4/3.5 = 0.4. The 3.5 is empirical-ish — assumes some BB are unintentional and PAs per inning skew slightly above 3 for high-WHIP pitchers. **Don't change this without a calibration study.**
- **Clamps.** `[0.05, 0.85]` prevents degenerate values from bad split data (e.g. early-season splits with N=3). The pseudo-OBP `[0.18, 0.55]` clamp is a separate safety on the pitcher input.

### Switch hitter rule (user-specified, NOT standard)

When `batter.bats === "S"`:
- `batterObp = max(batter.obpVs.L, batter.obpVs.R)`
- `pitcherWhip = max(pitcher.whipVs.L, pitcher.whipVs.R)`

Standard MLB convention is that switch hitters always face pitchers from the *opposite* side, so you'd use the batter's OBP vs the pitcher's hand directly. The user explicitly chose to use **max** of both sides, which is intentionally generous toward "batter reaches" — it assumes the pitcher's worse split applies because switch hitters have the optionality to wait for the matchup that suits them.

This rule is in `lib/prob/reach-prob.ts:21-28` and unit-tested in `lib/prob/reach-prob.test.ts`. **Don't replace with the opposite-hand convention** without explicit user approval.

### Environment factors

- `env.parkRunFactor` — Baseball Savant runs index for the home park (e.g. 1.15 at Coors, 0.92 at Oracle). `lib/env/park.ts:getParkRunFactor`.
- `env.weatherRunFactor` — derived from covers.com weather scrape. `lib/env/weather.ts:weatherRunFactor`. Multiplicative chain: temp delta from 70°F (±10% cap), wind out/in (±8% cap by mph), precip > 60% (×0.95). Domes bypass everything → 1.0. Final factor clamped to `[0.85, 1.15]`.

Both factors default to `1.0` if the scrape fails. The combined `parkRunFactor * weatherRunFactor` mildly double-counts temperature/wind (the park factor was computed from games played in actual weather), but the bias is modest. Not worth correcting until we backtest.

## Inning DP — `lib/prob/inning-dp.ts`

A small Bayesian dynamic program walks the upcoming order forward, tracking the joint distribution over `(outs, reaches_so_far)` at each batter index.

### State space

`dp: Map<outs, [pReach0, pReach1]>` where `outs ∈ {0,1,2,3}` and `pReach0`/`pReach1` are probability masses for `reaches_so_far ∈ {0,1}`.

We don't track `reaches >= 2` as a state — instead it's an absorbing event. As soon as mass would transition into `reaches=2`, it's added to a running scalar `pHitEvent` and removed from the working `dp`.

### Transitions

For each upcoming batter `i` with `p_i = pReach`:
- With prob `p_i`: batter reaches. State `(o, 0) → (o, 1)`, or `(o, 1) → absorbed into pHitEvent`.
- With prob `1 - p_i`: batter is out. State `(o, r) → (o+1, r)`. If `o+1 == 3`, that mass is dead (no further transitions, no contribution to `pHitEvent`).

### Termination

- `o >= 3`: that mass is inert (inning ended without a hit event from this branch).
- All remaining mass at `o == 3`: loop exits.
- We only iterate `min(p.length, until_dead)` batters. We pass at least 9 (one full lineup turn) so the DP terminates naturally at 3 outs.

### Output

```
pAtLeastTwoReach(p[]) → P(hit event)         // p_HitEvent
pNoHitEvent(p[])      → 1 - pAtLeastTwoReach(p)
```

Implementation at `lib/prob/inning-dp.ts:10-44`. The helper `addMass` at `:46-51` does the in-place accumulation.

### Verified by simulation

`lib/prob/inning-dp.test.ts` includes a Monte Carlo sanity check: for `p=[0.3]*9` and a varied 9-vector, the DP value matches a 200K-trial simulation within `5e-3`. Matches by construction at `[0,0,...] → 0` and `[1,1,1] → 1`.

## American odds break-even — `lib/prob/odds.ts`

Given `q = P(NRSI)` (probability the bet wins):

```
americanBreakEven(q) =
   q ≥ 0.5  →  -100 * q / (1 - q)         // negative odds
   q < 0.5  →  +100 * (1 - q) / q         // positive odds
```

Implementation at `lib/prob/odds.ts:1-5`. Round-trips through `impliedProb`:

```
impliedProb(american) =
   american < 0  →  -american / (-american + 100)
   american > 0  →  100 / (american + 100)
   american = 0  →  0.5
```

(`lib/prob/odds.ts:7-11`.)

A quoted line `A` is **positive-EV** iff `impliedProb(A) < q`. The display value uses `roundOdds(americanBreakEven(q))` rounded to nearest 5 (`:13-17`). The raw unrounded value should be used for any actual EV comparison.

Tests at `lib/prob/odds.test.ts` include the `americanBreakEven(0.5) === -100` boundary and round-trip checks for `q ∈ {0.2, 0.35, 0.5, 0.65, 0.8}`.

## End-to-end

The pipeline lives in `workflows/steps/compute-nrsi.ts`:

```
probs        = batters.map(b => pReach(b, pitcher, env))
pHitEvent    = pAtLeastTwoReach(probs)
pNoHitEvent  = 1 - pHitEvent
breakEven    = roundOdds(americanBreakEven(pNoHitEvent))
```

The step returns `{ pHitEvent, pNoHitEvent, breakEvenAmerican, perBatter: [{id, name, bats, pReach}] }` which the watcher publishes verbatim into `GameState`.

## Calibration notes

The model is deliberately rough and not validated against historical results. Specific weak points:

- **Pseudo-OBP from WHIP.** The `WHIP / 3.5` heuristic is an estimator of a different quantity (baserunners per inning vs. on-base rate per PA). It correlates strongly but isn't equivalent. A proper conversion would model PA → OBP from a regression on historical pitcher seasons.
- **Independence assumption.** The DP treats each batter's reach event as independent given the pitcher. In reality, pitchers fatigue, get pulled, and face platoon advantages within the same inning. The DP doesn't model substitutions mid-inning.
- **Park × weather double-count.** Statcast park factors include average weather, so multiplying both is slight over-correction. Bias is small but non-zero.
- **Switch hitter "max" generosity.** Documented above. Will push P(NRSI) lower (more pessimistic for the bettor) than the standard convention.
- **No bullpen modeling.** Once a pitcher change happens (high-leverage situation, mid-inning swap), the watcher recomputes with the new pitcher's splits, but doesn't anticipate the swap. A real model would weight in expected reliever WHIP for late innings.
- **Splits sample size.** Early-season splits can be N=10 or fewer. The fallback to prior season helps but doesn't fully address regression-to-the-mean. A Bayesian shrinkage toward league average would be more honest.

## How to validate against reality

Not implemented, but the shape:

1. Backfill historical `nrsi:snapshot` states from completed games (publish phase only, no UI).
2. For each Live half-inning where we logged `(pHitEvent, breakEvenAmerican)`, look up the actual outcome via `statsapi.mlb.com/api/v1.1/game/{pk}/feed/live` historical data: did 2+ reach base in that half?
3. Compute calibration: bin predictions into deciles, compare predicted vs. actual frequency. Plot. If well-calibrated, the line is `y = x`.
4. Compute log-loss against actual outcomes vs. a baseline (e.g. constant 60% NRSI rate, the empirical league average).

A win is: outperforming the constant baseline by ≥ 5% on log-loss across ≥ 5,000 inning observations. That would justify the complexity over a sportsbook's posted line.
