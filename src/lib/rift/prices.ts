// src/lib/rift/prices.ts
//
// Market prices for the cost check, in USD.
//   - iAERO: its price in its main Aerodrome pool on Base, read on-chain every 30 s, times AERO's USD price.
//     DeFiLlama's iAERO price lags (it was 0.8-1.2% high on 2026-10-02), which made real costs look negative.
//   - AERO and the token being paid with: DeFiLlama (keyless, allows browser requests), every minute.

'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useReadContracts } from 'wagmi';
import { base } from 'wagmi/chains';
import { IAERO_ADDRESS } from './config';
import { clAeroPerIaero, llamaIdOf, parseLlamaPrices, v2AeroPerIaero } from './cost';

const IAERO_ID = `base:${IAERO_ADDRESS.toLowerCase()}`;
const AERO_ID = 'base:0x940181a94a35a4569e4529a3cdfb74e38fd98631';

/** iAERO/AERO on Aerodrome, iAERO as token0: the Slipstream pool (0.05% fee) holds nearly all iAERO
 *  liquidity and is where buys fill; the classic volatile pool (the site's price card, client-prices.ts)
 *  is the fallback, for example if the Slipstream pool has no liquidity at its current price. */
const IAERO_CL_POOL = '0xA1b79A66994878476A9dcB20E50969A7d641229C' as const;
const IAERO_V2_POOL = '0x08d49DA370ecfFBC4c6Fdd2aE82B2D6aE238Affd' as const;

const TOKEN0 = { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] } as const;
const CL_ABI = [
  TOKEN0,
  {
    type: 'function', name: 'slot0', stateMutability: 'view', inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' }, { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' }, { name: 'unlocked', type: 'bool' },
    ],
  },
  { type: 'function', name: 'liquidity', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint128' }] },
] as const;
const V2_ABI = [
  TOKEN0,
  {
    type: 'function', name: 'getReserves', stateMutability: 'view', inputs: [],
    outputs: [{ name: '_reserve0', type: 'uint256' }, { name: '_reserve1', type: 'uint256' }, { name: '_blockTimestampLast', type: 'uint256' }],
  },
] as const;

export function useMarketPrices(asset: string | undefined): { iaeroUsd?: number; inputUsd?: number } {
  const inputId = asset ? llamaIdOf(asset) : null;
  const { data: llama } = useQuery({
    queryKey: ['rift-market-prices', inputId],
    queryFn: async ({ signal }) => {
      const ids = [...new Set([AERO_ID, IAERO_ID, ...(inputId ? [inputId] : [])])];
      const res = await fetch(`https://coins.llama.fi/prices/current/${ids.join(',')}?searchWidth=4h`, { signal });
      if (!res.ok) throw new Error(`DeFiLlama HTTP ${res.status}`);
      return parseLlamaPrices(await res.json(), Date.now());
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  });

  const { data: pools } = useReadContracts({
    contracts: [
      { address: IAERO_CL_POOL, abi: CL_ABI, functionName: 'token0', chainId: base.id },
      { address: IAERO_CL_POOL, abi: CL_ABI, functionName: 'slot0', chainId: base.id },
      { address: IAERO_CL_POOL, abi: CL_ABI, functionName: 'liquidity', chainId: base.id },
      { address: IAERO_V2_POOL, abi: V2_ABI, functionName: 'token0', chainId: base.id },
      { address: IAERO_V2_POOL, abi: V2_ABI, functionName: 'getReserves', chainId: base.id },
    ],
    query: { refetchInterval: 30_000 },
  });

  const aeroPerIaero = useMemo(() => {
    if (!pools) return undefined;
    const [clToken0, slot0, liquidity, v2Token0, reserves] = pools;
    const iaeroFirst = (r: { status: string; result?: unknown }) =>
      r.status === 'success' && String(r.result).toLowerCase() === IAERO_ADDRESS.toLowerCase();
    if (iaeroFirst(clToken0) && slot0.status === 'success' && liquidity.status === 'success' && liquidity.result > 0n) {
      const p = clAeroPerIaero(slot0.result[0]);
      if (p > 0 && Number.isFinite(p)) return p;
    }
    if (iaeroFirst(v2Token0) && reserves.status === 'success') {
      const p = v2AeroPerIaero(reserves.result[0], reserves.result[1]);
      if (p > 0 && Number.isFinite(p)) return p;
    }
    return undefined;
  }, [pools]);

  const aeroUsd = llama?.[AERO_ID];
  return {
    iaeroUsd: aeroPerIaero && aeroUsd ? aeroPerIaero * aeroUsd : llama?.[IAERO_ID],
    inputUsd: inputId ? llama?.[inputId] : undefined,
  };
}
