// src/components/protocol/GetIaeroSection.tsx
//
// "Get iAERO": turn a token you hold into iAERO in one step, routed by Rift (rift.trade). The picker lists
// your own tokens on Ethereum, Arbitrum, Base and Hyperliquid (HyperCore spot) that Rift can route, highest
// USD value first; Bitcoin from another wallet is offered last. Before committing you see the iAERO you will
// get, what that costs against market prices, the route and how long it takes. One click re-checks the price
// against your tolerance, creates the order and asks the wallet for a single plain transfer (or, for
// HyperCore, one signed Hyperliquid transfer) to the order's one-time deposit address. Rift does the rest;
// OrderTracker shows every step, and every unfinished order is tracked in the background (watch.ts).
//
// Money safety: one purchase at a time and one payment per order (in-flight guards); a quote is never reused
// for a second order; a payment whose outcome is unknown is checked before it can be repeated; an order is
// paid only by the wallet it delivers to and only while its price is current (order-state.ts).

'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useAccount, useBalance, useGasPrice, usePublicClient, useReadContract, useSendTransaction, useSignTypedData, useSwitchChain,
  useWriteContract,
} from 'wagmi';
import { arbitrum, base, mainnet } from 'wagmi/chains';
import { useConnectModal } from '@rainbow-me/rainbowkit';
import { erc20Abi, formatUnits, isAddress, parseSignature, type Address } from 'viem';
import { AlertTriangle, ArrowLeftRight, Bell, Bitcoin, Info, Loader2, RefreshCw, Route as RouteIcon, ShieldCheck, Timer } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useDebounce } from '@/components/lib/defi-utils';
import RouteSteps from '@/components/rift/RouteSteps';
import OrderTracker from '@/components/rift/OrderTracker';
import RecentOrders from '@/components/rift/RecentOrders';
import { CURATED_TOKENS, KNOWN_SYMBOLS, RIFT_DESTINATION, RIFT_SECURITY_URL, SOURCE_CHAINS } from '@/lib/rift/config';
import { classifyRiftError, createOrder, explainRiftError, fetchQuote, RiftApiError } from '@/lib/rift/client';
import { decimalToRaw, isContractCode, normalizeDecimal, parseOrder, parseQuote } from '@/lib/rift/validate';
import { estimateRoute, formatRange } from '@/lib/rift/timing';
import { isBtcAddress, normalizeBtcAddress } from '@/lib/rift/bitcoin';
import { rawToNumber, type Holding } from '@/lib/rift/holdings';
import { useRiftSupport } from '@/lib/rift/support';
import { useMarketPrices } from '@/lib/rift/prices';
import { parseAmountInput } from '@/lib/rift/amount';
import {
  HL_API, HL_NEW_ADDRESS_FEE_USDC, HL_SIGNATURE_CHAIN_ID, HYPERCORE_TOKENS, hyperCoreToken, parseSpotBalances, spotSendRequest,
  spotSendResult, spotSendToken, spotSendTypedData, usdcForFee,
} from '@/lib/rift/hypercore';
import {
  DEFAULT_TOLERANCE_PCT, TOLERANCE_CHOICES, assessCost, costNeedsTick, costText, formatPct, gasDeskChains, gasDeskUsd,
  priceDropPct, type CostCheck, type CostLevel,
} from '@/lib/rift/cost';
import { canPay, isTerminalStatus, needsAttention } from '@/lib/rift/order-state';
import { loadOrders, patchOrder, removeOrders, storageFailing, upsertOrder, useStoredOrders } from '@/lib/rift/storage';
import { useOrderWatcher } from '@/lib/rift/watch';
import type { RiftQuote, SourceToken, StoredOrder } from '@/lib/rift/types';

type EvmChainId = 1 | 42161 | 8453;
const BTC_ASSET = 'bitcoin.btc';
const BTC_TOKEN = CURATED_TOKENS.find(t => t.asset === BTC_ASSET)!;
const TOLERANCE_KEY = 'iaero.rift.tolerance.v1';
/** A quote older than this is re-fetched when you click Buy, and compared with what you saw. */
const RECHECK_AFTER_MS = 20_000;
const HOLDINGS_TIMEOUT_MS = 45_000;

const COST_STYLE: Record<CostLevel, string> = {
  low: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200',
  medium: 'border-amber-500/25 bg-amber-500/10 text-amber-100',
  high: 'border-red-500/30 bg-red-500/10 text-red-200',
};
const LEVEL_WORD: Record<CostLevel, string> = { low: 'Low', medium: 'Moderate', high: 'High' };

const CHAIN_NAMES: Record<number, string> = { 1: 'Ethereum', 42161: 'Arbitrum', 8453: 'Base' };
const chainList = (ids: number[]) => ids.map(id => CHAIN_NAMES[id] ?? `chain ${id}`).join(' and ');

/** A quote that got worse than the tolerance between seeing it and clicking Buy. */
interface PriceMove { seenOut: string; quote: RiftQuote; fetchedAt: number; dropPct: number; limit: number }
/** The user's tick on a cost that needs one: for this token and amount, and this kind of check. */
interface Ack { key: string; kind: CostCheck['kind']; pct: number }

interface Props {
  /** The tab is showing: holdings, quotes, prices and route checks run only then. */
  active: boolean;
  showToast: (message: string, type: 'success' | 'error' | 'info' | 'warning') => void;
  onGoToStake?: () => void;
}

const fmt = (v: string | number | undefined, digits = 4) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: digits }) : '—';
};
const fmtUsd = (n: number) => n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: n >= 1000 ? 0 : 2 });
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const errText = (e: unknown) => {
  const x = e as { shortMessage?: string; message?: string };
  return x?.shortMessage ?? x?.message ?? String(e);
};
const errorNames = (e: unknown): string[] => {
  const names: string[] = [];
  let x = e as { name?: string; cause?: unknown } | undefined;
  for (let i = 0; x && i < 8; i++, x = x.cause as typeof x) if (x.name) names.push(x.name);
  return names;
};
const isUserRejection = (e: unknown) => {
  const x = e as { name?: string; code?: number; message?: string; cause?: { code?: number } };
  return errorNames(e).includes('UserRejectedRequestError') || x?.code === 4001 || x?.cause?.code === 4001
    || /user (rejected|denied)|rejected the request/i.test(x?.message ?? '');
};
/** viem could not reach a chain's RPC ("HTTP request failed."), anywhere in the error's cause chain. */
const isNetworkError = (e: unknown) => errorNames(e).some(n => n === 'HttpRequestError' || n === 'TimeoutError' || n === 'WebSocketRequestError');
/** Wallet errors raised before anything could be broadcast: the payment certainly did not go out. */
const PRE_SEND = new Set([
  'ChainMismatchError', 'ChainNotConfiguredError', 'ConnectorNotConnectedError', 'ConnectorAccountNotFoundError', 'InsufficientFundsError',
  'EstimateGasExecutionError', 'ExecutionRevertedError', 'IntrinsicGasTooLowError', 'IntrinsicGasTooHighError', 'FeeCapTooLowError',
  'FeeCapTooHighError', 'NonceTooLowError', 'NonceTooHighError', 'NonceMaxValueError', 'SwitchChainError', 'UnsupportedProviderMethodError',
  'UnauthorizedProviderError', 'ProviderDisconnectedError', 'ChainDisconnectedError',
]);
const isPreSend = (e: unknown) => errorNames(e).some(n => PRE_SEND.has(n));

