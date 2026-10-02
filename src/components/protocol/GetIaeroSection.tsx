// src/components/protocol/GetIaeroSection.tsx
//
// "Get iAERO": buy iAERO with any token on Ethereum, Arbitrum or Base, or with BTC, in one step, routed by
// Rift (rift.trade). The user picks what to pay with and sees the iAERO they will get, the route, and how
// long it should take. One click creates the order and, on EVM chains, asks the wallet for a single plain
// transfer to the order's one-time deposit address. Rift does the rest, and OrderTracker shows every step
// until iAERO arrives on Base.

'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  useAccount, useBalance, usePublicClient, useReadContract, useSendTransaction, useSwitchChain, useWriteContract,
} from 'wagmi';
import { base } from 'wagmi/chains';
import { erc20Abi, formatUnits, isAddress } from 'viem';
import { ArrowLeftRight, Bell, Info, Loader2, Route as RouteIcon, ShieldCheck, Timer } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { usePrices } from '@/components/contexts/PriceContext';
import { useDebounce } from '@/components/lib/defi-utils';
import RouteSteps from '@/components/rift/RouteSteps';
import OrderTracker from '@/components/rift/OrderTracker';
import RecentOrders from '@/components/rift/RecentOrders';
import {
  KNOWN_SYMBOLS, RIFT_DESTINATION, RIFT_SECURITY_URL, SOURCE_CHAINS, SOURCE_CHAIN_ORDER, tokensFor,
} from '@/lib/rift/config';
import { RiftApiError, createOrder, explainRiftError, fetchQuote } from '@/lib/rift/client';
import { decimalToRaw, isTerminal, normalizeDecimal, parseOrder, parseQuote } from '@/lib/rift/validate';
import { estimateRoute, formatRange } from '@/lib/rift/timing';
import { isBtcAddress } from '@/lib/rift/bitcoin';
import { patchOrder, removeOrders, upsertOrder, useStoredOrders } from '@/lib/rift/storage';
import type { SourceChainKey, SourceToken, StoredOrder } from '@/lib/rift/types';

type EvmChainId = 1 | 42161 | 8453;

interface Props {
  showToast: (message: string, type: 'success' | 'error' | 'info' | 'warning') => void;
  formatNumber: (value: string | number) => string;
  onGoToStake?: () => void;
}

const fmt = (v: string | number | undefined, digits = 4) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: digits }) : '—';
};
const errText = (e: unknown) => {
  const x = e as { shortMessage?: string; message?: string };
  return x?.shortMessage ?? x?.message ?? String(e);
};
const isUserRejection = (e: unknown) => {
  const x = e as { name?: string; code?: number; message?: string; cause?: { code?: number } };
  return x?.name === 'UserRejectedRequestError' || x?.code === 4001 || x?.cause?.code === 4001 || /user (rejected|denied)|rejected the request/i.test(x?.message ?? '');
};

/** Keep only digits and one dot, and no more decimals than the token has. */
function sanitizeAmount(input: string, decimals: number): string {
  let v = input.replace(/,/g, '.').replace(/[^\d.]/g, '');
  const dot = v.indexOf('.');
  if (dot >= 0) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '').slice(0, decimals);
  return v;
}

