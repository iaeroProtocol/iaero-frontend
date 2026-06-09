// src/components/lib/fees.ts
import type { PublicClient } from 'viem';

/** Get safe gas price estimate for viem PublicClient */
export async function get1559Overrides(publicClient: PublicClient) {
  try {
    const gasPrice = await publicClient.getGasPrice();
    
    // Return a reasonable multiplier for maxFeePerGas (1.2x base)
    const maxFeePerGas = (gasPrice * 120n) / 100n;
    const maxPriorityFeePerGas = gasPrice / 20n; // ~5% tip
    
    return {
      type: 2 as const,
      maxFeePerGas,
      maxPriorityFeePerGas,
    };
  } catch (error) {
    // Fallback values
    const fallbackGas = BigInt(1000000000); // 1 gwei
    return {
      type: 2 as const,
      maxFeePerGas: fallbackGas * 5n,
      maxPriorityFeePerGas: fallbackGas,
    };
  }
}