// src/contracts/hooks/useRewardTokens.ts
import { useState, useCallback, useEffect } from 'react';
import { ethers } from 'ethers';
import { useProtocol } from '../../contexts/ProtocolContext';
import { usePrices } from '../../contexts/PriceContext';
import { getContractAddress } from '../../contracts/addresses';

interface RewardToken {
  address: string;
  symbol: string;
  decimals: number;
  name: string;
  balance: string;
  pendingAmount: string;
  valueUSD: number;
}

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function balanceOf(address) view returns (uint256)"
];

// Same default set you use in useStaking.ts
const DEFAULT_CLAIM_TOKENS_BY_CHAIN: Record<number, string[]> = {
  8453: [
    getContractAddress('AERO', 8453)!,
    getContractAddress('WETH', 8453) ?? "",
    getContractAddress('USDC', 8453) ?? "",
  ].filter(Boolean),
};

async function fetchEpochTokensViaRewardsSugar(contracts: any, limit = 200): Promise<string[]> {
  try {
    const rs = contracts.RewardsSugar;
    if (!rs) return [];
    const rows = await rs.epochsLatest(limit, 0);
    const seen = new Set<string>();
    for (const row of rows) {
      const bribes = row.bribes ?? [];
      const fees   = row.fees ?? [];
      for (const b of bribes) if (b?.token) seen.add(b.token.toLowerCase());
      for (const f of fees)   if (f?.token) seen.add(f.token.toLowerCase());
    }
    return Array.from(seen);
  } catch { return []; }
}

async function getEpochClaimTokenList(contracts: any, chainId: number): Promise<string[]> {
  const viaSugar = await fetchEpochTokensViaRewardsSugar(contracts);
  if (viaSugar.length) return viaSugar;
  return DEFAULT_CLAIM_TOKENS_BY_CHAIN[chainId] ?? [];
}

export const useRewardTokens = () => {
  const { getContracts, account, chainId } = useProtocol();
  const { prices } = usePrices();
  const [rewardTokens, setRewardTokens] = useState<RewardToken[]>([]);
  const [loading, setLoading] = useState(false);

  const loadRewardTokens = useCallback(async () => {
    if (!account) return;

    setLoading(true);
    try {
      const contracts = await getContracts();
      const distributor = contracts.stakingDistributor;
      const provider = contracts.provider;
      const resolvedChainId = chainId ?? provider?.network?.chainId ?? 8453;

      if (!distributor) { setRewardTokens([]); return; }

      // ---- EPOCH PATH ----
      if (typeof distributor.currentEpoch === 'function' && typeof distributor.previewClaim === 'function') {
        const tokens = await getEpochClaimTokenList(contracts, resolvedChainId);

        const WEEK = 7n * 24n * 60n * 60n;
        const nowEpoch: bigint = await distributor.currentEpoch();
        const prev = nowEpoch - WEEK;

        const out: RewardToken[] = [];

        for (const address of tokens) {
          // pending = prev + current
          const [p0, p1] = await Promise.all([
            distributor.previewClaim(account, address, prev).catch(() => 0n),
            distributor.previewClaim(account, address, nowEpoch).catch(() => 0n),
          ]);
          const pendingRaw = (p0 ?? 0n) + (p1 ?? 0n);
          if (address === ethers.ZeroAddress) {
            const decimals = 18;
            const symbol = 'ETH';
            const name = 'Ethereum';
            const formattedPending = ethers.formatUnits(pendingRaw, decimals);
            const price = prices.ETH?.usd || 0;
            out.push({
              address,
              symbol,
              decimals,
              name,
              balance: '0', // wallet ETH balance not required here
              pendingAmount: formattedPending,
              valueUSD: parseFloat(formattedPending) * price,
            });
            continue;
          }

          // ERC-20 metadata & wallet balance
          const token = new ethers.Contract(address, ERC20_ABI, provider);
          let [symbol, decimals, name, balance] = ['UNK', 18, 'Unknown', 0n] as any;
          try {
            [symbol, decimals, name, balance] = await Promise.all([
              token.symbol(),
              token.decimals(),
              token.name(),
              token.balanceOf(account),
            ]);
          } catch {
            // leave safe defaults
          }

          const formattedPending = ethers.formatUnits(pendingRaw, decimals);

          // pricing (best-effort)
          let priceUSD = 0;
          if (symbol === 'AERO') priceUSD = prices.AERO?.usd || 0;
          else if (symbol === 'iAERO') priceUSD = prices.iAERO?.usd || 0;
          else if (symbol === 'LIQ') priceUSD = prices.LIQ?.usd || 0;
          else if (symbol === 'USDC') priceUSD = prices.USDC?.usd || 1;

          out.push({
            address,
            symbol,
            decimals,
            name,
            balance: ethers.formatUnits(balance, decimals),
            pendingAmount: formattedPending,
            valueUSD: parseFloat(formattedPending) * priceUSD,
          });
        }

        setRewardTokens(out);
        return;
      }

      // ---- LEGACY PATH (if you ever point back to a streaming distributor) ----
      const tokenAddresses: string[] = await distributor.getRewardTokens();
      const [pendingTokens, pendingAmounts] = await distributor.getPendingRewards(account);

      const out: RewardToken[] = await Promise.all(
        tokenAddresses.map(async (address: string, index: number) => {
          const pending = pendingAmounts[index] || 0n;

          if (address === ethers.ZeroAddress) {
            const formattedPending = ethers.formatEther(pending);
            return {
              address,
              symbol: 'ETH',
              decimals: 18,
              name: 'Ethereum',
              balance: '0',
              pendingAmount: formattedPending,
              valueUSD: parseFloat(formattedPending) * (prices.ETH?.usd || 0),
            };
          }

          const token = new ethers.Contract(address, ERC20_ABI, provider);
          const [symbol, decimals, name, balance] = await Promise.all([
            token.symbol(),
            token.decimals(),
            token.name(),
            token.balanceOf(account),
          ]);

          let priceUSD = 0;
          if (symbol === 'AERO') priceUSD = prices.AERO?.usd || 0;
          else if (symbol === 'iAERO') priceUSD = prices.iAERO?.usd || 0;
          else if (symbol === 'LIQ') priceUSD = prices.LIQ?.usd || 0;
          else if (symbol === 'USDC') priceUSD = prices.USDC?.usd || 1;

          const formattedPending = ethers.formatUnits(pending, decimals);

          return {
            address,
            symbol,
            decimals,
            name,
            balance: ethers.formatUnits(balance, decimals),
            pendingAmount: formattedPending,
            valueUSD: parseFloat(formattedPending) * priceUSD,
          };
        })
      );

      setRewardTokens(out);
    } catch (error) {
      console.error('Failed to load reward tokens:', error);
      setRewardTokens([]);
    } finally {
      setLoading(false);
    }
  }, [account, chainId, getContracts, prices]);

  useEffect(() => {
    loadRewardTokens();
    const interval = setInterval(loadRewardTokens, 30_000);
    return () => clearInterval(interval);
  }, [loadRewardTokens]);

  return { rewardTokens, loading, refresh: loadRewardTokens };
};
