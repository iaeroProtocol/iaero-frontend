"use client";

import React, { useMemo } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Button } from "@/components/ui/button";
import { ChevronDown, Check, AlertCircle } from "lucide-react";
import { switchToBase, switchToBaseSepolia } from "@/components/lib/ethereum";
import { useProtocol } from "@/components/contexts/ProtocolContext";
import { cn } from "@/lib/utils";

const CHAINS = [
  { id: 8453, label: "Base", action: switchToBase },
  { id: 84532, label: "Base Sepolia", action: switchToBaseSepolia },
] as const;

export default function NetworkSwitcher({ className }: { className?: string }) {
  const { chainId, networkSupported } = useProtocol();

  const current = useMemo(
    () => CHAINS.find((c) => c.id === chainId) ?? { id: chainId, label: chainId ? `Chain ${chainId}` : "—" },
    [chainId]
  );

  return (
    <div className={cn("flex items-center gap-3", className)}>
      {/* Dropdown trigger */}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button
            size="sm"
            className="h-10 rounded-xl bg-slate-800/70 hover:bg-slate-700/70 border border-slate-600/30 
                       text-slate-100 px-4 gap-2 shadow-sm"
          >
            {current.label}
            <ChevronDown className="h-4 w-4 opacity-80" />
          </Button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Content
          sideOffset={8}
          className="z-50 min-w-[200px] rounded-xl border border-slate-700/60 bg-slate-900/95 
                     p-1 shadow-2xl backdrop-blur"
        >
          {CHAINS.map((c) => (
            <DropdownMenu.Item
              key={c.id}
              onClick={() => c.action()}
              className={cn(
                "relative flex cursor-pointer select-none items-center rounded-lg px-3 py-2 text-sm",
                "outline-none focus:bg-slate-800/80 hover:bg-slate-800/60 text-slate-200"
              )}
            >
              <span
                className={cn(
                  "mr-2 h-2 w-2 rounded-full",
                  c.id === 8453 ? "bg-emerald-400" : "bg-blue-400"
                )}
              />
              {c.label}
              {chainId === c.id && <Check className="ml-auto h-4 w-4 opacity-80" />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Root>

      {/* Single status pill (no extra one below) */}
      <div className="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1">
        <span className="mr-2 h-2 w-2 rounded-full bg-emerald-400" />
        <span className="text-xs font-medium text-emerald-300">
          {current.label === "—" ? "Not connected" : current.label}
        </span>
        {!networkSupported && (
          <span className="ml-2 inline-flex items-center text-[10px] text-amber-300">
            <AlertCircle className="mr-1 h-3 w-3" />
            unsupported
          </span>
        )}
      </div>
    </div>
  );
}
