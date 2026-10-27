# Frontend staging decisions

## 25 October 2026

- Keep this app inside `sAERO/frontend-staging/`; preserve the current frontend and reviewed production checkout. The user requested local testing before any push.
- Keep the approved visual design and the sample account at `?demo=1`. Real-wallet mode is the default following the explicit request to wire actual contracts.
- Use public deployed addresses in a separate registry. The owner confirmed that the new user-facing stack is not deployed, so its addresses remain null and no new staking/deposit/NFT write is possible. Keeper and harvester addresses never substitute for user vault or staking contracts.
- Enable only existing legacy claim/withdrawal continuity for local browser-wallet testing. The agent does not sign, deploy, use a private key or execute an owner transaction. Every available write simulates and requires the user's wallet confirmation.
- Withdraw exact reviewed principal rather than an unbounded `exit()`. Claim an explicit token and reward week. Keep old AutoVault shares and rewards distinct from both previous direct staking and the future stream.
- Retain all positive selected rewards, including native ETH and dust. Expose date/token selection and its scope; do not imply exhaustive history. Failed reads are unknown. Bad reward selectors do not hide successfully read principal.
- Keep private read endpoints server-side behind a same-origin loopback read/simulation proxy. Compare initial finalized code and links on two configured providers; do not present this as full source provenance or launch acceptance.
- Preserve the six reviewed client files verbatim and reuse the wallet guard and persistent transaction journal. Actual account/network changes invalidate the action; receipt failures and ambiguous wallet requests retain the record for review.
- Use a stable built local preview for wallet testing, and keep simulated browser interaction checks separate from actual read-only network checks. Independent review and the release gates remain pending.


## 25 October 2026 — aggregated rewards and restored sweeps

- The owner requested Claim all, aggregation by token and the old sweep flows. Token identity is the address; equal symbols never merge different assets. Weekly detail and individual-week claims remain accessible.
- Claim all means the displayed token/week selection. Discover the full verified reward registry, keep native ETH and every positive reward, batch at the contract's actual 50-entry limit and preserve completed batches if a later one fails. No unreviewed reward-exclusion policy is introduced.
- Reuse the existing RewardSwapper and the deployed Aero two-pool market route. Keep the 0x API credential in its existing app proxy. No Railway or local signing key is used.
- Sweeps require review of exact wallet amounts and live minimum outputs. Use bounded exact pulls rather than `useAll`, per-step simulations, exact approvals and fresh quotes that retain the reviewed floor. Existing iAERO principal/receipts and native gas balances are excluded.
- Keep liquid iAERO output available. Label optional compounding into previous staking explicitly; it never aliases the undeployed new stream. Stake only receipt-proven new iAERO. Automatically selected USDC after a claim is limited to the exact claim receipts.
- A partially completed sweep is not idempotent. Discard its executable preview on any failure, rescan balances and clear selection before another attempt. Confirmed hashes remain available, and a pending request still blocks sending. Claims themselves remain idempotent on chain.
- Continue local staging only. No push, deployment, production acceptance or independent-review claim.

## 26 October 2026 — estimated USDC reward totals

- Show the selected rewards' combined USDC estimate and each token's estimated equivalent. Portfolio also includes the previous AutoVault's known USDC entitlement. Keep the existing token/week selection scope explicit.
- Value canonical USDC exactly and native ETH through WETH for display only. Prefer an actual-amount live quote; label reference-size fallbacks as indicative. Unknown prices remain unknown and make the total partial. Preserve integer precision and positive dust.
- Bind values to account, chain, selected dates/tokens and amounts. Abort superseded pricing, refresh separately from balance reads and expire old estimates. Quote availability must never gate claiming, withdrawal or sweep execution.
- Use the existing app's quote relay through a bounded, cached local read-only endpoint. Return numeric values only. Do not copy an API credential or alter reviewed transaction clients.
- Keep the work local. Author tests and read-only quote checks do not close independent review or deployment gates.

## 26 October 2026 — skip failing swaps and filter known spam

