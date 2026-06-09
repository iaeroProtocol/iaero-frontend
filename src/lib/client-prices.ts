import { ethers } from "ethers";

/* ========================== Constants ========================== */

const IAERO_AERO_POOL = "0x08d49DA370ecfFBC4c6Fdd2aE82B2D6aE238Affd"; // iAERO/AERO pool
const LIQ_USDC_POOL   = "0x8966379fCD16F7cB6c6EA61077B6c4fAfECa28f4";

const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".toLowerCase();
const AERO_ADDRESS = "0x940181a94A35A4569E4529A3CDfB74e38FD98631".toLowerCase();

const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112, uint112, uint32)",
];

/* ========================== Provider ========================== */

const ALCHEMY_KEY = process.env.NEXT_PUBLIC_ALCHEMY_KEY;

// If key is missing, use a reliable public RPC so the app still works
const RPC_URL =
  (ALCHEMY_KEY && `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`) ||
  "https://mainnet.base.org";

const provider = new ethers.JsonRpcProvider(RPC_URL);

/* ========================== Helpers ========================== */

function num(x: bigint, decimals: number) {
  return Number(ethers.formatUnits(x, decimals));
}

function isPositiveFinite(n: number) {
  return typeof n === "number" && isFinite(n) && n > 0;
}

/** Generic V2-like reserve fetcher (decimals must be supplied per token) */
async function getPoolReserves(
  poolAddress: string,
  dec0 = 18,
  dec1 = 18
): Promise<{ r0: number; r1: number; token0: string; token1: string }> {
  const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
  const [t0, t1] = await Promise.all([pool.token0(), pool.token1()]);
  const [res0, res1] = await pool.getReserves();
  return {
    token0: String(t0).toLowerCase(),
    token1: String(t1).toLowerCase(),
    r0: num(res0, dec0),
    r1: num(res1, dec1),
  };
}

/** AERO price in USDC from a known USDC/AERO pair (handles either token order). */
async function getAEROPriceFromPool(): Promise<number | null> {
  try {
    const USDC_AERO_POOL = "0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d";
    const pool = new ethers.Contract(USDC_AERO_POOL, POOL_ABI, provider);

    const [t0, t1] = await Promise.all([pool.token0(), pool.token1()]);
    const token0 = String(t0).toLowerCase();
    const token1 = String(t1).toLowerCase();
    const [res0, res1] = await pool.getReserves();

    if (token0 === USDC_ADDRESS && token1 === AERO_ADDRESS) {
      // price = USDC per AERO
      const usdcReserve = num(res0, 6);
      const aeroReserve = num(res1, 18);
      const px = usdcReserve / aeroReserve;
      return isPositiveFinite(px) ? px : null;
    } else if (token0 === AERO_ADDRESS && token1 === USDC_ADDRESS) {
      const aeroReserve = num(res0, 18);
      const usdcReserve = num(res1, 6);
      const px = usdcReserve / aeroReserve;
      return isPositiveFinite(px) ? px : null;
    } else {
      console.error("Unexpected token pair in USDC/AERO pool");
      return null;
    }
  } catch (e) {
    console.error("Failed to get AERO price from pool:", e);
    return null;
  }
}

/**
 * Compute the **AERO per iAERO** peg ratio from the iAERO/AERO pool.
 * Works regardless of token order:
 * - If token0=iAERO, token1=AERO => ratio = r1/r0 (AERO per iAERO)
 * - If token0=AERO,  token1=iAERO => ratio = r0/r1 (AERO per iAERO)
 */
async function getAeroPerIaeroRatio(): Promise<number | null> {
  try {
    const pool = new ethers.Contract(IAERO_AERO_POOL, POOL_ABI, provider);
    const [t0, t1] = await Promise.all([pool.token0(), pool.token1()]);
    const token0 = String(t0).toLowerCase();
    const token1 = String(t1).toLowerCase();

    // both tokens have 18 decimals
    const [res0, res1] = await pool.getReserves();
    const r0 = num(res0, 18);
    const r1 = num(res1, 18);
    if (!isPositiveFinite(r0) || !isPositiveFinite(r1)) return null;

    // Identify which side is AERO; the other is iAERO
    if (token0 === AERO_ADDRESS) {
      // token0=AERO, token1=iAERO => AERO per iAERO = r0 / r1
      const ratio = r0 / r1;
      return isPositiveFinite(ratio) ? ratio : null;
    } else if (token1 === AERO_ADDRESS) {
      // token0=iAERO, token1=AERO => AERO per iAERO = r1 / r0
      const ratio = r1 / r0;
      return isPositiveFinite(ratio) ? ratio : null;
    } else {
      // Pool not the expected pair (shouldn’t happen)
      return null;
    }
  } catch (e) {
    console.error("Failed to get iAERO/AERO ratio:", e);
    return null;
  }
}

