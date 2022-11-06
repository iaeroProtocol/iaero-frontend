import { ethers } from "ethers";

/** Get safe EIP-1559 overrides (type:2). Falls back sanely if RPC omits fields. */
export async function get1559Overrides(provider: ethers.Provider, opts?: {
  maxFeeCapGwei?: number;        // hard cap to avoid extreme spikes (default 50 gwei)
  minPriorityGwei?: number;      // floor for tip (default 1 gwei)
}) {
  const { maxFeeCapGwei = 50, minPriorityGwei = 1 } = opts || {};
  const fee = await provider.getFeeData();

  // Base is EIP-1559: prefer maxFeePerGas / maxPriorityFeePerGas
  let maxFee = fee.maxFeePerGas ?? fee.gasPrice ?? ethers.parseUnits("5", "gwei");
  let maxPriority = fee.maxPriorityFeePerGas ?? ethers.parseUnits(String(minPriorityGwei), "gwei");

  // Cap the absolute max fee so users don’t overpay on spiky mempools
  const hardCap = ethers.parseUnits(String(maxFeeCapGwei), "gwei");
  if (maxFee > hardCap) maxFee = hardCap;
  if (maxPriority > maxFee) maxPriority = maxFee / 2n; // keep reasonable relation

  return { type: 2, maxFeePerGas: maxFee, maxPriorityFeePerGas: maxPriority } as const;
}

