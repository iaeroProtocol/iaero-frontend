# iAERO app

The iAERO frontend combines live positions, original-token reward claims, LIQ staking, reward sweeps, Rift routes and shared protocol yield. New deposit and USDC-stream actions open only after their deployment manifest and live links pass verification. The owner confirmed that only the new vault, keeper and harvester are deployed as of 27 October 2026.

## Local development

Use Node 22.19 or later, then `npm ci` and `npm run dev`. The local app runs at http://127.0.0.1:4317. `?demo=1` opens a separate sample account. Production builds remove the local preview ribbon and use actual wallet-confirmed actions.

The local server selects only approved read-only RPC settings. No signing key is needed. Browser bundles contain no private RPC or quote credential. The public mobile-wallet project ID lives in `config/wallet.public.json`.

## Production build

`npm run pages:build` creates `.vercel/output/static`, preserving the existing Cloudflare Pages build command and output location. `npm run build:pages` produces an isolated `.release/pages` directory for manual preview deployment and tests. Both compile the same Pages Worker, remove public source maps, and use same-origin APIs. The existing Next frontend remains recoverable at commit `0f3e3e6` and its retained Cloudflare deployment.

The Pages environment needs these bindings:

- `BASE_READ_RPC_URLS`: encrypted JSON array of two approved, independently hosted Base endpoints.
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
