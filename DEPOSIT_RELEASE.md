# AeroStakeDeposit frontend — 29 October 2026

The Deposit page connects the separately deployed `AeroStakeDeposit` at
`0xD5E4a7869D1189caa617749d483aaD95Af370c70`. It also replaces the previous
closed intake panels under Get iAERO. Existing claims, LIQ staking, sweeps,
compounding and Rift routes retain their contract targets.

## Identity and availability

`config/aero-deposit.json` pins the runtime and handoff source hashes. The
runtime matched Sourcify's exact creation/runtime record and the approved Base
read provider. The original source SHA-256 is
`49596ea30591c83651714285a90f6257df299141731e79cfa606bcf2169d2fdf`.
The refusal table remains the exact version 3, revision 5 file, SHA-256
`adef8af81541ed5c366749dfd5437e752626d7e85b73eded1a06c621c27c90f6`.

Deposit verification is independent of `newStackReady`. An unavailable future
USDC stream cannot enable or disable the separate verified deposit route.
Fresh `checkAeroDeposit` results control availability; codes 1, 2, 3, 4 and 21
close it. Missing balances or approvals alone do not close the protocol.
There is no opening date or enable flag in frontend configuration.

The observed mainnet state was closed: the vault's depositor was zero and the
new contract did not have both mint roles. The site must continue to show the
closed state until the Safe's reviewed go-live process opens it. No real Safe
transaction, signature, minter grant, deposit or protocol setting was sent by
this work. Keeper acceptance, the primary/protocol NFT census, predecessor
conversion checks and owner go-live A/B remain separate operations gates.

## Execution and review decisions

- AERO bounds are checked before amount-specific RPC calls. Only new AERO is
  approved, for the exact amount. Insufficient nonzero allowances are reset.
- NFT enumeration is paged. Each deposit approves only its selected NFT.
  Decaying stakes explicitly become permanent; the whole NFT enters the vault.
- Reviews are bound to the account, Base chain, input, refusal version and a
  two-minute freshness window. Wallet changes discard the visible review.
- Every execution obtains fresh checks and preview values after approval,
  simulates, estimates gas with a 25% allowance and refuses above 16M gas.
- A LIQ decrease after approval requires another explicit review. A zero LIQ
  minimum is never submitted. A zero preview has generic no-LIQ guidance,
  rather than an invented assertion that the supply cap has been reached.
- Receipt events determine received amounts. A confirmed deposit whose
  details cannot be read stays confirmed, with its transaction link and no
  automatic replay. Failed stake operations are rechecked for current guidance;
  failed rechecks retain a generic refusal without invented fields.
- All 27 refusal codes and ordered chain variants use the supplied table.
  AERO amounts preserve 18 decimals and chain times are displayed in UTC.
- The deployed escrow's `uint48 end` decodes as a JavaScript number in viem.
  The initial fork replay caught this; normalization now accepts safe
  nonnegative integers, alongside bigint and exact decimal strings.
- Protocol TVL and backing-per-iAERO include separately held deposit NFTs,
  deduplicating the primary. An incomplete vault read yields an unavailable
  total. Allocation percentages and existing yield history keep their explicit
  primary-position scope. Historical D1 facts and the scheduled recorder are
  unchanged.

## Validation and its bounds

Author-context validation covers 765 unit/integration checks, typecheck,
production build, 33 compiled deposit browser checks at 1440/390/320px, and
existing claim, compound, retry, wallet identity and Rift regressions.
The six protected protocol clients and all 47 restored files remain
byte-identical to baseline `68c7cbc`.

The isolated Base fork is pinned to block 53,237,830,
`0xb52ab8c55b90e6c8479602d015115946e574f0089614f58f5186d7506bc371a0`.
The existing contract fork suite is bound to the published deposit address
and passes 24/24 without skips. The actual frontend execution helper passes
eight cases: closed state, fork-only go-live setup, AERO deposit, backing
census, permanent NFT, decaying NFT, post-approval pause and post-approval
halving with fresh consent. It uses real deployed token balances and event
outputs. Local ETH funding, Safe impersonation and one predecessor-counter
injection are explicitly recorded; token balances and runtime code are not
overridden in that frontend replay.

These tests are author-run evidence, not independent acceptance or Safe
signature-threshold acceptance. See the release evidence manifest for the
final source commit, compiled Worker/cache replay, public asset identity,
hosted readback and deployment identities. Reproduction commands are in
README.md; do not point the fork scripts at a shared development chain.
