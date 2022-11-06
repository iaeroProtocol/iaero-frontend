import { ethers } from "ethers";

// Pool addresses
const IAERO_AERO_POOL = "0x08d49DA370ecfFBC4c6Fdd2aE82B2D6aE238Affd";
const LIQ_USDC_POOL = "0x8966379fCD16F7cB6c6EA61077B6c4fAfECa28f4";

const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint256, uint256, uint256)",
];

// Use Alchemy for RPC
const ALCHEMY_KEY = process.env.NEXT_PUBLIC_ALCHEMY_KEY;

if (!ALCHEMY_KEY) {
  console.error('Missing NEXT_PUBLIC_ALCHEMY_KEY');
}

const provider = new ethers.JsonRpcProvider(
  `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`
);

async function getPoolPrice(poolAddress: string, token0Decimals = 18, token1Decimals = 18) {
  const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
  const [reserves0, reserves1] = await pool.getReserves();
  
  const r0 = Number(ethers.formatUnits(reserves0, token0Decimals));
  const r1 = Number(ethers.formatUnits(reserves1, token1Decimals));
  
  return { r0, r1, ratio: r1 / r0 };
}

async function getLIQPrice() {
  const pool = new ethers.Contract(LIQ_USDC_POOL, POOL_ABI, provider);
  
  const [token0, token1] = await Promise.all([
    pool.token0(),
    pool.token1()
  ]);
  
  const [reserves0, reserves1] = await pool.getReserves();
  
  const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".toLowerCase();
  
  if (token0.toLowerCase() === USDC_ADDRESS) {
    const usdcReserve = Number(ethers.formatUnits(reserves0, 6));
    const liqReserve = Number(ethers.formatUnits(reserves1, 18));
    return usdcReserve / liqReserve;
  } else {
    const liqReserve = Number(ethers.formatUnits(reserves0, 18));
    const usdcReserve = Number(ethers.formatUnits(reserves1, 6));
    return usdcReserve / liqReserve;
  }
}

async function getAEROPriceFromPool() {
  try {
    const USDC_AERO_POOL = "0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d";
    
    const pool = new ethers.Contract(USDC_AERO_POOL, POOL_ABI, provider);
    
    const [token0, token1] = await Promise.all([
      pool.token0(),
      pool.token1()
    ]);
    
    const [reserves0, reserves1] = await pool.getReserves();
    
    const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".toLowerCase();
    const AERO_ADDRESS = "0x940181a94A35A4569E4529A3CDfB74e38FD98631".toLowerCase();
    
    // Since it's USDC/AERO pool:
    // token0 should be USDC, token1 should be AERO
    if (token0.toLowerCase() === USDC_ADDRESS && token1.toLowerCase() === AERO_ADDRESS) {
      const usdcReserve = Number(ethers.formatUnits(reserves0, 6));  // USDC has 6 decimals
      const aeroReserve = Number(ethers.formatUnits(reserves1, 18)); // AERO has 18 decimals
      return usdcReserve / aeroReserve; // Price of 1 AERO in USDC
    } else if (token1.toLowerCase() === USDC_ADDRESS && token0.toLowerCase() === AERO_ADDRESS) {
      // Just in case the order is reversed
      const aeroReserve = Number(ethers.formatUnits(reserves0, 18));
      const usdcReserve = Number(ethers.formatUnits(reserves1, 6));
      return usdcReserve / aeroReserve;
    } else {
      console.error('Unexpected token pair in USDC/AERO pool');
      return null;
    }
  } catch (error) {
    console.error('Failed to get AERO price from pool:', error);
    return null;
  }
}

export async function fetchPricesClient() {
  try {
    let aeroUsd = 0;
    let aeroChange = 0;
    
    // Try CoinGecko proxy first
    try {
      const cgResponse = await fetch('https://iaero-price-proxy.iaero.workers.dev')
        .then(r => r.json());
      
      aeroUsd = cgResponse['aerodrome-finance']?.usd || 0;
      aeroChange = cgResponse['aerodrome-finance']?.usd_24h_change || 0;
    } catch (err) {
      console.warn('CoinGecko proxy failed, will use pool price');
    }
    
    // If no price from CoinGecko, get from USDC/AERO pool
    if (!aeroUsd || aeroUsd === 0) {
      const poolPrice = await getAEROPriceFromPool();
      if (poolPrice) {
        aeroUsd = poolPrice;
        console.log('Using AERO price from USDC/AERO pool:', aeroUsd);
      }
    }
    
    // Get other pool data
    const [iaeroPoolData, liqUsd] = await Promise.all([
      getPoolPrice(IAERO_AERO_POOL, 18, 18),
      getLIQPrice()
    ]);
    
    // Calculate iAERO price
    const iaeroUsd = aeroUsd * iaeroPoolData.ratio;

    return {
      aeroUsd,
      aeroChange24h: aeroChange,
      iaeroUsd,
      liqUsd,
      ethUsd: 4000,
      usdcUsd: 1.0,
      updatedAt: Date.now()
    };
  } catch (error) {
    console.error('Price fetch failed, attempting pool fallback:', error);
    
    // Last resort: try to at least get pool price
    const poolPrice = await getAEROPriceFromPool();
    
    return {
      aeroUsd: poolPrice || 0,
      aeroChange24h: 0,
      iaeroUsd: poolPrice || 0,
      liqUsd: 0.1,
      ethUsd: 4000,
      usdcUsd: 1.0,
      updatedAt: Date.now()
    };
  }
}

// Keep the cache function as-is
const CACHE_DURATION = 30000;
let priceCache: { data: any; timestamp: number } | null = null;

export async function fetchPricesWithCache() {
  if (priceCache && Date.now() - priceCache.timestamp < CACHE_DURATION) {
    return priceCache.data;
  }
  
  const data = await fetchPricesClient();
  priceCache = { data, timestamp: Date.now() };
  return data;
}
