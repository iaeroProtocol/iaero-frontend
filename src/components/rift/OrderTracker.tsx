// src/components/rift/OrderTracker.tsx
//
// Live progress for one Rift order, from payment to iAERO in the wallet. Four independent sources:
//   - Rift's order status (polled; it says awaiting_deposit / funded / executing / delivered / ...);
//   - the payment transaction on its own chain (EVM receipt, or Bitcoin confirmations from mempool.space);
//   - the iAERO Transfer to the wallet on Base, for the delivery transaction link;
//   - a clock against the route's expected durations (timing.ts), for "about N min left" and
//     "taking longer than usual".
// Everything is written to localStorage as it is learned, so a refresh resumes exactly here.

'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAccount, usePublicClient, useSwitchChain, useWaitForTransactionReceipt } from 'wagmi';
import { parseAbiItem } from 'viem';
import { base } from 'wagmi/chains';
import { AlertTriangle, CheckCircle2, Clock, Copy, ExternalLink, Info, Loader2, XCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress as Bar } from '@/components/ui/progress';
import RouteSteps, { type StepLink } from './RouteSteps';
import BitcoinPayment from './BitcoinPayment';
import { PHASE_STYLE } from './status';
import { getOrder } from '@/lib/rift/client';
import { isTerminal, parseOrderUpdate } from '@/lib/rift/validate';
import { patchOrder } from '@/lib/rift/storage';
import { findBtcDeposit } from '@/lib/rift/bitcoin';
import { BASESCAN_TX, IAERO_ADDRESS, KNOWN_SYMBOLS, RIFT_SECURITY_URL, SOURCE_CHAINS } from '@/lib/rift/config';
import { computeProgress, estimateRoute, formatClock, formatDuration, formatRange } from '@/lib/rift/timing';
import { costText, costVsMarketPct, deliveredVsQuotedPct, formatPct } from '@/lib/rift/cost';
import type { RiftOrderStatus, StoredOrder } from '@/lib/rift/types';

type EvmChainId = 1 | 42161 | 8453;
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

const fmt = (v?: string | null, digits = 4) => {
  const n = Number(v);
  return v && Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: digits }) : '—';
};
const short = (a: string) => (a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);

interface Props {
  order: StoredOrder;
  onPay?: (order: StoredOrder) => void;
  paying?: boolean;
  onGoToStake?: () => void;
  showToast?: (message: string, type: 'success' | 'error' | 'info' | 'warning') => void;
}

