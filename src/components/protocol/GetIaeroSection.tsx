// src/components/protocol/GetIaeroSection.tsx
//
// "Get iAERO": turn a token you hold into iAERO in one step, routed by Rift (rift.trade). The picker lists
// your own tokens on Ethereum, Arbitrum, Base and Hyperliquid (HyperCore spot) that Rift can route, highest
// USD value first; Bitcoin from another wallet is offered last. Before committing you see the iAERO you will
// get, what that costs against market prices, the route and how long it takes. One click re-checks the price
// against your tolerance, creates the order and asks the wallet for a single plain transfer (or, for
// HyperCore, one signed Hyperliquid transfer) to the order's one-time deposit address. Rift does the rest;
// OrderTracker shows every step, and every unfinished order is tracked in the background (OrderWatcher).
//
// Money safety: one purchase at a time and one payment per order (in-flight guards, re-checked after every
// wallet prompt); a quote is never reused for a second order; an attempt that may have sent money is checked
// before it can be repeated, and a HyperCore retry re-posts the same signed transfer; an order is paid only by
// the wallet it delivers to and only while its price is current (order-state.ts), with the price checked again
// when paying from the order card.

'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useAccount, useBalance, useGasPrice, usePublicClient, useReadContract, useSendTransaction, useSignTypedData, useSwitchChain,
  useWriteContract,
} from 'wagmi';
import { arbitrum, base, mainnet } from 'wagmi/chains';
import { useConnectModal } from '@rainbow-me/rainbowkit';
import { erc20Abi, formatUnits, isAddress, parseSignature, type Address, type PublicClient } from 'viem';
import { AlertTriangle, ArrowLeftRight, Bell, Bitcoin, Info, Loader2, RefreshCw, Route as RouteIcon, ShieldCheck, Timer } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useDebounce } from '@/components/lib/defi-utils';
import RouteSteps from '@/components/rift/RouteSteps';
import OrderTracker from '@/components/rift/OrderTracker';
import RecentOrders, { clearable } from '@/components/rift/RecentOrders';
import RiftErrorBoundary from '@/components/rift/RiftErrorBoundary';
import { CURATED_TOKENS, KNOWN_SYMBOLS, RIFT_DESTINATION, RIFT_SECURITY_URL, SOURCE_CHAINS } from '@/lib/rift/config';
import { classifyRiftError, createOrder, explainRiftError, fetchQuote, riftPricing, RiftApiError } from '@/lib/rift/client';
import { decimalToRaw, isContractCode, normalizeDecimal, parseOrder } from '@/lib/rift/validate';
import { estimateRoute, formatRange } from '@/lib/rift/timing';
import { isBtcAddress, normalizeBtcAddress } from '@/lib/rift/bitcoin';
import { rawToNumber, type Holding } from '@/lib/rift/holdings';
import { useRiftSupport } from '@/lib/rift/support';
import { checkQuote, riftNames } from '@/lib/rift/quote-check';
import { useMarketPrices, type MarketPrices } from '@/lib/rift/prices';
import { localeDecimalSep, parseAmountInput, toInputText } from '@/lib/rift/amount';
import {
  HL_API, HL_NEW_ADDRESS_FEE_USDC, HL_SIGNATURE_CHAIN_ID, HYPERCORE_TOKENS, hyperCoreToken, parseSpotBalances, spotSendToken,
  spotSendTypedData, usdcForFee,
} from '@/lib/rift/hypercore';
import {
  DEFAULT_TOLERANCE_PCT, ETHEREUM_GAS_FLOOR_WEI, TOLERANCE_CHOICES, assessCost, costNeedsTick, costText, formatPct, gasDeskChains,
  gasDeskUsd, priceDropPct, type CostCheck, type CostLevel,
} from '@/lib/rift/cost';
import { PAY_HEARTBEAT_MS, canPay, isOutOfDate, isTerminalStatus, needsAttention, sourceKindOf } from '@/lib/rift/order-state';
import {
  beginHyperPost, claimPayment, loadOrders, patchOrder, patchPaymentAttempt, paymentStorageProblem, removeOrders, storageFailing,
  unreadableOrderIds, upsertOrder, useStoredOrders,
} from '@/lib/rift/storage';
import { accountNonce, hyperDepositEvidence, postHyperTransfer, transferDeliversInFull } from '@/lib/rift/payment-io';
import { enableNotifications } from '@/lib/rift/watch';
import type { RiftQuote, SourceToken, StoredOrder } from '@/lib/rift/types';

type EvmChainId = 1 | 42161 | 8453;
const BTC_ASSET = 'bitcoin.btc';
const BTC_TOKEN = CURATED_TOKENS.find(t => t.asset === BTC_ASSET)!;
const TOLERANCE_KEY = 'iaero.rift.tolerance.v1';
/** A quote older than this is re-fetched when you click Buy, and compared with what you saw. */
const RECHECK_AFTER_MS = 20_000;
/** Paying an order whose quote is younger than this does not ask Rift for the price again (it allows a browser
 *  about 10 calls a minute); older, or paid from the order card, it does. */
const FRESH_QUOTE_MS = 30_000;
const HOLDINGS_TIMEOUT_MS = 45_000;
/** A wallet prompt open this long gets a reminder that Rift fills at the price when the payment arrives. */
const SLOW_PROMPT_MS = 3 * 60_000;
/** Ethereum's gas price older than this (its refreshes failing) is not used for the cost. */
const GAS_MAX_AGE_MS = 3 * 60_000;

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
/** Wallet errors raised before anything could be broadcast: the payment certainly did not go out. Not here:
 *  "nonce too low" (viem also uses it for "already known", the same transaction already broadcast) and wallet
 *  disconnects (4900, 4901), which can come after the wallet sent it; those are treated as unknown. */
