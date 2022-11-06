/* eslint-disable no-console */
// src/components/contracts/hooks/useVault.ts

import { useState, useCallback } from "react";
import { ethers, Contract, ContractTransactionReceipt } from "ethers";
import { useProtocol } from "../../contexts/ProtocolContext";
import { parseTokenAmount } from "../../lib/ethereum";

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

interface VaultStatus {
  totalUserDeposits: string;
  totalProtocolOwned: string;
  actualFeesCollected: string;
  virtualFeesOwed: string;
  primaryNFTId: string;
  primaryNFTBalance: string;
  primaryNFTVotingPower: string;
  primaryNFTUnlockTime: string;
  additionalNFTCount: string;
  needsRebase: boolean;
  needsMerge: boolean;
  MAXTIME?: number;
}

interface VeNFT {
  id: string;
  locked: string;
  unlockDate: string;
  isPermanent?: boolean;
}

type ProgressCallback = (message: string) => void;
type SuccessCallback = (receipt: ContractTransactionReceipt) => void;
type ErrorCallback = (error: any) => void;

/* -------------------------------------------------------------------------- */
/*                                   Consts                                   */
/* -------------------------------------------------------------------------- */

const DEBUG = true;
const FALLBACK_GAS_DEPOSIT_VENFT = 900_000n; // match cast-style cushion
const USE_PER_TOKEN_APPROVALS_ONLY = true as const;

/* -------------------------------------------------------------------------- */
/*                                   Utils                                    */
/* -------------------------------------------------------------------------- */

