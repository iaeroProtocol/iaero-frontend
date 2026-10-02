// src/components/SwitchToBase.tsx
//
// The one "your wallet is on the wrong network" prompt: protocol sections and the page banner use it when a
// connected wallet sits on Ethereum, Arbitrum (where "Get iAERO" payments leave it) or any other chain.

'use client';

import React from 'react';
import { useAccount, useSwitchChain } from 'wagmi';
import { base } from 'wagmi/chains';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { chainName } from '@/lib/protocol-chain';

export function SwitchToBaseButton({ className = '' }: { className?: string }) {
  const { switchChain, isPending } = useSwitchChain();
  return (
    <Button onClick={() => switchChain({ chainId: base.id })} disabled={isPending} className={`bg-amber-600 hover:bg-amber-700 ${className}`}>
      {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Switch to Base
    </Button>
  );
}

/** A card for a section that needs Base: shown instead of its content while the wallet is elsewhere. */
export function SwitchToBaseCard({ what }: { what: string }) {
  const { chainId } = useAccount();
  return (
    <div className="space-y-4 rounded-xl border border-amber-500/20 bg-amber-500/10 p-6 text-center">
      <AlertTriangle className="mx-auto h-10 w-10 text-amber-400" />
      <div>
        <h3 className="text-lg font-semibold text-white">Switch to Base</h3>
        <p className="mt-1 text-sm text-slate-300">Your wallet is on {chainName(chainId)}. iAERO runs on Base: switch to {what}.</p>
      </div>
      <SwitchToBaseButton />
    </div>
  );
}

/** A slim page-wide banner while a connected wallet is off Base. */
export function WrongNetworkBanner() {
  const { chainId } = useAccount();
  return (
    <div role="status" className="mx-auto mb-6 flex w-full max-w-7xl flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
      <span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" /> Your wallet is on {chainName(chainId)}. iAERO runs on Base.</span>
      <SwitchToBaseButton className="h-8 px-3 text-sm" />
    </div>
  );
}