export default function OrderTracker({ order, onPay, paying, onGoToStake, showToast }: Props) {
  const chain = SOURCE_CHAINS[order.sourceChain];
  const evmChainId = chain.chainId as EvmChainId | undefined;
  const terminal = isTerminal(order.status);
  const { chainId: walletChainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const basePublic = usePublicClient({ chainId: base.id });

  // A 1-second clock while the order is moving.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (terminal) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [terminal]);

  // 1. Rift status: every 4 s while executing, 6 s once paid, 15 s while waiting; backs off on errors.
  const paid = !!order.depositTxHash || !!order.btc?.txid;
  useEffect(() => {
    if (terminal) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const tick = async () => {
      try {
        const u = parseOrderUpdate(await getOrder(order.id), order.id);
        failures = 0;
        patchOrder(order.id, prev => ({
          status: u.status,
          amountOut: u.amountOut ?? prev.amountOut,
          statusTimes: prev.statusTimes[u.status] ? prev.statusTimes : { ...prev.statusTimes, [u.status]: Date.now() },
        }));
        if (isTerminal(u.status)) return;
      } catch {
        failures++;
      }
      if (stop) return;
      const every = order.status === 'funded' || order.status === 'executing' ? 4000 : paid ? 6000 : 15000;
      timer = setTimeout(tick, Math.min(every * 2 ** failures, 60000));
    };
    tick();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [order.id, order.status, paid, terminal]);

  // Tell the user when the order finishes while they are on the page (toast, plus a browser
  // notification if they allowed it).
  const lastStatus = useRef<RiftOrderStatus>(order.status);
  useEffect(() => {
    const before = lastStatus.current;
    lastStatus.current = order.status;
    if (before === order.status || !isTerminal(order.status) || isTerminal(before)) return;
    const msg =
      order.status === 'delivered' ? `${fmt(order.amountOut)} iAERO arrived in your wallet.`
      : order.status === 'refunded' ? `Your ${order.token.symbol} was refunded.`
      : order.status === 'expired' ? 'Your order expired before a payment arrived.'
      : 'Rift put your order on hold. Open the order for details.';
    showToast?.(msg, order.status === 'delivered' ? 'success' : 'warning');
    if (order.notify && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try { new Notification('iAERO order update', { body: msg }); } catch { /* not allowed here */ }
    }
  }, [order.status, order.amountOut, order.notify, order.token.symbol, showToast]);

  // 2a. EVM payment: wait for its receipt on the source chain.
  const receipt = useWaitForTransactionReceipt({
    hash: order.depositTxHash as `0x${string}` | undefined,
    chainId: evmChainId,
    query: { enabled: chain.kind === 'evm' && !!order.depositTxHash && !order.depositConfirmedAt && !order.depositFailed },
  });
  useEffect(() => {
    if (!receipt.data) return;
    patchOrder(order.id, receipt.data.status === 'success' ? { depositConfirmedAt: Date.now() } : { depositFailed: true });
  }, [receipt.data, order.id]);

  // 2b. Bitcoin payment: look for it on mempool.space every 20 s until Rift has picked it up.
  useEffect(() => {
    if (chain.kind !== 'bitcoin' || (order.status !== 'awaiting_deposit' && order.status !== 'underfunded')) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const d = await findBtcDeposit(order.depositAddress);
        if (d && !stop) {
          patchOrder(order.id, prev => ({ btc: { txid: d.txid, confirmations: d.confirmations, firstSeenAt: prev.btc?.firstSeenAt ?? Date.now() } }));
        }
      } catch { /* mempool.space unavailable: Rift's status still drives progress */ }
      if (!stop) timer = setTimeout(tick, 20000);
    };
    tick();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [chain.kind, order.id, order.depositAddress, order.status]);

  // 3. Delivery: find the iAERO Transfer to the wallet on Base, for a BaseScan link (a few retries while indexers catch up).
  useEffect(() => {
    if (order.status !== 'delivered' || order.deliveryTxHash || !order.baseFromBlock || !basePublic) return;
    let stop = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scan = async () => {
      try {
        const latest = await basePublic.getBlockNumber();
        const from = BigInt(order.baseFromBlock!);
        if (latest - from > 50_000n) return;
        const logs = await basePublic.getLogs({ address: IAERO_ADDRESS, event: TRANSFER, args: { to: order.toAddress as `0x${string}` }, fromBlock: from, toBlock: latest });
        const last = logs[logs.length - 1];
        if (last?.transactionHash) { if (!stop) patchOrder(order.id, { deliveryTxHash: last.transactionHash }); return; }
      } catch { /* the link is optional */ }
      if (!stop && ++tries < 4) timer = setTimeout(scan, 15000);
    };
    scan();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [order.status, order.deliveryTxHash, order.baseFromBlock, order.id, order.toAddress, basePublic]);

  // 4. Expected durations and where we are against them.
  const estimate = useMemo(() => estimateRoute(order.sourceChain, order.route, KNOWN_SYMBOLS), [order.sourceChain, order.route]);
  const progress = computeProgress({
    status: order.status,
    sourceKind: chain.kind,
    createdAt: order.createdAt,
    depositSentAt: order.depositTxHash && !order.depositFailed ? order.depositSentAt : undefined,
    depositConfirmedAt: order.depositConfirmedAt,
    btcSeenAt: order.btc?.firstSeenAt,
    fundedAt: order.statusTimes.funded ?? order.statusTimes.executing,
    finishedAt: terminal ? order.statusTimes[order.status] : undefined,
    now,
    estimate,
  });
  const phase = progress.phase;
  const moving = phase === 'confirming' || phase === 'detecting' || phase === 'executing';
  const style = PHASE_STYLE[phase];

  const links: Partial<Record<string, StepLink>> = {};
  if (chain.kind === 'evm' && order.depositTxHash) links.deposit = { href: chain.txUrl(order.depositTxHash), text: 'Your payment transaction' };
  if (chain.kind === 'bitcoin' && order.btc?.txid) links.deposit = { href: chain.txUrl(order.btc.txid), text: 'Your Bitcoin payment' };
  if (order.deliveryTxHash) links.deliver = { href: BASESCAN_TX(order.deliveryTxHash), text: 'Delivery on BaseScan' };
  const extras: Partial<Record<string, React.ReactNode>> = {};
  if (chain.kind === 'bitcoin' && order.btc?.txid && phase === 'confirming') {
    extras.deposit = order.btc.confirmations
      ? `${order.btc.confirmations} confirmation${order.btc.confirmations === 1 ? '' : 's'} so far; Rift starts once it has enough.`
      : 'Seen in the mempool; waiting for the first confirmation.';
  }
  if (order.depositFailed) extras.deposit = 'Your payment transaction failed, so nothing was sent. You can pay again below.';
  if (phase === 'detecting') extras.deposit = 'Confirmed on-chain; waiting for Rift to register it.';

  // Once delivered: what arrived against the quote, and the all-in cost against market prices when ordered
  // (the iAERO price then, so a market move during the trip does not count as cost).
  const vsQuote = order.status === 'delivered' ? deliveredVsQuotedPct(order.amountOut, order.estimatedOut) : null;
  const allIn = order.status === 'delivered' && order.marketUsdIn && order.marketIaeroUsd && order.amountOut
    ? costVsMarketPct(order.marketUsdIn, Number(order.amountOut) * order.marketIaeroUsd) : null;

  const copy = async (v: string) => { try { await navigator.clipboard.writeText(v); showToast?.('Copied', 'info'); } catch { /* blocked */ } };

  return (
    <Card className="border-slate-700/50 bg-slate-800/50 backdrop-blur-xl">
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base text-white">
          <span>{fmt(order.fromAmount, 8)} {order.token.symbol} on {chain.name} → iAERO</span>
          <Badge className={style.className}>{style.label}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Headline timing */}
        <div className="rounded-xl border border-slate-700/30 bg-slate-900/50 p-4">
          {phase === 'pay' && (
            <div className="text-sm text-slate-300">
              Takes <span className="font-medium text-white">{formatRange(estimate.typicalSec, estimate.slowSec)}</span> once your payment is sent.
            </div>
          )}
          {moving && (
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="text-sm text-slate-300">
                About <span className="text-lg font-semibold text-white">{formatDuration(progress.remainingSec)}</span> left
                {progress.expectedDoneAt && <> · expected by <span className="text-white">{new Date(progress.expectedDoneAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></>}
              </div>
              <div className="flex items-center gap-1.5 font-mono text-sm text-slate-400"><Clock className="h-4 w-4" />{formatClock(progress.elapsedSec)} elapsed</div>
            </div>
          )}
          {phase === 'delivered' && (
            <div className="space-y-1 text-sm text-slate-300">
              <div><span className="text-lg font-semibold text-emerald-300">{fmt(order.amountOut)} iAERO</span> delivered{progress.elapsedSec > 0 && <> in {formatClock(progress.elapsedSec)}</>}.</div>
              <div className={`text-xs ${vsQuote !== null && vsQuote < -1 ? 'text-amber-300' : 'text-slate-400'}`}>
                {vsQuote === null ? <>Quoted {fmt(order.estimatedOut)} iAERO when you ordered.</>
                  : Math.abs(vsQuote) < 0.005 ? <>Exactly the {fmt(order.estimatedOut)} iAERO quoted.</>
                  : <>{formatPct(vsQuote)} {vsQuote > 0 ? 'more' : 'less'} than the {fmt(order.estimatedOut)} iAERO quoted.</>}
              </div>
              {allIn !== null && (
                <div className="text-xs text-slate-500">
                  All-in cost vs market price when you ordered: {costText(allIn)}.
                </div>
              )}
            </div>
          )}
          {(moving || phase === 'delivered') && <Bar value={progress.fraction * 100} className="mt-3" />}
          {phase === 'refunded' && <div className="text-sm text-amber-200">Rift could not complete the route and refunded your {order.token.symbol} to {short(order.refundAddress ?? 'the paying address')} on {chain.name}.</div>}
          {phase === 'expired' && <div className="text-sm text-slate-300">No payment arrived before the deadline, so this order closed. Nothing was taken.</div>}
          {phase === 'frozen' && <div className="text-sm text-red-200">Rift put this order on hold (a compliance or safety check). Contact Rift with the order ID below.</div>}
          {phase === 'underfunded' && <div className="text-sm text-red-200">Rift received less than {fmt(order.fromAmount, 8)} {order.token.symbol}. Don’t send more yet: contact Rift with the order ID below.</div>}
        </div>

        {/* Taking longer than usual */}
        {moving && progress.slow && (
          <div className="flex gap-3 rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-100">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
            <div>
              Taking longer than usual. This happens when {chain.name} is congested or a bridge is slow. Your funds stay in Rift’s
              route; if it cannot complete, Rift refunds you. There is nothing you need to do: this page keeps tracking.
            </div>
          </div>
        )}

        {/* Payment needed */}
        {phase === 'pay' && chain.kind === 'evm' && (
          <div className="space-y-3 rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-4">
            <div className="text-sm text-slate-200">
              {order.depositFailed ? 'Your last payment failed. ' : ''}Send <span className="font-medium text-white">{fmt(order.fromAmount, 8)} {order.token.symbol}</span> on {chain.name} to start.
            </div>
            <Button onClick={() => onPay?.(order)} disabled={paying || !onPay} className="w-full bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700">
              {paying ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Waiting for your wallet…</> : `Pay ${fmt(order.fromAmount, 8)} ${order.token.symbol}`}
            </Button>
          </div>
        )}
        {chain.kind === 'bitcoin' && phase === 'pay' && (
          <BitcoinPayment address={order.depositAddress} amountBtc={order.fromAmount} deadline={order.depositDeadline} />
        )}

        {/* Steps */}
        <RouteSteps estimate={estimate} progress={progress} links={links} extras={extras} />

        {/* Done */}
        {phase === 'delivered' && (
          <div className="flex flex-wrap gap-2">
            {onGoToStake && <Button onClick={onGoToStake} className="bg-gradient-to-r from-indigo-600 to-purple-600">Stake your iAERO</Button>}
            {walletChainId !== base.id && (
              <Button variant="outline" onClick={() => switchChain({ chainId: base.id })} className="border-slate-600 text-slate-200">Switch wallet back to Base</Button>
            )}
          </div>
        )}

        {/* Reference */}
        <div className="space-y-1.5 border-t border-slate-700/40 pt-3 text-xs text-slate-500">
          <div className="flex flex-wrap items-center gap-1.5">
            Order <span className="font-mono text-slate-400">{order.id}</span>
            <button type="button" onClick={() => copy(order.id)} aria-label="Copy order ID" className="text-slate-400 hover:text-white"><Copy className="h-3.5 w-3.5" /></button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            Deposit address <span className="font-mono text-slate-400">{short(order.depositAddress)}</span>
            <a href={chain.addressUrl(order.depositAddress)} target="_blank" rel="noopener noreferrer" className="text-slate-400 hover:text-white"><ExternalLink className="h-3.5 w-3.5" /></a>
            {order.refundAddress && <> · refunds to <span className="font-mono text-slate-400">{short(order.refundAddress)}</span></>}
          </div>
          <div className="flex items-center gap-1.5">
            {terminal ? (order.status === 'delivered' ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> : <XCircle className="h-3.5 w-3.5" />) : <Info className="h-3.5 w-3.5" />}
            Routed by Rift.{' '}
            <a href={RIFT_SECURITY_URL} target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:text-indigo-300">How Rift secures funds</a>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
