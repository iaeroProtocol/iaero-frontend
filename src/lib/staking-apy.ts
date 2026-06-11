// Single source of truth for the iAERO staking APY.
//
// The Rewards panel and the Auto-Vault must show the SAME number: the Auto-Vault
// stakes its iAERO into the very same epoch staking distributor at the same
// per-iAERO rate, so a vault depositor earns exactly the protocol-wide staking
// APY. Previously the Auto-Vault derived its own figure from the last 4 epochs
// of vault USDC ÷ vault TVL, which is noisy (a single big/small or missed
// harvest swings it) and could disagree with the Rewards panel. Both now call
// computeStakingApyPct().

import { parseAbi, type Address, type PublicClient } from 'viem';

const DIST_ABI = parseAbi(['function totalStaked() view returns (uint256)']);
const E18 = 10n ** 18n;
const toE18 = (num: number) => BigInt(Math.round(num * 1e18));

export const DEFAULT_REWARDS_JSON_URL =
  process.env.NEXT_PUBLIC_REWARDS_JSON_URL ||
  'https://raw.githubusercontent.com/iaeroProtocol/ChainProcessingBot/main/data/estimated_rewards_usd.json';

/** Weekly USD distributed to stakers, scaled 1e18, from the rewards JSON feed. */
export async function fetchStakersWeeklyUSD_1e18(
  url: string = DEFAULT_REWARDS_JSON_URL,
): Promise<bigint> {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`rewards json ${r.status}`);
  const j = await r.json();
  if (j?.stakersWeeklyUSD_1e18) return BigInt(j.stakersWeeklyUSD_1e18);
  // Older feed shape: gross estimate; stakers get ~80%.
  if (j?.estimatedWeeklyUSD_1e18) return (BigInt(j.estimatedWeeklyUSD_1e18) * 8000n) / 10000n;
  throw new Error('missing stakersWeeklyUSD');
}

/**
 * Protocol-wide iAERO staking APY as a percentage (e.g. 6.5 for 6.5%).
 *
 * APY = (stakersWeeklyUSD × 52) / (totalStaked × iAERO price). Returns `null`
 * when an input is unavailable (no price, missing distributor, feed error) and
 * `0` when there are no stakers — mirroring the Rewards panel's behaviour so the
 * two render identically.
 */
export async function computeStakingApyPct(params: {
  publicClient: PublicClient;
  distAddr: Address | undefined;
  iaeroUsd: number;
  rewardsUrl?: string;
}): Promise<number | null> {
  const { publicClient, distAddr, iaeroUsd, rewardsUrl } = params;
  if (!distAddr) return null;
  if (!isFinite(iaeroUsd) || iaeroUsd <= 0) return null;

  const stakersWeeklyUSD_1e18 = await fetchStakersWeeklyUSD_1e18(rewardsUrl);
  const totalStakedRaw = (await publicClient.readContract({
    address: distAddr,
    abi: DIST_ABI,
    functionName: 'totalStaked',
  })) as bigint;
  if (!totalStakedRaw || totalStakedRaw === 0n) return 0;

  const iaeroUsd_1e18 = toE18(iaeroUsd);
  const annualUSD_1e18 = stakersWeeklyUSD_1e18 * 52n;
  const tvlUSD_1e18 = (totalStakedRaw * iaeroUsd_1e18) / E18;
  if (tvlUSD_1e18 === 0n) return 0;
  const apyRatio_1e18 = (annualUSD_1e18 * E18) / tvlUSD_1e18;
  const apyPct_1e18 = apyRatio_1e18 * 100n;
  return Number(apyPct_1e18) / 1e18;
}
