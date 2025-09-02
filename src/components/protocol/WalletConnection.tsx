
// =============================
// src/components/protocol/WalletConnection.tsx
// =============================
import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Wallet, LogOut, AlertTriangle, Loader2, Copy } from "lucide-react";
import { useProtocol } from "@/components/contexts/ProtocolContext";
import { switchToBase, formatAddress } from "../lib/ethereum";

export default function WalletConnection() {
  const { connected, account, chainId, networkSupported, loading, connectWallet, disconnectWallet } = useProtocol();

  const [isConnecting, setIsConnecting] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleConnect = async () => {
    setIsConnecting(true);
    try {
      await connectWallet();
    } catch (e) {
      console.error("Connection failed:", e);
    } finally {
      setIsConnecting(false);
    }
  };

  const handleNetworkSwitch = async () => {
    setIsSwitching(true);
    try {
      await switchToBase(); // prefer Base mainnet now
    } catch (e) {
      console.error("Network switch failed:", e);
    } finally {
      setIsSwitching(false);
    }
  };

  const copyAddr = async () => {
    if (!account) return;
    try {
      await navigator.clipboard.writeText(account);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };

  const NetworkBadge = () => {
    if (!connected) return null;
    if (!networkSupported) {
      return (
        <Badge variant="outline" className="border-red-500/30 text-red-400 bg-red-500/10">
          <div className="w-2 h-2 bg-red-400 rounded-full mr-2" /> Wrong Network
        </Badge>
      );
    }
    const networkName = chainId === 84532 ? "Base Sepolia" : "Base";
    return (
      <Badge variant="outline" className="border-emerald-500/30 text-emerald-400 bg-emerald-500/10">
        <div className="w-2 h-2 bg-emerald-400 rounded-full mr-2" /> {networkName}
      </Badge>
    );
  };

  const ConnectButton = () => {
    if (!connected) {
      return (
        <Button onClick={handleConnect} disabled={isConnecting || (loading as any)?.connection} className="flex items-center space-x-2 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 disabled:opacity-50">
          {isConnecting || (loading as any)?.connection ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Connecting...</span>
            </>
          ) : (
            <>
              <Wallet className="w-4 h-4" />
              <span>Connect Wallet</span>
            </>
          )}
        </Button>
      );
    }
    return (
      <div className="flex items-center space-x-2">
        <Button onClick={copyAddr} variant="outline" className="border-slate-600 text-slate-200 hover:bg-slate-700">
          <div className="w-2 h-2 bg-emerald-400 rounded-full mr-2" />
          <span>{formatAddress(account)}</span>
          <Copy className={`w-4 h-4 ml-2 ${copied ? 'opacity-100' : 'opacity-70'}`} />
        </Button>
        <Button onClick={disconnectWallet} className="flex items-center space-x-2 bg-slate-800 hover:bg-slate-700 border border-slate-600 transition-all duration-200">
          <LogOut className="w-4 h-4" />
          <span>Disconnect</span>
        </Button>
      </div>
    );
  };

  const NetworkSwitchButton = () => {
    if (!connected || networkSupported) return null;
    return (
      <Button
        onClick={handleNetworkSwitch}
        disabled={isSwitching}
        variant="outline"
        className="border-red-500/30 text-red-400 hover:bg-red-500/10"
      >
        {isSwitching ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Switching...
          </>
        ) : (
          <>
            <AlertTriangle className="w-4 h-4 mr-2" /> Switch Network
          </>
        )}
      </Button>
    );
  };

  return (
    <div className="flex items-center space-x-4">
      <NetworkBadge />
      <div className="flex items-center space-x-2">
        <NetworkSwitchButton />
        <ConnectButton />
      </div>
    </div>
  );
}
