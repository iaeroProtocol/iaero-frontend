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

export async function fetchPricesClient() {
  try {
    // Use your Cloudflare Worker proxy instead of calling CoinGecko directly
    const [cgResponse, iaeroPoolData, liqUsd] = await Promise.all([
      // Fetch from your Worker proxy (no API key needed in frontend)
      fetch('https://iaero-price-proxy.iaero.workers.dev')
        .then(r => r.json())
        .catch(err => {
          console.error('Price proxy fetch failed:', err);
          return { 
            'aerodrome-finance': { usd: 1.15, usd_24h_change: 0 }
          };
        }),
      
      // iAERO/AERO pool ratio
      getPoolPrice(IAERO_AERO_POOL, 18, 18),
      
      // LIQ price from pool
      getLIQPrice()
    ]);

    const aeroUsd = cgResponse['aerodrome-finance']?.usd || 1.15;
    const aeroChange = cgResponse['aerodrome-finance']?.usd_24h_change || 0;
    
    // Calculate iAERO price
    const iaeroUsd = aeroUsd * iaeroPoolData.ratio;

    return {
      aeroUsd,
      aeroChange24h: aeroChange,
      iaeroUsd,
      liqUsd,
      ethUsd: 4000, // You can add ETH to your worker if needed
      usdcUsd: 1.0,
      updatedAt: Date.now()
    };
  } catch (error) {
    console.error('Price fetch failed:', error);
    return {
      aeroUsd: 1.15,
      aeroChange24h: 0,
      iaeroUsd: 1.0,
      liqUsd: 0.15,
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
