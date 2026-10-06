// Browser-only recovery of token lists when Blockscout is unavailable. The public Alchemy key is restricted
// to this site's origin; the anonymous Worker never spends a private Alchemy key. A short, bounded scan keeps
// a spam-filled wallet from consuming unbounded API quota or filling Rift's route-check queue.

import { CURATED_TOKENS, RIFT_DESTINATION } from './config';
import { parseAlchemyHoldings, type EvmHoldingChain, type Holding } from './holdings';
import { RIFT_LISTED } from './rift-tokens';

export interface RecoveredHoldings {
  holdings: Holding[];
  covered: EvmHoldingChain[];
  limited: EvmHoldingChain[];
}

const NETWORK: Record<EvmHoldingChain, string> = {
  ethereum: 'eth-mainnet', arbitrum: 'arb-mainnet', base: 'base-mainnet',
};
const MAX_PAGES = 2; // Alchemy returns at most 100 tokens per page.
const MAX_HOLDINGS = 40;
const TIMEOUT_MS = 18_000;
const KNOWN = new Set([...CURATED_TOKENS.map(t => t.asset.toLowerCase()), ...RIFT_LISTED]);
const EXCLUDE = new Set([RIFT_DESTINATION]);

async function recoverChain(chain: EvmHoldingChain, owner: string, key: string, signal: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, TIMEOUT_MS);
  const rows: unknown[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let complete = true;
  let gotPage = false;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      let body: unknown;
      try {
        const response = await fetch(`https://api.g.alchemy.com/data/v1/${key}/assets/tokens/by-address`, {
          method: 'POST', credentials: 'omit', cache: 'no-store', signal: controller.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            addresses: [{ address: owner, networks: [NETWORK[chain]] }], withMetadata: true, withPrices: true,
            includeNativeTokens: false, includeErc20Tokens: true, ...(cursor ? { pageKey: cursor } : {}),
          }),
        });
        if (!response.ok) throw new Error(`Alchemy HTTP ${response.status}`);
        body = await response.json();
      } catch {
        if (!gotPage) throw new Error('Alchemy token list unavailable');
        complete = false;
        break;
      }
      const result = body && typeof body === 'object' ? body as Record<string, unknown> : null;
      const data = result?.data && typeof result.data === 'object' ? result.data as Record<string, unknown> : null;
      if (!Array.isArray(data?.tokens)) {
        if (!gotPage) throw new Error('Alchemy token list unavailable');
        complete = false;
        break;
      }
      gotPage = true;
      rows.push(...data.tokens.slice(0, 100));
      if (data.tokens.some(x => !x || typeof x !== 'object'
          || (x as Record<string, unknown>).network !== NETWORK[chain]
          || String((x as Record<string, unknown>).address).toLowerCase() !== owner.toLowerCase())) complete = false;
      const error = result?.error && typeof result.error === 'object' ? result.error as Record<string, unknown> : null;
      const partial = !!error;
      if (partial || data.tokens.length > 100) complete = false;
      const next = typeof data.pageKey === 'string' && data.pageKey.length > 0 ? data.pageKey : undefined;
      if (!next || partial) break;
      if (cursors.has(next)) { complete = false; break; }
      cursors.add(next);
      cursor = next;
      if (page === MAX_PAGES - 1) complete = false;
    }
    const parsed = parseAlchemyHoldings(chain, owner, rows, KNOWN, EXCLUDE, Date.now());
    const ordered = [
      ...parsed.filter(h => KNOWN.has(h.asset)).sort((a, b) => b.valueUsd - a.valueUsd),
      ...parsed.filter(h => !KNOWN.has(h.asset)).sort((a, b) => b.valueUsd - a.valueUsd),
    ];
    if (ordered.length > MAX_HOLDINGS) complete = false;
    return { holdings: ordered.slice(0, MAX_HOLDINGS), complete };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

/** Each affected chain is independent: one failed network keeps the others' holdings. A completed empty list
 *  still covers that chain. An incomplete scan is marked so the page never implies all tokens were found. */
export async function fetchAlchemyFallback(
  owner: string, chains: EvmHoldingChain[], key: string, signal: AbortSignal,
): Promise<RecoveredHoldings> {
  const results = await Promise.all(chains.map(async chain => {
    try { return { chain, result: await recoverChain(chain, owner, key, signal) }; }
    catch { return { chain, result: null }; }
  }));
  return {
    holdings: results.flatMap(x => x.result?.holdings ?? []),
    covered: results.filter(x => x.result?.complete).map(x => x.chain),
    limited: results.filter(x => x.result && !x.result.complete).map(x => x.chain),
  };
}
