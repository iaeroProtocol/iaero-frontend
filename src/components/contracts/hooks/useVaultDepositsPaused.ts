// src/components/contracts/hooks/useVaultDepositsPaused.ts
//
// Whether minting iAERO is closed. PermalockVault refuses `deposit` and `depositVeNFT` while it is paused
// (OpenZeppelin's EnforcedPause()) or its emergency flag is set ("Emergency pause active"). The owner Safe set
// both on 2026-10-16 to move the protocol's veAERO to Aero.
//
// Until the vault answers, deposits count as closed, so a slow or failed read never offers a deposit that would
// fail. Only an explicit "not paused" on both flags reopens them.

'use client';

import { useReadContracts } from 'wagmi';
import { getContractAddress } from '@/components/contracts/addresses';
import { ABIS } from '@/components/contracts/abis';
import { useProtocolChainId } from '@/lib/protocol-chain';

export const DEPOSITS_PAUSED_MESSAGE = 'Deposits are paused for the Aero upgrade. Minting reopens after the migration.';

export function useVaultDepositsPaused(): boolean {
  const chainId = useProtocolChainId();
  const vault = getContractAddress('PermalockVault', chainId);
  const { data } = useReadContracts({
    contracts: [
      { address: vault, abi: ABIS.PermalockVault, functionName: 'paused', chainId },
      { address: vault, abi: ABIS.PermalockVault, functionName: 'emergencyPause', chainId },
    ],
  });
  const open = data?.every(r => r.status === 'success' && r.result === false) ?? false;
  return !open;
}
