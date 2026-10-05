// src/components/rift/OrderTracker.tsx
//
// Live progress for one Rift order, from payment to iAERO in the wallet. Sources:
//   - Rift's order status (polled; awaiting_deposit / funded / executing / delivered / ...);
//   - the payment on its own chain: the EVM transaction and the paying account's nonce (reverts, cancels and
//     speed-ups, including after a reload), Bitcoin payments from mempool.space, and, when this browser does
//     not know whether a payment went out, the deposit address and the payer's ledger (evidence.ts);
//   - the iAERO Transfer to the wallet on Base, for the delivery link and an accurate duration;
//   - a clock against the route's expected durations (timing.ts).
// Everything learned is saved (storage.ts), so a refresh resumes exactly here.

'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { usePublicClient, useSwitchChain } from 'wagmi';
import { parseAbiItem, parseUnits, type Address, type TransactionReceipt } from 'viem';
import { base } from 'wagmi/chains';
import { AlertTriangle, CheckCircle2, Clock, Copy, ExternalLink, Info, Loader2, XCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress as Bar } from '@/components/ui/progress';
import RouteSteps, { type StepLink } from './RouteSteps';
import { PHASE_STYLE, STALE_STYLE } from './status';
import { classifyRiftError, getOrder, riftBudget } from '@/lib/rift/client';
import { parseOrderUpdate } from '@/lib/rift/validate';
import { applyStatusUpdate, markPolled, patchOrder, polledWithin } from '@/lib/rift/storage';
import { btcToSats, findBtcDeposits } from '@/lib/rift/bitcoin';
import { hyperCoreToken } from '@/lib/rift/hypercore';
import { accountNonce, evmDepositEvidence, hyperDepositEvidence } from '@/lib/rift/payment-io';
import { BASESCAN_TX, IAERO_ADDRESS, KNOWN_SYMBOLS, RIFT_SECURITY_URL, RIFT_SUPPORT_URL, SOURCE_CHAINS } from '@/lib/rift/config';
import { computeProgress, estimateRoute, formatClock, formatDuration, formatRange } from '@/lib/rift/timing';
import { costText, costVsMarketPct, deliveredVsQuotedPct, formatPct } from '@/lib/rift/cost';
import { canHide, isAbandoned, isFinalStatus, isTerminalStatus, payState, payWindowMs, payWindowOpen, phaseInput } from '@/lib/rift/order-state';
import type { StoredOrder } from '@/lib/rift/types';

// The QR library loads only for Bitcoin payments.
const BitcoinPayment = dynamic(() => import('./BitcoinPayment'), { ssr: false });

type EvmChainId = 1 | 42161 | 8453;
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SCAN_CHUNK = 1_999n;
const SCAN_CHUNKS_PER_RUN = 25;
/** A payment hash no node has shown for this long (a private relay, a dropped transaction, or a wallet that
 *  returned something other than a transaction hash) is reported as unknown, to be checked. */
const LOST_AFTER_MS = 5 * 60_000;

