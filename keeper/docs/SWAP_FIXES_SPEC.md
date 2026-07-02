# Keeper swap-path fixes — implementation spec

> Created 2026-07-02, from analysis of the Jul-2 harvest of epoch `1782345600`
> (240.0 USDC banked vs ~262 addressable; 3/6 chunks reverted; ~40 sweep attempts;
> cbBTC stuck). Targets `iaero_frontend/keeper/index.ts` and `swap-pipeline.ts`.
> All changes are **keeper-side, no contract redeploy** unless flagged `[v2]`.

---

## As shipped (2026-07-02, post two adversarial audits)

Landed on branch `keeper/auto-usdc-swap-slippage-fixes` (based on the PR #18
`keeper/stiaero-exclusion-failclosed` branch). The sections below are the original
design rationale; this summary is what actually shipped, including audit fixes:

1. **slippageBps → 0x, end-to-end.** `QuoteRequest.slippageBps` + both fetchers +
   `getQuoteWithImpact` forward it, `buildSwapPlanFor` bakes it into the plan, **and
   `refreshQuotes()` re-bakes `step.slippageBps` into the JIT pre-broadcast re-quote.**
   The `refreshQuotes` leg is essential: without it the JIT refresh discarded the
   tolerance and 0x reverted to its ~1% default on the *actual* broadcast (the whole
   change would have been inert — caught by the audit).
