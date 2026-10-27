// src/lib/rift/prices.ts
//
// Market prices for the cost check, in USD, fetched only while the Get iAERO tab is open.
// - iAERO: its price in its main Aero pool on Base (read on-chain every 30 s) times AERO's USD price.
//   DeFiLlama's own iAERO price lags (0.8–1.2% high on 2026-10-02), so without a pool price there is none.
// - AERO and ETH (for Rift's gas charge): DeFiLlama, every minute, in one request that does not change when
//   the user picks another token.
// - The token being paid with: DeFiLlama, every minute.
// Prices are checked for age when used (`at(now)`), not only when fetched: a failed refresh keeps the last
// answer, which must not keep feeding the cost check through an outage.

'use client';

import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useReadContracts } from 'wagmi';
import { base } from 'wagmi/chains';
import { IAERO_ADDRESS } from './config.ts';
import { clAeroPerIaero, freshPrice, llamaIdOf, parseLlamaQuotes, plausibleEthUsd, v2AeroPerIaero, type LlamaQuote } from './cost.ts';

/** Aero's AERO; DeFiLlama had no price for it at launch (2026-10-22), so Aerodrome's AERO, convertible 1:1 through
 *  Aero's migration contract, stands in until it does. */
const AERO_ID = 'base:0x3f5bf3edac59d650d8fdf9657a71f2f904a3a4ee';
const AERO_LEGACY_ID = 'base:0x940181a94a35a4569e4529a3cdfb74e38fd98631';
const ETH_ID = 'coingecko:ethereum';
const BASE_IDS = [AERO_ID, AERO_LEGACY_ID, ETH_ID];
/** A fetch older than this (its refreshes failing) no longer counts, whatever the prices' own timestamps. */
const FETCH_MAX_AGE_MS = 3 * 60_000;
const POOL_MAX_AGE_MS = 2 * 60_000;

/** AERO/iAERO on Aero (liquidity moved from Aerodrome on 2026-10-22), AERO as token0: the concentrated-liquidity
 *  pool is read first; the classic volatile pool (the site's price card, client-prices.ts) is the fallback, for
 *  example if the CL pool has no liquidity at its current price. Token order is checked, not assumed. */
const IAERO_CL_POOL = '0x361D728c97E591Ef47A68CAe2DC5C8ef475608EB' as const;
const IAERO_V2_POOL = '0x72Decb30DFE4F6Cf7Db3ba1D58411dDda5ed903b' as const;

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

async function llama(ids: string[], signal?: AbortSignal) {
  const res = await fetch(`https://coins.llama.fi/prices/current/${ids.join(',')}?searchWidth=4h`, { signal });
  if (!res.ok) throw new Error(`DeFiLlama HTTP ${res.status}`);
  return parseLlamaQuotes(await res.json(), Date.now(), ETH_ID);
}

export interface MarketPrices { iaeroUsd?: number; inputUsd?: number; ethUsd?: number }

/** Prices as of now, plus `at(now)` to re-check them at the moment they are acted on. */
export function useMarketPrices(asset: string | undefined, enabled = true): MarketPrices & { at: (now: number) => MarketPrices } {
  const inputId = asset ? llamaIdOf(asset) : null;
  const core = useQuery({
    queryKey: ['rift-market-prices'],
    queryFn: ({ signal }) => llama(BASE_IDS, signal),
    enabled, refetchInterval: 60_000, staleTime: 30_000, retry: 1,
  });
  const token = useQuery({
    queryKey: ['rift-token-price', inputId],
    // With ETH alongside, whose fresh price dates the answer (cost.ts parseLlamaQuotes).
    queryFn: ({ signal }) => llama([inputId!, ETH_ID], signal),
    enabled: enabled && !!inputId && !BASE_IDS.includes(inputId),
    refetchInterval: 60_000, staleTime: 30_000, retry: 1,
  });

  const pools = useReadContracts({
    contracts: [
      { address: IAERO_CL_POOL, abi: CL_ABI, functionName: 'token0', chainId: base.id },
      { address: IAERO_CL_POOL, abi: CL_ABI, functionName: 'slot0', chainId: base.id },
      { address: IAERO_CL_POOL, abi: CL_ABI, functionName: 'liquidity', chainId: base.id },
      { address: IAERO_V2_POOL, abi: V2_ABI, functionName: 'token0', chainId: base.id },
      { address: IAERO_V2_POOL, abi: V2_ABI, functionName: 'getReserves', chainId: base.id },
    ],
    query: { enabled, refetchInterval: 30_000 },
  });

  const aeroPerIaero = useMemo(() => {
    if (!pools.data) return undefined;
    const [clToken0, slot0, liquidity, v2Token0, reserves] = pools.data;
    // Either token order: with iAERO as token0 the pool price is AERO per iAERO, otherwise its inverse.
    const order = (r: { status: string; result?: unknown }) => r.status !== 'success' ? undefined
      : String(r.result).toLowerCase() === IAERO_ADDRESS.toLowerCase() ? 'iaero-first' : 'aero-first';
    const clOrder = order(clToken0), v2Order = order(v2Token0);
    if (clOrder && slot0.status === 'success' && liquidity.status === 'success' && liquidity.result > 0n) {
      const raw = clAeroPerIaero(slot0.result[0]);
      const p = clOrder === 'iaero-first' ? raw : 1 / raw;
      if (p > 0 && Number.isFinite(p)) return p;
    }
    if (v2Order && reserves.status === 'success') {
      const [r0, r1] = [reserves.result[0], reserves.result[1]];
      const p = v2Order === 'iaero-first' ? v2AeroPerIaero(r0, r1) : v2AeroPerIaero(r1, r0);
      if (p > 0 && Number.isFinite(p)) return p;
    }
    return undefined;
  }, [pools.data]);

  const coreData = core.data, coreAt = core.dataUpdatedAt, tokenData = token.data, tokenAt = token.dataUpdatedAt, poolsAt = pools.dataUpdatedAt;
  const at = useCallback((now: number): MarketPrices => {
    // (A fetch stamped in the future, by a clock since put back, is not fresh.)
    const pick = (data: Record<string, LlamaQuote> | undefined, fetchedAt: number, id: string) =>
      data && now - fetchedAt <= FETCH_MAX_AGE_MS && now >= fetchedAt - 1000 ? freshPrice(data[id], now) : undefined;
    const aeroUsd = pick(coreData, coreAt, AERO_ID) ?? pick(coreData, coreAt, AERO_LEGACY_ID);
    const poolFresh = aeroPerIaero !== undefined && now - poolsAt <= POOL_MAX_AGE_MS && now >= poolsAt - 1000;
    return {
      iaeroUsd: poolFresh && aeroUsd ? aeroPerIaero * aeroUsd : undefined,
      inputUsd: inputId ? (BASE_IDS.includes(inputId) ? (p => (inputId !== ETH_ID || plausibleEthUsd(p) ? p : undefined))(pick(coreData, coreAt, inputId))
        : pick(tokenData, tokenAt, inputId)) : undefined,
      ethUsd: (p => (plausibleEthUsd(p) ? p : undefined))(pick(coreData, coreAt, ETH_ID)),
    };
  }, [coreData, coreAt, tokenData, tokenAt, poolsAt, aeroPerIaero, inputId]);

  return { ...at(Date.now()), at };
}
