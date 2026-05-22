# Auto-USDC Vault

Deposit iAERO once. Earn USDC weekly without lifting a finger.

The Auto-USDC Vault is a thin wrapper around the protocol's existing iAERO staking. It does three things you'd otherwise do manually:

1. **Auto-stakes** your iAERO into the EpochStakingDistributor on deposit.
2. **Auto-claims** all reward tokens (AERO, WETH, USDC, EIGEN, bribes, etc.) every Thursday.
3. **Auto-converts** every reward token to USDC via the same 0x aggregator the rewards page uses.

You get one clean USDC balance to claim — no juggling 20+ tokens per week, no manual swaps.

---

## How it works

```
You deposit iAERO  ────►  Vault stakes it in EpochStakingDistributor (instant)
                                                        │
        Every Thursday 00:00 UTC ──► keeper claims rewards ──► swaps everything to USDC
                                                        │
                                            USDC bucketed per epoch ◄────
                                                        │
                                        You click "Claim USDC" ◄──── (any time)
```

Your iAERO stake is yours alone — withdraw it any time, instantly, with no cooldown. Past USDC remains claimable even after you've withdrawn your principal.

## Key properties

| | |
|---|---|
| **Deposit asset** | iAERO |
| **Reward asset** | USDC (after keeper conversion) |
| **Withdrawal lockup** | None — instant |
| **Reward cadence** | Weekly, every Thursday 00:00 UTC |
| **Claim model** | Pull (you click claim, no auto-push) |
| **Past USDC after withdraw** | Stays claimable |
| **Share token** | None — shares tracked by the vault contract |
| **Vault address (Base)** | [`0xFE5c…9c774`](https://basescan.org/address/0xFE5c929677D97723dc822C86c93c7e2D1B59c774) |

---

## Using the vault

### 1. Deposit

1. Have iAERO in your wallet. ([Get iAERO →](LINK_TO_LOCK_PAGE))
2. Open the **Auto-Vault** tab.
3. Enter the amount and click **Deposit**.
4. Approve iAERO spending (one-time per wallet), then confirm the deposit tx.

Your iAERO is now staked and earning rewards. You'll see your position in the dashboard.

### 2. Claim USDC

Each Thursday around 01:00 UTC the keeper processes the previous epoch's rewards. After it runs, you'll see a green **"Pending USDC ready to claim"** banner at the top of the tab.

Click **Claim USDC**. One signature, USDC lands in your wallet. Done.

You can claim:
- Whenever you want — there's no deadline.
- Multiple epochs at once — the contract handles it in one tx.
- Even after withdrawing your iAERO principal.

### 3. Withdraw

1. Click the **Withdraw** toggle.
2. Enter how much iAERO you want back (or **MAX**).
3. Confirm — iAERO returns to your wallet immediately, no cooldown.

Any pending USDC stays claimable. You don't lose past earnings by withdrawing.

---

## Reward eligibility — the epoch-snapshot rule

The underlying distributor uses a balance-at-epoch-start snapshot model. The Auto-Vault inherits this exactly:

- **Your share of an epoch's rewards is based on your vault balance at that epoch's boundary (Thursday 00:00 UTC).**
- Deposit *before* Thursday 00:00 UTC → you earn for the upcoming week.
- Deposit *after* Thursday 00:00 UTC → you earn starting from the *next* Thursday.

This means there's no incentive to time your deposit mid-week — the protocol-level snapshot decides.

### Worked example

You deposit 100 iAERO on Wednesday 23:55 UTC.
- 5 minutes later, the Thursday epoch boundary triggers.
- The snapshot at that boundary includes your 100 iAERO.
- You earn a pro-rata share of the next week's USDC rewards.

If you'd instead deposited Thursday 00:05 UTC, you'd earn rewards starting the *following* Thursday.

---

## Frequently asked questions

**Q: Do I need to do anything between claims?**
No. The keeper runs weekly and converts everything to USDC. Just click claim when you want your USDC.

**Q: What happens if a reward token can't be swapped (no liquidity)?**
The keeper attempts up to 3 retry sweeps with progressively higher slippage tolerance. Anything genuinely unswappable stays in the vault until an admin can resolve it manually. Your iAERO principal is never at risk.

**Q: Can I lose my iAERO?**
No. iAERO is permanently protected by the vault contract — the admin role cannot rescue it. Withdrawals are always 1:1.

**Q: What about USDC?**
Same — USDC is protected from admin rescue. Only your `claimUSDC` can move it out, and only your pro-rata share for each epoch you held shares in.

**Q: Who runs the keeper?**
A protocol-operated bot. If the keeper ever fails to run, admin can re-attempt manually. The contract supports re-opening already-finalized epochs in case late rewards land.

**Q: Is this audited?**
The contract was through 4 internal audit rounds (7 fixes applied) plus a 50-test Foundry suite (45 unit + 5 fork). 256-run fuzz on the pro-rata math. Multisig is `DEFAULT_ADMIN_ROLE`. Source verified on [Basescan](https://basescan.org/address/0xFE5c929677D97723dc822C86c93c7e2D1B59c774).

**Q: How is APR calculated?**
Last 4 epochs of USDC harvested into the vault, annualized, divided by current TVL in USD. It's an estimate — actual returns vary with Aerodrome reward levels and vault TVL.

**Q: Can I deposit on behalf of someone else?**
Not in the current contract — only `msg.sender` can deposit for themselves. This prevents griefing.

**Q: Why pull-claim instead of auto-pushing USDC to my wallet?**
Pulling lets you control claim timing (tax year, gas costs). Most major DeFi vaults (Curve, Convex, Yearn v2) use the same pattern. The frontend surfaces a prominent banner so you never miss a claim.

**Q: Do I get a receipt token (like stiAERO)?**
No — the Auto-Vault deliberately doesn't issue a transferable receipt token. Your position is stored as `sharesOf[your_address]` in the vault contract directly. This is by design: USDC entitlement is decided by your balance at each Thursday epoch snapshot, so transferring a receipt token mid-week would create ambiguous reward ownership. To withdraw, just call `withdraw()` — no token to burn first. If you want a transferable position, the regular **Stake** tab (which uses the EpochStakingDistributor directly) issues **stiAERO**, an ERC20 receipt.

**Q: Can I use my Auto-Vault position as collateral elsewhere?**
Not directly, since there's no transferable token. If you need on-chain composability, use the Stake tab — that gives you stiAERO which is a standard ERC20.

---

## Technical reference

### Contract

- **Vault**: `0xFE5c929677D97723dc822C86c93c7e2D1B59c774`
- **iAERO**: `0x81034Fb34009115F215f5d5F564AAc9FfA46a1Dc`
- **USDC**: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- **Upstream**: `EpochStakingDistributor` `0x781A80fA817b5a146C440F03EF8643f4aca6588A`
- **Swap router**: `RewardSwapper` `0x25F11F947309df89bF4D36DA5D9A9fb5F1E186c1`
- **Admin role**: Treasury multisig `0x1039CB48254a3150fC604d4B9ea08F66f4739D37`

### Key functions

| Function | Caller | Notes |
|---|---|---|
| `deposit(uint256)` | user | Auto-stakes downstream |
| `withdraw(uint256)` | user | Always open, even when paused |
| `claimUSDC(uint256[] epochs)` | user | Up to 50 epochs per call |
| `previewUSDC(address, uint256)` | view | Per-epoch pending |
| `previewUSDCMany(address, uint256[])` | view | Batch pending lookup |
| `harvest(...)` | keeper | Per-epoch claim + swap orchestration |
| `pause()` / `unpause()` | admin | Withdraw/claim remain open under pause |
| `unfinalize(uint256)` | admin | Re-open epoch if late rewards arrive |
| `rescue(address, address, uint256)` | admin | iAERO, USDC, stiAERO permanently protected |

### Events

```solidity
event Deposited (address indexed user, uint256 amount);
event Withdrawn (address indexed user, uint256 amount);
event Harvested (uint256 indexed epoch, uint256 usdcGained, bool finalized);
event Claimed   (address indexed user, uint256 indexed epoch, uint256 usdc);
```

### Security model

- All user-facing actions (`deposit`, `withdraw`, `claimUSDC`) are `nonReentrant`.
- Withdraw + claim are NOT pause-gated — emergency exit always available.
- Vault doesn't NAV-mark: shares are 1:1 with deposited iAERO, no oracle.
- First-depositor share inflation is defused by a 1-iAERO seed deposit at deploy.
- Admin cannot rescue iAERO, USDC, or stiAERO (downstream receipt token).
- Keeper role can be revoked + replaced via multisig at any time.

---

## Comparing to direct staking

If you stake iAERO directly into the EpochStakingDistributor (the "Stake" tab), you get the same underlying rewards — but you'd then need to:

1. Click "claim" for each reward token, each epoch.
2. Manually swap each one to USDC via the rewards page.
3. Approve each token to the swapper.

The Auto-Vault does all of this for you, automatically, weekly. There's no APR difference — same pool of rewards, just less clicking.

The **one** trade-off: with direct staking you can claim raw tokens (e.g. keep your AERO). With the Auto-Vault, everything becomes USDC. Pick the tab that matches your preference.
