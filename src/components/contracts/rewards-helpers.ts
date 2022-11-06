import { ethers } from "ethers";

/** Extract token addresses from RewardsSugar rows defensively. */
export function tokensFromSugarRows(rows: any[]): string[] {
  const seen = new Set<string>();
  for (const row of rows || []) {
    // sugar may call them "bribes" / "fees" (arrays)
    const groups = [row?.bribes ?? [], row?.fees ?? []];
    for (const group of groups) {
      for (const item of group) {
        const t = typeof item === 'string' ? item : item?.token;
        if (t && ethers.isAddress(t)) seen.add(t.toLowerCase());
      }
    }
  }
  return Array.from(seen);
}

/** Try multiple sugar method names if ABI differs slightly. */
export async function getSugarRows(rs: any, limit = 16, offset = 0): Promise<any[]> {
  if (!rs) return [];
  const tryCalls: Array<[string, any[]]> = [
    ["epochsLatest", [limit, offset]],
    ["getEpochsLatest", [limit, offset]],
    ["listRecentEpochs", [limit, offset]],
  ];
  for (const [name, args] of tryCalls) {
    try {
      if (typeof rs[name] === 'function') {
        const rows = await rs[name](...args);
        if (Array.isArray(rows)) return rows;
      }
    } catch { /* next */ }
  }
  return [];
}

/** Primary: RewardsSugar; Fallback: AERO only (no WETH/USDC to avoid throw). */
export async function getEpochClaimTokenList(contracts: any): Promise<string[]> {
  try {
    const rows = await getSugarRows(contracts?.RewardsSugar, 16, 0);
    const tokens = tokensFromSugarRows(rows);
    if (tokens.length) return tokens;
  } catch { /* fallback below */ }

  // Fallback to AERO only to avoid getContractAddress('WETH'|'USDC') throws
  try {
    const aero = contracts?.AERO?.target || contracts?.AERO?.address;
    if (aero) return [String(aero)];
  } catch {}
  return [];
}