2. **`SLIPPAGE_MIN_BPS` 30 → 150** in the keeper copy only (frontend `src/lib` stays
   30; the divergence is documented in `index.ts`'s header).
3. **Chunk-then-simulate.** Whole-plan isolation is deferred for `>EXECUTION_BATCH_SIZE`
   plans (it always hit "plan too long" >32 and dropped good tokens); the per-chunk
   sim isolates instead. The WARMUP/DRY_RUN gates run a **representative first-chunk
   sim** so the pre-deploy gate still validates the harvest path for large plans.
4. **Tier-3 escalation ladder** `[100,300,500,800,1000]` bps over 5 passes, extracted
   to `keeper/sweep-ladder.ts` (`sweepSlippageForPass`); early-stop only at the top rung.
5. **Isolation sims claim only `plan.tokensInPlan`** (not the full `tokensToClaim`,
   which includes spam) so a >50-claimable epoch can't false-revert on the vault's
   50-token claim cap and false-abort a deploy (audit finding C1).
6. **`MIN_USDC_PCT` aggregate floor kept** — it is load-bearing anti-strand (reverts a
   chunk so tokens roll back to the vault instead of stranding in the swapper), NOT
   redundant. See the Correction below.

**Not shipped (deferred):** Change 5 (thin-token chunk isolation) and Change 6
(`[v2]` keeper `forwardRaw`).

**Tests:** `keeper/test/swap-pipeline.test.mts` (12 cases, `node --test`) + 2 Foundry
strand/rollback tests in the contracts repo. `tsc --noEmit` clean.

---

## Correction to prior analysis (important)

Earlier I claimed the aggregate `MIN_USDC_PCT` floor was "redundant with per-step
protection — set it to 0." **That is wrong; do NOT set it to 0.** The vault calls
`executePlanFromCallerAdvanced(..., allowPartial:true)`. In that mode the swapper
does `transferFrom(vault → swapper)` *before* each swap (`RewardSwapper.sol:265`).
If a leg then fails, the pulled token is left **stranded in the swapper**
(unreachable by the vault sweep; only the RewardSwapper owner can rescue it).

The aggregate floor is precisely what prevents that: when the summed output falls
short, the whole `harvest()` tx **reverts and rolls the `transferFrom` back**, so the
tokens stay in the **vault** and are retried by the sweep. So the floor is
load-bearing (anti-strand), not the villain.

### The real root cause of the whole-chunk "total slippage" reverts

For the 0x/aggregator path (`_executeOneTry`, `RewardSwapper.sol:483-513`):
- A leg only fails when **0x's own `.call` reverts** (`okCall == false`, line 497).
- 0x reverts when the **minOut embedded in its calldata** isn't met.
- **We never pass `slippageBps` to 0x**, so 0x uses its **default (~1%)**.
- Our contract-side `slippageBps` (30 bps normal) is only checked *after* a
  successful 0x call (line 510) — so on the main batch it's 0x's ~1% that is the
  binding constraint, not our 30 bps.

WETH failed in chunk 1 because it drifted **>1%** in the ~52s between quote and
broadcast → 0x's ~1% minOut reverted → leg returned 0 → chunk total below floor →
whole chunk reverted (WETH rolled back to vault, later swept at 10% tolerance).

**So the levers that actually matter are: (a) pass our intended `slippageBps` to
0x, and (b) give the main batch a realistic slippage floor + fresher quotes — NOT
lowering the aggregate floor.**

---

## Change 1 — Chunk first, then simulate (kill the bogus 34-step "plan too long")

**Problem.** `index.ts` builds one combined plan of *all* swap steps and runs
`isolateExecutablePlan` on the whole thing (~`index.ts:1166-1204`) before chunking.
Because the contract caps at `MAX_STEPS = 32`, any plan >32 steps auto-fails the
whole-plan sim with `"plan too long"`, and the isolator **drops good tokens**
(BIO etc.) to get under 32 — tokens that would swap fine inside a 10-step chunk.
They then have to be recovered by the slow sweep.

**Fix.** Skip the whole-plan simulate/isolate. Go straight to `packChunks`
(~`index.ts:1406`) and rely on the **per-chunk** sim + re-isolate that already
exists (`index.ts:1451-1464`). Each chunk is ≤10 steps, far under 32, so
`"plan too long"` never fires and no good token is dropped for a length reason.

- Remove/guard the pre-chunk isolation block around `index.ts:1160-1204`.
- Keep the per-chunk `simulateHarvest` + `isolateExecutablePlan` at `1451-1464`
  (that's where genuine per-token reverts should be found).
- `isolateExecutablePlan`'s `floorFor` (`index.ts:759-760`) stays, but now only
  ever sees ≤10-step chunks.

---

## Change 2 — Pass `slippageBps` to the 0x quote (the key fix)

**Problem.** 0x bakes its **default ~1%** minOut into the calldata; we never override
it. On the main batch our 30 bps is tighter (so our post-check binds), but 0x's ~1%
is what reverts blue-chip legs on drift. On the boosted sweep our floor is *looser*
(10%) but 0x's calldata still enforces ~1% — so the "boost" is half-fake.

**Fix (`swap-pipeline.ts`).**
1. `QuoteRequest` (`:192`): add `slippageBps?: number`.
2. `createDirectQuoteFetcher` (`:247`) and `browserQuoteFetcher` (`:224`): if
   `req.slippageBps != null`, add `params.set('slippageBps', String(req.slippageBps))`.
3. `getQuoteWithImpact` (`:460`): add `slippageBps?: number` to args; pass it into
   the **main** fetch (`:478-481`). Leave the **reference** quote (`:498-501`) at
   default — it's a price probe, not executed.

This makes 0x's embedded minOut match our intended tolerance in every path.

---

## Change 3 — Realistic main-batch slippage floor + JIT freshness

**Problem.** `calculateSlippage(impact, false)` (`swap-pipeline.ts:286-297`) floors at
**30 bps**. Against ~1s–1min quote drift, blue-chip legs (WETH) fail 0x's minOut and
sink their chunk. 30 bps is unrealistically tight for a keeper that quotes then
broadcasts seconds later.

**Fix.**
- Raise the normal-mode floor from **30 → ~100–150 bps** (`SLIPPAGE_MIN_BPS`,
  `swap-pipeline.ts:57`), cap unchanged at 500 bps (5%). Combined with Change 2,
  WETH-type legs then tolerate ~1–1.5% drift and fill in-batch.
- The per-chunk JIT refresh already re-quotes right before broadcast
  (`index.ts:1432-1437`); keep it. Optionally tighten the refresh→broadcast gap.
- The aggregate floor (`MIN_USDC_PCT`, `index.ts:1441`) **stays** as the anti-strand
  rollback. Because more legs now fill, chunks commit instead of reverting to sweep.

> Net effect: the main batch banks the liquid majority in-tx (cheap, fast) instead
> of dumping nearly everything onto the per-token sweep.

---

## Change 4 — Escalation ladder in the sweep (5 passes: 1 / 3 / 5 / 8 / 10 %)

**Problem.** Every sweep pass calls `individualRetry` **identically** — slippage is a
flat ~10% (`index.ts:874`, capped by `MAX_SWEEP_SLIPPAGE_BPS=1000`). A
deterministically-failing token (cbBTC) fails 3× the same way, then the early-stop
(`index.ts:1607`) abandons it. No graduated escalation.

**Fix (`index.ts`).**
1. Define the ladder and default passes to its length:
   ```ts
   const SWEEP_SLIPPAGE_LADDER_BPS = [100, 300, 500, 800, 1000]; // 1/3/5/8/10 %
   const MAX_SWEEPS = Number(process.env.MAX_SWEEPS || String(SWEEP_SLIPPAGE_LADDER_BPS.length)); // 5
   ```
2. `individualRetry` (`:828`): add param `slippageBpsOverride: number`. Replace the
   computed `slippageBps` (`:874`) with
   `Math.min(slippageBpsOverride, MAX_SWEEP_SLIPPAGE_BPS)` and **also pass it into
   `getQuoteWithImpact`** (`:856`) as `slippageBps` (Change 2) so the 0x calldata
   matches. Keep the `minOut === 0` illiquid-dust skip (`:891-895`).
3. Sweep loop (`index.ts:1562`): pass the rung
   `SWEEP_SLIPPAGE_LADDER_BPS[Math.min(pass - 1, SWEEP_SLIPPAGE_LADDER_BPS.length - 1)]`.
4. Early-stop (`index.ts:1607`): don't stop just because a pass delivered no USDC —
   a higher rung may fill next pass. Only stop when a pass delivered nothing **and
   the rung is already at the top (1000 bps)**. (Still bounded by `MAX_SWEEPS`.)

The ladder tops out at the existing 10% cap, so per-leg value loss is unchanged at
worst; most tokens fill at a low rung (minimal loss) and only the stubborn ones
climb.

---

## Change 5 (optional) — segregate liquid vs thin at pack time

`packChunks` (`index.ts:1389`) balances by value/dominance. Add: force tokens whose
**measured impact > ~1%** (or a static thin-list) into **single-token chunks**, so a
thin failer can't sink a liquid batch and — under the aggregate floor — only reverts
itself back to the vault (never strands a good leg). Lower priority than 1–4.

---

## Change 6 — "swap them ALL / never strand": the hard limit `[v2]`

Keeper-side, Changes 2–4 will convert essentially everything that can fill within
10%. But a token that **cannot fill at 10%** (genuinely illiquid) has nowhere to go:
the vault exposes only `harvest()` to the keeper; unswappable tokens leave **only**
via admin `rescue()` (`iAEROAutoUSDCVault.sol:331`, `DEFAULT_ADMIN_ROLE`). There is
**no keeper-callable forward-raw**.

To *guarantee* every token exits without admin action, a **v2 vault** needs a
keeper-callable `forwardRaw(token)` that pushes the raw token to
`epochDist.notifyRewardAmount` (stakers receive the actual asset, swappable later).
Batch this with the other v2 hardening in `NEXT_SESSION_autovault_scaling.md`.

Separately: tokens stranded **in the RewardSwapper** (the AVNT/TLOS/RAVE/cbBTC dust in
the Jul-2 postflight) are only recoverable by the **RewardSwapper owner** — a distinct
cleanup, and a reason Change 3 (fill in-batch, avoid the strand path) matters.

---

## Validation

1. **DRY_RUN plan check** — `DRY_RUN=1 TARGET_EPOCH=<next open epoch> npm start`.
   Confirm: (a) no `"plan too long"`; (b) chunks ≤10 with sane floors; (c) the 0x
   requests now carry `slippageBps`; (d) sweep logs show rungs 1→3→5→8→10%.
   (DRY_RUN skips broadcast, so it validates construction, not fills.)
2. **Fork test** (Foundry, `protocol/.../test`): a chunk with one leg forced to
   revert → assert the token returns to the **vault** (not the swapper) and the good
   legs still bank; assert the sweep escalates rung-by-rung.
3. **Live watch** — next Thursday harvest: expect chunks to *commit* (not revert to
   sweep), higher conversion %, and cbBTC either filling at a high rung or cleanly
   left for rescue.

`MIN_USDC_PCT` needs **no contract change** — it's the keeper-supplied `minUSDC`
argument to `harvest()`. Keep it > 0 (see Correction above).

---

## Summary of files touched

| Change | File | Anchor |
|---|---|---|
| 1 chunk-then-sim | `index.ts` | remove pre-chunk isolate ~`1160-1204`; keep per-chunk `1451-1464` |
| 2 slippageBps→0x | `swap-pipeline.ts` | `QuoteRequest:192`, fetchers `224`/`247`, `getQuoteWithImpact:460` |
| 3 main-batch floor | `swap-pipeline.ts` | `SLIPPAGE_MIN_BPS:57`, `calculateSlippage:286` |
| 4 escalation ladder | `index.ts` | new ladder const; `individualRetry:828/874`; sweep loop `1562`; early-stop `1607` |
| 5 pack segregation | `index.ts` | `packChunks:1389` (optional) |
| 6 forward-raw | `iAEROAutoUSDCVault.sol` | `[v2]` new keeper fn |
