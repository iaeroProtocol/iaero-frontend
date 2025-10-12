// src/contracts/hooks/useVault.ts
import { useState, useCallback } from "react";
import { useAccount, useChainId, useWriteContract, usePublicClient } from 'wagmi';
import { getContractAddress } from "../addresses";
import { ABIS } from "../abis";
import { useProtocol } from "../../contexts/ProtocolContext";

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
type SuccessCallback = (receipt: any) => void;
type ErrorCallback = (error: any) => void;

const isUserRejection = (error: any): boolean =>
  error?.name === 'UserRejectedRequestError' ||
  error?.message?.toLowerCase?.().includes('user rejected');

const safeFormatEther = (value: bigint | undefined): string => {
  if (!value) return '0';
  return (Number(value) / 1e18).toString();
};

const parseEther = (value: string): bigint => {
  try {
    return BigInt(Math.floor(parseFloat(value) * 1e18));
  } catch {
    return 0n;
  }
};

export const useVault = () => {
  const { address } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { loadBalances, loadAllowances, setTransactionLoading } = useProtocol();
  
  const [loading, setLoading] = useState(false);
  const { writeContractAsync } = useWriteContract();

  const getAddr = useCallback((name: any) => {
    try {
      return getContractAddress(name, chainId);
    } catch {
      return undefined;
    }
  }, [chainId]);

  // Calculate LIQ rewards preview
  const calculateLiqRewards = useCallback(async (aeroAmount: string) => {
    try {
      const vaultAddr = getAddr('PermalockVault');
      if (!vaultAddr || !publicClient) {
        throw new Error("Vault not initialized");
      }

      const wei = parseEther(aeroAmount);
      
      const result = await publicClient.readContract({
        address: vaultAddr,
        abi: ABIS.PermalockVault,
        functionName: 'previewDeposit',
        args: [wei],
      }) as any;

      const iAeroToUser = safeFormatEther(result?.[0]);
      const liqToUser = safeFormatEther(result?.[2]);
      
      const iAeroNum = parseFloat(iAeroToUser);
      const liqNum = parseFloat(liqToUser);
      const effectiveRate = iAeroNum > 0 ? (liqNum / iAeroNum).toFixed(4) : "0.0";
      
      // Calculate next halving
      let nextHalvingIn = "0.0";
      try {
        const totalMinted = await publicClient.readContract({
          address: vaultAddr,
          abi: ABIS.PermalockVault,
          functionName: 'totalLIQMinted',
        }) as bigint;

        const halvingStep = 5_000_000n * 10n ** 18n;
        const currentHalvingIndex = totalMinted / halvingStep;
        const nextHalvingThreshold = (currentHalvingIndex + 1n) * halvingStep;
        const untilNextHalving = nextHalvingThreshold - totalMinted;
        nextHalvingIn = safeFormatEther(untilNextHalving);
      } catch (e) {
        console.debug("Could not fetch halving info:", e);
      }

      return { liqToUser, effectiveRate, nextHalvingIn };
    } catch (error) {
      console.error("calculateLiqRewards error:", error);
      throw error;
    }
  }, [publicClient, getAddr]);

  // Check AERO approval
  const checkAeroApproval = useCallback(async (amount: string): Promise<boolean> => {
    if (!address || !publicClient) return false;
    
    try {
      const vaultAddr = getAddr('PermalockVault');
      const aeroAddr = getAddr('AERO');
      if (!vaultAddr || !aeroAddr) return false;

      const allowance = await publicClient.readContract({
        address: aeroAddr,
        abi: ABIS.AERO,
        functionName: 'allowance',
        args: [address, vaultAddr],
      }) as bigint;

      return allowance >= parseEther(amount);
    } catch (e) {
      console.error("checkAeroApproval failed:", e);
      return false;
    }
  }, [address, publicClient, getAddr]);

  // Approve AERO
  const approveAero = useCallback(async (
    amount: string,
    onSuccess?: SuccessCallback,
    onError?: ErrorCallback
  ) => {
    const txId = "approveAero";
    setTransactionLoading(txId, true);
    
    try {
      const vaultAddr = getAddr('PermalockVault');
      const aeroAddr = getAddr('AERO');
      if (!vaultAddr || !aeroAddr) throw new Error("Contracts not initialized");

      const amountWei = parseEther(amount);
      
      // Check current allowance
      const isApproved = await checkAeroApproval(amount);
      if (isApproved) {
        await loadAllowances();
        return undefined;
      }

      const hash = await writeContractAsync({
        address: aeroAddr,
        abi: ABIS.AERO,
        functionName: 'approve',
        args: [vaultAddr, amountWei],
      });

      const receipt = await publicClient?.waitForTransactionReceipt({ hash });
      
      await loadAllowances();
      onSuccess?.(receipt);
      return receipt;
    } catch (e: any) {
      console.error("approveAero error:", e);
      onError?.(e);
      throw e;
    } finally {
      setTransactionLoading(txId, false);
    }
  }, [address, publicClient, writeContractAsync, getAddr, checkAeroApproval, loadAllowances, setTransactionLoading]);

  // Deposit AERO
  const depositAero = useCallback(async (
    amount: string,
    onSuccess?: SuccessCallback,
    onError?: ErrorCallback,
    onProgress?: ProgressCallback
  ) => {
    setLoading(true);
    const txId = "depositAero";
    setTransactionLoading(txId, true);
    
    try {
      const vaultAddr = getAddr('PermalockVault');
      if (!vaultAddr) throw new Error("Vault contract not initialized");

      onProgress?.("Checking allowance…");
      const hasApproval = await checkAeroApproval(amount);
      
      if (!hasApproval) {
        onProgress?.("Approving AERO spending…");
        await approveAero(amount);
      }

      const wei = parseEther(amount);
      
      onProgress?.("Depositing AERO…");
      const hash = await writeContractAsync({
        address: vaultAddr,
        abi: ABIS.PermalockVault,
        functionName: 'deposit',
        args: [wei],
      });

      onProgress?.("Confirming…");
      const receipt = await publicClient?.waitForTransactionReceipt({ hash });

      onProgress?.("Updating balances…");
      await Promise.all([loadBalances(), loadAllowances()]);

      onSuccess?.(receipt);
      return receipt;
    } catch (e: any) {
      console.error("depositAero error:", e);
      onError?.(e);
      throw e;
    } finally {
      setLoading(false);
      setTransactionLoading(txId, false);
    }
  }, [
    publicClient,
    writeContractAsync,
    getAddr,
    checkAeroApproval,
    approveAero,
    loadBalances,
    loadAllowances,
    setTransactionLoading
  ]);

  // Get user veNFTs
  const getUserVeNFTs = useCallback(async (): Promise<VeNFT[]> => {
    if (!address || !publicClient) return [];

    try {
      const veAddr = getAddr('VeAERO') || getAddr('MockVeAERO');
      if (!veAddr) return [];

      const balance = await publicClient.readContract({
        address: veAddr,
        abi: ABIS.VeAERO,
        functionName: 'balanceOf',
        args: [address],
      }) as bigint;

      const bal = Number(balance);
      if (bal === 0) return [];

      const nfts: VeNFT[] = [];
      
      for (let i = 0; i < bal; i++) {
        try {
          const tokenId = await publicClient.readContract({
            address: veAddr,
            abi: ABIS.VeAERO,
            functionName: 'ownerToNFTokenIdList',
            args: [address, BigInt(i)],
          }) as bigint;

          const locked = await publicClient.readContract({
            address: veAddr,
            abi: ABIS.VeAERO,
            functionName: 'locked',
            args: [tokenId],
          }) as any;

          const amount = safeFormatEther(locked?.amount || 0n);
          const end = Number(locked?.end || 0n);
          const isPermanent = Boolean(locked?.isPermanent);

          nfts.push({
            id: tokenId.toString(),
            locked: amount,
            unlockDate: end ? new Date(end * 1000).toLocaleDateString() : "—",
            isPermanent,
          });
        } catch (err) {
          console.warn(`Failed to get NFT at index ${i}:`, err);
        }
      }

      return nfts;
    } catch (e) {
      console.error("getUserVeNFTs error:", e);
      return [];
    }
  }, [address, publicClient, getAddr]);

  // Deposit veNFT
  const depositVeNFT = useCallback(async (
    tokenId: string | number | bigint,
    onSuccess?: SuccessCallback,
    onError?: ErrorCallback,
    onProgress?: ProgressCallback
  ) => {
    setLoading(true);
    const txId = "depositVeNFT";
    setTransactionLoading(txId, true);

    try {
      const vaultAddr = getAddr('PermalockVault');
      const veAddr = getAddr('VeAERO') || getAddr('MockVeAERO');
      
      if (!vaultAddr || !veAddr || !address) {
        throw new Error("Contracts not initialized");
      }

      const tid = typeof tokenId === 'bigint' ? tokenId : BigInt(tokenId);

      // Check ownership
      const owner = await publicClient?.readContract({
        address: veAddr,
        abi: ABIS.VeAERO,
        functionName: 'ownerOf',
        args: [tid],
      }) as string;

      if (owner.toLowerCase() !== address.toLowerCase()) {
        throw new Error("This veNFT isn't owned by your connected wallet.");
      }

      // Check/set approval
      onProgress?.("Approving this veNFT for the vault…");
      const approved = await publicClient?.readContract({
        address: veAddr,
        abi: ABIS.VeAERO,
        functionName: 'getApproved',
        args: [tid],
      }) as string;

      if (approved.toLowerCase() !== vaultAddr.toLowerCase()) {
        const approvalHash = await writeContractAsync({
          address: veAddr,
          abi: ABIS.VeAERO,
          functionName: 'approve',
          args: [vaultAddr, tid],
        });
        
        await publicClient?.waitForTransactionReceipt({ hash: approvalHash });
      }

      // Deposit veNFT
      onProgress?.("Depositing veNFT to vault…");
      const hash = await writeContractAsync({
        address: vaultAddr,
        abi: ABIS.PermalockVault,
        functionName: 'depositVeNFT',
        args: [tid],
        gas: 900_000n, // Conservative gas limit
      });

      onProgress?.("Confirming transaction…");
      const receipt = await publicClient?.waitForTransactionReceipt({ hash });

      if (!receipt || receipt.status !== 'success') {
        throw new Error("depositVeNFT reverted on-chain.");
      }

      onProgress?.("Updating balances…");
      await loadBalances();
      
      onProgress?.("Complete!");
      onSuccess?.(receipt);
      return receipt;
    } catch (error: any) {
      console.error("depositVeNFT error:", error);
      onError?.(error);
      throw error;
    } finally {
      setLoading(false);
      setTransactionLoading(txId, false);
    }
  }, [
    address,
    publicClient,
    writeContractAsync,
    getAddr,
    loadBalances,
    setTransactionLoading
  ]);

  // Get vault status
  const getVaultStatus = useCallback(async (): Promise<VaultStatus | null> => {
    try {
      const vaultAddr = getAddr('PermalockVault');
      if (!vaultAddr || !publicClient) return null;

      const status = await publicClient.readContract({
        address: vaultAddr,
        abi: ABIS.PermalockVault,
        functionName: 'vaultStatus',
      }) as any;

      let maxTime = 4 * 365 * 24 * 60 * 60; // 4 years default
      try {
        const max = await publicClient.readContract({
          address: vaultAddr,
          abi: ABIS.PermalockVault,
          functionName: 'MAXTIME',
        }) as bigint;
        maxTime = Number(max);
      } catch {}

      return {
        totalUserDeposits: safeFormatEther(status[0]),
        totalProtocolOwned: safeFormatEther(status[1]),
        actualFeesCollected: safeFormatEther(status[2]),
        virtualFeesOwed: safeFormatEther(status[3]),
        primaryNFTId: (status[4] ?? 0n).toString(),
        primaryNFTBalance: safeFormatEther(status[5]),
        primaryNFTVotingPower: safeFormatEther(status[6]),
        primaryNFTUnlockTime: (status[7] ?? 0n).toString(),
        additionalNFTCount: (status[8] ?? 0n).toString(),
        needsRebase: Boolean(status[9]),
        needsMerge: Boolean(status[10]),
        MAXTIME: maxTime,
      };
    } catch (e) {
      console.error("getVaultStatus error:", e);
      return null;
    }
  }, [publicClient, getAddr]);

  return {
    loading,
    depositAero,
    depositVeNFT,
    approveAero,
    checkAeroApproval,
    calculateLiqRewards,
    getUserVeNFTs,
    getVaultStatus,
  };
};