- The owner hit an unsupported RNDR quote while sweeping all tokens. Check every requested token independently, collecting quote and simulation failures without aborting other candidates. Only passing inputs contribute to the review and its minimum; an empty passing set cannot execute.
- Simulate exact allowance reset/approval plus the actual swap through the primary provider's verified `eth_simulateV1`. Do not invent token balances, allowance storage slots or contract code. An unavailable simulation cannot enable an input. These calls change only simulated state.
- Recheck before approval and after approval. Use one strict atomic transaction per token, retaining `useAll=false` and `allowPartial=false`. The legacy partial-execution path pulls tokens before trying a swap; enabling it would risk leaving a failed input inside the swapper.
- Continue past pre-send quote/simulation failures. Wallet rejection, identity change, ambiguous sends and receipt failures still stop. A smaller set after review leaves USDC liquid and defers iAERO/staking rather than weakening the reviewed conversion floor.
- Reuse the existing protocol spam address and symbol rules from a hashed local snapshot. Keep known spam out of sweep selection, and expose a read-only inspection list. Treat symbol rules as literal strings. Missing liquidity alone does not classify an asset as spam. Preserve direct reward-claim coverage and perform no automatic external reporting.
- Keep local author verification separate from independent review and production acceptance. No push, deployment, signature or real transaction is performed by this task.

## 26 October 2026 — wallet value order and restored swap batches

- The owner requested USDC value ordering and restored batching. Sort scanned wallet balances by integer USDC estimates, descending; keep unpriced tokens at the bottom and deterministic ties. Reuse the existing read-only pricing endpoint. Commit the completed valuation snapshot to avoid progressive row movement, and retain selections/edited amounts by address. Pricing never gates the sweep review.
- Read the existing frontend's `RewardsSection.tsx`: ten swaps per execution batch, just-in-time quotes, individual simulation, aggregate gas validation and problem-token isolation. Restore its ten-token grouping with strict reviewed minimums and recursive pre-submission splitting. Each split refreshes its own quotes and repeats individual/combined checks; no sent batch is automatically retried.
- Keep exact approvals separate, as in the old site. Batch simulation after approval uses actual allowances. Require a successful gas estimate, add 30% headroom and remain within 16 million gas. Apply that limit only to the batch through the existing guarded sender, preserving all six reviewed clients verbatim. Do not increase slippage or substitute guessed gas after a failed estimate.
- Preserve per-token failure collection, known-spam filtering, receipt reconciliation, account/network guards, cross-tab locking and ambiguity handling. Keep USDC liquid if a post-review exclusion changes an iAERO conversion's input set.
- Keep the work staged locally and independently unreviewed. Actual read-only batch simulation is scoped separately from owner-wallet/Safe or fork acceptance.

## 26 October 2026 — quote diagnosis and protocol metrics

- The owner supplied exact VVV/wstETH sell amounts after many skips. Read-only calls to the existing 0x relay confirm no routes for these amounts, while larger reference amounts quote successfully. Keep executable amounts exact; do not substitute reference-size calldata. Show selected amounts and separate no-route responses from service, access, authentication and rate-limit failures. No conclusion is inferred about the other 70 skipped balances without their amounts.
- Add the four requested market statistics to Overview, using existing-app definitions: protocol NFT backing × AERO/USDC price; AERO/USDC price; AERO per iAERO market peg; minted LIQ supply × LIQ/USDC price.
- Inject the LIQ/USDC pool through public configuration. Compare pool type, token order, reserves, decimals and supply at a common finalized block on both providers. The deployed Aero ABI uses `POOL_TYPE()` with `V2_VOLATILE`, not the old `stable()` boolean. Read `getReserves()` as its actual uint256 tuple.
- Use integer arithmetic through calculation and format only for display. Retain partial metrics independently; unavailable/expired values stay unknown and never block legacy claims or withdrawals. Label spot-price, backing and minted-supply scopes explicitly. Market metrics require no additional 0x requests.
- Keep all edits in local staging. No original-app change, production publish, owner transaction or independent-review acceptance is implied.

## 26 October 2026 — circulating LIQ, larger type and mobile usability

