// src/lib/debug.ts (temporary)
import { getProvider } from "../components/lib/ethereum";
import { CONTRACTS } from "../components/contracts/addresses";

export async function verifyDeployed(chainId: 8453 | 84532) {
  const provider = getProvider(chainId);
  const entries = Object.entries(CONTRACTS[chainId] || {});
  for (const [name, addr] of entries) {
    try {
      const code = await provider.getCode(addr!);
      console.log(name, addr, code && code !== "0x" ? "✅ code present" : "❌ NO CODE");
    } catch (e) {
      console.warn(name, addr, "⚠︎ error", e);
    }
  }
}

