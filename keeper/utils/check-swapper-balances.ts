#!/usr/bin/env node
// scripts/check-swapper-balances.ts
// One-off audit: list every registry token whose balance in the deployed
// RewardSwapper is > 0. Helps identify tokens stuck from prior failed swaps.

import { createPublicClient, http, parseAbi, formatUnits, type Address } from 'viem';
import { base } from 'viem/chains';

const SWAPPER  = '0x25F11F947309df89bF4D36DA5D9A9fb5F1E186c1' as Address;
const REGISTRY = '0xd3e32B22Da6Bf601A5917ECd344a7Ec46BCA072c' as Address;

const REGISTRY_ABI = parseAbi(['function allTokens() view returns (address[])']);
const ERC20_ABI    = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

async function main() {
  const rpc = process.env.RPC_URL || 'https://mainnet.base.org';
  const client = createPublicClient({
    chain: base,
    transport: http(rpc, { timeout: 60_000, retryCount: 3 }),
  });

  console.log(`Reading registry from ${REGISTRY}...`);
  const tokens = await client.readContract({
    address: REGISTRY, abi: REGISTRY_ABI, functionName: 'allTokens',
  }) as readonly Address[];
  console.log(`Registry has ${tokens.length} tokens. Querying swapper balances via multicall...\n`);

  // Multicall balanceOf for each
  const balanceResults = await client.multicall({
    contracts: tokens.map(t => ({
      address: t, abi: ERC20_ABI, functionName: 'balanceOf', args: [SWAPPER] as const,
    })),
    allowFailure: true,
  });

  const nonZero: Array<{ address: Address; balance: bigint }> = [];
  balanceResults.forEach((r, i) => {
    if (r.status === 'success' && (r.result as unknown as bigint) > 0n) {
      nonZero.push({ address: tokens[i], balance: r.result as unknown as bigint });
    }
  });

  if (nonZero.length === 0) {
    console.log('No registry tokens are currently held by the swapper.');
    return;
  }

  // Enrich with symbol + decimals
  console.log(`${nonZero.length} tokens with non-zero balance in swapper. Fetching symbols...\n`);
  const enriched = await client.multicall({
    contracts: nonZero.flatMap(n => [
      { address: n.address, abi: ERC20_ABI, functionName: 'symbol' } as const,
      { address: n.address, abi: ERC20_ABI, functionName: 'decimals' } as const,
    ]),
    allowFailure: true,
  });

  console.log('Symbol            Decimals  Balance                          Address');
  console.log('───────────────── ──────── ──────────────────────────────── ──────────────────────────────────────────');
  for (let i = 0; i < nonZero.length; i++) {
    const sym = enriched[i * 2].status === 'success' ? String(enriched[i * 2].result) : '???';
    const dec = enriched[i * 2 + 1].status === 'success' ? Number(enriched[i * 2 + 1].result) : 18;
    const balFmt = formatUnits(nonZero[i].balance, dec);
    console.log(`${sym.padEnd(17)} ${String(dec).padEnd(8)} ${balFmt.padEnd(32)} ${nonZero[i].address}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
