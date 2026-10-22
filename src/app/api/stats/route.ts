// src/app/api/stats/route.ts
import { NextResponse } from 'next/server';
export const runtime = 'edge';
export const revalidate = 300;
import { ethers } from 'ethers';
import { getLIQinUSDC, getPegIAEROinAERO, getAEROinUSDC, serverRpc } from '@/lib/amm';
import { safeErrorText } from '@/lib/safe-error';

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

// Legacy PermalockVault (still the iAERO minter's accounting), the tokens, and the backing on Aero.
// On 2026-10-22 the protocol's veAERO left the vault and was converted 1:1 into Aero stake #1584; until the new
// sAERO vault holds it, backing is read from that stake (override with PROTOCOL_AERO_STAKE_ID).
const CONTRACTS = {
  vault: '0x180DAB53968e599Dd43CF431E27CB01AA5C37909',
  iAERO: '0x81034Fb34009115F215f5d5F564AAc9FfA46a1Dc',
  LIQ: '0x7ee8964160126081cebC443a42482E95e393e6A8',
  AERO: '0x3f5bF3EdAc59d650D8fDf9657a71F2f904A3a4Ee',
  aeroVotingEscrow: '0xBF7977E1521e9a3032bf7243Ee4712f311f13915',
};
const PROTOCOL_AERO_STAKE_ID = BigInt(process.env.PROTOCOL_AERO_STAKE_ID || '1584');
const ESCROW_ABI = ['function staked(uint256) view returns (tuple(uint128 amount, uint48 end, bool isPermanent))'];

// RPC: resolved per request by serverRpc() (lib/amm.ts): RPC_URL, else ALCHEMY_KEY, else the public browser key.

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
    const rpc = serverRpc();
    const provider = new ethers.JsonRpcProvider(rpc.url);
    
    // Initialize contracts
    const vault = new ethers.Contract(CONTRACTS.vault, VAULT_ABI, provider);
    const iAERO = new ethers.Contract(CONTRACTS.iAERO, TOKEN_ABI, provider);
    const liq = new ethers.Contract(CONTRACTS.LIQ, TOKEN_ABI, provider);
    const escrow = new ethers.Contract(CONTRACTS.aeroVotingEscrow, ESCROW_ABI, provider);

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
      iAeroPeg,
      protocolStake
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
      getPegIAEROinAERO(),
      escrow.staked(PROTOCOL_AERO_STAKE_ID).catch(() => null)
    ]);
    const backingAero: bigint = protocolStake ? BigInt(protocolStake.amount ?? protocolStake[0]) : 0n;

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
    
    // Primary TVL is the value of the AERO actually backing iAERO (the Aero stake); the vault's deposit counter
    // (totalAEROLocked) is kept below for reference.
    const backingFloat = parseFloat(ethers.formatEther(backingAero));
    const totalTVL = backingAero > 0n ? backingFloat * aeroPrice : tvlComponents.aeroLocked;

    // Format response
    const stats = {
      timestamp: now,
      backing: {
        aeroStakeId: PROTOCOL_AERO_STAKE_ID.toString(),
        aeroStaked: ethers.formatEther(backingAero),
        isPermanent: protocolStake ? Boolean(protocolStake.isPermanent ?? protocolStake[2]) : null,
        votingEscrow: CONTRACTS.aeroVotingEscrow,
      },
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
    // Sanitized: an RPC_URL with a key in it would otherwise be logged and returned (viem errors repeat it).
    console.error('Stats API error:', safeErrorText(error));
    
    // Return cached data if available, even if stale
    if (cache) {
      return NextResponse.json({ ...cache, stale: true });
    }

    // Return error response
    return NextResponse.json(
      { 
        error: 'Failed to fetch stats',
        message: safeErrorText(error),
        // Which key source was used (never the key) and the RPC's own reply, to tell an allowlisted key from a
        // missing one.
        rpcSource: serverRpc().source,
        rpcReply: safeErrorText((error as any)?.info?.responseBody ?? '').slice(0, 200)
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
