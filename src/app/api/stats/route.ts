// src/app/api/stats/route.ts
import { NextResponse } from 'next/server';
export const runtime = 'edge';
export const dynamic = 'force-static';
export const revalidate = 300;
import { ethers } from 'ethers';
import { getLIQinUSDC, getPegIAEROinAERO, getAEROinUSDC } from '@/lib/amm';

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

// Contract addresses - update these with your actual addresses
const CONTRACTS = {
  vault: '0x877398Aea8B5cCB0D482705c2D88dF768c953957',
  iAERO: '0x81034Fb34009115F215f5d5F564AAc9FfA46a1Dc', // UPDATE THIS
  LIQ: '0x7ee8964160126081cebC443a42482E95e393e6A8',     // UPDATE THIS
  AERO: '0x940181a94a35a4569e4529a3cdfb74e38fd98631',   // UPDATE THIS
  veAERO: '0xeBf418Fe2512e7E6bd9b87a8F0f294aCDC67e6B4' // UPDATE THIS
};

// RPC URL - use environment variable
const RPC_URL = process.env.RPC_URL || 'https://mainnet.base.org';

// Cache configuration
let cache: any = null;
let cacheTimestamp = 0;
const CACHE_DURATION = 30 * 1000; // 30 seconds

export async function GET() {
  try {
    // Check cache
    const now = Date.now();
    if (cache && (now - cacheTimestamp) < CACHE_DURATION) {
      return NextResponse.json(cache);
    }

    // Initialize provider
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    
    // Initialize contracts
    const vault = new ethers.Contract(CONTRACTS.vault, VAULT_ABI, provider);
    const iAERO = new ethers.Contract(CONTRACTS.iAERO, TOKEN_ABI, provider);
    const liq = new ethers.Contract(CONTRACTS.LIQ, TOKEN_ABI, provider);

    // Fetch vault status and prices in parallel
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
      getAEROinUSDC(),  // Get AERO price directly from USDC/AERO pool
      getLIQinUSDC(),
      getPegIAEROinAERO()
    ]);

    // Calculate derived values
    const HALVING_STEP = ethers.parseEther('5000000'); // 5M LIQ
    const currentHalvingIndex = totalLIQMinted / HALVING_STEP;
    const nextHalvingThreshold = (currentHalvingIndex + 1n) * HALVING_STEP;
    const untilNextHalving = nextHalvingThreshold - totalLIQMinted;

    // Calculate TVL components
    const aeroLockedFloat = parseFloat(ethers.formatEther(totalAEROLocked));
    const iAeroSupplyFloat = parseFloat(ethers.formatEther(iAeroSupply));
    const liqSupplyFloat = parseFloat(ethers.formatEther(liqSupply));
    
    // Calculate TVL
    const tvlComponents = {
      aeroLocked: aeroLockedFloat * aeroPrice,
      iAeroMarketCap: iAeroSupplyFloat * aeroPrice * iAeroPeg,
      liqMarketCap: liqSupplyFloat * liqPrice
    };
    
    // Primary TVL is the value of AERO locked in the vault
    const totalTVL = tvlComponents.aeroLocked;

    // Format response
    const stats = {
      timestamp: now,
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
        totalFormatted: `$${totalTVL.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        breakdown: {
          aeroLocked: tvlComponents.aeroLocked,
          aeroLockedFormatted: `$${tvlComponents.aeroLocked.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
          iAeroMarketCap: tvlComponents.iAeroMarketCap,
          iAeroMarketCapFormatted: `$${tvlComponents.iAeroMarketCap.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
          liqMarketCap: tvlComponents.liqMarketCap,
          liqMarketCapFormatted: `$${tvlComponents.liqMarketCap.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        }
      },
      protocol: {
        feeRate: '5',
        treasuryLiqShare: '20',
        minDeposit: '0.01',
        maxSingleLock: '10000000',
        maxLockDuration: '126144000' // 4 years in seconds
      }
    };

    // Update cache
    cache = stats;
    cacheTimestamp = now;

    // Return with CORS headers for browser access
    return NextResponse.json(stats, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60'
      }
    });

  } catch (error) {
    console.error('Stats API error:', error);
    
    // Return cached data if available, even if stale
    if (cache) {
      return NextResponse.json({ ...cache, stale: true });
    }

    // Return error response
    return NextResponse.json(
      { 
        error: 'Failed to fetch stats',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

// Optional: Handle OPTIONS for CORS preflight
export async function OPTIONS() {
  return new Response(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
