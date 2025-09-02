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

// CoinGecko with API key
const COINGECKO_KEY = process.env.NEXT_PUBLIC_COINGECKO_API_KEY;

if (!COINGECKO_KEY) {
  console.error('Missing NEXT_PUBLIC_ALCHEMY_KEY');
}

async function getPoolPrice(poolAddress: string, token0Decimals = 18, token1Decimals = 18) {
  const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
  const [reserves0, reserves1] = await pool.getReserves();
  
  const r0 = Number(ethers.formatUnits(reserves0, token0Decimals));
  const r1 = Number(ethers.formatUnits(reserves1, token1Decimals));
  
  return { r0, r1, ratio: r1 / r0 };
}

async function getLIQPrice() {  // No parameters here
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
    // Use CoinGecko Pro API with your key
    const cgUrl = new URL('https://pro-api.coingecko.com/api/v3/simple/price');
    cgUrl.searchParams.append('ids', 'aerodrome-finance,ethereum,usd-coin');
    cgUrl.searchParams.append('vs_currencies', 'usd');
    cgUrl.searchParams.append('include_24hr_change', 'true');
    cgUrl.searchParams.append('x_cg_pro_api_key', COINGECKO_KEY!);

    const [cgResponse, iaeroPoolData, liqPoolData] = await Promise.all([
      // Fetch from CoinGecko with API key
      fetch(cgUrl.toString())
        .then(r => r.json())
        .catch(err => {
          console.error('CoinGecko fetch failed:', err);
          return { 
            'aerodrome-finance': { usd: 2.0, usd_24h_change: 0 },
            'ethereum': { usd: 4000, usd_24h_change: 0 },
            'usd-coin': { usd: 1.0, usd_24h_change: 0 }
          };
        }),
      
      // iAERO/AERO pool ratio
      getPoolPrice(IAERO_AERO_POOL, 18, 18),
      
      // LIQ/USDC pool (USDC has 6 decimals on Base)
      getLIQPrice()
    ]);

    const aeroUsd = cgResponse['aerodrome-finance']?.usd || 2.0;
    const aeroChange = cgResponse['aerodrome-finance']?.usd_24h_change || 0;
    const ethUsd = cgResponse['ethereum']?.usd || 4000;
    const usdcUsd = cgResponse['usd-coin']?.usd || 1.0;
    
    // Calculate iAERO price (check token order in pool)
    const iaeroUsd = aeroUsd * iaeroPoolData.ratio;
    
    // LIQ price in USDC (verify token order)
    const liqUsd = await getLIQPrice();

    return {
      aeroUsd,
      aeroChange24h: aeroChange,
      iaeroUsd,
      liqUsd,
      ethUsd,
      usdcUsd,
      updatedAt: Date.now()
    };
  } catch (error) {
    console.error('Price fetch failed:', error);
    // Fallback prices
    return {
      aeroUsd: 2.0,
      aeroChange24h: 0,
      iaeroUsd: 2.0,
      liqUsd: 0.1,
      ethUsd: 4000,
      usdcUsd: 1.0,
      updatedAt: Date.now()
    };
  }
}

// Optional: Add caching to reduce API calls
const CACHE_DURATION = 30000; // 30 seconds
let priceCache: { data: any; timestamp: number } | null = null;

export async function fetchPricesWithCache() {
  if (priceCache && Date.now() - priceCache.timestamp < CACHE_DURATION) {
    return priceCache.data;
  }
  
  const data = await fetchPricesClient();
  priceCache = { data, timestamp: Date.now() };
  return data;
}