const PRE_SEND = new Set([
  'ChainMismatchError', 'ChainNotConfiguredError', 'ConnectorNotConnectedError', 'ConnectorAccountNotFoundError', 'InsufficientFundsError',
  'EstimateGasExecutionError', 'ExecutionRevertedError', 'IntrinsicGasTooLowError', 'IntrinsicGasTooHighError', 'FeeCapTooLowError',
  'FeeCapTooHighError', 'NonceTooHighError', 'NonceMaxValueError', 'SwitchChainError', 'UnsupportedProviderMethodError',
  'UnauthorizedProviderError',
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
  if (/balances unavailable/.test(w)) return chain === 'hyperliquid' ? 'Hyperliquid balances unavailable' : `${name}: balances unavailable`;
  if (/some balances could not be checked/.test(w)) return `${name}: some balances could not be checked`;
  if (/token list unavailable/.test(w)) return `${name}: only major tokens checked`;
  if (/token list incomplete/.test(w)) return `${name}: some tokens may be missing`;
  if (/on-chain/.test(w)) return `${name}: balances may be out of date`;
  if (chain === 'prices') return 'some prices unavailable';
  return w;
}

/** The server's notes (a token list longer than its scan reads) as one quiet line: a limit, not a failure. */
function noteText(notes: string[]): string | null {
  const chains = [...new Set(notes.map(n => n.split(':')[0]).filter(Boolean))].map(c => c.charAt(0).toUpperCase() + c.slice(1));
  return chains.length ? `Long token lists are checked up to a limit, most valuable first (${chains.join(', ')}).` : null;
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
  const publicFor = (id: number): PublicClient | undefined =>
    (id === mainnet.id ? ethPublic : id === arbitrum.id ? arbPublic : id === base.id ? basePublic : undefined) as PublicClient | undefined;
  const allOrders = useStoredOrders();
  // Orders of the connected wallet only: another account's unpaid order must not be paid from this one.
  // (Every order in this browser is still tracked in the background, whichever account it is for.)
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
  const [settlementAckKey, setSettlementAckKey] = useState<string | null>(null);
  /** `<asset>|<amount>` whose quote went into an order: not re-quoted until the amount is entered again. */
  const [spent, setSpent] = useState<string | null>(null);
  const [decimalSep, setDecimalSep] = useState<'.' | ','>('.');
  /** Amount text this page wrote itself (MAX, a repeated order): it reads back as written, without a note. */
  const [autoText, setAutoText] = useState<string | null>(null);
  /** Why this browser can't pay orders here (no Web Locks, storage blocked), checked when the page opens. */
  const [payBlock, setPayBlock] = useState<string | null>(null);
  const startingRef = useRef(false);
  const payingRef = useRef(new Set<string>());
  const formRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setTolerance(loadTolerance()); setDecimalSep(localeDecimalSep()); setPayBlock(paymentStorageProblem()); }, []);
  const chooseTolerance = (v: number) => {
    setTolerance(v);
    try { localStorage.setItem(TOLERANCE_KEY, String(v)); } catch { /* private mode */ }
  };
  // Asked when the box is ticked (a click), never in the middle of a purchase.
  const toggleNotify = async (on: boolean) => {
    if (!on || !notifySupported) { setNotify(false); return; }
    try {
      const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      setNotify(p === 'granted');
      if (p === 'granted') void enableNotifications();
      if (p === 'denied') showToast('Notifications are blocked for this site in your browser settings.', 'info');
    } catch { setNotify(false); }
  };
  const typeAmount = (text: string) => { setAmountText(text); setAutoText(null); setSpent(null); };
  /** A plain decimal the page puts in the amount box, written in the user's locale. */
  const writeAmount = (decimal: string) => { const text = toInputText(decimal, decimalSep); typeAmount(text); setAutoText(text); };

  // --- Your tokens: balances on Ethereum, Arbitrum, Base and HyperCore, valued in USD, largest first ---
  const freshRef = useRef(false);
  const holdingsQuery = useQuery({
    queryKey: ['rift-holdings', address],
    enabled: !!address && active,
    queryFn: async ({ signal }): Promise<{ holdings: Holding[]; warnings: string[]; notes?: string[]; hyperliquidUsdc?: string }> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HOLDINGS_TIMEOUT_MS);
      signal.addEventListener('abort', () => controller.abort());
      // A Refresh asks for one fresh read, whether or not it succeeds; the next poll uses the cache again.
      const fresh = freshRef.current;
      freshRef.current = false;
      try {
        const res = await fetch(`/api/rift/holdings?address=${address}${fresh ? '&fresh=1' : ''}`, { signal: controller.signal });
        if (res.status === 429) throw new Error('Too many balance requests from this connection. Wait a minute, then refresh.');
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
  useEffect(() => { setSelected(null); setAmountText(''); setAck(null); setSettlementAckKey(null); setMoved(null); setError(null); setSpent(null); }, [address]);

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

  const amountState = useMemo((): { normalized?: string; raw?: bigint; error?: string; ambiguous?: boolean } => {
    if (!token) return {};
    const parsed = parseAmountInput(amountText, token.decimals, decimalSep);
    if (parsed.error) return { error: parsed.error };
    if (!parsed.value) return {};
    const raw = decimalToRaw(parsed.value, token.decimals);
    const ambiguous = parsed.ambiguous;
    if (balanceRaw !== undefined && raw > balanceRaw) {
      return { normalized: parsed.value, raw, ambiguous, error: hlFeeRaw ? 'Not enough USDC: 1 USDC stays for Hyperliquid’s transfer fee' : `Not enough ${token.symbol}` };
    }
    if (hlUsdcShort) return { normalized: parsed.value, raw, ambiguous, error: 'Hyperliquid charges 1 USDC per transfer: keep 1 USDC available' };
    return { normalized: parsed.value, raw, ambiguous };
  }, [amountText, token, balanceRaw, hlFeeRaw, hlUsdcShort, decimalSep]);

  const setMax = () => {
    if (!token || balanceRaw === undefined) return;
    let raw = balanceRaw;
    if (!token.address && chain.gasReserve) {
      const reserve = decimalToRaw(chain.gasReserve, token.decimals);
      raw = raw > reserve ? raw - reserve : 0n;
    }
    writeAmount(normalizeDecimal(formatUnits(raw, token.decimals)));
  };

  // Market prices (prices.ts): iAERO from its Aerodrome pool, the token from DeFiLlama, each checked for age when
  // used. The list's price shows the amount's value, but never feeds the cost check.
  const market = useMarketPrices(token?.asset, active);
  const displayPriceUsd = market.inputUsd ?? (holding && !holding.priceMissing ? holding.priceUsd : 0);
  const amountUsd = amountState.normalized && displayPriceUsd ? Number(amountState.normalized) * displayPriceUsd : 0;

  // --- Live quote: re-priced every 30 s while shown (paused while a price move waits for your answer, and while
  //     buying). A rate-limited quote is not retried at once: the next refresh asks again. ---
  const quoteAmount = useDebounce(amountState.error ? undefined : amountState.normalized, 600);
  const quoteKey = `${token?.asset}|${quoteAmount}`;
  const quoteQuery = useQuery({
    queryKey: ['rift-quote', token?.asset, quoteAmount],
    enabled: active && !!token && !!quoteAmount && !busy && spent !== quoteKey,
    queryFn: async ({ signal }) =>
      checkQuote(await fetchQuote({ from: token!.asset, from_amount: quoteAmount! }, signal), {
        destination: RIFT_DESTINATION, fromChain: chainKey, fromAmount: quoteAmount!, fromAsset: token!.asset,
      }, { rawAmount: decimalToRaw(quoteAmount!, token!.decimals), kind: 'user' }),
    refetchInterval: moved || !active ? false : 30_000,
    staleTime: 20_000,
    retry: (count, e) => classifyRiftError(e) === 'network' && count < 1,
    retryDelay: 3_000,
  });
  const quote = quoteQuery.data && quoteAmount && amountState.normalized === quoteAmount && spent !== quoteKey ? quoteQuery.data : undefined;
  const estimate = useMemo(() => (quote ? estimateRoute(chainKey, quote.route, KNOWN_SYMBOLS) : null), [quote, chainKey]);
  // "Could not be priced": an outage, or no route for this token. Rift pricing a control route says which.
  const quoteErrorKind = quoteQuery.error ? classifyRiftError(quoteQuery.error) : null;
  const [riftUp, setRiftUp] = useState<boolean | null>(null);
  useEffect(() => {
    setRiftUp(null);
    if (quoteErrorKind !== 'unavailable') return;
    let live = true;
    riftPricing('user').then(up => { if (live) setRiftUp(up); });
    return () => { live = false; };
  }, [quoteErrorKind, quoteQuery.errorUpdatedAt]);
  const quoteErrorText = !quoteQuery.error ? null
    : quoteErrorKind === 'unavailable' && riftUp === true ? 'Rift has no route for this token right now (other tokens are pricing normally). Try a different token.'
    : explainRiftError(quoteQuery.error);

  // Rift's gas desk charges each chain's gas once you have paid, and its quote leaves that out (cost.ts). The
  // page expects the quote minus that charge, valued in iAERO at the pool price; Ethereum's gas price is
  // fetched only when the route runs on Ethereum.
  const routeOnEthereum = !!quote && gasDeskChains(quote.route).includes(1);
  const gasQuery = useGasPrice({ chainId: mainnet.id, query: { enabled: active && routeOnEthereum, refetchInterval: 60_000 } });
  const gasAt = (now: number) => (gasQuery.data !== undefined && now - gasQuery.dataUpdatedAt <= GAS_MAX_AGE_MS ? gasQuery.data : undefined);
  const expectedFor = (q: RiftQuote, px: MarketPrices, gasWei: bigint | undefined) => {
    const chains = gasDeskChains(q.route);
    const usd = gasDeskUsd(chains, gasWei, px.ethUsd);
    if (usd === null || (usd > 0 && !px.iaeroUsd)) return null;
    return { out: Number(q.estimated_amount_out) - (usd > 0 ? usd / px.iaeroUsd! : 0), gasUsd: usd, chains };
  };

  // What the order costs against market prices; no price, or prices that disagree, also need the tick. An
  // order Rift's gas charge would swallow is refused, assuming at least a low gas price when it is unknown.
  const hlFeeUsd = isHyperCore ? HL_NEW_ADDRESS_FEE_USDC : 0;
  const costOf = (q: RiftQuote, px: MarketPrices, gasWei: bigint | undefined) => {
    const usdIn = px.inputUsd && px.inputUsd > 0 ? Number(q.from_amount) * px.inputUsd + hlFeeUsd : null;
    const e = expectedFor(q, px, gasWei);
    const usdOut = e && px.iaeroUsd ? e.out * px.iaeroUsd : null;
    const atLeast = gasWei === undefined ? expectedFor(q, px, ETHEREUM_GAS_FLOOR_WEI) : e;
    return { check: assessCost(usdIn, usdOut), usdIn, usdOut, tooSmall: (usdOut !== null && usdOut <= 0) || (!!atLeast && atLeast.out <= 0) };
  };
  const renderNow = Date.now();
  const gasNow = gasAt(renderNow);
  const expected = quote ? expectedFor(quote, market, gasNow) : null;
  const expectedOut = quote ? Math.max(0, expected?.out ?? Number(quote.estimated_amount_out)) : 0;
  const cost = quote ? costOf(quote, market, gasNow) : null;
  const ackKey = quoteKey;
  // A tick covers this token and amount, the same kind of check and (for a known cost) no more than half a
  // point worse; "prices disagree" is one state whatever the size of the gap.
  const ackCovers = (a: Ack | null, c: CostCheck) =>
    !!a && a.key === ackKey && a.kind === c.kind && (c.kind !== 'ok' || c.pct <= a.pct + 0.5);
  const needsAck = !!cost && costNeedsTick(cost.check) && !ackCovers(ack, cost.check);
  const tooSmall = !!cost?.tooSmall;

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
    // Resume this wallet's most recent unfinished order after a refresh: one in flight or still payable before
    // one past its pay window, then one that needs attention, then the latest.
    if (activeId && orders.some(o => o.id === activeId)) return;
    const now = Date.now();
    const pick = orders.find(o => !isTerminalStatus(o.status) && !isOutOfDate(o, now)) ?? orders.find(o => needsAttention(o.status)) ?? orders[0];
    setActiveId(pick ? pick.id : null);
  }, [orders, activeId]);
  const activeOrder = orders.find(o => o.id === activeId) ?? null;
  // Saved records this version can't show, read again whenever the saved orders change.
  const unreadable = useMemo(() => unreadableOrderIds(), [allOrders]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Pay an order, once: only the wallet it delivers to, only while its price is current, never while a
   *  previous attempt might still be on its way, and only if Rift's price for it has not dropped by more than the
   *  tolerance since it was made (`quoteAt`: when a just-created order's quote was fetched; a quote that recent
   *  is not asked again). */
  async function pay(o: StoredOrder, opts: { quoteAt?: number } = {}) {
    const kind = sourceKindOf(o.sourceChain);
    if (payingRef.current.has(o.id)) return;
    payingRef.current.add(o.id);
    setPayingId(o.id);
    setError(null);
    try {
      if (!payableNow(o.id)) return;
      const problem = await walletProblem(o.toAddress as Address, o.sourceChain);
      if (problem) { setError(problem); return; }
      if (kind === 'hypercore') await payHyperCore(o.id, opts.quoteAt);
      else await payEvm(o.id, opts.quoteAt);
    } catch (e) {
      const msg = errText(e);
      setError(msg);
      showToast(msg, 'error');
    } finally {
      payingRef.current.delete(o.id);
      setPayingId(null);
      setBusy(null);
    }
  }

  /** The order as stored now (another tab may have paid it), if this wallet may pay it now; else says why. */
  function payableNow(id: string): StoredOrder | null {
    const latest = loadOrders().find(x => x.id === id);
    if (!latest) return null;
    if (!addressRef.current || addressRef.current.toLowerCase() !== latest.toAddress.toLowerCase()) {
      setError(`This order delivers iAERO to ${short(latest.toAddress)}. Connect that wallet to pay it.`);
      return null;
    }
    if (!canPay(latest, sourceKindOf(latest.sourceChain), Date.now())) {
      setError('This order can’t be paid now: it is already paid, its payment is being checked, or its price is out of date.');
      return null;
    }
    return latest;
  }

  /** Rift fills at the price when the payment arrives, so its current price for this order must not be worse
   *  than when it was made by more than the tolerance. 'error': the price could not be checked right now. */
  async function priceCheck(o: StoredOrder, quoteAt?: number): Promise<'ok' | 'dropped' | 'error'> {
    if (quoteAt !== undefined && Date.now() - quoteAt < FRESH_QUOTE_MS) return 'ok';
    setBusy('Checking the latest price…');
    try {
      const q = await checkQuote(await fetchQuote({ from: o.token.asset, from_amount: o.fromAmount }), {
        destination: RIFT_DESTINATION, fromChain: o.sourceChain, fromAmount: o.fromAmount, fromAsset: o.token.asset,
      }, { rawAmount: BigInt(o.fromAmountRaw), kind: 'user' });
      const drop = priceDropPct(o.estimatedOut, q.estimated_amount_out);
      if (drop > tolerance) {
        setError(`Rift’s price for this order has dropped ${formatPct(drop)} since you made it, more than your ${tolerance}% limit. Nothing was sent. Start a new order at today’s price.`);
        return 'dropped';
      }
      return 'ok';
    } catch (e) {
      setError(`Couldn’t re-check the price (${e instanceof RiftApiError ? explainRiftError(e) : errText(e)}). Nothing was sent; try again in a moment.`);
      return 'error';
    }
  }

  /** What happened when the wallet call failed: cancelled, failed before anything went out, or unknown. */
  async function recordPayFailure(id: string, attemptId: string, e: unknown, where: string) {
    if (isUserRejection(e)) {
      await patchPaymentAttempt(id, attemptId, { payRequestedAt: undefined, depositFailed: true, depositFailReason: 'cancelled' });
      const msg = 'Payment cancelled in your wallet. You can pay from the order card while its price is current.';
      setError(msg); showToast(msg, 'info');
    } else if (isPreSend(e)) {
      await patchPaymentAttempt(id, attemptId, { payRequestedAt: undefined, depositFailed: true, depositFailReason: 'pre_send' });
      const msg = `Payment failed before anything was sent: ${errText(e)}`;
      setError(msg); showToast(msg, 'error');
    } else {
      await patchPaymentAttempt(id, attemptId, { payRequestedAt: undefined, payUnknown: true });
      const kind = loadOrders().find(o => o.id === id)?.sourceChain;
      const msg = kind === 'hyperliquid'
        ? `We couldn’t confirm whether your payment ${where}. Check your wallet; the order card can safely retry the same signed transfer.`
        : `We couldn’t confirm whether your payment ${where}. Don’t send another payment until its outcome is clear. Check your wallet and the order card.`;
      setError(msg); showToast(msg, 'warning');
    }
  }

  /** While the wallet is open: keep this tab's "payment requested" marker fresh (another tab would otherwise
   *  take it for a lost prompt after 2 minutes), and remind about the price if the prompt stays open long. */
  function whileWalletOpen(id: string, attemptId: string, waiting: string) {
    setBusy(waiting);
    const beat = setInterval(() => void patchPaymentAttempt(id, attemptId, prev => (prev.payRequestedAt ? { payRequestedAt: Date.now() } : {})), PAY_HEARTBEAT_MS);
    const slow = setTimeout(() => setBusy('Still waiting for your wallet. Rift fills at the price when your payment arrives: if it may have moved, reject the request and buy again.'), SLOW_PROMPT_MS);
    return () => { clearInterval(beat); clearTimeout(slow); };
  }

  async function payEvm(id: string, quoteAt?: number) {
    let o = payableNow(id);
    if (!o) return;
    const c = SOURCE_CHAINS[o.sourceChain];
    if (c.kind !== 'evm' || !c.chainId) return;
    if (walletChainRef.current !== c.chainId) {
      setBusy(`Switch your wallet to ${c.name}…`);
      try { await switchChainAsync({ chainId: c.chainId as EvmChainId }); } catch (e) {
        const msg = isUserRejection(e) ? `Switching to ${c.name} was cancelled. Nothing was sent.` : `Couldn’t switch your wallet to ${c.name}: ${errText(e)}`;
        setError(msg); showToast(msg, 'info');
        return;
      }
      // The switch prompt can stay open: check again (account, another tab) before asking to pay.
      o = payableNow(id);
      if (!o) return;
    }
    const client = publicFor(c.chainId);
    if (!client) throw new Error(`Could not reach ${c.name} to check your account. Nothing was sent; try again in a moment.`);
    if (o.token.address) {
      const delivers = await transferDeliversInFull(client, o.token.address as Address, o.toAddress as Address, BigInt(o.fromAmountRaw), o.depositAddress as Address);
      if (delivers !== true) throw new Error(delivers === false
        ? `${o.token.symbol} would arrive short at Rift’s deposit address. Nothing was sent; use another token.`
        : delivers === 'reverts'
          ? `A transfer of ${fmt(o.fromAmount, 8)} ${o.token.symbol} would fail right now (your balance may have changed, or the token is blocking the transfer). Nothing was sent.`
          : `Could not check that ${o.token.symbol} arrives in full (${c.name} didn’t answer). Nothing was sent; try again in a moment.`);
    }
    if (await priceCheck(o, quoteAt) !== 'ok') return;
    let payNonce: number;
    try { payNonce = await accountNonce(client, o.toAddress, 'pending'); } catch {
      throw new Error(`Could not check pending payments on ${c.name}. Nothing was sent; try again in a moment.`);
    }
    if (!Number.isSafeInteger(payNonce) || payNonce < 0) throw new Error(`Could not check pending payments on ${c.name}. Nothing was sent.`);
    if (!payableNow(id)) return;
    const claimed = await claimPayment(id, addressRef.current!, { payNonce });
    if (!claimed) { payableNow(id); return; }
    o = claimed;
    const stopWaiting = whileWalletOpen(id, claimed.payAttemptId!, 'Confirm the payment in your wallet…');
    try {
      const value = BigInt(o.fromAmountRaw);
      const to = o.depositAddress as Address;
      const hash = o.token.address
        ? await writeContractAsync({ address: o.token.address as Address, abi: erc20Abi, functionName: 'transfer', args: [to, value], chainId: c.chainId as EvmChainId, account: o.toAddress as Address })
        : await sendTransactionAsync({ to, value, chainId: c.chainId as EvmChainId, account: o.toAddress as Address });
      stopWaiting();
      const sent: Partial<StoredOrder> = {
        depositTxHash: hash, depositSentAt: Date.now(), payRequestedAt: undefined, payUnknown: false,
        depositConfirmedAt: undefined, depositFailed: false, depositFailReason: undefined,
      };
      let saved = await patchPaymentAttempt(id, claimed.payAttemptId!, sent);
      // Removed from this browser while the wallet was open (dismissed in another tab): put it back, with this payment.
      if (saved === 'missing') saved = await upsertOrder({ ...claimed, ...sent });
      if (saved === 'saved' || saved === 'unchanged') showToast('Payment sent. Tracking your order…', 'success');
      else {
        setError(`Your wallet sent the payment (transaction ${hash}), but this browser could not record it for order ${id}. Keep this page open, check the transaction in your wallet, and don’t pay again.`);
        showToast('Payment sent, but tracking could not be saved.', 'warning');
      }
    } catch (e) {
      stopWaiting();
      await recordPayFailure(id, claimed.payAttemptId!, e, 'was sent');
    }
  }

  /** HyperCore: one signed spot transfer to the deposit address (signed on Arbitrum, the chain the signature's
   *  domain names), posted to Hyperliquid. Accepted means final; there is no transaction hash. The signed
   *  transfer is saved before it is posted: a retry re-posts that same transfer, which Hyperliquid accepts at
   *  most once, and the payer's ledger settles any doubt. */
  async function payHyperCore(id: string, quoteAt?: number) {
    let o = payableNow(id);
    if (!o) return;
    const t = hyperCoreToken(o.token.asset);
    if (!t) return;
    /** The transfer went through: recorded for this tab's attempt, or (one found in the ledger) for whichever
     *  attempt holds it. An order removed from this browser meanwhile is put back, with its payment. */
    const sentNow = async (at: number, attemptId?: string) => {
      const sent = { depositSentAt: at, depositConfirmedAt: Date.now(), payRequestedAt: undefined, payUnknown: false };
      let r = attemptId
        ? await patchPaymentAttempt(id, attemptId, sent)
        : await patchOrder(id, prev => (prev.hlAction?.time === at ? sent : {}));
      if (r === 'missing' && o) r = await upsertOrder({ ...o, ...sent });
      if (r === 'failed') setError(`Your Hyperliquid transfer went through, but this browser could not record it for order ${id}. Keep this page open and don’t pay again.`);
    };
    const ledger = async () => (await hyperDepositEvidence(o!, t.symbol)).evidence;
    /** The order's saved signed transfer, if it is for exactly this order. */
    const savedAction = (x: StoredOrder) => {
      const a = x.hlAction;
      return a && a.destination.toLowerCase() === x.depositAddress.toLowerCase() && a.amount === x.fromAmount && a.token === spotSendToken(t) ? a : undefined;
    };
    /** For a claim: the stored signed transfer must still be the one this tab saw (another tab may have signed, or
     *  posted, one since; it must never be replaced by a second signature). */
    const holds = (seen: StoredOrder['hlAction']) => (x: StoredOrder) => x.hlAction?.time === seen?.time && x.hlAction?.r === seen?.r;
    const changedElsewhere = () => {
      if (payableNow(id)) setError('This order’s payment changed in another tab. Check the order card before paying again.');
    };

    let action = savedAction(o);
    if (action) {
      try {
        if (await ledger() !== 'none') { await sentNow(action.time); showToast('Your Hyperliquid transfer had gone through. Tracking your order…', 'success'); return; }
      } catch { /* the same signed transfer can be retried after the price check */ }
    }
    if (!action) {
      if (walletChainRef.current !== HL_SIGNATURE_CHAIN_ID) {
        setBusy('Switch your wallet to Arbitrum to sign…');
        try { await switchChainAsync({ chainId: arbitrum.id }); } catch (e) {
          const msg = isUserRejection(e) ? 'Switching to Arbitrum was cancelled. Nothing was sent.' : `Couldn’t switch your wallet to Arbitrum: ${errText(e)}`;
          setError(msg); showToast(msg, 'info');
          return;
        }
        o = payableNow(id);
        if (!o) return;
        // Another tab may have signed a transfer for this order while the switch prompt was open.
        if (savedAction(o)) { changedElsewhere(); return; }
      }
      if (await priceCheck(o, quoteAt) !== 'ok') return;
      const claimed = await claimPayment(id, addressRef.current!, { hlAction: undefined, hlPostedAt: undefined }, holds(o.hlAction));
      if (!claimed) { changedElsewhere(); return; }
      o = claimed;
      const attemptId = claimed.payAttemptId!;
      const transfer = { destination: o.depositAddress, token: spotSendToken(t), amount: o.fromAmount, time: Date.now() };
      const stopWaiting = whileWalletOpen(id, attemptId, 'Sign the Hyperliquid transfer in your wallet…');
      try {
        const sig = parseSignature(await signTypedDataAsync({ ...spotSendTypedData(transfer), account: o.toAddress as Address }));
        action = { ...transfer, r: sig.r, s: sig.s, v: Number(sig.v ?? BigInt(27 + (sig.yParity ?? 0))) };
      } catch (e) {
        // Nothing can have moved without a signature.
        await patchPaymentAttempt(id, attemptId, { payRequestedAt: undefined });
        const msg = isUserRejection(e) ? 'Signing cancelled in your wallet. Nothing was sent.' : `Signing failed, so nothing was sent: ${errText(e)}`;
        setError(msg); showToast(msg, isUserRejection(e) ? 'info' : 'error');
        return;
      } finally {
        stopWaiting();
      }
      if (addressRef.current?.toLowerCase() !== o.toAddress.toLowerCase()) {
        await patchPaymentAttempt(id, attemptId, { payRequestedAt: undefined });
        throw new Error('Your wallet account changed while signing. Nothing was sent; reconnect the order’s receiving wallet and try again.');
      }
      // A signature is posted only once it is saved as the order's current attempt: one that another tab has
      // taken over, or that could not be saved, could become a second transfer.
      const saved = await patchPaymentAttempt(id, attemptId, { hlAction: action, payRequestedAt: Date.now() });
      if (saved !== 'saved') {
        if (saved === 'failed') await patchPaymentAttempt(id, attemptId, { payRequestedAt: undefined });
        throw new Error(saved === 'superseded' ? 'This payment was taken over in another tab. The signature from this tab was not sent.'
          : saved === 'missing' ? 'This order was removed from this browser. Nothing was sent.'
          : 'Could not save the signed transfer. Nothing was sent; enable browser storage and try again.');
      }
      // A signature can sit in an open wallet for minutes: check the price again before posting it. If it can't
      // be checked now, the signed transfer is kept, and the next try posts it without signing again.
      const price = await priceCheck(o, quoteAt);
      if (price !== 'ok') {
        await patchPaymentAttempt(id, attemptId, price === 'dropped' ? { hlAction: undefined, payRequestedAt: undefined } : { payRequestedAt: undefined });
        return;
      }
    } else {
      if (await priceCheck(o, quoteAt) !== 'ok') return;
      const claimed = await claimPayment(id, addressRef.current!, { hlAction: action }, holds(action));
      if (!claimed) { changedElsewhere(); return; }
      o = claimed;
      // A transfer signed earlier, whose outcome was not known: if the ledger shows it, it went through.
      try {
        if (await ledger() !== 'none') { await sentNow(action.time, claimed.payAttemptId); showToast('Your Hyperliquid transfer had gone through. Tracking your order…', 'success'); return; }
      } catch { /* re-posting is safe either way */ }
    }

    // Only the order's current attempt, holding exactly this signed transfer, may post it. Whether it was posted
    // before is read under the same lock: Hyperliquid accepts a signed transfer once, so refusing it again does not
    // show that nothing moved.
    const begun = await beginHyperPost(id, o.payAttemptId!, action);
    if (!begun) {
      throw new Error('This payment changed in another tab (or could not be saved) before it was sent. This tab sent nothing; check the order card.');
    }
    setBusy('Sending on Hyperliquid…');
    const outcome = await postHyperTransfer(action);
    if (outcome.kind === 'ok') {
      await sentNow(action.time, o.payAttemptId);
      showToast('Transfer sent on Hyperliquid. Tracking your order…', 'success');
      return;
    }
    // Refused, or no clear answer: Hyperliquid's ledger says whether this transfer (or an earlier post of it) went through.
    let found: 'arrived' | 'partial' | 'none' | null = null;
    try {
      await new Promise(res => setTimeout(res, 2000));
      found = await ledger();
    } catch { found = null; }
    if (found === 'arrived' || found === 'partial') {
      await sentNow(action.time, o.payAttemptId);
      showToast('Transfer sent on Hyperliquid. Tracking your order…', 'success');
    } else if (outcome.kind === 'refused' && found === 'none' && !begun.postedBefore) {
      // Hyperliquid refused its first post and nothing moved: the next attempt signs a new transfer.
      await patchPaymentAttempt(id, o.payAttemptId!, { payRequestedAt: undefined, hlAction: undefined, hlPostedAt: undefined });
      const msg = `Hyperliquid refused the transfer: ${outcome.error}`;
      setError(msg); showToast(msg, 'error');
    } else {
      // No clear answer, or a transfer posted before refused again (its first post may have gone through, and the
      // ledger can lag): unknown, and the same signed transfer is kept.
      await recordPayFailure(id, o.payAttemptId!, new Error('no clear answer from Hyperliquid'), 'reached Hyperliquid');
    }
  }

  /** Wallets that can't pay or receive here. A smart-contract wallet that exists on the paying chain but not
   *  on Base could not use the iAERO delivered there. And a smart-contract wallet can't pay at all: Safe-style
   *  wallets queue the payment for other signers (it would go out later, at that time's price, under a hash this
   *  page can't follow), and Hyperliquid accepts signatures only from regular wallets. */
  async function walletProblem(owner: Address, sourceChain: StoredOrder['sourceChain']): Promise<string | null> {
    const source = SOURCE_CHAINS[sourceChain];
    if (source.kind === 'bitcoin') {
      // Bitcoin is paid from another wallet; this one only receives, on Base. A smart-contract wallet that exists
      // on Ethereum or Arbitrum but not on Base could not use the iAERO delivered there.
      if (!basePublic) throw new Error('Could not reach the network to check your wallet. Nothing was sent; try again in a moment.');
      // Ethereum or Arbitrum not answering skips that chain's check rather than blocking the order.
      const [onBase, onEth, onArb] = await Promise.all([
        basePublic.getCode({ address: owner }),
        ethPublic?.getCode({ address: owner }).catch(() => undefined), arbPublic?.getCode({ address: owner }).catch(() => undefined),
      ]);
      if (isContractCode(onBase)) return null;
      const elsewhere = isContractCode(onEth) ? mainnet.id : isContractCode(onArb) ? arbitrum.id : null;
      return elsewhere ? `Your wallet is a smart-contract wallet on ${CHAIN_NAMES[elsewhere]} but not on Base, so it could not receive iAERO there.` : null;
    }
    const payChain = source.kind === 'evm' ? source.chainId : arbitrum.id;
    const client = payChain ? publicFor(payChain) : undefined;
    if (!client || !basePublic) throw new Error('Could not reach the network to check your wallet. Nothing was sent; try again in a moment.');
    const [code, onBase] = await Promise.all([client.getCode({ address: owner }), payChain === base.id ? undefined : basePublic.getCode({ address: owner })]);
    if (!isContractCode(code)) return null;
    if (payChain !== base.id && !isContractCode(onBase)) {
      return `Your wallet is a smart-contract wallet on ${CHAIN_NAMES[payChain!]} but not on Base, so it could not receive iAERO there.`;
    }
    return 'Payments from smart-contract wallets (Safe, smart accounts) aren’t supported here: they can go out later, at a different price, in a way this page can’t follow. Use a regular wallet, or swap on Aerodrome.';
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
      if (settlementAckKey !== quoteKey) throw new Error('Confirm that Rift cannot guarantee a minimum amount of iAERO before creating this order.');
      // Paying needs Web Locks and working storage: checked before an order exists, not after.
      const storageProblem = chain.kind === 'bitcoin' ? null : paymentStorageProblem();
      if (storageProblem) throw new Error(`${storageProblem} Nothing was sent.`);
      const refund = chain.kind === 'bitcoin' ? normalizeBtcAddress(btcRefund) : owner;
      if (chain.kind === 'bitcoin' && !isBtcAddress(refund)) {
        throw new Error('Enter a valid Bitcoin refund address you control (not an exchange deposit address).');
      }
      setBusy('Checking your wallet…');
      let problem: string | null;
      try { problem = await walletProblem(owner, chainKey); } catch {
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

      // A token that delivers less than is sent (a fee or rebasing on transfer) would leave the order underfunded:
      // the transfer is simulated first (nothing is signed or sent).
      if (chain.kind === 'evm' && token.address) {
        setBusy('Checking the token…');
        if (!sourcePublic) throw new Error(`Could not reach ${chain.name} to check this token. Nothing was sent; try again in a moment.`);
        const delivers = await transferDeliversInFull(sourcePublic as PublicClient, token.address as Address, owner, amountState.raw);
        if (delivers !== true) {
          throw new Error(delivers === false
            ? `${token.symbol} arrives short of the amount sent (it takes a fee or rebases on transfer), so Rift would receive less than the order needs. Nothing was sent; this token can’t be used here.`
            : delivers === 'reverts'
              ? `A transfer of this amount of ${token.symbol} would fail right now (your balance may have changed, or the token is blocking the transfer). Nothing was sent.`
              : `Could not check that ${token.symbol} arrives in full (${chain.name} didn’t answer). Nothing was sent; try again in a moment.`);
        }
      }

      // HyperCore: the spendable balance and the 1 USDC fee, live (the list can be a minute old).
      if (chain.kind === 'hypercore') {
        setBusy('Checking your Hyperliquid balance…');
        let state: unknown;
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10_000);
          try {
            const res = await fetch(`${HL_API}/info`, {
              method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
              body: JSON.stringify({ type: 'spotClearinghouseState', user: owner }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            state = await res.json();
          } finally {
            clearTimeout(timer);
          }
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
      // The cost tick, against the price actually used and market prices as they are now (it can cross into
      // "high" with this refresh, or become unknown if a price source has gone quiet).
      const px = market.at(Date.now());
      const gasWei = gasAt(Date.now());
      const freshExpected = expectedFor(q, px, gasWei);
      const freshCost = costOf(q, px, gasWei);
      if (freshCost.tooSmall) throw new Error('This amount is too small: Rift’s gas charge is more than the order is worth.');
      if (costNeedsTick(freshCost.check) && !ackCovers(ack, freshCost.check)) {
        throw new Error('The cost changed with the latest prices. Nothing was sent: tick the confirmation above to continue.');
      }
      stillSameAccount();

      setBusy('Creating your order…');
      const fromAmount = normalizeDecimal(q.from_amount);
      const raw = decimalToRaw(fromAmount, token.decimals);
      const order = parseOrder(await createOrder({ quote_id: q.id, to_address: owner, refund_address: refund }), {
        destination: RIFT_DESTINATION, quoteId: q.id, toAddress: owner, fromChain: chainKey, fromAmount, refundAddress: refund, fresh: true,
        source: { fromAsset: token.asset, names: riftNames() },
      });
      // This quote is spent: it is not shown or re-fetched until an amount is entered again.
      setSpent(quoteKey);
      shown.current = null;
      queryClient.removeQueries({ queryKey: ['rift-quote'] });
      // Never ask the wallet to send anything the order does not say, or to an address of the wrong kind.
      if (decimalToRaw(order.from_amount, token.decimals) !== raw) throw new Error('The order amount does not match your request. Nothing was sent.');
      if (chain.kind === 'bitcoin' ? !isBtcAddress(order.deposit_address) : !isAddress(order.deposit_address)) {
        throw new Error('Rift returned a deposit address of the wrong kind; nothing was sent.');
      }
      let baseFromBlock: string | undefined;
      try { baseFromBlock = basePublic ? String(await basePublic.getBlockNumber()) : undefined; } catch { /* optional */ }
      const created = Date.now();
      const stored: StoredOrder = {
        id: order.id, quoteId: q.id, createdAt: created, sourceChain: chainKey,
        token: { symbol: token.symbol, decimals: token.decimals, address: token.address, asset: token.asset },
        fromAmount, fromAmountRaw: raw.toString(), estimatedOut: q.estimated_amount_out, route: q.route,
        depositAddress: order.deposit_address, depositDeadline: order.deposit_deadline, toAddress: owner,
        refundAddress: refund, status: order.status, statusTimes: { [order.status]: created }, lastPolledAt: created, baseFromBlock, notify,
        marketUsdIn: px.inputUsd ? Number(fromAmount) * px.inputUsd + hlFeeUsd : undefined, marketIaeroUsd: px.iaeroUsd,
        expectedOut: freshExpected ? Math.max(0, freshExpected.out).toFixed(6) : undefined, gasDeskUsd: freshExpected?.gasUsd,
      };
      // The order must survive a reload before showing Bitcoin's deposit address or opening an EVM wallet.
      if (await upsertOrder(stored, { keepOnFailure: false }) !== 'saved') {
        throw new Error(`Rift created order ${order.id}, but this browser could not save it. Do not pay this order; allow site storage and try again with a new order.`);
      }
      setActiveId(order.id);
      setAmountText('');
      setAck(null);
      setSettlementAckKey(null);
      if (chain.kind !== 'bitcoin') {
        stillSameAccount();
        await pay(stored, { quoteAt: fetchedAt });
      } else {
        showToast('Order created. Send the exact BTC amount shown to complete it.', 'info');
      }
    } catch (e) {
      const kind = e instanceof RiftApiError ? classifyRiftError(e) : null;
      // A used or expired quote: drop it and fetch a fresh one for the next click.
      if (kind === 'quote_used' || kind === 'quote_expired') {
        queryClient.removeQueries({ queryKey: ['rift-quote', token.asset, quoteAmount] });
        void quoteQuery.refetch();
      }
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
    writeAmount(o.fromAmount);
    setError(null);
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  /** An out-of-date order that was never paid (or is past saving), removed from this browser. Never one whose
   *  payment may still be on its way: its order ID is how it is tracked. */
  const dismiss = (o: StoredOrder) => {
    const latest = loadOrders().find(x => x.id === o.id) ?? o;
    if (clearable(latest, Date.now())) remove(o);
  };
  /** Removed from this browser whatever its state: a damaged record this page can't show. */
  const remove = (o: StoredOrder) => {
    void removeOrders([o.id]);
    if (activeId === o.id) setActiveId(null);
  };

  // The price-moved panel shows the same after-gas figures as the quote panel.
  const movedDeduction = moved ? Number(moved.quote.estimated_amount_out) - (expectedFor(moved.quote, market, gasNow)?.out ?? Number(moved.quote.estimated_amount_out)) : 0;

  const cta = ((): { text: string; disabled: boolean; connect?: boolean } => {
    if (!isConnected) return { text: 'Connect a wallet to get iAERO', disabled: !openConnectModal, connect: true };
    if (!token) return { text: 'Choose a token to pay with', disabled: true };
    if (amountState.error) return { text: amountState.error, disabled: true };
    if (!amountState.normalized) return { text: 'Enter an amount', disabled: true };
    if (busy) return { text: busy, disabled: true };
    if (quoteQuery.isFetching && !quote) return { text: 'Finding the best route…', disabled: true };
    if (!quote) {
      return {
        text: quoteErrorKind === 'unavailable' && riftUp === true ? 'No route available'
          : quoteErrorKind === 'unavailable' || quoteErrorKind === 'network' || quoteErrorKind === 'rate_limited' ? 'Rift is unavailable right now'
          : quoteQuery.error ? 'No route available' : 'Waiting for a quote',
        disabled: true,
      };
    }
    if (chain.kind === 'bitcoin' && !isBtcAddress(btcRefund)) return { text: 'Enter a valid BTC refund address', disabled: true };
    if (chain.kind !== 'bitcoin' && (payBlock || storageFailing())) return { text: 'This browser can’t make payments here', disabled: true };
    if (tooSmall) return { text: 'Amount too small for Rift’s gas charge', disabled: true };
    if (moved) return { text: 'The price moved: review it above', disabled: true };
    if (needsAck) return { text: 'Confirm the cost above to continue', disabled: true };
    if (settlementAckKey !== quoteKey) return { text: 'Confirm the final amount risk above', disabled: true };
    return { text: chain.kind === 'bitcoin' ? 'Create Bitcoin payment' : `Buy iAERO with ${token.symbol}`, disabled: false };
  })();

  const choose = (asset: string) => {
    if (asset === selected || busy) return;
    setSelected(asset);
    if (asset !== BTC_ASSET) lastHolding.current = usable.find(h => h.asset === asset) ?? null;
    typeAmount('');
    setError(null);
  };

  const warnings = [...new Set((holdingsQuery.data?.warnings ?? []).map(warningText))];
  const holdingsNote = noteText(holdingsQuery.data?.notes ?? []);

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
                    aria-label={`${h.symbol} on ${SOURCE_CHAINS[h.chain].name}, ${fmt(rawToNumber(h.balanceRaw, h.decimals), 6)} ${h.symbol}${h.priceMissing ? ', price unavailable' : `, ${fmtUsd(h.valueUsd)}`}`}
                    className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors ${selected === h.asset ? 'bg-indigo-500/15' : 'hover:bg-slate-800/60'}`}
                  >
                    <TokenIcon src={h.icon} symbol={h.symbol} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="min-w-[3rem] max-w-[55%] shrink-0 truncate font-medium text-white">{h.symbol}</span>
                        <span className={`min-w-0 max-w-[45%] truncate text-right text-sm font-medium ${h.priceMissing ? 'text-slate-400' : 'text-white'}`}>{h.priceMissing ? 'price unavailable' : fmtUsd(h.valueUsd)}</span>
                      </div>
                      <div className="flex min-w-0 items-center gap-2 text-xs text-slate-400">
                        <span className="shrink-0 rounded bg-slate-700/60 px-1.5 py-0.5 text-[10px] text-slate-300">{SOURCE_CHAINS[h.chain].name}</span>
                        <span className="truncate">{fmt(rawToNumber(h.balanceRaw, h.decimals), 6)} {h.symbol}</span>
                      </div>
                    </div>
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
            {holdingsNote && <div className="text-xs text-slate-500">{holdingsNote}</div>}
            {isConnected && !holdingsQuery.isLoading && (
              <div className="flex items-center justify-between gap-2 text-xs text-slate-400">
                <span>
                  {checking > 0 ? `Checking routes for ${checking} more token${checking === 1 ? '' : 's'}…` : 'Highest value first. Tokens under $1, small Ethereum balances and tokens without a route are hidden.'}
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
                  onChange={e => typeAmount(e.target.value)} aria-invalid={!!amountState.error} aria-describedby="rift-amount-note"
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
              {amountState.ambiguous && amountState.normalized && amountText !== autoText && (
                <div className="text-xs text-amber-300/90">
                  Read as <span className="font-medium text-white">{fmt(amountState.normalized, token.decimals)} {token.symbol}</span>. If you meant something else, type it with a {decimalSep === '.' ? 'dot' : 'comma'} as the decimal point.
                </div>
              )}
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
          {(quote || quoteQuery.isFetching || quoteQuery.error) && amountState.normalized && !amountState.error && spent !== quoteKey && (
            <div className="space-y-4 rounded-xl border border-slate-700/30 bg-slate-900/50 p-4" aria-busy={quoteQuery.isFetching}>
              {!quote && quoteQuery.isFetching && (
                <div role="status" className="flex items-center gap-2 text-sm text-slate-300"><Loader2 className="h-4 w-4 animate-spin" /> Finding the best route across 20+ venues (a few seconds)…</div>
              )}
              {!quote && quoteErrorText && !quoteQuery.isFetching && (
                <div role="alert" className="text-sm text-red-300">{quoteErrorText}</div>
              )}
              {quote && estimate && cost && (
                <>
                  <div className="flex items-end justify-between gap-3">
                    <div className="min-w-0" aria-live="polite" aria-atomic="true">
                      <div className="text-xs text-slate-400">You receive (estimated)</div>
                      <div className="break-words text-2xl font-semibold text-white">{fmt(expectedOut)} iAERO</div>
                      {(market.iaeroUsd ?? 0) > 0 && <div className="text-xs text-slate-400">≈ {fmtUsd(expectedOut * market.iaeroUsd!)}</div>}
                    </div>
                    {quoteQuery.isFetching && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-slate-400" aria-label="Refreshing the price" />}
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
                        <div className="flex items-center justify-between gap-2" aria-live="polite" aria-atomic="true">
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
                          <div className="text-xs">
                            {tooSmall ? <>Rift’s gas charge would be more than this order is worth. Try a larger amount, or pay from Base or Arbitrum.</>
                              : <>There’s no current market price to compare this quote with, so its cost can’t be checked.</>}
                          </div>
                        )}
                        {c.kind === 'disagree' && (
                          <div className="text-xs">Rift’s quote is {formatPct(c.pct)} better than the market prices this page sees, so one of them is probably out of date.</div>
                        )}
                        {costNeedsTick(c) && !tooSmall && (
                          <label className="flex cursor-pointer items-start gap-2 pt-1 text-xs">
                            <input
                              type="checkbox" checked={ackCovers(ack, c)} disabled={!!busy} className="mt-0.5 h-4 w-4 shrink-0 accent-red-500"
                              onChange={e => setAck(e.target.checked ? { key: ackKey, kind: c.kind, pct: c.kind === 'ok' ? c.pct : NaN } : null)}
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
                      The price refreshes every 30 seconds and is checked again when you click (and when you pay from an order card). If Rift’s
                      price has dropped by more than {tolerance}%, nothing is sent and you are asked first. This is not a slippage limit: Rift has
                      no way to cap the final amount, and fills at the market price when your payment arrives
                      {chain.kind === 'bitcoin' ? ' (usually within the hour, after your BTC confirms)' : ''}.
                    </div>
                    <label className="flex cursor-pointer items-start gap-2 pt-1 text-xs text-amber-100">
                      <input type="checkbox" checked={settlementAckKey === quoteKey} disabled={!!busy} className="mt-0.5 h-4 w-4 shrink-0 accent-amber-500"
                        onChange={e => setSettlementAckKey(e.target.checked ? quoteKey : null)} />
                      <span>I understand the final iAERO amount can be lower than this estimate. Rift does not guarantee a minimum after my payment is sent.</span>
                    </label>
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
                <Button onClick={() => start(moved)} disabled={!!busy || needsAck || tooSmall || settlementAckKey !== quoteKey} className="bg-amber-600 text-white hover:bg-amber-700">
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
          {storageFailing() ? (
            <div role="alert" className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-100">
              This browser isn’t saving your orders (its storage is full or blocked), so paying from this page is paused. Note the order ID
              shown on the right, and refresh once storage works again.
            </div>
          ) : payBlock && chain.kind !== 'bitcoin' && isConnected && (
            <div role="status" className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-100">{payBlock}</div>
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
          <RiftErrorBoundary
            key={activeOrder.id}
            fallback={() => (
              <div role="alert" className="space-y-3 rounded-xl border border-red-500/20 bg-red-500/10 p-6 text-sm text-red-200">
                <div className="font-medium text-white">This order can’t be shown</div>
                <div>
                  Its saved record is damaged. Your funds are not affected and Rift completes the order regardless. Order{' '}
                  <span className="break-all font-mono text-red-100">{activeOrder.id}</span>: keep this ID if you need Rift’s support.
                </div>
                <button type="button" onClick={() => remove(activeOrder)} className="rounded-lg border border-red-400/40 px-3 py-1.5 text-red-100 hover:border-red-300">
                  Remove it from this browser
                </button>
              </div>
            )}
          >
            <OrderTracker
              key={activeOrder.id}
              order={activeOrder} account={address} walletChainId={walletChainId}
              onPay={o => { void pay(o); }} paying={payingId === activeOrder.id} onReorder={reorder} onDismiss={dismiss} onGoToStake={onGoToStake} showToast={showToast}
            />
          </RiftErrorBoundary>
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
        {unreadable.length > 0 && (
          <div className="rounded-lg border border-slate-600/40 bg-slate-900/40 p-3 text-xs text-slate-300">
            {unreadable.length === 1 ? 'One saved order' : `${unreadable.length} saved orders`} can’t be shown by this version of the page (perhaps
            saved by a newer one). Rift completes {unreadable.length === 1 ? 'it' : 'them'} regardless; keep the ID if you need Rift’s support:{' '}
            <span className="break-all font-mono text-slate-200">{unreadable.join(', ')}</span>
          </div>
        )}
        <RiftErrorBoundary fallback={() => null}>
          <RecentOrders
            orders={orders} activeId={activeId} onSelect={setActiveId}
            onClearFinished={() => {
              const now = Date.now();
              const done = orders.filter(o => clearable(o, now)).map(o => o.id);
              void removeOrders(done);
              if (activeId && done.includes(activeId)) setActiveId(null);
            }}
          />
        </RiftErrorBoundary>
      </div>
    </div>
  );
}