const fmt = (v?: string | number | null, digits = 4) => {
  const n = Number(v);
  return v !== undefined && v !== null && v !== '' && Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: digits }) : '—';
};
const short = (a: string) => (a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);
const satsToBtc = (s: bigint) => (Number(s) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
const unitsOf = (amount: string) => { try { return parseUnits(amount, 18); } catch { return null; } };
const notFound = (e: unknown) => /NotFound/.test((e as { name?: string } | null)?.name ?? '');

/** What a check of an uncertain payment found. */
type Verdict = 'moved' | 'arrived' | 'partial' | 'pending' | 'nothing' | 'reverted';

interface Props {
  order: StoredOrder;
  /** The connected wallet, to refuse paying an order that delivers to another one. */
  account?: string;
  walletChainId?: number;
  onPay: (order: StoredOrder) => void;
  paying: boolean;
  /** Start a new order with the same token and amount (an unpaid order's price is out of date). */
  onReorder: (order: StoredOrder) => void;
  /** Remove an out-of-date order that was never paid. */
  onDismiss: (order: StoredOrder) => void;
  onGoToStake?: () => void;
  showToast?: (message: string, type: 'success' | 'error' | 'info' | 'warning') => void;
}

export default function OrderTracker({ order, account, walletChainId, onPay, paying, onReorder, onDismiss, onGoToStake, showToast }: Props) {
  const chain = SOURCE_CHAINS[order.sourceChain];
  const kind = chain.kind;
  const evmChainId = chain.chainId as EvmChainId | undefined;
  const terminal = isTerminalStatus(order.status);
  const { switchChainAsync } = useSwitchChain();
  const basePublic = usePublicClient({ chainId: base.id });
  const sourcePublic = usePublicClient({ chainId: evmChainId ?? base.id });

  // A clock while the order is open: every second while it moves or can be paid, every 15 s otherwise.
  const [now, setNow] = useState(() => Date.now());
  const stale = isAbandoned(order, now);
  useEffect(() => {
    if (terminal) return;
    const t = setInterval(() => setNow(Date.now()), stale ? 15_000 : 1000);
    return () => clearInterval(t);
  }, [terminal, stale]);

  // The tab waiting on the wallet says "requesting" for as long as the wallet is open.
  const ps = paying ? 'requesting' : payState(order, now);
  const [settlementAck, setSettlementAck] = useState(false);
  const paid = ps === 'sent' || !!order.btc?.txid;
  const btcConfirming = kind === 'bitcoin' && order.status === 'awaiting_deposit' && !!order.btc?.txid;
  const staleRef = useRef(stale);
  staleRef.current = stale;

  // 1. Rift status: every 8 s while executing, 10 s once paid, 30 s while Bitcoin confirms, 20 s while waiting,
  //    every minute while on hold or the page is hidden, every 10 minutes once out of date. An order any tab
  //    asked about within that time is not asked again (storage.ts poll stamps), and polls give way in Rift's
  //    call budget. Backs off on errors (more on rate limits) and says so after three failures in a row.
  const [pollFailures, setPollFailures] = useState(0);
  useEffect(() => {
    if (isFinalStatus(order.status)) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const tick = async () => {
      const regular = order.status === 'frozen' ? 60_000 : staleRef.current ? 10 * 60_000
        : order.status === 'funded' || order.status === 'executing' ? 8000 : btcConfirming ? 30000 : paid ? 10000 : 20000;
      const every = Math.max(regular, document.hidden ? 60_000 : 0);
      if (!polledWithin(order.id, every - 1000) && riftBudget('track')) {
        try {
          const u = parseOrderUpdate(await getOrder(order.id, undefined, 'track'), order.id);
          if (stop) return;
          failures = 0;
          setPollFailures(0);
          await applyStatusUpdate(order.id, u);
          if (u.status && isFinalStatus(u.status)) return;
        } catch (e) {
          if (stop) return;
          markPolled(order.id);
          failures = classifyRiftError(e) === 'rate_limited' ? Math.max(failures + 1, 3) : failures + 1;
          setPollFailures(failures);
        }
      }
      if (!stop) timer = setTimeout(tick, Math.min(every * 2 ** failures, 10 * 60_000));
    };
    tick();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [order.id, order.status, paid, btcConfirming]);

  // 2a. EVM payment: its receipt on the source chain. A revert means nothing was sent. While it is pending, the
  //     paying account's nonce is watched: once the account has moved past the payment's nonce without mining
  //     it, the payment was replaced in the wallet, a speed-up (the deposit address has the money) or a cancel
  //     (it has not). This works after a reload too. A hash no node shows for minutes is reported as unknown.
  //     For tokens, the Transfer logs say what actually reached the deposit address (fee-on-transfer tokens).
  //     Every write checks the hash is still this order's current payment (a retry may have replaced it).
  useEffect(() => {
    if (kind !== 'evm' || !order.depositTxHash || order.depositConfirmedAt || order.depositFailed || order.payUnknown || !sourcePublic) return;
    let stop = false;
    const id = order.id;
    const hash = order.depositTxHash as `0x${string}`;
    const payer = order.toAddress as Address;
    const ifCurrent = (patch: Partial<StoredOrder> | ((prev: StoredOrder) => Partial<StoredOrder>)) =>
      patchOrder(id, prev => (prev.depositTxHash === hash && !prev.depositFailed && !prev.depositConfirmedAt && !prev.payUnknown
        ? (typeof patch === 'function' ? patch(prev) : patch) : {}));
    const settle = (r: TransactionReceipt) => {
      if (r.status !== 'success') return ifCurrent({ depositFailed: true, depositFailReason: 'reverted' });
      let received: string | undefined;
      if (order.token.address) {
        const token = order.token.address.toLowerCase(), to = order.depositAddress.toLowerCase();
        const sum = r.logs
          .filter(l => l.address.toLowerCase() === token && l.topics[0] === TRANSFER_TOPIC && !!l.topics[2] && `0x${l.topics[2].slice(26)}`.toLowerCase() === to)
          .reduce((n, l) => n + BigInt(l.data), 0n);
        if (sum < BigInt(order.fromAmountRaw)) received = sum.toString();
      }
      return ifCurrent({ depositConfirmedAt: Date.now(), depositReceivedRaw: received });
    };
    const receipt = () => sourcePublic.getTransactionReceipt({ hash }).catch(e => (notFound(e) ? null : Promise.reject(e)));
    let nonce = order.depositNonce;
    let lastSeen = Date.now();
    (async () => {
      for (let round = 0; !stop; round++) {
        try {
          const r = await receipt();
          if (stop) return;
          if (r) { await settle(r); return; }
          if (nonce === undefined || round % 3 === 0) {
            const tx = await sourcePublic.getTransaction({ hash }).catch(e => (notFound(e) ? null : Promise.reject(e)));
            if (stop) return;
            if (tx) {
              lastSeen = Date.now();
              if (nonce === undefined) { nonce = tx.nonce; await patchOrder(id, prev => (prev.depositTxHash === hash ? { depositNonce: tx.nonce } : {})); }
            }
          }
          if (nonce !== undefined && round % 2 === 1) {
            // The account's nonce and the deposit address are read at one block: a node lagging behind the one
            // that answered the nonce must not make a sped-up payment look replaced (and payable again).
            const head = await sourcePublic.getBlockNumber();
            const mined = await accountNonce(sourcePublic, payer, head);
            if (stop) return;
            if (mined > nonce) {
              const again = await receipt();
              if (stop) return;
              if (again) { await settle(again); return; }
              const ev = await evmDepositEvidence(sourcePublic, order, head);
              if (stop) return;
              if (ev === 'none') await ifCurrent({ depositFailed: true, depositFailReason: 'replaced' });
              // Sped up: the payment went out under a hash this page does not know.
              else await ifCurrent(prev => ({ depositConfirmedAt: Date.now(), depositTxHash: undefined, pastTxHashes: [...(prev.pastTxHashes ?? []), hash].slice(-5) }));
              return;
            }
          }
          if (Date.now() - lastSeen > LOST_AFTER_MS) { await ifCurrent({ payUnknown: true }); return; }
        } catch { /* RPC trouble: keep waiting */ }
        await new Promise(res => setTimeout(res, round < 15 ? 8000 : 20000));
      }
    })();
    return () => { stop = true; };
  }, [kind, order.id, order.depositTxHash, order.depositConfirmedAt, order.depositFailed, order.payUnknown, sourcePublic]); // eslint-disable-line react-hooks/exhaustive-deps

  // 2b. Bitcoin: every payment to the deposit address every 20 s, until Rift has picked it up. A payment that
  //     was seen and is gone (dropped or replaced) is said so, and the QR code comes back.
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
        if (!stop) {
          await patchOrder(order.id, prev => {
            if (!d.payments.length) return prev.btc?.txid ? { btc: { missing: true } } : {};
            const confirmations = Math.min(...d.payments.map(p => p.confirmations));
            // First seen already confirmed: the page was not watching when it was sent.
            const seenLate = prev.btc?.firstSeenAt ? prev.btc.seenLate : confirmations > 0;
            return {
              btc: {
                txid: d.payments[0].txid, confirmations, firstSeenAt: prev.btc?.firstSeenAt ?? Date.now(), totalSats: d.totalSats.toString(),
                payments: d.payments.length, ...(seenLate ? { seenLate: true } : {}),
              },
            };
          });
        }
      } catch {
        errors++;
        if (!stop) setBtcErrors(errors);
      }
      if (!stop) timer = setTimeout(tick, staleRef.current ? 10 * 60_000 : 20000);
    };
    tick();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [kind, order.id, order.depositAddress, order.status]);

  // 3. Delivery: the iAERO Transfer to the wallet on Base, scanned in 2,000-block chunks (public RPCs refuse
  //    more) from where the last scan stopped, carrying on across retries. It must come from the order's vault
  //    (EVM sources, where the vault has the same address on Base) and match the delivered amount.
  useEffect(() => {
    if (order.status !== 'delivered' || order.deliveryTxHash || !order.baseFromBlock || !basePublic) return;
    let stop = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const want = order.amountOut ? unitsOf(order.amountOut) : null;
    const fromVault = kind === 'evm' ? (order.depositAddress as Address) : undefined;
    let from = BigInt(order.deliveryScannedTo ?? order.baseFromBlock);
    const scan = async () => {
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
            if (!stop) await patchOrder(order.id, { deliveryTxHash: hit.transactionHash, deliveredAtChain: at, deliveryScannedTo: String(to) });
            return;
          }
          from = to + 1n;
        }
      } catch { /* the link is optional */ }
      if (!stop) await patchOrder(order.id, { deliveryScannedTo: String(from) });
      if (!stop && ++tries < 8) timer = setTimeout(scan, 20000);
    };
    scan();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [order.status, order.deliveryTxHash, order.baseFromBlock, order.id, order.toAddress, order.amountOut, order.depositAddress, kind, basePublic]); // eslint-disable-line react-hooks/exhaustive-deps

  // 4. "Did my payment go out?" Rift must answer first: without its status nothing is concluded (a failed
  //    read never offers "Pay again"). Then the deposit address (any sign of a payment counts), then the paying
  //    account: anything sent from it since the payment was requested means a payment may be on its way.
  const [checking, setChecking] = useState(false);
  const [checkSaid, setCheckSaid] = useState<'nothing' | 'partial' | 'pending' | 'reverted' | 'error' | null>(null);
  async function judgePayment(): Promise<Verdict> {
    const u = parseOrderUpdate(await getOrder(order.id), order.id);
    await applyStatusUpdate(order.id, u);
    if (u.status !== 'awaiting_deposit') return 'moved';
    if (kind === 'evm') {
      if (!sourcePublic) throw new Error('no client');
      const ev = await evmDepositEvidence(sourcePublic, order);
      if (ev !== 'none') return ev;
      if (order.depositTxHash) {
        const receipt = await sourcePublic.getTransactionReceipt({ hash: order.depositTxHash as `0x${string}` })
          .catch(e => (notFound(e) ? null : Promise.reject(e)));
        if (receipt?.status === 'reverted') return 'reverted';
        if (receipt) return 'pending'; // a successful transfer with no deposit needs investigation
      }
      if (order.payNonce !== undefined && await accountNonce(sourcePublic, order.toAddress, 'pending') > order.payNonce) return 'pending';
    } else if (kind === 'hypercore') {
      const t = hyperCoreToken(order.token.asset);
      if (!t) throw new Error('unknown HyperCore token');
      const r = await hyperDepositEvidence(order, t.symbol);
      if (r.evidence !== 'none') return r.evidence;
    }
    return 'nothing';
  }
  const markArrived = () => patchOrder(order.id, prev => ({
    payUnknown: false, payRequestedAt: undefined, depositFailed: false, depositFailReason: undefined, depositConfirmedAt: Date.now(),
    depositSentAt: prev.depositSentAt ?? prev.payAttemptAt ?? Date.now(), startEstimated: prev.startEstimated || !prev.depositSentAt,
  }));
  /** Out of the way once its window has closed and a check found nothing; still tracked, at the idle rate. */
  const hide = () => { void patchOrder(order.id, prev => (canHide(prev, Date.now()) ? { hiddenAt: Date.now() } : {})); };
  async function checkPayment(thenPay = false) {
    if (thenPay && !settlementAck) return;
    setChecking(true);
    setCheckSaid(null);
    try {
      const v = await judgePayment();
      if (v === 'arrived') {
        await markArrived();
        showToast?.('Your payment reached the deposit address. Tracking your order…', 'success');
      } else if (v === 'reverted') {
        await patchOrder(order.id, prev => prev.depositTxHash === order.depositTxHash && payState(prev, Date.now()) === 'unknown'
          ? { payUnknown: false, payRequestedAt: undefined, depositFailed: true, depositFailReason: 'reverted' as const }
          : {});
        setCheckSaid('reverted');
      } else if (v !== 'moved') {
        setCheckSaid(v);
        if (v === 'nothing' && thenPay && kind === 'hypercore') {
          // HyperCore retries the same saved signed action. A tab still waiting on the wallet keeps its marker fresh.
          await patchOrder(order.id, prev => (payState(prev, Date.now()) !== 'unknown' ? {} : {
            payUnknown: false, payRequestedAt: undefined,
            ...(prev.depositSentAt ? { depositFailed: true, depositFailReason: 'lost' as const } : {}),
          }));
          setCheckSaid(null);
          onPay(order);
        }
      }
    } catch {
      setCheckSaid('error');
    } finally {
      setChecking(false);
    }
  }

  // 5. Expected durations and where we are against them. A status first seen late (the page was closed)
  //    does not restart the clock: routing then started no later than the payment confirmed.
  const estimate = useMemo(() => estimateRoute(order.sourceChain, order.route, KNOWN_SYMBOLS), [order.sourceChain, order.route]);
  const seenFundedAt = order.statusTimes.funded ?? order.statusTimes.executing;
  const fundedLate = order.statusLate?.funded || (!order.statusTimes.funded && order.statusLate?.executing);
  const progress = computeProgress({
    ...phaseInput(order, kind),
    createdAt: order.createdAt,
    fundedAt: fundedLate ? (order.depositConfirmedAt ?? order.depositSentAt ?? seenFundedAt) : seenFundedAt,
    finishedAt: terminal ? order.statusTimes[order.status] : undefined,
    now,
    estimate,
  });
  const phase = progress.phase;
  const moving = phase === 'confirming' || phase === 'detecting' || phase === 'executing';
  const style = stale ? STALE_STYLE : PHASE_STYLE[phase];
  const windowOpen = payWindowOpen(order, kind, now);
  const wrongAccount = !!account && account.toLowerCase() !== order.toAddress.toLowerCase();

  const links: Partial<Record<string, StepLink>> = {};
  if (kind === 'evm' && order.depositTxHash && !order.payUnknown) links.deposit = { href: chain.txUrl(order.depositTxHash), text: 'Your payment transaction' };
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
    extras.deposit = kind === 'hypercore' ? 'Sent on Hyperliquid; waiting for Rift to register it.'
      : kind === 'evm' && !order.depositTxHash ? 'Sped up in your wallet and confirmed; waiting for Rift to register it.'
      : 'Confirmed on-chain; waiting for Rift to register it.';
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
  // A duration only from times that are real: the delivery's block time, or a status this page saw happen,
  // measured from a payment time that was not estimated.
  const startedAt = order.depositSentAt ?? order.btc?.firstSeenAt;
  const startReal = !order.startEstimated && !order.btc?.seenLate;
  const deliveredIn = !startReal ? null
    : order.deliveredAtChain && startedAt ? Math.max(0, (order.deliveredAtChain - startedAt) / 1000)
    : !order.statusLate?.delivered && progress.elapsedSec > 0 ? progress.elapsedSec : null;

  const copy = async (v: string) => { try { await navigator.clipboard.writeText(v); showToast?.('Copied', 'info'); } catch { /* blocked */ } };
  const switchToBase = async () => {
    try { await switchChainAsync({ chainId: base.id }); } catch (e) {
      const rejected = /reject|denied/i.test((e as { message?: string })?.message ?? '');
      showToast?.(rejected ? 'Switching to Base was cancelled.' : 'Couldn’t switch your wallet to Base. Switch it in your wallet.', 'info');
    }
  };
  const supportLink = <a href={RIFT_SUPPORT_URL} target="_blank" rel="noopener noreferrer" className="underline hover:text-white">contact Rift</a>;
  const staleActions = (
    <div className="flex flex-wrap gap-2">
      <Button onClick={() => onReorder(order)} className="bg-gradient-to-r from-indigo-600 to-purple-600">New order at today’s price</Button>
      <Button variant="outline" onClick={() => onDismiss(order)} className="border-slate-600 text-slate-200">Dismiss</Button>
    </div>
  );

  return (
    <Card className="min-w-0 border-slate-700/50 bg-slate-800/50 backdrop-blur-xl">
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base text-white">
          <span>{fmt(order.fromAmount, 8)} {order.token.symbol} on {chain.name} → iAERO</span>
          <span role="status" aria-live="polite"><Badge className={style.className}>{style.label}</Badge></span>
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
                  <>Usually done by now{progress.upToSec !== undefined && <> · up to about <span className="text-lg font-semibold text-white">{formatDuration(progress.upToSec)}</span> more</>}</>
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
          {(moving || phase === 'delivered') && <Bar value={progress.fraction * 100} className="mt-3" aria-label="Progress" />}
          {phase === 'refunded' && (
            <div className="text-sm text-amber-200">
              Rift could not complete the route and refunded {order.amountOut ? <>{fmt(order.amountOut, 8)} {order.token.symbol}</> : <>your {order.token.symbol}</>} to{' '}
              {short(order.refundAddress ?? 'the paying address')} on {chain.name}.
            </div>
          )}
          {phase === 'expired' && <div className="text-sm text-slate-300">No payment arrived before the deadline, so this order closed. Nothing was taken.</div>}
          {phase === 'frozen' && <div className="text-sm text-red-200">Rift put this order on hold (a compliance or safety check). Please {supportLink} with the order ID below. This page keeps checking it.</div>}
          {phase === 'underfunded' && (
            <div className="text-sm text-red-200">
              Rift received less than {fmt(order.fromAmount, 8)} {order.token.symbol}. Don’t send more yet: please {supportLink} with the order ID below.
            </div>
          )}
        </div>

        {/* Can't read the status, or a status this page doesn't know */}
        {!isFinalStatus(order.status) && pollFailures >= 3 && (
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
            {!wrongAccount && windowOpen && ps !== 'requesting' && (ps !== 'unknown' || kind === 'hypercore') && (
              <label className="flex cursor-pointer items-start gap-2 text-xs text-amber-100">
                <input type="checkbox" checked={settlementAck} onChange={e => setSettlementAck(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-amber-500" />
                <span>I understand Rift can deliver less iAERO than this order estimates. There is no guaranteed minimum after payment is sent.</span>
              </label>
            )}
            {wrongAccount ? (
              <div>This order delivers iAERO to <span className="font-mono">{short(order.toAddress)}</span>. Connect that wallet to pay it.</div>
            ) : ps === 'unknown' && order.hiddenAt ? (
              <>
                <div>You hid this order after a check found no payment. It is still tracked: if a payment turns up, it continues here.</div>
                {staleActions}
              </>
            ) : ps === 'unknown' ? (
              <>
                <div className="flex gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                  <div>We couldn’t confirm whether your payment went out. Check your wallet’s activity and this order before sending anything else.</div>
                </div>
                <div aria-live="polite" className="space-y-1 text-xs">
                  {checkSaid === 'nothing' && (windowOpen
                    ? <div className="text-slate-300">Nothing has reached the deposit address.{kind === 'evm'
                      ? ' An RPC check cannot prove a wallet request was never broadcast. Keep checking your wallet and this order before sending anything else.'
                      : order.hlAction ? ' You can retry the same signed Hyperliquid transfer: it can’t go through twice.'
                      : ' No signed transfer was saved, so nothing could have been sent. You can pay again.'}</div>
                    : <div className="text-slate-300">Nothing has reached the deposit address. Don’t pay this order now: its price is out of date. If your wallet shows the payment as pending, this order completes when it arrives; otherwise start a new order. You can hide this order: it stays tracked in the background.</div>)}
                  {checkSaid === 'reverted' && <div className="text-slate-300">The payment transaction reverted. Nothing reached Rift; you can try again while the price is current.</div>}
                  {checkSaid === 'partial' && <div className="text-amber-200">Part of the amount has reached the deposit address. Don’t pay again: if the rest doesn’t follow, Rift treats the order as underpaid, and you can {supportLink} with the order ID.</div>}
                  {checkSaid === 'pending' && <div className="text-amber-200">A transaction was sent from your account after the payment was requested. If it is this payment, it shows up here once it confirms. Don’t pay again.</div>}
                  {checkSaid === 'error' && <div className="text-amber-200">Couldn’t check right now (Rift or the network didn’t answer). Don’t pay again yet; try again in a moment.</div>}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => checkPayment()} disabled={checking} variant="outline" className="border-slate-600 text-slate-200">
                    {checking && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Check payment
                  </Button>
                  {checkSaid === 'nothing' && windowOpen && kind === 'hypercore' && (
                    <Button onClick={() => checkPayment(true)} disabled={!settlementAck || paying || checking} className="bg-gradient-to-r from-indigo-600 to-purple-600">Pay again</Button>
                  )}
                  {checkSaid === 'nothing' && !windowOpen && (
                    <>
                      <Button onClick={() => onReorder(order)} className="bg-gradient-to-r from-indigo-600 to-purple-600">New order at today’s price</Button>
                      {canHide(order, now) && (
                        <Button variant="outline" onClick={hide} className="border-slate-600 text-slate-200">Hide this order</Button>
                      )}
                    </>
                  )}
                </div>
              </>
            ) : ps === 'requesting' ? (
              // A wallet prompt is open (here or in another tab), even if the pay window closes meanwhile: nothing
              // about this order is settled until the wallet answers.
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                Waiting for your wallet{paying ? '' : ' (in another tab)'} to confirm or reject this payment…
              </div>
            ) : !windowOpen ? (
              <>
                <div>This order wasn’t paid within {Math.round(payWindowMs(kind) / 60_000)} minutes, so its price is out of date. Nothing was sent.</div>
                {staleActions}
              </>
            ) : (
              <>
                <div>
                  {order.depositFailed && (
                    <>Your last payment {order.depositFailReason === 'reverted' ? 'failed on-chain'
                      : order.depositFailReason === 'cancelled' ? 'was cancelled in your wallet'
                      : order.depositFailReason === 'pre_send' ? 'failed before it was broadcast'
                      : order.depositFailReason === 'lost' ? 'never reached the network'
                      : 'was replaced or cancelled in your wallet'}, so nothing was sent.{' '}</>
                  )}
                  Send <span className="font-medium text-white">{fmt(order.fromAmount, 8)} {order.token.symbol}</span> on {chain.name} to start.
                </div>
                <Button onClick={() => onPay(order)} disabled={!settlementAck || paying} className="h-auto min-h-10 w-full whitespace-normal bg-gradient-to-r from-indigo-600 to-purple-600 py-2.5 hover:from-indigo-700 hover:to-purple-700">
                  {paying ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Waiting for your wallet…</> : `Pay ${fmt(order.fromAmount, 8)} ${order.token.symbol}`}
                </Button>
              </>
            )}
          </div>
        )}

        {/* Paying with Bitcoin */}
        {phase === 'pay' && kind === 'bitcoin' && (windowOpen ? (
          <>
            {order.btc?.missing && (
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-100">
                The Bitcoin payment seen earlier is no longer in the mempool (it was dropped or replaced). Check your wallet before sending again.
              </div>
            )}
            <BitcoinPayment address={order.depositAddress} amountBtc={order.fromAmount} sendBy={order.createdAt + payWindowMs('bitcoin')} />
          </>
        ) : (
          <div className="space-y-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-sm text-slate-200">
            <div>This order wasn’t paid within an hour, so its price is out of date. Don’t send to its address; start a new order instead.</div>
            {staleActions}
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
            <Button variant="outline" onClick={switchToBase} className="border-slate-600 text-slate-200">Switch wallet back to Base</Button>
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