- Correct the capitalization basis to the existing dashboard's circulating definition: minted supply minus unvested LIQ and treasury-held LIQ. Use the legacy vault's treasury link, the vester's immutable LIQ link and actual stream totals/vesting at the common finalized timestamp. Keep vested-but-unclaimed allocations circulating. Validate funding/deductions; an unknown or inconsistent exclusion leaves the cap unavailable rather than using minted supply as a fallback.
- Keep the established visual design while increasing shared typography with rem units, stronger muted colours and more line spacing. Use 12px as the smallest tested meaningful label at default size, with 14–16px explanations/body copy. Preserve decorative artwork separately from readable information. Render chart callouts in HTML so their text does not shrink with the chart SVG.
- Make controls at least 44px, primary actions larger, and phone inputs at least 16px. Allow form rows, long labels, tablet navigation and grid children to wrap/shrink. Check internal clipping as well as document overflow; hiding page overflow must not conceal broken cards.
- Give phone dialogs a full-width sheet, sticky title/close control, safe-area spacing and available-viewport height. Remove nested reward/sweep scroll areas. Keep keyboard focus trapping, Escape and restoration, and use preventScroll when restoring focus.
- Point the live hero toward available wallet/reward functionality while retaining all deployment gates. Explain metric definitions and circulating-supply deductions in a disclosure usable on touch screens.
- Pause automatic display reads while hidden and refresh on visibility. Retain sender receipt reconciliation and persistent transaction journaling. Defer the sweep UI module until opened and provide a recoverable load-failure screen with access to previous rewards.
- Retain local-only author testing, no push or publication. Chrome touch/short-viewport checks are scoped separately from physical-device/iOS acceptance; sampled contrast does not imply full accessibility certification.

## 26 October 2026 — feature comparison and protocol yield history

- Compare the old public site and local source with the staged app, then perform a second sweep against the reviewed new vault/stream/AutoVault clients and contracts. Keep Rift as the single cross-chain purchase flow, including existing order continuity. Separate necessary restorations from deployment gates and optional additions.
- Add the owner's requested persistent protocol-income ledger and current pending view locally. Read registered VRM ClaimFees/ClaimIncentives events, verify successful canonical receipts, token ID and manager registration at the event block, and retain every positive claim. Collect historical/current gauges so leaving a gauge does not erase its fees. Keep pending and received figures separate from funded-staker income.
- Store immutable claim facts and observations as separate SQLite rows with an optimistic revision check and durable atomic commit. Preserve exact token units; ignore runtime data in source control. Retain and migrate the first local format rather than overwriting it. A server restart cannot reset history to zero; corrupt/conflicting data fails visibly.
- Value received canonical USDC exactly. Retain other received token units without inventing historical USDC prices. Current quotes and explicitly configured WETH aliases are display estimates for pending income; never use them to rewrite past received values.
- Annualise a complete rolling week with weekly compounding. Require the exact historical boundary, verified capital basis, recipient/price/chain coverage and a suitable backing-flow basis. A pending-data outage does not invalidate otherwise complete receipt-based income. Missing or incomplete reads remain unknown and never gate principal or claims.
- Compare Base and Ethereum with Alchemy/Infura at their common finalized block; retain Robinhood's accepted pending-second-provider scope. Re-scan earlier history when adding independent coverage. Detect newly allocated unsupported chains instead of declaring aggregate completeness.
- Keep the recorder and all data local. It may read and persist public chain facts; it has no signing keys and sends no transactions. Production storage/hosting and all release gates remain separate.


## 26 October 2026 — accepted feature sweep and shared multi-chain history

[DECISION] Implement the owner's accepted restoration list inside this local stage. Keep the production frontend and six reviewed protocol client files unchanged. Reuse the prior Rift engine and order key; imported backups are recovery-only. Use the selected injected/WalletConnect provider across the app and native Rift so a separate wallet request cannot change the payment account. The public WalletConnect project ID supplied by the owner is configuration, not a private key.

[DECISION] Restore native LIQ management, exact partial legacy exits and actual full funded history rather than treating a rolling selection/public hint as complete. The two-provider census found 2,028 funded token/week pairs and 21 AutoVault harvest epochs at its recorded head; all direct rewards remain claimable independently of pricing/spam filters.

[DECISION] Stage new AERO/NFT intake, LIQ emissions previews, continuous USDC staking, replacement AutoVault, transition and collateral adapters behind accepted runtime/address/link readback. Undeployed addresses stay unavailable. Mandatory emissions, protected NFT outputs, transfer restrictions, allowance targets and principal/reward separation follow the reviewed clients/contracts. New adapters have author verification only.

