// src/components/NetworkSwitcher.tsx
"use client";

import React, { useEffect, useState } from "react";
import { useAccount, useSwitchChain } from 'wagmi';
import { base, baseSepolia } from 'wagmi/chains';
import { Button } from "@/components/ui/button";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, Check, AlertTriangle } from "lucide-react";
import { chainName } from '@/lib/protocol-chain';
import { isUserRejection } from '@/components/lib/tx-errors';

const CHAINS = [base, baseSepolia];

export default function NetworkSwitcher() {
  // The wallet's own chain: it can be Ethereum or Arbitrum after paying for a Get iAERO order.
  const { chainId, isConnected } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  // A switch the wallet declined or couldn't do says so here (this header sits outside the page's toasts).
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 5000);
    return () => clearTimeout(t);
  }, [note]);
  const switchTo = async (id: number, name: string) => {
    setNote(null);
    try { await switchChainAsync({ chainId: id }); } catch (e) {
      setNote(isUserRejection(e) ? `Switching to ${name} was declined in your wallet.` : `Your wallet couldn’t switch to ${name}. Switch it there.`);
    }
  };

  const currentChain = CHAINS.find(c => c.id === chainId);
  const wrong = isConnected && !!chainId && !currentChain;

  return (
    <div className="relative">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button size="sm" className={`h-10 rounded-xl ${wrong ? 'bg-amber-600/80 hover:bg-amber-600' : 'bg-slate-800/70'}`}>
            {wrong && <AlertTriangle className="h-4 w-4 mr-1.5" />}
            {wrong ? chainName(chainId) ?? 'Unsupported network' : (currentChain ?? base).name}
            <ChevronDown className="h-4 w-4 ml-2" />
          </Button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Content className="z-50 min-w-[200px] rounded-xl bg-slate-900/95 p-1">
          {wrong && <div className="px-3 py-2 text-xs text-amber-300">iAERO runs on Base</div>}
          {CHAINS.map((chain) => (
            <DropdownMenu.Item
              key={chain.id}
              onClick={() => switchTo(chain.id, chain.name)}
              className="flex items-center rounded-lg px-3 py-2 cursor-pointer hover:bg-slate-800/60"
            >
              {chain.name}
              {chainId === chain.id && <Check className="ml-auto h-4 w-4" />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
      {note && (
        <div role="status" className="absolute right-0 top-full z-50 mt-2 w-64 rounded-lg border border-amber-500/30 bg-slate-900/95 p-2 text-xs text-amber-200 shadow-lg">
          {note}
        </div>
      )}
    </div>
  );
}
