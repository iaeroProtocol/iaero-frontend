// src/components/protocol/WalletConnection.tsx
import React from "react";
import { ConnectButton } from '@rainbow-me/rainbowkit';

export default function WalletConnection() {
  return (
    <ConnectButton 
      chainStatus="icon"
      showBalance={false}
    />
  );
}