function loadTolerance(): number {
  try {
    const v = Number(localStorage.getItem(TOLERANCE_KEY));
    return (TOLERANCE_CHOICES as readonly number[]).includes(v) ? v : DEFAULT_TOLERANCE_PCT;
  } catch {
    return DEFAULT_TOLERANCE_PCT;
  }
}

function warningText(w: string): string {
  const [chain] = w.split(':');
  const name = chain.charAt(0).toUpperCase() + chain.slice(1);
  if (/token list unavailable/.test(w)) return `${name}: only major tokens checked`;
  if (/on-chain/.test(w)) return `${name}: balances may be out of date`;
  if (chain === 'hyperliquid') return 'Hyperliquid balances unavailable';
  if (chain === 'prices') return 'some prices unavailable';
  return w;
}

const toSourceToken = (h: Holding): SourceToken => ({ chain: h.chain, symbol: h.symbol, name: h.name, decimals: h.decimals, address: h.address, asset: h.asset });

function TokenIcon({ src, symbol }: { src?: string; symbol: string }) {
  const [broken, setBroken] = useState(false);
  if (src && !broken) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" className="h-8 w-8 shrink-0 rounded-full bg-slate-700" onError={() => setBroken(true)} />;
  }
  return <div aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-700 text-xs font-semibold text-slate-200">{symbol.slice(0, 3)}</div>;
}

