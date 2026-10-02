// src/components/SwitchToBase.tsx
//
// The one "your wallet is on the wrong network" prompt: protocol sections and the page banner use it when a
// connected wallet sits on Ethereum, Arbitrum (where "Get iAERO" payments leave it) or any other chain.

'use client';

import React, { useCallback } from 'react';
import { useAccount, useSwitchChain } from 'wagmi';
import { base } from 'wagmi/chains';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { chainName } from '@/lib/protocol-chain';

export type ShowToast = (message: string, type: 'success' | 'error' | 'info' | 'warning') => void;

const isUserRejection = (e: any) =>
  e?.code === 4001 || e?.name === 'UserRejectedRequestError' || /user (rejected|denied)/i.test(String(e?.message ?? ''));

/** Asks the wallet to switch to Base; says so when the user declines or the wallet can't. */
export function useSwitchToBase(showToast?: ShowToast) {
  const { switchChainAsync, isPending } = useSwitchChain();
  const switchToBase = useCallback(async () => {
    try {
      await switchChainAsync({ chainId: base.id });
    } catch (e) {
      if (isUserRejection(e)) showToast?.('Network switch declined in your wallet. iAERO needs Base.', 'warning');
      else showToast?.("Your wallet couldn't switch to Base. Switch to Base in the wallet itself.", 'error');
    }
  }, [switchChainAsync, showToast]);
  return { switchToBase, isPending };
}

export function SwitchToBaseButton({ className = '', showToast }: { className?: string; showToast?: ShowToast }) {
  const { switchToBase, isPending } = useSwitchToBase(showToast);
  return (
    <Button onClick={switchToBase} disabled={isPending} className={`bg-amber-600 hover:bg-amber-700 ${className}`}>
      {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Switch to Base
    </Button>
  );
}

/** A card for a section that needs Base: shown instead of its content while the wallet is elsewhere. */
export function SwitchToBaseCard({ what, showToast }: { what: string; showToast?: ShowToast }) {
  const { chainId } = useAccount();
  return (
    <div className="space-y-4 rounded-xl border border-amber-500/20 bg-amber-500/10 p-6 text-center">
      <AlertTriangle className="mx-auto h-10 w-10 text-amber-400" />
      <div>
        <h3 className="text-lg font-semibold text-white">Switch to Base</h3>
        <p className="mt-1 text-sm text-slate-300">
          Your wallet is on {chainName(chainId) ?? 'an unsupported network'}. iAERO runs on Base: switch to {what}.
        </p>
      </div>
      <SwitchToBaseButton showToast={showToast} />
    </div>
  );
}

/** A slim page-wide banner while a connected wallet is off Base. */
export function WrongNetworkBanner() {
  const { chainId } = useAccount();
  return (
    <div role="status" className="mx-auto mb-6 flex w-full max-w-7xl flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
      <span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" /> Your wallet is on {chainName(chainId) ?? 'an unsupported network'}. iAERO runs on Base.</span>
      <SwitchToBaseButton className="h-8 px-3 text-sm" />
    </div>
  );
}
