// src/components/protocol/WalletConnection.tsx
import React from "react";
import { ConnectButton } from '@rainbow-me/rainbowkit';

export default function WalletConnection() {
  return (
    <ConnectButton 
      // The header's NetworkSwitcher handles networks; RainbowKit's own chain menu would also list Ethereum
      // and Arbitrum, which the wallet config carries only so Get iAERO can pay from them.
      chainStatus="none"
      showBalance={false}
    />
  );
}