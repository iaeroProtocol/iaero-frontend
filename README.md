# iAERO app

The iAERO frontend combines live positions, original-token reward claims, LIQ staking, reward sweeps, Rift routes and shared protocol yield. The separate AeroStakeDeposit contract is connected at `0xD5E4a7869D1189caa617749d483aaD95Af370c70`. Its exact runtime, immutable links and refusal version are verified independently of the future USDC staking stream. Deposit controls open only when fresh on-chain checks permit them. The replacement USDC stream and wrappers remain gated by their own deployment manifest.

## New AERO and stake deposits

The Deposit page supports new AERO and existing Aero stake NFTs, with exact ERC20 or single-NFT approvals. It rechecks after approvals and simulates before each wallet request. A lower LIQ preview requires a fresh review; the app never submits a zero LIQ minimum. Old Aerodrome AERO is directed to the official upgrade page. The handoff's version 3, revision 5 guidance is preserved byte-for-byte in `config/aero-deposit.reasons.v3.json`.

Source, runtime and refusal-table identities live in `config/aero-deposit.json`. Protocol TVL includes the primary stake and verified separate vault-held NFTs, deduplicated at the same finalized block. The existing yield recorder continues to identify its explicit primary position; this frontend change does not rewrite historical yield.

`npm run test:browser:deposit` checks compiled desktop and phone screens with a deterministic wallet and RPC. For an isolated deployed-contract replay, set `DEPOSIT_FORK_CONTEXT` to a public JSON file containing `forkUrl`, `readBridgeUrl`, `forkBlock` and `forkBlockHash`, then run `npm run test:deposit:fork` followed by `npm run test:deposit:worker-fork`. Both URLs must be loopback HTTP, and the bridge must forward read methods only. These scripts reset their disposable Anvil, impersonate accounts only locally, and never load a signing key. The Worker replay uses a local D1 and advances empty blocks for Anvil's finalized tag. Author-run fork tests do not close independent review, Safe signature, keeper, provider or owner go-live gates.

## Local development

Use Node 22.19 or later, then `npm ci` and `npm run dev`. The local app runs at http://127.0.0.1:4317. `?demo=1` opens a separate sample account. Production builds remove the local preview ribbon and use actual wallet-confirmed actions.

The local server selects only approved read-only RPC settings. No signing key is needed. Browser bundles contain no private RPC or quote credential. The public mobile-wallet project ID lives in `config/wallet.public.json`.

## Production build

`npm run pages:build` creates `.vercel/output/static`, preserving the existing Cloudflare Pages build command and output location. `npm run build:pages` produces an isolated `.release/pages` directory for manual preview deployment and tests. Both compile the same Pages Worker, remove public source maps, and use same-origin APIs. The existing Next frontend remains recoverable at commit `0f3e3e6` and its retained Cloudflare deployment.

The Pages environment needs these bindings:

- `BASE_READ_RPC_URLS`: encrypted JSON array containing the owner-approved Alchemy Base endpoint. Two independent HTTPS providers remain supported for future corroboration.
- `ZERO_EX_API_KEY`: the existing server-side 0x credential.
- `YIELD_DB`: the shared Cloudflare D1 ledger.
- `APP_ALLOWED_ORIGINS`: explicit public HTTPS origins allowed to call the app APIs.
- `LEGACY_API_ORIGIN`: the retained immutable Pages deployment serving pre-existing stats, token-price, generic 0x quote and spam-report integrations.
- `COLLECTOR_ENABLED`: health reporting must match the separate recorder's activation.

Use compatibility date `2026-07-30` with `global_fetch_strictly_public` for the retained API routes and recorder price requests. Private settings belong in Cloudflare bindings, never VITE variables. The reviewed clients in `src/protocol` retain their original bytes; `REVIEWED_CLIENT_SOURCE.json` records their identities. The root `keeper/` and original `docs/` are preserved.

## Shared history

A separate scheduled Worker in `worker/index.ts` records finalized Base, Ethereum and Robinhood rewards into D1 every five minutes. Pages reads the same database. Browser requests cannot start collection or mutate the ledger. The recorder needs Workers Paid; the Free plan's CPU and external-request limits are insufficient for these verified reads.

`config/wrangler.history.production.jsonc` describes the recorder with collection disabled by default. Set its encrypted `YIELD_RPC_SOURCES` binding, apply `worker/migrations`, import and verify every existing fact, then activate the cron. A fresh scheduled observation and `/api/protocol-yield/health` must pass before release. Robinhood remains explicitly provisional with one provider. Read `SHARED_HISTORY.md` for valuation and observation-window rules.

## Verification

Run `npm test`, `npm run typecheck`, and `node --test test/restored-rift/*.test.mjs`. The browser checks exercise claims, sweeps, Rift recovery, unavailable data, changing accounts, stale quotes and phone layouts with mocked wallets. `scripts/run-release-browser-checks.mjs` runs the complete local browser round. `scripts/pages-worker-check.mjs` exercises the compiled production Worker locally with approved read-only providers and a fresh D1.

These are author checks. They do not assert independent contract review, real-owner signing or physical-phone acceptance. Contract deployment and activation remain separate from publishing the frontend.

Provider reliability: private RPC reads are paced per API key across chains, with bounded retries for HTTP 429/502/503/504 and Retry-After support. Authentication failures and contract reverts are preserved. Pages shares a one-minute finalized verification snapshot from the configured provider(s) through the derived cache in migration `0003_bootstrap_cache.sql`; expired proofs never become a fallback and cache hits do not renew their lifetime. This cache stores public contract metadata, not personal wallet balances or protocol reward facts. Apply the additive migration before publishing this backend.

27 October operational decision: the owner requested Alchemy-only frontend and recorder reads after Infura exhausted its daily quota. The policy in `config/frontend-read-policy.json` accepts one Alchemy endpoint for app operation; API responses and the UI retain the actual provider count and mark independent confirmation pending. New Base, Ethereum and Robinhood observations use one provider each. Historical facts keep their original coverage. This does not close the separate two-provider contract launch gate.
