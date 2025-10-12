// src/components/NetworkSwitcher.tsx
"use client";

import React from "react";
import { useChainId, useSwitchChain } from 'wagmi';
import { base, baseSepolia } from 'wagmi/chains';
import { Button } from "@/components/ui/button";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, Check } from "lucide-react";

const CHAINS = [base, baseSepolia];

export default function NetworkSwitcher() {
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  
  const currentChain = CHAINS.find(c => c.id === chainId) || base;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button size="sm" className="h-10 rounded-xl bg-slate-800/70">
          {currentChain.name}
          <ChevronDown className="h-4 w-4 ml-2" />
        </Button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Content className="z-50 min-w-[200px] rounded-xl bg-slate-900/95 p-1">
        {CHAINS.map((chain) => (
          <DropdownMenu.Item
            key={chain.id}
            onClick={() => switchChain?.({ chainId: chain.id })}
            className="flex items-center rounded-lg px-3 py-2 cursor-pointer hover:bg-slate-800/60"
          >
            {chain.name}
            {chainId === chain.id && <Check className="ml-auto h-4 w-4" />}
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}