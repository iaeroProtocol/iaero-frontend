/* eslint-disable no-console */
import { NextResponse } from 'next/server';
export const runtime = 'edge';
export const dynamic = 'force-static';
export const revalidate = 300;

// viem (edge-friendly)
import { createPublicClient, http, getAddress, parseAbi } from 'viem';
import { base } from 'viem/chains';

// --- Your central address book (adjust import path to your monorepo)
import { CONTRACTS } from '@/components/contracts/addresses';

// Minimal pair ABI
const PAIR_ABI = parseAbi([
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]);

// Helper: compact numbers to plain JS number (we only need ~2-4 decimals client-side)
function toNumber(x: bigint, decimals = 18): number {
  if (x === 0n) return 0;
  const s = x.toString();
  if (decimals === 0) return Number(s);
  const pad = decimals - (s.length - 1);
  const whole = s.length > decimals ? s.slice(0, s.length - decimals) : '0';
  const frac = s.length > decimals ? s.slice(s.length - decimals) : '0'.repeat(decimals - s.length) + s;
  const f = `${whole}.${frac}`;
  return Number(f);
}

// Try DeFiLlama first (cache-friendly, no chain calls)
async function fetchLlamaPrices(chainPrefix: string, addrs: string[]) {
  const ids = addrs.map(a => `${chainPrefix}:${a}`).join(',');
  const url = `https://coins.llama.fi/prices/current/${ids}`;
  try {
    const r = await fetch(url, { next: { revalidate: 300 } });
    if (!r.ok) return {};
    const j = await r.json();
    const out: Record<string, number> = {};
    for (const a of addrs) {
      const key = `${chainPrefix}:${a.toLowerCase()}`;
      const p = j?.coins?.[key]?.price;
      if (typeof p === 'number' && p > 0) out[a.toLowerCase()] = p;
    }
    return out;
  } catch {
    return {};
  }
}