export default function GetIaeroSection({ showToast, onGoToStake }: Props) {
  const { address, isConnected, chainId: walletChainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();
  const { writeContractAsync } = useWriteContract();
  const basePublic = usePublicClient({ chainId: base.id });
  const { prices } = usePrices();
  const orders = useStoredOrders();

  // --- What the user pays with ---
  const [chainKey, setChainKey] = useState<SourceChainKey>('ethereum');
  const [pickedDefault, setPickedDefault] = useState(false);
  const [tokenAsset, setTokenAsset] = useState<string>(SOURCE_CHAINS.ethereum.nativeAsset);
  const [customAddress, setCustomAddress] = useState('');
  const [customToken, setCustomToken] = useState<SourceToken | null>(null);
  const [customError, setCustomError] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [btcRefund, setBtcRefund] = useState('');
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [payingId, setPayingId] = useState<string | null>(null);
  useEffect(() => {
    // Start on the chain the wallet is already on, if supported.
    if (pickedDefault || !walletChainId) return;
    const match = SOURCE_CHAIN_ORDER.find(k => SOURCE_CHAINS[k].chainId === walletChainId);
    if (match) { setChainKey(match); setTokenAsset(SOURCE_CHAINS[match].nativeAsset); }
    setPickedDefault(true);
  }, [walletChainId, pickedDefault]);
  const chain = SOURCE_CHAINS[chainKey];
  const evmChainId = chain.chainId as EvmChainId | undefined;
  const curated = tokensFor(chainKey);
  const sourcePublic = usePublicClient({ chainId: evmChainId });

  const selectChain = (k: SourceChainKey) => {
    setChainKey(k);
    setTokenAsset(SOURCE_CHAINS[k].nativeAsset);
    setCustomAddress(''); setCustomToken(null); setCustomError(null); setAmount(''); setError(null);
  };

  // Any other ERC-20, by contract address: read its symbol and decimals on that chain.
  useEffect(() => {
    setCustomToken(null); setCustomError(null);
    if (tokenAsset !== 'custom' || chain.kind !== 'evm') return;
    const a = customAddress.trim();
    if (!a) return;
    if (!isAddress(a)) { setCustomError('Not a valid token contract address.'); return; }
    if (`${chainKey}.${a.toLowerCase()}` === RIFT_DESTINATION) { setCustomError('That is iAERO already.'); return; }
    if (!sourcePublic) return;
    let stop = false;
    (async () => {
      try {
        const [decimals, symbol] = await Promise.all([
          sourcePublic.readContract({ address: a as `0x${string}`, abi: erc20Abi, functionName: 'decimals' }),
          sourcePublic.readContract({ address: a as `0x${string}`, abi: erc20Abi, functionName: 'symbol' }).catch(() => `${a.slice(0, 6)}…`),
        ]);
        if (!stop) setCustomToken({ chain: chainKey, symbol: String(symbol), name: String(symbol), decimals: Number(decimals), address: a as `0x${string}`, asset: `${chainKey}.${a.toLowerCase()}`, custom: true });
      } catch {
        if (!stop) setCustomError(`No ERC-20 token at this address on ${chain.name}.`);
      }
    })();
    return () => { stop = true; };
  }, [tokenAsset, customAddress, chainKey, chain.kind, chain.name, sourcePublic]);

  const token: SourceToken | null = tokenAsset === 'custom' ? customToken : curated.find(t => t.asset === tokenAsset) ?? null;

  // --- Amount and balance ---
  const nativeBal = useBalance({ address, chainId: evmChainId, query: { enabled: !!address && chain.kind === 'evm' && !!token && !token.address } });
  const tokenBal = useReadContract({
    address: token?.address, abi: erc20Abi, functionName: 'balanceOf', args: address ? [address] : undefined, chainId: evmChainId,
    query: { enabled: !!address && chain.kind === 'evm' && !!token?.address },
  });
  const balanceRaw: bigint | undefined = chain.kind !== 'evm' || !token ? undefined : token.address ? (tokenBal.data as bigint | undefined) : nativeBal.data?.value;

  const amountState = useMemo((): { normalized?: string; raw?: bigint; error?: string } => {
    if (!token || !amount) return {};
    try {
      const normalized = normalizeDecimal(amount.endsWith('.') ? amount.slice(0, -1) : amount);
      const raw = decimalToRaw(normalized, token.decimals);
      if (raw === 0n) return {};
      if (balanceRaw !== undefined && raw > balanceRaw) return { normalized, raw, error: `Insufficient ${token.symbol} balance` };
      return { normalized, raw };
    } catch {
      return { error: 'Enter a valid amount' };
    }
  }, [amount, token, balanceRaw]);

  const setMax = () => {
    if (!token || balanceRaw === undefined) return;
    let raw = balanceRaw;
    if (!token.address && chain.gasReserve) {
      const reserve = decimalToRaw(chain.gasReserve, token.decimals);
      raw = raw > reserve ? raw - reserve : 0n;
    }
    setAmount(normalizeDecimal(formatUnits(raw, token.decimals)));
  };

  // --- Live quote: re-priced every 30 s while shown ---
  const quoteAmount = useDebounce(amountState.error ? undefined : amountState.normalized, 600);
  const quoteQuery = useQuery({
    queryKey: ['rift-quote', token?.asset, quoteAmount],
    enabled: !!token && !!quoteAmount,
    queryFn: async ({ signal }) =>
      parseQuote(await fetchQuote({ from: token!.asset, from_amount: quoteAmount! }, signal), {
        destination: RIFT_DESTINATION, fromChain: chainKey, fromAmount: quoteAmount!,
      }),
    refetchInterval: 30_000,
    staleTime: 20_000,
    retry: false,
  });
  const quote = quoteQuery.data && quoteAmount && amountState.normalized === quoteAmount ? quoteQuery.data : undefined;
  const estimate = useMemo(() => (quote ? estimateRoute(chainKey, quote.route, KNOWN_SYMBOLS) : null), [quote, chainKey]);
  const iaeroUsd = (prices as { iAERO?: { usd?: number } } | undefined)?.iAERO?.usd ?? 0;

  // --- Orders ---
  useEffect(() => {
    // Resume the most recent unfinished order after a refresh.
    if (activeId || !orders.length) return;
    setActiveId((orders.find(o => !isTerminal(o.status)) ?? orders[0]).id);
  }, [orders, activeId]);
  const activeOrder = orders.find(o => o.id === activeId) ?? null;

  async function pay(o: StoredOrder) {
    const c = SOURCE_CHAINS[o.sourceChain];
    if (c.kind !== 'evm' || !c.chainId) return;
    setPayingId(o.id); setError(null);
    try {
      if (walletChainId !== c.chainId) {
        setBusy(`Switch your wallet to ${c.name}…`);
        await switchChainAsync({ chainId: c.chainId as EvmChainId });
      }
      setBusy('Confirm the payment in your wallet…');
      const value = BigInt(o.fromAmountRaw);
      const to = o.depositAddress as `0x${string}`;
      const hash = o.token.address
        ? await writeContractAsync({ address: o.token.address as `0x${string}`, abi: erc20Abi, functionName: 'transfer', args: [to, value], chainId: c.chainId as EvmChainId })
        : await sendTransactionAsync({ to, value, chainId: c.chainId as EvmChainId });
      patchOrder(o.id, { depositTxHash: hash, depositSentAt: Date.now(), depositFailed: false, depositConfirmedAt: undefined });
      showToast('Payment sent. Tracking your order…', 'success');
    } catch (e) {
      const msg = isUserRejection(e)
        ? 'Payment cancelled in your wallet. You can pay from the order card whenever you are ready.'
        : `Payment failed: ${errText(e)}`;
      setError(msg); showToast(msg, 'error');
    } finally {
      setPayingId(null); setBusy(null);
    }
  }

  async function start() {
    if (!address || !token || !quote) return;
    setError(null);
    try {
      const refund = chain.kind === 'bitcoin' ? btcRefund.trim() : address;
      if (chain.kind === 'bitcoin' && !isBtcAddress(refund)) {
        throw new Error('Enter a Bitcoin refund address you control (not an exchange deposit address).');
      }
      // iAERO goes to this same address on Base. A smart-contract wallet that exists only on the paying
      // chain could not use it there.
      if (chain.kind === 'evm' && chainKey !== 'base' && sourcePublic && basePublic) {
        const [srcCode, baseCode] = await Promise.all([sourcePublic.getCode({ address }), basePublic.getCode({ address })]);
        if (srcCode && srcCode !== '0x' && (!baseCode || baseCode === '0x')) {
          throw new Error(`Your wallet is a smart-contract wallet on ${chain.name} but not on Base, so it could not receive iAERO there.`);
        }
      }
      // A fresh price if the shown one is over a minute old or close to expiry.
      let q = quote;
      if (Date.now() - quoteQuery.dataUpdatedAt > 60_000 || Date.parse(q.expires_at) - Date.now() < 60_000) {
        setBusy('Refreshing the price…');
        const r = await quoteQuery.refetch();
        if (!r.data) throw r.error ?? new Error('Could not refresh the quote');
        q = r.data;
      }
      if (notify && typeof Notification !== 'undefined' && Notification.permission === 'default') {
        try { await Notification.requestPermission(); } catch { /* not supported */ }
      }
      setBusy('Creating your order…');
      const fromAmount = normalizeDecimal(q.from_amount);
      const raw = decimalToRaw(fromAmount, token.decimals);
      const order = parseOrder(await createOrder({ quote_id: q.id, to_address: address, refund_address: refund }), {
        destination: RIFT_DESTINATION, quoteId: q.id, toAddress: address, fromChain: chainKey, fromAmount, refundAddress: refund,
      });
      // Never ask the wallet to send anything the order does not say, or to an address of the wrong kind.
      if (decimalToRaw(order.from_amount, token.decimals) !== raw) throw new Error('The order amount does not match your request.');
      if (chain.kind === 'evm' ? !isAddress(order.deposit_address) : !isBtcAddress(order.deposit_address)) {
        throw new Error('Rift returned a deposit address of the wrong kind; nothing was sent.');
      }
      let baseFromBlock: string | undefined;
      try { baseFromBlock = basePublic ? String(await basePublic.getBlockNumber()) : undefined; } catch { /* optional */ }
      const stored: StoredOrder = {
        id: order.id, quoteId: q.id, createdAt: Date.now(), sourceChain: chainKey,
        token: { symbol: token.symbol, decimals: token.decimals, address: token.address, asset: token.asset },
        fromAmount, fromAmountRaw: raw.toString(), estimatedOut: q.estimated_amount_out, route: q.route,
        depositAddress: order.deposit_address, depositDeadline: order.deposit_deadline, toAddress: address,
        refundAddress: refund, status: order.status, statusTimes: { [order.status]: Date.now() }, baseFromBlock, notify,
      };
      upsertOrder(stored);
      setActiveId(order.id);
      setAmount('');
      if (chain.kind === 'evm') await pay(stored);
      else showToast('Order created. Send the exact BTC amount shown to complete it.', 'info');
    } catch (e) {
      if (e instanceof RiftApiError && e.status === 410) quoteQuery.refetch();
      const msg = e instanceof RiftApiError ? explainRiftError(e) : errText(e);
      setError(msg); showToast(msg, 'error');
    } finally {
      setBusy(null);
    }
  }

  const cta = (() => {
    if (!isConnected) return { text: 'Connect a wallet to receive iAERO on Base', disabled: true };
    if (!token) return { text: tokenAsset === 'custom' ? 'Enter a token address' : 'Choose a token', disabled: true };
    if (!amountState.normalized) return { text: 'Enter an amount', disabled: true };
    if (amountState.error) return { text: amountState.error, disabled: true };
    if (quoteQuery.isFetching && !quote) return { text: 'Finding the best route…', disabled: true };
    if (!quote) return { text: quoteQuery.error ? 'No route available' : 'Waiting for a quote', disabled: true };
    if (chain.kind === 'bitcoin' && !isBtcAddress(btcRefund.trim())) return { text: 'Enter your BTC refund address', disabled: true };
    return { text: chain.kind === 'bitcoin' ? 'Create Bitcoin payment' : `Buy iAERO with ${token.symbol}`, disabled: !!busy };
  })();

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* Order form */}
      <Card className="border-slate-700/50 bg-slate-800/50 backdrop-blur-xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-white">
            <ArrowLeftRight className="h-5 w-5" /> Get iAERO with any token
          </CardTitle>
          <p className="text-sm text-slate-400">Pay on Ethereum, Arbitrum, Base or Bitcoin. iAERO arrives in your wallet on Base, automatically.</p>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Chain */}
          <div className="space-y-2">
            <Label className="text-slate-300">Pay from</Label>
            <div className="grid grid-cols-4 gap-2">
              {SOURCE_CHAIN_ORDER.map(k => (
                <button
                  key={k} type="button" onClick={() => selectChain(k)} disabled={!!busy}
                  className={`rounded-lg border px-2 py-2 text-sm transition-colors ${chainKey === k ? 'border-indigo-500 bg-indigo-500/15 text-white' : 'border-slate-600 text-slate-300 hover:border-slate-400'}`}
                >
                  {SOURCE_CHAINS[k].name}
                </button>
              ))}
            </div>
          </div>

          {/* Token */}
          <div className="space-y-2">
            <Label className="text-slate-300">Token</Label>
            <div className="flex flex-wrap gap-2">
              {curated.map(t => (
                <button
                  key={t.asset} type="button" onClick={() => { setTokenAsset(t.asset); setError(null); }} disabled={!!busy}
                  className={`rounded-full border px-3 py-1 text-sm ${tokenAsset === t.asset ? 'border-indigo-500 bg-indigo-500/15 text-white' : 'border-slate-600 text-slate-300 hover:border-slate-400'}`}
                >
                  {t.symbol}
                </button>
              ))}
              {chain.kind === 'evm' && (
                <button
                  type="button" onClick={() => setTokenAsset('custom')} disabled={!!busy}
                  className={`rounded-full border px-3 py-1 text-sm ${tokenAsset === 'custom' ? 'border-indigo-500 bg-indigo-500/15 text-white' : 'border-slate-600 text-slate-300 hover:border-slate-400'}`}
                >
                  Other token…
                </button>
              )}
            </div>
            {tokenAsset === 'custom' && (
              <div className="space-y-1">
                <Input
                  placeholder={`Token contract address on ${chain.name} (0x…)`} value={customAddress}
                  onChange={e => setCustomAddress(e.target.value)} className="border-slate-600 bg-slate-900/50 font-mono text-sm text-white"
                />
                <div className="text-xs">
                  {customError ? <span className="text-red-400">{customError}</span>
                    : customToken ? <span className="text-emerald-400">{customToken.symbol} · {customToken.decimals} decimals</span>
                    : <span className="text-slate-500">Rift quotes any token that has a route.</span>}
                </div>
              </div>
            )}
          </div>

          {/* Amount */}
          <div className="space-y-2">
            <Label className="text-slate-300">Amount</Label>
            <div className="relative">
              <Input
                type="text" inputMode="decimal" placeholder="0.0" value={amount} disabled={!token || !!busy}
                onChange={e => token && setAmount(sanitizeAmount(e.target.value, token.decimals))}
                className={`border-slate-600 bg-slate-900/50 pr-24 text-white placeholder-slate-400 ${amountState.error ? 'border-red-500/50' : ''}`}
              />
              <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
                <span className="text-sm text-slate-400">{token?.symbol}</span>
                {chain.kind === 'evm' && balanceRaw !== undefined && (
                  <Button variant="ghost" size="sm" onClick={setMax} disabled={!!busy} className="h-7 px-2 text-indigo-400 hover:text-indigo-300">MAX</Button>
                )}
              </div>
            </div>
            <div className="text-sm">
              {amountState.error ? <span className="text-red-400">{amountState.error}</span>
                : chain.kind === 'evm' && token && balanceRaw !== undefined
                  ? <span className="text-slate-400">Balance: {fmt(formatUnits(balanceRaw, token.decimals), 6)} {token.symbol} on {chain.name}</span>
                  : chain.kind === 'bitcoin' ? <span className="text-slate-400">You will pay from any Bitcoin wallet using a QR code or address.</span> : null}
            </div>
          </div>

          {chain.kind === 'bitcoin' && (
            <div className="space-y-2">
              <Label className="text-slate-300">Your Bitcoin refund address</Label>
              <Input
                placeholder="bc1…" value={btcRefund} onChange={e => setBtcRefund(e.target.value)} disabled={!!busy}
                className={`border-slate-600 bg-slate-900/50 font-mono text-sm text-white ${btcRefund && !isBtcAddress(btcRefund.trim()) ? 'border-red-500/50' : ''}`}
              />
              <div className="text-xs text-slate-500">Only used if the order cannot complete. Use a wallet you control, not an exchange.</div>
            </div>
          )}

          {/* Quote */}
          {(quote || quoteQuery.isFetching || quoteQuery.error) && amountState.normalized && !amountState.error && (
            <div className="space-y-4 rounded-xl border border-slate-700/30 bg-slate-900/50 p-4">
              {!quote && quoteQuery.isFetching && (
                <div className="flex items-center gap-2 text-sm text-slate-300"><Loader2 className="h-4 w-4 animate-spin" /> Finding the best route across 20+ venues (a few seconds)…</div>
              )}
              {!quote && quoteQuery.error && !quoteQuery.isFetching && (
                <div className="text-sm text-red-300">{explainRiftError(quoteQuery.error)}</div>
              )}
              {quote && estimate && (
                <>
                  <div className="flex items-end justify-between gap-3">
                    <div>
                      <div className="text-xs text-slate-400">You receive (estimated)</div>
                      <div className="text-2xl font-semibold text-white">{fmt(quote.estimated_amount_out)} iAERO</div>
                      {iaeroUsd > 0 && <div className="text-xs text-slate-500">≈ ${fmt(Number(quote.estimated_amount_out) * iaeroUsd, 2)}</div>}
                    </div>
                    {quoteQuery.isFetching && <Loader2 className="h-4 w-4 animate-spin text-slate-500" />}
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="rounded-lg bg-slate-800/60 p-3">
                      <div className="flex items-center gap-1.5 text-xs text-slate-400"><Timer className="h-3.5 w-3.5" /> Time to arrive</div>
                      <div className="font-medium text-white">{formatRange(estimate.typicalSec, estimate.slowSec)}</div>
                      <div className="text-[11px] text-slate-500">after your payment is sent</div>
                    </div>
                    <div className="rounded-lg bg-slate-800/60 p-3">
                      <div className="text-xs text-slate-400">Rate</div>
                      <div className="font-medium text-white">1 {token?.symbol} ≈ {fmt(Number(quote.estimated_amount_out) / Number(quote.from_amount), 4)} iAERO</div>
                      <div className="text-[11px] text-slate-500">network and venue costs included</div>
                    </div>
                  </div>
                  <div>
                    <div className="mb-2 flex items-center gap-1.5 text-xs text-slate-400"><RouteIcon className="h-3.5 w-3.5" /> Route</div>
                    <RouteSteps estimate={estimate} />
                  </div>
                  <div className="text-[11px] text-slate-500">Price refreshes every 30 seconds; the amount you receive can differ slightly from the estimate.</div>
                </>
              )}
            </div>
          )}

          {isConnected && address && (
            <div className="text-xs text-slate-400">iAERO goes to <span className="font-mono text-slate-300">{address.slice(0, 6)}…{address.slice(-4)}</span> on Base.</div>
          )}

          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" checked={notify} onChange={e => setNotify(e.target.checked)} className="h-4 w-4 accent-indigo-500" />
            <Bell className="h-4 w-4 text-slate-400" /> Notify me when it arrives
          </label>

          <Button
            onClick={start} disabled={cta.disabled}
            className="w-full bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />{busy}</span> : cta.text}
          </Button>
          {chain.kind === 'evm' && chainKey !== 'base' && isConnected && (
            <div className="flex gap-2 text-xs text-slate-500">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Your wallet switches to {chain.name} for the payment (one plain transfer, no approvals). You can switch back to Base after.
            </div>
          )}
          {error && <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>}

          <div className="flex gap-2 border-t border-slate-700/40 pt-3 text-xs text-slate-500">
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
      <div className="space-y-6">
        {activeOrder ? (
          <OrderTracker
            key={activeOrder.id} order={activeOrder} onPay={pay} paying={payingId === activeOrder.id}
            onGoToStake={onGoToStake} showToast={showToast}
          />
        ) : (
          <Card className="border-slate-700/50 bg-slate-800/50 backdrop-blur-xl">
            <CardContent className="space-y-3 p-6 text-sm text-slate-400">
              <div className="font-medium text-white">How it works</div>
              <ol className="list-decimal space-y-1.5 pl-5">
                <li>Choose what to pay with. You see the iAERO you’ll get, the route, and how long it takes, before you commit.</li>
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
            const done = orders.filter(o => isTerminal(o.status)).map(o => o.id);
            removeOrders(done);
            if (activeId && done.includes(activeId)) setActiveId(null);
          }}
        />
      </div>
    </div>
  );
}
