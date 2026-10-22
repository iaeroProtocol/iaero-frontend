// src/lib/amm.ts
import { ethers } from "ethers";
import { getContractAddress } from "@/components/contracts/addresses";

// Server-side only (API routes). Prefer the server key: the public browser key is domain-allowlisted, and
// Alchemy refuses requests from the edge, which carry no browser Origin (HTTP 403). Resolved per call, because
// on Cloudflare Pages runtime variables exist only inside a request, not when this module is first loaded.
export function serverRpc(): { url: string; source: 'RPC_URL' | 'ALCHEMY_KEY' | 'NEXT_PUBLIC_ALCHEMY_KEY' | 'public' } {
  if (process.env.RPC_URL) return { url: process.env.RPC_URL, source: 'RPC_URL' };
  if (process.env.ALCHEMY_KEY) return { url: `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`, source: 'ALCHEMY_KEY' };
  if (process.env.NEXT_PUBLIC_ALCHEMY_KEY) return { url: `https://base-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_KEY}`, source: 'NEXT_PUBLIC_ALCHEMY_KEY' };
  return { url: 'https://mainnet.base.org', source: 'public' };
}

// Aero pools (iAERO and LIQ liquidity moved from Aerodrome on 2026-10-22; the old pools are drained)
const IAERO_AERO_POOL = getContractAddress("iAERO_AERO_Pool", 8453);
const LIQ_USDC_POOL   = getContractAddress("LIQ_USDC_Pool", 8453);
const USDC_AERO_POOL  = getContractAddress("AERO_USDC_Pool", 8453);

const BASE_USDC = (process.env.BASE_USDC ||
  "0x833589fCD6EDb6E08f4c7C32D4f71b54bdA02913").toLowerCase();

// ✅ Solidly/Aerodrome style ABI (uint256 reserves)
const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast)",
] as const;

const ERC20_ABI = ["function decimals() view returns (uint8)"] as const;

function provider() {
  // v6 provider, fine in Node and browser; we’ll call from API route (server)
  return new ethers.JsonRpcProvider(serverRpc().url, 8453, { staticNetwork: true });
}

async function decimalsOf(addr: string, p = provider()): Promise<number> {
  try {
    const erc = new ethers.Contract(addr, ERC20_ABI, p);
    return Number(await erc.decimals());
  } catch {
    // Sensible defaults if a token is weird (still better than failing hard)
    return 18;
  }
}

function asNum(x: bigint, d: number) {
  return Number(ethers.formatUnits(x, d));
}

/** Price(BASE in QUOTE) using reserves from a v2/solidly style pool */
async function priceFromPool(poolAddr: string, base: string, quote: string): Promise<number> {
  const p = provider();
  const pair = new ethers.Contract(poolAddr, POOL_ABI, p);

  const [t0, t1] = await Promise.all([pair.token0(), pair.token1()]);
  const { reserve0, reserve1 } = await pair.getReserves();

  if (reserve0 === 0n || reserve1 === 0n) return 0;

  const d0 = await decimalsOf(t0, p);
  const d1 = await decimalsOf(t1, p);

  const baseLc  = base.toLowerCase();
  const quoteLc = quote.toLowerCase();
  const t0Lc    = (t0 as string).toLowerCase();
  const t1Lc    = (t1 as string).toLowerCase();

  // price(BASE in QUOTE) = QUOTE / BASE
  if (t0Lc === baseLc && t1Lc === quoteLc) return asNum(reserve1, d1) / asNum(reserve0, d0);
  if (t0Lc === quoteLc && t1Lc === baseLc) return asNum(reserve0, d0) / asNum(reserve1, d1);

  // pair mismatch
  return 0;
}

/** iAERO in AERO (peg reference) */
export async function getPegIAEROinAERO(): Promise<number> {
  const iaero = getContractAddress("iAERO", 8453);
  const aero  = getContractAddress("AERO", 8453);
  return priceFromPool(IAERO_AERO_POOL, iaero, aero);
}

export async function getAEROinUSDC(): Promise<number> {
  const aero = getContractAddress("AERO", 8453);
  return priceFromPool(USDC_AERO_POOL, aero, BASE_USDC);
}

/** LIQ in USDC (≈ USD) */
export async function getLIQinUSDC(): Promise<number> {
  const p = provider();
  const pair = new ethers.Contract(LIQ_USDC_POOL, POOL_ABI, p);
  const [t0, t1] = await Promise.all([pair.token0(), pair.token1()]);
  const { reserve0, reserve1 } = await pair.getReserves();
  if (reserve0 === 0n || reserve1 === 0n) return 0;

  const [d0, d1] = await Promise.all([decimalsOf(t0, p), decimalsOf(t1, p)]);
  const t0Lc = (t0 as string).toLowerCase();
  const t1Lc = (t1 as string).toLowerCase();

  // We want: price(non‑USDC token in USDC) = USDC / nonUSDC
  if (t0Lc === BASE_USDC) {
    // token0 = USDC, token1 = LIQ
    return asNum(reserve0, d0) / asNum(reserve1, d1);
  } else if (t1Lc === BASE_USDC) {
    // token1 = USDC, token0 = LIQ
    return asNum(reserve1, d1) / asNum(reserve0, d0);
  }
  return 0;
}
