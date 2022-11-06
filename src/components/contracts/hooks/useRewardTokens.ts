import { useState, useCallback, useEffect } from 'react';
import { ethers } from 'ethers';
import { useProtocol } from '../../contexts/ProtocolContext';
import { usePrices } from '../../contexts/PriceContext';

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

export const useRewardTokens = () => {
  const { getContracts, account } = useProtocol();
  const { prices } = usePrices(); // Remove fetchTokenPrice
  const [rewardTokens, setRewardTokens] = useState<RewardToken[]>([]);
  const [loading, setLoading] = useState(false);

  const loadRewardTokens = useCallback(async () => {
    if (!account) return;
    
    setLoading(true);
    try {
      const contracts = await getContracts();
      const distributor = contracts.stakingDistributor;
      
      // Get all reward tokens from StakingDistributor
      const tokenAddresses = await distributor.getRewardTokens();
      
      // Get pending rewards for user
      const [pendingTokens, pendingAmounts] = await distributor.getPendingRewards(account);
      
      const tokens: RewardToken[] = await Promise.all(
        tokenAddresses.map(async (address: string, index: number) => {
          const pending = pendingAmounts[index] || 0n;
          
          if (address === ethers.ZeroAddress) {
            return {
              address,
              symbol: 'ETH',
              decimals: 18,
              name: 'Ethereum',
              balance: '0',
              pendingAmount: ethers.formatEther(pending),
              valueUSD: parseFloat(ethers.formatEther(pending)) * (prices.ETH?.usd || 0)
            };
          }
          
          const token = new ethers.Contract(address, ERC20_ABI, contracts.provider);
          const [symbol, decimals, name, balance] = await Promise.all([
            token.symbol(),
            token.decimals(),
            token.name(),
            token.balanceOf(account)
          ]);
          
          // Check if we have a price for this token
          let priceUSD = 0;
          if (symbol === 'AERO') priceUSD = prices.AERO?.usd || 0;
          else if (symbol === 'iAERO') priceUSD = prices.iAERO?.usd || 0;
          else if (symbol === 'LIQ') priceUSD = prices.LIQ?.usd || 0;
          else if (symbol === 'USDC') priceUSD = prices.USDC?.usd || 1;
          // For unknown tokens, default to 0 or you could add a client-side price fetch here
          else {
            console.warn(`No price data for token ${symbol} at ${address}`);
            priceUSD = 0;
          }
          
          const formattedPending = ethers.formatUnits(pending, decimals);
          
          return {
            address,
            symbol,
            decimals,
            name,
            balance: ethers.formatUnits(balance, decimals),
            pendingAmount: formattedPending,
            valueUSD: parseFloat(formattedPending) * priceUSD
          };
        })
      );
      
      setRewardTokens(tokens);
    } catch (error) {
      console.error('Failed to load reward tokens:', error);
    } finally {
      setLoading(false);
    }
  }, [account, getContracts, prices]);

  useEffect(() => {
    loadRewardTokens();
    const interval = setInterval(loadRewardTokens, 30000);
    return () => clearInterval(interval);
  }, [loadRewardTokens]);

  return { rewardTokens, loading, refresh: loadRewardTokens };
};