[DECISION] Use a read-only scheduled Worker and durable D1 for globally shared production protocol history. Rehearse locally with persistent D1; do not publish while the owner is optimising locally. Public requests cannot trigger collection or mutate history. Keep private RPC endpoints server-side, wallet/order data outside this ledger, and immutable facts paginated/exportable. Use lease/revision checks and rollback to reject overlapping/expired collectors. A local restart waits for the prior lease rather than bypassing it; cached observations are not proof of a fresh collection.

[DECISION] Count Base, Ethereum and Robinhood pending rewards and show their separate values/coverage. Native ETH aliases are economic equivalents for token-unit APY only; original receipt identities are retained. Freeze validated historical claim valuations independently of current quotes. Read every chain back to a shared finalized cutoff for APY and the exact week boundary. Keep a numerical rate unavailable for a partial week, single-provider allocated chain, missing price or changed capital basis.

[UNVERIFIED] Robinhood still lacks independent second-provider route acceptance. User-facing contracts are not deployed. Full conversion/bridge/delivery/funding receipt ingestion and flow-adjusted APY for changing backing remain pending; the interface leaves those stages/rates unknown. Physical phone pairing, actual payments/owner-wallet/fork acceptance and independent sequential review are separate from these author checks.


## 26 October 2026 — repeated audit remediation, local only

The owner authorised fixing all findings and repeated fix/test/audit rounds. Preserve the audited snapshot and report; retain the six reviewed clients byte-for-byte. Support the real LIQ registry bound and permissionless retired-token recovery with bounded work and fail-closed known-retired checks. Treat raw receipts as immutable facts and recovered metadata/provider evidence as append-only assessments. Freeze archive exports at collection row boundaries and bind them to NFT 1584’s configured identity. Optional service/read failures do not decide unrelated exit capabilities, and configured-but-unverifiable positions make totals partial.

Provide production routing as an unlaunched native Node adapter with explicit HTTPS app/history origins, read-only provider configuration, a local-build publication guard and no embedded credentials. The owner’s local-stage/no-push instruction remains in effect. Provider/fork/owner/phone/production operations acceptance and previously documented unsupported revenue/flow-adjusted stages remain open. No independent review, READY or actual payout is inferred from author tests. Full report: artifacts/audit-remediation/REPORT.md.

## 26 October 2026 — staked LIQ and LIQ yield follow-up

The owner identified missing staked LIQ in Portfolio and requested the existing live-site LIQ yield on Overview. Show a separate LIQ position with unlock state and existing management controls; never add LIQ units to iAERO principal. Use only three summary reads, independently of reward registry/metadata/caps. Preserve stale/account-failure protections.

Carry over the published-forecast **APR** method (8% net LIQ share, 52 weeks), label the source’s publication date, validate a seven-day freshness limit and convert USD forecasts to USDC using a validated reference. Keep the estimate separate from actual-received, compounded protocol APY. A missing feed/price/total must not disable unrelated claims/exits. The observed first-party forecast remains dated 21 October; future freshness depends on publishing a new forecast. Local testing only; all previous release/owner/provider gates remain open.

## 26 October 2026 — Portfolio yield visibility

Add LIQ and iAERO yield cards below Portfolio holdings, preserving balances as the first view. Reuse the Overview LIQ component and the protocol-history data hook, and share the funded staking APR calculation with Earn. Keep funded staking APR, forecast-based LIQ APR, and gross protocol earned/received APYs distinctly labelled. Do not invent a rate for the undeployed new staking stream or bypass historical/provider coverage. Existing management routes remain unchanged; all work stays local before review/publication.

## 26 October 2026 — visual audit follow-up

Apply the eleven accepted visual recommendations in the local stage. Keep the orbital artwork and palette; improve reading size and information priority. Present claims before principal withdrawal, show natural-height cards, keep persistent sweep review controls, and reset scroll/focus at each review step. Use generation badges for legacy/current/pending positions. Keep unknowns visible, LIQ units separate from iAERO principal, funded APR separate from gross protocol APY, and forecast date/age beside LIQ APR. Readable amount summaries always retain an accessible exact amount; inputs and transaction minima retain their original bigints. All reviewed clients, backend, restored Rift logic and compiled Worker remain unchanged. This is local author verification; existing independent, deployment, provider, owner and production gates remain open.

