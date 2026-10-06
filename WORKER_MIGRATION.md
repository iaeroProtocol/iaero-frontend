# Cloudflare Workers migration

This branch replaces the deprecated Cloudflare Pages adapter with OpenNext. It must stay separate from the live Pages deployment until the Worker has been staged with the current environment variables and tested on its own URL. The existing `app.iaero.finance` Pages site remains the rollback target.

## Local verification

```sh
npm ci
npm run test:rift
npm run lint
npx tsc --noEmit --incremental false
npm audit
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=<test-id> npm run worker:build
npx opennextjs-cloudflare preview
```

The `preview` command serves the Worker locally with Wrangler. The production build must use the real public IDs and keys; the local test ID used during validation must never be deployed.

Local verification on 2026-10-06: clean install, 200 Rift unit tests, TypeScript, and the OpenNext build passed; the full npm audit found zero advisories. Oxlint exited successfully with 46 existing warnings. The local Worker returned HTTP 200 for the home page and read-only Rift holdings route, and passed 7/7 mocked payment-safety checks plus all 33 mocked purchase/order browser checks. A Wrangler deployment dry run passed. No live order or transfer was made.

## Cloudflare staging and cutover

1. Authenticate Wrangler to the Cloudflare account that owns `app.iaero.finance`. This machine currently has no Cloudflare login.
2. Recreate the Pages project's build variables in Workers Builds, especially `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` and `NEXT_PUBLIC_ALCHEMY_KEY`. Copy any configured public URL overrides. Recreate runtime variables and secrets in the Worker dashboard: `ZERO_EX_API_KEY`, `GITHUB_SPAM_TOKEN`, and any configured `ALCHEMY_KEY`, `RPC_URL`, or `BASE_USDC`. Keep secret values out of Git and chat. Cloudflare does not reveal existing secret values after creation, so the owner may need to re-enter them from their source.
3. Deploy the Worker to a staging `workers.dev` URL with `npm run deploy`. The script uses `--keep-vars` so dashboard variables survive deployments. Check the page, the Rift holdings route, status, quote proxy, and spam report behavior with safe test requests. Do not submit a real order or transfer during smoke testing.
4. Configure Workers Builds for this repository and branch, then move `app.iaero.finance` from the Pages project to the tested Worker. Keep the Pages project and its last successful deployment available for rollback until production smoke checks pass.
5. After cutover, remove or disable the old Pages Git integration so it no longer attempts the removed `pages:build` script.

The Cloudflare WAF rate rule for `/api/rift/holdings` is optional defense in depth. The route already has a per-instance limit, cache, deadline, and public RPCs only.
