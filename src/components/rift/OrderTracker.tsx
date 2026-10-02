// src/components/rift/OrderTracker.tsx
//
// Live progress for one Rift order, from payment to iAERO in the wallet. Sources:
//   - Rift's order status (polled; awaiting_deposit / funded / executing / delivered / ...);
//   - the payment on its own chain: the EVM receipt (reverts, cancels and speed-ups included), Bitcoin
//     payments and confirmations from mempool.space, or the deposit address's balance when this browser does
//     not know whether a payment went out;
//   - the iAERO Transfer to the wallet on Base, for the delivery link and an accurate duration;
//   - a clock against the route's expected durations (timing.ts).
// Everything learned is saved (storage.ts), so a refresh resumes exactly here.

'use client';

import React, { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { usePublicClient, useSwitchChain } from 'wagmi';
import { erc20Abi, parseAbiItem, parseUnits, type Address, type ReplacementReturnType } from 'viem';
import { base } from 'wagmi/chains';
import { AlertTriangle, CheckCircle2, Clock, Copy, ExternalLink, Info, Loader2, XCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress as Bar } from '@/components/ui/progress';
import RouteSteps, { type StepLink } from './RouteSteps';
import { PHASE_STYLE } from './status';
import { classifyRiftError, getOrder } from '@/lib/rift/client';
import { parseOrderUpdate } from '@/lib/rift/validate';
import { applyStatusUpdate, patchOrder } from '@/lib/rift/storage';
import { btcToSats, findBtcDeposits } from '@/lib/rift/bitcoin';
import { HL_API, parseSpotBalances } from '@/lib/rift/hypercore';
import { BASESCAN_TX, IAERO_ADDRESS, KNOWN_SYMBOLS, RIFT_SECURITY_URL, RIFT_SUPPORT_URL, SOURCE_CHAINS } from '@/lib/rift/config';
import { computeProgress, estimateRoute, formatClock, formatDuration, formatRange } from '@/lib/rift/timing';
import { costText, costVsMarketPct, deliveredVsQuotedPct, formatPct } from '@/lib/rift/cost';
import { isTerminalStatus, payState, payWindowMs, payWindowOpen, phaseInput } from '@/lib/rift/order-state';
import type { StoredOrder } from '@/lib/rift/types';

// The QR library loads only for Bitcoin payments.
const BitcoinPayment = dynamic(() => import('./BitcoinPayment'), { ssr: false });

type EvmChainId = 1 | 42161 | 8453;
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SCAN_CHUNK = 1_999n;
const SCAN_CHUNKS_PER_RUN = 25;

const fmt = (v?: string | number | null, digits = 4) => {
  const n = Number(v);
  return v !== undefined && v !== null && v !== '' && Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: digits }) : '—';
};
const short = (a: string) => (a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);
const satsToBtc = (s: bigint) => (Number(s) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
const unitsOf = (amount: string) => { try { return parseUnits(amount, 18); } catch { return null; } };

interface Props {
  order: StoredOrder;
  /** The connected wallet, to refuse paying an order that delivers to another one. */
  account?: string;
  walletChainId?: number;
  onPay: (order: StoredOrder) => void;
  paying: boolean;
  /** Start a new order with the same token and amount (an unpaid order's price is out of date). */
  onReorder: (order: StoredOrder) => void;
  onGoToStake?: () => void;
  showToast?: (message: string, type: 'success' | 'error' | 'info' | 'warning') => void;
}

export default function OrderTracker({ order, account, walletChainId, onPay, paying, onReorder, onGoToStake, showToast }: Props) {
  const chain = SOURCE_CHAINS[order.sourceChain];
  const kind = chain.kind;
  const evmChainId = chain.chainId as EvmChainId | undefined;
  const terminal = isTerminalStatus(order.status);
  const { switchChain } = useSwitchChain();
  const basePublic = usePublicClient({ chainId: base.id });
  const sourcePublic = usePublicClient({ chainId: evmChainId ?? base.id });

  // A 1-second clock while the order is open (progress, the pay window, the "unknown payment" timer).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (terminal) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [terminal]);

  const ps = payState(order, now);
  const paid = ps === 'sent' || !!order.btc?.txid;
  const btcConfirming = kind === 'bitcoin' && order.status === 'awaiting_deposit' && !!order.btc?.txid;

  // 1. Rift status: every 8 s while executing, 10 s once paid, 30 s while Bitcoin confirms, 20 s while waiting
  //    (Rift rate-limits each browser; its own example polls every 10 s); backs off on errors (more on rate
  //    limits) and says so after three failures in a row.
  const [pollFailures, setPollFailures] = useState(0);
  useEffect(() => {
    if (terminal) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const tick = async () => {
      try {
        const u = parseOrderUpdate(await getOrder(order.id), order.id);
        if (stop) return;
        failures = 0;
        setPollFailures(0);
        applyStatusUpdate(order.id, u);
        if (u.status && isTerminalStatus(u.status)) return;
      } catch (e) {
        if (stop) return;
        failures = classifyRiftError(e) === 'rate_limited' ? Math.max(failures + 1, 3) : failures + 1;
        setPollFailures(failures);
      }
      if (stop) return;
      const every = order.status === 'funded' || order.status === 'executing' ? 8000 : btcConfirming ? 30000 : paid ? 10000 : 20000;
      timer = setTimeout(tick, Math.min(every * 2 ** failures, 120000));
    };
    tick();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [order.id, order.status, paid, terminal, btcConfirming]);

  // 2a. EVM payment: its receipt on the source chain. A revert, or a cancel / replacement in the wallet, means
  //     nothing was sent; a speed-up keeps the payment under its new hash. For tokens, the Transfer logs say what
  //     actually reached the deposit address (fee-on-transfer tokens deliver less).
  useEffect(() => {
    if (kind !== 'evm' || !order.depositTxHash || order.depositConfirmedAt || order.depositFailed || !sourcePublic) return;
    let stop = false;
    const hash = order.depositTxHash as `0x${string}`;
    (async () => {
      for (let attempt = 0; !stop && attempt < 40; attempt++) {
        let replaced: ReplacementReturnType | undefined;
        try {
          const r = await sourcePublic.waitForTransactionReceipt({ hash, onReplaced: x => { replaced = x; }, timeout: 10 * 60_000 });
          if (stop) return;
          if (replaced && replaced.reason !== 'repriced') {
            patchOrder(order.id, { depositFailed: true, depositFailReason: replaced.reason === 'cancelled' ? 'cancelled' : 'replaced' });
            return;
          }
          const finalHash = replaced ? replaced.transaction.hash : r.transactionHash;
          if (r.status !== 'success') {
            patchOrder(order.id, { depositFailed: true, depositFailReason: 'reverted', depositTxHash: finalHash });
            return;
          }
          let received: string | undefined;
          if (order.token.address) {
            const token = order.token.address.toLowerCase(), to = order.depositAddress.toLowerCase();
            const sum = r.logs
              .filter(l => l.address.toLowerCase() === token && l.topics[0] === TRANSFER_TOPIC && !!l.topics[2] && `0x${l.topics[2].slice(26)}`.toLowerCase() === to)
              .reduce((n, l) => n + BigInt(l.data), 0n);
            if (sum < BigInt(order.fromAmountRaw)) received = sum.toString();
          }
          patchOrder(order.id, { depositTxHash: finalHash, depositConfirmedAt: Date.now(), depositReceivedRaw: received });
          return;
        } catch {
          if (stop) return;
          await new Promise(res => setTimeout(res, 15_000)); // timeout or RPC trouble: keep waiting
        }
      }
    })();
    return () => { stop = true; };
  }, [kind, order.id, order.depositTxHash, order.depositConfirmedAt, order.depositFailed, order.token.address, order.depositAddress, order.fromAmountRaw, sourcePublic]);

  // 2b. Bitcoin: every payment to the deposit address every 20 s, until Rift has picked it up.
  const [btcErrors, setBtcErrors] = useState(0);
  useEffect(() => {
    if (kind !== 'bitcoin' || (order.status !== 'awaiting_deposit' && order.status !== 'underfunded')) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let errors = 0;
    const tick = async () => {
      try {
        const d = await findBtcDeposits(order.depositAddress);
        errors = 0;
        if (!stop) setBtcErrors(0);
        if (d.payments.length && !stop) {
          const confirmations = Math.min(...d.payments.map(p => p.confirmations));
          patchOrder(order.id, prev => ({
            btc: { txid: d.payments[0].txid, confirmations, firstSeenAt: prev.btc?.firstSeenAt ?? Date.now(), totalSats: d.totalSats.toString(), payments: d.payments.length },
          }));
        }
      } catch {
        errors++;
        if (!stop) setBtcErrors(errors);
      }
      if (!stop) timer = setTimeout(tick, 20000);
    };
    tick();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [kind, order.id, order.depositAddress, order.status]);

  // 3. Delivery: the iAERO Transfer to the wallet on Base, scanned in 2,000-block chunks (public RPCs refuse
  //    more) from where the last scan stopped. It must come from the order's vault (EVM sources, where the
  //    vault has the same address on Base) and match the delivered amount.
  useEffect(() => {
    if (order.status !== 'delivered' || order.deliveryTxHash || !order.baseFromBlock || !basePublic) return;
    let stop = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const want = order.amountOut ? unitsOf(order.amountOut) : null;
    const fromVault = kind === 'evm' ? (order.depositAddress as Address) : undefined;
    const scan = async () => {
      let from = BigInt(order.deliveryScannedTo ?? order.baseFromBlock!);
      try {
        const latest = await basePublic.getBlockNumber();
        for (let i = 0; i < SCAN_CHUNKS_PER_RUN && from <= latest && !stop; i++) {
          const to = from + SCAN_CHUNK > latest ? latest : from + SCAN_CHUNK;
          const logs = await basePublic.getLogs({
            address: IAERO_ADDRESS, event: TRANSFER, fromBlock: from, toBlock: to,
            args: { to: order.toAddress as Address, ...(fromVault ? { from: fromVault } : {}) },
          });
          const hit = logs.find(l => want === null || l.args.value === want);
          if (hit) {
            let at: number | undefined;
            try { at = Number((await basePublic.getBlock({ blockNumber: hit.blockNumber })).timestamp) * 1000; } catch { /* optional */ }
            if (!stop) patchOrder(order.id, { deliveryTxHash: hit.transactionHash, deliveredAtChain: at, deliveryScannedTo: String(to) });
            return;
          }
          from = to + 1n;
        }
      } catch { /* the link is optional */ }
      if (!stop) patchOrder(order.id, { deliveryScannedTo: String(from) });
      if (!stop && ++tries < 8) timer = setTimeout(scan, 20000);
    };
    scan();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [order.status, order.deliveryTxHash, order.baseFromBlock, order.id, order.toAddress, order.amountOut, order.depositAddress, kind, basePublic]); // deliveryScannedTo: read at start only

  // 4. "Did my payment go out?": ask Rift, then look at the deposit address itself.
  const [checking, setChecking] = useState(false);
  const [checkSaid, setCheckSaid] = useState<'nothing' | 'error' | null>(null);
  async function checkPayment() {
    setChecking(true);
    setCheckSaid(null);
    try {
      try {
        const u = parseOrderUpdate(await getOrder(order.id), order.id);
        applyStatusUpdate(order.id, u);
        if (u.status && u.status !== 'awaiting_deposit') return;
      } catch { /* go on to the chain */ }
      let arrived = false;
      if (kind === 'evm' && sourcePublic) {
        const owner = order.depositAddress as Address;
        const balance = order.token.address
          ? await sourcePublic.readContract({ address: order.token.address as Address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
          : await sourcePublic.getBalance({ address: owner });
        arrived = balance >= BigInt(order.fromAmountRaw);
      } else if (kind === 'hypercore') {
        const res = await fetch(`${HL_API}/info`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'spotClearinghouseState', user: order.depositAddress }),
        });
        const have = parseSpotBalances(await res.json()).find(r => r.token.asset === order.token.asset)?.availableRaw ?? 0n;
        arrived = have >= BigInt(order.fromAmountRaw);
      }
      if (arrived) {
        const t = Date.now();
        patchOrder(order.id, { depositSentAt: t, depositConfirmedAt: t, payUnknown: false, payRequestedAt: undefined });
        showToast?.('Your payment reached the deposit address. Tracking your order…', 'success');
      } else {
        setCheckSaid('nothing');
      }
    } catch {
      setCheckSaid('error');
    } finally {
      setChecking(false);
    }
  }
  const payAgain = () => {
    patchOrder(order.id, { payUnknown: false, payRequestedAt: undefined });
    setCheckSaid(null);
    onPay({ ...order, payUnknown: false, payRequestedAt: undefined });
  };

  // 5. Expected durations and where we are against them.
  const estimate = useMemo(() => estimateRoute(order.sourceChain, order.route, KNOWN_SYMBOLS), [order.sourceChain, order.route]);
  const progress = computeProgress({
    ...phaseInput(order, kind),
    createdAt: order.createdAt,
    fundedAt: order.statusTimes.funded ?? order.statusTimes.executing,
    finishedAt: terminal ? order.statusTimes[order.status] : undefined,
    now,
    estimate,
  });
  const phase = progress.phase;
  const moving = phase === 'confirming' || phase === 'detecting' || phase === 'executing';
  const style = PHASE_STYLE[phase];
  const windowOpen = payWindowOpen(order, kind, now);
  const wrongAccount = !!account && account.toLowerCase() !== order.toAddress.toLowerCase();

  const links: Partial<Record<string, StepLink>> = {};
  if (kind === 'evm' && order.depositTxHash) links.deposit = { href: chain.txUrl(order.depositTxHash), text: 'Your payment transaction' };
  if (kind === 'bitcoin' && order.btc?.txid) links.deposit = { href: chain.txUrl(order.btc.txid), text: 'Your Bitcoin payment' };
  if (kind === 'hypercore' && order.depositSentAt) links.deposit = { href: chain.addressUrl(order.toAddress), text: 'Your Hyperliquid account' };
  if (order.deliveryTxHash) links.deliver = { href: BASESCAN_TX(order.deliveryTxHash), text: 'Delivery on BaseScan' };
  const extras: Partial<Record<string, React.ReactNode>> = {};
  if (kind === 'bitcoin' && order.btc?.txid && phase === 'confirming') {
    extras.deposit = order.btc.confirmations
      ? `${order.btc.confirmations} confirmation${order.btc.confirmations === 1 ? '' : 's'} so far; Rift starts once it has enough.`
      : 'Seen in the mempool; waiting for the first confirmation.';
  }
  if (phase === 'detecting') {
    extras.deposit = kind === 'hypercore' ? 'Sent on Hyperliquid; waiting for Rift to register it.' : 'Confirmed on-chain; waiting for Rift to register it.';
  }
  if (order.depositReceivedRaw) {
    extras.deposit = `Only ${fmt(Number(order.depositReceivedRaw) / 10 ** order.token.decimals, 8)} ${order.token.symbol} reached the deposit address: this token takes a fee on transfer. Rift will treat the order as underpaid.`;
  }

  // Bitcoin: what arrived against what the order needs.
  const btcNeeded = kind === 'bitcoin' ? btcToSats(order.fromAmount) : 0n;
  const btcGot = order.btc?.totalSats ? BigInt(order.btc.totalSats) : 0n;

  // Once delivered: against what the page said to expect (Rift's quote minus its gas charge; the first orders
  // only have the quote), and the all-in cost against market prices when ordered.
  const target = order.expectedOut ?? order.estimatedOut;
  const targetWord = order.expectedOut ? 'expected' : 'quoted';
  const vsQuote = order.status === 'delivered' ? deliveredVsQuotedPct(order.amountOut, target) : null;
  const allIn = order.status === 'delivered' && order.marketUsdIn && order.marketIaeroUsd && order.amountOut
    ? costVsMarketPct(order.marketUsdIn, Number(order.amountOut) * order.marketIaeroUsd) : null;
  // A duration only from times that are real: the delivery's block time, or a status this page saw happen.
  const startedAt = order.depositSentAt ?? order.btc?.firstSeenAt;
  const deliveredIn = order.deliveredAtChain && startedAt ? Math.max(0, (order.deliveredAtChain - startedAt) / 1000)
    : !order.statusLate?.delivered && progress.elapsedSec > 0 ? progress.elapsedSec : null;

  const copy = async (v: string) => { try { await navigator.clipboard.writeText(v); showToast?.('Copied', 'info'); } catch { /* blocked */ } };
  const supportLink = <a href={RIFT_SUPPORT_URL} target="_blank" rel="noopener noreferrer" className="underline hover:text-white">contact Rift</a>;

  return (
    <Card className="min-w-0 border-slate-700/50 bg-slate-800/50 backdrop-blur-xl">
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base text-white">
          <span>{fmt(order.fromAmount, 8)} {order.token.symbol} on {chain.name} → iAERO</span>
          <Badge className={style.className}>{style.label}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Headline */}
        <div className="rounded-xl border border-slate-700/30 bg-slate-900/50 p-4">
          {phase === 'pay' && (
            <div className="text-sm text-slate-300">
              Takes <span className="font-medium text-white">{formatRange(estimate.typicalSec, estimate.slowSec)}</span> once your payment is sent.
            </div>
          )}
          {moving && (
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="text-sm text-slate-300">
                {progress.overrun ? (
                  <>Usually done by now · up to about <span className="text-lg font-semibold text-white">{formatDuration(progress.upToSec ?? 0)}</span> more</>
                ) : (
                  <>
                    About <span className="text-lg font-semibold text-white">{formatDuration(progress.remainingSec)}</span> left
                    {progress.expectedDoneAt && <> · expected by <span className="text-white">{new Date(progress.expectedDoneAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></>}
                  </>
                )}
              </div>
              <div className="flex items-center gap-1.5 font-mono text-sm text-slate-400"><Clock className="h-4 w-4" />{formatClock(progress.elapsedSec)} elapsed</div>
            </div>
          )}
          {phase === 'delivered' && (
            <div className="space-y-1 text-sm text-slate-300">
              <div><span className="text-lg font-semibold text-emerald-300">{fmt(order.amountOut)} iAERO</span> delivered{deliveredIn !== null && <> in {formatClock(deliveredIn)}</>}.</div>
              <div className={`text-xs ${vsQuote !== null && vsQuote < -1 ? 'text-amber-300' : 'text-slate-400'}`}>
                {vsQuote === null ? <>{targetWord === 'expected' ? 'Expected' : 'Quoted'} {fmt(target)} iAERO when you ordered.</>
                  : Math.abs(vsQuote) < 0.005 ? <>Exactly the {fmt(target)} iAERO {targetWord}.</>
                  : <>{formatPct(vsQuote)} {vsQuote > 0 ? 'more' : 'less'} than the {fmt(target)} iAERO {targetWord}.</>}
                {order.expectedOut && (order.gasDeskUsd ?? 0) > 0 && <> Rift quoted {fmt(order.estimatedOut)} before about ${(order.gasDeskUsd ?? 0).toFixed(2)} of gas charges.</>}
              </div>
              {allIn !== null && <div className="text-xs text-slate-400">All-in cost vs market price when you ordered: {costText(allIn)}.</div>}
            </div>
          )}
          {(moving || phase === 'delivered') && <Bar value={progress.fraction * 100} className="mt-3" />}
          {phase === 'refunded' && (
            <div className="text-sm text-amber-200">
              Rift could not complete the route and refunded {order.amountOut ? <>{fmt(order.amountOut, 8)} {order.token.symbol}</> : <>your {order.token.symbol}</>} to{' '}
              {short(order.refundAddress ?? 'the paying address')} on {chain.name}.
            </div>
          )}
          {phase === 'expired' && <div className="text-sm text-slate-300">No payment arrived before the deadline, so this order closed. Nothing was taken.</div>}
          {phase === 'frozen' && <div className="text-sm text-red-200">Rift put this order on hold (a compliance or safety check). Please {supportLink} with the order ID below.</div>}
          {phase === 'underfunded' && (
            <div className="text-sm text-red-200">
              Rift received less than {fmt(order.fromAmount, 8)} {order.token.symbol}. Don’t send more yet: please {supportLink} with the order ID below.
            </div>
          )}
        </div>

        {/* Can't read the status, or a status this page doesn't know */}
        {!terminal && pollFailures >= 3 && (
          <div role="status" className="flex gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-100">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" /> Can’t reach Rift for this order’s status right now; retrying. Your order ID is below.
          </div>
        )}
        {order.rawStatus && (
          <div className="flex gap-2 rounded-lg border border-slate-600/40 bg-slate-900/40 p-3 text-xs text-slate-300">
            <Info className="mt-0.5 h-4 w-4 shrink-0" /> Rift reports “{order.rawStatus}”, a status this page doesn’t know yet. It keeps checking.
          </div>
        )}

        {/* Taking longer than usual */}
        {moving && progress.slow && (
          <div className="flex gap-3 rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-100">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
            <div>
              {phase === 'confirming' && kind === 'evm'
                ? <>Your payment hasn’t confirmed on {chain.name} yet. Check your wallet: a payment stuck on a low fee can be sped up there.</>
                : <>Taking longer than usual. This happens when {chain.name} is congested or a bridge is slow. Your funds stay in Rift’s route; if it
                  cannot complete, Rift refunds you. There is nothing you need to do: this page keeps tracking.</>}
            </div>
          </div>
        )}

        {/* Paying (EVM and HyperCore) */}
        {phase === 'pay' && kind !== 'bitcoin' && (
          <div className="space-y-3 rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-4 text-sm text-slate-200">
            {wrongAccount ? (
              <div>This order delivers iAERO to <span className="font-mono">{short(order.toAddress)}</span>. Connect that wallet to pay it.</div>
            ) : ps === 'unknown' ? (
              <>
                <div className="flex gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                  <div>We couldn’t confirm whether your payment went out. Check your wallet’s activity before paying again.</div>
                </div>
                {checkSaid === 'nothing' && <div className="text-xs text-slate-300">Nothing has reached the deposit address yet. If your wallet shows no pending payment, you can pay again.</div>}
                {checkSaid === 'error' && <div className="text-xs text-amber-200">Couldn’t check right now. Try again in a moment.</div>}
                <div className="flex flex-wrap gap-2">
                  <Button onClick={checkPayment} disabled={checking} variant="outline" className="border-slate-600 text-slate-200">
                    {checking && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Check payment
                  </Button>
                  {checkSaid === 'nothing' && windowOpen && (
                    <Button onClick={payAgain} disabled={paying} className="bg-gradient-to-r from-indigo-600 to-purple-600">Pay again</Button>
                  )}
                </div>
              </>
            ) : !windowOpen ? (
              <>
                <div>This order wasn’t paid within {Math.round(payWindowMs(kind) / 60_000)} minutes, so its price is out of date. Nothing was sent.</div>
                <Button onClick={() => onReorder(order)} className="bg-gradient-to-r from-indigo-600 to-purple-600">New order at today’s price</Button>
              </>
            ) : (
              <>
                <div>
                  {order.depositFailed && (
                    <>Your last payment {order.depositFailReason === 'reverted' ? 'failed on-chain' : order.depositFailReason === 'cancelled' ? 'was cancelled in your wallet' : 'was replaced in your wallet'}, so nothing was sent.{' '}</>
                  )}
                  Send <span className="font-medium text-white">{fmt(order.fromAmount, 8)} {order.token.symbol}</span> on {chain.name} to start.
                </div>
                <Button onClick={() => onPay(order)} disabled={paying || ps === 'requesting'} className="h-auto min-h-10 w-full whitespace-normal bg-gradient-to-r from-indigo-600 to-purple-600 py-2.5 hover:from-indigo-700 hover:to-purple-700">
                  {paying || ps === 'requesting' ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Waiting for your wallet…</> : `Pay ${fmt(order.fromAmount, 8)} ${order.token.symbol}`}
                </Button>
              </>
            )}
          </div>
        )}

        {/* Paying with Bitcoin */}
        {phase === 'pay' && kind === 'bitcoin' && (windowOpen ? (
          <BitcoinPayment address={order.depositAddress} amountBtc={order.fromAmount} sendBy={order.createdAt + payWindowMs('bitcoin')} />
        ) : (
          <div className="space-y-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-sm text-slate-200">
            <div>This order wasn’t paid within an hour, so its price is out of date. Don’t send to its address; start a new order instead.</div>
            <Button onClick={() => onReorder(order)} className="bg-gradient-to-r from-indigo-600 to-purple-600">New order at today’s price</Button>
          </div>
        ))}
        {kind === 'bitcoin' && btcGot > 0n && btcGot !== btcNeeded && order.status === 'awaiting_deposit' && (
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-100">
            {btcGot < btcNeeded
              ? <>So far {satsToBtc(btcGot)} of {order.fromAmount} BTC has arrived. Don’t send more yet: if it stays short, Rift treats the order as underpaid.</>
              : <>{satsToBtc(btcGot)} BTC arrived, more than the {order.fromAmount} BTC ordered. Keep the order ID: what happens to the extra is Rift’s call.</>}
          </div>
        )}
        {kind === 'bitcoin' && btcErrors >= 3 && order.status === 'awaiting_deposit' && (
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-100">
            Can’t check the Bitcoin network right now. Don’t send again: Rift’s status here still updates when your payment arrives.
          </div>
        )}

        {/* Steps */}
        <RouteSteps estimate={estimate} progress={progress} links={links} extras={extras} />

        {/* After paying: the wallet can go back to Base */}
        <div className="flex flex-wrap gap-2">
          {phase === 'delivered' && onGoToStake && <Button onClick={onGoToStake} className="bg-gradient-to-r from-indigo-600 to-purple-600">Stake your iAERO</Button>}
          {kind !== 'bitcoin' && (paid || terminal) && walletChainId !== undefined && walletChainId !== base.id && (
            <Button variant="outline" onClick={() => switchChain({ chainId: base.id })} className="border-slate-600 text-slate-200">Switch wallet back to Base</Button>
          )}
        </div>

        {/* Reference */}
        <div className="space-y-1.5 border-t border-slate-700/40 pt-3 text-xs text-slate-400">
          <div className="flex flex-wrap items-center gap-1.5">
            Order <span className="break-all font-mono text-slate-300">{order.id}</span>
            <button type="button" onClick={() => copy(order.id)} aria-label="Copy order ID" className="text-slate-400 hover:text-white"><Copy className="h-3.5 w-3.5" /></button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            iAERO to <span className="font-mono text-slate-300">{short(order.toAddress)}</span> on Base
            {order.refundAddress && <> · refunds to <span className="font-mono text-slate-300">{short(order.refundAddress)}</span></>}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            Deposit address <span className="font-mono text-slate-300">{short(order.depositAddress)}</span>
            <a href={chain.addressUrl(order.depositAddress)} target="_blank" rel="noopener noreferrer" aria-label="Deposit address on the explorer (opens in a new tab)" className="text-slate-400 hover:text-white"><ExternalLink className="h-3.5 w-3.5" /></a>
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
