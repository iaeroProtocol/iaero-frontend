// src/lib/rift/prices.ts
//
// Market prices for the cost check: the token being paid with and iAERO, in USD, from DeFiLlama (keyless,
// allows browser requests), refreshed every minute. One source for both sides keeps the comparison fair.

'use client';

import { useQuery } from '@tanstack/react-query';
import { IAERO_ADDRESS } from './config';
import { llamaIdOf, parseLlamaPrices } from './cost';

const IAERO_ID = `base:${IAERO_ADDRESS.toLowerCase()}`;

export function useMarketPrices(asset: string | undefined): { iaeroUsd?: number; inputUsd?: number } {
  const inputId = asset ? llamaIdOf(asset) : null;
  const { data } = useQuery({
    queryKey: ['rift-market-prices', inputId],
    queryFn: async ({ signal }) => {
      const ids = inputId ? [IAERO_ID, inputId] : [IAERO_ID];
      const res = await fetch(`https://coins.llama.fi/prices/current/${ids.join(',')}?searchWidth=4h`, { signal });
      if (!res.ok) throw new Error(`DeFiLlama HTTP ${res.status}`);
      return parseLlamaPrices(await res.json(), Date.now());
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  });
  return { iaeroUsd: data?.[IAERO_ID], inputUsd: inputId ? data?.[inputId] : undefined };
}