const fmtEth = (v: bigint) => ethers.formatEther(v ?? 0n);
const toLower = (a?: string) => (a ?? "").toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pretty(obj: any) {
  return JSON.stringify(obj, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}

function extractRevertData(err: any): string | undefined {
  return (
    err?.data ??
    err?.error?.data ??
    err?.info?.error?.data ??
    err?.cause?.data ??
    err?.revert ??
    err?.receipt?.revertReason ??
    undefined
  );
}

function normalizeTokenId(id: string | number | bigint): bigint {
  if (typeof id === "bigint") return id;
  if (typeof id === "number") return BigInt(id);
  if (typeof id === "string") {
    const s = id.trim();
    if (/^0x[0-9a-fA-F]+$/.test(s)) return BigInt(s);
    if (/^\d+$/.test(s)) return BigInt(s);
  }
  throw new Error(`Invalid tokenId: ${String(id)}`);
}

async function describeNetwork(signer: ethers.Signer): Promise<string> {
  try {
    const net = await signer.provider?.getNetwork?.();
    const name = (net as any)?.name ?? "";
    const chainId = (net as any)?.chainId ?? "";
    return `${name || "unknown"} (chainId=${chainId?.toString?.() ?? "?"})`;
  } catch {
    return "unknown";
  }
}

/* -------------------------------------------------------------------------- */
/*                                    ABI                                     */
/* -------------------------------------------------------------------------- */

const VAULT_MIN_ABI = [
  "function deposit(uint256 amount) external",
  "function depositVeNFT(uint256 tokenId) external",
  "function previewDeposit(uint256 amount) external view returns (uint256,uint256,uint256)",
  "function vaultStatus() external view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool,bool)",
  "function MAXTIME() external view returns (uint256)",
  "function totalLIQMinted() external view returns (uint256)"
];

const VAULT_IFACE = new ethers.Interface([
  "function depositVeNFT(uint256 tokenId)"
]);

const VAULT_READ_ABI = [
  "function paused() view returns (bool)",
  "function emergencyPause() view returns (bool)",
  "function isManaged(uint256 tokenId) view returns (bool)"
];

const ERC721_APPROVAL_ABI = [
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function approve(address to, uint256 tokenId)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "function locked(uint256 tokenId) view returns (tuple(int128 amount,uint256 end,bool isPermanent))",
  "function ownerToNFTokenIdList(address owner, uint256 i) view returns (uint256)",

];


/* -------------------------------------------------------------------------- */
/*                          Fee plan (ethers v6 safe)                         */
/* -------------------------------------------------------------------------- */

async function getFeePlan(provider: ethers.Provider) {
  const fee = await provider.getFeeData(); // v6-safe
  const legacyGasPrice: bigint | undefined =
    (fee.gasPrice ?? undefined) ?? (fee.maxFeePerGas ?? undefined);
  if (DEBUG)
    console.debug("[feePlan]", {
      maxFeePerGas: fee.maxFeePerGas?.toString(),
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas?.toString(),
      legacyGasPrice: legacyGasPrice?.toString()
    });
  return {
    maxFeePerGas: fee.maxFeePerGas ?? undefined,
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? undefined,
    legacyGasPrice
  };
}

/* -------------------------------------------------------------------------- */
/*                           Mempool verification                             */
/* -------------------------------------------------------------------------- */

type MempoolStatus = "match" | "mismatch" | "unknown";

async function verifyMempoolData(
  provider: ethers.Provider,
  hash: string,
  expectedData: string
): Promise<MempoolStatus> {
  for (let i = 0; i < 6; i++) {
    const tx = await provider.getTransaction(hash);
    if (tx) {
      const hasData = typeof tx.data === "string" && tx.data.length > 2;
      if (!hasData) return "mismatch"; // a tx without data is definitely wrong
      const matches = tx.data!.toLowerCase() === expectedData.toLowerCase();
      return matches ? "match" : "mismatch";
    }
    await sleep(250);
  }
  // Couldn’t read mempool; don’t assume mutation
  if (DEBUG) console.warn("[verifyMempoolData] mempool opaque; treating as unknown");
  return "unknown";
}


/* -------------------------------------------------------------------------- */
/*                      EIP-1193 direct (eth_sendTransaction)                 */
/* -------------------------------------------------------------------------- */
async function detectMergeTarget(
  receipt: ContractTransactionReceipt,
  ve: Contract
): Promise<string | null> {
  try {
    const veAddr = (await ve.getAddress()).toLowerCase();
    for (const log of (receipt.logs ?? [])) {
      if ((log.address || "").toLowerCase() !== veAddr) continue;
      try {
        const parsed = ve.interface.parseLog(log);
        const n = parsed?.name?.toLowerCase?.() || "";
        if (n.includes("merge") && parsed) {
          // pick the largest bigint arg as the "to" id (works across ABI variants)
          const ids = Object.values(parsed.args || {})
            .filter((v: any) => typeof v === "bigint") as bigint[];
          if (ids.length) return ids.sort((a,b)=> (a<b?-1:1))[ids.length-1].toString();
        }
      } catch {}
    }
  } catch {}
  return null;
}

async function retry<T>(fn: () => Promise<T>, times = 4, delayMs = 700): Promise<T> {
  let lastErr: any;
  for (let i=0; i<times; i++) {
    try { return await fn(); } catch (e) { lastErr = e; }
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw lastErr;
}

function getEip1193(signer: ethers.Signer): any | null {
  const p: any = signer.provider;
  // BrowserProvider exposes the underlying EIP‑1193 provider as `.provider`
  if (p && typeof p.provider?.request === "function") return p.provider;
  // Fallback to window.ethereum if present
  if (typeof (globalThis as any).ethereum?.request === "function") return (globalThis as any).ethereum;
  return null;
}

function toHex(v?: bigint) {
  return v == null ? undefined : ethers.toBeHex(v);
}

async function sendViaEip1193(
  signer: ethers.Signer,
  params: Record<string, any>,
  expectedData: string,
  label: string
) {
  const eip = getEip1193(signer);
  if (!eip) {
    if (DEBUG) console.debug(`[${label}] No EIP‑1193 provider; skipping.`);
    return null;
  }
  try {
    // Keep params minimal & wallet‑friendly (no chainId/type unless needed)
    const tx: any = {
      from: params.from,
      to: params.to,
      data: params.data,
      gas: toHex(params.gas),            // 'gas' (not gasLimit) for eth_sendTransaction
      value: toHex(params.value ?? 0n)
    };
    if (params.maxFeePerGas && params.maxPriorityFeePerGas) {
      tx.maxFeePerGas = toHex(params.maxFeePerGas);
      tx.maxPriorityFeePerGas = toHex(params.maxPriorityFeePerGas);
    } else if (params.gasPrice) {
      tx.gasPrice = toHex(params.gasPrice);
    }

    if (DEBUG) console.debug(`[${label}] eth_sendTransaction request:`, pretty(tx));
    const hash: string = await eip.request({
      method: "eth_sendTransaction",
      params: [tx]
    });
    if (DEBUG) console.debug(`[${label}] hash:`, hash);

    const status = await verifyMempoolData(signer.provider!, hash, expectedData);
    if (status === "mismatch") {
      console.error(`[${label}] Wallet/provider mutated or stripped calldata (mismatch).`);
      return { hash, mutated: true };
    }
    // "match" or "unknown" are both fine
    return { hash, mutated: false };

  } catch (e) {
    console.warn(`[${label}] eth_sendTransaction failed`, e);
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*                              Build calldata                                */
/* -------------------------------------------------------------------------- */

function buildVaultDepositData(tokenId: bigint) {
  const data = VAULT_IFACE.encodeFunctionData("depositVeNFT", [tokenId]);
  const selector = data.slice(0, 10);
  return { data, selector };
}


/* -------------------------------------------------------------------------- */
/*                                   Hook                                     */
/* -------------------------------------------------------------------------- */

export const useVault = () => {
  const { getContracts, loadBalances, loadAllowances, dispatch } = useProtocol();
  const [loading, setLoading] = useState(false);

  /* ----------------------------- LIQ: preview ------------------------------ */

  const calculateLiqRewards = useCallback(
    async (aeroAmount: string) => {
      const c = await getContracts();
      const wei = parseTokenAmount(aeroAmount);
      if (!c?.vault) throw new Error("Vault not initialized");
      
      const hasPreview = typeof (c.vault as any).previewDeposit === "function";
      if (!hasPreview) {
        console.warn("[calculateLiqRewards] vault.previewDeposit not exposed by ABI");
        return {
          liqToUser: "0.0",
          effectiveRate: "0.0",
          nextHalvingIn: "0.0"
        };
      }
      
      if (DEBUG) console.debug("[calculateLiqRewards] amount:", aeroAmount, "wei:", wei.toString());
      const res = await (c.vault as any).previewDeposit(wei);
      
      // Extract the values from the contract response
      const iAeroToUser = ethers.formatEther(res?.[0] ?? 0n);
      const liqToUser = ethers.formatEther(res?.[2] ?? 0n);
      
      // Calculate effective rate (LIQ per iAERO, not per AERO)
      const iAeroNum = parseFloat(iAeroToUser);
      const liqNum = parseFloat(liqToUser);
      const effectiveRate = iAeroNum > 0 
        ? (liqNum / iAeroNum).toFixed(4) 
        : "0.0";
      
      // Calculate nextHalvingIn by getting totalLIQMinted from contract
      let nextHalvingIn = "0.0";
      try {
        // Add these view functions to your vault ABI if not present:
        const totalMinted = await (c.vault as any).totalLIQMinted?.();
        const halvingStep = 5_000_000n * 10n**18n; // HALVING_STEP constant from contract
        
        if (totalMinted !== undefined) {
          const currentHalvingIndex = totalMinted / halvingStep;
          const nextHalvingThreshold = (currentHalvingIndex + 1n) * halvingStep;
          const untilNextHalving = nextHalvingThreshold - totalMinted;
          nextHalvingIn = ethers.formatEther(untilNextHalving);
        }
      } catch (e) {
        console.debug("[calculateLiqRewards] Could not fetch halving info:", e);
      }
      
      if (DEBUG) console.debug("[calculateLiqRewards] preview:", {
        iAeroToUser: res?.[0]?.toString?.(),
        iAeroToTreasury: res?.[1]?.toString?.(),
        liqToUser: res?.[2]?.toString?.(),
        effectiveRate,
        nextHalvingIn
      });
      
      return {
        liqToUser,
        effectiveRate,
        nextHalvingIn
      };
    },
    [getContracts]
  );

  /* --------------------------- AERO: approvals ----------------------------- */

  const checkAeroApproval = useCallback(
    async (amount: string): Promise<boolean> => {
      try {
        const c = await getContracts(true);
        if (!c?.AERO || !c?.vault) return false;
        const signer = c.vault.runner as ethers.Signer;
        const owner = await signer.getAddress();
        const spender = await c.vault.getAddress();
        const amountWei = parseTokenAmount(amount);
        const current = await c.AERO.allowance(owner, spender);
        if (DEBUG) console.debug("[checkAeroApproval]", {
          owner, spender, amount, amountWei: amountWei.toString(),
          current: current.toString(), ok: current >= amountWei
        });
        return current >= amountWei;
      } catch (e) {
        console.error("[checkAeroApproval] failed:", e);
        return false;
      }
    },
    [getContracts]
  );

  const approveAero = useCallback(
    async (amount: string, onSuccess?: SuccessCallback, onError?: ErrorCallback) => {
      const txId = "approveAero";
      dispatch({ type: "SET_TRANSACTION_LOADING", payload: { id: txId, loading: true } });
      try {
        const c = await getContracts(true);
        if (!c?.AERO || !c?.vault) throw new Error("Contracts not initialized");
        const signer = c.vault.runner as ethers.Signer;
        const owner = await signer.getAddress();
        const spender = await c.vault.getAddress();
        const amountWei = parseTokenAmount(amount);

        if (DEBUG) console.debug("[approveAero] owner:", owner, "spender:", spender, "amountWei:", amountWei.toString());
        const tx = await c.AERO.approve(spender, amountWei);
        if (DEBUG) console.debug("[approveAero] sent:", tx?.hash);
        const receipt = (await tx.wait()) as ContractTransactionReceipt;
        if (DEBUG) console.debug("[approveAero] receipt status:", receipt?.status);

        await loadAllowances();
        onSuccess?.(receipt);
        return receipt;
      } catch (e) {
        console.error("[approveAero] error:", e);
        onError?.(e);
        throw e;
      } finally {
        dispatch({ type: "SET_TRANSACTION_LOADING", payload: { id: txId, loading: false } });
      }
    },
    [getContracts, dispatch, loadAllowances]
  );

  /* ----------------------------- Deposit AERO ------------------------------ */

  const ensureAeroAllowance = useCallback(
    async (minWei: bigint) => {
      const c = await getContracts(true);
      if (!c?.AERO || !c?.vault) throw new Error("Contracts not initialized");
  
      const signer = c.vault.runner as ethers.Signer;
      const owner  = await signer.getAddress();
      const spender = await c.vault.getAddress();
  
      const current: bigint = await c.AERO.allowance(owner, spender);
      if (current >= minWei) return; // ✅ already good
  
      // 1) try single infinite approve
      try {
        const tx = await c.AERO.approve(spender, ethers.MaxUint256);
        await tx.wait();
      } catch {
        // 2) some tokens require zero→non‑zero sequence
        const tx0 = await c.AERO.approve(spender, 0n);
        await tx0.wait();
        const tx1 = await c.AERO.approve(spender, ethers.MaxUint256);
        await tx1.wait();
      }
  
      await loadAllowances();
    },
    [getContracts, loadAllowances]
  );

  const depositAero = useCallback(
    async (
      amount: string,
      onSuccess?: SuccessCallback,
      onError?: ErrorCallback,
      onProgress?: ProgressCallback
    ) => {
      setLoading(true);
      const txId = "depositAero";
      dispatch({ type: "SET_TRANSACTION_LOADING", payload: { id: txId, loading: true } });
      try {
        const c = await getContracts(true);
        if (!c?.vault) throw new Error("Vault contract not initialized");

        onProgress?.("Checking allowance…");
        const hasApproval = await checkAeroApproval(amount);
        if (!hasApproval) {
          onProgress?.("Approving AERO spending…");
          await approveAero(amount);
        }

        const wei = parseTokenAmount(amount);
        onProgress?.("Depositing AERO…");
        if (DEBUG) console.debug("[depositAero] amount:", amount, "wei:", wei.toString());

        onProgress?.("Checking vault state…");
        try {
          const status = await c.vault.vaultStatus();
          const primaryId = (status?.[4] ?? 0n) as bigint; // primaryNFTId
          if (primaryId === 0n) {
            throw new Error("Vault not bootstrapped yet — deposit a veNFT first via ‘Deposit veNFT’."); 
          }
        } catch {/* if view fails, continue; the on-chain revert will still guard */}

        const tx = await c.vault.deposit(wei);
        if (DEBUG) console.debug("[depositAero] sent:", (tx as any)?.hash);

        onProgress?.("Confirming…");
        const receipt = (await tx.wait()) as ContractTransactionReceipt;
        if (DEBUG) console.debug("[depositAero] status:", receipt?.status);

        onProgress?.("Updating balances…");
        await loadBalances();
        await loadAllowances();

        onSuccess?.(receipt as any);
        return receipt as any;
      } catch (e) {
        console.error("[depositAero] error:", e);
        onError?.(e);
        throw e;
      } finally {
        setLoading(false);
        dispatch({ type: "SET_TRANSACTION_LOADING", payload: { id: txId, loading: false } });
      }
    },
    [getContracts, checkAeroApproval, approveAero, dispatch, loadBalances, loadAllowances]
  );

  /* --------------------------- List user veNFTs ---------------------------- */

  const getUserVeNFTs = useCallback(async (): Promise<VeNFT[]> => {
    try {
      const c = await getContracts(true);
      const ve = c?.VeAEROResolved;
      if (!ve) return [];

      const signer = ve.runner as ethers.Signer;
      const user = await signer.getAddress();
      const net = await describeNetwork(signer);
      if (DEBUG) console.debug("[getUserVeNFTs] user:", user, "network:", net);

      const bal = Number(await ve.balanceOf(user));
      if (DEBUG) console.debug("[getUserVeNFTs] balance:", bal);
      if (bal === 0) return [];

      const out: VeNFT[] = [];
      for (let i = 0; i < bal; i++) {
        try {
          const tokenId = await ve.ownerToNFTokenIdList(user, i);
          const locked = await ve.locked(tokenId);
          const amount = fmtEth((locked as any)?.amount ?? 0n);
          const end = Number((locked as any)?.end ?? 0n);
          const isPermanent = Boolean((locked as any)?.isPermanent);
          out.push({
            id: tokenId.toString(),
            locked: amount,
            unlockDate: end ? new Date(end * 1000).toLocaleDateString() : "—",
            isPermanent,
          });
        } catch (err) {
          console.warn(`[getUserVeNFTs] index ${i} failed`, err);
        }
      }
      if (DEBUG) console.debug("[getUserVeNFTs] found:", out.length);
      return out;
    } catch (e) {
      console.error("[getUserVeNFTs] error:", e);
      return [];
    }
  }, [getContracts]);

  /* ---------------------- Ensure veNFT approval (per-token) ---------------- */

  const ensureVeNftApproval = useCallback(
    async (tokenId: string | number | bigint, onProgress?: ProgressCallback) => {
      const c = await getContracts(true);
      const ve = c?.VeAEROResolved;
      if (!ve || !c?.vault) throw new Error("Contracts not initialized");

      const signer = c.vault.runner as ethers.Signer;
      const ownerAddr = await signer.getAddress();
      const vaultAddr = await c.vault.getAddress();
      const veAddr = await ve.getAddress();
      const tid = normalizeTokenId(tokenId);

      const veWrite = new Contract(veAddr, ERC721_APPROVAL_ABI, signer);

      // Verify ownership
      const chainOwner = (await veWrite.ownerOf(tid)).toLowerCase();
      if (chainOwner !== ownerAddr.toLowerCase()) {
        throw new Error("This veNFT isn’t owned by your connected wallet.");
      }

      // Snapshot
      let isAll = false;
      try { isAll = await veWrite.isApprovedForAll(ownerAddr, vaultAddr); } catch {}
      let tokApproved = ethers.ZeroAddress;
      try { tokApproved = await veWrite.getApproved(tid); } catch {}
      if (DEBUG)
        console.debug("[ensureVeNftApproval] pre", {
          owner: ownerAddr, vault: vaultAddr, tokenId: tid.toString(),
          isApprovedForAll: isAll, getApproved: tokApproved
        });

      if (isAll || toLower(tokApproved) === toLower(vaultAddr)) {
        if (DEBUG) console.debug("[ensureVeNftApproval] approval already sufficient");
        return;
      }

      // Per-token approve
      onProgress?.("Approving this veNFT for the vault…");
      if (DEBUG) console.debug("[ensureVeNftApproval] approve(vault, tokenId)");
      const tx = await veWrite.approve(vaultAddr, tid);
      if (DEBUG) console.debug("[ensureVeNftApproval] approval tx:", (tx as any)?.hash);
      const rc = await tx.wait();
      if (DEBUG) console.debug("[ensureVeNftApproval] receipt status:", rc?.status);

      const afterApproved = await veWrite.getApproved(tid).catch(() => ethers.ZeroAddress);
      if (DEBUG) console.debug("[ensureVeNftApproval] post getApproved:", afterApproved);

      if (toLower(afterApproved) !== toLower(vaultAddr)) {
        if (USE_PER_TOKEN_APPROVALS_ONLY) {
          throw new Error("Failed to approve this veNFT to the vault.");
        } else {
          const tx2 = await (veWrite as any).setApprovalForAll?.(vaultAddr, true);
          if (tx2) {
            await tx2.wait();
            const afterAll = await veWrite.isApprovedForAll(ownerAddr, vaultAddr);
            if (!afterAll) throw new Error("Failed to grant operator approval to the vault.");
          } else {
            throw new Error("Approval not set despite successful transaction.");
          }
        }
      }
    },
    [getContracts]
  );


  /* -------------------------- Deposit veNFT (CAST-like) -------------------- */

  const depositVeNFT = useCallback(
    async (
      tokenId: string | number | bigint,
      onSuccess?: SuccessCallback,
      onError?: ErrorCallback,
      onProgress?: ProgressCallback
    ) => {
      setLoading(true);
      const txId = "depositVeNFT";
      dispatch({ type: "SET_TRANSACTION_LOADING", payload: { id: txId, loading: true } });

      try {
        const c = await getContracts(true);
        const ve = c?.VeAEROResolved;
        const vaultBase = c?.vault;
        if (!ve || !vaultBase) throw new Error("Contracts not initialized");

        const signer = vaultBase.runner as ethers.Signer;
        if (!signer || typeof (signer as any).sendTransaction !== "function") {
          throw new Error("No signer bound to vault (write calls require a signer).");
        }

        const provider = signer.provider!;
        const user = await signer.getAddress();
        const vaultAddr = await vaultBase.getAddress();
        const veAddr = await ve.getAddress();
        const tid = typeof tokenId === "bigint" ? tokenId : normalizeTokenId(tokenId);
        const netDesc = await describeNetwork(signer);

        console.debug("[depositVeNFT] === CONTEXT ===", {
          user, vault: vaultAddr, ve: veAddr, tokenId: tid.toString(), net: netDesc
        });

        // Ownership & per-token approval
        const onChainOwner = (await ve.ownerOf(tid)).toLowerCase();
        if (onChainOwner !== user.toLowerCase()) {
          throw new Error(`This veNFT isn’t owned by your connected wallet.\nOwner on-chain: ${onChainOwner}\nConnected: ${user}`);
        }

        onProgress?.("Approving this veNFT for the vault…");
        const approved = await ve.getApproved(tid).catch(() => ethers.ZeroAddress);
        if (toLower(approved) !== toLower(vaultAddr)) {
          const txA = await ve.approve(vaultAddr, tid);
          console.debug("[depositVeNFT] approve tx:", (txA as any)?.hash);
          await txA.wait();
        } else {
          console.debug("[depositVeNFT] already approved for token:", tid.toString());
        }

        const { data, selector } = buildVaultDepositData(tid);
        const fee = await getFeePlan(provider);

        /* --------------------- PATH 1: EIP-1193 Type-2 --------------------- */
        if (fee.maxFeePerGas && fee.maxPriorityFeePerGas) {
          onProgress?.("Sending deposit (EIP‑1193 type‑2)…");
          const r = await sendViaEip1193(
            signer,
            {
              from: user,
              to: vaultAddr,
              data,
              gas: FALLBACK_GAS_DEPOSIT_VENFT,
              value: 0n,
              maxFeePerGas: fee.maxFeePerGas,
              maxPriorityFeePerGas: fee.maxPriorityFeePerGas
            },
            data,
            "eip1193-type2"
          );
          if (r && !r.mutated) {
            onProgress?.("Confirming transaction…");
            const receipt = await provider.waitForTransaction(r.hash);
            if (receipt?.status !== 1) throw new Error("depositVeNFT reverted on-chain.");

            const mergedInto = await detectMergeTarget(receipt as any, ve);
            onProgress?.("Updating balances…");
            await retry(async () => {
              await loadBalances();
            });
            onProgress?.("Complete!");
            onSuccess?.(receipt as any);
            return receipt as any;
          }
        }

        /* --------------------- PATH 2: EIP-1193 Legacy --------------------- */
        if (fee.legacyGasPrice) {
          onProgress?.("Sending deposit (EIP‑1193 legacy)…");
          const r = await sendViaEip1193(
            signer,
            {
              from: user,
              to: vaultAddr,
              data,
              gas: FALLBACK_GAS_DEPOSIT_VENFT,
              value: 0n,
              gasPrice: fee.legacyGasPrice
            },
            data,
            "eip1193-legacy"
          );
          if (r && !r.mutated) {
            onProgress?.("Confirming transaction…");
            const receipt = await provider.waitForTransaction(r.hash);
            if (receipt?.status !== 1) throw new Error("depositVeNFT reverted on-chain.");
  
            const mergedInto = await detectMergeTarget(receipt as any, ve);
            if (mergedInto) {
              console.debug(`[depositVeNFT] NFT ${tid} was merged into NFT ${mergedInto}`);
            }
  
            onProgress?.("Updating balances…");
            await retry(async () => {
              await loadBalances();
            });
            onProgress?.("Complete!");
            onSuccess?.(receipt as any);
            return receipt as any;
          }
        }

        /* ------------- PATH 3 & 4: Wallet-managed sendTransaction ---------- */
        async function sendWalletManagedOnce(
          req: any,
          label: string
        ): Promise<any | null> {
          try {
            console.debug(`[${label}] sendTransaction request:`, pretty(req));
            const sent = await signer.sendTransaction(req);
            console.debug(`[${label}] hash:`, sent.hash, "| selector:", selector);
            const status = await verifyMempoolData(provider, sent.hash, data);
            if (status !== "mismatch") return sent;
            console.error(`[${label}] Wallet/provider mutated or stripped calldata.`);
            return null;
          } catch (e) {
            console.warn(`[${label}] failed`, e);
            return null;
          }
        }

        const baseWM: any = {
          to: vaultAddr,
          data,
          value: 0n,
          gasLimit: FALLBACK_GAS_DEPOSIT_VENFT
        };

        // Type-2
        if (fee.maxFeePerGas && fee.maxPriorityFeePerGas) {
          onProgress?.("Sending deposit (wallet type-2)…");
          const a = await sendWalletManagedOnce(
            { ...baseWM, type: 2, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas, from: user },
            "wallet-type2-with-from"
          ) || await sendWalletManagedOnce(
            { ...baseWM, type: 2, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas },
            "wallet-type2-no-from"
          );
          if (a) {
            onProgress?.("Confirming transaction…");
            const receipt = (await a.wait()) as ContractTransactionReceipt;
            if (receipt?.status !== 1) throw new Error("depositVeNFT reverted on-chain.");

            const mergedInto = await detectMergeTarget(receipt as any, ve);
            if (mergedInto) {
              console.debug(`[depositVeNFT] NFT ${tid} was merged into NFT ${mergedInto}`);
            }

            onProgress?.("Updating balances…");
            await retry(async () => {
              await loadBalances();
            });
            onProgress?.("Complete!");
            onSuccess?.(receipt);
            return receipt;
          }
        }

        // Legacy
        if (fee.legacyGasPrice) {
          onProgress?.("Sending deposit (wallet legacy)…");
          const b = await sendWalletManagedOnce(
            { ...baseWM, type: 0, gasPrice: fee.legacyGasPrice, from: user },
            "wallet-legacy-with-from"
          ) || await sendWalletManagedOnce(
            { ...baseWM, type: 0, gasPrice: fee.legacyGasPrice },
            "wallet-legacy-no-from"
          );
          if (b) {
            onProgress?.("Confirming transaction…");
            const receipt = (await b.wait()) as ContractTransactionReceipt;
            if (receipt?.status !== 1) throw new Error("depositVeNFT reverted on-chain.");
            
            const mergedInto = await detectMergeTarget(receipt as any, ve);
            if (mergedInto) {
              console.debug(`[depositVeNFT] NFT ${tid} was merged into NFT ${mergedInto}`);
            }

            onProgress?.("Updating balances…");
            await retry(async () => {
              await loadBalances();
            });
            onProgress?.("Complete!");
            onSuccess?.(receipt);
            return receipt;
          }
        }

        /* ---------------- PATH 5 & 6: Contract writer paths ---------------- */
        const vaultWrite = new Contract(vaultAddr, VAULT_MIN_ABI, signer);

        // Writer type-2
        if (fee.maxFeePerGas && fee.maxPriorityFeePerGas) {
          onProgress?.("Sending deposit (writer type-2)…");
          try {
            const tx = await (vaultWrite as any).depositVeNFT(tid, {
              gasLimit: FALLBACK_GAS_DEPOSIT_VENFT,
              type: 2,
              maxFeePerGas: fee.maxFeePerGas,
              maxPriorityFeePerGas: fee.maxPriorityFeePerGas
            });
            const hash = (tx as any)?.hash;
            const status = await verifyMempoolData(provider, hash, data);
            if (status !== "mismatch") {
              onProgress?.("Confirming transaction…");
              const rc = (await tx.wait()) as ContractTransactionReceipt;
              if (rc?.status !== 1) throw new Error("depositVeNFT reverted on-chain.");
              
              const mergedInto = await detectMergeTarget(rc as any, ve);
              if (mergedInto) {
                console.debug(`[depositVeNFT] NFT ${tid} was merged into NFT ${mergedInto}`);
              }

              onProgress?.("Updating balances…");
              await loadBalances();
              onProgress?.("Complete!");
              onSuccess?.(rc);
              return rc;
            } else {
              console.error("[writer-...] Wallet/provider mutated/stripped calldata.");
            }
          } catch (e) {
            console.warn("[writer-type2] failed", e);
          }
        }

        // Writer legacy
        if (fee.legacyGasPrice) {
          onProgress?.("Sending deposit (writer legacy)…");
          try {
            const tx = await (vaultWrite as any).depositVeNFT(tid, {
              gasLimit: FALLBACK_GAS_DEPOSIT_VENFT,
              type: 0,
              gasPrice: fee.legacyGasPrice
            });
            const hash = (tx as any)?.hash;
            const status = await verifyMempoolData(provider, hash, data);
            if (status !== "mismatch") {
              onProgress?.("Confirming transaction…");
              const rc = (await tx.wait()) as ContractTransactionReceipt;
              if (rc?.status !== 1) throw new Error("depositVeNFT reverted on-chain.");
              
              const mergedInto = await detectMergeTarget(rc as any, ve);
              if (mergedInto) {
                console.debug(`[depositVeNFT] NFT ${tid} was merged into NFT ${mergedInto}`);
              }

              onProgress?.("Updating balances…");
              await loadBalances();
              onProgress?.("Complete!");
              onSuccess?.(rc);
              return rc;
            } else {
              console.error("[writer-legacy] Wallet/provider mutated/stripped calldata.");
            }
          } catch (e) {
            console.warn("[writer-legacy] failed", e);
          }
        }

        // If we got here, every path produced mutated calldata or failed.
        throw new Error(
          "All send paths failed or the wallet/provider stripped calldata.\n" +
          "Try disabling 'transaction simulation / protect' in your wallet, or switch wallets (MetaMask / Rabby), and try again."
        );
      } catch (error) {
        console.error("[depositVeNFT] error:", error);
        onError?.(error);
        throw error;
      } finally {
        setLoading(false);
        dispatch({ type: "SET_TRANSACTION_LOADING", payload: { id: txId, loading: false } });
      }
    },
    [getContracts, dispatch, loadBalances]
  );

  /* ----------------------------- Vault status ------------------------------ */

  const getVaultStatus = useCallback(async (): Promise<VaultStatus | null> => {
    try {
      const c = await getContracts();
      if (!c?.vault) return null;

      const status = await c.vault.vaultStatus();
      let maxTime: number;
      try {
        const max = await (c.vault as any).MAXTIME?.();
        maxTime = Number(max ?? 0);
      } catch {
        maxTime = 4 * 365 * 24 * 60 * 60; // 4 years fallback
      }

      const v: VaultStatus = {
        totalUserDeposits: fmtEth(status[0]),
        totalProtocolOwned: fmtEth(status[1]),
        actualFeesCollected: fmtEth(status[2]),
        virtualFeesOwed: fmtEth(status[3]),
        primaryNFTId: (status[4] ?? 0n).toString(),
        primaryNFTBalance: fmtEth(status[5]),
        primaryNFTVotingPower: fmtEth(status[6]),
        primaryNFTUnlockTime: (status[7] ?? 0n).toString(),
        additionalNFTCount: (status[8] ?? 0n).toString(),
        needsRebase: Boolean(status[9]),
        needsMerge: Boolean(status[10]),
        MAXTIME: maxTime,
      };
      if (DEBUG) console.debug("[getVaultStatus]", v);
      return v;
    } catch (e) {
      console.error("[getVaultStatus] error:", e);
      return null;
    }
  }, [getContracts]);

  /* ------------------------------ Exports ---------------------------------- */

  return {
    loading,
    // deposits
    depositAero,
    depositVeNFT,
    // approvals / previews
    approveAero,
    checkAeroApproval,
    calculateLiqRewards,
    // info
    getUserVeNFTs,
    getVaultStatus,
  };
};
