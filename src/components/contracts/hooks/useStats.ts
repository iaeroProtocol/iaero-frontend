// src/hooks/useStats.ts
import { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { getLIQinUSDC, getPegIAEROinAERO, getAEROinUSDC } from '@/lib/amm';
import { getContractAddress } from '../addresses';

// Contract ABIs (minimal)
const VAULT_ABI = [
  'function vaultStatus() view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool,bool)',
  'function totalLIQMinted() view returns (uint256)',
  'function getCurrentEmissionRate() view returns (uint256)',
  'function totalAEROLocked() view returns (uint256)',
  'function totalIAEROMinted() view returns (uint256)'
];

const TOKEN_ABI = [
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)'
];

// Contract addresses
const CONTRACTS = {
  vault: getContractAddress('vault', 8453), // or whatever chain ID
  iAERO: getContractAddress('iAERO', 8453),
  LIQ: getContractAddress('LIQ', 8453),
  AERO: getContractAddress('AERO', 8453),
  veAERO: getContractAddress('VeAERO', 8453)
};

const RPC_URL = process.env.NEXT_PUBLIC_ALCHEMY_RPC_URL || 'https://mainnet.base.org';

export function useStats() {
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchStats() {
      try {
        setLoading(true);
        setError(null);

        // Initialize provider
        const provider = new ethers.JsonRpcProvider(RPC_URL);
        
        // Initialize contracts
        const vault = new ethers.Contract(CONTRACTS.vault, VAULT_ABI, provider);
        const iAERO = new ethers.Contract(CONTRACTS.iAERO, TOKEN_ABI, provider);
        const liq = new ethers.Contract(CONTRACTS.LIQ, TOKEN_ABI, provider);

        // Fetch all data in parallel
        const [
          vaultStatus,
          totalLIQMinted,
          currentEmissionRate,
          totalAEROLocked,
          totalIAEROMinted,
          iAeroSupply,
          liqSupply,
          aeroPrice,
          liqPrice,
          iAeroPeg
        ] = await Promise.all([
          vault.vaultStatus(),
          vault.totalLIQMinted().catch(() => 0n),
          vault.getCurrentEmissionRate().catch(() => ethers.parseEther('1')),
          vault.totalAEROLocked().catch(() => 0n),
          vault.totalIAEROMinted().catch(() => 0n),
          iAERO.totalSupply(),
          liq.totalSupply(),
          getAEROinUSDC(),
          getLIQinUSDC(),
          getPegIAEROinAERO()
        ]);

        // Calculate derived values
        const HALVING_STEP = ethers.parseEther('5000000');
        const currentHalvingIndex = totalLIQMinted / HALVING_STEP;
        const nextHalvingThreshold = (currentHalvingIndex + 1n) * HALVING_STEP;
        const untilNextHalving = nextHalvingThreshold - totalLIQMinted;

        // Calculate TVL
        const aeroLockedFloat = parseFloat(ethers.formatEther(totalAEROLocked));
        const iAeroSupplyFloat = parseFloat(ethers.formatEther(iAeroSupply));
        const liqSupplyFloat = parseFloat(ethers.formatEther(liqSupply));
        
        const tvlComponents = {
          aeroLocked: aeroLockedFloat * aeroPrice,
          iAeroMarketCap: iAeroSupplyFloat * aeroPrice * iAeroPeg,
          liqMarketCap: liqSupplyFloat * liqPrice
        };
        
        const totalTVL = tvlComponents.aeroLocked;

        // Build stats object
        const statsData = {
          timestamp: Date.now(),
          vault: {
            totalAEROLocked: ethers.formatEther(totalAEROLocked),
            totalIAEROMinted: ethers.formatEther(totalIAEROMinted),
            totalUserDeposits: ethers.formatEther(vaultStatus[0]),
            totalProtocolOwned: ethers.formatEther(vaultStatus[1]),
            primaryNFTId: vaultStatus[4].toString(),
            primaryNFTBalance: ethers.formatEther(vaultStatus[5]),
            primaryNFTVotingPower: ethers.formatEther(vaultStatus[6]),
            additionalNFTCount: vaultStatus[8].toString(),
            needsRebase: vaultStatus[9],
            needsMerge: vaultStatus[10]
          },
          tokens: {
            iAERO: {
              totalSupply: ethers.formatEther(iAeroSupply),
              circulatingSupply: ethers.formatEther(iAeroSupply),
              peg: iAeroPeg,
              price: aeroPrice * iAeroPeg,
              priceFormatted: `$${(aeroPrice * iAeroPeg).toFixed(4)}`
            },
            LIQ: {
              totalSupply: ethers.formatEther(liqSupply),
              totalMinted: ethers.formatEther(totalLIQMinted),
              maxSupply: '100000000',
              price: liqPrice,
              priceFormatted: `$${liqPrice.toFixed(4)}`
            },
            AERO: {
              locked: ethers.formatEther(totalAEROLocked),
              price: aeroPrice,
              priceFormatted: `$${aeroPrice.toFixed(4)}`
            }
          },
          emissions: {
            currentRate: ethers.formatEther(currentEmissionRate),
            currentHalvingIndex: currentHalvingIndex.toString(),
            nextHalvingAt: ethers.formatEther(nextHalvingThreshold),
            untilNextHalving: ethers.formatEther(untilNextHalving),
            halvingProgress: {
              current: ethers.formatEther(totalLIQMinted),
              next: ethers.formatEther(nextHalvingThreshold),
              percentage: Number((totalLIQMinted * 10000n) / nextHalvingThreshold) / 100
            }
          },
          tvl: {
            total: totalTVL,
            totalFormatted: `$${totalTVL.toLocaleString(undefined, { 
              minimumFractionDigits: 2, 
              maximumFractionDigits: 2 
            })}`,
            breakdown: {
              aeroLocked: tvlComponents.aeroLocked,
              aeroLockedFormatted: `$${tvlComponents.aeroLocked.toLocaleString(undefined, { 
                minimumFractionDigits: 2, 
                maximumFractionDigits: 2 
              })}`,
              iAeroMarketCap: tvlComponents.iAeroMarketCap,
              iAeroMarketCapFormatted: `$${tvlComponents.iAeroMarketCap.toLocaleString(undefined, { 
                minimumFractionDigits: 2, 
                maximumFractionDigits: 2 
              })}`,
              liqMarketCap: tvlComponents.liqMarketCap,
              liqMarketCapFormatted: `$${tvlComponents.liqMarketCap.toLocaleString(undefined, { 
                minimumFractionDigits: 2, 
                maximumFractionDigits: 2 
              })}`
            }
          },
          protocol: {
            feeRate: '5',
            treasuryLiqShare: '20',
            minDeposit: '0.01',
            maxSingleLock: '10000000',
            maxLockDuration: '126144000'
          }
        };

        setStats(statsData);
      } catch (err) {
        console.error('Failed to fetch stats:', err);
        setError(err instanceof Error ? err.message : 'Failed to fetch stats');
      } finally {
        setLoading(false);
      }
    }

    fetchStats();
    // Refresh every 30 seconds
    const interval = setInterval(fetchStats, 30000);
    return () => clearInterval(interval);
  }, []);

  return { stats, loading, error };
}

// Example usage in a component:
/*
function StatsDisplay() {
  const { stats, loading, error } = useStats();
  
  if (loading) return <div>Loading stats...</div>;
  if (error) return <div>Error: {error}</div>;
  if (!stats) return null;
  
  return (
    <div>
      <h2>TVL: {stats.tvl.totalFormatted}</h2>
      <p>AERO Price: {stats.tokens.AERO.priceFormatted}</p>
      <p>LIQ Price: {stats.tokens.LIQ.priceFormatted}</p>
    </div>
  );
}
*/