// Fallback: get price(base in quote) from a V2-like pair
async function dexPrice(publicClient: any, pair: `0x${string}`, baseAddr: `0x${string}`, quoteAddr: `0x${string}`) {
  try {
    const [t0, t1] = await Promise.all([
      publicClient.readContract({ address: pair, abi: PAIR_ABI, functionName: 'token0' }),
      publicClient.readContract({ address: pair, abi: PAIR_ABI, functionName: 'token1' }),
    ]);
    const [r0, r1] = await publicClient.readContract({
      address: pair, abi: PAIR_ABI, functionName: 'getReserves'
    }) as [bigint, bigint, number];

    const token0 = (t0 as string).toLowerCase();
    const token1 = (t1 as string).toLowerCase();
    const base = baseAddr.toLowerCase();
    const quote = quoteAddr.toLowerCase();

    // basic sanity
    if (base !== token0 && base !== token1) return 0;
    if (quote !== token0 && quote !== token1) return 0;

    const baseReserve  = base === token0 ? r0 : r1; // raw 18d assumption (Aero pairs)
    const quoteReserve = quote === token0 ? r0 : r1;
    // If USDC on Base is 6d, adjust here. We assume 18/6 for (AERO/WETH)/(USDC) on Aerodrome:
    const baseDec  = 18;
    const quoteDec = quote === CONTRACTS[8453].USDC?.toLowerCase() ? 6 : 18;

    const baseFloat  = toNumber(baseReserve, baseDec);
    const quoteFloat = toNumber(quoteReserve, quoteDec);
    if (baseFloat <= 0) return 0;

    return quoteFloat / baseFloat;
  } catch {
    return 0;
  }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const chainIdStr = searchParams.get('chainId') || '8453';
    const chainId = Number(chainIdStr);
    const addressesParam = searchParams.get('addresses') || '';
    const rawAddrs = addressesParam.split(',').map(s => s.trim()).filter(Boolean);
    if (!rawAddrs.length) {
      return NextResponse.json({ prices: {} });
    }

    // Normalize & dedupe
    const addrs: `0x${string}`[] = Array.from(
      new Set(
        rawAddrs
          .map(a => {
            try { return getAddress(a).toLowerCase() as `0x${string}`; }
            catch { return null; }
          })
          .filter(Boolean) as string[]
      )
    ) as `0x${string}`[];

    if (chainId !== 8453) {
      // Extend to other chains as you add support
      return NextResponse.json({ prices: Object.fromEntries(addrs.map(a => [a, 0])) });
    }

    const NET = CONTRACTS[8453];
    const USDC = NET.USDC!.toLowerCase() as `0x${string}`;
    const WETH = NET.WETH!.toLowerCase() as `0x${string}`;
    const AERO = NET.AERO!.toLowerCase() as `0x${string}`;

    // Public client (Edge-friendly)
    const rpcUrl = `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY || process.env.NEXT_PUBLIC_ALCHEMY_KEY}`;
    const client = createPublicClient({ chain: base, transport: http(rpcUrl) });

    // 1) Llama batch
    const llama = await fetchLlamaPrices('base', addrs);
    const out: Record<string, number> = { ...llama };

    // 2) DEX fallback for any missing
    const missing = addrs.filter(a => out[a] === undefined);

    // We use known pairs:
    // - AERO/USDC: price(AERO in USDC)
    // - WETH/USDC: price(WETH in USDC)
    // - For any token T:
    //    try T/USDC, then T/WETH -> then multiply by (WETH/USDC)
    // You can hardcode pair addresses you use on Base or read from factory if you prefer.
    // For simplicity, we’ll try factory.getPool(T, USDC, false/true) and likewise with WETH.
    const factory = {
      address: NET.PoolFactory as `0x${string}`,
      abi: parseAbi(['function getPool(address,address,bool) view returns (address)'])
    };

    async function getPool(x: `0x${string}`, y: `0x${string}`, stable: boolean) {
      try {
        const addr = await client.readContract({
          address: factory.address,
          abi: factory.abi,
          functionName: 'getPool',
          args: [x, y, stable],
        }) as `0x${string}`;
        return addr && addr !== '0x0000000000000000000000000000000000000000' ? (addr as `0x${string}`) : null;
      } catch { return null; }
    }

    // Precompute WETH/USDC and AERO/USDC references (volatile first, then stable)
    let wethUsdc = 0;
    for (const stab of [false, true]) {
      const p = await getPool(WETH, USDC, stab);
      if (p) { wethUsdc = await dexPrice(client, p, WETH, USDC); if (wethUsdc) break; }
    }
    let aeroUsdc = 0;
    for (const stab of [false, true]) {
      const p = await getPool(AERO, USDC, stab);
      if (p) { aeroUsdc = await dexPrice(client, p, AERO, USDC); if (aeroUsdc) break; }
    }
    // Seed bases
    if (out[WETH] === undefined && wethUsdc) out[WETH] = wethUsdc;
    if (out[AERO] === undefined && aeroUsdc) out[AERO] = aeroUsdc;
    if (out[USDC] === undefined) out[USDC] = 1.0;

    // For each missing token, try direct to USDC, then via WETH
    for (const t of missing) {
      if (out[t] !== undefined) continue;

      let px = 0;

      // direct T/USDC volatile then stable
      for (const stab of [false, true]) {
        const p = await getPool(t, USDC, stab);
        if (p) { px = await dexPrice(client, p, t, USDC); if (px) break; }
      }
      if (!px) {
        // T/WETH then * WETH/USDC
        for (const stab of [false, true]) {
          const p = await getPool(t, WETH, stab);
          if (p) {
            const tInWeth = await dexPrice(client, p, t, WETH);
            if (tInWeth && wethUsdc) { px = tInWeth * wethUsdc; break; }
          }
        }
      }
      out[t] = px || 0;
    }

    return NextResponse.json({ prices: out });
  } catch (err: any) {
    console.error('prices/token error:', err?.message || err);
    return NextResponse.json({ prices: {} }, { status: 500 });
  }
}