/** LIQ price in USDC from LIQ/USDC pool (handles either token order). */
async function getLIQPrice(): Promise<number | null> {
  try {
    const pool = new ethers.Contract(LIQ_USDC_POOL, POOL_ABI, provider);
    const [t0, t1] = await Promise.all([pool.token0(), pool.token1()]);
    const token0 = String(t0).toLowerCase();
    const token1 = String(t1).toLowerCase();
    const [res0, res1] = await pool.getReserves();

    if (token0 === USDC_ADDRESS) {
      const usdcReserve = num(res0, 6);
      const liqReserve = num(res1, 18);
      const px = usdcReserve / liqReserve;
      return isPositiveFinite(px) ? px : null;
    } else if (token1 === USDC_ADDRESS) {
      const liqReserve = num(res0, 18);
      const usdcReserve = num(res1, 6);
      const px = usdcReserve / liqReserve;
      return isPositiveFinite(px) ? px : null;
    } else {
      console.error("Unexpected token pair in LIQ/USDC pool");
      return null;
    }
  } catch (e) {
    console.error("Failed to get LIQ price:", e);
    return null;
  }
}

/* ========================== Public API ========================== */

export async function fetchPricesClient() {
  try {
    let aeroUsd = 0;
    let aeroChange = 0;

    // 1) Try your Cloudflare Worker / CG proxy (cheap & fast)
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      
      const r = await fetch("https://api.iaero.finance", {
        signal: controller.signal
      });
      clearTimeout(timeout);
      
      if (r.ok) {
        const j = await r.json();
        aeroUsd = Number(j?.["aerodrome-finance"]?.usd) || 0;
        aeroChange = Number(j?.["aerodrome-finance"]?.usd_24h_change) || 0;
      }
    } catch {
      // swallow and fall back
      console.warn("CoinGecko proxy failed, will use pool price");
    }

    // 2) Fallback to USDC/AERO pool if needed
    if (!isPositiveFinite(aeroUsd)) {
      const poolPrice = await getAEROPriceFromPool();
      if (isPositiveFinite(poolPrice || 0)) aeroUsd = poolPrice as number;
    }

    // 3) iAERO peg ratio from iAERO/AERO pool (direction-safe)
    let aeroPerIaero = await getAeroPerIaeroRatio();

    // 4) LIQ from LIQ/USDC pool
    let liqUsd = await getLIQPrice();

    // Finalize outputs with safe fallbacks
    if (!isPositiveFinite(aeroUsd)) aeroUsd = 1; // conservative non-zero to keep UI functional
    if (!isPositiveFinite(aeroPerIaero || 0)) aeroPerIaero = 1; // peg fallback
    if (!isPositiveFinite(liqUsd || 0)) liqUsd = 0.1;

    const iaeroUsd = aeroUsd * (aeroPerIaero as number);
    const payload = {
      aeroUsd,
      aeroChange24h: aeroChange,
      iaeroUsd,              // guaranteed > 0 if aeroUsd > 0
      liqUsd: liqUsd as number,
      ethUsd: 4000,
      usdcUsd: 1.0,
      updatedAt: Date.now(),
    };

    return payload;
  } catch (error) {
    console.error("Price fetch failed, using pool + peg fallbacks:", error);

    const poolPrice = await getAEROPriceFromPool();

    const aeroUsd = isPositiveFinite(poolPrice || 0) ? (poolPrice as number) : 1;
    return {
      aeroUsd,
      aeroChange24h: 0,
      iaeroUsd: aeroUsd, // peg fallback
      liqUsd: 0.1,
      ethUsd: 4000,
      usdcUsd: 1.0,
      updatedAt: Date.now(),
    };
  }
}

/* ========================== Tiny Cache ========================== */

const CACHE_DURATION = 30_000; // 30s
let priceCache: { data: any; timestamp: number } | null = null;

export async function fetchPricesWithCache() {
  if (priceCache && Date.now() - priceCache.timestamp < CACHE_DURATION) {
    return priceCache.data;
  }
  const data = await fetchPricesClient();
  priceCache = { data, timestamp: Date.now() };
  return data;
}

