// src/components/rift/BitcoinPayment.tsx
//
// Paying a Rift order from any Bitcoin wallet: QR code (BIP21, so the amount is pre-filled), the exact
// amount and address with copy buttons, and the deadline.

'use client';

import React, { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Copy, Check, Wallet } from 'lucide-react';
import { bip21 } from '@/lib/rift/bitcoin';

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
      }}
      className="inline-flex items-center gap-1 rounded-md border border-slate-600 px-2 py-1 text-xs text-slate-300 hover:border-indigo-400 hover:text-white"
      aria-label={`Copy ${label}`}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

interface Props { address: string; amountBtc: string; /** Send by this time (ms): the order's price is out of date after it. */ sendBy: number }

export default function BitcoinPayment({ address, amountBtc, sendBy }: Props) {
  const uri = bip21(address, amountBtc);
  return (
    <div className="space-y-4 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
      <div className="text-sm font-medium text-amber-200">Send exactly this amount, in one payment, from any Bitcoin wallet</div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="self-center rounded-lg bg-white p-2">
          <QRCodeSVG value={uri} size={148} level="M" />
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <div className="text-xs text-slate-400">Amount</div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-lg text-white">{amountBtc} BTC</span>
              <CopyButton value={amountBtc} label="amount" />
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-400">To this one-time address</div>
            <div className="flex items-center justify-between gap-2">
              <span className="break-all font-mono text-xs text-white">{address}</span>
              <CopyButton value={address} label="address" />
            </div>
          </div>
          <a href={uri} className="inline-flex items-center gap-1.5 text-sm text-indigo-400 hover:text-indigo-300">
            <Wallet className="h-4 w-4" /> Open in my Bitcoin wallet
          </a>
        </div>
      </div>
      <ul className="list-disc space-y-1 pl-5 text-xs text-slate-400">
        <li>Send exactly this amount, in one payment, from a wallet you control. Exchange withdrawals can arrive split, batched or short
          after fees, which Rift treats as underpaid; any refund goes to the refund address you gave.</li>
        <li>This page picks up your payment by itself; you can close it and come back in this browser. Note the order ID first: a private window, or clearing site data, loses it.</li>
        <li>Already sent it? It can take a minute to show here. Don’t send it again.</li>
        <li>Send by {new Date(sendBy).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}: after that this order’s price is out of date, so start a new one instead.</li>
      </ul>
    </div>
  );
}