Closing visual review: retain the two-provider rule when the primary RPC returns 429; record the actual-read failure separately from passing mocked UI checks. Keep both visual source-pack revisions immutable. The final 320px healthy status strip uses a fixed control layout.

## 27 October 2026 — earned yield and observed-period APY

The owner requested earned income in iAERO APY and annualisation over the actual N-day period until a complete week exists. They explicitly chose “Show a provisional all-chain estimate” while Robinhood has only one read provider. Apply this to Overview, Portfolio and historical views through one shared calculation. Keep gross earned, actually received and funded staking rates distinct. Preserve strict independent weekly fields and all existing deployment/route/signing acceptance gates.

Use pending-token growth plus interval claims, with token-unit reconciliation before current-price valuation, so a claim does not erase or double count earned income and price changes alone do not create yield. Annualise using exact elapsed seconds, then use a rolling seven-day interval automatically. Require priced complete observations and claims through the common finalized cutoff, stable capital and complete scoped history. The origin is the latest configured chain-history start or first usable complete priced observation; the current shared origin is 22 October at 02:12:11 UTC, not NFT creation 53 minutes earlier. Label shorter windows and unconfirmed chain coverage explicitly. Missing or inconsistent evidence remains unavailable.

Keep immutable provisional boundary IDs distinct from independently verified ones; failed attempts append retry facts. Preserve the earliest usable all-chain baseline in D1 and publish reports only after durable commit. Existing history is retained exactly. Serve the local compiled frontend from port 4317 using the persistent shared Worker at 4319; production publication remains pending. These are author checks only, with no independent, physical-phone, owner-wallet or fork acceptance inferred.

## 27 October 2026 — shared production history and missing reward valuations

The owner reiterated that yield history must be global for production, then reported a 6,716.57 USDC subtotal and unavailable earned APY despite roughly 10k earned. All token quantities were present; eight Base valuations were missing. Live probing found successful quotes for some assets and explicit stock-token trading refusals for others. The former implementation repeated quote requests separately for current, aligned and reference-unit observations and had no durable recent-price recovery.

Use one pricer per collection and preserve price provenance in immutable shared D1 observations. An informational market reference may use a sufficiently liquid direct canonical-USDC pair after identity checks; it does not imply trading permission. Reuse a saved price only within the configured 30-minute bound, preserving its original time across restarts and applying it to the current quantity. Show provenance/age and report missing-price coverage to monitoring. Do not invent a 10k total, turn unknowns into zero or relax claims, swap, provider or release controls.

The prepared production design is a scheduled Worker with persistent D1 and a shared public read API; the current instance remains local. Production must import the exact existing archive before collection, prove new durable observations and cross-visitor results, and run with this Mac off. The frontend production guard refuses a loopback history origin. Publishing the database/Worker, tested backups/alerts, production origins and preservation of the existing quote upstream remain concrete pre-launch work. No cloud publication is authorised by the local staging instruction.

## 27 October 2026 — accepted branded dashboard and parallel audit repairs

The owner approved the simpler Overview layout while asking to retain the original branding and visuals, and explicitly requested fixes in parallel. Keep the existing orbital SVG, colours, Manrope type and surrounding navigation. Put actual principal, staked LIQ and selected personal reward review before protocol detail. Keep gross protocol income, personally claimable tokens, forecast APR and funded staking APR distinct; never add the protocol NFT’s income to a wallet’s reward estimate. Unread LIQ rewards remain explicitly separate. Existing claim, withdrawal, sweep, Rift and gated new-contract reviews remain the execution paths.

Move long yield explanations and history behind one additional disclosure, preserving their content and controls. Render dust with a less-than threshold and exact accessible value; transaction amounts remain bigints. Pause automatic refresh while explicit reward discovery is in progress, preserve its requested scope, and retain account/chain cancellation. Resolve native API callers from their socket or an explicitly trusted ingress chain. Bind the real earned-price observation time and expire only the affected pending/earned display, preserving fresh received income and unrelated principal/claim controls.

All changes remain local author work. The local shared Worker is rebuilt with the new optional report fields; no schema migration or immutable fact rewrite is required. Parallel implementation/testing is not independent sequential release acceptance. Production publication/import, verified deployment manifest, owner/fork/physical-phone acceptance and outstanding provider/operations gates remain open.