export default function GetIaeroSection({ active, showToast, onGoToStake }: Props) {
  const { address, isConnected, chainId: walletChainId } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();
  const { writeContractAsync } = useWriteContract();
  const { signTypedDataAsync } = useSignTypedData();
  const queryClient = useQueryClient();
  const basePublic = usePublicClient({ chainId: base.id });
  const ethPublic = usePublicClient({ chainId: mainnet.id });
  const arbPublic = usePublicClient({ chainId: arbitrum.id });
  const allOrders = useStoredOrders();
  // Orders of the connected wallet only: another account's unpaid order must not be paid from this one.
  const orders = useMemo(
    () => (address ? allOrders.filter(o => o.toAddress.toLowerCase() === address.toLowerCase()) : []),
    [allOrders, address],
  );

  // The latest account and chain, for checks after awaits (the user can switch either mid-flow).
  const addressRef = useRef(address);
  addressRef.current = address;
  const walletChainRef = useRef(walletChainId);
  walletChainRef.current = walletChainId;

  const [selected, setSelected] = useState<string | null>(null);
  const [amountText, setAmountText] = useState('');
  const [btcRefund, setBtcRefund] = useState('');
  const notifySupported = typeof Notification !== 'undefined';
  const [notify, setNotify] = useState(() => notifySupported && Notification.permission === 'granted');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [tolerance, setTolerance] = useState(DEFAULT_TOLERANCE_PCT);
  const [moved, setMoved] = useState<PriceMove | null>(null);
  const [ack, setAck] = useState<Ack | null>(null);
  const startingRef = useRef(false);
  const payingRef = useRef(new Set<string>());
  const formRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setTolerance(loadTolerance()); }, []);
  const chooseTolerance = (v: number) => {
    setTolerance(v);
    try { localStorage.setItem(TOLERANCE_KEY, String(v)); } catch { /* private mode */ }
  };
  // Asked when the box is ticked (a click), never in the middle of a purchase.
  const toggleNotify = async (on: boolean) => {
    if (!on || !notifySupported) { setNotify(false); return; }
    if (Notification.permission === 'granted') { setNotify(true); return; }
    try {
      const p = await Notification.requestPermission();
      setNotify(p === 'granted');
      if (p === 'denied') showToast('Notifications are blocked for this site in your browser settings.', 'info');
    } catch { setNotify(false); }
  };

  // --- Your tokens: balances on Ethereum, Arbitrum, Base and HyperCore, valued in USD, largest first ---
  const freshRef = useRef(false);
  const holdingsQuery = useQuery({
    queryKey: ['rift-holdings', address],
    enabled: !!address && active,
    queryFn: async ({ signal }): Promise<{ holdings: Holding[]; warnings: string[]; hyperliquidUsdc?: string }> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HOLDINGS_TIMEOUT_MS);
      signal.addEventListener('abort', () => controller.abort());
      try {
        const res = await fetch(`/api/rift/holdings?address=${address}${freshRef.current ? '&fresh=1' : ''}`, { signal: controller.signal });
        freshRef.current = false;
        if (!res.ok) throw new Error(`Could not load your tokens (HTTP ${res.status})`);
        return res.json();
      } catch (e) {
        if (controller.signal.aborted && !signal.aborted) throw new Error('Loading your tokens took too long. Refresh to try again.');
        throw e;
      } finally {
        clearTimeout(timer);
      }
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const holdings = useMemo(() => holdingsQuery.data?.holdings ?? [], [holdingsQuery.data]);
  const support = useRiftSupport(holdings, active);
  const usable = useMemo(() => holdings.filter(h => support[h.asset] === 'supported'), [holdings, support]);
  const checking = holdings.filter(h => support[h.asset] === 'checking').length;

  // A new account starts over.
  useEffect(() => { setSelected(null); setAmountText(''); setAck(null); setMoved(null); setError(null); }, [address]);

  // Start on the most valuable usable token, and keep a choice that drops out of a single refresh (a slow
  // source for a minute) instead of jumping to another token mid-review.
  const lastHolding = useRef<Holding | null>(null);
  const misses = useRef<{ at: number; count: number }>({ at: 0, count: 0 });
  useEffect(() => {
    if (selected === BTC_ASSET || startingRef.current) return;
    const found = selected ? usable.find(h => h.asset === selected) : undefined;
    if (found) { lastHolding.current = found; misses.current = { at: holdingsQuery.dataUpdatedAt, count: 0 }; return; }
    if (selected && lastHolding.current?.asset === selected) {
      if (misses.current.at !== holdingsQuery.dataUpdatedAt) misses.current = { at: holdingsQuery.dataUpdatedAt, count: misses.current.count + 1 };
      if (misses.current.count < 2) return;
    }
    if (usable.length) {
      setSelected(usable[0].asset);
      setAmountText('');
      lastHolding.current = usable[0];
      misses.current = { at: holdingsQuery.dataUpdatedAt, count: 0 };
    }
  }, [usable, selected, holdingsQuery.dataUpdatedAt]);

  const holding = usable.find(h => h.asset === selected)
    ?? (selected && selected !== BTC_ASSET && lastHolding.current?.asset === selected ? lastHolding.current : null);
  const token: SourceToken | null = selected === BTC_ASSET ? BTC_TOKEN : holding ? toSourceToken(holding) : null;
  const chainKey = token?.chain ?? 'base';
  const chain = SOURCE_CHAINS[chainKey];
  const evmChainId = chain.chainId as EvmChainId | undefined;
  const sourcePublic = usePublicClient({ chainId: evmChainId ?? base.id });
  const isHyperCore = chain.kind === 'hypercore';

  // Live balance of the chosen EVM token (the list's balance is up to a minute old).
  const nativeBal = useBalance({ address, chainId: evmChainId, query: { enabled: active && !!address && chain.kind === 'evm' && !!token && !token.address } });
  const tokenBal = useReadContract({
    address: token?.address, abi: erc20Abi, functionName: 'balanceOf', args: address ? [address] : undefined, chainId: evmChainId,
    query: { enabled: active && !!address && chain.kind === 'evm' && !!token?.address },
  });
  const liveBalance = token?.address ? (tokenBal.data as bigint | undefined) : nativeBal.data?.value;
  // HyperCore: Hyperliquid takes 1 USDC for every transfer to a new address, so USDC keeps that back and
  // other tokens need it available (under portfolio margin it can be borrowed).
  const hlFeeRaw = token && isHyperCore && token.symbol === 'USDC' ? decimalToRaw(String(HL_NEW_ADDRESS_FEE_USDC), token.decimals) : 0n;
  const balanceRaw: bigint | undefined = !token ? undefined
    : chain.kind === 'evm' ? liveBalance ?? (holding ? BigInt(holding.balanceRaw) : undefined)
    : isHyperCore && holding ? (BigInt(holding.balanceRaw) > hlFeeRaw ? BigInt(holding.balanceRaw) - hlFeeRaw : 0n)
    : undefined;
  const hlUsdcShort = isHyperCore && token?.symbol !== 'USDC' && Number(holdingsQuery.data?.hyperliquidUsdc ?? 0) < HL_NEW_ADDRESS_FEE_USDC;

  const amountState = useMemo((): { normalized?: string; raw?: bigint; error?: string } => {
    if (!token) return {};
    const parsed = parseAmountInput(amountText, token.decimals);
    if (parsed.error) return { error: parsed.error };
    if (!parsed.value) return {};
    const raw = decimalToRaw(parsed.value, token.decimals);
    if (balanceRaw !== undefined && raw > balanceRaw) {
      return { normalized: parsed.value, raw, error: hlFeeRaw ? 'Not enough USDC: 1 USDC stays for Hyperliquid’s transfer fee' : `Not enough ${token.symbol}` };
    }
    if (hlUsdcShort) return { normalized: parsed.value, raw, error: 'Hyperliquid charges 1 USDC per transfer: keep 1 USDC available' };
    return { normalized: parsed.value, raw };
  }, [amountText, token, balanceRaw, hlFeeRaw, hlUsdcShort]);

  const setMax = () => {
    if (!token || balanceRaw === undefined) return;
    let raw = balanceRaw;
    if (!token.address && chain.gasReserve) {
      const reserve = decimalToRaw(chain.gasReserve, token.decimals);
      raw = raw > reserve ? raw - reserve : 0n;
    }
    setAmountText(normalizeDecimal(formatUnits(raw, token.decimals)));
  };

  // Market prices (prices.ts): iAERO from its Aerodrome pool, the token from DeFiLlama, else the list's price.
  const market = useMarketPrices(token?.asset, active);
  const inputPriceUsd = market.inputUsd ?? holding?.priceUsd ?? 0;
  const iaeroUsd = market.iaeroUsd ?? 0;
  const amountUsd = amountState.normalized && inputPriceUsd ? Number(amountState.normalized) * inputPriceUsd : 0;

  // --- Live quote: re-priced every 30 s while shown (paused while a price move waits for your answer) ---
  const quoteAmount = useDebounce(amountState.error ? undefined : amountState.normalized, 600);
  const quoteQuery = useQuery({
    queryKey: ['rift-quote', token?.asset, quoteAmount],
    enabled: active && !!token && !!quoteAmount,
    queryFn: async ({ signal }) =>
      parseQuote(await fetchQuote({ from: token!.asset, from_amount: quoteAmount! }, signal), {
        destination: RIFT_DESTINATION, fromChain: chainKey, fromAmount: quoteAmount!,
      }),
    refetchInterval: moved || !active ? false : 30_000,
    staleTime: 20_000,
    retry: (count, e) => classifyRiftError(e) === 'rate_limited' && count < 2,
    retryDelay: 8_000,
  });
  const quote = quoteQuery.data && quoteAmount && amountState.normalized === quoteAmount ? quoteQuery.data : undefined;
  const estimate = useMemo(() => (quote ? estimateRoute(chainKey, quote.route, KNOWN_SYMBOLS) : null), [quote, chainKey]);

  // Rift's gas desk charges each chain's gas once you have paid, and its quote leaves that out (cost.ts). The
  // page expects the quote minus that charge, valued in iAERO at the pool price; Ethereum's gas price is
  // fetched only when the route runs on Ethereum.
  const routeOnEthereum = !!quote && gasDeskChains(quote.route).includes(1);
  const { data: ethGasPrice } = useGasPrice({ chainId: mainnet.id, query: { enabled: active && routeOnEthereum, refetchInterval: 60_000 } });
  const expectedFor = (q: RiftQuote | undefined) => {
    if (!q) return null;
    const chains = gasDeskChains(q.route);
    const usd = gasDeskUsd(chains, ethGasPrice, market.ethUsd);
    if (usd === null || (usd > 0 && !iaeroUsd)) return null;
    return { out: Number(q.estimated_amount_out) - (usd > 0 ? usd / iaeroUsd : 0), gasUsd: usd, chains };
  };
  const expected = expectedFor(quote);
  const expectedOut = quote ? Math.max(0, expected?.out ?? Number(quote.estimated_amount_out)) : 0;

  // What the order costs against market prices; no price, or prices that disagree, also need the tick.
  const hlFeeUsd = isHyperCore ? HL_NEW_ADDRESS_FEE_USDC : 0;
  const costOf = (q: RiftQuote) => {
    const usdIn = inputPriceUsd > 0 ? Number(q.from_amount) * inputPriceUsd + hlFeeUsd : null;
    const e = expectedFor(q);
    const usdOut = e && iaeroUsd > 0 ? e.out * iaeroUsd : null;
    return { check: assessCost(usdIn, usdOut), usdIn, usdOut };
  };
  const cost = quote ? costOf(quote) : null;
  const ackKey = `${token?.asset}|${quoteAmount}`;
  const ackCovers = (a: Ack | null, c: CostCheck) =>
    !!a && a.key === ackKey && a.kind === c.kind && (c.kind === 'unknown' || c.pct <= a.pct + 0.5);
  const needsAck = !!cost && costNeedsTick(cost.check) && !ackCovers(ack, cost.check);
  const tooSmall = !!cost && cost.usdOut !== null && cost.usdOut <= 0;

  // What you saw: the quote on screen, or the one before it if it changed in the last 3 seconds
  // (a refresh landing just before your click is not something you had time to read).
  const shown = useRef<{ key: string; out: string; since: number; prevOut?: string } | null>(null);
  useEffect(() => {
    if (!quote) return;
    const key = `${quote.from}|${quote.from_amount}`;
    const s = shown.current;
    if (s && s.key === key && s.out === quote.estimated_amount_out) return;
    shown.current = { key, out: quote.estimated_amount_out, since: Date.now(), prevOut: s?.key === key ? s.out : undefined };
  }, [quote]);
  // A price move belongs to the token and amount it was found for.
  useEffect(() => { setMoved(null); }, [token?.asset, quoteAmount]);

  // --- Orders ---
  useEffect(() => {
    // Resume this wallet's most recent unfinished order after a refresh.
    if (activeId && orders.some(o => o.id === activeId)) return;
    setActiveId(orders.length ? (orders.find(o => !isTerminalStatus(o.status)) ?? orders[0]).id : null);
  }, [orders, activeId]);
  const activeOrder = orders.find(o => o.id === activeId) ?? null;
  useOrderWatcher(orders, activeId, showToast);

  /** Pay an order, once: only the wallet it delivers to, only while its price is current, and never while a
   *  previous attempt might still be on its way. */
  async function pay(o: StoredOrder) {
    const kind = SOURCE_CHAINS[o.sourceChain].kind;
    if (payingRef.current.has(o.id)) return;
    const latest = loadOrders().find(x => x.id === o.id) ?? o; // another tab may have paid it
    if (!addressRef.current || addressRef.current.toLowerCase() !== latest.toAddress.toLowerCase()) {
      setError(`This order delivers iAERO to ${short(latest.toAddress)}. Connect that wallet to pay it.`);
      return;
    }
    if (!canPay(latest, kind, Date.now())) {
      setError('This order can’t be paid now: it is already paid, its payment is being checked, or its price is out of date.');
      return;
    }
    payingRef.current.add(o.id);
    setPayingId(o.id);
    setError(null);
    try {
      if (kind === 'hypercore') await payHyperCore(latest);
      else await payEvm(latest);
    } finally {
      payingRef.current.delete(o.id);
      setPayingId(null);
      setBusy(null);
    }
  }

  /** What happened when the wallet call failed: cancelled, failed before anything went out, or unknown. */
  function recordPayFailure(o: StoredOrder, e: unknown, where: string) {
    if (isUserRejection(e)) {
      patchOrder(o.id, { payRequestedAt: undefined });
      const msg = 'Payment cancelled in your wallet. You can pay from the order card while its price is current.';
      setError(msg); showToast(msg, 'info');
    } else if (isPreSend(e)) {
      patchOrder(o.id, { payRequestedAt: undefined });
      const msg = `Payment failed before anything was sent: ${errText(e)}`;
      setError(msg); showToast(msg, 'error');
    } else {
      patchOrder(o.id, { payRequestedAt: undefined, payUnknown: true });
      const msg = `We couldn’t confirm whether your payment ${where}. Check your wallet before paying again; the order card can check the deposit address for you.`;
      setError(msg); showToast(msg, 'warning');
    }
  }

  async function payEvm(o: StoredOrder) {
    const c = SOURCE_CHAINS[o.sourceChain];
    if (c.kind !== 'evm' || !c.chainId) return;
    if (walletChainRef.current !== c.chainId) {
      setBusy(`Switch your wallet to ${c.name}…`);
      try { await switchChainAsync({ chainId: c.chainId as EvmChainId }); } catch (e) {
        const msg = isUserRejection(e) ? `Switching to ${c.name} was cancelled. Nothing was sent.` : `Couldn’t switch your wallet to ${c.name}: ${errText(e)}`;
        setError(msg); showToast(msg, 'info');
        return;
      }
    }
    patchOrder(o.id, { payRequestedAt: Date.now(), payUnknown: false, depositFailed: false, depositFailReason: undefined });
    setBusy('Confirm the payment in your wallet…');
    try {
      const value = BigInt(o.fromAmountRaw);
      const to = o.depositAddress as Address;
      const hash = o.token.address
        ? await writeContractAsync({ address: o.token.address as Address, abi: erc20Abi, functionName: 'transfer', args: [to, value], chainId: c.chainId as EvmChainId })
        : await sendTransactionAsync({ to, value, chainId: c.chainId as EvmChainId });
      patchOrder(o.id, { depositTxHash: hash, depositSentAt: Date.now(), payRequestedAt: undefined, depositConfirmedAt: undefined });
      showToast('Payment sent. Tracking your order…', 'success');
    } catch (e) {
      recordPayFailure(o, e, 'was sent');
    }
  }

  /** HyperCore: sign a spot transfer to the deposit address (on Arbitrum, the chain the signature's domain
   *  names) and post it to Hyperliquid. Accepted means final; there is no transaction hash. */
  async function payHyperCore(o: StoredOrder) {
    const t = hyperCoreToken(o.token.asset);
    if (!t) return;
    if (walletChainRef.current !== HL_SIGNATURE_CHAIN_ID) {
      setBusy('Switch your wallet to Arbitrum to sign…');
      try { await switchChainAsync({ chainId: arbitrum.id }); } catch (e) {
        const msg = isUserRejection(e) ? 'Switching to Arbitrum was cancelled. Nothing was sent.' : `Couldn’t switch your wallet to Arbitrum: ${errText(e)}`;
        setError(msg); showToast(msg, 'info');
        return;
      }
    }
    patchOrder(o.id, { payRequestedAt: Date.now(), payUnknown: false, depositFailed: false, depositFailReason: undefined });
    setBusy('Sign the Hyperliquid transfer in your wallet…');
    const transfer = { destination: o.depositAddress, token: spotSendToken(t), amount: o.fromAmount, time: Date.now() };
    let sig: ReturnType<typeof parseSignature>;
    try {
      sig = parseSignature(await signTypedDataAsync(spotSendTypedData(transfer)));
    } catch (e) {
      // Nothing can have moved without a signature.
      if (isUserRejection(e)) { recordPayFailure(o, e, 'was sent'); return; }
      patchOrder(o.id, { payRequestedAt: undefined });
      const msg = `Signing failed, so nothing was sent: ${errText(e)}`;
      setError(msg); showToast(msg, 'error');
      return;
    }
    setBusy('Sending on Hyperliquid…');
    let res: Response;
    try {
      res = await fetch(`${HL_API}/exchange`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(spotSendRequest(transfer, { r: sig.r, s: sig.s, v: Number(sig.v ?? BigInt(27 + (sig.yParity ?? 0))) })),
      });
    } catch (e) {
      recordPayFailure(o, e, 'reached Hyperliquid');
      return;
    }
    const text = await res.text().catch(() => '');
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { /* not JSON: the outcome is unknown */ }
    const result = json ? spotSendResult(json) : null;
    if (result?.ok) {
      const now = Date.now();
      patchOrder(o.id, { depositSentAt: now, depositConfirmedAt: now, payRequestedAt: undefined });
      showToast('Transfer sent on Hyperliquid. Tracking your order…', 'success');
    } else if (result && !result.ok) {
      // Hyperliquid answered and refused: nothing moved.
      patchOrder(o.id, { payRequestedAt: undefined });
      const msg = `Hyperliquid refused the transfer: ${result.error}`;
      setError(msg); showToast(msg, 'error');
    } else {
      recordPayFailure(o, new Error(`HTTP ${res.status}`), 'reached Hyperliquid');
    }
  }

  /** Is the wallet a smart-contract wallet on the chain it pays from (or is connected on) but not on Base?
   *  Then it could not use the iAERO delivered there. */
  async function smartWalletProblem(owner: Address): Promise<string | null> {
    const checkChain = chain.kind === 'evm' ? chain.chainId : walletChainRef.current;
    if (!checkChain || checkChain === base.id || !basePublic) return null;
    const client = checkChain === mainnet.id ? ethPublic : checkChain === arbitrum.id ? arbPublic : null;
    if (!client) return null;
    const [code, onBase] = await Promise.all([client.getCode({ address: owner }), basePublic.getCode({ address: owner })]);
    return isContractCode(code) && (!onBase || onBase === '0x')
      ? `Your wallet is a smart-contract wallet on ${CHAIN_NAMES[checkChain]} but not on Base, so it could not receive iAERO there.`
      : null;
  }

  /** Buy. `accepted` is a new price the user agreed to after a move; otherwise the baseline is what they saw. */
  async function start(accepted?: PriceMove) {
    if (startingRef.current || !address || !token || !quote || !amountState.raw) return;
    startingRef.current = true;
    const owner = address as Address;
    setBusy('Checking…');
    setError(null);
    setMoved(null);
    const stillSameAccount = () => {
      if (addressRef.current?.toLowerCase() !== owner.toLowerCase()) throw new Error('Your wallet account changed. Nothing was sent; check the new account and try again.');
    };
    try {
      const refund = chain.kind === 'bitcoin' ? normalizeBtcAddress(btcRefund) : owner;
      if (chain.kind === 'bitcoin' && !isBtcAddress(refund)) {
        throw new Error('Enter a valid Bitcoin refund address you control (not an exchange deposit address).');
      }
      setBusy('Checking your wallet…');
      let problem: string | null;
      try { problem = await smartWalletProblem(owner); } catch {
        throw new Error('Could not reach the network to check your wallet. Nothing was sent; try again in a moment.');
      }
      if (problem) throw new Error(problem);

      // Gas for the payment itself, on the paying chain.
      if (chain.kind === 'evm' && sourcePublic) {
        let native: bigint, gasPrice: bigint;
        try { [native, gasPrice] = await Promise.all([sourcePublic.getBalance({ address: owner }), sourcePublic.getGasPrice()]); } catch {
          throw new Error(`Could not reach ${chain.name} to check your balance. Nothing was sent; try again in a moment.`);
        }
        const fee = (gasPrice * (token.address ? 100_000n : 30_000n) * 3n) / 2n;
        const need = fee + (token.address ? 0n : amountState.raw);
        if (native < need) {
          throw new Error(token.address
            ? `You need a little ${chain.nativeSymbol} on ${chain.name} for the transfer’s network fee.`
            : `Not enough ${chain.nativeSymbol} on ${chain.name} for this amount plus the network fee. Lower the amount slightly.`);
        }
      }

      // HyperCore: the spendable balance and the 1 USDC fee, live (the list can be a minute old).
      if (chain.kind === 'hypercore') {
        setBusy('Checking your Hyperliquid balance…');
        let state: unknown;
        try {
          const res = await fetch(`${HL_API}/info`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'spotClearinghouseState', user: owner }),
          });
          state = await res.json();
        } catch {
          throw new Error('Could not reach Hyperliquid to check your balance. Nothing was sent; try again in a moment.');
        }
        const usdcToken = HYPERCORE_TOKENS.find(x => x.symbol === 'USDC')!;
        const fee = decimalToRaw(String(HL_NEW_ADDRESS_FEE_USDC), usdcToken.decimals);
        const have = parseSpotBalances(state).find(r => r.token.asset === token.asset)?.availableRaw ?? 0n;
        if (have < amountState.raw + (token.symbol === 'USDC' ? fee : 0n)) {
          throw new Error(`Not enough ${token.symbol} available on Hyperliquid for this amount${token.symbol === 'USDC' ? ' plus the 1 USDC transfer fee' : ''}.`);
        }
        if (token.symbol !== 'USDC' && usdcForFee(state) < HL_NEW_ADDRESS_FEE_USDC) {
          throw new Error('Hyperliquid charges 1 USDC per transfer to a new address: keep at least 1 USDC available.');
        }
      }

      // The price check. Baseline: the new price the user accepted, or what they saw on screen. A quote older
      // than 20 s, close to expiry, or already used for an order (Rift would return that order) is fetched
      // again; if it is worse than the baseline by more than the tolerance, stop and ask instead of buying.
      const used = (id: string) => loadOrders().some(x => x.quoteId === id);
      const s = shown.current;
      const justChanged = !!s?.prevOut && s.key === `${quote.from}|${quote.from_amount}` && Date.now() - s.since < 3000;
      const seenOut = accepted ? accepted.quote.estimated_amount_out : justChanged ? s!.prevOut! : quote.estimated_amount_out;
      let q = accepted?.quote ?? quote;
      let fetchedAt = accepted?.fetchedAt ?? quoteQuery.dataUpdatedAt;
      if (Date.now() - fetchedAt > RECHECK_AFTER_MS || Date.parse(q.expires_at) - Date.now() < 60_000 || used(q.id)) {
        setBusy('Checking the latest price…');
        const r = await quoteQuery.refetch();
        if (r.isError || !r.data) throw r.error ?? new Error('Could not refresh the price');
        q = r.data;
        fetchedAt = r.dataUpdatedAt;
        if (used(q.id)) throw new Error('Rift returned a price that was already used for an order. Nothing was sent; try again in a moment.');
      }
      const dropPct = priceDropPct(seenOut, q.estimated_amount_out);
      if (dropPct > tolerance) {
        setMoved({ seenOut, quote: q, fetchedAt, dropPct, limit: tolerance });
        return;
      }
      // The cost tick, against the price actually used (it can cross into "high" with this refresh).
      const freshExpected = expectedFor(q);
      const freshCost = costOf(q);
      if (freshCost.usdOut !== null && freshCost.usdOut <= 0) throw new Error('This amount is too small: Rift’s gas charge is more than the order is worth.');
      if (costNeedsTick(freshCost.check) && !ackCovers(ack, freshCost.check)) {
        throw new Error('The cost changed with the latest price. Nothing was sent: tick the confirmation above to continue.');
      }
      stillSameAccount();

      setBusy('Creating your order…');
      const fromAmount = normalizeDecimal(q.from_amount);
      const raw = decimalToRaw(fromAmount, token.decimals);
      const order = parseOrder(await createOrder({ quote_id: q.id, to_address: owner, refund_address: refund }), {
        destination: RIFT_DESTINATION, quoteId: q.id, toAddress: owner, fromChain: chainKey, fromAmount, refundAddress: refund, fresh: true,
      });
      // This quote is spent: the next purchase gets a new one.
      queryClient.removeQueries({ queryKey: ['rift-quote'] });
      // Never ask the wallet to send anything the order does not say, or to an address of the wrong kind.
      if (decimalToRaw(order.from_amount, token.decimals) !== raw) throw new Error('The order amount does not match your request. Nothing was sent.');
      if (chain.kind === 'bitcoin' ? !isBtcAddress(order.deposit_address) : !isAddress(order.deposit_address)) {
        throw new Error('Rift returned a deposit address of the wrong kind; nothing was sent.');
      }
      let baseFromBlock: string | undefined;
      try { baseFromBlock = basePublic ? String(await basePublic.getBlockNumber()) : undefined; } catch { /* optional */ }
      const stored: StoredOrder = {
        id: order.id, quoteId: q.id, createdAt: Date.now(), sourceChain: chainKey,
        token: { symbol: token.symbol, decimals: token.decimals, address: token.address, asset: token.asset },
        fromAmount, fromAmountRaw: raw.toString(), estimatedOut: q.estimated_amount_out, route: q.route,
        depositAddress: order.deposit_address, depositDeadline: order.deposit_deadline, toAddress: owner,
        refundAddress: refund, status: order.status, statusTimes: { [order.status]: Date.now() }, baseFromBlock, notify,
        marketUsdIn: inputPriceUsd ? Number(fromAmount) * inputPriceUsd + hlFeeUsd : undefined, marketIaeroUsd: iaeroUsd || undefined,
        expectedOut: freshExpected ? Math.max(0, freshExpected.out).toFixed(6) : undefined, gasDeskUsd: freshExpected?.gasUsd,
      };
      upsertOrder(stored);
      setActiveId(order.id);
      setAmountText('');
      setAck(null);
      if (chain.kind !== 'bitcoin') {
        stillSameAccount();
        await pay(stored);
      } else {
        showToast('Order created. Send the exact BTC amount shown to complete it.', 'info');
      }
    } catch (e) {
      if (e instanceof RiftApiError && classifyRiftError(e) === 'quote_expired') quoteQuery.refetch();
      const msg = e instanceof RiftApiError ? explainRiftError(e)
        : isNetworkError(e) ? 'Could not reach the network just now. Nothing was sent; try again in a moment.'
        : errText(e);
      setError(msg);
      showToast(msg, 'error');
    } finally {
      startingRef.current = false;
      setBusy(null);
    }
  }

  /** An unpaid order whose price is out of date: the same token and amount, priced again. */
  const reorder = (o: StoredOrder) => {
    setSelected(o.token.asset === BTC_ASSET ? BTC_ASSET : o.token.asset);
    setAmountText(o.fromAmount);
    setError(null);
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // The price-moved panel shows the same after-gas figures as the quote panel.
  const movedDeduction = moved ? Number(moved.quote.estimated_amount_out) - (expectedFor(moved.quote)?.out ?? Number(moved.quote.estimated_amount_out)) : 0;

  const cta = ((): { text: string; disabled: boolean; connect?: boolean } => {
    if (!isConnected) return { text: 'Connect a wallet to get iAERO', disabled: !openConnectModal, connect: true };
    if (!token) return { text: 'Choose a token to pay with', disabled: true };
    if (amountState.error) return { text: amountState.error, disabled: true };
    if (!amountState.normalized) return { text: 'Enter an amount', disabled: true };
    if (quoteQuery.isFetching && !quote) return { text: 'Finding the best route…', disabled: true };
    if (!quote) {
      const kind = quoteQuery.error ? classifyRiftError(quoteQuery.error) : null;
      return { text: kind === 'unavailable' || kind === 'network' || kind === 'rate_limited' ? 'Rift is unavailable right now' : quoteQuery.error ? 'No route available' : 'Waiting for a quote', disabled: true };
    }
    if (chain.kind === 'bitcoin' && !isBtcAddress(btcRefund)) return { text: 'Enter a valid BTC refund address', disabled: true };
    if (tooSmall) return { text: 'Amount too small for Rift’s gas charge', disabled: true };
    if (moved) return { text: 'The price moved: review it above', disabled: true };
    if (needsAck) return { text: 'Confirm the cost above to continue', disabled: true };
    return { text: chain.kind === 'bitcoin' ? 'Create Bitcoin payment' : `Buy iAERO with ${token.symbol}`, disabled: !!busy };
  })();

  const choose = (asset: string) => {
    if (asset === selected || busy) return;
    setSelected(asset);
    if (asset !== BTC_ASSET) lastHolding.current = usable.find(h => h.asset === asset) ?? null;
    setAmountText('');
    setError(null);
  };

  const warnings = [...new Set((holdingsQuery.data?.warnings ?? []).map(warningText))];

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {/* Order form */}
      <Card ref={formRef} className="min-w-0 scroll-mt-4 border-slate-700/50 bg-slate-800/50 backdrop-blur-xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-white">
            <ArrowLeftRight className="h-5 w-5 shrink-0" /> Get iAERO with tokens you hold
          </CardTitle>
          <p className="text-sm text-slate-400">Pay with any of your tokens on Ethereum, Arbitrum, Base or Hyperliquid. iAERO arrives in your wallet on Base, automatically.</p>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Your tokens */}
          <div className="space-y-2">
            <div id="rift-pay-with" className="text-sm font-medium text-slate-300">Pay with</div>
            {!isConnected ? (
              <div className="rounded-xl border border-slate-700/40 bg-slate-900/40 p-4 text-sm text-slate-400">Connect your wallet to see the tokens you can use.</div>
            ) : holdingsQuery.isLoading ? (
              <div className="flex items-center gap-2 rounded-xl border border-slate-700/40 bg-slate-900/40 p-4 text-sm text-slate-300">
                <Loader2 className="h-4 w-4 animate-spin" /> Finding your tokens on Ethereum, Arbitrum, Base and Hyperliquid…
              </div>
            ) : holdingsQuery.error && !holdingsQuery.data ? (
              <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-300">{(holdingsQuery.error as Error).message}</div>
            ) : (
              <div role="group" aria-labelledby="rift-pay-with" className="max-h-80 divide-y divide-slate-800 overflow-y-auto rounded-xl border border-slate-700/40 bg-slate-900/40">
                {usable.map(h => (
                  <button
                    key={h.asset} type="button" onClick={() => choose(h.asset)} disabled={!!busy} aria-pressed={selected === h.asset}
                    className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors ${selected === h.asset ? 'bg-indigo-500/15' : 'hover:bg-slate-800/60'}`}
                  >
                    <TokenIcon src={h.icon} symbol={h.symbol} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium text-white">{h.symbol}</span>
                        <span className="shrink-0 rounded bg-slate-700/60 px-1.5 py-0.5 text-[10px] text-slate-300">{SOURCE_CHAINS[h.chain].name}</span>
                      </div>
                      <div className="truncate text-xs text-slate-400">{fmt(rawToNumber(h.balanceRaw, h.decimals), 6)} {h.symbol}</div>
                    </div>
                    <div className="shrink-0 text-right text-sm font-medium text-white">{fmtUsd(h.valueUsd)}</div>
                  </button>
                ))}
                {!usable.length && !checking && (
                  <div className="p-4 text-sm text-slate-400">No tokens worth $1 or more that Rift can route were found in this wallet on Ethereum, Arbitrum, Base or Hyperliquid.</div>
                )}
                {!usable.length && checking > 0 && (
                  <div className="flex items-center gap-2 p-4 text-sm text-slate-300"><Loader2 className="h-4 w-4 animate-spin" /> Checking which of your tokens Rift can route…</div>
                )}
              </div>
            )}
            {warnings.length > 0 && (
              <div className="text-xs text-amber-300/90">Some balances may be incomplete ({warnings.join('; ')}). Refresh to try again.</div>
            )}
            {isConnected && !holdingsQuery.isLoading && (
              <div className="flex items-center justify-between gap-2 text-xs text-slate-400">
                <span>
                  {checking > 0 ? `Checking routes for ${checking} more token${checking === 1 ? '' : 's'}…` : 'Highest value first. Tokens under $1 and those without a route are hidden.'}
                </span>
                <button type="button" onClick={() => { freshRef.current = true; holdingsQuery.refetch(); }} className="flex shrink-0 items-center gap-1 hover:text-white">
                  <RefreshCw className={`h-3.5 w-3.5 ${holdingsQuery.isFetching ? 'animate-spin' : ''}`} /> Refresh
                </button>
              </div>
            )}
            <button
              type="button" onClick={() => choose(BTC_ASSET)} disabled={!!busy} aria-pressed={selected === BTC_ASSET}
              className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                selected === BTC_ASSET ? 'border-indigo-500 bg-indigo-500/15 text-white' : 'border-slate-700/50 text-slate-400 hover:border-slate-500 hover:text-slate-200'
              }`}
            >
              <Bitcoin className="h-4 w-4 shrink-0 text-amber-400" /> Paying with Bitcoin from another wallet? Use BTC
            </button>
          </div>

          {/* Amount */}
          {token && (
            <div className="space-y-2">
              <Label htmlFor="rift-amount" className="text-slate-300">Amount</Label>
              <div className="relative">
                <Input
                  id="rift-amount" type="text" inputMode="decimal" autoComplete="off" placeholder="0.0" value={amountText} disabled={!!busy}
                  onChange={e => setAmountText(e.target.value)} aria-invalid={!!amountState.error} aria-describedby="rift-amount-note"
                  className={`border-slate-600 bg-slate-900/50 pr-28 text-white placeholder-slate-400 ${amountState.error ? 'border-red-500/50' : ''}`}
                />
                <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
                  <span className="text-sm text-slate-400">{token.symbol}</span>
                  {(chain.kind === 'evm' || isHyperCore) && balanceRaw !== undefined && (
                    <Button variant="ghost" size="sm" onClick={setMax} disabled={!!busy} className="h-7 px-2 text-indigo-400 hover:text-indigo-300">MAX</Button>
                  )}
                </div>
              </div>
              <div id="rift-amount-note" className="flex flex-wrap justify-between gap-x-3 text-sm">
                {amountState.error ? <span className="text-red-400">{amountState.error}</span>
                  : (chain.kind === 'evm' || isHyperCore) && balanceRaw !== undefined
                    ? <span className="text-slate-400">{hlFeeRaw ? 'Spendable' : 'Balance'}: {fmt(formatUnits(balanceRaw, token.decimals), 6)} {token.symbol} on {chain.name}</span>
                    : <span className="text-slate-400">You will pay from any Bitcoin wallet using a QR code or address.</span>}
                {amountUsd > 0 && <span className="text-slate-400">≈ {fmtUsd(amountUsd)}</span>}
              </div>
            </div>
          )}

          {chain.kind === 'bitcoin' && token && (
            <div className="space-y-2">
              <Label htmlFor="rift-btc-refund" className="text-slate-300">Your Bitcoin refund address</Label>
              <Input
                id="rift-btc-refund" placeholder="bc1…" value={btcRefund} onChange={e => setBtcRefund(e.target.value)} disabled={!!busy}
                autoComplete="off" spellCheck={false} aria-invalid={!!btcRefund && !isBtcAddress(btcRefund)} aria-describedby="rift-btc-refund-note"
                className={`border-slate-600 bg-slate-900/50 font-mono text-sm text-white ${btcRefund && !isBtcAddress(btcRefund) ? 'border-red-500/50' : ''}`}
              />
              <div id="rift-btc-refund-note" className="text-xs text-slate-400">
                {btcRefund && !isBtcAddress(btcRefund) ? 'This is not a valid Bitcoin address (check for a typo). ' : ''}
                Only used if the order cannot complete. Use a wallet you control, not an exchange.
              </div>
            </div>
          )}

          {/* Quote */}
          {(quote || quoteQuery.isFetching || quoteQuery.error) && amountState.normalized && !amountState.error && (
            <div className="space-y-4 rounded-xl border border-slate-700/30 bg-slate-900/50 p-4">
              {!quote && quoteQuery.isFetching && (
                <div className="flex items-center gap-2 text-sm text-slate-300"><Loader2 className="h-4 w-4 animate-spin" /> Finding the best route across 20+ venues (a few seconds)…</div>
              )}
              {!quote && quoteQuery.error && !quoteQuery.isFetching && (
                <div role="alert" className="text-sm text-red-300">{explainRiftError(quoteQuery.error)}</div>
              )}
              {quote && estimate && cost && (
                <>
                  <div className="flex items-end justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs text-slate-400">You receive (estimated)</div>
                      <div className="break-words text-2xl font-semibold text-white">{fmt(expectedOut)} iAERO</div>
                      {iaeroUsd > 0 && <div className="text-xs text-slate-400">≈ {fmtUsd(expectedOut * iaeroUsd)}</div>}
                    </div>
                    {quoteQuery.isFetching && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-slate-400" />}
                  </div>
                  {expected && expected.gasUsd > 0 && (
                    <div className="text-xs text-slate-400">
                      After about {fmtUsd(expected.gasUsd)} that Rift deducts for network gas on {chainList(expected.chains)} once you pay.
                      Rift’s own quote, {fmt(quote.estimated_amount_out)} iAERO, leaves that out.
                    </div>
                  )}
                  {!expected && gasDeskChains(quote.route).length > 0 && (
                    <div className="text-xs text-amber-300/90">
                      Rift also deducts network gas once you pay, which its quote leaves out and which could not be estimated right now, so
                      expect somewhat less than this.
                    </div>
                  )}
                  {(() => {
                    const c = cost.check;
                    const box = c.kind === 'ok' ? COST_STYLE[c.level] : 'border-slate-500/40 bg-slate-800/70 text-slate-200';
                    return (
                      <div className={`space-y-1 rounded-lg border p-3 text-sm ${box}`}>
                        <div className="flex items-center justify-between gap-2">
                          <span>Cost vs market price</span>
                          <span className="font-semibold">{c.kind === 'ok' ? `${LEVEL_WORD[c.level]} · ${costText(c.pct)}` : c.kind === 'unknown' ? 'Can’t check' : 'Prices disagree'}</span>
                        </div>
                        {c.kind === 'ok' && (
                          <div className="text-xs opacity-90">
                            {tooSmall
                              ? <>Rift’s gas charge is more than this order is worth. Try a larger amount, or pay from Base or Arbitrum.</>
                              : <>You pay ≈ {fmtUsd(cost.usdIn ?? 0)}{isHyperCore ? ' (with Hyperliquid’s 1 USDC fee)' : ''} and get ≈ {fmtUsd(cost.usdOut ?? 0)} of iAERO at its
                                Aerodrome pool price. Includes every bridge, swap and network cost.</>}
                          </div>
                        )}
                        {c.kind === 'unknown' && (
                          <div className="text-xs">There’s no current market price to compare this quote with, so its cost can’t be checked.</div>
                        )}
                        {c.kind === 'disagree' && (
                          <div className="text-xs">Rift’s quote is {formatPct(c.pct)} better than the market prices this page sees, so one of them is probably out of date.</div>
                        )}
                        {costNeedsTick(c) && !tooSmall && (
                          <label className="flex cursor-pointer items-start gap-2 pt-1 text-xs">
                            <input
                              type="checkbox" checked={ackCovers(ack, c)} disabled={!!busy} className="mt-0.5 h-4 w-4 shrink-0 accent-red-500"
                              onChange={e => setAck(e.target.checked ? { key: ackKey, kind: c.kind, pct: c.kind === 'unknown' ? NaN : c.pct } : null)}
                            />
                            <span>
                              {c.kind === 'ok'
                                ? <>I understand I get about {formatPct(c.pct)} less than market value. A smaller amount usually costs less, because large orders move the iAERO price.</>
                                : <>I accept this quote as shown, without a market price check.</>}
                            </span>
                          </label>
                        )}
                      </div>
                    );
                  })()}
                  <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                    <div className="rounded-lg bg-slate-800/60 p-3">
                      <div className="flex items-center gap-1.5 text-xs text-slate-400"><Timer className="h-3.5 w-3.5" /> Time to arrive</div>
                      <div className="font-medium text-white">{formatRange(estimate.typicalSec, estimate.slowSec)}</div>
                      <div className="text-xs text-slate-400">after your payment is sent</div>
                    </div>
                    <div className="min-w-0 rounded-lg bg-slate-800/60 p-3">
                      <div className="text-xs text-slate-400">Rate</div>
                      <div className="break-words font-medium text-white">1 {token?.symbol} ≈ {fmt(expectedOut / Number(quote.from_amount), 4)} iAERO</div>
                      <div className="text-xs text-slate-400">network and venue costs included</div>
                    </div>
                  </div>
                  <div>
                    <div className="mb-2 flex items-center gap-1.5 text-xs text-slate-400"><RouteIcon className="h-3.5 w-3.5" /> Route</div>
                    <RouteSteps estimate={estimate} />
                  </div>
                  <div className="space-y-1.5 border-t border-slate-700/40 pt-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span id="rift-tolerance" className="text-xs text-slate-400">Max price change when you click Buy</span>
                      <div role="group" aria-labelledby="rift-tolerance" className="flex gap-1">
                        {TOLERANCE_CHOICES.map(v => (
                          <button
                            key={v} type="button" onClick={() => chooseTolerance(v)} disabled={!!busy} aria-pressed={tolerance === v}
                            className={`rounded-md px-2 py-0.5 text-xs transition-colors ${
                              tolerance === v ? 'bg-indigo-500/30 text-white ring-1 ring-indigo-400/60' : 'bg-slate-800 text-slate-400 hover:text-white'
                            }`}
                          >
                            {v}%
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="text-xs text-slate-400">
                      The price refreshes every 30 seconds and is checked again when you click. If Rift’s price has dropped by more than{' '}
                      {tolerance}%, nothing is sent and you are asked first. This is not a slippage limit: Rift has no way to cap the final
                      amount, and fills at the market price when your payment arrives
                      {chain.kind === 'bitcoin' ? ' (usually within the hour, after your BTC confirms)' : ''}.
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* The price got worse than the tolerance between seeing it and clicking */}
          {moved && (
            <div role="alert" className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
              <div className="flex gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                <div>
                  The price moved. You saw <span className="font-semibold text-white">{fmt(Math.max(0, Number(moved.seenOut) - movedDeduction))} iAERO</span>; it is now{' '}
                  <span className="font-semibold text-white">{fmt(Math.max(0, Number(moved.quote.estimated_amount_out) - movedDeduction))} iAERO</span>, {formatPct(moved.dropPct)} less
                  and more than your {moved.limit}% limit. Nothing was sent.
                  {needsAck && <> The new price needs the cost confirmation above first.</>}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => start(moved)} disabled={!!busy || needsAck || tooSmall} className="bg-amber-600 text-white hover:bg-amber-700">
                  Buy at the new price
                </Button>
                <Button variant="outline" onClick={() => setMoved(null)} disabled={!!busy} className="border-slate-600 text-slate-200">Cancel</Button>
              </div>
            </div>
          )}

          {isConnected && address && (
            <div className="text-xs text-slate-400">iAERO goes to <span className="font-mono text-slate-300">{short(address)}</span> on Base.</div>
          )}

          {notifySupported && (
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" checked={notify} onChange={e => toggleNotify(e.target.checked)} className="h-4 w-4 accent-indigo-500" />
              <Bell className="h-4 w-4 text-slate-400" /> Browser notification when it arrives (while this page is open)
            </label>
          )}

          <Button
            onClick={() => (cta.connect ? openConnectModal?.() : start())} disabled={cta.disabled}
            className="h-auto min-h-10 w-full whitespace-normal bg-gradient-to-r from-indigo-600 to-purple-600 py-2.5 hover:from-indigo-700 hover:to-purple-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <span className="flex items-center justify-center gap-2"><Loader2 className="h-4 w-4 shrink-0 animate-spin" />{busy}</span> : cta.text}
          </Button>
          {isHyperCore && isConnected && token && (
            <div className="flex gap-2 text-xs text-slate-400">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              You sign one Hyperliquid transfer, not a transaction; your wallet switches to Arbitrum to sign it. Hyperliquid takes 1 USDC
              for sending to a new address, which the cost above includes.
            </div>
          )}
          {chain.kind === 'evm' && chainKey !== 'base' && isConnected && token && (
            <div className="flex gap-2 text-xs text-slate-400">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Your wallet switches to {chain.name} for the payment (one plain transfer, no approvals). Switch back to Base after.
            </div>
          )}
          {storageFailing() && (
            <div role="alert" className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-100">
              This browser isn’t saving your orders (its storage is full or blocked). Keep this page open, and note the order ID shown on the right.
            </div>
          )}
          {error && <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>}

          <div className="flex gap-2 border-t border-slate-700/40 pt-3 text-xs text-slate-400">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Routed by Rift. Your payment goes to a one-time deposit address run by Rift’s secure-hardware network, which
              executes the route and delivers iAERO to your wallet. If the route cannot complete, Rift refunds you.{' '}
              <a href={RIFT_SECURITY_URL} target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:text-indigo-300">How it works</a>
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Progress */}
      <div className="min-w-0 space-y-6">
        {activeOrder ? (
          <OrderTracker
            key={activeOrder.id} order={activeOrder} account={address} walletChainId={walletChainId}
            onPay={pay} paying={payingId === activeOrder.id} onReorder={reorder} onGoToStake={onGoToStake} showToast={showToast}
          />
        ) : (
          <Card className="border-slate-700/50 bg-slate-800/50 backdrop-blur-xl">
            <CardContent className="space-y-3 p-6 text-sm text-slate-400">
              <div className="font-medium text-white">How it works</div>
              <ol className="list-decimal space-y-1.5 pl-5">
                <li>Pick one of your tokens. You see the iAERO you’ll get, the route, and how long it takes, before you commit.</li>
                <li>Confirm one payment in your wallet (or send BTC from any wallet).</li>
                <li>Rift bridges and swaps automatically; this page shows each step live, even if you close it and come back.</li>
                <li>iAERO lands in your wallet on Base.</li>
              </ol>
            </CardContent>
          </Card>
        )}
        <RecentOrders
          orders={orders} activeId={activeId} onSelect={setActiveId}
          onClearFinished={() => {
            const done = orders.filter(o => isTerminalStatus(o.status) && !needsAttention(o.status)).map(o => o.id);
            removeOrders(done);
            if (activeId && done.includes(activeId)) setActiveId(null);
          }}
        />
      </div>
    </div>
  );
}
