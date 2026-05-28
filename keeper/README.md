# Auto-USDC Vault Keeper

Weekly keeper for the [iAERO Auto-USDC Vault](https://basescan.org/address/0xFE5c929677D97723dc822C86c93c7e2D1B59c774). On every Thursday epoch boundary, it discovers reward tokens owed to the vault, fetches fresh 0x quotes, swaps everything to USDC, and finalizes the epoch — all atomically per epoch.

**Production deployment:** [iaero-autovault-production.up.railway.app](https://iaero-autovault-production.up.railway.app) (Railway cron service)

## What it does

1. **Discovers** claimable reward tokens via the on-chain `RewardTokenRegistry` + spam filter
2. **Quotes** each token through 0x v2 (`swap/allowance-holder/quote`) with main + reference quotes for impact measurement
3. **Builds + simulates** a swap plan; isolates any failing steps via binary search
4. **Broadcasts** the main harvest in chunks of ≤10 swaps (gas safety; the upstream `RewardSwapper` caps at 32)
5. **Per-token sweep** for any tokens that didn't make it into the main batch, up to `MAX_SWEEPS` passes
6. **Finalize** the epoch via a separate empty-plan `harvest()` call

For the full architecture see [`docs/AUTO_VAULT.md`](../docs/AUTO_VAULT.md) and the gitbook page.

## Required env

| Var | Purpose |
|---|---|
| `PRIVATE_KEY` | Keeper EOA private key (must hold `KEEPER_ROLE` on the vault) |
| `RPC_URL` | Base mainnet RPC. Public fallback used if not set. |
| `ZERO_EX_API_KEY` | 0x v2 API key. Legacy alias `ZERO_X_API_KEY` also accepted. |

## Optional env

| Var | Default | Purpose |
|---|---|---|
| `FINALIZE` | `1` | Set `0` to skip the final `finalize=true` tx |
| `MIN_USDC_PCT` | `95` | Global per-chunk minOut as % of summed quotes |
| `MAX_SWEEPS` | `3` | Max per-token retry passes after the main batch |
| `EXECUTION_BATCH_SIZE` | `10` | Swap steps per harvest tx |
| `SKIP_INDIVIDUAL_RETRY` | `0` | Set `1` to skip Tier 3 (individual retries) entirely |
| `DRY_RUN` | `0` | Set `1` to simulate without broadcasting |
| `WARMUP_RUN` | `0` | Set `1` for manually-triggered post-deploy validation runs. Adds a banner block to the startup logs identifying the run as deploy-gating. Behaviorally identical to a normal run. |
| `TARGET_EPOCH` | (latest completed) | Override which epoch to harvest |
| `LOG_LEVEL` | `info` | Set to `verbose` for per-phase timing |
| `FORCE_HIGH_SLIPPAGE` | `0` | Rehearsal-only — do NOT set in production |

## Running locally

```bash
cd iaero-frontend/keeper
cp .env.example .env       # then edit and fill in PRIVATE_KEY, RPC_URL, ZERO_EX_API_KEY
npm install
npm run dry-run            # simulate everything; no broadcast
# or
npm start                  # for real
```

## Utilities

```bash
# List tokens currently sitting in the deployed RewardSwapper:
npm run check-swapper-balances
```

## Railway deployment

This subdirectory is designed to be Railway's "root directory" for a Cron job service.

### Service config

| Setting | Value |
|---|---|
| **Builder** | Nixpacks (auto-detected from `package.json`) |
| **Root directory** | `keeper` |
| **Install command** | `npm install` (default) |
| **Start command** | `npm start` |
| **Schedule (cron)** | `0 1 * * 4` — Thursdays 01:00 UTC (1h after epoch boundary, so the upstream's reward funding lands first) |

### Required env vars (set in Railway service settings)

- `PRIVATE_KEY`
- `RPC_URL` (use an RPC that allows server-side calls — Alchemy keys with no origin restriction, QuickNode, etc.)
- `ZERO_EX_API_KEY`

### Optional env vars

Leave defaults unless you have a specific reason. See the table above.

### Gotchas

- **Don't set `FORCE_HIGH_SLIPPAGE=1` in production.** It's a rehearsal-only knob that accepts 50%+ per-step slippage.
- **Each run reads a lot of state.** Use a paid RPC (Alchemy/QuickNode) — the public Base RPC will rate-limit.
- **First Thursday after deploy:** double-check the logs. The keeper logs every quote, every isolation drop, every chunk's tx hash. If something looks off, you have ~6 hours before the next attempt would matter.
- **If the keeper EOA runs out of ETH:** harvests stop silently. Set up a low-balance alert (Railway can send webhooks on failed runs).
- **If the 0x API key gets rate-limited:** isolation drops affected tokens, sweep retries pick them up next pass. Worst case: tokens stay in vault, admin handles later.

### Monitoring

The keeper logs everything to stdout, structured with `[stage]` prefixes. Railway captures and stores all of it.

**Live deployment logs:** open the service in Railway, **Logs** tab. The most recent run is at the bottom.

Every run begins with a startup banner showing node version, env presence, RPC health, keeper EOA balance, and config. Every run ends with a one-block summary so you can scroll to the bottom for the outcome at a glance:

```
[summary] ═══════════════════════════════════════════════════════════════
[summary] Run complete in 87.3s — epoch 1780531200
[summary]   USDC bucketed:       42.184217 USDC
[summary]   Total gas used:      6342184 (3 chunk(s) + finalize)
[summary]   Chunks:              3/3 succeeded
[summary]   Sweep retries:       2 attempted, 1 delivered USDC, 1 confirmed-but-0-USDC
[summary]   Stuck in swapper:    1 token(s)
[summary]   Stuck in vault:      0 token(s) (admin can rescue if non-USDC)
[summary]   Finalize tx:         0xabc...
[summary] ═══════════════════════════════════════════════════════════════
```

Log stages used throughout:

| Prefix | Phase |
|---|---|
| `[init]` | Startup banner — node, env, RPC ping, keeper balance, config |
| `[discover]` | Token discovery via registry + spam filter + `previewClaim` results |
| `[quote]` | 0x quotes (main + reference) + impact + slippage |
| `[simulate]` / `[isolate]` | Pre-broadcast sim + any step drops |
| `[chunk]` | Per-chunk broadcast tx hashes + gas |
| `[refresh]` | Just-in-time quote refresh before each chunk |
| `[sweep]` | Per-token retry passes (Tier 3) |
| `[finalize]` | Epoch finalization tx |
| `[postflight]` | Any tokens left in swapper or vault |
| `[timing]` | Per-phase elapsed time (only when `LOG_LEVEL=verbose`) |
| `[summary]` | End-of-run recap |
| `[fatal]` | Unhandled error — run aborted |

### Manual one-off runs

To re-run a specific past epoch (e.g., after admin `unfinalize`):

```bash
TARGET_EPOCH=1779926400 npm start
```

## Architecture (5-tier resilience)

| Tier | What | Triggered when |
|---|---|---|
| 0 | Spam blocklist + symbol pattern filter | Always |
| 1 | Batch with normal slippage (30-500 bps) | Always |
| 2 | Batch with boosted slippage (1000+ bps) | Only if Tier 1 isolation reduces plan to 0 |
| 3 | Per-token individual retries | After main broadcast, for tokens still in vault |
| 4 | Multi-pass sweep (up to `MAX_SWEEPS`) | Re-attempts Tier 3 with fresh quotes |
| Finalize | Empty-plan `harvest(finalize=true)` | Last tx |

See [`index.ts`](./index.ts) for the implementation details.
